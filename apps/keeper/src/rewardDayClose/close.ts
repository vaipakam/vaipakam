// apps/keeper/src/rewardDayClose/close.ts
//
// Step 1 on every chain: CLOSE each elapsed day in the window not yet
// reported here (`getChainReportSentAt(d) == 0`), oldest first: `closeDay(d)`.
//
// On Base the close records Base's own report, fee-free. On a mirror it sends
// the day's report to Base over CCIP, paying the messenger's own quote for the
// report shape the Diamond sends (`quoteSendChainReport`); the messenger
// refunds any part the lane did not use. A mirror closes a day even when Base
// has finalized it: Base drops that report's DAY figures but still applies
// what it says about the CHAIN (its custody era and its cumulative
// recycled-availability and commitment ratchets). Only the B4 report carries
// that late path: an older shape reaching a finalized day is refused on Base
// after its fee is paid, so a mirror whose messenger cannot quote the B4
// report sends none for a day Base has finalized or can finalize now, nor for
// one whose finalization it cannot read.
//
// The checks are reads before the transaction, which sends through whatever
// messenger the Diamond then holds: a rotation in between cannot be prevented
// here, so each landed close's receipt is read for the messenger its report
// left through, and one other than the one checked is recorded (#2621 tracks
// the contract-side guard).
//
// A close refused because the interest fold has not reached the day
// (`ChainReportFrontierShort`) is preceded by `advanceInterestFrontiers`.

import type { Address } from 'viem';
import { FRONTIER_SHORT } from './constants';
import type { ChainRun } from './deps';
import { shortErr } from './errors';
import type { BaseDay } from './reads';
import { reportFee } from './reads';
import { reportSentVia } from './plan';
import type { Sender } from './sender';
import type { DayStore, DispatchRecord } from './store';

/** What a mirror knows of Base for its closes: each window day's state there,
 *  or that this keeper does not serve Base. */
export type BaseDays = Map<number, BaseDay> | 'unserved';

const PRE_B4_FINALIZED =
  "Base has finalized this day or can finalize it now, and this chain's messenger cannot quote the B4 report, the only shape whose chain-wide figures Base applies after finalization; an older report landing after finalization is refused on Base after its fee is paid, so it is not sent";
const PRE_B4_UNSERVED =
  "this keeper does not serve Base, so whether Base has finalized this day cannot be read, and this chain's messenger cannot quote the B4 report, the only shape safe to send for a finalized day; an older report would be refused on Base after its fee is paid if the day is finalized, so it is not sent";

/** Close `days` (each unreported here), oldest first. Mirror only: `mirror`
 *  carries the messenger the checks read and Base's state per day. Returns
 *  the days closed, and the closes whose report left through a messenger
 *  other than the one checked. */
export async function closeDays(
  c: ChainRun,
  store: DayStore,
  sender: Sender,
  days: readonly number[],
  mirror: { messenger: Address; baseDays: BaseDays } | null,
): Promise<{ closed: number[]; dispatched: Map<number, DispatchRecord> }> {
  const closed: number[] = [];
  const dispatched = new Map<number, DispatchRecord>();
  for (const d of days) {
    if (sender.stopped) break;
    let fee = 0n;
    if (mirror !== null) {
      // eslint-disable-next-line no-await-in-loop
      const q = await reportFee(c.deps.client, mirror.messenger, d);
      if (q === 'unread') {
        console.error(`[keeper] rewardDayClose ${c.where}: report fee for day ${d} unread, the RPC did not answer; left for the next run`);
        continue;
      }
      if (q === 'refused') {
        sender.refused.set(`close:${d}`, 'the messenger would not quote the report fee');
        continue;
      }
      if (!q.b4) {
        const onBase = mirror.baseDays === 'unserved' ? null : mirror.baseDays.get(d);
        if (onBase === null) {
          sender.refused.set(`close:${d}`, PRE_B4_UNSERVED);
          continue;
        }
        // A day Base can finalize now is as unsafe for an older report as one
        // it has finalized: anyone may finalize it before the report lands.
        if (onBase?.finalized.known && onBase.ready.known && (onBase.finalized.value || onBase.ready.value)) {
          sender.refused.set(`close:${d}`, PRE_B4_FINALIZED);
          continue;
        }
        // Fail closed: an older shape is safe only for a day Base is known
        // not to have finalized. A failed read is retried next run.
        if (!onBase?.finalized.known || !onBase.ready.known) {
          console.error(`[keeper] rewardDayClose ${c.where}: day ${d} not closed: whether Base has finalized it is unread, and this chain's messenger cannot quote the B4 report; left for the next run`);
          continue;
        }
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
