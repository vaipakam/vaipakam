/**
 * What a claim pays out, in words — the one composition every claim
 * surface reads (UX3-004, 2026-10-03 live review).
 *
 * Moved verbatim out of the Claims page's `ClaimRow`, which was the only
 * surface stating the amount: the Claim-everything checklist on the same
 * page said "your proceeds", the loan page's button said "Claim my funds",
 * and the Positions list carried a bare "Claim waiting" chip. A user being
 * asked to act on money sees the figure wherever they are asked.
 *
 * `what` is the payout (an exact amount whenever `getClaimable` named one,
 * otherwise a plain description that never overstates — see the branch
 * comments); `why` is the one-clause reason the claim exists.
 */
import { copy } from '../content/copy';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import { formatTokenAmount, shortAddress } from '../lib/format';
import type { ClaimableLoan } from './claimables';

export interface ClaimPayoutText {
  /** The payout itself. */
  what: string;
  /** Why the claim exists, in one clause. */
  why: string;
  /** A comparison worth stating beside the payout, when there is one. */
  note?: string;
  /** #2373 r3 — the payout is what is RECORDED now and the claim itself can
   *  change it (a fallback claim retries settlement first). Surfaces label it
   *  "recorded", never "you will receive". `what` already carries the
   *  qualifier, so a surface that ignores this flag still never promises. */
  provisional?: boolean;
}

export function useClaimPayoutText(loan: ClaimableLoan): ClaimPayoutText;
export function useClaimPayoutText(
  loan: ClaimableLoan | undefined,
): ClaimPayoutText | null;
/** Accepts `undefined` so a page can call it ABOVE its early returns (the
 *  hooks-order rule; #1511) before it knows whether a claim exists — the
 *  token-metadata reads it makes are disabled for an absent leg. */
export function useClaimPayoutText(
  loan: ClaimableLoan | undefined,
): ClaimPayoutText | null {
  // Rentals have an NFT principal leg and often no collateral — never
  // format them through the ERC-20 loan template.
  const isRental = loan !== undefined && loan.assetType !== AssetType.ERC20;
  const principalMeta = useTokenMeta(!loan || isRental ? undefined : loan.lendingAsset);
  const collateralMeta = useTokenMeta(loan?.collateralAsset);
  // UX-002 — getClaimable told us the exact asset + amount this claim
  // pays out; show the NUMBER on the money-collection screen instead
  // of "+ interest" or a description of a field. Two extra payout
  // lanes ride the same claim transaction (Codex #1156 r1):
  //   - lifRebate is always VPFI (18 dec) → shown numerically;
  //   - heldForLender ACCUMULATES potentially mixed assets on-chain
  //     (each park carries its own asset), so no single denomination
  //     is honest → shown qualitatively, never as a number.
  const claimAssetMeta = useTokenMeta(loan?.claim.asset ?? undefined);
  const surplusMeta = useTokenMeta(loan?.claim.surplus?.asset);
  const extraMeta = useTokenMeta(loan?.claim.extraCollateral?.asset);
  if (!loan) return null;
  const baseAmountStr =
    loan.claim.amount > 0n && claimAssetMeta.data
      ? `${formatTokenAmount(loan.claim.amount, claimAssetMeta.data.decimals)} ${claimAssetMeta.data.symbol}`
      : null;
  // #2373 r2 — a fungible amount whose token metadata has not loaded (or
  // failed). It is still an AMOUNT: never let a missing symbol turn it into
  // an in-kind description, a gross-collateral figure, or anything else the
  // claim read did not say.
  const amountPending = loan.claim.amount > 0n && baseAmountStr === null;
  const rebateStr =
    loan.claim.lifRebate > 0n
      ? copy.claims.row.rebateAmount(formatTokenAmount(loan.claim.lifRebate, 18))
      : null;
  const hasHeld = loan.role === 'lender' && loan.claim.heldForLender > 0n;
  const heldSuffix = hasHeld ? copy.claims.row.heldProceedsSuffix : '';
  // Per-branch composition below (Codex #1156 r2): a blended string
  // can't distinguish "this number IS the collateral leg" from "this
  // is only a VPFI rebate", and a held-only lane must still surface.
  const defaulted = loan.status === 'defaulted' || loan.status === 'liquidated';
  // Claimable proper-close group: repaid or internal_matched. NOT
  // `settled` — ClaimFacet rejects Settled on both claim paths (claims
  // already consumed), and the claimables hook filters those out.
  const properClose =
    loan.status === 'repaid' || loan.status === 'internal_matched';

  const collateralStr = collateralMeta.data
    ? `${formatTokenAmount(loan.collateralAmount, collateralMeta.data.decimals)} ${collateralMeta.data.symbol}`
    : 'collateral';

  let what: string;
  let why: string;
  /** Optional one-line comparison or caveat beside the payout. */
  let note: string | undefined;
  let provisional = false;
  if (isRental) {
    const nft = `NFT ${shortAddress(loan.lendingAsset)} #${loan.tokenId}`;
    if (loan.role === 'lender') {
      // getClaimable's amount is the fee payout (in the prepay asset)
      // when fungible fees are due — show the number (Codex #1156 r2).
      what = baseAmountStr
        ? copy.claims.row.feesNftBack(baseAmountStr, nft)
        : copy.claims.row.rentalFeesNftBack(nft);
      why = copy.claims.row.whyRentalEnded;
    } else {
      what = baseAmountStr
        ? copy.claims.row.bufferBack(baseAmountStr)
        : copy.claims.row.prepaidBufferBack;
      why = copy.claims.row.whyRentalClosed;
    }
  } else if (loan.role === 'lender') {
    if (properClose) {
      what = baseAmountStr
        ? copy.claims.row.amountWithSuffix(baseAmountStr, heldSuffix)
        : hasHeld
          ? copy.claims.row.heldProceeds
          : principalMeta.data
            ? copy.claims.row.principalPlusInterest(
                formatTokenAmount(loan.principal, principalMeta.data.decimals),
                principalMeta.data.symbol,
              )
            : copy.claims.row.repaidFunds;
      why =
        loan.status === 'repaid'
          ? copy.claims.row.whyRepaidLender
          : copy.claims.row.whyInternalMatchLender;
    } else if (loan.status === 'fallback_pending') {
      // #2373 r2 — the lender's SLICE: when the fallback is oracle-priced
      // and the collateral exceeds the lender's entitlement, getClaimable
      // records only that slice (the rest goes to treasury and borrower).
      // The gross collateral is the answer only when the claim names no
      // amount at all.
      what = copy.claims.row.provisionalAmount(
        baseAmountStr
          ? copy.claims.row.collateralLabel(baseAmountStr)
          : amountPending
            ? copy.claims.row.amountLoading
            : copy.claims.row.collateralLabel(collateralStr),
      );
      why = copy.claims.row.whyFallbackPending;
      // #2373 r3 (P1) — `claimAsLender` first attempts an internal match
      // (the app sends no retry-swap quotes, so that is the only rewrite it
      // can trigger), and a full or partial match pays the loan asset
      // instead. What is recorded now is therefore not a promise.
      note = copy.claims.row.fallbackMayChange;
      provisional = true;
    } else {
      // Liquid-collateral defaults settle by swap (proceeds in the
      // loan asset); in-kind paths hand over the collateral itself.
      // getClaimable names the exact asset + amount, so show it; only
      // when the read gave no fungible amount (pure in-kind transfer)
      // fall back to a plain-language title.
      what = baseAmountStr
        ? copy.claims.row.recoveredFromDefault(baseAmountStr, heldSuffix)
        : amountPending
          ? copy.claims.row.amountLoading
          : hasHeld
            ? copy.claims.row.heldProceedsDefault
            : copy.claims.row.defaultRecovery(collateralStr);
      why = copy.claims.row.whyDefaultLender;
      // UX3-005 — say what the recovery is and what the app cannot know
      // about it. #2373 r1 (P1): an earlier version compared the recovery
      // with `loan.principal` and called it "what you lent". That field is
      // the loan's CURRENT principal — partial repayment and settlement
      // move it — and a holder who bought the position never lent it at
      // all. No read here carries what the loan owed when it defaulted, so
      // no shortfall is computed; the note states that unknown instead.
      note = defaultRecoveryNote({
        hasHeld,
        // #2373 r2 — from the RAW claim, not from whether the amount could
        // be formatted yet: a cash recovery whose symbol is still loading
        // is not "the collateral itself".
        inKind: loan.claim.amount === 0n,
        labels: copy.claims.row,
      });
    }
  } else {
    // The borrower's claim: every lane the transaction pays (#2373 r3).
    what = borrowerPayoutWhat({
      status: loan.status,
      base: baseAmountStr,
      amountPending,
      returnedNft:
        loan.collateralAssetType !== AssetType.ERC20 && loan.status === 'repaid'
          ? `NFT ${shortAddress(loan.collateralAsset)} #${loan.collateralTokenId}`
          : null,
      rebate: rebateStr,
      // The frozen swap-to-repay surplus.
      surplus: loan.claim.surplus
        ? surplusMeta.data
          ? `${formatTokenAmount(loan.claim.surplus.amount, surplusMeta.data.decimals)} ${surplusMeta.data.symbol}`
          : 'pending'
        : null,
      // Collateral still liened in a different asset from the claim row.
      extraCollateral: loan.claim.extraCollateral
        ? extraMeta.data
          ? `${formatTokenAmount(loan.claim.extraCollateral.amount, extraMeta.data.decimals)} ${extraMeta.data.symbol}`
          : 'pending'
        : null,
      collateral: collateralStr,
      labels: copy.claims.row,
    });
    why = defaulted
      ? copy.claims.row.whyDefaultBorrower
      : loan.status === 'internal_matched'
        ? copy.claims.row.whyInternalMatchBorrower
        : copy.claims.row.whyRepaidBorrower;
  }

  return { what, why, note, provisional };
}

/** The borrower's payout as ONE list of lanes (#2373 r3 root fix). Pure,
 *  so the rule is tested rather than read. Every lane the claim transaction
 *  pays contributes a part; a lane whose token details are still loading
 *  (`'pending'`, or `amountPending` for the base) contributes a loading
 *  part rather than vanishing. The per-status branches this replaced each
 *  re-decided which lanes to show, and each review round found another lane
 *  one of them dropped. */
export function borrowerPayoutWhat(args: {
  status: ClaimableLoan['status'];
  /** The claim row's formatted amount, when it has one and it loaded. */
  base: string | null;
  /** The claim row has an amount whose token details have not loaded. */
  amountPending: boolean;
  /** An NFT handed back with no fungible amount (a repaid NFT-collateral
   *  loan) — a lane in its own right, never one a rebate may stand in for. */
  returnedNft: string | null;
  rebate: string | null;
  surplus: string | 'pending' | null;
  extraCollateral: string | 'pending' | null;
  /** Describes the collateral when no lane names an amount. */
  collateral: string;
  labels: Pick<
    typeof copy.claims.row,
    | 'collateralBackWithAmount'
    | 'collateralBack'
    | 'amountLoading'
    | 'swapSurplus'
    | 'swapSurplusPending'
    | 'extraCollateral'
    | 'extraCollateralPending'
    | 'surplusAfterLiquidation'
    | 'residualAfterMatch'
  >;
}): string {
  const { labels } = args;
  const lanes: string[] = [];
  if (args.base) {
    lanes.push(args.status === 'repaid' ? labels.collateralBackWithAmount(args.base, '') : args.base);
  } else if (args.amountPending) {
    lanes.push(labels.amountLoading);
  } else if (args.returnedNft) {
    lanes.push(labels.collateralBack(args.returnedNft));
  }
  if (args.rebate) lanes.push(args.rebate);
  if (args.surplus) {
    lanes.push(args.surplus === 'pending' ? labels.swapSurplusPending : labels.swapSurplus(args.surplus));
  }
  if (args.extraCollateral) {
    lanes.push(
      args.extraCollateral === 'pending'
        ? labels.extraCollateralPending
        : labels.extraCollateral(args.extraCollateral),
    );
  }
  if (lanes.length > 0) return capitalizeFirst(lanes.join(' + '));
  if (args.status === 'defaulted' || args.status === 'liquidated') return labels.surplusAfterLiquidation;
  if (args.status === 'internal_matched') return labels.residualAfterMatch;
  return labels.collateralBack(args.collateral);
}

/** Upper-case the first character, so a list whose first lane is written
 *  as a continuation ("an amount left over…") still opens a sentence. */
function capitalizeFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

/** The line beside a defaulted lender claim (UX3-005, revised #2373 r1).
 *  Pure, so the rule is tested rather than read. It NEVER states a figure:
 *  the amount the loan owed at default is not available to the app, and
 *  the loan's current principal is not a substitute (it moves with partial
 *  repayment and settlement, and a buyer of the position never lent it). */
export function defaultRecoveryNote(args: {
  hasHeld: boolean;
  /** True when the recovery is the collateral itself rather than an amount. */
  inKind: boolean;
  labels: Pick<typeof copy.claims.row, 'compareUnknownHeld' | 'compareInKind' | 'recoveryNotComparable'>;
}): string {
  if (args.hasHeld) return args.labels.compareUnknownHeld;
  if (args.inKind) return args.labels.compareInKind;
  return args.labels.recoveryNotComparable;
}
