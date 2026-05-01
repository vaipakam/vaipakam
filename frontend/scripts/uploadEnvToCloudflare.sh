#!/usr/bin/env bash
#
# uploadEnvToCloudflare.sh — push every `VITE_*` line in
# `frontend/.env.local` to a Cloudflare Pages project's build
# environment via Wrangler. Does NOT deploy code; only the env vars.
#
# Why we need this: Cloudflare Pages CI builds run with a fresh
# checkout that has no `.env.local` (it's gitignored). For Vite to
# inline `VITE_*` values into the bundle at `vite build` time, those
# values must be present in the build environment. The CF Pages
# dashboard at `Settings → Environment variables and secrets` is the
# source of truth; this script automates the bulk-upload from the
# operator's local file so the dashboard stays in sync.
#
# Secrets vs. plain vars: every `VITE_*` value is necessarily public
# (Vite inlines them into the JS bundle every visitor downloads).
# Wrangler's `pages secret put` command stores them encrypted at rest
# in CF's database, but that protection ends the moment they're
# baked into the bundle. The `secret`-vs-`plaintext` choice on CF
# Pages is operationally moot for `VITE_*` vars; we use `secret put`
# for the simpler API and the at-rest encryption.
#
# Usage:
#   PROJECT_NAME=vaipakam ENV_TARGET=production \
#     bash frontend/scripts/uploadEnvToCloudflare.sh
#
#   ENV_TARGET=preview bash frontend/scripts/uploadEnvToCloudflare.sh
#
# Defaults to the `production` Pages environment when ENV_TARGET is
# unset. Set ENV_TARGET=preview to push to the preview environment
# (used by branch deploys).
#
# Re-running: idempotent. `wrangler pages secret put` overwrites the
# existing value if the key is already set.
#
# Caveats:
#   1. Wrangler must be authenticated (`wrangler login` once on the
#      operator's machine, or `CLOUDFLARE_API_TOKEN` env var set).
#   2. The CF Pages project must already exist. This script does not
#      create the project; do that via the dashboard or
#      `wrangler pages project create` separately.
#   3. Only `VITE_*` lines are uploaded. Non-`VITE_*` keys
#      (Telegram bot tokens, RPC operator keys, etc.) belong on the
#      Worker, not on Pages, and are out of scope for this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env.local"
PROJECT_NAME="${PROJECT_NAME:-vaipakam}"
ENV_TARGET="${ENV_TARGET:-production}"

# Sanity checks before we touch the API.
if ! command -v npx >/dev/null 2>&1; then
  echo "Error: npx not found in PATH. Install Node 20.19+ first." >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found." >&2
  echo "Run \`bash contracts/script/syncFrontendEnv.sh\` first to populate it." >&2
  exit 1
fi
if [ "$ENV_TARGET" != "production" ] && [ "$ENV_TARGET" != "preview" ]; then
  echo "Error: ENV_TARGET must be 'production' or 'preview' (got '$ENV_TARGET')." >&2
  exit 1
fi

echo "── Cloudflare Pages env upload ──"
echo "Project:       $PROJECT_NAME"
echo "Environment:   $ENV_TARGET"
echo "Source file:   $ENV_FILE"
echo

# Wrangler's `pages secret put` reads the value from STDIN to avoid
# the `--secret` flag rendering it on the shell history. We pipe the
# captured value in via `printf` (not `echo`) to avoid trailing-
# newline corruption on values that contain `\n` or `\\`.
upload_one() {
  local key="$1"
  local value="$2"
  if [ -z "$value" ]; then
    # Empty values mean "unset on the deploy". Skip silently — the
    # CF dashboard treats absent and empty differently, and an empty
    # `secret put` reports as a no-op anyway.
    echo "    [skip] $key (empty)"
    return 0
  fi
  echo "    [upload] $key"
  printf '%s' "$value" | npx wrangler pages secret put "$key" \
    --project-name "$PROJECT_NAME" \
    --env "$ENV_TARGET" \
    >/dev/null
}

# Parse `.env.local` line-by-line. We respect `KEY=VALUE` shape with
# arbitrary `VALUE` content (URL with query string, numeric, empty).
# Comments (`#…`) and blank lines are skipped. Only lines whose key
# starts with `VITE_` are uploaded — anything else is operator
# scratch space and shouldn't reach CF.
COUNT=0
SKIPPED=0
while IFS= read -r line || [ -n "$line" ]; do
  # Strip leading whitespace.
  trimmed="${line#"${line%%[![:space:]]*}"}"
  case "$trimmed" in
    ''|'#'*) continue ;;
  esac
  case "$trimmed" in
    VITE_*=*) ;;
    *)
      # Non-VITE_ keys (or non-KEY=VALUE shape). Skip — see header.
      key="${trimmed%%=*}"
      echo "    [skip] $key (non-VITE_ key)"
      SKIPPED=$((SKIPPED + 1))
      continue
      ;;
  esac
  key="${trimmed%%=*}"
  value="${trimmed#*=}"
  upload_one "$key" "$value"
  COUNT=$((COUNT + 1))
done < "$ENV_FILE"

echo
echo "── Done ──"
echo "Uploaded:      $COUNT VITE_* keys"
echo "Skipped:       $SKIPPED non-VITE_ keys"
echo
echo "Verify on the dashboard:"
echo "  https://dash.cloudflare.com/?to=/:account/pages/view/$PROJECT_NAME/settings/environment-variables"
echo
echo "Next: trigger a fresh CF Pages build (any push to main, or"
echo "  manually retrigger via the dashboard) so the new env values"
echo "  get inlined into the bundle. Existing deployments are unchanged"
echo "  until the build re-runs."
