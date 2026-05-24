import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 300, pipelining: 10, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { sendDocument, sendMessage } from "./telegram.js";
import { heartbeat } from "./heartbeat.js";
import { writeJsonAtomic } from "./atomic-write.js";
import { log, err } from "./log.js";
import { isSkippedCategoryEvent } from "./category-filter.js";
import type { NewEventRecord } from "./event-discovery.js";

const STATE_DIR = join(process.cwd(), "state");
const OUTPUT_DIR = join(process.cwd(), "output");
const NEW_LOG_PATH = join(STATE_DIR, "new_events.jsonl");
const LAST_DIGEST_PATH = join(STATE_DIR, "last_digest.json");

const TZ = process.env.DIGEST_TZ || "Europe/Berlin";
const HOUR = Number(process.env.DIGEST_HOUR || "12");

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function todayInTz(now: Date): string {
  // YYYY-MM-DD in configured timezone.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function hourInTz(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value || "0");
}

function loadNewEventsSince(sinceTs: number): NewEventRecord[] {
  if (!existsSync(NEW_LOG_PATH)) return [];
  const lines = readFileSync(NEW_LOG_PATH, "utf-8").split("\n").filter((l) => l.trim());
  const out: NewEventRecord[] = [];
  let filtered = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as NewEventRecord;
      if (r.ts < sinceTs) continue;
      // Defense-in-depth: re-apply category filter at digest read time.
      // event-discovery applies it at WRITE time, but rules added after
      // events were written (curation iteration) wouldn't retroactively
      // skip stale records. This catches them at digest time so the
      // 12:00 send is always against current filter state.
      const tags = (r.tags || "").split("|").filter(Boolean).map((label) => ({ id: "", label, slug: "" }));
      if (isSkippedCategoryEvent(tags, r.event_slug)) { filtered++; continue; }
      out.push(r);
    } catch {
      // skip malformed line
    }
  }
  if (filtered > 0) log("digest", `filter re-applied: ${filtered} stale records skipped at read time`);
  return out;
}

function buildCsv(records: NewEventRecord[]): string {
  const headers = [
    "event_slug",
    "title",
    "category",
    "tags",
    "end_date",
    "start_date",
    "num_markets",
    "volume_24h",
    "liquidity",
    "description",
    "polymarket_url",
  ];
  const rows = records.map((r) => {
    const summary = (r.description || "").slice(0, 280);
    return [
      r.event_slug,
      r.title,
      r.category,
      r.tags,
      r.end_date,
      r.start_date,
      r.num_markets,
      r.volume_24h.toFixed(2),
      r.liquidity.toFixed(2),
      summary,
      r.url,
    ]
      .map(csvEscape)
      .join(",");
  });
  return [headers.join(","), ...rows].join("\n") + "\n";
}

interface LastDigestState {
  last_sent_iso?: string;
  last_sent_ts?: number;
  last_date_key?: string;
}

function loadLastDigest(): LastDigestState {
  if (!existsSync(LAST_DIGEST_PATH)) return {};
  try {
    return JSON.parse(readFileSync(LAST_DIGEST_PATH, "utf-8")) as LastDigestState;
  } catch {
    return {};
  }
}

function saveLastDigest(state: LastDigestState): void {
  writeJsonAtomic(LAST_DIGEST_PATH, state);
}

async function maybeSendDigest(): Promise<void> {
  const now = new Date();
  const dateKey = todayInTz(now);
  const hour = hourInTz(now);

  const last = loadLastDigest();
  if (last.last_date_key === dateKey) return; // already sent today
  if (hour < HOUR) return; // before scheduled hour

  // Send for "yesterday→today" window: last 24 hours from now.
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  const records = loadNewEventsSince(since);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const csvPath = join(OUTPUT_DIR, `new_events_${dateKey}.csv`);
  const csv = buildCsv(records);
  writeFileSync(csvPath, csv);

  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_DIGEST;
  if (!chat) {
    err("digest", "TG_CHAT_MAIN not set; CSV saved locally but not sent");
    saveLastDigest({ last_date_key: dateKey, last_sent_ts: Date.now(), last_sent_iso: now.toISOString() });
    return;
  }

  const totalSubs = records.reduce((s, r) => s + (r.num_markets || 0), 0);
  const caption = `📋 New Polymarket events ${dateKey}\nCount: ${records.length} events (${totalSubs} sub-markets) in last 24h\nReply with risk tags (HIGH / MED / SKIP) per event_slug; then /watch <event_slug>.`;

  if (records.length === 0) {
    await sendMessage({
      chatId: chat,
      threadId: thread || undefined,
      text: `📋 New Polymarket events ${dateKey}\nNo new events in last 24h.`,
    });
  } else {
    const ok = await sendDocument({
      chatId: chat,
      threadId: thread || undefined,
      filePath: csvPath,
      caption,
    });
    if (!ok) {
      err("digest", "TG send failed; will retry next cycle");
      return;
    }
  }

  saveLastDigest({ last_date_key: dateKey, last_sent_ts: Date.now(), last_sent_iso: now.toISOString() });
  log("digest", `sent digest for ${dateKey} (${records.length} events)`);
}

async function main(): Promise<void> {
  log("digest", `starting digest loop (tz=${TZ}, hour=${HOUR})`);

  const TICK_MS = 60 * 1000; // every minute, but only sends once per day
  while (true) {
    try {
      await maybeSendDigest();
    } catch (e) {
      err("digest", "cycle failed", e);
    }
    heartbeat("digest");
    await sleep(TICK_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  err("digest", "fatal", e);
  process.exit(1);
});
