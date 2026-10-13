import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, encodeFunctionResult, type Address, type Hex } from 'viem';
import {
  packAggregatorData,
  packUniV3Data,
  parseOneInchQuote,
  parseZeroExQuote,
  quoteTestnetMock,
  quoteUniV3,
  rankRoutes,
  readSwapAdapterEntries,
  resolveAdapterRoster,
  type RouteCandidate,
} from './swapRoutes';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

describe('resolveAdapterRoster', () => {
  it('maps each production adapter to its position in the Diamond list', () => {
    expect(
      resolveAdapterRoster([
        { address: A(1), name: 'OneInch', disabled: false },
        { address: A(2), name: 'ZeroEx', disabled: false },
        { address: A(3), name: 'UniswapV3', disabled: false },
      ]),
    ).toEqual({
      oneinch: { idx: 0, address: A(1) },
      zeroex: { idx: 1, address: A(2) },
      univ3: { idx: 2, address: A(3) },
    });
  });

  it('skips a disabled venue, and one whose flag could not be read', () => {
    expect(
      resolveAdapterRoster([
        { address: A(1), name: 'ZeroEx', disabled: true },
        { address: A(2), name: 'OneInch', disabled: undefined },
        { address: A(3), name: 'UniswapV3', disabled: false },
      ]),
    ).toEqual({ univ3: { idx: 2, address: A(3) } });
  });

  it('keeps the earlier of two enabled adapters of one kind', () => {
    expect(
      resolveAdapterRoster([
        { address: A(1), name: 'ZeroEx', disabled: false },
        { address: A(2), name: 'ZeroEx', disabled: false },
      ]),
    ).toEqual({ zeroex: { idx: 0, address: A(1) } });
  });

  it('recognises the testnet mock by its declared address only', () => {
    const entries = [
      { address: A(9), name: 'vaipakam-testnet-mock', disabled: false },
      { address: A(7), name: 'vaipakam-testnet-mock', disabled: false },
    ];
    expect(resolveAdapterRoster(entries)).toEqual({});
    expect(resolveAdapterRoster(entries, { testnetMockAdapter: A(7) })).toEqual({
      testnetMock: { idx: 1, address: A(7) },
    });
  });

  it('ignores names it does not know and names it could not read', () => {
    expect(
      resolveAdapterRoster([
        { address: A(1), name: 'SomethingElse', disabled: false },
        { address: A(2), name: undefined, disabled: false },
      ]),
    ).toEqual({});
  });
});

describe('readSwapAdapterEntries', () => {
  it('reads names and flags per entry and leaves a failed read undefined', async () => {
    const client = {
      readContract: async (args: { address: Address; functionName: string; args?: unknown[] }) => {
        if (args.functionName === 'getSwapAdapters') return [A(1), A(2)];
        if (args.functionName === 'adapterName') {
          if (args.address === A(2)) throw new Error('no answer');
          return 'ZeroEx';
        }
        if (args.functionName === 'isSwapAdapterDisabled') return args.args?.[0] === A(2);
        throw new Error('unexpected');
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = await readSwapAdapterEntries(client as any, A(100));
    expect(entries).toEqual([
      { address: A(1), name: 'ZeroEx', disabled: false },
      { address: A(2), name: undefined, disabled: true },
    ]);
  });
});

describe('aggregator parsers', () => {
  const target = A(0xabc);
  it('reads a 0x v2 body', () => {
    expect(
      parseZeroExQuote({ transaction: { to: target, data: '0x1234' }, buyAmount: '1000' }),
    ).toEqual({ swapTarget: target, swapCalldata: '0x1234', expectedOutput: 1000n });
  });

  it('reads a 1inch v6 body, with the older field name as a fallback', () => {
    expect(parseOneInchQuote({ tx: { to: target, data: '0xab' }, dstAmount: '5' })?.expectedOutput).toBe(5n);
    expect(parseOneInchQuote({ tx: { to: target, data: '0xab' }, toAmount: '6' })?.expectedOutput).toBe(6n);
  });

  it('rejects error bodies, empty calldata, bad addresses and zero or non-integer output', () => {
    expect(parseZeroExQuote({ name: 'INPUT_INVALID' })).toBeNull();
    expect(parseZeroExQuote(null)).toBeNull();
    expect(parseZeroExQuote({ transaction: { to: target, data: '0x' }, buyAmount: '1' })).toBeNull();
    expect(parseZeroExQuote({ transaction: { to: '0x12', data: '0x12' }, buyAmount: '1' })).toBeNull();
    expect(parseZeroExQuote({ transaction: { to: target, data: '0x12' }, buyAmount: '0' })).toBeNull();
    expect(parseZeroExQuote({ transaction: { to: target, data: '0x12' }, buyAmount: '1.5' })).toBeNull();
    expect(parseOneInchQuote({ tx: { to: target, data: '0x123' }, dstAmount: '1' })).toBeNull();
  });
});

describe('wire formats', () => {
  it('packs aggregator data as (address, bytes)', () => {
    const packed = packAggregatorData(A(5), '0xdeadbeef');
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], packed)).toEqual([
      A(5),
      '0xdeadbeef',
    ]);
  });

  it('packs the UniV3 fee tier as uint24', () => {
    expect(decodeAbiParameters([{ type: 'uint24' }], packUniV3Data(3000))).toEqual([3000]);
  });
});

describe('quoteUniV3', () => {
  const sale = { sellToken: A(1), buyToken: A(2), sellAmount: 10n };
  const answer = (out: bigint): Hex =>
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
      result: [out, 0n, 0, 0n],
    });

  it('returns the best quoting tier and skips tiers that fail', async () => {
    let call = 0;
    const client = {
      call: async () => {
        call += 1;
        if (call === 1) throw new Error('no pool');
        return { data: answer(call === 2 ? 7n : 9n) };
      },
    };
    expect(await quoteUniV3(client, 8453, sale)).toEqual({ fee: 3000, expectedOutput: 9n });
  });

  it('returns null on a chain with no V3 venue', async () => {
    const client = { call: async () => ({ data: answer(1n) }) };
    expect(await quoteUniV3(client, 84532, sale)).toBeNull();
  });
});

describe('quoteTestnetMock', () => {
  const sale = { sellToken: A(1), buyToken: A(2), sellAmount: 2n * 10n ** 18n };
  const client = (prices: Record<string, bigint>, balance: bigint) => ({
    readContract: async (args: { functionName: string; args?: unknown[] }) => {
      if (args.functionName === 'shouldRevert') return false;
      if (args.functionName === 'restrictedTo') return A(0xd);
      if (args.functionName === 'outputMultiplierBps') return 9_500n;
      if (args.functionName === 'tokenUsdPrice8') return prices[String(args.args?.[0])] ?? 0n;
      if (args.functionName === 'balanceOf') return balance;
      throw new Error('unexpected');
    },
  });

  it('prices the payout the way execute does, from the mock own balance', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client({ [A(1)]: 3000n * 10n ** 8n, [A(2)]: 10n ** 8n }, 10n ** 24n) as any;
    expect(await quoteTestnetMock(c, A(9), A(0xd), sale)).toBe(5700n * 10n ** 18n);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flat = client({}, 10n ** 24n) as any;
    expect(await quoteTestnetMock(flat, A(9), A(0xd), sale)).toBe(19n * 10n ** 17n);
  });

  it('returns null when it could not pay, or a read failed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await quoteTestnetMock(client({}, 1n) as any, A(9), A(0xd), sale)).toBeNull();
    const broken = { readContract: async () => { throw new Error('rpc'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await quoteTestnetMock(broken as any, A(9), A(0xd), sale)).toBeNull();
  });
});

describe('rankRoutes', () => {
  const c = (kind: RouteCandidate['kind'], out: bigint | null, idx: number): RouteCandidate => ({
    kind,
    expectedOutput: out,
    call: { adapterIdx: BigInt(idx), data: '0x' },
  });

  it('puts the best quote first and venues that cannot quote last, ties in order', () => {
    const ranked = rankRoutes([
      c('testnetMock', null, 4),
      c('zeroex', 5n, 0),
      c('oneinch', 9n, 1),
      c('univ3', 5n, 2),
    ]);
    expect(ranked.map((r) => r.kind)).toEqual(['oneinch', 'zeroex', 'univ3', 'testnetMock']);
  });
});
