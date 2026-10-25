/**
 * #2812 — a static-output view is decoded only when its answer has the
 * length this build's ABI describes.
 */
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Abi, type Hex, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { readProtocolConfigBundle } from './protocolKnobs';
import { describeShapeMismatch, readStaticReturn, staticReturnBytes } from './staticReturn';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;

const ABI = [
  {
    type: 'function',
    name: 'pair',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'nested',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'xs', type: 'uint16[3]' },
      {
        name: 't',
        type: 'tuple',
        components: [
          { name: 'p', type: 'address' },
          { name: 'q', type: 'bytes32[2]' },
        ],
      },
    ],
  },
  { type: 'function', name: 'one', stateMutability: 'view', inputs: [], outputs: [{ name: 'v', type: 'uint8' }] },
  { type: 'function', name: 'text', stateMutability: 'view', inputs: [], outputs: [{ name: 's', type: 'string' }] },
  { type: 'function', name: 'list', stateMutability: 'view', inputs: [], outputs: [{ name: 'l', type: 'uint256[]' }] },
] as const satisfies Abi;

/** A client whose every call answers `data`, recording the block asked for. */
function answering(data: Hex | undefined) {
  const calls: { blockNumber?: bigint }[] = [];
  const client = {
    call: async (args: { blockNumber?: bigint }) => {
      calls.push(args);
      return { data };
    },
  } as unknown as PublicClient;
  return { client, calls };
}

const word = (n: number) => n.toString(16).padStart(64, '0');

describe('staticReturnBytes', () => {
  it('counts one word per static value, fixed arrays and tuples included', () => {
    expect(staticReturnBytes(ABI, 'pair')).toBe(64);
    expect(staticReturnBytes(ABI, 'nested')).toBe(32 * (3 + 1 + 2));
    expect(staticReturnBytes(ABI, 'one')).toBe(32);
  });

  it('declines a dynamic output and an unknown getter', () => {
    expect(staticReturnBytes(ABI, 'text')).toBeNull();
    expect(staticReturnBytes(ABI, 'list')).toBeNull();
    expect(staticReturnBytes(ABI, 'absent')).toBeNull();
  });

  it("describes the config bundle as this build compiles it", () => {
    // 7 scalars, two uint256[4], the matcher flag and 3 more scalars.
    expect(staticReturnBytes(DIAMOND_ABI_VIEM, 'getProtocolConfigBundle')).toBe(19 * 32);
  });
});

describe('readStaticReturn', () => {
  it('decodes an answer of exactly the described length', async () => {
    const { client, calls } = answering(`0x${word(7)}${word(1)}`);
    const r = await readStaticReturn({ client, address: DIAMOND, abi: ABI, functionName: 'pair', blockNumber: 9n });
    expect(r).toEqual({ kind: 'decoded', outputs: [7n, true] });
    expect(calls[0].blockNumber).toBe(9n);
  });

  it('wraps a single output in a list of one', async () => {
    const { client } = answering(`0x${word(5)}`);
    expect(await readStaticReturn({ client, address: DIAMOND, abi: ABI, functionName: 'one' })).toEqual({
      kind: 'decoded',
      outputs: [5],
    });
  });

  it('refuses a LONGER answer, which positional decoding would accept', async () => {
    const { client } = answering(`0x${word(1)}${word(0)}${word(7)}`);
    expect(await readStaticReturn({ client, address: DIAMOND, abi: ABI, functionName: 'pair' })).toEqual({
      kind: 'shape-mismatch',
      gotBytes: 96,
      expectedBytes: 64,
    });
  });

  it('refuses a shorter answer and an empty one', async () => {
    expect(
      await readStaticReturn({ client: answering(`0x${word(1)}`).client, address: DIAMOND, abi: ABI, functionName: 'pair' }),
    ).toMatchObject({ kind: 'shape-mismatch', gotBytes: 32 });
    expect(
      await readStaticReturn({ client: answering(undefined).client, address: DIAMOND, abi: ABI, functionName: 'pair' }),
    ).toMatchObject({ kind: 'shape-mismatch', gotBytes: 0 });
  });

  it('will not read a dynamic getter at all', async () => {
    await expect(
      readStaticReturn({ client: answering('0x').client, address: DIAMOND, abi: ABI, functionName: 'text' }),
    ).rejects.toThrow(/no static outputs/);
  });

  it('says a mismatch in words', () => {
    expect(describeShapeMismatch('pair', { gotBytes: 96, expectedBytes: 64 })).toMatch(/answered 3 words.*describes 2 words/);
  });
});

describe('readProtocolConfigBundle', () => {
  const BUNDLE = (DIAMOND_ABI_VIEM as readonly { type: string; name?: string; outputs?: readonly unknown[] }[]).find(
    (e) => e.type === 'function' && e.name === 'getProtocolConfigBundle',
  )!;
  const sample = [200n, 20n, 50n, 600n, 300n, 11000n, 500n, [1n, 2n, 3n, 4n], [10n, 20n, 30n, 40n], true, 100n, 3600n, 365n];

  it('names every value of an answer this build describes', async () => {
    const data = encodeAbiParameters(BUNDLE.outputs as never, sample as never);
    const r = await readProtocolConfigBundle({ client: answering(data).client, diamond: DIAMOND, abi: DIAMOND_ABI_VIEM });
    expect(r.kind).toBe('read');
    if (r.kind !== 'read') return;
    expect(r.values.partialFillEnabled).toBe(true);
    expect(r.values.maxOfferDurationDays).toBe('365');
    expect(r.values.tierThresholds).toEqual(['1', '2', '3', '4']);
    expect(r.positional).toHaveLength(13);
  });

  it("leaves every field unknown on the pre-#2812 answer, which carried two more flags", async () => {
    // The old ConfigFacet: the same seven scalars and tier arrays, then
    // rangeAmount, rangeRate, partialFill, and the three scalars. Read by
    // position through this ABI it would put `rangeAmount` under the matcher
    // flag and `rangeRate` under the matcher fee.
    const head = encodeAbiParameters(BUNDLE.outputs!.slice(0, 9) as never, sample.slice(0, 9) as never);
    const tail = [1, 1, 0, 100, 3600, 365].map(word).join('');
    const r = await readProtocolConfigBundle({
      client: answering(`${head}${tail}` as Hex).client,
      diamond: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
    });
    expect(r).toEqual({ kind: 'unreadable', reason: expect.stringMatching(/answered 21 words.*describes 19 words/) });
  });
});
