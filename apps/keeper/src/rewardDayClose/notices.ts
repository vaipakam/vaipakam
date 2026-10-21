// apps/keeper/src/rewardDayClose/notices.ts
//
// The pass's one NOTICE (a thing that happened, not a condition): a day Base
// finalized with expected chains missing, naming each. One rule whoever
// finalized the day (this keeper, another caller, an admin): the chains are
// read from the finalization's own events where the keeper saw the day open,
// otherwise judged from Base's record of who reported it and marked so;
// journaled and recorded at once, and posted until delivered. A day kept
// from its record or its notice by a read that failed is said (`note`), like
// every other step a failed read holds, never left owed in silence.

import { boundedRead, PastRunDeadline } from '../batchRead';
import type { Env } from '../env';
import { sendOpsNoticeDigest } from '../opsAlert';
import { ABI, REASON_FINALIZED } from './constants';
import type { ChainRun } from './deps';
import { shortErr } from './errors';
import type { Fact } from './fact';
import type { DayStore, ZeroedRecord } from './store';
import type { AbiEvent } from 'viem';

/** Record that `what` could not be read, keeping `step:day` from being worked
 *  this run (the sender's `noteUnread`). */
export type Note = (key: string, what: string) => void;

const ZEROED_FOOTER =
  "Finalization is final: a missing chain's report for these days has its day figures dropped when it lands (its chain-wide figures still apply). Each day's chains are read from the finalization's own ChainContributionZeroed events where this keeper saw the day open before it was finalized; a day marked otherwise was judged against Base's expected-source list as read when this keeper first saw the day finalized, which may not be the list it was finalized against.";

function zeroedLine(day: number, r: ZeroedRecord): string {
  const basis = r.basis === 'list' ? " (judged against the expected-source list as read when first seen finalized: this keeper did not see the finalization's own record)" : '';
  return `reward day ${day}: finalized without chain(s) ${r.missing.join(', ')}; their interest counts as zero for the day${basis}`;
}

/** Blocks per log query, and the most a day's search may span. */
const LOG_CHUNK = 10_000n;
const MAX_LOG_RANGE = 200_000n;

const eventOf = (name: string) => ABI.find((x) => x.type === 'event' && x.name === name) as AbiEvent;
const FINALIZED_EVENT = eventOf('DailyGlobalInterestFinalized');
const ZEROED_EVENT = eventOf('ChainContributionZeroed');

/**
 * The chains day `d`'s finalization zeroed, from its own events, searched
 * from `from` (a block at which the day was seen open, so the finalization
 * is after it). 'absent' when the day's finalization event is not found
 * exactly once in that span (a node behind the read that showed it
 * finalized, a span too long to search, or logs no longer served); 'unread'
 * when a query failed.
 */
async function zeroedByEvents(c: ChainRun, d: number, from: bigint): Promise<number[] | 'absent' | 'unread'> {
  try {
    const to = await c.deps.client.getBlockNumber();
    if (to < from || to - from > MAX_LOG_RANGE) return 'absent';
    let finalized = 0;
    const zeroed: number[] = [];
    for (let lo = from; lo <= to; lo += LOG_CHUNK) {
      const hi = lo + LOG_CHUNK - 1n < to ? lo + LOG_CHUNK - 1n : to;
      const q = { address: c.diamond, args: { dayId: BigInt(d) }, fromBlock: lo, toBlock: hi } as const;
      // eslint-disable-next-line no-await-in-loop
      const [f, z] = await Promise.all([c.deps.client.getLogs({ ...q, event: FINALIZED_EVENT } as never), c.deps.client.getLogs({ ...q, event: ZEROED_EVENT } as never)]);
      finalized += (f as unknown[]).length;
      for (const l of z as unknown as { args: { sourceChainId?: number | bigint } }[]) if (l.args.sourceChainId !== undefined) zeroed.push(Number(l.args.sourceChainId));
    }
    return finalized === 1 ? [...new Set(zeroed)].sort((a, b) => a - b) : 'absent';
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${c.where}: the finalization events of day ${d} unread: ${shortErr(err)}`);
    return 'unread';
  }
}

/**
 * Record, once per finalized day, the expected chains it was finalized
 * without. The source is the finalization's own ChainContributionZeroed
 * events, searched from the block at which this keeper last saw the day open
 * (`openSeen`), so a change to the expected-source list after finalization
 * cannot change what is said. While that record cannot be read, no day is
 * recorded (each is `note`d), since a day seen open would otherwise be taken
 * for one never seen. A day this keeper never saw open, or whose
 * events cannot be found, is judged instead from Base's record of who
 * reported it against the list as read now, in one aggregate (one block)
 * together with the day's finalization and the list itself (a list that
 * changed since the run read it leaves the day for the next run), and the
 * record says so. A day whose
 * source cannot be read is left for the next run, and `note`d as such; an
 * empty list still gets a record (naming no chain), since a finalized day is
 * worked through only once its record exists.
 */
export async function recordZeroed(c: ChainRun, store: DayStore, finalizedDays: readonly number[], expected: readonly number[], openSeen: Fact<ReadonlyMap<number, bigint>>, note: Note): Promise<void> {
  if (finalizedDays.length === 0) return;
  let pending: readonly number[] = finalizedDays;
  try {
    const have = await store.zeroed(finalizedDays);
    pending = finalizedDays.filter((x) => !have.has(x));
    for (const d of pending) {
      if (!openSeen.known) {
        note(`notice:${d}`, `the block this keeper last saw the day open from (its database: ${openSeen.why})`);
        continue;
      }
      const from = openSeen.value.get(d);
      // eslint-disable-next-line no-await-in-loop
      const ev = from === undefined ? 'absent' : await zeroedByEvents(c, d, from);
      if (ev === 'unread') {
        note(`notice:${d}`, "the finalization's own events (the log query failed)");
        continue;
      }
      let r: ZeroedRecord;
      if (ev !== 'absent') r = { missing: ev, posted: ev.length === 0, basis: 'events' };
      else {
        // eslint-disable-next-line no-await-in-loop
        const res = await boundedRead(
          c.deps.readClient as never,
          [
            { address: c.diamond, abi: ABI, functionName: 'isDayReadyToFinalize', args: [BigInt(d)] },
            { address: c.diamond, abi: ABI, functionName: 'getExpectedSourceChainIds', args: [] },
            ...expected.map((x) => ({ address: c.diamond, abi: ABI, functionName: 'isChainReported', args: [BigInt(d), x] })),
          ],
          `rewardDayClose ${c.where} zeroed(${d})`,
          c.deps.sendDeadline,
        );
        if (res.some((x) => x?.status !== 'success')) {
          note(`notice:${d}`, "Base's record of who reported the day, to judge it against the expected-source list");
          continue;
        }
        if (Number((res[0].result as readonly [boolean, number])[1]) !== REASON_FINALIZED) {
          note(`notice:${d}`, 'the day as finalized in one read with who reported it (the node answering read it as not finalized yet)');
          continue;
        }
        // The list judged against is the one in this same read: one that
        // changed since the run first read it would judge the day against
        // a list Base no longer holds, and the record is kept for good.
        const listNow = (res[1].result as readonly (number | bigint)[]).map(Number);
        if (listNow.length !== expected.length || listNow.some((x) => !expected.includes(x))) {
          note(`notice:${d}`, "the day against Base's expected-source list in one read (the list changed during this run)");
          continue;
        }
        const missing = expected.filter((_, i) => res[i + 2].result !== true);
        r = { missing, posted: missing.length === 0, basis: 'list' };
      }
      if (r.missing.length > 0) console.log(`[keeper] rewardDayClose ${c.where} notice: ${zeroedLine(d, r)}`);
      // eslint-disable-next-line no-await-in-loop
      await store.saveZeroed(d, r);
    }
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${c.where}: zeroed-day records left for the next run: ${shortErr(err)}`);
    for (const d of pending) note(`notice:${d}`, "this keeper's own record of the day's notice (its database)");
  }
}

/** Post the window's zeroed-day notices not yet delivered, and return the
 *  window days whose record exists and is delivered (one naming no chain
 *  counts as delivered). A record is marked posted once delivered (or once
 *  the ops channel is not configured: the journal line written with the
 *  record is then the record) and kept, so the day is never noticed twice. */
export async function postZeroedNotices(env: Env, store: DayStore, window: readonly number[], deadline: number, note: Note): Promise<Set<number>> {
  const noticed = new Set<number>();
  let all: Map<number, ZeroedRecord>;
  try {
    all = await store.zeroed(window);
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${store.chainId}: zeroed-day notices unread, left queued: ${shortErr(err)}`);
    for (const d of window) note(`notice:${d}`, "this keeper's own record of the day's notice (its database)");
    return noticed;
  }
  try {
    for (const [d, r] of all) if (r.posted || r.missing.length === 0) noticed.add(d);
    const due = [...all].filter(([, r]) => !r.posted && r.missing.length > 0).sort(([a], [b]) => a - b);
    if (due.length === 0 || Date.now() >= deadline) return noticed;
    const outcome = await sendOpsNoticeDigest(
      env,
      `[chain ${store.chainId}] reward day close: finalized with expected reports missing`,
      due.map(([d, r]) => zeroedLine(d, r)),
      ZEROED_FOOTER,
      store.chainId,
    );
    if (outcome !== 'sent' && outcome !== 'unconfigured') return noticed;
    for (const [d, r] of due) {
      // eslint-disable-next-line no-await-in-loop
      await store.saveZeroed(d, { ...r, posted: true });
      noticed.add(d);
    }
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${store.chainId}: zeroed-day notices left queued: ${shortErr(err)}`);
  }
  return noticed;
}
