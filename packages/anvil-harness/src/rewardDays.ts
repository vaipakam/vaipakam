/**
 * Closing and finalizing reward days the way they close on a live canonical
 * chain that is its own only reporter: `closeDay` (permissionless; the
 * canonical chain records its own report directly) and then `finalizeDay`
 * (permissionless; with this chain as the only expected reporter, a reported
 * day finalizes on full coverage without waiting out the grace). A two-chain
 * mesh also needs the mirror's reports relayed before Base can finalize, so
 * this helper is for a single-chain canonical fixture only.
 *
 * A reward entry's window can be priced — and so claimed, observed, settled
 * or swept — only once every day of it is finalized, which is why a scenario
 * finalizes through the day before "today" before it acts on an entry.
 */
import type { ScenarioChain } from './scenarioChain';

/** `isDayReadyToFinalize`'s reason for a day already finalized. */
const ALREADY_FINALIZED = 1;

/**
 * Close and finalize every day from 0 through `lastDay` that is not finalized
 * yet. `lastDay` must be strictly before the chain's current reward day (the
 * contract refuses to close a day still accruing).
 */
export async function finalizeThrough(sc: ScenarioChain, lastDay: number): Promise<void> {
  const today = await sc.rewardDay();
  if (lastDay >= today) throw new Error(`day ${lastDay} has not elapsed (today is day ${today})`);
  for (let d = 0; d <= lastDay; d++) {
    const [, reason] = await sc.read<readonly [boolean, number]>('isDayReadyToFinalize', [BigInt(d)]);
    if (Number(reason) === ALREADY_FINALIZED) continue;
    const sentAt = await sc.read<bigint>('getChainReportSentAt', [BigInt(d)]);
    if (sentAt === 0n) await sc.diamondWrite('other', 'closeDay', [BigInt(d)]);
    await sc.diamondWrite('other', 'finalizeDay', [BigInt(d)]);
  }
}
