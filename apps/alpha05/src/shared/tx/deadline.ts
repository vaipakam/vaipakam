/**
 * #3412 — the deadline every price-exposed transaction carries, read from
 * the chain's clock. The rule (thirty minutes from the latest block) is the
 * shared one in `@vaipakam/lib/txDeadline`; this module only reads the
 * chain's time for it, so a post, a listing or a request never carries a
 * deadline measured on the device clock (which can be minutes off, and a
 * local test chain's clock moves on its own).
 *
 * The deadline is read right before the call's arguments are built: the
 * dry run reads its own, and the write reads one again, so a review left
 * open never sends a deadline that has already run down.
 */
import type { PublicClient } from 'viem';
import { admittedWindow, txValidUntil, type DeadlineWallet, type TxStep } from '@vaipakam/lib/txDeadline';
import type { OwnStateClient } from '../../chain/ownRail';

export { TX_DEADLINE_SECONDS, txValidUntil } from '@vaipakam/lib/txDeadline';
export type { TxStep } from '@vaipakam/lib/txDeadline';

/** A contract wallet's chosen approval window (#3770). Absent: a key
 *  wallet, or no choice, which is the step's thirty minutes. */
export interface WindowChoice {
  wallet: DeadlineWallet;
  window: number | null;
}

/** The window `step` carries for this choice: the one rule
 *  (`admittedWindow`), so a short step is never lengthened. */
export function stepWindow(step: TxStep, choice?: WindowChoice): number {
  return admittedWindow(step, choice?.wallet ?? { kind: 'key' }, choice?.window ?? null);
}

/** The `validUntil` for `step` built now, from this client's latest block.
 *  Every step names itself, so its class (`TX_STEPS`) decides the window. */
export async function chainValidUntil(c: PublicClient, step: TxStep, choice?: WindowChoice): Promise<bigint> {
  const block = await c.getBlock({ blockTag: 'latest' });
  return txValidUntil(block.timestamp, stepWindow(step, choice));
}

/** The same, read through the own rail. */
export async function readValidUntil(own: Pick<OwnStateClient, 'read'>, step: TxStep, choice?: WindowChoice): Promise<bigint> {
  return (await own.read((c) => chainValidUntil(c, step, choice))).value;
}
