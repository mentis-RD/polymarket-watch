import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-write.js";

/**
 * Deterministic cross-day accumulation bookkeeping for the daily alerts
 * digest. Replaces the LLM-driven STEP 2.6 in prompts/daily-alerts-digest.md:
 * the headless `claude -p` used to load `digest_wallet_history.json`, build
 * the `<wallet>:<event_slug>:<SIDE>` key by hand, diff prior days, record
 * today, and save the file — every step at the mercy of the model
 * remembering to do it (and to key it identically). A missed save or a
 * mis-cased key silently reset the dedup, re-surfacing an accumulating
 * wallet as a fresh duplicate (see lessons #22).
 *
 * Now claude only computes each survivor's end-of-day cost basis (data-api,
 * STEP 2.5b) and pipes the list here. This CLI owns ALL the stateful
 * bookkeeping: canonical key, 7-day window, prior-day diff, progression,
 * atomic write, prune. Same input → same output, no model in the loop.
 *
 * Usage (stdin = JSON, stdout = JSON):
 *   echo '{"date":"2026-05-30","alerts":[
 *     {"wallet":"0xABC","market_slug":"us-iran-nuclear-deal-by-june-30","side":"NO","cost_basis":3132430.62}
 *   ]}' | npx tsx src/digest-adders.ts [--dry-run]
 *
 * Output: the same alerts, each enriched with:
 *   is_adder    — true if this wallet+event+side was already seen on an
 *                 earlier day within the 7-day window (→ badge "🔁 добирает Nд")
 *   days        — distinct days hit within the window, incl. today
 *   progression — per-day end-of-day cost basis, oldest→newest (for "($a→$b→$c)")
 *
 * Side effect (unless --dry-run): updates digest_wallet_history.json —
 * records today's cost basis per key, drops days >7d old, deletes keys that
 * go empty. Idempotent on a same-day re-run (today is excluded from the
 * prior-day diff, so re-running never inflates the day count).
 */

const HISTORY_PATH = join(process.cwd(), "state", "digest_wallet_history.json");
const WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

interface InAlert {
  wallet: string;
  // The MARKET identity for keying. For date-laddered events this is the
  // DOMINANT SUB-MARKET slug (e.g. `…-by-june-30`), NOT the event slug — so a
  // re-bet on a different date rung is a fresh key (fresh line), not a false
  // cross-date progression. `event_slug` accepted as a back-compat alias.
  market_slug?: string;
  event_slug?: string;
  side: string;
  cost_basis: number;
}

function slugOf(a: InAlert): string {
  return a.market_slug ?? a.event_slug ?? "";
}
interface Input {
  date: string; // YYYY-MM-DD (digest date, from `date -u +%Y-%m-%d`)
  alerts: InAlert[];
}
interface OutAlert extends InAlert {
  is_adder: boolean;
  days: number;
  progression: number[];
}
type HistEntry = { days: Record<string, number> };
type History = Record<string, HistEntry>;

/** Parse a YYYY-MM-DD date string to a UTC epoch (ms). NaN if malformed. */
function dayToMs(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Canonical, case-stable dedup key. */
function makeKey(a: InAlert): string {
  return `${a.wallet.toLowerCase()}:${slugOf(a)}:${a.side.toUpperCase()}`;
}

function loadHistory(): History {
  if (!existsSync(HISTORY_PATH)) return {};
  try {
    const h = JSON.parse(readFileSync(HISTORY_PATH, "utf-8")) as History;
    return h && typeof h === "object" ? h : {};
  } catch {
    return {};
  }
}

/** Drop day entries older than the window; return sorted (asc) surviving dates. */
function pruneDays(entry: HistEntry, cutoffMs: number, todayMs: number): string[] {
  const kept: Record<string, number> = {};
  for (const [d, v] of Object.entries(entry.days)) {
    const ms = dayToMs(d);
    if (Number.isFinite(ms) && ms >= cutoffMs && ms <= todayMs) kept[d] = v;
  }
  entry.days = kept;
  return Object.keys(kept).sort();
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");

  let input: Input;
  try {
    input = JSON.parse(readFileSync(0, "utf-8")) as Input; // fd 0 = stdin
  } catch (e) {
    console.error(`digest-adders: bad stdin JSON: ${(e as Error).message}`);
    process.exit(1);
  }
  const todayMs = dayToMs(input.date);
  if (!Number.isFinite(todayMs)) {
    console.error(`digest-adders: bad date "${input.date}" (want YYYY-MM-DD)`);
    process.exit(1);
  }
  const cutoffMs = todayMs - WINDOW_DAYS * DAY_MS;
  const alerts = Array.isArray(input.alerts) ? input.alerts : [];

  const history = loadHistory();
  const out: OutAlert[] = [];

  for (const a of alerts) {
    if (!a || !a.wallet || !slugOf(a) || !a.side) continue;
    const key = makeKey(a);
    const entry: HistEntry = history[key] ?? { days: {} };

    // Prior-day diff BEFORE recording today → same-day re-runs stay idempotent.
    pruneDays(entry, cutoffMs, todayMs);
    const priorDays = Object.keys(entry.days).filter((d) => d !== input.date);

    // Record today's end-of-day cost basis (overwrites an earlier same-day value).
    entry.days[input.date] = Number(a.cost_basis) || 0;
    history[key] = entry;

    const sortedDates = Object.keys(entry.days).sort();
    out.push({
      wallet: a.wallet,
      market_slug: slugOf(a),
      side: a.side,
      cost_basis: a.cost_basis,
      is_adder: priorDays.length > 0,
      days: sortedDates.length,
      progression: sortedDates.map((d) => entry.days[d]),
    });
  }

  // Global prune so the file stays bounded: drop stale days on EVERY key
  // (incl. ones not in today's input), delete keys that go empty.
  for (const [key, entry] of Object.entries(history)) {
    const surviving = pruneDays(entry, cutoffMs, todayMs);
    if (surviving.length === 0) delete history[key];
  }

  if (!dryRun) writeJsonAtomic(HISTORY_PATH, history);

  process.stdout.write(JSON.stringify({ adders: out }, null, 2) + "\n");
}

main();
