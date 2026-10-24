/**
 * #2515 — the standalone staging-record route, executed.
 *
 * `rewardSanctionsHold.test.ts` pins the pass's judgement (the plan, the D1
 * reads, the alerts) one function at a time. Nothing there SELECTS a held
 * standalone record, SIMULATES `resolveStagedDayPage` and SENDS it: the route
 * a claim day takes once its transport-epoch scan passes the 64-delivery cap,
 * so its record is resolved on its own rather than through a domain. These
 * cells drive whole runs of the pass ({@link sanctionsHoldOnce}) against a fake
 * Diamond over the real schemas, across the owner's verdict changing:
 *
 *   - while the owner is HELD, the record waits: the run observes the owner
 *     and sends no page, because a page would only withhold again;
 *   - once the owner is CONFIRMED, the run selects the record from the
 *     indexer's open-record rows, reads it Resolving, simulates the page and
 *     sends it with the record's key;
 *   - a record that belongs to a DOMAIN is refused by the standalone entry by
 *     name, which is the chain routing it, not a wedge, so it is not counted
 *     as stuck and the domain's own page carries it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { DECISION_CONFIRMED, DECISION_HOLD, sanctionsHoldOnce } from '../src/rewardSanctionsHold';
import { disarmEpochFence } from '../src/epochFence';
import type { Env, KeeperD1 } from '../src/env';
import type { KeeperContext } from '../src/keeper';
import { settleIndexer } from './helpers/epochFence';
import { createKeeperD1, createSharedD1 } from './helpers/schemas';
import type { SqliteD1 } from './helpers/sqliteD1';

/** A chain no deployment record names: the ledger floor is 0. */
const CHAIN = 777_001;
const DIAMOND = '0x00000000000000000000000000000000000d1a30' as Address;
const ORACLE = '0x0000000000000000000000000000000000000a1e' as Address;
const OWNER = '0x00000000000000000000000000000000000000aa' as Address;
const KEEPER = '0x00000000000000000000000000000000000000ee' as Address;
const NOW_MS = 1_800_000_000_000;
const DAY = 86_400;
/** `StagingPhase.Resolving`, and the phase a resolved record leaves in. */
const RESOLVING = 3;
const CLOSED = 4;

const ERRORS_ABI = parseAbi([
  'error NoInteractionRewardsToClaim()',
  'error StagingRecordInDomain(bytes32 key, bytes32 domainKey)',
]);

function revert(errorName: 'NoInteractionRewardsToClaim' | 'StagingRecordInDomain', args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: ERRORS_ABI,
    data: encodeErrorResult({ abi: ERRORS_ABI, errorName, args } as never),
    functionName: 'resolveStagedDayPage',
  });
}

const key = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

/** One Diamond, as far as this pass reads and writes it. */
class FakeDiamond {
  decision = DECISION_HOLD;
  flaggedAt = 0;
  lastSeenAt = 0;
  /** Each staging record's phase, and the domain it belongs to, if any. */
  records = new Map<Hex, { phase: number; domain?: Hex; broken?: boolean }>();
  /** Every simulation, and every transaction sent, in order. */
  simulated: { fn: string; args: readonly unknown[] }[] = [];
  sent: { fn: string; args: readonly unknown[] }[] = [];

  readContract = async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    if (address.toLowerCase() === ORACLE) {
      if (functionName !== 'isSanctioned') throw new Error(`unexpected oracle read ${functionName}`);
      return this.decision !== 0;
    }
    switch (functionName) {
      case 'getSanctionsOracle':
        return ORACLE;
      case 'getRewardSanctionsStatus': {
        const observed = this.lastSeenAt !== 0;
        // [decision, flaggedAt, lastSeenAt, forfeitableAt, observeBy, evidenceOracle, marker]
        return [
          this.decision,
          BigInt(this.flaggedAt),
          BigInt(this.lastSeenAt),
          BigInt(this.flaggedAt === 0 ? 0 : this.flaggedAt + 3 * DAY),
          BigInt(observed ? this.lastSeenAt + DAY : 0),
          observed ? ORACLE : '0x0000000000000000000000000000000000000000',
          false,
        ] as const;
      }
      case 'getStagingRecord': {
        const r = this.records.get(args![0] as Hex);
        if (!r) throw new Error('no such record');
        return { user: OWNER, phase: r.phase };
      }
      case 'getStagingDomain':
        return [key(0), 0] as const;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  multicall = async ({ contracts }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[] }) =>
    Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract(c) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    this.simulated.push({ fn: functionName, args });
    switch (functionName) {
      case 'settleSanctionedInteractionRewards':
        // Nothing owed to settle: the case the pass treats as done.
        throw revert('NoInteractionRewardsToClaim');
      case 'recordRewardSanctionsEvidence':
        return { result: undefined };
      case 'resolveStagedDayPage': {
        const k = args[0] as Hex;
        const r = this.records.get(k);
        if (r?.domain) throw revert('StagingRecordInDomain', [k, r.domain]);
        if (r?.broken) throw new Error('execution reverted');
        return { result: true };
      }
      default:
        throw new Error(`unexpected simulation ${functionName}`);
    }
  };

  /** The state a landed call leaves. */
  private apply(fn: string, args: readonly unknown[]): void {
    if (fn === 'recordRewardSanctionsEvidence') {
      this.lastSeenAt = Math.floor(Date.now() / 1000);
      if (this.flaggedAt === 0) this.flaggedAt = this.lastSeenAt;
    }
    if (fn === 'resolveStagedDayPage') {
      // A confirmed owner's page settles the record whole (one page here).
      const r = this.records.get(args[0] as Hex)!;
      if (this.decision === DECISION_CONFIRMED) r.phase = CLOSED;
    }
  }

  waitForTransactionReceipt = async () => ({ status: 'success' as const, logs: [] });
  getTransactionReceipt = async () => ({ status: 'success' as const, logs: [] });

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
        writeContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          this.sent.push({ fn: functionName, args });
          this.apply(functionName, args);
          return key(0x1000 + this.sent.length);
        },
      },
    } as unknown as KeeperContext;
  }

  sentOf(fn: string) {
    return this.sent.filter((t) => t.fn === fn);
  }
}

describe('the standalone staging-record route, executed (#2515)', () => {
  let shared: SqliteD1;
  let keeper: SqliteD1;
  let env: Env;
  let chain: FakeDiamond;
  let block = 10;
  /** What the run journals: an undelivered ops alert lands here. */
  let journaled: string[];
  const stuckSaid = () => journaled.filter((l) => l.includes('staging resolution page(s) reverted'));

  /** The indexer's row for an opened record, as the shared ledger holds it. */
  function opened(k: Hex) {
    block += 1;
    shared.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (?, ?, 0, ?, 'StagingRecordOpened', ?, ?)`,
      )
      .run(CHAIN, block, key(block), JSON.stringify({ key: k, user: OWNER }), NOW_MS / 1000 - DAY);
  }

  const run = () =>
    sanctionsHoldOnce(env, { id: CHAIN, diamond: DIAMOND }, Number.POSITIVE_INFINITY, {
      readClient: chain.client(),
      client: chain.client(),
      context: () => chain.ctx(),
    });

  const advance = (sec: number) => vi.setSystemTime(Date.now() + sec * 1000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    shared = createSharedD1();
    keeper = createKeeperD1();
    env = { DB: shared.d1, KEEPER_DB: keeper.d1 as unknown as KeeperD1 } as unknown as Env;
    settleIndexer(shared, CHAIN, DIAMOND);
    chain = new FakeDiamond();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    journaled = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void journaled.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    disarmEpochFence();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits while the owner is held, then resolves the record with its own key once confirmed', async () => {
    const k = key(0xabc);
    chain.records.set(k, { phase: RESOLVING });
    opened(k);

    // HELD: the owner is a candidate through its open record, and is observed.
    // No page is simulated or sent: a held owner's page only withholds again.
    await run();
    expect(chain.sentOf('recordRewardSanctionsEvidence').map((t) => t.args)).toEqual([[OWNER]]);
    expect(chain.simulated.some((t) => t.fn === 'resolveStagedDayPage'), 'no page while held').toBe(false);
    expect(chain.sentOf('resolveStagedDayPage')).toEqual([]);

    // Still held a day later: observed again, still no page.
    advance(DAY - 3600);
    await run();
    expect(chain.sentOf('recordRewardSanctionsEvidence').length).toBe(2);
    expect(chain.sentOf('resolveStagedDayPage')).toEqual([]);

    // CONFIRMED: the record is read Resolving, its page simulated, then sent
    // with exactly that record's key.
    chain.decision = DECISION_CONFIRMED;
    advance(DAY);
    await run();
    expect(chain.simulated.filter((t) => t.fn === 'resolveStagedDayPage').map((t) => t.args)).toEqual([[k]]);
    expect(chain.sentOf('resolveStagedDayPage').map((t) => t.args)).toEqual([[k]]);
    expect(chain.records.get(k)!.phase).toBe(CLOSED);

    // Resolved: the next run reads the record closed and sends nothing for it,
    // although the indexer's open-record row has not caught up.
    const pages = chain.sentOf('resolveStagedDayPage').length;
    advance(3600);
    await run();
    expect(chain.sentOf('resolveStagedDayPage').length).toBe(pages);
    expect(stuckSaid(), 'nothing said stuck').toEqual([]);
  });

  it('sends a page per standalone record, and leaves a domain member to its domain without calling it stuck', async () => {
    const a = key(0xa1);
    const b = key(0xb2);
    const inDomain = key(0xd3);
    chain.records.set(a, { phase: RESOLVING });
    chain.records.set(inDomain, { phase: RESOLVING, domain: key(0xd0) });
    chain.records.set(b, { phase: RESOLVING });
    for (const k of [a, inDomain, b]) opened(k);
    chain.decision = DECISION_CONFIRMED;
    chain.flaggedAt = NOW_MS / 1000 - 4 * DAY;
    chain.lastSeenAt = NOW_MS / 1000 - 3600;

    await run();
    // Each record is offered its page, in the ledger's order; the domain member
    // is refused by name and so never sent.
    expect(chain.simulated.filter((t) => t.fn === 'resolveStagedDayPage').map((t) => t.args[0])).toEqual([a, inDomain, b]);
    expect(chain.sentOf('resolveStagedDayPage').map((t) => t.args[0])).toEqual([a, b]);
    expect(chain.records.get(inDomain)!.phase).toBe(RESOLVING);
    expect(stuckSaid(), 'a routed refusal is not a wedge').toEqual([]);
  });

  it('says a standalone page that reverts for any other reason, naming the owner (the control for the cells above)', async () => {
    const k = key(0xbad);
    chain.records.set(k, { phase: RESOLVING, broken: true });
    opened(k);
    chain.decision = DECISION_CONFIRMED;
    chain.flaggedAt = NOW_MS / 1000 - 4 * DAY;
    chain.lastSeenAt = NOW_MS / 1000 - 3600;

    await run();
    expect(chain.sentOf('resolveStagedDayPage')).toEqual([]);
    const said = stuckSaid();
    expect(said.length, 'the stuck page is said').toBeGreaterThan(0);
    expect(said.some((l) => l.toLowerCase().includes(OWNER))).toBe(true);
  });
});
