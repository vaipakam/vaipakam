import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Address, PublicClient } from 'viem';
import type { KeeperContext } from '../src/keeper';
import { describeReport, refreshOnce, REFRESH_MARGIN_SEC, type RefreshDeps } from '../src/sanctionsStandInRefresh';

const BNB = 97;
const ATTESTOR = '0x00000000000000000000000000000000000a7e57' as Address;
const STAND_IN = '0x0000000000000000000000000000000000057a1d' as Address;
const KEEPER = '0x000000000000000000000000000000000000beef' as Address;
const BASE_TL = '0x00000000000000000000000000000000000000b1' as Address;
const ARB_TL = '0x00000000000000000000000000000000000000a1' as Address;
const DAY = 86_400n;
const NOW = 1_800_000_000n;

/** The attestor chain: the attestor and the stand-in it reads. */
class AttestorChain {
  chainServed = BNB;
  oracle: Address = STAND_IN;
  isStandIn = true;
  lastUpdate = NOW - 6n * DAY - 1n;
  refresher: Address = KEEPER;
  sent: string[] = [];
  refuse: string | null = null;

  readContract = async ({ address, functionName }: { address: Address; functionName: string }) => {
    if (address === ATTESTOR && functionName === 'oracle') return this.oracle;
    if (address === STAND_IN) {
      if (functionName === 'isTestnetStandIn') return this.isStandIn;
      if (functionName === 'getLastUpdateBlockTimestamp') return this.lastUpdate;
      if (functionName === 'refresher') return this.refresher;
    }
    throw new Error(`unexpected read ${functionName} at ${address}`);
  };
  getChainId = async () => this.chainServed;
  getBlock = async () => ({ number: 1n, timestamp: NOW });
  getTransactionCount = async () => 3;
  simulateContract = async ({ address, functionName }: { address: Address; functionName: string }) => {
    if (address !== STAND_IN || functionName !== 'markUpdated') throw new Error(`unexpected simulation ${functionName} at ${address}`);
    if (this.refuse) {
      const err = new Error(this.refuse) as Error & { data?: unknown };
      throw Object.assign(err, { name: 'ContractFunctionExecutionError', cause: { data: { errorName: this.refuse, args: [] } } });
    }
    return { result: undefined };
  };
  waitForTransactionReceipt = async () => ({ status: 'success', logs: [], blockNumber: 2n });

  client(): PublicClient {
    return this as unknown as PublicClient;
  }

  ctx(): KeeperContext {
    return {
      client: this.client(),
      diamond: '0x00000000000000000000000000000000000d1a30' as Address,
      chainId: BNB,
      notAfterMs: Number.POSITIVE_INFINITY,
      wallet: {
        account: { address: KEEPER },
        writeContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          this.sent.push(`${functionName}@${address}`);
          this.lastUpdate = NOW;
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

/** A timelock chain's timelock. */
const timelock = (chainId: number, address: Address, maxAge: bigint, source = BNB, attestor: Address = ATTESTOR, fails = false) => ({
  chainId,
  timelock: address,
  client: {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (fails) throw new Error('rpc down');
      if (functionName === 'clearanceSourceChainId') return BigInt(source);
      if (functionName === 'clearanceAttestor') return attestor;
      if (functionName === 'oracleMaxAge') return Number(maxAge);
      throw new Error(`unexpected timelock read ${functionName}`);
    },
  } as unknown as PublicClient,
});

describe('sanctions stand-in refresh (#3113)', () => {
  let chain: AttestorChain;
  let deps: RefreshDeps;

  beforeEach(() => {
    chain = new AttestorChain();
    deps = {
      client: chain.client(),
      context: () => chain.ctx(),
      keeper: KEEPER,
      sendDeadline: Number.POSITIVE_INFINITY,
      attestor: ATTESTOR,
      timelocks: [timelock(84532, BASE_TL, 7n * DAY), timelock(421614, ARB_TL, 7n * DAY)],
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('refreshes the stand-in the attestor reads once it is within a day of the limit', async () => {
    const r = await refreshOnce(BNB, deps);
    expect(r.refresh).toBe('landed');
    expect(chain.sent).toEqual([`markUpdated@${STAND_IN}`]);
    expect(r.maxAgeSec).toBe(7n * DAY);
    expect(r.servedBy).toEqual([84532, 421614]);
    expect(r.stale).toBe(false);
    expect(describeReport(r)).toContain('refresh=landed');
  });

  it('sends nothing while the stand-in is fresher than the limit less the margin', async () => {
    chain.lastUpdate = NOW - 7n * DAY + BigInt(REFRESH_MARGIN_SEC) + 1n;
    const r = await refreshOnce(BNB, deps);
    expect(chain.sent).toEqual([]);
    expect(r.refresh).toBeNull();
    expect(r.stale).toBe(false);
  });

  it('takes the smallest limit among the timelocks this attestor answers, ignoring others', async () => {
    deps.timelocks = [
      timelock(84532, BASE_TL, 3n * DAY),
      // Another attestor's timelock binds nothing here, however short its limit.
      timelock(421614, ARB_TL, 1n * DAY, BNB, '0x00000000000000000000000000000000000000ff' as Address),
    ];
    chain.lastUpdate = NOW - 2n * DAY - 10n;
    const r = await refreshOnce(BNB, deps);
    expect(r.maxAgeSec).toBe(3n * DAY);
    expect(r.servedBy).toEqual([84532]);
    expect(r.refresh).toBe('landed');
  });

  it('says the stand-in is stale past the limit, and refreshes it', async () => {
    chain.lastUpdate = NOW - 15n * DAY;
    deps.context = () => null; // no signing key: nothing can be sent
    const r = await refreshOnce(BNB, deps);
    expect(r.stale).toBe(true);
    expect(chain.sent).toEqual([]);
    expect(r.refresh).toMatch(/^not sent: /);
  });

  it('sends nothing, and says so, when the keeper is not the named refresher', async () => {
    chain.refresher = '0x0000000000000000000000000000000000000000' as Address;
    const r = await refreshOnce(BNB, deps);
    expect(chain.sent).toEqual([]);
    expect(r.notRefresher).toBe('0x0000000000000000000000000000000000000000');
    expect(r.refresh).toContain('not this keeper');
  });

  it('judges nothing when no timelock it serves can be read', async () => {
    deps.timelocks = [timelock(84532, BASE_TL, 7n * DAY, BNB, ATTESTOR, true)];
    const r = await refreshOnce(BNB, deps);
    expect(chain.sent).toEqual([]);
    expect(r.maxAgeSec).toBeNull();
    expect(r.unreadTimelocks).toHaveLength(1);
    expect(r.refresh).toContain('no timelock it serves could be read');
  });

  it("refuses an oracle that does not say it is a testnet stand-in", async () => {
    chain.isStandIn = false;
    const r = await refreshOnce(BNB, deps);
    expect(r.skipped).toContain('does not say it is a testnet stand-in');
    expect(chain.sent).toEqual([]);
  });

  it('refuses every mainnet before reading anything', async () => {
    const r = await refreshOnce(56, { ...deps, client: {} as PublicClient });
    expect(r.skipped).toContain('not a testnet');
  });

  it('refuses an RPC that serves another chain', async () => {
    chain.chainServed = 84532;
    const r = await refreshOnce(BNB, deps);
    expect(r.skipped).toContain('serves chain 84532');
  });
});
