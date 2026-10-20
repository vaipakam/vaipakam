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
import {
  actionsFor,
  rolloutAdmissible,
  canonicalChainOf,
  deliveryComplete,
  fundedDaysFromBits,
  isWalkExceeded,
  packetMayNeedWork,
  planDelivery,
  type PacketState,
} from '../src/deliveryProof';
import { BaseError, encodeAbiParameters, keccak256 } from 'viem';
import { d6Leaf, d6Leaves, d6Root, d6VerifyProof } from '../src/d6Wire';
import { flatDayListHash, listBudgetDeliveries } from '../src/db';
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
    dayListHash: Z,
    dayListRoot: Z,
    chunkCount: 0,
    chunksIndexed: 0n,
    disposed: 0n,
    arrivedAt: 0,
    dayCount: 0,
    freshShare: 0n,
    recycledShare: 0n,
    unclassified: 0n,
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
      ev.run(blk, 0, tx, 'IngressPacketRecorded', JSON.stringify({ packetHash: p, kind: 1, remitId: '7', sourceChainId: S }));
      ev.run(blk, 1, tx, 'IngressPacketDayListRecorded', JSON.stringify({ packetHash: p, dayListHash: flatDayListHash([...days]), dayCount: '1' }));
      ev.run(blk, 2, tx, 'RewardBudgetReceived', JSON.stringify({ dayIds: [...days], remitId: '7', sourceChainId: S }));
    }
    void seed;
    // limit 4: the 5th row is block 101, so the page ends before it.
    const first = await discoverBudgetDeliveries(h.d1 as D1Database, 421614, 0, 1_000, 4);
    expect(first.rows.map((r) => r.packetHash.toLowerCase())).toEqual([P1]);
    expect(first.rows[0].flatDayIds, 'paired inside its own page').toEqual(['4']);
    expect(first.next).toBe(101);
    const second = await discoverBudgetDeliveries(h.d1 as D1Database, 421614, first.next, 1_000, 4);
    expect(second.rows.map((r) => r.packetHash.toLowerCase())).toEqual([P2]);
    expect(second.next, 'past the watermark it was given').toBe(1_001);
  });

  it('lists every budget packet with a VERIFIED day list, oldest first — no age window (Codex #2489 r1)', async () => {
    const { h, seed } = ledger();
    const P1 = `0x${'1'.repeat(64)}`;
    const P2 = `0x${'2'.repeat(64)}`;
    const P3 = `0x${'3'.repeat(64)}`;
    const P4 = `0x${'4'.repeat(64)}`;
    seed('0xt1', 'IngressPacketRecorded', { packetHash: P1, kind: 1, remitId: '7', sourceChainId: S });
    seed('0xt1', 'IngressPacketDayListRecorded', { packetHash: P1, dayListHash: flatDayListHash(['4', '5']), dayCount: '2' });
    seed('0xt1', 'RewardBudgetReceived', { dayIds: ['4', '5'], remitId: '7', sourceChainId: S });
    seed('0xt2', 'IngressPacketRecorded', { packetHash: P2, kind: 1, remitId: '8', sourceChainId: S });
    seed('0xt2', 'IngressPacketDayListRooted', { packetHash: P2, dayListRoot: H });
    seed('0xt2', 'RewardBudgetRootReceived', { dayListRoot: H, remitId: '8', sourceChainId: S });
    seed('0xt3', 'IngressPacketRecorded', { packetHash: P3, kind: 2, remitId: '9', sourceChainId: S }); // not a budget
    seed('0xt5', 'IngressPacketRecorded', { packetHash: P4, kind: 1, remitId: '6', sourceChainId: S }); // no stamp: not provable
    seed('0xt5', 'RewardBudgetReceived', { dayIds: ['1'], remitId: '6', sourceChainId: S });
    const rows = await listBudgetDeliveries(h.d1 as D1Database, 421614, 0);
    expect(rows.map((r) => [r.packetHash, r.remitId, r.rooted, r.flatDayIds])).toEqual([
      [P1, '7', false, ['4', '5']],
      [P2, '8', true, null],
    ]);
  });

  it('pairs two ZERO-id deliveries in one transaction by their stamped commitment, never by source and remit id (#2497 r3)', async () => {
    const { h, seed } = ledger();
    const A = `0x${'a'.repeat(64)}`;
    const B = `0x${'c'.repeat(64)}`;
    // Both legacy/manual: remitId 0 and the same source — the old join paired each packet with BOTH.
    seed('0xtx', 'IngressPacketRecorded', { packetHash: A, kind: 1, remitId: '0', sourceChainId: S });
    seed('0xtx', 'IngressPacketDayListRecorded', { packetHash: A, dayListHash: flatDayListHash(['1', '2']), dayCount: '2' });
    seed('0xtx', 'RewardBudgetReceived', { dayIds: ['1', '2'], remitId: '0', sourceChainId: S });
    seed('0xtx', 'IngressPacketRecorded', { packetHash: B, kind: 1, remitId: '0', sourceChainId: S });
    seed('0xtx', 'IngressPacketDayListRecorded', { packetHash: B, dayListHash: flatDayListHash(['3']), dayCount: '1' });
    seed('0xtx', 'RewardBudgetReceived', { dayIds: ['3'], remitId: '0', sourceChainId: S });
    const rows = await listBudgetDeliveries(h.d1 as D1Database, 421614, 0);
    expect(rows.map((r) => [r.packetHash, r.flatDayIds])).toEqual([
      [A, ['1', '2']],
      [B, ['3']],
    ]);
  });

  it("reads nothing from before the active Diamond's first block (#2497 r3)", async () => {
    const { h, seed } = ledger();
    const OLD = `0x${'5'.repeat(64)}`;
    const NEW = `0x${'6'.repeat(64)}`;
    seed('0xold', 'IngressPacketRecorded', { packetHash: OLD, kind: 1, remitId: '1', sourceChainId: S }, 100, 50);
    seed('0xold', 'IngressPacketDayListRecorded', { packetHash: OLD, dayListHash: flatDayListHash(['1']), dayCount: '1' }, 100, 51);
    seed('0xold', 'RewardBudgetReceived', { dayIds: ['1'], remitId: '1', sourceChainId: S }, 100, 52);
    seed('0xnew', 'IngressPacketRecorded', { packetHash: NEW, kind: 1, remitId: '2', sourceChainId: S }, 200, 500);
    seed('0xnew', 'IngressPacketDayListRecorded', { packetHash: NEW, dayListHash: flatDayListHash(['2']), dayCount: '1' }, 200, 501);
    seed('0xnew', 'RewardBudgetReceived', { dayIds: ['2'], remitId: '2', sourceChainId: S }, 200, 502);
    const rows = await listBudgetDeliveries(h.d1 as D1Database, 421614, 400);
    expect(rows.map((r) => r.packetHash)).toEqual([NEW]);
  });

  it('computes the flat commitment exactly as the contract does: keccak256(abi.encode(uint256[]))', () => {
    const want = keccak256(encodeAbiParameters([{ type: 'uint256[]' }], [[4n, 5n]])).toLowerCase();
    expect(flatDayListHash(['4', '5'])).toBe(want);
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
    const base: PacketState = {
      kind: 1, batchId: Z, dayListHash: Z, dayListRoot: H, chunkCount: 3, chunksIndexed: 0n, disposed: 0n,
    };
    expect(packetMayNeedWork(base)).toBe(true);
    expect(packetMayNeedWork({ ...base, chunksIndexed: 0b011n })).toBe(true); // straddle: one chunk left
    expect(packetMayNeedWork({ ...base, chunksIndexed: 0b111n })).toBe(false); // every chunk landed
    expect(packetMayNeedWork({ ...base, disposed: 1n })).toBe(false);
    expect(packetMayNeedWork({ ...base, kind: 2 })).toBe(false);
    expect(packetMayNeedWork({ ...base, dayListRoot: Z, dayListHash: H })).toBe(true); // a flat list: the planner decides
    expect(packetMayNeedWork({ ...base, dayListRoot: Z })).toBe(false); // a pre-3a packet: no provable list
    // The protocol's maximum, 256 chunks: the uint256 bitmap with every bit set
    // is finished, and one bit short is not (#2497 r1 — the mask was -1n).
    const full256 = (1n << 256n) - 1n;
    expect(packetMayNeedWork({ ...base, chunkCount: 256, chunksIndexed: full256 }), 'all 256 landed').toBe(false);
    expect(packetMayNeedWork({ ...base, chunkCount: 256, chunksIndexed: full256 >> 1n }), 'chunk 255 missing').toBe(true);
  });
});

describe('deliveryComplete — the done set takes only what the chain shows finished', () => {
  const root = d6Root(d6Leaves(days(40)));
  it('rooted: done only when every chunk has landed (straddle on the last bit)', () => {
    expect(deliveryComplete({ packet: packet({ dayListRoot: root, chunkCount: 3, chunksIndexed: 0b011n }), batch: null, flatAllLanded: false })).toBe(false);
    expect(deliveryComplete({ packet: packet({ dayListRoot: root, chunkCount: 3, chunksIndexed: 0b111n }), batch: null, flatAllLanded: false })).toBe(true);
  });

  it("an epoch's flat list: done only when the batch index is whole; an unread batch is not done", () => {
    const p = packet({ dayListHash: H, batchId: BATCH });
    expect(deliveryComplete({ packet: p, batch: { dayCount: 3, indexedDays: 2 }, flatAllLanded: false })).toBe(false);
    expect(deliveryComplete({ packet: p, batch: { dayCount: 3, indexedDays: 3 }, flatAllLanded: false })).toBe(true);
    expect(deliveryComplete({ packet: p, batch: null, flatAllLanded: true }), 'batch unread').toBe(false);
  });

  it('a no-epoch flat list: done only when every day reads as landed', () => {
    const p = packet({ dayListHash: H });
    expect(deliveryComplete({ packet: p, batch: null, flatAllLanded: false })).toBe(false);
    expect(deliveryComplete({ packet: p, batch: null, flatAllLanded: true })).toBe(true);
  });

  it('nothing provable left is done: disposed, not a budget, no list', () => {
    expect(deliveryComplete({ packet: packet({ dayListHash: H, disposed: 1n }), batch: null, flatAllLanded: false })).toBe(true);
    expect(deliveryComplete({ packet: packet({ dayListHash: H, kind: 2 }), batch: null, flatAllLanded: false })).toBe(true);
    expect(deliveryComplete({ packet: packet(), batch: null, flatAllLanded: false })).toBe(true);
  });
});

describe('fundedDaysFromBits — the rooted list from the reservation record itself (Codex #2489 r2)', () => {
  it('takes exactly the days whose bit is set, in order, across word boundaries', () => {
    const dayIds = Array.from({ length: 300 }, (_, i) => BigInt(1000 + i));
    const bits = [(1n << 0n) | (1n << 255n), 1n << 43n]; // indexes 0, 255, 256 + 43
    expect(fundedDaysFromBits(dayIds, bits)).toEqual([1000n, 1255n, 1299n]);
  });

  it('a closed day the reservation did not fund is left out', () => {
    expect(fundedDaysFromBits([4n, 5n, 6n], [0b101n])).toEqual([4n, 6n]);
  });

  it('a reservation that predates the record reads as null (the caller falls back), never as "nothing funded"', () => {
    expect(fundedDaysFromBits([4n, 5n], [])).toBeNull();
    expect(fundedDaysFromBits([], []), 'no closed day: an empty list').toEqual([]);
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
  const row = { packetHash: H, remitId: 99, block: 1, flatDayIds: null } as never; // the ledger's id is NOT used

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
      {} as never,
      `0x${'3'.repeat(40)}`,
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
      const plan = await actionsFor({} as never, `0x${'3'.repeat(40)}`, MIRROR, row, packet({ sourceChainId: 1, remitter: OLD, remitId: 3n, dayListRoot: root, chunkCount: 1 }), () => null);
      expect(plan).toEqual({ actions: [], complete: false });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a flat packet the rollout can still admit takes the admission, never the batchless proof (#2571 r1)', () => {
  const days = [4n, 5n];
  const flat = (over: Partial<PacketState> = {}) =>
    packet({ dayListHash: H, dayCount: 2, unclassified: 10n, ...over });
  it('admits first, and is never finished while admissible', () => {
    expect(rolloutAdmissible(flat())).toBe(true);
    expect(planDelivery({ packetHash: H, packet: flat(), batch: null, flatDays: days, rootedDays: null, flatAllLanded: true })).toEqual([
      { kind: 'admitBatch', packetHash: H, dayIds: days },
    ]);
    expect(deliveryComplete({ packet: flat(), batch: null, flatAllLanded: true }), 'not retired on landed days').toBe(false);
  });
  it('follows the contract clause for clause: typed wire, nothing untyped, or a batch already — not admissible', () => {
    expect(rolloutAdmissible(flat({ freshShare: 1n }))).toBe(false);
    expect(rolloutAdmissible(flat({ recycledShare: 1n }))).toBe(false);
    expect(rolloutAdmissible(flat({ unclassified: 0n }))).toBe(false);
    expect(rolloutAdmissible(flat({ dayCount: 0 }))).toBe(false);
    expect(rolloutAdmissible(flat({ batchId: BATCH }))).toBe(false);
    // Not admissible: the batchless proof route, as before.
    expect(planDelivery({ packetHash: H, packet: flat({ unclassified: 0n }), batch: null, flatDays: days, rootedDays: null, flatAllLanded: false })).toEqual([
      { kind: 'proveList', packetHash: H, dayIds: days },
    ]);
  });
});

