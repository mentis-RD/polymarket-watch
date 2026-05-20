import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 300, pipelining: 10, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { fetchOpenEvents, type PolyEventFull } from "./polymarket-api.js";
import { heartbeat } from "./heartbeat.js";
import { notifyErrors } from "./telegram.js";
import { writeJsonAtomic } from "./atomic-write.js";
import { isSkippedCategoryEvent } from "./category-filter.js";
import { log, err } from "./log.js";

const STATE_DIR = join(process.cwd(), "state");
const OUTPUT_DIR = join(process.cwd(), "output");
const SEEN_PATH = join(STATE_DIR, "seen_events.json");
const NEW_LOG_PATH = join(STATE_DIR, "new_events.jsonl");

interface SeenRecord {
  first_seen_ts: number;
  start_date: string;
  end_date: string;
  title: string;
  num_markets: number;
}

type SeenMap = Record<string, SeenRecord>; // keyed by event slug

function loadSeen(): SeenMap {
  if (!existsSync(SEEN_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SEEN_PATH, "utf-8")) as SeenMap;
  } catch (e) {
    err("discovery", "failed to parse seen_events.json, starting fresh", e);
    return {};
  }
}

function saveSeen(seen: SeenMap): void {
  writeJsonAtomic(SEEN_PATH, seen);
}

export interface NewEventRecord {
  ts: number;
  event_slug: string;
  title: string;
  category: string;
  tags: string;
  start_date: string;
  end_date: string;
  num_markets: number;
  volume_24h: number;
  liquidity: number;
  description: string;
  url: string;
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function categoryFromTags(tags: PolyEventFull["tags"]): string {
  if (!tags || tags.length === 0) return "";
  const meaningful = tags.filter((t) => t.label && t.label.toLowerCase() !== "all");
  return meaningful.map((t) => slugify(t.label)).filter(Boolean).join("|");
}

function toRecord(e: PolyEventFull, now: number): NewEventRecord {
  return {
    ts: now,
    event_slug: e.slug,
    title: e.title || "",
    category: e.tags?.[0]?.label ? slugify(e.tags[0].label) : "",
    tags: categoryFromTags(e.tags),
    start_date: e.startDate || "",
    end_date: e.endDate || "",
    num_markets: e.markets?.length ?? 0,
    volume_24h: e.volume24hr ?? 0,
    liquidity: e.liquidity ?? 0,
    description: (e.description || "").replace(/\s+/g, " ").trim(),
    url: `https://polymarket.com/event/${e.slug}`,
  };
}

function appendNewLog(records: NewEventRecord[]): void {
  if (records.length === 0) return;
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(NEW_LOG_PATH, lines);
}

async function discoveryCycle(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const seen = loadSeen();
  const coldStart = Object.keys(seen).length === 0;
  const now = Date.now();

  const all = await fetchOpenEvents({
    maxPages: coldStart ? 200 : 50,
    pageSize: 100,
    pageDelayMs: 200,
  });

  const newOnes: PolyEventFull[] = [];
  let skippedSports = 0;
  for (const e of all) {
    if (!e.slug) continue;
    // Skip sports / esports / combat / recurring-ticks / usage-counters.
    if (isSkippedCategoryEvent(e.tags, e.slug)) {
      skippedSports++;
      continue;
    }
    if (e.slug in seen) continue;
    seen[e.slug] = {
      first_seen_ts: now,
      start_date: e.startDate || "",
      end_date: e.endDate || "",
      title: e.title || "",
      num_markets: e.markets?.length ?? 0,
    };
    if (!coldStart) newOnes.push(e);
  }

  const records = newOnes.map((e) => toRecord(e, now));
  appendNewLog(records);
  saveSeen(seen);

  log(
    "discovery",
    coldStart
      ? `cold-start seed: ${all.length} events fetched, ${skippedSports} sports skipped, ${Object.keys(seen).length} indexed, 0 alerts`
      : `cycle done. fetched=${all.length} sports_skipped=${skippedSports} new=${newOnes.length} total_seen=${Object.keys(seen).length}`,
  );

  heartbeat("event-discovery", {
    fetched: all.length,
    sports_skipped: skippedSports,
    new: newOnes.length,
    cold_start: coldStart,
    total_seen: Object.keys(seen).length,
  });
}

async function main(): Promise<void> {
  const INTERVAL_MS = 60 * 60 * 1000; // hourly
  const once = process.argv.includes("--once");
  log("discovery", once ? "running single cycle (--once)" : "starting event-discovery loop");

  while (true) {
    try {
      await discoveryCycle();
    } catch (e) {
      err("discovery", "cycle failed", e);
      await notifyErrors(`event-discovery cycle failed: ${(e as Error).message}`);
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
