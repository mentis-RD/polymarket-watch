import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PolyTrade } from "../clob-rest.js";
import * as smartMoney from "../smart-money-db.js";
import * as watchlist from "../watchlist.js";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { marketLink, walletLink, fmtMoney } from "../alert-format.js";
import { writeJsonAtomic } from "../atomic-write.js";
import { escapeMd } from "../markdown.js";
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
  const txs = [...set];
  if (txs.length > SEEN_TX_MAX) txs.splice(0, txs.length - SEEN_TX_MAX);
  writeJsonAtomic(SEEN_TX_PATH, { txs }, undefined);
}

let seen: Set<string> | null = null;

/**
 * Process a batch of global recent trades — fire alert for any trade by a
 * smart-money wallet on a non-watchlist market.
 *
 * Both the watchlist and smart-money DB are loaded ONCE per batch (previously
 * loaded inside the per-trade loop, costing up to 500 file reads on every
 * 30s cycle). Building a Set of watchlist condition_ids gives O(1) lookups
 * inside the hot loop.
 */
export async function processBatch(trades: PolyTrade[]): Promise<void> {
  if (!seen) seen = loadSeen();
  const db = smartMoney.load();
  if (Object.keys(db).length === 0) return;

  const watchedConditions = new Set<string>();
  for (const s of watchlist.allConditionIds()) {
    watchedConditions.add(s.conditionId);
  }

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
    if (watchedConditions.has(t.conditionId)) continue; // covered by other signals

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
  const walletLbl = entry.pseudonym
    ? `*${escapeMd(entry.pseudonym)}* (${walletLink(wallet)})`
    : walletLink(wallet);
  const notional = trade.size * trade.price;
  const seedTxt = entry.seed_amount
    ? ` · lifetime ${escapeMd(entry.added_by.replace("leaderboard_", ""))} ${fmtMoney(entry.seed_amount)}`
    : "";
  const winsTxt = entry.wins.length > 0 ? ` · ${entry.wins.length} prior wins` : "";
  const titleLink = trade.title
    ? marketLink(trade.slug, escapeMd(trade.title))
    : marketLink(trade.slug, `\`${escapeMd(trade.slug)}\``);

  const text = [
    "⭐ *Smart money · non-watchlist*",
    "",
    titleLink,
    `${trade.side} *${escapeMd(trade.outcome).toUpperCase()}* ${fmtMoney(notional)} @${trade.price.toFixed(2)}`,
    "",
    `${walletLbl}${seedTxt}${winsTxt}`,
    `→ \`/watch ${escapeMd(trade.slug)}\``,
  ].join("\n");

  await sendMessage({
    chatId: chat,
    threadId: thread || undefined,
    text,
    parseMode: "Markdown",
  });
  log("smart-money", `alert: ${entry.pseudonym ?? wallet.slice(0, 10)} on ${trade.slug} $${notional.toFixed(0)}`);
}
