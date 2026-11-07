/**
 * #3240 (Codex #3275 r1) — the private nonce record against the keeper's real
 * private schema: one row per network and account, the address case-folded,
 * and a later write replacing the earlier one.
 */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { d1NonceReservations } from '../src/privateNonce';
import type { KeeperD1 } from '../src/env';
import { createKeeperD1 } from './helpers/schemas';

const A = '0xD9257B636E17D5714DD54F260c9F7EB81349E49B' as Address;

describe('d1NonceReservations', () => {
  it('reads nothing before the first write, then the latest write, whatever the address case', async () => {
    const r = d1NonceReservations(createKeeperD1().d1 as unknown as KeeperD1);
    expect(await r.read(1, A)).toBeNull();
    await r.write(1, A, { next: 5, atMs: 100, open: 4 });
    await r.write(1, A.toLowerCase() as Address, { next: 6, atMs: 200, open: 5 });
    expect(await r.read(1, A)).toEqual({ next: 6, atMs: 200, open: 5 });
    expect(await r.read(8453, A)).toBeNull();
  });
});
