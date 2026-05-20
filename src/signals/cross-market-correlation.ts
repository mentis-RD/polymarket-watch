import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { escapeMd } from "../markdown.js";
import { log } from "../log.js";
import { getRecent, type EnrichedTrade } from "../enriched-store.js";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_MARKET_NOTIONAL = 100; // ignore dust positions
const MIN_CLUSTER_SIZE = 3; // need ≥3 correlated markets
const MIN_SHARED_KEYWORDS = 2; // need ≥2 overlapping keywords to link
const MIN_DOMINANT_SIDE = 0.7; // ≥70% of notional on one side
const MIN_CLUSTER_NOTIONAL = 1000; // wallet must risk ≥$1k across the cluster
const COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * Common English/Polymarket slug tokens that carry no semantic load.
 * Tokens are matched case-insensitively after splitting slug by `-` / `_` / whitespace.
 */
const STOPWORDS = new Set([
  // English stopwords
  "the", "and", "are", "but", "for", "not", "you", "with", "from", "this",
  "that", "have", "has", "had", "his", "her", "him", "she", "they", "them",
  "their", "what", "when", "where", "which", "who", "whom", "how", "why",
  "will", "would", "could", "should", "did", "does", "doing", "was", "were",
  "been", "being", "before", "after", "into", "onto", "than", "then", "above",
  "below", "over", "under", "more", "most", "less", "least", "very", "some",
  "any", "all", "each", "every", "other", "another", "such", "only", "own",
  "same", "off", "out", "down", "between",
  // Polymarket-specific noise
  "yes", "no", "market", "happen", "happens", "happening", "before",
  "vs", "or", "of", "in", "on", "at", "to", "by", "as", "is", "be",
  "an", "a", "i",
  // Year tokens — markets about same year shouldn't link by year alone
  "2023", "2024", "2025", "2026", "2027",
  // Numeric date-like suffixes commonly seen
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  // Common verb modifiers
  "win", "wins", "won", "lose", "loses", "lost", "beat", "beats",
]);

// EnrichedTrade type imported from enriched-store (shared with cluster + tracker)

interface MarketBet {
  slug: string;
  market: string;
  total_notional: number;
  net_outcome0_notional: number; // signed: BUYs add, SELLs subtract
  net_outcome1_notional: number;
  keywords: Set<string>;
  first_ts: number;
  last_ts: number;
}

function tokenizeSlug(slug: string): Set<string> {
  const tokens = slug.toLowerCase().split(/[-_\s/]+/);
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue; // pure numeric IDs
    out.add(t);
  }
  return out;
}

function aggregatePerWallet(trades: EnrichedTrade[]): Map<string, Map<string, MarketBet>> {
  // wallet → event_slug → MarketBet (aggregated across all sub-markets
  // of the event). Falls back to sub-market slug for old data without
  // event_slug. Cross-market correlation between EVENTS is much more
  // signal-rich than between strikes of the same event.
  const out = new Map<string, Map<string, MarketBet>>();
  for (const t of trades) {
    const w = t.wallet.toLowerCase();
    let perWallet = out.get(w);
    if (!perWallet) {
      perWallet = new Map();
      out.set(w, perWallet);
    }
    const groupSlug = t.event_slug ?? t.slug;
    let bet = perWallet.get(groupSlug);
    if (!bet) {
      bet = {
        slug: groupSlug,
        market: t.market,
        total_notional: 0,
        net_outcome0_notional: 0,
        net_outcome1_notional: 0,
        keywords: tokenizeSlug(groupSlug),
        first_ts: t.ts,
        last_ts: t.ts,
      };
      perWallet.set(groupSlug, bet);
    }
    bet.total_notional += t.notional;
    bet.first_ts = Math.min(bet.first_ts, t.ts);
    bet.last_ts = Math.max(bet.last_ts, t.ts);
    const sign = t.side === "BUY" ? 1 : -1;
    if (t.outcomeIndex === 0) bet.net_outcome0_notional += sign * t.notional;
    else bet.net_outcome1_notional += sign * t.notional;
  }
  return out;
}

const MAX_MARKETS_PER_WALLET = 100; // hard cap for the O(M²) pair check

function findKeywordClusters(bets: MarketBet[]): MarketBet[][] {
  let filtered = bets.filter(
    (b) => b.total_notional >= MIN_MARKET_NOTIONAL && b.keywords.size >= MIN_SHARED_KEYWORDS,
  );
  if (filtered.length < MIN_CLUSTER_SIZE) return [];
  // Heavy traders (hundreds of markets in 7 days) would generate
  // hundreds-of-thousands of pair checks. Cap at top-N by notional so the
  // scan stays bounded; we still detect the most significant correlations.
  if (filtered.length > MAX_MARKETS_PER_WALLET) {
    filtered = [...filtered]
      .sort((a, b) => b.total_notional - a.total_notional)
      .slice(0, MAX_MARKETS_PER_WALLET);
  }

  // Build adjacency via shared-keyword count.
  const adj = new Map<string, Set<string>>();
  for (let i = 0; i < filtered.length; i++) {
    for (let j = i + 1; j < filtered.length; j++) {
      const a = filtered[i];
      const b = filtered[j];
      let shared = 0;
      for (const k of a.keywords) {
        if (b.keywords.has(k)) {
          shared++;
          if (shared >= MIN_SHARED_KEYWORDS) break;
        }
      }
      if (shared >= MIN_SHARED_KEYWORDS) {
        if (!adj.has(a.slug)) adj.set(a.slug, new Set());
        if (!adj.has(b.slug)) adj.set(b.slug, new Set());
        adj.get(a.slug)!.add(b.slug);
        adj.get(b.slug)!.add(a.slug);
      }
    }
  }

  // BFS connected components.
  const slugToBet = new Map(filtered.map((b) => [b.slug, b]));
  const visited = new Set<string>();
  const clusters: MarketBet[][] = [];
  for (const slug of adj.keys()) {
    if (visited.has(slug)) continue;
    const queue: string[] = [slug];
    visited.add(slug);
    const cluster: MarketBet[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const b = slugToBet.get(cur);
      if (b) cluster.push(b);
      for (const n of adj.get(cur) || []) {
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

function dominantSide(cluster: MarketBet[]): { side: 0 | 1; ratio: number; notional: number } {
  let side0 = 0;
  let side1 = 0;
  for (const b of cluster) {
    side0 += Math.max(0, b.net_outcome0_notional);
    side1 += Math.max(0, b.net_outcome1_notional);
  }
  const total = side0 + side1;
  if (total === 0) return { side: 0, ratio: 0, notional: 0 };
  if (side0 >= side1) return { side: 0, ratio: side0 / total, notional: side0 + side1 };
  return { side: 1, ratio: side1 / total, notional: side0 + side1 };
}

function topSharedKeywords(cluster: MarketBet[], k = 3): string[] {
  const counts = new Map<string, number>();
  for (const b of cluster) {
    for (const kw of b.keywords) {
      counts.set(kw, (counts.get(kw) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([w]) => w);
}

async function fireAlert(wallet: string, cluster: MarketBet[]): Promise<void> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_CLUSTER;
  if (!chat) return;

  const dom = dominantSide(cluster);
  const shared = topSharedKeywords(cluster);

  // Cooldown keyed on wallet + sorted top-3 slugs (cluster "core") so that
  // adding a 4th correlated market doesn't immediately re-alert. Cluster
  // membership often grows by one over time.
  const core = cluster.map((b) => b.slug).sort().slice(0, 3).join(",");
  const cooldownKey = `xmarket:${wallet}:${core}`;
  if (!canAlert(cooldownKey, COOLDOWN_MS)) return;

  const lines = [
    `🚨 *Cross-market correlation* — wallet \`${wallet.slice(0, 6)}…${wallet.slice(-4)}\``,
    `${cluster.length} related markets, keywords: ${shared.map((k) => `\`${escapeMd(k)}\``).join(", ") || "—"}`,
    `dominant side: ${dom.side === 0 ? "Yes" : "No"} (${Math.round(dom.ratio * 100)}%), total ≈ $${dom.notional.toFixed(0)}`,
    "",
    ...cluster.slice(0, 8).map((b) => {
      const net = b.net_outcome0_notional - b.net_outcome1_notional;
      const dir = net >= 0 ? "Y" : "N";
      const amt = Math.abs(net).toFixed(0);
      return `• \`${escapeMd(b.slug)}\` ${dir} $${amt}`;
    }),
    "",
    `https://polygonscan.com/address/${wallet}`,
  ].join("\n");

  await sendMessage({
    chatId: chat,
    threadId: thread || undefined,
    text: lines,
    parseMode: "Markdown",
  });
  markAlerted(cooldownKey);
  log(
    "cross-market",
    `alert: ${wallet} ${cluster.length} markets, $${dom.notional.toFixed(0)}`,
  );
}

/**
 * Run cross-market correlation scan across all enriched-trade activity in the
 * last 7 days. Caller invokes from trade-enricher every N cycles.
 */
export async function runScan(): Promise<{ wallets_scanned: number; alerts: number }> {
  const trades = getRecent(WINDOW_MS);
  if (trades.length === 0) return { wallets_scanned: 0, alerts: 0 };

  const perWallet = aggregatePerWallet(trades);
  let alerts = 0;
  for (const [wallet, marketsMap] of perWallet) {
    if (marketsMap.size < MIN_CLUSTER_SIZE) continue;
    const bets = [...marketsMap.values()];
    const clusters = findKeywordClusters(bets);
    for (const cluster of clusters) {
      const dom = dominantSide(cluster);
      if (dom.ratio < MIN_DOMINANT_SIDE) continue;
      if (dom.notional < MIN_CLUSTER_NOTIONAL) continue;
      await fireAlert(wallet, cluster);
      alerts++;
    }
  }
  return { wallets_scanned: perWallet.size, alerts };
}
