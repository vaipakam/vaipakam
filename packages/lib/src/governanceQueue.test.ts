/**
 * #3237 — the governance queue reader proves every call it reports against
 * the id the timelock stores, and says so when it cannot.
 */
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAbiItem, getAddress, keccak256, toFunctionSelector, toHex, type Abi, type Address, type Hex } from 'viem';
import { DIAMOND_ABI_VIEM, VaipakamTimelockABI } from '@vaipakam/contracts/abis';
import {
  CALL_SALT_EVENT,
  CALL_SCHEDULED_EVENT,
  GOVERNANCE_TIMELOCK_READ_ABI,
  describeGovernanceCall,
  englishSummary,
  firstBlockAtOrAfter,
  hashOperation,
  hashOperationBatch,
  readGovernanceQueue,
  roleName,
  type GovernanceCall,
} from './governanceQueue';

const TIMELOCK = '0x00000000000000000000000000000000000071c0' as Address;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Address;
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const GENESIS = 1_800_000_000n;
const BLOCK_TIME = 2n;
const HEAD = 100_000n;
const MIN_DELAY = 172_800n; // 48h = 86_400 blocks at 2s

const tsOf = (n: bigint) => GENESIS + n * BLOCK_TIME;

interface Scheduled {
  id: Hex;
  index: bigint;
  call: GovernanceCall;
  predecessor: Hex;
  delay: bigint;
  block: bigint;
  tx: Hex;
  logIndex: number;
}
interface Salt {
  id: Hex;
  salt: Hex;
  block: bigint;
  tx: Hex;
}

function fakeChain(opts: { pending: { id: Hex; eta: bigint; ready: boolean }[]; scheduled: Scheduled[]; salts?: Salt[] }) {
  const calls = { getLogs: 0, getBlock: 0, ranges: [] as [bigint, bigint][] };
  const client = {
    async getBlock(args: { blockNumber?: bigint; blockTag?: string }) {
      calls.getBlock++;
      const n = args.blockNumber ?? HEAD;
      return { number: n, timestamp: tsOf(n) };
    },
    async readContract(args: { functionName: string; args?: readonly unknown[] }) {
      if (args.functionName === 'getPendingProposalsCount') return BigInt(opts.pending.length);
      if (args.functionName === 'getMinDelay') return MIN_DELAY;
      if (args.functionName === 'getPendingProposals') {
        const [offset, limit] = args.args as [number, number];
        return opts.pending.slice(offset, offset + limit);
      }
      throw new Error(`unexpected read ${args.functionName}`);
    },
    async getLogs(args: { event: { name: string }; args: { id: Hex }; fromBlock: bigint; toBlock: bigint }) {
      calls.getLogs++;
      if (args.toBlock - args.fromBlock + 1n > 2000n) throw new Error('range too wide');
      calls.ranges.push([args.fromBlock, args.toBlock]);
      const inRange = (b: bigint) => b >= args.fromBlock && b <= args.toBlock;
      if (args.event.name === 'CallScheduled') {
        return opts.scheduled
          .filter((s) => s.id === args.args.id && inRange(s.block))
          .map((s) => ({
            args: { id: s.id, index: s.index, target: s.call.target, value: s.call.value, data: s.call.data, predecessor: s.predecessor, delay: s.delay },
            blockNumber: s.block,
            transactionHash: s.tx,
            logIndex: s.logIndex,
          }));
      }
      return (opts.salts ?? [])
        .filter((s) => s.id === args.args.id && inRange(s.block))
        .map((s) => ({ args: { id: s.id, salt: s.salt }, blockNumber: s.block, transactionHash: s.tx, logIndex: 0 }));
    },
  };
  return { client: client as never, calls };
}

const pauseCall: GovernanceCall = { target: DIAMOND, value: 0n, data: encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'pause' }) };
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

describe('the read ABI', () => {
  it('matches the committed VaipakamTimelock ABI', () => {
    for (const name of ['getPendingProposalsCount', 'getPendingProposals', 'getMinDelay'] as const) {
      const ours = getAbiItem({ abi: GOVERNANCE_TIMELOCK_READ_ABI, name });
      const theirs = getAbiItem({ abi: VaipakamTimelockABI as Abi, name });
      expect(toFunctionSelector(ours as never)).toBe(toFunctionSelector(theirs as never));
    }
    for (const ev of [CALL_SCHEDULED_EVENT, CALL_SALT_EVENT]) {
      const theirs = getAbiItem({ abi: VaipakamTimelockABI as Abi, name: ev.name }) as unknown as { inputs: unknown[] };
      expect(JSON.stringify(ev.inputs.map((i) => [i.name, i.type, (i as { indexed?: boolean }).indexed === true]))).toBe(
        JSON.stringify((theirs.inputs as { name: string; type: string; indexed: boolean }[]).map((i) => [i.name, i.type, i.indexed])),
      );
    }
  });
});

describe('firstBlockAtOrAfter', () => {
  it('finds the exact block on regular and irregular block times', async () => {
    const irregular = (n: bigint) => 1_000n + n * 3n + (n % 7n === 0n ? 0n : 1n);
    for (const time of [tsOf, irregular]) {
      const client = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: time(blockNumber) }) };
      for (const target of [5n, 12_345n, 99_998n]) {
        const ts = time(target);
        const got = await firstBlockAtOrAfter(client as never, ts, 0n, HEAD);
        expect(time(got)).toBeGreaterThanOrEqual(ts);
        if (got > 0n) expect(time(got - 1n)).toBeLessThan(ts);
      }
    }
  });
});

describe('readGovernanceQueue', () => {
  it('proves a single call scheduled with the minimum delay from one window', async () => {
    const block = 10_000n;
    const id = hashOperation(pauseCall, ZERO32, ZERO32);
    const eta = tsOf(block) + MIN_DELAY;
    const { client, calls } = fakeChain({
      pending: [{ id, eta, ready: false }],
      scheduled: [{ id, index: 0n, call: pauseCall, predecessor: ZERO32, delay: MIN_DELAY, block, tx: tx(1), logIndex: 3 }],
    });
    const q = await readGovernanceQueue(client, TIMELOCK, { maxLogRange: 2000, fromBlock: 0n });
    expect(q.block.number).toBe(HEAD);
    expect(q.minDelay).toBe(MIN_DELAY);
    expect(q.operations).toHaveLength(1);
    const d = q.operations[0].details;
    expect(d.kind).toBe('proved');
    if (d.kind === 'proved') {
      expect(d.form).toBe('single');
      expect(d.calls).toEqual([pauseCall]);
      expect(d.scheduledBlock).toBe(block);
    }
    expect(calls.getLogs).toBe(2); // one window: the schedule and salt reads
  });

  it('proves a batch with a salt', async () => {
    const block = 20_000n;
    const salt = `0x${'ab'.repeat(32)}` as Hex;
    const second: GovernanceCall = { target: DIAMOND, value: 0n, data: encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'unpause' }) };
    const id = hashOperationBatch([pauseCall, second], ZERO32, salt);
    const { client } = fakeChain({
      pending: [{ id, eta: tsOf(block) + MIN_DELAY, ready: true }],
      scheduled: [
        { id, index: 1n, call: second, predecessor: ZERO32, delay: MIN_DELAY, block, tx: tx(2), logIndex: 5 },
        { id, index: 0n, call: pauseCall, predecessor: ZERO32, delay: MIN_DELAY, block, tx: tx(2), logIndex: 4 },
      ],
      salts: [{ id, salt, block, tx: tx(2) }],
    });
    const q = await readGovernanceQueue(client, TIMELOCK, { maxLogRange: 2000, fromBlock: 0n });
    const d = q.operations[0].details;
    expect(d.kind === 'proved' && d.form).toBe('batch');
    expect(d.kind === 'proved' && d.calls).toEqual([pauseCall, second]);
    expect(q.operations[0].ready).toBe(true);
  });

  it('walks back to an operation scheduled with a longer delay', async () => {
    const block = 3_000n;
    const delay = MIN_DELAY + 3_600n * 2n; // 7_200 s = 3_600 blocks further back
    const id = hashOperation(pauseCall, ZERO32, ZERO32);
    const { client } = fakeChain({
      pending: [{ id, eta: tsOf(block) + delay, ready: false }],
      scheduled: [{ id, index: 0n, call: pauseCall, predecessor: ZERO32, delay, block, tx: tx(3), logIndex: 0 }],
    });
    const q = await readGovernanceQueue(client, TIMELOCK, { maxLogRange: 2000, fromBlock: 0n });
    expect(q.operations[0].details.kind).toBe('proved');
  });

  it('refuses logs that do not hash to the stored id', async () => {
    const block = 10_000n;
    const id = hashOperation(pauseCall, ZERO32, ZERO32);
    const forged: GovernanceCall = { ...pauseCall, data: encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'unpause' }) };
    const { client } = fakeChain({
      pending: [{ id, eta: tsOf(block) + MIN_DELAY, ready: false }],
      scheduled: [{ id, index: 0n, call: forged, predecessor: ZERO32, delay: MIN_DELAY, block, tx: tx(4), logIndex: 0 }],
    });
    const q = await readGovernanceQueue(client, TIMELOCK, { maxLogRange: 2000, fromBlock: 0n, maxWindowsPerOperation: 2 });
    const d = q.operations[0].details;
    expect(d.kind === 'unknown' && d.reason).toBe('unproved');
  });

  it('lists an operation it cannot find, with what it searched', async () => {
    const id = `0x${'cd'.repeat(32)}` as Hex;
    const { client } = fakeChain({ pending: [{ id, eta: tsOf(50_000n) + MIN_DELAY, ready: false }], scheduled: [] });
    const q = await readGovernanceQueue(client, TIMELOCK, { maxLogRange: 2000, fromBlock: 0n, maxWindowsPerOperation: 3 });
    expect(q.operations).toHaveLength(1);
    const d = q.operations[0].details;
    expect(d.kind === 'unknown' && d.reason).toBe('not-found');
    expect(d.kind === 'unknown' && d.searched.length).toBe(3);
  });

  it('uses a hint first and still proves it', async () => {
    const block = 1_000n;
    const delay = MIN_DELAY + 1_000_000n; // far outside the walk-back
    const id = hashOperation(pauseCall, ZERO32, ZERO32);
    const { client, calls } = fakeChain({
      pending: [{ id, eta: tsOf(block) + delay, ready: false }],
      scheduled: [{ id, index: 0n, call: pauseCall, predecessor: ZERO32, delay, block, tx: tx(5), logIndex: 0 }],
    });
    const q = await readGovernanceQueue(client, TIMELOCK, { maxLogRange: 2000, fromBlock: 0n, hints: new Map([[id, block]]) });
    expect(q.operations[0].details.kind).toBe('proved');
    expect(calls.getLogs).toBe(2);
  });

  it('orders the queue soonest first and reads past one page', async () => {
    const ids = Array.from({ length: 3 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex);
    const { client } = fakeChain({
      pending: [
        { id: ids[0], eta: 900n, ready: false },
        { id: ids[1], eta: 100n, ready: false },
        { id: ids[2], eta: 500n, ready: false },
      ],
      scheduled: [],
    });
    const q = await readGovernanceQueue(client, TIMELOCK, { maxLogRange: 2000, fromBlock: 0n, pageSize: 2, maxWindowsPerOperation: 1 });
    expect(q.operations.map((o) => o.eta)).toEqual([100n, 500n, 900n]);
  });
});

describe('describeGovernanceCall', () => {
  const targets = [
    { key: 'diamond', address: DIAMOND, abi: DIAMOND_ABI_VIEM },
    { key: 'timelock', address: TIMELOCK, abi: VaipakamTimelockABI as Abi },
  ];

  it('names a protocol role and the account', () => {
    const account = '0x00000000000000000000000000000000000000aa' as Address;
    const PAUSER = keccak256(toHex('PAUSER_ROLE'));
    expect(roleName(PAUSER)).toBe('PAUSER_ROLE');
    const d = describeGovernanceCall(
      { target: DIAMOND, value: 0n, data: encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'grantRole', args: [PAUSER, account] }) },
      targets,
    );
    expect(d.action).toEqual({ kind: 'role', change: 'grant', role: 'PAUSER_ROLE', account: getAddress(account) });
    expect(englishSummary(d)).toBe(`Grants PAUSER_ROLE to ${getAddress(account)} on the diamond.`);
  });

  it('counts a diamond cut', () => {
    const facet = '0x00000000000000000000000000000000000000fa' as Address;
    const data = encodeFunctionData({
      abi: DIAMOND_ABI_VIEM,
      functionName: 'diamondCut',
      args: [
        [
          { facetAddress: facet, action: 0, functionSelectors: ['0x11111111', '0x22222222'] },
          { facetAddress: facet, action: 1, functionSelectors: ['0x33333333'] },
        ],
        '0x0000000000000000000000000000000000000000',
        '0x',
      ],
    });
    const d = describeGovernanceCall({ target: DIAMOND, value: 0n, data }, targets);
    expect(d.action).toMatchObject({ kind: 'diamond-cut', add: 2, replace: 1, remove: 0, facets: 2 });
  });

  it('decodes the timelock calling itself', () => {
    const data = encodeFunctionData({ abi: VaipakamTimelockABI as Abi, functionName: 'updateDelay', args: [259_200n] });
    const d = describeGovernanceCall({ target: TIMELOCK, value: 0n, data }, targets);
    expect(d.action).toEqual({ kind: 'delay', newDelay: 259_200n });
  });

  it('says when a call cannot be decoded, never guessing', () => {
    const stranger = '0x00000000000000000000000000000000000000ee' as Address;
    const d = describeGovernanceCall({ target: stranger, value: 5n, data: pauseCall.data }, targets);
    expect(d.targetKey).toBeNull();
    expect(d.functionName).toBeNull();
    expect(d.action).toEqual({ kind: 'undecoded' });
    expect(englishSummary(d)).toContain('could not be decoded');
    const junk = describeGovernanceCall({ target: DIAMOND, value: 0n, data: '0xdeadbeef' }, targets);
    expect(junk.action).toEqual({ kind: 'undecoded' });
  });
});
