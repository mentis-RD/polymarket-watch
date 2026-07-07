import "dotenv/config";
import { request } from "undici";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { isSkippedCategoryEvent } from "./category-filter.js";
import { writeJsonAtomic } from "./atomic-write.js";
import type { PolyEventFull } from "./polymarket-api.js";

/**
 * One-shot backfill for events CREATED during the 2026-06-17 → 2026-07-07 Gamma
 * offset-cap outage (event-discovery threw every cycle for ~20 days, so nothing
 * was indexed). Those events are now past the ~2100 offset cap and unreachable
 * by normal discovery. But `closed=false` + `start_date_min/max` reaches them:
 * for a past date, all the short-lived noise (updown/hourly/sports) has already
 * CLOSED, so an open-only date-window query returns almost entirely the
 * long-horizon (valuable) events. Volume per old day is tiny (~22), so per-day
 * chunking keeps every query under the offset cap.
 *
 * Dry-run by default (prints the ranked list). Pass `--commit` to add survivors
 * to seen_events.json + append to new_events.jsonl (with their REAL creation ts,
 * so they don't flood the 24h catalog digest).
 */

const BASE = "https://gamma-api.polymarket.com";
const STATE_DIR = join(process.cwd(), "state");
const SEEN_PATH = join(STATE_DIR, "seen_events.json");
const NEW_LOG_PATH = join(STATE_DIR, "new_events.jsonl");

// Outage window (UTC): last pre-outage discovery write → discovery resume.
const WINDOW_START = "2026-06-17T02:00:00Z";
const WINDOW_END = "2026-07-07T12:00:00Z";

interface SeenRecord {
  first_seen_ts: number;
  start_date: string;
  end_date: string;
  title: string;
  num_markets: number;
}
type SeenMap = Record<string, SeenRecord>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function categoryFromTags(tags: PolyEventFull["tags"]): string {
  if (!tags || tags.length === 0) return "";
  return tags.filter((t) => t.label && t.label.toLowerCase() !== "all").map((t) => slugify(t.label)).filter(Boolean).join("|");
}

async function fetchWindowPage(min: string, max: string, offset: number): Promise<PolyEventFull[] | null> {
  const p = new URLSearchParams({
    closed: "false", limit: "100", offset: String(offset),
    order: "startDate", ascending: "false", include_tag: "true",
    start_date_min: min, start_date_max: max,
  });
  const res = await request(`${BASE}/events?${p.toString()}`);
  if (res.statusCode !== 200) {
    await res.body.text();
    return null; // offset cap / error → stop this day's pagination
  }
  const data = (await res.body.json()) as PolyEventFull[];
  return Array.isArray(data) ? data : [];
}

async function fetchDay(min: string, max: string): Promise<PolyEventFull[]> {
  const out: PolyEventFull[] = [];
  for (let offset = 0; offset <= 3000; offset += 100) {
    const page = await fetchWindowPage(min, max, offset);
    if (page === null) break; // cap
    if (page.length === 0) break;
    out.push(...page);
    if (page.length < 100) break;
    await sleep(150);
  }
  return out;
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const seen: SeenMap = existsSync(SEEN_PATH) ? JSON.parse(readFileSync(SEEN_PATH, "utf-8")) : {};

  const startMs = Date.parse(WINDOW_START);
  const endMs = Date.parse(WINDOW_END);
  const DAY = 86_400_000;

  const bySlug = new Map<string, PolyEventFull>();
  for (let d = startMs; d < endMs; d += DAY) {
    const min = new Date(d).toISOString();
    const max = new Date(Math.min(d + DAY, endMs)).toISOString();
    const events = await fetchDay(min, max);
    for (const e of events) if (e.slug && !bySlug.has(e.slug)) bySlug.set(e.slug, e);
    process.stderr.write(`  ${min.slice(0, 10)}: fetched ${events.length}, cumulative unique ${bySlug.size}\n`);
  }

  // Filter: drop skip-categories + already-seen. Survivors = missed valuable events.
  const survivors: PolyEventFull[] = [];
  let skipCat = 0, alreadySeen = 0;
  for (const e of bySlug.values()) {
    if (isSkippedCategoryEvent(e.tags, e.slug)) { skipCat++; continue; }
    if (e.slug in seen) { alreadySeen++; continue; }
    survivors.push(e);
  }
  survivors.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

  console.log(`\n=== BACKFILL ${WINDOW_START.slice(0, 10)} → ${WINDOW_END.slice(0, 10)} ===`);
  console.log(`fetched unique open events in window: ${bySlug.size}`);
  console.log(`  skip-category (sports/updown/etc): ${skipCat}`);
  console.log(`  already in seen: ${alreadySeen}`);
  console.log(`  MISSED valuable (survivors): ${survivors.length}\n`);

  // Category breakdown
  const byCat = new Map<string, number>();
  for (const e of survivors) {
    const c = e.tags?.[0]?.label ? slugify(e.tags[0].label) : "(untagged)";
    byCat.set(c, (byCat.get(c) ?? 0) + 1);
  }
  console.log("by top-tag:");
  for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${c}`);

  console.log(`\n=== survivors (by volume desc) ===`);
  for (const e of survivors) {
    const vol = Math.round(e.volume ?? 0).toLocaleString();
    console.log(`  $${vol.padStart(10)}  ${(e.startDate || "").slice(0, 10)}  ${e.slug}`);
  }

  if (!commit) {
    console.log(`\n(dry-run — pass --commit to write ${survivors.length} into seen + new_events.jsonl)`);
    return;
  }

  const now = Date.now();
  const lines: string[] = [];
  for (const e of survivors) {
    seen[e.slug] = {
      first_seen_ts: now,
      start_date: e.startDate || "",
      end_date: e.endDate || "",
      title: e.title || "",
      num_markets: e.markets?.length ?? 0,
    };
    lines.push(JSON.stringify({
      ts: Date.parse(e.startDate || "") || now, // REAL creation ts → no 24h-digest flood
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
      backfilled: true,
    }));
  }
  if (lines.length) appendFileSync(NEW_LOG_PATH, lines.join("\n") + "\n");
  writeJsonAtomic(SEEN_PATH, seen);
  console.log(`\n✅ committed: +${survivors.length} to seen (${Object.keys(seen).length} total) + appended to new_events.jsonl`);
}

main().catch((e) => {
  console.error("backfill fatal:", e);
  process.exit(1);
});
