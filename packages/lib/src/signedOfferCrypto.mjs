/**
 * The signed-offer signature rule (#1131, #3327, #2899): the order hash, the
 * digest a maker signs alone or as one of a set, and the check that a
 * signature is the signer's. This module is the one statement of that rule
 * off chain. The indexer's POST route applies it before an order enters the
 * book, and the off-chain restore converter applies it again before an
 * archived order is put back, so a row written straight into the database
 * (skipping the route) is not restored onto the book.
 *
 * Plain JavaScript, and it takes the hashing and recovery primitives as an
 * argument (`signedOfferCrypto(viem)`) instead of importing them. The restore
 * converter runs under plain Node outside the pnpm workspace, so a bare
 * `import 'viem'` here would resolve from this package's directory, where
 * that tool's install puts nothing. Each caller passes the viem it already
 * resolves: the workspace's for the apps and the indexer
 * (`signedOfferSet.ts`), the backup package's own for the converter. The
 * rule itself lives only here; `signedOfferSet.ts` binds it to viem once.
 *
 * Mirrors `contracts/src/libraries/LibSignedOffer.sol`. The indexer's
 * typehash test pins the field list to that file's type string, and
 * `signedOfferSet.test.ts` pins the set digest to a wallet's.
 */
import { SIGNED_OFFER_FIELDS } from './signedOfferWire.mjs';

/** `LibSignedOffer.domainSeparator()`'s fixed name and version. */
export const SIGNED_OFFER_DOMAIN_NAME = 'Vaipakam SignedOffer';
export const SIGNED_OFFER_DOMAIN_VERSION = '1';

/** The EIP-712 domain the Diamond on `chainId` at `diamond` signs under. */
export function signedOfferDomain(chainId, diamond) {
  return { name: SIGNED_OFFER_DOMAIN_NAME, version: SIGNED_OFFER_DOMAIN_VERSION, chainId, verifyingContract: diamond };
}

/** Wire order to the typed-data message, field by field from the one field
 *  list: a number up to 32 bits, a bigint above, hex for an address or a
 *  bytes32, a boolean as is. The wire shape must already be valid: `BigInt`
 *  throws on a malformed figure. */
export function signedOfferMessage(order) {
  const out = {};
  for (const { name, type } of SIGNED_OFFER_FIELDS) {
    const v = order[name];
    if (type === 'bool' || type === 'address' || type === 'bytes32') out[name] = v;
    else if (type === 'uint8' || type === 'uint16' || type === 'uint32') out[name] = Number(v);
    else out[name] = BigInt(v);
  }
  return out;
}

/** The EIP-712 types of one signed offer, and of a set of them. */
export const SIGNED_OFFER_TYPES = Object.freeze({ SignedOffer: SIGNED_OFFER_FIELDS });
export const SIGNED_OFFER_SET_TYPES = Object.freeze({
  SignedOfferSet: [{ name: 'offers', type: 'SignedOffer[]' }],
  SignedOffer: SIGNED_OFFER_FIELDS,
});

/** `LibSignedOffer.SIGNED_OFFER_SET_TYPEHASH`'s preimage. */
export const SIGNED_OFFER_SET_TYPE_STRING =
  'SignedOfferSet(SignedOffer[] offers)SignedOffer(' +
  SIGNED_OFFER_FIELDS.map((f) => `${f.type} ${f.name}`).join(',') +
  ')';

const EIP712_DOMAIN_TYPES = Object.freeze({
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
});

/**
 * The rule, bound to the given primitives. `viem` needs `hashStruct`,
 * `hashDomain`, `keccak256`, `concat`, `encodeAbiParameters` and
 * `recoverAddress`; the viem module namespace has all six.
 */
export function signedOfferCrypto(viem) {
  const { hashStruct, hashDomain, keccak256, concat, encodeAbiParameters, recoverAddress } = viem;
  const setTypehash = keccak256(new TextEncoder().encode(SIGNED_OFFER_SET_TYPE_STRING));

  /** The order hash: the EIP-712 struct hash, `SignedOfferFacet.signedOfferOrderHash`.
   *  Domain-independent; the on-chain fill ledger and the book both key on it. */
  function orderHashOf(order) {
    return hashStruct({ data: signedOfferMessage(order), primaryType: 'SignedOffer', types: SIGNED_OFFER_TYPES });
  }

  /** The struct hash the maker signed for the offer whose struct hash is
   *  `orderHash` (`LibSignedOffer.signedStructHash`): the offer itself when it
   *  was signed alone, else the set struct. The placement must be well formed
   *  (`placementProblem`). */
  function signedStructHash(orderHash, placement) {
    if (placement === null || placement === undefined || placement.others.length === 0) return orderHash;
    const hashes = [...placement.others];
    hashes.splice(placement.index, 0, orderHash);
    return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [setTypehash, keccak256(concat(hashes))]));
  }

  /** The full EIP-712 digest the maker signed for that offer in `domain`. */
  function signedDigest(orderHash, placement, domain) {
    return keccak256(
      concat([
        '0x1901',
        hashDomain({ domain: { ...domain, chainId: BigInt(domain.chainId) }, types: EIP712_DOMAIN_TYPES }),
        signedStructHash(orderHash, placement),
      ]),
    );
  }

  /**
   * Whether `signature` recovers `order.signer` over the digest the maker
   * signed on the Diamond at `diamond` on `chainId`. False, never a throw, for
   * malformed signature bytes.
   *
   * EOA-only: the contract also accepts ERC-1271 contract signatures, but
   * checking one needs an `eth_call`, so the book admits only signatures that
   * recover locally. A contract signer cannot post to the book yet.
   */
  async function verifySignedOffer(order, signature, chainId, diamond, placement = null) {
    try {
      const recovered = await recoverAddress({
        hash: signedDigest(orderHashOf(order), placement, signedOfferDomain(chainId, diamond)),
        signature,
      });
      return recovered.toLowerCase() === order.signer.toLowerCase();
    } catch {
      return false;
    }
  }

  return Object.freeze({ setTypehash, orderHashOf, signedStructHash, signedDigest, verifySignedOffer });
}
