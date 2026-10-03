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
  if (!loan) return null;
  const baseAmountStr =
    loan.claim.amount > 0n && claimAssetMeta.data
      ? `${formatTokenAmount(loan.claim.amount, claimAssetMeta.data.decimals)} ${claimAssetMeta.data.symbol}`
      : null;
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
  /** Optional one-line comparison (UX3-005); only the defaulted-lender
   *  branch sets it today. */
  let note: string | undefined;
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
      what = copy.claims.row.collateralLabel(collateralStr);
      why = copy.claims.row.whyFallbackPending;
    } else {
      // Liquid-collateral defaults settle by swap (proceeds in the
      // loan asset); in-kind paths hand over the collateral itself.
      // getClaimable names the exact asset + amount, so show it; only
      // when the read gave no fungible amount (pure in-kind transfer)
      // fall back to a plain-language title.
      what = baseAmountStr
        ? copy.claims.row.recoveredFromDefault(baseAmountStr, heldSuffix)
        : hasHeld
          ? copy.claims.row.heldProceedsDefault
          : copy.claims.row.defaultRecovery(collateralStr);
      why = copy.claims.row.whyDefaultLender;
      // UX3-005 — set what was recovered against what was lent, stating
      // only what the reads substantiate. A same-asset recovery with no
      // held proceeds compares exactly; anything else says WHY it cannot
      // be compared rather than leaving the comparison out. Interest is
      // never claimed as owed or lost here: the claim read does not carry
      // what was due at default.
      note = defaultRecoveryNote({
        hasHeld,
        recovered: baseAmountStr ? loan.claim.amount : null,
        sameAsset:
          loan.claim.asset !== null &&
          loan.claim.asset.toLowerCase() === loan.lendingAsset.toLowerCase(),
        lent: BigInt(loan.principal),
        fmtLent: principalMeta.data
          ? (v: bigint) =>
              `${formatTokenAmount(v, principalMeta.data!.decimals)} ${principalMeta.data!.symbol}`
          : null,
        labels: copy.claims.row,
      });
    }
  } else if (defaulted) {
    // After a liquidation only a residue (if any) is claimable — never
    // promise the full original collateral, and never say "you repaid".
    what = baseAmountStr
      ? copy.claims.row.amountWithSuffix(baseAmountStr, rebateStr ? ` + ${rebateStr}` : '')
      : (rebateStr ?? copy.claims.row.surplusAfterLiquidation);
    why = copy.claims.row.whyDefaultBorrower;
  } else if (loan.status === 'internal_matched') {
    // An internal match leaves the borrower a residual and/or VPFI
    // rebate at most — never promise the full collateral back.
    what = baseAmountStr
      ? copy.claims.row.amountWithSuffix(baseAmountStr, rebateStr ? ` + ${rebateStr}` : '')
      : (rebateStr ?? copy.claims.row.residualAfterMatch);
    why = copy.claims.row.whyInternalMatchBorrower;
  } else {
    what = baseAmountStr
      ? copy.claims.row.collateralBackWithAmount(baseAmountStr, rebateStr ? ` + ${rebateStr}` : '')
      : (rebateStr ?? copy.claims.row.collateralBack(collateralStr));
    why = copy.claims.row.whyRepaidBorrower;
  }

  return { what, why, note };
}

/** The recovered-vs-lent line on a defaulted lender claim (UX3-005).
 *  Pure, so the rule is tested rather than read: an exact comparison
 *  only when the recovery is a single amount in the asset that was lent;
 *  otherwise the reason it cannot be compared. `undefined` only while the
 *  lent asset's metadata is still loading. */
export function defaultRecoveryNote(args: {
  hasHeld: boolean;
  /** The fungible amount recovered, or null for an in-kind recovery. */
  recovered: bigint | null;
  sameAsset: boolean;
  lent: bigint;
  /** Formats an amount of the lent asset; null while metadata loads. */
  fmtLent: ((v: bigint) => string) | null;
  labels: Pick<
    typeof copy.claims.row,
    'compareUnknownHeld' | 'compareInKind' | 'compareOtherAsset' | 'shortfallVsLent' | 'coversLent'
  >;
}): string | undefined {
  const { labels } = args;
  if (args.hasHeld) return labels.compareUnknownHeld;
  if (args.recovered === null) return labels.compareInKind;
  if (!args.sameAsset) return labels.compareOtherAsset;
  if (!args.fmtLent) return undefined;
  return args.recovered < args.lent
    ? labels.shortfallVsLent(args.fmtLent(args.lent - args.recovered), args.fmtLent(args.lent))
    : labels.coversLent(args.fmtLent(args.lent));
}
