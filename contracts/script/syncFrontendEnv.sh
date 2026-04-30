#!/usr/bin/env bash
#
# syncFrontendEnv.sh — sync per-chain Diamond / facet addresses from
# `contracts/deployments/<chain-slug>/addresses.json` (the
# auto-populated source of truth produced by every deploy script) into
# `frontend/.env.local`.
#
# Why this exists: today the ops loop after a contract redeploy is
# "open addresses.json, copy seven values into .env.local by hand for
# each chain, hope you didn't transpose a digit". This script does it
# in one command, idempotently, preserving every other line in
# .env.local (RPC URLs, comments, manually-tuned values).
#
# Why NOT sync into wrangler.jsonc's `vars` block: the frontend ships
# as a Cloudflare Pages-style static-asset deploy (see
# `frontend/wrangler.jsonc` — only `assets` + SPA fallback, no Worker
# code). The `vars` block is for Workers runtime environment, which a
# static SPA never reads. VITE_* values reach the browser bundle by
# being inlined at `vite build` time from `.env.local` — that's the
# right surface to keep in sync.
#
# Deploy-flow note: `frontend/.env.local` is gitignored, so a CI build
# (Cloudflare Pages, GitHub Actions) won't see anything written here
# unless the values are also mirrored into the Cloudflare Pages
# Build-Environment-Variables dashboard, OR a `frontend/.env.production`
# is committed. The script writes .env.local for the developer's
# local `npm run deploy` flow; the CI mirror is a one-time setup.
#
# Usage:
#   bash contracts/script/syncFrontendEnv.sh
#
# Re-running: idempotent. Each `set_env_var` invocation either
# replaces an existing `KEY=oldvalue` line (preserving line position
# and surrounding comments) or appends `KEY=newvalue` at the end if
# the key didn't previously exist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOYMENTS_DIR="$REPO_ROOT/contracts/deployments"
ENV_FILE="$REPO_ROOT/frontend/.env.local"

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: this script requires jq (https://jqlang.github.io/jq/)" >&2
  exit 1
fi

if [ ! -d "$DEPLOYMENTS_DIR" ]; then
  echo "Error: $DEPLOYMENTS_DIR not found" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Note: $ENV_FILE missing — bootstrapping from .env.example"
  cp "$REPO_ROOT/frontend/.env.example" "$ENV_FILE"
fi

# Replace `KEY=...` in-place, or append `KEY=value` at EOF if absent.
# Comments and unrelated lines are untouched. Empty values (e.g.
# anvil's deploy block when not yet booted) are skipped silently so a
# half-populated addresses.json doesn't blank out an existing value.
set_env_var() {
  local key="$1"
  local value="$2"
  if [ -z "$value" ] || [ "$value" = "null" ] || [ "$value" = "0x0000000000000000000000000000000000000000" ]; then
    return 0
  fi
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # Use a sentinel char unlikely to appear in addresses (|) as the
    # sed delimiter so we don't have to escape forward slashes that
    # might appear in URL values.
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# Map a deployment's chain-slug to the per-chain prefix used in
# .env.local — the existing convention is upper-snake of the slug
# (base-sepolia → BASE_SEPOLIA, bnb-testnet → BNB_TESTNET, etc).
slug_to_prefix() {
  echo "$1" | tr '[:lower:]-' '[:upper:]_'
}

CHAINS_PROCESSED=0
for chain_dir in "$DEPLOYMENTS_DIR"/*/; do
  [ -d "$chain_dir" ] || continue
  slug="$(basename "$chain_dir")"
  addresses_file="$chain_dir/addresses.json"
  [ -f "$addresses_file" ] || continue

  # Anvil is local-only and shouldn't write into a frontend env that's
  # also used for production builds. Skip silently.
  if [ "$slug" = "anvil" ]; then
    continue
  fi

  prefix="$(slug_to_prefix "$slug")"
  echo "[sync] $slug → VITE_${prefix}_*"

  diamond=$(jq -r '.diamond // empty' "$addresses_file")
  deploy_block=$(jq -r '.deployBlock // empty' "$addresses_file")
  escrow_impl=$(jq -r '.escrowImpl // empty' "$addresses_file")
  metrics_facet=$(jq -r '.facets.metricsFacet // empty' "$addresses_file")
  risk_facet=$(jq -r '.facets.riskFacet // empty' "$addresses_file")
  profile_facet=$(jq -r '.facets.profileFacet // empty' "$addresses_file")
  vpfi_buy_adapter=$(jq -r '.vpfiBuyAdapter // empty' "$addresses_file")

  set_env_var "VITE_${prefix}_DIAMOND_ADDRESS" "$diamond"
  set_env_var "VITE_${prefix}_DEPLOY_BLOCK" "$deploy_block"
  set_env_var "VITE_${prefix}_ESCROW_IMPL" "$escrow_impl"
  set_env_var "VITE_${prefix}_METRICS_FACET_ADDRESS" "$metrics_facet"
  set_env_var "VITE_${prefix}_RISK_FACET_ADDRESS" "$risk_facet"
  set_env_var "VITE_${prefix}_PROFILE_FACET_ADDRESS" "$profile_facet"
  # Only mirror chains carry a buy adapter; canonical chains have a
  # receiver instead. `set_env_var` skips empties, so canonical chains
  # don't get a stray blank line.
  set_env_var "VITE_${prefix}_VPFI_BUY_ADAPTER" "$vpfi_buy_adapter"

  CHAINS_PROCESSED=$((CHAINS_PROCESSED + 1))
done

echo
if [ "$CHAINS_PROCESSED" -eq 0 ]; then
  echo "Warning: no eligible deployments found under $DEPLOYMENTS_DIR" >&2
  exit 1
fi

echo "Synced $CHAINS_PROCESSED chain(s) into $ENV_FILE"
echo
echo "Next: rebuild + redeploy the frontend so the new addresses make"
echo "it into the bundle:"
echo "  cd frontend && npm run deploy"
echo
echo "Reminder: .env.local is gitignored. For CI deploys, also mirror"
echo "the values into Cloudflare Pages → Settings → Environment"
echo "variables (or commit a frontend/.env.production)."
