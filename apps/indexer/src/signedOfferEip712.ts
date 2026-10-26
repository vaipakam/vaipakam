/**
 * Rate Desk phase 3 (#1131) — pure EIP-712 helpers for the signed-offer
 * book's POST ingest gate.
 *
 * Mirrors `contracts/src/libraries/LibSignedOffer.sol` exactly:
 *
 *   - `SIGNED_OFFER_TYPES.SignedOffer` lists the 31 fields in the SAME order
 *     as the Solidity struct / `SIGNED_OFFER_TYPEHASH` type string
 *     (LibSignedOffer.sol:39-105). Field order is load-bearing — any drift
 *     silently changes every hash. The unit test
 *     (`test/signedOfferEip712.test.ts`) pins the derived typehash against a
 *     byte-for-byte copy of the contract's canonical type string.
 *   - The domain is `{name: "Vaipakam SignedOffer", version: "1", chainId,
 *     verifyingContract: <diamond>}` (LibSignedOffer.sol:132-154).
 *   - `orderHashOf` is the STRUCT hash (`hashStruct`, NOT the full digest) —
 *     the same value `SignedOfferFacet.signedOfferOrderHash` returns and the
 *     key the on-chain `signedOfferFilled` ledger + the `signed_offers` D1
 *     table use. Domain/chain binding lives in the signature check (the
 *     digest folds in the chain-bound domain separator), matching the
 *     contract's `LibSignedOffer.verify` split.
 *
 * Everything here is side-effect-free local computation (no RPC, no D1) so
 * the route can verify signatures before spending any chain subrequest, and
 * so vitest can exercise it without a Worker runtime.
 */

import {
  hashStruct,
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem';
import {
  SIGNED_OFFER_FIELDS,
  SIGNED_OFFER_FIELD_NAMES,
  type SignedOrderWire,
} from '@vaipakam/lib/signedOfferWire';

/** The 31-field SignedOffer typed-data description — struct order EXACTLY as
 *  `LibSignedOffer.SignedOffer` declares it (enums ⇒ uint8, GTT ⇒ uint64).
 *  The list itself is `@vaipakam/lib/signedOfferWire`'s, the one statement of
 *  the stored order the POST route and the restore converter share (#1481). */
export const SIGNED_OFFER_TYPES = { SignedOffer: SIGNED_OFFER_FIELDS } as const;

/** The 31 field names in canonical struct order, and the wire-shape order:
 *  every uint as a decimal string, addresses as lowercase 0x-40-hex, bools as
 *  booleans. That is BOTH the POST body shape and the stored `order_json`
 *  shape — takers replay it verbatim into `acceptSignedOffer`. */
export { SIGNED_OFFER_FIELD_NAMES, type SignedOrderWire };

/** The EIP-712 domain the Diamond computes in
 *  `LibSignedOffer.domainSeparator()` — name/version are constants; chainId
 *  + verifyingContract bind the signature to one deployment. */
export function signedOfferDomain(
  chainId: number,
  diamond: Address,
): TypedDataDomain {
  return {
    name: 'Vaipakam SignedOffer',
    version: '1',
    chainId,
    verifyingContract: diamond,
  };
}

/** Convert the wire shape (decimal strings) into the bigint-typed message
 *  viem's typed-data encoder expects. Callers must have validated the wire
 *  shape first (`BigInt()` throws on malformed input by design — the route's
 *  strict per-field validation runs before any hashing). */
export function toTypedMessage(order: SignedOrderWire) {
  return {
    offerType: Number(order.offerType),
    lendingAsset: order.lendingAsset as Address,
    amount: BigInt(order.amount),
    amountMax: BigInt(order.amountMax),
    interestRateBps: BigInt(order.interestRateBps),
    interestRateBpsMax: BigInt(order.interestRateBpsMax),
    collateralAsset: order.collateralAsset as Address,
    collateralAmount: BigInt(order.collateralAmount),
    collateralAmountMax: BigInt(order.collateralAmountMax),
    durationDays: BigInt(order.durationDays),
    assetType: Number(order.assetType),
    collateralAssetType: Number(order.collateralAssetType),
    tokenId: BigInt(order.tokenId),
    quantity: BigInt(order.quantity),
    collateralTokenId: BigInt(order.collateralTokenId),
    collateralQuantity: BigInt(order.collateralQuantity),
    prepayAsset: order.prepayAsset as Address,
    allowsPartialRepay: order.allowsPartialRepay,
    allowsPrepayListing: order.allowsPrepayListing,
    allowsParallelSale: order.allowsParallelSale,
    expiresAt: BigInt(order.expiresAt),
    fillMode: Number(order.fillMode),
    periodicInterestCadence: Number(order.periodicInterestCadence),
    refinanceTargetLoanId: BigInt(order.refinanceTargetLoanId),
    useFullTermInterest: order.useFullTermInterest,
    creatorFull: order.creatorFull,
    creatorMaxCStar: BigInt(order.creatorMaxCStar),
    creatorAllowFullDowngrade: order.creatorAllowFullDowngrade,
    signer: order.signer as Address,
    nonce: BigInt(order.nonce),
    deadline: BigInt(order.deadline),
  };
}

/** The order hash — the EIP-712 STRUCT hash (`hashStruct`), matching
 *  `SignedOfferFacet.signedOfferOrderHash`. Domain-independent: the D1 PK and
 *  the on-chain fill ledger both key on it. */
export function orderHashOf(order: SignedOrderWire): Hex {
  return hashStruct({
    data: toTypedMessage(order),
    primaryType: 'SignedOffer',
    types: SIGNED_OFFER_TYPES,
  });
}

/** The full EIP-712 digest the signer signs (`\x19\x01` ‖ domainSeparator ‖
 *  hashStruct) — matches `SignedOfferFacet.hashSignedOffer`. */
export function signedOfferDigest(
  order: SignedOrderWire,
  chainId: number,
  diamond: Address,
): Hex {
  return hashTypedData({
    domain: signedOfferDomain(chainId, diamond),
    types: SIGNED_OFFER_TYPES,
    primaryType: 'SignedOffer',
    message: toTypedMessage(order),
  });
}

/**
 * Verify that `signature` recovers `order.signer` over the order's full
 * EIP-712 digest for this (chainId, diamond) domain.
 *
 * **EOA-only (v1 limitation).** The contract accepts BOTH ECDSA and ERC-1271
 * contract signatures (OZ `SignatureChecker` in `LibSignedOffer.verify`), but
 * a Worker-side 1271 check needs an `eth_call` to `isValidSignature` on the
 * signer contract — an RPC subrequest per POST on a public endpoint. v1 keeps
 * ingest verification purely local and rejects a non-recovering signature,
 * which means SMART-CONTRACT SIGNERS (Safe, future LenderIntentVault) cannot
 * post to the book yet. Follow-up: attempt local ECDSA first, and only for
 * addresses with code fall back to one `isValidSignature` eth_call via the
 * chain's configured RPC (bounded by the same per-IP rate limit).
 */
export async function verifySignedOfferSignature(
  order: SignedOrderWire,
  signature: Hex,
  chainId: number,
  diamond: Address,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: signedOfferDomain(chainId, diamond),
      types: SIGNED_OFFER_TYPES,
      primaryType: 'SignedOffer',
      message: toTypedMessage(order),
      signature,
    });
    return recovered.toLowerCase() === order.signer.toLowerCase();
  } catch {
    // Malformed signature bytes (bad length / invalid recovery id) — treat
    // as a verification failure, never a route 500.
    return false;
  }
}

/** The order's principal ceiling — the fully-consumed threshold. Mirrors
 *  `SignedOfferFacet._ceiling`: `amountMax == 0 ? amount : amountMax`. */
export function ceilingOf(amount: string, amountMax: string): bigint {
  const max = BigInt(amountMax);
  return max === 0n ? BigInt(amount) : max;
}
