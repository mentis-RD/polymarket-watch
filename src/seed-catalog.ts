import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 300, pipelining: 10, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import { fetchOpenEvents, type PolyEventFull, type PolyTag } from "./polymarket-api.js";
import { sendDocument } from "./telegram.js";
import { isSkippedCategoryEvent } from "./category-filter.js";
import { log, err } from "./log.js";

/**
 * Bootstrap a catalog of currently-open Polymarket EVENTS (not individual
 * markets). Each row in each output CSV is one event — humans trade themes,
 * not isolated binary strikes. Sub-market metadata is rolled up into a few
 * informational columns; the event_slug + condition_ids let downstream tools
 * (watchlist, monitor) expand to per-market subscriptions.
 *
 * Run:
 *   npx tsx src/seed-catalog.ts            # output/catalog_<date>/
 *   npx tsx src/seed-catalog.ts --send-tg  # also archive + send to digest thread
 */

const OUTPUT_BASE = join(process.cwd(), "output");

const SHORT_CYCLE_SLUG_RE =
  /(?:^|[-])(?:updown|up-or-down|hourly|every-?hour|every-?day|every-?week|daily|weekly|1m|2m|5m|10m|15m|30m|1h|2h|4h|6h|8h|12h)(?:[-]|$|\d)/i;

const SHORT_CYCLE_TITLE_RE =
  /\b(?:up or down|updown|next \d+\s*(?:minutes?|hours?|min|hr))\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;

interface CatalogEventRow {
  event_slug: string;
  title: string;
  category: string;
  tags: string; // pipe-separated, slugged, ALL tags incl. internal
  end_date: string;
  start_date: string;
  days_to_end: number;
  num_markets: number;
  open_markets: number;
  volume_24h: number;
  volume_total: number;
  liquidity: number;
  open_interest: number;
  competitive: number;
  comment_count: number;
  sub_market_slugs: string; // pipe-separated child slugs
  condition_ids: string; // pipe-separated child conditionIds (for API/cluster use)
  description: string;
  url: string;
}

function isShortCycleEvent(e: PolyEventFull): boolean {
  if (SHORT_CYCLE_SLUG_RE.test(e.slug)) return true;
  if (e.title && SHORT_CYCLE_TITLE_RE.test(e.title)) return true;
  // Duration-based fallback at event level.
  if (e.startDate && e.endDate) {
    const start = Date.parse(e.startDate);
    const end = Date.parse(e.endDate);
    if (Number.isFinite(start) && Number.isFinite(end) && end - start < DAY_MS) {
      return true;
    }
  }
  return false;
}

const STOP_TAG_RE =
  /^(?:all|trending|new|featured|hot|hide-from-new|rewards-?\d|earn-?\d|hip3|fuse-energy|platinum-glove|pre-market|comex-.*-futures|nymex-.*-futures|main-election|rewards-?[\d-]+|parlays|prediction-markets)$/i;

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const TOP_LEVEL_PREFERRED = [
  "politics",
  "geopolitics",
  "elections",
  "global-elections",
  "world-elections",
  "primaries",
  "congress",
  "sports",
  "soccer",
  "nfl",
  "nba",
  "mlb",
  "nhl",
  "ufc",
  "boxing",
  "tennis",
  "f1",
  "formula-1",
  "esports",
  "crypto",
  "bitcoin",
  "ethereum",
  "business",
  "finance",
  "ipo",
  "ipos",
  "tech",
  "ai",
  "culture",
  "music",
  "movies",
  "celebrities",
  "science",
  "space",
  "weather",
  "economy",
  "inflation",
  "gdp",
  "fed",
  "interest-rates",
  "world",
  "world-affairs",
];

function primaryTag(tags?: PolyTag[]): string {
  if (!tags || tags.length === 0) return "uncategorized";
  const slugged: string[] = [];
  for (const t of tags) {
    const label = (t.label || "").trim();
    if (!label) continue;
    const s = slugify(label);
    if (!s) continue;
    if (STOP_TAG_RE.test(s)) continue;
    slugged.push(s);
  }
  if (slugged.length === 0) return "uncategorized";
  const preferred = new Set(TOP_LEVEL_PREFERRED);
  for (const target of TOP_LEVEL_PREFERRED) {
    if (slugged.includes(target)) return target;
  }
  for (const s of slugged) {
    if (!preferred.has(s)) return s;
  }
  return slugged[0];
}

function allTagsPipe(tags?: PolyTag[]): string {
  if (!tags || tags.length === 0) return "";
  return tags
    .map((t) => slugify(t.label || ""))
    .filter((s) => s.length > 0)
    .join("|");
}

function toRow(e: PolyEventFull): CatalogEventRow {
  const now = Date.now();
  const endTs = e.endDate ? Date.parse(e.endDate) : NaN;
  const daysToEnd = Number.isFinite(endTs)
    ? Math.max(0, Math.round((endTs - now) / DAY_MS))
    : -1;
  const markets = e.markets ?? [];
  const openMarkets = markets.filter((m) => !m.closed && !m.archived);
  return {
    event_slug: e.slug,
    title: e.title || "",
    category: primaryTag(e.tags),
    tags: allTagsPipe(e.tags),
    end_date: e.endDate || "",
    start_date: e.startDate || "",
    days_to_end: daysToEnd,
    num_markets: markets.length,
    open_markets: openMarkets.length,
    volume_24h: e.volume24hr ?? 0,
    volume_total: e.volume ?? 0,
    liquidity: e.liquidity ?? 0,
    open_interest: e.openInterest ?? 0,
    competitive: e.competitive ?? 0,
    comment_count: e.commentCount ?? 0,
    sub_market_slugs: markets.map((m) => m.slug).filter(Boolean).join("|"),
    condition_ids: markets
      .map((m) => m.conditionId)
      .filter((id): id is string => !!id)
      .join("|"),
    description: (e.description || "").replace(/\s+/g, " ").trim().slice(0, 300),
    url: `https://polymarket.com/event/${e.slug}`,
  };
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: CatalogEventRow[]): string {
  // Identity first, then timing, then aggregate stats (informational only),
  // then sub-market expansion (for /watch_event etc), then context.
  const headers = [
    "event_slug",
    "title",
    "category",
    "tags",
    "end_date",
    "days_to_end",
    "start_date",
    "num_markets",
    "open_markets",
    "volume_24h",
    "volume_total",
    "liquidity",
    "open_interest",
    "competitive",
    "comment_count",
    "sub_market_slugs",
    "condition_ids",
    "description",
    "polymarket_url",
  ];
  const lines = rows.map((r) =>
    [
      r.event_slug,
      r.title,
      r.category,
      r.tags,
      r.end_date,
      r.days_to_end,
      r.start_date,
      r.num_markets,
      r.open_markets,
      r.volume_24h.toFixed(2),
      r.volume_total.toFixed(2),
      r.liquidity.toFixed(2),
      r.open_interest.toFixed(2),
      r.competitive.toFixed(3),
      r.comment_count,
      r.sub_market_slugs,
      r.condition_ids,
      r.description,
      r.url,
    ]
      .map(csvEscape)
      .join(","),
  );
  return [headers.join(","), ...lines].join("\n") + "\n";
}

async function main(): Promise<void> {
  const sendTg = process.argv.includes("--send-tg");
  const dateKey = new Date().toISOString().slice(0, 10);
  const outDir = join(OUTPUT_BASE, `catalog_${dateKey}`);
  mkdirSync(outDir, { recursive: true });

  log("seed-catalog", "fetching open events (paginated, ordered by endDate asc)...");
  const all = await fetchOpenEvents({ maxPages: 200, pageSize: 100, pageDelayMs: 200 });
  log("seed-catalog", `fetched ${all.length} open events`);

  let kept = 0;
  let strippedShortCycle = 0;
  let strippedExpired = 0;
  let strippedSports = 0;
  let totalSubMarkets = 0;
  const now = Date.now();
  const byCategory = new Map<string, CatalogEventRow[]>();

  for (const e of all) {
    if (!e.slug) continue;
    if (e.closed || e.archived) continue;
    if (isShortCycleEvent(e)) {
      strippedShortCycle++;
      continue;
    }
    // Sports / esports / combat skipped — see category-filter.ts.
    if (isSkippedCategoryEvent(e.tags)) {
      strippedSports++;
      continue;
    }
    if (e.endDate) {
      const endTs = Date.parse(e.endDate);
      if (Number.isFinite(endTs) && endTs < now) {
        strippedExpired++;
        continue;
      }
    }
    const row = toRow(e);
    totalSubMarkets += row.num_markets;
    const arr = byCategory.get(row.category) ?? [];
    arr.push(row);
    byCategory.set(row.category, arr);
    kept++;
  }

  // Sort each category by end_date asc (closest first); -1 (no end_date) last.
  for (const arr of byCategory.values()) {
    arr.sort((a, b) => {
      const ae = a.days_to_end < 0 ? Number.POSITIVE_INFINITY : a.days_to_end;
      const be = b.days_to_end < 0 ? Number.POSITIVE_INFINITY : b.days_to_end;
      return ae - be;
    });
  }

  const indexRows: { category: string; file: string; events: number; sub_markets: number }[] = [];
  for (const [category, arr] of [...byCategory.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const file = `${category}.csv`;
    writeFileSync(join(outDir, file), rowsToCsv(arr));
    const submarkets = arr.reduce((s, r) => s + r.num_markets, 0);
    indexRows.push({ category, file, events: arr.length, sub_markets: submarkets });
  }

  const indexCsv =
    ["category", "file", "events", "sub_markets"].join(",") +
    "\n" +
    indexRows
      .map((r) => [r.category, r.file, r.events, r.sub_markets].map(csvEscape).join(","))
      .join("\n") +
    "\n";
  writeFileSync(join(outDir, "_index.csv"), indexCsv);

  log(
    "seed-catalog",
    `wrote ${indexRows.length} categories, ${kept} events (${totalSubMarkets} sub-markets) kept, ${strippedShortCycle} short-cycle + ${strippedExpired} expired + ${strippedSports} sports stripped → ${outDir}`,
  );

  if (sendTg) {
    const chat = process.env.TG_CHAT_MAIN;
    const thread = process.env.TG_THREAD_DIGEST;
    if (!chat) {
      err("seed-catalog", "--send-tg requested but TG_CHAT_MAIN unset");
      return;
    }
    const archive = `/tmp/polymarket-catalog-${dateKey}.tar.gz`;
    try {
      execSync(`tar -czf ${archive} -C ${OUTPUT_BASE} catalog_${dateKey}`);
    } catch (e) {
      err("seed-catalog", "tar failed", (e as Error).message);
      return;
    }
    const ok = await sendDocument({
      chatId: chat,
      threadId: thread || undefined,
      filePath: archive,
      caption: `📚 Polymarket EVENTS catalog ${dateKey}\n${indexRows.length} categories, ${kept} events (${totalSubMarkets} sub-markets), short-cycle + expired stripped\nReview, /watch_event <event_slug> to monitor all sub-markets.`,
    });
    log("seed-catalog", `TG send: ${ok ? "ok" : "failed"}`);
  }
}

main().catch((e) => {
  err("seed-catalog", "fatal", e);
  process.exit(1);
});
