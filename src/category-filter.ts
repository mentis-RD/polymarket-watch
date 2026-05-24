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
  // Macro release brackets — CPI / inflation per country, GDP per country,
  // unemployment polls, Parcl Labs median home values. Each tag is a clean
  // umbrella for auto-poll brackets on a single public statistical release;
  // BLS/BEA/Eurostat/INEGI/etc don't bet on Polymarket and consensus is
  // already-priced by macro desks. Note `global-rates` is NOT here despite
  // similar logic — that tag also sits on personnel events like Lagarde-
  // out-as-ECB-president; we slug-filter the CB decision shape instead
  // (see rule 28) to spare those.
  "cpi",
  "gdp",
  "parcl",
  "unemployment",
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
  // 11) Daily ETF flow brackets — "bitcoin-etf-flows-on-may-20",
  //     "ethereum-etf-flows-on-may-21". Per-day bracket on a public flows
  //     number; same family as rule 10 (equity close brackets). Prime-broker
  //     flow data leaks early but those desks don't bet on Polymarket.
  /^(?:bitcoin|ethereum|btc|eth)-etf-flows-on-/i,
  // 12) Weekly equity close brackets — sibling shapes of rule 6/10. Event
  //     slugs come in two flavors that the existing rules miss:
  //       `<ticker>-week-<month>-<day>-<year>`  ("aapl-week-may-22-2026",
  //         sub-markets like will-aapl-close-between-N-and-M-week-...)
  //       `<ticker>-above-on-<month>-<day>-<year>`  ("aapl-above-on-may-22-2026",
  //         sub-markets like aapl-above-N-on-...)
  //     Both poll Friday close against bracket levels — same noise shape as
  //     rule 6 (will-X-hit-week-of-...) and rule 10 (X-close-above-on-...).
  /^[a-z]{2,6}-(?:week|above-on)-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d+/i,
  // 13) Quarterly earnings EPS brackets — "<ticker>-quarterly-earnings-
  //     [non]gaap-eps-<date>-<strike>", e.g. nvda-quarterly-earnings-nongaap-
  //     eps-05-20-2026-1pt77. Polymarket auto-creates these for the entire
  //     Street-covered universe (incl. BJ's Wholesale / Williams-Sonoma /
  //     Frontline) — same bracket-on-public-number shape as price brackets.
  //     Yes, management knows EPS before release, but slug is identical for
  //     NVDA and for obscure tickers and we can't pattern-discriminate, and
  //     earnings beat/miss bets are dominated by Wall Street desks not by
  //     Polymarket wallets.
  /^[a-z]{2,6}-quarterly-earnings-(?:non)?gaap-eps-\d/i,
  // 14) Private-company NPM valuation hit-by-date brackets — "will-anthropics-
  //     valuation-hit-by-june-30", sub-markets like will-anthropics-valuation-
  //     hit-high-925b-by-june-30. Polled against the public Nasdaq Private
  //     Market (NPM) Price; same bracket shape as IPO closing market cap
  //     (rule 9), just for ongoing private rounds. Polymarket auto-creates
  //     for the entire private-tech universe.
  /^will-[a-z][a-z-]+-valuation-hit-by-/i,
  // 15) Cross-company "higher valuation on <date>" comparisons — "anthropic-
  //     vs-openai-higher-valuation-on-june-30", "anthropic-openai-vs-meta-...".
  //     Same NPM-bracket shape as rule 14, just paired.
  /-vs-[a-z][a-z-]+-higher-valuation-on-/i,
  // 16) "Nth largest private company end-of-<month>" rankings — auto-poll
  //     across the NPM universe, same data source as rule 14.
  /^(?:\d+(?:st|nd|rd|th)-)?largest-private-company-end-of-/i,
  // 17) Index hit-by-month brackets — "spx-hit-jun-2026" with sub-markets
  //     "spx-hit-7450-high-jun-2026-..." and "will-sp-500-spx-hit-N-high-in-
  //     june". Monthly index target polling, same shape as equity weekly
  //     brackets (rule 6/12) one tier up. Future-proofed to sibling US
  //     indices (NDX/Russell/DJI) since Polymarket runs the same poll for
  //     each.
  /^(?:spx|sp-?500|ndx|nasdaq|russell-?2000|rut|dji|dow)-hit-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{4}/i,
  // 18) Quarterly metric brackets — "will-take-two-q4-net-bookings-be-above",
  //     "will-workday-q1-total-subscription-revenue-backlog-be-above",
  //     "will-broadcom-q2-ai-revenue-be-above". Per-segment quarterly metric
  //     polling against street estimates; same shape as rule 13 (EPS) but
  //     for revenue / ARR / bookings / backlog subsets that management knows
  //     but Polymarket auto-creates uniformly across the Street universe.
  /^will-[a-z][a-z-]+-q[1-4]-[a-z0-9-]+-be-(?:above|below)/i,
  // 19) Commodity hit-by-date brackets — "will-gas-hit-by-end-of-may".
  //     Same shape as the NYMEX/COMEX tag-filtered family in SKIP_TAG_SLUGS
  //     but slug-anchored to cover the few that ship without proper futures
  //     tagging. Future-proofed to common commodity siblings.
  /^will-(?:gas|gasoline|crude|brent|wti|natgas|natural-gas|heating-oil|diesel|propane|jet-fuel)-hit-(?:by-|on-|in-)/i,
  // 20) IPO date-prediction brackets — "spacex-ipo-by", "openai-ipo-by"
  //     with sub-markets like will-spacex-ipo-by-march-31-2026. Rule 9
  //     previously KEPT these on the theory that bankers know the schedule
  //     — user has since clarified that even date-leakable markets are
  //     noise on Polymarket because actual insiders don't bet here. Only
  //     reverses the `-ipo-by` shape; `lead-bank-in-X-ipo`, `which-exchange-
  //     will-X-list-on`, `in-which-month-will-X-ipo` left intact pending
  //     explicit flag.
  /^[a-z][a-z-]+-ipo-by$/i,
  // 21) Commodity hit-by-date brackets in `what-will-X-hit` shape —
  //     "what-will-gold-gc-hit-by-end-of-december". Polled against
  //     CME settlement prices. Some carry tag typos (`comex-gold-features`
  //     vs `-futures`) that bypass our SKIP_TAG_SLUGS tag-filter, so we
  //     slug-anchor here too. Companion to rule 19 (`will-gas-hit-by-...`).
  /^what-will-(?:gold|silver|copper|platinum|palladium|crude|wti|brent|natgas|natural-gas|heating-oil|gasoline|gas|rbob|diesel|propane|jet-fuel|corn|wheat|soybeans|cocoa|coffee|sugar|cotton)(?:-[a-z]{2,4})?-hit-(?:by-|on-|in-)/i,
  // 22) Interest rate / treasury yield / Fed rate brackets — "will-the-
  //     30-year-mortgage-rate-hit-in-2026", "how-high-will-10-year-
  //     treasury-yield-go-before-2027", "fed-rate-hike-in-2026", "fed-rate-
  //     cut-by-629", "fed-rate-hike-by". Freddie Mac PMMS / Treasury market
  //     / FOMC are all public, well-modeled by macro desks — bracket-on-
  //     public-number with no Polymarket-side insider edge.
  /^will-the-\d+-year-(?:mortgage-rate|treasury-yield|fixed-rate-mortgage)-hit-/i,
  /^how-high-will-\d+-year-(?:mortgage-rate|treasury-yield)-go/i,
  /^fed-rate-(?:hike|cut)-(?:by|in)(?:-|$)/i,
  // 23) FX pair brackets — "will-eurusd-hit-in-2026", usdjpy/gbpusd/usdkrw/
  //     usdcad/etc. Investing.com hourly candle data, auto-poll across the
  //     major FX matrix. Enum'd to actual currency codes (not generic
  //     6-letter regex) to avoid matching random non-FX tokens.
  /^will-(?:eur|usd|gbp|jpy|chf|cad|aud|nzd|cny|krw|try|mxn|brl|inr|zar|sgd|hkd|thb|cnh|sek|nok|dkk|pln|huf|czk|rub|ils|aed|sar|twd|myr|idr|php|vnd){2}-hit-/i,
  // 24) "X-valued-higher-than-Y" valuation comparison — variant of rule 15
  //     (which catches the `-vs-X-higher-valuation-on-` shape). Same NPM-
  //     bracket cross-company comparison, different slug phrasing.
  /-valued-higher-than-/i,
  // 25) Index monthly close brackets — "spx-close-dec-2026" with sub-markets
  //     spx-close-7000-7500-dec-2026. Companion to rule 17 (`spx-hit-...`)
  //     which catches the "any-time during month" shape; this catches the
  //     "month-end close" shape.
  /^(?:spx|sp-?500|ndx|nasdaq|russell-?2000|rut|dji|dow)-close-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{4}/i,
  // 26) Annual capex brackets — "amazon-2026-capex-above". Same shape as
  //     rule 18 (quarterly metric brackets) but annual aggregate. Auto-poll
  //     across the hyperscaler / mega-cap capex universe.
  /^[a-z][a-z-]+-\d{4}-capex-(?:above|below)/i,
  // 27) Parcl median home value brackets — backup for the `parcl` tag-skip.
  //     "what-will-the-median-home-value-in-miami-be-on-may-31". Per-city
  //     polling against Parcl Labs Sales Price index.
  /^what-will-the-median-home-value-in-/i,
  // 28) Central bank decision brackets — auto-poll across the global CB
  //     calendar (BoE/BoR/BoJ/BoC/BoK/ECB/PBoC/RBA/RBNZ/Banxico/SARB/BoI/
  //     Bank of Israel/Brazil/Colombia, etc.). Decisions are heavily
  //     public-modeled (Fed Funds futures, OIS curves, Bloomberg WIRP);
  //     leaks are press-side (FT/Reuters/Nikkei), not Polymarket-side.
  //     Slug-anchored (not tag-skip on `global-rates`) so personnel events
  //     like `christine-lagarde-out-as-ecb-president-in-2026` that share
  //     the tag survive.
  /-decision-in-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /^[a-z][a-z-]+-rate-(?:hike|cut|change)-in-(?:\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /-interest-rates?-[a-z]+-\d{4}/i,
  // 29) Exotic-currency FX brackets — "will-usd-hit-iranian-rials-by-may-31"
  //     and similar against non-major currencies outside rule 23's ISO-code
  //     enum (Iran rials, Venezuela bolivars, Argentina pesos, etc.).
  /^will-(?:usd|eur|gbp|jpy)-(?:hit|reach|fall-to|drop-to|rise-to)-[a-z0-9-]+-(?:rials?|peso|pesos|lira|naira|won|yen|ruble|hryvnia|riyal|dinar|dirham|dong|rupiah|tenge|som|bolivar|kwacha|shilling|colones|guarani|sol|escudo|kip|kyat|cedi|tugrik|afghani|taka)-(?:by|on|in)-/i,
  // 30) Commodity production brackets — "will-venezuelan-crude-oil-production-
  //     reach-barrels-per-day-in-2026". OPEC/IEA monthly reports, public.
  /-(?:crude-oil|natural-gas|coal|copper|iron-ore|lithium|nickel)-production-(?:reach|hit|be-above|be-below)-/i,
  // 31) Trade deficit/surplus brackets — "us-trade-deficit-in-2026". BEA /
  //     national-statistics-agency release, bracket on public number.
  /^(?:us|china|eurozone|uk|japan|germany|france|italy|spain|canada|mexico|brazil|india|south-korea|australia|russia|south-africa)-trade-(?:deficit|surplus|balance)-in-\d{4}/i,
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
