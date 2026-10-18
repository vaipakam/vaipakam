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
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import {
  actionsFor,
  canonicalChainOf,
  dayOrderReader,
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
import { hintsForDays } from '../src/transportHints';
import { isRunDeadlinePassed } from '../src/runDeadline';
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

describe('the hint walk reads through one deadline-bound reader (#2497 r20)', () => {
  afterEach(() => vi.useRealTimers());

  /** A client whose day views answer from a hand-built day: a cursor, a
   *  list page that chains to a second, and an empty late chain. Every
   *  read is counted. */
  function fakeClient(calls: string[], clock?: { advanceTo: number; on: number }) {
    const node = (i: number) => `0x${i.toString(16).padStart(64, '0')}` as Hex;
    return {
      readContract: async ({ functionName }: { functionName: string }) => {
        calls.push(functionName);
        if (clock && calls.length === clock.on) vi.setSystemTime(clock.advanceTo);
        switch (functionName) {
          case 'getTransportDayIndex':
            return [1n, node(1)];
          case 'getTransportDayBatchesFrom':
            return [[node(1)], [5n], node(2)];
          case 'getTransportDayLateFrom':
            return [[], [], Z];
          default:
            throw new Error(`unexpected read ${functionName}`);
        }
      },
    } as never;
  }

  it('a reader past the deadline refuses every view unissued', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const calls: string[] = [];
    const reader = dayOrderReader(fakeClient(calls), `0x${'d'.repeat(40)}`, 10_000);
    const err = await reader.cursor(1n).then(() => null, (e: unknown) => e);
    expect(isRunDeadlinePassed(err)).toBe(true);
    await expect(reader.listFrom(1n, Z, 100)).rejects.toSatisfy(isRunDeadlinePassed);
    await expect(reader.lateFrom(1n, Z, 100)).rejects.toSatisfy(isRunDeadlinePassed);
    expect(calls, 'nothing reached the RPC').toEqual([]);
  });

  it('a walk still paging when the deadline passes stops at its next read, as the deadline refusal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const calls: string[] = [];
    // The second read (the first list page) moves the clock past the
    // deadline: the walk may finish that page, and the next read refuses.
    const reader = dayOrderReader(fakeClient(calls, { advanceTo: 10_000, on: 2 }), `0x${'d'.repeat(40)}`, 10_000);
    const err = await hintsForDays(reader, [1n, 2n], 0, 2, BATCH, 7n).then(() => null, (e: unknown) => e);
    expect(isRunDeadlinePassed(err), String(err)).toBe(true);
    expect(calls.length, 'the reads issued before the deadline, and none after').toBe(2);
  });

  it('a reader inside its deadline answers the views as the chain shapes them', async () => {
    const calls: string[] = [];
    const reader = dayOrderReader(fakeClient(calls), `0x${'d'.repeat(40)}`, Number.MAX_SAFE_INTEGER);
    expect(await reader.cursor(1n)).toBe(`0x${'1'.padStart(64, '0')}`);
    const page = await reader.listFrom(1n, Z, 100);
    expect(page.arrivedAt).toEqual([5n]);
    expect(page.next).toBe(`0x${'2'.padStart(64, '0')}`);
    expect(calls).toEqual(['getTransportDayIndex', 'getTransportDayBatchesFrom']);
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
