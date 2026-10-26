// apps/keeper/src/rewardDayClose/constants.ts
//
// #2612 — what the day-close pass calls, and the numbers it works by. One
// place, so a timing or a refusal name is never restated in two modules.

import { toEventSelector, toFunctionSelector, type Abi } from 'viem';
import {
  AdminFacetABI,
  DiamondLoupeFacetABI,
  InteractionRewardsLensFacetABI,
  RewardAggregatorFacetABI,
  RewardBroadcastFacetABI,
  RewardReporterFacetABI,
  VaipakamDiamondABI,
  VaipakamRewardMessengerABI,
} from '@vaipakam/contracts/abis';

export const MESSENGER_ABI = VaipakamRewardMessengerABI as Abi;
/** The Diamond's reward surface, plus the messenger's errors so a fee refusal
 *  bubbled through `closeDay` decodes by name, and the Diamond proxy's own
 *  errors, so a selector the Diamond does not route reads as such
 *  (`FunctionDoesNotExist`). */
export const ABI = [
  ...(AdminFacetABI as Abi),
  ...(InteractionRewardsLensFacetABI as Abi),
  ...(RewardReporterFacetABI as Abi),
  ...(RewardAggregatorFacetABI as Abi),
  ...(RewardBroadcastFacetABI as Abi),
  ...MESSENGER_ABI.filter((x) => x.type === 'error'),
  ...(VaipakamDiamondABI as Abi).filter((x) => x.type === 'error'),
] as Abi;

/** The B4 report's fee quote, which the messengers deployed on the live
 *  testnets carry and the source no longer does (#2790 retired it for fresh
 *  deploys), so the compiled ABI cannot supply it. Copied verbatim from the
 *  messenger ABI exported before that change. Those Diamonds' `closeDay` sends
 *  the B4 report, the one older shape Base applies after finalization, so the
 *  keeper must still price it there. Delete this rung, with `diamondSendsB4`,
 *  once no served chain runs a pre-#2790 messenger (the all-waves fresh
 *  deploy, #2866). */
export const B4_QUOTE_ABI = [
  {
    type: 'function',
    name: 'quoteSendChainReport',
    stateMutability: 'view',
    inputs: [
      { name: 'dayId', type: 'uint256' },
      { name: 'lenderNumeraire18', type: 'uint256' },
      { name: 'borrowerNumeraire18', type: 'uint256' },
      { name: 'recycledCumulative18', type: 'uint256' },
      { name: 'recycledForDay18', type: 'uint256' },
      { name: 'commitRetiredCumulative18', type: 'uint256' },
      { name: 'commitReleasedCumulative18', type: 'uint256' },
      { name: 'custodyEra', type: 'uint64' },
    ],
    outputs: [{ name: 'nativeFee', type: 'uint256' }],
  },
  ...MESSENGER_ABI.filter((x) => x.type === 'error'),
] as const satisfies Abi;

export const LOUPE_ABI = DiamondLoupeFacetABI as Abi;
/** `closeDay`, and `getInterestFrontiers`: the reporter facet gained the
 *  second in the same change (#2459) that gave its `closeDay` the B4 report
 *  send, so a pre-#2790 Diamond routing both to one facet sends B4. */
export const CLOSE_DAY_SELECTOR = toFunctionSelector('closeDay(uint256)');
export const B4_REPORTER_SELECTOR = toFunctionSelector('getInterestFrontiers()');

/** This pass's cadence in seconds (passSchedule). */
export const PASS_CADENCE_SEC = 15 * 60;
/** Recent days each run works even once worked through: two weeks, so a day
 *  finalized without a chain, or a broadcast still unconfirmed, stays in view
 *  that long. Older days are worked only while the ledger holds them owed. */
export const LOOKBACK_DAYS = 14;
/** Transactions one run may send per chain. Each waits for its receipt. */
export const MAX_SENDS_PER_RUN = 8;
/** Entries per aggregate read. A window held open by a stuck day grows by a
 *  day each day it stays stuck; slices of this size keep every aggregate the
 *  size of one ordinary run's, so a long-open window costs more reads and
 *  never one aggregate too large for the node to answer. */
export const READ_CHUNK = 64;
/** Days older than the lookback that one run works from the ledger of owed
 *  days, the least recently worked first, so each comes round in turn. */
export const BACKLOG_PER_RUN = 14;
/** Warn when grace ends within this long and an expected chain is missing… */
export const GRACE_WARNING_SEC = 60 * 60;

/** …or within the last quarter of a grace shorter than four hours. A report
 *  still in flight early in grace is ordinary lane latency, not a fault, so
 *  the warning window scales down with a short grace instead of covering all
 *  of it. */
export function graceWarningSec(graceSec: number): number {
  return Math.min(GRACE_WARNING_SEC, Math.floor(graceSec / 4));
}

/** A served destination still lacking the pair this long after a broadcast
 *  is reported LATE (a CCIP delivery normally lands well inside it)… */
export const BROADCAST_LATE_AFTER_SEC = 2 * 3600;
/** …and the day is broadcast again once this long has passed since the last send. */
export const BROADCAST_RESEND_AFTER_SEC = 6 * 3600;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** What the run keeps for its alerts after the last send. */
export const PASS_ALERT_WINDOW_MS = 2 * 60_000;
/** Repeat an open alert at most this often. */
export const ALERT_REPEAT_SEC = 6 * 3600;
/** A statement (a thing that happened and cannot change): say it once a window. */
export const STATEMENT_REPEAT_SEC = LOOKBACK_DAYS * 86_400;

/** `LibVaipakam.RewardRole`, as `getRewardRole` returns it. */
export const ROLE_CANONICAL = 0;
export const ROLE_MIRROR = 1;
/** `isDayReadyToFinalize` reason for a finalized day. */
export const REASON_FINALIZED = 1;

/** Reverts that mean another caller got there first: re-read next run. */
export const RACES = new Set(['ChainDayAlreadyReported', 'DayAlreadyFinalized', 'ReportAfterFinalization']);
export const PAUSED_REFUSAL = 'EnforcedPause';
export const FRONTIER_SHORT = 'ChainReportFrontierShort';
/** Refusals of the single-destination send (`broadcastGlobalTo`) that mean
 *  this day, this messenger or this Diamond cannot take one: the send then
 *  goes to every destination (`broadcastGlobal`) instead. A Diamond that
 *  routes no single-destination quote or send at all (a partial upgrade)
 *  answers `FunctionDoesNotExist`. */
export const NO_STANDING = 'DestinationHasNoDayStanding';
export const NO_SELECTOR = 'FunctionDoesNotExist';
export const RESEND_TO_ALL = new Set(['MessengerPredatesV3', 'DayHasNoLapseClock', NO_STANDING, NO_SELECTOR]);

/** A step that exists only to let another through: its refusal is over once
 *  the step it serves is done, by anyone. On Base the day's own close serves
 *  its finalization (owed only until the day is finalized, which an admin's
 *  force-finalize can do first). */
export const SERVES: Readonly<Record<string, string>> = { advance: 'close' };
export const SERVES_ON_BASE: Readonly<Record<string, string>> = { advance: 'close', close: 'finalize' };

/** The messenger's per-destination "broadcast left" events, every version:
 *  each indexes the destination chain id second and the day third. */
export const BROADCAST_SENT_TOPICS = new Set<string>(
  ['BroadcastSent(bytes32,uint256,uint256,uint256,uint256)', 'BroadcastV2Sent(bytes32,uint256,uint256)', 'BroadcastV3Sent(bytes32,uint256,uint256)'].map((sig) =>
    toEventSelector(sig).toLowerCase(),
  ),
);
/** The messenger's "report left" event. */
export const REPORT_SENT_TOPIC = toEventSelector('ReportSent(bytes32,uint256,uint256,uint256)').toLowerCase();
