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
  type SignedOfferFields,
  type SignedOfferPlacement,
  type SignedOrderWire,
} from './signedOfferWire.mjs';

// The placement wire rule lives in the plain-JS wire module, which the
// restore converter also reads; re-exported here so callers have one import.
export { MAX_SIGNED_OFFER_SET, canonicalPlacementJson, placementProblem, type SignedOfferPlacement };

/** The primitive viem's typed-data encoder takes for an EIP-712 type: a
 *  number up to 48 bits, a bigint above, hex for an address or a bytes32. */
type MessageValue<T extends string> = T extends 'bool'
  ? boolean
  : T extends 'address' | 'bytes32'
    ? Hex
    : T extends 'uint8' | 'uint16' | 'uint32'
      ? number
      : bigint;

/** A signed offer as viem's typed-data encoder (and the Diamond's
 *  `SignedOffer` ABI tuple) takes it. */
export type SignedOfferMessage = {
  [F in SignedOfferFields[number] as F['name']]: MessageValue<F['type']>;
};

/** Wire order to {@link SignedOfferMessage}, field by field from the one
 *  field list, so no caller keeps its own copy of the struct (#3328: the
 *  apps, the indexer and the e2e helpers each had one). The wire shape must
 *  already be valid: `BigInt` throws on a malformed figure. */
export function signedOfferMessage(order: SignedOrderWire): SignedOfferMessage {
  const out: Record<string, unknown> = {};
  for (const { name, type } of SIGNED_OFFER_FIELDS) {
    const v = (order as Record<string, unknown>)[name];
    if (type === 'bool') out[name] = v;
    else if (type === 'address' || type === 'bytes32') out[name] = v as Hex;
    else if (type === 'uint8' || type === 'uint16' || type === 'uint32') out[name] = Number(v);
    else out[name] = BigInt(v as string);
  }
  return out as SignedOfferMessage;
}

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
