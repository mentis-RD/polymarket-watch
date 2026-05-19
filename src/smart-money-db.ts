import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-write.js";

const PATH = join(process.cwd(), "state", "smart_money.json");

export interface WinRecord {
  ts: number;
  slug: string;
  market: string;
  outcome: string;
  outcomeIndex: 0 | 1;
  avg_bought_price: number;
  size: number;
  notional: number;
  multiple: number;
}

export interface SmartMoneyEntry {
  first_added_ts: number;
  added_by: "post_mortem" | "leaderboard_profit" | "leaderboard_volume" | "manual";
  /** Optional leaderboard metric value at seed time (lifetime profit or volume in USD). */
  seed_amount?: number;
  /** Optional public pseudonym from Polymarket leaderboard. */
  pseudonym?: string;
  wins: WinRecord[];
}

export type SmartMoneyDB = Record<string, SmartMoneyEntry>;

export function load(): SmartMoneyDB {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, "utf-8")) as SmartMoneyDB;
  } catch {
    return {};
  }
}

export function save(db: SmartMoneyDB): void {
  writeJsonAtomic(PATH, db);
}

export function recordWin(wallet: string, win: WinRecord): void {
  // Single-winner add path. Prefer recordWins() for batch inserts so we
  // pay one full-file rewrite instead of N when a market resolves with
  // 50 early winners.
  recordWins([{ wallet, win }]);
}

/** Batched winner recording — single load + single save for the whole list. */
export function recordWins(rows: { wallet: string; win: WinRecord }[]): void {
  if (rows.length === 0) return;
  const db = load();
  for (const { wallet, win } of rows) {
    const lc = wallet.toLowerCase();
    const entry = db[lc] ?? {
      first_added_ts: Date.now(),
      added_by: "post_mortem",
      wins: [],
    };
    const exists = entry.wins.some(
      (w) => w.slug === win.slug && w.outcomeIndex === win.outcomeIndex,
    );
    if (!exists) entry.wins.push(win);
    db[lc] = entry;
  }
  save(db);
}

export function has(wallet: string): boolean {
  return wallet.toLowerCase() in load();
}

export function get(wallet: string): SmartMoneyEntry | null {
  return load()[wallet.toLowerCase()] ?? null;
}

export interface SeedRow {
  wallet: string;
  pseudonym?: string;
  amount: number;
  added_by: "leaderboard_profit" | "leaderboard_volume";
}

/** Bulk-add entries, preserving any existing wins. Returns count of new additions. */
export function bulkAdd(rows: SeedRow[]): number {
  const db = load();
  const now = Date.now();
  let added = 0;
  for (const r of rows) {
    const lc = r.wallet.toLowerCase();
    if (db[lc]) {
      // Keep existing; update pseudonym/seed_amount only if missing.
      if (!db[lc].pseudonym && r.pseudonym) db[lc].pseudonym = r.pseudonym;
      if (db[lc].seed_amount === undefined) db[lc].seed_amount = r.amount;
      continue;
    }
    db[lc] = {
      first_added_ts: now,
      added_by: r.added_by,
      seed_amount: r.amount,
      pseudonym: r.pseudonym,
      wins: [],
    };
    added++;
  }
  save(db);
  return added;
}

export function size(): number {
  return Object.keys(load()).length;
}
