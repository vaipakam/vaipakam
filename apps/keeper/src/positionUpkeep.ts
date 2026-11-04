// apps/keeper/src/positionUpkeep.ts
//
// #3097 — the POSITION UPKEEP pass: the permissionless steps on a single loan
// or offer that nothing else calls on a schedule. Each is open to anyone;
// without a keeper it waits for someone to make the call by hand.
//
// Per chain, per run (every hour), in this order:
//
//   1. RENTAL DEDUCTION — `RepayPeriodicFacet.autoDeductDaily(loanId)` for an
//      NFT rental whose next agreed day has elapsed. The day's fee comes out
//      of the renter's own prepayment (already in the renter's vault since
//      acceptance) and is split between the CURRENT lender-position holder and
//      the treasury at the loan's own snapshotted rate; the deduction that
//      uses the last agreed day closes the rental as repaid and leaves the
//      buffer to the renter. Without it the lender is paid only when the
//      renter repays, and a fully used rental is never closed. Candidates are
//      one window of the active-loan list at one pinned block
//      (`activeLoanWindow.ts`), walked a window per run on a larger book, and
//      read from each loan's own record at that block. A loan is sent only
//      when that record shows a day due: an NFT rental, active, its deduction
//      clock at or after its start, a whole day since its last deduction, an
//      agreed day still unused, and a prepayment that covers the day. The
//      pass never charges past the agreed term (the contract leaves rent past
//      maturity to the late fee, never to extra rent days), and never touches
//      a loan whose deduction clock is behind its start (a legacy record,
//      which the contract would charge again and again without the consumed
//      days moving). One deduction per loan per run, so a loan several days
//      behind catches up a day an hour.
//   2. BACKSTOP FILL — `BackstopFacet.backstopFill(offerId)` for a borrower
//      offer that opted into the backstop and is past its eligibility time.
//      The fill lends the TREASURY's capital, staged by governance in the
//      backstop vault under per-pair caps, to the borrower who asked for it
//      at opt-in; the keeper attaches no value and receives nothing (the
//      matcher's share of the loan initiation fee goes to the backstop vault,
//      which is protocol custody), and the fill counts against the keeper's
//      own free-tier service capacity. No view lists the opted-in offers, so
//      the indexer's ledger of `OfferBackstopEligibilitySet` nominates them,
//      a page a run above a floor that moves only on what the finalized block
//      shows (`ledgerRotation.ts`). Every decision is the offer's own record
//      (`getOffer`) against the chain's own clock, and the contract decides
//      the rest (the switches, the collateral's liquidity and oracle
//      coverage, the borrower's sanctions screen, the intent's terms and
//      caps). Off unless BACKSTOP_FILL_ENABLED is also set: whether the
//      keeper key originates treasury-funded loans is its own owner decision.
//
// Every call is simulated on the current state first and sent only when the
// simulation succeeds; each waits for its receipt before the next
// (`stepSender.ts`). Each step has its own share of the run's sends, so one
// cannot starve the other. Outcomes are read from the receipts' own events
// (`AutoDailyDeducted`, `BackstopFilled`) and, for a closing deduction, the
// loan's status after it.
//
// Not here: `ConsolidationFacet.consolidateCollateralToHolder` /
// `consolidatePrincipalToHolder`. Both refuse every caller but the current
// position holder (`NotNFTOwner`), so no keeper call can take; #3097 holds
// them for a contract decision.
//
// Gated by KEEPER_ENABLED + POSITION_UPKEEP_ENABLED (step 2 also by
// BACKSTOP_FILL_ENABLED). Ships disarmed.

import { createPublicClient, decodeEventLog, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { BackstopFacetABI, DIAMOND_ABI_VIEM, LoanFacetABI, OfferCancelFacetABI, RepayPeriodicFacetABI } from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, subStepArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { readActiveWindow, scanCutoffs, type ScanWindow } from './activeLoanWindow';
import { d1EventLedger, type EventLedger } from './eventLedger';
import { attemptOrder, readLedgerRotation } from './ledgerRotation';
import { PassReader } from './passReader';
import { pickBatch } from './rotate';
import { leadStageCutoffMs, runIndex } from './runWindow';
import { d1ScanCursors, type ScanCursors } from './scanCursors';
import { StepSender } from './stepSender';

const pick = (abi: unknown, names: readonly string[]): Abi =>
  (abi as Abi).filter((x) => (x.type === 'function' || x.type === 'event') && names.includes(x.name)) as Abi;

export const ABI = [
  ...pick(RepayPeriodicFacetABI, ['autoDeductDaily', 'AutoDailyDeducted']),
  ...pick(BackstopFacetABI, ['backstopFill', 'BackstopFilled']),
  ...pick(LoanFacetABI, ['getLoanDetails']),
  ...pick(OfferCancelFacetABI, ['getOffer']),
  // Every error the Diamond can revert with, so a refusal from deep in a fill
  // (an intent's cap, a sanctions screen) is named, not hex.
  ...DIAMOND_ABI_VIEM.filter((x) => x.type === 'error'),
] as Abi;

/** The pass's cadence, in seconds; the scheduler reads it from here. A rental
 *  day is due once a day and a backstop deadline is days after opt-in, so an
 *  hour is not material to either. */
export const PASS_CADENCE_SEC = 60 * 60;
/** Each step's share of a run's sends, per chain. */
export const MAX_DEDUCTIONS_PER_RUN = 8;
export const MAX_FILLS_PER_RUN = 2;
export const MAX_SENDS_PER_RUN = MAX_DEDUCTIONS_PER_RUN + MAX_FILLS_PER_RUN;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Ledger rows read per run for the backstop step, rotating above its floor. */
export const BACKSTOP_PAGE = 200;
export const BACKSTOP_FLOOR_ITEM = 'backstop-floor';
export const BACKSTOP_NEXT_ITEM = 'backstop-next';
const ELIGIBILITY_EVENT = 'OfferBackstopEligibilitySet';
/** The share of the read window step 1 may use, so step 2 always has time
 *  for its own reads (`runWindow.leadStageCutoffMs`). */
export const RENTAL_READ_SHARE = 0.5;

/** `LibVaipakam.ONE_DAY`. */
export const ONE_DAY = 86_400n;
/** `LibVaipakam.LoanStatus`. */
const LOAN_ACTIVE = 0;
const LOAN_REPAID = 1;
/** `LibVaipakam.AssetType.ERC20`: a loan whose lent asset is an ERC-20 is
 *  not a rental. */
const ASSET_ERC20 = 0;
/** `LibVaipakam.OfferType.Borrower`. */
const OFFER_BORROWER = 1;

export const PAUSED_REFUSAL = 'EnforcedPause';
/** The contract's refusals of a deduction that describe the loan, not the
 *  deployment: named on the run's line, and tried again on a later run. */
export const RENTAL_REFUSALS: ReadonlyMap<string, string> = new Map([
  ['NotDailyYet', 'its next day has not elapsed at the current block'],
  ['InsufficientPrepay', 'its prepayment no longer covers a day'],
  ['InvalidLoanStatus', 'no longer active'],
  ['NotNFTRental', 'not an NFT rental'],
]);
/** The contract's refusals of a fill that describe the offer. */
export const FILL_REFUSALS: ReadonlyMap<string, string> = new Map([
  ['OfferNotBackstopFillable', 'not fillable at the current block (accepted, expired, not yet eligible, or its collateral not liquid)'],
  ['OfferNotBackstopEligible', 'its shape is not one the backstop fills'],
  ['SanctionedAddress', 'the borrower is flagged by the sanctions oracle'],
]);
/** The refusals of a fill that describe the deployment: the step stops for
 *  the run, since no other offer can be filled either. */
export const BACKSTOP_OFF: ReadonlyMap<string, string> = new Map([
  ['BackstopDisabled', 'the backstop or its fill role is switched off on this chain'],
  ['BackstopNotProvisioned', 'no backstop vault is provisioned on this chain'],
]);

/** What one chain's run reads and signs with. Injected so a run is testable. */
export interface PositionUpkeepDeps {
  /** Deadline-bound client: single reads and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  cursors: ScanCursors;
  ledger: EventLedger;
  /** Which run this is (`runIndex`): the active-list window and the rotations. */
  visit: number;
  /** Step 2, the backstop fill (BACKSTOP_FILL_ENABLED). Off when absent. */
  backstopFill?: boolean;
}

export interface Deduction {
  loanId: bigint;
  /** The fee the receipt's `AutoDailyDeducted` names; null when the receipt
   *  read held no such event. */
  fee: bigint | null;
  /** Whether the rental closed as repaid: true or false from the loan's
   *  status after the deduction, read for EVERY landed deduction, or
   *  'unknown' when that read could not finish (the run's unread list says
   *  why). Never inferred from the scanned day count: another caller may have
   *  deducted a day between the scan and this call, so a deduction the scan
   *  saw as an ordinary day can be the one that closes the rental. */
  closed: boolean | 'unknown';
}

export interface Fill {
  offerId: bigint;
  /** The loan and principal the receipt's `BackstopFilled` names; null when
   *  the receipt read held no such event. */
  loanId: bigint | null;
  amount: bigint | null;
}

export interface FillReport {
  /** Why the step did nothing this run, when it did nothing by design. */
  off: string | null;
  /** Offers the ledger page named. */
  named: number;
  /** Of those, the ones past their eligibility time and still fillable on
   *  their own record. */
  due: number;
  filled: Fill[];
  declined: string[];
}

/** What a run did on one chain: its log line's figures, and what tests read. */
export interface PositionUpkeepReport {
  chainId: number;
  skipped?: string;
  window: ScanWindow | null;
  /** Rentals in the window with a day due on their own record. */
  rentalsDue: number;
  deducted: Deduction[];
  /** Rentals in the window held back on their own record, with why. */
  rentalsHeld: string[];
  /** Rentals the contract declined for a reason of the loan's own. */
  rentalsDeclined: string[];
  /** Due rentals left for a later run by the step's share of sends. */
  deferred: number;
  /** Step 2's figures; null when the step is off. */
  fills: FillReport | null;
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

export async function runPositionUpkeep(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'positionUpkeep', 'POSITION_UPKEEP_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const backstopFill = subStepArmed(env, 'positionUpkeep', 'step 2 (backstop fill)', 'BACKSTOP_FILL_ENABLED');
  const visit = runIndex(tick, PASS_CADENCE_SEC * 1000);
  const ledger = d1EventLedger(env.DB);
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await positionUpkeepOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          sendDeadline,
          cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'positionUpkeep'),
          ledger,
          visit,
          backstopFill,
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] positionUpkeep chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

/** The run's one line for a chain. */
export function describeReport(r: PositionUpkeepReport): string {
  if (r.skipped) return `[keeper] positionUpkeep chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const deducted = r.deducted
    .map((d) => `${d.loanId}${d.fee === null ? '(fee unread)' : `(${d.fee})`}${d.closed === true ? ' closed' : d.closed === false ? ' open' : ' closure-unknown'}`)
    .join(',');
  const f = r.fills;
  const fills =
    f === null
      ? ['backstop-fill=off (BACKSTOP_FILL_ENABLED not armed)']
      : [
          ...(f.off ? [`backstop-fill-idle=${f.off}`] : []),
          `backstop-named=${f.named}`,
          `backstop-due=${f.due}`,
          `backstop-filled=${f.filled.map((x) => `${x.offerId}${x.loanId === null ? '(event unread)' : `->loan ${x.loanId}(${x.amount})`}`).join(',') || 'none'}`,
          ...(f.declined.length > 0 ? [`backstop-declined=${f.declined.join('; ')}`] : []),
        ];
  const parts = [
    `[keeper] positionUpkeep chain=${r.chainId}`,
    ...(r.window ? [`window=${r.window.index + 1}/${r.window.count} of ${r.window.total} active`] : []),
    `rentals-due=${r.rentalsDue}`,
    `deducted=${deducted || 'none'}`,
    ...(r.rentalsHeld.length > 0 ? [`rentals-held=${r.rentalsHeld.join('; ')}`] : []),
    ...(r.rentalsDeclined.length > 0 ? [`rentals-declined=${r.rentalsDeclined.join('; ')}`] : []),
    ...(r.deferred > 0 ? [`deferred=${r.deferred} (taken on later runs)`] : []),
    ...fills,
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

/** The fields of a loan record step 1 reads. */
export interface RentalLoan {
  status: number;
  assetType: number;
  principal: bigint;
  startTime: bigint;
  durationDays: bigint;
  prepayAmount: bigint;
  lastDeductTime: bigint;
}

/** What step 1 makes of one loan of the window (`rentalVerdict`). */
export type RentalVerdict =
  /** Not a live rental: an ERC-20 loan, or one no longer active. */
  | { kind: 'none' }
  /** A live rental whose next day has not elapsed. */
  | { kind: 'not-due' }
  /** A live rental held back on its own record, and why. */
  | { kind: 'held'; why: string }
  /** A day is due; `lastDay` when it is the last agreed day, whose deduction
   *  closes the rental. */
  | { kind: 'due'; lastDay: boolean };

/**
 * What step 1 makes of a loan, from its own record at `now`. Exported for
 * tests. Three checks mirror the contract's own (an active rental, a whole
 * day elapsed, a prepayment that covers it) only so the pass spends no
 * simulation on a loan they rule out. Two the contract does not make keep the
 * keeper from charging what the agreement does not owe: no day past the
 * agreed term, and no loan whose deduction clock is behind its start. The
 * contract still decides every loan due here.
 */
export function rentalVerdict(loan: RentalLoan, now: bigint): RentalVerdict {
  if (Number(loan.status) !== LOAN_ACTIVE || Number(loan.assetType) === ASSET_ERC20) return { kind: 'none' };
  const start = BigInt(loan.startTime);
  const last = BigInt(loan.lastDeductTime);
  // The contract counts consumed days from `lastDeductTime - startTime` and
  // reads a clock at or before the start as nothing consumed, while each
  // deduction still moves the clock a day: a record behind its start would be
  // charged day after day with the consumed count standing still.
  if (last < start) return { kind: 'held', why: 'its deduction clock is behind its start (a legacy record; left for an operator)' };
  const term = BigInt(loan.durationDays);
  const consumed = (last - start) / ONE_DAY;
  if (consumed >= term) return { kind: 'held', why: 'every agreed day is already paid (rent past the term is the late fee, never a deduction)' };
  if (now < last + ONE_DAY) return { kind: 'not-due' };
  if (BigInt(loan.principal) > BigInt(loan.prepayAmount)) return { kind: 'held', why: 'its prepayment no longer covers a day (left to the default path)' };
  return { kind: 'due', lastDay: consumed + 1n >= term };
}

/** One chain's run. Exported for tests. */
export async function positionUpkeepOnce(chainId: number, diamond: Address, deps: PositionUpkeepDeps): Promise<PositionUpkeepReport> {
  const sender = new StepSender(
    {
      pass: 'positionUpkeep',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      stepBudgets: { deduct: MAX_DEDUCTIONS_PER_RUN, fill: MAX_FILLS_PER_RUN },
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: new Set(),
      pausedRefusal: PAUSED_REFUSAL,
      unrecorded: new Set([...RENTAL_REFUSALS.keys(), ...FILL_REFUSALS.keys(), ...BACKSTOP_OFF.keys()]),
      describe: (s) => String(s),
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: PositionUpkeepReport = {
    chainId,
    window: null,
    rentalsDue: 0,
    deducted: [],
    rentalsHeld: [],
    rentalsDeclined: [],
    deferred: 0,
    // An armed step reads as armed from the start: a run that ends before it
    // is reached says so, never that the step is off.
    fills: deps.backstopFill === true ? { off: 'not reached this run', named: 0, due: 0, filled: [], declined: [] } : null,
    refused: sender.refused,
    unread: sender.unread,
    stopped: null,
  };
  const r = new PassReader(deps, deps.sendDeadline, diamond, ABI, 'positionUpkeep');
  try {
    // The RPC must answer for this chain: a deterministic deployment can put
    // a Diamond at the same address on another chain.
    let served: number;
    try {
      served = await r.call('the chain id', (c) => c.getChainId());
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the RPC's chain id could not be read (${shortErr(err)})` };
    }
    if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };
    await deductRentals(r, sender, report, diamond, deps);
    if (deps.backstopFill === true) {
      // The step writes into the report's own record as it goes, so a read
      // that throws after a fill landed (the floor lift's, at the cutoff)
      // never drops that fill from the report.
      const fills: FillReport = { off: null, named: 0, due: 0, filled: [], declined: [] };
      report.fills = fills;
      await fillBackstop(r, sender, chainId, deps, fills);
    }
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the run deadline passed during its reads');
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

// ─── 1. Rental deduction ────────────────────────────────────────────────────

async function deductRentals(r: PassReader, sender: StepSender, report: PositionUpkeepReport, diamond: Address, deps: PositionUpkeepDeps): Promise<void> {
  // Step 1 reads within a share of the read window, so step 2 keeps time for
  // its own (runWindow.ts rule 3); inside it, the window stops a stage
  // reserve before the loan reads that follow it.
  const lead = r.withCutoff(leadStageCutoffMs(Date.now(), r.cutoff, RENTAL_READ_SHARE));
  let scan: Awaited<ReturnType<typeof readActiveWindow>>;
  try {
    scan = await readActiveWindow(deps.readClient, diamond, deps.visit, scanCutoffs(lead.cutoff).window);
  } catch (err) {
    if (err instanceof PastRunDeadline) {
      sender.noteUnread('deduct', 'the active-loan window (the read cutoff passed)');
      return;
    }
    sender.noteUnread('deduct', `the active-loan window (${shortErr(err)})`);
    return;
  }
  report.window = scan.window;
  if (scan.ids.length === 0) return;
  let now: bigint;
  let loans: unknown[];
  try {
    now = (await lead.call("the window block's time", (c) => c.getBlock({ blockNumber: scan.blockNumber }))).timestamp;
    loans = await lead.many(scan.ids.map((id) => ({ functionName: 'getLoanDetails', args: [id] })), 'loans', scan.blockNumber);
  } catch (err) {
    if (err instanceof PastRunDeadline) {
      sender.noteUnread('deduct', "the window's loan records (the read cutoff passed)");
      return;
    }
    sender.noteUnread('deduct', `the window's loan records (${shortErr(err)})`);
    return;
  }
  const due: { id: bigint; lastDay: boolean }[] = [];
  let unread = 0;
  scan.ids.forEach((id, i) => {
    const loan = loans[i] as RentalLoan | undefined;
    if (loan === undefined) {
      unread += 1;
      return;
    }
    const v = rentalVerdict(loan, now);
    if (v.kind === 'held') report.rentalsHeld.push(`loan ${id}: ${v.why}`);
    else if (v.kind === 'due') due.push({ id, lastDay: v.lastDay });
  });
  if (unread > 0) sender.noteUnread('deduct', `the records of ${unread} loan(s) in the window`);
  report.rentalsDue = due.length;
  // Rotated by this window's own visit count (ScanWindow.round), so each
  // visit to it takes the next batch however many windows the book has.
  const { picked, deferred } = pickBatch(due, scan.window.round, MAX_DEDUCTIONS_PER_RUN);
  report.deferred = deferred.length;
  for (const { id } of picked) {
    if (sender.stopped) break;
    // eslint-disable-next-line no-await-in-loop
    const res = await sender.call('deduct', String(id), 'autoDeductDaily', [id]);
    if (res === 'landed') {
      // A landed deduction is recorded from its receipt BEFORE any further
      // read, so a read that cannot finish never drops a charge that
      // happened from the run's report.
      const d: Deduction = { loanId: id, fee: deductedFee(diamond, id, sender.receipt?.logs ?? []), closed: 'unknown' };
      report.deducted.push(d);
      // Whether it closed the rental is said from the loan's status after it,
      // for every landed deduction: the scan's day count is not authoritative,
      // because another caller may have deducted a day since. Unread (the read
      // cutoff passed, or the RPC did not answer), it stays 'unknown' and the
      // run says why.
      try {
        // eslint-disable-next-line no-await-in-loop
        const after = await r.one<RentalLoan>('getLoanDetails', [id]);
        d.closed = Number(after.status) === LOAN_REPAID;
      } catch (err) {
        sender.noteUnread(`deduct:${id}`, `its status after the deduction (${shortErr(err)})`);
      }
      continue;
    }
    const words = RENTAL_REFUSALS.get(res);
    if (words !== undefined) report.rentalsDeclined.push(`loan ${id}: ${words}`);
  }
}

type Log = { address: Address; data: Hex; topics: readonly Hex[] };

function eventsOf(diamond: Address, name: string, logs: readonly Log[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === name) out.push(ev.args as unknown as Record<string, unknown>);
    } catch {
      // Another event of the transaction.
    }
  }
  return out;
}

/** The fee a landed deduction took, from its own `AutoDailyDeducted` event;
 *  null when the receipt holds none for this loan. Exported for tests. */
export function deductedFee(diamond: Address, loanId: bigint, logs: readonly Log[]): bigint | null {
  const a = eventsOf(diamond, 'AutoDailyDeducted', logs).find((x) => x.loanId === loanId);
  return a === undefined ? null : (a.dayFeeDeducted as bigint);
}

/** The loan and principal a landed fill made, from its own `BackstopFilled`
 *  event; null when the receipt holds none for this offer. Exported for tests. */
export function filledEvent(diamond: Address, offerId: bigint, logs: readonly Log[]): { loanId: bigint; amount: bigint } | null {
  const a = eventsOf(diamond, 'BackstopFilled', logs).find((x) => x.offerId === offerId);
  return a === undefined ? null : { loanId: a.loanId as bigint, amount: a.fillAmount as bigint };
}

// ─── 2. Backstop fill ───────────────────────────────────────────────────────

/** The fields of an offer record step 2 reads. */
export interface BackstopOffer {
  offerType: number;
  accepted: boolean;
  amountMax: bigint;
  amountFilled: bigint;
  expiresAt: bigint;
  backstopEligibleAfter: bigint;
}

/** Whether an opted-in offer is finished for good at a block of time `at`:
 *  filled, cancelled (a deleted offer reads all zero), its opt-in cleared by
 *  an edit (a fresh opt-in is a fresh row), or expired. Pure. */
export function offerFinished(o: BackstopOffer, at: bigint): boolean {
  const exp = BigInt(o.expiresAt);
  return o.accepted || BigInt(o.backstopEligibleAfter) === 0n || (exp !== 0n && at >= exp);
}

/** Whether an offer is fillable on its own record at `now`: a borrower offer
 *  still open, past its eligibility time, with principal unfilled. The
 *  contract checks the rest. Pure. */
export function offerDue(o: BackstopOffer, now: bigint): boolean {
  return (
    Number(o.offerType) === OFFER_BORROWER &&
    !offerFinished(o, now) &&
    now >= BigInt(o.backstopEligibleAfter) &&
    BigInt(o.amountMax) > BigInt(o.amountFilled)
  );
}

async function fillBackstop(r: PassReader, sender: StepSender, chainId: number, deps: PositionUpkeepDeps, out: FillReport): Promise<void> {
  // The offer each row names; a row that names none nominates nothing.
  const page = await readLedgerRotation<bigint>({
    ledger: deps.ledger,
    cursors: deps.cursors,
    chainId,
    kinds: [ELIGIBILITY_EVENT],
    floorItem: BACKSTOP_FLOOR_ITEM,
    nextItem: BACKSTOP_NEXT_ITEM,
    limit: BACKSTOP_PAGE,
    cutoff: r.cutoff,
    nominee: (row) => {
      const raw = String(row.args.offerId ?? '');
      return /^\d+$/.test(raw) ? BigInt(raw) : null;
    },
    id: (k) => k.toString(),
  });
  if (page === null) {
    sender.noteUnread('fill', 'the event ledger of backstop opt-ins');
    out.off = 'the event ledger could not be read';
    return;
  }
  const offers = page.nominees;
  out.named = offers.length;
  const readOffers = (ids: readonly bigint[], label: string, blockNumber?: bigint) =>
    r.many(ids.map((id) => ({ functionName: 'getOffer', args: [id] })), label, blockNumber);
  const finished = new Set<bigint>();
  if (offers.length > 0) {
    let now: bigint;
    try {
      now = (await r.call("the chain's clock", (c) => c.getBlock())).timestamp;
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      sender.noteUnread('fill', `the chain's clock (${shortErr(err)})`);
      out.off = "the chain's clock could not be read";
      return;
    }
    const recs = await readOffers(offers, 'backstop offers');
    const due: bigint[] = [];
    offers.forEach((id, i) => {
      const o = recs[i] as BackstopOffer | undefined;
      if (o === undefined) {
        sender.noteUnread(`fill:${id}`, 'its offer record');
        return;
      }
      if (offerFinished(o, now)) finished.add(id);
      else if (offerDue(o, now)) due.push(id);
    });
    out.due = due.length;
    // Each run starts elsewhere on the page (`attemptOrder`), so a refusal
    // that costs only a simulation never holds a later offer back for good.
    for (const j of attemptOrder(due.length, deps.visit)) {
      if (sender.stopped || sender.budgetReached.has('fill')) break;
      const id = due[j];
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call('fill', String(id), 'backstopFill', [id]);
      if (res === 'landed') {
        const ev = filledEvent(r.diamond, id, sender.receipt?.logs ?? []);
        out.filled.push({ offerId: id, loanId: ev?.loanId ?? null, amount: ev?.amount ?? null });
        finished.add(id);
        continue;
      }
      const off = BACKSTOP_OFF.get(res);
      if (off !== undefined) {
        out.off = off;
        break;
      }
      const words = FILL_REFUSALS.get(res);
      if (words !== undefined) out.declined.push(`offer ${id}: ${words}`);
    }
  }
  // A row is finished when its offer is filled, cancelled, cleared or expired
  // (`ledgerRotation.ts`): a fill a reorg undoes leaves its row above the
  // floor, to be tried again. At the finalized block the offer is read there
  // and judged against that block's own time. A lift the read cutoff ends
  // leaves the floor where it is, for the next run; the fills above are
  // already recorded.
  try {
    await page.liftFloor(r.finalized, (id) => finished.has(id), async (ids, block) => {
      const at = await readOffers(ids, 'backstop-final', block.number);
      const done = new Set(
        ids.filter((_, j) => {
          const o = at[j] as BackstopOffer | undefined;
          return o !== undefined && offerFinished(o, block.timestamp);
        }),
      );
      return (id) => done.has(id);
    });
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('fill', 'the finalized offers that would move the floor (the read cutoff passed)');
  }
}
