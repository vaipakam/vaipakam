/**
 * The keeper's reads of the D2 loan clock (#668 / #935, #2808).
 *
 * A pause moves every open loan's due date later by the protocol's paused
 * time since the loan's start, and the contracts enforce the moved date. The
 * rule itself lives once, in `@vaipakam/lib/loanClock`; this module is the
 * keeper's one place that reads the pause record for it, so every pass that
 * asks "is this loan still in term?" gets the same answer, and the same
 * "unknown" when the record does not read.
 */
import type { Address, PublicClient } from 'viem';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { loanMaturity, readPauseLog } from '@vaipakam/lib/loanClock';

/** Whether a loan is before its effective due date, or why that is unknown. */
export type InTermAnswer = { known: true; inTerm: boolean } | { known: false; reason: string };

/**
 * Is `now` before the loan's EFFECTIVE due date (`LibLoanClock.maturity`)?
 *
 * This is the date the contract's `PartialAfterMaturity` guard reads. A
 * pause log that does not read leaves it unknown, and the caller skips the
 * loan for the tick rather than deciding against the original date, which
 * after a pause is early. A Diamond that predates the loan clock reads as
 * never paused, which is what its loans are held to.
 */
export async function inTermOnLoanClock(
  client: PublicClient,
  diamond: Address,
  loan: { startTime: bigint; durationDays: bigint },
  now: bigint,
): Promise<InTermAnswer> {
  try {
    const log = await readPauseLog({ client, diamond });
    return { known: true, inTerm: now < loanMaturity(loan, log, now) };
  } catch (err) {
    // A bounded description, never the message: a transport error carries
    // the RPC URL, and with it any key in that URL (Codex #2822 r2).
    return { known: false, reason: `pause log unread: ${describeFailure(err)}` };
  }
}
