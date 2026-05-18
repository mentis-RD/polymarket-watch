import type { PolyTrade } from "../clob-rest.js";
import { getProfile, type WalletProfile } from "../wallet-profiler.js";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { log } from "../log.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // per (wallet, market)
const NOTIONAL_THRESHOLD = 5000; // $5k 24h net buy position
const SCORE_THRESHOLD = 6;

/**
 * Per-wallet, per-market rolling 24h buy notional tracker.
 * Map<wallet, Map<market, Array<{ts, notional}>>>
 */
type Bucket = { ts: number; notional: number; outcomeIndex: 0 | 1 };
const positions = new Map<string, Map<string, Bucket[]>>();

function trim(arr: Bucket[]): Bucket[] {
  const cutoff = Date.now() - DAY_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  return arr;
}

function notional24h(arr: Bucket[]): number {
  trim(arr);
  return arr.reduce((s, b) => s + (b.outcomeIndex === 0 ? b.notional : -b.notional), 0);
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
  const notional = trade.size * trade.price;
  arr.push({
    ts: trade.timestamp * 1000,
    notional,
    outcomeIndex: trade.outcomeIndex,
  });

  const net = Math.abs(notional24h(arr));
  if (net < NOTIONAL_THRESHOLD) return;

  const key = `freshwallet:${wallet}:${trade.conditionId}`;
  if (!canAlert(key, COOLDOWN_MS)) return;

  const profile = await getProfile(wallet);
  if (!profile) return;
  if (profile.score < SCORE_THRESHOLD) return;

  await fireAlert(trade, meta, profile, net);
  markAlerted(key);
}

async function fireAlert(
  trade: PolyTrade,
  meta: AlertMeta,
  profile: WalletProfile,
  net: number,
): Promise<void> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_FRESH;
  if (!chat) return;

  const ageTxt =
    profile.age_days === null
      ? "*never received >$1k USDC*"
      : `${profile.age_days}d since first $1k+ USDC inflow`;
  const endShort = meta.end_date ? meta.end_date.slice(0, 10) : "";

  const text = [
    `🚨 *Fresh wallet* — \`${meta.slug}\``,
    `_${meta.question}_`,
    `wallet \`${profile.wallet}\` score=${profile.score}/10`,
    ageTxt,
    `24h net ${trade.outcome}: $${net.toFixed(0)}  @${trade.price.toFixed(2)}`,
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
    `alert: ${profile.wallet} on ${meta.slug} net=$${net.toFixed(0)} score=${profile.score}`,
  );
}
