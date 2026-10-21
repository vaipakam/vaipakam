// apps/keeper/src/rewardDayClose/notices.ts
//
// The pass's one NOTICE (a thing that happened, not a condition): a day Base
// finalized with expected chains missing, naming each. One rule whoever
// finalized the day (this keeper, another caller, an admin): the chains are
// read from Base's own record of who reported it, at a block where the day is
// finalized, journaled and recorded at once, and posted until delivered.

import { boundedRead, PastRunDeadline } from '../batchRead';
import type { Env } from '../env';
import { sendOpsNoticeDigest } from '../opsAlert';
import { ABI, REASON_FINALIZED } from './constants';
import type { ChainRun } from './deps';
import { shortErr } from './errors';
import type { DayStore } from './store';

const ZEROED_FOOTER =
  "Finalization is final: a missing chain's report for these days has its day figures dropped when it lands (its chain-wide figures still apply). Read from Base's record of which chains reported each day, against Base's expected-source list as it stood when this keeper first saw the day finalized.";

function zeroedLine(day: number, missing: readonly number[]): string {
  return `reward day ${day}: finalized without chain(s) ${missing.join(', ')}; their interest counts as zero for the day`;
}

/**
 * Record, once per finalized day, the expected chains it was finalized
 * without. Base keeps no report for a chain that was not counted (a report
 * landing after finalization drops its day figures and is not recorded as the
 * day's), so the day's own record is the source, read in one aggregate (one
 * block) together with the day's finalization, so a lagging node cannot
 * record a report that landed just before finalization as missing. A day
 * whose record cannot be fully read is left for the next run; an empty list
 * still gets a record (naming no chain), since a finalized day is worked
 * through only once its record exists.
 */
export async function recordZeroed(c: ChainRun, store: DayStore, finalizedDays: readonly number[], expected: readonly number[]): Promise<void> {
  if (finalizedDays.length === 0) return;
  try {
    const have = await store.zeroed(finalizedDays);
    for (const d of finalizedDays.filter((x) => !have.has(x))) {
      // eslint-disable-next-line no-await-in-loop
      const res = await boundedRead(
        c.deps.readClient as never,
        [
          { address: c.diamond, abi: ABI, functionName: 'isDayReadyToFinalize', args: [BigInt(d)] },
          ...expected.map((x) => ({ address: c.diamond, abi: ABI, functionName: 'isChainReported', args: [BigInt(d), x] })),
        ],
        `rewardDayClose ${c.where} zeroed(${d})`,
        c.deps.sendDeadline,
      );
      if (res.some((r) => r?.status !== 'success')) continue;
      if (Number((res[0].result as readonly [boolean, number])[1]) !== REASON_FINALIZED) continue;
      const missing = expected.filter((_, i) => res[i + 1].result !== true);
      if (missing.length > 0) console.log(`[keeper] rewardDayClose ${c.where} notice: ${zeroedLine(d, missing)}`);
      // eslint-disable-next-line no-await-in-loop
      await store.saveZeroed(d, { missing, posted: missing.length === 0 });
    }
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${c.where}: zeroed-day records left for the next run: ${shortErr(err)}`);
  }
}

/** Post the window's zeroed-day notices not yet delivered, and return the
 *  window days whose record exists and is delivered (one naming no chain
 *  counts as delivered). A record is marked posted once delivered (or once
 *  the ops channel is not configured: the journal line written with the
 *  record is then the record) and kept, so the day is never noticed twice. */
export async function postZeroedNotices(env: Env, store: DayStore, window: readonly number[], deadline: number): Promise<Set<number>> {
  const noticed = new Set<number>();
  try {
    const all = await store.zeroed(window);
    for (const [d, r] of all) if (r.posted || r.missing.length === 0) noticed.add(d);
    const due = [...all].filter(([, r]) => !r.posted && r.missing.length > 0).sort(([a], [b]) => a - b);
    if (due.length === 0 || Date.now() >= deadline) return noticed;
    const outcome = await sendOpsNoticeDigest(
      env,
      `[chain ${store.chainId}] reward day close: finalized with expected reports missing`,
      due.map(([d, r]) => zeroedLine(d, r.missing)),
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
