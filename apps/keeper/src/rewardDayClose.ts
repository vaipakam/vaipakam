// apps/keeper/src/rewardDayClose.ts
//
// #2612 — the reward day-close pass: the three permissionless calls the
// cross-chain interaction-reward cycle needs every UTC day.
//
// A reward day's interest reaches the global denominator only when each chain
// REPORTS it and Base FINALIZES it, and a mirror can price its users' claims
// only once Base BROADCASTS the finalized pair back. Each step is a public,
// permissionless call, and before this pass nothing on a live chain made any
// of them: the Anvil mesh scenarios made them by hand. So on every chain
// carrying a live reward clock, each run:
//
//   0. READS the chain's reward role (`getRewardRole`: canonical or mirror;
//      any other role is skipped and says so), the reward clock
//      (`getInteractionCurrentDay`) and the pause state. A chain whose clock
//      is not running, or is still on day 0, has no elapsed day: nothing to do.
//      A paused protocol refuses every one of these calls, so the run sends
//      nothing and raises or clears no alert. It also compares reward clocks
//      (`getInteractionLaunchTimestamp`) with Base, on every chain it can read:
//      a day number must cover the same hours everywhere, or a report is
//      summed into Base's day with interest from other hours, irreversibly. A
//      mirror whose clock differs from Base's closes no day; Base finalizes no
//      day while a listed mirror it serves runs another clock. A chain this
//      keeper does not serve cannot be compared, and the run's line names it.
//   1. CLOSES every elapsed day in its window not yet reported here
//      (`getChainReportSentAt(d) == 0`), oldest first: `closeDay(d)`. On a
//      mirror that sends the day's report to Base over CCIP, and the fee is
//      the messenger's own quote for the report shape the Diamond sends
//      (`quoteSendChainReport`), paid exactly; the messenger refunds any part
//      the lane did not use. On Base it records Base's own report, fee-free. A
//      mirror closes a day even when Base has already finalized it: Base drops
//      that report's DAY figures, but still applies what it says about the
//      CHAIN (its custody era and its cumulative recycled-availability and
//      commitment ratchets), which a mirror's last report before detaching
//      must not lose. Base refuses a report from a chain off its
//      expected-source list outright, that last report included (#2618), so a
//      mirror reads Base's list and says when it is not on it. Only the B4
//      report carries that late path: an older report shape reaching a
//      finalized day is refused on Base after its fee is paid, so a mirror
//      whose messenger cannot quote the B4 report does not send one for a day
//      Base has finalized, or one whose finalization on Base it cannot read
//      (a failed read waits for the next run; a Base this keeper does not
//      serve is said), and says so. For every window day, sent or not, a day Base finalized
//      without this chain's report is reported as such (when this keeper also
//      serves Base). A close refused because the interest fold has not reached
//      the day (`ChainReportFrontierShort`) is preceded by
//      `advanceInterestFrontiers`.
//   2. FINALIZES (Base only) each day whose own report is recorded, when
//      either every chain on Base's expected-source list has reported, or the
//      grace window since the day's first report has elapsed — and only when
//      the contract agrees (`isDayReadyToFinalize`). The keeper's coverage
//      rule is per CHAIN, never a report COUNT: a count can reach the expected
//      number while an expected chain is still missing (a report from a chain
//      not on the list counts too), and finalizing then would zero a report
//      still in flight inside grace. A day finalized with a chain missing
//      zeroes that chain's interest for the day, so the run says so once,
//      whoever finalized it (this keeper, another caller, an admin): the
//      chains are read from Base's own record of who reported the day, at a
//      block where the day is finalized (a report landing later is not
//      recorded as the day's), journaled and recorded, and posted until it is
//      delivered. An empty expected-source list, or one without Base, is never
//      finalized against: every day would finalize as zero, or without Base's
//      own interest, irreversibly.
//   3. BROADCASTS (Base only) each finalized day to the messenger's
//      destinations (`broadcastGlobal`, the quoted fee, paid exactly), and
//      confirms delivery by reading each destination this keeper also serves
//      (`getKnownGlobalInterestNumeraire18(d).isSet` on that mirror). Every
//      judgement is per destination, against the last send that covered it:
//      a destination never sent the day is sent it (one added to the list
//      after the day went out included), and one sent it and still lacking
//      the pair is re-sent {@link BROADCAST_RESEND_AFTER_SEC} after that send.
//      When every listed destination needs the day it goes out in one send
//      to all; otherwise each is sent it alone (`broadcastGlobalTo`), so a
//      lane that delivered is not paid again, falling back to the send to all
//      when the day or the messenger cannot take a single-destination send
//      (the mirror ingress is idempotent, so a re-send cannot double-apply).
//      The destinations a day must reach are every one it has had while
//      worked, and every mirror on Base's expected-source list, listed as a
//      destination or not: a mirror off the list (taken off after a send that
//      never reached it, or never put on) is still checked and sent the day
//      alone (the contract admits a destination with standing in the day),
//      and is named as unreachable if that send is refused, the day staying
//      in view until it can be sent. Off the list, a destination the contract
//      gives no standing in the day (it had no part in it) is owed nothing. A destination list that cannot be read stops only this
//      step. A send that landed is recorded from its receipt, by the
//      messenger's own per-destination events: the send to all reaches the
//      list as it stands when the transaction runs, not as this run read it,
//      so a destination taken off in between is still owed the day and one
//      added is covered (the events are taken from the messenger the run read
//      or the one the Diamond holds at the receipt's block, should governance
//      rotate it in between; a send through any other counts as made,
//      unproven). A destination this keeper does not serve cannot be
//      read: once a receipt shows a message leaving for it, it is never
//      confirmed and the run's line says so; a send to it whose receipt was
//      not seen is re-sent after the re-send interval, the receipt being the
//      only evidence the keeper can have for it, and the run's line names it
//      until then. A send's time is recorded, for the destinations it is
//      meant to cover, before it goes out and kept unless nothing went out,
//      so a send whose receipt was not seen (it may have landed, paying every
//      lane it covered) is not repeated before the re-send interval. A send the node refused outright
//      (insufficient funds, a coded RPC refusal) went nowhere, and is not
//      counted as made.
//
// A call the RPC gives no answer about (a transport error, a timeout) is not
// the contract's refusal: nothing is said about the day, and the run stops
// sending on that RPC.
//
// What the run sends is bounded ({@link MAX_SENDS_PER_RUN} per chain), each
// send is simulated first on the current state, and each waits for its
// receipt before the next (every pass signs from one key). Every call here is
// permissionless; the only value it moves is the CCIP fee the keeper pays.
//
// Every elapsed day enters a ledger of owed days (`day_owed`) before the
// discovery cursor (`day_close`) moves past it, and leaves it only once a run
// sees it worked through, so no elapsed day is skipped, whenever the pass was
// first armed or however long the keeper was down. A day is worked through
// once nothing more is owed on it here: closed on a mirror; on Base,
// finalized, broadcast to every destination it is owed, and its zeroed-chain
// notice delivered (Base's own close is owed only until the day is finalized,
// which an admin's force-finalize can do first; after that a close is refused
// for good). A run works the last {@link LOOKBACK_DAYS} elapsed days and one
// page ({@link BACKLOG_PER_RUN}) of the older owed days, the least recently
// worked first, so however many days are stuck a run's reads stay bounded,
// every owed day comes round in turn, and the newest days are never starved:
// the run works the recent days first, so its sends go to the days still
// inside Base's grace before any backlog day (a page reached after the send
// budget is spent waits for its next turn).
// Its reads go in bounded aggregates ({@link READ_CHUNK}). A day's alerts go
// with it only once it is neither in the lookback nor owed; an owed day a run
// did not reach keeps them until its turn. A day an alert was due on and not
// delivered (the run's time ran out, or the post failed) stays owed, so the
// alert is never lost with a day leaving the ledger; while paused, no day
// leaves it.
//
// OPS alerts (conditions that hold, de-duplicated and cleared):
//   - a call the contract refuses, by step and day, with the reason (a race —
//     another caller closing or finalizing first — is not a refusal);
//   - on Base, an expected chain still missing in the last stretch of grace
//     ({@link graceWarningSec}), naming each missing chain and whether it has
//     sent its report (read on that chain, when served) or not;
//   - on Base, an empty expected-source list, or one that leaves Base itself
//     out (Base's own interest is then summed into no day's global total), or
//     an expected-source list and broadcast-destination list that disagree
//     (an expected mirror no day is broadcast to, whose users could never
//     claim; a destination whose reports Base refuses as unexpected; Base
//     itself, or a mirror twice, among the destinations); each read every run
//     and cleared only on a read showing the fix;
//   - on Base, a broadcast destination list that cannot be read;
//   - on Base, a broadcast a served destination has not received, or whose
//     arrival there cannot be read, {@link BROADCAST_LATE_AFTER_SEC} after it
//     was last sent there, raised in the run that re-sends it too, and
//     standing until the destination is read holding the day;
//   - on a mirror, a day Base finalized without this chain's report;
//   - on a mirror, this chain missing from Base's expected-source list, so
//     Base refuses its reports and the chain-wide figures they carry (#2618);
//   - a reward clock that differs from Base's (on a mirror, its own; on
//     Base, each listed mirror it serves), cleared on a read showing a match.
// A near-end grace warning clears once a run judges the day no longer near
// its end (grace lengthened, or the report landed). A chain that leaves the
// reward set (its role neither canonical nor mirror) is no longer worked, so
// its open alerts are closed and the ops channel told which and why.
// And one NOTICE (a thing that happened): a day Base finalized with expected
// chains missing, naming each.
//
// The pass keeps four kinds of row in the keeper's private open-work queue
// (`keeper_work_open`), per (chain, Diamond): the ledger of owed days (kind
// `day_owed`, one per day); every destination a broadcast's day has had, each
// with the last send that covered it (kind `day_broadcast`; losing it costs
// at most one extra broadcast, and forgets a destination removed since); a
// finalized day's zeroed chains with whether that notice was delivered (kind
// `day_zeroed`); those two kept while their day is owed or in the lookback;
// and each peer chain's reward clock as last read (kind `day_clock`, by peer
// chain), so a mismatch once seen holds while the peer cannot be read. Beside
// them it keeps one cursor per (chain, Diamond), the first day not yet entered
// into the ledger (`keeper_work_cursor`, kind `day_close`), which only moves
// forward; losing it costs one run re-entering days from day 0 (idempotent).
//
// Gated by KEEPER_ENABLED + REWARD_DAY_CLOSE_ENABLED.

import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, http, toEventSelector, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import {
  AdminFacetABI,
  InteractionRewardsLensFacetABI,
  RewardAggregatorFacetABI,
  RewardBroadcastFacetABI,
  RewardReporterFacetABI,
  VaipakamRewardMessengerABI,
} from '@vaipakam/contracts/abis';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import { isDefinitiveRejection, reportSendError } from './submissionQueue';
import type { PassTick } from './passSchedule';
import { boundedRead, deadlineClient, PastRunDeadline } from './batchRead';
import {
  enqueueWork,
  finishWork,
  getWorkCursor,
  getWorkItems,
  listOpenWorkBelow,
  listOpsAlertKeys,
  openWorkAmong,
  pruneWorkBelowUnlessOpen,
  putWork,
  putWorkCursor,
  touchOpenWork,
  type WorkItem,
} from './db';
import { resolveOpsAlert, sendOpsAlert, sendOpsNoticeDigest } from './opsAlert';

const MESSENGER_ABI = VaipakamRewardMessengerABI as Abi;
/** The Diamond's reward surface, plus the messenger's errors so a fee refusal
 *  bubbled through `closeDay` decodes by name. */
const ABI = [
  ...(AdminFacetABI as Abi),
  ...(InteractionRewardsLensFacetABI as Abi),
  ...(RewardReporterFacetABI as Abi),
  ...(RewardAggregatorFacetABI as Abi),
  ...(RewardBroadcastFacetABI as Abi),
  ...MESSENGER_ABI.filter((x) => x.type === 'error'),
] as Abi;

/** This pass's cadence in seconds (passSchedule). */
export const PASS_CADENCE_SEC = 15 * 60;
/** Recent days each run works even once worked through: two weeks, so a day
 *  finalized without a chain, or a broadcast still unconfirmed, stays in view
 *  that long. Older days are worked only while the ledger holds them owed. */
export const LOOKBACK_DAYS = 14;
/** Transactions one run may send per chain. Each waits for its receipt. */
export const MAX_SENDS_PER_RUN = 8;

/** Entries per aggregate read. A window held open by a day that is stuck
 *  grows by a day each day it stays stuck; reading it in slices of this size
 *  keeps every aggregate the size of one ordinary run's, so a long-open
 *  window costs more reads and never one aggregate too large for the node to
 *  answer, which would leave every day in it, the newest included, unread. */
export const READ_CHUNK = 64;

/** Days older than the lookback that one run works from the ledger of owed
 *  days, the least recently worked first, so each owed day comes round in
 *  turn however many there are. */
export const BACKLOG_PER_RUN = 14;
/** Warn when grace ends within this long and an expected chain is missing… */
export const GRACE_WARNING_SEC = 60 * 60;

/** …or within the last quarter of a grace shorter than four hours. A report
 *  still in flight early in grace is ordinary lane latency, not a fault, so
 *  the warning window scales down with a short grace instead of covering all
 *  of it (a one-hour grace would otherwise warn on every report the moment
 *  Base's own landed first). */
export function graceWarningSec(graceSec: number): number {
  return Math.min(GRACE_WARNING_SEC, Math.floor(graceSec / 4));
}
/** A served destination still lacking the pair this long after a broadcast
 *  is reported LATE (a CCIP delivery normally lands well inside it)… */
export const BROADCAST_LATE_AFTER_SEC = 2 * 3600;
/** …and the day is broadcast again once this long has passed since the last send. */
export const BROADCAST_RESEND_AFTER_SEC = 6 * 3600;
const RECEIPT_TIMEOUT_MS = 30_000;
/** What the run keeps for its alerts after the last send. */
export const PASS_ALERT_WINDOW_MS = 2 * 60_000;
/** Repeat an open alert at most this often. */
const ALERT_REPEAT_SEC = 6 * 3600;
/** A day Base finalized without this chain stays so: say it once a window. */
const EXCLUDED_REPEAT_SEC = LOOKBACK_DAYS * 86_400;

/** `LibVaipakam.RewardRole`, as `getRewardRole` returns it. */
export const ROLE_CANONICAL = 0;
export const ROLE_MIRROR = 1;
/** `isDayReadyToFinalize` reason for a finalized day. */
const REASON_FINALIZED = 1;

/** Reverts that mean another caller got there first: re-read next run. */
const RACES = new Set(['ChainDayAlreadyReported', 'DayAlreadyFinalized', 'ReportAfterFinalization']);
const PAUSED_REFUSAL = 'EnforcedPause';
/** Refusals of the single-destination re-send (`broadcastGlobalTo`) that mean
 *  this day or this messenger cannot take one: the re-send then goes to every
 *  destination (`broadcastGlobal`) instead. */
const NO_STANDING = 'DestinationHasNoDayStanding';
const RESEND_TO_ALL = new Set(['MessengerPredatesV3', 'DayHasNoLapseClock', NO_STANDING]);

/** A step that exists only to let another one through: its refusal is over
 *  once the step it serves is done, by anyone. */
const SERVES: Readonly<Record<string, string>> = { advance: 'close' };
const FRONTIER_SHORT = 'ChainReportFrontierShort';

// ─── Pure planning ──────────────────────────────────────────────────────

/** The elapsed days a run works, in the order it works them: the last
 *  `lookback` elapsed days, oldest first, then `owed`, a page of older days
 *  the ledger holds as not yet worked through, oldest first. The recent days
 *  come first because they are the ones still inside Base's grace: a backlog
 *  day worked ahead of them could spend the run's sends while a recent day's
 *  report runs out of time. Floored at day 0; empty on day 0. However many
 *  days are owed, a run works at most `lookback` plus one page of them, so a
 *  day stuck for good costs its own slot and never the newer days' reads or
 *  sends. Pure. */
export function dayWindow(today: number, owed: readonly number[] = [], lookback = LOOKBACK_DAYS): number[] {
  const recent: number[] = [];
  for (let d = Math.max(0, today - lookback); d < today; d++) recent.push(d);
  const backlog = [...new Set(owed)].filter((d) => Number.isSafeInteger(d) && d >= 0 && d < Math.max(0, today - lookback));
  return [...recent, ...backlog.sort((a, b) => a - b)];
}

/** What Base's state says about one day, for finalization. */
export interface FinalizeInput {
  day: number;
  finalized: boolean;
  /** Base's own report for the day is recorded (`getChainReportSentAt != 0`). */
  ownReported: boolean;
  /** The contract's readiness (`isDayReadyToFinalize`). */
  contractReady: boolean;
  /** `getDailyFirstReportAt` (0 = no report yet). */
  firstReportAt: number;
  /** Base's own chain id: a list without it is never finalized against. */
  selfChainId: number;
  /** Base's expected-source list and which of them have reported this day. */
  expected: readonly number[];
  reported: ReadonlySet<number>;
  /** Expected chains whose report status could not be read this run: neither
   *  reported nor missing, and never counted toward full coverage. */
  unknown?: ReadonlySet<number>;
}

export type FinalizeDecision =
  | { kind: 'done' }
  | { kind: 'own-report-first' }
  | { kind: 'no-expected' }
  | { kind: 'self-not-expected' }
  | { kind: 'finalize'; missing: number[] }
  | { kind: 'wait'; missing: number[]; unknown: number[]; graceEndsAt: number | null };

/**
 * Whether to finalize a day now. Pure.
 *
 * Finalize when every expected chain has reported, or when the grace since the
 * day's first report has elapsed — and in either case only when the contract
 * agrees. Coverage is judged chain by chain, never by the contract's report
 * count, which a report from a chain not on the list also raises.
 */
export function planFinalize(x: FinalizeInput, graceSec: number, nowSec: number): FinalizeDecision {
  if (x.finalized) return { kind: 'done' };
  if (!x.ownReported) return { kind: 'own-report-first' };
  if (x.expected.length === 0) return { kind: 'no-expected' };
  // Base's own interest would be left out of the day's total, irreversibly.
  if (!x.expected.includes(x.selfChainId)) return { kind: 'self-not-expected' };
  const unknown = x.expected.filter((c) => !x.reported.has(c) && x.unknown?.has(c) === true);
  const missing = x.expected.filter((c) => !x.reported.has(c) && x.unknown?.has(c) !== true);
  const graceEndsAt = x.firstReportAt > 0 ? x.firstReportAt + graceSec : null;
  const graceElapsed = graceEndsAt !== null && nowSec >= graceEndsAt;
  const complete = missing.length === 0 && unknown.length === 0;
  if ((complete || graceElapsed) && x.contractReady) return { kind: 'finalize', missing };
  return { kind: 'wait', missing, unknown, graceEndsAt };
}

/** One broadcast destination, as this run read it. */
export type DestinationState = 'received' | 'missing' | 'unread' | 'unserved';

/** What to do for a finalized day's broadcast this run, per destination. */
export interface BroadcastPlan {
  /** Destinations to send to now. */
  send: number[];
  /** Of `send`, those this keeper sent the day to before (a re-send). */
  resend: number[];
  /** Destinations sent to, not read as holding the day, past the late mark
   *  since their last send: `missing` read as lacking it, `unread` unknown. */
  late: { chain: number; state: 'missing' | 'unread'; sentAt: number }[];
  /** Destinations sent to that this keeper does not serve: never confirmed. */
  unconfirmed: number[];
  /** Destinations this keeper does not serve whose last send is not shown to
   *  have left for them (its receipt was not seen): re-sent once the re-send
   *  interval has passed, since nothing else can say whether it went. */
  unproven: number[];
  /** Every destination holds the day, or was sent it and cannot be read. */
  done: boolean;
}

/** This keeper's last send of a day covering one destination: when it went,
 *  and whether its receipt shows the message leaving for that destination
 *  (false: written before the send, or the send went out with no receipt
 *  seen, so whether it left is unknown). */
export interface SendMark {
  at: number;
  proven: boolean;
}

/**
 * The broadcast plan for a finalized day. Pure, and judged destination by
 * destination: `sentTo` is this keeper's last send covering each destination
 * (absent or null = never), so a destination added after the day was sent is
 * sent to like any other never-sent one.
 *
 * A destination holding the day needs nothing. One never sent to is sent to,
 * whatever its read (an unread or unserved one included: the ingress applies
 * a day once). One sent to and not served cannot be confirmed: it is done once
 * a send's receipt shows the message leaving for it, and otherwise re-sent
 * after {@link BROADCAST_RESEND_AFTER_SEC}, the receipt being the only
 * evidence this keeper can have for it. One sent to
 * and read as lacking it is late after {@link BROADCAST_LATE_AFTER_SEC} and
 * re-sent after {@link BROADCAST_RESEND_AFTER_SEC}; one sent to whose read
 * failed is never re-sent blind, and is late (as unknown) past the late mark.
 * Lateness is measured from the last send and never depends on what this run
 * then sends, so a late destination is reported in the run that re-sends.
 */
export function planBroadcast(dest: ReadonlyMap<number, DestinationState>, sentTo: ReadonlyMap<number, SendMark | null>, nowSec: number): BroadcastPlan {
  const plan: BroadcastPlan = { send: [], resend: [], late: [], unconfirmed: [], unproven: [], done: true };
  for (const [c, state] of dest) {
    if (state === 'received') continue;
    const mark = sentTo.get(c) ?? null;
    if (mark === null) {
      plan.send.push(c);
      plan.done = false;
      continue;
    }
    const at = mark.at;
    const since = nowSec - at;
    if (state === 'unserved') {
      if (mark.proven) {
        plan.unconfirmed.push(c);
        continue;
      }
      plan.done = false;
      if (since >= BROADCAST_RESEND_AFTER_SEC) {
        plan.send.push(c);
        plan.resend.push(c);
      } else plan.unproven.push(c);
      continue;
    }
    plan.done = false;
    if (since >= BROADCAST_LATE_AFTER_SEC) plan.late.push({ chain: c, state, sentAt: at });
    if (state === 'missing' && since >= BROADCAST_RESEND_AFTER_SEC) {
      plan.send.push(c);
      plan.resend.push(c);
    }
  }
  return plan;
}

// ─── The run ────────────────────────────────────────────────────────────

export async function runRewardDayClose(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardDayClose', 'REWARD_DAY_CLOSE_ENABLED')) return;
  const sendDeadline = tick.deadlineMs - PASS_ALERT_WINDOW_MS;
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        await dayCloseOnce(env, chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          peer: (id) => peerReader(chains, id, sendDeadline),
          sendDeadline,
          runDeadline: tick.deadlineMs,
        });
      } catch (err) {
        console.error(`[keeper] rewardDayClose chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

/** A read-only view of ANOTHER chain this keeper serves. */
export interface PeerReader {
  diamond: Address;
  client: PublicClient;
}

function peerReader(chains: readonly ChainConfig[], id: number, deadline: number): PeerReader | null {
  const c = chains.find((x) => x.id === id);
  if (!c) return null;
  return { diamond: c.diamond as Address, client: deadlineClient(createPublicClient({ transport: http(c.rpc) }) as PublicClient, deadline) };
}

/** What one chain's run reads and signs with. Injected so the run is testable
 *  against a fake chain. */
export interface DayCloseDeps {
  /** Deadline-bound client: single reads and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  /** The signing context, built only when there is something to send. */
  context: () => KeeperContext | null;
  /** Another chain this keeper serves, by EVM chain id (null = not served). */
  peer: (chainId: number) => PeerReader | null;
  sendDeadline: number;
  runDeadline: number;
}

/** What a run measured, for its alerts. */
interface RunFindings {
  /** `step:day` → reason, for calls the contract refused this run. */
  refused: Map<string, string>;
  /** `step:day` keys whose work is DONE: what takes a day out of the ledger. A call
   *  landing is not that by itself (a day's broadcast is done only once every
   *  destination it is owed is covered), so landings are kept apart. */
  settled: Set<string>;
  /** `step:day` keys whose call landed this run: what clears a refusal. */
  landed: Set<string>;
  /** Base: days waiting on expected chains, with what is known of each. */
  waiting: { day: number; missing: number[]; unknown: number[]; graceEndsAt: number | null; sent: Map<number, number | null> }[];
  /** Base: the expected-source list is empty. Null = not read this run, so
   *  neither raised nor cleared. */
  noExpected: boolean | null;
  /** Base: the expected-source list leaves Base itself out (null = not read). */
  selfNotExpected: boolean | null;
  /** Base: where the expected-source and broadcast-destination lists
   *  disagree (null = not read). `undeliverable`: expected mirrors no day is
   *  broadcast to; `unexpected`: destinations whose reports Base refuses. */
  topology: { undeliverable: number[]; unexpected: number[]; self: boolean; repeated: number[] } | null;
  /** Base: the messenger's broadcast destinations could not be read, so no
   *  day was broadcast this run (null = not attempted). */
  destinationsUnread: boolean | null;
  /** Base: finalized days every destination was READ holding this run. A
   *  day with a destination this keeper cannot read is never confirmed, even
   *  when there is nothing left to send it, so a late alert raised while that
   *  destination could be read is not cleared by losing the read. */
  broadcastConfirmed: Set<number>;
  /** Base: days a destination sent to has not been read as holding, past the
   *  late mark since its last send. */
  lateBroadcast: { day: number; late: BroadcastPlan['late'] }[];
  /** Mirror: days Base finalized without this chain's report. */
  excluded: number[];
  /** Mirror: this chain is absent from Base's expected-source list, so Base
   *  refuses its reports (null = not read: Base not served, or unread). */
  notExpectedOnBase: boolean | null;
  /** The reward clocks compared against Base's (null = not read): Base's
   *  launch timestamp, and each served chain whose launch differs. */
  /** `stale`: some clock was judged from its last read, this run's failing,
   *  so a match then is not a read showing the fix. */
  clock: { base: number; differ: { chain: number; launch: number; lastRead: boolean }[]; stale: boolean } | null;
  /** Base: open days this run judged for finalization. */
  judged: Set<number>;
  /** The days this run's window covered. */
  window: number[];
}

/** One chain's run. Exported for tests. */
export async function dayCloseOnce(env: Env, chainId: number, diamond: Address, deps: DayCloseDeps): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const where = `chain=${chainId}`;
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    deps.client.readContract({ address: diamond, abi: ABI, functionName, args }) as Promise<T>;

  const role = Number(await read<number>('getRewardRole'));
  if (role !== ROLE_CANONICAL && role !== ROLE_MIRROR) {
    console.log(`[keeper] rewardDayClose ${where}: reward role ${role} is neither canonical nor mirror — nothing to close`);
    await retireDayCloseAlerts(env, chainId, role, deps.runDeadline);
    return;
  }
  const [todayRaw, active] = await read<readonly [bigint, boolean]>('getInteractionCurrentDay');
  const today = Number(todayRaw);
  if (!active || today === 0) {
    console.log(`[keeper] rewardDayClose ${where}: ${active ? 'reward day 0 is still running' : 'reward clock not running'} — no elapsed day`);
    return;
  }
  if (await read<boolean>('paused')) {
    console.log(`[keeper] rewardDayClose ${where}: protocol paused — nothing sent, alerts left as they stand`);
    return;
  }
  const [messenger, , baseChainId, , graceSecRaw] = await read<readonly [Address, number, number, boolean, bigint]>('getRewardReporterConfig');
  const graceSec = Number(graceSecRaw);
  const launch = Number(await read<bigint>('getInteractionLaunchTimestamp'));
  const window = await openDays(env, chainId, diamond, today);
  const canonical = role === ROLE_CANONICAL;

  const f: RunFindings = {
    refused: new Map(),
    settled: new Set(),
    landed: new Set(),
    waiting: [],
    noExpected: null,
    selfNotExpected: null,
    topology: null,
    destinationsUnread: null,
    broadcastConfirmed: new Set(),
    lateBroadcast: [],
    excluded: [],
    notExpectedOnBase: null,
    clock: null,
    judged: new Set(),
    window,
  };
  const sender = new Sender(deps, f);

  // ── 1. Close ──
  const sentAt = await readDays<bigint>(deps, diamond, window, 'getChainReportSentAt', where);
  let finalizedOnBase = new Set<number>();
  /** Mirror: window days whose finalization on Base could not be read. */
  let finalizationUnread = new Set<number>();
  let baseServed = true;
  const unclosed = window.filter((d) => sentAt.get(d) === 0n);
  for (const d of window) if ((sentAt.get(d) ?? 0n) > 0n) f.settled.add(`close:${d}`);
  if (!canonical) {
    // Every window day, sent or not: Base may have finalized a day at grace
    // while this chain's report was still in flight. Either way the day is
    // finalized without this chain's interest, and it stays so. The day is
    // still closed below: its report carries chain-wide figures Base applies
    // after finalization too.
    const base = deps.peer(baseChainId);
    baseServed = base !== null;
    const onBase = await baseView(base, window, chainId, deps.sendDeadline);
    // Base refuses a report from a chain off its expected-source list, the
    // last one before the chain detaches included (#2618): the report still
    // goes out, and the run says so.
    f.notExpectedOnBase = await absentFromBaseList(base, chainId, where);
    // The same day number must cover the same hours here and on Base, or the
    // report is summed into Base's day with interest from other hours.
    const baseClock = await peerClock(env, chainId, diamond, baseChainId, base, where);
    if (baseClock !== null) {
      f.clock = { base: baseClock.launch, differ: baseClock.launch === launch ? [] : [{ chain: chainId, launch, lastRead: false }], stale: baseClock.lastRead };
    }
    // A day Base can finalize now is as unsafe for an older report as one it
    // has finalized: anyone may finalize it before the report lands.
    finalizedOnBase = new Set(window.filter((d) => onBase.get(d)?.finalized === true || onBase.get(d)?.ready === true));
    finalizationUnread = new Set(window.filter((d) => typeof onBase.get(d)?.finalized !== 'boolean'));
    f.excluded = window.filter((d) => onBase.get(d)?.finalized === true && onBase.get(d)?.counted === false);
  }
  let closed = 0;
  const clockOff = (f.clock?.differ.length ?? 0) > 0;
  for (const d of clockOff ? [] : unclosed) {
    // eslint-disable-next-line no-await-in-loop
    const q = canonical ? { fee: 0n, b4: true } : await reportFee(deps.client, messenger, d);
    if (q === 'unread') {
      console.error(`[keeper] rewardDayClose ${where}: report fee for day ${d} unread, the RPC did not answer; left for the next run`);
      continue;
    }
    if (q === 'refused') {
      f.refused.set(`close:${d}`, 'the messenger would not quote the report fee');
      continue;
    }
    if (finalizedOnBase.has(d) && !q.b4) {
      // Only the B4 report has Base's late path: an older shape reaching a
      // finalized day is refused there (ReportAfterFinalization), after its
      // fee is paid and this chain has recorded the day as sent.
      f.refused.set(
        `close:${d}`,
        "Base has finalized this day or can finalize it now, and this chain's messenger cannot quote the B4 report, the only shape whose chain-wide figures Base applies after finalization; an older report landing after finalization is refused on Base after its fee is paid, so it is not sent",
      );
      continue;
    }
    if (finalizationUnread.has(d) && !q.b4) {
      // Fail closed: an older report shape is safe only for a day Base has
      // not finalized, and that is not known. A read that failed is retried
      // next run; a Base this keeper does not serve is never readable here.
      if (baseServed) {
        console.error(`[keeper] rewardDayClose ${where}: day ${d} not closed: whether Base has finalized it is unread, and this chain's messenger cannot quote the B4 report; left for the next run`);
      } else {
        f.refused.set(
          `close:${d}`,
          "this keeper does not serve Base, so whether Base has finalized this day cannot be read, and this chain's messenger cannot quote the B4 report, the only shape safe to send for a finalized day; an older report would be refused on Base after its fee is paid if the day is finalized, so it is not sent",
        );
      }
      continue;
    }
    const fee = q.fee;
    // eslint-disable-next-line no-await-in-loop
    let r = await sender.call('close', d, 'closeDay', [BigInt(d)], fee);
    if (r === FRONTIER_SHORT) {
      // eslint-disable-next-line no-await-in-loop
      const a = await sender.call('advance', d, 'advanceInterestFrontiers', [BigInt(d)], 0n);
      // eslint-disable-next-line no-await-in-loop
      if (a === 'landed') r = await sender.call('close', d, 'closeDay', [BigInt(d)], fee);
    }
    if (r === 'landed') {
      closed += 1;
      sentAt.set(d, BigInt(nowSec));
      f.settled.add(`close:${d}`);
    }
    if (sender.stopped) break;
  }

  // ── 2. Finalize, 3. broadcast (Base) ──
  let clockNote = '';
  let finalized = 0;
  let broadcast = 0;
  const unconfirmed: number[] = [];
  const unproven: string[] = [];
  if (canonical) {
    // The topology is read every run, whatever the send budget left: its
    // alerts are raised and cleared only on what this run actually read.
    const expected = (await read<readonly number[]>('getExpectedSourceChainIds')).map(Number);
    // An unread destination list stops only the broadcast: finalizing needs
    // the expected-source list alone, and a finalized day can be broadcast on
    // any later run.
    const destinations = await broadcastDestinations(deps.client, messenger, where);
    f.noExpected = expected.length === 0;
    f.selfNotExpected = !f.noExpected && !expected.includes(chainId);
    f.destinationsUnread = destinations === null;
    if (destinations !== null) {
      f.topology = {
        undeliverable: expected.filter((c) => c !== chainId && !destinations.includes(c)),
        unexpected: destinations.filter((c) => !expected.includes(c)),
        self: destinations.includes(chainId),
        repeated: [...new Set(destinations.filter((c, i) => destinations.indexOf(c) !== i))],
      };
    }
    // Every expected mirror this keeper serves must run Base's reward clock:
    // a day finalized with a report from a chain whose day N covers other
    // hours sums unrelated interest into one global total, irreversibly. A
    // mirror this keeper does not serve cannot be compared, and the run's line
    // names it.
    const differ: { chain: number; launch: number; lastRead: boolean }[] = [];
    const clockUnchecked: number[] = [];
    let stale = false;
    for (const c of expected) {
      if (c === chainId) continue;
      // eslint-disable-next-line no-await-in-loop
      const l = await peerClock(env, chainId, diamond, c, deps.peer(c), where);
      if (l === null || l.lastRead) clockUnchecked.push(c);
      if (l?.lastRead) stale = true;
      if (l !== null && l.launch !== launch) differ.push({ chain: c, launch: l.launch, lastRead: l.lastRead });
    }
    f.clock = { base: launch, differ, stale };
    if (clockUnchecked.length > 0) clockNote = ` clock-unchecked=${clockUnchecked.join(',')}`;
    const ready = await readDays<readonly [boolean, number]>(deps, diamond, window, 'isDayReadyToFinalize', where);
    const firstAt = await readDays<bigint>(deps, diamond, window, 'getDailyFirstReportAt', where);
    const open = window.filter((d) => ready.has(d) && Number(ready.get(d)![1]) !== REASON_FINALIZED);
    const reported = await readReported(deps, diamond, open, expected, where);
    const finalizedDays = new Set(window.filter((d) => ready.has(d) && Number(ready.get(d)![1]) === REASON_FINALIZED));

    for (const d of differ.length > 0 ? [] : open) {
      if (sender.stopped) break;
      f.judged.add(d);
      const decision = planFinalize(
        {
          day: d,
          finalized: false,
          ownReported: (sentAt.get(d) ?? 0n) > 0n,
          selfChainId: chainId,
          contractReady: Boolean(ready.get(d)![0]),
          firstReportAt: Number(firstAt.get(d) ?? 0n),
          expected,
          reported: reported.get(d)?.reported ?? new Set(),
          unknown: reported.get(d)?.unknown ?? new Set(expected),
        },
        graceSec,
        nowSec,
      );
      if (decision.kind === 'finalize') {
        // eslint-disable-next-line no-await-in-loop
        const r = await sender.call('finalize', d, 'finalizeDay', [BigInt(d)], 0n);
        if (r === 'landed') {
          finalized += 1;
          finalizedDays.add(d);
        }
      } else if (decision.kind === 'wait' && (decision.missing.length > 0 || decision.unknown.length > 0)) {
        const nearEnd = decision.graceEndsAt !== null && decision.graceEndsAt - nowSec <= graceWarningSec(graceSec);
        if (nearEnd) {
          f.waiting.push({
            day: d,
            missing: decision.missing,
            unknown: decision.unknown,
            graceEndsAt: decision.graceEndsAt,
            // eslint-disable-next-line no-await-in-loop
            sent: await peerSentAt(deps, decision.missing, d),
          });
        }
      }
    }
    for (const d of finalizedDays) f.settled.add(`finalize:${d}`);
    await recordZeroed(env, deps, chainId, diamond, [...finalizedDays], expected, where);

    // ── 3. Broadcast ──
    // A day's broadcast record lives exactly as long as the day is in the
    // window: kept while it is worked, dropped when the day leaves it, and
    // read by day, never as a slice of the queue. It holds, for every
    // destination the day has had while worked, the last send that covered
    // it (null = known, never sent by this keeper). It only grows: a mirror
    // taken off the messenger's list after a send that never reached it still
    // lacks the day, and is still checked and sent to; a mirror added to the
    // list after the day was sent has never been sent it, and is sent to. A
    // send's time is written, for the destinations that send covers, BEFORE
    // it goes out, and put back unless no transaction went out, so a send
    // whose receipt was not seen (it may have landed, paying every lane it
    // covered) is never repeated before the re-send interval. A send that
    // landed is recorded from its receipt, never from the list as this run
    // read it: the all-destination send goes to the messenger's list as it
    // stands when the transaction runs, so a destination taken off the list
    // in between is not covered by it, and one added is.
    /** The reward messenger the Diamond held at `blockNumber`, or null when
     *  that cannot be read. */
    const messengerAt = async (blockNumber: bigint): Promise<Address | null> => {
      try {
        const [m] = (await deps.client.readContract({ address: diamond, abi: ABI, functionName: 'getRewardReporterConfig', blockNumber })) as readonly [Address, ...unknown[]];
        return m;
      } catch (err) {
        console.error(`[keeper] rewardDayClose ${where}: reward messenger at block ${blockNumber} unread: ${shortErr(err)}`);
        return null;
      }
    };
    /** Send day `d` to every destination on the messenger's list
     *  (`broadcastGlobal`). */
    const broadcastAll = async (d: number): Promise<CallResult> => {
      const q = await quote(deps.client, diamond, 'quoteBroadcastGlobal', [BigInt(d)]);
      if ('unread' in q) return 'skipped';
      if ('refused' in q) {
        f.refused.set(`broadcast:${d}`, `the Diamond would not quote the broadcast fee (${q.refused})`);
        return q.refused;
      }
      return sender.call('broadcast', d, 'broadcastGlobal', [BigInt(d)], q.fee);
    };
    /**
     * One send of day `d`, meant to cover the destinations `covered`: their
     * send is recorded, unproven, before it goes out, and put back unless a
     * transaction went out. One that went out with no receipt seen may have
     * landed, so it counts as made, unproven. One that landed is recorded
     * from its receipt: the destinations its messages left for are marked
     * proven, whether or not this run expected them, and a covered one it
     * did not send to is put back.
     */
    const sendCovering = async (
      d: number,
      covered: readonly number[],
      sentTo: Map<number, SendMark | null>,
      save: () => Promise<unknown>,
      send: () => Promise<CallResult>,
    ): Promise<CallResult> => {
      const prior = covered.map((c) => [c, sentTo.get(c) ?? null] as const);
      const before = sender.maybeSent;
      const at = Math.floor(Date.now() / 1000);
      for (const c of covered) sentTo.set(c, { at, proven: false });
      await save();
      const r = await send();
      if (sender.maybeSent === before) {
        for (const [c, t] of prior) sentTo.set(c, t);
        await save();
      } else if (r === 'landed') {
        const receipt = sender.receipt;
        const atBlock = receipt === null ? null : await messengerAt(receipt.blockNumber);
        const left = broadcastsLeft(receipt, atBlock === null ? [messenger] : [messenger, atBlock], d);
        if (left === null) {
          // Sent through a messenger this run cannot name: the send counts
          // as made, unproven, as one whose receipt was not seen.
          console.error(`[keeper] rewardDayClose ${where} broadcast of day ${d} landed through a messenger this run cannot name; its destinations are recorded as sent, unproven`);
        } else {
          for (const [c, t] of prior) if (!left.has(c)) sentTo.set(c, t);
          for (const c of left) sentTo.set(c, { at, proven: true });
          await save();
        }
      }
      return r;
    };
    /**
     * Deliver day `d` to `targets`, the destinations the plan sends to now.
     * One rule for a first send and a re-send, by which destinations need it:
     *   - when every destination on the messenger's list needs it, one
     *     all-destination send (`broadcastGlobal`) reaches them all;
     *   - otherwise each target is sent the day alone (`broadcastGlobalTo`),
     *     so a lane that delivered is not paid again, and a destination added
     *     to the list after the day was sent is reached alone; where the day
     *     or the messenger cannot take a single-destination send, a target on
     *     the list is reached by the all-destination send after all;
     *   - a target taken off the list since is reachable only alone, the
     *     contract admitting it by its standing in the day; when the contract
     *     will not, no send can reach it, and the run says so.
     */
    const deliver = async (
      d: number,
      targets: readonly number[],
      current: readonly number[],
      sentTo: Map<number, SendMark | null>,
      save: () => Promise<unknown>,
    ): Promise<void> => {
      const key = `broadcast:${d}`;
      let toAll = current.length > 0 && current.every((c) => targets.includes(c));
      const said: string[] = [];
      for (const c of toAll ? targets.filter((t) => !current.includes(t)) : targets) {
        if (sender.stopped) break;
        // eslint-disable-next-line no-await-in-loop
        const q = await quote(deps.client, diamond, 'quoteBroadcastGlobalTo', [BigInt(d), BigInt(c)]);
        if ('unread' in q) continue;
        const r =
          'refused' in q
            ? q.refused
            : // eslint-disable-next-line no-await-in-loop
              await sendCovering(d, [c], sentTo, save, () => sender.call('broadcast', d, 'broadcastGlobalTo', [BigInt(d), BigInt(c)], q.fee));
        if (r === 'landed' || r === 'skipped') continue;
        if (RESEND_TO_ALL.has(r) && current.includes(c)) toAll = true;
        else if (RESEND_TO_ALL.has(r)) said.push(`chain ${c} is not a broadcast destination and the Diamond will not send the day to it alone (${r})`);
        else if ('refused' in q) said.push(`the Diamond would not quote the send to chain ${c} (${q.refused})`);
        else said.push(`the send to chain ${c} was refused (${r})`);
      }
      // A single-destination refusal the all-destination send answers is not
      // a refusal of the day: what stands is what that send says, plus what no
      // send here could answer.
      f.refused.delete(key);
      if (toAll && !sender.stopped) await sendCovering(d, current, sentTo, save, () => broadcastAll(d));
      const all = f.refused.get(key);
      if (all !== undefined || said.length > 0) f.refused.set(key, [all, ...said].filter(Boolean).join('; '));
    };

    const current = destinations ?? [];
    const mirrors = expected.filter((c) => c !== chainId);
    // In the window's order: the recent days before the backlog page.
    const days = destinations === null ? [] : window.filter((d) => finalizedDays.has(d));
    const marks = await getWorkItems<BroadcastRecord>(env.KEEPER_DB, chainId, diamond, 'day_broadcast', days.map(String));

    for (const d of days) {
      if (sender.stopped) break;
      const sentTo = new Map<number, SendMark | null>(Object.entries(marks.get(String(d))?.payload.sentTo ?? {}).map(([c, t]) => [Number(c), t]));
      const save = () =>
        putWork(env.KEEPER_DB, chainId, diamond, 'day_broadcast', {
          item: String(d),
          block: d,
          payload: { sentTo: Object.fromEntries([...sentTo].sort(([a], [b]) => a - b).map(([c, t]) => [String(c), t])) },
        } as WorkItem<BroadcastRecord>);
      // The destinations the day is owed to: those it has had while worked,
      // the current list, and every expected mirror, listed or not. A mirror
      // Base expects reports from has users who claim against the day, so a
      // day is not done while one lacks it because it is missing from the
      // list: it stays in view (and the topology alert stands) until the
      // mirror can be sent it.
      const fresh = [...new Set([...current, ...mirrors])].filter((c) => !sentTo.has(c));
      for (const c of fresh) sentTo.set(c, null);
      // eslint-disable-next-line no-await-in-loop
      if (fresh.length > 0) await save();
      // eslint-disable-next-line no-await-in-loop
      const dest = await destinationStates(deps, [...sentTo.keys()].sort((a, b) => a - b), d);
      // Off the list, a destination is owed the day only where the contract
      // gives it standing in it (it reported the day, was zeroed from it, or
      // carries its commitments): one with none had no part in the day, and
      // the single-destination send that alone could reach it refuses it.
      for (const [c, state] of dest) {
        if (state === 'received' || current.includes(c)) continue;
        // eslint-disable-next-line no-await-in-loop
        const q = await quote(deps.client, diamond, 'quoteBroadcastGlobalTo', [BigInt(d), BigInt(c)]);
        if ('refused' in q && q.refused === NO_STANDING) dest.delete(c);
      }
      const plan = planBroadcast(dest, sentTo, nowSec);
      if (plan.late.length > 0) f.lateBroadcast.push({ day: d, late: plan.late });
      for (const c of plan.unproven) unproven.push(`${d}:${c}`);
      if (plan.done) {
        f.settled.add(`broadcast:${d}`);
        if (plan.unconfirmed.length > 0) unconfirmed.push(d);
        else f.broadcastConfirmed.add(d);
        continue;
      }
      if (plan.send.length === 0) continue;
      const before = sender.maybeSent;
      // eslint-disable-next-line no-await-in-loop
      await deliver(d, plan.send, current, sentTo, save);
      if (sender.maybeSent > before) broadcast += 1;
    }
  }


  console.log(
    `[keeper] rewardDayClose ${where} role=${canonical ? 'canonical' : 'mirror'} today=${today} window=${window[0]}..${today - 1}${window.some((d) => d < today - LOOKBACK_DAYS) ? `+backlog=${window.filter((d) => d < today - LOOKBACK_DAYS).join(',')}` : ''} ` +
      `unclosed=${unclosed.length} closed=${closed}` +
      (canonical ? ` finalized=${finalized} broadcast=${broadcast}` : '') +
      (f.excluded.length > 0 ? ` finalized-without-this-chain=${f.excluded.join(',')}` : '') +
      (unconfirmed.length > 0 ? ` broadcast-unconfirmed(unserved destinations)=${unconfirmed.join(',')}` : '') +
      (unproven.length > 0 ? ` broadcast-unproven(unserved, no receipt seen)=${unproven.join(',')}` : '') +
      (f.refused.size > 0 ? ` refused=${[...f.refused.keys()].join(',')}` : '') +
      clockNote +
      (sender.stopped ? ` stopped=${sender.stopReason}` : ''),
  );

  // While paused, alerts are left as they stand and nothing is posted, so no
  // day leaves the ledger: what a day is owed includes its alerts.
  const paused = sender.stopReason === PAUSED_REFUSAL;
  const held: AlertsHeld = paused ? 'all' : await raiseDayCloseAlerts(env, chainId, diamond, canonical, f, nowSec, deps.runDeadline);
  const noticed = canonical && !paused ? await postZeroedNotices(env, chainId, diamond, window, deps.runDeadline) : new Set<number>();

  // A day is worked through once nothing more is owed on it here, its alerts
  // included (one due and not delivered holds the day): closed on a mirror;
  // on Base, finalized, broadcast (nothing left to send) and its zeroed-chain
  // notice delivered. Base's own close is owed only until the
  // day is finalized: once it is, a close is refused for good (an admin's
  // force-finalize can come first), and the day needs nothing more from it.
  // Every other window day stays in the ledger, and is worked, and alerted
  // on, in its turn until it goes through.
  const through = (d: number): boolean =>
    held !== 'all' &&
    !held.has(d) &&
    (canonical ? f.settled.has(`finalize:${d}`) && f.settled.has(`broadcast:${d}`) && noticed.has(d) : f.settled.has(`close:${d}`));
  await settleLedger(env, chainId, diamond, today, window, through);
}

/**
 * The ledger of owed days (`day_owed`): every elapsed day enters it before
 * the discovery cursor (`day_close`) moves past it, and leaves it only once a
 * run sees it worked through, so no elapsed day is skipped, however late the
 * pass was armed or however long it was down. A run works the last
 * {@link LOOKBACK_DAYS} days and a page of the older owed ones, each page
 * touched before any work so a day that fails every run still yields its
 * turn. Returns the run's window.
 */
async function openDays(env: Env, chainId: number, diamond: Address, today: number): Promise<number[]> {
  const db = env.KEEPER_DB;
  const from = await getWorkCursor(db, chainId, diamond, 'day_close');
  const fresh: WorkItem<Record<string, never>>[] = [];
  for (let d = from; d < today; d++) fresh.push({ item: String(d), block: d, payload: {} });
  for (let i = 0; i < fresh.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    await enqueueWork(db, chainId, diamond, 'day_owed', fresh.slice(i, i + 100));
  }
  await putWorkCursor(db, chainId, diamond, 'day_close', today);
  const page = await listOpenWorkBelow(db, chainId, diamond, 'day_owed', Math.max(0, today - LOOKBACK_DAYS), BACKLOG_PER_RUN);
  await touchOpenWork(db, chainId, diamond, 'day_owed', page.map((w) => w.item));
  return dayWindow(today, page.map((w) => w.block));
}

/** Record what the run saw: a window day worked through leaves the ledger,
 *  any other stays in it (or re-enters it: a day the lookback holds can owe
 *  again, a destination added after it went through). A day's send and
 *  notice records stay while it is owed or in the lookback. */
async function settleLedger(env: Env, chainId: number, diamond: Address, today: number, window: readonly number[], through: (d: number) => boolean): Promise<void> {
  const db = env.KEEPER_DB;
  await finishWork(db, chainId, diamond, 'day_owed', window.filter(through).map(String));
  const open = window.filter((d) => !through(d)).map((d) => ({ item: String(d), block: d, payload: {} }));
  if (open.length > 0) await enqueueWork(db, chainId, diamond, 'day_owed', open);
  const floor = Math.max(0, today - LOOKBACK_DAYS);
  await pruneWorkBelowUnlessOpen(db, chainId, diamond, 'day_broadcast', floor, 'day_owed');
  await pruneWorkBelowUnlessOpen(db, chainId, diamond, 'day_zeroed', floor, 'day_owed');
}

/** A peer chain's reward-clock launch: read now when it can be (and recorded,
 *  `day_clock`), else as last read (`lastRead`), so a mismatch once seen is
 *  never forgotten because the peer stops answering; null = never read. */
async function peerClock(env: Env, chainId: number, diamond: Address, peerChain: number, p: PeerReader | null, where: string): Promise<{ launch: number; lastRead: boolean } | null> {
  const now = p ? await launchOf(p, where) : null;
  if (now !== null) {
    await putWork(env.KEEPER_DB, chainId, diamond, 'day_clock', { item: String(peerChain), block: 0, payload: { launch: now } });
    return { launch: now, lastRead: false };
  }
  const rec = (await getWorkItems<{ launch: number }>(env.KEEPER_DB, chainId, diamond, 'day_clock', [String(peerChain)])).get(String(peerChain));
  return rec && Number.isSafeInteger(rec.payload.launch) ? { launch: rec.payload.launch, lastRead: true } : null;
}

// ─── Reads ──────────────────────────────────────────────────────────────

/** `contracts` read in aggregates of {@link READ_CHUNK}, results in order. A
 *  slice that fails reads as failures for its own entries only. */
async function chunkedRead(client: never, contracts: readonly unknown[], label: string, deadline: number): Promise<Awaited<ReturnType<typeof boundedRead>>> {
  const out: Awaited<ReturnType<typeof boundedRead>> = [];
  for (let i = 0; i < contracts.length; i += READ_CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...(await boundedRead(client, contracts.slice(i, i + READ_CHUNK), label, deadline)));
  }
  return out;
}

/** One per-day view over the window, batched; a failed read is absent. */
async function readDays<T>(deps: DayCloseDeps, diamond: Address, days: readonly number[], functionName: string, where: string): Promise<Map<number, T>> {
  const out = new Map<number, T>();
  if (days.length === 0) return out;
  const res = await chunkedRead(
    deps.readClient as never,
    days.map((d) => ({ address: diamond, abi: ABI, functionName, args: [BigInt(d)] })),
    `rewardDayClose ${where} ${functionName}`,
    deps.sendDeadline,
  );
  days.forEach((d, i) => {
    if (res[i]?.status === 'success') out.set(d, res[i].result as T);
  });
  return out;
}

/** Per day, which expected chains Base has recorded a report from, and which
 *  it could not be read for: a failed read is UNKNOWN, never "missing", so it
 *  can neither complete coverage nor be stated as an absent report. */
async function readReported(
  deps: DayCloseDeps,
  diamond: Address,
  days: readonly number[],
  expected: readonly number[],
  where: string,
): Promise<Map<number, { reported: Set<number>; unknown: Set<number> }>> {
  const out = new Map<number, { reported: Set<number>; unknown: Set<number> }>();
  for (const d of days) out.set(d, { reported: new Set(), unknown: new Set() });
  const pairs = days.flatMap((d) => expected.map((c) => [d, c] as const));
  if (pairs.length === 0) return out;
  const res = await chunkedRead(
    deps.readClient as never,
    pairs.map(([d, c]) => ({ address: diamond, abi: ABI, functionName: 'isChainReported', args: [BigInt(d), c] })),
    `rewardDayClose ${where} isChainReported`,
    deps.sendDeadline,
  );
  pairs.forEach(([d, c], i) => {
    const day = out.get(d)!;
    if (res[i]?.status !== 'success') day.unknown.add(c);
    else if (res[i].result === true) day.reported.add(c);
  });
  return out;
}

/** On a mirror: for each of `days`, whether Base has finalized it and whether
 *  Base holds this chain's report for it, each read on its own (null = that
 *  read failed; absent = Base not served). */
async function baseView(
  base: PeerReader | null,
  days: readonly number[],
  self: number,
  deadline: number,
): Promise<Map<number, { finalized: boolean | null; ready: boolean | null; counted: boolean | null }>> {
  const out = new Map<number, { finalized: boolean | null; ready: boolean | null; counted: boolean | null }>();
  if (!base || days.length === 0) return out;
  const res = await chunkedRead(
    base.client as never,
    days.flatMap((d) => [
      { address: base.diamond, abi: ABI, functionName: 'isDayReadyToFinalize', args: [BigInt(d)] },
      { address: base.diamond, abi: ABI, functionName: 'isChainReported', args: [BigInt(d), self] },
    ]),
    'rewardDayClose base day view',
    deadline,
  );
  days.forEach((d, i) => {
    const ready = res[2 * i];
    const counted = res[2 * i + 1];
    // Each read stands alone: whether Base has finalized the day is what a
    // pre-B4 close turns on, and a failed report read must not hide it.
    out.set(d, {
      finalized: ready?.status === 'success' ? Number((ready.result as readonly [boolean, number])[1]) === REASON_FINALIZED : null,
      ready: ready?.status === 'success' ? (ready.result as readonly [boolean, number])[0] === true : null,
      counted: counted?.status === 'success' ? counted.result === true : null,
    });
  });
  return out;
}

/** A chain's reward-clock launch timestamp (null = unread). */
async function launchOf(p: PeerReader, where: string): Promise<number | null> {
  try {
    return Number(await p.client.readContract({ address: p.diamond, abi: ABI, functionName: 'getInteractionLaunchTimestamp' }));
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${where}: reward clock of the peer at ${p.diamond} unread: ${shortErr(err)}`);
    return null;
  }
}

/** On a mirror: whether Base's expected-source list leaves this chain out
 *  (null = Base not served, or the read failed). */
async function absentFromBaseList(base: PeerReader | null, self: number, where: string): Promise<boolean | null> {
  if (!base) return null;
  try {
    const ids = (await base.client.readContract({ address: base.diamond, abi: ABI, functionName: 'getExpectedSourceChainIds' })) as readonly (number | bigint)[];
    return !ids.map(Number).includes(self);
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${where}: Base's expected-source list unread: ${shortErr(err)}`);
    return null;
  }
}

/** On Base: when each missing chain sent its report for `day`, read on that
 *  chain (null = not served, or unread; 0 = not sent). */
async function peerSentAt(deps: DayCloseDeps, chains: readonly number[], day: number): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  for (const c of chains) {
    const p = deps.peer(c);
    if (!p) {
      out.set(c, null);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      out.set(c, Number(await p.client.readContract({ address: p.diamond, abi: ABI, functionName: 'getChainReportSentAt', args: [BigInt(day)] })));
    } catch {
      out.set(c, null);
    }
  }
  return out;
}

/** The messenger's fee for the report `closeDay` sends. The Diamond sends the
 *  newest report shape the messenger has (B4, then B3, B1 and the legacy one,
 *  each downgrade on a selector the messenger lacks), and the quote walks the
 *  same ladder, stopping at a refusal the messenger names. The payload is
 *  fixed-width, so zero figures price it exactly. `b4` says whether the
 *  shape that quoted is the B4 report.
 *  A quote that does not match the shape sent cannot overpay silently: the
 *  `closeDay` simulation is the judge, and refuses an underpaid send. */
async function reportFee(client: PublicClient, messenger: Address, day: number): Promise<{ fee: bigint; b4: boolean } | 'refused' | 'unread'> {
  const z = 0n;
  const d = BigInt(day);
  const ladder: readonly (readonly unknown[])[] = [
    [d, z, z, z, z, z, z, 0n], // B4: + custody era
    [d, z, z, z, z, z, z], // B3
    [d, z, z, z, z], // B1
    [d, z, z], // legacy
  ];
  for (const [i, args] of ladder.entries()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const fee = (await client.readContract({ address: messenger, abi: MESSENGER_ABI, functionName: 'quoteSendChainReport', args })) as bigint;
      return { fee, b4: i === 0 };
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      const c = classify(err);
      if ('unread' in c) return 'unread';
      // A named refusal is the messenger's answer; an unnamed one is a shape
      // it does not have, so the next one is tried.
      if (revertName(err) !== undefined) return 'refused';
    }
  }
  return 'refused';
}

type Quote = { fee: bigint } | { refused: string } | { unread: string };

/** A Diamond fee quote, the reason the contract refused it, or that the RPC
 *  did not answer (logged; never reported as a refusal). */
async function quote(client: PublicClient, diamond: Address, functionName: string, args: readonly unknown[]): Promise<Quote> {
  try {
    return { fee: (await client.readContract({ address: diamond, abi: ABI, functionName, args })) as bigint };
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    const c = classify(err);
    if ('unread' in c) console.error(`[keeper] rewardDayClose ${functionName} unread, the RPC did not answer: ${c.unread}`);
    return c;
  }
}

/** A finalized day's broadcast record (`day_broadcast`): every destination
 *  the day has had while worked, each with the last send this keeper made
 *  that covered it (null = none yet). */
interface BroadcastRecord {
  sentTo: Record<string, SendMark | null>;
}

/** The messenger's broadcast destinations, or null when they cannot be read
 *  (no messenger, one that predates the list, or a failed read). */
async function broadcastDestinations(client: PublicClient, messenger: Address, where: string): Promise<number[] | null> {
  try {
    const ids = (await client.readContract({ address: messenger, abi: MESSENGER_ABI, functionName: 'getBroadcastDestinations' })) as readonly bigint[];
    return ids.map(Number);
  } catch (err) {
    console.error(`[keeper] rewardDayClose ${where}: broadcast destinations unread, no day broadcast this run: ${shortErr(err)}`);
    return null;
  }
}

/** Each destination's state for `day`: read on that chain when served. */
async function destinationStates(deps: DayCloseDeps, destinations: readonly number[], day: number): Promise<Map<number, DestinationState>> {
  const out = new Map<number, DestinationState>();
  for (const c of destinations) {
    const p = deps.peer(c);
    if (!p) {
      out.set(c, 'unserved');
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const [, , isSet] = (await p.client.readContract({
        address: p.diamond,
        abi: ABI,
        functionName: 'getKnownGlobalInterestNumeraire18',
        args: [BigInt(day)],
      })) as readonly [bigint, bigint, boolean];
      out.set(c, isSet ? 'received' : 'missing');
    } catch {
      out.set(c, 'unread');
    }
  }
  return out;
}

// ─── Sends ──────────────────────────────────────────────────────────────

type CallResult = 'landed' | 'skipped' | string;

/** Simulate-then-send, one transaction at a time, within the run's budget. */
class Sender {
  private ctx: KeeperContext | null | undefined;
  private sends = 0;
  stopped = false;
  stopReason = '';
  /** Writes that went out and may have landed: landed, or sent with no
   *  receipt seen. A write known to have reverted is not counted. */
  maybeSent = 0;
  /** The receipt of the last call, when it landed (null otherwise). */
  receipt: TransactionReceipt | null = null;

  constructor(
    private readonly deps: DayCloseDeps,
    private readonly f: RunFindings,
  ) {}

  private stop(why: string): 'skipped' {
    this.stopped = true;
    this.stopReason = why;
    return 'skipped';
  }

  /** 'landed'; 'skipped' (not sent: budget, deadline, a race, no key, or the
   *  run stopped); or the revert reason of a refused call, which is recorded. */
  async call(step: string, day: number, functionName: string, args: readonly unknown[], value: bigint): Promise<CallResult> {
    this.receipt = null;
    if (this.stopped) return 'skipped';
    if (this.sends >= MAX_SENDS_PER_RUN) return this.stop('send-budget');
    if (Date.now() >= this.deps.sendDeadline) return this.stop('deadline');
    if (this.ctx === undefined) this.ctx = this.deps.context();
    const ctx = this.ctx;
    if (!ctx) return this.stop('no-signing-key');
    const key = `${step}:${day}`;
    try {
      await ctx.client.simulateContract({ address: ctx.diamond, abi: ABI, functionName, args, value, account: ctx.wallet.account! });
    } catch (err) {
      if (err instanceof PastRunDeadline) return this.stop('deadline');
      const c = classify(err);
      if ('unread' in c) {
        // No answer from the contract is not its refusal: say nothing about
        // the day, and stop sending on this RPC for the run.
        console.error(`[keeper] rewardDayClose chain=${ctx.chainId} ${functionName}(${day}) not simulated, the RPC did not answer: ${c.unread}`);
        return this.stop('rpc-unavailable');
      }
      const reason = c.refused;
      if (reason === PAUSED_REFUSAL) return this.stop(PAUSED_REFUSAL);
      if (RACES.has(reason)) return 'skipped';
      if (reason !== FRONTIER_SHORT) this.f.refused.set(key, reason);
      return reason;
    }
    this.sends += 1;
    const label = `[keeper] rewardDayClose chain=${ctx.chainId} ${functionName}(${day})`;
    let hash: Hex;
    try {
      hash = (await ctx.wallet.writeContract({
        address: ctx.diamond,
        abi: ABI,
        functionName,
        args,
        value,
        chain: undefined,
        account: ctx.wallet.account ?? null,
      } as never)) as Hex;
    } catch (err) {
      // A deferral at the deadline sent nothing, and says so.
      if (reportSendError(label, err, `send failed: ${shortErr(err)}`)) return this.stop('deadline');
      // Only a send the node did not answer may have gone out (a timeout, a
      // lost response, a nonce already taken): one the node refused outright
      // (insufficient funds, a coded RPC refusal) left nothing, so the
      // destinations it covered are not counted as sent.
      if (!isDefinitiveRejection(err)) this.maybeSent += 1;
      return this.stop('send-failed');
    }
    console.log(`${label} value=${value} tx=${hash}`);
    try {
      const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status !== 'success') {
        this.f.refused.set(key, `reverted on chain (tx ${hash})`);
        return `reverted on chain (tx ${hash})`;
      }
      this.receipt = receipt;
    } catch (err) {
      console.error(`${label} receipt not seen in time: ${shortErr(err)}`);
      this.maybeSent += 1;
      return this.stop('receipt-timeout');
    }
    this.maybeSent += 1;
    this.f.landed.add(key);
    return 'landed';
  }
}

// ─── Alerts ─────────────────────────────────────────────────────────────

const STEP_WORDS: Record<string, string> = {
  close: 'closing the day (closeDay)',
  advance: 'advancing the interest fold (advanceInterestFrontiers)',
  finalize: 'finalizing the day (finalizeDay)',
  broadcast: 'broadcasting the day (broadcastGlobal)',
};

/** The reward day an alert key names (`dayclose-<kind>:<chain>:<day>`, or
 *  `dayclose-refused:<chain>:<step>:<day>`), or null for a chain-wide one. */
function dayOfAlert(key: string): number | null {
  const parts = key.split(':');
  const d = Number(parts[0] === 'dayclose-refused' ? parts[3] : parts[2]);
  return Number.isSafeInteger(d) && d >= 0 ? d : null;
}

/** What became of the run's alerts: the days an alert was due on and not
 *  delivered, or 'all' when none could be judged (the open alerts unread). */
type AlertsHeld = Set<number> | 'all';

/** Raise or clear the pass's ops alerts for one chain. Returns the days
 *  whose due alert this run did not deliver (the deadline came first, or the
 *  post failed or was refused): such a day stays owed, so the alert is raised
 *  again in its next turn and never lost with a day that leaves the ledger. */
async function raiseDayCloseAlerts(env: Env, chainId: number, diamond: Address, canonical: boolean, f: RunFindings, nowSec: number, deadline: number): Promise<AlertsHeld> {
  let open: Set<string>;
  try {
    open = new Set(await listOpsAlertKeys(env.KEEPER_DB, `dayclose-%:${chainId}:%`));
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: open alerts unread, alerts left for the next run: ${shortErr(err)}`);
    return 'all';
  }
  const raised = new Set<string>();
  const held = new Set<number>();
  const raise = async (key: string, text: string, repeat = ALERT_REPEAT_SEC): Promise<void> => {
    raised.add(key);
    const outcome = Date.now() >= deadline ? 'deadline' : await sendOpsAlert(env, key, text, repeat, nowSec, chainId);
    const day = dayOfAlert(key);
    // 'suppressed' was delivered before; 'unconfigured' is journaled.
    if (day !== null && outcome !== 'sent' && outcome !== 'suppressed' && outcome !== 'unconfigured') held.add(day);
  };
  const tag = `[chain ${chainId}] reward day close`;
  const inWindow = new Set(f.window);
  // A day's alerts go with the day: once it is neither in this run's window
  // nor owed. An owed day this run did not work keeps them until its turn.
  const outside = [...new Set([...open].map(dayOfAlert).filter((d): d is number => d !== null && !inWindow.has(d)))];
  let owed: Set<string>;
  try {
    owed = await openWorkAmong(env.KEEPER_DB, chainId, diamond, 'day_owed', outside.map(String));
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: owed days unread, their alerts left for the next run: ${shortErr(err)}`);
    owed = new Set(outside.map(String));
  }
  const dropped = (d: number): boolean => !inWindow.has(d) && !owed.has(String(d));

  for (const [k, why] of f.refused) {
    const [step, day] = k.split(':');
    // eslint-disable-next-line no-await-in-loop
    await raise(
      `dayclose-refused:${chainId}:${k}`,
      `${tag}: ${STEP_WORDS[step] ?? step} for reward day ${day} is refused (${why}). The day stays open on this chain until the call goes through; the pass retries every run until it does.`,
    );
  }
  for (const w of f.waiting) {
    const ends = w.graceEndsAt === null ? 'unknown' : new Date(w.graceEndsAt * 1000).toISOString();
    const unread = w.unknown.length > 0 ? `; Base's record of the report could not be read this run for chain(s) ${w.unknown.join(', ')}` : '';
    const each = w.missing
      .map((c) => {
        const s = w.sent.get(c);
        if (s === null || s === undefined) return `chain ${c} (not served by this keeper, or unread: whether it sent is unknown)`;
        if (s === 0) return `chain ${c} (has not sent its report)`;
        return `chain ${c} (sent at ${new Date(s * 1000).toISOString()}, not yet landed on Base)`;
      })
      .join('; ');
    // eslint-disable-next-line no-await-in-loop
    await raise(
      `dayclose-waiting:${chainId}:${w.day}`,
      `${tag}: reward day ${w.day} ` +
        (w.missing.length > 0 ? `is still missing ${w.missing.length} expected report(s): ${each}` : 'has no expected report Base shows as missing') +
        `${unread}. Grace ends ${ends}; at that point the day is finalized with the reports that have landed, and each expected chain still missing then counts as zero for the day.`,
    );
  }
  if (canonical && f.noExpected) {
    await raise(
      `dayclose-noexpected:${chainId}:all`,
      `${tag}: Base's expected-source list is empty, so no day is finalized: a day finalized against an empty list sums no chain and finalizes as zero, irreversibly. Set the list (setExpectedSourceChainIds) before rewards can be finalized.`,
    );
  }
  const faults = canonical && f.topology ? topologyFaults(f.topology, chainId) : [];
  if (faults.length > 0) {
    await raise(
      `dayclose-topology:${chainId}:all`,
      `${tag}: Base's expected-source list and the reward messenger's broadcast destinations do not line up: ${faults.join('; ')}. Make each mirror appear once on both lists, and Base on the expected-source list only (setExpectedSourceChainIds on the Diamond, setBroadcastDestinations on the messenger).`,
    );
  }
  if (canonical && f.destinationsUnread) {
    await raise(
      `dayclose-destunread:${chainId}:all`,
      `${tag}: the reward messenger's broadcast destinations could not be read (the messenger is unset, too old to list them, or the read failed), so no finalized day was broadcast this run and users on the mirrors cannot claim those days yet. Finalizing goes on; the broadcast resumes on the first run that reads the list.`,
    );
  }
  if (canonical && f.selfNotExpected) {
    await raise(
      `dayclose-selfmissing:${chainId}:all`,
      `${tag}: this chain is not on its own expected-source list. Finalization sums only the listed chains, so this chain's own interest is left out of every day's global total while its users' shares are still worked out against it; and its own report still counts toward the contract's report count. Add it (setExpectedSourceChainIds). Until it is added, the pass finalizes no day: a day finalized now would leave this chain's interest out of its total for good.`,
    );
  }
  for (const l of f.lateBroadcast) {
    const each = (state: 'missing' | 'unread') =>
      l.late
        .filter((x) => x.state === state)
        .map((x) => `chain ${x.chain} (last sent ${new Date(x.sentAt * 1000).toISOString()}, or sent then with no receipt seen)`)
        .join(', ');
    const missing = each('missing');
    const unread = each('unread');
    // eslint-disable-next-line no-await-in-loop
    await raise(
      `dayclose-broadcast:${chainId}:${l.day}`,
      `${tag}: the broadcast of reward day ${l.day} ` +
        [
          missing ? `has not reached ${missing}` : '',
          unread ? `could not be confirmed on ${unread}, whose state this keeper could not read, so whether it arrived there is unknown` : '',
        ]
          .filter(Boolean)
          .join('; and it ') +
        `. Until it lands, users there cannot claim that day. The pass re-sends to a chain it reads as missing ${BROADCAST_RESEND_AFTER_SEC / 3600}h after each send to it, and this alert stands until every such chain is read holding the day; check the lane's CCIP delivery and the keeper's RPC for that chain.`,
    );
  }
  if (!canonical && f.notExpectedOnBase) {
    await raise(
      `dayclose-notexpected:${chainId}:all`,
      `${tag}: this chain is not on Base's expected-source list, so Base refuses every report it sends (SourceChainIdNotExpected): its interest counts toward no day, and the chain-wide figures each report carries (its custody era, and its recycled-availability and commitment ratchets) do not reach Base, so commitments this chain has retired stay outstanding there. The pass still closes each day here. CCIP records each refused report as a failed message, which can be executed again by hand once the chain is back on the list. If this chain is being detached, keep it on the list until its last report has landed (#2618).`,
    );
  }
  if (f.clock && f.clock.differ.length > 0) {
    const at = (t: number) => new Date(t * 1000).toISOString();
    const each = f.clock.differ.map((x) => `chain ${x.chain} (day 0 starts ${at(x.launch)}${x.lastRead ? ', as last read; this run could not read it' : ''})`).join(', ');
    await raise(
      `dayclose-clock:${chainId}:all`,
      canonical
        ? `${tag}: ${each} run(s) a reward clock different from Base's (day 0 starts ${at(f.clock.base)}), so the same day number covers different hours there and here. A day finalized with such a report sums unrelated interest into one global total, irreversibly, so the pass finalizes no day until every listed chain it serves runs Base's clock. Days already finalized are still broadcast.`
        : `${tag}: this chain's reward clock (day 0 starts ${at(f.clock.differ[0].launch)}) differs from Base's (day 0 starts ${at(f.clock.base)}${f.clock.stale ? ', as last read; this run could not read it' : ''}), so the same day number covers different hours here and on Base. A report sent now would be summed into Base's day with interest from other hours, irreversibly, so the pass closes no day here until the two match.`,
    );
  }
  for (const d of f.excluded) {
    // eslint-disable-next-line no-await-in-loop
    await raise(
      `dayclose-excluded:${chainId}:${d}`,
      `${tag}: Base finalized reward day ${d} without this chain's report, so this chain's interest counts as zero for that day. The report is still sent (or was): Base drops its day figures but applies the chain-wide figures it carries.`,
      EXCLUDED_REPEAT_SEC,
    );
  }

  // Clear what this run shows has gone: a refused call that landed or whose
  // work is done, a wait that ended, a list now set, a broadcast delivered.
  // A day outside the window is no longer worked, and its alerts go with it.
  for (const key of open) {
    if (raised.has(key)) continue;
    const parts = key.split(':');
    const kind = parts[0];
    const day = dayOfAlert(key) ?? Number.NaN;
    let gone = false;
    if (kind === 'dayclose-refused') {
      const served = SERVES[parts[2]];
      const done = (k: string) => f.settled.has(k) || f.landed.has(k);
      gone = done(`${parts[2]}:${parts[3]}`) || (served !== undefined && done(`${served}:${parts[3]}`)) || dropped(day);
    }
    // A wait judged this run and not raised is no longer near its end (grace
    // was lengthened, or a report landed): its deadline no longer holds.
    else if (kind === 'dayclose-waiting') gone = f.settled.has(`finalize:${day}`) || f.judged.has(day) || dropped(day);
    // A topology alert clears only on a read that shows the fix.
    else if (kind === 'dayclose-noexpected') gone = canonical && f.noExpected === false;
    else if (kind === 'dayclose-selfmissing') gone = canonical && f.selfNotExpected === false;
    else if (kind === 'dayclose-destunread') gone = canonical && f.destinationsUnread === false;
    else if (kind === 'dayclose-topology') gone = canonical && f.topology !== null && topologyFaults(f.topology, chainId).length === 0;
    // Cleared on a read showing delivery, never on a re-send merely landing.
    else if (kind === 'dayclose-broadcast') gone = f.broadcastConfirmed.has(day) || dropped(day);
    else if (kind === 'dayclose-excluded') gone = dropped(day);
    else if (kind === 'dayclose-notexpected') gone = !canonical && f.notExpectedOnBase === false;
    else if (kind === 'dayclose-clock') gone = f.clock !== null && f.clock.differ.length === 0 && !f.clock.stale;
    if (gone && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await resolveOpsAlert(env, key);
    }
  }
  return held;
}

/**
 * A chain that has left the reward set (its role is neither canonical nor
 * mirror) is no longer worked by this pass, so nothing it said about the
 * chain is still being retried or watched. Its open alerts are closed, and
 * the ops channel told once which ones and why, so none is left claiming a
 * retry that no run makes. Should the chain rejoin, a run judges it afresh
 * and raises what then holds.
 */
async function retireDayCloseAlerts(env: Env, chainId: number, role: number, deadline: number): Promise<void> {
  let open: string[];
  try {
    open = (await listOpsAlertKeys(env.KEEPER_DB, `dayclose-%:${chainId}:%`)).sort();
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: open alerts unread, left for the next run: ${shortErr(err)}`);
    return;
  }
  if (open.length === 0 || Date.now() >= deadline) return;
  const lines = open.map((k) => `closed: ${k}`);
  for (const l of lines) console.log(`[keeper] rewardDayClose chain=${chainId}: reward role ${role}, ${l}`);
  const outcome = await sendOpsNoticeDigest(
    env,
    `[chain ${chainId}] reward day close: chain left the reward set (role ${role}), its alerts closed`,
    lines,
    'This chain is neither the canonical reward chain nor a mirror, so the pass no longer closes, finalizes or broadcasts its days, and the conditions these alerts named are no longer retried or watched. If the chain rejoins, the pass judges it afresh.',
    chainId,
  );
  // Closed only once said: a notice that did not go out is tried next run.
  if (outcome !== 'sent' && outcome !== 'unconfigured') return;
  for (const k of open) {
    // eslint-disable-next-line no-await-in-loop
    await resolveOpsAlert(env, k);
  }
}

const ZEROED_FOOTER =
  "Finalization is final: a missing chain's report for these days has its day figures dropped when it lands (its chain-wide figures still apply). Read from Base's record of which chains reported each day, against Base's expected-source list as it stood when this keeper first saw the day finalized.";

function zeroedLine(day: number, missing: readonly number[]): string {
  return `reward day ${day}: finalized without chain(s) ${missing.join(', ')}; their interest counts as zero for the day`;
}

/** A finalized day's zeroed record (`day_zeroed`): the expected chains Base
 *  holds no report from, and whether the notice naming them was delivered. */
interface ZeroedRecord {
  missing: number[];
  posted: boolean;
}

/**
 * Record, once per finalized day, the expected chains it was finalized
 * without (Base). One rule whoever finalized the day, this keeper, another
 * caller or an admin: Base keeps no report for a chain that was not counted
 * (a report landing after finalization drops its day figures and is not
 * recorded as the day's), so the day's own record is the source, read at a
 * block where the day is finalized. A day whose record cannot be fully read
 * there is left for the next run. Exported for tests.
 */
export async function recordZeroed(
  env: Env,
  deps: DayCloseDeps,
  chainId: number,
  diamond: Address,
  finalizedDays: readonly number[],
  expected: readonly number[],
  where: string,
): Promise<void> {
  // An empty list still gets a record (naming no chain): a finalized day is
  // worked through only once its record exists.
  if (finalizedDays.length === 0) return;
  try {
    const have = await getWorkItems<ZeroedRecord>(env.KEEPER_DB, chainId, diamond, 'day_zeroed', finalizedDays.map(String));
    const fresh = finalizedDays.filter((d) => !have.has(String(d)));
    for (const d of fresh) {
      // One multicall, so one block: the day reads finalized at the same block
      // its reports are read at, and a lagging node cannot record a report
      // that landed just before finalization as missing.
      // eslint-disable-next-line no-await-in-loop
      const res = await boundedRead(
        deps.readClient as never,
        [
          { address: diamond, abi: ABI, functionName: 'isDayReadyToFinalize', args: [BigInt(d)] },
          ...expected.map((c) => ({ address: diamond, abi: ABI, functionName: 'isChainReported', args: [BigInt(d), c] })),
        ],
        `rewardDayClose ${where} zeroed(${d})`,
        deps.sendDeadline,
      );
      if (res.some((r) => r?.status !== 'success')) continue;
      if (Number((res[0].result as readonly [boolean, number])[1]) !== REASON_FINALIZED) continue;
      const missing = expected.filter((_, i) => res[i + 1].result !== true);
      if (missing.length > 0) console.log(`[keeper] rewardDayClose ${where} notice: ${zeroedLine(d, missing)}`);
      const row: WorkItem<ZeroedRecord> = { item: String(d), block: d, payload: { missing, posted: missing.length === 0 } };
      // eslint-disable-next-line no-await-in-loop
      await putWork(env.KEEPER_DB, chainId, diamond, 'day_zeroed', row);
    }
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${where}: zeroed-day records left for the next run: ${shortErr(err)}`);
  }
}

/** Post the zeroed-day notices not yet delivered (Base), for the window's
 *  days. A record is marked posted once delivered (or once the ops channel is
 *  not configured: the journal line written with the record is then the
 *  record) and kept, so the day is never noticed twice; a day with a notice
 *  still to deliver stays owed, so its record is never pruned before it is
 *  delivered. Returns the window days whose record exists and is delivered
 *  (one naming no chain counts as delivered). */
async function postZeroedNotices(env: Env, chainId: number, diamond: Address, window: readonly number[], deadline: number): Promise<Set<number>> {
  const noticed = new Set<number>();
  try {
    const all = [...(await getWorkItems<ZeroedRecord>(env.KEEPER_DB, chainId, diamond, 'day_zeroed', window.map(String))).values()];
    for (const r of all) if (r.payload.posted || r.payload.missing.length === 0) noticed.add(r.block);
    const rows = all.filter((r) => !r.payload.posted && r.payload.missing.length > 0);
    if (rows.length === 0 || Date.now() >= deadline) return noticed;
    rows.sort((a, b) => a.block - b.block);
    const lines = rows.map((r) => zeroedLine(r.block, r.payload.missing));
    const outcome = await sendOpsNoticeDigest(env, `[chain ${chainId}] reward day close: finalized with expected reports missing`, lines, ZEROED_FOOTER, chainId);
    if (outcome === 'sent' || outcome === 'unconfigured') {
      for (const r of rows) {
        // eslint-disable-next-line no-await-in-loop
        await putWork(env.KEEPER_DB, chainId, diamond, 'day_zeroed', { ...r, payload: { ...r.payload, posted: true } });
        noticed.add(r.block);
      }
    }
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: zeroed-day notices left queued: ${shortErr(err)}`);
  }
  return noticed;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** The messenger's per-destination "broadcast left" events, every version:
 *  each indexes the destination chain id second and the day third. */
const BROADCAST_SENT_TOPICS = new Set<string>(
  [
    'BroadcastSent(bytes32,uint256,uint256,uint256,uint256)',
    'BroadcastV2Sent(bytes32,uint256,uint256)',
    'BroadcastV3Sent(bytes32,uint256,uint256)',
  ].map((sig) => toEventSelector(sig).toLowerCase()),
);

/** The destinations a landed broadcast of day `day` sent a message to, read
 *  from the messenger's own events in its receipt: what the transaction did,
 *  not what the run expected it to do. `messengers` are the addresses the
 *  Diamond may have sent through (the one the run read, and the one it holds
 *  at the receipt's block, in case governance rotated it in between). Null
 *  when the receipt carries such an event from any other address, so what
 *  the send covered cannot be told; empty without a receipt. */
export function broadcastsLeft(receipt: TransactionReceipt | null, messengers: readonly Address[], day: number): Set<number> | null {
  const out = new Set<number>();
  if (receipt === null) return out;
  const known = new Set(messengers.map((m) => m.toLowerCase()));
  for (const log of receipt.logs) {
    const [sig, , dst, dayTopic] = log.topics;
    if (sig === undefined || dst === undefined || dayTopic === undefined || !BROADCAST_SENT_TOPICS.has(sig.toLowerCase())) continue;
    if (BigInt(dayTopic) !== BigInt(day)) continue;
    if (!known.has(log.address.toLowerCase())) return null;
    out.add(Number(BigInt(dst)));
  }
  return out;
}

/** What is wrong with Base's lists, one sentence each (empty = nothing). The
 *  one rule both the alert and its clearing read. */
function topologyFaults(t: NonNullable<RunFindings['topology']>, self: number): string[] {
  const out: string[] = [];
  if (t.undeliverable.length > 0) {
    out.push(`chain(s) ${t.undeliverable.join(', ')} are on Base's expected-source list but are not broadcast destinations, so no finalized day reaches them and their users cannot claim`);
  }
  const unexpected = t.unexpected.filter((c) => c !== self);
  if (unexpected.length > 0) {
    out.push(`chain(s) ${unexpected.join(', ')} are broadcast destinations but not on Base's expected-source list, so Base refuses their reports (SourceChainIdNotExpected) and every day finalizes without their interest`);
  }
  if (t.self) out.push(`Base itself (${self}) is a broadcast destination, so every broadcast pays for a message to itself that serves no one`);
  if (t.repeated.length > 0) out.push(`chain(s) ${t.repeated.join(', ')} appear more than once among the broadcast destinations, so every broadcast pays for and sends each of them more than once`);
  return out;
}

/** What a failed call says: the contract answered and refused it (with its
 *  reason), or no answer came from the contract at all (a transport error, a
 *  timeout, an RPC rejection), which says nothing about the call. */
function classify(err: unknown): { refused: string } | { unread: string } {
  const answered = err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;
  return answered ? { refused: revertName(err) ?? shortErr(err) } : { unread: shortErr(err) };
}

/** The decoded custom error a simulation reverted with, when the ABI names it. */
function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

/** viem's one-line summary when there is one; otherwise a bounded description
 *  that never carries the raw message (RPC URLs carry API keys). */
function shortErr(err: unknown): string {
  const short = (err as { shortMessage?: unknown } | null)?.shortMessage;
  return (typeof short === 'string' && short.length > 0 ? short : describeFailure(err)).slice(0, 200);
}
