import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-write.js";
import { tokenTx, txUsd } from "./etherscan.js";
import { classify, categoryBucket, type FundingCategory } from "./funding-source.js";
import { fetchEarliestBridgeOrigin } from "./bridge-tracer.js";
import { log, err } from "./log.js";

const PATH = join(process.cwd(), "state", "wallet_profiles.json");
const TTL_MS = 24 * 60 * 60 * 1000;
const MEANINGFUL_USDC = 1000; // $1k+ inflow threshold

// USDC contracts on Polygon mainnet.
const USDC_E = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"; // bridged USDC (used by Polymarket)
const USDC_NATIVE = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"; // native USDC (Circle)
// pUSD — Polymarket's collateral token. Deposits route through Relay and
// the meaningful balance lands as pUSD, NOT as a plain USDC.e transfer.
// Scanning only USDC/USDC.e made every Relay/pUSD-funded wallet look like
// it had zero inflow → false "hidden funding" (path B) alerts. Verified
// 2026-05-29: 0x0f02… (real $2.3M actor) received 8 pUSD inflows and zero
// USDC.e, so the profiler saw inflow_count=0 and mis-flagged it.
const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
// Polygon stable-token set (the proxy itself lives on Polygon → its own
// inflow/age scan uses this).
const USDC_CONTRACTS = [USDC_E, USDC_NATIVE, PUSD];

/**
 * Per-chain USD-stable contract sets for the funder-resolve scan. A conduit
 * can be fed on any chain (e.g. via Hyperliquid on Arbitrum), so resolving
 * the exchange behind it requires scanning the right chain's USDC variants.
 * Resolved via Etherscan V2 tokentx (chainid param) — free indexed history.
 */
const STABLES_BY_CHAIN: Record<string, string[]> = {
  polygon: [USDC_E, USDC_NATIVE, PUSD],
  arbitrum: [
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // native USDC
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", // USDC.e (bridged)
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
  ],
  base: [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // native USDC
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC (bridged)
  ],
  ethereum: [
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  ],
  optimism: [
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // native USDC
    "0x7f5c764cbc14f9669b88837ca1490cca17c31607", // USDC.e (bridged)
  ],
};
/** Numeric chain id → Alchemy chain key, for prioritizing the deposit-leg chain. */
const CHAINID_TO_ALCHEMY: Record<number, string> = {
  1: "ethereum", 10: "optimism", 137: "polygon", 8453: "base", 42161: "arbitrum",
};
/** Order we scan when resolving the exchange behind a conduit. */
const FUNDER_SCAN_CHAINS = ["polygon", "arbitrum", "base", "ethereum", "optimism"];

export interface WalletProfile {
  wallet: string;
  /** ISO timestamp of first transfer >= $1k USDC into this wallet, or null if none found. */
  first_meaningful_inflow_iso: string | null;
  first_meaningful_inflow_ts: number | null;
  /** Days since first meaningful inflow; null when first_meaningful_inflow_ts is null. */
  age_days: number | null;
  /** Fresh score 0-10: higher = more suspicious. */
  score: number;
  /** Total count of USDC transfers we scanned (capped). */
  inflow_count: number;
  /** Source address of the first meaningful inflow (lowercased), or null. */
  first_inflow_from: string | null;
  /** Classified category for the first inflow source. */
  funding_source: FundingCategory;
  /** Origin wallet on a source chain that initiated the earliest Relay bridge to this proxy.
   *  Populated only when funding_source is bridge:* or unclassified. null otherwise. */
  bridge_origin_wallet: string | null;
  /** Chain id where bridge_origin_wallet lives. */
  bridge_origin_chain: number | null;
  /** Classification of bridge_origin_wallet itself. If this is a CEX/service,
   *  two proxies sharing the same origin should NOT cluster — many real users
   *  withdraw from the same Binance hot wallet on Base. */
  bridge_origin_funding_source: FundingCategory;
  /** Age (days) of bridge_origin_wallet itself, when it was an UNKNOWN funder
   *  we inspected. null when not inspected. Drives the conduit-vs-established
   *  distinction below. */
  funder_age_days: number | null;
  /** True when bridge_origin_wallet was a FRESH one-time conduit (young, low-
   *  history) and we traced ONE more hop to find the exchange behind it.
   *  When false and bridge_origin_funding_source is private, the funder is an
   *  ESTABLISHED wallet whose own identity/age is the signal. */
  funder_is_conduit: boolean;
  /** DISPLAY-ONLY: exchange resolved one hop behind a FRESH conduit
   *  ("via Coinbase"). Intentionally SEPARATE from bridge_origin_funding_source
   *  — clustering must key on the funder/conduit ADDRESS (kept as the funder's
   *  own classification, usually `private` → strong same-actor signal), NOT on
   *  the upstream exchange (which would weaken it to a CEX-bucket score). Null
   *  unless we resolved an exchange behind a fresh conduit. */
  funder_exchange: FundingCategory;
  last_refreshed_iso: string;
  last_refreshed_ts: number;
}

interface AssetTransfer {
  blockNum: string;
  hash: string;
  from: string;
  to: string;
  value: number | null;
  asset: string | null;
  metadata?: { blockTimestamp?: string };
}

type Cache = Record<string, WalletProfile>;

/**
 * In-memory cache mirror with mtime-based invalidation. Previously every
 * getProfile call did a full readFileSync+JSON.parse — with 50-wallet
 * cluster scans that's 50 full-file reads + up to 50 full-file writes per
 * cycle. Now we keep an in-memory copy and only re-read disk if the file
 * mtime changed since last load (i.e. another process wrote it).
 */
let memCache: Cache | null = null;
let memMtimeMs = 0;

function loadCache(): Cache {
  if (!existsSync(PATH)) {
    if (memCache === null) memCache = {};
    return memCache;
  }
  let mtime = 0;
  try {
    mtime = statSync(PATH).mtimeMs;
  } catch {
    /* fall through */
  }
  if (memCache !== null && mtime === memMtimeMs) return memCache;
  try {
    memCache = JSON.parse(readFileSync(PATH, "utf-8")) as Cache;
    memMtimeMs = mtime;
    return memCache;
  } catch {
    if (memCache === null) memCache = {};
    return memCache;
  }
}

function saveCache(c: Cache): void {
  memCache = c;
  writeJsonAtomic(PATH, c);
  // Capture our own write's mtime so the next loadCache hits the in-memory
  // path without a disk read.
  try {
    memMtimeMs = statSync(PATH).mtimeMs;
  } catch {
    /* ignore */
  }
}

function isFresh(profile: WalletProfile): boolean {
  return Date.now() - profile.last_refreshed_ts < TTL_MS;
}

/**
 * How many DISTINCT profiled wallets share this address as their funder
 * (first_inflow_from or bridge_origin_wallet). A genuine private coordinator
 * funds a handful of burners; a shared on-ramp / conduit funds many. The
 * cluster signal uses this to neutralize the "same-funder" factor for high-
 * fanout funders (they're services, not coordinators). Index rebuilt only
 * when the profile cache file changes.
 */
let fanoutIndex: Map<string, number> | null = null;
let fanoutForMtime = -1;
export function getFunderFanout(funder: string): number {
  if (!funder) return 0;
  const cache = loadCache(); // refreshes memMtimeMs if disk changed
  if (fanoutIndex === null || fanoutForMtime !== memMtimeMs) {
    const idx = new Map<string, number>();
    for (const p of Object.values(cache)) {
      const seen = new Set<string>();
      if (p.first_inflow_from) seen.add(p.first_inflow_from.toLowerCase());
      if (p.bridge_origin_wallet) seen.add(p.bridge_origin_wallet.toLowerCase());
      for (const a of seen) idx.set(a, (idx.get(a) ?? 0) + 1);
    }
    fanoutIndex = idx;
    fanoutForMtime = memMtimeMs;
  }
  return fanoutIndex.get(funder.toLowerCase()) ?? 0;
}

function computeScore(ageDays: number | null): number {
  // No $1k+ USDC inflow on record — likely a small-fish trader that funded
  // via many tiny deposits. Don't flag on that alone; the wallet hasn't
  // tripped the "fresh" heuristic. (A separate signal can target the
  // "big bet but no visible funding" case later.)
  if (ageDays === null) return 1;
  if (ageDays < 21) return 8;
  if (ageDays < 90) return 5;
  return 2;
}

async function fetchEarliestUsdcInflow(wallet: string): Promise<AssetTransfer | null> {
  // Oldest ≥$1k USDC/pUSD inflow on Polygon, via Etherscan V2 tokentx (indexed,
  // sorted asc). One call per stable contract; keep the earliest hit across them.
  let best: AssetTransfer | null = null;
  let bestTs = Infinity;
  for (const contract of USDC_CONTRACTS) {
    const rows = await tokenTx({ chain: "polygon", address: wallet, contractaddress: contract, sort: "asc", offset: 100 });
    for (const r of rows) {
      if ((r.to || "").toLowerCase() !== wallet) continue; // inflow only
      if (txUsd(r) < MEANINGFUL_USDC) continue;
      const ts = Number(r.timeStamp);
      if (ts < bestTs) {
        bestTs = ts;
        best = {
          blockNum: r.blockNumber,
          hash: r.hash,
          from: r.from,
          to: r.to,
          value: txUsd(r),
          asset: r.tokenSymbol,
          metadata: { blockTimestamp: new Date(ts * 1000).toISOString() },
        };
      }
      break; // rows are asc → first qualifying is this contract's oldest
    }
  }
  return best;
}

/** A funder younger than this (days) is treated as a throwaway one-time
 *  conduit → we trace ONE more hop to the exchange behind it. Older than
 *  this, the funder is an established wallet whose own identity is signal
 *  and must NOT be collapsed away. */
export const FRESH_FUNDER_DAYS = 14;

/**
 * Scan a funder wallet's stable inflows ACROSS MAIN EVM CHAINS for the first
 * transfer from a KNOWN exchange (cex/swap/fiat). Returns that classification
 * or null. Used to resolve the exchange behind a fresh one-time conduit.
 * `priorityChain` (the chain the deposit leg came from) is scanned first.
 */
async function fetchFirstExchangeSender(
  wallet: string,
  priorityChain?: string,
): Promise<FundingCategory> {
  const chains = [priorityChain, ...FUNDER_SCAN_CHAINS].filter(
    (c, i, a): c is string => !!c && a.indexOf(c) === i,
  );
  for (const chain of chains) {
    const tokens = STABLES_BY_CHAIN[chain];
    if (!tokens) continue;
    // Oldest stable inflows on this chain (Etherscan V2), one call per stable;
    // return on the first sender that classifies as a known exchange.
    for (const contract of tokens) {
      const rows = await tokenTx({ chain, address: wallet, contractaddress: contract, sort: "asc", offset: 25 });
      for (const r of rows) {
        if ((r.to || "").toLowerCase() !== wallet) continue; // inflow only
        if (txUsd(r) < MEANINGFUL_USDC) continue;
        const cat = classify((r.from || "").toLowerCase());
        const bucket = categoryBucket(cat);
        if (bucket === "cex" || bucket === "swap" || bucket === "fiat") return cat;
      }
    }
  }
  return null;
}

async function buildProfile(wallet: string): Promise<WalletProfile> {
  const lc = wallet.toLowerCase();
  try {
    const first = await fetchEarliestUsdcInflow(lc);
    const tsIso = first?.metadata?.blockTimestamp || null;
    const ts = tsIso ? Date.parse(tsIso) : null;
    const ageDays = ts ? Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000)) : null;
    const fromLower = first?.from ? first.from.toLowerCase() : null;
    const funding = fromLower ? classify(fromLower) : null;

    // Phase 6b/c: trace bridge origin for bridge-funded (or unclassified) wallets.
    // Dispatches to the right tracer by bridge name (extracted from
    // funding_source like "bridge:relay" → "relay"). For unknown senders
    // ("private" bucket) tries Relay + Wormhole as fallbacks since the
    // unidentified sender might actually be a tracer-supported bridge we
    // don't have in the address dict.
    let bridge_origin_wallet: string | null = null;
    let bridge_origin_chain: number | null = null;
    let bridge_origin_funding_source: FundingCategory = null;
    let funder_age_days: number | null = null;
    let funder_is_conduit = false;
    let funder_exchange: FundingCategory = null;
    const bucket = categoryBucket(funding);
    if (bucket === "bridge" || bucket === "private") {
      const bridgeName =
        funding && funding.startsWith("bridge:") ? funding.slice("bridge:".length) : null;
      const origin = await fetchEarliestBridgeOrigin(bridgeName, lc);
      if (origin) {
        bridge_origin_wallet = origin.user; // original case (Solana/Tron base58 preserved)
        bridge_origin_chain = origin.chain_id;
        // Classify the origin too — Coinbase Base / Binance Solana would
        // otherwise spuriously link hundreds of users. classify() matches a
        // lowercased dict, so lowercase the (possibly mixed-case) origin here.
        bridge_origin_funding_source = classify(origin.user.toLowerCase());

        // Funder is an UNKNOWN wallet → decide conduit vs established.
        // - FRESH funder (< FRESH_FUNDER_DAYS): a throwaway pass-through
        //   between an exchange and Polymarket. Trace one more hop to the
        //   exchange and show THAT ("via Coinbase"). The conduit itself
        //   carries no identity signal.
        // - OLD funder: a deposit landing on an established wallet that
        //   then forwards. The aged wallet's identity IS the signal —
        //   keep it, do NOT collapse to the exchange (we'd lose it).
        if (categoryBucket(bridge_origin_funding_source) === "private") {
          try {
            const fb = await fetchEarliestUsdcInflow(bridge_origin_wallet);
            const fts = fb?.metadata?.blockTimestamp
              ? Date.parse(fb.metadata.blockTimestamp)
              : null;
            funder_age_days = fts
              ? Math.floor((Date.now() - fts) / (24 * 60 * 60 * 1000))
              : null;
            if (funder_age_days !== null && funder_age_days < FRESH_FUNDER_DAYS) {
              const priorityChain = bridge_origin_chain
                ? CHAINID_TO_ALCHEMY[bridge_origin_chain]
                : undefined;
              const ex = await fetchFirstExchangeSender(bridge_origin_wallet, priorityChain);
              if (ex) {
                // DISPLAY only — record the exchange behind the fresh conduit
                // for the alert ("via Coinbase"). Do NOT overwrite
                // bridge_origin_funding_source: clustering keys on the conduit
                // ADDRESS (still `private` → 0.8 same-actor), and collapsing to
                // a CEX bucket here would weaken that to 0.2.
                funder_exchange = ex;
                funder_is_conduit = true;
              }
            }
          } catch (e) {
            err("wallet-profiler", `funder resolve failed for ${bridge_origin_wallet}`, (e as Error).message);
          }
        }
      }
    }

    return {
      wallet: lc,
      first_meaningful_inflow_iso: tsIso,
      first_meaningful_inflow_ts: ts,
      age_days: ageDays,
      score: computeScore(ageDays),
      // inflow_count would require an extra Alchemy page to populate
      // properly; left as 0 historically. Drop the field meaning so future
      // readers don't expect a real value — we only fetch up to the first
      // $1k+ hit and stop, which is enough for the freshness signal.
      inflow_count: 0,
      first_inflow_from: fromLower,
      funding_source: funding,
      bridge_origin_wallet,
      bridge_origin_chain,
      bridge_origin_funding_source,
      funder_age_days,
      funder_is_conduit,
      funder_exchange,
      last_refreshed_iso: new Date().toISOString(),
      last_refreshed_ts: Date.now(),
    };
  } catch (e) {
    err("wallet-profiler", `profile build failed for ${lc}`, e);
    throw e;
  }
}

/**
 * Get a wallet profile, using cache when fresh (< 24h old).
 * Returns null only if Alchemy call fails and there's no cached entry.
 */
export async function getProfile(wallet: string): Promise<WalletProfile | null> {
  const lc = wallet.toLowerCase();
  const cache = loadCache();
  const cached = cache[lc];
  if (cached && isFresh(cached)) return cached;
  try {
    const fresh = await buildProfile(lc);
    cache[lc] = fresh;
    saveCache(cache);
    log(
      "wallet-profiler",
      `profiled ${lc} score=${fresh.score} age=${fresh.age_days ?? "none"}d`,
    );
    return fresh;
  } catch {
    return cached || null;
  }
}
