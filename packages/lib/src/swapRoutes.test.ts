import { decodeAbiParameters, type PublicClient } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orchestrateSwapRoutes, swapRouteInternals, type SwapRouteRequest } from './swapRoutes';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const MOCK = '0x00000000000000000000000000000000000000a2' as const;
const OTHER = '0x00000000000000000000000000000000000000a1' as const;
const SELL = '0x0000000000000000000000000000000000000c01' as const; // collateral
const BUY = '0x0000000000000000000000000000000000000b01' as const; // principal

/** A fake chain answering only the reads the mock venue makes. */
function fakeClient(opts: {
  adapters: string[];
  names: Record<string, string | Error>;
  disabled?: string[];
  prices?: Record<string, bigint>;
  multiplier?: bigint;
}): PublicClient {
  return {
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }) => {
      if (functionName === 'getSwapAdapters') return opts.adapters;
      if (functionName === 'isSwapAdapterDisabled') return (opts.disabled ?? []).includes(args![0] as string);
      if (functionName === 'adapterName') {
        const n = opts.names[address];
        if (n instanceof Error || n === undefined) throw n ?? new Error('no adapterName');
        return n;
      }
      if (functionName === 'tokenUsdPrice8') return opts.prices?.[args![0] as string] ?? 0n;
      if (functionName === 'outputMultiplierBps') return opts.multiplier ?? 10_000n;
      throw new Error(`unexpected read ${functionName}`);
    },
    call: async () => {
      throw new Error('no quoter on this chain');
    },
  } as unknown as PublicClient;
}

const req = (chainId: number, sellAmount = 10n ** 18n): SwapRouteRequest => ({
  chainId,
  sellToken: SELL,
  buyToken: BUY,
  sellAmount,
  taker: DIAMOND,
});

afterEach(() => vi.restoreAllMocks());

describe('testnet mock venue (#2463)', () => {
  it('discovers the mock by name, skipping other adapters, and prices it with the mock’s own formula', async () => {
    const client = fakeClient({
      adapters: [OTHER, MOCK],
      names: { [OTHER]: new Error('not named'), [MOCK]: 'vaipakam-testnet-mock' },
      prices: { [SELL]: 3_000n * 10n ** 8n, [BUY]: 10n ** 8n }, // mWETH $3,000, mUSDC $1
      multiplier: 9_900n,
    });
    const r = await orchestrateSwapRoutes({}, client, req(84532));
    expect(r.calls).toEqual([{ adapterIdx: 1n, data: '0x' }]);
    // 1 × 3000 / 1 × 0.99
    expect(r.ranked[0]).toMatchObject({ kind: 'testnetMock', expectedOutput: 2_970n * 10n ** 18n });
  });

  it('falls back to the flat payout when a leg has no registered price, exactly as the mock does', async () => {
    const client = fakeClient({ adapters: [MOCK], names: { [MOCK]: 'vaipakam-testnet-mock' } });
    const r = await orchestrateSwapRoutes({}, client, req(84532, 5n));
    expect(r.ranked[0].expectedOutput).toBe(5n);
  });

  it('never uses a disabled mock, a differently named adapter, or any mock on a mainnet', async () => {
    const disabled = fakeClient({
      adapters: [MOCK],
      names: { [MOCK]: 'vaipakam-testnet-mock' },
      disabled: [MOCK],
    });
    expect((await orchestrateSwapRoutes({}, disabled, req(84532))).calls).toEqual([]);

    const renamed = fakeClient({ adapters: [MOCK], names: { [MOCK]: 'some-other-adapter' } });
    expect((await orchestrateSwapRoutes({}, renamed, req(84532))).calls).toEqual([]);

    const mainnet = fakeClient({ adapters: [MOCK], names: { [MOCK]: 'vaipakam-testnet-mock' } });
    const r = await orchestrateSwapRoutes({}, mainnet, req(8453));
    expect(r.ranked.find((q) => q.kind === 'testnetMock')).toBeUndefined();
  });

  it('reports a venue it could not quote as failed, and never throws', async () => {
    const broken = {
      readContract: async () => {
        throw new Error('rpc down');
      },
      call: async () => {
        throw new Error('rpc down');
      },
    } as unknown as PublicClient;
    const r = await orchestrateSwapRoutes({}, broken, req(84532));
    expect(r.calls).toEqual([]);
    expect(r.failed).toContain('testnetMock');
  });
});

describe('aggregator venues and ranking', () => {
  it('skips an aggregator whose key is absent, without a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = fakeClient({ adapters: [], names: {} });
    const r = await orchestrateSwapRoutes({}, client, req(8453));
    expect(r.failed).toEqual(expect.arrayContaining(['zeroex', 'oneinch']));
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('0x.org') || String(u).includes('1inch'))).toEqual([]);
  });

  it('ranks by expected output and packs aggregator calldata as (swapTarget, swapCalldata)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.0x.org')) {
        return new Response(
          JSON.stringify({ buyAmount: '100', transaction: { to: '0x00000000000000000000000000000000000000e1', data: '0xaa' } }),
        );
      }
      if (url.includes('api.1inch.dev')) {
        return new Response(
          JSON.stringify({ dstAmount: '150', tx: { to: '0x00000000000000000000000000000000000000e2', data: '0xbb' } }),
        );
      }
      return new Response('{}', { status: 404 });
    });
    const client = fakeClient({ adapters: [], names: {} });
    const r = await orchestrateSwapRoutes({ zeroExApiKey: 'k0', oneInchApiKey: 'k1' }, client, req(8453));
    expect(r.ranked.map((q) => q.kind)).toEqual(['oneinch', 'zeroex']);
    expect(r.calls.map((c) => c.adapterIdx)).toEqual([1n, 0n]); // Base registry: zeroex 0, oneinch 1
    const [target, calldata] = decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], r.calls[0].data);
    expect([target.toLowerCase(), calldata]).toEqual(['0x00000000000000000000000000000000000000e2', '0xbb']);
  });

  it('packAdapterData is the (address, bytes) wire format the adapter decodes', () => {
    const packed = swapRouteInternals.packAdapterData('0x00000000000000000000000000000000000000e3', '0x1234');
    const [t, d] = decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], packed);
    expect([t.toLowerCase(), d]).toEqual(['0x00000000000000000000000000000000000000e3', '0x1234']);
  });
});
