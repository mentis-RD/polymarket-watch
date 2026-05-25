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
high-signal. Build a "🔁 Повторяющиеся участники" section listing wallets
present in ≥2 signals with which signals + events.

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
```

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

Send via Bot API:
```
curl -s "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
  -d chat_id="$TG_CHAT_MAIN" \
  -d message_thread_id="$TG_THREAD_DIGEST" \
  -d parse_mode=Markdown \
  -d disable_web_page_preview=true \
  --data-urlencode text="$MESSAGE"
```

Check `ok:true` in response. If `can't parse entities` — retry once
without parse_mode (раз escape failure не должен убить дайджест).

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
