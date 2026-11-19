/** Types for `signedOfferCrypto.mjs`. Callers in the workspace use the
 *  viem-bound, fully typed wrappers in `signedOfferSet.ts`. */
import type { SignedOfferFields, SignedOfferPlacement, SignedOrderWire } from './signedOfferWire.mjs';

type Hex = `0x${string}`;

export const SIGNED_OFFER_DOMAIN_NAME: 'Vaipakam SignedOffer';
export const SIGNED_OFFER_DOMAIN_VERSION: '1';

export interface SignedOfferDomain {
  name: string;
  version: string;
  chainId: number | bigint;
  verifyingContract: Hex;
}

export function signedOfferDomain(chainId: number, diamond: Hex): SignedOfferDomain;

/** The primitive viem's typed-data encoder takes for an EIP-712 type. */
type MessageValue<T extends string> = T extends 'bool'
  ? boolean
  : T extends 'address' | 'bytes32'
    ? Hex
    : T extends 'uint8' | 'uint16' | 'uint32'
      ? number
      : bigint;

export type SignedOfferMessage = {
  [F in SignedOfferFields[number] as F['name']]: MessageValue<F['type']>;
};

export function signedOfferMessage(order: SignedOrderWire): SignedOfferMessage;

export const SIGNED_OFFER_TYPES: Readonly<{ SignedOffer: SignedOfferFields }>;
export const SIGNED_OFFER_SET_TYPES: Readonly<{
  SignedOfferSet: readonly [{ name: 'offers'; type: 'SignedOffer[]' }];
  SignedOffer: SignedOfferFields;
}>;
export const SIGNED_OFFER_SET_TYPE_STRING: string;

/** The primitives the rule is bound to: the viem module namespace has them. */
export interface SignedOfferPrimitives {
  hashStruct(args: { data: Record<string, unknown>; primaryType: string; types: Record<string, unknown> }): Hex;
  hashDomain(args: { domain: Record<string, unknown>; types: Record<string, unknown> }): Hex;
  keccak256(value: Hex | Uint8Array): Hex;
  concat(values: readonly Hex[]): Hex;
  encodeAbiParameters(params: readonly { type: string }[], values: readonly unknown[]): Hex;
  recoverAddress(args: { hash: Hex; signature: Hex }): Promise<Hex>;
}

export interface SignedOfferCrypto {
  readonly setTypehash: Hex;
  orderHashOf(order: SignedOrderWire): Hex;
  signedStructHash(orderHash: Hex, placement: SignedOfferPlacement | null): Hex;
  signedDigest(orderHash: Hex, placement: SignedOfferPlacement | null, domain: SignedOfferDomain): Hex;
  verifySignedOffer(
    order: SignedOrderWire,
    signature: Hex,
    chainId: number,
    diamond: Hex,
    placement?: SignedOfferPlacement | null,
  ): Promise<boolean>;
}

export function signedOfferCrypto(viem: SignedOfferPrimitives): SignedOfferCrypto;
