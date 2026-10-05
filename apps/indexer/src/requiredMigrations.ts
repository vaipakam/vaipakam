/**
 * Every D1 migration this build was written against — the schema gate
 * (schemaGate.ts) holds scheduled work until ALL of them are recorded in
 * `d1_migrations`.
 *
 * The whole set, not only the newest: a migration that fills a gap in the
 * numbering sorts BELOW the newest, so a newest-only check would pass a
 * database that never applied it (#2409 r1). Kept as a committed list
 * because a Worker bundle cannot read its own migrations directory;
 * `scripts/check-schema-gate.mjs` (part of `typecheck`) fails CI unless this
 * list equals the `migrations/` directory exactly, so adding a migration
 * without listing it here is a red build rather than a gate that lets new
 * code run ahead of its schema.
 *
 * Full filenames, which is what wrangler records in `d1_migrations.name`.
 */
export const REQUIRED_D1_MIGRATIONS: readonly string[] = [
  '0001_init.sql',
  '0002_user_locale.sql',
  '0003_diag_errors.sql',
  '0004_offer_indexer.sql',
  '0005_loans_and_activity.sql',
  '0006_loan_token_ids.sql',
  '0007_periodic_interest.sql',
  '0008_offer_is_stub.sql',
  '0009_loan_indexes_and_is_stub.sql',
  '0010_oracle_snapshot_state.sql',
  '0011_liquidity_confidence.sql',
  '0011_offers_cancelled_at.sql',
  '0012_current_holder.sql',
  '0013_diag_erasure.sql',
  '0014_offer_gtt_and_fillmode.sql',
  '0015_prepay_listings.sql',
  '0016_prepay_listings_opensea.sql',
  '0017_prepay_listings_fee_legs.sql',
  '0018_prepay_listings_dutch.sql',
  '0019_prepay_listing_match_breadcrumbs.sql',
  '0020_prepay_listing_match_mode.sql',
  '0021_backfill_consumed_by_sale_creator.sql',
  '0022_swap_to_repay_intents.sql',
  '0023_pre_grace_notify_state.sql',
  '0024_purge_retired_vpfi_events.sql',
  '0025_webhook_deliveries.sql',
  '0026_backfill_offer_matched_refs.sql',
  '0027_notify_maturity_opt_in.sql',
  '0028_support_tickets.sql',
  '0029_rate_desk_market_reads.sql',
  '0030_backfill_sale_vehicle_flags.sql',
  '0031_offset_vehicle_flags.sql',
  '0032_rate_desk_phase2.sql',
  '0033_signed_offer_book.sql',
  '0034_test_alert_cooldown.sql',
  '0035_protocol_config.sql',
  '0036_signed_offers_signer_market_idx.sql',
  '0037_market_summary.sql',
  '0038_notifications.sql',
  '0039_protocol_config_grace_buckets.sql',
  '0040_loans_calendar_maturity_idx.sql',
  '0041_hf_band_state.sql',
  '0042_reward_loop_ledger.sql',
  '0043_keeper_commitment_scan.sql',
  '0044_keeper_remit_ack.sql',
  '0045_recycle_day_series.sql',
  '0046_recycle_prelaunch_absorption.sql',
  '0047_recycle_day_backfill.sql',
  '0048_recycle_backing_snapshot.sql',
  '0049_loan_reconcile_quarantine.sql',
  '0050_prenotify_scan_cursor.sql',
  '0052_quarantine_first_seen_index.sql',
  '0053_quarantine_observation_token.sql',
];
