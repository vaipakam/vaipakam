// apps/keeper/src/vaultBeaconUpkeep.ts
//
// #3282 — the VAULT BEACON UPKEEP pass: the keeper's backstop for the four
// permissionless steps of the #3204 VaultBeacon that apply a change once its
// delay has passed. Each step only applies what its owner already decided and
// waited out; none of them moves value.
//
//   1. PROPOSAL (`executeCurrentVersion` / `executeRevoke`). The Timelock
//      proposes a new current vault version or a revoke; the beacon holds it
//      in `pendingProposal` for MIN_CODE_DELAY, during which the Timelock or
//      the Pauser Safe may cancel it. Once `executableAt` has passed, anyone
//      applies it.
//   2. PIN (`executePin(vault)`). A vault owner's signed pin or unpin waits
//      that vault's pin delay in `pendingPinOf(vault)`. Once due, anyone
//      applies it. A target revoked while it waited lapses instead (the
//      beacon emits `VaultPinCancelled` with itself as the canceller).
//   3. PIN DELAY (`executePinDelay(vault)`). A signed lowering of a vault's
//      pin delay waits the current delay in `pendingPinDelayOf(vault)`, then
//      anyone applies it.
//
// Which vaults to look at: the beacon keeps no list of vaults with a pending
// change, so they are found from its own events. Each run reads the beacon's
// `VaultPinRequested` and `VaultPinDelayLowerRequested` logs from where the
// last run stopped up to the chain's FINALIZED block, a bounded number of
// ranges per run, and queues each vault they name in the keeper's open-work
// queue (kind `beacon_pin`, keyed by the active Diamond). Queue first, cursor
// second, so a failure between the two reads the range again and re-queuing
// is a no-op. The beacon's own logs are read directly rather than through the
// indexer's ledger, which records only the Diamond's events.
//
// A queued vault is only a nomination: every decision is an on-chain read. A
// vault is retired from the queue only when NOTHING is pending for it at the
// head AND at the finalized block, so a change that a reorg brings back is
// never dropped. A due change is simulated on the current state and sent only
// when the simulation succeeds; nothing is sent before its `executableAt`.
//
// Per chain, per run (hourly, at :26): the beacon's address from the Diamond
// (`getVaultBeacon`), discovery, then the proposal, then up to the step's
// share of due pins and of due delay lowerings, oldest-checked first.
//
// Gated by KEEPER_ENABLED + VAULT_BEACON_UPKEEP_ENABLED. Ships disarmed.

import { createPublicClient, decodeEventLog, http, parseAbiItem, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { VaultBeaconABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import type { ChainConfig, Env, KeeperD1 } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline, settledGroupedRead } from './batchRead';
import { boundedCall } from './passReader';
import { shortErr } from './callErrors';
import { deploymentFloor, enqueueWork, finishWork, getWorkCursor, listOpenWorkPage, putWorkCursor, touchOpenWork, type WorkItem } from './db';
import { priorStageCutoffMs, readCutoffMs, runIndex } from './runWindow';
import { StepSender } from './stepSender';

export const ABI = [...(VaultBeaconABI as Abi), ...(VaultFactoryFacetABI as Abi)] as Abi;

/** The pass's cadence, in seconds. A pin delay or a code delay is measured in
 *  hours or days, and each change only applies what its owner already
 *  decided, so an hour past maturity is not material. */
export const PASS_CADENCE_SEC = 60 * 60;

export const STEPS = ['proposal', 'pin', 'delay'] as const;
export type Step = (typeof STEPS)[number];
/** Sends per step per chain per run. The beacon holds at most one proposal. */
export const ATTEMPTS_PER_STEP: Readonly<Record<Step, number>> = { proposal: 1, pin: 4, delay: 4 };
export const MAX_SENDS_PER_RUN = STEPS.reduce((n, s) => n + ATTEMPTS_PER_STEP[s], 0);
export const RECEIPT_TIMEOUT_MS = 30_000;

/** Blocks one log read covers (the indexer's own range, which public RPCs accept). */
export const LOG_RANGE = 5_000n;
/** Log reads per chain per run: enough to keep up with a 0.25 s chain hourly
 *  and to catch up a backlog over a few runs. */
export const LOG_RANGES_PER_RUN = 20;
/** Queued vaults checked per chain per run, least recently checked first. */
export const VAULTS_PER_RUN = 200;
const READ_CHUNK = 100;

export const WORK_KIND = 'beacon_pin' as const;

/** The two events that name a vault with a change to wait out. */
export const REQUEST_EVENTS = [
  parseAbiItem('event VaultPinRequested(address indexed vault, uint256 indexed target, uint256 executableAt)'),
  parseAbiItem('event VaultPinDelayLowerRequested(address indexed vault, uint256 newDelay, uint256 executableAt)'),
] as const;

/** `VaultBeacon.ProposalKind`. */
const PROPOSAL_CURRENT = 1;
const PROPOSAL_REVOKE = 2;

/** Refusals that mean another caller got there first, or the change was
 *  cancelled: skipped, not refused. */
export const RACES: ReadonlySet<string> = new Set(['NoPinChange', 'NoDelayChange', 'NoProposal']);
/** The contract's "not yet": the read was at an earlier block. */
export const NOT_YET = 'TooEarly';
/** The beacon has no pause; this name never matches a beacon refusal. */
const PAUSED_REFUSAL = 'EnforcedPause';

/** The pass's open-work queue on one chain and Diamond. Injected so a run is testable. */
export interface BeaconQueue {
  /** The first block not yet read for requests (0 when none is recorded). */
  cursor(): Promise<number>;
  setCursor(next: number): Promise<void>;
  enqueue(items: readonly WorkItem<Record<string, never>>[]): Promise<void>;
  open(limit: number): Promise<string[]>;
  touch(items: readonly string[]): Promise<void>;
  finish(items: readonly string[]): Promise<void>;
}

export function d1BeaconQueue(db: KeeperD1, chainId: number, diamond: string): BeaconQueue {
  return {
    cursor: () => getWorkCursor(db, chainId, diamond, WORK_KIND),
    setCursor: (next) => putWorkCursor(db, chainId, diamond, WORK_KIND, next),
    enqueue: (items) => enqueueWork(db, chainId, diamond, WORK_KIND, items),
    open: async (limit) => (await listOpenWorkPage<Record<string, never>>(db, chainId, diamond, WORK_KIND, limit)).items.map((i) => i.item),
    touch: (items) => touchOpenWork(db, chainId, diamond, WORK_KIND, items),
    finish: (items) => finishWork(db, chainId, diamond, WORK_KIND, items),
  };
}

/** What one chain's run reads and signs with. */
export interface BeaconDeps {
  /** Deadline-bound client: single reads, logs and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  visit: number;
  queue: BeaconQueue;
  /** The block discovery starts from when no cursor is recorded (the Diamond's deploy block). */
  floor: number;
}

export interface StepReport {
  due: number;
  applied: string[];
  landedUnread: string[];
  gone: string[];
  notYet: string[];
  deferred: number;
}

export interface BeaconReport {
  chainId: number;
  skipped?: string;
  beacon: Address | null;
  /** Discovery: blocks read this run (inclusive), vaults queued, and whether it reached the finalized block. */
  discovery: { from: number; to: number; queued: number; caughtUp: boolean } | null;
  /** Queued vaults checked this run, and how many were retired (nothing pending). */
  checked: number;
  retired: number;
  /** The proposal the beacon holds, as the line names it, or null with none. */
  proposal: string | null;
  steps: Record<Step, StepReport>;
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

const emptyStep = (): StepReport => ({ due: 0, applied: [], landedUnread: [], gone: [], notYet: [], deferred: 0 });

export async function runVaultBeaconUpkeep(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'vaultBeaconUpkeep', 'VAULT_BEACON_UPKEEP_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const visit = runIndex(tick, PASS_CADENCE_SEC * 1000);
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const diamond = chain.diamond as Address;
        const report = await beaconUpkeepOnce(chain.id, diamond, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          sendDeadline,
          visit,
          queue: d1BeaconQueue(env.KEEPER_DB, chain.id, diamond),
          floor: deploymentFloor(chain.id),
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] vaultBeaconUpkeep chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

/** The run's one line for a chain. */
export function describeReport(r: BeaconReport): string {
  if (r.skipped) return `[keeper] vaultBeaconUpkeep chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const step = (name: Step): string => {
    const s = r.steps[name];
    const parts = [
      `due=${s.due}`,
      `applied=${s.applied.join(',') || 'none'}`,
      ...(s.landedUnread.length > 0 ? [`landed-event-unread=${s.landedUnread.join(',')}`] : []),
      ...(s.gone.length > 0 ? [`already-gone=${s.gone.join(',')}`] : []),
      ...(s.notYet.length > 0 ? [`not-yet=${s.notYet.join(',')}`] : []),
      ...(s.deferred > 0 ? [`deferred=${s.deferred} (taken on later runs)`] : []),
    ];
    return `${name}[${parts.join(' ')}]`;
  };
  const d = r.discovery;
  return [
    `[keeper] vaultBeaconUpkeep chain=${r.chainId}`,
    ...(r.beacon ? [`beacon=${r.beacon}`] : []),
    ...(d ? [`requests=blocks ${d.from}..${d.to} queued ${d.queued}${d.caughtUp ? '' : ' (more next run)'}`] : []),
    `vaults=${r.checked} checked, ${r.retired} retired`,
    `proposal=${r.proposal ?? 'none'}`,
    ...STEPS.map(step),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ].join(' ');
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** One chain's run. Exported for tests. */
export async function beaconUpkeepOnce(chainId: number, diamond: Address, deps: BeaconDeps): Promise<BeaconReport> {
  const report: BeaconReport = {
    chainId,
    beacon: null,
    discovery: null,
    checked: 0,
    retired: 0,
    proposal: null,
    steps: { proposal: emptyStep(), pin: emptyStep(), delay: emptyStep() },
    refused: new Map(),
    unread: new Map(),
    stopped: null,
  };
  const readCutoff = readCutoffMs(deps.sendDeadline);
  const discoveryCutoff = priorStageCutoffMs(readCutoff);
  const call = <T>(cutoff: number, what: string, work: () => Promise<T>) => boundedCall(cutoff, what, work);

  let beacon: Address;
  try {
    const served = await call(discoveryCutoff, 'the chain id', () => deps.client.getChainId());
    if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };
    beacon = (await call(discoveryCutoff, "the Diamond's vault beacon", () =>
      deps.client.readContract({ address: diamond, abi: ABI, functionName: 'getVaultBeacon' }),
    )) as Address;
  } catch (err) {
    if (err instanceof PastRunDeadline) return { ...report, skipped: 'the run deadline passed during its first reads' };
    return { ...report, skipped: `the chain id or the vault beacon could not be read (${shortErr(err)})` };
  }
  if (beacon.toLowerCase() === ZERO) return { ...report, skipped: 'the Diamond has no vault beacon set' };
  report.beacon = beacon;

  const sender = new StepSender(
    {
      pass: 'vaultBeaconUpkeep',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      stepBudgets: ATTEMPTS_PER_STEP,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: RACES,
      pausedRefusal: PAUSED_REFUSAL,
      unrecorded: new Set([NOT_YET]),
      describe: (s) => String(s),
      spends: 'the gas',
      target: beacon,
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  report.refused = sender.refused;
  report.unread = sender.unread;

  // 1. Discovery, up to the finalized block.
  try {
    report.discovery = await discover(beacon, deps, discoveryCutoff);
  } catch (err) {
    sender.noteUnread('requests', err instanceof PastRunDeadline ? 'the run deadline passed during the request logs' : `the request logs (${shortErr(err)})`);
  }

  // 2. The state, at the head (what is due) and at the finalized block (what may be retired).
  let now: bigint;
  let head: bigint;
  let finalized: bigint | null;
  try {
    const b = await call(readCutoff, 'the head block', () => deps.client.getBlock({ blockTag: 'latest' }));
    now = b.timestamp;
    head = b.number as bigint;
    finalized = await call(readCutoff, 'the finalized block', () => deps.client.getBlock({ blockTag: 'finalized' })).then(
      (f) => f.number as bigint,
      (err: unknown) => {
        if (err instanceof PastRunDeadline) throw err;
        return null;
      },
    );
  } catch (err) {
    sender.noteUnread('state', err instanceof PastRunDeadline ? 'the run deadline passed before the state reads' : `the head block (${shortErr(err)})`);
    return report;
  }

  const due: Record<Step, string[]> = { proposal: [], pin: [], delay: [] };
  let proposalFn: string | null = null;
  try {
    const p = (await call(readCutoff, 'the pending proposal', () =>
      deps.client.readContract({ address: beacon, abi: ABI, functionName: 'pendingProposal', blockNumber: head }),
    )) as readonly [number | bigint, bigint, bigint, bigint];
    const judged = proposalDue(p, now);
    report.proposal = judged.label;
    if (judged.due) {
      due.proposal.push(judged.label!);
      proposalFn = judged.functionName;
    }
  } catch (err) {
    if (err instanceof PastRunDeadline) sender.noteUnread('proposal', 'the run deadline passed before the proposal read');
    else sender.noteUnread('proposal', `the pending proposal (${shortErr(err)})`);
  }

  try {
    const vaults = await deps.queue.open(VAULTS_PER_RUN);
    report.checked = vaults.length;
    if (vaults.length > 0) {
      const pendingCalls = (v: string) => [
        { address: beacon, abi: ABI, functionName: 'pendingPinOf', args: [v] },
        { address: beacon, abi: ABI, functionName: 'pendingPinDelayOf', args: [v] },
      ];
      const atHead = await settledGroupedRead(deps.readClient, vaults, READ_CHUNK, pendingCalls, 'vaultBeaconUpkeep pending', readCutoff, deps.visit, head);
      const idle: string[] = [];
      const retired = new Set<string>();
      let unread = 0;
      for (const v of vaults) {
        const [pin, delay] = atHead.get(v) ?? [];
        if (pin?.status !== 'success' || delay?.status !== 'success') {
          unread += 1;
          continue;
        }
        const pinAt = BigInt((pin.result as readonly [bigint, bigint])[1]);
        const delayAt = BigInt((delay.result as readonly [bigint, bigint])[1]);
        if (pinAt === 0n && delayAt === 0n) idle.push(v);
        if (pinAt !== 0n && now >= pinAt) due.pin.push(v);
        if (delayAt !== 0n && now >= delayAt) due.delay.push(v);
      }
      if (unread > 0) sender.noteUnread('vaults', `the pending changes of ${unread} queued vault(s)`);
      // Retired only when the finalized block also shows nothing pending.
      if (idle.length > 0 && finalized !== null) {
        const atFinal = await settledGroupedRead(deps.readClient, idle, READ_CHUNK, pendingCalls, 'vaultBeaconUpkeep finalized', readCutoff, deps.visit, finalized);
        const retire = idle.filter((v) => {
          const [pin, delay] = atFinal.get(v) ?? [];
          return (
            pin?.status === 'success' &&
            delay?.status === 'success' &&
            BigInt((pin.result as readonly [bigint, bigint])[1]) === 0n &&
            BigInt((delay.result as readonly [bigint, bigint])[1]) === 0n
          );
        });
        await deps.queue.finish(retire);
        report.retired = retire.length;
        for (const v of retire) retired.add(v);
      }
      await deps.queue.touch(vaults.filter((v) => !retired.has(v)));
    }
  } catch (err) {
    sender.noteUnread('vaults', err instanceof PastRunDeadline ? 'the run deadline passed during the vault reads' : `the queued vaults (${shortErr(err)})`);
  }

  // 3. The contract decides.
  for (const step of STEPS) {
    const s = report.steps[step];
    s.due = due[step].length;
    const picked = due[step].slice(0, ATTEMPTS_PER_STEP[step]);
    s.deferred = due[step].length - picked.length;
    for (const subject of picked) {
      if (sender.stopped) break;
      const fn = step === 'proposal' ? proposalFn! : step === 'pin' ? 'executePin' : 'executePinDelay';
      const args = step === 'proposal' ? [] : [subject];
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call(step, subject, fn, args);
      if (res === 'landed') {
        const ev = appliedEvent(beacon, step, subject, sender.receipt?.logs ?? []);
        if (ev === null) s.landedUnread.push(subject);
        else s.applied.push(ev);
      } else if (res === 'skipped' && sender.refusal !== null && RACES.has(sender.refusal.name)) {
        s.gone.push(subject);
      } else if (res === NOT_YET) {
        s.notYet.push(subject);
      }
    }
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

/** Discovery: the beacon's request logs from the cursor to the finalized
 *  block, at most {@link LOG_RANGES_PER_RUN} ranges, queued before the cursor moves. */
async function discover(beacon: Address, deps: BeaconDeps, cutoff: number): Promise<BeaconReport['discovery']> {
  const fin = await boundedCall(cutoff, 'the finalized block', () => deps.client.getBlock({ blockTag: 'finalized' }));
  const through = fin.number as bigint;
  const start = BigInt(Math.max(deps.floor, await deps.queue.cursor()));
  let from = start;
  let queued = 0;
  for (let i = 0; i < LOG_RANGES_PER_RUN && from <= through; i++) {
    const to = from + LOG_RANGE - 1n > through ? through : from + LOG_RANGE - 1n;
    const lo = from;
    // eslint-disable-next-line no-await-in-loop
    const logs = await boundedCall(cutoff, 'the request logs', () =>
      deps.client.getLogs({ address: beacon, events: REQUEST_EVENTS, fromBlock: lo, toBlock: to }),
    );
    const items = requestedVaults(logs as readonly { args: { vault?: Address }; blockNumber: bigint | null }[]);
    // eslint-disable-next-line no-await-in-loop
    await deps.queue.enqueue(items);
    // eslint-disable-next-line no-await-in-loop
    await deps.queue.setCursor(Number(to + 1n));
    queued += items.length;
    from = to + 1n;
  }
  return { from: Number(start), to: Number(from - 1n), queued, caughtUp: from > through };
}

/** The vaults a page of request logs names, once each. Pure. */
export function requestedVaults(logs: readonly { args: { vault?: Address }; blockNumber: bigint | null }[]): WorkItem<Record<string, never>>[] {
  const out = new Map<string, WorkItem<Record<string, never>>>();
  for (const l of logs) {
    const v = l.args.vault?.toLowerCase();
    if (v && !out.has(v)) out.set(v, { item: v, block: Number(l.blockNumber ?? 0n), payload: {} });
  }
  return [...out.values()];
}

/** Whether the beacon's pending proposal is due at `now`, which call applies
 *  it, and how the line names it. Pure. */
export function proposalDue(
  p: readonly [number | bigint, bigint, bigint, bigint],
  now: bigint,
): { due: boolean; functionName: string | null; label: string | null } {
  const kind = Number(p[0]);
  const [, id, successor, at] = p;
  if (kind === PROPOSAL_CURRENT) return { due: now >= BigInt(at), functionName: 'executeCurrentVersion', label: `current-version ${id} at ${at}` };
  if (kind === PROPOSAL_REVOKE) {
    return { due: now >= BigInt(at), functionName: 'executeRevoke', label: `revoke ${id}${BigInt(successor) !== 0n ? ` successor ${successor}` : ''} at ${at}` };
  }
  return { due: false, functionName: null, label: null };
}

/** The change a landed call made, from its receipt's own beacon event; null
 *  when the receipt does not carry it. */
export function appliedEvent(
  beacon: Address,
  step: Step,
  subject: string,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
): string | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== beacon.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: VaultBeaconABI as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = ev.args as unknown as Record<string, unknown>;
    const forVault = typeof a.vault === 'string' && a.vault.toLowerCase() === subject.toLowerCase();
    switch (ev.eventName as string | undefined) {
      case 'CurrentVaultVersionSet':
        if (step === 'proposal') return `current-version ${a.oldId as bigint}->${a.newId as bigint}`;
        break;
      case 'VaultVersionRevoked':
        if (step === 'proposal') return `revoked ${a.id as bigint}`;
        break;
      case 'VaultVersionPinned':
        if (step === 'pin' && forVault) return `${subject} pinned ${a.id as bigint}`;
        break;
      case 'VaultVersionUnpinned':
        if (step === 'pin' && forVault) return `${subject} unpinned`;
        break;
      case 'VaultPinCancelled':
        if (step === 'pin' && forVault) return `${subject} lapsed (target ${a.target as bigint} revoked)`;
        break;
      case 'VaultPinDelaySet':
        if (step === 'delay' && forVault) return `${subject} delay ${a.oldDelay as bigint}->${a.newDelay as bigint}`;
        break;
      default:
        break;
    }
  }
  return null;
}
