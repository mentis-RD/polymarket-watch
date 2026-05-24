import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 50, pipelining: 1, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseClobTokenIds,
  resolveEventFromAnySlug,
  type PolyEventFull,
} from "./polymarket-api.js";
import * as watchlist from "./watchlist.js";
import { log, err } from "./log.js";

/**
 * Bulk-load every event_slug in a curated catalog archive into the
 * watchlist. One-shot; not a recurring process.
 *
 *   npx tsx src/bulk-add-from-catalog.ts <catalog-dir> [--dry-run] [--tag HIGH|MED] [--throttle-ms 200]
 *
 * Defaults: tag=MED, throttle=200ms (≈3 min for 900 events), dry-run off.
 *
 * Skips:
 *   - events already in the watchlist (manual /watch additions are preserved)
 *   - events whose Gamma lookup fails or returns no open sub-markets
 *   - events whose end_date is already past
 *
 * Why one-shot script not a pm2 process: catalog curation is manual; this
 * runs after each major curation pass to (re)seed the watchlist. For
 * forward-incremental discovery, pmw-event-discovery handles that hourly.
 */

const DEFAULT_TAG: watchlist.RiskTag = "MED";
const DEFAULT_THROTTLE_MS = 200;

function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === ",") { out.push(cur); cur = ""; }
    else if (ch === '"' && cur === "") inQ = true;
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function buildSubMarkets(event: PolyEventFull): watchlist.SubMarket[] {
  const out: watchlist.SubMarket[] = [];
  for (const m of event.markets ?? []) {
    if (!m.slug) continue;
    if (m.closed || m.archived) continue;
    out.push({
      slug: m.slug,
      question: m.question || "",
      condition_id: m.conditionId || "",
      clob_token_ids: parseClobTokenIds(m),
      end_date: m.endDate,
    });
  }
  return out;
}

function readSlugsFromArchive(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv") && f !== "_index.csv");
  const slugs: string[] = [];
  for (const f of files) {
    const path = join(dir, f);
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    if (lines.length < 2) continue;
    const cols = splitCsvRow(lines[0]);
    const slugIdx = cols.indexOf("event_slug");
    if (slugIdx < 0) continue;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const slug = splitCsvRow(line)[slugIdx];
      if (slug) slugs.push(slug);
    }
  }
  return slugs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: tsx src/bulk-add-from-catalog.ts <catalog-dir> [--dry-run] [--tag HIGH|MED] [--throttle-ms 200]");
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  const tag: watchlist.RiskTag = (args[args.indexOf("--tag") + 1] === "HIGH" ? "HIGH" : DEFAULT_TAG);
  const throttleIdx = args.indexOf("--throttle-ms");
  const throttleMs = throttleIdx >= 0 ? parseInt(args[throttleIdx + 1] || String(DEFAULT_THROTTLE_MS), 10) : DEFAULT_THROTTLE_MS;

  log("bulk-add", `dir=${dir} dryRun=${dryRun} tag=${tag} throttle=${throttleMs}ms`);

  const slugs = readSlugsFromArchive(dir);
  log("bulk-add", `read ${slugs.length} slugs from archive`);

  const wlBefore = watchlist.load();
  const skipExisting = new Set(Object.keys(wlBefore));
  log("bulk-add", `watchlist has ${skipExisting.size} entries before`);

  const stats = { fetched: 0, added: 0, skippedExisting: 0, skippedExpired: 0, skippedNoSubs: 0, fetchErr: 0 };
  const now = Date.now();

  // Build all entries in memory; write once at end.
  const newEntries: Record<string, watchlist.WatchEntry> = {};

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    if (skipExisting.has(slug)) { stats.skippedExisting++; continue; }

    let event: PolyEventFull | null = null;
    try {
      event = await resolveEventFromAnySlug(slug);
    } catch (e) {
      err("bulk-add", `resolveEventFromAnySlug(${slug}) failed`, (e as Error).message);
      stats.fetchErr++;
      await sleep(throttleMs);
      continue;
    }
    stats.fetched++;

    if (!event) {
      log("bulk-add", `${slug}: not found on Gamma`);
      stats.fetchErr++;
      await sleep(throttleMs);
      continue;
    }

    if (event.endDate) {
      const endTs = Date.parse(event.endDate);
      if (Number.isFinite(endTs) && endTs < now) {
        stats.skippedExpired++;
        await sleep(throttleMs);
        continue;
      }
    }

    const subMarkets = buildSubMarkets(event);
    const subsWithTokens = subMarkets.filter((sm) => sm.clob_token_ids.length > 0).length;
    if (subMarkets.length === 0 || subsWithTokens === 0) {
      stats.skippedNoSubs++;
      await sleep(throttleMs);
      continue;
    }

    newEntries[event.slug] = {
      added_at: now,
      added_by: "bulk_import",
      risk_tag: tag,
      reason: `bulk_import from ${dir}`,
      event_slug: event.slug,
      event_title: event.title || "",
      end_date: event.endDate || "",
      sub_markets: subMarkets,
    };
    stats.added++;

    if ((i + 1) % 50 === 0) {
      log("bulk-add", `progress ${i + 1}/${slugs.length}  added=${stats.added} skipped(existing=${stats.skippedExisting} expired=${stats.skippedExpired} no-subs=${stats.skippedNoSubs}) errs=${stats.fetchErr}`);
    }

    await sleep(throttleMs);
  }

  log("bulk-add", `DONE  fetched=${stats.fetched} added=${stats.added} skipped(existing=${stats.skippedExisting} expired=${stats.skippedExpired} no-subs=${stats.skippedNoSubs}) errs=${stats.fetchErr}`);

  if (dryRun) {
    log("bulk-add", "--dry-run: not writing watchlist");
    return;
  }

  const wl = watchlist.load();
  Object.assign(wl, newEntries);
  watchlist.save(wl);
  const totalSubs = Object.values(wl).reduce((n, e) => n + e.sub_markets.length, 0);
  log("bulk-add", `watchlist saved: ${Object.keys(wl).length} events, ${totalSubs} sub-markets total`);
}

main().catch((e) => {
  err("bulk-add", "fatal", e);
  process.exit(1);
});
