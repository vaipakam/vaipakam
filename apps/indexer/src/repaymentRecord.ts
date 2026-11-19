/**
 * #3778 — the repayment record: a count of what one address did as a
 * borrower or renter on this platform, from the platform's own events
 * (`docs/DesignsAndPlans/RepaymentRecordDesign.md`).
 *
 *   GET /repayment-record/{address}?chainId=<id>
 *
 * WHAT IT IS. Counted facts, each with the block they are true as of. It is
 * not a score: no figure is combined with another, nothing is ranked or
 * coloured, and every answer carries the statements of design §4.2. No
 * contract reads it.
 *
 * THE DERIVATION (version {@link RECORD_VERSION}; a change raises it). Read
 * only from rows the indexer already keeps: `loan_participants` (who held
 * the borrower position, and from when), `loans` (status, kind, the sale
 * vehicle flag) and `activity_events` (every decoded event, with its block
 * time). For each loan the address ever held as borrower:
 *
 *  - WHO IT COUNTS FOR. A loan, a period or an interest payment counts for
 *    the address that held the borrower position at the event's block time:
 *    the borrower participant with the latest acquisition at or before it.
 *    A loan taken over and then repaid counts for the one who closed it,
 *    under "took over later".
 *  - HOW A LOAN CLOSED. The closing repayment route wins when there is one
 *    (the last of: a full `LoanRepaid`, `LoanPreclosedDirect`,
 *    `OffsetCompleted`, `LoanRefinanced` on the old loan, `SwapToRepayExecuted`,
 *    `SwapToRepayIntentFilled`, `PrepayCollateralSaleSettled`), so a loan
 *    cured out of the fallback and then repaid is repaid. Otherwise the
 *    FIRST event that began the forced close decides: an HF liquidation
 *    (`HFLiquidationTriggered`, `LiquidationDiscounted`), a default
 *    (`LoanDefaulted`, `LoanFallbackPending`), or a `LiquidationFallback`
 *    with no default event in its transaction (the HF route's fallback). A
 *    fully matched internal liquidation (status `internal_matched`, timed by
 *    its `LoanStatusChanged` edge) is a liquidation. A closed loan none of this classifies is counted as
 *    unclassified; no class is guessed.
 *  - ON TIME OR AFTER THE DUE DATE, read from time and never from the late
 *    fee alone (design §4.4). A full `LoanRepaid` carrying `lateFeeFrom` is
 *    on time when its block time is not after it. Without it: a late fee
 *    means after the due date; otherwise a repayment no later than the due
 *    date the chain stated at the loan's start (`LoanInitiatedDetails`) is
 *    on time, and any other is unclassified (a pause or an extension may
 *    have moved the due date). A preclose and an offset close before the
 *    due date by the contract's own rule, so they are on time.
 *  - PERIODS. `PeriodicInterestSettled` is a period closed with no sale of
 *    collateral; `PeriodicInterestAutoLiquidated` is one collected by a sale
 *    after the grace.
 *  - INTEREST PAID. Per token, the sum of `LoanInterestPaid` less
 *    `LoanInterestUndelivered`, in the token's own units.
 *  - RENTALS. A loan whose lent asset is an NFT is a rental: completed when
 *    it closed by a repayment route, ended by default when it closed by a
 *    default or liquidation.
 *  - A closed loan whose closing time the index does not hold is placed by
 *    the current holder of its borrower position.
 *  - LEFT OUT. The vehicle loans a lender's sale creates.
 *
 * NOT STATED YET. The fees paid to the platform: the events do not state a
 * loan's initiation fee or the treasury's share of every interest payment
 * per loan, so the figure cannot be derived without a guess. The answer
 * says so (`feesPaid.stated: false`) instead of showing a partial sum.
 */
import { type Env } from './env';
import { redactedError } from '@vaipakam/lib/errorDescription';
import { chainNotServed, requestedChainId } from './servedChain';
import { CURSOR_KIND } from './chainIndexer';

export const RECORD_VERSION = 'repayment-record/1';

/** The statements every view of a record carries (design §4.2). */
export const RECORD_STATEMENTS = Object.freeze([
  'This is a count of what this address did on this platform. It is not a score and not advice.',
  'One person can use many addresses, and a new address has no record. An empty record says nothing bad.',
  'Two addresses can lend to each other to build a record. The fees paid line shows what that would have cost.',
  'Past repayment does not secure a loan. The collateral does.',
]);

/** What the record leaves out, stated with every answer. */
export const RECORD_EXCLUDES = Object.freeze([
  'loans and rentals on other networks (each network is read on its own)',
  'loans before the history this network’s index begins with (historyBegins)',
  "the vehicle loans a lender's sale creates",
  'who paid: a payment by another address counts for the holder',
  'anything outside this platform',
]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The events the derivation reads. */
const REPAY_ROUTE_KINDS = [
  'LoanRepaid',
  'LoanPreclosedDirect',
  'OffsetCompleted',
  'LoanRefinanced',
  'SwapToRepayExecuted',
  'SwapToRepayIntentFilled',
  'PrepayCollateralSaleSettled',
] as const;
const FORCED_KINDS = [
  'HFLiquidationTriggered',
  'LiquidationDiscounted',
  'LoanDefaulted',
  'LoanFallbackPending',
  'LiquidationFallback',
] as const;
const OTHER_KINDS = [
  'LoanStatusChanged',
  'LoanInitiatedDetails',
  'LoanInterestPaid',
  'LoanInterestUndelivered',
  'PeriodicInterestSettled',
  'PeriodicInterestAutoLiquidated',
] as const;
export const RECORD_EVENT_KINDS: readonly string[] = Object.freeze([
  ...REPAY_ROUTE_KINDS,
  ...FORCED_KINDS,
  ...OTHER_KINDS,
]);

/** LoanStatus values a full `LoanRepaid` closes to (Repaid, Settled). */
const CLOSING_REPAID_STATUSES = new Set([1, 3]);

export interface RecordEvent {
  loanId: number;
  kind: string;
  block: number;
  logIndex: number;
  tx: string;
  /** Block time, unix seconds; null when the index does not hold it. */
  at: number | null;
  args: Record<string, unknown>;
}

export interface RecordLoan {
  loanId: number;
  status: string;
  /** 0 = a token loan; any other = an NFT lent (a rental). */
  assetType: number;
  isSaleVehicle: boolean;
  /** The current borrower-position holder, lower case. */
  currentHolder: string | null;
}

export interface Acquisition {
  loanId: number;
  wallet: string;
  fromAt: number;
}

type CloseClass =
  | 'repaidOnTime'
  | 'repaidAfterDue'
  | 'repaidBySale'
  | 'refinanced'
  | 'liquidated'
  | 'defaulted'
  | 'unclassified';

export interface RepaymentRecordFigures {
  loans: {
    closed: number;
    repaidOnTime: number;
    repaidAfterDue: number;
    repaidBySale: number;
    refinanced: number;
    liquidated: number;
    defaulted: number;
    unclassified: number;
    openNow: number;
    openedByThisAddress: number;
    takenOverLater: number;
  };
  rentals: { closed: number; completed: number; endedByDefault: number; unclassified: number; openNow: number };
  interestPeriods: { closedWithoutSale: number; collectedBySale: number };
  interestPaid: { asset: string; total: string }[];
  /** First time this address held a borrower position here; null if never. */
  firstLoanAt: number | null;
}

const OPEN_STATUSES = new Set(['active', 'fallback_pending']);

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
};
const big = (v: unknown): bigint | null =>
  typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : null;

const byPosition = (a: RecordEvent, b: RecordEvent) => a.block - b.block || a.logIndex - b.logIndex;

/** The borrower holder of `loanId` at time `at`: the latest acquisition at or before it. */
export function holderAt(acqs: Acquisition[], loanId: number, at: number): string | null {
  let best: Acquisition | null = null;
  for (const a of acqs) {
    if (a.loanId !== loanId || a.fromAt > at) continue;
    if (!best || a.fromAt > best.fromAt) best = a;
  }
  return best?.wallet ?? null;
}

/** How one loan closed, and when (the last closing event's block time). */
export function classifyClose(
  loan: RecordLoan,
  events: RecordEvent[],
): { cls: CloseClass; at: number | null } {
  const sorted = [...events].sort(byPosition);
  const isClosingRepay = (e: RecordEvent) =>
    (REPAY_ROUTE_KINDS as readonly string[]).includes(e.kind) &&
    (e.kind !== 'LoanRepaid' || CLOSING_REPAID_STATUSES.has(num(e.args.newStatus) ?? -1));
  // A fully matched internal liquidation states its close only as a
  // status edge to InternalMatched (5).
  const matchedEdge = (e: RecordEvent) => e.kind === 'LoanStatusChanged' && num(e.args.to) === 5;
  const closing = sorted.filter(
    (e) => isClosingRepay(e) || (FORCED_KINDS as readonly string[]).includes(e.kind) || matchedEdge(e),
  );
  const at = closing.length > 0 ? closing[closing.length - 1].at : null;

  const repay = [...sorted].reverse().find(isClosingRepay);
  if (repay) {
    switch (repay.kind) {
      case 'LoanRefinanced':
        return { cls: 'refinanced', at };
      case 'SwapToRepayExecuted':
      case 'SwapToRepayIntentFilled':
      case 'PrepayCollateralSaleSettled':
        return { cls: 'repaidBySale', at };
      case 'LoanPreclosedDirect':
      case 'OffsetCompleted':
        return { cls: 'repaidOnTime', at };
      default:
        return { cls: repaidTiming(repay, sorted), at };
    }
  }

  const forced = sorted.find((e) => (FORCED_KINDS as readonly string[]).includes(e.kind));
  if (forced) {
    if (forced.kind === 'HFLiquidationTriggered' || forced.kind === 'LiquidationDiscounted') {
      return { cls: 'liquidated', at };
    }
    if (forced.kind === 'LoanDefaulted' || forced.kind === 'LoanFallbackPending') {
      return { cls: 'defaulted', at };
    }
    // LiquidationFallback: the default route emits its own default event in
    // the same transaction; without one, this is the HF route's fallback.
    const defaultInTx = sorted.some(
      (e) => e.tx === forced.tx && (e.kind === 'LoanDefaulted' || e.kind === 'LoanFallbackPending'),
    );
    return { cls: defaultInTx ? 'defaulted' : 'liquidated', at };
  }
  if (loan.status === 'internal_matched' || sorted.some(matchedEdge)) return { cls: 'liquidated', at };
  return { cls: 'unclassified', at };
}

/** On time or after the due date, for a full `LoanRepaid` (design §4.4). */
function repaidTiming(repay: RecordEvent, events: RecordEvent[]): CloseClass {
  if (repay.at === null) return 'unclassified';
  const lateFeeFrom = num(repay.args.lateFeeFrom);
  if (lateFeeFrom !== null) return repay.at <= lateFeeFrom ? 'repaidOnTime' : 'repaidAfterDue';
  const lateFee = big(repay.args.lateFeePaid);
  if (lateFee !== null && lateFee > 0n) return 'repaidAfterDue';
  const details = events.find((e) => e.kind === 'LoanInitiatedDetails');
  const due = num((details?.args.details as Record<string, unknown> | undefined)?.dueTimestamp);
  if (due !== null && repay.at <= due) return 'repaidOnTime';
  return 'unclassified';
}

/** The record's figures for `address`, from the rows the indexer keeps. */
export function deriveRecord(
  address: string,
  loans: RecordLoan[],
  acqs: Acquisition[],
  events: RecordEvent[],
): RepaymentRecordFigures {
  const me = address.toLowerCase();
  const out: RepaymentRecordFigures = {
    loans: {
      closed: 0,
      repaidOnTime: 0,
      repaidAfterDue: 0,
      repaidBySale: 0,
      refinanced: 0,
      liquidated: 0,
      defaulted: 0,
      unclassified: 0,
      openNow: 0,
      openedByThisAddress: 0,
      takenOverLater: 0,
    },
    rentals: { closed: 0, completed: 0, endedByDefault: 0, unclassified: 0, openNow: 0 },
    interestPeriods: { closedWithoutSale: 0, collectedBySale: 0 },
    interestPaid: [],
    firstLoanAt: null,
  };
  const eventsByLoan = new Map<number, RecordEvent[]>();
  for (const e of events) {
    const list = eventsByLoan.get(e.loanId) ?? [];
    list.push(e);
    eventsByLoan.set(e.loanId, list);
  }
  const counted = new Set(loans.filter((l) => !l.isSaleVehicle).map((l) => l.loanId));
  const mine = acqs.filter((a) => a.wallet === me && counted.has(a.loanId));
  for (const a of mine) {
    if (out.firstLoanAt === null || a.fromAt < out.firstLoanAt) out.firstLoanAt = a.fromAt;
  }
  const heldAt = (loanId: number, at: number | null) => at !== null && holderAt(acqs, loanId, at) === me;

  const interest = new Map<string, bigint>();
  for (const loan of loans) {
    if (loan.isSaleVehicle) continue;
    const evs = eventsByLoan.get(loan.loanId) ?? [];
    const rental = loan.assetType !== 0;

    if (OPEN_STATUSES.has(loan.status)) {
      if (loan.currentHolder === me) {
        if (rental) out.rentals.openNow++;
        else out.loans.openNow++;
      }
    } else {
      const { cls, at } = classifyClose(loan, evs);
      // Placed by the holder at the closing event's time. When the index
      // holds no closing time (a matched internal liquidation names only
      // its first leg), it is placed by the current holder of the borrower
      // position, which a closed position keeps unless it is sent on.
      const counts = at !== null ? heldAt(loan.loanId, at) : loan.currentHolder === me;
      if (counts) {
        if (rental) {
          out.rentals.closed++;
          if (cls === 'liquidated' || cls === 'defaulted') out.rentals.endedByDefault++;
          else if (cls === 'unclassified') out.rentals.unclassified++;
          else out.rentals.completed++;
        } else {
          out.loans.closed++;
          out.loans[cls]++;
          const first = acqs
            .filter((a) => a.loanId === loan.loanId)
            .reduce<Acquisition | null>((m, a) => (!m || a.fromAt < m.fromAt ? a : m), null);
          if (first?.wallet === me) out.loans.openedByThisAddress++;
          else out.loans.takenOverLater++;
        }
      }
    }

    for (const e of evs) {
      if (!heldAt(loan.loanId, e.at)) continue;
      if (e.kind === 'PeriodicInterestSettled') out.interestPeriods.closedWithoutSale++;
      else if (e.kind === 'PeriodicInterestAutoLiquidated') out.interestPeriods.collectedBySale++;
      else if (e.kind === 'LoanInterestPaid' || e.kind === 'LoanInterestUndelivered') {
        const asset = typeof e.args.asset === 'string' ? e.args.asset.toLowerCase() : null;
        const gross = big(e.args.gross);
        if (!asset || gross === null) continue;
        const sign = e.kind === 'LoanInterestPaid' ? 1n : -1n;
        interest.set(asset, (interest.get(asset) ?? 0n) + sign * gross);
      }
    }
  }
  out.interestPaid = [...interest.entries()]
    .filter(([, total]) => total !== 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    // A sum below zero would mean an undelivered statement with no matching
    // payment in this address's holding; it is stated as zero, never negative.
    .map(([asset, total]) => ({ asset, total: (total < 0n ? 0n : total).toString() }));
  return out;
}

function json(body: unknown, status = 200, cacheSeconds = 30): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  });
}

export function handleRepaymentRecordPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** `GET /repayment-record/{address}?chainId=` */
export async function handleRepaymentRecord(req: Request, env: Env, addressRaw: string): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  if (!ADDRESS_RE.test(addressRaw)) return json({ error: 'bad-address' }, 400);
  const address = addressRaw.toLowerCase();

  // Every loan this address ever held as borrower, read once as a subquery.
  const held = `SELECT DISTINCT loan_id FROM loan_participants
                 WHERE chain_id = ? AND wallet = ? AND role = 'borrower'`;
  const kinds = RECORD_EVENT_KINDS.map(() => '?').join(',');
  try {
    // The cursor is read first in the same batch, so asOf describes the
    // state the figures were read from.
    const [cursor, deployment, loanRows, acqRows, eventRows] = await env.DB.batch([
      env.DB.prepare(`SELECT last_block, updated_at FROM indexer_cursor WHERE chain_id = ? AND kind = ?`).bind(
        chainId,
        CURSOR_KIND,
      ),
      env.DB.prepare(`SELECT deploy_block, adopted_at FROM indexer_deployment WHERE chain_id = ?`).bind(chainId),
      env.DB.prepare(
        `SELECT loan_id, status, asset_type, is_sale_vehicle, borrower_current_owner
           FROM loans WHERE chain_id = ? AND loan_id IN (${held})`,
      ).bind(chainId, chainId, address),
      env.DB.prepare(
        `SELECT loan_id, wallet, from_at FROM loan_participants
          WHERE chain_id = ? AND role = 'borrower' AND loan_id IN (${held})`,
      ).bind(chainId, chainId, address),
      env.DB.prepare(
        `SELECT loan_id, kind, block_number, log_index, tx_hash, block_at, args_json
           FROM activity_events
          WHERE chain_id = ? AND kind IN (${kinds}) AND loan_id IN (${held})`,
      ).bind(chainId, ...RECORD_EVENT_KINDS, chainId, address),
    ]);
    const loans: RecordLoan[] = (
      (loanRows.results ?? []) as {
        loan_id: number;
        status: string;
        asset_type: number;
        is_sale_vehicle: number;
        borrower_current_owner: string | null;
      }[]
    ).map((r) => ({
      loanId: r.loan_id,
      status: r.status,
      assetType: r.asset_type,
      isSaleVehicle: r.is_sale_vehicle === 1,
      currentHolder: r.borrower_current_owner?.toLowerCase() ?? null,
    }));
    const acqs: Acquisition[] = (
      (acqRows.results ?? []) as { loan_id: number; wallet: string; from_at: number }[]
    ).map((r) => ({ loanId: r.loan_id, wallet: r.wallet.toLowerCase(), fromAt: r.from_at }));
    const events: RecordEvent[] = [];
    for (const r of (eventRows.results ?? []) as {
      loan_id: number;
      kind: string;
      block_number: number;
      log_index: number;
      tx_hash: string;
      block_at: number | null;
      args_json: string;
    }[]) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(r.args_json) as Record<string, unknown>;
      } catch {
        // An unreadable row is left without args; the classifier then
        // cannot use it for timing and says so as unclassified.
      }
      events.push({
        loanId: r.loan_id,
        kind: r.kind,
        block: r.block_number,
        logIndex: r.log_index,
        tx: r.tx_hash,
        at: r.block_at,
        args,
      });
    }
    const c = (cursor.results?.[0] ?? null) as { last_block: number; updated_at: number } | null;
    const d = (deployment.results?.[0] ?? null) as { deploy_block: number; adopted_at: number } | null;
    return json({
      version: RECORD_VERSION,
      chainId,
      address,
      asOf: { block: c?.last_block ?? null, indexedAt: c?.updated_at ?? null },
      // The record on this network starts with the Diamond the index adopted.
      historyBegins: d ? { block: d.deploy_block } : null,
      ...deriveRecord(address, loans, acqs, events),
      feesPaid: {
        stated: false,
        reason:
          'The events do not yet state each loan’s initiation fee and the platform’s share of each interest payment, so this figure is not derived.',
      },
      statements: RECORD_STATEMENTS,
      excludes: RECORD_EXCLUDES,
    });
  } catch (err) {
    console.error('[repaymentRecord] read failed', redactedError(err));
    return json({ error: 'record-unavailable' }, 503, 0);
  }
}
