// apps/keeper/src/prepayAutoList.ts
//
// #2984 — the GRACE AUTO-LIST pass: the keeper's call of the permissionless
// `NFTPrepayAutoListFacet.autoListAtFloorOnGrace` (design §18 of
// `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`). While a loan backed
// by an NFT is in its grace window, anyone but the borrower-position holder
// may put the collateral up for sale at the protocol floor: the ask that pays
// the lender and the treasury their legs plus the configured buffer. With no
// listing up, the call posts one (Case A); with one above the floor, or built
// on legs that have since grown, it rotates it to the floor (Case B). Without a
// keeper nobody makes the call, the grace window passes unsold, and the lender
// takes the NFT in kind at default even when a buyer at the floor existed.
//
// Per chain, per run (every minute):
//
//   1. The listing gate: prepay listings enabled and a buffer configured on
//      this chain, read from the chain. Otherwise nothing can be posted, and
//      the run says so.
//   2. One window of the active-loan list at one pinned block
//      (`activeLoanWindow.ts`), walked a window per run on a larger book.
//   3. Which of them are in grace, from the contract's own deadlines
//      (`LoanFacet.getLoanDeadlines`: the effective due date and grace end,
//      pause credit included), against that block's time. Nothing here
//      re-derives grace arithmetic.
//   4. Which of those the call can apply to, from the loan's own record: it
//      allows prepay listing, its collateral is an NFT and its principal an
//      ERC-20; and the borrower has not opted out (they cancelled a listing
//      during grace, which the contract makes sticky until they re-enable it).
//   5. Up to MAX_ATTEMPTS_PER_RUN of them, successive runs taking successive
//      ones (`pickBatch`), go to the contract: each is simulated on the
//      current state and sent only when the simulation succeeds. The
//      contract is the rule. Its refusals that describe the loan (already at
//      the floor, the grace window closed since the scan, the position holder
//      sanctioned, this keeper holding the position) are named on the run's
//      line, and the loan is tried again on a later run. Its refusals that
//      describe the deployment (no executor or conduit configured, an
//      executor migration left stale, this keeper's own address flagged) are
//      the run's refusals, for an operator.
//
// Every landed call is named with the ask it listed at, read from its own
// `PrepayListingPosted` / `PrepayListingUpdated` event. The pass pays only
// gas, moves no value to the keeper, and never chooses a price: the ask is
// the contract's floor at the block the call lands in.
//
// Why every minute (and not a staggered slot): the shortest grace in the
// default schedule is one hour (loans under seven days), and every minute of
// it without a floor listing is a minute a buyer at the floor cannot take
// the NFT. A slot every fifteen minutes or hour would give a one-hour grace
// most of its window unlisted.
//
// What it does not do: cancel a stale listing after grace
// (`cancelExpiredPrepayListing` is an open owner question on #2984), or
// default the loan (`graceDefault` does that once grace has ended).
//
// Gated by KEEPER_ENABLED + PREPAY_AUTO_LIST_ENABLED. Ships disarmed.

import { createPublicClient, decodeEventLog, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { LoanFacetABI, NFTPrepayAutoListFacetABI, NFTPrepayListingFacetABI } from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline, settledChunkedRead } from './batchRead';
import { boundedCall } from './passReader';
import { shortErr } from './callErrors';
import { readActiveWindow, type ScanWindow } from './activeLoanWindow';
import { pickBatch } from './rotate';
import { priorStageCutoffMs, readCutoffMs } from './runWindow';
import { StepSender } from './stepSender';

export const ABI = [
  ...(NFTPrepayAutoListFacetABI as Abi),
  ...(NFTPrepayListingFacetABI as Abi),
  ...(LoanFacetABI as Abi),
] as Abi;

/** The pass's cadence, in seconds; the scheduler reads it from here. */
export const PASS_CADENCE_SEC = 60;
/** Loans sent to the contract per chain per run: simulated, and sent when the
 *  simulation succeeds. Each costs one simulation, and a send when it lands. */
export const MAX_ATTEMPTS_PER_RUN = 6;
/** Sends per chain per run. */
export const MAX_SENDS_PER_RUN = MAX_ATTEMPTS_PER_RUN;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Reads per aggregate. */
const READ_CHUNK = 100;

/** `LibVaipakam.AssetType`. */
const ASSET_ERC20 = 0;
const ASSET_ERC721 = 1;
const ASSET_ERC1155 = 2;
/** `LibVaipakam.LoanStatus.Active`. */
const LOAN_ACTIVE = 0;

export const PAUSED_REFUSAL = 'EnforcedPause';
/** The contract's refusals that describe the loan, not the deployment: named
 *  on the run's line in these words, and tried again on a later run. */
export const LOAN_REFUSALS: ReadonlyMap<string, string> = new Map([
  ['AutoListAlreadyAtOrBelowFloor', 'already listed at or below the floor, on live legs'],
  ['AutoListBorrowerOptedOut', 'the borrower opted out of auto-listing'],
  ['GraceNotStarted', 'its grace window has not started at the current block'],
  ['GraceExpired', 'its grace window closed since the scan'],
  ['PrepayLoanNotActive', 'no longer active'],
  ['PrepayListingNotAllowed', 'its terms do not allow a prepay listing'],
  ['UnsupportedCollateralForV1', 'its collateral is not an NFT'],
  ['UnsupportedPrincipalForV1', 'its principal is not an ERC-20'],
  ['NotEligibleAutoLister', 'this keeper holds the borrower position, so the auto-list is not its call'],
  ['BorrowerSanctioned', 'the borrower-position holder is sanctioned, so no sale surplus may go to them'],
  ['VaultNotDeployed', 'the borrower has no vault'],
]);

/** What one chain's run reads and signs with. Injected so a run is testable. */
export interface AutoListDeps {
  /** Deadline-bound client: single reads and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  /** Which window of the active list and which candidates this run takes. */
  visit: number;
}

/** What a run did on one chain: its log line's figures, and what tests read. */
export interface AutoListReport {
  chainId: number;
  skipped?: string;
  window: ScanWindow | null;
  /** Loans in the window that are in their grace window. */
  inGrace: number;
  /** Fresh floor listings posted (Case A), with the ask. */
  posted: { loanId: bigint; ask: bigint }[];
  /** Listings rotated to the floor (Case B), with the new ask. */
  rotated: { loanId: bigint; ask: bigint }[];
  /** Calls that landed whose listing event was not in the receipt read. */
  landedUnread: bigint[];
  /** Loans in grace the call does not apply to, read before any send: their
   *  terms, their asset types, or the borrower's opt-out. */
  notApplicable: string[];
  /** Loans the contract declined for a reason of the loan's own. */
  declined: string[];
  /** Applicable loans left for a later run by MAX_ATTEMPTS_PER_RUN. */
  deferred: number;
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

export async function runPrepayAutoList(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'prepayAutoList', 'PREPAY_AUTO_LIST_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const visit = Math.floor((tick.scheduledTimeMs ?? Date.now()) / (PASS_CADENCE_SEC * 1000));
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await autoListOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          sendDeadline,
          visit,
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] prepayAutoList chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

/** The run's one line for a chain. */
export function describeReport(r: AutoListReport): string {
  if (r.skipped) return `[keeper] prepayAutoList chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const list = (xs: readonly { loanId: bigint; ask: bigint }[]) => xs.map((x) => `${x.loanId}@${x.ask}`).join(',') || 'none';
  const parts = [
    `[keeper] prepayAutoList chain=${r.chainId}`,
    ...(r.window ? [`window=${r.window.index + 1}/${r.window.count} of ${r.window.total} active`] : []),
    `in-grace=${r.inGrace}`,
    `posted=${list(r.posted)}`,
    `rotated=${list(r.rotated)}`,
    ...(r.landedUnread.length > 0 ? [`landed-ask-unread=${r.landedUnread.join(',')}`] : []),
    ...(r.notApplicable.length > 0 ? [`not-applicable=${r.notApplicable.join('; ')}`] : []),
    ...(r.declined.length > 0 ? [`declined=${r.declined.join('; ')}`] : []),
    ...(r.deferred > 0 ? [`deferred=${r.deferred} (taken on later runs)`] : []),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

interface LoanDetails {
  status: number;
  assetType: number;
  collateralAssetType: number;
  allowsPrepayListing: boolean;
}

/** One chain's run. Exported for tests. */
export async function autoListOnce(chainId: number, diamond: Address, deps: AutoListDeps): Promise<AutoListReport> {
  const sender = new StepSender(
    {
      pass: 'prepayAutoList',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: new Set(),
      pausedRefusal: PAUSED_REFUSAL,
      unrecorded: new Set(LOAN_REFUSALS.keys()),
      describe: (s) => `loan ${s}`,
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: AutoListReport = {
    chainId,
    window: null,
    inGrace: 0,
    posted: [],
    rotated: [],
    landedUnread: [],
    notApplicable: [],
    declined: [],
    deferred: 0,
    refused: sender.refused,
    unread: sender.unread,
    stopped: null,
  };
  // Each read stage stops early enough to leave the stages after it their
  // time (runWindow.ts, rule 3): the per-loan reads by the read cutoff, which
  // reserves the sends' time; the deadline reads a stage reserve before that;
  // the window scan a stage reserve before those.
  const readCutoff = readCutoffMs(deps.sendDeadline);
  const deadlinesCutoff = priorStageCutoffMs(readCutoff);
  const scanCutoff = priorStageCutoffMs(deadlinesCutoff);
  // The scan stage's single calls (the chain id, the gate, the window, its
  // block's time), each stopped at the scan cutoff (`passReader.boundedCall`).
  const scanCall = <T>(what: string, work: () => Promise<T>) => boundedCall(scanCutoff, what, work);
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    scanCall(functionName, () => deps.client.readContract({ address: diamond, abi: ABI, functionName, args }) as Promise<T>);
  // Through the keeper's one chunked read, which starts each visit's reads
  // at a point that moves with the window's own visit count, so a cutoff that
  // ends a stage partway never leaves the same tail unread every visit.
  // `undefined` where a read did not come back, in the order of `ids`.
  const many = async (
    functionName: string,
    ids: readonly bigint[],
    label: string,
    at: { blockNumber: bigint; round: number },
    cutoff: number,
  ): Promise<unknown[]> => {
    const res = await settledChunkedRead(
      deps.readClient,
      ids,
      READ_CHUNK,
      (id) => ({ address: diamond, abi: ABI, functionName, args: [id] }),
      `prepayAutoList ${label}`,
      cutoff,
      at.round,
      at.blockNumber,
    );
    return ids.map((id) => {
      const x = res.get(id);
      return x?.status === 'success' ? x.result : undefined;
    });
  };
  try {
    // The RPC must answer for this chain: a deterministic deployment can put
    // a Diamond at the same address on another chain.
    let served: number;
    try {
      served = await scanCall('the chain id', () => deps.client.getChainId());
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the RPC's chain id could not be read (${shortErr(err)})` };
    }
    if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };

    // 1. The listing gate.
    let enabled: boolean;
    let bufferBps: bigint;
    try {
      [enabled, bufferBps] = await Promise.all([read<boolean>('getPrepayListingEnabled'), read<bigint>('getPrepayListingBufferBps')]);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the prepay-listing configuration could not be read (${shortErr(err)})` };
    }
    if (!enabled) return { ...report, skipped: 'prepay listings are disabled on this chain, so no listing can be posted' };
    if (bufferBps === 0n) return { ...report, skipped: 'the prepay-listing buffer is not configured on this chain, so the contract has no floor to list at' };

    // 2–3. One window, and which of it is in grace at that block.
    const scan = await readActiveWindow(deps.readClient, diamond, deps.visit, scanCutoff);
    report.window = scan.window;
    if (scan.ids.length === 0) return report;
    const at = { blockNumber: scan.blockNumber, round: scan.window.round };
    const now = (await scanCall("the window block's time", () => deps.client.getBlock({ blockNumber: scan.blockNumber }))).timestamp;
    const deadlines = await many('getLoanDeadlines', scan.ids, 'deadlines', at, deadlinesCutoff);
    const inGrace: bigint[] = [];
    let deadlinesUnread = 0;
    scan.ids.forEach((id, i) => {
      const d = deadlines[i] as readonly [bigint, bigint, bigint, bigint] | undefined;
      if (d === undefined) {
        deadlinesUnread += 1;
        return;
      }
      const [, , maturity, graceEnd] = d;
      if (maturity <= now && now < graceEnd) inGrace.push(id);
    });
    if (deadlinesUnread > 0) sender.noteUnread('scan', `the deadlines of ${deadlinesUnread} loan(s) in the window`);
    report.inGrace = inGrace.length;
    if (inGrace.length === 0) return report;

    // 4. Which of them the call can apply to, at the same block.
    const [details, optedOut] = await Promise.all([
      many('getLoanDetails', inGrace, 'details', at, readCutoff),
      many('getPrepayListingAutoListOptedOut', inGrace, 'opt-outs', at, readCutoff),
    ]);
    const applicable: bigint[] = [];
    inGrace.forEach((id, i) => {
      const loan = details[i] as LoanDetails | undefined;
      const out = optedOut[i] as boolean | undefined;
      if (loan === undefined || out === undefined) {
        sender.noteUnread(`autoList:${id}`, 'its loan record or opt-out flag');
        return;
      }
      const why = notApplicable(loan, out);
      if (why === null) applicable.push(id);
      else report.notApplicable.push(`loan ${id}: ${why}`);
    });

    // 5. The contract decides.
    // Rotated by this window's own visit count (ScanWindow.round), so each
    // visit to it takes the next batch however many windows the book has.
    const { picked, deferred } = pickBatch(applicable, scan.window.round, MAX_ATTEMPTS_PER_RUN);
    report.deferred = deferred.length;
    for (const id of picked) {
      if (sender.stopped) break;
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call('autoList', String(id), 'autoListAtFloorOnGrace', [id]);
      if (res === 'landed') {
        const ev = listingEvent(diamond, id, sender.receipt?.logs ?? []);
        if (ev === null) report.landedUnread.push(id);
        else (ev.kind === 'posted' ? report.posted : report.rotated).push({ loanId: id, ask: ev.ask });
        continue;
      }
      const words = LOAN_REFUSALS.get(res);
      if (words !== undefined) report.declined.push(`loan ${id}: ${words}`);
    }
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the run deadline passed during its reads');
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

/** Why the call cannot apply to an in-grace loan, from its own record; null
 *  when it can. These mirror the contract's first preconditions only so the
 *  pass does not spend a simulation a minute on a loan they rule out for its
 *  whole grace; the contract still decides every loan that passes them. */
export function notApplicable(loan: LoanDetails, optedOut: boolean): string | null {
  if (Number(loan.status) !== LOAN_ACTIVE) return 'no longer active';
  if (!loan.allowsPrepayListing) return 'its terms do not allow a prepay listing';
  const c = Number(loan.collateralAssetType);
  if (c !== ASSET_ERC721 && c !== ASSET_ERC1155) return 'its collateral is not an NFT';
  if (Number(loan.assetType) !== ASSET_ERC20) return 'its principal is not an ERC-20';
  if (optedOut) return 'the borrower opted out of auto-listing';
  return null;
}

/** The listing a landed call made, from its receipt: Case A posts
 *  (`PrepayListingPosted`), Case B rotates (`PrepayListingUpdated`). */
export function listingEvent(
  diamond: Address,
  loanId: bigint,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
): { kind: 'posted' | 'rotated'; ask: bigint } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: NFTPrepayAutoListFacetABI as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = ev.args as unknown as Record<string, unknown>;
    if (a.loanId !== loanId) continue;
    if (ev.eventName === 'PrepayListingPosted') return { kind: 'posted', ask: a.askPrice as bigint };
    if (ev.eventName === 'PrepayListingUpdated') return { kind: 'rotated', ask: a.newAskPrice as bigint };
  }
  return null;
}
