/**
 * Cancelled-offer retention prune.
 *
 * Drops `offers` rows where `status = 'cancelled'` and the
 * `cancelled_at` stamp is older than the operator-chosen window
 * (default 30 days, override via `CANCELLED_OFFER_RETENTION_DAYS`).
 *
 * Why retention rather than indefinite keep: cancelled rows are
 * how the Dashboard's "Cancelled" filter renders without a per-row
 * RPC round-trip (cancelled offers have their on-chain storage slot
 * deleted, so a fresh `getOffer(id)` can't disambiguate
 * "cancelled" from "never existed"). They accumulate over time and
 * have zero value once a user is past the window where they'd
 * still be looking up "what cancellation am I investigating?".
 *
 * Index hygiene: the migration ships
 * `idx_offers_cancelled_at` as a partial index covering only
 * cancelled rows, so this DELETE doesn't scan the active /
 * accepted population. Cheap enough to ride alongside the diag
 * prune in the existing 5-min cron tick.
 *
 * Failure mode: same as the diag prune — wrap in `.catch()` at
 * the scheduled() call site so a transient D1 hiccup doesn't
 * wedge the rest of the tick.
 */

import type { Env } from './env';

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;

export async function pruneOldCancelledOffers(env: Env): Promise<void> {
  const rawDays = env.CANCELLED_OFFER_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS);
  const parsed = Number(rawDays);
  const days = isFinite(parsed)
    ? Math.max(MIN_RETENTION_DAYS, Math.floor(parsed))
    : DEFAULT_RETENTION_DAYS;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  await env.DB
    .prepare(
      `DELETE FROM offers
       WHERE status = 'cancelled'
         AND cancelled_at IS NOT NULL
         AND cancelled_at < ?`,
    )
    .bind(cutoff)
    .run();
}
