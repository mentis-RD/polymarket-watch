import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { rpc } from "./alchemy-pool.js";
import { classify, categoryBucket, type FundingCategory } from "./funding-source.js";
import { fetchEarliestRelayOrigin } from "./bridge-tracer.js";
import { log, err } from "./log.js";

const PATH = join(process.cwd(), "state", "wallet_profiles.json");
const TTL_MS = 24 * 60 * 60 * 1000;
const MEANINGFUL_USDC = 1000; // $1k+ inflow threshold

// USDC contracts on Polygon mainnet.
const USDC_E = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"; // bridged USDC (used by Polymarket)
const USDC_NATIVE = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"; // native USDC (Circle)
const USDC_CONTRACTS = [USDC_E, USDC_NATIVE];

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

function loadCache(): Cache {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, "utf-8")) as Cache;
  } catch {
    return {};
  }
}

function saveCache(c: Cache): void {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(c, null, 2));
}

function isFresh(profile: WalletProfile): boolean {
  return Date.now() - profile.last_refreshed_ts < TTL_MS;
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
  const params = {
    toAddress: wallet,
    contractAddresses: USDC_CONTRACTS,
    category: ["erc20"],
    order: "asc",
    maxCount: "0x64", // 100
    withMetadata: true,
    excludeZeroValue: true,
  };
  const result = await rpc<{ transfers: AssetTransfer[]; pageKey?: string }>(
    "alchemy_getAssetTransfers",
    [params],
  );
  for (const t of result.transfers || []) {
    if (typeof t.value === "number" && t.value >= MEANINGFUL_USDC) return t;
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

    // Phase 6b: trace bridge origin for relay-funded (or unclassified-sender) wallets.
    let bridge_origin_wallet: string | null = null;
    let bridge_origin_chain: number | null = null;
    let bridge_origin_funding_source: FundingCategory = null;
    const bucket = categoryBucket(funding);
    if (bucket === "bridge" || bucket === "private") {
      const origin = await fetchEarliestRelayOrigin(lc);
      if (origin) {
        bridge_origin_wallet = origin.user;
        bridge_origin_chain = origin.chain_id;
        // Classify the origin too — Coinbase Base / Binance Solana would
        // otherwise spuriously link hundreds of users.
        bridge_origin_funding_source = classify(origin.user);
      }
    }

    return {
      wallet: lc,
      first_meaningful_inflow_iso: tsIso,
      first_meaningful_inflow_ts: ts,
      age_days: ageDays,
      score: computeScore(ageDays),
      inflow_count: 0,
      first_inflow_from: fromLower,
      funding_source: funding,
      bridge_origin_wallet,
      bridge_origin_chain,
      bridge_origin_funding_source,
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
