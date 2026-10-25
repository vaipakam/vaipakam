/**
 * #2760 item 3 — the keeper rolls an intent loan only when the rolled amount is
 * worth at least 100x the roll's gas, both valued by the Diamond.
 */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  ROLL_MIN_VALUE_TO_GAS,
  judgeRollValue,
  rollWorthItsGas,
  wrappedNativeToken,
} from '../src/rollGasFloor';

const DIAMOND = '0x0000000000000000000000000000000000000001' as Address;
const USDC = '0x00000000000000000000000000000000000000c0' as Address;
const WETH_BASE_SEPOLIA = '0x4200000000000000000000000000000000000006';

describe('wrappedNativeToken', () => {
  it('values ETH-gas chains through their WETH', () => {
    expect(wrappedNativeToken(84532)?.toLowerCase()).toBe(WETH_BASE_SEPOLIA);
  });
  it('knows Polygon gas is POL, and has no figure for BNB Testnet', () => {
    expect(wrappedNativeToken(137)).toBe('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270');
    // BNB Testnet's `weth` is a mock WETH, not wrapped BNB.
    expect(wrappedNativeToken(97)).toBeNull();
    expect(wrappedNativeToken(999_999)).toBeNull();
  });
});

describe('rollWorthItsGas', () => {
  it('needs the rolled value to be at least 100x the gas value', () => {
    expect(ROLL_MIN_VALUE_TO_GAS).toBe(100n);
    expect(rollWorthItsGas(100n, 1n)).toBe(true);
    expect(rollWorthItsGas(99n, 1n)).toBe(false);
    expect(rollWorthItsGas(0n, 0n)).toBe(true);
  });
});

/** A client whose Diamond values `asset` at `perUnit` numeraire per base unit
 *  (or throws), recording each valuation call. */
function client(values: Record<string, bigint | 'throw'>, gasPrice: bigint | 'throw' = 2n) {
  const calls: { asset: string; units: bigint; roundUp: boolean }[] = [];
  return {
    calls,
    getGasPrice: async () => {
      if (gasPrice === 'throw') throw new Error('rpc down');
      return gasPrice;
    },
    readContract: async (req: { args: readonly [Address, bigint, boolean] }) => {
      const [asset, units, roundUp] = req.args;
      calls.push({ asset: asset.toLowerCase(), units, roundUp });
      const v = values[asset.toLowerCase()];
      if (v === undefined || v === 'throw') throw new Error('NoPriceFeed');
      return units * v;
    },
  };
}

describe('judgeRollValue', () => {
  const values = { [WETH_BASE_SEPOLIA]: 1n, [USDC.toLowerCase()]: 1n };

  it('rolls when the amount is worth 100x its gas, rounding the gas up and the amount down', async () => {
    const c = client(values);
    // gas = 50_000 units x 2 wei = 100_000; amount = 10_000_000 >= 100 x 100_000.
    const v = await judgeRollValue(c as never, DIAMOND, 84532, USDC, 10_000_000n, 50_000n);
    expect(v).toEqual({ kind: 'worth', rolledValue: 10_000_000n, gasValue: 100_000n });
    expect(c.calls).toEqual([
      { asset: WETH_BASE_SEPOLIA, units: 100_000n, roundUp: true },
      { asset: USDC.toLowerCase(), units: 10_000_000n, roundUp: false },
    ]);
  });

  it('declines a dust roll', async () => {
    const v = await judgeRollValue(client(values) as never, DIAMOND, 84532, USDC, 9_999_999n, 50_000n);
    expect(v.kind).toBe('dust');
  });

  it('cannot value gas on a chain with no known wrapped native token', async () => {
    const v = await judgeRollValue(client(values) as never, DIAMOND, 97, USDC, 10n ** 30n, 1n);
    expect(v.kind).toBe('gasUnpriced');
  });

  it('cannot value gas when the gas price or the wrapped token price is unreadable', async () => {
    expect((await judgeRollValue(client(values, 'throw') as never, DIAMOND, 84532, USDC, 1n, 1n)).kind).toBe(
      'gasUnpriced',
    );
    expect(
      (await judgeRollValue(client({ [USDC.toLowerCase()]: 1n }) as never, DIAMOND, 84532, USDC, 1n, 1n)).kind,
    ).toBe('gasUnpriced');
  });

  it('reports an unpriced lending asset as specific to that loan', async () => {
    const v = await judgeRollValue(client({ [WETH_BASE_SEPOLIA]: 1n }) as never, DIAMOND, 84532, USDC, 1n, 1n);
    expect(v.kind).toBe('assetUnpriced');
  });
});
