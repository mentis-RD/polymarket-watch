import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { getProfile, type WalletProfile } from "../wallet-profiler.js";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { log } from "../log.js";
import { categoryBucket, type FundingCategory } from "../funding-source.js";

const ENRICHED_PATH = join(process.cwd(), "state", "trades_enriched.jsonl");

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

interface EnrichedTrade {
  ts: number;
  slug: string;
  market: string;
  wallet: string;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: 0 | 1;
  price: number;
  size: number;
  notional: number;
}

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

/** Read enriched trades for a single market within the window. */
function readMarketTrades(conditionId: string, sinceTs: number): EnrichedTrade[] {
  if (!existsSync(ENRICHED_PATH)) return [];
  const out: EnrichedTrade[] = [];
  const raw = readFileSync(ENRICHED_PATH, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const t = JSON.parse(line) as EnrichedTrade;
      if (t.market !== conditionId) continue;
      if (t.ts < sinceTs) continue;
      out.push(t);
    } catch {
      /* skip */
    }
  }
  return out;
}

function aggregateWallets(trades: EnrichedTrade[]): Map<string, WalletAgg> {
  const map = new Map<string, WalletAgg>();
  for (const t of trades) {
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
    } else if (originBucket === "cex") {
      // Same exact CEX hot wallet on source chain — weak signal at best.
      s += 0.2;
      factors.push(`same-cex-origin:${a.bridge_origin_funding_source}`);
    }
    // bridge/service origin → no factor at all
  }

  // Same direct funder (private wallet, not bridge/CEX) — strongest signal.
  if (
    a.first_inflow_from &&
    b.first_inflow_from &&
    a.first_inflow_from === b.first_inflow_from
  ) {
    const bucket = categoryBucket(a.funding_source);
    if (bucket === "private") {
      s += 0.8;
      factors.push(`same-funder:${a.first_inflow_from.slice(0, 8)}…`);
    } else if (bucket === "cex") {
      // Same exact CEX hot wallet — slightly less strong than private.
      s += 0.5;
      factors.push(`same-cex-hot:${a.funding_source}`);
    }
  } else if (
    a.funding_source !== null &&
    a.funding_source === b.funding_source &&
    categoryBucket(a.funding_source) === "cex" &&
    a.first_inflow_ts !== null &&
    b.first_inflow_ts !== null
  ) {
    // Same CEX (any hot wallet of same CEX) within tight window.
    const dt = Math.abs(a.first_inflow_ts - b.first_inflow_ts);
    if (dt <= CEX_SAME_TIGHT_MS) {
      s += 0.5;
      factors.push(`${a.funding_source}±${Math.round(dt / 86400000)}d`);
    } else {
      s += 0.1;
      factors.push(`${a.funding_source}-far`);
    }
  }

  // Same dominant side?
  const aSide = a.net_outcome0_notional >= a.net_outcome1_notional ? 0 : 1;
  const bSide = b.net_outcome0_notional >= b.net_outcome1_notional ? 0 : 1;
  if (aSide === bSide) {
    s += 0.3;
    factors.push(`same-side(${aSide === 0 ? "Yes" : "No"})`);
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

  const wallets = info.cluster.map((w) => `\`${w.slice(0, 6)}…${w.slice(-4)}\``).join(", ");
  const text = [
    `🚨 *Coordinated cluster* — \`${meta.slug}\``,
    `_${meta.question}_`,
    `cluster: ${info.cluster.length} wallets on ${info.dominantSide === 0 ? "Yes" : "No"}`,
    `${wallets}`,
    `total notional: $${info.totalNotional.toFixed(0)}`,
    `strongest pair score=${info.maxPair.score.toFixed(2)} (${info.maxPair.factors.join(", ")})`,
    meta.end_date ? `⏳ ends ${meta.end_date.slice(0, 10)}` : null,
    `https://polymarket.com/market/${meta.slug}`,
  ]
    .filter((x) => x)
    .join("\n");

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
export async function checkMarket(conditionId: string, meta: MarketMeta): Promise<void> {
  const trades = readMarketTrades(conditionId, Date.now() - WINDOW_MS);
  if (trades.length < MIN_CLUSTER_SIZE) return;

  const wallets = aggregateWallets(trades);
  // Drop tiny wallets.
  for (const [w, agg] of wallets) {
    if (agg.total_notional < MIN_NOTIONAL) wallets.delete(w);
  }
  if (wallets.size < MIN_CLUSTER_SIZE) return;
  if (wallets.size > MAX_WALLETS_PER_MARKET) {
    // Keep top N by notional.
    const sorted = [...wallets.entries()].sort((a, b) => b[1].total_notional - a[1].total_notional);
    wallets.clear();
    for (const [w, a] of sorted.slice(0, MAX_WALLETS_PER_MARKET)) wallets.set(w, a);
  }

  // Enrich with age + funding info.
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

  // Pairwise scoring → adjacency.
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
  if (clusters.length === 0) return;

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

    const sortedKey = [...cluster].sort().join(",");
    const cooldownKey = `cluster:${conditionId}:${sortedKey}`;
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
