import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, type Address } from 'viem';
import { buildCloseOutRoute, quotableVenues } from './closeOutRoute';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const sale = { sellToken: A(1), buyToken: A(2), sellAmount: 10n ** 18n };
const S = (idx: number) => ({ idx, address: A(0x100 + idx) });
const noChain = {
  readContract: async () => {
    throw new Error('unused');
  },
  call: async () => {
    throw new Error('no quoter');
  },
};

function fakeFetch(bodies: Record<string, unknown>) {
  const seen: { url: string; body: unknown }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init?.body)) });
    const body = Object.entries(bodies).find(([k]) => url.endsWith(k))?.[1];
    if (body === undefined) return new Response('{}', { status: 502 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe('quotableVenues', () => {
  it('asks the aggregators only through a configured agent', () => {
    const roster = { zeroex: S(0), oneinch: S(1) };
    expect(quotableVenues(roster, 8453, true)).toEqual(['zeroex', 'oneinch']);
    expect(quotableVenues(roster, 8453, false)).toEqual([]);
  });

  it('asks Uniswap V3 only where the chain has a quoter', () => {
    expect(quotableVenues({ univ3: S(2) }, 8453, false)).toEqual(['univ3']);
    expect(quotableVenues({ univ3: S(2) }, 84532, false)).toEqual([]);
  });

  it('offers the testnet mock wherever the roster recognised it', () => {
    expect(quotableVenues({ testnetMock: S(0) }, 84532, false)).toEqual(['testnetMock']);
  });
});

describe('buildCloseOutRoute', () => {
  it('ranks aggregator quotes and packs each for its own adapter index', async () => {
    const { impl, seen } = fakeFetch({
      '/quote/0x': { transaction: { to: A(0xa), data: '0x01' }, buyAmount: '100' },
      '/quote/1inch': { tx: { to: A(0xb), data: '0x02' }, dstAmount: '200' },
    });
    const route = await buildCloseOutRoute({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(3), oneinch: S(1) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route.kind).toBe('route');
    if (route.kind !== 'route') return;
    expect(route.venues).toEqual(['oneinch', 'zeroex']);
    expect(route.calls.map((c) => c.adapterIdx)).toEqual([1n, 3n]);
    expect(
      decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], route.calls[0].data),
    ).toEqual([A(0xb), '0x02']);
    expect(seen[0].body).toEqual({
      chainId: 8453,
      sellToken: A(1),
      buyToken: A(2),
      sellAmount: (10n ** 18n).toString(),
      taker: A(0x103),
    });
    expect(seen[1].body).toMatchObject({ taker: A(0x101) });
  });

  it('drops a venue that declines and keeps the rest', async () => {
    const { impl } = fakeFetch({
      '/quote/1inch': { tx: { to: A(0xb), data: '0x02' }, dstAmount: '200' },
    });
    const route = await buildCloseOutRoute({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(0), oneinch: S(1) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route.kind === 'route' && route.venues).toEqual(['oneinch']);
  });

  function mockChain(state: {
    shouldRevert?: boolean;
    restrictedTo?: Address;
    bps?: bigint;
    balance?: bigint;
  }) {
    return {
      readContract: async (args: { functionName: string }) => {
        switch (args.functionName) {
          case 'shouldRevert':
            return state.shouldRevert ?? false;
          case 'restrictedTo':
            return state.restrictedTo ?? A(0xd);
          case 'outputMultiplierBps':
            return state.bps ?? 10_000n;
          case 'tokenUsdPrice8':
            return 0n;
          case 'balanceOf':
            return state.balance ?? 10n ** 21n;
          default:
            throw new Error('unexpected');
        }
      },
      call: noChain.call,
    };
  }

  const mockRoute = (client: ReturnType<typeof mockChain>) =>
    buildCloseOutRoute({
      client: client as any,
      chainId: 84532,
      diamond: A(0xd),
      roster: { testnetMock: S(0) },
      sale,
      agentOrigin: null,
    });

  it('quotes the testnet mock from its own state and ranks it like any venue', async () => {
    const { impl } = fakeFetch({
      '/quote/0x': { transaction: { to: A(0xa), data: '0x01' }, buyAmount: '1' },
    });
    const route = await buildCloseOutRoute({
      client: mockChain({ bps: 9_000n }) as any,
      chainId: 84532,
      diamond: A(0xd),
      roster: { testnetMock: S(0), zeroex: S(1) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route).toEqual({
      kind: 'route',
      venues: ['testnetMock', 'zeroex'],
      calls: [{ adapterIdx: 0n, data: '0x' }, expect.objectContaining({ adapterIdx: 1n })],
    });
  });

  it('leaves out a mock that would revert, refuse the Diamond, or could not pay', async () => {
    expect(await mockRoute(mockChain({ shouldRevert: true }))).toEqual({ kind: 'no-quote' });
    expect(await mockRoute(mockChain({ restrictedTo: A(0xe) }))).toEqual({ kind: 'no-quote' });
    expect(await mockRoute(mockChain({ balance: 10n ** 17n }))).toEqual({ kind: 'no-quote' });
    expect(await mockRoute(mockChain({ restrictedTo: A(0) }))).toMatchObject({ kind: 'route' });
  });

  it('says there is no route when nothing quotes, rather than sending an empty list', async () => {
    const { impl } = fakeFetch({});
    const route = await buildCloseOutRoute({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(0), univ3: S(2) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route).toEqual({ kind: 'no-quote' });
  });
});
