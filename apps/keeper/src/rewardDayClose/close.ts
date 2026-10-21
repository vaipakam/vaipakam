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
// after its fee is paid, so a mirror that sends an older shape sends none for
// a day Base has finalized or can finalize now, nor for one whose
// finalization it cannot read. Which shape goes out takes two reads: the
// messenger must quote B4, and the Diamond's reporter must send it (a B4
// messenger also takes the older shapes an older reporter sends).
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
import { diamondSendsB4, reportFee } from './reads';
import { known, type Fact } from './fact';
import { reportSentVia } from './plan';
import type { Sender } from './sender';
import type { DayStore, DispatchRecord } from './store';

/** What a mirror knows of Base for its closes: each window day's state there,
 *  or that this keeper does not serve Base. */
export type BaseDays = Map<number, BaseDay> | 'unserved';

const PRE_B4_FINALIZED =
  "Base has finalized this day or can finalize it now, and this chain sends an older report than B4, the only shape whose chain-wide figures Base applies after finalization; an older report landing after finalization is refused on Base after its fee is paid, so it is not sent";
const PRE_B4_UNSERVED =
  "this keeper does not serve Base, so whether Base has finalized this day cannot be read, and this chain sends an older report than B4, the only shape safe to send for a finalized day; an older report would be refused on Base after its fee is paid if the day is finalized, so it is not sent";
const MESSENGER_PRE_B4 = "its messenger cannot quote the B4 report";
const DIAMOND_PRE_B4 = "its Diamond's reporter facet predates the B4 send: closeDay is not routed to the facet that hosts getInterestFrontiers";

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
  let diamondB4: Fact<boolean> | null = null;
  for (const d of days) {
    if (sender.stopped) break;
    let fee = 0n;
    if (mirror !== null) {
      // eslint-disable-next-line no-await-in-loop
      const q = await reportFee(c.deps.client, mirror.messenger, d);
      if (q === 'unread') {
        console.error(`[keeper] rewardDayClose ${c.where}: report fee for day ${d} unread, the RPC did not answer; left for the next run`);
        sender.noteUnread(`close:${d}`, 'the report fee');
        continue;
      }
      if (q === 'refused') {
        sender.refused.set(`close:${d}`, 'the messenger would not quote the report fee');
        continue;
      }
      // The B4 report goes out only when the messenger takes it AND the
      // Diamond's reporter sends it; read once, on the first day that needs it.
      // eslint-disable-next-line no-await-in-loop
      if (q.b4 && diamondB4 === null) diamondB4 = await diamondSendsB4(c);
      const b4: Fact<boolean> = q.b4 ? diamondB4! : known(false);
      if (!b4.known || !b4.value) {
        const why = !q.b4 ? MESSENGER_PRE_B4 : DIAMOND_PRE_B4;
        const onBase = mirror.baseDays === 'unserved' ? null : mirror.baseDays.get(d);
        // Fail closed: an older shape is safe only for a day Base is known
        // not to have finalized and not to be able to finalize now (anyone
        // may finalize it before the report lands). A failed read is retried
        // next run.
        const safe = onBase?.finalized.known && onBase.ready.known && !onBase.finalized.value && !onBase.ready.value;
        if (!safe && !b4.known) {
          console.error(`[keeper] rewardDayClose ${c.where}: day ${d} not closed: whether this Diamond sends the B4 report is unread, and the day may be finalized on Base first; left for the next run`);
          sender.noteUnread(`close:${d}`, `whether this Diamond sends the B4 report: ${b4.why}`);
          continue;
        }
        if (onBase === null) {
          sender.refused.set(`close:${d}`, `${PRE_B4_UNSERVED} (${why})`);
          continue;
        }
        if (onBase?.finalized.known && onBase.ready.known && (onBase.finalized.value || onBase.ready.value)) {
          sender.refused.set(`close:${d}`, `${PRE_B4_FINALIZED} (${why})`);
          continue;
        }
        if (!safe) {
          console.error(`[keeper] rewardDayClose ${c.where}: day ${d} not closed: whether Base has finalized it is unread, and this chain sends an older report than B4; left for the next run`);
          sender.noteUnread(`close:${d}`, "whether Base has finalized the day (needed for this chain's older report shape)");
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
