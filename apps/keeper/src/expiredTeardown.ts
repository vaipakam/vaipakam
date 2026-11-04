// apps/keeper/src/expiredTeardown.ts
//
// #3097 — the EXPIRED TEARDOWN pass: the keeper's backstop for three
// permissionless teardowns of something that has outlived its use. Each one
// moves no value; each releases a hold that otherwise stays until somebody
// makes the call by hand.
//
//   1. PREPAY LISTING past its grace window
//      (`NFTPrepayListingFacet.cancelExpiredPrepayListing`). A listing nobody
//      filled keeps the borrower-position NFT locked and the vault's approval
//      to the listing conduit live. The executor already refuses a fill past
//      grace, so the listing is dead; the teardown releases the lock and the
//      approval. The contract allows it on any loan status and while the
//      protocol is paused.
//   2. LENDER-SALE LISTING past its expiry or on a closed loan
//      (`OfferCancelFacet.teardownStaleSaleListing`). A standing sale listing
//      holds the BORROWER's partial repayment and collateral withdrawal, and
//      locks the seller's lender-position NFT. Past its expiry on a live loan
//      (or a listing from before expiries existed), or once the loan has
//      closed, the contract tears it down for anyone, and on a live loan
//      starts the seller's relist cooldown. Allowed while paused.
//   3. SWAP-TO-REPAY INTENT past its cancel grace
//      (`SwapToRepayIntentFacet.cancelExpiredIntent`). A live commit keeps the
//      borrower position locked, keeps the loan out of every internal
//      liquidation match and out of auto-refinance, and leaves the vault's
//      allowance to the limit-order protocol raised by the lot. After the
//      order's deadline plus the configured cancel grace (the borrower's own
//      window to cancel), anyone may tear it down. Refused while paused.
//
// Per chain, per run (hourly, at :06):
//
//   a. One window of the active-loan list at one pinned block
//      (`activeLoanWindow.ts`), walked a window per run on a larger book. For
//      each loan, at that block: its deadlines (`LoanFacet.getLoanDeadlines`,
//      pause credit included), its prepay listing's order hash, and its
//      intent commit (`getIntentCommit`, which reverts when there is none).
//      A listing is due once the block's time is past the loan's grace end;
//      an intent once it is at or past the order's deadline plus the chain's
//      `getIntentCancelGraceSeconds`. Live prepay listings and intents exist
//      only on active loans (every closing path clears both first), so the
//      active list is where they are.
//   b. A bounded walk of the active-offer list (`getActiveOffersPaginated`),
//      starting at a point that moves each run (`rotate.pagedWalk`), at one
//      pinned block. A lender-sale listing is a borrower-side offer linked to
//      a loan (`getOfferLinkedLoanId`; a preclose offset is linked too, but is
//      a lender-side offer). It is due when it is not accepted and its loan
//      is closed, or its loan is live and its expiry is zero or has passed.
//   c. Up to the step's attempts of each, successive runs taking successive
//      ones (`pickBatch`), go to the contract: each is simulated on the
//      current state and sent only when the simulation succeeds. Prepay and
//      sale go first, the intents last, because only the intent teardown is
//      refused while the protocol is paused, and a pause stops the run's
//      sends.
//
// Every landed teardown is named from its own receipt: the
// `PrepayListingCanceled`, `LoanSaleListingTornDown` or
// `SwapToRepayIntentCancelled` event for that loan. A landed call whose event
// was not in the receipt is said apart, never counted as a teardown.
//
// What it leaves alone, deliberately:
//   - A prepay listing during its loan's grace window. That window is the
//     grace auto-list pass's (`prepayAutoList.ts`), which rotates a dead or
//     above-floor listing to the floor; this pass waits until grace has
//     ended, so the two never act on one listing.
//   - A Dutch prepay listing whose auction ended BEFORE its loan's grace. The
//     contract allows that teardown, but the auction's end is recorded only
//     on the listing's pinned executor, which the Diamond does not expose, so
//     finding one would take a simulation of every such listing every run;
//     and the one it frees is the lister's own position, which the lister can
//     cancel at any time. Once grace begins the auto-list pass rotates it.
//   - A sale listing whose offer has left the active-offer list while its
//     link to the loan remains. Nothing in the open book names it.
//
// Gated by KEEPER_ENABLED + EXPIRED_TEARDOWN_ENABLED. Ships disarmed.

import { createPublicClient, decodeEventLog, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import {
  IntentConfigFacetABI,
  LoanFacetABI,
  MetricsFacetABI,
  NFTPrepayListingFacetABI,
  OfferCancelFacetABI,
  SwapToRepayIntentFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, failedOnOwnCall, PastRunDeadline, settledChunkedRead, settledGroupedRead, type BatchResult } from './batchRead';
import { boundedCall } from './passReader';
import { shortErr } from './callErrors';
import { readActiveWindow, type ScanWindow } from './activeLoanWindow';
import { pagedWalk, pickBatch } from './rotate';
import { priorStageCutoffMs, readCutoffMs, runIndex } from './runWindow';
import { StepSender } from './stepSender';

export const ABI = [
  ...(SwapToRepayIntentFacetABI as Abi),
  ...(IntentConfigFacetABI as Abi),
  ...(NFTPrepayListingFacetABI as Abi),
  ...(OfferCancelFacetABI as Abi),
  ...(MetricsFacetABI as Abi),
  ...(LoanFacetABI as Abi),
] as Abi;

/** The pass's cadence, in seconds; the scheduler reads it from here. Every
 *  item it tears down is already past a window measured in hours or days, so
 *  an hour's wait changes nothing material. */
export const PASS_CADENCE_SEC = 60 * 60;

/** The pass's steps, in the order a run sends them. */
export const STEPS = ['prepay', 'sale', 'intent'] as const;
export type Step = (typeof STEPS)[number];

/** Items sent to the contract per step per chain per run: simulated, and sent
 *  when the simulation succeeds. Each is a share of its own, so a long queue
 *  in one step never leaves another with nothing. */
export const ATTEMPTS_PER_STEP: Readonly<Record<Step, number>> = { prepay: 4, sale: 4, intent: 4 };
/** Sends per chain per run: every step's share. */
export const MAX_SENDS_PER_RUN = STEPS.reduce((n, s) => n + ATTEMPTS_PER_STEP[s], 0);
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Reads per aggregate. */
const READ_CHUNK = 100;
/** Active offers read per page, and per run. */
export const OFFER_PAGE = 200n;
export const OFFERS_PER_RUN = 400;

/** `LibVaipakam.LoanStatus`: Active and FallbackPending are live (the latter
 *  can cure back to Active); every other status is closed. */
const LOAN_ACTIVE = 0;
const LOAN_FALLBACK_PENDING = 4;
/** `LibVaipakam.OfferType.Borrower`: a lender-sale vehicle is one. */
const OFFER_BORROWER = 1;

const FUNCTION: Readonly<Record<Step, string>> = {
  prepay: 'cancelExpiredPrepayListing',
  sale: 'teardownStaleSaleListing',
  intent: 'cancelExpiredIntent',
};

export const PAUSED_REFUSAL = 'EnforcedPause';
/** Refusals that mean the item is already gone: another caller, the owner or a
 *  closing path got there first. Skipped, not refused. */
export const RACES: ReadonlySet<string> = new Set(['PrepayListingNotFound', 'NoStaleSaleListing', 'IntentNoCommit']);
/** Refusals that mean the item is not yet due at the current block (the scan
 *  read an earlier one): named on the run's line, and tried again later. */
export const NOT_YET: ReadonlyMap<string, string> = new Map([
  ['GraceNotExpired', 'its grace window has not ended at the current block'],
  ['AuctionWindowStillOpen', 'its Dutch auction has not ended at the current block'],
  ['SaleListingLoanStillLive', 'its loan is live and the listing has not expired at the current block'],
  ['IntentNotPastCancelGrace', 'its cancel grace has not ended at the current block'],
]);

/** What one chain's run reads and signs with. Injected so a run is testable. */
export interface TeardownDeps {
  /** Deadline-bound client: single reads and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  /** Which run this is (`runIndex`): the loan window, and the offer walk's start. */
  visit: number;
}

/** One step's outcome on one chain. */
export interface StepReport {
  /** Items the scan found due. */
  due: number;
  /** Teardowns that landed, each as its own event names it. */
  torndown: string[];
  /** Calls that landed whose teardown event was not in the receipt read. */
  landedUnread: string[];
  /** Items already gone at the current block (another caller, or a close). */
  gone: string[];
  /** Items the contract says are not yet due at the current block. */
  notYet: string[];
  /** Due items left for a later run by the step's share. */
  deferred: number;
}

/** What a run did on one chain: its log line's figures, and what tests read. */
export interface TeardownReport {
  chainId: number;
  skipped?: string;
  window: ScanWindow | null;
  /** The active-offer walk: offers read this run, of how many. */
  offers: { read: number; total: number } | null;
  steps: Record<Step, StepReport>;
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

/** A due item: the loan the call takes, and how the line names it. */
interface Due {
  loanId: bigint;
  label: string;
}

export async function runExpiredTeardown(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'expiredTeardown', 'EXPIRED_TEARDOWN_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const visit = runIndex(tick, PASS_CADENCE_SEC * 1000);
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await teardownOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          sendDeadline,
          visit,
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] expiredTeardown chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

const emptyStep = (): StepReport => ({ due: 0, torndown: [], landedUnread: [], gone: [], notYet: [], deferred: 0 });

/** The run's one line for a chain. */
export function describeReport(r: TeardownReport): string {
  if (r.skipped) return `[keeper] expiredTeardown chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const step = (name: Step): string => {
    const s = r.steps[name];
    const parts = [
      `due=${s.due}`,
      `torn-down=${s.torndown.join(',') || 'none'}`,
      ...(s.landedUnread.length > 0 ? [`landed-event-unread=${s.landedUnread.join(',')}`] : []),
      ...(s.gone.length > 0 ? [`already-gone=${s.gone.join(',')}`] : []),
      ...(s.notYet.length > 0 ? [`not-yet=${s.notYet.join('; ')}`] : []),
      ...(s.deferred > 0 ? [`deferred=${s.deferred} (taken on later runs)`] : []),
    ];
    return `${name}[${parts.join(' ')}]`;
  };
  const parts = [
    `[keeper] expiredTeardown chain=${r.chainId}`,
    ...(r.window ? [`window=${r.window.index + 1}/${r.window.count} of ${r.window.total} active`] : []),
    ...(r.offers ? [`offers=${r.offers.read} of ${r.offers.total} read`] : []),
    ...STEPS.map(step),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

interface OfferRecord {
  offerType: number;
  accepted: boolean;
  expiresAt: bigint;
}

/** One chain's run. Exported for tests. */
export async function teardownOnce(chainId: number, diamond: Address, deps: TeardownDeps): Promise<TeardownReport> {
  const sender = new StepSender(
    {
      pass: 'expiredTeardown',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      stepBudgets: ATTEMPTS_PER_STEP,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: RACES,
      pausedRefusal: PAUSED_REFUSAL,
      unrecorded: new Set(NOT_YET.keys()),
      describe: (s) => `loan ${s}`,
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: TeardownReport = {
    chainId,
    window: null,
    offers: null,
    steps: { prepay: emptyStep(), sale: emptyStep(), intent: emptyStep() },
    refused: sender.refused,
    unread: sender.unread,
    stopped: null,
  };
  // Each read stage stops early enough to leave the stages after it their
  // time (runWindow.ts, rule 3): the offer records by the read cutoff, which
  // reserves the sends' time; the offer list a stage reserve before that; the
  // per-loan reads a stage reserve before that; the loan window a stage
  // reserve before those.
  const readCutoff = readCutoffMs(deps.sendDeadline);
  const offerListCutoff = priorStageCutoffMs(readCutoff);
  const loanReadsCutoff = priorStageCutoffMs(offerListCutoff);
  const windowCutoff = priorStageCutoffMs(loanReadsCutoff);
  const due: Record<Step, Due[]> = { prepay: [], sale: [], intent: [] };

  // The RPC must answer for this chain: a deterministic deployment can put a
  // Diamond at the same address on another chain.
  let served: number;
  try {
    served = await call(windowCutoff, 'the chain id', () => deps.client.getChainId());
  } catch (err) {
    if (err instanceof PastRunDeadline) {
      sender.noteUnread('run', 'the run deadline passed during its reads');
      return report;
    }
    return { ...report, skipped: `the RPC's chain id could not be read (${shortErr(err)})` };
  }
  if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };

  // a. The loan window: prepay listings and intents. b. The offer walk:
  // lender-sale listings. A stage that cannot finish its reads finds nothing
  // this run and says why; the other stage's findings are still worked.
  const stage = async (key: string, what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      sender.noteUnread(key, err instanceof PastRunDeadline ? `the run deadline passed during ${what}` : `${what} (${shortErr(err)})`);
    }
  };
  await stage('loans', 'the active-loan reads', () => scanLoans(diamond, deps, sender, report, due, { windowCutoff, loanReadsCutoff }));
  await stage('sales', 'the active-offer reads', () => scanSales(diamond, deps, sender, report, due, { offerListCutoff, readCutoff }));

  // c. The contract decides, step by step.
  for (const step of STEPS) {
    const s = report.steps[step];
    s.due = due[step].length;
    // The loan steps rotate by this window's own visit count, so each visit
    // to it takes the next batch however many windows the book has; the sale
    // step by the run, since its walk already starts somewhere new each run.
    const round = step === 'sale' ? deps.visit : (report.window?.round ?? 0);
    const { picked, deferred } = pickBatch(due[step], round, ATTEMPTS_PER_STEP[step]);
    s.deferred = deferred.length;
    for (const item of picked) {
      if (sender.stopped) break;
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call(step, String(item.loanId), FUNCTION[step], [item.loanId]);
      if (res === 'landed') {
        const ev = teardownEvent(step, diamond, item.loanId, sender.receipt?.logs ?? []);
        if (ev === null) s.landedUnread.push(item.label);
        else s.torndown.push(ev);
        continue;
      }
      if (res === 'skipped' && sender.refusal !== null && RACES.has(sender.refusal.name)) {
        s.gone.push(item.label);
        continue;
      }
      const words = NOT_YET.get(res);
      if (words !== undefined) s.notYet.push(`${item.label}: ${words}`);
    }
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

/** Step a: one window of the active-loan list, and which of its prepay
 *  listings and intents are due at that block. */
async function scanLoans(
  diamond: Address,
  deps: TeardownDeps,
  sender: StepSender,
  report: TeardownReport,
  due: Record<Step, Due[]>,
  cut: { windowCutoff: number; loanReadsCutoff: number },
): Promise<void> {
  const scan = await readActiveWindow(deps.readClient, diamond, deps.visit, cut.windowCutoff);
  report.window = scan.window;
  if (scan.ids.length === 0) return;
  const [now, graceSec] = await Promise.all([
    call(cut.windowCutoff, "the window block's time", () => deps.client.getBlock({ blockNumber: scan.blockNumber })).then((b) => b.timestamp),
    // The intent cancel grace is a chain setting; without it no intent is
    // judged this run (the listings still are).
    call(cut.windowCutoff, 'the intent cancel grace', () =>
      deps.client.readContract({ address: diamond, abi: ABI, functionName: 'getIntentCancelGraceSeconds', blockNumber: scan.blockNumber }) as Promise<number | bigint>,
    ).then(
      (v) => BigInt(v),
      (err: unknown) => {
        if (err instanceof PastRunDeadline) throw err;
        sender.noteUnread('intent', `the intent cancel grace (${shortErr(err)})`);
        return null;
      },
    ),
  ]);
  const reads = await settledGroupedRead(
    deps.readClient,
    scan.ids,
    READ_CHUNK,
    (id) => [
      { address: diamond, abi: ABI, functionName: 'getLoanDeadlines', args: [id] },
      { address: diamond, abi: ABI, functionName: 'getPrepayListingOrderHash', args: [id] },
      { address: diamond, abi: ABI, functionName: 'getIntentCommit', args: [id] },
    ],
    'expiredTeardown loans',
    cut.loanReadsCutoff,
    scan.window.round,
    scan.blockNumber,
  );
  let unread = 0;
  for (const id of scan.ids) {
    const [deadlines, orderHash, commit] = reads.get(id) ?? [];
    const listing = prepayDue(deadlines, orderHash, now);
    const intent = graceSec === null ? null : intentDue(commit, graceSec, now);
    if (listing === undefined || (graceSec !== null && intent === undefined)) unread += 1;
    if (listing) due.prepay.push({ loanId: id, label: `loan ${id}` });
    if (intent) due.intent.push({ loanId: id, label: `loan ${id}` });
  }
  if (unread > 0) sender.noteUnread('loans', `the listing or intent records of ${unread} loan(s) in the window`);
}

/** Whether a loan's prepay listing is due for teardown at `now`: it has one,
 *  and `now` is past the loan's grace end (the contract's strict rule).
 *  `undefined` when a read it needs did not come back. Pure. */
export function prepayDue(deadlines: BatchResult | undefined, orderHash: BatchResult | undefined, now: bigint): boolean | undefined {
  if (orderHash?.status !== 'success') return undefined;
  if (BigInt(orderHash.result as Hex) === 0n) return false;
  if (deadlines?.status !== 'success') return undefined;
  const [, , , graceEnd] = deadlines.result as readonly [bigint, bigint, bigint, bigint];
  return now > graceEnd;
}

/** Whether a loan's intent commit is due for the permissionless cancel at
 *  `now`: it has one, and `now` is at or past its deadline plus the cancel
 *  grace. `getIntentCommit` reverts when there is none, and only a revert of
 *  that call itself reads as none; any other failure is `undefined`. Pure. */
export function intentDue(commit: BatchResult | undefined, graceSec: bigint, now: bigint): boolean | undefined {
  if (commit === undefined) return undefined;
  if (commit.status !== 'success') return failedOnOwnCall(commit, 'getIntentCommit') ? false : undefined;
  const deadline = BigInt((commit.result as { deadline: bigint | number }).deadline);
  return now >= deadline + graceSec;
}

/** Step b: a bounded walk of the active-offer list, and which lender-sale
 *  listings in it are due at that block. */
async function scanSales(
  diamond: Address,
  deps: TeardownDeps,
  sender: StepSender,
  report: TeardownReport,
  due: Record<Step, Due[]>,
  cut: { offerListCutoff: number; readCutoff: number },
): Promise<void> {
  const blockNumber = await call(cut.offerListCutoff, 'the block number', () => deps.client.getBlockNumber({ cacheTime: 0 }));
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    call(cut.offerListCutoff, functionName, () => deps.client.readContract({ address: diamond, abi: ABI, functionName, args, blockNumber }) as Promise<T>);
  const total = await read<bigint>('getActiveOffersCount');
  report.offers = { read: 0, total: Number(total) };
  if (total === 0n) return;
  const now = (await call(cut.offerListCutoff, "the block's time", () => deps.client.getBlock({ blockNumber }))).timestamp;
  const ids: bigint[] = [];
  const seen = new Set<bigint>();
  for (const page of pagedWalk(total, OFFER_PAGE, deps.visit)) {
    if (ids.length >= OFFERS_PER_RUN) break;
    // eslint-disable-next-line no-await-in-loop
    const got = await read<readonly bigint[]>('getActiveOffersPaginated', [page.cursor, page.limit]);
    for (const id of got) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  report.offers.read = ids.length;
  const links = await settledChunkedRead(
    deps.readClient,
    ids,
    READ_CHUNK,
    (id) => ({ address: diamond, abi: ABI, functionName: 'getOfferLinkedLoanId', args: [id] }),
    'expiredTeardown offer links',
    cut.readCutoff,
    deps.visit,
    blockNumber,
  );
  let unread = 0;
  const linked: { offerId: bigint; loanId: bigint }[] = [];
  for (const id of ids) {
    const r = links.get(id);
    if (r?.status !== 'success') {
      unread += 1;
      continue;
    }
    const loanId = BigInt(r.result as bigint);
    if (loanId !== 0n) linked.push({ offerId: id, loanId });
  }
  const records = await settledGroupedRead(
    deps.readClient,
    linked,
    READ_CHUNK,
    (l) => [
      { address: diamond, abi: ABI, functionName: 'getOffer', args: [l.offerId] },
      { address: diamond, abi: ABI, functionName: 'getLoanDetails', args: [l.loanId] },
    ],
    'expiredTeardown sale listings',
    cut.readCutoff,
    deps.visit,
    blockNumber,
  );
  const loans = new Set<bigint>();
  for (const l of linked) {
    const [offer, loan] = records.get(l) ?? [];
    if (offer?.status !== 'success' || loan?.status !== 'success') {
      unread += 1;
      continue;
    }
    const why = saleDue(offer.result as OfferRecord, Number((loan.result as { status: number | bigint }).status), now);
    if (why !== null && !loans.has(l.loanId)) {
      loans.add(l.loanId);
      due.sale.push({ loanId: l.loanId, label: `loan ${l.loanId} offer ${l.offerId} (${why})` });
    }
  }
  if (unread > 0) sender.noteUnread('sales', `the link or records of ${unread} offer(s) in the walk`);
}

/** Why a linked offer is a lender-sale listing due for teardown at `now`, or
 *  null when it is not: a preclose offset (a lender-side offer), an accepted
 *  sale (mid-completion), or a live loan's listing still inside its expiry.
 *  These mirror the contract's own admission so the pass sends nothing it
 *  would refuse; the contract still decides every one that passes. Pure. */
export function saleDue(offer: OfferRecord, loanStatus: number, now: bigint): string | null {
  if (Number(offer.offerType) !== OFFER_BORROWER) return null;
  if (offer.accepted) return null;
  if (loanStatus !== LOAN_ACTIVE && loanStatus !== LOAN_FALLBACK_PENDING) return 'its loan has closed';
  const expiresAt = BigInt(offer.expiresAt);
  if (expiresAt === 0n) return 'a listing from before expiries, with none';
  return now >= expiresAt ? 'expired' : null;
}

const STEP_EVENTS: Readonly<Record<Step, { abi: Abi; eventName: string }>> = {
  prepay: { abi: NFTPrepayListingFacetABI as Abi, eventName: 'PrepayListingCanceled' },
  sale: { abi: OfferCancelFacetABI as Abi, eventName: 'LoanSaleListingTornDown' },
  intent: { abi: SwapToRepayIntentFacetABI as Abi, eventName: 'SwapToRepayIntentCancelled' },
};

/** The teardown a landed call made, from its receipt's own event for this
 *  loan, as the run's line names it; null when the receipt does not carry it. */
export function teardownEvent(
  step: Step,
  diamond: Address,
  loanId: bigint,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
): string | null {
  const { abi, eventName } = STEP_EVENTS[step];
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    if (ev.eventName !== eventName) continue;
    const a = ev.args as unknown as Record<string, unknown>;
    if (a.loanId !== loanId) continue;
    if (step === 'sale') return `loan ${loanId} offer ${a.saleOfferId as bigint}`;
    return `loan ${loanId} order ${String(a.orderHash).slice(0, 10)}`;
  }
  return null;
}

/** One single call of the pass, bounded at `cutoff` (`passReader.boundedCall`). */
function call<T>(cutoff: number, what: string, work: () => Promise<T>): Promise<T> {
  return boundedCall(cutoff, what, work);
}
