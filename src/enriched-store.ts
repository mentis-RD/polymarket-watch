import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared in-memory mirror of `state/trades_enriched.jsonl`. Avoids per-market
 * full-file reads from cluster + cross-market signals on every scan cycle
 * (was O(N watchlist) × O(file size) per cycle; now O(file size) per cycle).
 *
 * Strategy: cache the parsed array in memory, invalidate when file mtime
 * changes. Each refresh re-reads the full file. For very large files (>200MB)
 * an incremental byte-offset reader would be even better — the file rotates
 * at 200MB anyway, so this is bounded.
 */

const PATH = join(process.cwd(), "state", "trades_enriched.jsonl");

export interface EnrichedTrade {
  ts: number;
  slug: string;
  market: string;
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

let cached: EnrichedTrade[] = [];
let cachedMtimeMs = 0;
let cachedFromPath = "";

function refresh(): void {
  if (!existsSync(PATH)) {
    if (cachedFromPath !== "" || cached.length > 0) {
      cached = [];
      cachedMtimeMs = 0;
      cachedFromPath = "";
    }
    return;
  }
  let mtime: number;
  try {
    mtime = statSync(PATH).mtimeMs;
  } catch {
    return;
  }
  if (cachedFromPath === PATH && mtime === cachedMtimeMs) return;

  const next: EnrichedTrade[] = [];
  try {
    const raw = readFileSync(PATH, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        next.push(JSON.parse(line) as EnrichedTrade);
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    return;
  }
  cached = next;
  cachedMtimeMs = mtime;
  cachedFromPath = PATH;
}

/** All enriched trades. Triggers a re-parse if the file changed since last call. */
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
  return { rows: cached.length, mtime: cachedMtimeMs };
}
