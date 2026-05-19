import type { PolyTrade } from "../clob-rest.js";
import { getProfile, type WalletProfile } from "../wallet-profiler.js";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
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
  slug: string;
  question: string;
  end_date: string;
  risk_tag: string;
}

export async function handleEnrichedTrade(
  trade: PolyTrade,
  meta: AlertMeta,
): Promise<void> {
  if (trade.side !== "BUY") return; // only count opens for now

  sweepStaleWallets();

  const wallet = trade.proxyWallet.toLowerCase();
  let perWallet = positions.get(wallet);
  if (!perWallet) {
    perWallet = new Map();
    positions.set(wallet, perWallet);
  }
  let arr = perWallet.get(trade.conditionId);
  if (!arr) {
    arr = [];
    perWallet.set(trade.conditionId, arr);
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

  // Two alert paths, both gated by a (wallet, market) cooldown:
  //   A) fresh wallet (score ≥ 6) AND 24h dominant-side ≥ $5k
  //   B) no $1k+ USDC inflow on record AND 24h dominant-side ≥ $10k
  //      (caught by the redesigned score-1 path — see wallet-profiler)
  const pathA = profile.score >= SCORE_THRESHOLD && dominantNotional >= NOTIONAL_THRESHOLD;
  const pathB =
    profile.age_days === null && dominantNotional >= NOTIONAL_THRESHOLD_NO_INFLOW;
  if (!pathA && !pathB) return;

  const key = `freshwallet:${wallet}:${trade.conditionId}`;
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

  const ageTxt =
    profile.age_days === null
      ? "*no $1k+ USDC inflow on record (hidden funding)*"
      : `${profile.age_days}d since first $1k+ USDC inflow`;
  const endShort = meta.end_date ? meta.end_date.slice(0, 10) : "";
  const dominantOutcome = dominantIdx === 0 ? "Yes" : "No";
  const header = noInflowPath
    ? `🚨 *Fresh wallet (hidden funding)* — \`${escapeMd(meta.slug)}\``
    : `🚨 *Fresh wallet* — \`${escapeMd(meta.slug)}\``;

  const text = [
    header,
    `_${escapeMd(meta.question)}_`,
    `wallet \`${profile.wallet}\` score=${profile.score}/10`,
    ageTxt,
    `24h net ${dominantOutcome}: $${net.toFixed(0)}  @${trade.price.toFixed(2)}`,
    endShort ? `⏳ ends ${endShort}` : null,
    `https://polymarket.com/market/${meta.slug}`,
    `https://polygonscan.com/address/${profile.wallet}`,
  ]
    .filter((x) => x)
    .join("\n");

  await sendMessage({
    chatId: chat,
    threadId: thread || undefined,
    text,
    parseMode: "Markdown",
  });
  log(
    "fresh-wallet",
    `alert: ${profile.wallet} on ${meta.slug} net=$${net.toFixed(0)} score=${profile.score} path=${noInflowPath ? "B" : "A"}`,
  );
}
