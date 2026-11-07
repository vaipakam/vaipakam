/**
 * #3240 — the keeper's private submission route: every send on a chain with a
 * private endpoint is broadcast there, the same signed bytes fall back to the
 * ordinary RPC only where the operator allows it, and settings that cannot be
 * read send nothing.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPublicClient, createWalletClient, custom, keccak256, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  armSubmissionRoutes,
  describeSubmissionRoutes,
  providerDomain,
  PRIVATE_ROUTE_FLOOR_TTL_MS,
  readSubmissionRoutes,
  resetSubmissionRoutes,
  submissionRouteFor,
} from '../src/submissionRoute';
import {
  broadcastSigned,
  FLOOR_TTL_MS,
  isDefinitiveRejection,
  isSendPastDeadline,
  resetSubmissionQueues,
  setPrivateSubmissionClientForTest,
  SubmissionRouteUnread,
  withSubmissionSlot,
} from '../src/submissionQueue';
import { memoryNonceReservations, type NonceReservations } from '../src/privateNonce';
import { armHeldFence } from './helpers/epochFence';

const FAR = Number.MAX_SAFE_INTEGER;
const URL_ETH = 'https://rpc.example.org/fast?key=SECRET';
const account = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex);
// A real signed transaction at nonce 0, so the nonce the record takes is read
// from the bytes as it is in production.
let RAW: Hex;
beforeAll(async () => {
  RAW = await account.signTransaction({
    chainId: 1,
    nonce: 0,
    type: 'eip1559',
    to: account.address,
    gas: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
});

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
    expect(submissionRouteFor(r, 1)).toMatchObject({ kind: 'private', host: 'example.org', fallback: true });
    expect(submissionRouteFor(r, 56)).toMatchObject({ kind: 'private', host: 'example.net', fallback: false });
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

  it('names every served chain\'s route, and a private route for a chain not served, with the provider domain only', () => {
    const r = readSubmissionRoutes(`1=${URL_ETH},56=https://bsc.example.net/`, '1');
    const line = describeSubmissionRoutes(r, [{ id: 1, name: 'Ethereum' }, { id: 8453, name: 'Base' }]);
    expect(line).toBe(
      'Ethereum(1) private via example.org, falling back to the public RPC when it fails; Base(8453) public RPC; a private route is set for chain 56, which this tick does not serve',
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

function setup(opts: { fallback: boolean; priv: () => Promise<unknown>; pub?: () => Promise<unknown>; reservations?: NonceReservations }) {
  const calls: string[] = [];
  const reservations = opts.reservations ?? memoryNonceReservations();
  armSubmissionRoutes(readSubmissionRoutes(`1=${URL_ETH}`, opts.fallback ? '1' : ''), reservations);
  const route = submissionRouteFor(readSubmissionRoutes(`1=${URL_ETH}`, ''), 1) as { url: string };
  setPrivateSubmissionClientForTest(route.url, createPublicClient({ transport: rpc(opts.priv, calls, 'private') }) as PublicClient);
  const wallet = createWalletClient({ account, transport: rpc(opts.pub ?? (async () => keccak256(RAW)), calls, 'public') });
  return { calls, wallet, reservations };
}

const rpcRefusal = () => Object.assign(new Error('priority fee too low'), { code: -32000 });
const lost = () => new Error('socket hang up');

describe('broadcastSigned', () => {
  it('sends through the ordinary RPC on a chain with no private route', async () => {
    const calls: string[] = [];
    const wallet = createWalletClient({ account, transport: rpc(async () => keccak256(RAW), calls, 'public') });
    await broadcastSigned(wallet, 8453, RAW, FAR);
    expect(calls).toEqual(['public']);
  });

  it('sends through the private endpoint, and never the ordinary RPC, on a chain with one', async () => {
    const s = setup({ fallback: false, priv: async () => keccak256(RAW) });
    expect(await broadcastSigned(s.wallet, 1, RAW, FAR)).toBe(keccak256(RAW));
    expect(s.calls).toEqual(['private']);
  });

  it('without a fallback, a failed private send is a failed send', async () => {
    const s = setup({ fallback: false, priv: async () => { throw rpcRefusal(); } });
    await expect(broadcastSigned(s.wallet, 1, RAW, FAR)).rejects.toThrow();
    expect(s.calls).toEqual(['private']);
  });

  it('with a fallback, the same signed bytes go to the ordinary RPC', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup({ fallback: true, priv: async () => { throw rpcRefusal(); } });
    expect(await broadcastSigned(s.wallet, 1, RAW, FAR)).toBe(keccak256(RAW));
    expect(s.calls).toEqual(['private', 'public']);
    expect(warn.mock.calls.join(' ')).not.toContain('SECRET');
  });

  it('when a private send that may have relayed is followed by a refused fallback, the possibly-relayed error is thrown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup({ fallback: true, priv: async () => { throw lost(); }, pub: async () => { throw rpcRefusal(); } });
    const err = await broadcastSigned(s.wallet, 1, RAW, FAR).catch((e: unknown) => e);
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
    armSubmissionRoutes(readSubmissionRoutes(`1=${URL_ETH}`, ''), memoryNonceReservations());
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

describe('the private nonce record (Codex #3275 r1)', () => {
  const key = `1:${account.address.toLowerCase()}`;

  it('is written before the private broadcast leaves the process', async () => {
    const reservations = memoryNonceReservations();
    let seen: unknown;
    const s = setup({
      fallback: false,
      reservations,
      priv: async () => {
        seen = reservations.rows.get(key)?.next;
        return keccak256(RAW);
      },
    });
    await broadcastSigned(s.wallet, 1, RAW, FAR);
    expect(seen).toBe(1);
  });

  it('is released when the private endpoint refuses outright, and kept when the answer is lost', async () => {
    const refused = setup({ fallback: false, priv: async () => { throw rpcRefusal(); } });
    await broadcastSigned(refused.wallet, 1, RAW, FAR).catch(() => {});
    // No earlier record: put back as an expired one.
    expect(refused.reservations.rows.get(key)).toEqual({ next: 0, atMs: 0 });
    const unknown = setup({ fallback: false, priv: async () => { throw lost(); } });
    await broadcastSigned(unknown.wallet, 1, RAW, FAR).catch(() => {});
    expect(unknown.reservations.rows.get(key)?.next).toBe(1);
  });

  it('a refused send restores the earlier record with its own timestamp, so a gap ages out (Codex #3275 r2)', async () => {
    const reservations = memoryNonceReservations();
    reservations.rows.set(key, { next: 0, atMs: 1234 });
    const s = setup({ fallback: false, reservations, priv: async () => { throw rpcRefusal(); } });
    await broadcastSigned(s.wallet, 1, RAW, FAR).catch(() => {});
    expect(reservations.rows.get(key)).toEqual({ next: 0, atMs: 1234 });
  });

  it('a deadline that passes while the record is written sends nothing, and releases the record (Codex #3275 r2)', async () => {
    const reservations = memoryNonceReservations();
    let t = 0;
    const slow: NonceReservations = {
      read: (n, a) => reservations.read(n, a),
      write: async (n, a, next, at) => {
        t = 100;
        await reservations.write(n, a, next, at);
      },
    };
    const s = setup({ fallback: true, reservations: slow, priv: async () => keccak256(RAW) });
    const err = await broadcastSigned(s.wallet, 1, RAW, 50, () => t).catch((e: unknown) => e);
    expect(isSendPastDeadline(err)).toBe(true);
    expect(isDefinitiveRejection(err)).toBe(true);
    expect(s.calls).toEqual([]);
    expect(reservations.rows.get(key)).toEqual({ next: 0, atMs: 0 });
  });

  it('a record that cannot be written sends nothing', async () => {
    const failing: NonceReservations = {
      read: async () => null,
      write: async () => { throw new Error('D1 unavailable'); },
    };
    const s = setup({ fallback: true, reservations: failing, priv: async () => keccak256(RAW) });
    const err = await broadcastSigned(s.wallet, 1, RAW, FAR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionRouteUnread);
    expect(s.calls).toEqual([]);
  });

  it('a record that cannot be read refuses the send before it is signed', async () => {
    armHeldFence();
    const failing: NonceReservations = {
      read: async () => { throw new Error('D1 unavailable'); },
      write: async () => {},
    };
    armSubmissionRoutes(readSubmissionRoutes(`1=${URL_ETH}`, ''), failing);
    const wallet = createWalletClient({ account, transport: rpc(async () => '0x', [], 'public') });
    const send = vi.fn();
    const err = await withSubmissionSlot(wallet, 1, account.address, Number.MAX_SAFE_INTEGER, send).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionRouteUnread);
    expect(send).not.toHaveBeenCalled();
  });

  it('after a restart, the next send skips the nonce a private send still holds', async () => {
    armHeldFence();
    const reservations = memoryNonceReservations();
    reservations.rows.set(key, { next: 4, atMs: Date.now() });
    // A fresh process: no in-memory floor, the pending count reads 0.
    resetSubmissionQueues();
    armSubmissionRoutes(readSubmissionRoutes(`1=${URL_ETH}`, ''), reservations);
    const wallet = createWalletClient({ account, transport: rpc(async () => '0x', [], 'public') });
    let got = -1;
    await withSubmissionSlot(wallet, 1, account.address, Number.MAX_SAFE_INTEGER, async (nonce, signed) => {
      signed();
      got = nonce;
    });
    expect(got).toBe(4);
  });

  it('a route switched back to public still honours a pending private reservation (Codex #3275 r4)', async () => {
    armHeldFence();
    const reservations = memoryNonceReservations();
    reservations.rows.set(key, { next: 1, atMs: Date.now() });
    resetSubmissionQueues();
    // The operator removed chain 1's private entry and restarted.
    armSubmissionRoutes(readSubmissionRoutes('', ''), reservations);
    const wallet = createWalletClient({ account, transport: rpc(async () => '0x', [], 'public') });
    let got = -1;
    await withSubmissionSlot(wallet, 1, account.address, Number.MAX_SAFE_INTEGER, async (nonce, signed) => {
      signed();
      got = nonce;
    });
    expect(got).toBe(1);
  });

  it('public successors of a private gap advance the reservation inside its window (Codex #3275 r5)', async () => {
    armHeldFence();
    const reservations = memoryNonceReservations();
    const start = Date.now();
    reservations.rows.set(key, { next: 1, atMs: start });
    resetSubmissionQueues();
    armSubmissionRoutes(readSubmissionRoutes('', ''), reservations);
    // The pending count stays 0: private nonce 0 has not landed.
    const wallet = createWalletClient({ account, transport: rpc(async () => '0x', [], 'public') });
    let t = start;
    const nonces: number[] = [];
    for (const at of [start, start + FLOOR_TTL_MS + 1_000]) {
      t = at;
      await withSubmissionSlot(wallet, 1, account.address, FAR, async (nonce, signed) => {
        signed();
        nonces.push(nonce);
        const raw = await account.signTransaction({ chainId: 1, nonce, type: 'eip1559', to: account.address, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
        await broadcastSigned(wallet, 1, raw, FAR, () => t);
      }, () => t);
    }
    expect(nonces).toEqual([1, 2]);
    // The window stays the private send's, so the gap still ages out.
    expect(reservations.rows.get(key)).toEqual({ next: 3, atMs: start });
  });

  it('a deadline that passes while a public send reads the record sends nothing (Codex #3275 r6)', async () => {
    const calls: string[] = [];
    let t = 0;
    const slowRead: NonceReservations = {
      read: async () => {
        t = 100;
        return null;
      },
      write: async () => {},
    };
    armSubmissionRoutes(readSubmissionRoutes('', ''), slowRead);
    const wallet = createWalletClient({ account, transport: rpc(async () => keccak256(RAW), calls, 'public') });
    const err = await broadcastSigned(wallet, 1, RAW, 50, () => t).catch((e: unknown) => e);
    expect(isSendPastDeadline(err)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('a public send with no live reservation writes nothing', async () => {
    const reservations = memoryNonceReservations();
    armSubmissionRoutes(readSubmissionRoutes('', ''), reservations);
    const wallet = createWalletClient({ account, transport: rpc(async () => keccak256(RAW), [], 'public') });
    await broadcastSigned(wallet, 1, RAW, FAR);
    expect(reservations.rows.size).toBe(0);
  });

  it('a private route armed without a record sends nothing', async () => {
    armHeldFence();
    armSubmissionRoutes(readSubmissionRoutes(`1=${URL_ETH}`, ''));
    const wallet = createWalletClient({ account, transport: rpc(async () => '0x', [], 'public') });
    const send = vi.fn();
    const err = await withSubmissionSlot(wallet, 1, account.address, Number.MAX_SAFE_INTEGER, send).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionRouteUnread);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the provider domain a log may name (Codex #3275 r3)', () => {
  it('drops every label but the last two, so a key in a subdomain is never logged', () => {
    expect(providerDomain('rpc.flashbots.net')).toBe('flashbots.net');
    expect(providerDomain('SECRETKEY123.rpc.example.org')).toBe('example.org');
    expect(providerDomain('localhost')).toBe('localhost');
    expect(providerDomain('10.0.0.1')).toBe('10.0.0.1');
  });

  it('the route and its per-tick line carry only that domain', () => {
    const routes = readSubmissionRoutes('1=https://SECRETKEY123.rpc.example.org/x', '');
    expect(describeSubmissionRoutes(routes, [{ id: 1, name: 'eth' } as never])).not.toContain('SECRETKEY123');
  });
});

describe('a secret that is set but cannot be read', () => {
  it('reads as unread, not as absent, and refuses every send', () => {
    const routes = readSubmissionRoutes({ secretReadFailed: true }, '');
    expect('unread' in submissionRouteFor(routes, 8453)).toBe(true);
  });
});

describe('the private broadcast through a capped pass', () => {
  it('goes through the pass\'s own fetch', async () => {
    const reservations = memoryNonceReservations();
    armSubmissionRoutes(readSubmissionRoutes(`1=${URL_ETH}`, ''), reservations);
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: keccak256(RAW) }), { headers: { 'content-type': 'application/json' } }),
    );
    const { queuedWallet } = await import('../src/submissionQueue');
    const wallet = queuedWallet(
      createWalletClient({ account, transport: rpc(async () => keccak256(RAW), [], 'public') }),
      1,
      Number.MAX_SAFE_INTEGER,
      fetchFn as unknown as typeof fetch,
    );
    expect(await broadcastSigned(wallet, 1, RAW, FAR)).toBe(keccak256(RAW));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
