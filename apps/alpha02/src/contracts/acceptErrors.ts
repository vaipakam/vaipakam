/**
 * `OfferAcceptFacet.AcceptError` — the vocabulary `previewAccept`
 * answers in, mirrored for the app (#1645).
 *
 * WHY A MIRROR EXISTS AT ALL: Solidity enums encode as `uint8` and do
 * not appear in the ABI, so the ABI tells us the width and nothing
 * else. The names live only in `OfferAcceptFacet.sol`. A hand-kept copy
 * is the shape that caused the watcher offer-decode drift, so
 * `scripts/check-accept-errors.mjs` pins `ACCEPT_ERROR_NAMES` to the
 * contract's ordered member list on every typecheck. Order is
 * load-bearing — the numbers are positional, and the enum's own
 * comments promise "APPENDED — prior values stay stable" at nearly
 * every member.
 *
 * WHY THE COPY IS HERE AND NOT INVENTED PER-SCREEN: several members of
 * that enum carry an explicit instruction from the contract about what
 * a surface built on them must say, because saying the wrong thing
 * sends the reader somewhere that cannot help. `SaleListingTermsStale`
 * must blame the LISTING, never the buyer's terms — the buyer signed
 * the listing faithfully and re-signing reproduces the same bad
 * vehicle. `ProtocolPaused` must not give a listing-, offer- or
 * buyer-specific reason, since none of them are actionable while the
 * protocol is paused. `VaultUpgradeRequired` must point at the vault
 * upgrade rather than at a relist, which the same floor would block.
 * Those are honoured below and should not be reworded casually.
 *
 * WHAT THIS SURFACE MUST NOT CLAIM: `previewAccept`'s struct carries
 * `effectivePrincipal`, `interestRateBps`, `collateralAmount`,
 * `lifEstimate` and `collateralResidualRefund` — and no health figures.
 * So the solvency-floor copy states the shortfall WITHOUT quoting a
 * number. The contract is emphatic that a health figure may be shown
 * for the floor code and no other; here it cannot be shown for any,
 * because this view does not carry one. Quoting `0`, or reusing a
 * figure from a different read, would assert a measurement this call
 * never made.
 */
import { copy } from '../content/copy';

/**
 * The contract's members, in contract order. Index === the on-chain
 * `uint8`. Pinned by `scripts/check-accept-errors.mjs` — edit only to
 * follow `OfferAcceptFacet.sol`, never to reshape this list.
 */
export const ACCEPT_ERROR_NAMES = [
  'None',
  'OfferAlreadyAccepted',
  'SanctionedAcceptor',
  'SanctionedCreator',
  'AssetPaused',
  'CountriesNotCompatible',
  'RiskAndTermsConsentRequired',
  'KYCRequired',
  'OfferExpired',
  'OfferPartiallyFilled',
  'SaleLoanNotActive',
  'SaleSelfBuy',
  'OfferIsCancelled',
  'SaleLoanPastMaturity',
  'SalePositionBelowSolvencyFloor',
  'SaleAdmissionBlocked',
  'SaleListingTermsStale',
  'ProtocolPaused',
  'VaultUpgradeRequired',
  'SelfTrade',
] as const;

export type AcceptErrorName = (typeof ACCEPT_ERROR_NAMES)[number];

/** `None` — the accept is not blocked by any classifier. */
export const ACCEPT_OK = 0;

/**
 * Per-member copy. Keyed by name rather than by index so a member
 * inserted upstream (which the enum forbids, but which the guard would
 * catch) cannot silently re-point an existing message at a different
 * condition.
 */
const ACCEPT_ERROR_COPY: Record<AcceptErrorName, string | null> = {
  None: null,
  OfferAlreadyAccepted: copy.errors.acceptBlocked.alreadyAccepted,
  SanctionedAcceptor: copy.errors.acceptBlocked.flaggedAcceptor,
  SanctionedCreator: copy.errors.acceptBlocked.flaggedCreator,
  AssetPaused: copy.errors.acceptBlocked.assetPaused,
  CountriesNotCompatible: copy.errors.acceptBlocked.countryBlocked,
  RiskAndTermsConsentRequired: copy.errors.acceptBlocked.consentRequired,
  KYCRequired: copy.errors.acceptBlocked.kycBlocked,
  OfferExpired: copy.errors.acceptBlocked.expired,
  OfferPartiallyFilled: copy.errors.acceptBlocked.partiallyFilled,
  SaleLoanNotActive: copy.errors.acceptBlocked.saleLoanNotActive,
  SaleSelfBuy: copy.errors.acceptBlocked.saleSelfBuy,
  OfferIsCancelled: copy.errors.acceptBlocked.cancelled,
  SaleLoanPastMaturity: copy.errors.acceptBlocked.saleLoanPastMaturity,
  SalePositionBelowSolvencyFloor: copy.errors.acceptBlocked.saleBelowFloor,
  SaleAdmissionBlocked: copy.errors.acceptBlocked.saleAdmissionBlocked,
  SaleListingTermsStale: copy.errors.acceptBlocked.saleListingStale,
  ProtocolPaused: copy.errors.acceptBlocked.protocolPaused,
  VaultUpgradeRequired: copy.errors.acceptBlocked.vaultUpgradeRequired,
  SelfTrade: copy.errors.acceptBlocked.selfTrade,
};

/**
 * Turn a raw `errorCode` into something to show, or `null` when the
 * accept is clear.
 *
 * An out-of-range code is a REFUSAL we have no words for, not an
 * all-clear: the app can be older than the Diamond it is talking to,
 * and the enum grows by appending. Returning the generic refusal keeps
 * the failure on the safe side of that skew — the alternative would let
 * a newly-added blocker read as "fine" and walk the user into the
 * revert this whole path exists to prevent.
 */
export function acceptBlockReason(code: number): string | null {
  if (code === ACCEPT_OK) return null;
  const name = ACCEPT_ERROR_NAMES[code] as AcceptErrorName | undefined;
  if (name === undefined) return copy.errors.acceptBlocked.unknown;
  return ACCEPT_ERROR_COPY[name] ?? copy.errors.acceptBlocked.unknown;
}

/** Name for logs and test assertions. Never user-facing. */
export function acceptErrorName(code: number): string {
  return ACCEPT_ERROR_NAMES[code] ?? `Unknown(${code})`;
}
