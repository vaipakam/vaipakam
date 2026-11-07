/**
 * #3240 — the keeper's private submission route: every send on a chain with a
 * private endpoint is broadcast there, the same signed bytes fall back to the
 * ordinary RPC only where the operator allows it, and settings that cannot be
 * read send nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, createWalletClient, custom, keccak256, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  armSubmissionRoutes,
  describeSubmissionRoutes,
  PRIVATE_ROUTE_FLOOR_TTL_MS,
  readSubmissionRoutes,
  resetSubmissionRoutes,
  submissionRouteFor,
} from '../src/submissionRoute';
import {
  broadcastSigned,
  FLOOR_TTL_MS,
  isDefinitiveRejection,
  resetSubmissionQueues,
  setPrivateSubmissionClientForTest,
  SubmissionRouteUnread,
  withSubmissionSlot,
} from '../src/submissionQueue';
import { armHeldFence } from './helpers/epochFence';

const URL_ETH = 'https://rpc.example.org/fast?key=SECRET';
const account = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex);
const RAW = '0x02f86b0180808080808080c0' as Hex;

afterEach(() => {
  resetSubmissionRoutes();
  resetSubmissionQueues();
  vi.restoreAllMocks();
});

describe('readSubmissionRoutes', () => {
  it('reads no private route from unset settings', () => {
    expect(readSubmissionRoutes(undefined, undefined)).toEqual({ routes: new Map() });
    expect(submissionRouteFor(readSubmissionRoutes('', ''), 1)).toEqual({ kind: 'public' });
  });

  it('reads one route per chain, with its fallback where the list names it', () => {
    const r = readSubmissionRoutes(` 1=${URL_ETH}, 56=https://bsc.example.net/ `, '1');
    expect(submissionRouteFor(r, 1)).toMatchObject({ kind: 'private', host: 'rpc.example.org', fallback: true });
    expect(submissionRouteFor(r, 56)).toMatchObject({ kind: 'private', host: 'bsc.example.net', fallback: false });
    expect(submissionRouteFor(r, 8453)).toEqual({ kind: 'public' });
  });

  it('refuses a value it cannot read, by position, without echoing it', () => {
    const cases: [string, string, string][] = [
      ['1', '', 'entry 1 of 1 is not <chainId>=<URL>'],
      ['x=https://a.example', '', 'does not start with a chain id'],
      [`1=${URL_ETH},1=${URL_ETH}`, '', 'names chain 1 twice'],
      ['1=not a url', '', 'is not a URL'],
      ['1=http://rpc.example.org/SECRET', '', 'is not an https URL'],
      [`1=${URL_ETH}`, '56', 'names chain 56, which has no private route'],
      [`1=${URL_ETH}`, 'one', 'entry 1 of 1 is not a chain id'],
    ];
    for (const [rpcs, fallback, why] of cases) {
      const r = readSubmissionRoutes(rpcs, fallback);
      expect('unread' in r && r.unread, rpcs).toContain(why);
      expect(JSON.stringify(r)).not.toContain('SECRET');
    }
  });

  it('names every served chain\'s route, and a private route for a chain not served, with the host only', () => {
    const r = readSubmissionRoutes(`1=${URL_ETH},56=https://bsc.example.net/`, '1');
    const line = describeSubmissionRoutes(r, [{ id: 1, name: 'Ethereum' }, { id: 8453, name: 'Base' }]);
    expect(line).toBe(
      'Ethereum(1) private via rpc.example.org, falling back to the public RPC when it fails; Base(8453) public RPC; a private route is set for chain 56, which this tick does not serve',
    );
    expect(line).not.toContain('SECRET');
    expect(describeSubmissionRoutes(readSubmissionRoutes('bad', ''), [])).toMatch(/^nothing is sent on any chain/);
  });
});

/** A client whose `eth_sendRawTransaction` runs `send`. */
function rpc(send: () => Promise<unknown>, calls: string[], name: string) {
  return custom({
    async request({ method }: { method: string }) {
      if (method === 'eth_sendRawTransaction') {
        calls.push(name);
        return send();
      }
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_getTransactionCount') return '0x0';
      throw new Error(`unexpected ${method}`);
    },
  });
}

function setup(opts: { fallback: boolean; priv: () => Promise<unknown>; pub?: () => Promise<unknown> }) {
  const calls: string[] = [];
  armSubmissionRoutes(readSubmissionRoutes(`1=${URL_ETH}`, opts.fallback ? '1' : ''));
  const route = submissionRouteFor(readSubmissionRoutes(`1=${URL_ETH}`, ''), 1) as { url: string };
  setPrivateSubmissionClientForTest(route.url, createPublicClient({ transport: rpc(opts.priv, calls, 'private') }) as PublicClient);
  const wallet = createWalletClient({ account, transport: rpc(opts.pub ?? (async () => keccak256(RAW)), calls, 'public') });
  return { calls, wallet };
}

const rpcRefusal = () => Object.assign(new Error('priority fee too low'), { code: -32000 });
const lost = () => new Error('socket hang up');

describe('broadcastSigned', () => {
  it('sends through the ordinary RPC on a chain with no private route', async () => {
    const calls: string[] = [];
    const wallet = createWalletClient({ account, transport: rpc(async () => keccak256(RAW), calls, 'public') });
    await broadcastSigned(wallet, 8453, RAW);
    expect(calls).toEqual(['public']);
  });

  it('sends through the private endpoint, and never the ordinary RPC, on a chain with one', async () => {
    const s = setup({ fallback: false, priv: async () => keccak256(RAW) });
    expect(await broadcastSigned(s.wallet, 1, RAW)).toBe(keccak256(RAW));
    expect(s.calls).toEqual(['private']);
  });

  it('without a fallback, a failed private send is a failed send', async () => {
    const s = setup({ fallback: false, priv: async () => { throw rpcRefusal(); } });
    await expect(broadcastSigned(s.wallet, 1, RAW)).rejects.toThrow();
    expect(s.calls).toEqual(['private']);
  });

  it('with a fallback, the same signed bytes go to the ordinary RPC', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup({ fallback: true, priv: async () => { throw rpcRefusal(); } });
    expect(await broadcastSigned(s.wallet, 1, RAW)).toBe(keccak256(RAW));
    expect(s.calls).toEqual(['private', 'public']);
    expect(warn.mock.calls.join(' ')).not.toContain('SECRET');
  });

  it('when a private send that may have relayed is followed by a refused fallback, the possibly-relayed error is thrown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup({ fallback: true, priv: async () => { throw lost(); }, pub: async () => { throw rpcRefusal(); } });
    const err = await broadcastSigned(s.wallet, 1, RAW).catch((e: unknown) => e);
    // Not definitive: the slot keeps the nonce reserved.
    expect(isDefinitiveRejection(err)).toBe(false);
  });

  it('settings that cannot be read refuse the send at its turn, before the nonce is read', async () => {
    armSubmissionRoutes(readSubmissionRoutes('garbage', ''));
    const calls: string[] = [];
    const wallet = createWalletClient({ account, transport: rpc(async () => keccak256(RAW), calls, 'public') });
    const send = vi.fn();
    const err = await withSubmissionSlot(wallet, 8453, account.address, Number.MAX_SAFE_INTEGER, send).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionRouteUnread);
    expect(isDefinitiveRejection(err)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('the remembered nonce on a private route', () => {
  it('outranks the pending count for longer than on a public route', async () => {
    expect(PRIVATE_ROUTE_FLOOR_TTL_MS).toBeGreaterThan(6 * 60_000);
    armHeldFence();
    armSubmissionRoutes(readSubmissionRoutes(`1=${URL_ETH}`, ''));
    const wallet = createWalletClient({ account, transport: rpc(async () => '0x', [], 'public') });
    let t = 0;
    const now = () => t;
    const nonces: number[] = [];
    for (const [chain, at] of [[1, 0], [1, FLOOR_TTL_MS + 1], [8453, 0], [8453, FLOOR_TTL_MS + 1]] as const) {
      t = at;
      await withSubmissionSlot(wallet, chain, account.address, Number.MAX_SAFE_INTEGER, async (nonce, signed) => {
        signed();
        nonces.push(nonce);
      }, now);
    }
    // The pending count always reads 0. On the private chain the second send
    // still takes nonce 1; on the public chain the floor has expired.
    expect(nonces).toEqual([0, 1, 0, 0]);
  });
});
