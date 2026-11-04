import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { MULTICALL3, readBaseBooks, readLocalLedger } from '../src/mesh';
import type { ChainTarget, CoverageGap } from '../src/chains';

const DIAMOND = '0x63816B149266C9dBFB7683dfd02D851915238049' as Address;
/** A viem-shaped revert, which `classify` reads as `contract-revert`. */
const revert = Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' });

type Outcome = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
interface Call {
  functionName: string;
  args: readonly unknown[];
  blockNumber: bigint;
  multicallAddress: Address;
  batchSize: number;
  allowFailure: boolean;
}

/**
 * A client that answers each view by name, counts its requests, and records
 * what every multicall asked for. `fail` names views that revert.
 */
function fakeTarget(values: Record<string, unknown>, fail: readonly string[] = []) {
  const calls: Call[][] = [];
  let blockReads = 0;
  const client = {
    multicall: async (p: {
      contracts: { functionName: string; args: readonly unknown[] }[];
      blockNumber: bigint;
      multicallAddress: Address;
      batchSize: number;
      allowFailure: boolean;
    }): Promise<Outcome[]> => {
      calls.push(
        p.contracts.map((c) => ({
          functionName: c.functionName,
          args: c.args,
          blockNumber: p.blockNumber,
          multicallAddress: p.multicallAddress,
          batchSize: p.batchSize,
          allowFailure: p.allowFailure,
        })),
      );
      return p.contracts.map((c) =>
        fail.includes(c.functionName)
          ? { status: 'failure', error: revert }
          : { status: 'success', result: values[c.functionName] },
      );
    },
    getBlock: async () => {
      blockReads += 1;
      return { number: 777n, timestamp: 1_800_000_000n };
    },
  } as unknown as PublicClient;
  const target: ChainTarget = { chainId: 421614, slug: 'arb-sepolia', diamond: DIAMOND, client };
  return { target, calls, blockReads: () => blockReads };
}

const BASE_VIEWS = {
  getChainRecycledLedger: [10n, 4n, 6n, 3n],
  getChainRecycledCommitRetirement: [2n, 1n],
  getChainOutstandingRecycledCommit: 2n,
  getChainRepatriationDraw: [0n, 0n],
  getChainKeeperDraw: 0n,
  getChainRemittedRecycled: [5n, 0n],
};

const LOCAL_VIEWS = {
  getRecycleCustodyPosition: [1n, 9n, 10n],
  getLocalRecycledCommitRetirement: [2n, 1n],
  getGovernorCommitState: [0n, 0n, 2n, 0n],
  getRecycleCompositionPosition: [10n, 0n, false, 0n],
  getRepatriationPosition: [0n, DIAMOND, DIAMOND, 0n],
  getReconciliationTotals: [0n, 0n, 0n],
  getRecycleBackingSnapshotV2: [9n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false, false, 0n, 0n],
};

describe('batched reads — one request per Diamond', () => {
  it("reads Base's books for a chain in one multicall, pinned and unsplit", async () => {
    const { target, calls } = fakeTarget(BASE_VIEWS);
    const gaps: CoverageGap[] = [];
    const books = await readBaseBooks(target, 97, 555n, gaps);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((c) => c.functionName)).toEqual(Object.keys(BASE_VIEWS));
    for (const c of calls[0]!) {
      expect(c.args).toEqual([97]);
      expect(c.blockNumber).toBe(555n);
      expect(c.multicallAddress).toBe(MULTICALL3);
      expect(c.batchSize).toBe(0);
      expect(c.allowFailure).toBe(true);
    }
    expect(gaps).toEqual([]);
    expect(books).toMatchObject({
      chainId: 97,
      reported: 10n,
      consumed: 4n,
      avail: 6n,
      attributed: 3n,
      retired: 2n,
      released: 1n,
      outstanding: 2n,
      keeperDraw: 0n,
      recycledAcked: 5n,
      repat: { netDraw: 0n, lifetimeReleased: 0n },
    });
  });

  it('a newer view that reverts costs only its own value, named as a cut problem', async () => {
    const { target } = fakeTarget(BASE_VIEWS, ['getChainKeeperDraw']);
    const gaps: CoverageGap[] = [];
    const books = await readBaseBooks(target, 97, 555n, gaps);

    expect(books.keeperDraw).toBeUndefined();
    expect(books.reported).toBe(10n);
    expect(books.recycledAcked).toBe(5n);
    expect(gaps.map((g) => g.source)).toEqual(['base-books-keeper']);
    expect(gaps[0]!.detail).toContain("CURRENT CUT");
  });

  it('a required view that fails fails the whole read, with no partial gaps', async () => {
    const { target } = fakeTarget(BASE_VIEWS, ['getChainRecycledLedger', 'getChainKeeperDraw']);
    const gaps: CoverageGap[] = [];
    await expect(readBaseBooks(target, 97, 555n, gaps)).rejects.toBe(revert);
    expect(gaps).toEqual([]);
  });

  it("reads a chain's own books with one head read and one multicall at that head", async () => {
    const { target, calls, blockReads } = fakeTarget(LOCAL_VIEWS);
    const { ledger, gaps } = await readLocalLedger(target);

    expect(blockReads()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((c) => c.functionName)).toEqual(Object.keys(LOCAL_VIEWS));
    for (const c of calls[0]!) expect(c.blockNumber).toBe(777n);
    expect(gaps).toEqual([]);
    expect(ledger).toMatchObject({
      chainId: 421614,
      custodyRelocated: 1n,
      bucket: 9n,
      reportedCumulative: 10n,
      outstandingRecycled: 2n,
      composition: { credited: 10n, isCanonicalRewardChain: false },
      repatriatedOut: 0n,
      reattribution: { reattributedIn: 0n, reattributedOut: 0n },
      backing: { vpfiBalance: 9n, custodyActivated: false },
      observedAt: 1_800_000_000n,
    });
  });

  it('each optional local view that fails becomes its own gap', async () => {
    const { target } = fakeTarget(LOCAL_VIEWS, [
      'getRecycleCompositionPosition',
      'getRecycleBackingSnapshotV2',
    ]);
    const { ledger, gaps } = await readLocalLedger(target);

    expect(ledger.composition).toBeUndefined();
    expect(ledger.backing).toBeUndefined();
    expect(ledger.repatriatedOut).toBe(0n);
    expect(gaps.map((g) => g.source)).toEqual(['own-ledger-composition', 'own-ledger-backing']);
  });
});
