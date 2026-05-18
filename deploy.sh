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

# If package.json changed, npm install + restart all.
if echo "$CHANGED" | grep -q -E "^(package\.json|package-lock\.json)$"; then
  echo "deps changed, running npm install"
  npm install --no-audit --no-fund
  pm2 restart all || pm2 start ecosystem.config.cjs
  echo "[$(date -u +%FT%TZ)] full restart done"
  exit 0
fi

# Otherwise, smart restart based on which files changed.
RESTART_DISCOVERY=0
RESTART_DIGEST=0

while IFS= read -r f; do
  case "$f" in
    src/market-discovery.ts) RESTART_DISCOVERY=1 ;;
    src/digest.ts)           RESTART_DIGEST=1 ;;
    src/polymarket-api.ts|src/telegram.ts|src/heartbeat.ts|src/log.ts)
      RESTART_DISCOVERY=1
      RESTART_DIGEST=1
      ;;
    ecosystem.config.cjs)
      RESTART_DISCOVERY=1
      RESTART_DIGEST=1
      ;;
    src/watchdog.ts) : ;; # cron-driven, no restart needed
    *) : ;;
  esac
done <<< "$CHANGED"

# Ensure pm2 is running our procs (first deploy).
pm2 describe market-discovery >/dev/null 2>&1 || pm2 start ecosystem.config.cjs --only market-discovery
pm2 describe digest          >/dev/null 2>&1 || pm2 start ecosystem.config.cjs --only digest

[ "$RESTART_DISCOVERY" = "1" ] && pm2 restart market-discovery && echo "restarted market-discovery"
[ "$RESTART_DIGEST"    = "1" ] && pm2 restart digest          && echo "restarted digest"

pm2 save >/dev/null 2>&1 || true
echo "[$(date -u +%FT%TZ)] deploy done"
