import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-write.js";

const PATH = join(process.cwd(), "state", "watchlist.json");

export type RiskTag = "HIGH" | "MED";

/**
 * One sub-market within an event — a single binary Yes/No question with
 * its own CLOB stack and conditionId. Stored under the event so we can
 * subscribe / aggregate signals at the event level.
 */
export interface SubMarket {
  slug: string;
  question: string;
  condition_id: string;
  /** [yes_token_id, no_token_id] for CLOB WebSocket subscription. */
  clob_token_ids: string[];
  end_date?: string;
}

/**
 * Watchlist entry keyed by event_slug. Human reviewers think in events
 * ("Cyprus election"), not individual sub-markets ("Will DISY win?").
 * All signals aggregate across the sub_markets array.
 */
export interface WatchEntry {
  added_at: number;
  added_by: "manual" | "smart_money_signal";
  risk_tag: RiskTag;
  reason: string;
  event_slug: string;
  event_title: string;
  end_date: string;
  sub_markets: SubMarket[];
}

export type Watchlist = Record<string, WatchEntry>; // keyed by event_slug

export function load(): Watchlist {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, "utf-8")) as Watchlist;
  } catch {
    return {};
  }
}

export function save(wl: Watchlist): void {
  writeJsonAtomic(PATH, wl);
}

export function add(eventSlug: string, entry: WatchEntry): void {
  const wl = load();
  wl[eventSlug] = entry;
  save(wl);
}

export function remove(eventSlug: string): boolean {
  const wl = load();
  if (!(eventSlug in wl)) return false;
  delete wl[eventSlug];
  save(wl);
  return true;
}

export function has(eventSlug: string): boolean {
  return eventSlug in load();
}

export function get(eventSlug: string): WatchEntry | null {
  return load()[eventSlug] ?? null;
}

/**
 * Find the event containing a given sub-market slug. Linear scan; the
 * watchlist is small enough (dozens of events) that this is fine.
 */
export function findEventForSubMarketSlug(subSlug: string): WatchEntry | null {
  const wl = load();
  for (const e of Object.values(wl)) {
    if (e.sub_markets.some((sm) => sm.slug === subSlug)) return e;
  }
  return null;
}

/**
 * Find the event containing a sub-market by its conditionId. Used by the
 * trade enricher / signals to route per-market trades up to the event.
 */
export function findEventForConditionId(conditionId: string): WatchEntry | null {
  const wl = load();
  for (const e of Object.values(wl)) {
    if (e.sub_markets.some((sm) => sm.condition_id === conditionId)) return e;
  }
  return null;
}

/** Flat list of every clob_token_id across every watchlist event. */
export function allClobTokenIds(): { tokenId: string; subSlug: string; eventSlug: string }[] {
  const out: { tokenId: string; subSlug: string; eventSlug: string }[] = [];
  for (const e of Object.values(load())) {
    for (const sm of e.sub_markets) {
      for (const tid of sm.clob_token_ids) {
        if (tid) out.push({ tokenId: tid, subSlug: sm.slug, eventSlug: e.event_slug });
      }
    }
  }
  return out;
}

/** Flat list of every conditionId with its event_slug for trade-enricher polling. */
export function allConditionIds(): { conditionId: string; subSlug: string; eventSlug: string; question: string }[] {
  const out: { conditionId: string; subSlug: string; eventSlug: string; question: string }[] = [];
  for (const e of Object.values(load())) {
    for (const sm of e.sub_markets) {
      if (sm.condition_id) {
        out.push({
          conditionId: sm.condition_id,
          subSlug: sm.slug,
          eventSlug: e.event_slug,
          question: sm.question,
        });
      }
    }
  }
  return out;
}

/**
 * Auto-remove watchlist events whose end_date is more than `graceDays`
 * days in the past. Returns event_slugs that were removed.
 */
export function cleanupExpired(graceDays = 14): string[] {
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
