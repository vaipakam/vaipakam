/**
 * #3282 — the vault-beacon upkeep pass: applying the VaultBeacon's
 * permissionless executes (a Timelock proposal, a vault's pin, a vault's
 * pin-delay lowering) once their delay has passed, run against a fake beacon
 * that applies the contract's own admission rules to each call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  ABI,
  ATTEMPTS_PER_STEP,
  LOG_RANGE,
  LOG_RANGES_PER_RUN,
  appliedEvent,
  beaconUpkeepOnce,
  describeReport,
  proposalDue,
  requestedVaults,
  type BeaconQueue,
} from '../src/vaultBeaconUpkeep';
import type { WorkItem } from '../src/db';
import type { KeeperContext } from '../src/keeper';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const BEACON: Address = '0x00000000000000000000000000000000000000b1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const V1: Address = '0x00000000000000000000000000000000000000a1';
const V2: Address = '0x00000000000000000000000000000000000000a2';
const V3: Address = '0x00000000000000000000000000000000000000a3';
const NOW = 1_000_000n;
const HEAD = 120n;
const FINAL = 100n;

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

function logOf(eventName: string, args: Record<string, unknown>, address: Address = BEACON): { address: Address; data: Hex; topics: Hex[] } {
  const ev = ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])) };
}

interface Pending {
  value: bigint;
  at: bigint;
}

class MemoryQueue implements BeaconQueue {
  cur = 0;
  items = new Map<string, number>(); // vault -> last checked order
  finished: string[] = [];
  private tick = 0;
  cursor = async () => this.cur;
  setCursor = async (n: number) => {
    this.cur = n;
  };
  enqueue = async (items: readonly WorkItem<Record<string, never>>[]) => {
    for (const i of items) if (!this.items.has(i.item)) this.items.set(i.item, this.tick++);
  };
  open = async (limit: number) => [...this.items].sort((a, b) => a[1] - b[1]).slice(0, limit).map(([k]) => k);
  touch = async (items: readonly string[]) => {
    for (const i of items) this.items.set(i, this.tick++);
  };
  finish = async (items: readonly string[]) => {
    for (const i of items) {
      this.items.delete(i);
      this.finished.push(i);
    }
  };
}

class FakeBeacon {
  chainServed = CHAIN;
  now = NOW;
  /** The time the contract sees at simulation and send (a later block can differ). */
  sendNow: bigint | null = null;
  beacon: Address = BEACON;
  currentId = 1n;
  /** [kind, id, successor, executableAt]. */
  proposal: [number, bigint, bigint, bigint] = [0, 0n, 0n, 0n];
  pins = new Map<string, Pending>();
  delays = new Map<string, Pending>();
  pinDelay = new Map<string, bigint>();
  /** What the finalized block shows, when it differs from the head. */
  finalPins: Map<string, Pending> | null = null;
  finalDelays: Map<string, Pending> | null = null;
  /** Request logs, by block. */
  requests: { block: bigint; vault: Address }[] = [];
  logReads: [bigint, bigint][] = [];
  sent: string[] = [];
  simulated: string[] = [];
  lastLogs: ReturnType<typeof logOf>[] = [];
  dropLogs = false;

  private pinsAt(block?: bigint) {
    return block === FINAL && this.finalPins ? this.finalPins : this.pins;
  }
  private delaysAt(block?: bigint) {
    return block === FINAL && this.finalDelays ? this.finalDelays : this.delays;
  }

  readContract = async ({ address, functionName, args = [], blockNumber }: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const a = args as readonly any[];
    switch (functionName) {
      case 'getVaultBeacon':
        expect(address).toBe(DIAMOND);
        return this.beacon;
      case 'pendingProposal':
        expect(address).toBe(BEACON);
        return this.proposal;
      case 'pendingPinOf': {
        const p = this.pinsAt(blockNumber).get(String(a[0]).toLowerCase());
        return p ? [p.value, p.at] : [0n, 0n];
      }
      case 'pendingPinDelayOf': {
        const p = this.delaysAt(blockNumber).get(String(a[0]).toLowerCase());
        return p ? [p.value, p.at] : [0n, 0n];
      }
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  multicall = async ({ contracts, blockNumber }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[]; blockNumber?: bigint }) =>
    Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract({ ...c, blockNumber }) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );

  getLogs = async ({ address, fromBlock, toBlock }: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
    expect(address).toBe(BEACON);
    this.logReads.push([fromBlock, toBlock]);
    return this.requests.filter((r) => r.block >= fromBlock && r.block <= toBlock).map((r) => ({ args: { vault: r.vault }, blockNumber: r.block }));
  };

  private admit(functionName: string, args: readonly unknown[]): () => void {
    const t = this.sendNow ?? this.now;
    const v = String(args[0] ?? '').toLowerCase();
    switch (functionName) {
      case 'executeCurrentVersion':
      case 'executeRevoke': {
        const want = functionName === 'executeCurrentVersion' ? 1 : 2;
        const [kind, id, successor, at] = this.proposal;
        if (kind !== want) throw revert('NoProposal');
        if (t < at) throw revert('TooEarly', [at]);
        return () => {
          this.lastLogs =
            want === 1
              ? [logOf('CurrentVaultVersionSet', { oldId: this.currentId, newId: id })]
              : [logOf('VaultVersionRevoked', { id, successorId: successor, byGuardian: false })];
          if (want === 1) this.currentId = id;
          this.proposal = [0, 0n, 0n, 0n];
        };
      }
      case 'executePin': {
        const p = this.pins.get(v);
        if (!p) throw revert('NoPinChange', [args[0]]);
        if (t < p.at) throw revert('TooEarly', [p.at]);
        return () => {
          this.lastLogs = p.value === 0n ? [logOf('VaultVersionUnpinned', { vault: args[0] })] : [logOf('VaultVersionPinned', { vault: args[0], id: p.value })];
          this.pins.delete(v);
        };
      }
      case 'executePinDelay': {
        const p = this.delays.get(v);
        if (!p) throw revert('NoDelayChange', [args[0]]);
        if (t < p.at) throw revert('TooEarly', [p.at]);
        return () => {
          this.lastLogs = [logOf('VaultPinDelaySet', { vault: args[0], oldDelay: this.pinDelay.get(v) ?? 86_400n, newDelay: p.value })];
          this.pinDelay.set(v, p.value);
          this.delays.delete(v);
        };
      }
      default:
        throw new Error(`unexpected call ${functionName}`);
    }
  }

  simulateContract = async ({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) => {
    expect(address, 'every send goes to the beacon, never the Diamond').toBe(BEACON);
    this.simulated.push(`${functionName}:${args[0] ?? ''}`);
    this.admit(functionName, args);
    return { result: undefined };
  };

  getChainId = async () => this.chainServed;
  getBlockNumber = async () => HEAD;
  getBlock = async ({ blockTag }: { blockTag?: string } = {}) => (blockTag === 'finalized' ? { number: FINAL, timestamp: this.now - 60n } : { number: HEAD, timestamp: this.now });
  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => ({ status: 'success', logs: this.dropLogs ? [] : this.lastLogs, blockNumber: HEAD + 1n });

  client(): PublicClient {
    return this as unknown as PublicClient;
  }

  ctx(): KeeperContext {
    return {
      client: this.client(),
      diamond: DIAMOND,
      chainId: CHAIN,
      notAfterMs: Number.POSITIVE_INFINITY,
      wallet: {
        account: { address: KEEPER },
        writeContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) => {
          expect(address).toBe(BEACON);
          this.admit(functionName, args)();
          this.sent.push(`${functionName}:${args[0] ?? ''}`);
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

describe('pure helpers', () => {
  it('a proposal is due only at or after its executableAt, and none is never due', () => {
    expect(proposalDue([1, 3n, 0n, 100n], 100n)).toEqual({ due: true, functionName: 'executeCurrentVersion', label: 'current-version 3 at 100' });
    expect(proposalDue([1, 3n, 0n, 100n], 99n).due).toBe(false);
    expect(proposalDue([2, 2n, 3n, 100n], 150n)).toEqual({ due: true, functionName: 'executeRevoke', label: 'revoke 2 successor 3 at 100' });
    expect(proposalDue([2, 2n, 0n, 100n], 150n).label).toBe('revoke 2 at 100');
    expect(proposalDue([0, 0n, 0n, 0n], 10n ** 18n)).toEqual({ due: false, functionName: null, label: null });
  });

  it('a page of request logs names each vault once, lower-cased', () => {
    const out = requestedVaults([
      { args: { vault: '0x00000000000000000000000000000000000000AA' }, blockNumber: 5n },
      { args: { vault: '0x00000000000000000000000000000000000000aa' }, blockNumber: 6n },
      { args: {}, blockNumber: 7n },
      { args: { vault: V2 }, blockNumber: 8n },
    ]);
    expect(out).toEqual([
      { item: '0x00000000000000000000000000000000000000aa', block: 5, payload: {} },
      { item: V2.toLowerCase(), block: 8, payload: {} },
    ]);
  });

  it("names the applied change from the beacon's own event, for this step and vault only", () => {
    expect(appliedEvent(BEACON, 'pin', V1, [logOf('VaultVersionPinned', { vault: V1, id: 4n })])).toBe(`${V1} pinned 4`);
    expect(appliedEvent(BEACON, 'pin', V2, [logOf('VaultVersionPinned', { vault: V1, id: 4n })]), 'another vault').toBeNull();
    expect(appliedEvent(BEACON, 'pin', V1, [logOf('VaultVersionPinned', { vault: V1, id: 4n }, DIAMOND)]), 'another contract').toBeNull();
    expect(appliedEvent(BEACON, 'pin', V1, [logOf('VaultPinCancelled', { vault: V1, target: 4n, by: BEACON })])).toBe(`${V1} lapsed (target 4 revoked)`);
    expect(appliedEvent(BEACON, 'delay', V1, [logOf('VaultVersionPinned', { vault: V1, id: 4n })]), "another step's event").toBeNull();
    expect(appliedEvent(BEACON, 'proposal', '', [logOf('CurrentVaultVersionSet', { oldId: 1n, newId: 2n })])).toBe('current-version 1->2');
  });
});

describe('a run', () => {
  let b: FakeBeacon;
  let q: MemoryQueue;

  beforeEach(() => {
    b = new FakeBeacon();
    q = new MemoryQueue();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (opts: { floor?: number } = {}) =>
    beaconUpkeepOnce(CHAIN, DIAMOND, {
      client: b.client(),
      readClient: b.client(),
      context: () => b.ctx(),
      sendDeadline: Number.POSITIVE_INFINITY,
      visit: 0,
      queue: q,
      floor: opts.floor ?? 0,
    });

  const key = (v: Address) => v.toLowerCase();

  it('applies only what is due, and sends nothing before its executableAt', async () => {
    b.proposal = [1, 2n, 0n, NOW - 1n];
    b.requests = [
      { block: 10n, vault: V1 },
      { block: 20n, vault: V2 },
      { block: 30n, vault: V3 },
    ];
    b.pins.set(key(V1), { value: 2n, at: NOW }); // due exactly now
    b.pins.set(key(V2), { value: 0n, at: NOW + 1n }); // one second early
    b.delays.set(key(V3), { value: 3600n, at: NOW - 10n }); // due

    const r = await run();
    expect(b.sent).toEqual(['executeCurrentVersion:', `executePin:${V1}`, `executePinDelay:${V3}`]);
    expect(b.simulated, 'nothing not yet due reaches the contract').toEqual(b.sent);
    expect(r.proposal).toBe(`current-version 2 at ${NOW - 1n}`);
    expect(r.steps.proposal).toMatchObject({ due: 1, applied: ['current-version 1->2'] });
    expect(r.steps.pin).toMatchObject({ due: 1, applied: [`${V1} pinned 2`] });
    expect(r.steps.delay).toMatchObject({ due: 1, applied: [`${V3} delay 86400->3600`] });
    expect(r.discovery).toEqual({ from: 0, to: Number(FINAL), queued: 3, caughtUp: true });
    expect(q.cur, 'the cursor moves past the finalized block read').toBe(Number(FINAL) + 1);
    expect(r.refused.size).toBe(0);
    expect(describeReport(r)).toContain('proposal[due=1 applied=current-version 1->2]');
  });

  it('retires a vault only when nothing is pending at the head AND the finalized block', async () => {
    q.items.set(key(V1), 0);
    q.items.set(key(V2), 1);
    q.cur = Number(FINAL) + 1;
    // V2 shows nothing at the head, but the finalized block still has a pin: a reorg could bring it back.
    b.finalPins = new Map([[key(V2), { value: 3n, at: NOW + 999n }]]);

    const r = await run();
    expect(r.checked).toBe(2);
    expect(r.retired).toBe(1);
    expect(q.finished).toEqual([key(V1)]);
    expect(q.items.has(key(V2)), 'kept for a later run').toBe(true);
    expect(b.sent).toEqual([]);
  });

  it('counts a change someone else applied first as gone, and a later block\'s "too early" as not yet', async () => {
    q.items.set(key(V1), 0);
    q.items.set(key(V2), 1);
    q.cur = Number(FINAL) + 1;
    b.pins.set(key(V1), { value: 2n, at: NOW - 5n });
    b.delays.set(key(V2), { value: 60n, at: NOW - 5n });
    // V1's pin is applied by another caller between the read and the send.
    const sim = b.simulateContract;
    b.simulateContract = async (p) => {
      if (p.functionName === 'executePin') b.pins.delete(key(V1));
      return sim(p);
    };
    // The send-side block reads an earlier time for V2's delay.
    const delaySim = b.simulateContract;
    b.simulateContract = async (p) => {
      b.sendNow = p.functionName === 'executePinDelay' ? NOW - 6n : null;
      return delaySim(p);
    };

    const r = await run();
    expect(b.sent).toEqual([]);
    expect(r.steps.pin.gone).toEqual([key(V1)]);
    expect(r.steps.delay.notYet).toEqual([key(V2)]);
    expect(r.refused.size, 'neither is a refusal').toBe(0);
  });

  it('takes at most its share per step and defers the rest', async () => {
    const vaults = Array.from({ length: ATTEMPTS_PER_STEP.pin + 2 }, (_, i) => `0x${(0xd0 + i).toString(16).padStart(40, '0')}` as Address);
    vaults.forEach((v, i) => {
      q.items.set(key(v), i);
      b.pins.set(key(v), { value: 2n, at: NOW - 1n });
    });
    q.cur = Number(FINAL) + 1;

    const r = await run();
    expect(b.sent).toHaveLength(ATTEMPTS_PER_STEP.pin);
    expect(r.steps.pin).toMatchObject({ due: vaults.length, deferred: 2 });
    expect(describeReport(r)).toContain('deferred=2 (taken on later runs)');
  });

  it('records a landed call whose receipt lacks its event apart from an applied one', async () => {
    q.items.set(key(V1), 0);
    q.cur = Number(FINAL) + 1;
    b.pins.set(key(V1), { value: 2n, at: NOW - 1n });
    b.dropLogs = true;

    const r = await run();
    expect(b.sent).toEqual([`executePin:${V1}`]);
    expect(r.steps.pin).toMatchObject({ applied: [], landedUnread: [key(V1)] });
  });

  it('reads discovery in bounded ranges from the deploy floor, and resumes from the cursor', async () => {
    const far = FINAL + LOG_RANGE * BigInt(LOG_RANGES_PER_RUN) * 2n;
    b.getBlock = async ({ blockTag }: { blockTag?: string } = {}) => (blockTag === 'finalized' ? { number: far, timestamp: NOW } : { number: far + 20n, timestamp: NOW });

    const first = await run({ floor: 50 });
    expect(b.logReads).toHaveLength(LOG_RANGES_PER_RUN);
    expect(b.logReads[0]).toEqual([50n, 50n + LOG_RANGE - 1n]);
    expect(first.discovery?.caughtUp).toBe(false);
    expect(q.cur).toBe(50 + Number(LOG_RANGE) * LOG_RANGES_PER_RUN);

    b.logReads = [];
    await run({ floor: 50 });
    expect(b.logReads[0]?.[0], 'the next run starts where the last stopped').toBe(BigInt(q.cur) - LOG_RANGE * BigInt(LOG_RANGES_PER_RUN));
  });

  it('skips a Diamond with no beacon, and an RPC serving another chain', async () => {
    b.beacon = '0x0000000000000000000000000000000000000000';
    expect((await run()).skipped).toBe('the Diamond has no vault beacon set');
    b.beacon = BEACON;
    b.chainServed = 1;
    expect((await run()).skipped).toContain('serves chain 1');
    expect(b.sent).toEqual([]);
  });
});
