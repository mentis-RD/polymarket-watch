import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 300, pipelining: 10, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import * as watchlist from "./watchlist.js";
import * as smartMoney from "./smart-money-db.js";
import { fetchMarketBySlug } from "./polymarket-api.js";
import { sendMessage } from "./telegram.js";
import { heartbeat } from "./heartbeat.js";
import { writeJsonAtomic } from "./atomic-write.js";
import { escapeMd } from "./markdown.js";
import { getForMarket, type EnrichedTrade } from "./enriched-store.js";
import { log, err } from "./log.js";

const STATE_DIR = join(process.cwd(), "state");
const RESOLUTIONS_PATH = join(STATE_DIR, "resolutions.json");

const CYCLE_MS = 60 * 60 * 1000; // 1h
const WIN_PRICE_THRESHOLD = 0.2; // bought-at price for "early winner" classification
const MIN_NOTIONAL = 100; // ignore dust positions

interface ResolutionRecord {
  condition_id: string;
  slug: string;
  resolved_at_iso: string;
  resolved_at_ts: number;
  winning_outcome: string;
  winning_outcome_index: 0 | 1;
  processed_at_ts: number;
  winner_count: number;
}

type ResolutionsMap = Record<string, ResolutionRecord>; // keyed by condition_id

// EnrichedTrade imported from enriched-store (shared in-memory cache)

function loadResolutions(): ResolutionsMap {
  if (!existsSync(RESOLUTIONS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(RESOLUTIONS_PATH, "utf-8")) as ResolutionsMap;
  } catch {
    return {};
  }
}

function saveResolutions(m: ResolutionsMap): void {
  writeJsonAtomic(RESOLUTIONS_PATH, m);
}

function parsePrices(raw?: string): number[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as string[];
    if (!Array.isArray(arr)) return null;
    return arr.map(Number);
  } catch {
    return null;
  }
}

function parseOutcomes(raw?: string): string[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as string[];
    if (!Array.isArray(arr)) return null;
    return arr;
  } catch {
    return null;
  }
}

// readTradesForMarket replaced by shared getForMarket from enriched-store.

interface WalletAggregate {
  wallet: string;
  buys_winning: { price: number; size: number; notional: number; ts: number }[];
  sells_winning: { price: number; size: number; notional: number; ts: number }[];
}

function aggregateByWallet(trades: EnrichedTrade[], winningIdx: 0 | 1): Map<string, WalletAggregate> {
  const map = new Map<string, WalletAggregate>();
  for (const t of trades) {
    if (t.outcomeIndex !== winningIdx) continue;
    const w = t.wallet.toLowerCase();
    let agg = map.get(w);
    if (!agg) {
      agg = { wallet: w, buys_winning: [], sells_winning: [] };
      map.set(w, agg);
    }
    const entry = { price: t.price, size: t.size, notional: t.notional, ts: t.ts };
    if (t.side === "BUY") agg.buys_winning.push(entry);
    else agg.sells_winning.push(entry);
  }
  return map;
}

interface Winner {
  wallet: string;
  avg_bought_price: number;
  net_size_held: number; // size held at resolution = buys - sells
  notional_invested: number;
  earliest_buy_ts: number;
  multiple: number; // 1.0 / avg_bought_price
}

function identifyWinners(
  trades: EnrichedTrade[],
  winningIdx: 0 | 1,
): Winner[] {
  const byWallet = aggregateByWallet(trades, winningIdx);
  const winners: Winner[] = [];

  for (const agg of byWallet.values()) {
    const totalBuySize = agg.buys_winning.reduce((s, b) => s + b.size, 0);
    const totalSellSize = agg.sells_winning.reduce((s, b) => s + b.size, 0);
    const netHeld = totalBuySize - totalSellSize;
    if (netHeld <= 0) continue; // did not hold through resolution

    const totalNotional = agg.buys_winning.reduce((s, b) => s + b.notional, 0);
    const avgPrice = totalBuySize > 0 ? totalNotional / totalBuySize : 0;

    if (avgPrice >= WIN_PRICE_THRESHOLD) continue; // not an "early" winner
    if (totalNotional < MIN_NOTIONAL) continue; // too small

    const earliest = agg.buys_winning.reduce((m, b) => Math.min(m, b.ts), Infinity);

    winners.push({
      wallet: agg.wallet,
      avg_bought_price: avgPrice,
      net_size_held: netHeld,
      notional_invested: totalNotional,
      earliest_buy_ts: earliest,
      multiple: 1.0 / avgPrice,
    });
  }
  return winners.sort((a, b) => b.notional_invested - a.notional_invested);
}

async function checkMarket(
  slug: string,
  conditionId: string,
  resolutions: ResolutionsMap,
): Promise<boolean> {
  if (resolutions[conditionId]) return false;

  const market = await fetchMarketBySlug(slug);
  if (!market) {
    err("resolution-tracker", `slug ${slug} not found in Gamma`);
    return false;
  }
  if (!market.closed) return false; // not resolved yet

  const prices = parsePrices(market.outcomePrices);
  const outcomes = parseOutcomes(market.outcomes);
  if (!prices || !outcomes || prices.length !== 2 || outcomes.length !== 2) {
    err("resolution-tracker", `${slug}: malformed outcomePrices/outcomes`);
    return false;
  }
  // Winning outcome has price ~= 1.0; treat anything >= 0.9 as a clean
  // winner. For "tight" resolutions (0.7..0.9) we still record the market
  // as processed so we don't keep retrying Gamma forever — but we skip
  // winner identification because "bought < $0.20 on winning side" doesn't
  // imply a 5x return when the winning side closed at 0.85.
  let winningIdx: 0 | 1 = 0;
  if (prices[1] > prices[0]) winningIdx = 1;
  const winningOutcome = outcomes[winningIdx];
  const cleanWin = prices[winningIdx] >= 0.9;
  const resolvedTs = Date.parse(market.endDate || new Date().toISOString());

  if (!cleanWin) {
    log(
      "resolution-tracker",
      `${slug}: tight resolution (prices=${prices.join(",")}), skipping winner detection but marking processed`,
    );
    resolutions[conditionId] = {
      condition_id: conditionId,
      slug,
      resolved_at_iso: market.endDate || new Date().toISOString(),
      resolved_at_ts: Number.isFinite(resolvedTs) ? resolvedTs : Date.now(),
      winning_outcome: winningOutcome,
      winning_outcome_index: winningIdx,
      processed_at_ts: Date.now(),
      winner_count: 0,
    };
    return true;
  }

  const trades = getForMarket(conditionId);
  const winners = identifyWinners(trades, winningIdx);

  // Persist resolution.
  resolutions[conditionId] = {
    condition_id: conditionId,
    slug,
    resolved_at_iso: market.endDate || new Date().toISOString(),
    resolved_at_ts: Number.isFinite(resolvedTs) ? resolvedTs : Date.now(),
    winning_outcome: winningOutcome,
    winning_outcome_index: winningIdx,
    processed_at_ts: Date.now(),
    winner_count: winners.length,
  };

  // Bulk-add winners to smart-money DB: single file rewrite for the whole
  // batch instead of N (previously a 50-winner resolution rewrote
  // smart_money.json 50 times in succession).
  if (winners.length > 0) {
    smartMoney.recordWins(
      winners.map((w) => ({
        wallet: w.wallet,
        win: {
          ts: w.earliest_buy_ts,
          slug,
          market: conditionId,
          outcome: winningOutcome,
          outcomeIndex: winningIdx,
          avg_bought_price: w.avg_bought_price,
          size: w.net_size_held,
          notional: w.notional_invested,
          multiple: w.multiple,
        },
      })),
    );
  }

  await sendRecap(slug, market.question || slug, winningOutcome, winners);
  log("resolution-tracker", `processed ${slug}: ${winners.length} winners; outcome=${winningOutcome}`);
  return true;
}

async function sendRecap(
  slug: string,
  question: string,
  outcome: string,
  winners: Winner[],
): Promise<void> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_RESOLUTION;
  if (!chat) return;

  const top = winners.slice(0, 10).map((w) => {
    const short = w.wallet.slice(0, 6) + "…" + w.wallet.slice(-4);
    return `• \`${short}\` ${w.multiple.toFixed(1)}× ($${w.notional_invested.toFixed(0)} @${w.avg_bought_price.toFixed(2)})`;
  });

  const text = [
    `📊 *Resolution* — \`${escapeMd(slug)}\` → *${escapeMd(outcome)}*`,
    `_${escapeMd(question)}_`,
    "",
    winners.length > 0
      ? `*Early winners (bought < ${WIN_PRICE_THRESHOLD}, held through, >$${MIN_NOTIONAL}):* ${winners.length}`
      : "_no early winners on our enriched data_",
    ...top,
    "",
    `https://polymarket.com/market/${slug}`,
  ].join("\n");

  await sendMessage({
    chatId: chat,
    threadId: thread || undefined,
    text,
    parseMode: "Markdown",
  });
}

async function cycle(): Promise<void> {
  const wl = watchlist.load();
  const resolutions = loadResolutions();
  const now = Date.now();
  let processed = 0;

  // Iterate every sub-market of every watchlist event. Each sub-market
  // resolves independently (different deadlines / different outcomes), so
  // we keep resolutions[] keyed by conditionId.
  for (const entry of Object.values(wl)) {
    for (const sm of entry.sub_markets) {
      if (!sm.condition_id) continue;
      const subEnd = sm.end_date || entry.end_date;
      if (!subEnd) continue;
      const endTs = Date.parse(subEnd);
      if (!Number.isFinite(endTs)) continue;
      if (endTs > now) continue;
      if (resolutions[sm.condition_id]) continue;
      try {
        const ok = await checkMarket(sm.slug, sm.condition_id, resolutions);
        if (ok) processed++;
      } catch (e) {
        err("resolution-tracker", `checkMarket ${sm.slug} failed`, e);
      }
    }
  }

  if (processed > 0) saveResolutions(resolutions);

  heartbeat("resolution-tracker", {
    events: Object.keys(wl).length,
    processed_total: Object.keys(resolutions).length,
    processed_this_cycle: processed,
  });
  log("resolution-tracker", `cycle: processed=${processed} total=${Object.keys(resolutions).length}`);
}

async function main(): Promise<void> {
  log("resolution-tracker", "starting");
  while (true) {
    try {
      await cycle();
    } catch (e) {
      err("resolution-tracker", "cycle failed", e);
    }
    await sleep(CYCLE_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  err("resolution-tracker", "fatal", e);
  process.exit(1);
});
