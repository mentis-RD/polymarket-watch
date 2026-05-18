import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 300, pipelining: 10, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { fetchNewestMarkets, type PolyMarket, marketUrl, categoryFromTags } from "./polymarket-api.js";
import { heartbeat } from "./heartbeat.js";
import { notifyErrors } from "./telegram.js";
import { log, err } from "./log.js";

const STATE_DIR = join(process.cwd(), "state");
const OUTPUT_DIR = join(process.cwd(), "output");
const SEEN_PATH = join(STATE_DIR, "seen_markets.json");
const NEW_LOG_PATH = join(STATE_DIR, "new_markets.jsonl");

interface SeenRecord {
  first_seen_ts: number;
  created_at: string;
  start_date: string;
  end_date: string;
  question: string;
}

type SeenMap = Record<string, SeenRecord>;

function loadSeen(): SeenMap {
  if (!existsSync(SEEN_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SEEN_PATH, "utf-8")) as SeenMap;
  } catch (e) {
    err("discovery", "failed to parse seen_markets.json, starting fresh", e);
    return {};
  }
}

function saveSeen(seen: SeenMap): void {
  writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
}

function appendNewMarketsLog(records: NewMarketRecord[]): void {
  if (records.length === 0) return;
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(NEW_LOG_PATH, lines);
}

export interface NewMarketRecord {
  ts: number;
  slug: string;
  title: string;
  category: string;
  start_date: string;
  end_date: string;
  created_at: string;
  volume_24h: number;
  liquidity: number;
  description: string;
  url: string;
}

function toNewMarketRecord(m: PolyMarket, now: number): NewMarketRecord {
  return {
    ts: now,
    slug: m.slug,
    title: m.question,
    category: categoryFromTags(m.tags),
    start_date: m.startDate || "",
    end_date: m.endDate || "",
    created_at: m.createdAt || "",
    volume_24h: m.volume24hr ?? 0,
    liquidity: m.liquidityNum ?? 0,
    description: (m.description || "").replace(/\s+/g, " ").trim(),
    url: marketUrl(m.slug),
  };
}

async function discoveryCycle(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const seen = loadSeen();
  const coldStart = Object.keys(seen).length === 0;
  const now = Date.now();

  // Page through newest markets until we see a page where every slug is already seen.
  let pagesWithAllSeen = 0;
  const all = await fetchNewestMarkets({
    maxPages: coldStart ? 200 : 50, // on cold start, drain everything we can
    pageSize: 100,
    shouldStop: (page) => {
      if (coldStart) return false; // seed everything on first run
      const allKnown = page.every((m) => m.slug in seen);
      if (allKnown) {
        pagesWithAllSeen++;
        // Require two consecutive fully-known pages to stop, in case of ordering jitter.
        return pagesWithAllSeen >= 2;
      }
      pagesWithAllSeen = 0;
      return false;
    },
  });

  const newOnes: PolyMarket[] = [];
  for (const m of all) {
    if (!m.slug) continue;
    if (m.slug in seen) continue;
    seen[m.slug] = {
      first_seen_ts: now,
      created_at: m.createdAt || "",
      start_date: m.startDate || "",
      end_date: m.endDate || "",
      question: m.question,
    };
    if (!coldStart) newOnes.push(m);
  }

  const records = newOnes.map((m) => toNewMarketRecord(m, now));
  appendNewMarketsLog(records);
  saveSeen(seen);

  log(
    "discovery",
    coldStart
      ? `cold-start seed: ${all.length} markets indexed, 0 alerts emitted`
      : `cycle done. fetched=${all.length} new=${newOnes.length} total_seen=${Object.keys(seen).length}`,
  );

  heartbeat("market-discovery", {
    fetched: all.length,
    new: newOnes.length,
    cold_start: coldStart,
    total_seen: Object.keys(seen).length,
  });
}

async function main(): Promise<void> {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const once = process.argv.includes("--once");
  log("discovery", once ? "running single cycle (--once)" : "starting market-discovery loop");

  while (true) {
    try {
      await discoveryCycle();
    } catch (e) {
      err("discovery", "cycle failed", e);
      await notifyErrors(`market-discovery cycle failed: ${(e as Error).message}`);
    }
    if (once) break;
    await sleep(INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  err("discovery", "fatal", e);
  process.exit(1);
});
