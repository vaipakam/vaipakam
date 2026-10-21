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
//      nothing and raises or clears no alert.
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
//      must not lose. For every window day, sent or not, a day Base finalized
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
//      still in flight inside grace. A day finalized at grace with a chain
//      missing zeroes that chain's interest for the day, so the run says so,
//      naming each one from the finalization's own `ChainContributionZeroed`
//      events (not from the read before the send, which can be stale). That
//      notice is journaled and queued the moment the finalization lands, and
//      posted until it is delivered: on the next run the day is finalized and
//      the receipt is gone, so nothing could rebuild it. An empty expected-source list is never finalized
//      against: every day would finalize as zero, irreversibly.
//   3. BROADCASTS (Base only) each finalized day to the messenger's
//      destinations (`broadcastGlobal`, the quoted fee, paid exactly), and
//      confirms delivery by reading each destination this keeper also serves
//      (`getKnownGlobalInterestNumeraire18(d).isSet` on that mirror). A day
//      is sent once and re-sent only when a served destination still lacks
//      the pair {@link BROADCAST_RESEND_AFTER_SEC} after the last send, and
//      then only to the destinations still lacking it (`broadcastGlobalTo`),
//      falling back to every destination when the day or the messenger cannot
//      take a single-destination send (the mirror ingress is idempotent, so a
//      re-send cannot double-apply). A destination this keeper does not serve
//      cannot be read, so it is sent to once and never confirmed: the run's
//      line says so.
//
// What the run sends is bounded ({@link MAX_SENDS_PER_RUN} per chain), each
// send is simulated first on the current state, and each waits for its
// receipt before the next (every pass signs from one key). Every call here is
// permissionless; the only value it moves is the CCIP fee the keeper pays.
//
// The window is the last {@link LOOKBACK_DAYS} elapsed days. A day older than
// that is no longer worked by this pass, and the alerts below say so before a
// day stuck in the window can leave it.
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
//     claim; or a destination whose reports Base refuses as unexpected); each
//     read every run and cleared only on a read showing the fix;
//   - on Base, a broadcast a served destination has not received
//     {@link BROADCAST_LATE_AFTER_SEC} after it was sent;
//   - on a mirror, a day Base finalized without this chain's report.
// And one NOTICE (a thing that happened): a day Base finalized at grace with
// expected chains missing, naming each.
//
// The pass keeps two kinds of row in the keeper's private open-work queue
// (`keeper_work_open`), one per (chain, Diamond, day), each dropped when its
// day leaves the window: a broadcast's last send time (kind `day_broadcast`;
// losing it costs at most one extra broadcast), and an undelivered zeroed-day
// notice (kind `day_zeroed`).
//
// Gated by KEEPER_ENABLED + REWARD_DAY_CLOSE_ENABLED.

import { BaseError, ContractFunctionRevertedError, createPublicClient, http, parseEventLogs, type Abi, type Address, type Hex, type Log, type PublicClient } from 'viem';
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
import { reportSendError } from './submissionQueue';
import type { PassTick } from './passSchedule';
import { boundedRead, deadlineClient, PastRunDeadline } from './batchRead';
import { finishWork, getWorkItems, listOpsAlertKeys, pruneWorkBelow, putWork, type WorkItem } from './db';
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
/** Elapsed days each run works. Two weeks: a keeper down for days catches up
 *  on its own, and the alerts fire long before a stuck day leaves it. */
export const LOOKBACK_DAYS = 14;
/** Transactions one run may send per chain. Each waits for its receipt. */
export const MAX_SENDS_PER_RUN = 8;
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
const RESEND_TO_ALL = new Set(['MessengerPredatesV3', 'DayHasNoLapseClock', 'DestinationHasNoDayStanding']);
const FRONTIER_SHORT = 'ChainReportFrontierShort';

// ─── Pure planning ──────────────────────────────────────────────────────

/** The elapsed days a run works, oldest first: `[today - LOOKBACK, today - 1]`
 *  floored at day 0. Empty on day 0. Pure. */
export function dayWindow(today: number, lookback = LOOKBACK_DAYS): number[] {
  const out: number[] = [];
  for (let d = Math.max(0, today - lookback); d < today; d++) out.push(d);
  return out;
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

export type BroadcastDecision =
  | { kind: 'done' }
  | { kind: 'send'; resend: boolean }
  | { kind: 'wait'; late: boolean };

/**
 * Whether to broadcast a finalized day now. Pure.
 *
 * `sentAt` is the last send this keeper recorded (null = none). A day never
 * sent is sent. Once sent, it is done when no served destination still lacks
 * the pair (an unserved one cannot be confirmed). A served destination still
 * missing it is reported late after {@link BROADCAST_LATE_AFTER_SEC} and
 * re-sent after {@link BROADCAST_RESEND_AFTER_SEC}, whatever another
 * destination's read did; one whose read failed is judged next run, and holds
 * back only "done".
 */
export function planBroadcast(dest: ReadonlyMap<number, DestinationState>, sentAt: number | null, nowSec: number): BroadcastDecision {
  const states = [...dest.values()];
  if (states.length === 0) return { kind: 'done' };
  if (sentAt === null) {
    // Nothing recorded: every served destination already holding it (a send
    // from elsewhere, or a lost record) needs none.
    const served = states.filter((s) => s !== 'unserved');
    if (served.length > 0 && served.length === states.length && served.every((s) => s === 'received')) return { kind: 'done' };
    return { kind: 'send', resend: false };
  }
  if (!states.some((s) => s === 'missing')) return states.some((s) => s === 'unread') ? { kind: 'wait', late: false } : { kind: 'done' };
  const since = nowSec - sentAt;
  if (since >= BROADCAST_RESEND_AFTER_SEC) return { kind: 'send', resend: true };
  return { kind: 'wait', late: since >= BROADCAST_LATE_AFTER_SEC };
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
  /** `step:day` keys whose call landed, or whose work is done. */
  settled: Set<string>;
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
  topology: { undeliverable: number[]; unexpected: number[] } | null;
  /** Base: finalized days no served destination still lacks, as read. */
  broadcastConfirmed: Set<number>;
  /** Base: days a served destination has not received, past the late mark. */
  lateBroadcast: { day: number; missing: number[]; sentAt: number }[];
  /** Mirror: days Base finalized without this chain's report. */
  excluded: number[];
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
  const window = dayWindow(today);
  const canonical = role === ROLE_CANONICAL;

  const f: RunFindings = {
    refused: new Map(),
    settled: new Set(),
    waiting: [],
    noExpected: null,
    selfNotExpected: null,
    topology: null,
    broadcastConfirmed: new Set(),
    lateBroadcast: [],
    excluded: [],
    window,
  };
  const sender = new Sender(deps, f);

  // ── 1. Close ──
  const sentAt = await readDays<bigint>(deps, diamond, window, 'getChainReportSentAt', where);
  const unclosed = window.filter((d) => sentAt.get(d) === 0n);
  for (const d of window) if ((sentAt.get(d) ?? 0n) > 0n) f.settled.add(`close:${d}`);
  if (!canonical) {
    // Every window day, sent or not: Base may have finalized a day at grace
    // while this chain's report was still in flight. Either way the day is
    // finalized without this chain's interest, and it stays so. The day is
    // still closed below: its report carries chain-wide figures Base applies
    // after finalization too.
    const onBase = await baseView(deps.peer(baseChainId), window, chainId, deps.sendDeadline);
    f.excluded = window.filter((d) => onBase.get(d)?.finalized === true && onBase.get(d)?.counted === false);
  }
  let closed = 0;
  for (const d of unclosed) {
    // eslint-disable-next-line no-await-in-loop
    const fee = canonical ? 0n : await reportFee(deps.client, messenger, d);
    if (fee === null) {
      f.refused.set(`close:${d}`, 'the messenger would not quote the report fee');
      continue;
    }
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
    }
    if (sender.stopped) break;
  }

  // ── 2. Finalize, 3. broadcast (Base) ──
  let finalized = 0;
  let broadcast = 0;
  const unconfirmed: number[] = [];
  if (canonical) {
    // The topology is read every run, whatever the send budget left: its
    // alerts are raised and cleared only on what this run actually read.
    const expected = (await read<readonly number[]>('getExpectedSourceChainIds')).map(Number);
    const destinations = await broadcastDestinations(deps.client, messenger);
    f.noExpected = expected.length === 0;
    f.selfNotExpected = !f.noExpected && !expected.includes(chainId);
    f.topology = {
      undeliverable: expected.filter((c) => c !== chainId && !destinations.includes(c)),
      unexpected: destinations.filter((c) => !expected.includes(c)),
    };
    const ready = await readDays<readonly [boolean, number]>(deps, diamond, window, 'isDayReadyToFinalize', where);
    const firstAt = await readDays<bigint>(deps, diamond, window, 'getDailyFirstReportAt', where);
    const open = window.filter((d) => ready.has(d) && Number(ready.get(d)![1]) !== REASON_FINALIZED);
    const reported = await readReported(deps, diamond, open, expected, where);
    const finalizedDays = new Set(window.filter((d) => ready.has(d) && Number(ready.get(d)![1]) === REASON_FINALIZED));

    for (const d of open) {
      if (sender.stopped) break;
      const decision = planFinalize(
        {
          day: d,
          finalized: false,
          ownReported: (sentAt.get(d) ?? 0n) > 0n,
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
          // What the finalization itself zeroed, from its own events: the
          // pre-send read can be stale (a report landing in between) or
          // partial (a failed read is judged as all missing).
          const zeroed = zeroedChains(sender.lastLogs, diamond, d);
          if (zeroed.length > 0) {
            // Journaled and queued now: the receipt is the only record.
            console.log(`[keeper] rewardDayClose ${where} notice: ${zeroedLine(d, zeroed)}`);
            const row: WorkItem<{ missing: number[] }> = { item: String(d), block: d, payload: { missing: zeroed } };
            // eslint-disable-next-line no-await-in-loop
            await putWork(env.KEEPER_DB, chainId, diamond, 'day_zeroed', row);
          }
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

    // ── 3. Broadcast ──
    /** Send day `d` to every destination (`broadcastGlobal`). */
    const broadcastAll = async (d: number): Promise<boolean> => {
      const q = await quote(deps.client, diamond, 'quoteBroadcastGlobal', [BigInt(d)]);
      if ('refused' in q) {
        f.refused.set(`broadcast:${d}`, `the Diamond would not quote the broadcast fee (${q.refused})`);
        return false;
      }
      return (await sender.call('broadcast', d, 'broadcastGlobal', [BigInt(d)], q.fee)) === 'landed';
    };
    /** Re-send day `d` only to the destinations still lacking it
     *  (`broadcastGlobalTo`), so a lane that delivered is not paid again; to
     *  every destination when the day or the messenger cannot take a
     *  single-destination send. */
    const resendMissing = async (d: number, missing: readonly number[]): Promise<boolean> => {
      let landed = false;
      for (const c of missing) {
        if (sender.stopped) break;
        // eslint-disable-next-line no-await-in-loop
        const q = await quote(deps.client, diamond, 'quoteBroadcastGlobalTo', [BigInt(d), BigInt(c)]);
        // eslint-disable-next-line no-await-in-loop
        const r = 'refused' in q ? q.refused : await sender.call('broadcast', d, 'broadcastGlobalTo', [BigInt(d), BigInt(c)], q.fee);
        if (r === 'landed') {
          landed = true;
          continue;
        }
        if (RESEND_TO_ALL.has(r)) {
          f.refused.delete(`broadcast:${d}`);
          // eslint-disable-next-line no-await-in-loop
          return (await broadcastAll(d)) || landed;
        }
        if ('refused' in q) f.refused.set(`broadcast:${d}`, `the Diamond would not quote the re-send to chain ${c} (${q.refused})`);
      }
      return landed;
    };

    // A day's send marker lives exactly as long as the day is in the window:
    // kept while it is worked (so a day whose destinations cannot all be
    // confirmed is still sent only once), dropped when the day leaves it. The
    // window's markers are read by day, never as a slice of the queue.
    await pruneWorkBelow(env.KEEPER_DB, chainId, diamond, 'day_broadcast', window[0]);
    const days = [...finalizedDays].sort((a, b) => a - b);
    const marks = await getWorkItems<{ sentAt: number }>(env.KEEPER_DB, chainId, diamond, 'day_broadcast', days.map(String));
    for (const d of days) {
      if (sender.stopped) break;
      // eslint-disable-next-line no-await-in-loop
      const dest = await destinationStates(deps, destinations, d);
      const lastSent = marks.get(String(d))?.payload.sentAt ?? null;
      const decision = planBroadcast(dest, lastSent, nowSec);
      const missing = [...dest].filter(([, s]) => s === 'missing').map(([c]) => c);
      if (decision.kind === 'done') {
        f.settled.add(`broadcast:${d}`);
        f.broadcastConfirmed.add(d);
        if ([...dest.values()].some((s) => s === 'unserved')) unconfirmed.push(d);
        continue;
      }
      if (decision.kind === 'wait') {
        if (decision.late && lastSent !== null) f.lateBroadcast.push({ day: d, missing, sentAt: lastSent });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const landed = decision.resend ? await resendMissing(d, missing) : await broadcastAll(d);
      if (landed) {
        broadcast += 1;
        const row: WorkItem<{ sentAt: number }> = { item: String(d), block: d, payload: { sentAt: Math.floor(Date.now() / 1000) } };
        // eslint-disable-next-line no-await-in-loop
        await putWork(env.KEEPER_DB, chainId, diamond, 'day_broadcast', row);
      } else if (decision.resend && lastSent !== null && missing.length > 0) {
        f.lateBroadcast.push({ day: d, missing, sentAt: lastSent });
      }
    }
  }

  console.log(
    `[keeper] rewardDayClose ${where} role=${canonical ? 'canonical' : 'mirror'} today=${today} window=${window[0]}..${window[window.length - 1]} ` +
      `unclosed=${unclosed.length} closed=${closed}` +
      (canonical ? ` finalized=${finalized} broadcast=${broadcast}` : '') +
      (f.excluded.length > 0 ? ` finalized-without-this-chain=${f.excluded.join(',')}` : '') +
      (unconfirmed.length > 0 ? ` broadcast-unconfirmed(unserved destinations)=${unconfirmed.join(',')}` : '') +
      (f.refused.size > 0 ? ` refused=${[...f.refused.keys()].join(',')}` : '') +
      (sender.stopped ? ` stopped=${sender.stopReason}` : ''),
  );

  if (sender.stopReason === PAUSED_REFUSAL) return;
  await raiseDayCloseAlerts(env, chainId, canonical, f, nowSec, deps.runDeadline);
  if (canonical) await postZeroedNotices(env, chainId, diamond, window, deps.runDeadline);
}

// ─── Reads ──────────────────────────────────────────────────────────────

/** One per-day view over the window, batched; a failed read is absent. */
async function readDays<T>(deps: DayCloseDeps, diamond: Address, days: readonly number[], functionName: string, where: string): Promise<Map<number, T>> {
  const out = new Map<number, T>();
  if (days.length === 0) return out;
  const res = await boundedRead(
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
  const res = await boundedRead(
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
 *  Base holds this chain's report for it (absent = unknown: Base not served,
 *  or a read failed). */
async function baseView(
  base: PeerReader | null,
  days: readonly number[],
  self: number,
  deadline: number,
): Promise<Map<number, { finalized: boolean; counted: boolean }>> {
  const out = new Map<number, { finalized: boolean; counted: boolean }>();
  if (!base || days.length === 0) return out;
  const res = await boundedRead(
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
    if (ready?.status !== 'success' || counted?.status !== 'success') return;
    out.set(d, { finalized: Number((ready.result as readonly [boolean, number])[1]) === REASON_FINALIZED, counted: counted.result === true });
  });
  return out;
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
 *  fixed-width, so zero figures price it exactly. Null when no shape quotes.
 *  A quote that does not match the shape sent cannot overpay silently: the
 *  `closeDay` simulation is the judge, and refuses an underpaid send. */
async function reportFee(client: PublicClient, messenger: Address, day: number): Promise<bigint | null> {
  const z = 0n;
  const d = BigInt(day);
  const ladder: readonly (readonly unknown[])[] = [
    [d, z, z, z, z, z, z, 0n], // B4: + custody era
    [d, z, z, z, z, z, z], // B3
    [d, z, z, z, z], // B1
    [d, z, z], // legacy
  ];
  for (const args of ladder) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return (await client.readContract({ address: messenger, abi: MESSENGER_ABI, functionName: 'quoteSendChainReport', args })) as bigint;
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      if (revertName(err) !== undefined) return null;
    }
  }
  return null;
}

type Quote = { fee: bigint } | { refused: string };

/** A Diamond fee quote, or the reason it was refused. */
async function quote(client: PublicClient, diamond: Address, functionName: string, args: readonly unknown[]): Promise<Quote> {
  try {
    return { fee: (await client.readContract({ address: diamond, abi: ABI, functionName, args })) as bigint };
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    return { refused: revertName(err) ?? shortErr(err) };
  }
}

async function broadcastDestinations(client: PublicClient, messenger: Address): Promise<number[]> {
  const ids = (await client.readContract({ address: messenger, abi: MESSENGER_ABI, functionName: 'getBroadcastDestinations' })) as readonly bigint[];
  return ids.map(Number);
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
  /** The logs of the last call that landed. */
  lastLogs: readonly Log[] = [];

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
      const reason = revertName(err) ?? shortErr(err);
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
      reportSendError(label, err, `send failed: ${shortErr(err)}`);
      return this.stop('send-failed');
    }
    console.log(`${label} value=${value} tx=${hash}`);
    try {
      const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      this.lastLogs = receipt.logs ?? [];
      if (receipt.status !== 'success') {
        this.f.refused.set(key, `reverted on chain (tx ${hash})`);
        return `reverted on chain (tx ${hash})`;
      }
    } catch (err) {
      console.error(`${label} receipt not seen in time: ${shortErr(err)}`);
      return this.stop('receipt-timeout');
    }
    this.f.settled.add(key);
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

/** Raise or clear the pass's ops alerts for one chain. */
async function raiseDayCloseAlerts(env: Env, chainId: number, canonical: boolean, f: RunFindings, nowSec: number, deadline: number): Promise<void> {
  let open: Set<string>;
  try {
    open = new Set(await listOpsAlertKeys(env.KEEPER_DB, `dayclose-%:${chainId}:%`));
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: open alerts unread, alerts left for the next run: ${shortErr(err)}`);
    return;
  }
  const raised = new Set<string>();
  const raise = async (key: string, text: string, repeat = ALERT_REPEAT_SEC): Promise<void> => {
    raised.add(key);
    if (Date.now() >= deadline) return;
    await sendOpsAlert(env, key, text, repeat, nowSec, chainId);
  };
  const tag = `[chain ${chainId}] reward day close`;
  const inWindow = new Set(f.window);

  for (const [k, why] of f.refused) {
    const [step, day] = k.split(':');
    // eslint-disable-next-line no-await-in-loop
    await raise(
      `dayclose-refused:${chainId}:${k}`,
      `${tag}: ${STEP_WORDS[step] ?? step} for reward day ${day} is refused (${why}). The day stays open on this chain until the call goes through; the pass retries every run while the day is in its ${LOOKBACK_DAYS}-day window.`,
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
  if (canonical && f.topology && (f.topology.undeliverable.length > 0 || f.topology.unexpected.length > 0)) {
    const parts: string[] = [];
    if (f.topology.undeliverable.length > 0) {
      parts.push(`chain(s) ${f.topology.undeliverable.join(', ')} are on Base's expected-source list but are not broadcast destinations, so no finalized day reaches them and their users cannot claim`);
    }
    if (f.topology.unexpected.length > 0) {
      parts.push(`chain(s) ${f.topology.unexpected.join(', ')} are broadcast destinations but not on Base's expected-source list, so Base refuses their reports (SourceChainIdNotExpected) and every day finalizes without their interest`);
    }
    await raise(
      `dayclose-topology:${chainId}:all`,
      `${tag}: Base's expected-source list and the reward messenger's broadcast destinations disagree: ${parts.join('; ')}. Make them list the same mirrors (setExpectedSourceChainIds on the Diamond, setBroadcastDestinations on the messenger).`,
    );
  }
  if (canonical && f.selfNotExpected) {
    await raise(
      `dayclose-selfmissing:${chainId}:all`,
      `${tag}: this chain is not on its own expected-source list. Finalization sums only the listed chains, so this chain's own interest is left out of every day's global total while its users' shares are still worked out against it; and its own report still counts toward the contract's report count. Add it (setExpectedSourceChainIds). The pass judges coverage chain by chain, so it does not finalize early meanwhile.`,
    );
  }
  for (const l of f.lateBroadcast) {
    // eslint-disable-next-line no-await-in-loop
    await raise(
      `dayclose-broadcast:${chainId}:${l.day}`,
      `${tag}: the broadcast of reward day ${l.day} has not reached chain(s) ${l.missing.join(', ')} since it was sent at ${new Date(l.sentAt * 1000).toISOString()}. Until it lands, users there cannot claim that day. The pass re-sends it ${BROADCAST_RESEND_AFTER_SEC / 3600}h after each send; check the lane's CCIP delivery.`,
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
    const dayStr = kind === 'dayclose-refused' ? parts[3] : parts[2];
    const day = Number(dayStr);
    let gone = false;
    if (kind === 'dayclose-refused') gone = f.settled.has(`${parts[2]}:${parts[3]}`) || !inWindow.has(day);
    else if (kind === 'dayclose-waiting') gone = f.settled.has(`finalize:${day}`) || !inWindow.has(day);
    // A topology alert clears only on a read that shows the fix.
    else if (kind === 'dayclose-noexpected') gone = canonical && f.noExpected === false;
    else if (kind === 'dayclose-selfmissing') gone = canonical && f.selfNotExpected === false;
    else if (kind === 'dayclose-topology') gone = canonical && f.topology !== null && f.topology.undeliverable.length === 0 && f.topology.unexpected.length === 0;
    // Cleared on a read showing delivery, never on a re-send merely landing.
    else if (kind === 'dayclose-broadcast') gone = f.broadcastConfirmed.has(day) || !inWindow.has(day);
    else if (kind === 'dayclose-excluded') gone = !inWindow.has(day);
    if (gone && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await resolveOpsAlert(env, key);
    }
  }

}

const ZEROED_FOOTER = "Finalization is final: a missing chain's report for these days has its day figures dropped when it lands (its chain-wide figures still apply).";

function zeroedLine(day: number, missing: readonly number[]): string {
  return `reward day ${day}: finalized at grace without chain(s) ${missing.join(', ')}; their interest counts as zero for the day`;
}

/** Post the queued zeroed-day notices (Base). Each was journaled and queued
 *  when its finalization landed; it leaves the queue once delivered (or once
 *  the ops channel is not configured: the journal is then the record), and
 *  otherwise stays for the next run until its day leaves the window. */
async function postZeroedNotices(env: Env, chainId: number, diamond: Address, window: readonly number[], deadline: number): Promise<void> {
  try {
    await pruneWorkBelow(env.KEEPER_DB, chainId, diamond, 'day_zeroed', window[0]);
    const rows = [...(await getWorkItems<{ missing: number[] }>(env.KEEPER_DB, chainId, diamond, 'day_zeroed', window.map(String))).values()];
    if (rows.length === 0 || Date.now() >= deadline) return;
    rows.sort((a, b) => a.block - b.block);
    const lines = rows.map((r) => zeroedLine(r.block, r.payload.missing));
    const outcome = await sendOpsNoticeDigest(env, `[chain ${chainId}] reward day close: finalized with expected reports missing`, lines, ZEROED_FOOTER, chainId);
    if (outcome === 'sent' || outcome === 'unconfigured') {
      await finishWork(env.KEEPER_DB, chainId, diamond, 'day_zeroed', rows.map((r) => r.item));
    }
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: zeroed-day notices left queued: ${shortErr(err)}`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** The chains a landed `finalizeDay(day)` zeroed, from its own
 *  `ChainContributionZeroed` events. */
function zeroedChains(logs: readonly Log[], diamond: Address, day: number): number[] {
  return parseEventLogs({ abi: ABI, logs: logs as Log[], eventName: 'ChainContributionZeroed' })
    .filter((l) => l.address.toLowerCase() === diamond.toLowerCase())
    .map((l) => l.args as unknown as { dayId: bigint; sourceChainId: number })
    .filter((a) => Number(a.dayId) === day)
    .map((a) => Number(a.sourceChainId));
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
