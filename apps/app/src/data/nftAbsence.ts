/**
 * Why a position NFT id does not currently exist (#2529).
 *
 * `ownerOf` reverts the same way for a token the protocol retired and for
 * an id never minted, so the verifier used to state both possibilities.
 * `VaipakamNFTFacet.highestTokenId()` closes that: ids run from 1, are
 * never reused, and every id up to that value was minted once, so an id
 * at or below it whose `ownerOf` reverts was retired, and an id above it
 * was never minted on this network.
 *
 * Both reads are taken at ONE block. Read separately, a token minted
 * between them would have `ownerOf` revert at the earlier block and
 * `highestTokenId` cover it at the later one, and a brand-new position
 * would be reported retired.
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { isMissingSelectorError } from '../contracts/preflights';

/** - `retired`: minted here once, no longer exists.
 *  - `never-minted`: no token with this id has been created here.
 *  - `unrecorded`: this network's contracts predate the view, so the
 *    chain cannot say which — a fact about the deployment.
 *  - `unchecked`: the view exists but the read failed; a reload may
 *    answer. */
export type NftAbsence = 'retired' | 'never-minted' | 'unrecorded' | 'unchecked';

/** The classification itself, pure so it is tested without a chain. */
export function classifyAbsence(tokenId: bigint, highestTokenId: bigint): NftAbsence {
  return tokenId <= highestTokenId ? 'retired' : 'never-minted';
}

/** Read why `tokenId` is absent, at `blockNumber` — the block whose
 *  `ownerOf` revert established the absence. */
export async function readNftAbsence(
  client: PublicClient,
  diamond: `0x${string}`,
  tokenId: bigint,
  blockNumber: bigint,
): Promise<NftAbsence> {
  try {
    const highest = (await client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'highestTokenId',
      blockNumber,
    })) as bigint;
    return classifyAbsence(tokenId, highest);
  } catch (err) {
    // The absence itself is already proven by the `ownerOf` revert, so a
    // failure here costs only the reason, never the verdict.
    return isMissingSelectorError(err) ? 'unrecorded' : 'unchecked';
  }
}
