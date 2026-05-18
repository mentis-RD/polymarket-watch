#!/usr/bin/env bash
# Auto-deploy: every minute, check for new commits and apply.
# Cron: * * * * * /root/polymarket-watch/deploy.sh >> /root/polymarket-watch/state/deploy.log 2>&1

set -euo pipefail
cd "$(dirname "$0")"

mkdir -p state

# Avoid concurrent deploys.
LOCK_FILE="state/deploy.lock"
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(($(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0)))
  if [ "$LOCK_AGE" -lt 300 ]; then
    exit 0
  fi
fi
echo "$$" > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Fetch and check for changes.
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "[$(date -u +%FT%TZ)] deploying $LOCAL -> $REMOTE"

# Snapshot changed files BEFORE pulling.
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")
echo "changed:"
echo "$CHANGED" | sed 's/^/  /'

git reset --hard origin/main

# If package.json changed, npm install + restart all of OUR procs only.
if echo "$CHANGED" | grep -q -E "^(package\.json|package-lock\.json)$"; then
  echo "deps changed, running npm install"
  npm install --no-audit --no-fund
  pm2 restart pmw-market-discovery pmw-digest pmw-tg-control pmw-market-monitor || pm2 start ecosystem.config.cjs
  echo "[$(date -u +%FT%TZ)] full restart done"
  exit 0
fi

# Otherwise, smart restart based on which files changed.
RESTART_DISCOVERY=0
RESTART_DIGEST=0
RESTART_CONTROL=0
RESTART_MONITOR=0

while IFS= read -r f; do
  case "$f" in
    src/market-discovery.ts) RESTART_DISCOVERY=1 ;;
    src/digest.ts)           RESTART_DIGEST=1 ;;
    src/tg-control.ts) RESTART_CONTROL=1 ;;
    src/watchlist.ts)
      RESTART_CONTROL=1
      RESTART_MONITOR=1
      ;;
    src/market-monitor.ts|src/clob-ws.ts|src/alert-cooldown.ts|src/signals/*)
      RESTART_MONITOR=1
      ;;
    src/polymarket-api.ts)
      RESTART_DISCOVERY=1
      RESTART_DIGEST=1
      RESTART_CONTROL=1
      ;;
    src/telegram.ts|src/heartbeat.ts|src/log.ts)
      RESTART_DISCOVERY=1
      RESTART_DIGEST=1
      RESTART_CONTROL=1
      RESTART_MONITOR=1
      ;;
    ecosystem.config.cjs)
      RESTART_DISCOVERY=1
      RESTART_DIGEST=1
      RESTART_CONTROL=1
      RESTART_MONITOR=1
      ;;
    src/watchdog.ts) : ;; # cron-driven, no restart needed
    *) : ;;
  esac
done <<< "$CHANGED"

# Ensure pm2 is running our procs (first deploy).
pm2 describe pmw-market-discovery >/dev/null 2>&1 || pm2 start ecosystem.config.cjs --only pmw-market-discovery
pm2 describe pmw-digest           >/dev/null 2>&1 || pm2 start ecosystem.config.cjs --only pmw-digest
pm2 describe pmw-tg-control       >/dev/null 2>&1 || pm2 start ecosystem.config.cjs --only pmw-tg-control
pm2 describe pmw-market-monitor   >/dev/null 2>&1 || pm2 start ecosystem.config.cjs --only pmw-market-monitor

[ "$RESTART_DISCOVERY" = "1" ] && pm2 restart pmw-market-discovery && echo "restarted pmw-market-discovery"
[ "$RESTART_DIGEST"    = "1" ] && pm2 restart pmw-digest          && echo "restarted pmw-digest"
[ "$RESTART_CONTROL"   = "1" ] && pm2 restart pmw-tg-control      && echo "restarted pmw-tg-control"
[ "$RESTART_MONITOR"   = "1" ] && pm2 restart pmw-market-monitor  && echo "restarted pmw-market-monitor"

pm2 save >/dev/null 2>&1 || true
echo "[$(date -u +%FT%TZ)] deploy done"
