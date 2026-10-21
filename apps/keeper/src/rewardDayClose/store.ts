// apps/keeper/src/rewardDayClose/store.ts
//
// Everything the pass keeps between runs, per (chain, Diamond, reward role),
// in the keeper's private open-work queue (`keeper_work_open`) and its cursor
// table (`keeper_work_cursor`). One class, so no other module knows a row's
// kind or shape.
//
// The role is part of the namespace (the tables' `diamond` column holds
// `<diamond>:<role>`) because the work is the role's: a Diamond moved between
// canonical and mirror in place owes different things on the same day
// numbers, so its new role's work starts afresh, as a fresh Diamond's does,
// and the old role's open alerts are closed with a notice (alerts.ts). The
// kinds:
//
//   - `day_close` (cursor): the first day not yet entered into the ledger;
//     only moves forward. Losing it costs one run re-entering days from day 0.
//   - `day_owed`: the ledger of owed days, one row per day. Every elapsed day
//     enters it before the cursor passes it, and leaves only once a run sees
//     it worked through.
//   - `day_broadcast`: per finalized day, every destination it has had while
//     worked, each with the last send that covered it. Losing it costs at most
//     one extra broadcast.
//   - `day_zeroed`: per finalized day, the expected chains Base finalized it
//     without, and whether that notice was delivered.
//   - `day_open`: per open day on Base, the block from which it was last seen
//     open, so the finalization's own events can be read from there.
//   - `day_dispatch`: per mirror close whose report left through a messenger
//     other than the one checked, so it is said until Base records the day.
//   - `day_clock`: per PEER chain, the Diamond its reward clock was last read
//     from and that clock (null = that Diamond's clock not yet read).
//
// The per-day records live while their day is owed or in the lookback.

import type { Address } from 'viem';
import type { Env } from '../env';
import {
  enqueueWork,
  finishWork,
  getWorkCursor,
  getWorkItems,
  listOpenWorkBelow,
  openWorkAmong,
  pruneWorkBelowUnlessOpen,
  putWork,
  putWorkCursor,
  touchOpenWork,
  type WorkItem,
  type WorkKind,
} from '../db';
import { BACKLOG_PER_RUN, LOOKBACK_DAYS } from './constants';
import type { SendMark } from './plan';
import { dayWindow } from './plan';

/** A finalized day's broadcast record: every destination the day has had
 *  while worked, with the last send that covered it (null = none yet). */
export interface BroadcastRecord {
  sentTo: Record<string, SendMark | null>;
  /** Chains the contract says have no standing in the day, so are not owed it. */
  noStanding?: number[];
}

/** A finalized day's zeroed record: the expected chains Base holds no report
 *  from, and whether the notice naming them was delivered. */
export interface ZeroedRecord {
  missing: number[];
  posted: boolean;
  /** Where `missing` came from: the finalization's own events, or (when this
   *  keeper never saw the day open, or those events could not be found) the
   *  expected-source list as read when the day was first seen finalized. */
  basis?: 'events' | 'list';
}

/** A mirror close whose receipt showed its report leaving through a messenger
 *  other than the one checked. */
export interface DispatchRecord {
  checked: Address;
  via: Address[];
}

/** A peer chain's last known Diamond and its reward-clock launch there. */
export interface ClockRecord {
  diamond: string;
  launch: number | null;
}

/** The two roles a Diamond's day work is done in. */
export type RewardRoleName = 'canonical' | 'mirror';

const PER_DAY_RECORDS: readonly WorkKind[] = ['day_broadcast', 'day_zeroed', 'day_dispatch', 'day_open'];

export class DayStore {
  private readonly db: Env['KEEPER_DB'];

  /** The namespace of every row: `<diamond>:<role>`, lowercased. */
  private readonly scope: string;

  constructor(
    env: Env,
    readonly chainId: number,
    readonly diamond: Address,
    readonly role: RewardRoleName,
  ) {
    this.db = env.KEEPER_DB;
    this.scope = `${diamond.toLowerCase()}:${role}`;
  }

  // ── The ledger of owed days ──

  /**
   * Enter every elapsed day not yet entered, then return the run's window:
   * the last {@link LOOKBACK_DAYS} days and a page of the older owed ones, the
   * page touched before any work so a day that fails every run still yields
   * its turn.
   */
  async openWindow(today: number): Promise<number[]> {
    const from = await getWorkCursor(this.db, this.chainId, this.scope, 'day_close');
    const fresh: WorkItem<Record<string, never>>[] = [];
    for (let d = from; d < today; d++) fresh.push({ item: String(d), block: d, payload: {} });
    for (let i = 0; i < fresh.length; i += 100) {
      // eslint-disable-next-line no-await-in-loop
      await enqueueWork(this.db, this.chainId, this.scope, 'day_owed', fresh.slice(i, i + 100));
    }
    await putWorkCursor(this.db, this.chainId, this.scope, 'day_close', today);
    const page = await listOpenWorkBelow(this.db, this.chainId, this.scope, 'day_owed', Math.max(0, today - LOOKBACK_DAYS), BACKLOG_PER_RUN);
    await touchOpenWork(this.db, this.chainId, this.scope, 'day_owed', page.map((w) => w.item));
    return dayWindow(today, page.map((w) => w.block));
  }

  /** Of `days`, those the ledger still holds owed. */
  async owedAmong(days: readonly number[]): Promise<Set<number>> {
    const s = await openWorkAmong(this.db, this.chainId, this.scope, 'day_owed', days.map(String));
    return new Set([...s].map(Number));
  }

  /** Record what the run saw: a window day worked through leaves the ledger,
   *  any other stays in it (or re-enters it). A day's records stay while it
   *  is owed or in the lookback. */
  async settle(today: number, window: readonly number[], through: (d: number) => boolean): Promise<void> {
    await finishWork(this.db, this.chainId, this.scope, 'day_owed', window.filter(through).map(String));
    const open = window.filter((d) => !through(d)).map((d) => ({ item: String(d), block: d, payload: {} }));
    if (open.length > 0) await enqueueWork(this.db, this.chainId, this.scope, 'day_owed', open);
    const floor = Math.max(0, today - LOOKBACK_DAYS);
    for (const kind of PER_DAY_RECORDS) {
      // eslint-disable-next-line no-await-in-loop
      await pruneWorkBelowUnlessOpen(this.db, this.chainId, this.scope, kind, floor, 'day_owed');
    }
  }

  // ── Per-day records ──

  private async byDay<T>(kind: WorkKind, days: readonly number[]): Promise<Map<number, T>> {
    const rows = await getWorkItems<T>(this.db, this.chainId, this.scope, kind, days.map(String));
    return new Map([...rows].map(([item, r]) => [Number(item), r.payload]));
  }

  private put<T>(kind: WorkKind, day: number, payload: T): Promise<void> {
    return putWork(this.db, this.chainId, this.scope, kind, { item: String(day), block: day, payload });
  }

  broadcasts(days: readonly number[]): Promise<Map<number, BroadcastRecord>> {
    return this.byDay('day_broadcast', days);
  }

  saveBroadcast(day: number, sentTo: ReadonlyMap<number, SendMark | null>, noStanding: ReadonlySet<number> = new Set()): Promise<void> {
    return this.put<BroadcastRecord>('day_broadcast', day, {
      sentTo: Object.fromEntries([...sentTo].sort(([a], [b]) => a - b).map(([c, t]) => [String(c), t])),
      ...(noStanding.size > 0 ? { noStanding: [...noStanding].sort((a, b) => a - b) } : {}),
    });
  }

  zeroed(days: readonly number[]): Promise<Map<number, ZeroedRecord>> {
    return this.byDay('day_zeroed', days);
  }

  saveZeroed(day: number, r: ZeroedRecord): Promise<void> {
    return this.put('day_zeroed', day, r);
  }

  /** Per day, the block from which it was last seen open (as a decimal string). */
  openSeen(days: readonly number[]): Promise<Map<number, string>> {
    return this.byDay('day_open', days);
  }

  saveOpenSeen(day: number, block: bigint): Promise<void> {
    return this.put('day_open', day, block.toString());
  }

  dispatches(days: readonly number[]): Promise<Map<number, DispatchRecord>> {
    return this.byDay('day_dispatch', days);
  }

  saveDispatch(day: number, r: DispatchRecord): Promise<void> {
    return this.put('day_dispatch', day, r);
  }

  // ── Peer clocks ──

  async clock(peerChain: number): Promise<ClockRecord | null> {
    const rows = await getWorkItems<ClockRecord>(this.db, this.chainId, this.scope, 'day_clock', [String(peerChain)]);
    return rows.get(String(peerChain))?.payload ?? null;
  }

  saveClock(peerChain: number, r: ClockRecord): Promise<void> {
    return putWork(this.db, this.chainId, this.scope, 'day_clock', { item: String(peerChain), block: 0, payload: r });
  }
}
