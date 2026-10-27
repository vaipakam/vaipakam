// apps/keeper/src/rewardDayClose/close.ts
//
// Step 1 on every chain: CLOSE each elapsed day in the window not yet
// reported here (`getChainReportSentAt(d) == 0`), oldest first: `closeDay(d)`.
//
// On Base the close records Base's own report, fee-free. On a mirror it sends
// the day's report to Base over CCIP, paying the messenger's own quote for the
// one report shape (`quoteSendChainReport`, #2621); the messenger refunds any
// part the lane did not use. A mirror closes a day even when Base has
// finalized it: Base drops that report's DAY figures but still applies what it
// says about the CHAIN (its custody era and its cumulative recycled-
// availability and commitment ratchets).
//
// The contract holds the rules that make a close safe whoever sends it
// (#2621): `closeDay` names the Diamond's Base to the messenger, which refuses
// a report routed anywhere else, so a messenger rotated in between this run's
// reads and the close cannot carry the report elsewhere (the close reverts,
// and the day stays unsent). A rotated messenger that does reach Base is still
// one other than the one checked, so each landed close's receipt is read for
// the messenger its report left through, and one other than the one checked
// is recorded.
//
// A close refused because the interest fold has not reached the day
// (`ChainReportFrontierShort`) is preceded by `advanceInterestFrontiers`.

import type { Address } from 'viem';
import { FRONTIER_SHORT } from './constants';
import type { ChainRun } from './deps';
import { shortErr } from './errors';
import { reportFee } from './reads';
import { reportSentVia } from './plan';
import type { Sender } from './sender';
import type { DayStore, DispatchRecord } from './store';

/** Close `days` (each unreported here), oldest first. Mirror only: `mirror`
 *  carries the messenger the checks read and the chain this Diamond names as
 *  Base. Returns
 *  the days closed, and the closes whose report left through a messenger
 *  other than the one checked. */
export async function closeDays(
  c: ChainRun,
  store: DayStore,
  sender: Sender,
  days: readonly number[],
  mirror: { messenger: Address; baseChainId: number } | null,
): Promise<{ closed: number[]; dispatched: Map<number, DispatchRecord> }> {
  const closed: number[] = [];
  const dispatched = new Map<number, DispatchRecord>();
  for (const d of days) {
    if (sender.stopped) break;
    let fee = 0n;
    if (mirror !== null) {
      // eslint-disable-next-line no-await-in-loop
      const q = await reportFee(c.deps.client, mirror.messenger, mirror.baseChainId, d);
      if (q === 'unread') {
        console.error(`[keeper] rewardDayClose ${c.where}: report fee for day ${d} unread, the RPC did not answer; left for the next run`);
        sender.noteUnread(`close:${d}`, 'the report fee');
        continue;
      }
      if ('refused' in q) {
        sender.refused.set(`close:${d}`, q.refused);
        continue;
      }
      fee = q.fee;
    }
    // eslint-disable-next-line no-await-in-loop
    let r = await sender.call('close', d, 'closeDay', [BigInt(d)], fee);
    if (r === FRONTIER_SHORT) {
      // eslint-disable-next-line no-await-in-loop
      const a = await sender.call('advance', d, 'advanceInterestFrontiers', [BigInt(d)], 0n);
      // eslint-disable-next-line no-await-in-loop
      if (a === 'landed') r = await sender.call('close', d, 'closeDay', [BigInt(d)], fee);
    }
    if (r !== 'landed') continue;
    closed.push(d);
    const via = mirror === null ? null : reportSentVia(sender.receipt, mirror.messenger);
    if (via === null) continue;
    // Kept, so the alert is said until Base records the day's outcome,
    // however its first delivery went.
    const rec: DispatchRecord = { checked: mirror!.messenger, via };
    dispatched.set(d, rec);
    try {
      // eslint-disable-next-line no-await-in-loop
      await store.saveDispatch(d, rec);
    } catch (err) {
      console.error(`[keeper] rewardDayClose ${c.where}: the unchecked dispatch of day ${d} not recorded, said this run only: ${shortErr(err)}`);
    }
  }
  return { closed, dispatched };
}
