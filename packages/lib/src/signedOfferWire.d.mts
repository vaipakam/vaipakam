/** Types for `signedOfferWire.mjs`. The field list is spelled out as literal
 *  types so viem can type the EIP-712 message from it; the runtime list is the
 *  `.mjs`, and the indexer's typehash test pins it to the type string it
 *  reads from `LibSignedOffer.sol`. */

export type SignedOfferFields = readonly [
  { readonly name: 'offerType'; readonly type: 'uint8' },
  { readonly name: 'lendingAsset'; readonly type: 'address' },
  { readonly name: 'amount'; readonly type: 'uint256' },
  { readonly name: 'amountMax'; readonly type: 'uint256' },
  { readonly name: 'interestRateBps'; readonly type: 'uint256' },
  { readonly name: 'interestRateBpsMax'; readonly type: 'uint256' },
  { readonly name: 'collateralAsset'; readonly type: 'address' },
  { readonly name: 'collateralAmount'; readonly type: 'uint256' },
  { readonly name: 'collateralAmountMax'; readonly type: 'uint256' },
  { readonly name: 'durationDays'; readonly type: 'uint256' },
  { readonly name: 'assetType'; readonly type: 'uint8' },
  { readonly name: 'collateralAssetType'; readonly type: 'uint8' },
  { readonly name: 'tokenId'; readonly type: 'uint256' },
  { readonly name: 'quantity'; readonly type: 'uint256' },
  { readonly name: 'collateralTokenId'; readonly type: 'uint256' },
  { readonly name: 'collateralQuantity'; readonly type: 'uint256' },
  { readonly name: 'prepayAsset'; readonly type: 'address' },
  { readonly name: 'allowsPartialRepay'; readonly type: 'bool' },
  { readonly name: 'allowsPrepayListing'; readonly type: 'bool' },
  { readonly name: 'allowsParallelSale'; readonly type: 'bool' },
  { readonly name: 'expiresAt'; readonly type: 'uint64' },
  { readonly name: 'fillMode'; readonly type: 'uint8' },
  { readonly name: 'periodicInterestCadence'; readonly type: 'uint8' },
  { readonly name: 'refinanceTargetLoanId'; readonly type: 'uint256' },
  { readonly name: 'useFullTermInterest'; readonly type: 'bool' },
  { readonly name: 'lifecycleFlex'; readonly type: 'uint8' },
  { readonly name: 'integrator'; readonly type: 'address' },
  { readonly name: 'creatorFull'; readonly type: 'bool' },
  { readonly name: 'creatorMaxCStar'; readonly type: 'uint256' },
  { readonly name: 'creatorAllowFullDowngrade'; readonly type: 'bool' },
  { readonly name: 'maxTreasuryFeeBps'; readonly type: 'uint16' },
  { readonly name: 'maxLoanInitiationFeeBps'; readonly type: 'uint16' },
  { readonly name: 'allowedTaker'; readonly type: 'address' },
  { readonly name: 'coSigner'; readonly type: 'address' },
  { readonly name: 'signer'; readonly type: 'address' },
  { readonly name: 'nonce'; readonly type: 'uint256' },
  { readonly name: 'deadline'; readonly type: 'uint256' },
  { readonly name: 'setKind'; readonly type: 'uint8' },
  { readonly name: 'setLow'; readonly type: 'uint256' },
  { readonly name: 'setHigh'; readonly type: 'uint256' },
  { readonly name: 'setRoot'; readonly type: 'bytes32' },
  { readonly name: 'setListCount'; readonly type: 'uint32' },
  { readonly name: 'setListHash'; readonly type: 'bytes32' },
  { readonly name: 'exclusionsHash'; readonly type: 'bytes32' },
  { readonly name: 'loans'; readonly type: 'uint16' },
  { readonly name: 'startTime'; readonly type: 'uint64' },
  { readonly name: 'linkKind'; readonly type: 'uint8' },
  { readonly name: 'linkMarginBps'; readonly type: 'int16' },
  { readonly name: 'rateFarFromAverageAcknowledged'; readonly type: 'bool' },
];

export const SIGNED_OFFER_FIELDS: SignedOfferFields;
export const SIGNED_OFFER_FIELD_NAMES: readonly string[];

/** The order in wire form, keyed by field name: addresses lowercased, bools
 *  as booleans, uints as canonical decimal strings (ints may carry a leading minus). */
export type SignedOrderWire = {
  [F in SignedOfferFields[number] as F['name']]: F['type'] extends 'bool' ? boolean : string;
};

/** #3328 — the collection fields of an ordinary order, at their zero wire
 *  values. */
export const NO_COLLECTION: Readonly<{
  setKind: '0';
  setLow: '0';
  setHigh: '0';
  setRoot: `0x${string}`;
  setListCount: '0';
  setListHash: `0x${string}`;
  exclusionsHash: `0x${string}`;
  loans: '0';
  startTime: '0';
}>;

/** #3635 A, #3713 — the rate-link fields of an order with no market link and
 *  no far-from-average acknowledgement. */
export const NO_RATE_LINK: Readonly<{
  linkKind: '0';
  linkMarginBps: '0';
  rateFarFromAverageAcknowledged: false;
}>;

export interface SignedOfferColumns {
  signer: string;
  offer_type: number;
  lending_asset: string;
  collateral_asset: string;
  duration_days: number;
  asset_type: number;
  collateral_asset_type: number;
  interest_rate_bps: number;
  interest_rate_bps_max: number;
  amount: string;
  amount_max: string;
  collateral_amount: string;
  collateral_amount_max: string;
  fill_mode: number;
  expires_at: number;
  deadline: number;
  nonce: string;
}

export function canonicalOrderJson(order: SignedOrderWire): string;
export function parseStoredOrderJson(json: unknown): { order: SignedOrderWire } | { error: string };
export function signedOfferColumns(order: SignedOrderWire): SignedOfferColumns;
export function signedOfferRowProblem(row: Record<string, unknown>): string | null;

/** #3327 part 2 — where one offer sits in the set its maker signed
 *  (`LibSignedOffer.OfferSet`). */
export interface SignedOfferPlacement {
  others: `0x${string}`[];
  index: number;
}
export const MAX_SIGNED_OFFER_SET: 32;
export function placementProblem(value: unknown): string | null;
export function canonicalPlacementJson(placement: SignedOfferPlacement): string;
