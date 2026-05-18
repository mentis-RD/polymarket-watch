# polymarket-watch

Detect insider activity on Polymarket. Phase 1: market discovery + daily CSV digest to Telegram.

## Phase 1 components

- `src/market-discovery.ts` — every hour: pull Gamma API `/markets`, dedupe against `state/seen_markets.json`, append new ones to `state/new_markets.jsonl`.
- `src/digest.ts` — at 12:00 Europe/Berlin: build CSV of last 24h of new markets, send to Telegram.
- `src/watchdog.ts` — cron every 5 min: check heartbeats, alert to TG if a process is stuck.

## Layout

```
src/                # TypeScript sources
state/              # gitignored; runtime state (seen_markets.json, heartbeats/, etc.)
output/             # gitignored; daily CSV digests
ecosystem.config.cjs# pm2 process spec
deploy.sh           # git auto-pull + pm2 restart (cron every minute)
backup.sh           # hourly: rsync to state repo; daily: tar.gz to TG
.env.example        # copy to .env and fill secrets
```

## Local dev

```
npm install
cp .env.example .env  # fill in TG_TOKEN, TG_CHAT_MAIN
npx tsx src/market-discovery.ts --once
npx tsx src/digest.ts          # loops; sends once per day at DIGEST_HOUR
npx tsx src/watchdog.ts        # one-shot
```

## Server deploy

```
cd /root && git clone https://<TOKEN>@github.com/mentis-RD/polymarket-watch.git
cd polymarket-watch && npm install
cp .env.example .env  # edit
chmod +x deploy.sh backup.sh
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Cron entries (`crontab -e`):

```
* * * * *   /root/polymarket-watch/deploy.sh >> /root/polymarket-watch/state/deploy.log 2>&1
0 * * * *   /root/polymarket-watch/backup.sh hourly
5 3 * * *   /root/polymarket-watch/backup.sh daily
*/5 * * * * cd /root/polymarket-watch && /usr/bin/npx tsx src/watchdog.ts >> state/watchdog.log 2>&1
```
