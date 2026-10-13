import { describe, expect, it } from 'vitest';
import {
  RawContractError,
  decodeAbiParameters,
  encodeAbiParameters,
  type Address,
} from 'viem';
import {
  buildCloseOutRoute,
  transactionOrigin,
  noQuoteReason,
  previewCloseOut,
  quotableVenues,
  readCloseOutRoster,
  routePosture,
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

describe('quotableVenues', () => {
  it('asks the aggregators only through a configured agent', () => {
    const roster = { zeroex: S(0), oneinch: S(1) };
    expect(quotableVenues(roster, 8453, true, true)).toEqual(['zeroex', 'oneinch']);
    expect(quotableVenues(roster, 8453, false, true)).toEqual([]);
  });

  it('asks Uniswap V3 only where the chain has a quoter', () => {
    expect(quotableVenues({ univ3: S(2) }, 8453, false, true)).toEqual(['univ3']);
    expect(quotableVenues({ univ3: S(2) }, 84532, false, true)).toEqual([]);
  });

  it('offers the testnet mock wherever the roster recognised it', () => {
    expect(quotableVenues({ testnetMock: S(0) }, 84532, false, true)).toEqual(['testnetMock']);
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
      txOrigin: A(0xe0a),
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
      slippageBps: 600,
      txOrigin: A(0xe0a),
    });
    expect(seen[1].body).toMatchObject({ taker: A(0x101) });
  });

  it('asks every enabled instance of a venue, each as its own taker', async () => {
    const { impl, seen } = fakeFetch({
      '/quote/0x': { transaction: { to: A(0xa), data: '0x01' }, buyAmount: '100' },
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
    const route = await buildCloseOutRoute({
      client,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: [...S(0), ...S(1)] },
      sale,
      agentOrigin: 'https://agent.example',
      txOrigin: A(0xe0a),
      fetchImpl: impl,
    });
    expect(seen.map((r) => (r.body as { taker: Address }).taker)).toEqual([A(0x100), A(0x101)]);
    expect(route.kind === 'route' && route.calls.map((c) => c.adapterIdx)).toEqual([1n]);
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
      txOrigin: A(0xe0a),
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
    buildCloseOutRoute({
      client: client as any,
      chainId: 84532,
      diamond: A(0xd),
      roster: { testnetMock: S(0) },
      sale,
      agentOrigin: null,
      txOrigin: A(0xe0a),
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
      txOrigin: A(0xe0a),
      fetchImpl: impl,
    });
    expect(route).toEqual({
      kind: 'route',
      venues: ['testnetMock', 'zeroex'],
      calls: [{ adapterIdx: 0n, data: '0x' }, expect.objectContaining({ adapterIdx: 1n })],
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
    const route = await buildCloseOutRoute({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(0), univ3: S(2) },
      sale,
      agentOrigin: 'https://agent.example',
      txOrigin: A(0xe0a),
      fetchImpl: impl,
    });
    expect(route).toEqual({
      kind: 'no-quote',
      outcomes: [
        { kind: 'zeroex', outcome: 'declined' },
        { kind: 'univ3', outcome: 'declined' },
      ],
    });
  });

  it('drops a quote whose swap target the adapter does not allow', async () => {
    const { impl } = fakeFetch({
      '/quote/0x': { transaction: { to: A(0xa), data: '0x01' }, buyAmount: '100' },
    });
    const route = await buildCloseOutRoute({
      client: {
        readContract: async (args: { functionName: string; args?: unknown[] }) =>
          args.functionName === 'swapTargetAllowed' && args.args?.[0] !== A(0xa),
        call: noChain.call,
      } as any,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(0) },
      sale,
      agentOrigin: 'https://agent.example',
      txOrigin: A(0xe0a),
      fetchImpl: impl,
    });
    expect(route.kind).toBe('no-quote');
  });

  it('names the aggregators the agent has no key for', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ error: 'zeroex-not-configured' }), {
        status: 503,
      })) as unknown as typeof fetch;
    const route = await buildCloseOutRoute({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(0) },
      sale,
      agentOrigin: 'https://agent.example',
      txOrigin: A(0xe0a),
      fetchImpl: impl,
    });
    expect(route).toEqual({
      kind: 'no-quote',
      outcomes: [{ kind: 'zeroex', outcome: 'unconfigured' }],
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
    const route = await buildCloseOutRoute({
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
      txOrigin: A(0xe0a),
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
        const i = Number(BigInt((args.args?.[0] ?? args.address) as string) - 0x100n);
        const v = args.functionName === 'adapterName' ? entries[i].name : entries[i].disabled;
        if (v === undefined) throw new Error('unreadable');
        return v;
      },
    } as unknown as Parameters<typeof readCloseOutRoster>[0];
  }
  const posture = async (
    entries: { name?: string; disabled?: boolean }[],
    agent = true,
    chainId = 8453,
    origin: 'known' | 'unknown' | 'unread' = 'known',
  ) =>
    routePosture(
      await readCloseOutRoster(chainOf(entries), A(9), undefined),
      chainId,
      agent,
      origin === 'unread' ? undefined : origin === 'known',
    );

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
    expect(await posture([{ name: 'OneInch', disabled: false }], false)).toBe(
      'proxy-unconfigured',
    );
  });
  it('does not count 0x as askable for a wallet whose origin is unknown', async () => {
    const zeroexOnly = [{ name: 'ZeroEx', disabled: false }];
    expect(await posture(zeroexOnly, true, 8453, 'unknown')).toBe('unsupported');
    expect(await posture(zeroexOnly, true, 8453, 'unread')).toBe('unread');
    expect(await posture([...zeroexOnly, { name: 'OneInch', disabled: false }], true, 8453, 'unknown')).toBe(
      'available',
    );
  });
  it('is unsupported when enabled venues exist that this app cannot ask', async () => {
    expect(await posture([{ name: 'BalancerV2', disabled: false }])).toBe('unsupported');
    // UniV3 with no quoter on this chain.
    expect(await posture([{ name: 'UniswapV3', disabled: false }], true, 84532)).toBe(
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
  it('says unread before anything else', () => {
    expect(noQuoteReason(nq(['zeroex', 'unanswered']), true)).toBe('unread');
  });
  it('says unanswered when any venue gave no answer it could judge', () => {
    expect(noQuoteReason(nq(['univ3', 'declined'], ['zeroex', 'unanswered']), false)).toBe(
      'unanswered',
    );
  });
  it('says unconfigured when nothing declined and only the proxy was missing', () => {
    expect(noQuoteReason(nq(['zeroex', 'unconfigured'], ['oneinch', 'no-proxy']), false)).toBe(
      'unconfigured',
    );
  });
  it('says unreachable when nothing declined and a venue cannot be priced here', () => {
    expect(noQuoteReason(nq(['univ3', 'other-pools']), false)).toBe('unreachable');
  });
  it('says unreachable, not unconfigured, when 0x was skipped for an unknown origin', () => {
    expect(noQuoteReason(nq(['zeroex', 'no-origin'], ['oneinch', 'unconfigured']), false)).toBe(
      'unreachable',
    );
    expect(noQuoteReason(nq(['zeroex', 'no-origin'], ['univ3', 'declined']), false)).toBe(
      'partly-reached',
    );
  });
  it('says partly-reached when venues declined and others were left out', () => {
    expect(noQuoteReason(nq(['univ3', 'declined'], ['oneinch', 'no-proxy']), false)).toBe(
      'partly-reached',
    );
  });
  it('says declined only when every venue was asked and declined', () => {
    expect(noQuoteReason(nq(['univ3', 'declined'], ['zeroex', 'declined']), false)).toBe(
      'declined',
    );
  });
});

describe('buildCloseOutRoute — route checks', () => {
  const run = (client: RouteClient, roster: Parameters<typeof buildCloseOutRoute>[0]['roster'], impl?: typeof fetch) =>
    buildCloseOutRoute({
      client,
      chainId: 8453,
      diamond: A(0xd),
      roster,
      sale,
      agentOrigin: impl ? 'https://agent.example' : null,
      txOrigin: A(0xe0a),
      fetchImpl: impl,
    });
  const quoteOk = fakeFetch({
    '/quote/0x': { transaction: { to: A(0xa), data: '0x01' }, buyAmount: '100' },
  }).impl;

  it('marks a quote whose allowlist read failed as unanswered, not declined', async () => {
    const client = {
      readContract: async () => {
        throw new Error('rpc down');
      },
      call: noChain.call,
    } as unknown as RouteClient;
    expect(await run(client, { zeroex: S(0) }, quoteOk)).toEqual({
      kind: 'no-quote',
      outcomes: [{ kind: 'zeroex', outcome: 'unanswered' }],
    });
  });

  it('marks a proxy that timed out, rate-limited or sent junk as unanswered', async () => {
    for (const res of [
      () => Promise.reject(new Error('aborted')),
      () => Promise.resolve(new Response('{}', { status: 429 })),
      () => Promise.resolve(new Response('{}', { status: 502 })),
      () => Promise.resolve(new Response('not json', { status: 200 })),
    ]) {
      const impl = (async () => res()) as unknown as typeof fetch;
      expect(await run(noChain, { zeroex: S(0) }, impl)).toMatchObject({
        outcomes: [{ kind: 'zeroex', outcome: 'unanswered' }],
      });
    }
  });

  it('reads a rejected proxy credential as unconfigured, not as a decline', async () => {
    for (const status of [401, 403]) {
      const impl = (async () => new Response('{}', { status })) as unknown as typeof fetch;
      expect(await run(noChain, { zeroex: S(0) }, impl)).toMatchObject({
        outcomes: [{ kind: 'zeroex', outcome: 'unconfigured' }],
      });
    }
  });

  it('names the submitting wallet as txOrigin on every aggregator request', async () => {
    const { impl, seen } = fakeFetch({});
    await buildCloseOutRoute({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(0), oneinch: S(1) },
      sale,
      agentOrigin: 'https://agent.example',
      txOrigin: A(0xe0a),
      fetchImpl: impl,
    });
    expect(seen.map((r) => (r.body as { txOrigin?: Address }).txOrigin)).toEqual([
      A(0xe0a),
      A(0xe0a),
    ]);
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
      const route = await buildCloseOutRoute({
        client,
        chainId: 8453,
        diamond: A(0xd),
        roster: { oneinch: S(1) },
        sale,
        agentOrigin: 'https://agent.example',
        txOrigin: A(0xe0a),
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

  it('does not ask 0x when the originating account is unknown, and still asks 1inch', async () => {
    const { impl, seen } = fakeFetch({});
    const route = await buildCloseOutRoute({
      client: noChain,
      chainId: 8453,
      diamond: A(0xd),
      roster: { zeroex: S(0), oneinch: S(1) },
      sale,
      agentOrigin: 'https://agent.example',
      txOrigin: null,
      fetchImpl: impl,
    });
    expect(seen).toHaveLength(1);
    expect(route).toMatchObject({
      outcomes: [
        { kind: 'zeroex', outcome: 'no-origin' },
        { kind: 'oneinch', outcome: 'declined' },
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

describe('transactionOrigin', () => {
  const at = (code: unknown) =>
    ({
      getCode: async () => {
        if (code instanceof Error) throw code;
        return code;
      },
    }) as unknown as Parameters<typeof transactionOrigin>[0];
  const me = A(0xe0a);
  it('is the account itself for an EOA, with or without a 7702 delegation', async () => {
    expect(await transactionOrigin(at(undefined), me)).toBe(me);
    expect(await transactionOrigin(at('0x'), me)).toBe(me);
    expect(await transactionOrigin(at('0xef0100' + '11'.repeat(20)), me)).toBe(me);
  });
  it('is unknown for a contract wallet or a failed read', async () => {
    expect(await transactionOrigin(at('0x6080604052'), me)).toBeNull();
    expect(await transactionOrigin(at(new Error('rpc')), me)).toBeNull();
  });
});
