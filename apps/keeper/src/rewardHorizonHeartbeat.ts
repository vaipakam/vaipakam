// apps/keeper/src/rewardHorizonHeartbeat.ts
//
// #2517 — the reward claim-horizon heartbeat (RL-3, #1956).
//
// The claim horizon reaps a dormant reward only after it has stayed
// claim-executable for a full horizon plus the 90-day notice, measured in
// EXECUTABLE time, never wall-clock. That time is an accumulator per reward
// entry, and it advances only when something TOUCHES the entry
// (`RewardHorizonSweepFacet.sweepExpiredInteractionRewards`, permissionless):
// the first touch that finds the entry claim-executable starts it, and each
// later interval between two touches counts only if the entry was executable
// at both ends and the gap is no longer than the contract's maximum
// observation gap. With nobody touching, no clock starts, no final notice is
// filed and nothing ever expires — the horizon knob would read as live while
// the path is dark. So the runbook makes this pass a precondition of arming
// `setRewardClaimHorizonDays` (GovernanceRunbook, M7.2), and it runs before
// the knob is armed: while the horizon is dark it only discovers.
//
// Per chain, per run (hourly):
//
//   0. PAUSE — read the protocol's pause state. While it is paused no touch can
//      land and no clock runs, so the run sends nothing and leaves every
//      queue-wide report as it stands (see step 4).
//   1. DISCOVER — read the global entry sequence from the keeper's cursor
//      (`getRewardEntriesRange`; ids are allocated from 1), queue every entry
//      not yet settled, and move the cursor to the end of what exists. The
//      run's line says whether discovery reached that end (`discovery=caught-up`)
//      or stopped short of it (`discovery=behind`).
//   2. READ the due entries (not finished with for most of a heartbeat), the
//      least recently tried first, so entries that keep failing rotate to the
//      back instead of holding the slice: the entry itself and the contract's removal
//      estimate (`getRewardEntryExpiry`). A settled entry (claimed, expired,
//      forfeited) leaves the queue. The pass decides nothing about
//      executability: that is the sweep's own gate, re-run on every touch.
//   3. TOUCH — sweep the due entries in batches. A touch on an entry that
//      cannot advance is a cheap no-op on chain, so every live entry is
//      touched each heartbeat while the horizon is armed; while it is dark,
//      only an entry whose removal has begun is (it still needs its
//      settlement finished). Every transaction carries exactly the entries
//      just simulated together on the current state; a group that would
//      revert is halved until each part goes through or one bad entry is left
//      on its own, so one bad entry costs only itself.
//   4. ALERT — the OPS channel, for an entry whose touch reverts for a reason
//      other than the protocol being paused (named, with the reason); for
//      queued entries the pass has not finished with for two heartbeats
//      (whatever the cause: touches not landing, or more live entries than a
//      heartbeat can reach — the alert states the capacity); and, while the
//      horizon is armed, for entries whose clock did not advance across two
//      consecutive landed touches, with the two readings compared (see
//      {@link pausedRunsAfter}). While the protocol is paused, none of the
//      queue-wide reports (refused, overdue, paused clock) is raised or
//      cleared: a pause is an operator's deliberate act, and what it stops is
//      not a fault of the pass.
//
// The pass needs no notification code: the indexer files the free final
// notice and the removal rows from `RewardEntryExpiryArmed` /
// `RewardEntryExpiryBegun`, which these touches are what emit.
//
// Every call here is permissionless and moves value only into the protocol's
// recycle bucket (an expired reward), never to the keeper.
//
// Gated by KEEPER_ENABLED + REWARD_HORIZON_HEARTBEAT_ENABLED.

import { BaseError, ContractFunctionRevertedError, createPublicClient, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { AdminFacetABI, ConfigFacetABI, InteractionRewardsLensFacetABI, RewardHorizonSweepFacetABI } from '@vaipakam/contracts/abis';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import { reportSendError } from './submissionQueue';
import type { PassTick } from './passSchedule';
import { boundedRead, deadlineClient, PastRunDeadline } from './batchRead';
import {
  checkHorizonEntries,
  countDueHorizonEntries,
  enqueueHorizonEntries,
  finishHorizonEntries,
  getHorizonCursor,
  listDueHorizonEntries,
  listOpsAlertKeys,
  listOverdueHorizonEntries,
  listPausedHorizonEntries,
  markHorizonTried,
  putHorizonCursor,
  recordHorizonTouches,
  type HorizonEntryRow,
  type PausedHorizonEntry,
} from './db';
import { resolveOpsAlert, sendOpsAlert } from './opsAlert';

const ABI = [
  ...(AdminFacetABI as Abi),
  ...(ConfigFacetABI as Abi),
  ...(InteractionRewardsLensFacetABI as Abi),
  ...(RewardHorizonSweepFacetABI as Abi),
] as Abi;

/** The heartbeat: every live entry is touched about this often. Twice a day,
 *  far inside the contract's maximum observation gap (seven days), so a run
 *  that fails costs nothing the next one cannot make up. */
export const HEARTBEAT_SEC = 12 * 3600;
/** This pass's cadence in seconds (passSchedule). */
export const PASS_CADENCE_SEC = 60 * 60;
/** An entry is due once this long has passed since the pass last finished
 *  with it: one cadence short of the heartbeat, so the hourly run that falls
 *  due first takes it rather than the one after. */
export const DUE_AFTER_SEC = HEARTBEAT_SEC - PASS_CADENCE_SEC;
/** Queued entries the pass has not finished with for this long are reported
 *  OVERDUE: two heartbeats is no longer a run that failed once, and it stays
 *  far inside the contract's seven-day maximum observation gap. */
export const OVERDUE_AFTER_SEC = 2 * HEARTBEAT_SEC;
/** Consecutive landed touches across which a clock did not advance before the
 *  pass says so (the issue's "two heartbeats"). */
export const PAUSED_ALERT_RUNS = 2;
/** How closely the removal estimate's forward move must match the time
 *  between its two reads for the clock to count as NOT advancing. An advancing
 *  clock holds the estimate still; a stalled one moves it by exactly the time
 *  between the reads (eleven hours or more), give or take the minutes between
 *  a read and its touch landing. */
export const ADVANCE_TOLERANCE_SEC = PASS_CADENCE_SEC;

/** Entries one discovery page reads (the lens clamps at 500). */
const DISCOVER_PAGE = 200n;
/** Discovery pages one run reads, so a long history is caught up over a few
 *  runs instead of one run reading it all. */
const DISCOVER_PAGES_PER_RUN = 5;
/** Due entries one run reads and may touch. With the hourly cadence this is
 *  the pass's capacity: about DUE_SLICE × 12 live entries per chain keep a
 *  12-hour heartbeat; beyond that the overdue alert says so. */
export const DUE_SLICE = 300;
/** Entries per read aggregate (two reads each). */
const READ_CHUNK = 50;
/** Entries per sweep transaction. */
export const SWEEP_BATCH = 10;
/** Sweep transactions one run may send per chain. Each waits for its receipt
 *  before the next, so this bounds the run's wall time as well as its gas. */
export const MAX_WRITES_PER_RUN = 30;
const RECEIPT_TIMEOUT_MS = 30_000;
/** What the run keeps for its alerts after the last send. */
export const PASS_ALERT_WINDOW_MS = 5 * 60_000;
/** Repeat an open alert at most this often. */
const ALERT_REPEAT_SEC = 6 * 3600;
/** A paused clock is usually the owner's state, not a fault: repeat daily. */
const PAUSED_REPEAT_SEC = 24 * 3600;
/** Entry ids an alert names before it says "and N more". */
const ALERT_NAMES = 10;

/** Reverts that refuse the WHOLE sweep on this chain, whatever the entries. */
const CHAIN_WIDE_REFUSALS = new Set(['EnforcedPause', 'InteractionEmissionsNotStarted', 'VPFITokenNotSet']);
/** Of those, the one that is an operator's deliberate act and needs no alert:
 *  no clock runs during a pause anyway (the sweep drops a paused interval). The
 *  run reads the pause state first; this catches a pause that begins between
 *  that read and a send. */
const PAUSED_REFUSAL = 'EnforcedPause';

/** `LibVaipakam.RewardEntry` as the lens returns it. */
export interface RewardEntryView {
  user: Address;
  loanId: bigint;
  startDay: number;
  endDay: number;
  side: number;
  processed: boolean;
  forfeited: boolean;
  closed: boolean;
  perDayNumeraire18: bigint;
  expiryBegun: boolean;
}

/** `getRewardEntryExpiry`: the clock's start and the removal estimate (0 = none). */
export interface EntryExpiry {
  firstClaimableAt: number;
  expiresAt: number;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** A zeroed struct: past the end of the allocated sequence. Pure. */
export function isUnallocated(e: RewardEntryView): boolean {
  return e.user.toLowerCase() === ZERO && e.endDay === 0 && e.perDayNumeraire18 === 0n;
}

/** Settled for good: claimed or expired (`processed`), or forfeited — the
 *  forfeit sweep owns a forfeited entry and the horizon never expires it. Pure. */
export function isSettled(e: RewardEntryView): boolean {
  return e.processed || e.forfeited;
}

/** Whether this heartbeat sends a touch for a live entry. While the horizon is
 *  dark (`0`) no clock runs and a touch does nothing, EXCEPT for an entry whose
 *  removal has begun: its settlement must still be finished, and the sweep
 *  finishes it whatever the knob says. Pure. */
export function isTouchable(e: RewardEntryView, horizonDays: number): boolean {
  return !isSettled(e) && (horizonDays > 0 || e.expiryBegun);
}

/**
 * The pause count an entry carries after a touch that LANDED. Pure.
 *
 * `getRewardEntryExpiry` is "now + remaining executable time", and while the
 * entry is executable it folds in the interval a sweep-now would credit, so an
 * advancing clock holds the estimate still. A clock that did not advance over
 * an interval — the entry was not claim-executable (its owner could not have
 * claimed: a funding shortfall, the pool cap, a sanctions bar, a pause), or the
 * interval was not credited for some other reason — moves it forward by that
 * interval. So comparing the estimate read before this touch with the one read
 * before the previous landed touch says whether the clock advanced between
 * them. Nothing here judges WHY: the alert names both readings.
 *
 * Comparable only when both reads carry a countdown and the clock had started
 * at the earlier one; otherwise the count restarts at 0.
 */
export function pausedRunsAfter(
  row: Pick<HorizonEntryRow, 'touchedAt' | 'expiresAt' | 'pausedRuns'>,
  now: EntryExpiry,
  nowSec: number,
): number {
  if (row.touchedAt === 0 || row.expiresAt === 0 || now.firstClaimableAt === 0 || now.expiresAt === 0) return 0;
  // A stalled clock moves the estimate by the time between the reads, not by
  // some other amount: a horizon RETUNE re-baselines the notice and moves it by
  // whole days (or back), and must not read as a pause (Codex #2596 r1).
  const between = nowSec - row.touchedAt;
  const moved = now.expiresAt - row.expiresAt;
  const stalled = between > ADVANCE_TOLERANCE_SEC && Math.abs(moved - between) <= ADVANCE_TOLERANCE_SEC;
  return stalled ? row.pausedRuns + 1 : 0;
}

/** What one run does with the due entries it read. Pure. */
export interface HeartbeatPlan {
  /** Settled on chain: leave the queue. */
  settled: number[];
  /** Live, but nothing to send this heartbeat (the horizon is dark). */
  idle: number[];
  /** To touch, in order, with what to record when the touch lands. */
  touch: { entryId: number; expiresAt: number; pausedRuns: number }[];
  /** Not read this run: kept due, read next run. */
  unread: number[];
}

export function planHeartbeat(
  rows: readonly HorizonEntryRow[],
  reads: ReadonlyMap<number, { entry: RewardEntryView; expiry: EntryExpiry } | null>,
  horizonDays: number,
  nowSec: number,
): HeartbeatPlan {
  const plan: HeartbeatPlan = { settled: [], idle: [], touch: [], unread: [] };
  for (const row of rows) {
    const r = reads.get(row.entryId);
    if (!r) {
      plan.unread.push(row.entryId);
      continue;
    }
    if (isSettled(r.entry)) plan.settled.push(row.entryId);
    else if (!isTouchable(r.entry, horizonDays)) plan.idle.push(row.entryId);
    else plan.touch.push({ entryId: row.entryId, expiresAt: r.expiry.expiresAt, pausedRuns: pausedRunsAfter(row, r.expiry, nowSec) });
  }
  return plan;
}

export async function runRewardHorizonHeartbeat(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardHorizonHeartbeat', 'REWARD_HORIZON_HEARTBEAT_ENABLED')) return;
  const sendDeadline = tick.deadlineMs - PASS_ALERT_WINDOW_MS;
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane,
  // so one chain's receipt waits never spend another chain's window.
  await Promise.all(
    getChainConfigs(env)
      .filter((c) => c.diamond)
      .map(async (chain) => {
        try {
          await heartbeatChain(env, chain, sendDeadline, tick.deadlineMs);
        } catch (err) {
          console.error(`[keeper] rewardHorizonHeartbeat chain=${chain.id} failed: ${shortErr(err)}`);
        }
      }),
  );
}

async function heartbeatChain(env: Env, chain: ChainConfig, sendDeadline: number, runDeadline: number): Promise<void> {
  const plainClient = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
  // Every read and simulation is refused past the send window (`deadlineClient`);
  // the batched entry reads carry the deadline themselves.
  const client = deadlineClient(plainClient, sendDeadline);
  await heartbeatOnce(env, chain.id, chain.diamond as Address, {
    client,
    readClient: plainClient,
    context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
    sendDeadline,
    runDeadline,
  });
}

/** What one chain's run reads and signs with. Injected so the whole run is
 *  testable against a fake chain. */
export interface HeartbeatDeps {
  /** Deadline-bound client: single reads and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  /** The signing context, built only when there is something to send. */
  context: () => KeeperContext | null;
  sendDeadline: number;
  runDeadline: number;
}

/** One chain's run. Exported for tests. */
export async function heartbeatOnce(env: Env, chainId: number, diamond: Address, deps: HeartbeatDeps): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const { client } = deps;
  const where = `chain=${chainId}`;

  const horizonDays = Number(
    (await client.readContract({ address: diamond, abi: ABI, functionName: 'getRewardClaimHorizonDays' })) as number,
  );
  const pausedAtStart = Boolean(await client.readContract({ address: diamond, abi: ABI, functionName: 'paused' }));

  const discovery = await discover(env, chainId, client, diamond, nowSec);

  const dueBefore = nowSec - DUE_AFTER_SEC;
  const rows = await listDueHorizonEntries(env.KEEPER_DB, chainId, diamond, dueBefore, DUE_SLICE);
  const dueTotal = rows.length < DUE_SLICE ? rows.length : await countDueHorizonEntries(env.KEEPER_DB, chainId, diamond, dueBefore);
  const reads = await readEntries(deps.readClient, diamond, rows.map((r) => r.entryId), deps.sendDeadline, chainId);
  const plan = planHeartbeat(rows, reads, horizonDays, nowSec);

  await markHorizonTried(env.KEEPER_DB, chainId, diamond, rows.map((r) => r.entryId), nowSec);
  await finishHorizonEntries(env.KEEPER_DB, chainId, diamond, plan.settled);
  await checkHorizonEntries(env.KEEPER_DB, chainId, diamond, plan.idle, nowSec);

  const ctx = plan.touch.length > 0 && !pausedAtStart ? deps.context() : null;
  if (plan.touch.length > 0 && !pausedAtStart && !ctx) {
    console.log(`[keeper] rewardHorizonHeartbeat ${where}: no signing key — ${plan.touch.length} due touch(es) not sent`);
  }
  const outcome: TouchOutcome = ctx
    ? await touchAll(ctx, plan.touch.map((t) => t.entryId))
    : { landed: new Set(), reverted: new Map(), refused: null, attempted: false };
  const protocolPaused = pausedAtStart || outcome.refused === PAUSED_REFUSAL;
  const landedTouches = plan.touch.filter((t) => outcome.landed.has(t.entryId));
  await recordHorizonTouches(env.KEEPER_DB, chainId, diamond, landedTouches, Math.floor(Date.now() / 1000));

  console.log(
    `[keeper] rewardHorizonHeartbeat ${where} horizonDays=${horizonDays} discovered=${discovery.queued} ` +
      `discovery=${discovery.caughtUp ? 'caught-up' : `behind (next id ${discovery.next})`} due=${dueTotal} read=${rows.length - plan.unread.length}/${rows.length} ` +
      `settled=${plan.settled.length} idle=${plan.idle.length} touch=${plan.touch.length} landed=${outcome.landed.size} reverted=${outcome.reverted.size}` +
      (outcome.refused ? ` refused=${outcome.refused}` : '') +
      (pausedAtStart ? ' (protocol paused: nothing sent)' : '') +
      (horizonDays === 0 ? ' (horizon dark: only entries whose removal has begun are touched)' : ''),
  );

  await raiseHeartbeatAlerts(env, chainId, diamond, {
    horizonDays,
    reverted: outcome.reverted,
    clearedIds: new Set([...outcome.landed, ...plan.settled]),
    protocolPaused,
    refused: outcome.attempted ? outcome.refused : 'unmeasured',
    nowSec,
    deadline: deps.runDeadline,
  });
}

/** What one discovery did: how many entries it queued, the next id it will
 *  read, and whether it reached the end of the allocated sequence. */
export interface Discovery {
  queued: number;
  next: number;
  caughtUp: boolean;
}

/** Queue the entries allocated since the cursor. `caughtUp` is true only when
 *  a read showed the end of the sequence — not when the run's page budget ran
 *  out or a read failed — so a long history still being caught up is never
 *  mistaken for a complete queue (Codex #2596 r2). */
async function discover(env: Env, chainId: number, client: PublicClient, diamond: Address, nowSec: number): Promise<Discovery> {
  let next = BigInt(await getHorizonCursor(env.KEEPER_DB, chainId, diamond));
  let queued = 0;
  let caughtUp = false;
  for (let p = 0; p < DISCOVER_PAGES_PER_RUN; p++) {
    let page: readonly RewardEntryView[];
    try {
      // eslint-disable-next-line no-await-in-loop
      page = (await client.readContract({
        address: diamond,
        abi: ABI,
        functionName: 'getRewardEntriesRange',
        args: [next, DISCOVER_PAGE],
      })) as readonly RewardEntryView[];
    } catch (err) {
      if (!(err instanceof PastRunDeadline)) console.error(`[keeper] rewardHorizonHeartbeat chain=${chainId} discovery read failed at id ${next}: ${shortErr(err)}`);
      break;
    }
    const live: number[] = [];
    let consumed = 0;
    let end = false;
    for (let i = 0; i < page.length; i++) {
      if (isUnallocated(page[i])) {
        end = true;
        break;
      }
      consumed = i + 1;
      if (!isSettled(page[i])) live.push(Number(next) + i);
    }
    // Queue first, cursor second: a failure between them re-reads the page.
    // eslint-disable-next-line no-await-in-loop
    await enqueueHorizonEntries(env.KEEPER_DB, chainId, diamond, live, nowSec);
    next += BigInt(consumed);
    // eslint-disable-next-line no-await-in-loop
    await putHorizonCursor(env.KEEPER_DB, chainId, diamond, Number(next));
    queued += live.length;
    if (end || consumed === 0) {
      caughtUp = true;
      break;
    }
  }
  return { queued, next: Number(next), caughtUp };
}

/** The entry and its removal estimate for each id, or null where either read failed. */
async function readEntries(
  client: PublicClient,
  diamond: Address,
  ids: readonly number[],
  deadline: number,
  chainId: number,
): Promise<Map<number, { entry: RewardEntryView; expiry: EntryExpiry } | null>> {
  const out = new Map<number, { entry: RewardEntryView; expiry: EntryExpiry } | null>();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const part = ids.slice(i, i + READ_CHUNK);
    const contracts = part.flatMap((id) => [
      { address: diamond, abi: ABI, functionName: 'getRewardEntriesRange', args: [BigInt(id), 1n] },
      { address: diamond, abi: ABI, functionName: 'getRewardEntryExpiry', args: [BigInt(id)] },
    ]);
    // eslint-disable-next-line no-await-in-loop
    const res = await boundedRead(client as never, contracts, `rewardHorizonHeartbeat chain=${chainId} entries`, deadline);
    part.forEach((id, k) => {
      const e = res[2 * k];
      const x = res[2 * k + 1];
      if (e?.status !== 'success' || x?.status !== 'success') {
        out.set(id, null);
        return;
      }
      const entry = (e.result as readonly RewardEntryView[])[0];
      const [firstClaimableAt, expiresAt] = x.result as readonly [bigint, bigint];
      out.set(id, entry ? { entry, expiry: { firstClaimableAt: Number(firstClaimableAt), expiresAt: Number(expiresAt) } } : null);
    });
  }
  return out;
}

/** What the touches did. `refused` names a chain-wide refusal that stopped
 *  them; `attempted` is false when no simulation ran to a result. */
interface TouchOutcome {
  landed: Set<number>;
  reverted: Map<number, string>;
  refused: string | null;
  attempted: boolean;
}

/** Sweep `ids` in batches of {@link SWEEP_BATCH}. Every transaction carries
 *  exactly the group just simulated on the current state (after the previous
 *  send landed): a group that would revert is halved and each half simulated
 *  again, so a constraint only the COMBINATION breaks — a pool limit on the
 *  batch's total, say — splits the group instead of resending it (Codex #2596
 *  r1), and one bad entry is left on its own with its reason. */
async function touchAll(ctx: KeeperContext, ids: readonly number[]): Promise<TouchOutcome> {
  const out: TouchOutcome = { landed: new Set(), reverted: new Map(), refused: null, attempted: false };
  let writes = MAX_WRITES_PER_RUN;
  const pending: number[][] = [];
  for (let i = 0; i < ids.length; i += SWEEP_BATCH) pending.push(ids.slice(i, i + SWEEP_BATCH));
  while (pending.length > 0 && writes > 0) {
    if (Date.now() >= ctx.notAfterMs) break;
    const group = pending.shift()!;
    // eslint-disable-next-line no-await-in-loop
    const sim = await simulate(ctx, group);
    // A simulation the deadline refused observed nothing: only one that ran
    // makes the run's refusal state a measurement (Codex #2596 r2).
    if (sim === 'deadline') break;
    out.attempted = true;
    if (sim !== 'ok') {
      if (CHAIN_WIDE_REFUSALS.has(sim)) {
        out.refused = sim;
        break;
      }
      if (group.length === 1) out.reverted.set(group[0], sim);
      else {
        const mid = Math.ceil(group.length / 2);
        pending.unshift(group.slice(0, mid), group.slice(mid));
      }
      continue;
    }
    writes -= 1;
    // eslint-disable-next-line no-await-in-loop
    const sent = await send(ctx, group);
    if (sent.kind === 'landed') group.forEach((id) => out.landed.add(id));
    else if (sent.kind === 'reverted') group.forEach((id) => out.reverted.set(id, sent.reason));
    else if (sent.kind === 'stop') break;
  }
  return out;
}

/** 'ok', 'deadline', or the reason the sweep would revert (the decoded error
 *  name where the ABI has it). */
async function simulate(ctx: KeeperContext, ids: readonly number[]): Promise<string> {
  try {
    await ctx.client.simulateContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: 'sweepExpiredInteractionRewards',
      args: [ids.map((id) => BigInt(id))],
      account: ctx.wallet.account!,
    });
    return 'ok';
  } catch (err) {
    if (err instanceof PastRunDeadline) return 'deadline';
    return revertName(err) ?? shortErr(err);
  }
}

/** A send's outcome: landed, reverted on chain (with why), or `stop` — not
 *  sent, or sent with no receipt in time; either way this run sends no more. */
type SendResult = { kind: 'landed' } | { kind: 'reverted'; reason: string } | { kind: 'stop' };

async function send(ctx: KeeperContext, ids: readonly number[]): Promise<SendResult> {
  const label = `[keeper] rewardHorizonHeartbeat chain=${ctx.chainId} entries=${ids.join(',')}`;
  let hash: Hex;
  try {
    hash = (await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: 'sweepExpiredInteractionRewards',
      args: [ids.map((id) => BigInt(id))],
      chain: undefined,
      account: ctx.wallet.account ?? null,
    } as never)) as Hex;
  } catch (err) {
    // A deadline refusal is a deferral (nothing was sent); anything else is a
    // failed send. Either way the run sends no more: the next run re-reads.
    reportSendError(label, err, `send failed: ${shortErr(err)}`);
    return { kind: 'stop' };
  }
  console.log(`${label} tx=${hash}`);
  try {
    // Wait for inclusion before the next send: every pass signs from one key.
    const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== 'success') {
      console.error(`${label} reverted on chain: tx=${hash}`);
      return { kind: 'reverted', reason: `reverted on chain (tx ${hash})` };
    }
    return { kind: 'landed' };
  } catch (err) {
    console.error(`${label} receipt not seen in time: ${shortErr(err)}`);
    return { kind: 'stop' };
  }
}

/** What a run measured, for its alerts. */
export interface HeartbeatAlertInput {
  horizonDays: number;
  /** Entries whose touch reverted this run, with why. */
  reverted: ReadonlyMap<number, string>;
  /** Entries whose earlier revert alert this run disproves (landed or settled). */
  clearedIds: ReadonlySet<number>;
  /** The protocol is paused: no queue-wide report (refused, overdue, paused
   *  clock) is raised or cleared this run. */
  protocolPaused: boolean;
  /** A chain-wide refusal; null when the sends ran; 'unmeasured' when none was tried. */
  refused: string | null | 'unmeasured';
  nowSec: number;
  /** Alerts past this are neither sent nor recorded; the next run raises them. */
  deadline: number;
}

/** Raise or clear the pass's ops alerts for one chain. Exported for tests. */
export async function raiseHeartbeatAlerts(env: Env, chainId: number, diamond: string, m: HeartbeatAlertInput): Promise<void> {
  const prefix = `horizon-revert:${chainId}:`;
  let open: Set<string>;
  try {
    open = new Set(await listOpsAlertKeys(env.KEEPER_DB, 'horizon-', chainId));
  } catch (err) {
    console.error(`[keeper] rewardHorizonHeartbeat chain=${chainId}: open alerts unread, alerts left for the next run: ${shortErr(err)}`);
    return;
  }
  const toggle = async (key: string, on: boolean, text: () => string, repeat = ALERT_REPEAT_SEC): Promise<void> => {
    if (Date.now() >= m.deadline) return;
    if (on) await sendOpsAlert(env, key, text(), repeat, m.nowSec, chainId);
    else if (open.has(key)) await resolveOpsAlert(env, key);
  };
  const tag = `[chain ${chainId}] reward horizon heartbeat`;

  for (const [id, why] of m.reverted) {
    // eslint-disable-next-line no-await-in-loop
    await toggle(`${prefix}${id}`, true, () =>
      `${tag}: the touch of reward entry ${id} reverts (${why}). Its horizon clock gets no observation while this stands; an interval longer than the contract's maximum observation gap is then not counted, so the entry cannot expire early — but it is not being measured either.`,
    );
  }
  for (const key of open) {
    if (!key.startsWith(prefix)) continue;
    const id = Number(key.slice(prefix.length));
    // eslint-disable-next-line no-await-in-loop
    if (m.clearedIds.has(id)) await toggle(key, false, () => '');
  }

  // A deliberate pause stops every touch and every clock, so nothing below is
  // measured while it stands: each report keeps the state it had (Codex #2596 r1, r2).
  if (m.protocolPaused) return;

  if (m.refused !== 'unmeasured') {
    const refused = m.refused;
    await toggle(`horizon-refused:${chainId}:all`, refused !== null, () =>
      `${tag}: every touch on this chain is refused (${refused}). No horizon clock is observed while it stands.`,
    );
  }

  // The overdue report reads the queue as the run left it, so it covers every
  // queued entry — those this run never reached as well as those it touched.
  {
    let overdue: { ids: number[]; total: number; queued: number };
    try {
      overdue = await listOverdueHorizonEntries(env.KEEPER_DB, chainId, diamond, m.nowSec - OVERDUE_AFTER_SEC, ALERT_NAMES);
    } catch (err) {
      console.error(`[keeper] rewardHorizonHeartbeat chain=${chainId}: overdue count unread: ${shortErr(err)}`);
      return;
    }
    await toggle(`horizon-overdue:${chainId}:all`, overdue.total > 0, () =>
      `${tag}: ${overdue.total} of ${overdue.queued} queued reward entr${overdue.queued === 1 ? 'y' : 'ies'} ha${overdue.total === 1 ? 's' : 've'} not been reached for more than ${OVERDUE_AFTER_SEC / 3600}h (${names(overdue.ids, overdue.total)}): no landed touch, and no read showing nothing to send. ` +
        `Either their touches are not landing (check this chain's sends and gas, and any revert alert), or there are more live entries than the pass reaches: it handles at most ${DUE_SLICE} an hour, about ${DUE_SLICE * (HEARTBEAT_SEC / 3600)} per ${HEARTBEAT_SEC / 3600}h heartbeat. ` +
        `An interval between two touches longer than the contract's maximum observation gap (seven days) is not counted toward expiry — the safe direction, but those clocks stop being measured.`,
    );
  }

  // The clock-pause report reads the queue as the run left it, so it covers
  // every entry, not only those this run touched.
  const pausedKey = `horizon-paused:${chainId}:all`;
  if (m.horizonDays === 0) {
    await toggle(pausedKey, false, () => '');
    return;
  }
  let paused: { entries: PausedHorizonEntry[]; total: number };
  try {
    paused = await listPausedHorizonEntries(env.KEEPER_DB, chainId, diamond, PAUSED_ALERT_RUNS, ALERT_NAMES);
  } catch (err) {
    console.error(`[keeper] rewardHorizonHeartbeat chain=${chainId}: paused-clock count unread: ${shortErr(err)}`);
    return;
  }
  await toggle(
    pausedKey,
    paused.total > 0,
    () =>
      `${tag}: the horizon clock of ${paused.total} reward entr${paused.total === 1 ? 'y' : 'ies'} did not advance across the last ${PAUSED_ALERT_RUNS} or more landed touches (${names(paused.entries.map((e) => e.entryId), paused.total)}). ` +
      `The last comparison, per entry: ${paused.entries.map(describeComparison).join('; ')}. ` +
      `A clock advances only while its owner could actually claim; it pauses while the reward pool, the recycle bucket or the chain's delivered funding cannot pay the claim, while the owner is barred by the sanctions screen, or while the protocol is paused. ` +
      `Nothing expires while a clock is paused. If none of those holds, the touches are landing without being credited, which is a fault.`,
    PAUSED_REPEAT_SEC,
  );
}

/** One paused clock's last comparison, in the alert's words: the removal
 *  estimate read before each of two landed touches, and how far it moved
 *  against the time between them. Pure. */
export function describeComparison(e: PausedHorizonEntry): string {
  const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
  const hours = (sec: number) => `${(sec / 3600).toFixed(1)}h`;
  return (
    `id ${e.entryId}: removal estimate ${iso(e.prevExpiresAt)} at the touch of ${iso(e.prevTouchedAt)}, ` +
    `${iso(e.expiresAt)} at the touch of ${iso(e.touchedAt)} (moved ${hours(e.expiresAt - e.prevExpiresAt)} over ${hours(e.touchedAt - e.prevTouchedAt)})`
  );
}

/** "ids 1, 2, 3" or "ids 1, 2, … and 40 more". */
function names(ids: readonly number[], total = ids.length): string {
  const shown = ids.slice(0, ALERT_NAMES);
  const more = total - shown.length;
  return `id${total === 1 ? '' : 's'} ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

/** The decoded custom error a simulation reverted with, when the ABI names it. */
function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

/** viem's one-line summary when there is one; otherwise a bounded description
 *  that never carries the raw message — a transport error's message includes
 *  the request URL, and the RPC URLs carry API keys. */
function shortErr(err: unknown): string {
  const short = (err as { shortMessage?: unknown } | null)?.shortMessage;
  return (typeof short === 'string' && short.length > 0 ? short : describeFailure(err)).slice(0, 200);
}
