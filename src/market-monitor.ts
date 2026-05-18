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
  const newAssetToSlug = new Map<string, string>();
  const known = new Set<string>();
  for (const [slug, entry] of Object.entries(wl)) {
    known.add(slug);
    detector.setMarketMeta(slug, {
      question: entry.question,
      end_date: entry.end_date,
      risk_tag: entry.risk_tag,
    });
    for (const tokenId of entry.clob_token_ids || []) {
      if (tokenId) newAssetToSlug.set(tokenId, slug);
    }
  }
  // Drop detector state for removed slugs.
  for (const slug of detector.trackedSlugs()) {
    if (!known.has(slug)) detector.removeMarket(slug);
  }

  // Swap the map.
  assetToSlug.clear();
  for (const [k, v] of newAssetToSlug) assetToSlug.set(k, v);

  ws.setAssetIds([...assetToSlug.keys()]);
  log(
    "market-monitor",
    `watchlist=${Object.keys(wl).length} subscriptions=${assetToSlug.size}`,
  );
}

function onTrade(t: TradeEvent): void {
  const slug = assetToSlug.get(t.asset_id);
  if (!slug) return; // ignore trades for assets we no longer track
  const stored: StoredTrade = {
    ts: t.ts,
    slug,
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
  detector.ingest(slug, t);
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
