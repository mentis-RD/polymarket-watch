import { request } from "undici";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { escapeMd } from "../markdown.js";
import { walletLink, eventLink, fmtMoney, sideLabel, EXTREME_PRICE_HIGH } from "../alert-format.js";
import { log } from "../log.js";
import { getRecent, type EnrichedTrade } from "../enriched-store.js";
import { isConsensusFavoriteBuy } from "../consensus-gates.js";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_MARKET_NOTIONAL = 100; // ignore dust positions
const MIN_CLUSTER_SIZE = 3; // need ≥3 correlated markets
const MIN_SHARED_KEYWORDS = 2; // need ≥2 overlapping keywords to link
const MIN_DOMINANT_SIDE = 0.7; // ≥70% of notional on one side
const MIN_CLUSTER_NOTIONAL = 1000; // wallet must risk ≥$1k across the cluster
const COOLDOWN_MS = 48 * 60 * 60 * 1000; // was 12h → identical clusters re-fired ~twice/day

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

function aggregatePerWallet(trades: EnrichedTrade[], applyGate = false): Map<string, Map<string, MarketBet>> {
  // wallet → event_slug → MarketBet (aggregated across all sub-markets
  // of the event). Falls back to sub-market slug for old data without
  // event_slug. Cross-market correlation between EVENTS is much more
  // signal-rich than between strikes of the same event.
  const out = new Map<string, Map<string, MarketBet>>();
  for (const t of trades) {
    // Skip near-certain BUYs (>=95c) — no edge.
    if (t.side === "BUY" && t.price >= EXTREME_PRICE_HIGH) continue;
    // Consensus-side gate (live alerts only): on a gated "event happens by date"
    // market, a rich NO BUY is consensus, not edge — don't let it build a
    // cross-market cluster. Cheap NO / any YES still count. Off for the /xmarket
    // on-demand report (raw view of what the user explicitly asked for).
    if (applyGate && t.side === "BUY" && isConsensusFavoriteBuy(t.event_slug ?? t.slug, t.slug, t.outcomeIndex, t.price)) continue;
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

/**
 * Market-maker / bot guard for the AUTO-ALERT path. A wallet that trades
 * thousands of markets mechanically will trivially land ≥3 keyword-correlated
 * markets by coincidence — that overlap is noise, not a coordinated
 * cross-market thematic bet (the thing this signal exists to surface).
 *
 * The data-api caps historical `offset` at 3000, so this is the deepest
 * lifetime probe available: a trade existing at offset 3000 means the wallet
 * has >3000 lifetime trades. Cross-market is NOT a fresh-wallet signal, so the
 * cutoff is deliberately permissive — fresh-wallet wants brand-new wallets;
 * here we only exclude the extreme high-frequency tail (the `0xbacd…ab35`
 * 278k-predictions class the user flagged). One cheap request per firing
 * wallet. On any error / non-200 → treat as NOT high-freq (fire) so a
 * transient API hiccup never silently suppresses a real signal.
 */
const MM_LIFETIME_OFFSET = 3000; // data-api hard cap; "wallet has >3000 lifetime trades"

async function isHighFreqTrader(wallet: string): Promise<boolean> {
  try {
    const res = await request(
      `https://data-api.polymarket.com/trades?user=${wallet}&limit=1&offset=${MM_LIFETIME_OFFSET}`,
      { bodyTimeout: 10_000, headersTimeout: 8_000 },
    );
    if (res.statusCode !== 200) return false;
    const arr = (await res.body.json()) as unknown;
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

/** Returns true only if a message was actually sent (false if no chat / cooldown-suppressed). */
async function fireAlert(wallet: string, cluster: MarketBet[]): Promise<boolean> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_CLUSTER;
  if (!chat) return false;

  const dom = dominantSide(cluster);
  const shared = topSharedKeywords(cluster);

  // Cooldown keyed on wallet + sorted top-3 slugs (cluster "core") so adding a
  // 4th correlated market doesn't immediately re-alert, PLUS a notional bucket
  // (~50% growth steps) so the SAME cluster at the SAME size doesn't re-fire as
  // a useless identical duplicate (2026-05-30: $32,003 cluster fired verbatim
  // at 07:30 and 21:15 because the old 12h cooldown just elapsed). A materially
  // grown position lands in a new bucket → new key → re-alerts under its own
  // cooldown; an unchanged one stays quiet for the full 48h.
  const core = cluster.map((b) => b.slug).sort().slice(0, 3).join(",");
  const notionalBucket = Math.floor(Math.log(Math.max(1, dom.notional)) / Math.log(1.5));
  const cooldownKey = `xmarket:${wallet}:${core}:n${notionalBucket}`;
  if (!canAlert(cooldownKey, COOLDOWN_MS)) return false;

  const kwTxt = shared.map((k) => `\`${escapeMd(k)}\``).join(", ") || "—";
  const lines = [
    `🚨 *Cross-market correlation · ${cluster.length} markets · ${sideLabel(dom.side as 0 | 1)} ${Math.round(dom.ratio * 100)}%*`,
    "",
    `${walletLink(wallet)} · ${fmtMoney(dom.notional)} total`,
    `keywords: ${kwTxt}`,
    "",
    ...cluster.slice(0, 8).map((b) => {
      const net = b.net_outcome0_notional - b.net_outcome1_notional;
      const dir = net >= 0 ? "YES" : "NO";
      const amt = fmtMoney(Math.abs(net));
      return `• ${eventLink(b.slug, `\`${escapeMd(b.slug)}\``)} *${dir}* ${amt}`;
    }),
    `→ \`/xmarket ${wallet}\``,
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
  return true;
}

const MIN_CURRENT_POSITION_USD = 100; // EOD review: drop markets held < this

/** Fetch a wallet's current positions once → conditionId(lower) → {0:yesVal,1:noVal}. */
async function fetchPositionMap(wallet: string): Promise<Map<string, [number, number]> | null> {
  try {
    const res = await request(`https://data-api.polymarket.com/positions?user=${wallet}`, {
      bodyTimeout: 10_000, headersTimeout: 8_000,
    });
    if (res.statusCode !== 200) return null;
    const arr = (await res.body.json()) as Array<{ conditionId?: string; outcome?: string; currentValue?: number }>;
    const m = new Map<string, [number, number]>();
    for (const p of arr || []) {
      const cid = (p.conditionId || "").toLowerCase();
      if (!cid) continue;
      const oc = String(p.outcome || "").toLowerCase();
      const side = oc === "no" ? 1 : oc === "yes" ? 0 : null;
      if (side === null) continue;
      const cur = m.get(cid) ?? [0, 0];
      cur[side] += Number(p.currentValue ?? 0);
      m.set(cid, cur);
    }
    return m;
  } catch {
    return null;
  }
}

/**
 * On-demand drill-down for a cross-market alert: `/xmarket <wallet>`.
 * Re-detects the wallet's keyword-correlated market cluster(s) and lists the
 * markets with side / CURRENT held position, dominant side, shared keywords.
 * EOD review: a single data-api positions fetch prunes markets now held
 * < $100 (sold/dust); cluster dropped if < MIN_CLUSTER_SIZE survive. API
 * error → no pruning (conservative). Returns Markdown.
 */
export async function crossMarketReport(wallet: string): Promise<string> {
  const w = wallet.toLowerCase();
  const trades = getRecent(WINDOW_MS).filter((t) => t.wallet.toLowerCase() === w);
  if (trades.length === 0) return `🔍 no cross-market activity for \`${w.slice(0, 6)}…${w.slice(-4)}\` in last 7d`;
  const perWallet = aggregatePerWallet(trades);
  const bets = [...(perWallet.get(w)?.values() ?? [])];
  const clusters = findKeywordClusters(bets);
  if (clusters.length === 0) return `🔍 no correlated-market cluster for ${walletLink(w)} (need ≥${MIN_CLUSTER_SIZE} markets sharing ≥${MIN_SHARED_KEYWORDS} keywords)`;

  // Event_slug → all conditionIds the wallet traded for it. A cross-market
  // bet is event-level but `bet.market` holds only ONE sub-market cid, so a
  // multi-strike hold on a different strike would falsely read $0. Sum the
  // wallet's current position over EVERY cid it traded for the event.
  const eventCids = new Map<string, Set<string>>();
  for (const t of trades) {
    const ev = t.event_slug ?? t.slug;
    (eventCids.get(ev) ?? eventCids.set(ev, new Set()).get(ev)!).add((t.market || "").toLowerCase());
  }
  const heldOnSide = (
    positions: Map<string, [number, number]> | null,
    eventSlug: string,
    side: 0 | 1,
  ): number | null => {
    if (!positions) return null; // unknown
    let v = 0;
    for (const cid of eventCids.get(eventSlug) ?? []) v += positions.get(cid)?.[side] ?? 0;
    return v;
  };

  const positions = await fetchPositionMap(w); // null = unknown → don't prune
  const out: string[] = [`🔗 *Cross-market for* ${walletLink(w)}`];
  let shownClusters = 0;
  let pruned = 0;
  for (const cluster of clusters) {
    // EOD review per market: keep where current held on the bet side >= $100.
    const survivors = cluster.filter((b) => {
      const side = b.net_outcome0_notional >= b.net_outcome1_notional ? 0 : 1;
      const cur = heldOnSide(positions, b.slug, side);
      if (cur === null || cur >= MIN_CURRENT_POSITION_USD) return true;
      pruned++;
      return false;
    });
    if (survivors.length < MIN_CLUSTER_SIZE) continue;
    shownClusters++;
    const dom = dominantSide(survivors);
    const shared = topSharedKeywords(survivors);
    const kwTxt = shared.map((k) => `\`${escapeMd(k)}\``).join(", ") || "—";
    out.push(`\n*${survivors.length} markets · ${sideLabel(dom.side as 0 | 1)} ${Math.round(dom.ratio * 100)}% · ${fmtMoney(dom.notional)}*`);
    out.push(`keywords: ${kwTxt}`);
    const rows = survivors
      .map((b) => {
        const side = b.net_outcome0_notional >= b.net_outcome1_notional ? 0 : 1;
        const cur = heldOnSide(positions, b.slug, side);
        const net = Math.abs(b.net_outcome0_notional - b.net_outcome1_notional);
        const amt = cur !== null && cur > 0 ? cur : net;
        return { b, side, amt };
      })
      .sort((a, b) => b.amt - a.amt);
    for (const { b, side, amt } of rows) {
      out.push(`• ${eventLink(b.slug, `\`${escapeMd(b.slug)}\``)} *${side === 0 ? "YES" : "NO"}* $${Math.round(amt).toLocaleString("en-US")}`);
    }
  }
  if (shownClusters === 0) return `🔍 cross-market cluster for ${walletLink(w)} decayed — < ${MIN_CLUSTER_SIZE} markets still held ≥$${MIN_CURRENT_POSITION_USD}`;
  if (pruned > 0) out.push(`\n_(${pruned} market(s) pruned: sold / < $${MIN_CURRENT_POSITION_USD})_`);
  return out.join("\n");
}

/**
 * Run cross-market correlation scan across all enriched-trade activity in the
 * last 7 days. Caller invokes from trade-enricher every N cycles.
 */
export async function runScan(): Promise<{ wallets_scanned: number; alerts: number }> {
  const trades = getRecent(WINDOW_MS);
  if (trades.length === 0) return { wallets_scanned: 0, alerts: 0 };

  const perWallet = aggregatePerWallet(trades, true); // apply consensus gate on the alert path
  let alerts = 0;
  let mmSkipped = 0;
  for (const [wallet, marketsMap] of perWallet) {
    if (marketsMap.size < MIN_CLUSTER_SIZE) continue;
    const bets = [...marketsMap.values()];
    const clusters = findKeywordClusters(bets);
    // Only the clusters that pass the dominant-side + notional gates would fire.
    const firing = clusters.filter((cluster) => {
      const dom = dominantSide(cluster);
      return dom.ratio >= MIN_DOMINANT_SIDE && dom.notional >= MIN_CLUSTER_NOTIONAL;
    });
    if (firing.length === 0) continue;
    // Market-maker / bot guard: ONE lifetime-depth probe per wallet, and only
    // for wallets that would otherwise alert. Drop the extreme high-frequency
    // tail whose multi-market overlap is mechanical, not coordinated.
    if (await isHighFreqTrader(wallet)) {
      mmSkipped++;
      continue;
    }
    for (const cluster of firing) {
      // Count only messages actually sent — fireAlert cooldown-suppresses repeats,
      // so counting calls overstated "N alerts" in the scan summary (a recurring
      // cluster logged 2-3 "alerts" every scan while sending nothing).
      if (await fireAlert(wallet, cluster)) alerts++;
    }
  }
  if (mmSkipped > 0) log("cross-market", `skipped ${mmSkipped} high-frequency wallet(s) (>${MM_LIFETIME_OFFSET} lifetime trades)`);
  return { wallets_scanned: perWallet.size, alerts };
}
