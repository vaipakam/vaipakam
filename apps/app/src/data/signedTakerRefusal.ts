/**
 * #3327 — the taker-side reads and messages for the maker's limits on a
 * signed order (a named taker, a co-signer, the fee caps, the cancel floor).
 * The rule itself is `signedOrderTakerRefusal` in `lib/signedOffer`.
 */
import type { Address, PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { isMissingSelectorError } from '../contracts/preflights';
import type { SignedTakerRefusal } from '../lib/signedOffer';

/** The signer's cancel floor, or `undefined` on a Diamond that predates it
 *  (no floor exists there). Any other read failure is thrown: an unknown
 *  floor must not read as "no floor". */
export async function readSignedOfferCancelFloor(
  publicClient: PublicClient,
  diamond: Address,
  signer: Address,
): Promise<bigint | undefined> {
  try {
    return (await publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'signedOfferCancelFloor',
      args: [signer],
    })) as bigint;
  } catch (err) {
    if (isMissingSelectorError(err)) return undefined;
    throw err;
  }
}

/** The plain-language reason a taker cannot fill the order. */
export function signedTakerRefusalMessage(refusal: SignedTakerRefusal): string {
  switch (refusal) {
    case 'taker':
      return copy.desk.signed.reservedForOtherTaker;
    case 'coSigner':
      return copy.desk.signed.needsCoSigner;
    case 'feeAboveCap':
      return copy.desk.signed.feeAboveCap;
    case 'cancelled':
      return copy.desk.signed.gone;
  }
}
