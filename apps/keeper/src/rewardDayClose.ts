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
//      mirror first asks Base (when this keeper also serves Base) whether the
//      day is already finalized there: a report that lands after finalization
//      is refused by Base's ingress, so sending it would only spend the fee,
//      and the run says instead that the day was finalized without this
//      chain. A close refused because the interest fold has not reached the
//      day (`ChainReportFrontierShort`) is preceded by `advanceInterestFrontiers`.
//   2. FINALIZES (Base only) each day whose own report is recorded, when
//      either every chain on Base's expected-source list has reported, or the
//      grace window since the day's first report has elapsed — and only when
//      the contract agrees (`isDayReadyToFinalize`). The keeper's coverage
//      rule is per CHAIN, never a report COUNT: a count can reach the expected
//      number while an expected chain is still missing (a report from a chain
//      not on the list counts too), and finalizing then would zero a report
//      still in flight inside grace. A day finalized at grace with a chain
//      missing zeroes that chain's interest for the day, so the run says so,
//      naming each one. An empty expected-source list is never finalized
//      against: every day would finalize as zero, irreversibly.
//   3. BROADCASTS (Base only) each finalized day to the messenger's
//      destinations (`broadcastGlobal`, the quoted fee, paid exactly), and
//      confirms delivery by reading each destination this keeper also serves
//      (`getKnownGlobalInterestNumeraire18(d).isSet` on that mirror). A day
//      is sent once and re-sent only when a served destination still lacks
//      the pair {@link BROADCAST_RESEND_AFTER_SEC} after the last send (the
//      mirror ingress is idempotent, so a re-send cannot double-apply). A
//      destination this keeper does not serve cannot be read, so it is sent
//      to once and never confirmed: the run's line says so.
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
//   - on Base, an expected chain still missing when grace ends within
//     {@link GRACE_WARNING_SEC}, naming each missing chain and whether it has
//     sent its report (read on that chain, when served) or not;
//   - on Base, an empty expected-source list, or one that leaves Base itself
//     out (Base's own interest is then summed into no day's global total);
//   - on Base, a broadcast a served destination has not received
//     {@link BROADCAST_LATE_AFTER_SEC} after it was sent;
//   - on a mirror, a day Base finalized without this chain's report.
// And one NOTICE (a thing that happened): a day Base finalized at grace with
// expected chains missing, naming each.
//
// The broadcast's last send time is the only state the pass keeps: one row
// per (chain, Diamond, day) in the keeper's private open-work queue
// (`keeper_work_open`, kind `day_broadcast`), removed once every served
// destination has the pair. Losing it costs at most one extra broadcast.
//
// Gated by KEEPER_ENABLED + REWARD_DAY_CLOSE_ENABLED.

import { BaseError, ContractFunctionRevertedError, createPublicClient, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
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
import { finishWork, listOpsAlertKeys, listOpenWork, putWork, type WorkItem } from './db';
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
/** Warn when grace ends within this long and an expected chain is missing. */
export const GRACE_WARNING_SEC = 60 * 60;
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
}

export type FinalizeDecision =
  | { kind: 'done' }
  | { kind: 'own-report-first' }
  | { kind: 'no-expected' }
  | { kind: 'finalize'; missing: number[] }
  | { kind: 'wait'; missing: number[]; graceEndsAt: number | null };

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
  const missing = x.expected.filter((c) => !x.reported.has(c));
  const graceEndsAt = x.firstReportAt > 0 ? x.firstReportAt + graceSec : null;
  const graceElapsed = graceEndsAt !== null && nowSec >= graceEndsAt;
  if ((missing.length === 0 || graceElapsed) && x.contractReady) return { kind: 'finalize', missing };
  return { kind: 'wait', missing, graceEndsAt };
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
 * the pair (an unserved one cannot be confirmed, and one whose read failed is
 * judged next run); a served destination still missing it is reported late
 * after {@link BROADCAST_LATE_AFTER_SEC} and re-sent after
 * {@link BROADCAST_RESEND_AFTER_SEC}.
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
  if (states.some((s) => s === 'unread')) return { kind: 'wait', late: false };
  if (!states.some((s) => s === 'missing')) return { kind: 'done' };
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
  waiting: { day: number; missing: number[]; graceEndsAt: number | null; sent: Map<number, number | null> }[];
  /** Base: days finalized this run with expected chains missing. */
  zeroed: { day: number; missing: number[] }[];
  /** Base: the expected-source list is empty. */
  noExpected: boolean;
  /** Base: the expected-source list leaves Base itself out. */
  selfNotExpected: boolean;
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

  const f: RunFindings = { refused: new Map(), settled: new Set(), waiting: [], zeroed: [], noExpected: false, selfNotExpected: false, lateBroadcast: [], excluded: [], window };
  const sender = new Sender(deps, f);

  // ── 1. Close ──
  const sentAt = await readDays<bigint>(deps, diamond, window, 'getChainReportSentAt', where);
  const unclosed = window.filter((d) => sentAt.get(d) === 0n);
  for (const d of window) if ((sentAt.get(d) ?? 0n) > 0n) f.settled.add(`close:${d}`);
  let closeable = unclosed;
  if (!canonical && unclosed.length > 0) {
    const finalizedOnBase = await baseFinalized(deps.peer(baseChainId), unclosed, deps.sendDeadline);
    f.excluded = unclosed.filter((d) => finalizedOnBase.get(d) === true);
    closeable = unclosed.filter((d) => finalizedOnBase.get(d) !== true);
  }
  let closed = 0;
  for (const d of closeable) {
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
  if (canonical && !sender.stopped) {
    const expected = (await read<readonly number[]>('getExpectedSourceChainIds')).map(Number);
    f.noExpected = expected.length === 0;
    f.selfNotExpected = !f.noExpected && !expected.includes(chainId);
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
          reported: reported.get(d) ?? new Set(),
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
          if (decision.missing.length > 0) f.zeroed.push({ day: d, missing: decision.missing });
        }
      } else if (decision.kind === 'wait' && decision.missing.length > 0) {
        const nearEnd = decision.graceEndsAt !== null && decision.graceEndsAt - nowSec <= GRACE_WARNING_SEC;
        // eslint-disable-next-line no-await-in-loop
        if (nearEnd) f.waiting.push({ day: d, missing: decision.missing, graceEndsAt: decision.graceEndsAt, sent: await peerSentAt(deps, decision.missing, d) });
      }
    }
    for (const d of finalizedDays) f.settled.add(`finalize:${d}`);

    // ── 3. Broadcast ──
    const destinations = sender.stopped ? [] : await broadcastDestinations(deps.client, messenger);
    const work = new Map(
      (await listOpenWork<{ sentAt: number }>(env.KEEPER_DB, chainId, diamond, 'day_broadcast', LOOKBACK_DAYS * 4)).map((w) => [Number(w.item), w]),
    );
    for (const d of [...finalizedDays].sort((a, b) => a - b)) {
      if (sender.stopped) break;
      // eslint-disable-next-line no-await-in-loop
      const dest = await destinationStates(deps, destinations, d);
      const item = work.get(d);
      const decision = planBroadcast(dest, item ? item.payload.sentAt : null, nowSec);
      const missing = [...dest].filter(([, s]) => s === 'missing').map(([c]) => c);
      if (decision.kind === 'done') {
        // eslint-disable-next-line no-await-in-loop
        if (item) await finishWork(env.KEEPER_DB, chainId, diamond, 'day_broadcast', [String(d)]);
        f.settled.add(`broadcast:${d}`);
        if ([...dest.values()].some((s) => s === 'unserved')) unconfirmed.push(d);
        continue;
      }
      if (decision.kind === 'wait') {
        if (decision.late && item) f.lateBroadcast.push({ day: d, missing, sentAt: item.payload.sentAt });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const fee = await broadcastFee(deps.client, diamond, d);
      if (fee === null) {
        f.refused.set(`broadcast:${d}`, 'the Diamond would not quote the broadcast fee');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await sender.call('broadcast', d, 'broadcastGlobal', [BigInt(d)], fee);
      if (r === 'landed') {
        broadcast += 1;
        const row: WorkItem<{ sentAt: number }> = { item: String(d), block: d, payload: { sentAt: Math.floor(Date.now() / 1000) } };
        // eslint-disable-next-line no-await-in-loop
        await putWork(env.KEEPER_DB, chainId, diamond, 'day_broadcast', row);
      } else if (decision.resend && item && missing.length > 0) {
        f.lateBroadcast.push({ day: d, missing, sentAt: item.payload.sentAt });
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

/** Which expected chains Base has recorded a report from, per day. A day
 *  whose reads failed is absent, and so never finalizes this run on coverage. */
async function readReported(deps: DayCloseDeps, diamond: Address, days: readonly number[], expected: readonly number[], where: string): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  const pairs = days.flatMap((d) => expected.map((c) => [d, c] as const));
  if (pairs.length === 0) return out;
  const res = await boundedRead(
    deps.readClient as never,
    pairs.map(([d, c]) => ({ address: diamond, abi: ABI, functionName: 'isChainReported', args: [BigInt(d), c] })),
    `rewardDayClose ${where} isChainReported`,
    deps.sendDeadline,
  );
  const failed = new Set<number>();
  pairs.forEach(([d, c], i) => {
    if (res[i]?.status !== 'success') {
      failed.add(d);
      return;
    }
    if (!out.has(d)) out.set(d, new Set());
    if (res[i].result === true) out.get(d)!.add(c);
  });
  // A day with any unread chain is judged on grace alone: treat every expected
  // chain as missing, so coverage cannot be claimed from a partial read.
  for (const d of failed) out.set(d, new Set());
  return out;
}

/** On a mirror: which of `days` Base has already finalized (absent = unknown:
 *  Base not served, or its read failed). */
async function baseFinalized(base: PeerReader | null, days: readonly number[], deadline: number): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  if (!base) return out;
  const res = await boundedRead(
    base.client as never,
    days.map((d) => ({ address: base.diamond, abi: ABI, functionName: 'isDayReadyToFinalize', args: [BigInt(d)] })),
    'rewardDayClose base isDayReadyToFinalize',
    deadline,
  );
  days.forEach((d, i) => {
    if (res[i]?.status === 'success') out.set(d, Number((res[i].result as readonly [boolean, number])[1]) === REASON_FINALIZED);
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

/** The messenger's fee for the report `closeDay` sends: the current (B4) shape,
 *  or the eight-word one a messenger without it dispatches. The payload is
 *  fixed-width, so zero figures price it exactly. Null when neither quotes. */
async function reportFee(client: PublicClient, messenger: Address, day: number): Promise<bigint | null> {
  const z = 0n;
  const attempts: readonly (readonly unknown[])[] = [
    [BigInt(day), z, z, z, z, z, z, 0n],
    [BigInt(day), z, z, z, z, z, z],
  ];
  for (const args of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return (await client.readContract({ address: messenger, abi: MESSENGER_ABI, functionName: 'quoteSendChainReport', args })) as bigint;
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
    }
  }
  return null;
}

async function broadcastFee(client: PublicClient, diamond: Address, day: number): Promise<bigint | null> {
  try {
    return (await client.readContract({ address: diamond, abi: ABI, functionName: 'quoteBroadcastGlobal', args: [BigInt(day)] })) as bigint;
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    return null;
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
      `${tag}: reward day ${w.day} is still missing ${w.missing.length} expected report(s): ${each}. Grace ends ${ends}; at that point the day is finalized without them and each missing chain's interest counts as zero for the day.`,
    );
  }
  if (canonical && f.noExpected) {
    await raise(
      `dayclose-noexpected:${chainId}:all`,
      `${tag}: Base's expected-source list is empty, so no day is finalized: a day finalized against an empty list sums no chain and finalizes as zero, irreversibly. Set the list (setExpectedSourceChainIds) before rewards can be finalized.`,
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
      `${tag}: Base finalized reward day ${d} before this chain reported it, so this chain's interest counts as zero for that day. The report is not sent: Base refuses a report after finalization.`,
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
    else if (kind === 'dayclose-noexpected') gone = canonical && !f.noExpected;
    else if (kind === 'dayclose-selfmissing') gone = canonical && !f.selfNotExpected;
    else if (kind === 'dayclose-broadcast') gone = f.settled.has(`broadcast:${day}`) || !inWindow.has(day);
    else if (kind === 'dayclose-excluded') gone = !inWindow.has(day);
    if (gone && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await resolveOpsAlert(env, key);
    }
  }

  if (f.zeroed.length > 0 && Date.now() < deadline) {
    const lines = f.zeroed.map((z) => `reward day ${z.day}: finalized at grace without chain(s) ${z.missing.join(', ')}; their interest counts as zero for the day`);
    for (const l of lines) console.log(`[keeper] rewardDayClose chain=${chainId} notice: ${l}`);
    await sendOpsNoticeDigest(env, `${tag}: finalized with expected reports missing`, lines, 'Finalization is final: a missing chain\'s report for these days is refused when it lands.', chainId);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

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
