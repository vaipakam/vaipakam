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
npx wrangler d1 execute "$DB_NAME" $TARGET_FLAG --command "
  SELECT 'offers'           AS tbl, COUNT(*) AS rows FROM offers           WHERE chain_id = $CHAIN_ID
  UNION ALL SELECT 'loans',           COUNT(*)        FROM loans           WHERE chain_id = $CHAIN_ID
  UNION ALL SELECT 'activity_events', COUNT(*)        FROM activity_events WHERE chain_id = $CHAIN_ID
  UNION ALL SELECT 'indexer_cursor',  COUNT(*)        FROM indexer_cursor  WHERE chain_id = $CHAIN_ID
  UNION ALL SELECT 'user_thresholds', COUNT(*)        FROM user_thresholds WHERE chain_id = $CHAIN_ID
  UNION ALL SELECT 'notify_state',    COUNT(*)        FROM notify_state    WHERE chain_id = $CHAIN_ID
  UNION ALL SELECT 'telegram_links',  COUNT(*)        FROM telegram_links  WHERE chain_id = $CHAIN_ID
  UNION ALL SELECT 'diag_errors',     COUNT(*)        FROM diag_errors     WHERE chain_id = $CHAIN_ID;
"

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
npx wrangler d1 execute "$DB_NAME" $TARGET_FLAG --command "
  DELETE FROM offers           WHERE chain_id = $CHAIN_ID;
  DELETE FROM loans            WHERE chain_id = $CHAIN_ID;
  DELETE FROM activity_events  WHERE chain_id = $CHAIN_ID;
  DELETE FROM indexer_cursor   WHERE chain_id = $CHAIN_ID;
  DELETE FROM notify_state     WHERE chain_id = $CHAIN_ID;
  DELETE FROM user_thresholds  WHERE chain_id = $CHAIN_ID;
  DELETE FROM telegram_links   WHERE chain_id = $CHAIN_ID;
  DELETE FROM diag_errors      WHERE chain_id = $CHAIN_ID;
"
echo "Done. Chain $CHAIN_ID purged."
