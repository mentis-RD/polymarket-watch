import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 300, pipelining: 10, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-write.js";

import { fetchTrades, fetchRecentTrades, type PolyTrade } from "./clob-rest.js";
import * as watchlist from "./watchlist.js";
import { handleEnrichedTrade } from "./signals/fresh-wallet.js";
import { checkMarket as checkClusterMarket } from "./signals/coordinated-cluster.js";
import { processBatch as processSmartMoneyBatch } from "./signals/smart-money-cross-link.js";
import { runScan as runCrossMarketScan } from "./signals/cross-market-correlation.js";
import { poolStatus } from "./alchemy-pool.js";
import { heartbeat } from "./heartbeat.js";
import { log, err } from "./log.js";

const STATE_DIR = join(process.cwd(), "state");
const ENRICHED_PATH = join(STATE_DIR, "trades_enriched.jsonl");
const LAST_TS_PATH = join(STATE_DIR, "enricher_last_ts.json");
const POLL_MS = 60_000;
const TRADES_PER_POLL = 100;
const CLUSTER_CHECK_EVERY_CYCLES = 10; // cluster scan every ~10 minutes
const CROSS_MARKET_CHECK_EVERY_CYCLES = 20; // cross-market scan every ~20 minutes
const GLOBAL_POLL_MS = 30_000;
const GLOBAL_POLL_LIMIT = 500;
const ENRICHED_ROTATE_BYTES = 200 * 1024 * 1024; // 200 MB cap before archival
const ROTATE_CHECK_EVERY_MS = 60 * 60 * 1000; // once an hour
let lastRotateCheckTs = 0;

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
  writeJsonAtomic(LAST_TS_PATH, m);
}

function appendEnriched(trade: PolyTrade & { slug: string; event_slug: string }): void {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(
    ENRICHED_PATH,
    JSON.stringify({
      ts: trade.timestamp * 1000,
      slug: trade.slug, // sub-market slug
      market: trade.conditionId, // sub-market conditionId
      event_slug: trade.event_slug, // event the sub-market belongs to
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

/**
 * Rotate trades_enriched.jsonl when it exceeds the size cap. Mirrors the
 * market-monitor rotation policy for trades.jsonl — old data becomes a
 * timestamped archive next to the live file. Resolution-tracker and cluster
 * scans only read the current file; archived data is for offline review.
 */
function rotateEnrichedIfNeeded(): void {
  const now = Date.now();
  if (now - lastRotateCheckTs < ROTATE_CHECK_EVERY_MS) return;
  lastRotateCheckTs = now;
  if (!existsSync(ENRICHED_PATH)) return;
  try {
    const sz = statSync(ENRICHED_PATH).size;
    if (sz < ENRICHED_ROTATE_BYTES) return;
    const archive = ENRICHED_PATH + "." + new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(ENRICHED_PATH, archive);
    log(
      "trade-enricher",
      `rotated trades_enriched.jsonl -> ${archive} (was ${(sz / 1024 / 1024).toFixed(1)} MB)`,
    );
  } catch (e) {
    err("trade-enricher", "rotate failed", (e as Error).message);
  }
}

async function pollMarket(
  conditionId: string,
  subSlug: string,
  meta: { event_slug: string; event_title: string; end_date: string; risk_tag: string },
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

  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t.timestamp <= prevTs) continue;
    appendEnriched({ ...t, slug: subSlug, event_slug: meta.event_slug });
    try {
      await handleEnrichedTrade(t, {
        event_slug: meta.event_slug,
        event_title: meta.event_title,
        sub_slug: subSlug,
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
    // Flat list of every sub-market we need to poll, with its parent event.
    const subs = watchlist.allConditionIds();
    let totalNew = 0;

    const lastTs = loadLastTs();
    // Mid-cycle heartbeat: with 4K+ sub-markets one cycle can take hours
    // (sequential REST polls + per-wallet alchemy lookups). Heartbeating
    // only at cycle end would trigger watchdog stale-alert spam. Beat
    // every HB_INTERVAL_MS regardless of cycle position.
    const HB_INTERVAL_MS = 60_000;
    let lastHb = Date.now();
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      const entry = wl[s.eventSlug];
      if (!entry) continue;
      const n = await pollMarket(
        s.conditionId,
        s.subSlug,
        {
          event_slug: entry.event_slug,
          event_title: entry.event_title,
          end_date: entry.end_date,
          risk_tag: entry.risk_tag,
        },
        lastTs,
      );
      totalNew += n;
      if (Date.now() - lastHb > HB_INTERVAL_MS) {
        const ps = poolStatus();
        heartbeat("trade-enricher", {
          events: Object.keys(wl).length,
          sub_markets: subs.length,
          progress: i + 1,
          new_trades: totalNew,
          alchemy_keys: ps.keys,
          alchemy_exhausted: ps.exhausted,
          cycle: cycleNum,
          in_cycle: true,
        });
        lastHb = Date.now();
      }
    }
    if (totalNew > 0) saveLastTs(lastTs);

    // Cluster checks run at EVENT level (aggregated across sub-markets),
    // every 10 cycles (~10 min).
    if (cycleNum % CLUSTER_CHECK_EVERY_CYCLES === 0) {
      for (const [eventSlug, entry] of Object.entries(wl)) {
        try {
          await checkClusterMarket(eventSlug, {
            slug: eventSlug,
            question: entry.event_title,
            end_date: entry.end_date,
          });
        } catch (e) {
          err("trade-enricher", `cluster check ${eventSlug} failed`, (e as Error).message);
        }
        // Same mid-phase heartbeat as the poll loop: cluster-checking ~800
        // events (each with on-chain wallet lookups) takes well over 5 min, so
        // without this the watchdog false-alarms the enricher as dead.
        if (Date.now() - lastHb > HB_INTERVAL_MS) {
          heartbeat("trade-enricher", { events: Object.keys(wl).length, sub_markets: subs.length, phase: "cluster", cycle: cycleNum, in_cycle: true });
          lastHb = Date.now();
        }
      }
    }

    // Cross-market correlation scan across ALL enriched activity (not just
    // watchlist) — heavier, less frequent.
    if (cycleNum % CROSS_MARKET_CHECK_EVERY_CYCLES === 0) {
      // Beat before the (single, potentially multi-minute) scan so the gap from
      // the last cluster/poll beat to the next cycle-end beat can't go stale.
      heartbeat("trade-enricher", { events: Object.keys(wl).length, sub_markets: subs.length, phase: "xmarket", cycle: cycleNum, in_cycle: true });
      lastHb = Date.now();
      try {
        const r = await runCrossMarketScan();
        log("trade-enricher", `cross-market: scanned ${r.wallets_scanned} wallets, ${r.alerts} alerts`);
      } catch (e) {
        err("trade-enricher", "cross-market scan failed", (e as Error).message);
      }
    }

    rotateEnrichedIfNeeded();

    const ps = poolStatus();
    const eventCount = Object.keys(wl).length;
    heartbeat("trade-enricher", {
      events: eventCount,
      sub_markets: subs.length,
      new_trades: totalNew,
      alchemy_keys: ps.keys,
      alchemy_exhausted: ps.exhausted,
      cycle: cycleNum,
    });
    log(
      "trade-enricher",
      `cycle ${cycleNum}: events=${eventCount} subs=${subs.length} new_trades=${totalNew}`,
    );
    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function globalPollLoop(): Promise<void> {
  while (true) {
    try {
      const trades = await fetchRecentTrades({ limit: GLOBAL_POLL_LIMIT });
      await processSmartMoneyBatch(trades);
    } catch (e) {
      err("trade-enricher", "global poll failed", (e as Error).message);
    }
    await sleep(GLOBAL_POLL_MS);
  }
}

log("trade-enricher", "starting");
// watchlist loop is essential — if it crashes, exit the whole process so
// pm2 restarts and watchdog/heartbeat catches any longer outage.
const watchlistLoop = pollLoop().catch((e) => {
  err("trade-enricher", "watchlist loop fatal", e);
  process.exit(1);
});

// Global smart-money cross-link loop — gated behind env flag. Disabled
// by default after the catalog bulk-load: pulling 500 recent trades every
// 30s + per-wallet alchemy profile lookups on every smart-money trade
// on non-watchlist markets burns alchemy credits without proportionate
// signal value. Re-enable by setting SMART_MONEY_CROSS_LINK_ENABLED=true
// in .env if/when alert noise is acceptable again.
const SMART_MONEY_ENABLED = process.env.SMART_MONEY_CROSS_LINK_ENABLED === "true";
if (SMART_MONEY_ENABLED) {
  log("trade-enricher", "smart-money cross-link ENABLED");
  const globalLoop = globalPollLoop().catch((e) => {
    err("trade-enricher", "global loop fatal", e);
    process.exit(1);
  });
  void Promise.all([watchlistLoop, globalLoop]);
} else {
  log("trade-enricher", "smart-money cross-link DISABLED (set SMART_MONEY_CROSS_LINK_ENABLED=true to re-enable)");
  void watchlistLoop;
}
