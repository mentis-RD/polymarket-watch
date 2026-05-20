import type { PolyTag } from "./polymarket-api.js";

/**
 * Categories we deliberately exclude from indexing / catalogs / digest.
 *
 * Sports + esports + combat — Polymarket activity in these is dominated by
 * line-shopping arbitrage and casual punters. The only insider-style edge is
 * match-fixing, and that's already a solved problem for traditional books +
 * UMA challenges. Excluding them lets the catalog and digest focus on:
 *   politics, geopolitics, business / IPOs, crypto, tech / AI, science,
 *   economy, weather, culture, etc.
 *
 * Match is done on ANY tag of an event (lowercased + slugged). One sports
 * tag anywhere → event is skipped, regardless of primary-category routing.
 */
const SKIP_TAG_SLUGS: Set<string> = new Set([
  // Umbrella tags
  "sports",
  "esports",
  // Team sports
  "soccer",
  "football",
  "basketball",
  "baseball",
  "hockey",
  "ice-hockey",
  "cricket",
  "rugby",
  // Leagues + competitions
  "nfl",
  "nba",
  "mlb",
  "nhl",
  "wnba",
  "cba",
  "mls",
  "premier-league",
  "la-liga",
  "bundesliga",
  "bundesliga-2",
  "serie-a",
  "ligue-1",
  "uefa-champions-league",
  "uefa-europa-league",
  "uefa-conference-league",
  "uel",
  "uecl",
  "europa-league",
  "euroleague",
  "uefa-women-s-champions-league",
  "fifa-world-cup",
  "world-cup",
  "copa-america",
  "afc",
  "afcon",
  "afc-asian-cup",
  "concacaf",
  "nations-league",
  "k-league",
  "j-league",
  "j1-league",
  "japan-j2-league",
  "australian-a-league",
  "brazil",
  "brazil-s-rie-b",
  "argentina",
  "peru-liga-1",
  "norway-eliteserien",
  "morocco-botola-pro",
  "kbo",
  "dfb-pokal",
  "coupe-de-france",
  "fa-cup",
  // Combat
  "ufc",
  "mma",
  "boxing",
  "kickboxing",
  "combats",
  // Tennis
  "tennis",
  "wta",
  "atp",
  "wimbledon",
  "us-open",
  "french-open",
  "australian-open",
  "roland-garros",
  // Motorsport
  "formula-1",
  "f1",
  "nascar",
  "motogp",
  "indycar",
  // Golf
  "golf",
  "pga",
  "lpga",
  "masters",
  "open-championship",
  // Misc / niche
  "american-league",
  "national-championship",
  "qualification",
  "postseason",
  "regular-season",
  "mvp",
  "ecf-mvp",
  "platinum-glove",
  "nba-draft",
  "2026-nhl-draft-1st-overall-pick-349",
  "iem-cologne",
  "league-of-legends",
  "cs2",
  "valorant",
  "dota-2",
  "starcraft",
  // Daily auto-recurring weather ticks — markets like
  // `highest-temperature-in-cape-town-on-may-22-2026` with 10+ temperature
  // bracket sub-markets. Tag set always includes daily-temperature plus
  // highest-temperature OR lowest-temperature. Pure tick noise, zero
  // insider edge (we keep real-weather events like hurricanes / earthquakes
  // / disease outbreaks since those have actual subject-matter informants).
  "daily-temperature",
  "highest-temperature",
  "lowest-temperature",
]);

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Returns true if the event has any tag we want to skip (sports family).
 * Pass the raw tags array from a PolyMarket / PolyEvent.
 */
export function isSkippedCategoryEvent(tags?: PolyTag[]): boolean {
  if (!tags) return false;
  for (const t of tags) {
    const s = slugify(t.label || "");
    if (s && SKIP_TAG_SLUGS.has(s)) return true;
  }
  return false;
}

export function skippedTagSlugs(): string[] {
  return [...SKIP_TAG_SLUGS].sort();
}
