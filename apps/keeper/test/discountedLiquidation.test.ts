/**
 * #2697 — the flash-loan discount path sizes the swap from the Diamond's
 * preview, and the profit floor from the transaction's own fee in the
 * principal token's units, never from placeholders.
 */
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  DISCOUNTED_LIQUIDATION_READY,
  DISCOUNTED_LIQUIDATION_STATUS,
  discountedStatusReason,
  liquidatorFunction,
  minProfitForFee,
  planFlashLoanLiquidation,
  type DiscountedLiquidationPreview,
  type FlashLoanPlanDeps,
  type FlashLoanSaleQuote,
} from '../src/discountedLiquidation';

const DIAMOND = '0x0000000000000000000000000000000000000001' as Address;
const USDC = '0x00000000000000000000000000000000000000c0' as Address; // 6 decimals
const DAI = '0x00000000000000000000000000000000000000da' as Address; // 18 decimals
const WETH_BASE_SEPOLIA = '0x4200000000000000000000000000000000000006';
const COLLATERAL = '0x00000000000000000000000000000000000000ee' as Address;

/** A Diamond over a price table (1e18 numeraire per whole token) and token
 *  decimals, answering `getNumeraireValue` and `getAmountForNumeraireValue`
 *  with the same rounding the facet uses. */
function pricingDiamond(prices: Record<string, { price: bigint; decimals: number }>) {
  const calls: { fn: string; args: readonly unknown[] }[] = [];
  const of = (asset: Address) => {
    const p = prices[asset.toLowerCase()];
    if (!p) throw new Error('NoPriceFeed');
    return { price: p.price, unit: 10n ** BigInt(p.decimals) };
  };
  const div = (a: bigint, b: bigint, up: boolean) => (up ? (a + b - 1n) / b : a / b);
  return {
    calls,
    readContract: async (req: { functionName: string; args: readonly [Address, bigint, boolean] }) => {
      calls.push({ fn: req.functionName, args: req.args });
      const [asset, x, up] = req.args;
      const { price, unit } = of(asset);
      if (req.functionName === 'getNumeraireValue') return div(x * price, unit, up);
      if (req.functionName === 'getAmountForNumeraireValue') return div(x * unit, price, up);
      throw new Error(`unexpected ${req.functionName}`);
    },
  };
}

// ETH at $3,000; both stablecoins at $1.
const PRICES = {
  [WETH_BASE_SEPOLIA]: { price: 3_000n * 10n ** 18n, decimals: 18 },
  [USDC.toLowerCase()]: { price: 10n ** 18n, decimals: 6 },
  [DAI.toLowerCase()]: { price: 10n ** 18n, decimals: 18 },
};

describe('minProfitForFee', () => {
  // A fee of 0.0001 ETH = $0.30.
  const feeWei = 10n ** 14n;

  it('prices the fee in a 6-decimal principal in its own units', async () => {
    const r = await minProfitForFee(pricingDiamond(PRICES) as never, DIAMOND, 84532, USDC, feeWei);
    expect(r).toEqual({ kind: 'priced', minProfit: 300_000n }); // 0.30 USDC
  });

  it('prices the same fee in an 18-decimal principal in its own units', async () => {
    const r = await minProfitForFee(pricingDiamond(PRICES) as never, DIAMOND, 84532, DAI, feeWei);
    expect(r).toEqual({ kind: 'priced', minProfit: 3n * 10n ** 17n }); // 0.30 DAI
  });

  it('rounds both conversions up, so a fee worth a fraction of a unit still costs one', async () => {
    const d = pricingDiamond(PRICES);
    expect(await minProfitForFee(d as never, DIAMOND, 84532, USDC, 1n)).toEqual({ kind: 'priced', minProfit: 1n });
    expect(d.calls.map((c) => c.args[2])).toEqual([true, true]);
  });

  it('has no floor when the gas or the principal cannot be priced', async () => {
    expect((await minProfitForFee(pricingDiamond(PRICES) as never, DIAMOND, 97, USDC, feeWei)).kind).toBe('unpriced');
    const noUsdc = { [WETH_BASE_SEPOLIA]: PRICES[WETH_BASE_SEPOLIA] };
    const r = await minProfitForFee(pricingDiamond(noUsdc) as never, DIAMOND, 84532, USDC, feeWei);
    expect(r.kind).toBe('unpriced');
  });
});

describe('the preview status', () => {
  it('mirrors LibDiscountedLiquidation.Status, Ready last', () => {
    expect(DISCOUNTED_LIQUIDATION_STATUS[0]).toBe('Paused');
    expect(DISCOUNTED_LIQUIDATION_READY).toBe(7);
    expect(discountedStatusReason(0)).toMatch(/paused/);
    expect(discountedStatusReason(1)).toMatch(/switch is off/);
    expect(discountedStatusReason(4)).toMatch(/healthy/);
    // #2734 — appended after Ready.
    expect(DISCOUNTED_LIQUIDATION_STATUS[8]).toBe('InternalMatchWindow');
    expect(discountedStatusReason(8)).toMatch(/internal-match priority window/);
    expect(discountedStatusReason(9)).toMatch(/unknown status 9/);
  });
  it('maps each provider to its entry', () => {
    expect(liquidatorFunction('aave-v3')).toBe('liquidateViaAaveV3');
    expect(liquidatorFunction('balancer-v2')).toBe('liquidateViaBalancerV2');
  });
});

describe('planFlashLoanLiquidation', () => {
  const ready = (over: Partial<DiscountedLiquidationPreview> = {}): DiscountedLiquidationPreview => ({
    status: DISCOUNTED_LIQUIDATION_READY,
    principalAsset: USDC,
    collateralAsset: COLLATERAL,
    tier: 3,
    discountBps: 500,
    debt: 1_000_000_000n, // 1,000 USDC
    seized: 1_050n * 10n ** 18n,
    surplus: 750n * 10n ** 18n,
    ...over,
  });
  const quote = (expectedOutput: bigint): FlashLoanSaleQuote => ({
    kind: 'zeroex',
    expectedOutput,
    adapter: '0x00000000000000000000000000000000000000a1' as Address,
    adapterData: '0xdeadbeef' as Hex,
  });
  function deps(over: Partial<FlashLoanPlanDeps> = {}) {
    const quoted: bigint[] = [];
    const estimated: (readonly unknown[])[] = [];
    const d: FlashLoanPlanDeps = {
      chainId: 84532,
      loanId: 7n,
      readPreview: async () => ready(),
      quote: async (sellAmount) => {
        quoted.push(sellAmount);
        return [quote(1_040_000_000n)];
      },
      estimateFee: async (args) => {
        estimated.push(args);
        return 10n ** 14n;
      },
      minProfit: (asset, feeWei) => minProfitForFee(pricingDiamond(PRICES) as never, DIAMOND, 84532, asset, feeWei),
      ...over,
    };
    return { d, quoted, estimated };
  }

  it('quotes the previewed seizure and sends with the fee as the profit floor', async () => {
    const { d, quoted, estimated } = deps();
    const plan = await planFlashLoanLiquidation(d);
    expect(quoted).toEqual([1_050n * 10n ** 18n]);
    // Estimated with no floor, re-simulated and sent with the fee's worth
    // in USDC (0.30).
    expect(estimated.map((a) => a[2])).toEqual([0n, 300_000n]);
    expect(plan.kind).toBe('send');
    if (plan.kind !== 'send') return;
    expect(plan.args).toEqual([
      7n,
      1_050n * 10n ** 18n,
      300_000n,
      '0x00000000000000000000000000000000000000a1',
      '0xdeadbeef',
    ]);
  });

  it('never quotes the whole collateral or sizes anything from it', async () => {
    const { d, quoted } = deps({ readPreview: async () => ready({ seized: 5n, surplus: 10n ** 30n }) });
    await planFlashLoanLiquidation(d);
    expect(quoted).toEqual([5n]);
  });

  it('skips, naming the reason, when the preview rules the liquidation out', async () => {
    const { d, quoted } = deps({ readPreview: async () => ready({ status: 1 }) });
    const plan = await planFlashLoanLiquidation(d);
    expect(plan).toEqual({ kind: 'skip', reason: "not liquidatable: the Diamond's discount-path switch is off" });
    expect(quoted).toEqual([]);
  });

  it('waits out the internal-match window rather than quoting', async () => {
    const { d, quoted } = deps({ readPreview: async () => ready({ status: 8 }) });
    const plan = await planFlashLoanLiquidation(d);
    expect(plan.kind === 'skip' && plan.reason).toMatch(/internal-match priority window/);
    expect(quoted).toEqual([]);
  });

  it('skips when the preview cannot be read', async () => {
    const { d } = deps({
      readPreview: async () => {
        throw new Error('OraclePriceDivergence()');
      },
    });
    const plan = await planFlashLoanLiquidation(d);
    expect(plan.kind === 'skip' && plan.reason).toMatch(/preview unread/);
  });

  it('skips a quote that does not even repay the debt, without simulating', async () => {
    const { d, estimated } = deps({ quote: async () => [quote(1_000_000_000n)] });
    const plan = await planFlashLoanLiquidation(d);
    expect(plan.kind === 'skip' && plan.reason).toMatch(/unprofitable/);
    expect(estimated).toEqual([]);
  });

  it('skips when the simulation reverts (the run would not net its fees)', async () => {
    const { d } = deps({
      estimateFee: async () => {
        throw new Error('InsufficientPostSwapBalance(1, 0)');
      },
    });
    const plan = await planFlashLoanLiquidation(d);
    expect(plan.kind === 'skip' && plan.reason).toMatch(/simulation reverted/);
  });

  it('skips a run that nets less than its fee, at the floored simulation', async () => {
    const { d, estimated } = deps({
      estimateFee: async (args) => {
        estimated.push(args);
        if (args[2] > 0n) throw new Error('InsufficientPostSwapBalance(2, 1)');
        return 10n ** 14n;
      },
    });
    const plan = await planFlashLoanLiquidation(d);
    expect(plan.kind === 'skip' && plan.reason).toMatch(/does not net its fee of 300000/);
    expect(estimated.map((a) => a[2])).toEqual([0n, 300_000n]);
  });

  it('re-sizes the floor when the floored call measures dearer, and sends the call it measured', async () => {
    // 0.0001 ETH unfloored; 0.0002 ETH once any floor rides along.
    const { d, estimated } = deps({
      estimateFee: async (args) => {
        estimated.push(args);
        return args[2] === 0n ? 10n ** 14n : 2n * 10n ** 14n;
      },
    });
    const plan = await planFlashLoanLiquidation(d);
    expect(estimated.map((a) => a[2])).toEqual([0n, 300_000n, 600_000n]);
    expect(plan.kind === 'send' && plan.args[2]).toBe(600_000n);
    expect(plan.kind === 'send' && plan.feeWei).toBe(2n * 10n ** 14n);
  });

  it('skips when the fee keeps rising with its own floor', async () => {
    let fee = 10n ** 14n;
    const { d } = deps({
      estimateFee: async () => {
        fee *= 2n;
        return fee;
      },
    });
    const plan = await planFlashLoanLiquidation(d);
    expect(plan.kind === 'skip' && plan.reason).toMatch(/kept rising/);
  });

  it('skips on a chain whose gas cannot be valued, before reading anything', async () => {
    let read = false;
    const { d } = deps({
      chainId: 97,
      readPreview: async () => {
        read = true;
        return ready();
      },
    });
    const plan = await planFlashLoanLiquidation(d);
    expect(plan.kind === 'skip' && plan.reason).toMatch(/gas cannot be valued/);
    expect(read).toBe(false);
  });

  it('skips when no swap adapter quotes the seizure', async () => {
    const { d } = deps({ quote: async () => [] });
    expect(await planFlashLoanLiquidation(d)).toEqual({ kind: 'skip', reason: 'no swap adapter quoted the seizure' });
  });
});
