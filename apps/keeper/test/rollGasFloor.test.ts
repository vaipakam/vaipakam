/**
 * #2760 item 3 — the keeper rolls an intent loan only when the rolled amount is
 * worth at least 100x the roll's gas, both valued by the Diamond.
 */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  ROLL_MIN_VALUE_TO_GAS,
  estimateRollFeeWei,
  judgeRollValue,
  rollFeeModel,
  rollUnpricedReason,
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

describe('rollFeeModel', () => {
  it('charges OP-stack chains their L1 data fee, and knows no model for an unlisted chain', () => {
    for (const id of [8453, 84532, 10, 11155420]) expect(rollFeeModel(id)).toBe('opStack');
    for (const id of [1, 11155111, 137, 42161, 421614]) expect(rollFeeModel(id)).toBe('gasOnly');
    expect(rollFeeModel(97)).toBeNull();
    expect(rollFeeModel(999_999)).toBeNull();
  });
  it('names why a chain cannot be valued', () => {
    expect(rollUnpricedReason(84532)).toBeNull();
    expect(rollUnpricedReason(97)).toMatch(/wrapped native token/);
  });
});

describe('estimateRollFeeWei', () => {
  const request = {
    address: DIAMOND,
    abi: [] as never,
    functionName: 'rollIntentLoan',
    args: [1n],
    account: { address: DIAMOND, type: 'json-rpc' } as never,
  };
  it('is gas times price where the chain charges nothing else', async () => {
    const c = { estimateContractGas: async () => 50_000n, getGasPrice: async () => 3n };
    expect(await estimateRollFeeWei(c as never, 421614, request)).toBe(150_000n);
  });
  it('refuses a chain whose fee model is unknown instead of returning the gas alone', async () => {
    const c = { estimateContractGas: async () => 50_000n, getGasPrice: async () => 3n };
    await expect(estimateRollFeeWei(c as never, 97, request)).rejects.toThrow(/fee model/);
  });
  it('passes the estimate revert through, so an undelegated owner is still recognised', async () => {
    const c = {
      estimateContractGas: async () => {
        throw new Error('reverted: KeeperAccessRequired');
      },
      getGasPrice: async () => 1n,
    };
    await expect(estimateRollFeeWei(c as never, 1, request)).rejects.toThrow(/KeeperAccessRequired/);
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
function client(values: Record<string, bigint | 'throw'>) {
  const calls: { asset: string; units: bigint; roundUp: boolean }[] = [];
  return {
    calls,
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

  it('rolls when the amount is worth 100x its fee, rounding the fee up and the amount down', async () => {
    const c = client(values);
    // fee = 100_000 wei; amount = 10_000_000 >= 100 x 100_000.
    const v = await judgeRollValue(c as never, DIAMOND, 84532, USDC, 10_000_000n, 100_000n);
    expect(v).toEqual({ kind: 'worth', rolledValue: 10_000_000n, gasValue: 100_000n });
    expect(c.calls).toEqual([
      { asset: WETH_BASE_SEPOLIA, units: 100_000n, roundUp: true },
      { asset: USDC.toLowerCase(), units: 10_000_000n, roundUp: false },
    ]);
  });

  it('declines a dust roll', async () => {
    const v = await judgeRollValue(client(values) as never, DIAMOND, 84532, USDC, 9_999_999n, 100_000n);
    expect(v.kind).toBe('dust');
  });

  it('cannot value gas on a chain with no known wrapped native token', async () => {
    const v = await judgeRollValue(client(values) as never, DIAMOND, 97, USDC, 10n ** 30n, 1n);
    expect(v.kind).toBe('gasUnpriced');
  });

  it('cannot value gas when the wrapped token price is unreadable', async () => {
    expect(
      (await judgeRollValue(client({ [USDC.toLowerCase()]: 1n }) as never, DIAMOND, 84532, USDC, 1n, 1n)).kind,
    ).toBe('gasUnpriced');
  });

  it('reports an unpriced lending asset as specific to that loan', async () => {
    const v = await judgeRollValue(client({ [WETH_BASE_SEPOLIA]: 1n }) as never, DIAMOND, 84532, USDC, 1n, 1n);
    expect(v.kind).toBe('assetUnpriced');
  });
});
