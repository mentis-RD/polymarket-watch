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
