import { getProfile, type WalletProfile } from "../wallet-profiler.js";
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
}

const CEX_SAME_TIGHT_MS = 7 * 24 * 60 * 60 * 1000;

function pairwiseScore(a: WalletAgg, b: WalletAgg): PairScore {
  const factors: string[] = [];
  let s = 0;

  // Phase 6b: same true origin on source chain (after Relay tracing).
  // Critical: only fire if the origin itself is a private wallet, not a
  // CEX hot wallet or service. Many real users withdraw from the same
  // Binance Solana / Coinbase Base hot wallet — that's noise, not signal.
  if (
    a.bridge_origin_wallet &&
    b.bridge_origin_wallet &&
    a.bridge_origin_wallet === b.bridge_origin_wallet
  ) {
    const originBucket = categoryBucket(a.bridge_origin_funding_source);
    if (originBucket === "private") {
      s += 0.8;
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
    a.first_inflow_from === b.first_inflow_from
  ) {
    const bucket = categoryBucket(a.funding_source);
    if (bucket === "private") {
      s += 0.8;
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

  // Same dominant side? Skip the factor entirely when either wallet has
  // no net position on either side (e.g. only-SELLs cancelling earlier buys).
  // Previously these defaulted to side 0 and inflated false-positive clustering.
  const aHas = a.net_outcome0_notional > 0 || a.net_outcome1_notional > 0;
  const bHas = b.net_outcome0_notional > 0 || b.net_outcome1_notional > 0;
  if (aHas && bHas) {
    const aSide = a.net_outcome0_notional >= a.net_outcome1_notional ? 0 : 1;
    const bSide = b.net_outcome0_notional >= b.net_outcome1_notional ? 0 : 1;
    if (aSide === bSide) {
      s += 0.3;
      factors.push(`same-side(${aSide === 0 ? "Yes" : "No"})`);
    }
  }

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

  return { score: s, factors };
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

  const adj = new Map<string, Set<string>>();
  const pairScoreMap = new Map<string, PairScore>();
  const arr = [...wallets.values()];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i];
      const b = arr[j];
      const ps = pairwiseScore(a, b);
      if (ps.score < SCORE_PAIR_LINK) continue;
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

/**
 * On-demand cluster report for the `/cluster <event_slug>` TG command.
 * Lists every detected cluster's member wallets with side / notional /
 * age so the user can actually act on the "cluster exists" fact.
 * Returns a Markdown string (caller sends it).
 */
export async function clusterReport(eventSlug: string): Promise<string> {
  let res: DetectResult | null;
  try {
    res = await detectClusters(eventSlug);
  } catch (e) {
    return `❌ cluster scan failed: ${(e as Error).message}`;
  }
  if (!res) return `🔍 no qualifying cluster on \`${eventSlug}\` (need ≥${MIN_CLUSTER_SIZE} linked wallets, each ≥$${MIN_NOTIONAL} in last 48h)`;

  // Keep only clusters with a strong (≥0.8) internal pair, matching the
  // alert bar, so the report mirrors what would have fired.
  const out: string[] = [`🔗 *Clusters on* \`${eventSlug}\``];
  let shown = 0;
  for (const cluster of res.clusters) {
    let maxScore = 0;
    let maxFactors: string[] = [];
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const k = cluster[i] < cluster[j] ? `${cluster[i]}|${cluster[j]}` : `${cluster[j]}|${cluster[i]}`;
        const ps = res.pairScoreMap.get(k);
        if (ps && ps.score > maxScore) { maxScore = ps.score; maxFactors = ps.factors; }
      }
    }
    if (maxScore < SCORE_PAIR_STRONG) continue;
    shown++;
    const side0 = cluster.reduce((s, w) => s + (res!.wallets.get(w)?.net_outcome0_notional ?? 0), 0);
    const side1 = cluster.reduce((s, w) => s + (res!.wallets.get(w)?.net_outcome1_notional ?? 0), 0);
    const domSide = side0 >= side1 ? "YES" : "NO";
    const total = cluster.reduce((s, w) => s + (res!.wallets.get(w)?.total_notional ?? 0), 0);
    out.push(`\n*Cluster ${shown}* — ${cluster.length} wallets · *${domSide}* · $${Math.round(total).toLocaleString("en-US")} · pair ${maxScore.toFixed(2)} (${maxFactors.join(", ")})`);
    const rows = cluster
      .map((w) => res!.wallets.get(w)!)
      .sort((a, b) => b.total_notional - a.total_notional);
    for (const agg of rows) {
      const net = agg.net_outcome0_notional - agg.net_outcome1_notional;
      const wSide = net >= 0 ? "Y" : "N";
      const amt = Math.abs(net);
      const age = agg.age_days === null ? "no-inflow" : `${agg.age_days}d`;
      const fund = agg.funding_source ? ` · ${agg.funding_source}` : "";
      out.push(`• [${agg.wallet.slice(0, 6)}…${agg.wallet.slice(-4)}](https://polygonscan.com/address/${agg.wallet}) ${wSide} $${Math.round(amt).toLocaleString("en-US")} · ${age}${fund}`);
    }
  }
  if (shown === 0) return `🔍 linked wallets found on \`${eventSlug}\` but none meet the strong-pair bar (≥${SCORE_PAIR_STRONG})`;
  return out.join("\n");
}

export async function checkMarket(eventSlug: string, meta: MarketMeta): Promise<void> {
  const res = await detectClusters(eventSlug);
  if (!res) return;
  const { clusters, wallets, pairScoreMap } = res;

  for (const cluster of clusters) {
    // Require at least one strong pair (≥0.8) within the cluster.
    let maxPair = { a: "", b: "", score: 0, factors: [] as string[] };
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const a = cluster[i];
        const b = cluster[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const ps = pairScoreMap.get(key);
        if (!ps) continue;
        if (ps.score > maxPair.score) {
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
