/**
 * In-app notification center (#1213 / E-11) — the write-side
 * materialization, PR 1.
 *
 * `materializeNotifications` runs on the ingest scan tail, right after
 * `activity_events` is written, and derives per-RECIPIENT inbox rows
 * (table `notifications`, migration 0038) from the loan-lifecycle
 * events already decoded in the scan. The connected app then renders a
 * free wallet-native inbox from a plain `WHERE recipient = ?` read.
 *
 * Design (docs/DesignsAndPlans/InAppNotificationCenterDesign.md):
 *   - One row per (recipient wallet, notification). A both-parties
 *     event materializes two rows.
 *   - Recipients resolve to the CURRENT position-NFT holder
 *     (`*_current_owner`) at materialization time — the design's
 *     ownership discipline (a secondary-market buyer is notified, an
 *     exited seller and a burned/cash-satisfied side are not). See
 *     `recipientFor` for the exact cases this gets right.
 *   - Idempotent: every row carries a deterministic `dedup_key`; a
 *     re-scan / catch-up re-runs `INSERT OR IGNORE` with no duplicates.
 *   - Truncation-free: this is a bounded per-scan derivation (a scan
 *     has a bounded log count), not a capped hint.
 *
 * This PR ships every loan-lifecycle TERMINAL/repay row (matched,
 * partial repay, and each distinct repaid / defaulted / liquidated /
 * internal-match close-out — the contracts emit several of these under
 * their own terminal event with no generic LoanRepaid/LoanDefaulted
 * companion, so each is mapped explicitly). Offer-matched,
 * periodic-interest, secondary-market transfers, the time-based calendar
 * rows (maturity / grace) and the liquid-only HF-band rows are follow-ups
 * — each source event is consciously deferred in
 * `NOTIF_DELIBERATELY_NOT_HANDLED` (the coverage guardrail enforces that
 * every loan/offer state-change event is mapped OR allowlisted).
 */

/** Notification taxonomy — the row's `kind`, distinct from the raw
 *  contract event. The client renders copy + icon from this. */
export const NOTIF_KINDS = [
  'loan_matched',
  'partial_repay',
  'loan_repaid',
  'loan_defaulted',
  'internal_matched',
] as const;
export type NotifKind = (typeof NOTIF_KINDS)[number];

/** Which loan parties a notification is FOR. */
type Recipients = 'both' | 'lender' | 'borrower';

interface NotifMapping {
  kind: NotifKind;
  recipients: Recipients;
}

/**
 * Source contract event → notification mapping. The coverage guardrail
 * (`check-notification-coverage.mjs`) requires every
 * `state-change/{loan,offer}-mutation` event to appear here OR in
 * `NOTIF_DELIBERATELY_NOT_HANDLED`.
 */
export const EVENT_NOTIF_MAP: Readonly<Record<string, NotifMapping>> = {
  LoanInitiated: { kind: 'loan_matched', recipients: 'both' },
  PartialRepaid: { kind: 'partial_repay', recipients: 'lender' },
  LoanRepaid: { kind: 'loan_repaid', recipients: 'both' },
  LoanDefaulted: { kind: 'loan_defaulted', recipients: 'both' },
  // Swap-to-repay is a DISTINCT repayment path: it flips the position
  // status inline and emits its OWN event WITHOUT a LoanRepaid /
  // PartialRepaid companion (SwapToRepayFacet.sol), so it must map
  // directly or those repayments produce no inbox row (Codex #1292 r1).
  SwapToRepayExecuted: { kind: 'loan_repaid', recipients: 'both' },
  SwapToRepayPartialExecuted: { kind: 'partial_repay', recipients: 'lender' },
  // Backstop absorption terminalizes the loan to Defaulted via
  // `terminalizeFromAny` and emits ONLY `BackstopAbsorbedLoan` — no
  // `LoanDefaulted` companion (ClaimFacet.sol) — so the affected
  // borrower would otherwise get no terminal row (Codex #1292 r1). The
  // lender NFT is burned in this path, so `recipientFor` skips that
  // side; the borrower (with the residual collateral claim) is notified.
  BackstopAbsorbedLoan: { kind: 'loan_defaulted', recipients: 'both' },
  // HF-based liquidation is a DISTINCT terminal path from a time-based
  // default: the full-close (RiskFacet.sol:930) and split-terminal
  // (RiskSplitLiquidationFacet.sol:368) both `terminalize`→Defaulted and
  // emit ONLY `HFLiquidationTriggered`; the flash-loan discount close
  // (RiskFacet.sol:1665) emits ONLY `LiquidationDiscounted`. Neither
  // emits a `LoanDefaulted` companion, so without these mappings a real
  // HF liquidation gives both holders no terminal row (Codex #1292 r4).
  //
  // The indexer projects these two events to `loans.status = 'defaulted'`
  // (chainIndexer.ts HF branches, #1293) — they emit no `LoanDefaulted`
  // companion, so before #1293 the loan was stranded 'active' and the
  // terminal-status gate suppressed the row. With the projection in place
  // the gate passes and a real HF liquidation now produces the terminal
  // row. (The gate still protects the PARTIAL InternalMatchExecuted leg,
  // which legitimately stays active.)
  //
  // (The PARTIAL HF liquidation is a separate event, `LoanPartiallyLiquidated`,
  // allowlisted below — the loan stays active there.)
  HFLiquidationTriggered: { kind: 'loan_defaulted', recipients: 'both' },
  LiquidationDiscounted: { kind: 'loan_defaulted', recipients: 'both' },
  // Terminal repayment close-outs that flip the loan to Repaid inline and
  // emit ONLY their own event (dedicated indexer branches, verified: no
  // LoanRepaid companion in PrecloseFacet / RefinanceFacet /
  // LibSwapToRepayIntentSettlement) — Codex #1292 r5. Without these
  // mappings a preclose / offset / refinance / intent-fill full repayment
  // produces no inbox row.
  SwapToRepayIntentFilled: { kind: 'loan_repaid', recipients: 'both' },
  LoanPreclosedDirect: { kind: 'loan_repaid', recipients: 'both' },
  OffsetCompleted: { kind: 'loan_repaid', recipients: 'both' },
  LoanRefinanced: { kind: 'loan_repaid', recipients: 'both' },
  // Internal-match close (RiskMatchLiquidationFacet) — a MULTI-loan event
  // (loanIdA/B/C) that terminalizes each involved leg with no per-leg
  // LoanRepaid/LoanDefaulted companion (Codex #1292 r5). Handled specially
  // in `loanIdsOf` (the triple) — both parties of each closed leg are
  // notified to check the Claim Center, where the exact terminal status
  // and any residual are re-verified on chain. A PARTIAL match only reduces
  // principal/collateral and leaves the leg 'active' (the indexer flips to
  // 'internal_matched' ONLY on a full close); `planNotifications`'s
  // terminal-status gate suppresses the row for those partial legs so a
  // still-open loan can't get a false "closed" row (Codex #1292 r7).
  InternalMatchExecuted: { kind: 'internal_matched', recipients: 'both' },
};

/**
 * Loan/offer state-change events that deliberately produce NO inbox row
 * in this PR — each with a one-line reason. `PR2:` entries are queued
 * for the follow-up (offer-matched, periodic-interest, richer terminal
 * variants, calendar + HF cron); the rest are internal / companion /
 * transient signals with no user-facing meaning. Consumed by the
 * coverage guardrail so a NEW loan/offer event must be mapped above or
 * allowlisted here — notification drift fails CI the same way indexer
 * drift does.
 */
export const NOTIF_DELIBERATELY_NOT_HANDLED: Readonly<Record<string, string>> = {
  // ── PR2 — queued for the follow-up ──────────────────────────────
  OfferMatched: 'PR2 — "your offer matched (X of Y)" to both offer creators',
  OfferAccepted: 'PR2 — "your offer was accepted" to the offer creator',
  PeriodicInterestSettled: 'PR2 — periodic-interest settled row to the lender',
  LoanSettled: 'PR2 — folded into the claim-available row precision pass',
  LoanSaleCompleted: 'PR2 — secondary-market sale completed → new/old lender',
  LoanSold: 'PR2 — secondary-market sale → both sides',
  LoanObligationTransferred: 'PR2 — obligation transfer → both sides',
  LoanExtended: 'PR2 — loan extended → both sides',
  PeriodicInterestAutoLiquidated: 'PR2 — periodic-interest auto-liquidation → borrower',
  // ── Companion detail events (their primary event IS mapped) ─────
  LoanInitiatedDetails: 'companion to LoanInitiated (mapped) — no separate row',
  // ── Internal / companion / transient — no user-facing notification ─
  OfferCreated: 'own action — the creator initiated it; no inbound notification',
  OfferCreatedDetails: 'companion to OfferCreated — no row',
  OfferModified: 'own action — the creator repriced their own offer',
  OfferCanceled: 'own action — the creator cancelled their own offer',
  OfferCanceledDetails: 'companion to OfferCanceled — no row',
  OfferClosed: 'bookkeeping status flip — no distinct user meaning',
  OfferConsumedBySale: 'surfaced via the sale terminal rows (PR2), not the consume marker',
  OfferKeeperEnabled: 'per-offer keeper authorization — own config action',
  LoanKeeperEnabled: 'per-loan keeper authorization — own config action',
  OffsetOfferCreated: 'own action — offset offer creation',
  LoanSaleOfferLinked: 'internal linkage breadcrumb — no user meaning',
  CollateralAdded: 'own action — the borrower topped up their own collateral',
  LoanFallbackPending: 'transient — status stays active through the fallback episode',
  LoanCuredFromFallback: 'transient — pairs with LoanFallbackPending',
  LoanLiquidated: 'declared but never `emit`ted (DefaultedFacet.sol) — the time-based liquidation close-out sets the NFT LoanLiquidated status and emits LoanDefaulted (mapped), so a liquidation already produces a loan_defaulted row (Codex #1292 r3)',
  LoanPartiallyLiquidated: 'partial-liquidation companion — loan stays ACTIVE with reduced size (NOT terminal), unlike the mapped terminal HFLiquidationTriggered',
  AutoDailyDeducted: 'NFT-rental daily-fee deduction — high-frequency, not per-event notified',
  AutoListOptOutCleared: 'UI-facing auto-list signal — no loan-state notification',
  PartialCollateralWithdrawn: 'own action — the borrower withdrew their own excess collateral',
  RepayPartialPeriodAdvanced: 'companion to PartialRepaid (mapped) — no separate row',
  PrepayListingPosted: 'own action — the borrower listed their own collateral for prepay sale',
  PrepayListingUpdated: 'own action — the borrower repriced their own listing',
  PrepayListingCanceled: 'own action — the borrower cancelled their own listing',
  PrepayListingMatched: 'auto-list rotation breadcrumb — no user-state change',
  PrepayCollateralSaleSettled: 'proceeds land in the vault; terminal loan row arrives via LoanRepaid/Settled',
  PrepaySaleListingSynced: 'permissionless sanctions-sync breadcrumb — no user meaning',
  PrepaySaleOfferSynced: 'offer-keyed sanctions-sync breadcrumb — no user meaning',
  OfferSaleProceedsCredited: 'vault-credit breadcrumb — surfaced on the balance pane, not the inbox',
  OfferSaleProceedsSplit: 'per-recipient split breakdown — terminal loan row covers the user',
  PostParallelSaleListing: 'UI-facing OpenSea listing breadcrumb — no loan-state notification',
  ParallelSaleLockReleased: 'non-destructive unwind — offer stays open, no user meaning',
  SwapToRepayIntentCommitted: 'own action — the borrower committed a swap intent',
  SwapToRepayIntentCancelled: 'own action — the borrower cancelled their swap intent',
  SwapToRepayIntentForceCancelled: 'keeper force-cancel — no distinct user-facing state',
};

/** The minimal source-log shape this module needs (structurally
 *  compatible with the ingest's `DecodedLog`). */
export interface NotifSourceLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * The indexer's terminal loan statuses (`loans.status` string values —
 * see `LOAN_STATUS_TO_INDEXER_TERMINAL` in chainIndexer.ts). A terminal
 * KIND of notification (`loan_repaid` / `loan_defaulted` /
 * `internal_matched`) is only materialized when the loan the indexer has
 * PROJECTED is actually in one of these — see the gate in
 * `planNotifications` (Codex #1292 r7).
 */
const TERMINAL_LOAN_STATUSES = new Set([
  'repaid',
  'defaulted',
  'settled',
  'liquidated',
  'internal_matched',
]);

/** The notification kinds that assert a loan has CLOSED — a row deep-links
 *  the recipient to the Claim Center. Gated on the projected loan status so
 *  a still-active loan can't get a false "closed" row (Codex #1292 r7). */
const TERMINAL_NOTIF_KINDS = new Set<NotifKind>([
  'loan_repaid',
  'loan_defaulted',
  'internal_matched',
]);

function isTerminalStatus(status: string | null | undefined): boolean {
  return status != null && TERMINAL_LOAN_STATUSES.has(status);
}

/** A loan's parties + projected state as the recipient resolution and the
 *  materialization gates need them. */
interface LoanParties {
  lender: string | null;
  borrower: string | null;
  lenderCurrentOwner: string | null;
  borrowerCurrentOwner: string | null;
  /** The indexer's projected `loans.status` at the scan's end (see
   *  `isTerminalStatus`). Null for an unknown loan. */
  status: string | null;
  /** True for a lender-sale VEHICLE's temporary bookkeeping loan
   *  (`loans.is_sale_vehicle = 1`) — excluded from a `loan_matched` row. */
  isSaleVehicle: boolean;
}

/**
 * Resolve the notification recipient wallet for a side — the CURRENT
 * position-NFT holder (`*_current_owner`, kept authoritative by the
 * Transfer / sale / accept-seed / claim-burn handlers), falling back to
 * the origination party only for legacy rows without the column.
 *
 * This is the design's ownership discipline (issue #1213): "recipients
 * resolve to the current position-NFT holders at materialization time,
 * NEVER the original loan parties — original-party rows would miss
 * secondary buyers and ping sellers who exited." Concretely it makes
 * three cases correct that the immutable `lender`/`borrower` fields get
 * wrong (all three flagged by Codex #1292 r3):
 *   - a `LoanInitiated` whose offer NFT was transferred BEFORE accept:
 *     `loans.lender` is the origination `offer.creator`, but the matched
 *     position was seeded to `lender_current_owner` — so the loan_matched
 *     row reaches the wallet that actually holds the new position;
 *   - a backstop absorption: the lender NFT is BURNED and cash-satisfied,
 *     so `lender_current_owner` is `0x0` → skipped here → the cashed-out
 *     lender is not spuriously pinged; the live borrower (residual claim)
 *     is notified;
 *   - a secondary-market sale: the current holder, who now owns the
 *     claim, is notified rather than the exited seller.
 *
 * "At materialization time" means the holder as of the scan's end — the
 * intended semantic: a claim follows the NFT, so whoever holds it when
 * the row materializes is who can act on the notification.
 *
 * Returns null for a burned side (0x0), empty, or unknown loan.
 */
function recipientFor(
  parties: LoanParties | undefined,
  side: 'lender' | 'borrower',
): string | null {
  if (!parties) return null;
  const current =
    side === 'lender' ? parties.lenderCurrentOwner : parties.borrowerCurrentOwner;
  const original = side === 'lender' ? parties.lender : parties.borrower;
  const who = (current ?? original ?? '').toLowerCase();
  if (!who || who === ZERO_ADDR) return null;
  return who;
}

/** Coerce a single arg to a positive loan id (bigint/number). */
function toLoanId(raw: unknown): number | null {
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}

/**
 * The loan id(s) a notification-worthy event concerns. Almost every event
 * carries a single `loanId`; `InternalMatchExecuted` is a MULTI-loan event
 * (loanIdA/B/C, up to three legs — the third is 0 for a two-way match), so
 * it fans out to one notification per closed leg (Codex #1292 r5).
 */
export function loanIdsOf(
  eventName: string,
  args: Record<string, unknown>,
): number[] {
  if (eventName === 'InternalMatchExecuted') {
    return [args.loanIdA, args.loanIdB, args.loanIdC]
      .map(toLoanId)
      .filter((n): n is number => n != null && n > 0);
  }
  // A few close-out events name the closed loan id differently than the
  // usual `loanId` (Codex #1292 r6): `OffsetCompleted(originalLoanId, …)`
  // and `LoanRefinanced(oldLoanId, newLoanId, …)` — the OLD loan is the
  // one that closed (the new refinanced loan gets its own LoanInitiated →
  // loan_matched row). Reading only `args.loanId` would drop both.
  const raw =
    eventName === 'OffsetCompleted'
      ? args.originalLoanId
      : eventName === 'LoanRefinanced'
        ? args.oldLoanId
        : args.loanId;
  const single = toLoanId(raw);
  return single != null ? [single] : [];
}

interface NotifRow {
  chainId: number;
  recipient: string;
  kind: NotifKind;
  loanId: number | null;
  eventKind: string;
  blockNumber: number;
  logIndex: number;
  createdAt: number;
  dedupKey: string;
}

/**
 * Pure planner (exported for the unit test): turn a scan's logs +
 * per-loan parties into the concrete inbox rows to INSERT. No I/O —
 * `materializeNotifications` does the D1 read that feeds `partiesByLoan`
 * and the writes.
 */
export function planNotifications(
  chainId: number,
  logs: NotifSourceLog[],
  partiesByLoan: Map<number, LoanParties>,
  blockTimestamps: Map<bigint, number>,
  nowSec: number,
): NotifRow[] {
  const rows: NotifRow[] = [];
  for (const log of logs) {
    const mapping = EVENT_NOTIF_MAP[log.eventName];
    if (!mapping) continue;
    const sides: ('lender' | 'borrower')[] =
      mapping.recipients === 'both'
        ? ['lender', 'borrower']
        : [mapping.recipients];
    const blockNumber = Number(log.blockNumber);
    const createdAt = blockTimestamps.get(log.blockNumber) ?? nowSec;
    // Self-dedup within this event: a wallet on BOTH sides of the same
    // loan yields one dedup_key twice → collapse. The dedup_key includes
    // loanId so a MULTI-loan event (InternalMatchExecuted) can't collide
    // its legs (same block+logIndex, different loan).
    const seen = new Set<string>();
    for (const loanId of loanIdsOf(log.eventName, log.args)) {
      const parties = partiesByLoan.get(loanId);
      // Gate 1 (Codex #1292 r7) — a lender-sale VEHICLE accept emits a
      // normal `LoanInitiated` for a temporary bookkeeping loan that is
      // excluded from every market surface (`is_sale_vehicle = 1`). A
      // `loan_matched` row would deep-link the buyer/seller to that temp
      // loan; the real secondary-market sale is surfaced by the sale
      // terminal rows (PR2, `LoanSaleCompleted` / `LoanSold`), not here.
      if (mapping.kind === 'loan_matched' && parties?.isSaleVehicle) continue;
      // Gate 2 (Codex #1292 r7) — a TERMINAL-kind row asserts the loan
      // CLOSED (it deep-links to the Claim Center), so only materialize it
      // when the indexer has actually PROJECTED the loan to a terminal
      // status. This suppresses a false "closed" row for a PARTIAL
      // `InternalMatchExecuted` leg — the indexer reduces principal/
      // collateral but leaves status 'active' (only a fully-closed leg
      // flips to 'internal_matched').
      // This gate keys off the END-OF-BATCH projected status — materialize
      // runs after every same-batch status flip — so a properly-handled
      // terminal event (LoanRepaid / LoanDefaulted / swap-to-repay /
      // preclose / offset / refinance / backstop / HF liquidation #1293)
      // has already flipped D1 to terminal and passes.
      if (
        TERMINAL_NOTIF_KINDS.has(mapping.kind) &&
        !isTerminalStatus(parties?.status)
      )
        continue;
      for (const side of sides) {
      const recipient = recipientFor(parties, side);
      if (!recipient) continue;
      const dedupKey = `${chainId}:${recipient}:${mapping.kind}:${loanId}:${blockNumber}:${log.logIndex}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      rows.push({
        chainId,
        recipient,
        kind: mapping.kind,
        loanId,
        eventKind: log.eventName,
        blockNumber,
        logIndex: log.logIndex,
        createdAt,
        dedupKey,
      });
      }
    }
  }
  return rows;
}

/**
 * Materialize inbox rows for a scan's logs. Fail-open: a notification
 * failure must never wedge the ingest scan (the rows are a derived
 * convenience — the authoritative `activity_events` / `loans` writes
 * already succeeded). Returns the number of rows inserted.
 */
export async function materializeNotifications(
  db: D1Database,
  chainId: number,
  logs: NotifSourceLog[],
  blockTimestamps: Map<bigint, number>,
  nowSec: number,
): Promise<number> {
  const worthy = logs.filter((l) => l.eventName in EVENT_NOTIF_MAP);
  if (worthy.length === 0) return 0;

  const loanIds = [
    ...new Set(worthy.flatMap((l) => loanIdsOf(l.eventName, l.args))),
  ];
  if (loanIds.length === 0) return 0;

  const partiesByLoan = new Map<number, LoanParties>();
  try {
    // Chunk the IN-list: D1 caps a statement at 100 bound parameters, so
    // a catch-up scan touching >99 distinct loans would otherwise blow
    // the limit, throw, and (fail-open) skip that scan's rows forever —
    // the cursor has already advanced (Codex #1292 r1). 90 ids + the
    // chainId bind stays safely under the cap.
    const CHUNK = 90;
    for (let i = 0; i < loanIds.length; i += CHUNK) {
      const slice = loanIds.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const res = await db
        .prepare(
          `SELECT loan_id, lender, borrower, lender_current_owner, borrower_current_owner,
                  status, is_sale_vehicle
             FROM loans
            WHERE chain_id = ? AND loan_id IN (${placeholders})`,
        )
        .bind(chainId, ...slice)
        .all<{
          loan_id: number;
          lender: string | null;
          borrower: string | null;
          lender_current_owner: string | null;
          borrower_current_owner: string | null;
          status: string | null;
          is_sale_vehicle: number | null;
        }>();
      for (const r of res.results ?? []) {
        partiesByLoan.set(r.loan_id, {
          lender: r.lender,
          borrower: r.borrower,
          lenderCurrentOwner: r.lender_current_owner,
          borrowerCurrentOwner: r.borrower_current_owner,
          status: r.status,
          isSaleVehicle: (r.is_sale_vehicle ?? 0) === 1,
        });
      }
    }
  } catch (err) {
    console.error('[notifications] party lookup failed', err);
    return 0;
  }

  const rows = planNotifications(chainId, worthy, partiesByLoan, blockTimestamps, nowSec);
  if (rows.length === 0) return 0;

  let inserted = 0;
  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO notifications
         (chain_id, recipient, kind, loan_id, event_kind,
          block_number, log_index, created_at, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Chunk the batch: each row binds 9 params and D1 caps a Worker
    // invocation at ~5000 bindings, so a busy catch-up scan with hundreds
    // of recipient rows would blow the limit, throw, and (fail-open) skip
    // that scan's rows forever. 500 rows × 9 = 4500 binds stays under
    // (Codex #1292 r4).
    const INSERT_CHUNK = 500;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const batch = rows.slice(i, i + INSERT_CHUNK).map((r) =>
        stmt.bind(
          r.chainId,
          r.recipient,
          r.kind,
          r.loanId,
          r.eventKind,
          r.blockNumber,
          r.logIndex,
          r.createdAt,
          r.dedupKey,
        ),
      );
      const results = await db.batch(batch);
      for (const res of results) inserted += res.meta?.changes ?? 0;
    }
  } catch (err) {
    console.error('[notifications] insert failed', err);
    return 0;
  }
  return inserted;
}
