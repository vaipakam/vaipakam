// apps/keeper/src/privateNonce.ts
//
// The keeper's record of the next nonce it may use on a chain with a PRIVATE
// submission route (#3240, migration 0007). The ordinary RPC's pending count
// cannot see a private transaction until it is mined, and the queue's
// in-memory floor (`submissionQueue.ts`) does not survive a restart, so a
// restarted keeper would read a nonce a private send still holds and replace
// that send. The record is written BEFORE each private broadcast and read at
// each private send's turn; a send whose record cannot be read or written is
// refused before anything leaves the process.

import type { Address } from 'viem';
import type { KeeperD1 } from './env';

/** One account's record on one network. */
export interface NonceReservation {
  next: number;
  atMs: number;
}

/** Where the records live. */
export interface NonceReservations {
  read(networkId: number, address: Address): Promise<NonceReservation | null>;
  write(networkId: number, address: Address, next: number, atMs: number): Promise<void>;
}

/** The records in the keeper's private database. */
export function d1NonceReservations(db: KeeperD1): NonceReservations {
  return {
    async read(networkId, address) {
      const row = await db
        .prepare('SELECT next_nonce, recorded_at_ms FROM keeper_private_nonce WHERE network_id = ?1 AND address = ?2')
        .bind(networkId, address.toLowerCase())
        .first<{ next_nonce: number; recorded_at_ms: number }>();
      return row ? { next: Number(row.next_nonce), atMs: Number(row.recorded_at_ms) } : null;
    },
    async write(networkId, address, next, atMs) {
      await db
        .prepare(
          `INSERT INTO keeper_private_nonce (network_id, address, next_nonce, recorded_at_ms)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(network_id, address) DO UPDATE SET
             next_nonce = excluded.next_nonce,
             recorded_at_ms = excluded.recorded_at_ms`,
        )
        .bind(networkId, address.toLowerCase(), next, atMs)
        .run();
    },
  };
}

/** Records held in memory: tests, and nothing else. */
export function memoryNonceReservations(): NonceReservations & { rows: Map<string, NonceReservation> } {
  const rows = new Map<string, NonceReservation>();
  const key = (n: number, a: Address) => `${n}:${a.toLowerCase()}`;
  return {
    rows,
    async read(n, a) {
      return rows.get(key(n, a)) ?? null;
    },
    async write(n, a, next, atMs) {
      rows.set(key(n, a), { next, atMs });
    },
  };
}
