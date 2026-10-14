/**
 * The time-based default pass (#2483).
 *
 * The pass is a sequence of refusals with one send at the end, so these
 * tests are mostly about the refusals: each one is a way the keeper could
 * otherwise sell a borrower's collateral on a premise the chain no longer
 * holds. Each asserts that NOTHING was written, not just the outcome tag.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { DefaultedFacetABI } from '@vaipakam/contracts/abis';
import {
  SWAP_ADAPTER_SUCCEEDED_TOPIC,
  SWAP_ALL_ADAPTERS_FAILED_TOPIC,
} from '@vaipakam/lib/routeBuilder';
import { LOCK_EARLY_WITHDRAWAL_SALE } from '@vaipakam/lib/saleHold';
import {
  attemptGraceDefault,
  findDefaultable,
  pickBatch,
  SCAN_WINDOW,
  rotate,
  type GraceDefaultDeps,
  type GraceLoan,
} from '../src/graceDefault';
import type { ServerOrchestrationResult } from '../src/serverQuotes';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const DIAMOND = A(0xd1);
const KEEPER = A(0xee);
const LOAN_ID = 21n;
const LOAN_TOPIC = `0x${LOAN_ID.toString(16).padStart(64, '0')}`;

const LIQUID: GraceLoan = {
  assetType: 0,
  collateralAssetType: 0,
  collateralAsset: A(1),
  collateralAmount: 10n ** 18n,
  principalAsset: A(2),
  lenderTokenId: 7n,
};

/** A viem-shaped revert, matched structurally the way the probe reads it. */
function revertWith(errorName: string): Error {
  const inner = { name: 'ContractFunctionRevertedError', data: { errorName } };
  const err = new Error('reverted') as Error & { walk: (fn: (x: unknown) => boolean) => unknown };
  err.walk = (fn) => (fn(inner) ? inner : null);
  return err;
}

interface Scene {
  /** Loan as read on each call, in order (the last one repeats). */
  loans?: GraceLoan[];
  lock?: number;
  teardown?: () => void;
  boundedListing?: boolean;
  /** The preview's ending; null makes the node fail the simulation. */
  ending?: 'sale' | 'fallback' | 'other' | null;
  calls?: number;
  /** Unmined keeper transactions on the chain (pending − latest nonce). */
  unmined?: number;
  /** Health factor; a function to compute it per read, or to throw (e.g.
   *  illiquid collateral). */
  hf?: bigint | (() => bigint);
  /** `lost`: the broadcast call fails after the signed bytes went out. */
  broadcast?: 'lost';
}

const SIGNED: Hex = '0x02f86b0182';

function harness(scene: Scene) {
  const writes: unknown[] = [];
  const previews: unknown[] = [];
  let loanReads = 0;
  const loans = scene.loans ?? [LIQUID];
  const client = {
    getBlockNumber: async () => 100n,
    getTransactionCount: async (args: { blockTag: string }) =>
      args.blockTag === 'pending' ? 7 + (scene.unmined ?? 0) : 7,
    readContract: async (args: { functionName: string }) => {
      switch (args.functionName) {
        case 'getLoanDetails': {
          const l = loans[Math.min(loanReads, loans.length - 1)];
          loanReads += 1;
          return l;
        }
        case 'positionLock':
          return BigInt(scene.lock ?? 0);
        case 'calculateHealthFactor':
          if (typeof scene.hf === 'function') return scene.hf();
          return scene.hf ?? 2n * 10n ** 18n;
        case 'facetAddress':
          return scene.boundedListing === false ? A(0) : A(0xfa);
        default:
          throw new Error(`unexpected read ${args.functionName}`);
      }
    },
    simulateContract: async () => {
      scene.teardown?.();
      return {};
    },
    simulateCalls: async (args: unknown) => {
      previews.push(args);
      if (scene.ending === null) throw new Error('eth_simulateV1 unsupported');
      const topics =
        scene.ending === 'sale'
          ? [SWAP_ADAPTER_SUCCEEDED_TOPIC]
          : scene.ending === 'fallback'
            ? [SWAP_ALL_ADAPTERS_FAILED_TOPIC]
            : [];
      return {
        results: [
          {
            status: 'success',
            logs: topics.map((t) => ({ address: DIAMOND, topics: [t, LOAN_TOPIC] })),
          },
        ],
      };
    },
  } as unknown as PublicClient;
  const wallet = {
    account: { address: KEEPER },
    // The submission slot (#2486) reads the pending nonce first.
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_getTransactionCount') return '0x0';
      throw new Error(`unexpected request ${method}`);
    },
    // The send is prepare → sign → broadcast; what was asked for is
    // recorded at the prepare, decoded, so tests read it like a call.
    prepareTransactionRequest: async (args: { data: Hex }) => {
      writes.push(decodeFunctionData({ abi: DefaultedFacetABI as Abi, data: args.data }));
      return args;
    },
    signTransaction: async () => SIGNED,
    sendRawTransaction: async () => {
      if (scene.broadcast === 'lost') throw new Error('request timed out');
      return keccak256(SIGNED);
    },
  } as unknown as WalletClient;
  const routes: GraceLoan[] = [];
  const deps: GraceDefaultDeps = {
    client,
    wallet,
    diamond: DIAMOND,
    chainId: 84532,
    buildRoute: async (loan) => {
      routes.push(loan);
      const n = scene.calls ?? 1;
      return {
        ranked: [],
        calls: Array.from({ length: n }, (_, i) => ({ adapterIdx: BigInt(i), data: '0x01' })),
        failed: [],
        route: null,
      } as unknown as ServerOrchestrationResult;
    },
  };
  return { deps, writes, previews, routes };
}

describe('attemptGraceDefault', () => {
  it('reports a lost broadcast as unconfirmed, naming the locally computed hash', async () => {
    const h = harness({ ending: 'sale', calls: 1, broadcast: 'lost' });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toMatchObject({ kind: 'unconfirmed', tx: keccak256(SIGNED), preview: 'sale', calls: 1 });
    expect(h.writes).toHaveLength(1);
  });

  it('submits triggerDefault with the quoted try-list when the preview is a sale', async () => {
    const h = harness({ ending: 'sale', calls: 2 });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({ kind: 'submitted', tx: keccak256(SIGNED), preview: 'sale', calls: 2 });
    expect(h.routes).toEqual([LIQUID]);
    expect(h.writes).toHaveLength(1);
    const w = h.writes[0] as { functionName: string; args: [bigint, unknown[]] };
    expect(w.functionName).toBe('triggerDefault');
    expect(w.args[0]).toBe(LOAN_ID);
    expect(w.args[1]).toHaveLength(2);
  });

  it('does NOT send a route that would fall into the full-collateral fallback', async () => {
    const h = harness({ ending: 'fallback' });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out.kind).toBe('skipped');
    expect((out as { reason: string }).reason).toMatch(/^preview=fallback/);
    expect(h.writes).toHaveLength(0);
  });

  it('does not send when the node cannot preview (or the call reverts)', async () => {
    const h = harness({ ending: null });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect((out as { reason: string }).reason).toMatch(/^preview=unknown/);
    expect(h.writes).toHaveLength(0);
  });

  it('sends an EMPTY list for NFT collateral and lets the contract pick its branch', async () => {
    const nft: GraceLoan = { ...LIQUID, collateralAssetType: 1 };
    const h = harness({ loans: [nft], ending: 'other' });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({ kind: 'submitted', tx: keccak256(SIGNED), preview: 'other', calls: 0 });
    expect(h.routes).toHaveLength(0);
    expect((h.writes[0] as { args: [bigint, unknown[]] }).args[1]).toEqual([]);
  });

  it('quotes nothing for a rental (non-ERC-20 principal)', async () => {
    const rental: GraceLoan = { ...LIQUID, assetType: 1 };
    const h = harness({ loans: [rental], ending: 'other' });
    await attemptGraceDefault(h.deps, LOAN_ID);
    expect(h.routes).toHaveLength(0);
  });

  describe('the sale interlock (#2078)', () => {
    it('skips an ACCEPTED lender-position sale — closing it would strand the buyer', async () => {
      const h = harness({
        lock: LOCK_EARLY_WITHDRAWAL_SALE,
        teardown: () => {
          throw revertWith('NoStaleSaleListing');
        },
        ending: 'sale',
      });
      const out = await attemptGraceDefault(h.deps, LOAN_ID);
      expect(out).toEqual({ kind: 'skipped', reason: 'sale-accepted' });
      expect(h.previews).toHaveLength(0);
      expect(h.writes).toHaveLength(0);
    });

    it('skips a sale state the chain does not establish', async () => {
      const h = harness({
        lock: LOCK_EARLY_WITHDRAWAL_SALE,
        teardown: () => {
          throw revertWith('EnforcedPause');
        },
        ending: 'sale',
      });
      const out = await attemptGraceDefault(h.deps, LOAN_ID);
      expect(out).toEqual({ kind: 'skipped', reason: 'sale-unknown' });
      expect(h.writes).toHaveLength(0);
    });

    it('skips when the probe cannot be read at all', async () => {
      const h = harness({
        lock: LOCK_EARLY_WITHDRAWAL_SALE,
        teardown: () => {
          throw new Error('fetch failed');
        },
        ending: 'sale',
      });
      const out = await attemptGraceDefault(h.deps, LOAN_ID);
      expect((out as { reason: string }).reason).toMatch(/^sale-unread:/);
      expect(h.writes).toHaveLength(0);
    });

    it('proceeds past a LIVE listing — no buyer has paid', async () => {
      const h = harness({
        lock: LOCK_EARLY_WITHDRAWAL_SALE,
        teardown: () => {
          throw revertWith('SaleListingLoanStillLive');
        },
        ending: 'sale',
      });
      const out = await attemptGraceDefault(h.deps, LOAN_ID);
      expect(out.kind).toBe('submitted');
    });

    it('does not trust a listing reading on a Diamond without the bounded lifecycle', async () => {
      const h = harness({
        lock: LOCK_EARLY_WITHDRAWAL_SALE,
        teardown: () => {
          throw revertWith('SaleListingLoanStillLive');
        },
        boundedListing: false,
        ending: 'sale',
      });
      const out = await attemptGraceDefault(h.deps, LOAN_ID);
      expect(out).toEqual({ kind: 'skipped', reason: 'sale-legacy-listing' });
      expect(h.writes).toHaveLength(0);
    });
  });

  it('refuses when the collateral changed after quoting (#2472)', async () => {
    const toppedUp: GraceLoan = { ...LIQUID, collateralAmount: LIQUID.collateralAmount + 1n };
    const h = harness({ loans: [LIQUID, toppedUp], ending: 'sale' });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({ kind: 'skipped', reason: 'gate:collateral-changed' });
    expect(h.writes).toHaveLength(0);
  });

  it('re-checks the sale at the final gate, not only before quoting', async () => {
    let probes = 0;
    const h = harness({
      lock: LOCK_EARLY_WITHDRAWAL_SALE,
      teardown: () => {
        probes += 1;
        // Live on the first look; accepted by the time of the gate.
        throw revertWith(probes === 1 ? 'SaleListingLoanStillLive' : 'NoStaleSaleListing');
      },
      ending: 'sale',
    });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({ kind: 'skipped', reason: 'gate:sale-accepted' });
    expect(h.writes).toHaveLength(0);
  });
});

describe('the preview is part of the final gate', () => {
  it('simulates at the gate block, so the route is judged where the other reads are', async () => {
    const h = harness({ ending: 'sale' });
    await attemptGraceDefault(h.deps, LOAN_ID);
    expect(h.previews).toHaveLength(1);
    expect(h.previews[0]).toMatchObject({ blockNumber: 100n });
  });
});

describe('a send still pending from an earlier run', () => {
  it('waits while the keeper has an unmined transaction — no duplicate triggerDefault', async () => {
    const h = harness({ unmined: 1, ending: 'sale' });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({ kind: 'skipped', reason: 'keeper-tx-pending (1 unmined)' });
    expect(h.routes).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it('reports an in-kind ending as such even when a try-list was sent', async () => {
    const h = harness({ ending: 'other', calls: 3 });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toMatchObject({ kind: 'submitted', preview: 'other', calls: 3 });
  });
});

describe('the liquidator boundary', () => {
  it('leaves an under-water loan to the HF liquidator wholly — no route, no preview, no send', async () => {
    const h = harness({ hf: 9n * 10n ** 17n, ending: 'other' });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({ kind: 'skipped', reason: 'hf-liquidatable (left to the liquidator)' });
    expect(h.routes).toHaveLength(0);
    expect(h.previews).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it('re-checks the health factor at the final gate — a price that crosses the line mid-quote', async () => {
    let reads = 0;
    const h = harness({
      hf: () => {
        reads += 1;
        // Healthy before quoting; under water by the time of the gate.
        return reads === 1 ? 2n * 10n ** 18n : 9n * 10n ** 17n;
      },
      ending: 'sale',
    });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({
      kind: 'skipped',
      reason: 'gate:hf-liquidatable (left to the liquidator)',
    });
    expect(reads).toBe(2);
    expect(h.writes).toHaveLength(0);
  });

  it('proceeds when the HF read REVERTS — illiquid collateral has no HF, and the liquidator skips it too', async () => {
    const nft: GraceLoan = { ...LIQUID, collateralAssetType: 1 };
    const h = harness({
      loans: [nft],
      hf: () => {
        throw revertWith('IlliquidCollateral');
      },
      ending: 'other',
    });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out.kind).toBe('submitted');
  });

  it('does not proceed when the HF read never got an answer', async () => {
    const h = harness({
      hf: () => {
        throw new Error('fetch failed');
      },
      ending: 'sale',
    });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect((out as { reason: string }).reason).toMatch(/^hf-unread:/);
    expect(h.writes).toHaveLength(0);
  });
});

describe('pickBatch', () => {
  it('takes consecutive, non-overlapping batches, so every loan is tried within ceil(n/width) runs', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const tried = new Set<number>();
    for (let run = 0; run < Math.ceil(items.length / 5); run += 1) {
      const { picked, deferred } = pickBatch(items, run, 5);
      expect(picked).toHaveLength(5);
      expect(picked.length + deferred.length).toBe(items.length);
      picked.forEach((x) => tried.add(x));
    }
    expect(tried.size).toBe(items.length);
  });

  it('defers nothing when the set fits in one batch', () => {
    expect(pickBatch([1, 2, 3], 9, 5)).toEqual({ picked: [1, 2, 3], deferred: [] });
  });
});

describe('rotate', () => {
  it('brings every candidate to the front within length runs', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const fronts = new Set<number>();
    for (let step = 0; step < items.length; step += 1) fronts.add(rotate(items, step)[0]);
    expect(fronts.size).toBe(items.length);
    expect(rotate(items, 3)).toEqual([4, 5, 6, 7, 1, 2, 3]);
    expect(rotate([], 5)).toEqual([]);
  });
});

describe('findDefaultable', () => {
  it('reads the active list AND every eligibility answer at one pinned block', async () => {
    const seen: (bigint | undefined)[] = [];
    const client = {
      getBlockNumber: async () => 555n,
      readContract: async (args: { functionName: string; blockNumber?: bigint }) => {
        seen.push(args.blockNumber);
        if (args.functionName === 'getActiveLoansCount') return 3n;
        if (args.functionName === 'getActiveLoansPaginated') return [4n, 5n, 6n];
        throw new Error(`unexpected read ${args.functionName}`);
      },
      multicall: async (args: { contracts: unknown[]; blockNumber?: bigint }) => {
        seen.push(args.blockNumber);
        return [
          { status: 'success', result: false },
          { status: 'success', result: true },
          { status: 'failure', error: new Error('reverted') },
        ];
      },
    } as unknown as PublicClient;
    await expect(findDefaultable(client, DIAMOND, 84532)).resolves.toEqual({
      defaultable: [5n],
      unread: [6n],
      window: { index: 0, count: 1, total: 3 },
    });
    expect(seen).toEqual([555n, 555n, 555n]);
  });

  it('scans one bounded window per visit and walks a large book window by window', async () => {
    const total = BigInt(SCAN_WINDOW * 2 + 50);
    const pages: [bigint, bigint][] = [];
    let aggregates = 0;
    const client = {
      getBlockNumber: async () => 9n,
      readContract: async (args: { functionName: string; args?: [bigint, bigint] }) => {
        if (args.functionName === 'getActiveLoansCount') return total;
        if (args.functionName === 'getActiveLoansPaginated') {
          const [from, limit] = args.args!;
          pages.push([from, limit]);
          return Array.from({ length: Number(limit) }, (_, i) => from + BigInt(i) + 1n);
        }
        throw new Error(`unexpected read ${args.functionName}`);
      },
      multicall: async (args: { contracts: unknown[] }) => {
        aggregates += 1;
        return args.contracts.map(() => ({ status: 'success', result: false }));
      },
    } as unknown as PublicClient;

    const third = await findDefaultable(client, DIAMOND, 84532, 2);
    expect(third.window).toEqual({ index: 2, count: 3, total: Number(total) });
    // The last window holds only the 50 ids past 2 × SCAN_WINDOW.
    expect(pages).toEqual([[BigInt(SCAN_WINDOW * 2), 50n]]);
    expect(aggregates).toBe(1);

    pages.length = 0;
    aggregates = 0;
    const wrapped = await findDefaultable(client, DIAMOND, 84532, 3);
    expect(wrapped.window.index).toBe(0);
    // A full window: never more than SCAN_WINDOW ids, whatever the book.
    expect(pages.reduce((n, [, l]) => n + Number(l), 0)).toBe(SCAN_WINDOW);
    expect(aggregates).toBeLessThanOrEqual(Math.ceil(SCAN_WINDOW / 100));
  });

  it('marks a rejected or throwing aggregate unread instead of retrying each id serially', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => BigInt(i + 1));
    let eligibilityReads = 0;
    let aggregates = 0;
    const shared = new Error('aggregate3 rejected');
    const client = {
      getBlockNumber: async () => 7n,
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === 'getActiveLoansCount') return BigInt(ids.length);
        if (args.functionName === 'getActiveLoansPaginated') return ids;
        eligibilityReads += 1;
        return true;
      },
      multicall: async (args: { contracts: unknown[] }) => {
        aggregates += 1;
        // First chunk: rejected (one shared error); second chunk: throws.
        if (aggregates === 1) return args.contracts.map(() => ({ status: 'failure', error: shared }));
        throw new Error('multicall unavailable');
      },
    } as unknown as PublicClient;
    const scan = await findDefaultable(client, DIAMOND, 84532);
    expect(eligibilityReads).toBe(0);
    expect(aggregates).toBe(2);
    expect(scan.defaultable).toEqual([]);
    expect(scan.unread).toEqual(ids);
  });
});
