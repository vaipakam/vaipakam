/**
 * #1944 / transport epochs — the delivery-proof pass. The planner decides, per
 * delivery, which permissionless call it still needs: INDEX an epoch's days
 * (flat page / rooted chunk) or PROVE a no-epoch delivery's days (flat list /
 * rooted chunk). Pinned on every route, including the two that must do
 * NOTHING (a whole index, an already-landed list) and the refusals (a rebuilt
 * list whose chunk count disagrees with the packet's, a disposed packet). Every
 * rooted proof the planner emits is checked to VERIFY against the root, so a
 * builder slip fails here, not as gas. The discovery read runs on the real
 * migration DDL.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { planDelivery, type PacketState } from '../src/deliveryProof';
import { d6Leaf, d6Leaves, d6Root, d6VerifyProof } from '../src/d6Wire';
import { listRecentBudgetDeliveries } from '../src/db';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../../indexer/migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const Z = `0x${'0'.repeat(64)}` as Hex;
const H = `0x${'a'.repeat(64)}` as Hex;
const BATCH = `0x${'b'.repeat(64)}` as Hex;
const days = (n: number, from = 100) => Array.from({ length: n }, (_, i) => BigInt(from + i));

function packet(over: Partial<PacketState> = {}): PacketState {
  return { kind: 1, batchId: Z, dayListHash: Z, dayListRoot: Z, chunkCount: 0, chunksIndexed: 0n, disposed: 0n, ...over };
}

describe('planDelivery — rooted (d6)', () => {
  const list = days(40); // 3 chunks: 16, 16, 8
  const root = d6Root(d6Leaves(list));

  it('proves only the chunks not yet landed, each proof verifying against the root', () => {
    const acts = planDelivery({
      packetHash: H,
      packet: packet({ dayListRoot: root, chunkCount: 3, chunksIndexed: 0b010n }),
      batch: null,
      flatDays: null,
      rootedDays: list,
      flatAllLanded: false,
    });
    expect(acts.map((a) => (a.kind === 'proveChunk' ? a.chunkIndex : -1))).toEqual([0, 2]);
    for (const a of acts) {
      if (a.kind !== 'proveChunk') throw new Error('route');
      expect(d6VerifyProof(a.proof, root, d6Leaf(a.chunkIndex, a.dayIds)), `chunk ${a.chunkIndex}`).toBe(true);
    }
  });

  it('INDEXES instead of proving when the delivery holds an epoch', () => {
    const acts = planDelivery({
      packetHash: H,
      packet: packet({ dayListRoot: root, chunkCount: 3, batchId: BATCH }),
      batch: { dayCount: 40, indexedDays: 0 },
      flatDays: null,
      rootedDays: list,
      flatAllLanded: false,
    });
    expect(acts).toHaveLength(3);
    expect(acts.every((a) => a.kind === 'indexChunk' && a.batchId === BATCH)).toBe(true);
  });

  it('refuses a rebuilt list whose chunk count disagrees with the packet', () => {
    expect(
      planDelivery({
        packetHash: H,
        packet: packet({ dayListRoot: root, chunkCount: 2 }),
        batch: null,
        flatDays: null,
        rootedDays: list,
        flatAllLanded: false,
      }),
    ).toEqual([]);
  });

  it('does nothing once every chunk has landed', () => {
    expect(
      planDelivery({
        packetHash: H,
        packet: packet({ dayListRoot: root, chunkCount: 3, chunksIndexed: 0b111n }),
        batch: null,
        flatDays: null,
        rootedDays: list,
        flatAllLanded: false,
      }),
    ).toEqual([]);
  });
});

describe('planDelivery — flat', () => {
  const list = days(3);
  it('indexes one page while the epoch index is short of whole, then stops (straddle)', () => {
    const base = { packetHash: H, packet: packet({ dayListHash: H, batchId: BATCH }), flatDays: list, rootedDays: null, flatAllLanded: false };
    expect(planDelivery({ ...base, batch: { dayCount: 3, indexedDays: 2 } })).toEqual([
      { kind: 'indexPage', batchId: BATCH, dayIds: list },
    ]);
    expect(planDelivery({ ...base, batch: { dayCount: 3, indexedDays: 3 } }), 'whole: the writer would refuse').toEqual([]);
  });

  it('proves a no-epoch list once, and not again once every day landed', () => {
    const base = { packetHash: H, packet: packet({ dayListHash: H }), batch: null, flatDays: list, rootedDays: null };
    expect(planDelivery({ ...base, flatAllLanded: false })).toEqual([{ kind: 'proveList', packetHash: H, dayIds: list }]);
    expect(planDelivery({ ...base, flatAllLanded: true })).toEqual([]);
  });

  it('does nothing for a disposed packet, a non-budget packet, or a packet with no list', () => {
    const base = { packetHash: H, batch: null, flatDays: list, rootedDays: null, flatAllLanded: false };
    expect(planDelivery({ ...base, packet: packet({ dayListHash: H, disposed: 1n }) })).toEqual([]);
    expect(planDelivery({ ...base, packet: packet({ dayListHash: H, kind: 2 }) })).toEqual([]);
    expect(planDelivery({ ...base, packet: packet() })).toEqual([]);
  });
});

describe('listRecentBudgetDeliveries (real schema)', () => {
  it('joins each budget packet to its day-list event in the same transaction, newest first', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    let block = 10;
    const seed = (tx: string, kind: string, args: Record<string, unknown>, at: number) =>
      h.db
        .prepare(
          `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
           VALUES (?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(421614, block++, tx, kind, JSON.stringify(args), at);
    const P1 = `0x${'1'.repeat(64)}`;
    const P2 = `0x${'2'.repeat(64)}`;
    const P3 = `0x${'3'.repeat(64)}`;
    seed('0xt1', 'IngressPacketRecorded', { packetHash: P1, kind: 1, remitId: '7' }, 5_000);
    seed('0xt1', 'RewardBudgetReceived', { dayIds: ['4', '5'] }, 5_000);
    seed('0xt2', 'IngressPacketRecorded', { packetHash: P2, kind: 1, remitId: '8' }, 6_000);
    seed('0xt2', 'RewardBudgetRootReceived', { dayListRoot: H }, 6_000);
    seed('0xt3', 'IngressPacketRecorded', { packetHash: P3, kind: 2, remitId: '9' }, 7_000); // compensation: not a budget
    seed('0xt0', 'IngressPacketRecorded', { packetHash: `0x${'4'.repeat(64)}`, kind: 1, remitId: '6' }, 100); // too old
    seed('0xt0', 'RewardBudgetReceived', { dayIds: ['1'] }, 100);
    const rows = await listRecentBudgetDeliveries(h.d1 as D1Database, 421614, 1_000);
    expect(rows.map((r) => [r.packetHash, r.remitId, r.rooted, r.flatDayIds])).toEqual([
      [P2, '8', true, null],
      [P1, '7', false, ['4', '5']],
    ]);
  });
});
