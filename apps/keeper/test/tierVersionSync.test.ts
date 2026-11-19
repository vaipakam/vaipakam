/**
 * #912 — the tier-version sync (protocol upkeep step 8), run against a fake
 * Base Diamond whose `broadcastTierTableVersionTo` lifts the named mirror to
 * Base's version, and fake mirrors read from their own RPCs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { describeTierVersion, mirrorVersionReader, parseSent, sentItem, syncTierTableVersions, TIER_VERSION_ABI, type MirrorVersionRead } from '../src/tierVersionSync';
import { memoryScanCursors } from '../src/scanCursors';
import { StepSender, type SendFeeCeiling } from '../src/stepSender';
import type { KeeperContext } from '../src/keeper';

const CHAIN = 84532;
const ARB = 421614;
const BNB = 97;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const NOW = 1_000_000;

class FakeBase {
  version = 3;
  fee = new Map<bigint, bigint>([[BigInt(ARB), 500n], [BigInt(BNB), 700n]]);
  mirrors = new Map<number, number>([[ARB, 2], [BNB, 3]]);
  sent: { dest: bigint; value: bigint }[] = [];
  /** The lane quote refuses. */
  quoteFails = false;

  readContract = async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    if (functionName === 'getTierTableVersion') return this.version;
    if (functionName === 'quoteBroadcastTierTableVersionTo') {
      if (this.quoteFails) throw new Error('LaneNotConfigured');
      return this.fee.get(args![0] as bigint)!;
    }
    throw new Error(`unexpected read ${functionName}`);
  };

  simulateContract = async ({ functionName }: { functionName: string }) => {
    expect(functionName).toBe('broadcastTierTableVersionTo');
    return { result: undefined };
  };
  getBlockNumber = async () => 120n;
  getBlock = async () => ({ number: 120n, timestamp: BigInt(NOW) });
  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => ({ status: 'success', logs: [], blockNumber: 1n });

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
        writeContract: async ({ args, value }: { args: readonly unknown[]; value: bigint }) => {
          const dest = args[0] as bigint;
          this.sent.push({ dest, value });
          // Delivered over the lane later; the mirror's own read moves then.
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }

  readers(): MirrorVersionRead[] {
    return [...this.mirrors.keys()].map((chainId) => ({ chainId, read: async () => this.mirrors.get(chainId)! }));
  }
}

describe('the tier-version sync', () => {
  let b: FakeBase;
  let cursors: ReturnType<typeof memoryScanCursors>;

  beforeEach(() => {
    b = new FakeBase();
    cursors = memoryScanCursors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (opts: { nowSec?: number; ceiling?: SendFeeCeiling; mirrors?: MirrorVersionRead[] } = {}) => {
    const sender = new StepSender(
      {
        pass: 'protocolUpkeep',
        abi: TIER_VERSION_ABI,
        maxSends: 10,
        receiptTimeoutMs: 1_000,
        races: new Set(),
        pausedRefusal: 'EnforcedPause',
        describe: (s) => String(s),
        spends: 'the gas',
      },
      { context: () => b.ctx(), sendDeadline: Number.POSITIVE_INFINITY, feeCeiling: opts.ceiling ?? { wei: 10_000n, from: 'test' } },
    );
    return syncTierTableVersions(DIAMOND, sender, {
      readClient: b.client(),
      sendDeadline: Number.POSITIVE_INFINITY,
      cursors,
      mirrors: opts.mirrors ?? b.readers(),
      nowSec: opts.nowSec ?? NOW,
    }).then((report) => ({ report, sender }));
  };

  it('sends Base\'s version, with the quoted fee, to the mirror behind it and to no other', async () => {
    const { report } = await run();
    expect(b.sent).toEqual([{ dest: BigInt(ARB), value: 500n }]);
    expect(report.base).toBe(3);
    expect(report.current).toEqual([`${BNB}@3`]);
    expect(report.sent).toEqual([`${ARB} (2 to 3, fee 500 wei)`]);
    expect(parseSent(cursors.rows.get(sentItem(ARB)))).toEqual({ version: 3, atSec: NOW });
  });

  it('does not pay again for a bump still in flight, and sends again once its window has passed', async () => {
    await run();
    const { report } = await run({ nowSec: NOW + 60 });
    expect(b.sent).toHaveLength(1);
    expect(report.waiting).toEqual([`${ARB}@2 (bump to 3 sent 60s ago)`]);
    await run({ nowSec: NOW + 6 * 3600 });
    expect(b.sent).toHaveLength(2);
  });

  it('sends again at once when Base moves to a newer version than the one in flight', async () => {
    await run();
    b.version = 4;
    await run({ nowSec: NOW + 60 });
    expect(b.sent.map((s) => s.dest)).toEqual([BigInt(ARB), BigInt(ARB), BigInt(BNB)]);
  });

  it('pays nothing above its ceiling and leaves the mirror behind', async () => {
    const { report, sender } = await run({ ceiling: { wei: 100n, from: 'test ceiling' } });
    expect(b.sent).toEqual([]);
    expect(report.sent).toEqual([]);
    expect(cursors.rows.has(sentItem(ARB))).toBe(false);
    expect([...sender.refused.values()].join(' ')).toMatch(/above this keeper's ceiling of 100 wei/);
  });

  it('sends nothing while Base has no version, and says so', async () => {
    b.version = 0;
    const { report } = await run();
    expect(b.sent).toEqual([]);
    expect(describeTierVersion(report)).toEqual(['tier-version=Base has no tier-table version set, so there is nothing to send']);
  });

  it('names an unreadable mirror and a mirror ahead of Base, and treats neither as behind', async () => {
    const mirrors: MirrorVersionRead[] = [
      { chainId: ARB, read: async () => { throw new Error('rpc down'); } },
      { chainId: BNB, read: async () => 5 },
    ];
    const { report, sender } = await run({ mirrors });
    expect(b.sent).toEqual([]);
    expect(report.ahead).toEqual([`${BNB}@5`]);
    expect(sender.unread.get(`tier-version:${ARB}`)).toMatch(/the mirror's tier-table version/);
  });

  it('names a lane it cannot quote as unread, sending nothing to it', async () => {
    b.quoteFails = true;
    const { sender } = await run();
    expect(b.sent).toEqual([]);
    expect(sender.unread.get(`tier-version:${ARB}`)).toMatch(/the lane fee/);
  });

  it("refuses a mirror RPC that serves another chain", async () => {
    const client = { getChainId: async () => 1, readContract: async () => 9 } as unknown as PublicClient;
    await expect(mirrorVersionReader(ARB, DIAMOND, client).read()).rejects.toThrow(/serves chain 1/);
  });
});
