import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-write.js";

/**
 * Per-market CONSENSUS-SIDE price gates for the fresh-wallet signal.
 *
 * On low-base-rate "will X happen by <date>" markets (ME peace deals,
 * ceasefires, nuclear deals, Iran concessions) the NO side ("it won't happen")
 * is the obvious favorite = consensus, not insider edge — a fresh wallet paying
 * 0.87 for NO carries no signal. On a gated market the NO side is counted ONLY
 * when bought CHEAP (≤ maxPrice, default 0.30): the rare contrarian where a
 * deal looks announced and someone bets it still falls through.
 *
 * ALL gates are NO-side (outcomeIndex 1) BY DESIGN — the YES side ("the
 * unlikely event happens") is the insider direction and is NEVER gated at any
 * price. The /gate TG command can only add NO gates.
 *
 * SEED_PATTERNS are always-on (hardcoded). User additions via `/gate` live in
 * state/consensus_gates.json and merge on top (single writer = tg-control, so
 * no merge-on-save needed; the enricher reads + reloads on mtime change).
 */

const PATH = join(process.cwd(), "state", "consensus_gates.json");
const DEFAULT_MAX_PRICE = 0.3;

const SEED_PATTERNS = [
  "permanent-peace-deal",
  "nuclear-deal",
  "ceasefire",
  "blockade-of-[a-z-]+-lifted",
  "iran-agrees-to-",
];

export interface ConsensusGate {
  pattern: string; // regex source, matched case-insensitively against the slug
  maxPrice: number; // NO counts only at price ≤ this
}

let cached: ConsensusGate[] = [];
let cachedMtime = -1;
let loadedOnce = false;

function loadUserGates(): ConsensusGate[] {
  if (!existsSync(PATH)) return [];
  try {
    const o = JSON.parse(readFileSync(PATH, "utf-8")) as { gates?: ConsensusGate[] };
    return Array.isArray(o.gates)
      ? o.gates.filter((g) => g && typeof g.pattern === "string")
      : [];
  } catch {
    return [];
  }
}

function refresh(): void {
  let mtime = -1;
  try { if (existsSync(PATH)) mtime = statSync(PATH).mtimeMs; } catch { /* no file */ }
  if (loadedOnce && mtime === cachedMtime) return;

  const byPattern = new Map<string, ConsensusGate>();
  for (const p of SEED_PATTERNS) byPattern.set(p, { pattern: p, maxPrice: DEFAULT_MAX_PRICE });
  for (const g of loadUserGates()) {
    byPattern.set(g.pattern, {
      pattern: g.pattern,
      maxPrice: typeof g.maxPrice === "number" ? g.maxPrice : DEFAULT_MAX_PRICE,
    });
  }
  cached = [...byPattern.values()];
  cachedMtime = mtime;
  loadedOnce = true;
}

/**
 * A BUY to IGNORE: the NO favorite of a gated market, bought above the gate
 * price. YES (outcomeIndex 0) is never gated, at any price.
 */
export function isConsensusFavoriteBuy(
  eventSlug: string,
  subSlug: string,
  outcomeIndex: 0 | 1,
  price: number,
): boolean {
  if (outcomeIndex !== 1) return false; // NO-only
  refresh();
  for (const g of cached) {
    if (price <= g.maxPrice) continue;
    try {
      const re = new RegExp(g.pattern, "i");
      if (re.test(eventSlug) || re.test(subSlug)) return true;
    } catch { /* bad regex → skip */ }
  }
  return false;
}

/** Add a NO-side gate. Idempotent; rejects dup / invalid regex. */
export function addGate(pattern: string, maxPrice = DEFAULT_MAX_PRICE): { ok: boolean; reason?: string } {
  const p = pattern.trim();
  if (!p) return { ok: false, reason: "пустой паттерн" };
  try { new RegExp(p, "i"); } catch { return { ok: false, reason: "невалидный regex" }; }
  if (!(maxPrice > 0 && maxPrice < 1)) return { ok: false, reason: "цена должна быть 0..1" };
  if (SEED_PATTERNS.includes(p)) return { ok: false, reason: "уже в сиде (hardcoded)" };
  const user = loadUserGates();
  if (user.some((g) => g.pattern === p)) return { ok: false, reason: "уже добавлен" };
  user.push({ pattern: p, maxPrice });
  writeJsonAtomic(PATH, { gates: user });
  cachedMtime = -1; // force reload here + in the reader process on next mtime check
  return { ok: true };
}

/** Remove a user gate (seed gates are hardcoded and can't be removed). */
export function removeGate(pattern: string): { ok: boolean; reason?: string } {
  const p = pattern.trim();
  const user = loadUserGates();
  const next = user.filter((g) => g.pattern !== p);
  if (next.length === user.length) {
    return SEED_PATTERNS.includes(p)
      ? { ok: false, reason: "сид-гейт (hardcoded, не удалить)" }
      : { ok: false, reason: "не найден" };
  }
  writeJsonAtomic(PATH, { gates: next });
  cachedMtime = -1;
  return { ok: true };
}

/**
 * True if ANY gate pattern matches the slug (regardless of side/price). Used to
 * exempt the YES side from the global extreme-price (≥0.95) cut on these
 * markets — on a gated "event happens by date" market the YES side ("it
 * happens") is the insider direction and must stay a signal at ANY price.
 */
export function isGatedMarket(eventSlug: string, subSlug: string): boolean {
  refresh();
  for (const g of cached) {
    try {
      const re = new RegExp(g.pattern, "i");
      if (re.test(eventSlug) || re.test(subSlug)) return true;
    } catch { /* bad regex → skip */ }
  }
  return false;
}

/** All active gates (seed + user) for listing. */
export function listGates(): { pattern: string; maxPrice: number; seed: boolean }[] {
  refresh();
  return cached.map((g) => ({ ...g, seed: SEED_PATTERNS.includes(g.pattern) }));
}
