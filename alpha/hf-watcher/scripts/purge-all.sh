#!/usr/bin/env bash
# T-046 — full D1 purge across every chain.
#
# Use case: pre-mainnet cutover. After months of testnet iteration,
# the watcher's D1 holds offer / loan / activity-event rows from
# many redeployed testnet diamonds, plus user-threshold rows for
# wallets that may not exist on mainnet, plus diag_errors that have
# no diagnostic value past the testnet phase. This script wipes
# everything except `user_locales` (which is a wallet-scoped
# language preference and survives the transition cleanly).
#
# Schema is preserved — we DELETE rows, never DROP TABLE — so the
# next cron tick after deploy starts cleanly without re-running
# migrations.
#
# DOUBLE-CONFIRMATION required for production safety:
#   1. The y/N prompt below asks the operator to confirm intent.
#   2. They must then type the literal string `PURGE-ALL` to
#      acknowledge that they understand this is destructive.
#
# Usage:
#   bash scripts/purge-all.sh
#
# Env knobs:
#   FORCE=1   skip BOTH prompts (intended for one-shot CI scripts
#             that have already done their own confirmation step)
#   LOCAL=1   target the local miniflare DB instead of --remote

set -euo pipefail

DB_NAME="vaipakam-alerts-db"
TARGET_FLAG="${LOCAL:+--local}"
TARGET_FLAG="${TARGET_FLAG:---remote}"

echo "Counting rows across the watcher's D1 ($TARGET_FLAG)…"
npx wrangler d1 execute "$DB_NAME" $TARGET_FLAG --command "
  SELECT 'offers'           AS tbl, COUNT(*) AS rows FROM offers
  UNION ALL SELECT 'loans',           COUNT(*)        FROM loans
  UNION ALL SELECT 'activity_events', COUNT(*)        FROM activity_events
  UNION ALL SELECT 'indexer_cursor',  COUNT(*)        FROM indexer_cursor
  UNION ALL SELECT 'user_thresholds', COUNT(*)        FROM user_thresholds
  UNION ALL SELECT 'notify_state',    COUNT(*)        FROM notify_state
  UNION ALL SELECT 'telegram_links',  COUNT(*)        FROM telegram_links
  UNION ALL SELECT 'diag_errors',     COUNT(*)        FROM diag_errors
  UNION ALL SELECT 'user_locales (KEPT — wallet-scoped, not purged)', COUNT(*) FROM user_locales;
"

if [ "${FORCE:-0}" != "1" ]; then
  echo
  echo "This will DELETE every row above except user_locales."
  read -r -p "Continue? [y/N] " ANSWER
  case "$ANSWER" in
    y|Y) ;;
    *) echo "Aborted."; exit 2 ;;
  esac
  echo
  read -r -p "Type PURGE-ALL exactly to confirm: " ACK
  if [ "$ACK" != "PURGE-ALL" ]; then
    echo "Confirmation string did not match. Aborted."
    exit 2
  fi
fi

echo "Purging every chain…"
npx wrangler d1 execute "$DB_NAME" $TARGET_FLAG --command "
  DELETE FROM offers;
  DELETE FROM loans;
  DELETE FROM activity_events;
  DELETE FROM indexer_cursor;
  DELETE FROM notify_state;
  DELETE FROM user_thresholds;
  DELETE FROM telegram_links;
  DELETE FROM diag_errors;
"
echo "Done. Watcher D1 cleared (user_locales preserved)."
