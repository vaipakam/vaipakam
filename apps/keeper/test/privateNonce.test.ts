/**
 * #3240 (Codex #3275 r1, r8) — the private nonce record against the keeper's
 * real private schema: one row per network, account and nonce, the address
 * case-folded, a later write of a nonce replacing its earlier one, a null
 * write removing it, and pruning by send time.
 */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { d1NonceReservations } from '../src/privateNonce';
import type { KeeperD1 } from '../src/env';
import { createKeeperD1 } from './helpers/schemas';

const A = '0xD9257B636E17D5714DD54F260c9F7EB81349E49B' as Address;
const sorted = (rows: { nonce: number; atMs: number }[]) => [...rows].sort((x, y) => x.nonce - y.nonce);

describe('d1NonceReservations', () => {
  it('keeps one row per nonce, whatever the address case', async () => {
    const r = d1NonceReservations(createKeeperD1().d1 as unknown as KeeperD1);
    expect(await r.read(1, A)).toEqual([]);
    await r.write(1, A, 5, 100);
    await r.write(1, A.toLowerCase() as Address, 5, 150);
    await r.write(1, A, 6, 200);
    expect(sorted(await r.read(1, A))).toEqual([{ nonce: 5, atMs: 150 }, { nonce: 6, atMs: 200 }]);
    expect(await r.read(8453, A)).toEqual([]);
    await r.write(1, A, 6, null);
    expect(await r.read(1, A)).toEqual([{ nonce: 5, atMs: 150 }]);
    await r.write(1, A, 7, 300);
    await r.prune(1, A, 200);
    expect(await r.read(1, A)).toEqual([{ nonce: 7, atMs: 300 }]);
  });
});
