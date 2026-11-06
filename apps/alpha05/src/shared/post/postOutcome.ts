/**
 * RB-CONFIDENCE — what posting a request or an offer did, read from its own
 * transaction: the offer the protocol recorded for this wallet (its
 * `OfferCreated`, of the side that was posted). The collateral that moved into the vault is measured
 * with the shared transfer reader; a figure the logs do not substantiate is
 * unknown, never assumed.
 */
import { parseEventLogs, type Log } from 'viem';
import { CREATE_ABI } from './postReview';

type Hex = `0x${string}`;

/** The offer of `offerType` (the protocol's position: 0 a lender's offer,
 *  1 a borrower's request) this transaction recorded for `creator`, from the
 *  Diamond's own log; null when it recorded none. */
export function createdOffer(logs: readonly Log[], diamond: Hex, creator: Hex, offerType: number): bigint | null {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: CREATE_ABI, logs: [...own], eventName: 'OfferCreated', strict: false }) as unknown as {
    args: { offerId?: bigint; creator?: Hex; offerType?: number };
  }[];
  const hit = events.find((e) => e.args.creator?.toLowerCase() === creator.toLowerCase() && e.args.offerType === offerType);
  return hit?.args.offerId ?? null;
}
