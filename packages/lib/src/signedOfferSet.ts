/**
 * #3327 part 2 — one signature over a set of signed offers.
 *
 * A maker signs the EIP-712 type `SignedOfferSet(SignedOffer[] offers)`: a
 * typed list, so the wallet shows every offer's terms before signing (owner
 * decision 2026-11-15: a readable list, not an opaque Merkle root). A fill
 * presents one offer, the struct hashes of the set's other offers in signing
 * order, and the offer's position among them (its "placement");
 * `LibSignedOffer.signedStructHash` rebuilds the signed struct from those.
 * Each offer keeps its own order hash, fill ledger and cancel; giving every
 * offer of a set one nonce lets one nonce cancel stop the whole set.
 *
 * This is the one statement of the set rule off-chain: the indexer's ingest
 * check and both apps' signing and fill paths read it.
 */
import { concat, encodeAbiParameters, hashDomain, hashStruct, keccak256, recoverAddress, type Hex } from 'viem';
import {
  MAX_SIGNED_OFFER_SET,
  canonicalPlacementJson,
  placementProblem,
  type SignedOfferPlacement,
  type SignedOrderWire,
} from './signedOfferWire.mjs';
import {
  SIGNED_OFFER_SET_TYPES,
  signedOfferCrypto,
  signedOfferDomain,
  signedOfferMessage,
  type SignedOfferDomain,
  type SignedOfferMessage,
} from './signedOfferCrypto.mjs';

// The placement wire rule lives in the plain-JS wire module, which the
// restore converter also reads; re-exported here so callers have one import.
export { MAX_SIGNED_OFFER_SET, canonicalPlacementJson, placementProblem, type SignedOfferPlacement };

// The hashing and signature rule lives in the plain-JS crypto module, which
// the restore converter binds to its own viem (#2899); bound here once to the
// workspace's, so every caller below reads the one rule.
export { SIGNED_OFFER_SET_TYPES, signedOfferDomain, signedOfferMessage, type SignedOfferDomain, type SignedOfferMessage };
// Named imports, not the namespace: a bundler cannot drop unused viem code
// behind a namespace object passed to a function.
const rule = signedOfferCrypto({ concat, encodeAbiParameters, hashDomain, hashStruct, keccak256, recoverAddress });

/** `LibSignedOffer.SIGNED_OFFER_SET_TYPEHASH`. */
export const SIGNED_OFFER_SET_TYPEHASH: Hex = rule.setTypehash;

/** The placement the contract takes for an offer signed alone. */
export const ALONE: SignedOfferPlacement = Object.freeze({ others: [], index: 0 }) as SignedOfferPlacement;

/** Every offer's placement in a set whose struct hashes are `hashes`, in
 *  signing order. */
export function placementsOf(hashes: readonly Hex[]): SignedOfferPlacement[] {
  return hashes.map((_, i) => ({ others: hashes.filter((__, j) => j !== i), index: i }));
}

/** The struct hash the maker signed for the offer whose struct hash is
 *  `orderHash` (`LibSignedOffer.signedStructHash`): the offer itself when it
 *  was signed alone, else the set struct. The placement must be well formed
 *  ({@link placementProblem}). */
export function signedStructHash(orderHash: Hex, placement: SignedOfferPlacement | null): Hex {
  return rule.signedStructHash(orderHash, placement);
}

/** The full EIP-712 digest the maker signed for that offer in `domain`. */
export function signedDigest(orderHash: Hex, placement: SignedOfferPlacement | null, domain: SignedOfferDomain): Hex {
  return rule.signedDigest(orderHash, placement, domain);
}

/** The order hash: the EIP-712 struct hash (`SignedOfferFacet.signedOfferOrderHash`). */
export function signedOfferOrderHash(order: SignedOrderWire): Hex {
  return rule.orderHashOf(order);
}

/** Whether `signature` recovers `order.signer` over the digest the maker
 *  signed on that Diamond, alone (`placement` null) or in a set. EOA-only:
 *  see `signedOfferCrypto.mjs`. */
export function verifySignedOffer(
  order: SignedOrderWire,
  signature: Hex,
  chainId: number,
  diamond: Hex,
  placement: SignedOfferPlacement | null = null,
): Promise<boolean> {
  return rule.verifySignedOffer(order, signature, chainId, diamond, placement);
}
