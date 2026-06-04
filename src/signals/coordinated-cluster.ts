import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { request } from "undici";
import { getProfile, getFunderFanout, type WalletProfile } from "../wallet-profiler.js";
import { rpc } from "../alchemy-pool.js";
import { writeJsonAtomic } from "../atomic-write.js";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { escapeMd } from "../markdown.js";
import { eventLink, walletLink, fmtMoney, sideLabel, shortDate, EXTREME_PRICE_HIGH } from "../alert-format.js";
import { log } from "../log.js";
import { categoryBucket, type FundingCategory } from "../funding-source.js";
import { getForEvent } from "../enriched-store.js";

const WINDOW_MS = 48 * 60 * 60 * 1000; // analyze last 48h on the market
const MIN_NOTIONAL = 500; // ignore tiny traders ($500 lifetime on market)
const SCORE_PAIR_LINK = 0.6;
const SCORE_PAIR_STRONG = 0.8;
const MIN_CLUSTER_SIZE = 3;
const COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MAX_WALLETS_PER_MARKET = 50; // O(n²) cap

const TIME_TOLERANCE_MS = 60 * 60 * 1000; // ±60 min for "similar timing"
const AMOUNT_TOLERANCE = 0.2; // ±20%
const FRESH_AGE_DAYS = 21;
/**
 * A "private" funder shared by more than this many distinct profiled wallets
 * is a shared on-ramp / conduit, NOT a coordinator — funding two proxies from
 * it is no signal. Above the limit the same-funder / same-origin factor is
 * neutralized. (Root-caused 2026-05-29: one shared funder 0xc417fd… glued 47
 * unrelated wallets — incl. both YES and NO and a 5-yr-old wallet — into a
 * bogus cluster on us-x-iran.) Kept generous: a genuine burner farm rarely
 * exceeds this many distinct signal-firing recipients.
 */
const FUNDER_FANOUT_LIMIT = 20;

/**
 * TRUE on-chain fanout gate. `getFunderFanout` (above) counts only PROFILED
 * recipients, so a shared conduit/disperser whose profiled-fanout happens to
 * sit just under FUNDER_FANOUT_LIMIT slips the cap and glues its recipients
 * into a bogus cluster (root-caused 2026-05-30: origin 0xaea4d1… had 28
 * distinct on-chain recipients but only 19 profiled (<20), so it passed the
 * cheap gate and linked 15 same-side wallets on us-military-draft-…). Here we
 * count the origin's ACTUAL distinct recipients on Polygon and neutralize the
 * edge when it exceeds the same limit — regardless of how many we've profiled.
 *
 * NOTE: do NOT use "is this address a contract?" as the test — on Polymarket
 * the trading/funding wallets are themselves proxy CONTRACTS, so contract-ness
 * doesn't separate a coordinator's distribution wallet from infrastructure.
 * Recipient fanout does.
 *
 * Memoized for the process. One alchemy_getAssetTransfers (1 page) per distinct
 * origin; ≥21 distinct recipients in that page is enough to conclude
 * high-fanout. RPC error → left uncached (edge kept this scan, retried next) so
 * a hiccup never suppresses a real signal.
 */
const FANOUT_PROBE_MAX = "0x3e8"; // 1000 transfers — plenty to clear the limit
const FANOUT_CACHE_PATH = join(process.cwd(), "state", "funder_fanout.json");
const FANOUT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-probe an address weekly

/**
 * PERSISTENT fanout cache, shared on disk across processes. Critical for the
 * daily digest: cluster review spawns ~60 SEPARATE `cluster-cli` processes, so
 * an in-memory cache wouldn't survive between them → each would re-probe the
 * same shared funders via Alchemy, hammering the (shared, 5-key) pool into 429
 * exhaustion (observed 2026-05-31: all 62 clusters left unverified). With a
 * disk cache the long-running trade-enricher warms it all day, and the digest
 * subprocesses mostly hit it. Merge-on-save (multi-writer: enricher + N
 * cli procs). Entries carry a ts; re-probed after TTL since a low-fanout
 * funder can grow.
 */
interface FanoutEntry { high: boolean; ts: number }
const onchainFanout = new Map<string, FanoutEntry>();

(function loadFanoutCache(): void {
  try {
    if (!existsSync(FANOUT_CACHE_PATH)) return;
    const o = JSON.parse(readFileSync(FANOUT_CACHE_PATH, "utf-8")) as Record<string, FanoutEntry>;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v.high === "boolean" && typeof v.ts === "number") onchainFanout.set(k, v);
    }
  } catch { /* cold start */ }
})();

function freshFanout(a: string, now: number): boolean | undefined {
  const e = onchainFanout.get(a);
  if (!e || now - e.ts > FANOUT_CACHE_TTL_MS) return undefined;
  return e.high;
}

function saveFanoutCache(fresh: Record<string, FanoutEntry>): void {
  try {
    const disk: Record<string, FanoutEntry> = existsSync(FANOUT_CACHE_PATH)
      ? (JSON.parse(readFileSync(FANOUT_CACHE_PATH, "utf-8")) as Record<string, FanoutEntry>)
      : {};
    for (const [k, v] of Object.entries(fresh)) {
      if (!disk[k] || disk[k].ts < v.ts) disk[k] = v; // newest-ts wins (merge, don't clobber)
    }
    // prune entries older than 2×TTL so the file stays bounded
    const cutoff = Date.now() - 2 * FANOUT_CACHE_TTL_MS;
    for (const k of Object.keys(disk)) if (disk[k].ts < cutoff) delete disk[k];
    writeJsonAtomic(FANOUT_CACHE_PATH, disk);
  } catch { /* non-fatal */ }
}

async function markHighFanoutAddrs(addrs: string[]): Promise<Set<string>> {
  const high = new Set<string>();
  const now = Date.now();
  const toCheck: string[] = [];
  for (const a of addrs) {
    if (!a) continue;
    const cached = freshFanout(a, now);
    if (cached === undefined) toCheck.push(a);
    else if (cached) high.add(a);
  }
  if (toCheck.length === 0) return high;
  const fresh: Record<string, FanoutEntry> = {};
  await Promise.all(
    [...new Set(toCheck)].map(async (a) => {
      try {
        const r = await rpc<{ transfers?: Array<{ to?: string }> }>(
          "alchemy_getAssetTransfers",
          [{ fromAddress: a, category: ["erc20", "external"], maxCount: FANOUT_PROBE_MAX, order: "asc", withMetadata: false, excludeZeroValue: true }],
          "polygon",
        );
        const recips = new Set((r?.transfers ?? []).map((t) => (t.to || "").toLowerCase()));
        const entry: FanoutEntry = { high: recips.size > FUNDER_FANOUT_LIMIT, ts: now };
        onchainFanout.set(a, entry);
        fresh[a] = entry;
        if (entry.high) high.add(a);
      } catch {
        /* leave uncached → edge kept this scan, retried next */
      }
    }),
  );
  if (Object.keys(fresh).length > 0) saveFanoutCache(fresh);
  return high;
}

import type { EnrichedTrade } from "../enriched-store.js";

interface WalletAgg {
  wallet: string;
  first_ts: number;
  last_ts: number;
  total_notional: number;
  net_outcome0_notional: number;
  net_outcome1_notional: number;
  trades: EnrichedTrade[];
  age_days: number | null;
  is_fresh: boolean;
  first_inflow_from: string | null;
  first_inflow_ts: number | null;
  funding_source: FundingCategory;
  bridge_origin_wallet: string | null;
  bridge_origin_funding_source: FundingCategory;
}

// readMarketTrades replaced by shared `getForMarket` from enriched-store
// (single mtime-checked parse per cycle across all markets + signals).

function aggregateWallets(trades: EnrichedTrade[]): Map<string, WalletAgg> {
  const map = new Map<string, WalletAgg>();
  for (const t of trades) {
    // Skip near-certain BUYs (>=95c) — no edge, shouldn't count toward
    // cluster position math. SELLs and cheap buys stay.
    if (t.side === "BUY" && t.price >= EXTREME_PRICE_HIGH) continue;
    const w = t.wallet.toLowerCase();
    let agg = map.get(w);
    if (!agg) {
      agg = {
        wallet: w,
        first_ts: t.ts,
        last_ts: t.ts,
        total_notional: 0,
        net_outcome0_notional: 0,
        net_outcome1_notional: 0,
        trades: [],
        age_days: null,
        is_fresh: false,
        first_inflow_from: null,
        first_inflow_ts: null,
        funding_source: null,
        bridge_origin_wallet: null,
        bridge_origin_funding_source: null,
      };
      map.set(w, agg);
    }
    agg.trades.push(t);
    agg.total_notional += t.notional;
    agg.first_ts = Math.min(agg.first_ts, t.ts);
    agg.last_ts = Math.max(agg.last_ts, t.ts);
    const sign = t.side === "BUY" ? 1 : -1;
    if (t.outcomeIndex === 0) agg.net_outcome0_notional += sign * t.notional;
    else agg.net_outcome1_notional += sign * t.notional;
  }
  return map;
}

function within(a: number, b: number, tolerance: number): boolean {
  if (a === 0 && b === 0) return true;
  const m = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / m <= tolerance;
}

interface PairScore {
  score: number;
  factors: string[];
  /** True only when the pair shares an IDENTITY link (same private funder
   *  or same private bridge-origin). Time/size/burner correlation is NOT
   *  identity — on a hot news market many independent wallets pile in
   *  same-side at similar size within minutes. A cluster must be anchored
   *  by at least one identity pair, else it's correlated-but-independent
   *  noise. (User-accepted tradeoff: may miss a coordinator who funds each
   *  burner via a distinct path, but kills the spam that made the signal
   *  useless.) */
  identity: boolean;
}

const CEX_SAME_TIGHT_MS = 7 * 24 * 60 * 60 * 1000;

function pairwiseScore(a: WalletAgg, b: WalletAgg, highFanout: Set<string>): PairScore {
  const factors: string[] = [];
  let s = 0;

  // ── SAME-SIDE GATE ──────────────────────────────────────────────────────
  // Coordination is directional. NO edge between opposite sides, or when
  // either wallet has no net position (only-sells / fully closed). This is a
  // hard requirement, not a bonus — a cluster is one-sided by definition.
  const aSide =
    a.net_outcome0_notional > 0 || a.net_outcome1_notional > 0
      ? a.net_outcome0_notional >= a.net_outcome1_notional ? 0 : 1
      : null;
  const bSide =
    b.net_outcome0_notional > 0 || b.net_outcome1_notional > 0
      ? b.net_outcome0_notional >= b.net_outcome1_notional ? 0 : 1
      : null;
  if (aSide === null || bSide === null || aSide !== bSide) {
    return { score: 0, factors: [], identity: false };
  }
  let identity = false;
  // The zero address is never a funder — it's the pUSD mint source on
  // Polymarket deposits, so MANY unrelated wallets share it as
  // first_inflow_from. Must not create identity links.
  const ZERO = "0x0000000000000000000000000000000000000000";

  // Phase 6b: same true origin on source chain (after Relay tracing).
  // Critical: only fire if the origin itself is a private wallet, not a
  // CEX hot wallet or service. Many real users withdraw from the same
  // Binance Solana / Coinbase Base hot wallet — that's noise, not signal.
  if (
    a.bridge_origin_wallet &&
    b.bridge_origin_wallet &&
    a.bridge_origin_wallet === b.bridge_origin_wallet &&
    a.bridge_origin_wallet !== ZERO
  ) {
    const originBucket = categoryBucket(a.bridge_origin_funding_source);
    if (originBucket === "private" && !a.bridge_origin_wallet.startsWith("0x")) {
      // Non-EVM origin (Solana/Tron, base58 — no 0x prefix). Our fanout probe
      // is Polygon-only, so we CAN'T verify this isn't a shared exchange/bridge
      // hot wallet that just isn't in our CEX dict — the common case for a
      // non-EVM origin reaching Polymarket via a bridge. Unverifiable → no
      // identity edge. Accepted tradeoff: misses a coordinator who funds Polygon
      // burners from a PRIVATE Solana/Tron wallet (rare — coordination usually
      // funds proxies from EVM). Classified non-EVM CEX still get the cex/swap
      // weight below; only the unclassified "private" case is cut here.
      factors.push(`shared-origin-skip:${a.bridge_origin_wallet.slice(0, 8)}…(non-evm)`);
    } else if (
      originBucket === "private" &&
      (getFunderFanout(a.bridge_origin_wallet) > FUNDER_FANOUT_LIMIT || highFanout.has(a.bridge_origin_wallet))
    ) {
      // High-fanout "private" origin = shared conduit/service/disperser, not a
      // coordinator. profiled-fanout OR true on-chain fanout over the limit.
      factors.push(`shared-origin-skip:${a.bridge_origin_wallet.slice(0, 8)}…(fanout)`);
    } else if (originBucket === "private") {
      s += 0.8;
      identity = true;
      factors.push(`same-bridge-origin:${a.bridge_origin_wallet.slice(0, 8)}…`);
    } else if (originBucket === "cex" || originBucket === "swap") {
      // Same exact CEX/swap hot wallet on source chain — weak but real;
      // ChangeNOW/Bitget hot funding two proxies = potentially same actor.
      s += 0.2;
      factors.push(`same-${originBucket}-origin:${a.bridge_origin_funding_source}`);
    } else if (originBucket === "fiat") {
      // Same fiat onramp hot on source chain — even weaker than CEX/swap.
      s += 0.15;
      factors.push(`same-fiat-origin:${a.bridge_origin_funding_source}`);
    }
    // bridge/service origin → no factor (no info)
  }

  // Same direct funder (private wallet, not a routed service) — strongest signal.
  if (
    a.first_inflow_from &&
    b.first_inflow_from &&
    a.first_inflow_from === b.first_inflow_from &&
    a.first_inflow_from !== ZERO
  ) {
    const bucket = categoryBucket(a.funding_source);
    if (
      bucket === "private" &&
      (getFunderFanout(a.first_inflow_from) > FUNDER_FANOUT_LIMIT || highFanout.has(a.first_inflow_from))
    ) {
      // High-fanout "private" funder = shared on-ramp/conduit/disperser, not a
      // coordinator. profiled-fanout OR true on-chain fanout over the limit.
      factors.push(`shared-funder-skip:${a.first_inflow_from.slice(0, 8)}…(fanout)`);
    } else if (bucket === "private") {
      s += 0.8;
      identity = true;
      factors.push(`same-funder:${a.first_inflow_from.slice(0, 8)}…`);
    } else if (bucket === "cex" || bucket === "swap") {
      // Same exact CEX/swap hot wallet — one withdrawal funded both proxies.
      s += 0.5;
      factors.push(`same-${bucket}-hot:${a.funding_source}`);
    } else if (bucket === "fiat") {
      // Same fiat onramp hot wallet — weaker than CEX/swap because two
      // people running KYC card purchases through the same MoonPay hot in
      // tight window is genuinely rarer, but possible. Still a real link.
      s += 0.4;
      factors.push(`same-fiat-hot:${a.funding_source}`);
    }
  } else if (
    a.funding_source !== null &&
    a.funding_source === b.funding_source &&
    a.first_inflow_ts !== null &&
    b.first_inflow_ts !== null
  ) {
    // Same brand (any hot of same CEX/swap/fiat) within tight window.
    const bucket = categoryBucket(a.funding_source);
    if (bucket === "cex" || bucket === "swap") {
      const dt = Math.abs(a.first_inflow_ts - b.first_inflow_ts);
      if (dt <= CEX_SAME_TIGHT_MS) {
        s += 0.5;
        factors.push(`${a.funding_source}±${Math.round(dt / 86400000)}d`);
      } else {
        s += 0.1;
        factors.push(`${a.funding_source}-far`);
      }
    } else if (bucket === "fiat") {
      const dt = Math.abs(a.first_inflow_ts - b.first_inflow_ts);
      if (dt <= CEX_SAME_TIGHT_MS) {
        s += 0.4;
        factors.push(`${a.funding_source}±${Math.round(dt / 86400000)}d`);
      } else {
        s += 0.05;
        factors.push(`${a.funding_source}-far`);
      }
    }
  }

  // Same-side base contribution (guaranteed by the gate above).
  s += 0.3;
  factors.push(`same-side(${aSide === 0 ? "Yes" : "No"})`);

  // Similar timing of first significant trade?
  if (Math.abs(a.first_ts - b.first_ts) <= TIME_TOLERANCE_MS) {
    s += 0.4;
    factors.push(`time±${Math.round(Math.abs(a.first_ts - b.first_ts) / 60000)}min`);
  }

  // Similar total notional (rough proxy for "similar bet amounts")?
  if (within(a.total_notional, b.total_notional, AMOUNT_TOLERANCE)) {
    s += 0.4;
    factors.push(`size±${Math.round(AMOUNT_TOLERANCE * 100)}%`);
  }

  // Both fresh wallets?
  if (a.is_fresh && b.is_fresh) {
    s += 0.3;
    factors.push("burner-pair");
  }

  return { score: s, factors, identity };
}

function findClusters(adj: Map<string, Set<string>>): string[][] {
  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const node of adj.keys()) {
    if (visited.has(node)) continue;
    const cluster: string[] = [];
    const queue: string[] = [node];
    visited.add(node);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      cluster.push(cur);
      const neighbors = adj.get(cur);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    if (cluster.length >= MIN_CLUSTER_SIZE) clusters.push(cluster);
  }
  return clusters;
}

interface MarketMeta {
  slug: string;
  question: string;
  end_date: string;
}

interface ProfileBits {
  age_days: number | null;
  is_fresh: boolean;
  first_inflow_from: string | null;
  first_inflow_ts: number | null;
  funding_source: FundingCategory;
  bridge_origin_wallet: string | null;
  bridge_origin_funding_source: FundingCategory;
}

async function profileWallets(wallets: string[]): Promise<Map<string, ProfileBits>> {
  const out = new Map<string, ProfileBits>();
  for (const w of wallets) {
    try {
      const p: WalletProfile | null = await getProfile(w);
      if (!p) {
        out.set(w, {
          age_days: null,
          is_fresh: false,
          first_inflow_from: null,
          first_inflow_ts: null,
          funding_source: null,
          bridge_origin_wallet: null,
          bridge_origin_funding_source: null,
        });
        continue;
      }
      out.set(w, {
        age_days: p.age_days,
        is_fresh: p.age_days !== null && p.age_days < FRESH_AGE_DAYS,
        first_inflow_from: p.first_inflow_from ?? null,
        first_inflow_ts: p.first_meaningful_inflow_ts ?? null,
        funding_source: p.funding_source ?? null,
        bridge_origin_wallet: p.bridge_origin_wallet ?? null,
        bridge_origin_funding_source: p.bridge_origin_funding_source ?? null,
      });
    } catch {
      out.set(w, {
        age_days: null,
        is_fresh: false,
        first_inflow_from: null,
        first_inflow_ts: null,
        funding_source: null,
        bridge_origin_wallet: null,
        bridge_origin_funding_source: null,
      });
    }
  }
  return out;
}

interface AlertInfo {
  cluster: string[];
  maxPair: { a: string; b: string; score: number; factors: string[] };
  totalNotional: number;
  dominantSide: 0 | 1;
}

async function fireAlert(meta: MarketMeta, info: AlertInfo): Promise<void> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_CLUSTER;
  if (!chat) return;

  const wallets = info.cluster.map((w) => walletLink(w)).join(" · ");
  const endTxt = meta.end_date ? ` · ends ${shortDate(meta.end_date)}` : "";
  const text = [
    `🚨 *Coordinated cluster · ${info.cluster.length} wallets · ${sideLabel(info.dominantSide)}*`,
    "",
    eventLink(meta.slug, escapeMd(meta.question)),
    `${fmtMoney(info.totalNotional)} total${endTxt}`,
    "",
    wallets,
    `strongest pair ${info.maxPair.score.toFixed(2)} (${escapeMd(info.maxPair.factors.join(", "))})`,
  ].join("\n");

  await sendMessage({
    chatId: chat,
    threadId: thread || undefined,
    text,
    parseMode: "Markdown",
  });
  log("cluster", `alert: ${meta.slug} cluster=${info.cluster.length}`);
}

/**
 * Analyze a single market's enriched trades for coordinated clusters and fire
 * alerts if any qualifying connected component is found. Idempotent thanks to
 * alert-cooldown keyed by sorted wallet set.
 */
/**
 * Cluster-detect at the EVENT level: aggregates trades from every sub-market
 * of the event into one wallet-level view before pairwise scoring. Catches
 * "split the bet across strikes" pattern that per-market analysis missed.
 *
 * `meta.slug` here is the event_slug (cooldown + alert URL use it).
 */
/** Result of cluster detection on one event — shared by checkMarket (alerting) and clusterReport (TG command). */
interface DetectResult {
  clusters: string[][];
  wallets: Map<string, WalletAgg>;
  pairScoreMap: Map<string, PairScore>;
}

/**
 * Pure detection: aggregate event trades → drop tiny → enrich profiles →
 * pairwise score → connected components. No alerting, no cooldown side
 * effects. Returns null if nothing qualifies.
 */
async function detectClusters(eventSlug: string): Promise<DetectResult | null> {
  const trades = getForEvent(eventSlug, WINDOW_MS);
  if (trades.length < MIN_CLUSTER_SIZE) return null;

  const wallets = aggregateWallets(trades);
  const tinyWallets: string[] = [];
  for (const [w, agg] of wallets) {
    if (agg.total_notional < MIN_NOTIONAL) tinyWallets.push(w);
  }
  for (const w of tinyWallets) wallets.delete(w);
  if (wallets.size < MIN_CLUSTER_SIZE) return null;
  if (wallets.size > MAX_WALLETS_PER_MARKET) {
    const sorted = [...wallets.entries()].sort((a, b) => b[1].total_notional - a[1].total_notional);
    wallets.clear();
    for (const [w, a] of sorted.slice(0, MAX_WALLETS_PER_MARKET)) wallets.set(w, a);
  }

  const profiles = await profileWallets([...wallets.keys()]);
  for (const [w, agg] of wallets) {
    const p = profiles.get(w);
    if (p) {
      agg.age_days = p.age_days;
      agg.is_fresh = p.is_fresh;
      agg.first_inflow_from = p.first_inflow_from;
      agg.first_inflow_ts = p.first_inflow_ts;
      agg.funding_source = p.funding_source;
      agg.bridge_origin_wallet = p.bridge_origin_wallet;
      agg.bridge_origin_funding_source = p.bridge_origin_funding_source;
    }
  }

  // True-fanout pre-pass: resolve REAL on-chain recipient fanout so pairwiseScore
  // can neutralize edges through a shared conduit/disperser the profiled-only
  // getFunderFanout cap missed (the 0xaea4d1… case). ONLY probe addresses SHARED
  // by ≥2 wallets — an origin/funder unique to one wallet can never form an edge,
  // so probing it is wasted Alchemy load. This (plus the disk cache) is what
  // keeps the digest's ~60-cluster review from bursting the pool into 429.
  const originCount = new Map<string, number>();
  for (const a of wallets.values()) {
    const addrs = new Set<string>();
    if (a.bridge_origin_wallet) addrs.add(a.bridge_origin_wallet);
    if (a.first_inflow_from) addrs.add(a.first_inflow_from);
    for (const addr of addrs) originCount.set(addr, (originCount.get(addr) ?? 0) + 1);
  }
  // Only probe EVM (0x) addresses on Polygon — a non-EVM origin returns empty
  // and is neutralized directly in pairwiseScore (the `(non-evm)` branch).
  const sharedAddrs = [...originCount.entries()]
    .filter(([a, n]) => n >= 2 && a.startsWith("0x"))
    .map(([a]) => a);
  const highFanout = await markHighFanoutAddrs(sharedAddrs);

  const adj = new Map<string, Set<string>>();
  const pairScoreMap = new Map<string, PairScore>();
  const arr = [...wallets.values()];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i];
      const b = arr[j];
      const ps = pairwiseScore(a, b, highFanout);
      // EDGE requires an IDENTITY link (shared private funder/origin), not
      // just a ≥0.6 score. Otherwise time+size+same-side correlation (0.7+)
      // would connect every wallet that piled into a hot market within an
      // hour → a bloated component that one stray identity pair then
      // qualifies. Identity-only edges ⇒ a cluster IS a shared-funding
      // cohort. (burner/time/size remain score corroborators, shown in
      // factors, but never create an edge on their own.)
      if (ps.score < SCORE_PAIR_LINK || !ps.identity) continue;
      const key = a.wallet < b.wallet ? `${a.wallet}|${b.wallet}` : `${b.wallet}|${a.wallet}`;
      pairScoreMap.set(key, ps);
      if (!adj.has(a.wallet)) adj.set(a.wallet, new Set());
      if (!adj.has(b.wallet)) adj.set(b.wallet, new Set());
      adj.get(a.wallet)!.add(b.wallet);
      adj.get(b.wallet)!.add(a.wallet);
    }
  }

  const clusters = findClusters(adj);
  if (clusters.length === 0) return null;
  return { clusters, wallets, pairScoreMap };
}

const MIN_CURRENT_POSITION_USD = 100; // EOD review: drop members holding < this

/**
 * Current USD value a wallet still holds on `side` across the event's
 * conditionIds, via data-api positions. Returns -1 on error/unknown so the
 * caller does NOT drop a member just because the API hiccuped.
 */
async function currentSideValue(
  wallet: string,
  condIds: Set<string>,
  side: 0 | 1,
): Promise<number> {
  try {
    const res = await request(`https://data-api.polymarket.com/positions?user=${wallet}`, {
      bodyTimeout: 10_000,
      headersTimeout: 8_000,
    });
    if (res.statusCode !== 200) return -1;
    const arr = (await res.body.json()) as Array<{
      conditionId?: string; outcome?: string; currentValue?: number; size?: number;
    }>;
    let v = 0;
    for (const p of arr || []) {
      if (!condIds.has((p.conditionId || "").toLowerCase())) continue;
      const oc = String(p.outcome || "").toLowerCase();
      const pSide = oc === "no" ? 1 : oc === "yes" ? 0 : null;
      if (pSide !== side) continue;
      v += Number(p.currentValue ?? 0);
    }
    return v;
  } catch {
    return -1;
  }
}

/**
 * On-demand cluster report for the `/cluster <event_slug>` TG command.
 * Lists every detected cluster's member wallets with side / notional / age.
 *
 * EOD position re-review (user request): each member's CURRENT position on
 * its side is re-checked against data-api; members now holding < $100 (sold
 * out or dust) are dropped before reporting — the 48h-net that built the
 * cluster can be stale by end of day. A cluster that falls below
 * MIN_CLUSTER_SIZE after pruning is omitted. API errors never drop a member.
 */
export async function clusterReport(eventSlug: string): Promise<string> {
  let res: DetectResult | null;
  try {
    res = await detectClusters(eventSlug);
  } catch (e) {
    return `❌ cluster scan failed: ${(e as Error).message}`;
  }
  if (!res) return `🔍 no qualifying cluster on \`${eventSlug}\` (need ≥${MIN_CLUSTER_SIZE} linked wallets, each ≥$${MIN_NOTIONAL} in last 48h)`;

  const out: string[] = [`🔗 *Clusters on* \`${eventSlug}\``];
  let shown = 0;
  let prunedTotal = 0;
  for (const cluster of res.clusters) {
    let maxScore = 0;
    let maxFactors: string[] = [];
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const k = cluster[i] < cluster[j] ? `${cluster[i]}|${cluster[j]}` : `${cluster[j]}|${cluster[i]}`;
        const ps = res.pairScoreMap.get(k);
        // Anchor requires a strong IDENTITY pair (shared private funder/
        // origin), not mere time+size correlation.
        if (ps && ps.score >= SCORE_PAIR_STRONG && ps.identity && ps.score > maxScore) {
          maxScore = ps.score; maxFactors = ps.factors;
        }
      }
    }
    if (maxScore < SCORE_PAIR_STRONG) continue;

    // conditionIds spanned by this cluster's trades (for the position check).
    const condIds = new Set<string>();
    for (const w of cluster) {
      for (const t of res.wallets.get(w)?.trades ?? []) {
        if (t.market) condIds.add(t.market.toLowerCase());
      }
    }

    // EOD re-review: keep members still holding >= $100 on their side.
    const survivors: { agg: WalletAgg; side: 0 | 1; current: number }[] = [];
    for (const w of cluster) {
      const agg = res.wallets.get(w)!;
      const side: 0 | 1 = agg.net_outcome0_notional >= agg.net_outcome1_notional ? 0 : 1;
      const cur = await currentSideValue(agg.wallet, condIds, side);
      if (cur === -1 || cur >= MIN_CURRENT_POSITION_USD) {
        survivors.push({ agg, side, current: cur });
      } else {
        prunedTotal++;
      }
      await new Promise((r) => setTimeout(r, 80)); // throttle data-api
    }
    if (survivors.length < MIN_CLUSTER_SIZE) continue;

    shown++;
    const side0 = survivors.reduce((s, m) => s + m.agg.net_outcome0_notional, 0);
    const side1 = survivors.reduce((s, m) => s + m.agg.net_outcome1_notional, 0);
    const domSide = side0 >= side1 ? "YES" : "NO";
    // Total = sum of current positions where known, else 48h-net fallback.
    const total = survivors.reduce(
      (s, m) => s + (m.current >= 0 ? m.current : m.agg.total_notional), 0);
    out.push(`\n*Cluster ${shown}* — ${survivors.length} wallets · *${domSide}* · $${Math.round(total).toLocaleString("en-US")} held · pair ${maxScore.toFixed(2)} (${maxFactors.join(", ")})`);
    survivors.sort((a, b) => (b.current >= 0 ? b.current : b.agg.total_notional) - (a.current >= 0 ? a.current : a.agg.total_notional));
    for (const { agg, side, current } of survivors) {
      const wSide = side === 0 ? "Y" : "N";
      const amt = current >= 0 ? current : Math.abs(agg.net_outcome0_notional - agg.net_outcome1_notional);
      const age = agg.age_days === null ? "no-inflow" : `${agg.age_days}d`;
      const fund = agg.funding_source ? ` · ${agg.funding_source}` : "";
      out.push(`• [${agg.wallet.slice(0, 6)}…${agg.wallet.slice(-4)}](https://polygonscan.com/address/${agg.wallet}) ${wSide} $${Math.round(amt).toLocaleString("en-US")} · ${age}${fund}`);
    }
  }
  if (shown === 0) return `🔍 linked wallets on \`${eventSlug}\` but none survive (strong-pair ≥${SCORE_PAIR_STRONG} + ≥${MIN_CLUSTER_SIZE} members still holding ≥$${MIN_CURRENT_POSITION_USD})`;
  if (prunedTotal > 0) out.push(`\n_(${prunedTotal} member(s) pruned: sold out / < $${MIN_CURRENT_POSITION_USD})_`);
  return out.join("\n");
}

export async function checkMarket(eventSlug: string, meta: MarketMeta): Promise<void> {
  const res = await detectClusters(eventSlug);
  if (!res) return;
  const { clusters, wallets, pairScoreMap } = res;

  for (const cluster of clusters) {
    // Require at least one strong IDENTITY pair (≥0.8 AND a shared private
    // funder/origin). Time+size+same-side correlation alone does NOT anchor
    // a cluster — that's just a hot market.
    let maxPair = { a: "", b: "", score: 0, factors: [] as string[] };
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const a = cluster[i];
        const b = cluster[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const ps = pairScoreMap.get(key);
        if (!ps) continue;
        if (ps.score >= SCORE_PAIR_STRONG && ps.identity && ps.score > maxPair.score) {
          maxPair = { a, b, score: ps.score, factors: ps.factors };
        }
      }
    }
    if (maxPair.score < SCORE_PAIR_STRONG) continue;

    // Per-EVENT cooldown — was per-wallet-core (sorted lowest triple) but
    // that fired drip alerts on hot events where multiple distinct clusters
    // formed concurrently (e.g. iran-ceasefire-continues-through fired 5x
    // in one cycle). User signal: one coord-cluster alert per event per
    // cooldown window is enough; if user wants to inspect distinct sub-
    // clusters they can /profile wallets manually.
    const cooldownKey = `cluster:${eventSlug}`;
    if (!canAlert(cooldownKey, COOLDOWN_MS)) continue;

    const totalNotional = cluster.reduce((s, w) => s + (wallets.get(w)?.total_notional ?? 0), 0);
    const dominantSide: 0 | 1 = cluster.reduce(
      (s, w) => s + (wallets.get(w)?.net_outcome0_notional ?? 0),
      0,
    ) >=
      cluster.reduce((s, w) => s + (wallets.get(w)?.net_outcome1_notional ?? 0), 0)
        ? 0
        : 1;

    await fireAlert(meta, { cluster, maxPair, totalNotional, dominantSide });
    markAlerted(cooldownKey);
  }
}
