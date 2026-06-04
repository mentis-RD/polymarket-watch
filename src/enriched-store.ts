import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Shared in-memory mirror of `state/trades_enriched.jsonl` (+ its recent
 * rotations). Avoids per-market full-file reads from cluster + cross-market
 * signals on every scan cycle.
 *
 * The live file rotates at 200 MB → `trades_enriched.jsonl.<ISO>`. Reading
 * ONLY the live file silently collapsed every consumer window to "time since
 * the last rotation": after a rotation the live file held ~18h, so the 7d
 * cross-market and 48h cluster windows starved and EVERY cluster/cross-market
 * re-review decayed (root-caused 2026-06-04 — wallet absent from the live file
 * minutes after it fired a cross-market alert). Fix: also load rotation files
 * whose data falls within RETAIN_MS. Rotations are immutable → parsed once and
 * cached by filename; the live file is re-read on mtime change.
 *
 * Memory is bounded by RETAIN_MS (rows older than that are dropped on load),
 * which covers the widest consumer window (cross-market = 7d) with margin.
 */

const PATH = join(process.cwd(), "state", "trades_enriched.jsonl");
const ROT_PREFIX = "trades_enriched.jsonl.";
const RETAIN_MS = 8 * 24 * 60 * 60 * 1000; // > the 7d cross-market window
const REBUILD_EVERY_MS = 60 * 60 * 1000; // re-prune aged rows hourly even if files unchanged

export interface EnrichedTrade {
  ts: number;
  /** Sub-market slug (the binary question). */
  slug: string;
  /** Sub-market conditionId. */
  market: string;
  /** Event slug — multiple sub-markets share this; signals aggregate over it. */
  event_slug?: string;
  wallet: string;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: 0 | 1;
  asset?: string;
  price: number;
  size: number;
  notional: number;
  tx?: string;
}

/** Parse a rotation filename's ISO ts: `trades_enriched.jsonl.2026-06-03T19-54-37-313Z`. */
function rotationTs(fname: string): number {
  const m = /^trades_enriched\.jsonl\.(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(fname);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

function parseFile(p: string): EnrichedTrade[] {
  const out: EnrichedTrade[] = [];
  try {
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line) as EnrichedTrade); } catch { /* skip malformed */ }
    }
  } catch { /* unreadable → empty */ }
  return out;
}

let liveRows: EnrichedTrade[] = [];
let liveMtime = -1;
const rotCache = new Map<string, EnrichedTrade[]>(); // immutable rotations, parsed once (filtered to RETAIN)
let rotMerged: EnrichedTrade[] = []; // concat of all rotCache values, rebuilt only when the set changes
let cached: EnrichedTrade[] = [];
let lastRotScanMs = 0;

function refresh(): void {
  const now = Date.now();
  const cutoff = now - RETAIN_MS;
  let liveChanged = false;
  let rotChanged = false;

  // Live file — re-read on mtime change.
  if (existsSync(PATH)) {
    let m = -1;
    try { m = statSync(PATH).mtimeMs; } catch { /* keep prior */ }
    if (m !== liveMtime) {
      liveRows = parseFile(PATH);
      liveMtime = m;
      liveChanged = true;
    }
  } else if (liveRows.length) {
    liveRows = [];
    liveMtime = -1;
    liveChanged = true;
  }

  // Rotation set — immutable files, so only re-scan the directory occasionally.
  if (now - lastRotScanMs > REBUILD_EVERY_MS || rotCache.size === 0) {
    lastRotScanMs = now;
    let rotFiles: string[] = [];
    try { rotFiles = readdirSync(dirname(PATH)).filter((f) => f.startsWith(ROT_PREFIX)); } catch { /* none */ }
    for (const f of rotFiles) {
      const ts = rotationTs(f);
      if (!Number.isFinite(ts) || ts < cutoff) continue; // too old to matter
      if (rotCache.has(f)) continue;
      rotCache.set(f, parseFile(join(dirname(PATH), f)).filter((t) => t.ts >= cutoff));
      rotChanged = true;
    }
    for (const f of [...rotCache.keys()]) {
      const ts = rotationTs(f);
      if (!rotFiles.includes(f) || !Number.isFinite(ts) || ts < cutoff) {
        rotCache.delete(f);
        rotChanged = true;
      }
    }
    if (rotChanged) {
      rotMerged = [];
      for (const arr of rotCache.values()) for (const t of arr) rotMerged.push(t);
    }
  }

  // Merge is a cheap concat; per-window age filtering is done in the getters.
  if (liveChanged || rotChanged || cached.length === 0) {
    cached = rotMerged.concat(liveRows);
  }
}

/** All enriched trades currently retained (live + rotations within RETAIN_MS). */
export function getAll(): EnrichedTrade[] {
  refresh();
  return cached;
}

/** Trades for one conditionId within the last `maxAgeMs`. */
export function getForMarket(conditionId: string, maxAgeMs?: number): EnrichedTrade[] {
  refresh();
  const cutoff = maxAgeMs ? Date.now() - maxAgeMs : 0;
  const out: EnrichedTrade[] = [];
  for (const t of cached) {
    if (t.market !== conditionId) continue;
    if (cutoff > 0 && t.ts < cutoff) continue;
    out.push(t);
  }
  return out;
}

/**
 * Trades for one event (across ALL its sub-markets) within the last
 * `maxAgeMs`. Used by event-level cluster + resolution-tracker signals.
 */
export function getForEvent(eventSlug: string, maxAgeMs?: number): EnrichedTrade[] {
  refresh();
  const cutoff = maxAgeMs ? Date.now() - maxAgeMs : 0;
  const out: EnrichedTrade[] = [];
  for (const t of cached) {
    if (t.event_slug !== eventSlug) continue;
    if (cutoff > 0 && t.ts < cutoff) continue;
    out.push(t);
  }
  return out;
}

/** Trades across all markets within the last `maxAgeMs`. */
export function getRecent(maxAgeMs: number): EnrichedTrade[] {
  refresh();
  const cutoff = Date.now() - maxAgeMs;
  const out: EnrichedTrade[] = [];
  for (const t of cached) {
    if (t.ts >= cutoff) out.push(t);
  }
  return out;
}

/** Diagnostic for heartbeats. */
export function cacheStats(): { rows: number; mtime: number } {
  return { rows: cached.length, mtime: liveMtime };
}
