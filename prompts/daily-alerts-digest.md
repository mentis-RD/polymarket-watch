You are running the daily alerts-digest routine for polymarket-watch.
Working directory: /root/polymarket-watch (cwd already set by cron).
Today's date: read from `date -u +%Y-%m-%d`.

TASK: build a human-readable summary of every signal alert fired across
the pipeline in the last 24h, then post to the daily-digest TG thread.

=== STEP 1: gather alerts ===

The 5 signal types live across 2 processes. Pull 24h of alert log lines:

```
pm2 logs pmw-trade-enricher --nostream --lines 30000 2>&1 \
  | grep -E '\[(cluster|cross-market|fresh-wallet)\] alert' > /tmp/alerts_te.log
pm2 logs pmw-market-monitor --nostream --lines 30000 2>&1 \
  | grep '\[volume-spike\] alert' > /tmp/alerts_mm.log
```

Smart-money cross-link (xlink) is intentionally disabled — skip.

Parse the ISO timestamp at the start of each line, drop anything older
than 24h. If total fired < 5 → send "тихий день — N сигналов" + bullets
and exit.

=== STEP 2: enrich each alert ===

Per signal-type, extract from log line:
- cluster:       `alert: <event_slug> cluster=<N>`
- cross-market:  `alert: <wallet> <N> markets, $<notional>`
- fresh-wallet:  `alert: <wallet> on event <event_slug> net=$<N> score=<S> path=<A|B>`
                 (path A = score-based, B = hidden-funding)
- volume-spike:  `alert: <slug> <multiplier>x baseline`

Resolve event_slug → human title via Gamma (cache per unique slug, 200ms
throttle):
```
curl -s "https://gamma-api.polymarket.com/events?slug=<slug>" \
  | jq -r '.[0].title // empty'
```

=== STEP 2.5: QUALITY FILTERS (drop noise before grouping) ===

Apply these to every alert. They encode hard-won feedback — a raw alert
list is mostly noise without them.

(a) EXTREME-PRICE — drop any alert whose position was taken at >=0.95 or
    <=0.05 (near-certain bet / lottery ticket, no edge). The live signals
    now pre-filter this, but older log lines may predate the fix, so
    enforce here too. For fresh-wallet you can read the price from the
    live alert format ("@0.94"); if unavailable, fetch last trade price
    from data-api.

(b) FAST-SELL — for each fresh-wallet alert, check whether the wallet
    still holds the flagged position at digest time. Query current
    position:
    ```
    curl -s "https://data-api.polymarket.com/positions?user=<wallet>" \
      | jq '[.[] | select(.conditionId=="<cond>")] | .[0].size // 0'
    ```
    If current size < 50% of the alerted notional/size → wallet has
    sold most of the position the alert was about → DROP it (a signal
    they've already exited is not actionable). Annotate dropped count in
    a footer if you like, but do not list them.

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

=== STEP 3: group by THEME ===

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
weight cluster > fresh-wallet > cross-market > volume-spike.

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
• 🔥 [Iran ceasefire continues through](https://polymarket.com/event/iran-...) — coord-cluster 37 wallets · *NO* $124k
• 🚨 [Israel-Iran peace deal by](https://polymarket.com/event/israel-...) — fresh-wallet [0xab12…cd34](https://polygonscan.com/address/0xfull) *NO* $16k (hidden funding, score 1)
• 📈 [Strait of Hormuz traffic returns by end of May](https://polymarket.com/event/strait-...) — vol-spike 12.3× · 78% *NO*
• ...

*🗳 Politics* (5)
• ...

*🚀 Crypto launches* (3)
• ...

*🔁 Повторяющиеся участники* (3)
• [0xab12…cd34](https://polygonscan.com/address/0xfull) — fresh-wallet (iran-leader-2026) + cross-market (3 events: ...)
• ...

*Всего:* freshwallet=N · cluster=M · xmarket=K · volspike=L
_отсеяно: fast-sell N · extreme-price N · est-wallet N_
```

For cluster (🔥) lines: do NOT put a `/cluster` text command. Instead,
collect every cluster event_slug you list and attach an INLINE KEYBOARD
to the message (STEP 6) — one tappable button per cluster that fires the
report. The message body just shows the cluster line; the button below
does the drill-in.

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
