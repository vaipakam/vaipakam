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
import { concat, encodeAbiParameters, hashDomain, keccak256, type Hex } from 'viem';
import {
  MAX_SIGNED_OFFER_SET,
  SIGNED_OFFER_FIELDS,
  canonicalPlacementJson,
  placementProblem,
  type SignedOfferPlacement,
} from './signedOfferWire.mjs';

// The placement wire rule lives in the plain-JS wire module, which the
// restore converter also reads; re-exported here so callers have one import.
export { MAX_SIGNED_OFFER_SET, canonicalPlacementJson, placementProblem, type SignedOfferPlacement };

/** The typed-data types a wallet signs for a set. */
export const SIGNED_OFFER_SET_TYPES = {
  SignedOfferSet: [{ name: 'offers', type: 'SignedOffer[]' }],
  SignedOffer: SIGNED_OFFER_FIELDS,
} as const;

/** `LibSignedOffer.SIGNED_OFFER_SET_TYPEHASH`. */
export const SIGNED_OFFER_SET_TYPEHASH: Hex = keccak256(
  new TextEncoder().encode(
    'SignedOfferSet(SignedOffer[] offers)SignedOffer(' +
      SIGNED_OFFER_FIELDS.map((f) => `${f.type} ${f.name}`).join(',') +
      ')',
  ),
);

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
  if (placement === null || placement.others.length === 0) return orderHash;
  const hashes = [...placement.others];
  hashes.splice(placement.index, 0, orderHash);
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [SIGNED_OFFER_SET_TYPEHASH, keccak256(concat(hashes))]),
  );
}

/** The signed-offer EIP-712 domain: all four fields, as the Diamond's
 *  `LibSignedOffer.domainSeparator` hashes them. */
export interface SignedOfferDomain {
  name: string;
  version: string;
  chainId: number | bigint;
  verifyingContract: Hex;
}

/** The full EIP-712 digest the maker signed for that offer in `domain`. */
export function signedDigest(orderHash: Hex, placement: SignedOfferPlacement | null, domain: SignedOfferDomain): Hex {
  return keccak256(
    concat([
      '0x1901',
      hashDomain({
        domain: { ...domain, chainId: BigInt(domain.chainId) },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
        },
      }),
      signedStructHash(orderHash, placement),
    ]),
  );
}
