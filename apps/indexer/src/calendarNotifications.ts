/**
 * Calendar notification sweep (#1213 / E-11, PR 2) — the TIME-derived
 * inbox rows the event materializer can't produce: no contract event
 * fires when a due date approaches or a grace window opens quietly.
 *
 *   - `maturity_7d` — the loan is due within 7 days (borrower; they are
 *     the party who can act — repay, extend, or list collateral).
 *   - `maturity_1d` — the loan is due within 1 day (borrower).
 *   - `grace_entered` — the loan is past due and its grace window is
 *     running (BOTH parties, per the design table: the borrower can
 *     still repay with the late fee; the current lender-position holder
 *     learns a default — and their claim — may be near).
 *
 * Runs at the ingest scan tail (chainIndexer.ts), same fail-open
 * discipline as the event materializer: derived convenience rows must
 * never wedge a scan. Pure D1 — no RPC — so it covers ILLIQUID loans
 * too (calendar math needs no oracle), which is exactly the gap the
 * design calls out (HF alerts cover only liquid loans).
 *
 * Correctness notes:
 *   - Maturity is computed from the LIVE `start_time + duration_days`
 *     columns (never the immutable `init_*` history): the LoanExtended
 *     handler rewrites both, and a partial repay resets `start_time`,
 *     so the milestone windows re-derive correctly after either.
 *   - The dedup key embeds the maturity timestamp, so an extension
 *     that pushes the due date out RE-ARMS the milestones (a fresh
 *     T-7d/T-1d row for the new date) while `INSERT OR IGNORE` keeps
 *     every per-maturity milestone one-shot across cron re-runs.
 *   - Rows are stamped with the scan's head block (`block_number`,
 *     `log_index = 0`): the feed orders + keyset-pages by chain order,
 *     and a NULL block would sort a cron row to the bottom AND fall out
 *     of every keyset continuation (`block_number < ?` is NULL-false) —
 *     the 0038 migration's "stamp the head block" note.
 *   - Grace length mirrors `LibVaipakam.gracePeriod` EXACTLY (Codex
 *     #1298 r1): when governance has set custom `graceBuckets`, the
 *     sweep consults the snapshotted array (the `protocol_config`
 *     row's `grace_buckets_json`, refreshed on `GraceBucketsUpdated`
 *     + the 6h backstop — see configSnapshot.ts); an empty/absent
 *     array means the compile-time default schedule, which is what
 *     the retail deploy runs.
 */

import {
  insertNotificationRows,
  recipientFor,
  type LoanParties,
  type NotifKind,
  type NotifRow,
} from './notifications';

/** One governance grace bucket as snapshotted (decimal strings — the
 *  bigint-safe serialization `configSnapshot.serializeTuple` writes). */
export interface GraceBucketJson {
  maxDurationDays: string;
  graceSeconds: string;
}

/** Mirrors LibVaipakam.gracePeriod's zero-bucket default schedule
 *  (same table as apps/alpha02/src/lib/grace.ts). */
export function defaultGraceSeconds(durationDays: number): number {
  if (durationDays < 7) return 3_600;
  if (durationDays < 30) return 86_400;
  if (durationDays < 90) return 3 * 86_400;
  if (durationDays < 180) return 7 * 86_400;
  if (durationDays < 365) return 14 * 86_400;
  return 30 * 86_400;
}

/**
 * The EFFECTIVE grace for a duration — LibVaipakam.gracePeriod's exact
 * semantics (Codex #1298 r1): no buckets → the compile-time default;
 * else walk in array order, `maxDurationDays == 0` is the catch-all,
 * the first bucket whose threshold strictly exceeds durationDays wins,
 * defensive fallback to the last entry.
 */
export function effectiveGraceSeconds(
  durationDays: number,
  buckets: GraceBucketJson[] | null,
): number {
  if (!buckets || buckets.length === 0) return defaultGraceSeconds(durationDays);
  for (const b of buckets) {
    const maxD = Number(b.maxDurationDays);
    if (maxD === 0) return Number(b.graceSeconds);
    if (durationDays < maxD) return Number(b.graceSeconds);
  }
  return Number(buckets[buckets.length - 1].graceSeconds);
}

const DAY = 86_400;
/** The widest DEFAULT grace bucket. The sweep's "recently matured" SQL
 *  window bound uses max(this, widest configured bucket) so a custom
 *  longer-than-30d grace can't fall out of the window early. */
const MAX_DEFAULT_GRACE_SECONDS = 30 * DAY;

/** The widest grace across the effective schedule — bounds the sweep's
 *  look-back so every loan still inside ANY possible grace window is
 *  selected. */
export function maxGraceSeconds(buckets: GraceBucketJson[] | null): number {
  if (!buckets || buckets.length === 0) return MAX_DEFAULT_GRACE_SECONDS;
  let max = 0;
  for (const b of buckets) max = Math.max(max, Number(b.graceSeconds));
  // Defensive: a malformed/empty-values array must never shrink the
  // window below the default (missing a live grace loan is worse than
  // scanning a few extra aged-out rows).
  return Math.max(max, MAX_DEFAULT_GRACE_SECONDS);
}

/**
 * The effective schedule as a SQL CASE over `duration_days` — so the
 * sweep's window predicate is PER-LOAN-grace-aware (Codex #1298 r2): a
 * loan past its OWN grace end emits nothing and must not occupy a
 * LIMIT slot (with the default 3d grace, 30d loans 4–30 days overdue
 * would otherwise fill the soonest-due prefix and starve the emitting
 * tail on every tick). Every number is validated (`Number.isFinite`)
 * before interpolation; any malformed bucket falls back to the default
 * CASE — the same values `effectiveGraceSeconds` computes in JS, so the
 * SQL filter and the planner can never disagree.
 */
export function graceCaseSql(buckets: GraceBucketJson[] | null): string {
  const DEFAULT_CASE =
    `CASE WHEN duration_days < 7 THEN 3600 ` +
    `WHEN duration_days < 30 THEN 86400 ` +
    `WHEN duration_days < 90 THEN 259200 ` +
    `WHEN duration_days < 180 THEN 604800 ` +
    `WHEN duration_days < 365 THEN 1209600 ` +
    `ELSE 2592000 END`;
  if (!buckets || buckets.length === 0) return DEFAULT_CASE;
  const whens: string[] = [];
  let catchAll: number | null = null;
  for (const b of buckets) {
    const maxD = Number(b.maxDurationDays);
    const g = Number(b.graceSeconds);
    if (!Number.isFinite(maxD) || !Number.isFinite(g) || maxD < 0 || g < 0) {
      return DEFAULT_CASE; // malformed snapshot → default (never inject)
    }
    if (maxD === 0) {
      catchAll = g; // the schedule's catch-all marker
    } else {
      whens.push(`WHEN duration_days < ${Math.floor(maxD)} THEN ${Math.floor(g)}`);
    }
  }
  // Defensive fallback mirrors effectiveGraceSeconds: a schedule with no
  // 0-marker uses the last entry's grace as the ELSE.
  const elseG =
    catchAll ?? Number(buckets[buckets.length - 1].graceSeconds);
  if (whens.length === 0) return `${Math.floor(elseG)}`; // constant grace
  return `CASE ${whens.join(' ')} ELSE ${Math.floor(elseG)} END`;
}

/** Fail-loud sweep bound: the maturity window (matured within max-grace,
 *  or due within 7d) should hold at most a few hundred loans per chain;
 *  if it ever exceeds this, log the truncation rather than silently
 *  skipping the tail (no-silent-caps rule). The window keeps shifting,
 *  so a transient overflow self-heals on later ticks. */
const SWEEP_LIMIT = 2000;

/** The log_index stamped on cron rows — a sentinel ABOVE any real
 *  per-block log index (Codex #1298 r2): the feed and the client's
 *  read-state cursor order by (block, logIndex, id), and a real log in
 *  the same head block can carry logIndex > 0 — a cron row at 0 would
 *  sort OLDER than an already-seen event row and never raise the
 *  badge. Blocks hold nowhere near a million logs, so the sentinel
 *  keeps head-stamped cron rows strictly newest within their block. */
export const CRON_LOG_INDEX = 1_000_000;

/** The slice of a `loans` row the calendar planner needs. */
export interface CalendarLoanRow {
  loan_id: number;
  lender: string | null;
  borrower: string | null;
  lender_current_owner: string | null;
  borrower_current_owner: string | null;
  start_time: number;
  duration_days: number;
}

interface Milestone {
  kind: NotifKind;
  /** Window start relative to maturity (seconds; negative = before). */
  fromOffset: number;
  /** Window end relative to maturity (exclusive). */
  toOffset: (durationDays: number, buckets: GraceBucketJson[] | null) => number;
  recipients: 'borrower' | 'both';
}

/** The three calendar milestones. Each fires once per (loan, maturity):
 *  T-7d and T-1d while the loan is still live; grace_entered from the
 *  due date until the grace window closes (past grace end the loan is
 *  liquidatable — a "grace running" nudge would be stale advice, and
 *  the terminal row arrives via the default/liquidation events). */
const MILESTONES: Milestone[] = [
  { kind: 'maturity_7d', fromOffset: -7 * DAY, toOffset: () => 0, recipients: 'borrower' },
  { kind: 'maturity_1d', fromOffset: -1 * DAY, toOffset: () => 0, recipients: 'borrower' },
  {
    kind: 'grace_entered',
    fromOffset: 0,
    toOffset: (durationDays, buckets) => effectiveGraceSeconds(durationDays, buckets),
    recipients: 'both',
  },
];

/**
 * Pure planner (exported for the unit test): which calendar rows are due
 * NOW for these active loans. `headBlock` stamps the rows' chain-order
 * position so the feed sorts them as current. `graceBuckets` is the
 * snapshotted governance schedule (null/empty = the default).
 */
export function planCalendarRows(
  chainId: number,
  loans: CalendarLoanRow[],
  nowSec: number,
  headBlock: number,
  graceBuckets: GraceBucketJson[] | null = null,
): NotifRow[] {
  const rows: NotifRow[] = [];
  for (const loan of loans) {
    if (loan.start_time <= 0) continue; // unhealed stub — no real clock yet
    const maturity = loan.start_time + loan.duration_days * DAY;
    const parties: LoanParties = {
      lender: loan.lender,
      borrower: loan.borrower,
      lenderCurrentOwner: loan.lender_current_owner,
      borrowerCurrentOwner: loan.borrower_current_owner,
      status: 'active',
      isSaleVehicle: false,
    };
    for (const m of MILESTONES) {
      const from = maturity + m.fromOffset;
      const to = maturity + m.toOffset(loan.duration_days, graceBuckets);
      if (nowSec < from || nowSec >= to) continue;
      const sides: ('lender' | 'borrower')[] =
        m.recipients === 'both' ? ['lender', 'borrower'] : ['borrower'];
      const seen = new Set<string>();
      for (const side of sides) {
        const recipient = recipientFor(parties, side);
        if (!recipient) continue;
        // Maturity in the key → an extension re-arms; no block/log in the
        // key → the milestone is one-shot per (loan, maturity) no matter
        // how many cron ticks land inside its window.
        const dedupKey = `${chainId}:${recipient}:${m.kind}:${loan.loan_id}:${maturity}`;
        if (seen.has(dedupKey)) continue; // same wallet on both sides
        seen.add(dedupKey);
        rows.push({
          chainId,
          recipient,
          kind: m.kind,
          loanId: loan.loan_id,
          eventKind: null, // cron-derived — no source event
          blockNumber: headBlock,
          logIndex: CRON_LOG_INDEX, // above any real log in this block
          createdAt: nowSec,
          dedupKey,
        });
      }
    }
  }
  return rows;
}

/** What a sweep did — the inserted count feeds the push rail's
 *  `notification.created` invalidation key, and the affected loan ids
 *  ride the frame hints so client-side relevance scoping keeps the
 *  refetch on the wallets that hold those loans (Codex #1298 r3). */
export interface CalendarSweepResult {
  inserted: number;
  /** Distinct loan ids of the PLANNED rows when anything inserted —
   *  a partially-deduped tick may over-hint slightly, which is safe
   *  (hints only ever ADD relevance, never suppress). */
  loanIds: number[];
}

/** Zero-result sweep — also the scanned path's stand-in when the
 *  full-catch-up gate defers the sweep (exported for chainIndexer). */
export const EMPTY_SWEEP: CalendarSweepResult = { inserted: 0, loanIds: [] };

/**
 * The window SELECT the sweep runs, as one exported builder so the
 * query-plan test pins the EXACT production SQL against migration
 * 0040's `idx_loans_calendar_maturity` (Codex #1298 r4: without the
 * expression index SQLite picked idx_loans_chain_is_stub + a temp
 * B-tree for the ORDER BY, scaling each tick with the chain's whole
 * active set instead of the due/grace window). The fixed predicate
 * terms and the maturity expression must stay textually identical to
 * that index's definition — SQLite matches partial/expression indexes
 * structurally.
 */
export function calendarWindowSql(graceCase: string): string {
  return `SELECT loan_id, lender, borrower, lender_current_owner,
                borrower_current_owner, start_time, duration_days
           FROM loans
          WHERE chain_id = ?
            AND status = 'active'
            AND is_stub = 0 AND is_sale_vehicle = 0
            AND start_time > 0
            AND (start_time + duration_days * 86400) BETWEEN ? AND ?
            AND (start_time + duration_days * 86400 + ${graceCase}) > ?
          ORDER BY (start_time + duration_days * 86400) ASC
          LIMIT ${SWEEP_LIMIT}`;
}

/**
 * The sweep: SELECT the maturity-window slice of active loans and insert
 * any due milestone rows. Fail-open — a hiccup logs and returns an empty
 * result, never wedges the scan (same contract as
 * materializeNotifications).
 */
export async function sweepCalendarNotifications(
  db: D1Database,
  chainId: number,
  nowSec: number,
  headBlock: number,
): Promise<CalendarSweepResult> {
  try {
    // The effective grace schedule — snapshotted governance buckets
    // (configSnapshot.ts refreshes on GraceBucketsUpdated + the 6h
    // backstop); null/absent column or empty array = the compile-time
    // default (Codex #1298 r1).
    const cfg = await db
      .prepare(`SELECT grace_buckets_json FROM protocol_config WHERE chain_id = ?`)
      .bind(chainId)
      .first<{ grace_buckets_json: string | null }>();
    let graceBuckets: GraceBucketJson[] | null = null;
    if (cfg?.grace_buckets_json) {
      try {
        const parsed = JSON.parse(cfg.grace_buckets_json) as GraceBucketJson[];
        if (Array.isArray(parsed) && parsed.length > 0) graceBuckets = parsed;
      } catch {
        // Malformed snapshot → default schedule (fail-open, never wedge).
      }
    }

    // Window: every real active loan whose maturity is within 7d ahead
    // (T-7d arm) or within the WIDEST possible grace behind
    // (grace_entered arm — bucket-derived so a custom longer-than-30d
    // grace can't fall out early). The arithmetic runs in SQLite so the
    // scan never loads the whole active set. Sale-vehicle/stub rows are
    // excluded (bookkeeping, not user loans); there is no loans-side
    // offset-vehicle flag — an offset acceptance re-originates a REAL
    // loan (0031's offers-only rationale), so those rows are
    // legitimately swept.
    //
    // ORDER BY maturity ASC — soonest-due first (Codex #1298 r1): if
    // the window ever holds more than SWEEP_LIMIT loans, the loans
    // whose one-shot windows are closing (in/near grace, T-1d) are
    // always in the served prefix; only the far-out T-7d tail defers,
    // and those have days of window left before their reminder is
    // late. A loan-id order would starve a fixed tail instead.
    //
    // The `maturity + <per-loan grace> > now` leg (Codex #1298 r2) drops
    // loans already past their OWN grace end IN SQL: they emit nothing,
    // so letting them occupy LIMIT slots (e.g. 30d loans 4–30 days
    // overdue under the default 3d grace, which the broad max-grace
    // look-back otherwise keeps selecting) would starve the emitting
    // tail. Every selected row is now pre-maturity or inside its own
    // grace — a LIMIT hit only ever defers rows that WOULD emit.
    const res = await db
      .prepare(calendarWindowSql(graceCaseSql(graceBuckets)))
      .bind(
        chainId,
        nowSec - maxGraceSeconds(graceBuckets),
        nowSec + 7 * DAY,
        nowSec,
      )
      .all<CalendarLoanRow>();
    const loans = res.results ?? [];
    if (loans.length === SWEEP_LIMIT) {
      // Fail-loud, not silent: the window is saturated; the urgent
      // prefix was served, the far-out tail waits for later ticks.
      console.warn(
        `[calendarNotifications] sweep hit LIMIT ${SWEEP_LIMIT} on chain ${chainId} — far-out T-7d tail deferred to later ticks`,
      );
    }
    if (loans.length === 0) return EMPTY_SWEEP;
    const rows = planCalendarRows(chainId, loans, nowSec, headBlock, graceBuckets);
    if (rows.length === 0) return EMPTY_SWEEP;
    const inserted = await insertNotificationRows(db, rows);
    if (inserted === 0) return EMPTY_SWEEP; // pure re-tick — nothing new
    return {
      inserted,
      loanIds: [...new Set(rows.map((r) => r.loanId).filter((id): id is number => id !== null))],
    };
  } catch (err) {
    console.error('[calendarNotifications] sweep failed', err);
    return EMPTY_SWEEP;
  }
}
