/**
 * #1461 — the ack pass also acknowledges a RELEASED reservation whose delivery
 * executed after all, so Base resolves the share its release counted as
 * stranded. Pinned: which reservations qualify (released AND still holding a
 * stranded share and no acknowledgement stamp yet — an acknowledgement changes
 * nothing for any other), and the
 * discovery read over the chain's own release events on the real schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isLateDeliveryCandidate, lateAckDone, lateAckUseful } from '../src/remitAck';
import { listReleasedRemitIds, listWorkDone, markWorkDone } from '../src/db';
import { createKeeperD1 } from './helpers/schemas';
import type { KeeperD1 } from '../src/env';
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
    // Once the mirror's classification is stamped the ack has done its work.
    expect(
      isLateDeliveryCandidate({ status: 3, strandedRecycled: 1n, consumedAcked: false, quarantineAcked: false }),
      'released, stranded, no stamp yet',
    ).toBe(true);
    expect(
      isLateDeliveryCandidate({ status: 3, strandedRecycled: 1n, quarantineAcked: true }),
      'quarantined: the ceremony or the loss record resolves it, not an ack',
    ).toBe(false);
    expect(
      isLateDeliveryCandidate({ status: 3, strandedRecycled: 1n, consumedAcked: true }),
      'consumption already stamped',
    ).toBe(false);
  });
});

describe('listReleasedRemitIds (real schema)', () => {
  it('lists EVERY released remit id, oldest first, once each, for one chain — no newest-N window (Codex #2489 r1)', async () => {
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
    seed(84532, 'RemitReservationReleased', '4'); // a repeat: once
    // 60 newer releases: the old read took the newest 50, so 4 and 9 fell out.
    for (let i = 0; i < 60; i++) seed(84532, 'RemitReservationReleased', String(100 + i));
    const ids = await listReleasedRemitIds(h.d1 as D1Database, 84532);
    expect(ids.slice(0, 2)).toEqual([4, 9]);
    expect(ids).toHaveLength(62);
  });
});

describe('lateAckUseful', () => {
  it('acks a settled receipt only — a provisional one waits for its broadcast (no fee every backoff)', () => {
    expect(lateAckUseful(0), 'consumed').toBe(true);
    expect(lateAckUseful(1), 'quarantined').toBe(true);
    expect(lateAckUseful(2), 'provisional').toBe(false);
    expect(lateAckUseful(2n), 'provisional, as a bigint').toBe(false);
  });
});

describe('lateAckDone — the done set takes only what the chain shows finished', () => {
  it('a released reservation with nothing left to ack is done; a candidate or any other status is not (straddle)', () => {
    expect(lateAckDone({ status: 3, strandedRecycled: 0n }), 'released, resolved').toBe(true);
    expect(lateAckDone({ status: 3, strandedRecycled: 1n, consumedAcked: true }), 'released, stamped').toBe(true);
    expect(lateAckDone({ status: 3, strandedRecycled: 1n }), 'released, one wei still stranded').toBe(false);
    expect(lateAckDone({ status: 1, strandedRecycled: 0n }), 'not released: never taken as finished').toBe(false);
  });

  it('records into the keeper-private done set, per Diamond, idempotently', async () => {
    const h = createKeeperD1();
    const db = h.d1 as KeeperD1;
    await markWorkDone(db, 84532, '0xAB', 'late_ack', ['4', '9']);
    await markWorkDone(db, 84532, '0xab', 'late_ack', ['4']);
    expect([...(await listWorkDone(db, 84532, '0xab', 'late_ack'))].sort()).toEqual(['4', '9']);
    expect((await listWorkDone(db, 84532, '0xcd', 'late_ack')).size, 'another Diamond: a redeploy starts empty').toBe(0);
    expect((await listWorkDone(db, 84532, '0xab', 'delivery_proof')).size, 'another pass').toBe(0);
  });
});
