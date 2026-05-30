You are running the daily alerts-digest routine for polymarket-watch.
Working directory: /root/polymarket-watch (cwd already set by cron).
Today's date: read from `date -u +%Y-%m-%d`.

TASK: build a human-readable summary of every signal alert fired across
the pipeline in the last 24h, then post to the daily-digest TG thread.

=== STEP 1: gather alerts ===

Pull 24h of alert log lines (cluster + cross-market + fresh-wallet):

```
pm2 logs pmw-trade-enricher --nostream --lines 30000 2>&1 \
  | grep -E '\[(cluster|cross-market|fresh-wallet)\] alert' > /tmp/alerts_te.log
```

Smart-money cross-link (xlink) is intentionally disabled — skip.
Volume-spike is NOT in this digest — it has its own on-demand command
`/spikes` (24h themed spike digest). Do not gather or list spikes here.

Parse the ISO timestamp at the start of each line, drop anything older
than 24h. If total fired < 5 → send "тихий день — N сигналов" + bullets
and exit.

=== STEP 2: enrich each alert ===

Per signal-type, extract from log line:
- cluster:       `alert: <event_slug> cluster=<N>`
- cross-market:  `alert: <wallet> <N> markets, $<notional>`
  (append `→ /xmarket <wallet>` to each cross-market line so the user can
  drill into the wallet's correlated markets + positions; the inline
  buttons are reserved for clusters, this is the cross-market equivalent)
- fresh-wallet:  `alert: <wallet> on event <event_slug> net=$<N> score=<S> path=<A|B>`
                 (path A = score-based, B = hidden-funding)

CLUSTER RE-REVIEW (mandatory — the `cluster=N` count in the log is the
detection-time count and is STALE by morning). For each UNIQUE cluster
event_slug, re-run the reviewer, which re-applies the same-side gate +
funder-fanout neutralization + end-of-day position prune (drops members
who sold out / now hold < $100):
```
cd /root/polymarket-watch && npx tsx src/cluster-cli.ts <event_slug>
```
- If the output contains "no qualifying" or "none survive" → the cluster
  has DECAYED (over-linked or everyone exited) → DROP it from the digest
  entirely. Do not list it.
- Otherwise parse the header line(s) `*Cluster k* — M wallets · *SIDE* ·
  $X held · pair P (...)` for the CURRENT member count / side / $ held —
  use THOSE numbers in the digest, not the stale log count. A slug may
  yield multiple sub-clusters; take the largest.
This is throttled (it queries positions per member); expect a few seconds
per cluster event. Only re-review cluster events, not every alert.

CROSS-MARKET RE-REVIEW (mandatory — the log line carries NO market slugs,
only `<wallet> <N> markets, $<notional>`). DO NOT title the line from the
wallet's positions: a wallet trades markets OUTSIDE its keyword cluster
(and outside our watchlist), so its top overall position is usually the
WRONG market. That guess mislabelled an Iran-uranium cluster as "Russia
Kostyantynivka / Ukraine" and surfaced a "France win World Cup" title not
in the cluster at all. Instead re-derive the ACTUAL cluster per unique
cross-market wallet (re-runs keyword correlation + EOD position prune):
```
cd /root/polymarket-watch && npx tsx src/xmarket-cli.ts <wallet>
```
- If the output contains "decayed" or "no correlated-market cluster" →
  the cluster is gone (markets sold / below threshold) → DROP it from the
  digest. Do not list it. Count it as a dropped cross-market.
- Otherwise parse the header `*N markets · *SIDE* R% · $X*` for the CURRENT
  count / side / notional, and take the FIRST market bullet (rows are
  sorted by held $ desc) as the cluster's TOP market. Use THAT market's
  slug/title for the line text AND for theme grouping. NEVER title or
  theme a cross-market line from a market not in this report.
Throttled (one positions fetch per wallet); only re-review cross-market
wallets, not every alert.

Resolve event_slug → human title via Gamma (cache per unique slug, 200ms
throttle):
```
curl -s "https://gamma-api.polymarket.com/events?slug=<slug>" \
  | jq -r '.[0].title // empty'
```

=== STEP 2.5: QUALITY FILTERS (drop noise before grouping) ===

Apply these to every alert. They encode hard-won feedback — a raw alert
list is mostly noise without them.

(a) EXTREME-PRICE — drop any alert whose position was taken at >=0.95
    (near-certain bet, no edge). NOTE: only the HIGH end — a cheap buy
    (<=0.05) is a long-shot/contrarian position that CAN be informative,
    keep it. The live signals now pre-filter >=0.95, but older log lines
    may predate the fix, so enforce here too. Read the price from the
    fresh-wallet alert ("@0.92"); if unavailable, fetch last trade price.

(b) POSITION RECONCILE — the alerted notional is a SNAPSHOT at alert
    time (24h-net at that instant). By end of day the wallet may have
    BOUGHT MORE (the real position is far bigger) or SOLD OUT. The
    digest must show the ACTUAL end-of-day position, not the stale
    alert number. (Real case 2026-05-29: alert said $97.6k but the
    wallet accumulated to $2.3M on us-x-iran NO through the day.)

    Step 1 — get the event's conditionId(s). You already fetch the event
    from Gamma for the title; grab its market conditionIds:
    ```
    curl -s "https://gamma-api.polymarket.com/events?slug=<slug>" \
      | jq -r '.[0].markets[].conditionId'
    ```

    Step 2 — fetch the wallet's live positions and sum the COST BASIS
    across the matching conditionId(s) AND the alerted side (Yes/No):
    ```
    curl -s "https://data-api.polymarket.com/positions?user=<wallet>" \
      | jq --arg side "<NO|YES>" '
        [ .[] | select(.conditionId=="<cond>")
              | select((.outcome|ascii_upcase)==$side)
              | (.initialValue // (.size*.avgPrice)) ] | add // 0'
    ```
    (initialValue = USD cost basis = what they actually put in; fall back
    to size×avgPrice. Sum across all event sub-markets if multi-market.)

    Step 3 — REPLACE the displayed amount with this end-of-day cost basis.
    This is the number that goes in the digest line, NOT the alert-time
    notional. A wallet that scaled $97.6k → $2.3M now reads $2.3M.

    Step 4 — drop if effectively exited: if the end-of-day cost basis is
    < 30% of the alert-time notional (sold most of it) OR < $1k absolute
    → DROP (they've left, not actionable). Count drops for the footer.

    Annotate big movers: if end-of-day >= 2× the alert-time notional,
    prefix the line with "📈 scaled in" so the accumulation is visible.

(c) NON-FRESH — the "hidden funding" path fires on wallets with no $1k+
    USDC inflow on record, but many are seasoned traders funded another
    way (CEX / pUSD / other rail). The live signal now pre-filters these
    (established guard shipped 2026-05-30: ≥1000 lifetime trades OR first
    trade >90d → skip), so few should reach here — but log lines fired
    before that still surface for 24h, so enforce it. Verify by trade
    history:
    ```
    curl -s "https://data-api.polymarket.com/trades?user=<wallet>&limit=1000" \
      | jq 'if type=="array" then {n:length, oldest_age_d:(((now - (.[-1].timestamp))/86400)|floor)} else {n:0} end'
    ```
    If `n >= 1000` (≥1000 lifetime trades) OR `oldest_age_d > 90` (first
    trade >90 days ago) → the wallet is NOT fresh → DROP the alert (count
    it as `est-wallet` in the footer). No "keep if >$25k" exception — an
    established / high-frequency wallet's position size is not a fresh-
    insider signal (the 0xb100…6461 case: 88k predictions, $28k, dropped).
    A genuinely fresh wallet (few trades, recent first activity) with
    hidden funding stays as a top signal.

(d) HIGH-FREQUENCY (for the repeating-participants section only) — a
    wallet that appears across many signals because it trades 1000s of
    times/day is a market-maker/bot, not a coordinator. Count last-24h
    trades:
    ```
    curl -s "https://data-api.polymarket.com/trades?user=<wallet>&limit=1000" \
      | jq '[.[] | select(.timestamp > (now - 86400))] | length'
    ```
    If >500 trades in 24h → EXCLUDE from "🔁 Повторяющиеся участники"
    (its cross-signal presence is mechanical, not meaningful). Such a
    wallet may still appear in a theme section if its single position is
    notable, but never as a "repeating participant".

(e) CROSS-MARKET MARKET-MAKER — drop any **cross-market (🔀)** alert whose
    wallet is a high-frequency trader: its 3+ keyword-correlated markets
    are mechanical coincidence, not a coordinated thematic bet. The live
    signal now pre-filters these (>3000 lifetime trades), but log lines
    fired before that shipped 2026-05-30 still surface here for 24h, so
    enforce it. Probe lifetime depth (data-api caps offset at 3000):
    ```
    curl -s "https://data-api.polymarket.com/trades?user=<wallet>&limit=1&offset=3000" \
      | jq 'if type=="array" then length else 0 end'
    ```
    If ≥1 (a trade exists at offset 3000 → >3000 lifetime trades) → DROP
    the cross-market alert. Count drops for the footer. Applies to
    cross-market only — fresh-wallet/cluster keep their own rules.

=== STEP 2.6: MULTI-DAY ACCUMULATION (cross-day persistence) ===

A wallet that keeps hitting the SAME event + SAME side on multiple days
within a week is ADDING to a conviction position — a stronger signal than
a one-day spike. Detect and badge it.

**Do NOT do this bookkeeping by hand.** The cross-day state (load the
history file, build the `<wallet>:<event_slug>:<SIDE>` key, diff prior
days, record today, prune, save) is owned by a deterministic CLI —
`src/digest-adders.ts` — so it can't break when a key is mis-cased or a
save is forgotten. Your only job is to feed it each survivor's end-of-day
cost basis (from the 2.5b reconcile) and read back the badges.

1. Collect every fresh-wallet alert that SURVIVED the 2.5 filters into a
   JSON array of `{wallet, event_slug, side, cost_basis}` where
   `cost_basis` is the end-of-day cost basis from 2.5b and `side` is
   `YES`/`NO`. Pipe it to the CLI with today's date:
   ```
   echo '{"date":"'"$(date -u +%Y-%m-%d)"'","alerts":[ ...the array... ]}' \
     | npx tsx src/digest-adders.ts
   ```
   (If there are zero surviving fresh-wallet alerts, skip the call.)
2. The CLI prints `{"adders":[ {wallet, event_slug, side, cost_basis,
   is_adder, days, progression}, ... ]}` and has ALREADY updated +
   pruned `state/digest_wallet_history.json` — you do NOT touch that file.
3. For each returned alert with `is_adder: true`:
   - badge the line `🔁 добирает Nд` where N = `days`.
   - main amount = `cost_basis` (current end-of-day basis = the summary
     buy across all the adds). Append the `progression` array as a
     day-by-day trail when it fits, e.g. `($97k→$1.2M→$2.3M)`.
   - adders are high-conviction: sort them to the TOP of their theme.
   Alerts with `is_adder: false` render as normal single-day lines.

The CLI matches keys case-insensitively (wallet + side), keeps a rolling
7-day window, is idempotent on a same-day re-run, and prunes stale keys —
nothing for you to manage. Match alerts back to the CLI output by
`(wallet, event_slug, side)`.

Cluster events by inferred topic from titles + slugs. Heuristics:
- iran|israel|hezbollah|hormuz|gaza         → 🇮🇷 Iran / Middle East
- ukraine|russia|putin|zelensky             → 🇺🇦 Ukraine / Russia
- primary|nominee|midterm|governor|senate|congress|election → 🗳 Politics
- token-launch|airdrop|ipo-by|-fdv-above-   → 🚀 Crypto launches
- bitcoin|ethereum|btc-|eth-|stablecoin     → ₿ Crypto markets
- aapl|msft|nvda|googl|tsla|amzn|meta|pltr  → 📈 Equity
- trump-|biden-|powell-|warsh-              → 🇺🇸 US figures
- everything else                            → 📦 Прочее

Within a theme, sort by notional desc (where comparable), else by signal
weight cluster > fresh-wallet > cross-market.

=== STEP 4: cross-reference wallets ===

A wallet appearing in 2+ different signal types in the 24h window is
high-signal — UNLESS it's a high-frequency market-maker (filter 2.5d:
>500 trades/24h → exclude from this section entirely). Build a "🔁
Повторяющиеся участники" section listing the surviving wallets, each with
which signals + events they hit. If all candidates were filtered as
high-frequency, omit the section.

=== STEP 5: format message ===

Markdown V1 (legacy Telegram). Escape user data via \\_ \\* \\[ \\` in
titles. Template:

```
📰 *Дайджест сигналов · 24h*
_<YYYY-MM-DD> 09:00 Europe/Berlin_

*🇮🇷 Iran / Middle East* (12)
• 🔥 [Iran ceasefire continues through](https://polymarket.com/event/iran-...) — coord-cluster *8 wallets* · *NO* $124k held   ← post-review count/held from cluster-cli, NOT the stale log "cluster=37"
• 🚨 [Israel-Iran peace deal by](https://polymarket.com/event/israel-...) — fresh-wallet [0xab12…cd34](https://polygonscan.com/address/0xfull) *NO* $16k (hidden funding, score 1)
• 🚨 📈 scaled in [US x Iran peace deal](https://polymarket.com/event/us-x-iran-...) — fresh-wallet [0x0f02…5bfb](https://polygonscan.com/address/0xfull) *NO* $2.3M (hidden funding, score 1)   ← end-of-day cost basis, not the $97.6k alert snapshot
• 🚨 🔁 добирает 3д [Iran regime falls](https://polymarket.com/event/iran-...) — fresh-wallet [0x9a01…77bc](https://polygonscan.com/address/0xfull) *YES* $840k ($120k→$410k→$840k) · via coinbase   ← same wallet+side hit 3 days running this week
• ...

*🗳 Politics* (5)
• ...

*🚀 Crypto launches* (3)
• ...

*🔁 Повторяющиеся участники* (3)
• [0xab12…cd34](https://polygonscan.com/address/0xfull) — fresh-wallet (iran-leader-2026) + cross-market (3 events: ...)
• ...

*Всего:* freshwallet=N · cluster=M · xmarket=K
_отсеяно: exited N · extreme-price N · est-wallet N · decayed-clusters N_
_суммы fresh-wallet = позиция на конец дня (cost basis), не снапшот алерта_
```

`cluster=M` in the total is the count of clusters that SURVIVED re-review
(not the raw alert count); note dropped ones as `decayed-clusters N`.

For cluster (🔥) lines: do NOT put a `/cluster` text command. Instead,
collect every SURVIVING cluster event_slug you list and attach an INLINE
KEYBOARD to the message (STEP 6) — one tappable button per cluster that
fires the report. Decayed/dropped clusters get neither a line nor a
button. The message body shows the post-review cluster line; the button
does the live drill-in.

Constraints:
- Wallets ALWAYS as `[0xab12…cd34](polygonscan-url)` short clickable form
- Event titles as `[title](polymarket-event-url)` clickable
- Money format: `$1.2k` / `$1.2M` / `$345`
- Side bold UPPERCASE: `*YES*` / `*NO*`
- Themes with empty content — пропускать
- Theme >8 alerts: top-5 by notional + `_и ещё N_`

=== STEP 6: send to TG ===

Source env from .env:
```
set -a; source .env; set +a
```

Build an inline keyboard with one button per listed cluster so the user
can tap to see its member wallets. tg-control handles callback_data of
shape `c:<event_slug>` → posts the cluster report into the thread.

```
# JSON: rows of up to 2 buttons. Label = short readable cluster name
# (truncate to ~24 chars). callback_data = "c:<event_slug>".
# IMPORTANT: callback_data max 64 bytes — if "c:"+slug > 64, skip that
# button (rare; very long slugs).
REPLY_MARKUP='{"inline_keyboard":[
  [{"text":"🔗 Iran ceasefire","callback_data":"c:iran-ceasefire-continues-through"}],
  [{"text":"🔗 Russia x Ukraine","callback_data":"c:russia-x-ukraine-ceasefire-agreement-by"}]
]}'
```

Send via Bot API (attach reply_markup only if ≥1 cluster button exists):
```
curl -s "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
  -d chat_id="$TG_CHAT_MAIN" \
  -d message_thread_id="$TG_THREAD_DIGEST" \
  -d parse_mode=Markdown \
  -d disable_web_page_preview=true \
  --data-urlencode text="$MESSAGE" \
  --data-urlencode reply_markup="$REPLY_MARKUP"
```

Check `ok:true` in response. If `can't parse entities` — retry once
without parse_mode (раз escape failure не должен убить дайджест). If
the message is too long for a single send (>4096 chars) OR has >~30
cluster buttons, split: send the themed body first (no markup), then a
short follow-up "🔗 Кластеры — тапни чтобы раскрыть" carrying the
inline keyboard.

=== STEP 7: dedup ===

Before sending, check `state/last_alerts_digest_ts.txt`. If <20h since
last write, log "already ran today, skipping" and exit 0 (covers re-runs
/ accidental double-trigger). After successful send, write current epoch
to that file.

=== Done ===

Don't ask for confirmation — execute autonomously. If anomalous (zero
alerts in 24h AND zero in 48h), send a warning to $TG_THREAD_ERRORS
instead of digest thread.

Working dir is already /root/polymarket-watch; all paths above are
relative to it.
