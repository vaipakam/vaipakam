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
  /** When the window opened: the last time the chain was seen to move past `open`. */
  atMs: number;
  /**
   * The oldest reserved nonce not yet seen mined. A successor renews the
   * window only once the pending count has passed it, so a gap that never
   * mines (a crash between the record and the broadcast) ages out within one
   * window however many successors are accepted behind it (Codex #3275 r7).
   */
  open: number;
}

/** Where the records live. */
export interface NonceReservations {
  read(networkId: number, address: Address): Promise<NonceReservation | null>;
  write(networkId: number, address: Address, record: NonceReservation): Promise<void>;
}

/** The records in the keeper's private database. */
export function d1NonceReservations(db: KeeperD1): NonceReservations {
  return {
    async read(networkId, address) {
      const row = await db
        .prepare('SELECT next_nonce, recorded_at_ms, open_nonce FROM keeper_private_nonce WHERE network_id = ?1 AND address = ?2')
        .bind(networkId, address.toLowerCase())
        .first<{ next_nonce: number; recorded_at_ms: number; open_nonce: number }>();
      return row ? { next: Number(row.next_nonce), atMs: Number(row.recorded_at_ms), open: Number(row.open_nonce) } : null;
    },
    async write(networkId, address, { next, atMs, open }) {
      await db
        .prepare(
          `INSERT INTO keeper_private_nonce (network_id, address, next_nonce, recorded_at_ms, open_nonce)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(network_id, address) DO UPDATE SET
             next_nonce = excluded.next_nonce,
             recorded_at_ms = excluded.recorded_at_ms,
             open_nonce = excluded.open_nonce`,
        )
        .bind(networkId, address.toLowerCase(), next, atMs, open)
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
    async write(n, a, record) {
      rows.set(key(n, a), { ...record });
    },
  };
}
