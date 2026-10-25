/**
 * The periodic-interest settler pass.
 *
 * Like the grace-default pass it is a sequence of refusals with one send at
 * the end. Each refusal test asserts that NOTHING was written, not just the
 * outcome tag, and the sale tests assert the route was quoted for, and the
 * call sent with, the middle of the range the contract accepts (#2795,
 * #2796): a size outside `[sell, maxSell]` reverts the call.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { armHeldFence } from './helpers/epochFence';
import {
  decodeFunctionData,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { RepayPeriodicFacetABI } from '@vaipakam/contracts/abis';
import { LEFT_TO_LIQUIDATOR, type GraceLoan } from '../src/closeOut';
import {
  attemptPeriodicSettle,
  findSettleable,
  FORCED_SALE_KIND_PERIODIC,
  LEFT_TO_GRACE_DEFAULT_PASS,
  type ForcedSalePlan,
  type PeriodicSettleDeps,
} from '../src/periodicSettle';
import type { ServerOrchestrationResult } from '../src/serverQuotes';

beforeEach(() => armHeldFence());

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const DIAMOND = A(0xd1);
const KEEPER = A(0xee);
const LOAN_ID = 31n;
const SIGNED: Hex = '0x02f86b0182';

const LIQUID: GraceLoan = {
  assetType: 0,
  collateralAssetType: 0,
  collateralAsset: A(1),
  collateralAmount: 10n ** 18n,
  principalAsset: A(2),
  lenderTokenId: 7n,
};

const NO_SALE: ForcedSalePlan = { debt: 0n, need: 0n, sell: 0n, floor: 0n, covered: false, maxSell: 0n };
const SALE: ForcedSalePlan = {
  debt: 100n,
  need: 105n,
  sell: 4n * 10n ** 16n,
  floor: 106n,
  covered: true,
  maxSell: 4n * 10n ** 16n + 2_000n,
};
/** `forcedSaleQuoteAmount(SALE)`: the middle of `[sell, maxSell]`. */
const QUOTED = SALE.sell + 1_000n;

function revertWith(errorName: string): Error {
  const inner = { name: 'ContractFunctionRevertedError', data: { errorName } };
  const err = new Error('reverted') as Error & { walk: (fn: (x: unknown) => boolean) => unknown };
  err.walk = (fn) => (fn(inner) ? inner : null);
  return err;
}

interface Scene {
  /** The plan as read on each call, in order (the last one repeats). */
  plans?: ForcedSalePlan[];
  loan?: GraceLoan;
  hf?: bigint;
  defaultable?: boolean;
  unmined?: number;
  calls?: number;
  /** The simulation reverts with this error name. */
  simulateRevert?: string;
}

function harness(scene: Scene) {
  const writes: { functionName: string; args: readonly unknown[] }[] = [];
  const quotedFor: bigint[] = [];
  const simulations: { args: readonly unknown[]; blockNumber?: bigint }[] = [];
  const planBlocks: (bigint | undefined)[] = [];
  let planReads = 0;
  const plans = scene.plans ?? [NO_SALE];
  const client = {
    getBlockNumber: async () => 100n,
    getTransactionCount: async (args: { blockTag: string }) =>
      args.blockTag === 'pending' ? 7 + (scene.unmined ?? 0) : 7,
    readContract: async (args: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      switch (args.functionName) {
        case 'getLoanDetails':
          return scene.loan ?? LIQUID;
        case 'calculateHealthFactor':
          return scene.hf ?? 2n * 10n ** 18n;
        case 'isLoanDefaultable':
          return scene.defaultable ?? false;
        case 'previewForcedSale': {
          expect(args.args).toEqual([LOAN_ID, FORCED_SALE_KIND_PERIODIC]);
          planBlocks.push(args.blockNumber);
          const p = plans[Math.min(planReads, plans.length - 1)];
          planReads += 1;
          return p;
        }
        default:
          throw new Error(`unexpected read ${args.functionName}`);
      }
    },
    simulateContract: async (args: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }) => {
      expect(args.functionName).toBe('settlePeriodicInterest');
      simulations.push({ args: args.args, blockNumber: args.blockNumber });
      if (scene.simulateRevert) throw revertWith(scene.simulateRevert);
      return {};
    },
  } as unknown as PublicClient;
  const wallet = {
    account: { address: KEEPER },
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_getTransactionCount') return '0x0';
      throw new Error(`unexpected request ${method}`);
    },
    prepareTransactionRequest: async (args: { data: Hex }) => {
      const d = decodeFunctionData({ abi: RepayPeriodicFacetABI as Abi, data: args.data });
      writes.push({ functionName: d.functionName, args: d.args ?? [] });
      return args;
    },
    signTransaction: async () => SIGNED,
    sendRawTransaction: async () => keccak256(SIGNED),
  } as unknown as WalletClient;
  const deps: PeriodicSettleDeps = {
    client,
    wallet,
    diamond: DIAMOND,
    chainId: 84532,
    notAfterMs: Number.MAX_SAFE_INTEGER,
    buildRoute: async (_loan, sell) => {
      quotedFor.push(sell);
      const n = scene.calls ?? 1;
      return {
        ranked: [],
        calls: Array.from({ length: n }, (_, i) => ({ adapterIdx: BigInt(i), data: '0x01' })),
        failed: n > 0 ? [] : ['zeroex:declined'],
        route: null,
        noQuote: n > 0 ? null : 'declined',
        marketDeclined: n === 0,
      } as unknown as ServerOrchestrationResult;
    },
  };
  return { deps, writes, quotedFor, simulations, planBlocks };
}

describe('attemptPeriodicSettle', () => {
  it('stamps a fully paid period with an empty try-list and quotes nothing', async () => {
    const h = harness({ plans: [NO_SALE] });
    const out = await attemptPeriodicSettle(h.deps, LOAN_ID);
    expect(out).toMatchObject({ kind: 'submitted', path: 'stamp', sell: 0n, calls: 0 });
    expect(h.quotedFor).toEqual([]);
    expect(h.writes).toEqual([{ functionName: 'settlePeriodicInterest', args: [LOAN_ID, 0n, []] }]);
  });

  it('quotes a shortfall sale at the middle of the contract-sized range, never the whole collateral', async () => {
    const h = harness({ plans: [SALE], calls: 2 });
    const out = await attemptPeriodicSettle(h.deps, LOAN_ID);
    expect(out).toMatchObject({ kind: 'submitted', path: 'sale', sell: QUOTED, calls: 2 });
    expect(h.quotedFor).toEqual([QUOTED]);
    expect(h.quotedFor[0]).not.toBe(LIQUID.collateralAmount);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].functionName).toBe('settlePeriodicInterest');
    // The call carries the size the route was quoted for.
    expect(h.writes[0].args[1]).toBe(QUOTED);
    expect((h.writes[0].args[2] as unknown[]).length).toBe(2);
    expect(h.simulations[0].args[1]).toBe(QUOTED);
    // The plan is read again at the gate's block, and the simulation runs there.
    expect(h.planBlocks).toEqual([undefined, 100n]);
    expect(h.simulations).toHaveLength(1);
    expect(h.simulations[0].blockNumber).toBe(100n);
  });

  it('leaves an under-water loan to the liquidator and sends nothing', async () => {
    const h = harness({ plans: [SALE], hf: 9n * 10n ** 17n });
    await expect(attemptPeriodicSettle(h.deps, LOAN_ID)).resolves.toEqual({
      kind: 'skipped',
      reason: LEFT_TO_LIQUIDATOR,
    });
    expect(h.quotedFor).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('leaves a loan past its maturity grace to the grace-default pass and sends nothing', async () => {
    const h = harness({ plans: [SALE], defaultable: true });
    await expect(attemptPeriodicSettle(h.deps, LOAN_ID)).resolves.toEqual({
      kind: 'skipped',
      reason: LEFT_TO_GRACE_DEFAULT_PASS,
    });
    expect(h.writes).toEqual([]);
  });

  it('still sends when the range moved but the quote is inside it', async () => {
    const moved = { ...SALE, debt: SALE.debt + 1n, sell: SALE.sell + 1n };
    const h = harness({ plans: [SALE, moved] });
    const out = await attemptPeriodicSettle(h.deps, LOAN_ID);
    expect(out).toMatchObject({ kind: 'submitted', path: 'sale', sell: QUOTED });
  });

  it('refuses when the range moved past the quote between the quote and the gate', async () => {
    const moved = { ...SALE, sell: QUOTED + 1n, maxSell: QUOTED + 3_000n };
    const h = harness({ plans: [SALE, moved] });
    const out = await attemptPeriodicSettle(h.deps, LOAN_ID);
    expect(out.kind === 'skipped' && out.reason).toBe(
      `gate:quote-out-of-range quoted=${QUOTED} range=[${moved.sell},${moved.maxSell}]`,
    );
    expect(h.simulations).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('refuses when a stamp became a sale between the read and the gate', async () => {
    const h = harness({ plans: [NO_SALE, SALE] });
    const out = await attemptPeriodicSettle(h.deps, LOAN_ID);
    expect(out.kind === 'skipped' && out.reason).toMatch(/^gate:plan-changed/);
    expect(h.simulations).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('names the revert when the simulation fails, and sends nothing', async () => {
    const h = harness({ plans: [SALE], simulateRevert: 'PeriodicSettleSwapFailed' });
    const out = await attemptPeriodicSettle(h.deps, LOAN_ID);
    expect(out.kind === 'skipped' && out.reason).toMatch(/^gate:simulation PeriodicSettleSwapFailed path=sale/);
    expect(h.writes).toEqual([]);
  });

  it('holds while an earlier keeper transaction is unmined', async () => {
    const h = harness({ plans: [SALE], unmined: 1 });
    const out = await attemptPeriodicSettle(h.deps, LOAN_ID);
    expect(out.kind === 'skipped' && out.reason).toMatch(/^keeper-tx-pending/);
    expect(h.quotedFor).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('sends nothing when no venue quoted the sized sale', async () => {
    const h = harness({ plans: [SALE], calls: 0 });
    const out = await attemptPeriodicSettle(h.deps, LOAN_ID);
    expect(out.kind === 'skipped' && out.reason).toMatch(/^no-route sell=/);
    expect(h.writes).toEqual([]);
  });

  it('sends nothing for a shortfall the plan sizes to no sale', async () => {
    const h = harness({ plans: [{ ...SALE, sell: 0n }] });
    await expect(attemptPeriodicSettle(h.deps, LOAN_ID)).resolves.toEqual({
      kind: 'skipped',
      reason: 'plan-sells-nothing',
    });
    expect(h.writes).toEqual([]);
  });

  it('sends nothing for a shortfall on a loan with no ERC-20 to ERC-20 sale', async () => {
    const h = harness({ plans: [SALE], loan: { ...LIQUID, collateralAssetType: 1 } });
    const out = await attemptPeriodicSettle(h.deps, LOAN_ID);
    expect(out.kind === 'skipped' && out.reason).toMatch(/^not-swappable/);
    expect(h.quotedFor).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});

describe('findSettleable', () => {
  const preview = (cadence: number, canSettleNow: boolean) => ({
    status: 'success',
    result: [cadence, 1n, 2n, 3n, 0n, 3n, canSettleNow],
  });

  it('keeps only cadence loans the contract says may be settled now, all at one pinned block', async () => {
    const seen: (bigint | undefined)[] = [];
    const client = {
      getBlockNumber: async () => 555n,
      readContract: async (args: { functionName: string; blockNumber?: bigint }) => {
        seen.push(args.blockNumber);
        if (args.functionName === 'getActiveLoansCount') return 4n;
        if (args.functionName === 'getActiveLoansPaginated') return [4n, 5n, 6n, 7n];
        if (args.functionName === 'getPeriodicInterestEnabled') return true;
        throw new Error(`unexpected read ${args.functionName}`);
      },
      multicall: async (args: { blockNumber?: bigint }) => {
        seen.push(args.blockNumber);
        return [
          preview(0, false), // no cadence
          preview(1, true), // due
          preview(2, false), // grace not over
          { status: 'failure', error: new Error('reverted') },
        ];
      },
    } as unknown as PublicClient;
    await expect(findSettleable(client, DIAMOND, 84532)).resolves.toEqual({
      kind: 'scanned',
      due: [5n],
      unread: [7n],
      window: { index: 0, count: 1, total: 4 },
    });
    expect(seen).toEqual([555n, 555n, 555n, 555n]);
  });

  it('stops before the previews while periodic interest is switched off', async () => {
    let aggregates = 0;
    const client = {
      getBlockNumber: async () => 1n,
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === 'getActiveLoansCount') return 2n;
        if (args.functionName === 'getActiveLoansPaginated') return [1n, 2n];
        if (args.functionName === 'getPeriodicInterestEnabled') return false;
        throw new Error(`unexpected read ${args.functionName}`);
      },
      multicall: async () => {
        aggregates += 1;
        return [];
      },
    } as unknown as PublicClient;
    await expect(findSettleable(client, DIAMOND, 84532)).resolves.toEqual({ kind: 'disabled' });
    expect(aggregates).toBe(0);
  });
});
