import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 300, pipelining: 10, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import {
  fetchNewestMarkets,
  marketUrl,
  type PolyMarket,
  type PolyTag,
} from "./polymarket-api.js";
import { sendDocument } from "./telegram.js";
import { log, err } from "./log.js";

/**
 * Bootstrap a catalog of currently-open Polymarket markets, grouped by primary
 * tag, with short-cycle noise stripped. NOT a pre-filter on volume/liquidity —
 * a thin market today may be tomorrow's insider target. Use this output as
 * a one-time human-review pass to populate watchlist.
 *
 * Run:
 *   npx tsx src/seed-catalog.ts            # output/catalog_<date>/
 *   npx tsx src/seed-catalog.ts --send-tg  # also archive + send to digest thread
 */

const OUTPUT_BASE = join(process.cwd(), "output");

/**
 * Slugs that look algorithmically generated for recurring price ticks
 * (e.g. `xrp-updown-15m-1779129000`, `btc-up-or-down-this-hour`). These
 * dominate the open-markets list and add zero insider-detection value.
 */
const SHORT_CYCLE_SLUG_RE =
  /(?:^|[-])(?:updown|up-or-down|hourly|every-?hour|every-?day|every-?week|daily|weekly|1m|2m|5m|10m|15m|30m|1h|2h|4h|6h|8h|12h)(?:[-]|$|\d)/i;

const SHORT_CYCLE_TITLE_RE =
  /\b(?:up or down|updown|next \d+\s*(?:minutes?|hours?|min|hr))\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;

interface CatalogRow {
  slug: string;
  title: string;
  category: string; // primary tag (used for file routing)
  tags: string; // ALL tags, pipe-separated — for downstream filtering
  event_slug: string; // Polymarket event grouping (multiple markets per event)
  condition_id: string;
  end_date: string;
  start_date: string;
  days_to_end: number;
  volume_total: number;
  volume_24h: number;
  liquidity: number;
  description: string;
  url: string;
}

function isShortCycle(m: PolyMarket): boolean {
  if (SHORT_CYCLE_SLUG_RE.test(m.slug)) return true;
  if (m.question && SHORT_CYCLE_TITLE_RE.test(m.question)) return true;
  // Duration-based fallback: if the market opened and closes within 24h
  // it's almost certainly a tick market.
  if (m.startDate && m.endDate) {
    const start = Date.parse(m.startDate);
    const end = Date.parse(m.endDate);
    if (Number.isFinite(start) && Number.isFinite(end) && end - start < DAY_MS) {
      return true;
    }
  }
  return false;
}

/** Tags that are Polymarket internal config, not topic categories. */
const STOP_TAG_RE =
  /^(?:all|trending|new|featured|hot|hide-from-new|rewards-?\d|earn-?\d|hip3|fuse-energy|platinum-glove|pre-market|comex-.*-futures|nymex-.*-futures|main-election|rewards-?[\d-]+|parlays|prediction-markets)$/i;

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Pick a primary category tag. Skips internal/config tags (rewards-*,
 * hide-from-new, exchange names, etc) and prefers broad topical tags when
 * available. Polymarket's tag order is NOT semantically meaningful —
 * "Rewards 50, 4.5, 20" frequently shows up first for election markets.
 */
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
  // First pass: any top-level preferred tag wins, in preference order.
  const preferred = new Set(TOP_LEVEL_PREFERRED);
  for (const target of TOP_LEVEL_PREFERRED) {
    if (slugged.includes(target)) return target;
  }
  // Second pass: first non-preferred tag (i.e. specific topic like "ukraine").
  for (const s of slugged) {
    if (!preferred.has(s)) return s;
  }
  return slugged[0];
}

function allTagsPipe(tags?: PolyTag[]): string {
  if (!tags || tags.length === 0) return "";
  // Keep ALL tags including internal ones (rewards-*, hide-from-new, ...)
  // — user can grep/filter them out, and having them visible is useful info.
  // Slugged form so it grep's cleanly without case-sensitivity surprises.
  return tags
    .map((t) => slugify(t.label || ""))
    .filter((s) => s.length > 0)
    .join("|");
}

function toRow(m: PolyMarket): CatalogRow {
  const now = Date.now();
  const endTs = m.endDate ? Date.parse(m.endDate) : NaN;
  const daysToEnd = Number.isFinite(endTs) ? Math.max(0, Math.round((endTs - now) / DAY_MS)) : -1;
  return {
    slug: m.slug,
    title: m.question || "",
    category: primaryTag(m.tags),
    tags: allTagsPipe(m.tags),
    event_slug: m.events?.[0]?.slug || "",
    condition_id: m.conditionId || "",
    end_date: m.endDate || "",
    start_date: m.startDate || "",
    days_to_end: daysToEnd,
    volume_total: m.volumeNum ?? 0,
    volume_24h: m.volume24hr ?? 0,
    liquidity: m.liquidityNum ?? 0,
    description: (m.description || "").replace(/\s+/g, " ").trim().slice(0, 280),
    url: marketUrl(m.slug),
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

function rowsToCsv(rows: CatalogRow[]): string {
  // Column order chosen for at-a-glance scanning in a spreadsheet:
  //   slug / title / category / tags / event_slug    — identity & grouping
  //   end_date / days_to_end / start_date            — timing
  //   volume_24h / volume_total / liquidity          — informational, NOT filtered upstream
  //   description / polymarket_url / condition_id    — context & API refs
  //
  // The `tags` column is pipe-separated (`politics|elections|trump|2026`) so
  // you can grep/filter without comma collisions: in Excel filter by "contains
  // trump", in CLI: `grep -E '[,"]tags[^,]*\\|trump\\|' file.csv` or simpler
  // `awk -F, 'NR==1 || $4 ~ /lebron/' politics.csv`.
  const headers = [
    "slug",
    "title",
    "category",
    "tags",
    "event_slug",
    "end_date",
    "days_to_end",
    "start_date",
    "volume_24h",
    "volume_total",
    "liquidity",
    "description",
    "polymarket_url",
    "condition_id",
  ];
  const lines = rows.map((r) =>
    [
      r.slug,
      r.title,
      r.category,
      r.tags,
      r.event_slug,
      r.end_date,
      r.days_to_end,
      r.start_date,
      r.volume_24h.toFixed(2),
      r.volume_total.toFixed(2),
      r.liquidity.toFixed(2),
      r.description,
      r.url,
      r.condition_id,
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

  log("seed-catalog", "fetching open markets (paginated)...");
  // fetchNewestMarkets paginates with closed=false until Gamma's offset cap.
  const all = await fetchNewestMarkets({
    maxPages: 200, // hit the cap (~10k markets); harmless if fewer
    pageSize: 100,
    pageDelayMs: 200,
  });
  log("seed-catalog", `fetched ${all.length} open markets`);

  let kept = 0;
  let strippedShortCycle = 0;
  let strippedExpired = 0;
  const now = Date.now();
  const byCategory = new Map<string, CatalogRow[]>();

  for (const m of all) {
    if (!m.slug) continue;
    if (m.closed || m.archived) continue;
    if (isShortCycle(m)) {
      strippedShortCycle++;
      continue;
    }
    // Skip markets whose end_date is already in the past — they're awaiting
    // UMA resolution and aren't actionable. (Polymarket leaves these "open"
    // in the API until resolution clears.)
    if (m.endDate) {
      const endTs = Date.parse(m.endDate);
      if (Number.isFinite(endTs) && endTs < now) {
        strippedExpired++;
        continue;
      }
    }
    const row = toRow(m);
    const arr = byCategory.get(row.category) ?? [];
    arr.push(row);
    byCategory.set(row.category, arr);
    kept++;
  }

  // Sort each category by end_date ascending (closest first), with markets
  // missing end_date pushed to the bottom.
  for (const arr of byCategory.values()) {
    arr.sort((a, b) => {
      const ae = a.days_to_end < 0 ? Number.POSITIVE_INFINITY : a.days_to_end;
      const be = b.days_to_end < 0 ? Number.POSITIVE_INFINITY : b.days_to_end;
      return ae - be;
    });
  }

  // Write per-category CSV.
  const indexRows: { category: string; file: string; count: number }[] = [];
  for (const [category, arr] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const file = `${category}.csv`;
    writeFileSync(join(outDir, file), rowsToCsv(arr));
    indexRows.push({ category, file, count: arr.length });
  }

  // Index file
  const indexCsv =
    ["category", "file", "count"].join(",") +
    "\n" +
    indexRows.map((r) => [r.category, r.file, r.count].map(csvEscape).join(",")).join("\n") +
    "\n";
  writeFileSync(join(outDir, "_index.csv"), indexCsv);

  log(
    "seed-catalog",
    `wrote ${indexRows.length} categories, ${kept} kept, ${strippedShortCycle} short-cycle + ${strippedExpired} expired stripped → ${outDir}`,
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
      caption: `📚 Initial markets catalog ${dateKey}\n${indexRows.length} categories, ${kept} markets (short-cycle stripped)\nReview, /watch interesting slugs.`,
    });
    log("seed-catalog", `TG send: ${ok ? "ok" : "failed"}`);
  }
}

main().catch((e) => {
  err("seed-catalog", "fatal", e);
  process.exit(1);
});
