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
    way. Verify freshness by trade history:
    ```
    curl -s "https://data-api.polymarket.com/trades?user=<wallet>&limit=1&offset=1000" | jq 'length'
    ```
    (or fetch the wallet's earliest trade timestamp). If the wallet has
    >~1000 lifetime trades OR first trade > 90 days ago → it is NOT
    fresh. Relabel the alert from "hidden funding"/"fresh-wallet" to
    "established wallet" and DEMOTE it (only keep if notional is large,
    e.g. >$25k; otherwise drop). A genuinely fresh wallet (few trades,
    recent first activity) with hidden funding stays as a top signal.

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

=== STEP 2.6: MULTI-DAY ACCUMULATION (cross-day persistence) ===

A wallet that keeps hitting the SAME event + SAME side on multiple days
within a week is ADDING to a conviction position — a stronger signal than
a one-day spike. Detect and badge it.

State file: `state/digest_wallet_history.json`, keyed by
`<wallet>:<event_slug>:<YES|NO>` → { "days": { "<YYYY-MM-DD>": <end-of-day
cost basis that day> } }. Load it at start (empty object if absent).

For each fresh-wallet alert that SURVIVED the 2.5 filters:
1. key = `<wallet>:<event_slug>:<side>`; today = the digest date.
2. Look at history[key].days, drop any date older than 7 days.
3. priorDays = the remaining dates that are NOT today.
4. Record today: history[key].days[today] = end-of-day cost basis (from
   the 2.6 reconcile). Save the file back at the very end (after send).
5. If priorDays is non-empty → this is an ADDER:
   - badge the line `🔁 добирает Nд` where N = total distinct days
     (priorDays + today), e.g. 3д.
   - cumulative buy = the CURRENT end-of-day cost basis (it already sums
     every add — that IS the summary buy across the days). Show it as the
     main amount, and append the day-progression of cost bases when it
     fits, e.g. `($97k→$1.2M→$2.3M)`.
   - adders are high-conviction: sort them to the TOP of their theme.

Prune: after updating, drop any history key whose every day is >7d old so
the file doesn't grow unbounded.

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
