// apps/keeper/src/rewardDeliveryConflict.ts
//
// #2961 (owner decision 2026-10-28, option B) — the reward DELIVERY-CONFLICT
// pass: SKIP a mirror day whose delivered parts CONFLICT on the day's whole,
// and move what landed for it to this mirror's recycle bucket.
//
// A day sent in several parts (#918) carries, in every part, the whole Base
// locked at the day's first part. A part that declares a different whole is a
// source breaking its own rule; the mirror records it (`wholeConflict`), and
// the day never opens: nothing can repair the flag, and Base re-sends the same
// locked whole. So the day's claims could never resume. The contract's answer
// is `skipConflictedDay`: close the day UNPAID on this mirror, once the
// conflict has been on the record for a day, so later days move again; and
// `recycleSkippedDayValue`, repeated until it returns zero, to move whatever
// the day's epochs hold into the recycle bucket, where it funds later days on
// this chain. Both are permissionless and move value only between this
// chain's own records; nothing calls them by itself, so this pass does.
//
// The days come from the indexer's record of the delivery events: a day is
// queued (`delivery_conflict` open work) when a part conflicts on it, and
// again whenever a later part lands on it. Per queued day, each run (every
// 15 minutes):
//
//   - the conflict is ALERTED at once (ops channel), with when the skip
//     becomes allowed — read from the contract's own refusal, never a copy of
//     its delay — or what else it waits on;
//   - the skip is sent once the contract allows it. It is refused, by name,
//     while the delay runs (`DayDeliverySkipTooEarly`) or until Base's
//     broadcast for the day is applied here (`DayDeliverySkipAwaitsBroadcast`):
//     the day stays queued and is tried again;
//   - `DayDeliverySkipSideNotHeld` is an INCIDENT, not a wait: a side whose
//     claims may already have paid from the day (it is no longer held) carries
//     recycled funding, and no later state makes that skip possible — the
//     hold, once released, never returns. It is alerted, the skip is never
//     retried, and the day leaves the queue once that alert is delivered;
//   - after the skip, the value is recycled until the contract reports
//     nothing left. A part that lands on the day later adds to it, so the day
//     is queued again whenever one does;
//   - what was given up and what moved is posted as a NOTICE, from the
//     transactions' own events.
//
// A day that had already opened before its parts conflicted stays paid and
// cannot be skipped; it is alerted as the source fault it is, and left.
//
// Every send goes through the one `StepSender` (simulated first, a refusal
// named by the contract), and every read stops at its stage cutoff
// (`runWindow.ts`, rule 3). Ships disarmed (`REWARD_DELIVERY_CONFLICT_ENABLED`).

import { createPublicClient, formatUnits, http, parseEventLogs, type Abi, type Address, type Log, type PublicClient } from 'viem';
import { RewardEpochFacetABI, RewardRemittanceLensFacetABI, RewardReporterFacetABI, VaipakamDiamondABI } from '@vaipakam/contracts/abis';
import { redactedError } from '@vaipakam/lib/errorDescription';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline, settleBy } from './batchRead';
import { shortErr } from './callErrors';
import { deploymentFloor, discoverConflictedDayParts, finishWork, listOpenWorkPage, touchOpenWork, type ConflictedDayRow } from './db';
import { journal, OPS_POST_TIMEOUT_MS, resolveOpsAlerts, sendOpsAlertDigest, sendOpsNoticeDigest, type OpsAlertOutcome } from './opsAlert';
import { priorStageCutoffMs, readCutoffMs } from './runWindow';
import { StepSender, type CallResult } from './stepSender';
import { discoverWork } from './workQueue';

export const ABI = [
  ...(RewardEpochFacetABI as Abi),
  ...(RewardRemittanceLensFacetABI as Abi),
  ...(RewardReporterFacetABI as Abi),
  ...(VaipakamDiamondABI as Abi).filter((x) => x.type === 'error'),
] as Abi;

export const PASS_CADENCE_SEC = 15 * 60;
/** Conflicted days one run reads (the rest wait their turn in rotation). */
export const CONFLICT_SLICE = 50;
/** Skip and recycle transactions per chain per run. A conflict is a fault, and
 *  a skipped day's value usually moves in one call. */
export const MAX_SENDS_PER_RUN = 4;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** The tail of a run kept for what follows its sends: the queue writes, then
 *  one alert digest and one notice digest, each bounded by its post timeout. */
export const ALERT_TAIL_MS = 2 * OPS_POST_TIMEOUT_MS + 10_000;
/** Repeat a standing conflict alert at most this often. */
const ALERT_REPEAT_SEC = 6 * 3600;
const WORK_KIND = 'delivery_conflict' as const;
const ROLE_MIRROR = 1;
const PAUSED_REFUSAL = 'EnforcedPause';

/** Refusals that are the day's own state, read again next run, never a fault
 *  of the call: each is worked from `sender.refusal` below. */
export const EXPECTED_REFUSALS: ReadonlySet<string> = new Set([
  'DayDeliverySkipTooEarly',
  'DayDeliverySkipAwaitsBroadcast',
  'DayDeliverySkipSideNotHeld',
  'DayDeliveryAlreadySkipped',
  'DayDeliveryNotConflicted',
  'DayDeliveryAlreadyOpen',
]);

/** The day's delivery record, as `getDayDeliveryParts` returns it. */
export interface DayParts {
  wholeFresh: bigint;
  wholeRecycled: bigint;
  landedFresh: bigint;
  landedRecycled: bigint;
  landedAt: bigint | number;
  parts: bigint | number;
  wholeConflict: boolean;
  conflictAt: bigint | number;
  skippedAt: bigint | number;
}

/** The part of the `StepSender` a day's work uses, so the rules are tested
 *  against a fake. */
export type ConflictCaller = Pick<StepSender, 'call' | 'receipt' | 'refusal' | 'stopped' | 'stall'>;

/** What working one day needs. */
export interface ConflictDeps {
  chainId: number;
  diamond: Address;
  abi: Abi;
  readParts(day: bigint): Promise<DayParts>;
  sender: ConflictCaller;
}

/** A standing condition for the ops channel. */
export interface ConflictCondition {
  key: string;
  id: string;
  detail: string;
  group: 'conflict' | 'incident' | 'refused';
}

/** What working one day found. */
export interface DayOutcome {
  /** The day leaves the queue: nothing a send can do is left. */
  finished: boolean;
  /** Finished on a condition only a person can act on (an incident, a source
   *  fault): the day leaves the queue only once its alert is delivered, so a
   *  failed post is posted again on the next run (Codex #2999). */
  awaitsAlert: boolean;
  conditions: ConflictCondition[];
  /** Alert keys the run disproved. */
  cleared: string[];
  /** Things that HAPPENED this run (a skip, value recycled). */
  notices: string[];
}

export const conflictKey = (chainId: number, day: bigint | string) => `delivery-conflict:${chainId}:${day}`;
export const heldKey = (chainId: number, day: bigint | string) => `delivery-conflict-held:${chainId}:${day}`;
export const refusedKey = (chainId: number, day: bigint | string) => `delivery-conflict-revert:${chainId}:${day}`;

const vpfi = (x: bigint) => `${formatUnits(x, 18)} VPFI`;
const iso = (sec: bigint | number) => new Date(Number(sec) * 1000).toISOString();

/** What the day's record says, for an alert: the whole its first part set and
 *  what has landed. The conflicting part's own figures are in its
 *  `DayDeliveryWholeConflict` event. Pure. */
export function describeParts(p: DayParts): string {
  return (
    `${Number(p.parts)} part${Number(p.parts) === 1 ? '' : 's'} landed (fresh ${vpfi(p.landedFresh)}, recycled ${vpfi(p.landedRecycled)}) ` +
    `against the first part's whole (fresh ${vpfi(p.wholeFresh)}, recycled ${vpfi(p.wholeRecycled)}); ` +
    `conflict since ${iso(p.conflictAt)}`
  );
}

/** Why the sender sent nothing for a call it was allowed to make: its stall
 *  (no key, an RPC that does not answer, a send the node refused, a receipt
 *  not seen), or the run's send budget or deadline, which the next run
 *  continues from. */
function notSentWhy(sender: ConflictCaller): string {
  return sender.stall ?? 'this run reached its send budget or deadline; the next run sends it';
}

/**
 * Work ONE conflicted day: read its record, then skip it or recycle what it
 * holds, as far as the contract allows and this run's sends reach. Every call
 * is simulated first; a refusal is classified by the contract's own name for
 * it. Exported for the tests.
 */
export async function workConflictedDay(deps: ConflictDeps, day: bigint): Promise<DayOutcome> {
  const out: DayOutcome = { finished: false, awaitsAlert: false, conditions: [], cleared: [], notices: [] };
  const { chainId, sender } = deps;
  const ck = conflictKey(chainId, day);
  const rk = refusedKey(chainId, day);
  const raise = (key: string, group: ConflictCondition['group'], detail: string) => out.conditions.push({ key, id: `day ${day}`, detail, group });
  const conflicted = (parts: DayParts, tail: string) => raise(ck, 'conflict', `its parts disagree on its whole, so it cannot open. ${describeParts(parts)}. ${tail}`);

  let parts = await deps.readParts(day);
  if (!parts.wholeConflict) {
    // Found by its conflict event, so this is a Diamond whose record no longer
    // carries it (a redeploy keeps another queue); nothing is left to do.
    out.finished = true;
    out.cleared.push(ck, rk);
    return out;
  }
  if (Number(parts.landedAt) !== 0) {
    raise(ck, 'conflict', `opened at ${iso(parts.landedAt)}, before its parts conflicted: it stays paid and cannot be skipped. ${describeParts(parts)}. The source broke its own rule; investigate it.`);
    out.finished = true;
    out.awaitsAlert = true;
    return out;
  }

  if (Number(parts.skippedAt) === 0) {
    const res = await sender.call('skip', String(day), 'skipConflictedDay', [day]);
    if (res === 'landed') {
      out.notices.push(skipNotice(deps, day, sender.receipt?.logs ?? []));
      out.cleared.push(rk);
    } else if (res === 'skipped') {
      // Not sent: the conflict stands, and says why nothing went out.
      conflicted(parts, `The skip was not sent: ${notSentWhy(sender)}.`);
      return out;
    } else {
      const refusal = sender.refusal;
      switch (refusal?.name) {
        case 'DayDeliverySkipTooEarly': {
          const readyAt = refusal.args[1];
          const when = typeof readyAt === 'bigint' ? iso(readyAt) : 'one day after the conflict';
          conflicted(parts, `This keeper skips it (closed unpaid on this mirror) from ${when}.`);
          out.cleared.push(rk);
          return out;
        }
        case 'DayDeliverySkipAwaitsBroadcast':
          conflicted(parts, "The skip waits for Base's broadcast for the day to be applied here.");
          out.cleared.push(rk);
          return out;
        case 'DayDeliverySkipSideNotHeld': {
          const s = refusal.args[1];
          const side = s === 0 || s === 0n ? 'lender' : s === 1 || s === 1n ? 'borrower' : 'one';
          raise(
            heldKey(chainId, day),
            'incident',
            `its parts disagree on its whole and it CANNOT be skipped: its ${side} side carries recycled funding and is no longer held, so claims may already have paid from the day. ${describeParts(parts)}. Not retried; this needs a person.`,
          );
          out.cleared.push(ck, rk);
          out.finished = true;
          out.awaitsAlert = true;
          return out;
        }
        case 'DayDeliveryAlreadySkipped':
          // Another caller got there first: recycle below, on a fresh read.
          parts = await deps.readParts(day);
          break;
        case 'DayDeliveryNotConflicted':
        case 'DayDeliveryAlreadyOpen':
          // The record moved since the read: read again next run.
          return out;
        default:
          raise(rk, 'refused', `skipConflictedDay was refused: ${res}. ${describeParts(parts)}.`);
          conflicted(parts, 'Not yet skipped.');
          return out;
      }
    }
  }

  // Skipped: move what the day's epochs hold, until the contract says nothing
  // is left. The simulation's return value is what the call would move, so a
  // call that would move nothing is not sent, and that is the end.
  let fresh = 0n;
  let recycled = 0n;
  let calls = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const res: CallResult = await sender.call('recycle', String(day), 'recycleSkippedDayValue', [day], 0n, (moved) => moved !== 0n);
    if (res === 'idle') {
      out.finished = true;
      out.cleared.push(ck, rk);
      break;
    }
    if (res === 'skipped') break; // the rest moves next run
    if (res !== 'landed') {
      raise(rk, 'refused', `recycleSkippedDayValue was refused: ${res}. The value that landed for the skipped day has not moved.`);
      break;
    }
    const moved = recycledBy(deps, day, sender.receipt?.logs ?? []);
    calls += 1;
    fresh += moved.fresh;
    recycled += moved.recycled;
    if (moved.fresh + moved.recycled === 0n) break; // landed, its event unread: read again next run rather than spin
  }
  if (calls > 0) {
    out.notices.push(
      `day ${day}: ${vpfi(fresh)} fresh and ${vpfi(recycled)} recycled value moved to this mirror's recycle bucket in ${calls} call${calls === 1 ? '' : 's'}` +
        `${out.finished ? '; nothing is left for the day' : '; more may be left, moved next run'}.`,
    );
  }
  // A skipped day still holding value this run could not move stays queued,
  // and raises nothing new.
  return out;
}

/** The skip's notice, from its own `DayDeliveryConflictSkipped` event: what
 *  the day would have priced, given up, and the recycled commitment released.
 *  Pure over the receipt's logs. */
function skipNotice(deps: ConflictDeps, day: bigint, logs: readonly Log[]): string {
  const ev = ownEvents(deps, logs, 'DayDeliveryConflictSkipped').find((e) => e.args.dayId === day);
  if (!ev) return `day ${day}: skipped (closed unpaid on this mirror); its DayDeliveryConflictSkipped event was not in the receipt this keeper read.`;
  const a = ev.args as Record<string, bigint>;
  return (
    `day ${day}: skipped (closed unpaid on this mirror) in ${ev.transactionHash}. Given up: fresh lender half ${vpfi(a.freshLenderHalf)}, ` +
    `fresh borrower half ${vpfi(a.freshBorrowerHalf)}, recycled lender half ${vpfi(a.lenderHalfEquiv)}, recycled borrower half ${vpfi(a.borrowerHalfEquiv)}; ` +
    `recycled commitment released: ${vpfi(a.recycleConsume)}.`
  );
}

/** What one recycle call moved, from its own `DayDeliveryConflictValueRecycled`
 *  event (none when it moved nothing). Pure over the receipt's logs. */
function recycledBy(deps: ConflictDeps, day: bigint, logs: readonly Log[]): { fresh: bigint; recycled: bigint } {
  let fresh = 0n;
  let recycled = 0n;
  for (const ev of ownEvents(deps, logs, 'DayDeliveryConflictValueRecycled')) {
    const a = ev.args as Record<string, bigint>;
    if (a.dayId !== day) continue;
    fresh += a.fresh;
    recycled += a.recycled;
  }
  return { fresh, recycled };
}

function ownEvents(deps: ConflictDeps, logs: readonly Log[], eventName: string) {
  const own = logs.filter((l) => l.address.toLowerCase() === deps.diamond.toLowerCase()) as Log[];
  return parseEventLogs({ abi: deps.abi, logs: own, eventName, strict: false }) as unknown as {
    args: Record<string, unknown>;
    transactionHash: string;
  }[];
}

// ─── The run ────────────────────────────────────────────────────────────────

/** `work`, abandoned at `cutoff` if still waiting then (`PastRunDeadline`). */
function boundedCall<T>(cutoff: number, what: string, work: () => Promise<T>): Promise<T> {
  if (Date.now() >= cutoff) return Promise.reject(new PastRunDeadline(`${what}: past its cutoff — read next run`));
  return settleBy(work(), cutoff, () => {
    throw new PastRunDeadline(`${what}: still unread at its cutoff — read next run`);
  });
}

export async function runRewardDeliveryConflict(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardDeliveryConflict', 'REWARD_DELIVERY_CONFLICT_ENABLED')) return;
  const runDeadline = tick.deadlineMs;
  const sendDeadline = runDeadline - ALERT_TAIL_MS;
  const nowSec = Math.floor(Date.now() / 1000);
  await Promise.all(
    getChainConfigs(env)
      .filter((c) => c.diamond)
      .map(async (chain: ChainConfig) => {
        try {
          await conflictsOnce(env, chain, sendDeadline, runDeadline, nowSec);
        } catch (err) {
          console.error(`[keeper] rewardDeliveryConflict chain=${chain.id} failed: ${redactedError(err, { stack: false })}`);
        }
      }),
  );
}

/** One chain's run: gate, discover, work a slice of the queue, then record and
 *  post what it found. */
async function conflictsOnce(env: Env, chain: ChainConfig, sendDeadline: number, runDeadline: number, nowSec: number): Promise<void> {
  const chainId = chain.id;
  const diamond = chain.diamond as Address;
  const readCutoff = readCutoffMs(sendDeadline);
  const queueCutoff = priorStageCutoffMs(readCutoff);
  const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
  const client = deadlineClient(plain, sendDeadline);
  const reads = deadlineClient(plain, readCutoff);
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    boundedCall(readCutoff, functionName, () => reads.readContract({ address: diamond, abi: ABI, functionName, args })) as Promise<T>;

  const gate = await readGate(read, chainId);
  if (gate !== null) {
    console.log(`[keeper] rewardDeliveryConflict chain=${chainId}: not worked this run: ${gate}`);
    return;
  }

  // Discovery and the queue page, by the stage before the day reads. Discovery
  // stores its cursor page by page, so one stopped here resumes next run.
  let open: { item: string }[];
  try {
    open = await boundedCall(queueCutoff, 'the conflicted-day queue', async () => {
      await discoverWork<ConflictedDayRow>(env, chainId, diamond, WORK_KIND, deploymentFloor(chainId), async (from, through, limit) => {
        const page = await discoverConflictedDayParts(env.DB, chainId, from, through, limit);
        return { items: page.rows.map((r) => ({ item: r.dayId, block: r.block, payload: r })), next: page.next };
      });
      return (await listOpenWorkPage<ConflictedDayRow>(env.KEEPER_DB, chainId, diamond, WORK_KIND, CONFLICT_SLICE)).items;
    });
  } catch (err) {
    console.error(`[keeper] rewardDeliveryConflict chain=${chainId}: the conflicted-day queue was not read (${err instanceof PastRunDeadline ? shortErr(err) : redactedError(err, { stack: false })})`);
    return;
  }
  if (open.length === 0) return;

  const sender = new StepSender(
    {
      pass: 'rewardDeliveryConflict',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: new Set(),
      pausedRefusal: PAUSED_REFUSAL,
      unrecorded: EXPECTED_REFUSALS,
      describe: (s) => `day ${s}`,
      spends: 'the gas',
    },
    { context: (): KeeperContext | null => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }), sendDeadline },
  );
  const deps: ConflictDeps = {
    chainId,
    diamond,
    abi: ABI,
    readParts: (day) => read<DayParts>('getDayDeliveryParts', [day]),
    sender,
  };
  const r = await workQueue(deps, open, readCutoff);
  await recordAndPost(env, chainId, diamond, r, runDeadline, nowSec);
  if (sender.stopped && sender.stall !== null) console.warn(`[keeper] rewardDeliveryConflict chain=${chainId}: sends stopped: ${sender.stall}`);
}

/** The Diamond must name itself this chain and hold the Mirror role: only a
 *  mirror counts delivered parts. A string says why not. */
async function readGate(read: <T>(fn: string, args?: readonly unknown[]) => Promise<T>, chainId: number): Promise<string | null> {
  try {
    const cfg = await read<readonly [Address, number, ...unknown[]]>('getRewardReporterConfig');
    if (Number(cfg[1]) !== chainId) {
      return `the Diamond its RPC serves names itself chain ${Number(cfg[1])}, so the RPC configured for chain ${chainId} answers for another chain (or the Diamond's reporter config names the wrong local chain)`;
    }
    const role = await read<number>('getRewardRole');
    if (Number(role) !== ROLE_MIRROR) return `its reward role is ${Number(role)}, not Mirror: only a mirror counts delivered parts`;
    return null;
  } catch (err) {
    return `its reward reporter config or role could not be read (${shortErr(err)})`;
  }
}

/** What the run found across its slice of the queue. */
export interface QueueRun {
  finished: string[];
  /** Finished, but held in the queue until their alert is delivered. */
  awaitingAlert: string[];
  examined: string[];
  conditions: ConflictCondition[];
  cleared: Set<string>;
  notices: string[];
}

/** Work each queued day in turn, until the reads' cutoff or the sender stops.
 *  A day whose record cannot be read keeps its place and is read again next
 *  run. Exported for the tests. */
export async function workQueue(deps: ConflictDeps, open: readonly { item: string }[], readCutoff: number): Promise<QueueRun> {
  const run: QueueRun = { finished: [], awaitingAlert: [], examined: [], conditions: [], cleared: new Set(), notices: [] };
  for (const o of open) {
    if (Date.now() >= readCutoff || deps.sender.stopped) break; // the rest keep their turn
    run.examined.push(o.item);
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await workConflictedDay(deps, BigInt(o.item));
      if (r.finished) (r.awaitsAlert ? run.awaitingAlert : run.finished).push(o.item);
      run.conditions.push(...r.conditions);
      for (const k of r.cleared) run.cleared.add(k);
      run.notices.push(...r.notices);
    } catch (err) {
      console.error(`[keeper] rewardDeliveryConflict chain=${deps.chainId} day=${o.item} not worked: ${err instanceof PastRunDeadline ? shortErr(err) : redactedError(err, { stack: false })}`);
    }
  }
  return run;
}

/** The queue writes, then the notices, alerts and clears, all by the run's
 *  deadline. A day finished on an alert leaves the queue only once that alert
 *  is delivered. */
export async function recordAndPost(env: Env, chainId: number, diamond: Address, run: QueueRun, deadline: number, nowSec: number): Promise<void> {
  await finishWork(env.KEEPER_DB, chainId, diamond, WORK_KIND, run.finished);
  await touchOpenWork(env.KEEPER_DB, chainId, diamond, WORK_KIND, run.examined.filter((d) => !run.finished.includes(d)));

  const tag = `[chain ${chainId}] reward delivery conflicts`;
  if (run.notices.length > 0) {
    journal(`${tag}:`, run.notices);
    await sendOpsNoticeDigest(env, `${tag}:`, run.notices, "Each figure is from the transaction's own event.", chainId);
  }
  let alerted: OpsAlertOutcome = 'suppressed';
  if (run.conditions.length > 0) {
    alerted = await sendOpsAlertDigest(
      env,
      (n) => `${tag}: ${n} mirror day${n === 1 ? '' : 's'} whose delivered parts disagree on the day's whole:`,
      run.conditions,
      'A conflicted day never opens: its claims and sweeps wait until it is skipped (closed unpaid here), and then move again. Each conflicting part is in its DayDeliveryWholeConflict event.',
      ALERT_REPEAT_SEC,
      nowSec,
      chainId,
      deadline,
    );
  }
  // Every condition the digest carried is delivered, or was before (a repeat
  // suppressed inside its window). With no ops bot the journal is the only
  // place it can go, and it has been written there. A failed or refused post
  // keeps those days queued, to be posted again.
  if (run.awaitingAlert.length > 0 && ALERT_DELIVERED.has(alerted)) {
    await finishWork(env.KEEPER_DB, chainId, diamond, WORK_KIND, run.awaitingAlert);
  }
  const raised = new Set(run.conditions.map((c) => c.key));
  await resolveOpsAlerts(env, [...run.cleared].filter((k) => !raised.has(k)), deadline);
}

const ALERT_DELIVERED: ReadonlySet<OpsAlertOutcome> = new Set(['sent', 'suppressed', 'unconfigured']);
