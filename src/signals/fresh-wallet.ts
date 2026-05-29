import type { PolyTrade } from "../clob-rest.js";
import { getProfile, type WalletProfile } from "../wallet-profiler.js";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { eventLink, walletLink, fmtMoney, sideLabel, shortDate, EXTREME_PRICE_HIGH } from "../alert-format.js";
import { escapeMd } from "../markdown.js";
import { log } from "../log.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // per (wallet, market)
const NOTIONAL_THRESHOLD = 5000; // $5k 24h net buy position
/**
 * Higher threshold for the "no $1k+ inflow on record" alert path —
 * wallet has somehow accumulated $10k+ active position without us
 * seeing any meaningful incoming USDC transfer (small inflows summing
 * up to that much is genuinely rare and worth flagging).
 */
const NOTIONAL_THRESHOLD_NO_INFLOW = 10000;
const SCORE_THRESHOLD = 6;
const GC_INTERVAL_MS = 6 * 60 * 60 * 1000; // sweep stale wallets every 6h
const WALLET_STALE_MS = MONTH_MS; // drop wallet entries inactive ≥30d
const POSITIONS_HARD_CAP = 50_000; // hard ceiling — emergency eviction

/**
 * Per-wallet, per-market rolling 24h buy notional tracker.
 * Map<wallet, Map<market, Array<{ts, notional, outcomeIndex}>>>
 *
 * Outer Map is GC-swept every 6h: wallets that haven't traded any market
 * in ≥30 days get dropped. Inner array entries fall out of the 24h window
 * lazily via trim() on every signal check.
 */
type Bucket = { ts: number; notional: number; outcomeIndex: 0 | 1 };
const positions = new Map<string, Map<string, Bucket[]>>();
/** wallet → max ts across all its markets, for cheap staleness check. */
const lastSeenByWallet = new Map<string, number>();
let lastGcTs = Date.now();

function trim(arr: Bucket[]): Bucket[] {
  const cutoff = Date.now() - DAY_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  return arr;
}

/**
 * Returns {net0, net1} buy notional over the last 24h for the array.
 * Caller decides which side dominates — we no longer collapse into a single
 * signed scalar because that loses outcome attribution for the alert text.
 */
function net24h(arr: Bucket[]): { side0: number; side1: number } {
  trim(arr);
  let side0 = 0;
  let side1 = 0;
  for (const b of arr) {
    if (b.outcomeIndex === 0) side0 += b.notional;
    else side1 += b.notional;
  }
  return { side0, side1 };
}

function sweepStaleWallets(): void {
  const now = Date.now();
  if (now - lastGcTs < GC_INTERVAL_MS) return;
  const cutoff = now - WALLET_STALE_MS;
  let dropped = 0;
  for (const [w, last] of lastSeenByWallet) {
    if (last < cutoff) {
      positions.delete(w);
      lastSeenByWallet.delete(w);
      dropped++;
    }
  }
  // Emergency hard cap — if still oversized, drop oldest until under cap.
  if (positions.size > POSITIONS_HARD_CAP) {
    const sorted = [...lastSeenByWallet.entries()].sort((a, b) => a[1] - b[1]);
    const drop = positions.size - POSITIONS_HARD_CAP;
    for (let i = 0; i < drop && i < sorted.length; i++) {
      positions.delete(sorted[i][0]);
      lastSeenByWallet.delete(sorted[i][0]);
      dropped++;
    }
  }
  lastGcTs = now;
  if (dropped > 0) log("fresh-wallet", `gc swept ${dropped} stale wallets, ${positions.size} remain`);
}

interface AlertMeta {
  /** Parent event slug — signal aggregates 24h notional ACROSS all sub-markets of this event. */
  event_slug: string;
  /** Event title for the alert message. */
  event_title: string;
  /** Sub-market slug the actual trade hit (for context in the alert). */
  sub_slug: string;
  end_date: string;
  risk_tag: string;
}

export async function handleEnrichedTrade(
  trade: PolyTrade,
  meta: AlertMeta,
): Promise<void> {
  if (trade.side !== "BUY") return; // only count opens for now
  // Skip near-certain bets — buying at >=95c means the market already
  // priced it in, no informational edge. (Only the high end: a cheap buy
  // at <=5c is a long-shot/contrarian position which CAN be informative.)
  if (trade.price >= EXTREME_PRICE_HIGH) return;

  sweepStaleWallets();

  // Aggregate 24h notional at the EVENT level — wallet hedging across N
  // sub-markets of one event was previously invisible (per-market threshold
  // never tripped). Now we sum across all sub-markets of the parent event.
  const wallet = trade.proxyWallet.toLowerCase();
  let perWallet = positions.get(wallet);
  if (!perWallet) {
    perWallet = new Map();
    positions.set(wallet, perWallet);
  }
  // Key the per-wallet bucket by event_slug, not conditionId.
  let arr = perWallet.get(meta.event_slug);
  if (!arr) {
    arr = [];
    perWallet.set(meta.event_slug, arr);
  }
  const tradeTs = trade.timestamp * 1000;
  const notional = trade.size * trade.price;
  arr.push({ ts: tradeTs, notional, outcomeIndex: trade.outcomeIndex });
  lastSeenByWallet.set(wallet, Math.max(lastSeenByWallet.get(wallet) ?? 0, tradeTs));

  const { side0, side1 } = net24h(arr);
  const dominantIdx: 0 | 1 = side0 >= side1 ? 0 : 1;
  const dominantNotional = Math.max(side0, side1);

  const profile = await getProfile(wallet);
  if (!profile) return;

  const pathA = profile.score >= SCORE_THRESHOLD && dominantNotional >= NOTIONAL_THRESHOLD;
  const pathB =
    profile.age_days === null && dominantNotional >= NOTIONAL_THRESHOLD_NO_INFLOW;
  if (!pathA && !pathB) return;

  const key = `freshwallet:${wallet}:${meta.event_slug}`;
  if (!canAlert(key, COOLDOWN_MS)) return;

  await fireAlert(trade, meta, profile, dominantNotional, dominantIdx, pathB);
  markAlerted(key);
}

async function fireAlert(
  trade: PolyTrade,
  meta: AlertMeta,
  profile: WalletProfile,
  net: number,
  dominantIdx: 0 | 1,
  noInflowPath: boolean,
): Promise<void> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_FRESH;
  if (!chat) return;

  const endTxt = meta.end_date ? ` · ends ${shortDate(meta.end_date)}` : "";
  const ageTxt =
    profile.age_days === null
      ? "no $1k+ USDC inflow on record"
      : `${profile.age_days}d since first $1k+ USDC inflow`;
  const subDetail = meta.sub_slug && meta.sub_slug !== meta.event_slug
    ? ` (sub: \`${escapeMd(meta.sub_slug)}\`)`
    : "";

  const header = noInflowPath
    ? "🚨 *Fresh wallet — hidden funding*"
    : "🚨 *Fresh wallet*";

  // Funding-origin line: show the exchange when we resolved one (either the
  // funder is directly a known CEX, or it was a fresh one-time conduit we
  // traced one hop back to its exchange). When the funder is instead an
  // ESTABLISHED unknown wallet, surface IT (its age is the signal) rather
  // than hiding it behind a CEX label.
  const brand = (c: string | null) => (c ? escapeMd(c.split(":")[1] || c) : null);
  let fundingTxt: string | null = null;
  const originBrand = brand(profile.bridge_origin_funding_source);
  if (originBrand && profile.funder_is_conduit) {
    fundingTxt = `💰 via *${originBrand}* (one-time conduit)`;
  } else if (originBrand) {
    fundingTxt = `💰 via *${originBrand}*`;
  } else if (profile.bridge_origin_wallet) {
    const age = profile.funder_age_days;
    const aged = age !== null ? ` · aged ${age}d ⚠️ established` : "";
    fundingTxt = `💰 funder ${walletLink(profile.bridge_origin_wallet)}${aged}`;
  } else if (profile.funding_source) {
    fundingTxt = `💰 via *${brand(profile.funding_source)}*`;
  }

  const text = [
    header,
    "",
    eventLink(meta.event_slug, escapeMd(meta.event_title || meta.event_slug)),
    `${fmtMoney(net)} ${sideLabel(dominantIdx)} @${trade.price.toFixed(2)}${subDetail}${endTxt}`,
    "",
    `${walletLink(profile.wallet)} · score ${profile.score}/10`,
    ageTxt,
    fundingTxt,
  ].filter((x) => x).join("\n");

  await sendMessage({
    chatId: chat,
    threadId: thread || undefined,
    text,
    parseMode: "Markdown",
  });
  log(
    "fresh-wallet",
    `alert: ${profile.wallet} on event ${meta.event_slug} net=$${net.toFixed(0)} score=${profile.score} path=${noInflowPath ? "B" : "A"}`,
  );
}
