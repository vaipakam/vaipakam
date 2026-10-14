import { describe, expect, it } from 'vitest';
import {
  RawContractError,
  decodeAbiParameters,
  encodeAbiParameters,
  type Address,
} from 'viem';
import {
  buildCloseOutRoute,
  noQuoteReason,
  previewCloseOut,
  classifySlots,
  readCloseOutRoster,
  routePosture,
  readQuoteProxyReadiness,
  readRouteStanding,
  routeMissingAnswers,
  type QuoteProxyReadiness,
  SWAP_ADAPTER_SUCCEEDED_TOPIC,
  SWAP_ALL_ADAPTERS_FAILED_TOPIC,
} from './closeOutRoute';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const sale = { sellToken: A(1), buyToken: A(2), sellAmount: 10n ** 18n };
const S = (idx: number) => [{ idx, address: A(0x100 + idx) }];
type RouteClient = Parameters<typeof buildCloseOutRoute>[0]['client'];
// Every aggregator target is on its adapter's allowlist unless a test
// says otherwise.
const chainReads = async (args: { functionName: string }): Promise<unknown> => {
  if (args.functionName === 'swapTargetAllowed') return true;
  // Every UniV3 adapter's router shares the quoter's factory.
  if (args.functionName === 'ROUTER') return A(0x77);
  if (args.functionName === 'factory') return A(0xfa);
  if (args.functionName === 'getLiquidationConfig') return [0n, 600n, 0n];
  throw new Error('unused');
};
const noChain = {
  readContract: chainReads,
  // No pool at any tier: the quoter reverts.
  call: async () => {
    throw new RawContractError({ data: '0x' });
  },
} as unknown as RouteClient;

function fakeFetch(bodies: Record<string, unknown>) {
  const seen: { url: string; body: unknown }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init?.body)) });
    const body = Object.entries(bodies).find(([k]) => url.endsWith(k))?.[1];
    // An aggregator with nothing for this pair answers 400 — a decline.
    if (body === undefined) return new Response('{}', { status: 400 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

/** The confirm's two steps as one call: judge every slot, then ask the
 *  askable ones. Tests state the roster; the slots are derived exactly as
 *  the card and the confirm derive them. */
async function build(
  deps: Omit<Parameters<typeof buildCloseOutRoute>[0], 'slots'> & {
    roster: Parameters<typeof classifySlots>[0]['roster'];
  },
) {
  const { roster, ...rest } = deps;
  const slots = await classifySlots({
    client: deps.client,
    chainId: deps.chainId,
    roster,
    quoteProxy: deps.agentOrigin !== null ? { oneinch: true } : 'absent',
  });
  return buildCloseOutRoute({ ...rest, slots });
}

describe('classifySlots', () => {
  const judge = (
    roster: Parameters<typeof classifySlots>[0]['roster'],
    opts: { chainId?: number; agent?: QuoteProxyReadiness; client?: RouteClient } = {},
  ) =>
    classifySlots({
      client: opts.client ?? noChain,
      chainId: opts.chainId ?? 8453,
      roster,
      quoteProxy: opts.agent ?? { oneinch: true },
    }).then((xs) => xs.map((x) => `${x.kind}:${x.askability}`));

  it('asks the aggregators only through a configured agent', async () => {
    const roster = { zeroex: S(0), oneinch: S(1) };
    expect(await judge(roster)).toEqual(['zeroex:origin-bound', 'oneinch:askable']);
    expect(await judge(roster, { agent: 'absent' })).toEqual([
      'zeroex:origin-bound',
      'oneinch:no-proxy',
    ]);
  });

  it('does not ask 1inch when the proxy holds no key for it, or its readiness is unread', async () => {
    expect(await judge({ oneinch: S(1) }, { agent: { oneinch: false } })).toEqual([
      'oneinch:unconfigured',
    ]);
    expect(await judge({ oneinch: S(1) }, { agent: 'unread' })).toEqual(['oneinch:unread']);
  });

  it('never asks 0x, whose quotes can bind to the transaction origin', async () => {
    expect(await judge({ zeroex: S(0) })).toEqual(['zeroex:origin-bound']);
  });

  it('asks Uniswap V3 only where the chain has a quoter on the same factory', async () => {
    expect(await judge({ univ3: S(2) })).toEqual(['univ3:askable']);
    expect(await judge({ univ3: S(2) }, { chainId: 84532 })).toEqual(['univ3:unpriceable']);
    const otherFactory = {
      ...noChain,
      readContract: async (args: { functionName: string; address: Address }) =>
        args.functionName === 'factory' && args.address === A(0x77)
          ? A(0xbad)
          : chainReads(args),
    } as unknown as RouteClient;
    expect(await judge({ univ3: S(2) }, { client: otherFactory })).toEqual(['univ3:other-pools']);
    const routerUnread = {
      ...noChain,
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === 'ROUTER') throw new Error('rpc');
        return chainReads(args);
      },
    } as unknown as RouteClient;
    expect(await judge({ univ3: S(2) }, { client: routerUnread })).toEqual(['univ3:unread']);
  });

  it('judges a kind this app cannot quote as unpriceable', async () => {
    expect(await judge({ balancerv2: S(3) })).toEqual(['balancerv2:unpriceable']);
  });

  it('offers the testnet mock wherever the roster recognised it', async () => {
    expect(await judge({ testnetMock: S(0) }, { chainId: 84532 })).toEqual(['testnetMock:askable']);
  });
});

describe('buildCloseOutRoute', () => {
  it('ranks quotes, packs each for its own adapter index, and never asks 0x', async () => {
    const { impl, seen } = fakeFetch({
      '/quote/0x': { transaction: { to: A(0xa), data: '0x01' }, buyAmount: '900' },
      '/quote/1inch': { tx: { to: A(0xb), data: '0x02' }, dstAmount: '200' },
    });
    const route = await build({
      client: mockChain({ bps: 9_000n }) as any,
      chainId: 84532,
      diamond: A(0xd),
      roster: { zeroex: S(3), oneinch: S(1), testnetMock: S(0) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route.kind).toBe('route');
    if (route.kind !== 'route') return;
    expect(route.venues).toEqual(['testnetMock', 'oneinch']);
    expect(route.calls.map((c) => c.adapterIdx)).toEqual([0n, 1n]);
    expect(
      decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], route.calls[1].data),
    ).toEqual([A(0xb), '0x02']);
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({
      chainId: 84532,
      sellToken: A(1),
      buyToken: A(2),
      sellAmount: (10n ** 18n).toString(),
      taker: A(0x101),
      slippageBps: 600,
    });
  });

  it('asks every enabled instance of a venue, each as its own taker', async () => {
    const { impl, seen } = fakeFetch({
      '/quote/1inch': { tx: { to: A(0xa), data: '0x01' }, dstAmount: '100' },
    });
    // The older adapter no longer allows the aggregator's current target;
    // its replacement does.
    const client = {
      readContract: async (args: { functionName: string; address: Address }) =>
        args.functionName === 'swapTargetAllowed'
          ? args.address === A(0x101)
          : chainReads(args),
      call: noChain.call,
    } as unknown as RouteClient;
    const route = await build({
      client,
      chainId: 8453,
      diamond: A(0xd),
      roster: { oneinch: [...S(0), ...S(1)] },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(seen.map((r) => (r.body as { taker: Address }).taker)).toEqual([A(0x100), A(0x101)]);
    expect(route.kind === 'route' && route.calls.map((c) => c.adapterIdx)).toEqual([1n]);
  });

  it('drops a venue that declines and keeps the rest', async () => {
    const { impl } = fakeFetch({
      '/quote/1inch': { tx: { to: A(0xb), data: '0x02' }, dstAmount: '200' },
    });
    const route = await build({
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

  it('keeps every outcome on a route, so a venue that never answered is disclosed', async () => {
    let n = 0;
    const impl = (async () =>
      n++ === 0
        ? new Response(JSON.stringify({ tx: { to: A(0xa), data: '0x01' }, dstAmount: '100' }), {
            status: 200,
          })
        : new Response('{}', { status: 502 })) as unknown as typeof fetch;
    const route = await build({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(2), oneinch: [...S(0), ...S(1)] },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route.kind).toBe('route');
    if (route.kind !== 'route') return;
    expect(route.outcomes).toEqual([
      { kind: 'oneinch', outcome: 'quoted' },
      { kind: 'oneinch', outcome: 'unanswered' },
      { kind: 'zeroex', outcome: 'origin-bound' },
    ]);
    expect(routeMissingAnswers(route)).toBe(true);
    // A venue left out for a standing reason is not a missing answer.
    expect(
      routeMissingAnswers({ ...route, outcomes: [route.outcomes[0], route.outcomes[2]] }),
    ).toBe(false);
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
          case 'getLiquidationConfig':
            return [0n, 600n, 0n];
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
          case 'swapTargetAllowed':
            return true;
          default:
            throw new Error('unexpected');
        }
      },
      call: noChain.call,
    };
  }

  const mockRoute = (client: ReturnType<typeof mockChain>) =>
    build({
      client: client as any,
      chainId: 84532,
      diamond: A(0xd),
      roster: { testnetMock: S(0) },
      sale,
      agentOrigin: null,
    });

  it('quotes the testnet mock from its own state and ranks it like any venue', async () => {
    const { impl } = fakeFetch({
      '/quote/1inch': { tx: { to: A(0xa), data: '0x01' }, dstAmount: '1' },
    });
    const route = await build({
      client: mockChain({ bps: 9_000n }) as any,
      chainId: 84532,
      diamond: A(0xd),
      roster: { testnetMock: S(0), oneinch: S(1) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route).toMatchObject({
      kind: 'route',
      venues: ['testnetMock', 'oneinch'],
      calls: [{ adapterIdx: 0n, data: '0x' }, expect.objectContaining({ adapterIdx: 1n })],
      outcomes: [
        { kind: 'oneinch', outcome: 'quoted' },
        { kind: 'testnetMock', outcome: 'quoted' },
      ],
    });
  });

  it('leaves out a mock that would revert, refuse the Diamond, or could not pay', async () => {
    expect(await mockRoute(mockChain({ shouldRevert: true }))).toMatchObject({ kind: 'no-quote' });
    expect(await mockRoute(mockChain({ restrictedTo: A(0xe) }))).toMatchObject({ kind: 'no-quote' });
    expect(await mockRoute(mockChain({ balance: 10n ** 17n }))).toMatchObject({ kind: 'no-quote' });
    expect(await mockRoute(mockChain({ restrictedTo: A(0) }))).toMatchObject({ kind: 'route' });
  });

  it('says there is no route when nothing quotes, rather than sending an empty list', async () => {
    const { impl } = fakeFetch({});
    const route = await build({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { oneinch: S(0), univ3: S(2) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route).toEqual({
      kind: 'no-quote',
      outcomes: [
        { kind: 'oneinch', outcome: 'declined' },
        { kind: 'univ3', outcome: 'declined' },
      ],
    });
  });

  it('drops a quote whose swap target the adapter does not allow', async () => {
    const { impl } = fakeFetch({
      '/quote/1inch': { tx: { to: A(0xa), data: '0x01' }, dstAmount: '100' },
    });
    const route = await build({
      client: {
        readContract: async (args: { functionName: string; args?: unknown[] }) =>
          args.functionName === 'swapTargetAllowed' && args.args?.[0] !== A(0xa),
        call: noChain.call,
      } as any,
      chainId: 8453,
      diamond: A(0xd),
      roster: { oneinch: S(0) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route.kind).toBe('no-quote');
  });

  it('names the aggregators the agent has no key for', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ error: 'oneinch-not-configured' }), {
        status: 503,
      })) as unknown as typeof fetch;
    const route = await build({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { oneinch: S(0) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(route).toEqual({
      kind: 'no-quote',
      outcomes: [{ kind: 'oneinch', outcome: 'unconfigured' }],
    });
  });
});

describe('buildCloseOutRoute — UniV3', () => {
  it('sends every quoting pool, ranked with the other venues', async () => {
    const { encodeFunctionResult } = await import('viem');
    const out = (n: bigint) =>
      encodeFunctionResult({
        abi: [
          {
            type: 'function',
            name: 'q',
            stateMutability: 'view',
            inputs: [],
            outputs: [
              { type: 'uint256' },
              { type: 'uint160' },
              { type: 'uint32' },
              { type: 'uint256' },
            ],
          },
        ],
        functionName: 'q',
        result: [n, 0n, 0, 0n],
      });
    const amounts = [0n, 5n, 9n, 0n];
    let i = 0;
    const route = await build({
      client: {
        readContract: noChain.readContract,
        call: async () => {
          const n = amounts[i++];
          if (n === 0n) throw new RawContractError({ data: '0x' });
          return { data: out(n) };
        },
      } as unknown as RouteClient,
      chainId: 8453,
      diamond: A(0xd),
      roster: { univ3: S(2) },
      sale,
      agentOrigin: null,
    });
    expect(route.kind === 'route' && route.calls).toEqual([
      { adapterIdx: 2n, data: encodeAbiParameters([{ type: 'uint24' }], [3000]) },
      { adapterIdx: 2n, data: encodeAbiParameters([{ type: 'uint24' }], [500]) },
    ]);
  });
});

describe('previewCloseOut', () => {
  const diamond = A(0xd);
  const loanTopic = `0x${(21).toString(16).padStart(64, '0')}`;
  const run = (simulateCalls: () => Promise<unknown>) =>
    previewCloseOut({
      client: { simulateCalls } as any,
      diamond,
      account: A(0xe),
      loanId: 21n,
      calls: [{ adapterIdx: 0n, data: '0x' }],
    });

  it('reads a fallback from the adapters-failed event for this loan', async () => {
    expect(
      await run(async () => ({
        results: [
          {
            status: 'success',
            logs: [{ address: diamond, topics: [SWAP_ALL_ADAPTERS_FAILED_TOPIC, loanTopic] }],
          },
        ],
      })),
    ).toBe('fallback');
  });

  it('reads a sale only from an adapter-succeeded event for this loan', async () => {
    const other = `0x${(22).toString(16).padStart(64, '0')}`;
    expect(
      await run(async () => ({
        results: [
          {
            status: 'success',
            logs: [
              { address: diamond, topics: [SWAP_ALL_ADAPTERS_FAILED_TOPIC, other] },
              { address: diamond, topics: [SWAP_ADAPTER_SUCCEEDED_TOPIC, loanTopic, loanTopic] },
            ],
          },
        ],
      })),
    ).toBe('sale');
  });

  it('reads neither event as a different ending, not as a sale', async () => {
    expect(await run(async () => ({ results: [{ status: 'success', logs: [] }] }))).toBe('other');
  });

  it('says unknown when the node cannot preview or the call reverts', async () => {
    expect(await run(async () => Promise.reject(new Error('eth_simulateV1 unsupported')))).toBe(
      'unknown',
    );
    expect(await run(async () => ({ results: [{ status: 'failure', logs: [] }] }))).toBe('unknown');
  });

  it('says unknown, not a changed ending, when the node reports no logs field', async () => {
    expect(await run(async () => ({ results: [{ status: 'success' }] }))).toBe('unknown');
  });
});

describe('routePosture', () => {
  // Fake chain: each adapter at A(0x100+i) answers its name and the
  // Diamond answers its disabled flag; `undefined` makes that read fail.
  function chainOf(entries: { name?: string; disabled?: boolean }[]) {
    return {
      readContract: async (args: { functionName: string; address: Address; args?: [Address] }) => {
        if (args.functionName === 'getSwapAdapters') return entries.map((_, i) => A(0x100 + i));
        if (args.functionName === 'ROUTER' || args.functionName === 'factory') return chainReads(args);
        const i = Number(BigInt((args.args?.[0] ?? args.address) as string) - 0x100n);
        const v = args.functionName === 'adapterName' ? entries[i].name : entries[i].disabled;
        if (v === undefined) throw new Error('unreadable');
        return v;
      },
    } as unknown as Parameters<typeof readCloseOutRoster>[0];
  }
  const posture = async (
    entries: { name?: string; disabled?: boolean }[],
    agent: QuoteProxyReadiness = { oneinch: true },
    chainId = 8453,
  ) => {
    const client = chainOf(entries);
    const read = await readCloseOutRoster(client, A(9), undefined);
    const slots = await classifySlots({
      client: client as unknown as RouteClient,
      chainId,
      roster: read.roster,
      quoteProxy: agent,
    });
    return routePosture(read, slots);
  };

  it('is available when an askable venue is enabled', async () => {
    expect(await posture([{ name: 'UniswapV3', disabled: false }])).toBe('available');
  });
  it('is no-enabled-venue for an empty list or an all-disabled one', async () => {
    expect(await posture([])).toBe('no-enabled-venue');
    expect(
      await posture([
        { name: 'ZeroEx', disabled: true },
        { name: undefined, disabled: true },
      ]),
    ).toBe('no-enabled-venue');
  });
  it('is unread when a possibly-usable entry could not be read', async () => {
    expect(await posture([{ name: 'ZeroEx', disabled: undefined }])).toBe('unread');
    expect(await posture([{ name: undefined, disabled: false }])).toBe('unread');
  });
  it('is proxy-unconfigured when only an aggregator is enabled and no proxy is set', async () => {
    expect(await posture([{ name: 'OneInch', disabled: false }], 'absent')).toBe(
      'proxy-unconfigured',
    );
  });
  it('is proxy-unconfigured when the proxy holds no key, and unread when it could not say', async () => {
    const oneinchOnly = [{ name: 'OneInch', disabled: false }];
    expect(await posture(oneinchOnly, { oneinch: false })).toBe('proxy-unconfigured');
    expect(await posture(oneinchOnly, 'unread')).toBe('unread');
  });
  it('does not count 0x as askable, with or without a proxy', async () => {
    const zeroexOnly = [{ name: 'ZeroEx', disabled: false }];
    expect(await posture(zeroexOnly)).toBe('unsupported');
    expect(await posture(zeroexOnly, 'absent')).toBe('unsupported');
    expect(await posture([...zeroexOnly, { name: 'OneInch', disabled: false }])).toBe('available');
  });
  it('is unsupported when enabled venues exist that this app cannot ask', async () => {
    expect(await posture([{ name: 'BalancerV2', disabled: false }])).toBe('unsupported');
    // UniV3 with no quoter on this chain.
    expect(await posture([{ name: 'UniswapV3', disabled: false }], undefined, 84532)).toBe(
      'unsupported',
    );
  });
});

describe('noQuoteReason', () => {
  type O = Parameters<typeof noQuoteReason>[0]['outcomes'][number]['outcome'];
  const nq = (...o: [string, O][]) => ({
    kind: 'no-quote' as const,
    outcomes: o.map(([kind, outcome]) => ({ kind: kind as 'zeroex', outcome })),
  });
  const R = { incomplete: false, unrecognized: 0 };
  it('says unread before anything else', () => {
    expect(noQuoteReason(nq(['zeroex', 'unanswered']), { ...R, incomplete: true })).toBe('unread');
  });
  it('keeps a left-out venue in the answer when another gave no answer', () => {
    expect(noQuoteReason(nq(['univ3', 'unanswered'], ['oneinch', 'unconfigured']), R)).toBe(
      'unanswered-partly-reached',
    );
    expect(noQuoteReason(nq(['univ3', 'unanswered'], ['zeroex', 'origin-bound']), R)).toBe(
      'unanswered-partly-reached',
    );
  });
  it('says unanswered when any venue gave no answer it could judge', () => {
    expect(noQuoteReason(nq(['univ3', 'declined'], ['zeroex', 'unanswered']), R)).toBe(
      'unanswered',
    );
  });
  it('says unconfigured when nothing declined and only the proxy was missing', () => {
    expect(noQuoteReason(nq(['zeroex', 'unconfigured'], ['oneinch', 'no-proxy']), R)).toBe(
      'unconfigured',
    );
  });
  it('says unreachable when nothing declined and a venue cannot be priced here', () => {
    expect(noQuoteReason(nq(['univ3', 'other-pools']), R)).toBe('unreachable');
  });
  it('says unreachable, not unconfigured, when 0x was left out', () => {
    expect(noQuoteReason(nq(['zeroex', 'origin-bound'], ['oneinch', 'unconfigured']), R)).toBe(
      'unreachable',
    );
    expect(noQuoteReason(nq(['zeroex', 'origin-bound'], ['univ3', 'declined']), R)).toBe(
      'partly-reached',
    );
  });
  it('says partly-reached when venues declined and others were left out', () => {
    expect(noQuoteReason(nq(['univ3', 'declined'], ['oneinch', 'no-proxy']), R)).toBe(
      'partly-reached',
    );
  });
  it('counts an enabled adapter it could not name as left out (#2480 r6)', () => {
    expect(
      noQuoteReason(nq(['univ3', 'declined'], ['zeroex', 'declined']), { ...R, unrecognized: 1 }),
    ).toBe('partly-reached');
    expect(noQuoteReason(nq(), { ...R, unrecognized: 1 })).toBe('unreachable');
  });
  it('says declined only when every venue was asked and declined', () => {
    expect(noQuoteReason(nq(['univ3', 'declined'], ['zeroex', 'declined']), R)).toBe(
      'declined',
    );
  });
});

describe('buildCloseOutRoute — route checks', () => {
  const run = (client: RouteClient, roster: Parameters<typeof classifySlots>[0]['roster'], impl?: typeof fetch) =>
    build({
      client,
      chainId: 8453,
      diamond: A(0xd),
      roster,
      sale,
      agentOrigin: impl ? 'https://agent.example' : null,
      fetchImpl: impl,
    });
  const quoteOk = fakeFetch({
    '/quote/1inch': { tx: { to: A(0xa), data: '0x01' }, dstAmount: '100' },
  }).impl;

  it('marks a quote whose allowlist read failed as unanswered, not declined', async () => {
    const client = {
      readContract: async () => {
        throw new Error('rpc down');
      },
      call: noChain.call,
    } as unknown as RouteClient;
    expect(await run(client, { oneinch: S(0) }, quoteOk)).toEqual({
      kind: 'no-quote',
      outcomes: [{ kind: 'oneinch', outcome: 'unanswered' }],
    });
  });

  it('marks a proxy that timed out, rate-limited or sent junk as unanswered', async () => {
    for (const res of [
      () => Promise.reject(new Error('aborted')),
      () => Promise.resolve(new Response('{}', { status: 429 })),
      () => Promise.resolve(new Response('{}', { status: 502 })),
      () => Promise.resolve(new Response('not json', { status: 200 })),
      // The proxy's own envelope for an upstream body it could not parse.
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'upstream-non-json', status: 200 }), { status: 200 }),
        ),
    ]) {
      const impl = (async () => res()) as unknown as typeof fetch;
      expect(await run(noChain, { oneinch: S(0) }, impl)).toMatchObject({
        outcomes: [{ kind: 'oneinch', outcome: 'unanswered' }],
      });
    }
  });

  it('reads a rejected proxy credential as unconfigured, not as a decline', async () => {
    for (const status of [401, 403]) {
      const impl = (async () => new Response('{}', { status })) as unknown as typeof fetch;
      expect(await run(noChain, { oneinch: S(0) }, impl)).toMatchObject({
        outcomes: [{ kind: 'oneinch', outcome: 'unconfigured' }],
      });
    }
  });

  it('quotes the aggregators with the protocol slippage ceiling, and asks none when it is unread', async () => {
    const withCfg = (cfg: unknown) =>
      ({
        readContract: async (args: { functionName: string }) => {
          if (args.functionName === 'getLiquidationConfig') {
            if (cfg instanceof Error) throw cfg;
            return cfg;
          }
          return chainReads(args);
        },
        call: noChain.call,
      }) as unknown as RouteClient;
    const go = async (client: RouteClient) => {
      const { impl, seen } = fakeFetch({});
      const route = await build({
        client,
        chainId: 8453,
        diamond: A(0xd),
        roster: { oneinch: S(1) },
        sale,
        agentOrigin: 'https://agent.example',
        fetchImpl: impl,
      });
      return { route, seen };
    };
    const tuned = await go(withCfg([0n, 900n, 0n]));
    expect((tuned.seen[0].body as { slippageBps: number }).slippageBps).toBe(900);
    const unread = await go(withCfg(new Error('rpc')));
    expect(unread.seen).toHaveLength(0);
    expect(unread.route).toMatchObject({ outcomes: [{ kind: 'oneinch', outcome: 'unanswered' }] });
  });

  it('does not ask 0x, and still asks 1inch', async () => {
    const { impl, seen } = fakeFetch({});
    const route = await build({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(0), oneinch: S(1) },
      sale,
      agentOrigin: 'https://agent.example',
      fetchImpl: impl,
    });
    expect(seen).toHaveLength(1);
    expect(route).toMatchObject({
      outcomes: [
        { kind: 'oneinch', outcome: 'declined' },
        { kind: 'zeroex', outcome: 'origin-bound' },
      ],
    });
  });

  it('marks a UniV3 quoter that never answered as unanswered, not as no pool', async () => {
    const client = {
      readContract: noChain.readContract,
      call: async () => {
        throw new Error('timeout');
      },
    } as unknown as RouteClient;
    expect(await run(client, { univ3: S(2) })).toMatchObject({
      outcomes: [{ kind: 'univ3', outcome: 'unanswered' }],
    });
  });

  it('does not price a UniV3 adapter whose router is on another factory', async () => {
    let quoted = false;
    const client = {
      readContract: async (args: { functionName: string; address: Address }) => {
        if (args.functionName === 'ROUTER') return A(0x77);
        // The router's factory differs from the quoter's.
        if (args.functionName === 'factory') return args.address === A(0x77) ? A(0xf1) : A(0xf2);
        throw new Error('unused');
      },
      call: async () => {
        quoted = true;
        throw new RawContractError({ data: '0x' });
      },
    } as unknown as RouteClient;
    expect(await run(client, { univ3: S(2) })).toMatchObject({
      outcomes: [{ kind: 'univ3', outcome: 'other-pools' }],
    });
    expect(quoted).toBe(false);
  });

  it('names the aggregators left out for want of a quote proxy', async () => {
    expect(await run(noChain, { univ3: S(2), oneinch: S(1) })).toEqual({
      kind: 'no-quote',
      outcomes: [
        { kind: 'univ3', outcome: 'declined' },
        { kind: 'oneinch', outcome: 'no-proxy' },
      ],
    });
  });
});

describe('readQuoteProxyReadiness', () => {
  const answer = (res: () => Promise<Response>) => (async () => res()) as unknown as typeof fetch;
  it('is absent without a proxy, and never asks', async () => {
    expect(await readQuoteProxyReadiness(null, answer(() => Promise.reject(new Error('x'))))).toBe(
      'absent',
    );
  });
  it('reads the per-venue answer', async () => {
    const ok = (b: unknown) => answer(() => Promise.resolve(new Response(JSON.stringify(b))));
    expect(await readQuoteProxyReadiness('https://a', ok({ oneinch: true, zeroex: false }))).toEqual(
      { oneinch: true },
    );
    expect(await readQuoteProxyReadiness('https://a', ok({ oneinch: false }))).toEqual({
      oneinch: false,
    });
  });
  it('is unread on a failure, an error status or a malformed body', async () => {
    for (const res of [
      // A CORS refusal (an origin outside the allow-list) reaches fetch as a throw.
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('{}', { status: 404 })),
      () => Promise.resolve(new Response('not json')),
      () => Promise.resolve(new Response(JSON.stringify({ oneinch: 'yes' }))),
    ]) {
      expect(await readQuoteProxyReadiness('https://a', answer(res))).toBe('unread');
    }
  });
  it('is asked by the standing only when 1inch is on the list', async () => {
    let asked = 0;
    const impl = (async () => {
      asked++;
      return new Response(JSON.stringify({ oneinch: false }));
    }) as unknown as typeof fetch;
    const roster = (names: string[]) =>
      ({
        readContract: async (args: { functionName: string; address: Address; args?: [Address] }) => {
          if (args.functionName === 'getSwapAdapters') return names.map((_, i) => A(0x100 + i));
          const i = Number(BigInt((args.args?.[0] ?? args.address) as string) - 0x100n);
          return args.functionName === 'adapterName' ? names[i] : false;
        },
      }) as unknown as Parameters<typeof readRouteStanding>[0]['client'];
    const one = await readRouteStanding({
      client: roster(['OneInch']),
      diamond: A(9),
      chainId: 8453,
      testnetMockAdapter: undefined,
      agentOrigin: 'https://a',
      fetchImpl: impl,
    });
    expect(asked).toBe(1);
    expect(one.posture).toBe('proxy-unconfigured');
    await readRouteStanding({
      client: roster(['ZeroEx']),
      diamond: A(9),
      chainId: 8453,
      testnetMockAdapter: undefined,
      agentOrigin: 'https://a',
      fetchImpl: impl,
    });
    expect(asked).toBe(1);
  });
});
