#!/usr/bin/env bash
# pr-codex-watch.sh — post Codex trigger once per HEAD, poll until Codex
# reviews that commit, retry with backoff (not spam).
#
# Usage:
#   pr-codex-watch.sh <pr-number> [--mode full|adversarial|normal] [--interval 300] [--max-retries 2]
#
# Exit 0 when chatgpt-codex-connector has a review whose commit_id matches
# the PR HEAD. Exit 1 on timeout.

set -euo pipefail

PR=""
MODE="full"
INTERVAL=300
MAX_RETRIES=2
OWNER="vaipakam"
REPO="vaipakam"
CODEX_USER="chatgpt-codex-connector[bot]"

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    *) [ -z "$PR" ] && PR="$1" || { echo "unexpected arg: $1" >&2; exit 2; }; shift ;;
  esac
done

[ -n "$PR" ] || { echo "usage: pr-codex-watch.sh <pr-number> [--mode full] [--interval 300]" >&2; exit 2; }

STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}"
STATE_FILE="$STATE_DIR/pr-codex-watch-${OWNER}-${REPO}-${PR}.state"

head_sha() {
  gh pr view "$PR" --repo "$OWNER/$REPO" --json headRefOid -q .headRefOid
}

codex_reviewed_head() {
  local head="$1"
  local count
  count=$(gh api "repos/$OWNER/$REPO/pulls/$PR/reviews" \
    | jq --arg head "$head" --arg bot "$CODEX_USER" \
      '[.[] | select(.user.login == $bot and .commit_id == $head)] | length')
  [ "${count:-0}" -gt 0 ] && echo true || echo false
}

already_triggered_for() {
  local head="$1"
  [ -f "$STATE_FILE" ] && grep -qx "triggered:$head" "$STATE_FILE" 2>/dev/null
}

post_trigger() {
  local head="$1"
  local body
  body="$(cat <<EOF
@codex review ${MODE}

> *\`${MODE}\` = canonical Codex mode (automated re-review after push to \`${head:0:8}\`).*

🤖 Generated with Grok 4.3
EOF
)"
  gh pr comment "$PR" --repo "$OWNER/$REPO" --body "$body" >/dev/null
  echo "triggered:$head" >> "$STATE_FILE"
  echo "[pr-codex-watch] posted @codex review ${MODE} for HEAD ${head:0:8}" >&2
}

HEAD="$(head_sha)"
RETRIES=0

if [ "$(codex_reviewed_head "$HEAD")" = "true" ]; then
  echo "[pr-codex-watch] Codex already reviewed HEAD ${HEAD:0:8} — done" >&2
  exit 0
fi

if ! already_triggered_for "$HEAD"; then
  post_trigger "$HEAD"
else
  echo "[pr-codex-watch] trigger already posted for HEAD ${HEAD:0:8}" >&2
fi

while true; do
  if [ "$(codex_reviewed_head "$HEAD")" = "true" ]; then
    echo "[pr-codex-watch] Codex reviewed HEAD ${HEAD:0:8} — done" >&2
    exit 0
  fi

  CURRENT="$(head_sha)"
  if [ "$CURRENT" != "$HEAD" ]; then
    echo "[pr-codex-watch] HEAD moved ${HEAD:0:8} → ${CURRENT:0:8}; restart watcher" >&2
    exit 2
  fi

  if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
    echo "[pr-codex-watch] timeout: no Codex review on HEAD ${HEAD:0:8} after $MAX_RETRIES retries" >&2
    exit 1
  fi

  echo "[pr-codex-watch] waiting ${INTERVAL}s (retry $RETRIES/$MAX_RETRIES)…" >&2
  sleep "$INTERVAL"

  if [ "$(codex_reviewed_head "$HEAD")" = "true" ]; then
    echo "[pr-codex-watch] Codex reviewed HEAD ${HEAD:0:8} — done" >&2
    exit 0
  fi

  RETRIES=$((RETRIES + 1))
  if [ "$RETRIES" -le "$MAX_RETRIES" ]; then
    echo "[pr-codex-watch] no Codex review yet — retry trigger ($RETRIES/$MAX_RETRIES)" >&2
    post_trigger "$HEAD"
  fi
done