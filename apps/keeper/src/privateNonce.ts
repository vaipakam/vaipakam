// apps/keeper/src/privateNonce.ts
//
// The keeper's durable record of the nonces it has broadcast on a chain with
// a PRIVATE submission route (#3240, migration 0007). The ordinary RPC's
// pending count cannot see a private transaction until it is mined, and the
// queue's in-memory record (`submissionQueue.ts`) does not survive a
// restart, so a restarted keeper would read a nonce a private send still
// holds and replace that send.
//
// One row per broadcast nonce, each with its own send time (Codex #3275 r8):
// a nonce is taken while its own row is recent, and free once its row has
// aged out, whatever the rows around it say. So a nonce that never went out
// (a crash between the record and the broadcast) is refilled once its own row
// expires, while a newer send behind it keeps its protection for its own full
// window. A row is written BEFORE its broadcast; a send whose record cannot be
// read or written is refused before anything leaves the process.

import type { Address } from 'viem';
import type { KeeperD1 } from './env';

/** One broadcast nonce and when it was sent. */
export interface NonceReservation {
  nonce: number;
  atMs: number;
}

/** Where the records live. */
export interface NonceReservations {
  /** Every row for the account on the network. */
  read(networkId: number, address: Address): Promise<NonceReservation[]>;
  /** Record `nonce` as sent at `atMs`; null removes its row. */
  write(networkId: number, address: Address, nonce: number, atMs: number | null): Promise<void>;
  /** Drop the rows sent before `beforeMs` (housekeeping, never load-bearing). */
  prune(networkId: number, address: Address, beforeMs: number): Promise<void>;
}

/** The records in the keeper's private database. */
export function d1NonceReservations(db: KeeperD1): NonceReservations {
  return {
    async read(networkId, address) {
      const { results } = await db
        .prepare('SELECT nonce, sent_at_ms FROM keeper_private_nonce WHERE network_id = ?1 AND address = ?2')
        .bind(networkId, address.toLowerCase())
        .all<{ nonce: number; sent_at_ms: number }>();
      return (results ?? []).map((r) => ({ nonce: Number(r.nonce), atMs: Number(r.sent_at_ms) }));
    },
    async write(networkId, address, nonce, atMs) {
      if (atMs === null) {
        await db
          .prepare('DELETE FROM keeper_private_nonce WHERE network_id = ?1 AND address = ?2 AND nonce = ?3')
          .bind(networkId, address.toLowerCase(), nonce)
          .run();
        return;
      }
      await db
        .prepare(
          `INSERT INTO keeper_private_nonce (network_id, address, nonce, sent_at_ms)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(network_id, address, nonce) DO UPDATE SET sent_at_ms = excluded.sent_at_ms`,
        )
        .bind(networkId, address.toLowerCase(), nonce, atMs)
        .run();
    },
    async prune(networkId, address, beforeMs) {
      await db
        .prepare('DELETE FROM keeper_private_nonce WHERE network_id = ?1 AND address = ?2 AND sent_at_ms < ?3')
        .bind(networkId, address.toLowerCase(), beforeMs)
        .run();
    },
  };
}

/** Records held in memory: tests, and nothing else. */
export function memoryNonceReservations(): NonceReservations & { rows: Map<string, number> } {
  // key `${network}:${address}:${nonce}` -> sent at
  const rows = new Map<string, number>();
  const prefix = (n: number, a: Address) => `${n}:${a.toLowerCase()}:`;
  return {
    rows,
    async read(n, a) {
      const p = prefix(n, a);
      return [...rows].filter(([k]) => k.startsWith(p)).map(([k, atMs]) => ({ nonce: Number(k.slice(p.length)), atMs }));
    },
    async write(n, a, nonce, atMs) {
      if (atMs === null) rows.delete(prefix(n, a) + nonce);
      else rows.set(prefix(n, a) + nonce, atMs);
    },
    async prune(n, a, beforeMs) {
      const p = prefix(n, a);
      for (const [k, at] of rows) if (k.startsWith(p) && at < beforeMs) rows.delete(k);
    },
  };
}
