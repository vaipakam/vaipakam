/**
 * #2755 — `POST /opensea/listing` publishes only a live Vaipakam listing.
 *
 * The chain is replaced by a reader stub; the cases pin each of the four
 * checks in `openseaListingBinding.ts`, that the hash is computed from the
 * parsed components rather than taken from the caller, that a chain read
 * that fails refuses the post, and that the executor fragments match the
 * contract source.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import type { Env } from '../src/env';
import {
  bindListingToProtocol,
  openSeaParameters,
  parseOrderComponents,
  type ListingChainReader,
  type OrderComponents,
} from '../src/openseaListingBinding';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN = 84532; // a chain with a deployment in the bundle
const EXECUTOR = `0x${'e0'.repeat(20)}` as Address;
const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395' as Address;
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const ZERO = `0x${'00'.repeat(20)}` as Address;

const RAW = {
  offerer: `0x${'0a'.repeat(20)}`,
  zone: EXECUTOR,
  offer: [{ itemType: 2, token: `0x${'0b'.repeat(20)}`, identifierOrCriteria: '7', startAmount: '1', endAmount: '1' }],
  consideration: [
    {
      itemType: 1,
      token: `0x${'0c'.repeat(20)}`,
      identifierOrCriteria: '0',
      startAmount: '900',
      endAmount: '900',
      recipient: `0x${'0d'.repeat(20)}`,
    },
  ],
  orderType: 2,
  startTime: '1790000000',
  endTime: '1790086400',
  zoneHash: `0x${'00'.repeat(32)}`,
  salt: '42',
  conduitKey: `0x${'00'.repeat(32)}`,
  counter: '0',
};

const env = {} as Env;

function reader(over: Partial<ListingChainReader> = {}): ListingChainReader & { hashedWith: OrderComponents[] } {
  const hashedWith: OrderComponents[] = [];
  return {
    hashedWith,
    listingExecutor: async () => EXECUTOR,
    executorSeaport: async () => SEAPORT,
    orderHash: async (_s, c) => {
      hashedWith.push(c);
      return HASH;
    },
    isOrderValid: async (_e, h) => h === HASH,
    ...over,
  };
}

const components = () => parseOrderComponents(RAW)!;

afterEach(() => vi.restoreAllMocks());

describe('parseOrderComponents', () => {
  it('parses the shape the shared order builder produces', () => {
    const c = components();
    expect(c.offer[0].identifierOrCriteria).toBe(7n);
    expect(c.consideration[0].recipient).toBe(RAW.consideration[0].recipient);
    expect(c.counter).toBe(0n);
  });

  it('refuses anything Seaport would not hash as given', () => {
    const bad: unknown[] = [
      null,
      { ...RAW, offer: [] },
      { ...RAW, consideration: [{ ...RAW.consideration[0], recipient: 'nope' }] },
      { ...RAW, startTime: 1790000000 }, // a number where a decimal string is required
      { ...RAW, salt: '0x2a' },
      { ...RAW, orderType: 9 },
      { ...RAW, zoneHash: '0x00' },
      { ...RAW, counter: undefined },
      { ...RAW, offer: Array(33).fill(RAW.offer[0]) },
    ];
    for (const b of bad) expect(parseOrderComponents(b)).toBeNull();
  });

  it('forwards only the parsed fields, with the item count OpenSea needs derived, not taken', () => {
    const out = openSeaParameters(parseOrderComponents({ ...RAW, totalOriginalConsiderationItems: 99, extra: 'x' })!);
    expect(out.totalOriginalConsiderationItems).toBe(1);
    expect(out).not.toHaveProperty('extra');
    expect(out.startTime).toBe('1790000000');
  });
});

describe('bindListingToProtocol', () => {
  it('has a deployment to bind against', () => {
    expect(getDeployment(CHAIN)?.diamond).toBeTruthy();
  });

  it('binds a live listing, hashing the PARSED components', async () => {
    const r = reader();
    const c = components();
    expect(await bindListingToProtocol(env, CHAIN, c, SEAPORT, r)).toEqual({
      kind: 'bound',
      seaport: SEAPORT,
      orderHash: HASH,
    });
    expect(r.hashedWith).toEqual([c]);
  });

  it('compares addresses without regard to case', async () => {
    const c = { ...components(), zone: EXECUTOR.toUpperCase().replace('0X', '0x') as Address };
    const verdict = await bindListingToProtocol(env, CHAIN, c, SEAPORT.toLowerCase() as Address, reader());
    expect(verdict.kind).toBe('bound');
  });

  it('refuses each way an order is not one of ours', async () => {
    const cases: [ListingChainReader, OrderComponents, Address, string][] = [
      [reader({ listingExecutor: async () => ZERO }), components(), SEAPORT, 'listings-not-enabled'],
      [reader(), { ...components(), zone: `0x${'99'.repeat(20)}` as Address }, SEAPORT, 'order-not-a-vaipakam-listing'],
      [reader(), components(), `0x${'98'.repeat(20)}` as Address, 'wrong-protocol-address'],
      [reader({ isOrderValid: async () => false }), components(), SEAPORT, 'order-not-live'],
    ];
    for (const [r, c, protocol, error] of cases) {
      expect(await bindListingToProtocol(env, CHAIN, c, protocol, r)).toEqual({ kind: 'refused', status: 400, error });
    }
  });

  it('refuses a chain with no deployment', async () => {
    expect(await bindListingToProtocol(env, 999_999, components(), SEAPORT, reader())).toEqual({
      kind: 'refused',
      status: 400,
      error: 'no-deployment-for-chain',
    });
  });

  it('refuses, never publishes, when it cannot check', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = reader({
      orderHash: async () => {
        throw new Error('rpc down');
      },
    });
    expect(await bindListingToProtocol(env, CHAIN, components(), SEAPORT, failing)).toEqual({
      kind: 'refused',
      status: 503,
      error: 'listing-check-unavailable',
    });
    // No RPC configured for the chain: nothing to check with.
    expect(await bindListingToProtocol(env, CHAIN, components(), SEAPORT)).toEqual({
      kind: 'refused',
      status: 503,
      error: 'listing-check-unavailable',
    });
  });
});

describe('the executor fragments match the contract', () => {
  // The executor is not a Diamond facet, so its ABI is not exported; the
  // two reads are declared as fragments and pinned to the source here.
  const src = readFileSync(
    resolve(HERE, '..', '..', '..', 'contracts', 'src', 'seaport', 'CollateralListingExecutor.sol'),
    'utf8',
  );

  it('exposes `seaport()` as a public address', () => {
    expect(src).toMatch(/^\s*address public seaport;/m);
  });

  it('exposes `isOrderValid(bytes32) returns (bool)` as a view', () => {
    expect(src).toMatch(/function isOrderValid\(bytes32 \w+\) (public|external) view returns \(bool\)/);
  });
});

describe('POST /opensea/listing handler', () => {
  const post = (body: unknown) =>
    new Request('https://agent.example/opensea/listing', { method: 'POST', body: JSON.stringify(body) });
  const keyed = { OPENSEA_API_KEY: 'k' } as Env;

  it('refuses a body carrying a real signature: a Vaipakam listing is signed by ERC-1271', async () => {
    const { handleOpenSeaListingPost } = await import('../src/openseaProxy');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await handleOpenSeaListingPost(
      post({ chainId: 8453, parameters: RAW, signature: `0x${'11'.repeat(65)}`, protocol_address: SEAPORT }),
      keyed,
      'https://app.example',
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-payload' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('spends nothing on a chain with no Vaipakam deployment', async () => {
    const { handleOpenSeaListingPost } = await import('../src/openseaProxy');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await handleOpenSeaListingPost(
      post({ chainId: 8453, parameters: RAW, signature: '0x', protocol_address: SEAPORT }),
      keyed,
      'https://app.example',
    );
    // Base mainnet: OpenSea serves it, Vaipakam has not deployed there.
    expect(getDeployment(8453)).toBeUndefined();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no-deployment-for-chain' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
