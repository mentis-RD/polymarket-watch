import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { sendDocument } from "./telegram.js";
import type { NewEventRecord } from "./event-discovery.js";

/**
 * One-shot: post a CATCH-UP catalog digest (CSV) for the events recovered by
 * backfill-events.ts (rows flagged `backfilled` in new_events.jsonl). Same
 * format/thread as the normal 📋 daily catalog digest, but drawn from the
 * backfilled set and filtered to a 24h-volume floor so the low/zero-volume tail
 * doesn't spam the thread. Ranked by 24h volume desc.
 *
 *   tsx src/backfill-digest.ts [minVol24h]     (default floor $1000)
 */

const STATE_DIR = join(process.cwd(), "state");
const OUTPUT_DIR = join(process.cwd(), "output");
const NEW_LOG_PATH = join(STATE_DIR, "new_events.jsonl");

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(records: NewEventRecord[]): string {
  const headers = [
    "event_slug", "title", "category", "tags", "end_date", "start_date",
    "num_markets", "volume_24h", "liquidity", "description", "polymarket_url",
  ];
  const rows = records.map((r) =>
    [
      r.event_slug, r.title, r.category, r.tags, r.end_date, r.start_date,
      r.num_markets, (r.volume_24h ?? 0).toFixed(2), (r.liquidity ?? 0).toFixed(2),
      (r.description || "").slice(0, 280), r.url,
    ].map(csvEscape).join(","),
  );
  return [headers.join(","), ...rows].join("\n") + "\n";
}

async function main(): Promise<void> {
  const minVol = Number(process.argv[2] || "1000");
  const lines = readFileSync(NEW_LOG_PATH, "utf-8").split("\n").filter((l) => l.trim());
  const recs: NewEventRecord[] = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l) as NewEventRecord & { backfilled?: boolean };
      if (r.backfilled && (r.volume_24h ?? 0) >= minVol) recs.push(r);
    } catch { /* skip */ }
  }
  recs.sort((a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0));

  if (recs.length === 0) {
    console.log(`no backfilled rows with 24h-vol >= $${minVol}; nothing to send`);
    return;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const csvPath = join(OUTPUT_DIR, `catchup_backfill_events.csv`);
  writeFileSync(csvPath, buildCsv(recs));

  const totalSubs = recs.reduce((s, r) => s + (r.num_markets || 0), 0);
  const caption =
    `📋 Catch-up: events missed during the discovery outage (2026-06-17 → 07-07)\n` +
    `Count: ${recs.length} events (${totalSubs} sub-markets), 24h-vol ≥ $${minVol.toLocaleString()}, ranked by 24h volume\n` +
    `Created during the ~20d Gamma offset-cap outage — never surfaced until now.\n` +
    `Reply risk tags (HIGH / MED / SKIP) per event_slug; then /watch <event_slug>.`;

  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_DIGEST;
  if (!chat) { console.error("TG_CHAT_MAIN not set; CSV saved at " + csvPath + " but not sent"); return; }

  const ok = await sendDocument({ chatId: chat, threadId: thread || undefined, filePath: csvPath, caption });
  console.log(ok ? `✅ sent catch-up digest: ${recs.length} events` : `❌ TG send failed`);
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error("backfill-digest fatal:", e); process.exit(1); });
