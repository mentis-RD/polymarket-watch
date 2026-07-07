import { request } from "undici";
import { log, err } from "./log.js";

const BASE = "https://gamma-api.polymarket.com";

export interface PolyTag {
  id: string;
  label: string;
  slug: string;
}

export interface PolyEvent {
  id: string;
  slug: string;
  ticker?: string;
  title?: string;
}

export interface PolyMarket {
  id: string;
  question: string;
  slug: string;
  conditionId?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  updatedAt?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  restricted?: boolean;
  liquidity?: string;
  liquidityNum?: number;
  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  volume1wk?: number;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  tags?: PolyTag[];
  events?: PolyEvent[];
}

export interface FetchOpts {
  limit?: number;
  offset?: number;
  closed?: boolean;
  active?: boolean;
  order?: string;
  ascending?: boolean;
}

export async function fetchMarketsPage(opts: FetchOpts = {}): Promise<PolyMarket[]> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 100));
  params.set("offset", String(opts.offset ?? 0));
  if (opts.closed !== undefined) params.set("closed", String(opts.closed));
  if (opts.active !== undefined) params.set("active", String(opts.active));
  params.set("order", opts.order ?? "start_date");
  params.set("ascending", String(opts.ascending ?? false));
  params.set("include_tag", "true");

  const url = `${BASE}/markets?${params.toString()}`;
  const res = await request(url);
  if (res.statusCode !== 200) {
    throw new Error(`Gamma /markets ${res.statusCode}: ${await res.body.text()}`);
  }
  const data = (await res.body.json()) as PolyMarket[];
  if (!Array.isArray(data)) {
    throw new Error(`Gamma /markets non-array response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

/**
 * Paginate through newest markets (start_date desc) until `shouldStop` returns true
 * or `maxPages` is reached. Returns all markets seen during pagination in order.
 *
 * Gamma caps offset; once we hit a 422 "offset exceeds maximum" we stop gracefully.
 */
export async function fetchNewestMarkets(opts: {
  shouldStop?: (page: PolyMarket[]) => boolean;
  maxPages?: number;
  pageSize?: number;
  pageDelayMs?: number;
}): Promise<PolyMarket[]> {
  const maxPages = opts.maxPages ?? 50;
  const pageSize = opts.pageSize ?? 100;
  const delay = opts.pageDelayMs ?? 250;
  const out: PolyMarket[] = [];

  for (let i = 0; i < maxPages; i++) {
    let page: PolyMarket[];
    try {
      page = await fetchMarketsPage({
        limit: pageSize,
        offset: i * pageSize,
        closed: false,
        order: "start_date",
        ascending: false,
      });
    } catch (e) {
      const msg = (e as Error).message || "";
      if (msg.includes("offset exceeds maximum")) {
        log("gamma", `hit offset cap at page ${i + 1} (${out.length} markets); stopping`);
        break;
      }
      throw e;
    }
    if (page.length === 0) break;
    out.push(...page);

    if (opts.shouldStop && opts.shouldStop(page)) {
      log("gamma", `pagination stop at page ${i + 1} (${out.length} markets)`);
      break;
    }
    if (page.length < pageSize) break;
    if (delay > 0) await sleep(delay);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function marketUrl(slug: string): string {
  return `https://polymarket.com/market/${slug}`;
}

export function categoryFromTags(tags?: PolyTag[]): string {
  if (!tags || tags.length === 0) return "";
  // Skip generic "All" tag, take first meaningful label.
  const meaningful = tags.filter((t) => t.label && t.label.toLowerCase() !== "all");
  return meaningful.map((t) => t.label).join("|");
}

export async function fetchMarketBySlug(slug: string): Promise<PolyMarket | null> {
  const params = new URLSearchParams({ slug, include_tag: "true" });
  const url = `${BASE}/markets?${params.toString()}`;
  const res = await request(url);
  if (res.statusCode !== 200) return null;
  const data = (await res.body.json()) as PolyMarket[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

/**
 * `market.clobTokenIds` is a stringified JSON array like '["123...", "456..."]'.
 * Returns parsed token IDs (Yes/No) or empty array if missing/malformed.
 */
export function parseClobTokenIds(market: PolyMarket): string[] {
  const raw = market.clobTokenIds;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String);
  } catch {
    // fall through
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────
// Events
//
// Polymarket models the user-visible "market" as an EVENT containing N
// individual binary markets (e.g. "MSTR sells any BTC by ___?" event has
// sub-markets for each cutoff date). Trading and review happens at the
// event level — humans don't bet on isolated strikes, they bet on the
// theme. Catalog and watchlist should operate on events accordingly.
// ─────────────────────────────────────────────────────────────────────────

export interface PolyEventMarket {
  id: string;
  slug: string;
  question: string;
  conditionId?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  liquidity?: string;
  liquidityNum?: number;
  clobTokenIds?: string;
  endDate?: string;
  closed?: boolean;
  archived?: boolean;
  groupItemTitle?: string;
}

export interface PolyEventFull {
  id: string;
  slug: string;
  ticker?: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  featured?: boolean;
  liquidity?: number;
  volume?: number;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  openInterest?: number;
  competitive?: number;
  commentCount?: number;
  markets?: PolyEventMarket[];
  tags?: PolyTag[];
}

interface FetchEventsOpts {
  limit?: number;
  offset?: number;
  closed?: boolean;
  active?: boolean;
  order?: string;
  ascending?: boolean;
}

async function fetchEventsPage(opts: FetchEventsOpts = {}): Promise<PolyEventFull[]> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 100));
  params.set("offset", String(opts.offset ?? 0));
  if (opts.closed !== undefined) params.set("closed", String(opts.closed));
  if (opts.active !== undefined) params.set("active", String(opts.active));
  params.set("order", opts.order ?? "endDate");
  params.set("ascending", String(opts.ascending ?? true));
  params.set("include_tag", "true");

  const url = `${BASE}/events?${params.toString()}`;
  const res = await request(url);
  if (res.statusCode !== 200) {
    throw new Error(`Gamma /events ${res.statusCode}: ${await res.body.text()}`);
  }
  const data = (await res.body.json()) as PolyEventFull[];
  if (!Array.isArray(data)) {
    throw new Error(`Gamma /events non-array response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

/**
 * Paginate through open events. Same offset-cap behaviour as /markets
 * (Gamma returns 422 once you exceed ~10k offset). Returns events sorted
 * by ascending endDate so the soonest-to-resolve come first.
 */
export async function fetchEventBySlug(slug: string): Promise<PolyEventFull | null> {
  const params = new URLSearchParams({ slug, include_tag: "true" });
  const url = `${BASE}/events?${params.toString()}`;
  const res = await request(url);
  if (res.statusCode !== 200) return null;
  const data = (await res.body.json()) as PolyEventFull[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

/**
 * Resolve a slug to an event. Accepts EITHER an event slug or a market slug
 * — if the slug matches a market, returns that market's parent event.
 * Returns null if neither lookup succeeds.
 */
export async function resolveEventFromAnySlug(slug: string): Promise<PolyEventFull | null> {
  const event = await fetchEventBySlug(slug);
  if (event) return event;
  const market = await fetchMarketBySlug(slug);
  if (!market) return null;
  const parentSlug = market.events?.[0]?.slug;
  if (!parentSlug) return null;
  return await fetchEventBySlug(parentSlug);
}

export async function fetchOpenEvents(opts: {
  maxPages?: number;
  pageSize?: number;
  pageDelayMs?: number;
  order?: string;
  ascending?: boolean;
} = {}): Promise<PolyEventFull[]> {
  const maxPages = opts.maxPages ?? 200;
  const pageSize = opts.pageSize ?? 100;
  const delay = opts.pageDelayMs ?? 200;
  const order = opts.order ?? "endDate";
  const ascending = opts.ascending ?? true;
  const out: PolyEventFull[] = [];
  for (let i = 0; i < maxPages; i++) {
    let page: PolyEventFull[];
    try {
      page = await fetchEventsPage({
        limit: pageSize,
        offset: i * pageSize,
        closed: false,
        order,
        ascending,
      });
    } catch (e) {
      const m = (e as Error).message || "";
      // Gamma caps offset (dropped ~10k → ~2-4k in 2026-07 and changed the error
      // text to "offset too large, use /events/keyset"). Stop gracefully on both.
      if (/offset exceeds maximum|offset too large|keyset/i.test(m)) {
        log("gamma", `events: hit offset cap at page ${i + 1} (${out.length} events); stopping`);
        break;
      }
      throw e;
    }
    if (page.length === 0) break;
    out.push(...page);
    if (page.length < pageSize) break;
    if (delay > 0) await sleep(delay);
  }
  return out;
}
