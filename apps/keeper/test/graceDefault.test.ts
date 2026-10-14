/**
 * The time-based default pass (#2483).
 *
 * The pass is a sequence of refusals with one send at the end, so these
 * tests are mostly about the refusals: each one is a way the keeper could
 * otherwise sell a borrower's collateral on a premise the chain no longer
 * holds. Each asserts that NOTHING was written, not just the outcome tag.
 */
import { describe, expect, it } from 'vitest';
import type { Address, PublicClient, WalletClient } from 'viem';
import {
  SWAP_ADAPTER_SUCCEEDED_TOPIC,
  SWAP_ALL_ADAPTERS_FAILED_TOPIC,
} from '@vaipakam/lib/routeBuilder';
import { LOCK_EARLY_WITHDRAWAL_SALE } from '@vaipakam/lib/saleHold';
import {
  attemptGraceDefault,
  findDefaultable,
  pickBatch,
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
  /** Health factor; a function to compute it per read, or to throw (e.g.
   *  illiquid collateral). */
  hf?: bigint | (() => bigint);
}

function harness(scene: Scene) {
  const writes: unknown[] = [];
  const previews: unknown[] = [];
  let loanReads = 0;
  const loans = scene.loans ?? [LIQUID];
  const client = {
    getBlockNumber: async () => 100n,
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
      const topic =
        scene.ending === 'sale'
          ? SWAP_ADAPTER_SUCCEEDED_TOPIC
          : scene.ending === 'fallback'
            ? SWAP_ALL_ADAPTERS_FAILED_TOPIC
            : null;
      return {
        results: [
          {
            status: 'success',
            logs: topic ? [{ address: DIAMOND, topics: [topic, LOAN_TOPIC] }] : [],
          },
        ],
      };
    },
  } as unknown as PublicClient;
  const wallet = {
    account: { address: KEEPER },
    writeContract: async (args: unknown) => {
      writes.push(args);
      return '0xabc';
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
  it('submits triggerDefault with the quoted try-list when the preview is a sale', async () => {
    const h = harness({ ending: 'sale', calls: 2 });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({ kind: 'submitted', tx: '0xabc', preview: 'sale', route: 'swap' });
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
    expect(out).toEqual({ kind: 'submitted', tx: '0xabc', preview: 'other', route: 'none' });
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

describe('the liquidator boundary', () => {
  it('leaves an under-water loan to the HF liquidator — no competing sale is quoted', async () => {
    // The empty list a liquid loan cannot close with: the chain refuses it.
    const h = harness({ hf: 9n * 10n ** 17n, ending: null });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({
      kind: 'skipped',
      reason: 'hf-liquidatable (left to the liquidator) preview=unknown',
    });
    expect(h.routes).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it('closes an under-water loan IN KIND when the chain takes the no-swap branch — the liquidator needs a route it may not have', async () => {
    // A genuinely LTV-collapsed loan: `triggerDefault` moves the collateral
    // in kind with an empty list, which the quote-bound liquidator cannot do.
    const h = harness({ hf: 9n * 10n ** 17n, ending: 'other' });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toMatchObject({ kind: 'submitted', preview: 'other', route: 'none' });
    expect(h.routes).toHaveLength(0);
  });

  it('never sends an under-water loan into a swap ending of its own', async () => {
    const h = harness({ hf: 9n * 10n ** 17n, ending: 'sale' });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({
      kind: 'skipped',
      reason: 'hf-liquidatable (left to the liquidator) preview=sale',
    });
    expect(h.writes).toHaveLength(0);
  });

  it('refuses the in-kind send when the health factor recovered by the gate', async () => {
    let reads = 0;
    const h = harness({
      hf: () => {
        reads += 1;
        return reads === 1 ? 9n * 10n ** 17n : 2n * 10n ** 18n;
      },
      ending: 'other',
    });
    const out = await attemptGraceDefault(h.deps, LOAN_ID);
    expect(out).toEqual({ kind: 'skipped', reason: 'gate:hf-recovered' });
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
    });
    expect(seen).toEqual([555n, 555n, 555n]);
  });
});
