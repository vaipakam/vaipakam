/**
 * The deadline a price-exposed transaction carries — the one rule, for every
 * app that sends one (#3412).
 *
 * The protocol refuses a price-exposed action (posting or changing an offer
 * or a standing intent, accepting, a swap-to-repay, a sale listing or a
 * direct sale, an offset, an obligation handover) that lands after the
 * deadline its sender put on it (`LibTiming.requireDeadline`; a zero reverts
 * `DeadlineRequired`, a passed one `DeadlinePassed`). A transaction can wait
 * in a queue for a long time; without the deadline it would execute on
 * whatever the market is when it finally lands, on terms the user no longer
 * wants.
 *
 * The window is measured from the CHAIN's latest block time, never from the
 * device clock: the contract compares against `block.timestamp`, a device
 * clock can be minutes off, and a local test chain's clock moves on its own.
 * Thirty minutes is the window the signed acceptance terms and the Permit2
 * pulls already use, so one transaction never carries two different windows.
 */

/** How long a price-exposed transaction stays valid after it is built. */
export const TX_DEADLINE_SECONDS = 30 * 60;

/**
 * The `validUntil` to send with a price-exposed transaction built now.
 *
 * @param chainNowSec The latest block's timestamp, in seconds.
 * @returns The last second (inclusive) the transaction may land in.
 */
export function txValidUntil(chainNowSec: bigint, windowSec: number = TX_DEADLINE_SECONDS): bigint {
  return chainNowSec + BigInt(windowSec);
}

// ─── #3770: the window by step class and wallet kind ────────────────────

/**
 * How long a step may wait for its sender's approvals. A key wallet signs at
 * once, so every step it sends carries the thirty-minute window. A contract
 * wallet (a team or family account behind several approvers) may need hours
 * to gather them, so a step whose terms are fixed when it is built lets it
 * choose a longer window; a step that carries a live price never does.
 *
 * - `fixed-terms`: the call's terms cannot change once built (accepting an
 *   offer on its terms; posting or changing an offer, a slot or a setting;
 *   the refinance payoff permit, sized to the window's end and shown as "at
 *   most"). A contract wallet chooses among {@link APPROVAL_WINDOWS}.
 *   `maxWindow` caps the choice (adopting a stray asset: a source flagged
 *   before the step lands bars the vault, so no window past 24 hours).
 *   `signedMessage`: the step signs a message and then sends the transaction
 *   that uses it; the message's deadline and the transaction's are ONE value,
 *   so the chosen window covers both approval rounds.
 * - `short`: thirty minutes for every wallet, for one of two reasons
 *   (`why`): `live-price` (the call carries a slippage floor, a quote, a
 *   route or a stated minimum, so the market it was built on must still
 *   hold) or `unruled` (no class has been decided for it yet). No step is
 *   submitted by anyone but its signer; one that would be is decided before
 *   it is added.
 */
export type StepClass =
  | { kind: 'fixed-terms'; maxWindow?: number; signedMessage?: true }
  | { kind: 'short'; why: 'live-price' | 'unruled' };

/** The windows a contract wallet may choose on a fixed-terms step, in seconds:
 *  30 minutes, 24 hours, 3 days, 7 days. */
export const APPROVAL_WINDOWS: readonly number[] = [TX_DEADLINE_SECONDS, 24 * 3600, 3 * 24 * 3600, 7 * 24 * 3600];

const FIXED: StepClass = { kind: 'fixed-terms' };
const FIXED_SIGNED: StepClass = { kind: 'fixed-terms', signedMessage: true };
const LIVE: StepClass = { kind: 'short', why: 'live-price' };
const UNRULED: StepClass = { kind: 'short', why: 'unruled' };

/**
 * Every step that carries a deadline, by name, with its class. A step not
 * listed reads as `unruled` (thirty minutes). A step whose call carries a
 * slippage floor, a quote, a route or a stated minimum must be `live-price`;
 * the apps' tests hold that.
 */
export const TX_STEPS = {
  // Fixed terms.
  acceptOffer: FIXED_SIGNED,
  acceptRental: FIXED_SIGNED,
  takeRentalRequest: FIXED_SIGNED,
  postOffer: FIXED,
  postRentalListing: FIXED,
  postRentalRequest: FIXED,
  editOffer: FIXED,
  autoLendSetup: FIXED,
  autoLendPreset: FIXED,
  instantSlotConsent: FIXED,
  refinancePayoffPermit: FIXED,
  // A live price.
  borrowInstant: LIVE,
  directSale: LIVE,
  slotTakeover: LIVE,
  getCashPlan: LIVE,
  swapToRepay: LIVE,
  offsetWithOffer: LIVE,
  obligationHandover: LIVE,
  saleListing: LIVE,
  // Thirty minutes or 24 hours at most: a source flagged before it lands
  // bars the vault.
  adoptAsset: { kind: 'fixed-terms', maxWindow: 24 * 3600, signedMessage: true },
  // A signed order carries its own expiry, chosen like any order's; it takes
  // no window from this table.
} as const satisfies Record<string, StepClass>;

export type TxStep = keyof typeof TX_STEPS;

/** The class of `step`; a name not in {@link TX_STEPS} is `unruled`. */
export function stepClass(step: string): StepClass {
  return (TX_STEPS as Record<string, StepClass>)[step] ?? UNRULED;
}

/** The sender, as far as the window depends on it. `threshold`: the
 *  contract wallet's approvals required, read on chain; null when unread. */
export type DeadlineWallet = { kind: 'key' } | { kind: 'contract'; threshold: bigint | null };

/** The windows offered and the one pre-selected. A single choice means the
 *  sender is not asked. */
export interface DeadlineWindows {
  choices: readonly number[];
  preselected: number;
}

/**
 * The windows `step` offers this wallet. A key wallet, and every short step,
 * gets thirty minutes and no choice. A contract wallet on a fixed-terms step
 * chooses among {@link APPROVAL_WINDOWS}, with 24 hours pre-selected when it
 * needs more than one approval and thirty minutes when it needs one (or its
 * threshold could not be read: the shorter window is the one that cannot
 * leave terms standing longer than the sender meant).
 */
export function deadlineWindows(step: string, wallet: DeadlineWallet): DeadlineWindows {
  const cls = stepClass(step);
  if (wallet.kind === 'key' || cls.kind === 'short') return { choices: [TX_DEADLINE_SECONDS], preselected: TX_DEADLINE_SECONDS };
  const choices = cls.maxWindow === undefined ? APPROVAL_WINDOWS : APPROVAL_WINDOWS.filter((w) => w <= cls.maxWindow!);
  const wanted = wallet.threshold !== null && wallet.threshold > 1n ? 24 * 3600 : TX_DEADLINE_SECONDS;
  return { choices, preselected: choices.includes(wanted) ? wanted : TX_DEADLINE_SECONDS };
}

/** `window` if `step` offers it to this wallet, else the step's thirty minutes.
 *  The one place a chosen window is admitted, so a stale or forged choice
 *  never lengthens a short step. */
export function admittedWindow(step: string, wallet: DeadlineWallet, window: number | null): number {
  const w = deadlineWindows(step, wallet);
  return window !== null && w.choices.includes(window) ? window : w.preselected;
}
