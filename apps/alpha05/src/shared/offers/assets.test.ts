import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type Abi, type PublicClient } from 'viem';
import { OracleFacetABI } from '@vaipakam/contracts/abis';
import { loadLastPair, parsePasted, readAssetClass, saveLastPair } from './assets';
import { TLIQ, WETH } from './testOffer';

type Hex = `0x${string}`;
const DIAMOND: Hex = '0x9999999999999999999999999999999999999999';

function client(status: number, liquidity: () => number): PublicClient {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => (functionName === 'getAssetPriceStatus' ? [status, 0n, 0] : liquidity())),
  } as unknown as PublicClient;
}

describe('an asset’s class, as the protocol reads it', () => {
  it('reports a distrusted price before asking about liquidity', async () => {
    expect(
      await readAssetClass(
        client(2, () => 0),
        DIAMOND,
        WETH,
      ),
    ).toBe('distrusted');
  });
  it('reads liquid and illiquid from the liquidity probe', async () => {
    expect(
      await readAssetClass(
        client(0, () => 0),
        DIAMOND,
        WETH,
      ),
    ).toBe('liquid');
    expect(
      await readAssetClass(
        client(1, () => 1),
        DIAMOND,
        WETH,
      ),
    ).toBe('illiquid');
  });
  it('lets a read failure through rather than guessing a class', async () => {
    await expect(
      readAssetClass(
        client(0, () => {
          throw new Error('rpc down');
        }),
        DIAMOND,
        WETH,
      ),
    ).rejects.toThrow('rpc down');
  });
  it('treats the protocol’s divergent-price refusal as distrusted, and no other refusal', async () => {
    const abi = OracleFacetABI as Abi;
    const failing = (errorName: string) => {
      const data = encodeErrorResult({ abi, errorName } as Parameters<typeof encodeErrorResult>[0]);
      const err = new BaseError('reverted', { cause: new ContractFunctionRevertedError({ abi, data, functionName: 'checkLiquidityOnActiveNetwork' }) });
      return client(0, () => {
        throw err;
      });
    };
    expect(await readAssetClass(failing('OraclePriceDivergence'), DIAMOND, WETH)).toBe('distrusted');
    await expect(readAssetClass(failing('SequencerDown'), DIAMOND, WETH)).rejects.toBeTruthy();
  });
});

describe('a pasted address and the remembered pair', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('accepts an address of the right shape, checksummed, and nothing else', () => {
    expect(parsePasted(`  ${WETH.toLowerCase()} `)).toBe(WETH);
    expect(parsePasted('0x123')).toBeNull();
    expect(parsePasted('weth')).toBeNull();
  });
  it('keeps the pair per network and survives a blocked store', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    saveLastPair('t', 1, { lending: WETH, collateral: TLIQ });
    expect(loadLastPair('t', 1)).toEqual({ lending: WETH, collateral: TLIQ });
    expect(loadLastPair('t', 2)).toBeNull();
    store.set('t:3', '{"lending":"nope"}');
    expect(loadLastPair('t', 3)).toBeNull();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(loadLastPair('t', 1)).toBeNull();
    expect(() => saveLastPair('t', 1, { lending: WETH, collateral: TLIQ })).not.toThrow();
  });
});
