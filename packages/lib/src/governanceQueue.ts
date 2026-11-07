/**
 * #3237 — the governance timelock's queue, read from the chain.
 *
 * While a governance change waits out the timelock's delay, users and the
 * canceller can react. They can only do that if someone shows them the
 * change. This module is the one reader both consumers use: the public
 * "queued changes" page and the ops alert. It reads in three steps.
 *
 * 1. **The queue itself comes from contract storage.** `VaipakamTimelock`
 *    keeps an on-chain list of operations that are scheduled and not yet
 *    executed or cancelled (`getPendingProposals`). Every read in one call
 *    is pinned to one block, so the list, the delay and the readiness flags
 *    all describe the same moment.
 * 2. **What each operation will do comes from its `CallScheduled` logs.**
 *    The timelock stores only an operation's id and its earliest execution
 *    time, not the call. So the reader finds the block the operation was
 *    scheduled in and reads that block range's logs, filtered by the id.
 *    The schedule time is `eta - delay`. The delay is read from the chain,
 *    so the first window tried is the one that holds an operation scheduled
 *    with the current minimum delay, which is how governance normally
 *    schedules. A caller may also pass the block it already knows (an
 *    indexer's row, say). Either way the block is only a HINT.
 * 3. **Every call it reports is proved against the id stored on chain.**
 *    The id is the hash of the calls, the predecessor and the salt, so the
 *    reader recomputes it from the logs it found. Logs that do not hash to
 *    the id are refused, never shown. So a wrong hint, a stale index or an
 *    endpoint returning the wrong logs can make an operation's details
 *    unknown, but cannot make them wrong.
 *
 * An operation whose logs were not found is still listed, with its id and
 * time, and with the reason its action is unknown. It is never dropped:
 * the list must say everything that is queued.
 *
 * Decoding a call into words is a separate step, `describeGovernanceCall`,
 * so this file keeps no dependency on `@vaipakam/contracts`: the ABIs are
 * the caller's to supply (the same convention as `staticReturn`).
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseAbiItem,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

/** The parts of `VaipakamTimelock`'s interface this reader uses. They are
 *  OpenZeppelin's `TimelockController` shapes plus the pending list. The
 *  package test pins them to the committed ABI. */
export const GOVERNANCE_TIMELOCK_READ_ABI = parseAbi([
  'function getPendingProposalsCount() view returns (uint256)',
  'function getPendingProposals(uint32 offset, uint32 limit) view returns ((bytes32 id, uint256 eta, bool ready)[] page)',
  'function getMinDelay() view returns (uint256)',
  'function MIN_DELAY_FLOOR() view returns (uint256)',
  'function isOperationDone(bytes32 id) view returns (bool)',
]);

export const CALL_SCHEDULED_EVENT = parseAbiItem(
  'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
);
export const CALL_SALT_EVENT = parseAbiItem('event CallSalt(bytes32 indexed id, bytes32 salt)');

const ZERO32: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** One call of a queued operation. */
export interface GovernanceCall {
  target: Address;
  value: bigint;
  data: Hex;
}

/** What is known about what a queued operation will do. */
export type QueuedOperationDetails =
  | {
      kind: 'proved';
      /** Single-call `schedule`, or a `scheduleBatch` of these calls. */
      form: 'single' | 'batch';
      calls: GovernanceCall[];
      predecessor: Hex;
      /** Whether the predecessor has run, read at the queue's block: the
       *  timelock refuses to run this operation until it has. `null` when
       *  there is no predecessor (it is zero). */
      predecessorDone: boolean | null;
      salt: Hex;
      /** The delay it was scheduled with, in seconds. */
      delay: bigint;
      scheduledBlock: bigint;
      scheduledTx: Hex;
    }
  | {
      kind: 'unknown';
      /**
       * `not-found`: no schedule logs for this id in the ranges searched.
       * `unproved`: logs were found, but they do not hash to the id the
       * timelock stores, so they are not shown.
       * `read-failed`: the log read itself failed.
       */
      reason: 'not-found' | 'unproved' | 'read-failed';
      /** The block ranges searched, so the gap can be closed by hand. */
      searched: ReadonlyArray<{ fromBlock: bigint; toBlock: bigint }>;
    };

export interface QueuedOperation {
  id: Hex;
  /** Earliest execution time, unix seconds, as the timelock stores it. */
  eta: bigint;
  /** The timelock's own answer: the delay has passed and it has not run. */
  ready: boolean;
  details: QueuedOperationDetails;
}

export interface GovernanceQueue {
  timelock: Address;
  /** The block every value here was read at. */
  block: { number: bigint; timestamp: bigint };
  /** The timelock's current minimum delay, in seconds. */
  minDelay: bigint;
  operations: QueuedOperation[];
}

export interface ReadGovernanceQueueOptions {
  /** Widest `eth_getLogs` range the endpoint allows, in blocks, both ends
   *  included (the RPC proxy's `RPC_PROXY_MAX_LOG_RANGE_BLOCKS`). */
  maxLogRange: number;
  /** The first block worth searching: the timelock's deploy block. */
  fromBlock: bigint;
  /** How many log windows one operation may cost, beyond a hint, when its
   *  schedule block has to be searched for. Default 8. */
  maxWindowsPerOperation?: number;
  /** Blocks the caller already believes each operation was scheduled in. */
  hints?: ReadonlyMap<Hex, bigint>;
  /** Page size for `getPendingProposals`. Default 50. */
  pageSize?: number;
}

/** The operation id OpenZeppelin's timelock computes for `schedule`. */
export function hashOperation(call: GovernanceCall, predecessor: Hex, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [call.target, call.value, call.data, predecessor, salt],
    ),
  );
}

/** The operation id OpenZeppelin's timelock computes for `scheduleBatch`. */
export function hashOperationBatch(calls: readonly GovernanceCall[], predecessor: Hex, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address[]' }, { type: 'uint256[]' }, { type: 'bytes[]' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [calls.map((c) => c.target), calls.map((c) => c.value), calls.map((c) => c.data), predecessor, salt],
    ),
  );
}

/**
 * The first block at or after `lo` whose timestamp is at least `ts`, found
 * by interpolation (block times are regular enough that it settles in a few
 * reads) with bisection whenever an estimate fails to halve the interval.
 * Returns `hi` when no earlier block qualifies.
 */
export async function firstBlockAtOrAfter(
  client: Pick<PublicClient, 'getBlock'>,
  ts: bigint,
  lo: bigint,
  hi: bigint,
): Promise<bigint> {
  const timeOf = async (n: bigint) => (await client.getBlock({ blockNumber: n })).timestamp;
  let loTs = await timeOf(lo);
  if (loTs >= ts) return lo;
  let hiTs = await timeOf(hi);
  if (hiTs < ts) return hi;
  // Invariant: timestamp(lo) < ts <= timestamp(hi).
  for (let i = 0; i < 96 && hi - lo > 1n; i++) {
    const width = hi - lo;
    let mid = hiTs > loTs ? lo + ((ts - loTs) * width) / (hiTs - loTs) : lo + width / 2n;
    if (i % 2 === 1) mid = lo + width / 2n; // alternate, so a bad estimate cannot stall
    if (mid <= lo) mid = lo + 1n;
    if (mid >= hi) mid = hi - 1n;
    const midTs = await timeOf(mid);
    if (midTs >= ts) {
      hi = mid;
      hiTs = midTs;
    } else {
      lo = mid;
      loTs = midTs;
    }
  }
  return hi;
}

type ScheduledLog = { index: bigint; call: GovernanceCall; predecessor: Hex; delay: bigint; block: bigint; tx: Hex; logIndex: number };

/** Prove one transaction's logs against the stored id. */
function prove(id: Hex, logs: ScheduledLog[], salt: Hex): QueuedOperationDetails | null {
  const sorted = [...logs].sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  // The indices must be 0..n-1 with no gap or repeat, all sharing one predecessor.
  if (sorted.some((l, i) => l.index !== BigInt(i))) return null;
  const predecessor = sorted[0].predecessor;
  if (sorted.some((l) => l.predecessor !== predecessor || l.delay !== sorted[0].delay)) return null;
  const calls = sorted.map((l) => l.call);
  const base = { calls, predecessor, predecessorDone: null, salt, delay: sorted[0].delay, scheduledBlock: sorted[0].block, scheduledTx: sorted[0].tx } as const;
  if (calls.length === 1 && hashOperation(calls[0], predecessor, salt) === id) return { kind: 'proved', form: 'single', ...base };
  if (hashOperationBatch(calls, predecessor, salt) === id) return { kind: 'proved', form: 'batch', ...base };
  return null;
}

/** Read one window's schedule logs for `id` and try to prove them. */
async function tryWindow(
  client: Pick<PublicClient, 'getLogs' | 'getBlock'>,
  timelock: Address,
  op: { id: Hex; eta: bigint },
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ found: false } | { found: true; details: QueuedOperationDetails | null }> {
  const id = op.id;
  const [scheduled, salts] = await Promise.all([
    client.getLogs({ address: timelock, event: CALL_SCHEDULED_EVENT, args: { id }, fromBlock, toBlock }),
    client.getLogs({ address: timelock, event: CALL_SALT_EVENT, args: { id }, fromBlock, toBlock }),
  ]);
  if (scheduled.length === 0) return { found: false };
  // The same id can be scheduled again after a cancel, so group by
  // transaction and try the latest first: the queue holds the live one.
  const byTx = new Map<Hex, ScheduledLog[]>();
  for (const l of scheduled) {
    const a = l.args;
    if (a.index === undefined || !a.target || a.value === undefined || !a.data || !a.predecessor || a.delay === undefined) continue;
    if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
    const entry: ScheduledLog = {
      index: a.index,
      call: { target: a.target, value: a.value, data: a.data },
      predecessor: a.predecessor,
      delay: a.delay,
      block: l.blockNumber,
      tx: l.transactionHash,
      logIndex: l.logIndex,
    };
    const list = byTx.get(l.transactionHash) ?? [];
    list.push(entry);
    byTx.set(l.transactionHash, list);
  }
  const txs = [...byTx.entries()].sort((a, b) => {
    const x = a[1][0];
    const y = b[1][0];
    return x.block === y.block ? y.logIndex - x.logIndex : x.block < y.block ? 1 : -1;
  });
  for (const [tx, logs] of txs) {
    // OpenZeppelin emits CallSalt only for a non-zero salt.
    const saltLog = salts.find((s) => s.transactionHash === tx);
    const salt = (saltLog?.args.salt as Hex | undefined) ?? ZERO32;
    const details = prove(id, logs, salt);
    if (!details || details.kind !== 'proved') continue;
    // The calls hash to the id, but an id is the same every time the same
    // calls are scheduled, so a cancelled earlier scheduling proves the calls
    // and not this one's delay, block or transaction. The live scheduling is
    // the one the stored time came from: OpenZeppelin sets
    // eta = schedule block's timestamp + delay.
    const at = await client.getBlock({ blockNumber: details.scheduledBlock });
    if (at.timestamp + details.delay === op.eta) return { found: true, details };
    return { found: false };
  }
  return { found: true, details: null };
}

/** Find and prove what one queued operation will do. */
async function detailsFor(
  client: Pick<PublicClient, 'getBlock' | 'getLogs'>,
  timelock: Address,
  op: { id: Hex; eta: bigint },
  delays: { current: bigint; floor: bigint },
  head: bigint,
  opts: ReadGovernanceQueueOptions,
): Promise<QueuedOperationDetails> {
  const range = BigInt(Math.max(1, Math.floor(opts.maxLogRange)));
  const searched: { fromBlock: bigint; toBlock: bigint }[] = [];
  let sawUnproved = false;
  const clip = (from: bigint): { fromBlock: bigint; toBlock: bigint } | null => {
    const fromBlock = from < opts.fromBlock ? opts.fromBlock : from;
    if (fromBlock > head) return null;
    const end = fromBlock + range - 1n;
    return { fromBlock, toBlock: end > head ? head : end };
  };
  const attempt = async (w: { fromBlock: bigint; toBlock: bigint } | null): Promise<QueuedOperationDetails | null> => {
    if (!w || searched.some((s) => s.fromBlock === w.fromBlock && s.toBlock === w.toBlock)) return null;
    searched.push(w);
    const r = await tryWindow(client, timelock, op, w.fromBlock, w.toBlock);
    if (!r.found) return null;
    if (r.details) return r.details;
    sawUnproved = true;
    return null;
  };

  try {
    const hint = opts.hints?.get(op.id);
    if (hint !== undefined) {
      const d = await attempt(clip(hint - range / 2n));
      if (d) return d;
    }
    // An operation was scheduled at exactly `eta - delay`, where the delay
    // is at least the minimum in force then, and never below the floor the
    // timelock was deployed with. The two exact candidates are the current
    // minimum (how governance normally schedules) and the floor (the minimum
    // until it is raised, so an operation queued before a raise). Any longer
    // delay puts the schedule earlier than the floor's candidate, so the
    // bounded walk goes back from there.
    const at = (delay: bigint) => firstBlockAtOrAfter(client, op.eta > delay ? op.eta - delay : 0n, opts.fromBlock, head);
    const d1 = await attempt(clip(await at(delays.current)));
    if (d1) return d1;
    let start = await at(delays.floor);
    const windows = opts.maxWindowsPerOperation ?? 8;
    for (let i = 0; i < windows; i++) {
      const d = await attempt(clip(start));
      if (d) return d;
      if (start <= opts.fromBlock) break;
      start = start - range;
    }
  } catch {
    return { kind: 'unknown', reason: 'read-failed', searched };
  }
  return { kind: 'unknown', reason: sawUnproved ? 'unproved' : 'not-found', searched };
}

/** Read the governance timelock's queue at one block, each operation's
 *  action proved against its stored id or stated as unknown. */
export async function readGovernanceQueue(
  client: Pick<PublicClient, 'getBlock' | 'getLogs' | 'readContract'>,
  timelock: Address,
  opts: ReadGovernanceQueueOptions,
): Promise<GovernanceQueue> {
  const latest = await client.getBlock({ blockTag: 'latest' });
  const blockNumber = latest.number;
  if (blockNumber === null) throw new Error('governance queue: the latest block has no number');
  const read = <T>(
    functionName: 'getPendingProposalsCount' | 'getMinDelay' | 'MIN_DELAY_FLOOR' | 'getPendingProposals' | 'isOperationDone',
    args?: readonly unknown[],
  ) =>
    client.readContract({ address: timelock, abi: GOVERNANCE_TIMELOCK_READ_ABI, functionName, args, blockNumber } as never) as Promise<T>;

  const [count, minDelay, floor] = await Promise.all([
    read<bigint>('getPendingProposalsCount'),
    read<bigint>('getMinDelay'),
    read<bigint>('MIN_DELAY_FLOOR'),
  ]);
  const pageSize = opts.pageSize ?? 50;
  const pending: { id: Hex; eta: bigint; ready: boolean }[] = [];
  for (let offset = 0; BigInt(offset) < count; offset += pageSize) {
    const page = await read<readonly { id: Hex; eta: bigint; ready: boolean }[]>('getPendingProposals', [offset, pageSize]);
    pending.push(...page);
    if (page.length < pageSize) break;
  }

  const operations: QueuedOperation[] = [];
  for (const op of pending) {
    const details = await detailsFor(client, timelock, op, { current: minDelay, floor }, blockNumber, opts);
    // The timelock runs an operation only after its predecessor has run, so
    // an elapsed delay alone does not make it runnable.
    if (details.kind === 'proved' && details.predecessor !== ZERO32) {
      details.predecessorDone = await read<boolean>('isOperationDone', [details.predecessor]);
    }
    operations.push({ ...op, details });
  }
  // Soonest first: the change that can run next leads.
  operations.sort((a, b) => (a.eta < b.eta ? -1 : a.eta > b.eta ? 1 : 0));
  return { timelock, block: { number: blockNumber, timestamp: latest.timestamp }, minDelay, operations };
}

// ─── Describing a call ───────────────────────────────────────────────────

/** Role names the protocol's contracts declare, by their hash. */
const ROLE_NAMES = [
  'ADMIN_ROLE',
  'PAUSER_ROLE',
  'UNPAUSER_ROLE',
  'KYC_ADMIN_ROLE',
  'ORACLE_ADMIN_ROLE',
  'RISK_ADMIN_ROLE',
  'VAULT_ADMIN_ROLE',
  'WATCHER_ROLE',
  'NOTIF_BILLER_ROLE',
  'KEEPER_ROLE',
  'EMERGENCY_REVOKER_ROLE',
  'PROPOSER_ROLE',
  'EXECUTOR_ROLE',
  'CANCELLER_ROLE',
] as const;

const ROLE_BY_HASH: ReadonlyMap<string, string> = new Map<string, string>([
  [ZERO32, 'DEFAULT_ADMIN_ROLE'],
  ...ROLE_NAMES.map((n) => [keccak256(toHex(n)), n] as [string, string]),
]);

/** The name of a role hash, or null when it is not one the protocol declares. */
export function roleName(hash: Hex): string | null {
  return ROLE_BY_HASH.get(hash.toLowerCase()) ?? null;
}

/** A known contract a call may target, as the caller's deployment names it. */
export interface GovernanceTarget {
  /** The deployment's key for it (`diamond`, `timelock`, `vpfiToken`…). */
  key: string;
  address: Address;
  /** The ABI to decode calls to it with; null when the caller has none. */
  abi: Abi | null;
}

export interface DescribedArg {
  name: string;
  type: string;
  /** The value as text: numbers in full, addresses checksummed as given,
   *  a role hash followed by its name where known. */
  value: string;
}

/** What one call will do, in data a surface can put into its own words. */
export interface DescribedCall {
  target: Address;
  /** The deployment key of the target, or null for an address the
   *  deployment does not list. */
  targetKey: string | null;
  /** Native value sent with the call, wei. */
  value: bigint;
  /** The whole calldata, kept so an undecoded call is still shown exactly. */
  data: Hex;
  selector: Hex;
  /** Null when the call could not be decoded against the target's ABI. */
  functionName: string | null;
  args: DescribedArg[];
  /** A recognised kind, for surfaces that phrase the common changes. */
  action:
    | { kind: 'diamond-cut'; add: number; replace: number; remove: number; facets: number; init: Address }
    | { kind: 'role'; change: 'grant' | 'revoke' | 'renounce'; role: string; account: Address }
    | { kind: 'delay'; newDelay: bigint }
    | { kind: 'pause' }
    | { kind: 'unpause' }
    | { kind: 'ownership'; newOwner: Address }
    | { kind: 'upgrade'; implementation: Address }
    | { kind: 'call' }
    /** No calldata: a plain transfer of `value` to the target. */
    | { kind: 'transfer' }
    | { kind: 'undecoded' };
}

function argText(type: string, v: unknown): string {
  if (type === 'bytes32' && typeof v === 'string') {
    const name = roleName(v as Hex);
    return name ? `${v} (${name})` : v;
  }
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v) || (v !== null && typeof v === 'object')) {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  }
  return String(v);
}

/** Decode one queued call against the ABI of the contract it targets. */
export function describeGovernanceCall(call: GovernanceCall, targets: readonly GovernanceTarget[]): DescribedCall {
  const known = targets.find((t) => t.address.toLowerCase() === call.target.toLowerCase()) ?? null;
  const selector = (call.data.length >= 10 ? call.data.slice(0, 10) : call.data) as Hex;
  const base = { target: call.target, targetKey: known?.key ?? null, value: call.value, data: call.data, selector };
  if (call.data === '0x') return { ...base, functionName: null, args: [], action: { kind: 'transfer' } };
  if (!known?.abi) return { ...base, functionName: null, args: [], action: { kind: 'undecoded' } };

  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: known.abi, data: call.data });
  } catch {
    return { ...base, functionName: null, args: [], action: { kind: 'undecoded' } };
  }
  const item = known.abi.find(
    (e) => e.type === 'function' && e.name === decoded.functionName && (e.inputs?.length ?? 0) === (decoded.args?.length ?? 0),
  ) as { inputs: readonly { name?: string; type: string }[] } | undefined;
  const raw = decoded.args ?? [];
  const args: DescribedArg[] = raw.map((v, i) => ({
    name: item?.inputs[i]?.name || `arg${i}`,
    type: item?.inputs[i]?.type ?? 'unknown',
    value: argText(item?.inputs[i]?.type ?? '', v),
  }));
  return { ...base, functionName: decoded.functionName, args, action: actionOf(decoded.functionName, raw) };
}

function actionOf(fn: string, a: readonly unknown[]): DescribedCall['action'] {
  switch (fn) {
    case 'diamondCut': {
      const cuts = (a[0] ?? []) as readonly { action: number; functionSelectors: readonly Hex[] }[];
      const count = (k: number) => cuts.filter((c) => c.action === k).reduce((n, c) => n + c.functionSelectors.length, 0);
      return { kind: 'diamond-cut', add: count(0), replace: count(1), remove: count(2), facets: cuts.length, init: a[1] as Address };
    }
    case 'grantRole':
    case 'revokeRole':
    case 'renounceRole': {
      const hash = a[0] as Hex;
      return {
        kind: 'role',
        change: fn === 'grantRole' ? 'grant' : fn === 'revokeRole' ? 'revoke' : 'renounce',
        role: roleName(hash) ?? hash,
        account: a[1] as Address,
      };
    }
    case 'updateDelay':
      return { kind: 'delay', newDelay: a[0] as bigint };
    case 'pause':
      return { kind: 'pause' };
    case 'unpause':
      return { kind: 'unpause' };
    case 'transferOwnership':
      return { kind: 'ownership', newOwner: a[0] as Address };
    case 'upgradeTo':
    case 'upgradeToAndCall':
      return { kind: 'upgrade', implementation: a[0] as Address };
    default:
      return { kind: 'call' };
  }
}

/** One English line for an ops alert. Surfaces with their own copy (the
 *  app's locales) phrase `action` themselves instead. */
export function englishSummary(d: DescribedCall): string {
  // A native amount leaving the timelock is stated on every call that sends
  // one, whatever the call does, so two calls differing only in it never read
  // the same.
  const sends = d.value > 0n ? ` Sends ${d.value.toString()} wei of the chain's native token from the timelock.` : '';
  return actionSentence(d) + sends;
}

function actionSentence(d: DescribedCall): string {
  const where = d.targetKey ? `the ${d.targetKey}` : `unlisted contract ${d.target}`;
  const a = d.action;
  switch (a.kind) {
    case 'diamond-cut':
      return `Changes the Diamond's code: ${a.add} functions added, ${a.replace} replaced, ${a.remove} removed, across ${a.facets} facet entries${a.init !== '0x0000000000000000000000000000000000000000' ? `, then runs an initializer at ${a.init}` : ''}.`;
    case 'role':
      return `${a.change === 'grant' ? 'Grants' : a.change === 'revoke' ? 'Revokes' : 'Renounces'} ${a.role} ${a.change === 'grant' ? 'to' : 'from'} ${a.account} on ${where}.`;
    case 'delay':
      return `Sets the timelock's minimum delay to ${a.newDelay.toString()} seconds.`;
    case 'pause':
      return `Pauses ${where}.`;
    case 'unpause':
      return `Unpauses ${where}.`;
    case 'ownership':
      return /^0x0{40}$/i.test(a.newOwner)
        ? `Calls transferOwnership with the zero address on ${where}: on a two-step owner this cancels a pending handover.`
        : `Names ${a.newOwner} as the new owner of ${where}; where ownership is two-step, it moves only when that address accepts.`;
    case 'upgrade':
      return `Upgrades ${where} to the implementation at ${a.implementation}.`;
    case 'call':
      return `Calls ${d.functionName}(${d.args.map((x) => `${x.name}=${x.value}`).join(', ')}) on ${where}.`;
    case 'transfer':
      return `Transfers to ${where} with no call.`;
    case 'undecoded':
      return `Calls function ${d.selector} on ${where}; the call could not be decoded (call data ${d.data}).`;
  }
}
