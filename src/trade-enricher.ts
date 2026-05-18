import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 300, pipelining: 10, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { fetchTrades, type PolyTrade } from "./clob-rest.js";
import * as watchlist from "./watchlist.js";
import { handleEnrichedTrade } from "./signals/fresh-wallet.js";
import { checkMarket as checkClusterMarket } from "./signals/coordinated-cluster.js";
import { poolStatus } from "./alchemy-pool.js";
import { heartbeat } from "./heartbeat.js";
import { log, err } from "./log.js";

const STATE_DIR = join(process.cwd(), "state");
const ENRICHED_PATH = join(STATE_DIR, "trades_enriched.jsonl");
const LAST_TS_PATH = join(STATE_DIR, "enricher_last_ts.json");
const POLL_MS = 60_000;
const TRADES_PER_POLL = 100;
const CLUSTER_CHECK_EVERY_CYCLES = 10; // cluster scan every ~10 minutes

interface LastTsMap {
  [conditionId: string]: number;
}

function loadLastTs(): LastTsMap {
  if (!existsSync(LAST_TS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(LAST_TS_PATH, "utf-8")) as LastTsMap;
  } catch {
    return {};
  }
}

function saveLastTs(m: LastTsMap): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LAST_TS_PATH, JSON.stringify(m, null, 2));
}

function appendEnriched(trade: PolyTrade & { slug: string }): void {
  appendFileSync(
    ENRICHED_PATH,
    JSON.stringify({
      ts: trade.timestamp * 1000,
      slug: trade.slug,
      market: trade.conditionId,
      wallet: trade.proxyWallet.toLowerCase(),
      side: trade.side,
      outcome: trade.outcome,
      outcomeIndex: trade.outcomeIndex,
      asset: trade.asset,
      price: trade.price,
      size: trade.size,
      notional: trade.size * trade.price,
      tx: trade.transactionHash,
    }) + "\n",
  );
}

async function pollMarket(
  conditionId: string,
  slug: string,
  meta: { question: string; end_date: string; risk_tag: string },
  lastTs: LastTsMap,
): Promise<number> {
  let trades: PolyTrade[];
  try {
    trades = await fetchTrades(conditionId, { limit: TRADES_PER_POLL });
  } catch (e) {
    err("trade-enricher", `fetch ${conditionId} failed`, (e as Error).message);
    return 0;
  }

  const prevTs = lastTs[conditionId] ?? 0;
  let maxTs = prevTs;
  let newCount = 0;

  // CLOB returns newest first; iterate oldest-first so signals get chronological order.
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t.timestamp <= prevTs) continue;
    appendEnriched({ ...t, slug });
    try {
      await handleEnrichedTrade(t, {
        slug,
        question: meta.question,
        end_date: meta.end_date,
        risk_tag: meta.risk_tag,
      });
    } catch (e) {
      err("trade-enricher", "signal handler failed", (e as Error).message);
    }
    if (t.timestamp > maxTs) maxTs = t.timestamp;
    newCount++;
  }

  if (maxTs > prevTs) lastTs[conditionId] = maxTs;
  return newCount;
}

async function pollLoop(): Promise<void> {
  let cycleNum = 0;
  while (true) {
    cycleNum++;
    const wl = watchlist.load();
    const slugs = Object.entries(wl).filter(([, e]) => e.condition_id);
    let totalNew = 0;

    const lastTs = loadLastTs();
    for (const [slug, entry] of slugs) {
      const n = await pollMarket(
        entry.condition_id,
        slug,
        {
          question: entry.question,
          end_date: entry.end_date,
          risk_tag: entry.risk_tag,
        },
        lastTs,
      );
      totalNew += n;
    }
    if (totalNew > 0) saveLastTs(lastTs);

    // Cluster checks are O(n²) per market with Alchemy lookups per wallet;
    // run less often than per-cycle.
    if (cycleNum % CLUSTER_CHECK_EVERY_CYCLES === 0) {
      for (const [slug, entry] of slugs) {
        try {
          await checkClusterMarket(entry.condition_id, {
            slug,
            question: entry.question,
            end_date: entry.end_date,
          });
        } catch (e) {
          err("trade-enricher", `cluster check ${slug} failed`, (e as Error).message);
        }
      }
    }

    const ps = poolStatus();
    heartbeat("trade-enricher", {
      watchlist_size: slugs.length,
      new_trades: totalNew,
      alchemy_keys: ps.keys,
      alchemy_exhausted: ps.exhausted,
      cycle: cycleNum,
    });
    log("trade-enricher", `cycle ${cycleNum}: watchlist=${slugs.length} new_trades=${totalNew}`);
    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

log("trade-enricher", "starting");
pollLoop().catch((e) => {
  err("trade-enricher", "fatal", e);
  process.exit(1);
});
