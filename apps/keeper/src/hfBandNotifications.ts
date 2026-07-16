/**
 * #1213 PR 2b — HF-band inbox rows, piggybacked on the liquidator scan.
 *
 * The liquidator pass already multicalls `calculateHealthFactor` for
 * EVERY active loan on every tick (liquidator.ts); this module reuses
 * those readings to materialize free in-app inbox rows when a loan's
 * health CROSSES DOWN into a protocol-level band:
 *
 *   - `hf_warn`     — HF dipped below 1.5 (the initiation floor)
 *   - `hf_alert`    — HF dipped below 1.2
 *   - `hf_critical` — HF dipped below 1.05 (liquidatable at 1.0)
 *
 * Distinct from the SUBSCRIBER alert rail (watcher.ts / notify_state):
 * that path sends Telegram/Push against each wallet's OWN configured
 * thresholds and only for wallets that set them up. This path is
 * unconditional protocol-band bookkeeping — one fixed schedule, every
 * borrower, zero setup — feeding the same `notifications` table the
 * indexer's event/calendar rows land in (the bell reads one feed).
 *
 * Semantics:
 *   - DOWNGRADE-ONLY: a row mints when the observed band is WORSE than
 *     the stored one (absence = healthy, so a loan FIRST OBSERVED
 *     already inside a band notifies once). Recoveries update state
 *     silently — "your loan got safer" is not an alert.
 *   - Day-bucketed dedup: the dedup key embeds the UTC day, so an HF
 *     oscillating around a threshold re-alerts at most once per band
 *     per day (state updates keep the crossing edge-triggered within
 *     the day; the bucket only bounds pathological flapping).
 *   - Borrower-only recipient: HF is the BORROWER's actionable number
 *     (top up / repay). The lender-side risk surface is the grace and
 *     terminal rows. Recipient resolves to the CURRENT borrower-
 *     position holder via the shared D1 `loans` table.
 *   - LIQUID LOANS ONLY, inherently: illiquid loans revert
 *     `IlliquidLoanNoRiskMath` in the multicall and never reach this
 *     module — exactly the design split (#1213): calendar rows cover
 *     every loan; HF rows cover the loans HF math exists for.
 *   - Fail-open: this is derived convenience data. Any failure logs
 *     and returns — the liquidation pass it rides on must never wedge.
 *
 * Gating note (documented, deliberate): the liquidator pass — and so
 * this piggyback — runs only when the autonomous keeper is enabled
 * (`isKeeperEnabled`). Without a keeper key there is no per-tick HF
 * scan to reuse, so HF-band inbox rows are a keeper-enabled feature;
 * the calendar/event rows (indexer-side) are unconditional.
 *
 * Delivery note: rows written here reach the bell on its polling
 * cadence (the signal-stretched net). The keeper cannot push the
 * indexer DO's `notification.created` invalidation — an acceptable
 * lag for a band alert whose Telegram/Push twin (for subscribers) is
 * immediate.
 */

export type HfBand = 'healthy' | 'warn' | 'alert' | 'critical';

/** Protocol-level band thresholds in milli-HF (1e18-scaled HF / 1e15).
 *  Fixed on purpose — the subscriber rail (watcher.ts) is where users
 *  tune personal thresholds; the inbox uses one protocol schedule
 *  anchored on MIN_HEALTH_FACTOR (1.5, the initiation floor). */
export const HF_WARN_MILLI = 1_500;
export const HF_ALERT_MILLI = 1_200;
export const HF_CRITICAL_MILLI = 1_050;

/** Milli-HF ceiling stored for effectively-infinite readings (a
 *  zero-borrow loan's `calculateHealthFactor` returns uint256.max). */
const HEALTHY_MILLI_CAP = 1_000_000;

/** Mirrors the indexer's calendar-row sentinel (calendarNotifications
 *  .ts CRON_LOG_INDEX — duplicated because Workers are separate
 *  packages): keeps a head-stamped cron row strictly newer than any
 *  real log in the same block for the feed's (block, logIndex, id)
 *  order and the client read cursor. */
export const CRON_LOG_INDEX = 1_000_000;

const BAND_RANK: Record<HfBand, number> = {
  healthy: 0,
  warn: 1,
  alert: 2,
  critical: 3,
};

const BAND_KIND: Record<Exclude<HfBand, 'healthy'>, string> = {
  warn: 'hf_warn',
  alert: 'hf_alert',
  critical: 'hf_critical',
};

/** 1e18-scaled HF → milli-HF, clamped. uint256.max (zero borrow) and
 *  any absurdly large reading collapse to the healthy cap. */
export function hfToMilli(hf: bigint): number {
  if (hf >= BigInt(HEALTHY_MILLI_CAP) * 10n ** 15n) return HEALTHY_MILLI_CAP;
  return Number(hf / 10n ** 15n);
}

export function classifyBand(hfMilli: number): HfBand {
  if (hfMilli < HF_CRITICAL_MILLI) return 'critical';
  if (hfMilli < HF_ALERT_MILLI) return 'alert';
  if (hfMilli < HF_WARN_MILLI) return 'warn';
  return 'healthy';
}

/** IN()-list width — keeps every chunked statement's bind count far
 *  under D1/SQLite variable limits. */
const IN_CHUNK = 90;
/** Notification INSERT chunk — 9 binds per row, 500 × 9 = 4500 stays
 *  under D1's ~5000-binding invocation cap (same bound the indexer's
 *  insertNotificationRows uses). */
const INSERT_CHUNK = 500;

export interface HfReading {
  id: bigint;
  hf: bigint;
}

export interface HfBandResult {
  inserted: number;
  stateWrites: number;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * Record band crossings for one chain's full active-book HF readings.
 * Called from the liquidator pass with EVERY successful reading (not
 * just the at-risk subset). Fail-open: returns zeros on any error.
 */
export async function recordHfBandNotifications(
  db: D1Database,
  chainId: number,
  readings: HfReading[],
  nowSec: number,
): Promise<HfBandResult> {
  const empty: HfBandResult = { inserted: 0, stateWrites: 0 };
  if (readings.length === 0) return empty;
  try {
    // Head block for the feed's chain-order stamp — the indexer's own
    // cursor on the shared DB. No cursor row means the indexer has
    // never scanned this chain: the loans table has no recipients to
    // resolve anyway, so skip the whole pass this tick.
    const cursor = await db
      .prepare(
        `SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = 'diamond'`,
      )
      .bind(chainId)
      .first<{ last_block: number }>();
    if (!cursor) return empty;
    const headBlock = cursor.last_block;

    // Prune state for loans that left the active set (repaid/defaulted/
    // liquidated) — their terminal inbox rows come from the indexer's
    // event materializer; keeping band state would only re-alert a
    // re-observed id. Runs every pass (BEFORE the early returns — a
    // quiet book still prunes). Bounded: hf_band_state holds only
    // at-risk loans.
    await db
      .prepare(
        `DELETE FROM hf_band_state
          WHERE chain_id = ?1
            AND EXISTS (
              SELECT 1 FROM loans l
               WHERE l.chain_id = ?1 AND l.loan_id = hf_band_state.loan_id
                 AND l.status <> 'active'
            )`,
      )
      .bind(chainId)
      .run();

    const observed = readings.map((r) => {
      const milli = hfToMilli(r.hf);
      return { loanId: Number(r.id), milli, band: classifyBand(milli) };
    });

    // Stored band per loan (absence = healthy; healthy loans carry no
    // row — see migration 0041).
    const prevBand = new Map<number, HfBand>();
    for (let i = 0; i < observed.length; i += IN_CHUNK) {
      const chunk = observed.slice(i, i + IN_CHUNK);
      const res = await db
        .prepare(
          `SELECT loan_id, last_band FROM hf_band_state
            WHERE chain_id = ? AND loan_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(chainId, ...chunk.map((o) => o.loanId))
        .all<{ loan_id: number; last_band: HfBand }>();
      for (const row of res.results ?? []) prevBand.set(row.loan_id, row.last_band);
    }

    const changed = observed.filter(
      (o) => o.band !== (prevBand.get(o.loanId) ?? 'healthy'),
    );
    if (changed.length === 0) return empty;
    const downgraded = changed.filter(
      (o) => BAND_RANK[o.band] > BAND_RANK[prevBand.get(o.loanId) ?? 'healthy'],
    );

    // Borrower recipients for the downgrades — the CURRENT position
    // holder from the shared loans table.
    const recipientByLoan = new Map<number, string>();
    for (let i = 0; i < downgraded.length; i += IN_CHUNK) {
      const chunk = downgraded.slice(i, i + IN_CHUNK);
      const res = await db
        .prepare(
          `SELECT loan_id, borrower, borrower_current_owner FROM loans
            WHERE chain_id = ? AND loan_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(chainId, ...chunk.map((o) => o.loanId))
        .all<{
          loan_id: number;
          borrower: string | null;
          borrower_current_owner: string | null;
        }>();
      for (const row of res.results ?? []) {
        const who = (row.borrower_current_owner ?? row.borrower ?? '').toLowerCase();
        if (who && who !== ZERO_ADDR) recipientByLoan.set(row.loan_id, who);
      }
    }

    // Mint the downgrade rows. A downgrade whose recipient can't be
    // resolved yet (indexer lag — the loan row hasn't landed) is
    // DEFERRED: no row AND no state write, so the next tick retries
    // the same crossing instead of silently swallowing it.
    const dayBucket = Math.floor(nowSec / 86_400);
    interface Row {
      loanId: number;
      recipient: string;
      kind: string;
      dedupKey: string;
    }
    const rows: Row[] = [];
    const deferred = new Set<number>();
    for (const o of downgraded) {
      const recipient = recipientByLoan.get(o.loanId);
      if (!recipient) {
        deferred.add(o.loanId);
        continue;
      }
      const kind = BAND_KIND[o.band as Exclude<HfBand, 'healthy'>];
      rows.push({
        loanId: o.loanId,
        recipient,
        kind,
        // Same segment order as the indexer's producers
        // (`chain:recipient:kind:loan:<discriminator>`); the day bucket
        // bounds a flapping HF to one row per band per UTC day.
        dedupKey: `${chainId}:${recipient}:${kind}:${o.loanId}:${dayBucket}`,
      });
    }

    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const batch = rows.slice(i, i + INSERT_CHUNK).map((r) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO notifications
               (chain_id, recipient, kind, loan_id, event_kind,
                block_number, log_index, created_at, dedup_key)
             VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          )
          .bind(
            chainId,
            r.recipient,
            r.kind,
            r.loanId,
            headBlock,
            CRON_LOG_INDEX,
            nowSec,
            r.dedupKey,
          ),
      );
      const results = await db.batch(batch);
      for (const res of results) {
        inserted += (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
      }
    }

    // Commit the observed band for every change EXCEPT deferred
    // downgrades (those retry next tick). Recoveries to healthy DELETE
    // the row — absence means healthy, keeping the table proportional
    // to the at-risk book.
    let stateWrites = 0;
    const commits = changed.filter((o) => !deferred.has(o.loanId));
    for (let i = 0; i < commits.length; i += INSERT_CHUNK) {
      const batch = commits.slice(i, i + INSERT_CHUNK).map((o) =>
        o.band === 'healthy'
          ? db
              .prepare(
                `DELETE FROM hf_band_state WHERE chain_id = ? AND loan_id = ?`,
              )
              .bind(chainId, o.loanId)
          : db
              .prepare(
                `INSERT INTO hf_band_state
                   (chain_id, loan_id, last_band, last_hf_milli, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (chain_id, loan_id) DO UPDATE SET
                   last_band = excluded.last_band,
                   last_hf_milli = excluded.last_hf_milli,
                   updated_at = excluded.updated_at`,
              )
              .bind(chainId, o.loanId, o.band, o.milli, nowSec),
      );
      await db.batch(batch);
      stateWrites += batch.length;
    }

    return { inserted, stateWrites };
  } catch (err) {
    console.error(
      `[keeper] hfBandNotifications chain=${chainId} failed (fail-open): ${String(err).slice(0, 250)}`,
    );
    return empty;
  }
}
