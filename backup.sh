#!/usr/bin/env bash
# Backup state to a separate git repo (hourly) + TG document (daily).
# Cron:
#   0 * * * * /root/polymarket-watch/backup.sh hourly
#   5 3 * * * /root/polymarket-watch/backup.sh daily

set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-hourly}"
STATE_REPO_DIR="/root/polymarket-watch-state"

# Explicit .env check — without this `. .env` under `set -u` errors out with
# a parser-level message that hides the actual cause from the operator.
if [ ! -f .env ]; then
  echo "[$(date -u +%FT%TZ)] backup.sh: .env missing — credentials unavailable, aborting" >&2
  exit 1
fi
# shellcheck disable=SC1091
. .env

if [ "$MODE" = "hourly" ]; then
  if [ ! -d "$STATE_REPO_DIR" ]; then
    echo "[$(date -u +%FT%TZ)] state repo not cloned yet at $STATE_REPO_DIR; skipping"
    exit 0
  fi

  # Sync state/ files but exclude logs and ephemeral data.
  # IMPORTANT: do NOT push large append-only / rotated logs or the big
  # regenerable profile cache into the hourly GIT backup — committing GBs every
  # hour ballooned the -state repo history to 9 GB and triggered OOM during git
  # pack (2026-06-02). These are covered by the DAILY tar.gz instead.
  # --delete-excluded also purges any such files already copied into the tree.
  rsync -a --delete --delete-excluded \
    --exclude='*.log' \
    --exclude='*.out.log' \
    --exclude='*.err.log' \
    --exclude='deploy.lock' \
    --exclude='alerts/' \
    --exclude='*.tmp' \
    --exclude='*.tmp.*' \
    --exclude='trades.jsonl' \
    --exclude='trades_enriched.jsonl' \
    --exclude='*.jsonl.*' \
    --exclude='wallet_profiles.json' \
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
  # Disk hygiene. Raw trades.jsonl rotations are unread archives → prune >2d.
  # trades_enriched.jsonl rotations ARE read by the enriched-store (it loads
  # them to cover the 7d cross-market / 48h cluster windows across a rotation),
  # so keep them ≥10d — pruning these too early was starving every
  # cluster/cross-market re-review (2026-06-04). And drop stale atomic-write
  # temp files left by killed procs (wallet_profiles.json.tmp.<pid>).
  find state -maxdepth 1 -name 'trades.jsonl.*' -mtime +2 -delete 2>/dev/null || true
  find state -maxdepth 1 -name 'trades_enriched.jsonl.*' -mtime +10 -delete 2>/dev/null || true
  find state -maxdepth 1 -name '*.tmp.*' -mmin +60 -delete 2>/dev/null || true

  TS=$(date -u +%Y%m%d-%H%M%S)
  ARCHIVE="/tmp/polymarket-watch-state-$TS.tar.gz"
  # Exclude the big regenerable logs so the archive fits Telegram's 50 MB bot
  # document limit (the old full tar was 173 MB and silently failed to upload).
  # wallet_profiles.json is KEPT — it gzips to ~7 MB and is expensive to rebuild.
  tar -czf "$ARCHIVE" \
    --exclude='state/*.log' \
    --exclude='state/*.out.log' \
    --exclude='state/*.err.log' \
    --exclude='state/deploy.lock' \
    --exclude='state/alerts' \
    --exclude='state/*.tmp' \
    --exclude='state/*.tmp.*' \
    --exclude='state/trades.jsonl' \
    --exclude='state/trades_enriched.jsonl' \
    --exclude='state/*.jsonl.*' \
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
