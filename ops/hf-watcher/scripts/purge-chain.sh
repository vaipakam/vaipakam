#!/usr/bin/env bash
# T-046 — purge every D1 row scoped to a given chain ID.
#
# Use case: a testnet diamond redeploy invalidates every offer/loan/
# activity event we've cached for that chain. Old offer IDs collide
# with new ones (`nextOfferId` resets), old loan IDs reference
# burned NFTs, user thresholds reference loans that no longer exist.
# Running this BEFORE the redeploy clears the slate so the next
# cron tick re-indexes from the new diamond's deployBlock.
#
# Surviving across redeploys (intentional):
#   - `user_locales` — preferred language is wallet-scoped, not
#     chain-scoped. Carries no stale references.
#
# Usage:
#   bash scripts/purge-chain.sh <chainId>
#   bash scripts/purge-chain.sh 84532              # Base Sepolia
#
# Env knobs:
#   FORCE=1   skip the y/N confirmation prompt (CI use)
#   LOCAL=1   target the local miniflare DB instead of --remote
#             (sanity-check before hitting prod)
#
# Exit codes: 0 success / 1 bad usage / 2 user aborted at prompt.

set -euo pipefail

CHAIN_ID="${1:-}"
if [ -z "$CHAIN_ID" ] || ! [[ "$CHAIN_ID" =~ ^[0-9]+$ ]]; then
  cat <<EOF
Usage: $0 <chainId>

Common chain IDs:
  Mainnets : 8453 (Base) / 1 (Ethereum) / 42161 (Arbitrum) /
             10 (Optimism) / 1101 (Polygon zkEVM) / 56 (BNB Chain)
  Testnets : 84532 (Base Sepolia) / 11155111 (Sepolia) /
             421614 (Arb Sepolia) / 11155420 (OP Sepolia) /
             80002 (Polygon Amoy) / 97 (BNB Testnet)

Env:
  FORCE=1   skip confirmation prompt
  LOCAL=1   purge local miniflare DB instead of remote D1
EOF
  exit 1
fi

DB_NAME="vaipakam-alerts-db"
TARGET_FLAG="${LOCAL:+--local}"
TARGET_FLAG="${TARGET_FLAG:---remote}"

echo "Counting rows scoped to chain $CHAIN_ID ($TARGET_FLAG)…"
# D1 caps compound SELECT at ~6 UNION terms ("too many terms in
# compound SELECT" SQLITE_ERROR 7500). With 8 chain-scoped tables
# the single-query approach blows the cap. Issue per-table COUNTs
# instead — slower (8 round-trips) but works on any D1 size.
for tbl in offers loans activity_events indexer_cursor user_thresholds notify_state telegram_links diag_errors; do
  npx wrangler d1 execute "$DB_NAME" $TARGET_FLAG --command \
    "SELECT '$tbl' AS tbl, COUNT(*) AS rows FROM $tbl WHERE chain_id = $CHAIN_ID;" \
    2>&1 | grep -E '"rows":|"tbl":' | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g'
  echo
done

if [ "${FORCE:-0}" != "1" ]; then
  echo
  read -r -p "Delete every row above for chain $CHAIN_ID? [y/N] " ANSWER
  case "$ANSWER" in
    y|Y) ;;
    *) echo "Aborted."; exit 2 ;;
  esac
fi

echo "Purging chain $CHAIN_ID…"
# D1 does not currently support BEGIN/COMMIT explicit transactions
# via `--command`. Each DELETE runs in its own implicit transaction.
# That's acceptable here — partial failure leaves the DB in a still-
# coherent state (some tables purged, others not). The next run
# completes the rest. Idempotent.
#
# Per-table DELETEs (same rationale as the count loop above —
# wrangler's compound-statement parser is also fragile when the
# UNION-cap bug kicks in for related shapes).
for tbl in offers loans activity_events indexer_cursor notify_state user_thresholds telegram_links diag_errors; do
  npx wrangler d1 execute "$DB_NAME" $TARGET_FLAG --command \
    "DELETE FROM $tbl WHERE chain_id = $CHAIN_ID;" >/dev/null 2>&1 \
    && echo "  ✓ $tbl" \
    || echo "  ✗ $tbl (continuing — re-run will catch it)"
done
echo "Done. Chain $CHAIN_ID purged."
