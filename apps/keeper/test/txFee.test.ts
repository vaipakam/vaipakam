/**
 * #2760 item 3 / #2697 — the whole fee of a keeper transaction, and its value
 * through the chain's wrapped native token.
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, custom, encodeAbiParameters, toFunctionSelector, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  estimateTxFeeWei,
  feeNumeraireValue,
  txFeeModel,
  txFeeUnpricedReason,
  wrappedNativeToken,
} from '../src/txFee';

const DIAMOND = '0x0000000000000000000000000000000000000001' as Address;
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

describe('txFeeModel', () => {
  it('charges OP-stack chains their L1 data fee, and knows no model for an unlisted chain', () => {
    for (const id of [8453, 84532, 10, 11155420]) expect(txFeeModel(id)).toBe('opStack');
    for (const id of [1, 11155111, 137, 42161, 421614]) expect(txFeeModel(id)).toBe('gasOnly');
    expect(txFeeModel(97)).toBeNull();
    expect(txFeeModel(999_999)).toBeNull();
  });
  it('names why a chain cannot be valued', () => {
    expect(txFeeUnpricedReason(84532)).toBeNull();
    expect(txFeeUnpricedReason(97)).toMatch(/wrapped native token/);
  });
});

describe('estimateTxFeeWei', () => {
  const request = {
    address: DIAMOND,
    abi: [
      { type: 'function', name: 'rollIntentLoan', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
    ] as never,
    functionName: 'rollIntentLoan',
    args: [1n],
    account: { address: DIAMOND, type: 'json-rpc' } as never,
  };
  it('is gas times price where the chain charges nothing else', async () => {
    const c = { estimateContractGas: async () => 50_000n, getGasPrice: async () => 3n };
    expect(await estimateTxFeeWei(c as never, 421614, request)).toBe(150_000n);
  });
  it('refuses a chain whose fee model is unknown instead of returning the gas alone', async () => {
    const c = { estimateContractGas: async () => 50_000n, getGasPrice: async () => 3n };
    await expect(estimateTxFeeWei(c as never, 97, request)).rejects.toThrow(/fee model/);
  });
  /** A Base Sepolia client over a fake RPC: execution gas 50_000 at 3 wei, an
   *  L1 data fee of 7_000 wei, operator scalar 2_000_000 (2x) and constant 11. */
  function opClient(failOperatorFee = false) {
    const word = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }], [v]);
    const sel = (sig: string) => toFunctionSelector(sig).slice(0, 10);
    return createPublicClient({
      chain: baseSepolia,
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method === 'eth_estimateGas') return '0xc350';
          if (method === 'eth_gasPrice') return '0x3';
          if (method === 'eth_chainId') return '0x14a34';
          if (method === 'eth_call') {
            const data = ((params as [{ data: string }])[0].data ?? '').slice(0, 10);
            if (data === sel('getL1Fee(bytes)')) return word(7_000n);
            if (failOperatorFee) throw new Error('fetch failed');
            if (data === sel('operatorFeeScalar()')) return word(2_000_000n);
            if (data === sel('operatorFeeConstant()')) return word(11n);
          }
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
  }

  it('on an OP-stack chain adds the L1 data fee and the operator fee to the gas', async () => {
    // 50_000 x 3 + 7_000 + (50_000 x 2_000_000 / 1e6 + 11)
    expect(await estimateTxFeeWei(opClient() as never, 84532, request)).toBe(150_000n + 7_000n + 100_011n);
  });

  it('fails closed when the operator fee cannot be read, instead of taking it as zero (Codex #2807 r3)', async () => {
    await expect(estimateTxFeeWei(opClient(true) as never, 84532, request)).rejects.toThrow();
  });

  it('passes the estimate revert through, so an undelegated owner is still recognised', async () => {
    const c = {
      estimateContractGas: async () => {
        throw new Error('reverted: KeeperAccessRequired');
      },
      getGasPrice: async () => 1n,
    };
    await expect(estimateTxFeeWei(c as never, 1, request)).rejects.toThrow(/KeeperAccessRequired/);
  });
});

describe('feeNumeraireValue', () => {
  const reader = (perUnit: bigint | 'throw') => {
    const calls: unknown[] = [];
    return {
      calls,
      readContract: async (req: { args: readonly [Address, bigint, boolean] }) => {
        calls.push(req.args);
        if (perUnit === 'throw') throw new Error('NoPriceFeed');
        return req.args[1] * perUnit;
      },
    };
  };
  it('values the fee through the wrapped native token, rounding up', async () => {
    const c = reader(3n);
    expect(await feeNumeraireValue(c as never, DIAMOND, 84532, 100n)).toEqual({ kind: 'priced', value: 300n });
    expect((c.calls[0] as [string, bigint, boolean])[0].toLowerCase()).toBe(WETH_BASE_SEPOLIA);
    expect((c.calls[0] as [string, bigint, boolean])[2]).toBe(true);
  });
  it('has no value on a chain with no known wrapped native token, or when the price is unreadable', async () => {
    expect((await feeNumeraireValue(reader(1n) as never, DIAMOND, 97, 1n)).kind).toBe('unpriced');
    expect((await feeNumeraireValue(reader('throw') as never, DIAMOND, 84532, 1n)).kind).toBe('unpriced');
  });
});
