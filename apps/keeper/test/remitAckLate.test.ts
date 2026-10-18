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
import { enqueueWork, finishWork, listOpenWork, listReleasedRemitIds, pageByBlock, touchOpenWork } from '../src/db';
import { discoverWork } from '../src/workQueue';
import { createKeeperD1, createSharedD1 } from './helpers/schemas';
import type { Env } from '../src/env';
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

});

describe('the open-work queue (#2497 r8) — keeper-private, per Diamond and pass', () => {
  const db = () => createKeeperD1().d1 as KeeperD1;
  const w = (item: string, block: number) => ({ item, block, payload: { remitId: Number(item) } });

  it('queues idempotently, per Diamond and pass, and lists the least recently checked first', async () => {
    const k = db();
    await enqueueWork(k, 84532, '0xAB', 'late_ack', [w('4', 10), w('9', 12)]);
    await enqueueWork(k, 84532, '0xab', 'late_ack', [w('4', 10)]); // re-discovered: no-op
    await enqueueWork(k, 84532, '0xcd', 'late_ack', [w('4', 10)]);
    await enqueueWork(k, 84532, '0xab', 'delivery_proof', [w('4', 10)]);
    expect((await listOpenWork(k, 84532, '0xab', 'late_ack', 10)).map((o) => o.item)).toEqual(['4', '9']);
    await touchOpenWork(k, 84532, '0xab', 'late_ack', ['4']);
    expect((await listOpenWork(k, 84532, '0xab', 'late_ack', 10)).map((o) => o.item), 'a checked item rotates to the back').toEqual(['9', '4']);
    expect((await listOpenWork(k, 84532, '0xab', 'late_ack', 1)).map((o) => o.payload), 'bounded, payload intact').toEqual([{ remitId: 9 }]);
  });

  it('retires only the named items of one Diamond and pass', async () => {
    const k = db();
    await enqueueWork(k, 84532, '0xab', 'late_ack', [w('4', 10), w('9', 12)]);
    await enqueueWork(k, 84532, '0xcd', 'late_ack', [w('4', 10)]);
    await enqueueWork(k, 84532, '0xab', 'delivery_proof', [w('4', 10)]);
    await finishWork(k, 84532, '0xAB', 'late_ack', ['4']);
    expect((await listOpenWork(k, 84532, '0xab', 'late_ack', 10)).map((o) => o.item)).toEqual(['9']);
    expect((await listOpenWork(k, 84532, '0xcd', 'late_ack', 10)).length, 'another Diamond').toBe(1);
    expect((await listOpenWork(k, 84532, '0xab', 'delivery_proof', 10)).length, 'another pass').toBe(1);
  });

  it('an item that never finishes holds back nothing: the rotation reaches every other one', async () => {
    const k = db();
    await enqueueWork(k, 1, '0xab', 'late_ack', [w('1', 1), w('2', 2), w('3', 3)]);
    const seen: string[] = [];
    for (let t = 0; t < 3; t++) {
      const slice = await listOpenWork(k, 1, '0xab', 'late_ack', 1);
      seen.push(slice[0].item);
      await touchOpenWork(k, 1, '0xab', 'late_ack', slice.map((o) => o.item)); // never finishes
      await new Promise((r) => setTimeout(r, 1_010)); // checked_at is whole seconds
    }
    expect(seen.sort()).toEqual(['1', '2', '3']);
  }, 10_000);
});

describe('pageByBlock — a discovery page never splits a block (#2497 r8)', () => {
  const rows = (...blocks: number[]) => blocks.map((b, i) => ({ block_number: b, i }));
  const fetchOver = (all: { block_number: number; i: number }[]) => async (from: number, through: number, limit: number | null) => {
    const hit = all.filter((r) => r.block_number >= from && r.block_number <= through);
    return limit === null ? hit : hit.slice(0, limit);
  };

  it('a short read ends past `through`', async () => {
    const r = await pageByBlock(fetchOver(rows(5, 6)), 0, 100, 3);
    expect(r).toEqual({ rows: rows(5, 6), next: 101 });
  });

  it('an overflowing page leaves its last block whole for the next page', async () => {
    const all = rows(5, 6, 7, 7, 8);
    const r = await pageByBlock(fetchOver(all), 0, 100, 3); // reads 5,6,7,7: the 4th row is block 7
    expect(r.rows.map((x) => x.block_number)).toEqual([5, 6]);
    expect(r.next).toBe(7);
    const r2 = await pageByBlock(fetchOver(all), r.next, 100, 3);
    expect(r2.rows.map((x) => x.block_number), 'block 7 together').toEqual([7, 7, 8]);
  });

  it('a single block bigger than a page is read whole, and the page moves past it', async () => {
    const r = await pageByBlock(fetchOver(rows(9, 9, 9, 9, 9, 10)), 0, 100, 2);
    expect(r.rows.map((x) => x.block_number)).toEqual([9, 9, 9, 9, 9]);
    expect(r.next).toBe(10);
  });
});

describe('discoverWork — the cursor stops at the indexed watermark read BEFORE the page (#2497 r5, r6, r8)', () => {
  function setup(lastBlock: number | null) {
    const shared = createSharedD1();
    if (lastBlock !== null) {
      shared.db.prepare(`INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (1, 'diamond', ?, 0)`).run(lastBlock);
    }
    const keeper = createKeeperD1();
    return { env: { DB: shared.d1, KEEPER_DB: keeper.d1 } as unknown as Env, keeper };
  }
  const reader = (blocks: number[]) => async (from: number, through: number) => ({
    items: blocks.filter((b) => b >= from && b <= through).map((b) => ({ item: String(b), block: b, payload: {} })),
    next: through + 1,
  });

  it('queues only what is completely recorded and moves the cursor just past it', async () => {
    const { env, keeper } = setup(20);
    expect(await discoverWork(env, 1, '0xab', 'late_ack', 0, reader([10, 20, 25]))).toBe(2);
    expect((await listOpenWork(keeper.d1 as KeeperD1, 1, '0xab', 'late_ack', 10)).map((o) => o.item)).toEqual(['10', '20']);
    const row = keeper.db.prepare('SELECT next_block FROM keeper_work_cursor').get() as { next_block: number };
    expect(row.next_block).toBe(21);
  });

  it('reads nothing while the watermark is unreadable, and never moves the cursor back', async () => {
    const { env, keeper } = setup(null);
    expect(await discoverWork(env, 1, '0xab', 'late_ack', 0, reader([10]))).toBe(0);
    expect(keeper.db.prepare('SELECT COUNT(*) AS n FROM keeper_work_cursor').get()).toEqual({ n: 0 });
    const { putWorkCursor } = await import('../src/db');
    await putWorkCursor(keeper.d1 as KeeperD1, 1, '0xab', 'late_ack', 50);
    await putWorkCursor(keeper.d1 as KeeperD1, 1, '0xab', 'late_ack', 30);
    expect(keeper.db.prepare('SELECT next_block FROM keeper_work_cursor').get()).toEqual({ next_block: 50 });
  });

  it('a permanently open item does not pin discovery: later items are still found', async () => {
    const { env, keeper } = setup(100);
    await discoverWork(env, 1, '0xab', 'late_ack', 0, reader([10]));
    // Item 10 is never finished. More is recorded later.
    keeper.db.prepare('UPDATE keeper_work_open SET checked_at = 1').run();
    (env.DB as unknown as { prepare: (q: string) => { bind: (...a: unknown[]) => { run: () => Promise<unknown> } } })
      .prepare(`UPDATE indexer_cursor SET last_block = 200 WHERE chain_id = 1 AND kind = 'diamond'`).bind().run();
    expect(await discoverWork(env, 1, '0xab', 'late_ack', 0, reader([10, 150]))).toBe(1);
    expect((await listOpenWork(keeper.d1 as KeeperD1, 1, '0xab', 'late_ack', 10)).map((o) => o.item).sort()).toEqual(['10', '150']);
  });
});
