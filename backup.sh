#!/usr/bin/env bash
# Backup state to a separate git repo (hourly) + TG document (daily).
# Cron:
#   0 * * * * /root/polymarket-watch/backup.sh hourly
#   5 3 * * * /root/polymarket-watch/backup.sh daily

set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-hourly}"
STATE_REPO_DIR="/root/polymarket-watch-state"

# shellcheck disable=SC1091
. .env

if [ "$MODE" = "hourly" ]; then
  if [ ! -d "$STATE_REPO_DIR" ]; then
    echo "[$(date -u +%FT%TZ)] state repo not cloned yet at $STATE_REPO_DIR; skipping"
    exit 0
  fi

  # Sync state/ files but exclude logs and ephemeral data.
  rsync -a --delete \
    --exclude='*.log' \
    --exclude='*.out.log' \
    --exclude='*.err.log' \
    --exclude='deploy.lock' \
    --exclude='alerts/' \
    state/ "$STATE_REPO_DIR/state/"

  # Also copy output CSVs.
  mkdir -p "$STATE_REPO_DIR/output"
  rsync -a output/ "$STATE_REPO_DIR/output/"

  cd "$STATE_REPO_DIR"
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git -c user.email=backup@polymarket-watch -c user.name=backup commit -m "state snapshot $(date -u +%FT%TZ)" --quiet
    git push origin main --quiet
    echo "[$(date -u +%FT%TZ)] hourly backup pushed"
  fi
  exit 0
fi

if [ "$MODE" = "daily" ]; then
  TS=$(date -u +%Y%m%d-%H%M%S)
  ARCHIVE="/tmp/polymarket-watch-state-$TS.tar.gz"
  tar -czf "$ARCHIVE" \
    --exclude='state/*.log' \
    --exclude='state/*.out.log' \
    --exclude='state/*.err.log' \
    --exclude='state/deploy.lock' \
    --exclude='state/alerts' \
    state output

  CHAT="${TG_CHAT_BACKUP:-$TG_CHAT_MAIN}"
  THREAD="${TG_THREAD_BACKUP:-}"
  if [ -z "${TG_TOKEN:-}" ] || [ -z "$CHAT" ]; then
    echo "[$(date -u +%FT%TZ)] TG creds missing; skipping daily TG upload"
  else
    CURL_ARGS=(-s -F "chat_id=$CHAT" -F "document=@$ARCHIVE")
    [ -n "$THREAD" ] && CURL_ARGS+=(-F "message_thread_id=$THREAD")
    curl "${CURL_ARGS[@]}" "https://api.telegram.org/bot$TG_TOKEN/sendDocument" >/dev/null
    echo "[$(date -u +%FT%TZ)] daily backup uploaded to TG"
  fi
  rm -f "$ARCHIVE"
  exit 0
fi

echo "usage: $0 hourly|daily" >&2
exit 1
