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
// Base's authorizations come from its own nonce: ids are issued in sequence,
// so they are read from the chain a bounded number a run, rotating above a
// floor of settled ones. The quarantines, which no view lists, come from the
// shared indexer's event ledger a page a run, rotating the same way, and the
// ledger also says when others sent a message, asked for by id. Every
// decision is an on-chain read: the ledger only nominates and times. What this keeper itself sent is
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
import { d1ScanCursors, decodeIndex, finalFloor, finalizedBlockOnce, rotatingWindow, type FinalBlock, type ScanCursors } from '../scanCursors';
import { StepSender, type CallResult, type SendFeeCeiling } from '../stepSender';
import { AUTH_PENDING, AUTH_RELEASED, AUTH_SETTLED, executeBlocked, repatStep, returnChunk, type LaneBucket, type RepatState } from './plan';

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
/** Authorizations one run reads on Base, rotating over every id not yet
 *  settled (`scanCursors.rotatingWindow`). */
export const MAX_AUTHS_PER_RUN = 50;
/** Quarantine rows one run reads per mirror, from where the last run stopped. */
export const LEDGER_PAGE = 200;
/** The scan-cursor items this pass keeps (`scanCursors.ts`). */
export const AUTH_FLOOR_ITEM = 'auth-floor';
export const AUTH_NEXT_ITEM = 'auth-next';
export const STRANDED_FLOOR_ITEM = 'stranded-floor';
export const STRANDED_NEXT_ITEM = 'stranded-next';
export const DEFAULT_MIN_PART = 1000n * 10n ** 18n;
export const MAX_FEE_VAR = 'REWARD_RETURN_TRANSPORT_MAX_FEE_WEI';
const READ_CHUNK = 100;

const ROLE_CANONICAL = 0;
const ROLE_MIRROR = 1;
/** The events that make a stranded-recovery record, each naming its receipt
 *  (`remitter`, `remitId`): an arrival quarantined on landing, and a
 *  provisional compensation demoted by its day's broadcast. */
export const STRANDED_EVENTS = ['CompensationQuarantined', 'CompensationDemoted'] as const;

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
  log: number;
}

/** A position in a chain's ledger: a row's block and log index. */
export interface LedgerPos {
  block: number;
  log: number;
}

/** Every read is from the active Diamond's deploy block on, and null when the
 *  ledger cannot be read. Neither read is bounded by the ledger's length: one
 *  is keyed by the ids a run already holds, the other is a page from a cursor. */
export interface ReturnLedger {
  /** The rows of `kinds` on `chainId` whose `arg` is one of `values`, oldest first. */
  matching(chainId: number, kinds: readonly string[], arg: string, values: readonly string[]): Promise<LedgerRow[] | null>;
  /** At most `limit` rows of `kinds` on `chainId` after `after` (from the
   *  start when null), oldest first; `more` when rows remain past them. */
  page(chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number): Promise<{ rows: LedgerRow[]; more: boolean } | null>;
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
  /** Where each chain's bounded reads got to, across runs. */
  cursors: (chainId: number, diamond: Address) => ScanCursors;
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
      cursors: (chainId, diamond) => d1ScanCursors(env.KEEPER_DB, chainId, diamond, 'rewardReturnTransport'),
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
  /** Base's authorization nonce: ids 1..authNonce were ever issued. */
  authNonce: bigint;
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
  /** The chain's finalized block, read once a run (`scanCursors.finalFloor`). */
  readonly finalized: () => Promise<FinalBlock | null>;

  constructor(
    readonly deps: ChainDeps,
    readonly deadline: number,
  ) {
    this.finalized = finalizedBlockOnce(deps.client);
  }

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

  /** At the head, or at `blockNumber` when one is given. */
  async many(calls: readonly { functionName: string; args: readonly unknown[] }[], label: string, blockNumber?: bigint): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < calls.length; i += READ_CHUNK) {
      const part = calls.slice(i, i + READ_CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const res: BatchResult[] = await settledRead(
        this.deps.readClient,
        part.map((c) => ({ address: this.deps.diamond, abi: ABI, functionName: c.functionName, args: c.args })),
        `rewardReturnTransport ${label}`,
        this.deadline,
        blockNumber,
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
    authNonce: pos[3],
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
/** An authorization the administrator's flow has finished with: settled by an
 *  execution, or released by a cancellation ACK. Anything else, including
 *  the zero status of an id not yet issued, is not finished (Codex #3002). */
const authFinished = (status: number): boolean => status === AUTH_SETTLED || status === AUTH_RELEASED;

/**
 * Sends one of the re-sendable paid messages (an instruction or an ACK) with
 * this keeper's record of it written BEFORE it goes out, and put back only
 * when no transaction can have gone out. A send whose receipt was not seen
 * may land after the run, and the indexer may not have recorded it by the
 * next run, so it counts as made: the next run waits on it, and alerts if it
 * runs late, rather than paying for a second copy (Codex #3002, the day-close
 * broadcast rule). A reverted send or one the node refused left nothing.
 */
async function sendRecorded(s: ChainState, deps: ReturnTransportDeps, item: string, send: () => Promise<CallResult>): Promise<CallResult> {
  const { chainId, diamond } = s.deps;
  const prior = (await deps.records.get(chainId, diamond, [item])).get(item);
  const before = s.sender.maybeSent;
  await deps.records.put(chainId, diamond, item, deps.now());
  const res = await send();
  if (s.sender.maybeSent === before) {
    if (prior === undefined) await deps.records.finish(chainId, diamond, [item]);
    else await deps.records.put(chainId, diamond, item, prior);
  }
  return res;
}
const RECORD_ACK = (base: Address, authId: bigint) => `ack:${base.toLowerCase()}:${authId}`;

async function repatriations(base: ChainState, states: ReadonlyMap<number, ChainState>, deps: ReturnTransportDeps): Promise<void> {
  // Base issues authorization ids in sequence, so the chain itself names every
  // one: they are read MAX_AUTHS_PER_RUN a run, rotating above a stored floor
  // every id below which is settled for good. The ledger only says when an
  // instruction left, and is asked for exactly the ids still pending.
  const nonce = Number(base.authNonce);
  if (nonce === 0) return;
  const cursors = deps.cursors(base.deps.chainId, base.deps.diamond);
  const stored = await cursors.get([AUTH_FLOOR_ITEM, AUTH_NEXT_ITEM]);
  const floor = Math.min(decodeIndex(stored.get(AUTH_FLOOR_ITEM)) ?? 1, nonce + 1);
  const win = rotatingWindow(floor, nonce, MAX_AUTHS_PER_RUN, decodeIndex(stored.get(AUTH_NEXT_ITEM)));
  if (win === null) return;
  const nums: number[] = [];
  for (let id = win.from; id <= win.to; id++) nums.push(id);
  const ids = nums.map(BigInt);
  const statuses = await base.r.many(ids.map((id) => ({ functionName: 'getRepatriationAuthorization', args: [id] })), 'authorizations');
  const finished = new Set<number>();
  const pending: { authId: bigint; dst: number; amount: bigint }[] = [];
  const settled: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const authId = ids[i];
    const st = statuses[i] as readonly [number, number, bigint, bigint, bigint] | undefined;
    if (st === undefined) {
      base.sender.noteUnread(`auth:${authId}`, 'its authorization record');
      continue;
    }
    if (authFinished(Number(st[0]))) {
      finished.add(nums[i]);
      settled.push(RECORD_INSTRUCTION(authId));
      const m = states.get(Number(st[1]));
      // eslint-disable-next-line no-await-in-loop
      if (m !== undefined) await deps.records.finish(m.deps.chainId, m.deps.diamond, [RECORD_ACK(base.deps.diamond, authId)]);
      continue;
    }
    if (Number(st[0]) !== AUTH_PENDING) {
      base.sender.noteUnread(`auth:${authId}`, `its authorization status ${Number(st[0])}, which is neither pending nor finished`);
      continue;
    }
    pending.push({ authId, dst: Number(st[1]), amount: st[3] });
  }
  if (settled.length > 0) await deps.records.finish(base.deps.chainId, base.deps.diamond, settled);
  // The floor moves only on what the finalized block shows (Codex #2993 r4):
  // an authorization a reorg puts back to pending stays above it. It must read
  // FINISHED there, not merely not pending: an id issued and finished since
  // the finalized block reads zero at it (Codex #3002).
  const newFloor = await finalFloor(floor, nums, (id) => finished.has(id), base.r.finalized, async (passed, block) => {
    const at = await base.r.many(passed.map((id) => ({ functionName: 'getRepatriationAuthorization', args: [BigInt(id)] })), 'authorizations-final', block.number);
    return new Set(passed.filter((_, i) => {
      const st = at[i] as readonly [number, ...unknown[]] | undefined;
      return st !== undefined && authFinished(Number(st[0]));
    }));
  });
  if (newFloor !== floor) await cursors.put(AUTH_FLOOR_ITEM, String(newFloor));
  if (String(win.next) !== stored.get(AUTH_NEXT_ITEM)) await cursors.put(AUTH_NEXT_ITEM, String(win.next));
  if (pending.length === 0) return;
  const rows = await deps.ledger.matching(base.deps.chainId, ['RepatriationInstructionDispatched'], 'authId', pending.map((p) => String(p.authId)));
  if (rows === null) {
    base.sender.noteUnread('repatriation', 'the event ledger');
    return;
  }
  const dispatchedAt = new Map<bigint, number>();
  for (const row of rows) {
    const id = asBig(row.args.authId);
    if (id !== null) dispatchedAt.set(id, Math.max(dispatchedAt.get(id) ?? 0, row.blockAt));
  }
  const own = await deps.records.get(base.deps.chainId, base.deps.diamond, pending.map((p) => RECORD_INSTRUCTION(p.authId)));
  for (const { authId, dst, amount } of pending) {
    // eslint-disable-next-line no-await-in-loop
    await oneAuthorization(base, states.get(dst), deps, authId, dst, amount, Math.max(dispatchedAt.get(authId) ?? 0, own.get(RECORD_INSTRUCTION(authId)) ?? 0) || null);
  }
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
  // The mirror executes and acknowledges toward its CURRENT Base: a mirror
  // detached and reattached elsewhere would send this authorization's return
  // or ACK to that other chain, leaving the issuing Base's authorization
  // unsettled (Codex #3002). Nothing is sent for it; an operator decides.
  if (mirror.role !== ROLE_MIRROR || mirror.baseChainId !== base.deps.chainId) {
    const now = mirror.role === ROLE_MIRROR ? `returns to chain ${mirror.baseChainId}` : `has reward role ${mirror.role}, not Mirror`;
    await stall(base, `auth:${authId}`, `${label}: chain ${dst} now ${now}, not to the issuing Base on chain ${base.deps.chainId}, so the keeper sends no instruction, return or ACK for it; cancelling the authorization is an operator decision`);
    return;
  }
  const instr = await mirror.r.tryOne<readonly [number, bigint]>(mirror.sender, `auth:${authId}`, `its instruction record on chain ${dst}`, 'getRepatriationInstruction', [base.deps.diamond, authId]);
  if (instr === undefined) return;
  // The mirror's own record of this id's execution and ACK, asked for by id.
  const ml = await deps.ledger.matching(mirror.deps.chainId, ['RepatriationExecuted', 'RepatriationCancelAckDispatched'], 'authId', [String(authId)]);
  if (ml === null) {
    mirror.sender.noteUnread(`auth:${authId}`, 'the mirror\'s event ledger');
    return;
  }
  const key = `${base.deps.diamond.toLowerCase()}:${authId}`;
  let executedAt = 0;
  let ackAt = 0;
  for (const row of ml) {
    if (asAddr(row.args.issuingBase) !== base.deps.diamond.toLowerCase()) continue;
    if (row.kind === 'RepatriationExecuted') executedAt = Math.max(executedAt, row.blockAt);
    else ackAt = Math.max(ackAt, row.blockAt);
  }
  const ownAck = (await deps.records.get(mirror.deps.chainId, mirror.deps.diamond, [RECORD_ACK(base.deps.diamond, authId)])).get(RECORD_ACK(base.deps.diamond, authId));
  const state: RepatState = {
    authId,
    dstChainId: dst,
    amount,
    baseStatus: AUTH_PENDING,
    mirrorState: Number(instr[0]),
    instructionSentAt,
    executedAt: executedAt || null,
    ackSentAt: Math.max(ackAt, ownAck ?? 0) || null,
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
      const res = await sendRecorded(base, deps, RECORD_INSTRUCTION(authId), () =>
        base.sender.call('instruction', `authorization ${authId}`, 'sendRepatriationInstruction', [authId, deps.keeper], fee),
      );
      if (res === 'landed') base.report.dispatched.push(String(authId));
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
      const res = await sendRecorded(mirror, deps, RECORD_ACK(base.deps.diamond, authId), () =>
        mirror.sender.call('ack', `authorization ${authId}`, 'sendRepatriationCancelAck', [base.deps.diamond, authId, deps.keeper], fee),
      );
      if (res === 'landed') mirror.report.acked.push(String(authId));
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
  // No view lists the stranded records, so the ledger nominates them, from
  // both events that make one (STRANDED_EVENTS): LEDGER_PAGE
  // rows a run, from where the last run stopped and wrapping round, above a
  // stored floor every row before which has been returned in full. A read of
  // the oldest rows only would never reach a later quarantine (the Codex
  // #2993 r2 rule).
  const cursors = deps.cursors(mirror.deps.chainId, mirror.deps.diamond);
  const stored = await cursors.get([STRANDED_FLOOR_ITEM, STRANDED_NEXT_ITEM]);
  const floor = decodePos(stored.get(STRANDED_FLOOR_ITEM));
  const next = decodePos(stored.get(STRANDED_NEXT_ITEM));
  const start = next !== null && (floor === null || posAfter(next, floor)) ? next : floor;
  const ledger = await deps.ledger.page(mirror.deps.chainId, STRANDED_EVENTS, start, LEDGER_PAGE);
  if (ledger === null) {
    mirror.sender.noteUnread('stranded', 'the event ledger');
    return;
  }
  const last = ledger.rows[ledger.rows.length - 1];
  // Past the last page the next run starts at the floor again.
  const nextPos = ledger.more && last !== undefined ? encodePos(last) : '';
  if (nextPos !== (stored.get(STRANDED_NEXT_ITEM) ?? '')) await cursors.put(STRANDED_NEXT_ITEM, nextPos);
  const keys = new Map<string, { remitter: Address; remitId: bigint }>();
  const rowKey: (string | null)[] = [];
  for (const row of ledger.rows) {
    const remitId = asBig(row.args.remitId);
    const remitter = asAddr(row.args.remitter);
    if (remitId === null || !/^0x[0-9a-f]{40}$/.test(remitter)) {
      rowKey.push(null);
      continue;
    }
    const k = `${remitter}:${remitId}`;
    rowKey.push(k);
    keys.set(k, { remitter: remitter as Address, remitId });
  }
  const returned = new Set<string>();
  // On a page read from the floor, the floor moves past the leading rows whose
  // quarantine is returned in full, or which nominate nothing, at the head AND
  // at the finalized block (Codex #2993 r4): a return a reorg undoes leaves
  // its row above the floor, to be returned again. At the finalized block the
  // row's own quarantine must be finalized too: an empty record before the
  // quarantine was made is not a return (Codex #3002).
  const liftFloor = async () => {
    if (start !== floor) return;
    const positions = ledger.rows.map((_, i) => i);
    const doneAtHead = (i: number) => rowKey[i] === null || returned.has(rowKey[i]!);
    const n = await finalFloor(0, positions, doneAtHead, mirror.r.finalized, async (passed, block) => {
      const named = passed.filter((i) => rowKey[i] !== null && ledger.rows[i].block <= Number(block.number));
      const at = await mirror.r.many(named.map((i) => ({ functionName: 'getStrandedRecovery', args: [keys.get(rowKey[i]!)!.remitter, keys.get(rowKey[i]!)!.remitId] })), 'stranded-final', block.number);
      const done = new Set(passed.filter((i) => rowKey[i] === null));
      named.forEach((i, j) => {
        if ((at[j] as StrandedRecord | undefined)?.amount === 0n) done.add(i);
      });
      return done;
    });
    if (n > 0) await cursors.put(STRANDED_FLOOR_ITEM, encodePos(ledger.rows[n - 1]));
  };
  if (keys.size === 0) {
    await liftFloor();
    return;
  }
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
    if (rec.amount === 0n) {
      returned.add(`${remitter}:${remitId}`);
      continue;
    }
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
  await liftFloor();
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

const encodePos = (p: LedgerPos) => `${p.block}:${p.log}`;
function decodePos(raw: string | undefined): LedgerPos | null {
  const m = raw === undefined ? null : /^(\d+):(\d+)$/.exec(raw);
  return m === null ? null : { block: Number(m[1]), log: Number(m[2]) };
}
const posAfter = (a: LedgerPos, b: LedgerPos) => a.block > b.block || (a.block === b.block && a.log > b.log);

// ─── Production seams ──────────────────────────────────────────────────────

/** The shared indexer's event ledger (`activity_events`). */
export function d1Ledger(db: D1Database): ReturnLedger {
  type Row = { kind: string; args_json: string; block_at: number; block_number: number; log_index: number };
  const decode = (all: readonly Row[]): LedgerRow[] =>
    all.map((r) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(r.args_json) as Record<string, unknown>;
      } catch {
        // An unreadable row nominates nothing, and still holds its place, so
        // a page past it does not stop at it.
      }
      return { kind: r.kind, args, blockAt: Number(r.block_at), block: Number(r.block_number), log: Number(r.log_index) };
    });
  return {
    async matching(chainId, kinds, arg, values) {
      if (values.length === 0) return [];
      try {
        const k = kinds.map((_, i) => `?${i + 3}`).join(', ');
        const v = values.map((_, i) => `?${i + 3 + kinds.length}`).join(', ');
        const rows = await db
          .prepare(
            `SELECT kind, args_json, block_at, block_number, log_index FROM activity_events
              WHERE chain_id = ?1 AND block_number >= ?2 AND kind IN (${k})
                AND CAST(json_extract(args_json, '$.${arg.replace(/[^A-Za-z0-9_]/g, '')}') AS TEXT) IN (${v})
              ORDER BY block_number ASC, log_index ASC`,
          )
          .bind(chainId, deploymentFloor(chainId), ...kinds, ...values)
          .all<Row>();
        return decode(rows.results ?? []);
      } catch {
        return null;
      }
    },
    async page(chainId, kinds, after, limit) {
      try {
        const k = kinds.map((_, i) => `?${i + 5}`).join(', ');
        const rows = await db
          .prepare(
            `SELECT kind, args_json, block_at, block_number, log_index FROM activity_events
              WHERE chain_id = ?1 AND block_number >= ?2 AND kind IN (${k})
                AND (block_number > ?3 OR (block_number = ?3 AND log_index > ?4))
              ORDER BY block_number ASC, log_index ASC
              LIMIT ${limit + 1}`,
          )
          .bind(chainId, deploymentFloor(chainId), after?.block ?? -1, after?.log ?? -1, ...kinds)
          .all<Row>();
        const all = rows.results ?? [];
        return { rows: decode(all.slice(0, limit)), more: all.length > limit };
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
