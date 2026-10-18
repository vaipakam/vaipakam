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
    const S = { strandedStamped: true } as const;
    expect(isLateDeliveryCandidate({ status: 3, strandedRecycled: 1n, ...S }), 'released, one wei stranded').toBe(true);
    expect(isLateDeliveryCandidate({ status: 3, strandedRecycled: 0n, ...S }), 'released, already resolved').toBe(false);
    expect(isLateDeliveryCandidate({ status: 1, strandedRecycled: 5n, ...S }), 'still pending: the main scan acks it').toBe(false);
    expect(isLateDeliveryCandidate({ status: 2, strandedRecycled: 5n, ...S }), 'acked').toBe(false);
    // Once the mirror's classification is stamped the ack has done its work.
    expect(
      isLateDeliveryCandidate({ status: 3, strandedRecycled: 1n, consumedAcked: false, quarantineAcked: false, ...S }),
      'released, stranded, no ack stamp yet',
    ).toBe(true);
    expect(
      isLateDeliveryCandidate({ status: 3, strandedRecycled: 1n, quarantineAcked: true, ...S }),
      'quarantined: the ceremony or the loss record resolves it, not an ack',
    ).toBe(false);
    expect(
      isLateDeliveryCandidate({ status: 3, strandedRecycled: 1n, consumedAcked: true, ...S }),
      'consumption already stamped',
    ).toBe(false);
  });

  it('keeps an UNSTAMPED release a candidate: a default-zero share is not a resolved one (#2497 r1)', () => {
    expect(isLateDeliveryCandidate({ status: 3, strandedRecycled: 0n, strandedStamped: false }), 'unstamped, reads zero').toBe(true);
    expect(isLateDeliveryCandidate({ status: 3 }), 'a view without the field: not stamped').toBe(true);
    expect(isLateDeliveryCandidate({ status: 1, strandedStamped: false }), 'not released: the main scan').toBe(false);
  });
});

describe('lateAckDone — the permanent done set takes POSITIVE evidence only (#2497 r1)', () => {
  it('retires a release only once its share is stamped AND resolved', () => {
    expect(lateAckDone({ status: 3, strandedRecycled: 0n, strandedStamped: true }), 'stamped, nothing stranded').toBe(true);
    expect(lateAckDone({ status: 3, strandedRecycled: 0n, strandedStamped: false }), 'unstamped: never retired').toBe(false);
    expect(lateAckDone({ status: 3, strandedRecycled: 0n }), 'no stamp field: never retired').toBe(false);
    expect(lateAckDone({ status: 3, strandedRecycled: 1n, strandedStamped: true }), 'stamped, still stranded').toBe(false);
    expect(lateAckDone({ status: 3, strandedRecycled: 1n, strandedStamped: true, consumedAcked: true }), 'stamped and acked').toBe(true);
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
    const ids = await listReleasedRemitIds(h.d1 as D1Database, 84532, 0);
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
    expect(lateAckDone({ status: 3, strandedRecycled: 0n, strandedStamped: true }), 'released, resolved').toBe(true);
    expect(lateAckDone({ status: 3, strandedRecycled: 1n, consumedAcked: true, strandedStamped: true }), 'released, stamped').toBe(true);
    expect(lateAckDone({ status: 3, strandedRecycled: 1n, strandedStamped: true }), 'released, one wei still stranded').toBe(false);
    expect(lateAckDone({ status: 1, strandedRecycled: 0n }), 'not released: never taken as finished').toBe(false);
  });

  it('records into the keeper-private done set, per Diamond, idempotently', async () => {
    const h = createKeeperD1();
    const db = h.d1 as KeeperD1;
    const at = (item: string, block = 10) => ({ item, block });
    await markWorkDone(db, 84532, '0xAB', 'late_ack', [at('4'), at('9')]);
    await markWorkDone(db, 84532, '0xab', 'late_ack', [at('4')]);
    expect([...(await listWorkDone(db, 84532, '0xab', 'late_ack'))].sort()).toEqual(['4', '9']);
    expect((await listWorkDone(db, 84532, '0xcd', 'late_ack')).size, 'another Diamond: a redeploy starts empty').toBe(0);
    expect((await listWorkDone(db, 84532, '0xab', 'delivery_proof')).size, 'another pass').toBe(0);
  });

  it('prunes by the frontier alone — idempotent, one Diamond and pass only — and reads only from it (#2497 r6)', async () => {
    const { pruneWorkDoneBelow } = await import('../src/db');
    const h = createKeeperD1();
    const db = h.d1 as KeeperD1;
    await markWorkDone(db, 84532, '0xab', 'late_ack', [{ item: '4', block: 10 }, { item: '9', block: 19 }, { item: '12', block: 20 }]);
    await markWorkDone(db, 84532, '0xab', 'delivery_proof', [{ item: '4', block: 10 }]);
    await markWorkDone(db, 84532, '0xcd', 'late_ack', [{ item: '4', block: 10 }]);
    expect([...(await listWorkDone(db, 84532, '0xab', 'late_ack', 20))], 'the read starts at the frontier, before any prune').toEqual(['12']);
    await pruneWorkDoneBelow(db, 84532, '0xAB', 'late_ack', 20);
    await pruneWorkDoneBelow(db, 84532, '0xAB', 'late_ack', 20); // a retry is harmless
    expect([...(await listWorkDone(db, 84532, '0xab', 'late_ack'))]).toEqual(['12']);
    expect((await listWorkDone(db, 84532, '0xab', 'delivery_proof')).size, 'another pass untouched').toBe(1);
    expect((await listWorkDone(db, 84532, '0xcd', 'late_ack')).size, 'another Diamond untouched').toBe(1);
  });
});

describe('nextFrontier — the done frontier moves only past confirmed-done items (#2497 r4)', () => {
  it('stops at the first open item, passes the last when all are done, and never moves back', async () => {
    const { nextFrontier } = await import('../src/db');
    expect(nextFrontier([{ block: 10, done: true }, { block: 12, done: false }, { block: 15, done: true }], 0, 100), 'first open').toBe(12);
    expect(nextFrontier([{ block: 10, done: true }, { block: 15, done: true }], 0, 15), 'all done: past the last indexed block').toBe(16);
    expect(nextFrontier([], 40, 39), 'nothing read, nothing newly indexed: unchanged').toBe(40);
    expect(nextFrontier([{ block: 30, done: false }], 40, 100), 'never backwards').toBe(40);
  });

  it('never passes what the indexer has completely recorded (#2497 r5)', async () => {
    const { nextFrontier } = await import('../src/db');
    // Every read item done, but the indexer is only through block 20: a delivery
    // still landing in block 21+ must be read next tick.
    expect(nextFrontier([{ block: 10, done: true }, { block: 15, done: true }], 0, 20)).toBe(21);
    // An item above the watermark (a partially written window) settles nothing.
    expect(nextFrontier([{ block: 10, done: true }, { block: 25, done: true }], 0, 20)).toBe(21);
    // An empty read moves to the watermark, so the next read starts there.
    expect(nextFrontier([], 5, 50)).toBe(51);
    // The watermark unreadable: the frontier does not move.
    expect(nextFrontier([{ block: 10, done: true }], 5, null)).toBe(5);
  });
});
