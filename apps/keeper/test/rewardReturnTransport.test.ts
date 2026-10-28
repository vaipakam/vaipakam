/**
 * #2984 — the reward return-transport pass. Pinned in two layers:
 *
 *   - the PURE rules: which step a repatriation authorization calls for
 *     (dispatch, execute, ACK, wait, stall, done), when an execute is held by
 *     the outbound lane, and how large a chunked return may be;
 *   - whole RUNS against a fake Base and a fake mirror that apply the
 *     contracts' own admission rules: each message sent once with the quoted
 *     fee, a late one alerted rather than re-sent, every VPFI-moving send
 *     posted as a notice, and nothing sent above the fee ceiling or past a
 *     pause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, type Address, type PublicClient } from 'viem';
import {
  ABI,
  AUTH_PENDING,
  INSTR_EXECUTED,
  INSTR_NONE,
  INSTR_PENDING,
  INSTR_TOMBSTONED,
  LANDING_ALERT_SEC,
  describeReport,
  executeBlocked,
  parseMinPart,
  DEFAULT_MIN_PART,
  repatStep,
  returnChunk,
  returnTransportOnce,
  type ChainDeps,
  type LaneBucket,
  type LedgerRow,
  type RepatState,
  type LedgerPos,
  AUTH_FLOOR_ITEM,
  LEDGER_PAGE,
  MAX_AUTHS_PER_RUN,
  STRANDED_FLOOR_ITEM,
  type ReturnLedger,
  type SendRecords,
} from '../src/rewardReturnTransport';
import type { SendFeeCeiling } from '../src/stepSender';
import { memoryScanCursors } from '../src/scanCursors';
import type { KeeperContext } from '../src/keeper';

const BASE_ID = 84532;
const MIRROR_ID = 421614;
const BASE: Address = '0x00000000000000000000000000000000000000b1';
const MIRROR: Address = '0x00000000000000000000000000000000000000a1';
const MESSENGER: Address = '0x00000000000000000000000000000000000000c2';
const RETURN_SENDER: Address = '0x00000000000000000000000000000000000000c3';
const RECEIVER: Address = '0x00000000000000000000000000000000000000c4';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const REMITTER: Address = '0x00000000000000000000000000000000000000ab';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ROLE_CANONICAL = 0;
const ROLE_MIRROR = 1;
const NOW = 1_800_000_000;
const FEE = 300n;
const CAP: SendFeeCeiling = { wei: 1_000n, from: 'the test' };
const E18 = 10n ** 18n;
const MIN_PART = 1_000n * E18;

const bucket = (o: Partial<LaneBucket> = {}): LaneBucket => ({ readable: true, limited: true, tokens: 50_000n * E18, capacity: 50_000n * E18, ...o });

// ─── The pure rules ─────────────────────────────────────────────────────────

const repat = (o: Partial<RepatState> = {}): RepatState => ({
  authId: 7n,
  dstChainId: MIRROR_ID,
  amount: 100n,
  baseStatus: AUTH_PENDING,
  mirrorState: INSTR_NONE,
  instructionSentAt: null,
  executedAt: null,
  ackSentAt: null,
  ...o,
});

describe('repatStep', () => {
  const late = NOW - LANDING_ALERT_SEC - 1;
  const fresh = NOW - 60;

  it('is done once Base no longer holds the authorization pending', () => {
    expect(repatStep(repat({ baseStatus: 2 }), NOW, LANDING_ALERT_SEC)).toEqual({ kind: 'done' });
    expect(repatStep(repat({ baseStatus: 0, mirrorState: INSTR_PENDING }), NOW, LANDING_ALERT_SEC)).toEqual({ kind: 'done' });
  });

  it('dispatches an instruction never sent, and never re-sends one in flight or late', () => {
    expect(repatStep(repat(), NOW, LANDING_ALERT_SEC)).toEqual({ kind: 'dispatch' });
    expect(repatStep(repat({ instructionSentAt: fresh }), NOW, LANDING_ALERT_SEC)).toMatchObject({ kind: 'wait', stalled: false });
    expect(repatStep(repat({ instructionSentAt: late }), NOW, LANDING_ALERT_SEC)).toMatchObject({ kind: 'wait', stalled: true, why: /re-executed by hand/ });
  });

  it('executes a recorded instruction, then waits on Base, stalled once late', () => {
    expect(repatStep(repat({ mirrorState: INSTR_PENDING }), NOW, LANDING_ALERT_SEC)).toEqual({ kind: 'execute' });
    expect(repatStep(repat({ mirrorState: INSTR_EXECUTED, executedAt: fresh }), NOW, LANDING_ALERT_SEC)).toMatchObject({ kind: 'wait', stalled: false });
    expect(repatStep(repat({ mirrorState: INSTR_EXECUTED, executedAt: null }), NOW, LANDING_ALERT_SEC)).toMatchObject({ kind: 'wait', stalled: false });
    expect(repatStep(repat({ mirrorState: INSTR_EXECUTED, executedAt: late }), NOW, LANDING_ALERT_SEC)).toMatchObject({ kind: 'wait', stalled: true, why: /has not settled/ });
  });

  it('ACKs a tombstoned instruction once, and stalls a late ACK', () => {
    expect(repatStep(repat({ mirrorState: INSTR_TOMBSTONED }), NOW, LANDING_ALERT_SEC)).toEqual({ kind: 'ack' });
    expect(repatStep(repat({ mirrorState: INSTR_TOMBSTONED, ackSentAt: fresh }), NOW, LANDING_ALERT_SEC)).toMatchObject({ kind: 'wait', stalled: false });
    expect(repatStep(repat({ mirrorState: INSTR_TOMBSTONED, ackSentAt: late }), NOW, LANDING_ALERT_SEC)).toMatchObject({ kind: 'wait', stalled: true, why: /not released/ });
  });

  it('stalls on an instruction state it does not know', () => {
    expect(repatStep(repat({ mirrorState: 9 }), NOW, LANDING_ALERT_SEC)).toMatchObject({ kind: 'wait', stalled: true, why: /state 9/ });
  });
});

describe('executeBlocked', () => {
  it('waits on an unread lane, passes an unlimited one, stalls above capacity, waits for refill', () => {
    expect(executeBlocked(10n, null)).toMatchObject({ stalled: false, why: /could not be read/ });
    expect(executeBlocked(10n, bucket({ readable: false }))).toMatchObject({ stalled: false });
    expect(executeBlocked(10n ** 30n, bucket({ limited: false }))).toBeNull();
    expect(executeBlocked(11n, bucket({ capacity: 10n, tokens: 10n }))).toMatchObject({ stalled: true, why: /cancels it or the lane is raised/ });
    expect(executeBlocked(10n, bucket({ capacity: 10n, tokens: 9n }))).toMatchObject({ stalled: false, why: /refills/ });
    expect(executeBlocked(10n, bucket({ capacity: 10n, tokens: 10n }))).toBeNull();
  });
});

describe('returnChunk', () => {
  it('sends all of it when both lanes admit it', () => {
    expect(returnChunk(5n * E18, bucket(), bucket(), MIN_PART)).toEqual({ amount: 5n * E18, note: null });
    expect(returnChunk(10n ** 30n, bucket({ limited: false }), bucket({ limited: false }), MIN_PART)).toEqual({ amount: 10n ** 30n, note: null });
  });

  it('is bounded by the outbound tokens and capacity, and by the inbound capacity (not its tokens)', () => {
    expect(returnChunk(9_000n * E18, bucket({ tokens: 4_000n * E18 }), bucket(), MIN_PART)).toEqual({ amount: 4_000n * E18, note: null });
    expect(returnChunk(9_000n * E18, bucket({ capacity: 3_000n * E18 }), bucket(), MIN_PART)).toEqual({ amount: 3_000n * E18, note: null });
    expect(returnChunk(9_000n * E18, bucket(), bucket({ capacity: 2_000n * E18, tokens: 1n }), MIN_PART)).toEqual({ amount: 2_000n * E18, note: null });
  });

  it('goes out on the outbound lane alone when the inbound end is unread, and says so', () => {
    const p = returnChunk(5n * E18, bucket(), null, MIN_PART);
    expect(p).toMatchObject({ amount: 5n * E18, note: /lane pairing rule/ });
    expect(returnChunk(5n * E18, bucket(), bucket({ readable: false }), MIN_PART)).toMatchObject({ note: /lane pairing rule/ });
  });

  it('waits on an unread outbound end, an empty bucket, or a dust part that leaves a remainder', () => {
    expect(returnChunk(5n, null, bucket(), MIN_PART)).toMatchObject({ wait: /could not be read/ });
    expect(returnChunk(5n, bucket({ tokens: 0n }), bucket(), MIN_PART)).toMatchObject({ wait: /empty/ });
    expect(returnChunk(5_000n * E18, bucket({ tokens: 10n * E18 }), bucket(), MIN_PART)).toMatchObject({ wait: /below the minimum part/ });
    expect(returnChunk(0n, bucket(), bucket(), MIN_PART)).toMatchObject({ wait: /nothing remains/ });
  });

  it('always sends a last part, however small', () => {
    expect(returnChunk(3n, bucket(), bucket(), MIN_PART)).toEqual({ amount: 3n, note: null });
  });
});

describe('parseMinPart', () => {
  it('reads wei, and falls back to the default when unset or unreadable', () => {
    expect(parseMinPart('42')).toBe(42n);
    expect(parseMinPart(undefined)).toBe(DEFAULT_MIN_PART);
    expect(parseMinPart('1e18')).toBe(DEFAULT_MIN_PART);
  });
});

// ─── The fake chains ────────────────────────────────────────────────────────

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

interface Auth {
  status: number;
  dst: number;
  amount: bigint;
}

class FakeChain {
  chainNamed: number;
  sender: Address = RETURN_SENDER;
  receiver: Address = RECEIVER;
  retirement: readonly [boolean, number, Address, bigint] = [false, 0, ZERO, 0n];
  pendingSurplus = 0n;
  paused = false;
  fee = FEE;
  fundable = 10n ** 30n;
  readonly auths = new Map<bigint, Auth>();
  readonly instr = new Map<string, { state: number; amount: bigint }>();
  readonly stranded = new Map<string, { amount: bigint; dayId: bigint }>();
  readonly outbound = new Map<number, LaneBucket>();
  readonly inbound = new Map<number, LaneBucket>();
  sent: { fn: string; args: readonly unknown[]; value: bigint }[] = [];
  txs = 0;
  /** How the next receipts read: seen, reverted, or not seen in time. */
  receipt: 'success' | 'reverted' | 'timeout' = 'success';
  /** The authorizations and quarantines as the finalized block shows them,
   *  when it lags the head; null reads the head's there too. */
  final: { auths: Map<bigint, Auth>; stranded: Map<string, { amount: bigint; dayId: bigint }> } | null = null;
  readonly finalNumber = 10_000n;

  constructor(
    readonly chainId: number,
    readonly diamond: Address,
    readonly role: number,
    readonly baseChainId: number,
  ) {
    this.chainNamed = chainId;
  }

  readContract = async ({ address, functionName, args = [], blockNumber }: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const a = args as readonly any[];
    if (blockNumber !== undefined && blockNumber !== this.finalNumber) throw new Error(`read at unexpected block ${blockNumber}`);
    const auths = blockNumber !== undefined && this.final !== null ? this.final.auths : this.auths;
    const stranded = blockNumber !== undefined && this.final !== null ? this.final.stranded : this.stranded;
    if (address === MESSENGER) {
      if (functionName !== 'quoteSendRepatriationInstruction') throw new Error(`unexpected messenger read ${functionName}`);
      return this.fee;
    }
    if (address === RETURN_SENDER) {
      if (!['quoteRepatriationReturn', 'quoteRepatriationCancelAck', 'quoteStrandedReturn', 'quoteRetiredSurplusReturn'].includes(functionName)) throw new Error(`unexpected return-sender read ${functionName}`);
      return this.fee;
    }
    switch (functionName) {
      case 'getRewardReporterConfig':
        return [MESSENGER, this.chainNamed, this.baseChainId, false, 3600n];
      case 'getRewardRole':
        return this.role;
      case 'getRepatriationPosition':
        return [0n, this.sender, this.receiver, [...this.auths.keys()].reduce((a, b) => (b > a ? b : a), 0n)];
      case 'getRewardChainRetirement':
        return this.retirement;
      case 'getRepatriationAuthorization': {
        const x = auths.get(a[0] as bigint);
        return x === undefined ? [0, 0, 0n, 0n, 0n] : [x.status, x.dst, 0n, x.amount, 0n];
      }
      case 'getRepatriationInstruction': {
        const x = this.instr.get(`${(a[0] as string).toLowerCase()}:${a[1]}`);
        return x === undefined ? [INSTR_NONE, 0n] : [x.state, x.amount];
      }
      case 'getStrandedRecovery': {
        const x = stranded.get(`${(a[0] as string).toLowerCase()}:${a[1]}`) ?? { amount: 0n, dayId: 0n };
        return { amount: x.amount, dayId: x.dayId, reservedAt: 0n, reason: 0, held: true };
      }
      case 'getRemitLaneBucket':
      case 'getRemitInboundLaneBucket': {
        const b = (functionName === 'getRemitLaneBucket' ? this.outbound : this.inbound).get(Number(a[0]));
        if (b === undefined) throw new Error('lane view absent');
        return [b.readable, b.limited, b.tokens, b.capacity];
      }
      case 'rewardCustodyLedger':
        return [true, 0n, 0n, 0n, 0n, this.pendingSurplus, 0n, 0n, 0n];
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

  getBlock = async ({ blockTag }: { blockTag?: string } = {}) => {
    if (blockTag !== 'finalized') throw new Error(`unexpected block read ${blockTag}`);
    return { number: this.finalNumber, timestamp: 1_000n };
  };

  private drawOutbound(amount: bigint): void {
    const b = this.outbound.get(this.baseChainId === 0 ? this.retirement[1] : this.baseChainId);
    if (b !== undefined && b.limited) b.tokens -= amount;
  }

  private admit(functionName: string, a: readonly any[], value: bigint): () => void {
    if (this.paused) throw revert('EnforcedPause');
    if (value !== this.fee) throw new Error(`paid ${value}, quoted ${this.fee}`);
    switch (functionName) {
      case 'sendRepatriationInstruction': {
        const x = this.auths.get(a[0] as bigint);
        if (x === undefined || x.status !== AUTH_PENDING) throw revert('RepatriationAuthNotPending', [a[0], x?.status ?? 0]);
        return () => {};
      }
      case 'executeRepatriation': {
        const key = `${(a[0] as string).toLowerCase()}:${a[1]}`;
        const x = this.instr.get(key);
        if (x === undefined || x.state !== INSTR_PENDING) throw revert('RepatriationInstructionWrongState', [a[0], a[1], x?.state ?? 0]);
        const b = this.outbound.get(this.baseChainId);
        if (b && b.limited && x.amount > b.capacity) throw revert('RepatriationExceedsLaneCapacity', [x.amount, b.capacity]);
        if (x.amount > this.fundable) throw revert('RepatriationExceedsFundable', [x.amount, this.fundable]);
        return () => {
          x.state = INSTR_EXECUTED;
          this.drawOutbound(x.amount);
        };
      }
      case 'sendRepatriationCancelAck': {
        const x = this.instr.get(`${(a[0] as string).toLowerCase()}:${a[1]}`);
        if (x === undefined || x.state !== INSTR_TOMBSTONED) throw revert('RepatriationInstructionWrongState', [a[0], a[1], x?.state ?? 0]);
        return () => {};
      }
      case 'sendStrandedReturn': {
        const x = this.stranded.get(`${(a[0] as string).toLowerCase()}:${a[1]}`);
        if (x === undefined || x.amount === 0n) throw revert('StrandedReturnNothingRecorded', [a[0], a[1]]);
        const amount = a[2] as bigint;
        if (amount === 0n || amount > x.amount) throw revert('StrandedReturnBadAmount', [amount, x.amount]);
        return () => {
          x.amount -= amount;
          this.drawOutbound(amount);
        };
      }
      case 'sendRetiredSurplusReturn': {
        const amount = a[0] as bigint;
        if (amount === 0n || amount > this.pendingSurplus) throw revert('RetiredSurplusBadAmount', [amount, this.pendingSurplus]);
        return () => {
          this.pendingSurplus -= amount;
          const b = this.outbound.get(this.retirement[1]);
          if (b !== undefined && b.limited) b.tokens -= amount;
        };
      }
      default:
        throw new Error(`unexpected call ${functionName}`);
    }
  }

  simulateContract = async ({ functionName, args, value }: { functionName: string; args: readonly unknown[]; value: bigint }) => {
    this.admit(functionName, args, value);
    return { result: undefined };
  };

  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async ({ hash }: { hash: string }) => {
    if (this.receipt === 'timeout') throw new Error('timed out waiting for the receipt');
    return { status: this.receipt, logs: [], blockNumber: 1n, transactionHash: hash };
  };

  client(): PublicClient {
    return this as unknown as PublicClient;
  }

  ctx(): KeeperContext {
    return {
      client: this.client(),
      diamond: this.diamond,
      chainId: this.chainId,
      notAfterMs: Number.POSITIVE_INFINITY,
      wallet: {
        account: { address: KEEPER },
        writeContract: async ({ functionName, args, value }: { functionName: string; args: readonly unknown[]; value: bigint }) => {
          this.admit(functionName, args, value)();
          this.sent.push({ fn: functionName, args, value });
          this.txs += 1;
          return `0x${this.chainId.toString(16).padStart(8, '0')}${this.txs.toString(16).padStart(56, '0')}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

class FakeLedger implements ReturnLedger {
  rows = new Map<number, LedgerRow[]>();
  down = false;
  pages = 0;

  add(chainId: number, kind: string, args: Record<string, unknown>, blockAt: number, block?: number): void {
    const list = this.rows.get(chainId) ?? [];
    list.push({ kind, args, blockAt, block: block ?? list.length + 1, log: 0 });
    this.rows.set(chainId, list);
  }

  async matching(chainId: number, kinds: readonly string[], arg: string, values: readonly string[]) {
    if (this.down) return null;
    return (this.rows.get(chainId) ?? []).filter((r) => kinds.includes(r.kind) && values.includes(String(r.args[arg])));
  }

  async page(chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number) {
    if (this.down) return null;
    this.pages += 1;
    const all = (this.rows.get(chainId) ?? []).filter((r) => kinds.includes(r.kind) && (after === null || r.block > after.block || (r.block === after.block && r.log > after.log)));
    return { rows: all.slice(0, limit), more: all.length > limit };
  }
}

class FakeRecords implements SendRecords {
  readonly rows = new Map<string, number>();
  private k = (chainId: number, diamond: Address, item: string) => `${chainId}:${diamond.toLowerCase()}:${item}`;

  async get(chainId: number, diamond: Address, items: readonly string[]) {
    const out = new Map<string, number>();
    for (const i of items) {
      const v = this.rows.get(this.k(chainId, diamond, i));
      if (v !== undefined) out.set(i, v);
    }
    return out;
  }

  async put(chainId: number, diamond: Address, item: string, sentAt: number) {
    this.rows.set(this.k(chainId, diamond, item), sentAt);
  }

  async finish(chainId: number, diamond: Address, items: readonly string[]) {
    for (const i of items) this.rows.delete(this.k(chainId, diamond, i));
  }
}

// ─── Runs ───────────────────────────────────────────────────────────────────

describe('a run', () => {
  let base: FakeChain;
  let mirror: FakeChain;
  let ledger: FakeLedger;
  let records: FakeRecords;
  let cursors: Map<string, ReturnType<typeof memoryScanCursors>>;
  let alerts: { key: string; text: string }[];
  let now: number;

  beforeEach(() => {
    base = new FakeChain(BASE_ID, BASE, ROLE_CANONICAL, BASE_ID);
    mirror = new FakeChain(MIRROR_ID, MIRROR, ROLE_MIRROR, BASE_ID);
    mirror.outbound.set(BASE_ID, bucket());
    base.inbound.set(MIRROR_ID, bucket());
    ledger = new FakeLedger();
    records = new FakeRecords();
    cursors = new Map();
    alerts = [];
    now = NOW;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const deps = (c: FakeChain, cap: SendFeeCeiling): ChainDeps => ({
    chainId: c.chainId,
    diamond: c.diamond,
    client: c.client(),
    readClient: c.client(),
    context: () => c.ctx(),
    feeCeiling: cap,
    alert: async (key: string, text: string) => void alerts.push({ key, text }),
  });
  const run = (o: { keeper?: Address | null; cap?: SendFeeCeiling; chains?: FakeChain[] } = {}) =>
    returnTransportOnce({
      chains: (o.chains ?? [base, mirror]).map((c) => deps(c, o.cap ?? CAP)),
      ledger,
      records,
      cursors: (chainId, diamond) => {
        const k = `${chainId}:${diamond}`;
        if (!cursors.has(k)) cursors.set(k, memoryScanCursors());
        return cursors.get(k)!;
      },
      keeper: o.keeper === undefined ? KEEPER : o.keeper,
      sendDeadline: Number.POSITIVE_INFINITY,
      minPart: MIN_PART,
      now: () => now,
    });
  const fns = (c: FakeChain) => c.sent.map((s) => s.fn);
  const authorize = (authId: bigint, amount: bigint) => {
    base.auths.set(authId, { status: AUTH_PENDING, dst: MIRROR_ID, amount });
    ledger.add(BASE_ID, 'RepatriationAuthorized', { authId: String(authId), dstChainId: String(MIRROR_ID), amount: String(amount) }, NOW - 600);
  };

  it('does nothing with no work, and says what it saw', async () => {
    const r = await run();
    expect([fns(base), fns(mirror)]).toEqual([[], []]);
    expect(r.map((x) => x.skipped)).toEqual([undefined, undefined]);
    expect(describeReport(r[0])).toBe(
      `[keeper] rewardReturnTransport chain=${BASE_ID} role=0 instructions-sent=none executed=none acks-sent=none stranded-returned=none retired-surplus-returned=none`,
    );
  });

  it('dispatches an authorization\'s instruction once, paying the messenger\'s quote, and records it', async () => {
    authorize(1n, 400n * E18);
    const r = await run();
    expect(base.sent).toEqual([{ fn: 'sendRepatriationInstruction', args: [1n, KEEPER], value: FEE }]);
    expect(r[0].dispatched).toEqual(['1']);
    expect(records.rows.get(`${BASE_ID}:${BASE}:instruction:1`)).toBe(NOW);
    // Before the indexer records the dispatch, the keeper's own record holds it.
    base.sent = [];
    const again = await run();
    expect(base.sent).toEqual([]);
    expect(again[0].waiting[0]).toMatch(/authorization 1 to chain 421614: its instruction is in flight/);
    expect(alerts).toEqual([]);
  });

  it('counts an instruction whose receipt was not seen as sent, so it is not paid for twice (Codex #3002)', async () => {
    authorize(1n, 400n * E18);
    base.receipt = 'timeout';
    await run();
    expect(fns(base)).toEqual(['sendRepatriationInstruction']);
    expect(records.rows.get(`${BASE_ID}:${BASE}:instruction:1`), 'recorded before it went out, and kept').toBe(NOW);
    // It mined after the run; the indexer has not recorded it yet.
    base.receipt = 'success';
    base.sent = [];
    const again = await run();
    expect(base.sent).toEqual([]);
    expect(again[0].waiting[0]).toMatch(/its instruction is in flight/);
  });

  it('puts the record back when the instruction reverted or the node refused it, so it is sent again', async () => {
    authorize(1n, 400n * E18);
    base.receipt = 'reverted';
    await run();
    expect(records.rows.has(`${BASE_ID}:${BASE}:instruction:1`)).toBe(false);
    base.receipt = 'success';
    base.sent = [];
    await run();
    expect(fns(base)).toEqual(['sendRepatriationInstruction']);
  });

  it('never re-sends a late instruction: it alerts once on its own key', async () => {
    authorize(1n, 400n * E18);
    ledger.add(BASE_ID, 'RepatriationInstructionDispatched', { authId: '1', dstChainId: String(MIRROR_ID), amount: '1', messageId: '0x' }, NOW - 600);
    now = NOW + LANDING_ALERT_SEC;
    const r = await run();
    expect(base.sent).toEqual([]);
    expect(r[0].stalled).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe(`return-transport-stalled:${BASE_ID}:auth:1`);
    expect(alerts[0].text).toMatch(/re-executed by hand/);
  });

  it('executes a recorded instruction on the mirror, posting the amount it sent home', async () => {
    authorize(2n, 400n * E18);
    ledger.add(BASE_ID, 'RepatriationInstructionDispatched', { authId: '2' }, NOW - 600);
    mirror.instr.set(`${BASE}:2`, { state: INSTR_PENDING, amount: 400n * E18 });
    const r = await run();
    expect(base.sent).toEqual([]);
    expect(mirror.sent).toEqual([{ fn: 'executeRepatriation', args: [BASE, 2n, KEEPER], value: FEE }]);
    expect(r[1].executed).toEqual(['2']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toMatch(new RegExp(`^return-transport-sent:${MIRROR_ID}:0x`));
    expect(alerts[0].text).toMatch(/executed repatriation 2, sending 400000000000000000000 VPFI \(wei\) home to chain 84532/);
    // Executed, Base not yet settled: a wait, and no second execute.
    mirror.sent = [];
    const again = await run();
    expect(mirror.sent).toEqual([]);
    expect(again[0].waiting[0]).toMatch(/its return is in flight to Base/);
  });

  it('holds an execute the outbound lane cannot carry: above capacity stalls, short of tokens waits', async () => {
    authorize(3n, 400n * E18);
    ledger.add(BASE_ID, 'RepatriationInstructionDispatched', { authId: '3' }, NOW - 600);
    mirror.instr.set(`${BASE}:3`, { state: INSTR_PENDING, amount: 400n * E18 });
    mirror.outbound.set(BASE_ID, bucket({ capacity: 100n * E18, tokens: 100n * E18 }));
    let r = await run();
    expect(mirror.sent).toEqual([]);
    expect(r[1].stalled[0]).toMatch(/above the mirror's outbound lane capacity/);
    expect(alerts.map((a) => a.key)).toEqual([`return-transport-stalled:${MIRROR_ID}:auth:${BASE}:3`]);
    mirror.outbound.set(BASE_ID, bucket({ capacity: 500n * E18, tokens: 100n * E18 }));
    alerts = [];
    r = await run();
    expect(mirror.sent).toEqual([]);
    expect(r[1].waiting[0]).toMatch(/holds 100000000000000000000 of the 400000000000000000000 it needs/);
    expect(alerts).toEqual([]);
  });

  it('reads an under-funded mirror as a wait, not a refusal', async () => {
    authorize(4n, 400n * E18);
    ledger.add(BASE_ID, 'RepatriationInstructionDispatched', { authId: '4' }, NOW - 600);
    mirror.instr.set(`${BASE}:4`, { state: INSTR_PENDING, amount: 400n * E18 });
    mirror.fundable = 1n;
    const r = await run();
    expect(mirror.sent).toEqual([]);
    expect(r[1].refused.size).toBe(0);
    expect(r[1].waiting[0]).toMatch(/un-reserved surplus is below its amount/);
  });

  it('ACKs a tombstoned instruction once, then waits on Base\'s release', async () => {
    authorize(5n, 400n * E18);
    ledger.add(BASE_ID, 'RepatriationInstructionDispatched', { authId: '5' }, NOW - 600);
    mirror.instr.set(`${BASE}:5`, { state: INSTR_TOMBSTONED, amount: 400n * E18 });
    const r = await run();
    expect(mirror.sent).toEqual([{ fn: 'sendRepatriationCancelAck', args: [BASE, 5n, KEEPER], value: FEE }]);
    expect(r[1].acked).toEqual(['5']);
    expect(alerts).toEqual([]);
    mirror.sent = [];
    const again = await run();
    expect(mirror.sent).toEqual([]);
    expect(again[0].waiting[0]).toMatch(/cancellation ACK is in flight/);
    // Base releases it: both records are cleared.
    base.auths.get(5n)!.status = 3;
    await run();
    expect([...records.rows.keys()]).toEqual([]);
  });

  it(`reaches an authorization past the first ${MAX_AUTHS_PER_RUN}, rotating above a floor of settled ids`, async () => {
    for (let i = 1n; i <= BigInt(MAX_AUTHS_PER_RUN + 10); i++) base.auths.set(i, { status: 2, dst: MIRROR_ID, amount: 1n });
    authorize(BigInt(MAX_AUTHS_PER_RUN + 11), 400n * E18);
    let r = await run();
    expect(base.sent).toEqual([]);
    expect(cursors.get(`${BASE_ID}:${BASE}`)!.rows.get(AUTH_FLOOR_ITEM), 'the floor passes every settled id read').toBe(String(MAX_AUTHS_PER_RUN + 1));
    r = await run();
    expect(base.sent.map((x) => x.args[0])).toEqual([BigInt(MAX_AUTHS_PER_RUN + 11)]);
    expect(r[0].dispatched).toEqual([String(MAX_AUTHS_PER_RUN + 11)]);
  });

  it('moves its authorization floor only on what the finalized block shows (Codex #2993 r4)', async () => {
    for (let i = 1n; i <= 3n; i++) base.auths.set(i, { status: 2, dst: MIRROR_ID, amount: 1n });
    base.final = { auths: new Map([[1n, { status: 2, dst: MIRROR_ID, amount: 1n }], [2n, { status: AUTH_PENDING, dst: MIRROR_ID, amount: 1n }]]), stranded: new Map() };
    await run();
    const c = cursors.get(`${BASE_ID}:${BASE}`)!;
    expect(c.rows.get(AUTH_FLOOR_ITEM), 'id 2 is settled at the head, still pending at finality').toBe('2');
    base.final = null;
    await run();
    expect(c.rows.get(AUTH_FLOOR_ITEM)).toBe('4');
  });

  it('does not read an id not yet issued at finality as finished (Codex #3002)', async () => {
    for (let i = 1n; i <= 3n; i++) base.auths.set(i, { status: 2, dst: MIRROR_ID, amount: 1n });
    // Ids 2 and 3 were issued and settled after the finalized block.
    base.final = { auths: new Map([[1n, { status: 2, dst: MIRROR_ID, amount: 1n }]]), stranded: new Map() };
    await run();
    expect(cursors.get(`${BASE_ID}:${BASE}`)!.rows.get(AUTH_FLOOR_ITEM)).toBe('2');
  });

  it('does not lift its quarantine floor past a quarantine not yet finalized (Codex #3002)', async () => {
    ledger.add(MIRROR_ID, 'CompensationQuarantined', { remitter: REMITTER, remitId: '100' }, NOW - 600, 1);
    ledger.add(MIRROR_ID, 'CompensationQuarantined', { remitter: REMITTER, remitId: '101' }, NOW - 600, 2);
    ledger.add(MIRROR_ID, 'CompensationQuarantined', { remitter: REMITTER, remitId: '102' }, NOW - 60, Number(mirror.finalNumber) + 5);
    // All three are returned in full at the head; the third's quarantine is
    // past the finalized block, where its record reads empty too.
    await run();
    expect(cursors.get(`${MIRROR_ID}:${MIRROR}`)!.rows.get(STRANDED_FLOOR_ITEM)).toBe('2:0');
  });

  it('moves its quarantine floor only on what the finalized block shows (Codex #2993 r4)', async () => {
    for (let i = 0; i < 3; i++) ledger.add(MIRROR_ID, 'CompensationQuarantined', { remitter: REMITTER, remitId: String(100 + i) }, NOW - 600);
    mirror.final = { auths: new Map(), stranded: new Map([[`${REMITTER}:101`, { amount: 5n, dayId: 4n }]]) };
    await run();
    const c = cursors.get(`${MIRROR_ID}:${MIRROR}`)!;
    expect(c.rows.get(STRANDED_FLOOR_ITEM), 'the second row is returned at the head, not yet at finality').toBe('1:0');
    mirror.final = null;
    await run();
    expect(c.rows.get(STRANDED_FLOOR_ITEM)).toBe('3:0');
  });

  it('a mirror this keeper does not serve is named, and nothing is sent for it', async () => {
    authorize(1n, 1n);
    const r = await run({ chains: [base] });
    expect(base.sent).toEqual([]);
    expect([...r[0].unread.values()][0]).toMatch(/no RPC or Diamond for/);
  });

  it('returns a quarantined compensation in lane-bounded chunks, then the last part', async () => {
    mirror.stranded.set(`${REMITTER}:9`, { amount: 7_000n * E18, dayId: 4n });
    ledger.add(MIRROR_ID, 'CompensationQuarantined', { dayId: '4', remitter: REMITTER, remitId: '9', amount: '1', reason: 0 }, NOW - 600);
    base.inbound.set(MIRROR_ID, bucket({ capacity: 5_000n * E18 }));
    let r = await run();
    expect(mirror.sent).toEqual([{ fn: 'sendStrandedReturn', args: [REMITTER, 9n, 5_000n * E18, KEEPER], value: FEE }]);
    expect(r[1].stranded).toEqual([`${REMITTER}:9=${5_000n * E18}`]);
    expect(alerts[0].text).toMatch(/returned 5000000000000000000000 of the 7000000000000000000000 VPFI \(wei\) quarantined for remit 9 \(day 4\)/);
    mirror.sent = [];
    r = await run();
    expect(mirror.sent.map((s) => s.args[2])).toEqual([2_000n * E18]);
    mirror.sent = [];
    r = await run();
    expect(mirror.sent).toEqual([]);
    expect(r[1].waiting).toEqual([]);
  });

  it(`reaches a quarantine past the first ${LEDGER_PAGE} ledger rows, from where the last run stopped`, async () => {
    for (let i = 0; i < LEDGER_PAGE + 5; i++) ledger.add(MIRROR_ID, 'CompensationQuarantined', { remitter: REMITTER, remitId: String(100 + i) }, NOW - 600);
    mirror.stranded.set(`${REMITTER}:9`, { amount: 300n * E18, dayId: 4n });
    ledger.add(MIRROR_ID, 'CompensationQuarantined', { remitter: REMITTER, remitId: '9' }, NOW - 600);
    await run();
    expect(mirror.sent).toEqual([]);
    const c = cursors.get(`${MIRROR_ID}:${MIRROR}`)!;
    expect(c.rows.get(STRANDED_FLOOR_ITEM), 'every row read is returned in full').toBe(`${LEDGER_PAGE}:0`);
    await run();
    expect(mirror.sent).toEqual([{ fn: 'sendStrandedReturn', args: [REMITTER, 9n, 300n * E18, KEEPER], value: FEE }]);
    expect(c.rows.get(STRANDED_FLOOR_ITEM), 'the floor stops at the quarantine it sent part of, until it reads it at zero').toBe(`${LEDGER_PAGE + 5}:0`);
  });

  it('waits rather than spend a fee on a dust part', async () => {
    mirror.stranded.set(`${REMITTER}:9`, { amount: 7_000n * E18, dayId: 4n });
    ledger.add(MIRROR_ID, 'CompensationQuarantined', { remitter: REMITTER, remitId: '9' }, NOW - 600);
    mirror.outbound.set(BASE_ID, bucket({ tokens: 5n * E18 }));
    const r = await run();
    expect(mirror.sent).toEqual([]);
    expect(r[1].waiting[0]).toMatch(/below the minimum part/);
  });

  it('returns a retired chain\'s pending surplus toward its return chain', async () => {
    mirror.retirement = [true, BASE_ID, BASE, 0n];
    mirror.pendingSurplus = 800n * E18;
    const r = await run();
    expect(mirror.sent).toEqual([{ fn: 'sendRetiredSurplusReturn', args: [800n * E18, KEEPER], value: FEE }]);
    expect(r[1].retired).toEqual([String(800n * E18)]);
    expect(alerts[0].text).toMatch(/returned 800000000000000000000 of this retired chain's 800000000000000000000 VPFI \(wei\) pending surplus to chain 84532/);
    mirror.sent = [];
    await run();
    expect(mirror.sent).toEqual([]);
  });

  it('pays no fee above its ceiling: nothing is sent or recorded', async () => {
    authorize(1n, 400n * E18);
    const r = await run({ cap: { wei: FEE - 1n, from: 'the test' } });
    expect(base.sent).toEqual([]);
    expect([...r[0].refused.values()][0]).toMatch(/above this keeper's ceiling/);
    expect(records.rows.size).toBe(0);
  });

  it('sends nothing without a keeper key, and says why', async () => {
    authorize(1n, 400n * E18);
    const r = await run({ keeper: null });
    expect(base.sent).toEqual([]);
    expect([...r[0].unread.values()][0]).toMatch(/no refund address/);
  });

  it('a paused protocol stops the chain\'s run', async () => {
    authorize(1n, 400n * E18);
    authorize(2n, 400n * E18);
    base.paused = true;
    const r = await run();
    expect(base.sent).toEqual([]);
    expect(r[0].stopped).toBe('EnforcedPause');
  });

  it('skips a chain whose Diamond names another chain, or whose return transport is unset', async () => {
    mirror.chainNamed = 1;
    base.sender = ZERO;
    base.receiver = ZERO;
    const r = await run();
    expect(r[0].skipped).toMatch(/not configured/);
    expect(r[1].skipped).toMatch(/names itself chain 1/);
  });

  it('names an unreadable ledger and sends nothing', async () => {
    authorize(1n, 400n * E18);
    ledger.down = true;
    const r = await run();
    expect(base.sent).toEqual([]);
    expect(r[0].unread.get('repatriation')).toBe('the event ledger');
  });
});
