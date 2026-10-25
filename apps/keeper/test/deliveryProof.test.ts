/**
 * #1944 / transport epochs — the delivery-proof pass. Every budget delivery is
 * rooted (d6), so the planner decides, per delivery, which permissionless call
 * each chunk not yet landed still needs: INDEX it into the delivery's epoch, or
 * PROVE it for a delivery that holds no epoch. Pinned on both routes, including
 * the cases that must do NOTHING (every chunk landed, a disposed packet, a
 * packet with no rooted list) and the refusal (a rebuilt list whose chunk count
 * disagrees with the packet's). Every proof the planner emits is checked to
 * VERIFY against the root, so a builder slip fails here, not as gas. The
 * discovery read runs on the real migration DDL.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import {
  actionsFor,
  canonicalChainOf,
  isWalkExceeded,
  packetMayNeedWork,
  planDelivery,
  type PacketState,
} from '../src/deliveryProof';
import { BaseError } from 'viem';
import { d6Leaf, d6Leaves, d6Root, d6VerifyProof } from '@vaipakam/lib/d6Wire';
import { listBudgetDeliveries } from '../src/db';
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
  return {
    sourceChainId: 84532,
    remitter: `0x${'1'.repeat(40)}`,
    remitId: 1n,
    kind: 1,
    batchId: Z,
    dayListRoot: Z,
    chunkCount: 0,
    chunksIndexed: 0n,
    disposed: 0n,
    arrivedAt: 0,
    ...over,
  };
}

describe('planDelivery — rooted (d6)', () => {
  const list = days(40); // 3 chunks: 16, 16, 8
  const root = d6Root(d6Leaves(list));

  it('proves only the chunks not yet landed, each proof verifying against the root', () => {
    const acts = planDelivery({
      packetHash: H,
      packet: packet({ dayListRoot: root, chunkCount: 3, chunksIndexed: 0b010n }),
      rootedDays: list,
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
      rootedDays: list,
    });
    expect(acts).toHaveLength(3);
    expect(acts.every((a) => a.kind === 'indexChunk' && a.batchId === BATCH)).toBe(true);
  });

  it('refuses a rebuilt list whose chunk count disagrees with the packet', () => {
    expect(
      planDelivery({
        packetHash: H,
        packet: packet({ dayListRoot: root, chunkCount: 2 }),
        rootedDays: list,
      }),
    ).toEqual([]);
  });

  it('does nothing once every chunk has landed', () => {
    expect(
      planDelivery({
        packetHash: H,
        packet: packet({ dayListRoot: root, chunkCount: 3, chunksIndexed: 0b111n }),
        rootedDays: list,
      }),
    ).toEqual([]);
  });
});

describe('planDelivery — nothing to do', () => {
  const list = days(3);
  const root = d6Root(d6Leaves(list));
  it('does nothing for a disposed packet, a non-budget packet, or a packet with no rooted list', () => {
    const base = { packetHash: H, rootedDays: list };
    expect(planDelivery({ ...base, packet: packet({ dayListRoot: root, chunkCount: 1, disposed: 1n }) })).toEqual([]);
    expect(planDelivery({ ...base, packet: packet({ dayListRoot: root, chunkCount: 1, kind: 2 }) })).toEqual([]);
    expect(planDelivery({ ...base, packet: packet({ chunkCount: 1 }) }), 'no root: nothing to prove against').toEqual([]);
  });

  it('does nothing when the list could not be rebuilt', () => {
    expect(planDelivery({ packetHash: H, packet: packet({ dayListRoot: root, chunkCount: 1 }), rootedDays: null })).toEqual([]);
  });
});

describe('listBudgetDeliveries (real schema)', () => {
  function ledger() {
    const h = createSqliteD1(ALL_MIGRATIONS);
    let block = 10;
    const seed = (tx: string, kind: string, args: Record<string, unknown>, at = 5_000, at_block?: number) =>
      h.db
        .prepare(
          `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
           VALUES (?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(421614, at_block ?? block++, tx, kind, JSON.stringify(args), at);
    return { h, seed };
  }
  const S = '84532';

  it('the PRODUCTION discovery page never splits a packet: a page cut at a block keeps each packet whole (#2497 re-cut)', async () => {
    const { discoverBudgetDeliveries } = await import('../src/db');
    const { h, seed } = ledger();
    const P1 = `0x${'a1'.repeat(32)}`;
    const P2 = `0x${'a2'.repeat(32)}`;
    // One transaction per packet, its three events in ONE block (distinct log indexes).
    const ev = h.db.prepare(
      `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at) VALUES (421614, ?, ?, ?, ?, ?, 5000)`,
    );
    for (const [tx, p, blk, days] of [['0xb1', P1, 100, ['4']], ['0xb2', P2, 101, ['5']]] as const) {
      const root = d6Root(d6Leaves(days.map(BigInt)));
      ev.run(blk, 0, tx, 'IngressPacketRecorded', JSON.stringify({ packetHash: p, kind: 1, remitId: '7', sourceChainId: S }));
      ev.run(blk, 1, tx, 'IngressPacketDayListRooted', JSON.stringify({ packetHash: p, dayListRoot: root }));
      ev.run(blk, 2, tx, 'RewardBudgetRootReceived', JSON.stringify({ dayListRoot: root, remitId: '7', sourceChainId: S }));
    }
    void seed;
    // limit 4: the 5th row is block 101, so the page ends before it.
    const first = await discoverBudgetDeliveries(h.d1 as D1Database, 421614, 0, 1_000, 4);
    expect(first.rows.map((r) => r.packetHash.toLowerCase())).toEqual([P1]);
    expect(first.rows[0].remitId, 'paired inside its own page').toBe('7');
    expect(first.next).toBe(101);
    const second = await discoverBudgetDeliveries(h.d1 as D1Database, 421614, first.next, 1_000, 4);
    expect(second.rows.map((r) => r.packetHash.toLowerCase())).toEqual([P2]);
    expect(second.next, 'past the watermark it was given').toBe(1_001);
  });

  const R1 = `0x${'e1'.repeat(32)}`;
  const R2 = `0x${'e2'.repeat(32)}`;

  it('lists every budget packet with a VERIFIED rooted list, oldest first — no age window (Codex #2489 r1)', async () => {
    const { h, seed } = ledger();
    const P1 = `0x${'1'.repeat(64)}`;
    const P2 = `0x${'2'.repeat(64)}`;
    const P3 = `0x${'3'.repeat(64)}`;
    const P4 = `0x${'4'.repeat(64)}`;
    seed('0xt1', 'IngressPacketRecorded', { packetHash: P1, kind: 1, remitId: '7', sourceChainId: S });
    seed('0xt1', 'IngressPacketDayListRooted', { packetHash: P1, dayListRoot: R1 });
    seed('0xt1', 'RewardBudgetRootReceived', { dayListRoot: R1, remitId: '7', sourceChainId: S });
    seed('0xt2', 'IngressPacketRecorded', { packetHash: P2, kind: 1, remitId: '8', sourceChainId: S });
    seed('0xt2', 'IngressPacketDayListRooted', { packetHash: P2, dayListRoot: H });
    seed('0xt2', 'RewardBudgetRootReceived', { dayListRoot: H, remitId: '8', sourceChainId: S });
    seed('0xt3', 'IngressPacketRecorded', { packetHash: P3, kind: 2, remitId: '9', sourceChainId: S }); // not a budget
    seed('0xt5', 'IngressPacketRecorded', { packetHash: P4, kind: 1, remitId: '6', sourceChainId: S }); // no stamp: not provable
    seed('0xt5', 'RewardBudgetRootReceived', { dayListRoot: R2, remitId: '6', sourceChainId: S });
    const rows = await listBudgetDeliveries(h.d1 as D1Database, 421614, 0);
    expect(rows.map((r) => [r.packetHash, r.remitId])).toEqual([
      [P1, '7'],
      [P2, '8'],
    ]);
  });

  it('pairs two ZERO-id deliveries in one transaction by their stamped root, never by source and remit id (#2497 r3)', async () => {
    const { h, seed } = ledger();
    const A = `0x${'a'.repeat(64)}`;
    const B = `0x${'c'.repeat(64)}`;
    const C = `0x${'d'.repeat(64)}`;
    // remitId 0 and the same source for all three — a join on source and remit
    // id would pair each packet with every delivery. C's stamped root matches
    // no delivery in the transaction, so it is left out.
    seed('0xtx', 'IngressPacketRecorded', { packetHash: A, kind: 1, remitId: '0', sourceChainId: S });
    seed('0xtx', 'IngressPacketDayListRooted', { packetHash: A, dayListRoot: R1 });
    seed('0xtx', 'RewardBudgetRootReceived', { dayListRoot: R1, remitId: '0', sourceChainId: S });
    seed('0xtx', 'IngressPacketRecorded', { packetHash: B, kind: 1, remitId: '0', sourceChainId: S });
    seed('0xtx', 'IngressPacketDayListRooted', { packetHash: B, dayListRoot: R2 });
    seed('0xtx', 'RewardBudgetRootReceived', { dayListRoot: R2, remitId: '0', sourceChainId: S });
    seed('0xtx', 'IngressPacketRecorded', { packetHash: C, kind: 1, remitId: '0', sourceChainId: S });
    seed('0xtx', 'IngressPacketDayListRooted', { packetHash: C, dayListRoot: H });
    const rows = await listBudgetDeliveries(h.d1 as D1Database, 421614, 0);
    expect(rows.map((r) => r.packetHash)).toEqual([A, B]);
  });

  it('never lists a pre-d6 flat-list delivery: the receiver refuses that wire, so no such packet is work', async () => {
    const { h, seed } = ledger();
    const P = `0x${'7'.repeat(64)}`;
    seed('0xf1', 'IngressPacketRecorded', { packetHash: P, kind: 1, remitId: '5', sourceChainId: S });
    seed('0xf1', 'IngressPacketDayListRecorded', { packetHash: P, dayListHash: H, dayCount: '2' });
    seed('0xf1', 'RewardBudgetReceived', { dayIds: ['4', '5'], remitId: '5', sourceChainId: S });
    expect(await listBudgetDeliveries(h.d1 as D1Database, 421614, 0)).toEqual([]);
  });

  it("reads nothing from before the active Diamond's first block (#2497 r3)", async () => {
    const { h, seed } = ledger();
    const OLD = `0x${'5'.repeat(64)}`;
    const NEW = `0x${'6'.repeat(64)}`;
    seed('0xold', 'IngressPacketRecorded', { packetHash: OLD, kind: 1, remitId: '1', sourceChainId: S }, 100, 50);
    seed('0xold', 'IngressPacketDayListRooted', { packetHash: OLD, dayListRoot: R1 }, 100, 51);
    seed('0xold', 'RewardBudgetRootReceived', { dayListRoot: R1, remitId: '1', sourceChainId: S }, 100, 52);
    seed('0xnew', 'IngressPacketRecorded', { packetHash: NEW, kind: 1, remitId: '2', sourceChainId: S }, 200, 500);
    seed('0xnew', 'IngressPacketDayListRooted', { packetHash: NEW, dayListRoot: R2 }, 200, 501);
    seed('0xnew', 'RewardBudgetRootReceived', { dayListRoot: R2, remitId: '2', sourceChainId: S }, 200, 502);
    const rows = await listBudgetDeliveries(h.d1 as D1Database, 421614, 400);
    expect(rows.map((r) => r.packetHash)).toEqual([NEW]);
  });
});

describe('the pass wiring', () => {
  it('reads the CANONICAL chain from field 2 of the reporter config, never the mirror\'s own field 1', () => {
    const A0 = '0x0000000000000000000000000000000000000001' as const;
    expect(canonicalChainOf([A0, 421614, 84532, false, 0n])).toBe(84532);
    expect(canonicalChainOf([A0, 84532, 84532, true, 0n])).toBeNull(); // the canonical chain funds itself
    expect(canonicalChainOf([A0, 421614, 0, false, 0n])).toBeNull(); // no canonical configured: nothing to rebuild from
  });

  it('skips, before any read, a packet with nothing left to write', () => {
    const base = packet({ dayListRoot: H, chunkCount: 3 });
    expect(packetMayNeedWork(base)).toBe(true);
    expect(packetMayNeedWork({ ...base, chunksIndexed: 0b011n })).toBe(true); // straddle: one chunk left
    expect(packetMayNeedWork({ ...base, chunksIndexed: 0b111n })).toBe(false); // every chunk landed
    expect(packetMayNeedWork({ ...base, disposed: 1n })).toBe(false);
    expect(packetMayNeedWork({ ...base, kind: 2 })).toBe(false);
    expect(packetMayNeedWork({ ...base, dayListRoot: Z })).toBe(false); // no rooted list: nothing to prove, so finished
    // The protocol's maximum, 256 chunks: the uint256 bitmap with every bit set
    // is finished, and one bit short is not (#2497 r1 — the mask was -1n).
    const full256 = (1n << 256n) - 1n;
    expect(packetMayNeedWork({ ...base, chunkCount: 256, chunksIndexed: full256 }), 'all 256 landed').toBe(false);
    expect(packetMayNeedWork({ ...base, chunkCount: 256, chunksIndexed: full256 >> 1n }), 'chunk 255 missing').toBe(true);
  });
});

describe('isWalkExceeded — the one failure a verified hint cures', () => {
  it('reads the error name from the message, and nothing else counts', () => {
    expect(isWalkExceeded(new BaseError('reverted: TransportIndexWalkExceeded(0x12, 4)'))).toBe(true);
    expect(isWalkExceeded(new Error('execution reverted: TransportIndexWalkExceeded'))).toBe(true);
    expect(isWalkExceeded(new BaseError('reverted: TransportIndexHintInvalid'))).toBe(false);
    expect(isWalkExceeded(new Error('timeout'))).toBe(false);
  });
});

describe("a rooted packet's list is rebuilt from the packet's OWN remitter (#2497 r6)", () => {
  const list = days(3);
  const root = d6Root(d6Leaves(list));
  const OLD = `0x${'2'.repeat(40)}` as const; // a retired canonical Diamond
  const MIRROR = 97;
  const row = { packetHash: H, remitId: '99', block_at: 0, block: 1 }; // the ledger's id is NOT used

  function sourceClient() {
    const reads: { address: string; args: readonly unknown[] }[] = [];
    const client = {
      readContract: async (q: { address: string; functionName: string; args: readonly unknown[] }) => {
        reads.push({ address: q.address, args: q.args });
        return { dayIds: list, dayListRoot: root, dstChainId: MIRROR, fundedDayBits: [0b111n] };
      },
    };
    return { reads, client };
  }

  it('reads the reservation on the packet source chain, at its remitter, under its remit id', async () => {
    const { reads, client } = sourceClient();
    const asked: number[] = [];
    const plan = await actionsFor(
      MIRROR,
      row,
      packet({ sourceChainId: 421614, remitter: OLD, remitId: 3n, dayListRoot: root, chunkCount: 1 }),
      (id) => {
        asked.push(id);
        return client as never;
      },
    );
    expect(asked).toEqual([421614]);
    expect(reads).toEqual([{ address: OLD, args: [3n] }]);
    expect(plan.complete).toBe(false);
    expect(plan.actions.length, 'the rebuilt list is proven').toBeGreaterThan(0);
  });

  it('declines, reading nothing, when the source chain has no RPC here', async () => {
    const warn = (await import('vitest')).vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const plan = await actionsFor(MIRROR, row, packet({ sourceChainId: 1, remitter: OLD, remitId: 3n, dayListRoot: root, chunkCount: 1 }), () => null);
      expect(plan).toEqual({ actions: [], complete: false });
    } finally {
      warn.mockRestore();
    }
  });
});
