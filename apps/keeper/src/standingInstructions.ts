// apps/keeper/src/standingInstructions.ts
//
// #3681 — the STANDING INSTRUCTIONS pass: runs the three instructions a
// borrower can leave on a loan, each paid from the borrower's own per-loan
// reserve (`StandingInstructionFacet`). All three executors are open to any
// caller, and the caller chooses nothing and receives nothing: the loan, the
// borrower's setting and the reserve fix every amount. Without a keeper an
// instruction waits for someone to submit it by hand, which is what the app
// says when this pass is not running a step here.
//
// Per chain, per run (every minute), for the loans the indexer's ledger of
// `StandingInstructionsSet` names, a page a run above a floor that moves only
// on what the finalized block shows (`ledgerRotation.ts`):
//
//   1. COLLATERAL TOP-UP — `runCollateralTopUp(loanId)` when the loan's
//      health factor is under the borrower's trigger. The contract moves the
//      least collateral from the collateral reserve that brings the health
//      factor back to the borrower's target (or the whole reserve if that is
//      less); no tokens leave the borrower's vault. At most once per governed
//      interval per loan (`topUpIntervalSeconds`).
//   2. DUE REPAYMENT — `runDueRepayment(loanId)` from the borrower's chosen
//      lead time before the due date until grace ends, when the payment
//      reserve covers the whole repayment. All or nothing, exactly as a
//      manual repayment.
//   3. INTEREST PAYMENT — `runInterestPayment(loanId)` from the end of the
//      current interest period, paying its unpaid interest from the payment
//      reserve (all of it, or as much as the reserve holds).
//
// Each step is decided from the loan's own view, `getLoanReserve(loanId,
// owner)`, and the loan's deadlines (`getLoanDeadlines`), against the chain's
// own clock. That view also says what a call would do: the top-up amount
// now, the interest payable now, the repayment due and how much the reserve
// is short of it. The pass sends only a call the view shows would move
// something, so it never pays gas for a skip the view can see (the holder
// changed, an empty or short reserve, a missing price). A loan whose
// repayment is due takes only that step: the repayment closes the loan.
//
// A skip the view cannot see (a sale, offset or refinance live on the loan,
// the borrower's account locked, an asset paused, the collateral not yet
// consolidated after a transfer) still lands: the contract records it with
// `StandingInstructionSkipped` and changes nothing. The pass reads that event
// from the receipt, says why on the run's line, and holds that loan's
// instruction for SKIP_HOLD_SEC before trying it again, so a skip costs gas
// at most once per hold, not once a minute. A paused protocol is read once
// per run, before any send.
//
// Every call is simulated on the current state first and sent only when the
// simulation succeeds; each waits for its receipt before the next
// (`stepSender.ts`). Each step has its own share of the run's sends.
//
// BORROWER ALERTS (STANDING_ALERTS_ENABLED, design §6), to the instruction's
// owner through the agent's keeper route (#1722) and Push: a reserve that
// will not cover the next repayment or interest period (from three days
// before it, once a day) or a top-up's empty collateral reserve (weekly); a
// top-up that ran; an instruction the contract skipped (once a day per
// reason). The throttle is the keeper's, in its own cursor store.
//
// Gated by KEEPER_ENABLED, then each step by its own flag:
// STANDING_TOPUP_ENABLED, STANDING_REPAY_ENABLED, STANDING_INTEREST_ENABLED.
// The alerts also need STANDING_ALERTS_ENABLED. The pass does nothing while
// no step is armed. Ships disarmed.

import { createPublicClient, decodeEventLog, erc20Abi, formatUnits, http, zeroAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { plainField, renderTelegramAlert, type AddressedAlert, type TelegramAlert } from '@vaipakam/lib/telegramAlerts/message';
import { standingSkipReason } from '@vaipakam/lib/telegramAlerts/standingCopy';
import { AdminFacetABI, DIAMOND_ABI_VIEM, LoanClockFacetABI, LoanFacetABI, RepayPeriodicFacetABI, StandingInstructionFacetABI } from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, subStepArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { d1EventLedger, type EventLedger } from './eventLedger';
import { attemptOrder, readLedgerRotation } from './ledgerRotation';
import { PassReader } from './passReader';
import { runIndex } from './runWindow';
import { d1ScanCursors, type ScanCursors } from './scanCursors';
import { listThresholdsForChain, publishKeeperStepStatus, type UserThresholds } from './db';
import { AlertDelivery, delivered, worthRetrying } from './alertDelivery';
import { StepSender } from './stepSender';

const pick = (abi: unknown, names: readonly string[]): Abi =>
  (abi as Abi).filter((x) => (x.type === 'function' || x.type === 'event') && names.includes(x.name)) as Abi;

export const ABI = [
  ...pick(StandingInstructionFacetABI, [
    'runCollateralTopUp',
    'runDueRepayment',
    'runInterestPayment',
    'getLoanReserve',
    'getStandingInstructionConfig',
    'CollateralTopUpRun',
    'DueRepaymentRun',
    'InterestPaidFromReserve',
    'StandingInstructionSkipped',
  ]),
  ...pick(LoanClockFacetABI, ['getLoanDeadlines']),
  ...pick(LoanFacetABI, ['getLoanDetails']),
  ...pick(AdminFacetABI, ['paused']),
  ...pick(RepayPeriodicFacetABI, ['previewPeriodicSettle']),
  // The facet's own errors, then every other error the Diamond can revert
  // with, so a refusal from deep in a repayment is named, not hex.
  ...(StandingInstructionFacetABI as Abi).filter((x) => x.type === 'error'),
  ...DIAMOND_ABI_VIEM.filter(
    (x) => x.type === 'error' && !(StandingInstructionFacetABI as Abi).some((y) => y.type === 'error' && y.name === x.name),
  ),
] as Abi;

/** The pass's cadence, in seconds; the scheduler reads it from here. A
 *  top-up is a response to a falling health factor, so it runs every minute;
 *  every staggered minute of the hour is already taken. */
export const PASS_CADENCE_SEC = 60;
/** The three steps, by their send-budget names. */
export const STEPS = ['topUp', 'repay', 'interest'] as const;
export type Step = (typeof STEPS)[number];
/** Each step's share of a run's sends, per chain. */
export const STEP_SENDS: Readonly<Record<Step, number>> = { topUp: 4, repay: 3, interest: 3 };
export const MAX_SENDS_PER_RUN = Object.values(STEP_SENDS).reduce((a, b) => a + b, 0);
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Ledger rows read per run, rotating above the floor. */
export const PAGE = 200;
export const FLOOR_ITEM = 'set-floor';
export const NEXT_ITEM = 'set-next';
/** The cursor item holding the instructions held after a landed skip. */
export const HOLDS_ITEM = 'skip-holds';
/** How long an instruction the contract skipped waits before it is tried
 *  again: the skip changed nothing, and the reasons the view cannot see (a
 *  live sale or refinance, a locked account) last minutes to days. */
export const SKIP_HOLD_SEC = 30 * 60;
const SET_EVENT = 'StandingInstructionsSet';

/** `StandingInstructionFacet.INSTRUCTION_*`, as the skip event names them. */
export const INSTRUCTION: Readonly<Record<Step, number>> = { topUp: 1, interest: 2, repay: 3 };
/** `StandingInstructionFacet.SKIP_*`, in words. */
export const SKIP_REASONS: ReadonlyMap<number, string> = new Map([
  [1, 'the borrower position is no longer held by the wallet that set the instruction'],
  [2, 'the reserve is empty'],
  [3, 'the reserve is short of the full repayment'],
  [4, 'a sale, offset, refinance or intent is live on the loan'],
  [5, 'the collateral price is missing or distrusted'],
  [6, 'the platform or the asset is paused'],
  [7, "the borrower's account is locked"],
  [8, "the collateral has not yet moved to the new holder's vault"],
]);

/** `LibVaipakam.LoanStatus.Active`. */
const LOAN_ACTIVE = 0;

export const PAUSED_REFUSAL = 'EnforcedPause';
/** The contract's refusals that describe the loan at the current block (the
 *  view said otherwise a moment before, or another caller ran it first):
 *  named on the run's line, and tried again on a later run. */
export const REFUSALS: ReadonlyMap<string, string> = new Map([
  ['StandingInstructionNotSet', 'the instruction was cleared'],
  ['LoanNotActive', 'the loan is no longer active'],
  ['TopUpTooSoon', 'a top-up ran within the interval'],
  ['LoanHealthAboveTrigger', 'the health factor is back above the trigger'],
  ['StandingInstructionNotDue', 'not due at the current block'],
  ['StandingInstructionWindowClosed', 'grace has ended'],
  ['NothingOwed', 'nothing is owed for the period'],
]);

/** What one chain's run reads and signs with. Injected so a run is testable. */
export interface StandingInstructionsDeps {
  /** Deadline-bound client: single reads and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  cursors: ScanCursors;
  ledger: EventLedger;
  /** Which run this is (`runIndex`): where the page's attempts start. */
  visit: number;
  /** The steps armed on this keeper. */
  armed: ReadonlySet<Step>;
  /** The borrower alerts (STANDING_ALERTS_ENABLED); none are sent when
   *  absent. Delivers one alert and says whether it may be stamped as sent. */
  notify?: (alert: AddressedAlert) => Promise<NoticeOutcome>;
}

/** The instructions as `getLoanReserve` returns them. */
export interface Instructions {
  owner: Address;
  topUpTriggerHf: bigint;
  topUpTargetHf: bigint;
  lastTopUpAt: bigint;
  payInterest: boolean;
  repayAtDue: boolean;
  repayLeadSeconds: number | bigint;
}

/** `StandingInstructionFacet.ReserveView`, the fields the pass reads. */
export interface ReserveView {
  paymentAsset: Address;
  paymentReserve: bigint;
  collateralAsset: Address;
  collateralReserve: bigint;
  instructions: Instructions;
  ownerHoldsPosition: boolean;
  topUpNow: bigint;
  priceKnown: boolean;
  interestShortfall: bigint;
  interestNow: bigint;
  repayDue: bigint;
  repayShortBy: bigint;
  /** The skip the contract would make of a top-up now, before the reserve
   *  and price checks (a `SKIP_REASONS` code; 0 = none). */
  topUpSkipNow: number;
  /** The same for the interest and repayment instructions, which share the
   *  payment asset. */
  paymentSkipNow: number;
  /** The loan's borrower record is not the current holder yet. A top-up
   *  consolidates first, so this alone holds nothing back. */
  consolidationPending: boolean;
}

/** The loan's effective due date and grace end (`getLoanDeadlines`). */
export interface Deadlines {
  maturity: bigint;
  graceEnd: bigint;
}

/** What the pass makes of one loan (`loanVerdict`): the steps to send, and
 *  the instructions held back on the loan's own view, with why. */
export interface LoanVerdict {
  send: Step[];
  held: { step: Step; why: string }[];
  /** Due instructions held because the view predicts the contract's skip,
   *  with its `SKIP_REASONS` code. */
  skipped: { step: Step; code: number }[];
}

/**
 * What the pass makes of a loan, from its view and deadlines at `now`, with
 * `interval` the governed least time between top-ups. Pure; exported for
 * tests. Sends only a call the view shows would move something; the contract
 * still decides every call sent. A repayment due takes the loan alone, since
 * it closes the loan.
 */
export function loanVerdict(v: ReserveView, d: Deadlines | null, now: bigint, interval: bigint): LoanVerdict {
  const out: LoanVerdict = { send: [], held: [], skipped: [] };
  const i = v.instructions;
  if (i.owner === zeroAddress) return out;
  const wants: Step[] = [];
  if (BigInt(i.topUpTriggerHf) !== 0n) wants.push('topUp');
  if (i.repayAtDue) wants.push('repay');
  if (i.payInterest) wants.push('interest');
  if (wants.length === 0) return out;
  if (!v.ownerHoldsPosition) {
    // Also what an inactive loan reads as; the floor lift tells the two apart.
    for (const step of wants) out.held.push({ step, why: 'the position is not held by the wallet that set it, or the loan is not active' });
    return out;
  }
  if (i.repayAtDue) {
    if (d === null) out.held.push({ step: 'repay', why: "the loan's deadlines were not read" });
    else {
      const lead = BigInt(i.repayLeadSeconds);
      const from = d.maturity > lead ? d.maturity - lead : 0n;
      if (now >= from && now <= d.graceEnd && BigInt(v.repayDue) > 0n) {
        if (BigInt(v.repayShortBy) > 0n) out.held.push({ step: 'repay', why: `the payment reserve is ${v.repayShortBy} short of the ${v.repayDue} due` });
        else out.send.push('repay');
      }
    }
  }
  if (BigInt(i.topUpTriggerHf) !== 0n) {
    const last = BigInt(i.lastTopUpAt);
    if (!v.priceKnown) out.held.push({ step: 'topUp', why: 'the collateral price is missing or distrusted' });
    else if (BigInt(v.topUpNow) > 0n) {
      if (last !== 0n && now < last + interval) out.held.push({ step: 'topUp', why: `a top-up ran within the interval (next from ${last + interval})` });
      else out.send.push('topUp');
    } else if (BigInt(v.collateralReserve) === 0n) {
      // Under the trigger or not, there is nothing to move: said only so a
      // borrower relying on the instruction can be told (the app shows it).
      out.held.push({ step: 'topUp', why: 'the collateral reserve is empty' });
    }
  }
  if (i.payInterest) {
    if (BigInt(v.interestNow) > 0n) out.send.push('interest');
    else if (BigInt(v.interestShortfall) > 0n && BigInt(v.paymentReserve) === 0n) out.held.push({ step: 'interest', why: 'the payment reserve is empty' });
  }
  // A call the view says the contract would only skip is held instead of
  // sent, so it costs no gas; the borrower is told as for a landed skip.
  // Not-consolidated is not predictable (a top-up consolidates first) and is
  // left to the receipt.
  const due = out.send;
  out.send = [];
  for (const step of due) {
    const code = Number(step === 'topUp' ? v.topUpSkipNow : v.paymentSkipNow);
    if (code === 0) out.send.push(step);
    else {
      out.held.push({ step, why: `the contract would skip it: ${SKIP_REASONS.get(code) ?? `skip reason ${code}`}` });
      out.skipped.push({ step, code });
    }
  }
  // A repayment closes the loan, so it goes alone.
  if (out.send.includes('repay')) out.send = ['repay'];
  return out;
}

/** One instruction that ran. */
export interface Run {
  step: Step;
  loanId: bigint;
  /** What the receipt's own event says moved; null when the receipt held no
   *  such event for the loan. */
  amount: bigint | null;
}

/** One instruction the contract skipped, from its receipt. */
export interface Skip {
  step: Step;
  loanId: bigint;
  reason: string;
}

/** What a run did on one chain: its log line's figures, and what tests read. */
export interface StandingInstructionsReport {
  chainId: number;
  skipped?: string;
  /** Loans the ledger page named. */
  named: number;
  /** Instructions due on their loan's own view. */
  due: number;
  ran: Run[];
  skips: Skip[];
  /** Instructions held back on the loan's own view, or held after a skip. */
  held: string[];
  /** Calls the contract declined for a reason of the loan's own. */
  declined: string[];
  /** Due instructions left for a later run by a step's share of sends. */
  deferred: number;
  /** Borrower alerts sent this run, by key; null when alerts are off. */
  alerted: string[] | null;
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

/** How often the armed steps are republished while the keeper runs. The
 *  indexer's `/keeper/steps` reads a row older than three times this as not
 *  running (`KEEPER_STEP_STALE_SEC`). */
export const STATUS_PUBLISH_SEC = 5 * 60;
/** When this process last published each chain's steps, and what. */
const lastPublished = new Map<number, { at: number; armed: string }>();

/**
 * Publish which steps are armed on each chain (`keeper_step_status`), so the
 * app can say whether an instruction has an automatic runner here: at most
 * once per STATUS_PUBLISH_SEC per chain, and at once when the armed set
 * changes. Every chain the keeper serves is published, armed or not, and a
 * keeper that is not armed at all publishes every step off. A failed write is
 * logged and retried next run; it never stops the pass. Exported for tests.
 */
export async function publishArmedSteps(
  db: D1Database,
  chains: readonly { id: number; diamond: string }[],
  armed: ReadonlySet<Step>,
  nowSec: number,
): Promise<void> {
  const key = STEPS.filter((s) => armed.has(s)).join(',');
  const due = chains.filter((c) => {
    const last = lastPublished.get(c.id);
    return last === undefined || last.armed !== key || nowSec - last.at >= STATUS_PUBLISH_SEC;
  });
  if (due.length === 0) return;
  try {
    await publishKeeperStepStatus(
      db,
      due.flatMap((c) =>
        STEPS.map((step) => ({ chain_id: c.id, diamond: c.diamond, pass: 'standingInstructions', step, armed: armed.has(step) ? (1 as const) : (0 as const), observed_at: nowSec })),
      ),
    );
    for (const c of due) lastPublished.set(c.id, { at: nowSec, armed: key });
  } catch (err) {
    console.warn(`[keeper] standingInstructions: the armed steps could not be published, so the app may read them as stale (${shortErr(err)})`);
  }
}

/** Forget what was published (tests). */
export const resetPublishedSteps = () => lastPublished.clear();

export async function runStandingInstructions(env: Env, tick: PassTick): Promise<void> {
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  const keeperOn = passIsArmed(env, 'standingInstructions');
  const armed = new Set<Step>();
  if (keeperOn) {
    if (subStepArmed(env, 'standingInstructions', 'collateral top-up', 'STANDING_TOPUP_ENABLED')) armed.add('topUp');
    if (subStepArmed(env, 'standingInstructions', 'due repayment', 'STANDING_REPAY_ENABLED')) armed.add('repay');
    if (subStepArmed(env, 'standingInstructions', 'interest payment', 'STANDING_INTEREST_ENABLED')) armed.add('interest');
  }
  await publishArmedSteps(env.DB, chains.map((c) => ({ id: c.id, diamond: c.diamond as string })), armed, Math.floor(Date.now() / 1000));
  if (!keeperOn) return;
  if (armed.size === 0) {
    console.log('[keeper] standingInstructions: no instruction step is armed, so nothing runs');
    return;
  }
  const sendDeadline = tick.deadlineMs;
  const visit = runIndex(tick, PASS_CADENCE_SEC * 1000);
  const ledger = d1EventLedger(env.DB);
  const alertsOn = subStepArmed(env, 'standingInstructions', 'borrower alerts', 'STANDING_ALERTS_ENABLED');
  const delivery = alertsOn ? new AlertDelivery(env) : null;
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await standingInstructionsOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          sendDeadline,
          cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'standingInstructions'),
          ledger,
          visit,
          armed,
          notify: delivery === null ? undefined : notifierFor(env, chain, delivery),
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] standingInstructions chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
  delivery?.disclose('standingInstructions');
}

/**
 * One chain's alert sender: the Telegram half as data for the agent, which
 * sends it to the chat the instruction's owner linked, if any; the Push half
 * when the owner subscribed on this chain, in their language. The
 * subscriptions are read once, at the first alert.
 */
function notifierFor(env: Env, chain: ChainConfig, delivery: AlertDelivery): (alert: AddressedAlert) => Promise<NoticeOutcome> {
  let subs: Promise<Map<string, UserThresholds>> | null = null;
  const appOrigin = env.FRONTEND_ORIGIN ?? '';
  return async (alert) => {
    const read = (subs ??= listThresholdsForChain(env.DB, chain.id).then((rows) => new Map(rows.map((r) => [r.wallet.toLowerCase(), r]))));
    const sub = (await read).get(alert.wallet.toLowerCase());
    const rendered = renderTelegramAlert(alert, { locale: sub?.locale ?? null, chainName: chain.name ?? String(chain.id), appOrigin });
    const outcome = await delivery.deliver({
      telegram: { diamond: chain.diamond as string, message: alert },
      pushSubscriber: sub?.push_channel ? alert.wallet : null,
      text: rendered.text,
      pushTitle: rendered.title,
      deepLinkUrl: `${appOrigin}/loans/${'loanId' in alert.alert ? alert.alert.loanId : ''}`,
    });
    return delivered(outcome) ? 'sent' : worthRetrying(outcome) ? 'retry' : 'gone';
  };
}

/** The run's one line for a chain. */
export function describeReport(r: StandingInstructionsReport): string {
  if (r.skipped) return `[keeper] standingInstructions chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const ran = r.ran.map((x) => `${x.step}:${x.loanId}${x.amount === null ? '(event unread)' : `(${x.amount})`}`).join(',');
  const parts = [
    `[keeper] standingInstructions chain=${r.chainId}`,
    `named=${r.named}`,
    `due=${r.due}`,
    `ran=${ran || 'none'}`,
    ...(r.skips.length > 0 ? [`skipped-by-contract=${r.skips.map((s) => `${s.step}:${s.loanId}(${s.reason})`).join('; ')}`] : []),
    ...(r.held.length > 0 ? [`held=${r.held.join('; ')}`] : []),
    ...(r.declined.length > 0 ? [`declined=${r.declined.join('; ')}`] : []),
    ...(r.deferred > 0 ? [`deferred=${r.deferred} (taken on later runs)`] : []),
    ...(r.alerted === null ? [] : [`alerted=${r.alerted.join(',') || 'none'}`]),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

const FUNCTION_OF: Readonly<Record<Step, string>> = { topUp: 'runCollateralTopUp', repay: 'runDueRepayment', interest: 'runInterestPayment' };
const RAN_EVENT: Readonly<Record<Step, { name: string; amount: string }>> = {
  topUp: { name: 'CollateralTopUpRun', amount: 'amount' },
  repay: { name: 'DueRepaymentRun', amount: 'amount' },
  interest: { name: 'InterestPaidFromReserve', amount: 'amount' },
};

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

/**
 * What a landed call did, from its receipt: the instruction's run event and
 * the amount it moved, or the contract's skip and its reason. Exported for
 * tests. A receipt with neither for the loan reads as a run whose amount is
 * unread.
 */
export function landedOutcome(diamond: Address, step: Step, loanId: bigint, logs: readonly Log[]): { ran: Run } | { skip: Skip } {
  const skip = eventsOf(diamond, 'StandingInstructionSkipped', logs).find(
    (x) => x.loanId === loanId && Number(x.instruction) === INSTRUCTION[step],
  );
  if (skip !== undefined) {
    const code = Number(skip.reason);
    const words = SKIP_REASONS.get(code) ?? `skip reason ${code}`;
    const missing = BigInt((skip.missing as bigint | undefined) ?? 0n);
    return { skip: { step, loanId, reason: missing > 0n ? `${words} (${missing} missing)` : words } };
  }
  const e = RAN_EVENT[step];
  const ran = eventsOf(diamond, e.name, logs).find((x) => x.loanId === loanId);
  return { ran: { step, loanId, amount: ran === undefined ? null : (ran[e.amount] as bigint) } };
}

// ─── Borrower alerts (#3681 design §6) ──────────────────────────────────────

/** An amount of a token, as the chain gave it. */
export interface Amount {
  asset: Address;
  amount: bigint;
}

/** One alert the run owes a borrower, before its amounts are written out.
 *  `key` names it for the throttle; `every` is the least time between two
 *  alerts with that key (0: every time, for an event that happened once). */
export type Notice = { key: string; every: number; loanId: bigint; owner: Address } & (
  | { kind: 'low'; instruction: Step; missing: Amount | null; dueAt: bigint | null }
  | { kind: 'topUp'; amount: Amount; hfBefore: bigint; hfAfter: bigint; reserveLeft: Amount }
  | { kind: 'skip'; instruction: Step; code: number; missing: Amount | null }
);

/** What delivering one alert came to: `sent` (a channel took it), `retry`
 *  (none did, and one may next run), `gone` (none will: nothing to retry). */
export type NoticeOutcome = 'sent' | 'retry' | 'gone';

/** How long before a repayment's window opens, or an interest period ends, a
 *  reserve that will not cover it is reported. */
export const LOW_WARN_SEC = 3 * 24 * 3600;
/** The least time between two alerts of one kind on one loan. */
export const LOW_EVERY_SEC = 24 * 3600;
/** An empty collateral reserve on a top-up: weekly, since nothing is due. */
export const LOW_TOPUP_EVERY_SEC = 7 * 24 * 3600;
export const SKIP_EVERY_SEC = 24 * 3600;
/** The cursor item holding when each alert key was last sent. */
export const ALERTS_ITEM = 'alerts-sent';

/**
 * The reserve alerts a loan's own view calls for at `now`. Pure; exported
 * for tests. A repayment the payment reserve will not cover, from
 * LOW_WARN_SEC before its window opens until grace ends; an interest period
 * the reserve will not cover, from LOW_WARN_SEC before the period ends
 * (`periodEnd`, null when unread: then only an EMPTY reserve is reported,
 * without a time); a top-up whose collateral reserve is empty.
 */
export function lowReserveNotices(id: bigint, v: ReserveView, d: Deadlines | null, now: bigint, periodEnd: bigint | null): Notice[] {
  const i = v.instructions;
  if (i.owner === zeroAddress || !v.ownerHoldsPosition) return [];
  const out: Notice[] = [];
  const base = { loanId: id, owner: i.owner };
  const reserve = BigInt(v.paymentReserve);
  if (i.repayAtDue && d !== null) {
    const lead = BigInt(i.repayLeadSeconds);
    const from = d.maturity > lead ? d.maturity - lead : 0n;
    if (now + BigInt(LOW_WARN_SEC) >= from && now <= d.graceEnd && BigInt(v.repayShortBy) > 0n) {
      out.push({
        ...base,
        key: `low:repay:${id}`,
        every: LOW_EVERY_SEC,
        kind: 'low',
        instruction: 'repay',
        missing: reserve === 0n ? null : { asset: v.paymentAsset, amount: BigInt(v.repayShortBy) },
        dueAt: d.maturity,
      });
    }
  }
  const owed = BigInt(v.interestShortfall);
  if (i.payInterest && owed > reserve) {
    const near = periodEnd !== null && now + BigInt(LOW_WARN_SEC) >= periodEnd;
    if (near) {
      out.push({ ...base, key: `low:interest:${id}`, every: LOW_EVERY_SEC, kind: 'low', instruction: 'interest', missing: reserve === 0n ? null : { asset: v.paymentAsset, amount: owed - reserve }, dueAt: periodEnd });
    } else if (periodEnd === null && reserve === 0n) {
      out.push({ ...base, key: `low:interest:${id}`, every: LOW_EVERY_SEC, kind: 'low', instruction: 'interest', missing: null, dueAt: null });
    }
  }
  if (BigInt(i.topUpTriggerHf) !== 0n && BigInt(v.collateralReserve) === 0n) {
    out.push({ ...base, key: `low:topUp:${id}`, every: LOW_TOPUP_EVERY_SEC, kind: 'low', instruction: 'topUp', missing: null, dueAt: null });
  }
  return out;
}

/** The alert a landed call owes, from its receipt: a top-up that ran, or a
 *  skip. Null for a repayment or an interest payment that ran (the app's
 *  history shows those) and for a receipt with neither event. Exported for
 *  tests. */
export function receiptNotice(diamond: Address, step: Step, id: bigint, owner: Address, v: ReserveView, logs: readonly Log[]): Notice | null {
  const skip = eventsOf(diamond, 'StandingInstructionSkipped', logs).find((x) => x.loanId === id && Number(x.instruction) === INSTRUCTION[step]);
  if (skip !== undefined) {
    const code = Number(skip.reason);
    const missing = BigInt((skip.missing as bigint | undefined) ?? 0n);
    return { key: `skip:${step}:${id}:${code}`, every: SKIP_EVERY_SEC, loanId: id, owner, kind: 'skip', instruction: step, code, missing: missing > 0n ? { asset: v.paymentAsset, amount: missing } : null };
  }
  if (step !== 'topUp') return null;
  const ran = eventsOf(diamond, 'CollateralTopUpRun', logs).find((x) => x.loanId === id);
  if (ran === undefined) return null;
  return {
    key: `topUp:${id}`,
    every: 0,
    loanId: id,
    owner: ran.holder as Address,
    kind: 'topUp',
    amount: { asset: v.collateralAsset, amount: ran.amount as bigint },
    hfBefore: ran.hfBefore as bigint,
    hfAfter: ran.hfAfter as bigint,
    reserveLeft: { asset: v.collateralAsset, amount: ran.reserveLeft as bigint },
  };
}

/** A health factor (1e18) as the alert writes it. */
const hf = (x: bigint) => Number(x / 10n ** 12n) / 1e6;

/** When each alert key was last sent, with every entry older than a week
 *  dropped (no throttle is longer). */
export function liveSent(raw: string | undefined, now: bigint): Map<string, bigint> {
  const out = liveHolds(raw, 0n);
  for (const [k, v] of out) if (now - v > BigInt(LOW_TOPUP_EVERY_SEC)) out.delete(k);
  return out;
}

/**
 * Write each due notice out (amounts with their token's decimals and symbol,
 * read once a run per token) and deliver it, stamping the throttle for each
 * one a channel took or none ever will. The throttle and the deduplication
 * are the keeper's: the agent sends what it is given.
 */
async function deliverNotices(
  r: PassReader,
  chainId: number,
  deps: StandingInstructionsDeps,
  report: StandingInstructionsReport,
  notices: readonly Notice[],
  now: bigint,
): Promise<void> {
  const notify = deps.notify;
  if (notify === undefined || notices.length === 0) return;
  const raw = (await deps.cursors.get([ALERTS_ITEM])).get(ALERTS_ITEM);
  const sent = liveSent(raw, now);
  const before = encodeHolds(sent);
  const tokens = new Map<string, Promise<{ decimals: number; symbol: string } | null>>();
  const token = (asset: Address) => {
    const k = asset.toLowerCase();
    if (!tokens.has(k)) {
      tokens.set(
        k,
        Promise.all([r.one<number>('decimals', [], asset, erc20Abi), r.one<string>('symbol', [], asset, erc20Abi)])
          .then(([decimals, symbol]) => ({ decimals: Number(decimals), symbol: plainField(String(symbol)) ?? '?' }))
          .catch((err) => {
            if (err instanceof PastRunDeadline) throw err;
            return null;
          }),
      );
    }
    return tokens.get(k)!;
  };
  const words = async (a: Amount): Promise<string> => {
    const t = await token(a.asset);
    const short = `${a.asset.slice(0, 8)}…${a.asset.slice(-4)}`;
    return plainField(t === null ? `${a.amount} raw units (${short})` : `${formatUnits(a.amount, t.decimals)} ${t.symbol.slice(0, 24)} (${short})`) ?? '?';
  };
  for (const n of notices) {
    const last = sent.get(n.key);
    if (n.every > 0 && last !== undefined && now - last < BigInt(n.every)) continue;
    let alert: TelegramAlert;
    const loanId = Number(n.loanId);
    if (n.kind === 'low') {
      alert = { kind: 'standingReserveLow', loanId, instruction: n.instruction, missing: n.missing === null ? null : await words(n.missing), dueAt: n.dueAt === null ? null : Number(n.dueAt) };
    } else if (n.kind === 'topUp') {
      alert = {
        kind: 'standingTopUp',
        loanId,
        amount: await words(n.amount),
        hfBefore: hf(n.hfBefore),
        hfAfter: n.hfAfter === 0n ? null : hf(n.hfAfter),
        reserveLeft: await words(n.reserveLeft),
      };
    } else {
      const reason = standingSkipReason(n.code);
      if (reason === null) continue;
      alert = { kind: 'standingSkipped', loanId, instruction: n.instruction, reason, missing: reason === 'reserveShort' && n.missing !== null ? await words(n.missing) : null };
    }
    // eslint-disable-next-line no-await-in-loop
    const outcome = await notify({ chainId, wallet: n.owner.toLowerCase(), alert });
    if (outcome === 'retry') continue;
    if (outcome === 'sent') report.alerted?.push(n.key);
    if (n.every > 0) sent.set(n.key, now);
  }
  const after = encodeHolds(sent);
  if (after !== before || (raw ?? '') !== after) await deps.cursors.put(ALERTS_ITEM, after);
}

/** The held instructions stored after landed skips, `step:loanId` to the
 *  unix second it may be tried again, with every lapsed hold dropped. */
export function liveHolds(raw: string | undefined, now: bigint): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (raw === undefined || raw === '') return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string' || !/^\d+$/.test(v)) continue;
      const until = BigInt(v);
      if (until > now) out.set(k, until);
    }
  } catch {
    // An unreadable record holds nothing: at worst one skip lands again.
  }
  return out;
}

export const encodeHolds = (holds: ReadonlyMap<string, bigint>) => JSON.stringify(Object.fromEntries([...holds].map(([k, v]) => [k, v.toString()])));

/** One chain's run. Exported for tests. */
export async function standingInstructionsOnce(chainId: number, diamond: Address, deps: StandingInstructionsDeps): Promise<StandingInstructionsReport> {
  const sender = new StepSender(
    {
      pass: 'standingInstructions',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      stepBudgets: STEP_SENDS,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: new Set(),
      pausedRefusal: PAUSED_REFUSAL,
      unrecorded: new Set(REFUSALS.keys()),
      describe: (s) => String(s),
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: StandingInstructionsReport = {
    chainId,
    named: 0,
    due: 0,
    ran: [],
    skips: [],
    held: [],
    declined: [],
    deferred: 0,
    alerted: deps.notify === undefined ? null : [],
    refused: sender.refused,
    unread: sender.unread,
    stopped: null,
  };
  const r = new PassReader(deps, deps.sendDeadline, diamond, ABI, 'standingInstructions');
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
    await runInstructions(r, sender, report, chainId, diamond, deps);
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the run deadline passed during its reads');
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

async function runInstructions(
  r: PassReader,
  sender: StepSender,
  report: StandingInstructionsReport,
  chainId: number,
  diamond: Address,
  deps: StandingInstructionsDeps,
): Promise<void> {
  const page = await readLedgerRotation<bigint>({
    ledger: deps.ledger,
    cursors: deps.cursors,
    chainId,
    kinds: [SET_EVENT],
    floorItem: FLOOR_ITEM,
    nextItem: NEXT_ITEM,
    limit: PAGE,
    cutoff: r.cutoff,
    nominee: (row) => {
      const raw = String(row.args.loanId ?? '');
      return /^\d+$/.test(raw) ? BigInt(raw) : null;
    },
    id: (k) => k.toString(),
  });
  if (page === null) {
    sender.noteUnread('run', 'the event ledger of standing instructions');
    return;
  }
  const loans = page.nominees;
  report.named = loans.length;
  const finished = new Set<bigint>();
  if (loans.length > 0) {
    // A paused protocol skips every instruction: read once, before any send.
    const paused = await r.one<boolean>('paused');
    if (paused) {
      report.held.push('every instruction: the platform is paused');
      return;
    }
    const block = await r.call("the chain's clock", (c) => c.getBlock());
    const now = block.timestamp;
    const cfg = await r.one<{ topUpIntervalSeconds: number | bigint }>('getStandingInstructionConfig');
    const interval = BigInt(cfg.topUpIntervalSeconds);
    // The owner of each loan's instructions first, then that owner's reserve
    // and the loan's deadlines, all at one block.
    const byOwner = await r.many(loans.map((id) => ({ functionName: 'getLoanReserve', args: [id, zeroAddress] })), 'instructions', block.number);
    const owned: { id: bigint; owner: Address }[] = [];
    loans.forEach((id, i) => {
      const v = byOwner[i] as ReserveView | undefined;
      if (v === undefined) sender.noteUnread(`loan:${id}`, 'its instructions');
      else if (v.instructions.owner === zeroAddress) finished.add(id);
      else owned.push({ id, owner: v.instructions.owner });
    });
    const views = await r.groups(
      owned.map(({ id, owner }) => [
        { functionName: 'getLoanReserve', args: [id, owner] },
        { functionName: 'getLoanDeadlines', args: [id] },
      ]),
      'reserves',
      block.number,
    );
    // A loan whose view shows the position not held by the instruction's
    // owner may instead have closed (the view reads an inactive loan the same
    // way): its status, at the same block, says which, so a closed loan's
    // row can leave the rotation.
    const unheld = owned.filter((_, j) => (views[j]?.[0] as ReserveView | undefined)?.ownerHoldsPosition === false).map((o) => o.id);
    const statuses = await r.many(unheld.map((id) => ({ functionName: 'getLoanDetails', args: [id] })), 'statuses', block.number);
    unheld.forEach((id, j) => {
      const loan = statuses[j] as { status: number } | undefined;
      if (loan !== undefined && Number(loan.status) !== LOAN_ACTIVE) finished.add(id);
    });
    // For the alerts only: the end of the current interest period of each
    // loan whose payment reserve will not cover it.
    const periodEnds = new Map<bigint, bigint>();
    if (deps.notify !== undefined) {
      const short = owned.filter((_, j) => {
        const v = views[j]?.[0] as ReserveView | undefined;
        return v !== undefined && v.instructions.payInterest && BigInt(v.interestShortfall) > BigInt(v.paymentReserve);
      });
      const previews = await r.many(short.map(({ id }) => ({ functionName: 'previewPeriodicSettle', args: [id] })), 'periods', block.number);
      short.forEach(({ id }, j) => {
        const p = previews[j] as { periodEndAt: bigint } | undefined;
        if (p !== undefined) periodEnds.set(id, BigInt(p.periodEndAt));
      });
    }
    const notices: Notice[] = [];
    const viewOf = new Map<bigint, { view: ReserveView; owner: Address }>();
    const holdsRaw = (await deps.cursors.get([HOLDS_ITEM])).get(HOLDS_ITEM);
    const holds = liveHolds(holdsRaw, now);
    const work: { id: bigint; step: Step }[] = [];
    owned.forEach(({ id, owner }, j) => {
      const [view, dl] = views[j] as [ReserveView | undefined, readonly bigint[] | undefined];
      if (view === undefined) {
        sender.noteUnread(`loan:${id}`, 'its reserve');
        return;
      }
      const d: Deadlines | null = dl === undefined ? null : { maturity: BigInt(dl[2]), graceEnd: BigInt(dl[3]) };
      if (finished.has(id)) return;
      viewOf.set(id, { view, owner });
      if (deps.notify !== undefined) notices.push(...lowReserveNotices(id, view, d, now, periodEnds.get(id) ?? null));
      const verdict = loanVerdict(view, d, now, interval);
      for (const h of verdict.held) if (deps.armed.has(h.step)) report.held.push(`${h.step} loan ${id}: ${h.why}`);
      if (deps.notify !== undefined) {
        for (const k of verdict.skipped) {
          if (deps.armed.has(k.step)) notices.push({ key: `skip:${k.step}:${id}:${k.code}`, every: SKIP_EVERY_SEC, loanId: id, owner, kind: 'skip', instruction: k.step, code: k.code, missing: null });
        }
      }
      for (const step of verdict.send) {
        if (!deps.armed.has(step)) continue;
        const until = holds.get(`${step}:${id}`);
        if (until !== undefined) {
          report.held.push(`${step} loan ${id}: skipped by the contract on an earlier run; tried again from ${until}`);
          continue;
        }
        work.push({ id, step });
      }
    });
    report.due = work.length;
    // Top-ups first: a falling health factor is the urgent one. Within a step,
    // each run starts elsewhere on the list (`attemptOrder`), so a refusal
    // that costs only a simulation never holds a later loan back for good.
    const holdsBefore = encodeHolds(holds);
    for (const step of STEPS) {
      const ofStep = work.filter((w) => w.step === step);
      for (const j of attemptOrder(ofStep.length, deps.visit)) {
        const { id } = ofStep[j];
        if (sender.stopped || sender.budgetReached.has(step)) {
          report.deferred += 1;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const res = await sender.call(step, String(id), FUNCTION_OF[step], [id]);
        if (res === 'landed') {
          const out = landedOutcome(diamond, step, id, sender.receipt?.logs ?? []);
          const seen = viewOf.get(id);
          if (deps.notify !== undefined && seen !== undefined) {
            const n = receiptNotice(diamond, step, id, seen.owner, seen.view, sender.receipt?.logs ?? []);
            if (n !== null) notices.push(n);
          }
          if ('skip' in out) {
            report.skips.push(out.skip);
            holds.set(`${step}:${id}`, now + BigInt(SKIP_HOLD_SEC));
          } else {
            report.ran.push(out.ran);
            // A repayment closes the loan, and with it the row.
            if (step === 'repay') finished.add(id);
          }
          continue;
        }
        if (res === 'skipped') {
          if (sender.budgetReached.has(step)) report.deferred += 1;
          continue;
        }
        const words = REFUSALS.get(res);
        if (words !== undefined) report.declined.push(`${step} loan ${id}: ${words}`);
      }
    }
    // Alerts after every send: a slow channel never holds a top-up back.
    // Unsent by the cutoff, they are owed again next run.
    try {
      await deliverNotices(r, chainId, deps, report, notices, now);
    } catch (err) {
      if (err instanceof PastRunDeadline) sender.noteUnread('alerts', 'the borrower alerts (the read cutoff passed)');
      else sender.noteUnread('alerts', `the borrower alerts (${shortErr(err)})`);
    }
    const holdsAfter = encodeHolds(holds);
    if (holdsAfter !== holdsBefore || (holdsRaw ?? '') !== holdsAfter) {
      // Unwritten, a skip may land once more on a later run.
      await deps.cursors.put(HOLDS_ITEM, holdsAfter);
    }
  }
  // A row is finished when its loan's instructions are cleared or the loan is
  // no longer active: a cleared and re-set instruction is a fresh row. At the
  // finalized block both are read there. A lift the read cutoff ends leaves
  // the floor where it is, for the next run.
  try {
    await page.liftFloor(r.finalized, (id) => finished.has(id), async (ids, block) => {
      const groups = await r.groups(
        ids.map((id) => [
          { functionName: 'getLoanReserve', args: [id, zeroAddress] },
          { functionName: 'getLoanDetails', args: [id] },
        ]),
        'final',
        block.number,
      );
      const done = new Set(
        ids.filter((_, j) => {
          const [v, loan] = groups[j] as [ReserveView | undefined, { status: number } | undefined];
          if (v === undefined || loan === undefined) return false;
          return v.instructions.owner === zeroAddress || Number(loan.status) !== LOAN_ACTIVE;
        }),
      );
      return (id) => done.has(id);
    });
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the finalized loans that would move the floor (the read cutoff passed)');
  }
}
