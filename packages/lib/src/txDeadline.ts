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
export function txValidUntil(chainNowSec: bigint): bigint {
  return chainNowSec + BigInt(TX_DEADLINE_SECONDS);
}
