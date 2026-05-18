import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import type { PolyTrade } from "../clob-rest.js";
import * as smartMoney from "../smart-money-db.js";
import * as watchlist from "../watchlist.js";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { log } from "../log.js";

const COOLDOWN_MS = 60 * 60 * 1000; // 1h per (wallet, market)
const MIN_NOTIONAL = 100; // ignore dust

const SEEN_TX_PATH = join(process.cwd(), "state", "cross_link_seen_tx.json");
const SEEN_TX_MAX = 5000;

interface SeenTxStore {
  txs: string[]; // FIFO ring (latest at end)
}

function loadSeen(): Set<string> {
  if (!existsSync(SEEN_TX_PATH)) return new Set();
  try {
    const s = JSON.parse(readFileSync(SEEN_TX_PATH, "utf-8")) as SeenTxStore;
    return new Set(s.txs);
  } catch {
    return new Set();
  }
}

function saveSeen(set: Set<string>): void {
  mkdirSync(dirname(SEEN_TX_PATH), { recursive: true });
  const txs = [...set];
  if (txs.length > SEEN_TX_MAX) txs.splice(0, txs.length - SEEN_TX_MAX);
  writeFileSync(SEEN_TX_PATH, JSON.stringify({ txs }));
}

let seen: Set<string> | null = null;

function isWatchlist(conditionId: string): boolean {
  const wl = watchlist.load();
  for (const e of Object.values(wl)) {
    if (e.condition_id === conditionId) return true;
  }
  return false;
}

/**
 * Process a batch of global recent trades — fire alert for any trade by a
 * smart-money wallet on a non-watchlist market.
 */
export async function processBatch(trades: PolyTrade[]): Promise<void> {
  if (!seen) seen = loadSeen();
  const db = smartMoney.load();
  if (Object.keys(db).length === 0) return;

  let newSeen = 0;
  let alerts = 0;

  for (const t of trades) {
    if (seen.has(t.transactionHash)) continue;
    seen.add(t.transactionHash);
    newSeen++;

    const wallet = t.proxyWallet.toLowerCase();
    if (!(wallet in db)) continue;
    const notional = t.size * t.price;
    if (notional < MIN_NOTIONAL) continue;
    if (isWatchlist(t.conditionId)) continue; // watchlist markets are covered by other signals

    const key = `xlink:${wallet}:${t.conditionId}`;
    if (!canAlert(key, COOLDOWN_MS)) continue;

    await fireAlert(t, db[wallet]);
    markAlerted(key);
    alerts++;
  }

  if (newSeen > 0) saveSeen(seen);
  if (alerts > 0) log("smart-money", `fired ${alerts} cross-link alerts`);
}

async function fireAlert(trade: PolyTrade, entry: smartMoney.SmartMoneyEntry): Promise<void> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_SMART;
  if (!chat) return;

  const wallet = trade.proxyWallet.toLowerCase();
  const label = entry.pseudonym ? `${entry.pseudonym} (\`${wallet.slice(0, 6)}…${wallet.slice(-4)}\`)` : `\`${wallet}\``;
  const notional = trade.size * trade.price;
  const seedAmt = entry.seed_amount ? ` lifetime ${entry.added_by.replace("leaderboard_", "")}: $${entry.seed_amount.toFixed(0)}` : "";
  const wins = entry.wins.length > 0 ? `, ${entry.wins.length} prior post-mortem wins` : "";

  const text = [
    `⭐ *Smart money* — \`${trade.slug}\` *(non-watchlist)*`,
    trade.title ? `_${trade.title}_` : null,
    `${label}${seedAmt}${wins}`,
    `${trade.side} ${trade.outcome}  $${notional.toFixed(0)} @${trade.price.toFixed(2)}`,
    `https://polymarket.com/market/${trade.slug}`,
    `https://polygonscan.com/address/${wallet}`,
    `_consider /watch ${trade.slug}_`,
  ]
    .filter((x) => x)
    .join("\n");

  await sendMessage({
    chatId: chat,
    threadId: thread || undefined,
    text,
    parseMode: "Markdown",
  });
  log("smart-money", `alert: ${entry.pseudonym ?? wallet.slice(0, 10)} on ${trade.slug} $${notional.toFixed(0)}`);
}
