import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const PATH = join(process.cwd(), "state", "watchlist.json");

export type RiskTag = "HIGH" | "MED";

export interface WatchEntry {
  added_at: number;
  added_by: "manual" | "smart_money_signal";
  risk_tag: RiskTag;
  reason: string;
  end_date: string;
  question: string;
  condition_id: string;
  /** [yes_token_id, no_token_id] for CLOB WS subscription */
  clob_token_ids: string[];
}

export type Watchlist = Record<string, WatchEntry>;

export function load(): Watchlist {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, "utf-8")) as Watchlist;
  } catch {
    return {};
  }
}

export function save(wl: Watchlist): void {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(wl, null, 2));
}

export function add(slug: string, entry: WatchEntry): void {
  const wl = load();
  wl[slug] = entry;
  save(wl);
}

export function remove(slug: string): boolean {
  const wl = load();
  if (!(slug in wl)) return false;
  delete wl[slug];
  save(wl);
  return true;
}

export function has(slug: string): boolean {
  return slug in load();
}

/**
 * Auto-remove watchlist entries whose end_date is more than `graceDays` days in the past.
 * Returns slugs that were removed.
 */
export function cleanupExpired(graceDays = 7): string[] {
  const wl = load();
  const cutoff = Date.now() - graceDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const [slug, entry] of Object.entries(wl)) {
    if (!entry.end_date) continue;
    const endTs = Date.parse(entry.end_date);
    if (Number.isFinite(endTs) && endTs < cutoff) {
      delete wl[slug];
      removed.push(slug);
    }
  }
  if (removed.length > 0) save(wl);
  return removed;
}
