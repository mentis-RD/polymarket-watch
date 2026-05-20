import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 300, pipelining: 10, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ClobWS, type TradeEvent } from "./clob-ws.js";
import * as watchlist from "./watchlist.js";
import { VolumeSpikeDetector } from "./signals/volume-spike.js";
import { heartbeat } from "./heartbeat.js";
import { log, err } from "./log.js";

const STATE_DIR = join(process.cwd(), "state");
const TRADES_PATH = join(STATE_DIR, "trades.jsonl");
const WATCHLIST_RELOAD_MS = 60_000;
const SIGNAL_CHECK_MS = 60_000;
const TRADES_ROTATE_DAYS = 30;
const TRADES_MAX_BYTES = 200 * 1024 * 1024; // 200 MB safety cap

interface StoredTrade {
  ts: number;
  slug: string;
  asset_id: string;
  market: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
}

const ws = new ClobWS();
const detector = new VolumeSpikeDetector();

// asset_id (token_id) -> slug
const assetToSlug = new Map<string, string>();

function appendTrade(t: StoredTrade): void {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(TRADES_PATH, JSON.stringify(t) + "\n");
}

function rotateTradesIfNeeded(): void {
  if (!existsSync(TRADES_PATH)) return;
  try {
    const sz = statSync(TRADES_PATH).size;
    if (sz < TRADES_MAX_BYTES) return;
    const archive = TRADES_PATH + "." + new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(TRADES_PATH, archive);
    log("market-monitor", `rotated trades.jsonl -> ${archive} (was ${(sz / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    err("market-monitor", "rotate failed", e);
  }
}

function replayTrades(maxAgeMs: number): number {
  if (!existsSync(TRADES_PATH)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  const raw = readFileSync(TRADES_PATH, "utf-8");
  const lines = raw.split("\n");
  let count = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      const t = JSON.parse(line) as StoredTrade;
      if (t.ts < cutoff) continue;
      detector.ingest(t.slug, {
        asset_id: t.asset_id,
        market: t.market,
        side: t.side,
        price: t.price,
        size: t.size,
        ts: t.ts,
      });
      count++;
    } catch {
      /* skip malformed */
    }
  }
  return count;
}

function reloadWatchlist(): void {
  const wl = watchlist.load();
  const newAssetToEvent = new Map<string, string>(); // tokenId → event_slug
  const knownEvents = new Set<string>();

  for (const [eventSlug, entry] of Object.entries(wl)) {
    knownEvents.add(eventSlug);
    // Volume-spike detector now tracks at EVENT level — one combined
    // baseline across all sub-markets of the event.
    detector.setMarketMeta(eventSlug, {
      question: entry.event_title,
      end_date: entry.end_date,
      risk_tag: entry.risk_tag,
    });
    for (const sm of entry.sub_markets) {
      for (const tokenId of sm.clob_token_ids || []) {
        if (tokenId) newAssetToEvent.set(tokenId, eventSlug);
      }
    }
  }
  // Drop detector state for removed events.
  for (const slug of detector.trackedSlugs()) {
    if (!knownEvents.has(slug)) detector.removeMarket(slug);
  }

  assetToSlug.clear();
  for (const [k, v] of newAssetToEvent) assetToSlug.set(k, v);

  ws.setAssetIds([...assetToSlug.keys()]);
  log(
    "market-monitor",
    `watchlist=${knownEvents.size} events, ${assetToSlug.size} token subscriptions`,
  );
}

function onTrade(t: TradeEvent): void {
  // Now the value is the EVENT slug, not a sub-market slug — volume-spike
  // and other monitor-side signals aggregate at event level.
  const eventSlug = assetToSlug.get(t.asset_id);
  if (!eventSlug) return;
  const stored: StoredTrade = {
    ts: t.ts,
    slug: eventSlug,
    asset_id: t.asset_id,
    market: t.market,
    side: t.side,
    price: t.price,
    size: t.size,
  };
  try {
    appendTrade(stored);
  } catch (e) {
    err("market-monitor", "appendTrade failed", e);
  }
  detector.ingest(eventSlug, t);
}

async function main(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });

  log("market-monitor", "replaying recent trades into in-memory buckets");
  const replayed = replayTrades(TRADES_ROTATE_DAYS * 24 * 60 * 60 * 1000);
  log("market-monitor", `replayed ${replayed} trades`);

  reloadWatchlist();
  ws.on("trade", onTrade);
  ws.on("open", () => log("market-monitor", "ws connected"));
  ws.on("close", () => log("market-monitor", "ws closed"));
  ws.on("error", (e) => err("market-monitor", "ws error", e.message));
  ws.start();

  setInterval(reloadWatchlist, WATCHLIST_RELOAD_MS);
  setInterval(rotateTradesIfNeeded, 60 * 60 * 1000);

  setInterval(async () => {
    try {
      await detector.checkAll();
    } catch (e) {
      err("market-monitor", "signal check failed", e);
    }
    heartbeat("market-monitor", { subs: assetToSlug.size });
  }, SIGNAL_CHECK_MS);

  // Initial heartbeat so watchdog sees us immediately.
  heartbeat("market-monitor", { subs: assetToSlug.size });
}

main().catch((e) => {
  err("market-monitor", "fatal", e);
  process.exit(1);
});
