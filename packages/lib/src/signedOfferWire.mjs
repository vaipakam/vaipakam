/**
 * A signed offer as the platform stores it (#1131, #1481).
 *
 * The maker signs a 31-field `SignedOffer` struct (EIP-712, struct order
 * exactly as `LibSignedOffer.SignedOffer` declares it). The indexer keeps
 * that order as `order_json` — the payload a taker replays on chain — beside
 * the market columns the book filters and sorts on, which are copies of
 * fields of the same order. This module is the one statement of that row:
 * the field list, the canonical `order_json` serialization, the promoted
 * columns, and the test a stored `order_json` must pass.
 *
 * Two writers depend on it and must agree byte for byte. The indexer's POST
 * route writes the row from a validated order; the off-chain restore
 * converter (`ops/offchain-data-warm/scripts/restore-from-archive.mjs`)
 * re-admits an archived row only when its `order_json` is the canonical
 * serialization of a well-formed order and every promoted column equals the
 * field it copies. A row that fails would be served by the book as an offer
 * the taker cannot replay, or as one market while filling another — so it
 * is refused rather than restored.
 *
 * Plain JavaScript with no imports, because the converter runs under plain
 * Node outside the pnpm workspace; `signedOfferWire.d.mts` carries the types.
 * What this module does NOT decide is whether the signature is the signer's
 * over this order on this deployment: that needs the EIP-712 domain and is
 * the indexer's `signedOfferEip712.ts`.
 */

/** The 31 fields, in struct order, with their EIP-712 types. Field order is
 *  load-bearing: it fixes the typehash and so every signature and order hash.
 *  The indexer's typehash test pins this list to the contract's type string. */
export const SIGNED_OFFER_FIELDS = Object.freeze([
  { name: 'offerType', type: 'uint8' },
  { name: 'lendingAsset', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'amountMax', type: 'uint256' },
  { name: 'interestRateBps', type: 'uint256' },
  { name: 'interestRateBpsMax', type: 'uint256' },
  { name: 'collateralAsset', type: 'address' },
  { name: 'collateralAmount', type: 'uint256' },
  { name: 'collateralAmountMax', type: 'uint256' },
  { name: 'durationDays', type: 'uint256' },
  { name: 'assetType', type: 'uint8' },
  { name: 'collateralAssetType', type: 'uint8' },
  { name: 'tokenId', type: 'uint256' },
  { name: 'quantity', type: 'uint256' },
  { name: 'collateralTokenId', type: 'uint256' },
  { name: 'collateralQuantity', type: 'uint256' },
  { name: 'prepayAsset', type: 'address' },
  { name: 'allowsPartialRepay', type: 'bool' },
  { name: 'allowsPrepayListing', type: 'bool' },
  { name: 'allowsParallelSale', type: 'bool' },
  { name: 'expiresAt', type: 'uint64' },
  { name: 'fillMode', type: 'uint8' },
  { name: 'periodicInterestCadence', type: 'uint8' },
  { name: 'refinanceTargetLoanId', type: 'uint256' },
  { name: 'useFullTermInterest', type: 'bool' },
  // #1949 — the maker's Full tariff opt-in rides the artifact they sign.
  { name: 'creatorFull', type: 'bool' },
  { name: 'creatorMaxCStar', type: 'uint256' },
  { name: 'creatorAllowFullDowngrade', type: 'bool' },
  { name: 'signer', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
].map((f) => Object.freeze(f)));

/** The 31 field names in struct order. */
export const SIGNED_OFFER_FIELD_NAMES = Object.freeze(SIGNED_OFFER_FIELDS.map((f) => f.name));

/** The stored wire form of each EIP-712 type: an address lowercased, a bool
 *  as a JSON boolean, a uint as a canonical decimal string (no sign, no
 *  leading zero) within its width. */
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DEC = /^(0|[1-9][0-9]*)$/;

function wireValueProblem(type, value) {
  if (type === 'address') return typeof value === 'string' && ADDRESS.test(value) ? null : 'a lowercase address';
  if (type === 'bool') return typeof value === 'boolean' ? null : 'a boolean';
  const width = /^uint(\d+)$/.exec(type);
  if (width) {
    if (typeof value !== 'string' || !DEC.test(value)) return 'a canonical decimal string';
    return BigInt(value) < 1n << BigInt(width[1]) ? null : `within ${type}`;
  }
  return `a known type (${type})`;
}

/** The canonical `order_json`: the 31 fields in struct order. Stable key
 *  order makes the same order serialize to the same bytes, so two copies are
 *  comparable as strings. The order must already be in wire form. */
export function canonicalOrderJson(order) {
  const o = {};
  for (const name of SIGNED_OFFER_FIELD_NAMES) o[name] = order[name];
  return JSON.stringify(o);
}

/**
 * Read a stored `order_json`. Returns `{ order }` only when the text is the
 * canonical serialization of an object carrying exactly the 31 fields, each
 * in its wire form; otherwise `{ error }`, naming the first problem.
 */
export function parseStoredOrderJson(json) {
  if (typeof json !== 'string') return { error: 'order_json is not text' };
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: 'order_json is not JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'order_json is not an object' };
  }
  const keys = Object.keys(parsed);
  for (const k of keys) {
    if (!SIGNED_OFFER_FIELD_NAMES.includes(k)) return { error: `order_json carries an unknown field ${k}` };
  }
  for (const { name, type } of SIGNED_OFFER_FIELDS) {
    if (!Object.hasOwn(parsed, name)) return { error: `order_json lacks ${name}` };
    const problem = wireValueProblem(type, parsed[name]);
    if (problem) return { error: `order_json ${name} is not ${problem}` };
  }
  if (canonicalOrderJson(parsed) !== json) {
    return { error: 'order_json is not in canonical form (field order or spacing)' };
  }
  return { order: parsed };
}

/** The `signed_offers` columns that copy a field of the order, as the row
 *  stores them: INTEGER columns as numbers, TEXT columns as the wire string.
 *  The book filters, sorts and summarizes on these, so each must equal the
 *  order a taker replays. */
export function signedOfferColumns(order) {
  return {
    signer: order.signer,
    offer_type: Number(order.offerType),
    lending_asset: order.lendingAsset,
    collateral_asset: order.collateralAsset,
    duration_days: Number(order.durationDays),
    asset_type: Number(order.assetType),
    collateral_asset_type: Number(order.collateralAssetType),
    interest_rate_bps: Number(order.interestRateBps),
    interest_rate_bps_max: Number(order.interestRateBpsMax),
    amount: order.amount,
    amount_max: order.amountMax,
    collateral_amount: order.collateralAmount,
    collateral_amount_max: order.collateralAmountMax,
    fill_mode: Number(order.fillMode),
    expires_at: Number(order.expiresAt),
    deadline: Number(order.deadline),
    nonce: order.nonce,
  };
}

/**
 * Whether a stored `signed_offers` row is internally consistent: its
 * `order_json` passes `parseStoredOrderJson`, and every promoted column
 * equals the order field it copies. Returns null when it is, else the first
 * problem. The signature and the order hash are not judged here (see the
 * header).
 */
export function signedOfferRowProblem(row) {
  const parsed = parseStoredOrderJson(row.order_json);
  if ('error' in parsed) return parsed.error;
  const expected = signedOfferColumns(parsed.order);
  for (const [column, value] of Object.entries(expected)) {
    if (row[column] !== value) {
      return `${column} is ${JSON.stringify(row[column])} but the order says ${JSON.stringify(value)}`;
    }
  }
  return null;
}
