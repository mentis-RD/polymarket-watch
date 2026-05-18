import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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
  added_by: "post_mortem" | "dune_seed" | "manual";
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
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(db, null, 2));
}

export function recordWin(wallet: string, win: WinRecord): void {
  const lc = wallet.toLowerCase();
  const db = load();
  const entry = db[lc] ?? {
    first_added_ts: Date.now(),
    added_by: "post_mortem",
    wins: [],
  };
  // Dedup by (slug, outcome) — one entry per market resolution per wallet.
  const exists = entry.wins.some((w) => w.slug === win.slug && w.outcomeIndex === win.outcomeIndex);
  if (!exists) {
    entry.wins.push(win);
  }
  db[lc] = entry;
  save(db);
}

export function has(wallet: string): boolean {
  return wallet.toLowerCase() in load();
}
