/**
 * #1461 — the ack pass also acknowledges a RELEASED reservation whose delivery
 * executed after all, so Base resolves the share its release counted as
 * stranded. Pinned: which reservations qualify (released AND still holding a
 * stranded share — an acknowledgement changes nothing for any other), and the
 * discovery read over the chain's own release events on the real schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isLateDeliveryCandidate } from '../src/remitAck';
import { listReleasedRemitIds } from '../src/db';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../../indexer/migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

describe('isLateDeliveryCandidate', () => {
  it('takes a released reservation that still holds a stranded share, and nothing else (straddle)', () => {
    expect(isLateDeliveryCandidate({ status: 3, strandedRecycled: 1n }), 'released, one wei stranded').toBe(true);
    expect(isLateDeliveryCandidate({ status: 3, strandedRecycled: 0n }), 'released, already resolved').toBe(false);
    expect(isLateDeliveryCandidate({ status: 3 }), 'released, a pre-#1461 view').toBe(false);
    expect(isLateDeliveryCandidate({ status: 1, strandedRecycled: 5n }), 'still pending: the main scan acks it').toBe(false);
    expect(isLateDeliveryCandidate({ status: 2, strandedRecycled: 5n }), 'acked').toBe(false);
  });
});

describe('listReleasedRemitIds (real schema)', () => {
  it('lists released remit ids newest first, once each, for one chain', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    let block = 1;
    const seed = (chain: number, kind: string, remitId: string) =>
      h.db
        .prepare(
          `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
           VALUES (?, ?, 0, ?, ?, ?, 0)`,
        )
        .run(chain, block++, `0xt${block}`, kind, JSON.stringify({ remitId }));
    seed(84532, 'RemitReservationReleased', '4');
    seed(84532, 'RemitReservationReleased', '9');
    seed(84532, 'RemitReservationAcked', '5');
    seed(421614, 'RemitReservationReleased', '7');
    expect(await listReleasedRemitIds(h.d1 as D1Database, 84532)).toEqual([9, 4]);
  });
});
