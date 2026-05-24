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
  // Service-uptime tick markets — "Will Claude go down on __ days in May?"
  // and "Will ChatGPT outage on __ days in May?". Anthropic / OpenAI
  // employees aren't betting on their own service going down (PR /
  // legal nightmare), so zero insider edge.
  "outage",
  "downtime",
  // Recurring crypto-price prediction markets — "Bitcoin price on May 21?"
  // "Ethereum above $X on May 21?" "Bitcoin ETF flows on May 20?". This
  // is Polymarket's own daily/weekly price tick game; not bettable on
  // private knowledge. Keep general crypto news / project announcements
  // (those don't carry this tag).
  "crypto-prices",
  // Stock / equity weekly-bracket ticks — "Will AAPL hit __ week of May 18?"
  // "Will TSLA hit __ week of June 1?". Pyth-finance-backed price polling.
  // Same shape as crypto-prices — pure speculation, no insider edge
  // beyond what public traders already have via order books.
  "hit-price",
  "finance-updown",
  "pyth-finance",
  // Lottery jackpots — random number generator, zero insider edge.
  "lottery",
  "powerball",
  // NYMEX / COMEX futures price-bracket ticks — "Will Crude Oil (CL) hit
  // \$200 by end of June?", "Will Gold (GC) settle at \$3800-\$4200 in June?".
  // Same shape as stock weekly ticks (hit-price/pyth-finance) — Polymarket's
  // own price polling against public commodities futures. Zero insider edge
  // beyond what's already in COMEX/NYMEX order books.
  "nymex-crude-oil-futures",
  "nymex-natural-gas-futures",
  "nymex-heating-oil-futures",
  "nymex-rbob-gasoline-futures",
  "comex-gold-futures",
  "comex-silver-futures",
  "comex-copper-futures",
  "comex-platinum-futures",
  "comex-palladium-futures",
]);

/**
 * Slug-pattern skips: noise patterns we don't tag-filter cleanly.
 *
 * Several families:
 *
 * 1) Public usage-counter ticks: "Will <X> commits hit __ by date?",
 *    "Will MrBeast hit billion views by date?", "Will <product>
 *    subscribers hit __ by date?". Anyone with grep / public API can
 *    count these, so no asymmetric private knowledge.
 *
 * 2) Earthquake count / magnitude ticks: "How many 7.0+ earthquakes
 *    by June 30?", "9.0+ earthquake before 2027?", "Magnitude 6.5 in
 *    LA before 2027?". Earthquakes are genuinely unpredictable — no
 *    public or private model has meaningful lead time on a specific
 *    quake. Aggregate counts over months/years are climate-scale RNG.
 *
 * 3) Tornado count ticks: "How many tornadoes in the US in 2026?" —
 *    annual aggregate, same shape.
 *
 * 4) Annual hurricane class: "Will any Category 4 hurricane make
 *    landfall before 2027?". 1.5-year climate-scale uncertainty;
 *    real edge only in short-window active-season tracking which is
 *    a separate slug shape we keep.
 */
const SKIP_SLUG_RES: RegExp[] = [
  /(?:^|[-])(?:commits|views|subscribers|followers|stars|downloads|mau|dau)-hit-/i,
  /(?:^|[-])how-many-.*-(?:earthquakes|tornadoes|hurricanes)\b/i,
  /(?:^|[-])\d+pt\d+-or-above-earthquake/i,
  /(?:^|[-])magnitude-\d+pt\d+-earthquake/i,
  /(?:^|[-])will-any-(?:category|cat)-?\d+-hurricane/i,
  // 5) Volcano VEI markets: "Vesuvius eruption with VEI 1 in 2026",
  //    "Etna eruption with VEI 2 in 2026", "major-volcano-eruption-vei-6-in-2026",
  //    "how-many-large-volcano-eruption-vei-4-in-2026". Dormant + low VEI =
  //    statistical noise; active + low VEI (Etna) = volcanologist-only
  //    edge that doesn't bet on Polymarket. Year-window aggregates,
  //    no insider edge.
  /(?:^|[-])eruption-(?:with-)?vei-\d+/i,
  // 6) Equity weekly price ticks: "Will AAPL hit week of May 18, 2026?"
  //    "Will RKLB hit week of May 18?". Polymarket polls weekly stock
  //    closes against bracket levels — same shape as the Pyth/finance-updown
  //    ticks we already tag-filter, but some tickers (AMZN/META/TSLA/NFLX/
  //    COIN/HOOD/RKLB/ABNB) carry only the bare 'finance' tag and slip past.
  /^will-[a-z]{2,6}-hit-week-of-/i,
  // 7) Equity monthly price-bracket: "What price will RKLB hit in May 2026?"
  //    "What price will TSLA hit in May 2026?". Polymarket monthly bracket
  //    polling. Note the 'hit-in-<month>' shape is distinct from legit
  //    'reach-by-<date>' valuation milestone markets which we keep.
  /^what-price-will-[a-z0-9-]+-hit-in-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d+/i,
  // 8) Music chart-position weekly/aggregate ticks — Billboard 200,
  //    Billboard Hot 100, Spotify weekly top artist/song, "how many
  //    spots/weeks/albums on billboard" aggregates, "first-week album
  //    sales" brackets, "which artists will have N #1 hits". Chart data
  //    is Luminate/Spotify public reporting; the people with lead-time
  //    edge (radio/label data analysts) don't bet on Polymarket. Note
  //    we deliberately don't tag-filter on `billboard`/`spotify` — those
  //    tags also sit on release-date / featuring-list markets (Ariana
  //    Grande's `petal` album) where label insiders CAN have leaks.
  /^billboard-(?:200|hot-100|\d+-artist)/i,
  /^how-many-(?:spots|weeks|albums|songs).*billboard/i,
  /-first-week-album-sales(?:-|$)/i,
  /^\d+-song-on-(?:us-)?spotify-this-week-/i,
  /^(?:top|\d+)-spotify-artist-/i,
  /^which-artists-will-have-(?:a-billboard-)?\d+-(?:hits?|songs?|albums?)/i,
  /^will-[a-z-]+-have-the-top-\d+-albums-on-the-billboard/i,
  // 9) IPO valuation / closing market-cap brackets — "SpaceX IPO closing
  //    market cap above ___?" "What will SpaceX's IPO valuation be?"
  //    "How much will SpaceX raise in its IPO?". Same shape as equity
  //    weekly/monthly price brackets (rule 6/7): bracket polling against
  //    a future public number. The bankers who actually price the book
  //    don't bet on Polymarket; everyone else is guessing. Deliberately
  //    keeps insider-edge IPO markets: timing (`in-which-month-will-X-ipo`,
  //    `X-ipo-by`), lead bank, exchange choice, corporate-vehicle structure
  //    (Ackman SPAR), and date races between companies.
  /-ipo-closing-market-cap(?:-|$)/i,
  /^what-will-[a-z-]+s?-ipo-valuation-be/i,
  /^how-much-will-[a-z-]+-raise-in-its-ipo/i,
  // 10) Daily equity close-above/below brackets — "aapl-close-above-on-may-20-2026",
  //     "tsla-close-below-on-may-21-2026". Per-day binary on a public closing
  //     price; daily tick of the weekly bracket family from rule 6. Tagged
  //     `daily|equities|stocks|hide-from-new` but we slug-filter to avoid
  //     killing genuine equity-news events that also carry `equities`/`stocks`.
  /^[a-z]{2,6}-close-(?:above|below)-on-[a-z]+-\d+/i,
];

export function isSkippedSlug(slug: string): boolean {
  return SKIP_SLUG_RES.some((r) => r.test(slug));
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Returns true if the event should be skipped. Combines tag-based skip
 * (sports family + recurring-tick families + lottery) and slug-pattern
 * skip (public usage-counter markets).
 *
 * Signature kept as `(tags)` for backward compat; new callers can pass
 * the slug too via the optional second arg.
 */
export function isSkippedCategoryEvent(tags?: PolyTag[], slug?: string): boolean {
  if (tags) {
    for (const t of tags) {
      const s = slugify(t.label || "");
      if (s && SKIP_TAG_SLUGS.has(s)) return true;
    }
  }
  if (slug && isSkippedSlug(slug)) return true;
  return false;
}

export function skippedTagSlugs(): string[] {
  return [...SKIP_TAG_SLUGS].sort();
}
