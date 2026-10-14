/**
 * The keeper's route building reads adapter indexes from the Diamond and
 * quotes each aggregator for its ADAPTER (#2468). The table it replaced
 * carried hand-kept indexes, quoted for the Diamond, and had no Base
 * Sepolia entry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeAbiParameters, type Address, type PublicClient } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { orchestrateServerQuotes } from '../src/serverQuotes';
import type { Env } from '../src/env';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const DIAMOND = A(0xd1);
const SELL = A(1);
const BUY = A(2);
const KEEPER = A(0xee);
const SWAP_TARGET = A(0x5a);
const BASE_SEPOLIA = 84532;
const MOCK = getDeployment(BASE_SEPOLIA)!.testnetMocks!.mockSwapAdapter as Address;

/** A Diamond listing `adapters` (address → adapterName), all enabled. */
function chain(adapters: [Address, string][], targetAllowed = true): PublicClient {
  const names = new Map(adapters.map(([a, n]) => [a.toLowerCase(), n]));
  return {
    readContract: async (args: { address: Address; functionName: string }) => {
      switch (args.functionName) {
        case 'getSwapAdapters':
          return adapters.map(([a]) => a);
        case 'adapterName':
          return names.get(args.address.toLowerCase());
        case 'isSwapAdapterDisabled':
          return false;
        case 'getLiquidationConfig':
          return [0n, 600n, 0n];
        case 'swapTargetAllowed':
          return targetAllowed;
        // The testnet mock: live, unrestricted, 1:1, funded.
        case 'shouldRevert':
          return false;
        case 'restrictedTo':
          return A(0);
        case 'outputMultiplierBps':
          return 10_000n;
        case 'tokenUsdPrice8':
          return 0n;
        case 'balanceOf':
          return 10n ** 30n;
        default:
          throw new Error(`unexpected read ${args.functionName}`);
      }
    },
    call: async () => {
      throw new Error('no quoter on this chain');
    },
  } as unknown as PublicClient;
}

const sale = { sellToken: SELL, buyToken: BUY, sellAmount: 10n ** 18n };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('orchestrateServerQuotes (#2468)', () => {
  it('builds a Base Sepolia route through the testnet mock at its ON-CHAIN index', async () => {
    // The mock sits at index 1 behind an adapter this module cannot name.
    const client = chain([
      [A(0xab), 'SomethingElse'],
      [MOCK, 'Mock'],
    ]);
    const out = await orchestrateServerQuotes({} as Env, client, {
      chainId: BASE_SEPOLIA,
      diamond: DIAMOND,
      ...sale,
    });
    expect(out.calls).toEqual([{ adapterIdx: 1n, data: '0x' }]);
    expect(out.ranked.map((r) => r.kind)).toEqual(['testnetMock']);
  });

  it('quotes 0x for ITS ADAPTER with the keeper as origin, at the index the Diamond lists', async () => {
    const zeroEx = A(0x0e);
    const client = chain([
      [MOCK, 'Mock'],
      [zeroEx, 'ZeroEx'],
    ]);
    const seen: URL[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(new URL(url));
      return new Response(
        JSON.stringify({ transaction: { to: SWAP_TARGET, data: '0xabcd' }, buyAmount: '5' }),
        { status: 200 },
      );
    });
    const out = await orchestrateServerQuotes({ ZEROEX_API_KEY: 'k' } as Env, client, {
      chainId: BASE_SEPOLIA,
      diamond: DIAMOND,
      txOrigin: KEEPER,
      ...sale,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].searchParams.get('taker')).toBe(zeroEx);
    expect(seen[0].searchParams.get('txOrigin')).toBe(KEEPER);
    // The protocol's own slippage ceiling, read from the Diamond.
    expect(seen[0].searchParams.get('slippageBps')).toBe('600');
    const zx = out.ranked.find((r) => r.kind === 'zeroex')!;
    expect(zx.call.adapterIdx).toBe(1n);
    const [target] = decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], zx.call.data);
    expect(target).toBe(SWAP_TARGET);
  });

  it('does not ask 0x without an origin, and says why', async () => {
    const client = chain([[A(0x0e), 'ZeroEx']]);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await orchestrateServerQuotes({ ZEROEX_API_KEY: 'k' } as Env, client, {
      chainId: BASE_SEPOLIA,
      diamond: DIAMOND,
      ...sale,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.calls).toEqual([]);
    expect(out.failed).toEqual(['zeroex:origin-bound']);
  });

  describe('what a 0x answer that is not a usable quote is called (#2480 r5)', () => {
    const zeroEx = A(0x0e);
    const ask = async (body: unknown, targetAllowed = true) => {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }));
      return orchestrateServerQuotes({ ZEROEX_API_KEY: 'k' } as Env, chain([[zeroEx, 'ZeroEx']], targetAllowed), {
        chainId: BASE_SEPOLIA,
        diamond: DIAMOND,
        txOrigin: KEEPER,
        ...sale,
      });
    };

    it('a swap target the adapter does not allow is its own outcome, not a decline', async () => {
      const out = await ask({ transaction: { to: SWAP_TARGET, data: '0xabcd' }, buyAmount: '5' }, false);
      expect(out.calls).toEqual([]);
      expect(out.failed).toEqual(['zeroex:target-not-allowed']);
    });

    it("an explicit no-liquidity answer is a decline", async () => {
      const out = await ask({ liquidityAvailable: false });
      expect(out.failed).toEqual(['zeroex:declined']);
    });

    it('a body that is neither is unanswered, not a market fact', async () => {
      const out = await ask({});
      expect(out.failed).toEqual(['zeroex:unanswered']);
    });
  });

  it('says an enabled adapter it cannot name exists, rather than dropping it', async () => {
    const client = chain([[A(0xab), 'SomeNewVenue']]);
    const out = await orchestrateServerQuotes({} as Env, client, {
      chainId: BASE_SEPOLIA,
      diamond: DIAMOND,
      ...sale,
    });
    expect(out.calls).toEqual([]);
    expect(out.failed).toEqual(['unrecognized-adapters:1']);
  });

  it('says no adapter is enabled, rather than an empty failure list', async () => {
    const out = await orchestrateServerQuotes({} as Env, chain([]), {
      chainId: BASE_SEPOLIA,
      diamond: DIAMOND,
      ...sale,
    });
    expect(out.calls).toEqual([]);
    expect(out.failed).toEqual(['no-enabled-adapters']);
  });

  it('reports an unreadable roster instead of throwing, without the RPC URL', async () => {
    const client = {
      readContract: async () => {
        throw new Error('HTTP request failed. URL: https://rpc.example/v2/SECRET_KEY');
      },
    } as unknown as PublicClient;
    const out = await orchestrateServerQuotes({} as Env, client, {
      chainId: BASE_SEPOLIA,
      diamond: DIAMOND,
      ...sale,
    });
    expect(out.calls).toEqual([]);
    expect(out.failed[0]).toMatch(/^roster-unread:/);
    expect(out.failed[0]).not.toContain('SECRET_KEY');
  });
});
