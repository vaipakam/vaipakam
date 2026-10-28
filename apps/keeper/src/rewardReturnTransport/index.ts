// apps/keeper/src/rewardReturnTransport/index.ts
//
// #2984 — the keeper's RETURN-TRANSPORT pass: the backstop for the
// permissionless steps that move reward VPFI home to Base, or carry the
// messages that let Base release what it reserved. Each step is open to anyone,
// and pays a CCIP fee, so nothing calls it unless someone chooses to:
//
//   1. Repatriation (#1568 C2 Mode A), driven by Base's own authorizations.
//      The administrator issues each one (`authorizeRepatriation`); after that:
//        - Base: the instruction goes to the mirror (`sendRepatriationInstruction`).
//        - Mirror: a recorded instruction is executed (`executeRepatriation`),
//          sending the VPFI home; a tombstoned one (the administrator
//          cancelled it) has its cancellation ACK sent (`sendRepatriationCancelAck`),
//          which is what lets Base release the reserved availability.
//      The instruction and the ACK are re-sendable by the contracts. This pass
//      sends each once, and says so when one runs late instead of paying for a
//      second copy of a message CCIP most likely holds already (`plan.ts`).
//   2. Stranded returns (#1434 R4): a compensation the mirror quarantined is
//      returned to Base in chunks (`sendStrandedReturn`) until its record is
//      empty.
//   3. A retired mirror's pending surplus (#917) goes home in chunks
//      (`sendRetiredSurplusReturn`).
//
// What it never does: issue or cancel an authorization (`authorizeRepatriation`,
// `requestRepatriationCancel` are the administrator's), or choose an amount the
// chain did not record. Every chunk is bounded by the lanes at both ends
// (`returnChunk`). Every send that moves VPFI is posted to the ops channel with
// its amount and transaction, and a message that has not landed within
// `LANDING_ALERT_SEC` is alerted.
//
// Its work comes from the shared indexer's event ledger (the authorizations,
// the dispatches others made, the quarantines), and every decision from an
// on-chain read: the ledger only nominates. What this keeper itself sent is
// recorded in its private database, so a send is never repeated in the
// minutes before the indexer has recorded it.
//
// Ships disarmed: `REWARD_RETURN_TRANSPORT_ENABLED` plus `KEEPER_ENABLED`.

import { createPublicClient, http, zeroAddress, type Abi, type Address, type PublicClient } from 'viem';
import {
  RepatriationFacetABI,
  RewardCustodyFacetABI,
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
  VaipakamDiamondABI,
  VaipakamRewardMessengerABI,
  VpfiReturnSenderABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env, KeeperD1 } from '../env';
import { getChainConfigs } from '../env';
import { buildKeeperContext, passIsArmed, resolveKeeperAccount, type KeeperContext } from '../keeper';
import type { PassTick } from '../passSchedule';
import { deadlineClient, PastRunDeadline, settledRead, type BatchResult } from '../batchRead';
import { shortErr } from '../callErrors';
import { deploymentFloor, finishWork, getWorkItems, putWork } from '../db';
import { feeCeiling } from '../feeCeiling';
import { sendOpsAlert } from '../opsAlert';
import { StepSender, type SendFeeCeiling } from '../stepSender';
import { AUTH_PENDING, executeBlocked, repatStep, returnChunk, type LaneBucket, type RepatState } from './plan';

export * from './plan';

const errorsOf = (abi: unknown) => (abi as Abi).filter((x) => x.type === 'error');
export const ABI = [
  ...(RepatriationFacetABI as Abi),
  ...(RewardRemittanceLensFacetABI as Abi),
  ...(RewardReporterFacetABI as Abi),
  ...(RewardCustodyFacetABI as Abi),
  ...errorsOf(VaipakamDiamondABI),
  // A refusal inside the messenger or the return sender bubbles through the
  // Diamond call; their errors decode from here.
  ...errorsOf(VaipakamRewardMessengerABI),
  ...errorsOf(VpfiReturnSenderABI),
] as Abi;
const MESSENGER_ABI = VaipakamRewardMessengerABI as Abi;
const RETURN_SENDER_ABI = VpfiReturnSenderABI as Abi;

export const PASS_CADENCE_SEC = 60 * 60;
/** Sends per chain per run. */
export const MAX_SENDS_PER_RUN = 6;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** A message not landed this long after it left is alerted. */
export const LANDING_ALERT_SEC = 24 * 3600;
const STALL_ALERT_INTERVAL_SEC = 6 * 3600;
/** A send notice is a one-off: its key (the transaction) never repeats. */
const NOTICE_INTERVAL_SEC = 10 * 365 * 86_400;
/** Ledger rows one run reads per chain; a longer ledger is said, not walked. */
export const LEDGER_LIMIT = 2000;
export const DEFAULT_MIN_PART = 1000n * 10n ** 18n;
export const MAX_FEE_VAR = 'REWARD_RETURN_TRANSPORT_MAX_FEE_WEI';
const READ_CHUNK = 100;

const ROLE_CANONICAL = 0;
const ROLE_MIRROR = 1;

/** Refusals that mean another caller got there first. */
export const RACES = new Set([
  'RepatriationAuthNotPending',
  'RepatriationInstructionWrongState',
  'StrandedReturnNothingRecorded',
  'StrandedReturnBadAmount',
  'RetiredSurplusBadAmount',
]);
/** A refusal the step reports as a wait, in its own words. */
const FUNDABLE_WAIT = 'RepatriationExceedsFundable';
export const PAUSED_REFUSAL = 'EnforcedPause';

// ─── Seams (injected so a run is testable) ─────────────────────────────────

/** One decoded event the indexer recorded. */
export interface LedgerRow {
  kind: string;
  args: Record<string, unknown>;
  /** Unix seconds of its block. */
  blockAt: number;
  block: number;
}

export interface ReturnLedger {
  /** The rows of `kinds` on `chainId` since the active Diamond's deploy
   *  block, oldest first; `truncated` when more remain than were read. Null
   *  when the ledger cannot be read. */
  events(chainId: number, kinds: readonly string[]): Promise<{ rows: LedgerRow[]; truncated: boolean } | null>;
}

/** This keeper's own record of the re-sendable messages it sent. */
export interface SendRecords {
  get(chainId: number, diamond: Address, items: readonly string[]): Promise<Map<string, number>>;
  put(chainId: number, diamond: Address, item: string, sentAt: number): Promise<void>;
  finish(chainId: number, diamond: Address, items: readonly string[]): Promise<void>;
}

export interface ChainDeps {
  chainId: number;
  diamond: Address;
  client: PublicClient;
  readClient: PublicClient;
  context: () => KeeperContext | null;
  feeCeiling: SendFeeCeiling;
  /** Posts an operator alert or notice about this chain. */
  alert: (key: string, text: string, minIntervalSec: number) => Promise<unknown>;
}

export interface ReturnTransportDeps {
  chains: readonly ChainDeps[];
  ledger: ReturnLedger;
  records: SendRecords;
  keeper: Address | null;
  sendDeadline: number;
  minPart: bigint;
  now: () => number;
}

export interface ReturnTransportReport {
  chainId: number;
  skipped?: string;
  role?: number;
  dispatched: string[];
  executed: string[];
  acked: string[];
  stranded: string[];
  retired: string[];
  waiting: string[];
  stalled: string[];
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

// ─── Entry ─────────────────────────────────────────────────────────────────

export async function runRewardReturnTransport(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardReturnTransport', 'REWARD_RETURN_TRANSPORT_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const resolved = env.KEEPER_PRIVATE_KEY ? resolveKeeperAccount(env.KEEPER_PRIVATE_KEY) : null;
  const keeper = resolved && 'account' in resolved ? resolved.account.address : null;
  const minPart = parseMinPart(env.REWARD_RETURN_MIN_PART);
  const chains: ChainDeps[] = getChainConfigs(env)
    .filter((c) => c.diamond)
    .map((chain: ChainConfig) => {
      const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
      const client = deadlineClient(plain, sendDeadline);
      return {
        chainId: chain.id,
        diamond: chain.diamond as Address,
        client,
        readClient: plain,
        context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
        feeCeiling: feeCeiling(env.REWARD_RETURN_TRANSPORT_MAX_FEE_WEI, chain.id, MAX_FEE_VAR),
        alert: (key: string, text: string, interval: number) => sendOpsAlert(env, key, text, interval, undefined, chain.id),
      };
    });
  try {
    const reports = await returnTransportOnce({
      chains,
      ledger: d1Ledger(env.DB),
      records: d1Records(env.KEEPER_DB),
      keeper,
      sendDeadline,
      minPart,
      now: () => Math.floor(Date.now() / 1000),
    });
    for (const r of reports) console.log(describeReport(r));
  } catch (err) {
    console.error(`[keeper] rewardReturnTransport failed: ${shortErr(err)}`);
  }
}

/** `REWARD_RETURN_MIN_PART` in wei; unset or unreadable is the default. */
export function parseMinPart(raw: string | undefined): bigint {
  if (!raw || !/^\d+$/.test(raw.trim())) return DEFAULT_MIN_PART;
  return BigInt(raw.trim());
}

export function describeReport(r: ReturnTransportReport): string {
  if (r.skipped) return `[keeper] rewardReturnTransport chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const list = (xs: readonly string[]) => xs.join(',') || 'none';
  const parts = [
    `[keeper] rewardReturnTransport chain=${r.chainId} role=${r.role}`,
    `instructions-sent=${list(r.dispatched)}`,
    `executed=${list(r.executed)}`,
    `acks-sent=${list(r.acked)}`,
    `stranded-returned=${list(r.stranded)}`,
    `retired-surplus-returned=${list(r.retired)}`,
    ...(r.waiting.length > 0 ? [`waiting=${r.waiting.join('; ')}`] : []),
    ...(r.stalled.length > 0 ? [`stalled=${r.stalled.join('; ')}`] : []),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

// ─── One run ───────────────────────────────────────────────────────────────

interface ChainState {
  deps: ChainDeps;
  r: Reader;
  sender: StepSender;
  report: ReturnTransportReport;
  role: number;
  baseChainId: number;
  messenger: Address;
  returnSender: Address;
  receiver: Address;
  retirement: { retired: boolean; returnChainId: number; returnDeployment: Address };
}

/** One run over every configured chain. Exported for tests. */
export async function returnTransportOnce(deps: ReturnTransportDeps): Promise<ReturnTransportReport[]> {
  const states = new Map<number, ChainState>();
  const reports: ReturnTransportReport[] = [];
  for (const c of deps.chains) {
    const sender = new StepSender(
      {
        pass: 'rewardReturnTransport',
        abi: ABI,
        maxSends: MAX_SENDS_PER_RUN,
        receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
        races: RACES,
        pausedRefusal: PAUSED_REFUSAL,
        unrecorded: new Set([FUNDABLE_WAIT]),
        describe: (s) => String(s),
        spends: 'the gas and CCIP fee',
      },
      { context: c.context, sendDeadline: deps.sendDeadline, feeCeiling: c.feeCeiling },
    );
    const report: ReturnTransportReport = {
      chainId: c.chainId,
      dispatched: [],
      executed: [],
      acked: [],
      stranded: [],
      retired: [],
      waiting: [],
      stalled: [],
      refused: sender.refused,
      unread: sender.unread,
      stopped: null,
    };
    reports.push(report);
    const r = new Reader(c, deps.sendDeadline);
    try {
      // eslint-disable-next-line no-await-in-loop
      const gate = await readGate(r, c.chainId);
      if (typeof gate === 'string') {
        report.skipped = gate;
        continue;
      }
      report.role = gate.role;
      states.set(c.chainId, { deps: c, r, sender, report, ...gate });
    } catch (err) {
      if (!(err instanceof PastRunDeadline)) throw err;
      report.skipped = 'the run deadline passed during its reads';
    }
  }
  for (const s of states.values()) {
    try {
      if (s.role === ROLE_CANONICAL && s.receiver !== zeroAddress) await repatriations(s, states, deps); // eslint-disable-line no-await-in-loop
      if (s.role === ROLE_MIRROR && s.returnSender !== zeroAddress && s.baseChainId !== 0) await strandedReturns(s, states, deps); // eslint-disable-line no-await-in-loop
      if (s.retirement.retired && s.returnSender !== zeroAddress) await retiredSurplus(s, states, deps); // eslint-disable-line no-await-in-loop
    } catch (err) {
      if (!(err instanceof PastRunDeadline)) throw err;
      s.sender.noteUnread('run', 'the run deadline passed during its reads');
    }
  }
  for (const s of states.values()) s.report.stopped = s.sender.stopped ? s.sender.stopReason : null;
  return reports;
}

class Reader {
  constructor(
    readonly deps: ChainDeps,
    readonly deadline: number,
  ) {}

  async one<T>(functionName: string, args: readonly unknown[] = [], address: Address = this.deps.diamond, abi: Abi = ABI): Promise<T> {
    return (await this.deps.client.readContract({ address, abi, functionName, args })) as T;
  }

  /** `one`, or undefined with why noted. */
  async tryOne<T>(sender: StepSender, key: string, what: string, functionName: string, args: readonly unknown[] = [], address?: Address, abi?: Abi): Promise<T | undefined> {
    try {
      return await this.one<T>(functionName, args, address, abi);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      sender.noteUnread(key, `${what} (${shortErr(err)})`);
      return undefined;
    }
  }

  async many(calls: readonly { functionName: string; args: readonly unknown[] }[], label: string): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < calls.length; i += READ_CHUNK) {
      const part = calls.slice(i, i + READ_CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const res: BatchResult[] = await settledRead(
        this.deps.readClient,
        part.map((c) => ({ address: this.deps.diamond, abi: ABI, functionName: c.functionName, args: c.args })),
        `rewardReturnTransport ${label}`,
        this.deadline,
      );
      for (const x of res) out.push(x.status === 'success' ? x.result : undefined);
    }
    return out;
  }

  /** A lens lane bucket, or null when the view is absent or refuses. */
  async bucket(functionName: 'getRemitLaneBucket' | 'getRemitInboundLaneBucket', chainId: number): Promise<LaneBucket | null> {
    try {
      const b = await this.one<readonly [boolean, boolean, bigint, bigint]>(functionName, [chainId]);
      return { readable: b[0], limited: b[1], tokens: b[2], capacity: b[3] };
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return null;
    }
  }
}

type Gate = Omit<ChainState, 'deps' | 'r' | 'sender' | 'report'>;

/** The Diamond must name itself this chain; its role, transport endpoints and
 *  retirement record decide which steps apply. */
async function readGate(r: Reader, chainId: number): Promise<Gate | string> {
  const read = async <T>(functionName: string, what: string): Promise<T | string> => {
    try {
      return await r.one<T>(functionName);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return `${what} could not be read (${shortErr(err)})`;
    }
  };
  const cfg = await read<readonly [Address, number, number, boolean, bigint]>('getRewardReporterConfig', 'its reward reporter config');
  if (typeof cfg === 'string') return cfg;
  if (Number(cfg[1]) !== chainId) {
    return `the Diamond its RPC serves names itself chain ${Number(cfg[1])}, so the RPC configured for chain ${chainId} answers for another chain (or the Diamond's reporter config names the wrong local chain)`;
  }
  const role = await read<number>('getRewardRole', 'its reward role');
  if (typeof role === 'string') return role;
  const pos = await read<readonly [bigint, Address, Address, bigint]>('getRepatriationPosition', 'its repatriation endpoints');
  if (typeof pos === 'string') return pos;
  const ret = await read<readonly [boolean, number, Address, bigint]>('getRewardChainRetirement', 'its retirement record');
  if (typeof ret === 'string') return ret;
  if (pos[1] === zeroAddress && pos[2] === zeroAddress) {
    return 'its return transport is not configured (no repatriation sender or receiver), so every return step is dark';
  }
  return {
    role: Number(role),
    baseChainId: Number(cfg[2]),
    messenger: cfg[0],
    returnSender: pos[1],
    receiver: pos[2],
    retirement: { retired: ret[0], returnChainId: Number(ret[1]), returnDeployment: ret[2] },
  };
}

const asBig = (v: unknown): bigint | null => {
  try {
    return typeof v === 'bigint' ? v : BigInt(String(v));
  } catch {
    return null;
  }
};
const asAddr = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');

/** A stall the operator should see: listed, and alerted on its own key. */
async function stall(s: ChainState, key: string, text: string): Promise<void> {
  s.report.stalled.push(text);
  await s.deps.alert(`return-transport-stalled:${s.deps.chainId}:${key}`, `⚠️ Return transport on chain ${s.deps.chainId}: ${text}.`, STALL_ALERT_INTERVAL_SEC);
}

/** A send that moved VPFI, posted once with its amount and transaction. */
async function notice(s: ChainState, what: string): Promise<void> {
  const tx = s.sender.receipt?.transactionHash ?? 'unknown';
  await s.deps.alert(`return-transport-sent:${s.deps.chainId}:${tx}`, `ℹ️ Return transport on chain ${s.deps.chainId}: ${what} (tx ${tx}).`, NOTICE_INTERVAL_SEC);
}

// ─── 1. Repatriation ───────────────────────────────────────────────────────

const RECORD_INSTRUCTION = (authId: bigint) => `instruction:${authId}`;
const RECORD_ACK = (base: Address, authId: bigint) => `ack:${base.toLowerCase()}:${authId}`;

async function repatriations(base: ChainState, states: ReadonlyMap<number, ChainState>, deps: ReturnTransportDeps): Promise<void> {
  const ledger = await deps.ledger.events(base.deps.chainId, ['RepatriationAuthorized', 'RepatriationInstructionDispatched']);
  if (ledger === null) {
    base.sender.noteUnread('repatriation', 'the event ledger');
    return;
  }
  if (ledger.truncated) base.sender.noteUnread('repatriation', `the event ledger beyond its first ${LEDGER_LIMIT} rows`);
  const auths = new Map<bigint, { dst: number; amount: bigint }>();
  const dispatchedAt = new Map<bigint, number>();
  for (const row of ledger.rows) {
    const id = asBig(row.args.authId);
    if (id === null) continue;
    if (row.kind === 'RepatriationAuthorized') {
      const amount = asBig(row.args.amount);
      if (amount !== null) auths.set(id, { dst: Number(row.args.dstChainId), amount });
    } else dispatchedAt.set(id, Math.max(dispatchedAt.get(id) ?? 0, row.blockAt));
  }
  if (auths.size === 0) return;
  const ids = [...auths.keys()];
  const statuses = await base.r.many(ids.map((id) => ({ functionName: 'getRepatriationAuthorization', args: [id] })), 'authorizations');
  const own = await deps.records.get(base.deps.chainId, base.deps.diamond, ids.map(RECORD_INSTRUCTION));
  const settled: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const authId = ids[i];
    const st = statuses[i] as readonly [number, number, bigint, bigint, bigint] | undefined;
    if (st === undefined) {
      base.sender.noteUnread(`auth:${authId}`, 'its authorization record');
      continue;
    }
    if (Number(st[0]) !== AUTH_PENDING) {
      settled.push(RECORD_INSTRUCTION(authId));
      const m = states.get(Number(st[1]));
      // eslint-disable-next-line no-await-in-loop
      if (m !== undefined) await deps.records.finish(m.deps.chainId, m.deps.diamond, [RECORD_ACK(base.deps.diamond, authId)]);
      continue;
    }
    const dst = Number(st[1]);
    const amount = st[3];
    // eslint-disable-next-line no-await-in-loop
    await oneAuthorization(base, states.get(dst), deps, authId, dst, amount, Math.max(dispatchedAt.get(authId) ?? 0, own.get(RECORD_INSTRUCTION(authId)) ?? 0) || null);
  }
  if (settled.length > 0) await deps.records.finish(base.deps.chainId, base.deps.diamond, settled);
}

/** The mirror-side ledger, per mirror and per run. */
const mirrorLedgers = new WeakMap<ChainState, Promise<{ executedAt: Map<string, number>; ackAt: Map<string, number> } | null>>();

function mirrorLedger(mirror: ChainState, deps: ReturnTransportDeps): Promise<{ executedAt: Map<string, number>; ackAt: Map<string, number> } | null> {
  let p = mirrorLedgers.get(mirror);
  if (p === undefined) {
    p = (async () => {
      const l = await deps.ledger.events(mirror.deps.chainId, ['RepatriationExecuted', 'RepatriationCancelAckDispatched']);
      if (l === null) return null;
      if (l.truncated) mirror.sender.noteUnread('repatriation', `the event ledger beyond its first ${LEDGER_LIMIT} rows`);
      const executedAt = new Map<string, number>();
      const ackAt = new Map<string, number>();
      for (const row of l.rows) {
        const key = `${asAddr(row.args.issuingBase)}:${asBig(row.args.authId)}`;
        const into = row.kind === 'RepatriationExecuted' ? executedAt : ackAt;
        into.set(key, Math.max(into.get(key) ?? 0, row.blockAt));
      }
      return { executedAt, ackAt };
    })();
    mirrorLedgers.set(mirror, p);
  }
  return p;
}

async function oneAuthorization(
  base: ChainState,
  mirror: ChainState | undefined,
  deps: ReturnTransportDeps,
  authId: bigint,
  dst: number,
  amount: bigint,
  instructionSentAt: number | null,
): Promise<void> {
  const label = `authorization ${authId} to chain ${dst}`;
  if (mirror === undefined) {
    base.sender.noteUnread(`auth:${authId}`, `chain ${dst}, which this keeper has no RPC or Diamond for (or whose gate refused it)`);
    return;
  }
  const instr = await mirror.r.tryOne<readonly [number, bigint]>(mirror.sender, `auth:${authId}`, `its instruction record on chain ${dst}`, 'getRepatriationInstruction', [base.deps.diamond, authId]);
  if (instr === undefined) return;
  const ml = await mirrorLedger(mirror, deps);
  if (ml === null) {
    mirror.sender.noteUnread(`auth:${authId}`, 'the mirror\'s event ledger');
    return;
  }
  const key = `${base.deps.diamond.toLowerCase()}:${authId}`;
  const ownAck = (await deps.records.get(mirror.deps.chainId, mirror.deps.diamond, [RECORD_ACK(base.deps.diamond, authId)])).get(RECORD_ACK(base.deps.diamond, authId));
  const state: RepatState = {
    authId,
    dstChainId: dst,
    amount,
    baseStatus: AUTH_PENDING,
    mirrorState: Number(instr[0]),
    instructionSentAt,
    executedAt: ml.executedAt.get(key) ?? null,
    ackSentAt: Math.max(ml.ackAt.get(key) ?? 0, ownAck ?? 0) || null,
  };
  const step = repatStep(state, deps.now(), LANDING_ALERT_SEC);
  switch (step.kind) {
    case 'done':
      return;
    case 'wait':
      if (step.stalled) await stall(base, `auth:${authId}`, `${label}: ${step.why}`);
      else base.report.waiting.push(`${label}: ${step.why}`);
      return;
    case 'dispatch': {
      if (deps.keeper === null) {
        base.sender.noteUnread(`auth:${authId}`, 'the keeper key (no refund address)');
        return;
      }
      const fee = await base.r.tryOne<bigint>(base.sender, `auth:${authId}`, 'the messenger\'s fee for the instruction', 'quoteSendRepatriationInstruction', [BigInt(dst), authId, amount], base.messenger, MESSENGER_ABI);
      if (fee === undefined) return;
      const res = await base.sender.call('instruction', `authorization ${authId}`, 'sendRepatriationInstruction', [authId, deps.keeper], fee);
      if (res === 'landed') {
        base.report.dispatched.push(String(authId));
        await deps.records.put(base.deps.chainId, base.deps.diamond, RECORD_INSTRUCTION(authId), deps.now());
      }
      return;
    }
    case 'execute': {
      if (deps.keeper === null) {
        mirror.sender.noteUnread(`auth:${authId}`, 'the keeper key (no refund address)');
        return;
      }
      const blocked = executeBlocked(amount, await mirror.r.bucket('getRemitLaneBucket', mirror.baseChainId));
      if (blocked !== null) {
        if (blocked.stalled) await stall(mirror, `auth:${key}`, `${label}: ${blocked.why}`);
        else mirror.report.waiting.push(`${label}: ${blocked.why}`);
        return;
      }
      const fee = await mirror.r.tryOne<bigint>(mirror.sender, `auth:${authId}`, 'the return sender\'s fee', 'quoteRepatriationReturn', [BigInt(mirror.baseChainId), base.deps.diamond, authId, amount], mirror.returnSender, RETURN_SENDER_ABI);
      if (fee === undefined) return;
      const res = await mirror.sender.call('execute', `authorization ${authId}`, 'executeRepatriation', [base.deps.diamond, authId, deps.keeper], fee);
      if (res === 'landed') {
        mirror.report.executed.push(String(authId));
        await notice(mirror, `executed repatriation ${authId}, sending ${amount} VPFI (wei) home to chain ${mirror.baseChainId}`);
      } else if (res.includes(FUNDABLE_WAIT)) {
        mirror.report.waiting.push(`${label}: the mirror's un-reserved surplus is below its amount until claim commitments retire`);
      }
      return;
    }
    case 'ack': {
      if (deps.keeper === null) {
        mirror.sender.noteUnread(`auth:${authId}`, 'the keeper key (no refund address)');
        return;
      }
      const fee = await mirror.r.tryOne<bigint>(mirror.sender, `auth:${authId}`, 'the return sender\'s fee for the ACK', 'quoteRepatriationCancelAck', [BigInt(mirror.baseChainId), base.deps.diamond, authId], mirror.returnSender, RETURN_SENDER_ABI);
      if (fee === undefined) return;
      const res = await mirror.sender.call('ack', `authorization ${authId}`, 'sendRepatriationCancelAck', [base.deps.diamond, authId, deps.keeper], fee);
      if (res === 'landed') {
        mirror.report.acked.push(String(authId));
        await deps.records.put(mirror.deps.chainId, mirror.deps.diamond, RECORD_ACK(base.deps.diamond, authId), deps.now());
      }
      return;
    }
  }
}

// ─── 2. Stranded returns ───────────────────────────────────────────────────

interface StrandedRecord {
  amount: bigint;
  dayId: bigint;
}

async function strandedReturns(mirror: ChainState, states: ReadonlyMap<number, ChainState>, deps: ReturnTransportDeps): Promise<void> {
  const ledger = await deps.ledger.events(mirror.deps.chainId, ['CompensationQuarantined']);
  if (ledger === null) {
    mirror.sender.noteUnread('stranded', 'the event ledger');
    return;
  }
  if (ledger.truncated) mirror.sender.noteUnread('stranded', `the event ledger beyond its first ${LEDGER_LIMIT} rows`);
  const keys = new Map<string, { remitter: Address; remitId: bigint }>();
  for (const row of ledger.rows) {
    const remitId = asBig(row.args.remitId);
    const remitter = asAddr(row.args.remitter);
    if (remitId === null || !/^0x[0-9a-f]{40}$/.test(remitter)) continue;
    keys.set(`${remitter}:${remitId}`, { remitter: remitter as Address, remitId });
  }
  if (keys.size === 0) return;
  const list = [...keys.values()];
  const recs = await mirror.r.many(list.map((k) => ({ functionName: 'getStrandedRecovery', args: [k.remitter, k.remitId] })), 'stranded records');
  for (let i = 0; i < list.length; i++) {
    const { remitter, remitId } = list[i];
    const rec = recs[i] as StrandedRecord | undefined;
    const subject = `stranded ${remitter}:${remitId}`;
    if (rec === undefined) {
      mirror.sender.noteUnread(subject, 'its stranded-recovery record');
      continue;
    }
    if (rec.amount === 0n) continue;
    // eslint-disable-next-line no-await-in-loop
    const plan = await chunkFor(mirror, states.get(mirror.baseChainId), mirror.baseChainId, rec.amount, deps.minPart);
    if ('wait' in plan) {
      mirror.report.waiting.push(`${subject}: ${plan.wait}`);
      continue;
    }
    if (deps.keeper === null) {
      mirror.sender.noteUnread(subject, 'the keeper key (no refund address)');
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const fee = await mirror.r.tryOne<bigint>(mirror.sender, subject, 'the return sender\'s fee', 'quoteStrandedReturn', [BigInt(mirror.baseChainId), remitter, remitId, rec.dayId, plan.amount, rec.amount - plan.amount], mirror.returnSender, RETURN_SENDER_ABI);
    if (fee === undefined) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await mirror.sender.call('stranded', subject, 'sendStrandedReturn', [remitter, remitId, plan.amount, deps.keeper], fee);
    if (res === 'landed') {
      mirror.report.stranded.push(`${remitter}:${remitId}=${plan.amount}`);
      // eslint-disable-next-line no-await-in-loop
      await notice(mirror, `returned ${plan.amount} of the ${rec.amount} VPFI (wei) quarantined for remit ${remitId} (day ${rec.dayId}) to chain ${mirror.baseChainId}${plan.note ? `; ${plan.note}` : ''}`);
    }
  }
}

/** A chunk bounded by this chain's outbound lane toward `dst` and, when this
 *  keeper serves it, `dst`'s inbound lane from this chain. */
async function chunkFor(from: ChainState, to: ChainState | undefined, dst: number, remaining: bigint, minPart: bigint) {
  const outbound = await from.r.bucket('getRemitLaneBucket', dst);
  const inbound = to === undefined ? null : await to.r.bucket('getRemitInboundLaneBucket', from.deps.chainId);
  return returnChunk(remaining, outbound, inbound, minPart);
}

// ─── 3. A retired mirror's pending surplus ─────────────────────────────────

async function retiredSurplus(s: ChainState, states: ReadonlyMap<number, ChainState>, deps: ReturnTransportDeps): Promise<void> {
  const { returnChainId, returnDeployment } = s.retirement;
  const ledger = await s.r.tryOne<readonly bigint[]>(s.sender, 'retired surplus', 'the custody ledger', 'rewardCustodyLedger');
  if (ledger === undefined) return;
  const pending = ledger[5];
  if (pending === 0n) return;
  const plan = await chunkFor(s, states.get(returnChainId), returnChainId, pending, deps.minPart);
  if ('wait' in plan) {
    s.report.waiting.push(`retired surplus ${pending}: ${plan.wait}`);
    return;
  }
  if (deps.keeper === null) {
    s.sender.noteUnread('retired surplus', 'the keeper key (no refund address)');
    return;
  }
  const fee = await s.r.tryOne<bigint>(s.sender, 'retired surplus', 'the return sender\'s fee', 'quoteRetiredSurplusReturn', [BigInt(returnChainId), returnDeployment, plan.amount], s.returnSender, RETURN_SENDER_ABI);
  if (fee === undefined) return;
  const res = await s.sender.call('retired', 'pending surplus', 'sendRetiredSurplusReturn', [plan.amount, deps.keeper], fee);
  if (res === 'landed') {
    s.report.retired.push(String(plan.amount));
    await notice(s, `returned ${plan.amount} of this retired chain's ${pending} VPFI (wei) pending surplus to chain ${returnChainId}${plan.note ? `; ${plan.note}` : ''}`);
  }
}

// ─── Production seams ──────────────────────────────────────────────────────

/** The shared indexer's event ledger (`activity_events`). */
export function d1Ledger(db: D1Database): ReturnLedger {
  return {
    async events(chainId, kinds) {
      try {
        const marks = kinds.map((_, i) => `?${i + 3}`).join(', ');
        const rows = await db
          .prepare(
            `SELECT kind, args_json, block_at, block_number FROM activity_events
              WHERE chain_id = ?1 AND block_number >= ?2 AND kind IN (${marks})
              ORDER BY block_number ASC, log_index ASC
              LIMIT ${LEDGER_LIMIT + 1}`,
          )
          .bind(chainId, deploymentFloor(chainId), ...kinds)
          .all<{ kind: string; args_json: string; block_at: number; block_number: number }>();
        const all = rows.results ?? [];
        const out: LedgerRow[] = [];
        for (const r of all.slice(0, LEDGER_LIMIT)) {
          try {
            out.push({ kind: r.kind, args: JSON.parse(r.args_json) as Record<string, unknown>, blockAt: Number(r.block_at), block: Number(r.block_number) });
          } catch {
            /* an unreadable row nominates nothing */
          }
        }
        return { rows: out, truncated: all.length > LEDGER_LIMIT };
      } catch {
        return null;
      }
    },
  };
}

/** This keeper's own send records, in its private open-work table. */
export function d1Records(db: KeeperD1): SendRecords {
  return {
    async get(chainId, diamond, items) {
      const rows = await getWorkItems<{ sentAt: number }>(db, chainId, diamond, 'return_send', items);
      return new Map([...rows].map(([k, v]) => [k, Number(v.payload.sentAt)]));
    },
    put: (chainId, diamond, item, sentAt) => putWork(db, chainId, diamond, 'return_send', { item, block: 0, payload: { sentAt } }),
    finish: (chainId, diamond, items) => finishWork(db, chainId, diamond, 'return_send', items),
  };
}
