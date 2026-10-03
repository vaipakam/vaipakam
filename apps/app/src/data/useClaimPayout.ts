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
  // Every lane the claim transaction pays, each with its own token. The
  // VPFI rebate is always 18-decimal VPFI. Held proceeds are paid in ONE
  // asset — the loan asset for an ERC-20 loan, the prepay asset for a
  // rental (ClaimFacet withdraws the whole accumulator in `principalAsset` /
  // `prepayAsset`) — so they are stated as an amount too (#2373 r5; an
  // earlier comment here assumed mixed assets and showed no number).
  const claimAssetMeta = useTokenMeta(loan?.claim.asset ?? undefined);
  const surplusMeta = useTokenMeta(loan?.claim.surplus?.asset);
  const extraMeta = useTokenMeta(loan?.claim.extraCollateral?.asset);
  const hasHeld = loan !== undefined && loan.role === 'lender' && loan.claim.heldForLender > 0n;
  const heldMeta = useTokenMeta(hasHeld ? (loan?.claim.heldAsset ?? undefined) : undefined);
  if (!loan) return null;
  const labels = copy.claims.row;
  const base = laneAmount(loan.claim.amount, claimAssetMeta);
  // A held asset the probe could not resolve is stated as unreadable, not
  // as loading: no read is in flight that could ever name it.
  const held = hasHeld
    ? laneAmount(loan.claim.heldForLender, loan.claim.heldAsset ? heldMeta : { isError: true })
    : null;
  const rebateStr =
    loan.claim.lifRebate > 0n
      ? labels.rebateAmount(formatTokenAmount(loan.claim.lifRebate, 18))
      : null;
  const defaulted = loan.status === 'defaulted' || loan.status === 'liquidated';
  // Claimable proper-close group: repaid or internal_matched. NOT
  // `settled` — ClaimFacet rejects Settled on both claim paths (claims
  // already consumed), and the claimables hook filters those out.
  const properClose = loan.status === 'repaid' || loan.status === 'internal_matched';
  const collateralStr = collateralMeta.data
    ? `${formatTokenAmount(loan.collateralAmount, collateralMeta.data.decimals)} ${collateralMeta.data.symbol}`
    : 'collateral';

  let what: string;
  let why: string;
  /** Optional one-line comparison or caveat beside the payout. */
  let note: string | undefined;
  let provisional = false;
  if (isRental) {
    what = rentalPayoutWhat({
      role: loan.role,
      base,
      held,
      nft: `NFT ${shortAddress(loan.lendingAsset)} #${loan.tokenId}`,
      labels,
    });
    why = loan.role === 'lender' ? labels.whyRentalEnded : labels.whyRentalClosed;
  } else if (loan.role === 'lender') {
    const kind = properClose ? 'proper' : loan.status === 'fallback_pending' ? 'fallback' : 'default';
    what = lenderPayoutWhat({
      kind,
      base,
      nftClaim: nftClaimLabel(loan.claim),
      held,
      principalPlusInterest: principalMeta.data
        ? labels.principalPlusInterest(
            formatTokenAmount(loan.principal, principalMeta.data.decimals),
            principalMeta.data.symbol,
          )
        : null,
      collateral: collateralStr,
      labels,
    });
    if (kind === 'proper') {
      why = loan.status === 'repaid' ? labels.whyRepaidLender : labels.whyInternalMatchLender;
    } else if (kind === 'fallback') {
      why = labels.whyFallbackPending;
      // #2373 r3 (P1) — `claimAsLender` first attempts an internal match
      // (the app sends no retry-swap quotes, so that is the only rewrite it
      // can trigger), and a full or partial match pays the loan asset
      // instead. What is recorded now is therefore not a promise.
      note = labels.fallbackMayChange;
      provisional = true;
    } else {
      why = labels.whyDefaultLender;
      // UX3-005 — say what the recovery is and what the app cannot know
      // about it. #2373 r1 (P1): no read here carries what the loan owed
      // when it defaulted, and the loan's current principal is not what the
      // holder lent, so no shortfall is computed; the note states that
      // unknown instead.
      note = defaultRecoveryNote({
        hasHeld,
        // #2373 r2 — from the RAW claim, not from whether the amount could
        // be formatted yet: a cash recovery whose symbol is still loading
        // is not "the collateral itself".
        inKind: loan.claim.amount === 0n,
        labels,
      });
    }
  } else {
    what = borrowerPayoutWhat({
      status: loan.status,
      base,
      returnedNft: nftClaimLabel(loan.claim),
      rebate: rebateStr,
      // The frozen swap-to-repay surplus.
      surplus: loan.claim.surplus ? laneAmount(loan.claim.surplus.amount, surplusMeta) : null,
      // Collateral still liened in a different asset from the claim row.
      extraCollateral: loan.claim.extraCollateral
        ? laneAmount(loan.claim.extraCollateral.amount, extraMeta)
        : null,
      collateral: collateralStr,
      labels,
    });
    why = defaulted
      ? labels.whyDefaultBorrower
      : loan.status === 'internal_matched'
        ? labels.whyInternalMatchBorrower
        : labels.whyRepaidBorrower;
  }

  return { what, why, note, provisional };
}

type RowLabels = typeof copy.claims.row;

/** What a claim's confirmation says it pays (#2373 r5/r6). A stated
 *  unknown — checking, could not confirm, nothing waiting — WINS over any
 *  payout text, because a failed background refetch keeps the previous data
 *  while the page already reports the payout as unconfirmed. Null means the
 *  caller falls back to its generic description (no claim read yet). */
export function receiptPayout(
  unknown: string | null,
  text: Pick<ClaimPayoutText, 'what'> | null,
): string | null {
  return unknown ?? text?.what ?? null;
}

/** One fungible lane's amount, as far as the app knows it (#2373 r5 root
 *  fix). Every lane — the claim row, the swap surplus, added collateral,
 *  held proceeds — goes through this one type, so a lane is never left out
 *  while its token details load, and a token whose details cannot be read
 *  at all is said to be unreadable instead of loading forever. */
export type LaneAmount =
  | { kind: 'known'; text: string }
  | { kind: 'loading' }
  | { kind: 'unreadable' };

export function laneAmount(
  amount: bigint,
  meta: { data?: { decimals: number; symbol: string }; isError: boolean },
): LaneAmount | null {
  if (amount <= 0n) return null;
  if (meta.data) {
    return { kind: 'known', text: `${formatTokenAmount(amount, meta.data.decimals)} ${meta.data.symbol}` };
  }
  return meta.isError ? { kind: 'unreadable' } : { kind: 'loading' };
}

/** The amount as words usable inside a sentence. */
export function amountPhrase(amount: LaneAmount, labels: RowLabels): string {
  if (amount.kind === 'known') return amount.text;
  return amount.kind === 'loading' ? labels.amountLoadingInline : labels.amountUnreadableInline;
}

/** Join lanes into one line that opens a sentence. */
function joinLanes(lanes: (string | null)[]): string {
  return capitalizeFirst(lanes.filter((l): l is string => Boolean(l)).join(' + '));
}

/** The NFT a claim row pays, named — or null for a fungible claim. A
 *  non-fungible claim carries `amount == 0`, so it must be named from the
 *  row's own asset type and token id or it vanishes beside other lanes. */
export function nftClaimLabel(claim: {
  asset: string | null;
  assetType: number;
  tokenId: bigint;
  quantity: bigint;
}): string | null {
  if (claim.assetType === AssetType.ERC20 || !claim.asset) return null;
  const qty = claim.assetType === AssetType.ERC1155 && claim.quantity > 1n ? ` ×${claim.quantity}` : '';
  return `NFT ${shortAddress(claim.asset)} #${claim.tokenId}${qty}`;
}

/** A rental claim (#2373 r5). Pure. The lender's fee payout and held
 *  proceeds are stated, or stated as loading / unreadable, never dropped. */
export function rentalPayoutWhat(args: {
  role: 'lender' | 'borrower';
  base: LaneAmount | null;
  held: LaneAmount | null;
  nft: string;
  labels: RowLabels;
}): string {
  const { labels } = args;
  if (args.role === 'borrower') {
    return args.base
      ? capitalizeFirst(labels.bufferBack(amountPhrase(args.base, labels)))
      : labels.prepaidBufferBack;
  }
  const main = args.base
    ? labels.feesNftBack(amountPhrase(args.base, labels), args.nft)
    : labels.rentalFeesNftBack(args.nft);
  return joinLanes([main, args.held ? labels.heldFor(amountPhrase(args.held, labels)) : null]);
}

/** The lender's payout (#2373 r4/r5). Pure, so the rule is tested rather
 *  than read. The claim row's own payout — an amount (known, loading or
 *  unreadable) or an NFT — comes first, and held proceeds sit beside it,
 *  never instead of it. */
export function lenderPayoutWhat(args: {
  kind: 'proper' | 'fallback' | 'default';
  base: LaneAmount | null;
  nftClaim: string | null;
  held: LaneAmount | null;
  /** A proper close with no amount named: principal + interest, described. */
  principalPlusInterest: string | null;
  /** Describes the collateral when the claim names nothing. */
  collateral: string;
  labels: RowLabels;
}): string {
  const { labels } = args;
  const heldLane = args.held ? labels.heldFor(amountPhrase(args.held, labels)) : null;
  const named = args.base?.kind === 'known' ? args.base.text : args.nftClaim;
  const unnamedAmount = args.base && args.base.kind !== 'known' ? amountPhrase(args.base, labels) : null;
  if (args.kind === 'proper') {
    if (named || unnamedAmount) return joinLanes([named ?? unnamedAmount, heldLane]);
    if (heldLane) return joinLanes([heldLane]);
    return args.principalPlusInterest ?? labels.repaidFunds;
  }
  if (args.kind === 'fallback') {
    const main = named
      ? labels.collateralLabel(named)
      : (unnamedAmount ?? labels.collateralLabel(args.collateral));
    return labels.provisionalAmount(joinLanes([main, heldLane]));
  }
  if (named) return labels.recoveredFromDefault(named, heldLane ? ` + ${heldLane}` : '');
  if (unnamedAmount || heldLane) return joinLanes([unnamedAmount, heldLane]);
  return labels.defaultRecovery(args.collateral);
}

/** The borrower's payout as ONE list of lanes (#2373 r3/r5). Pure. Every
 *  lane the claim transaction pays contributes a part; a lane whose token
 *  details are loading or unreadable says so rather than vanishing. */
export function borrowerPayoutWhat(args: {
  status: ClaimableLoan['status'];
  base: LaneAmount | null;
  /** An NFT handed back with no fungible amount — a lane in its own right,
   *  never one a rebate may stand in for. */
  returnedNft: string | null;
  rebate: string | null;
  surplus: LaneAmount | null;
  extraCollateral: LaneAmount | null;
  /** Describes the collateral when no lane names an amount. */
  collateral: string;
  labels: RowLabels;
}): string {
  const { labels } = args;
  const lanes: string[] = [];
  if (args.base?.kind === 'known') {
    lanes.push(
      args.status === 'repaid' ? labels.collateralBackWithAmount(args.base.text, '') : args.base.text,
    );
  } else if (args.base) {
    lanes.push(amountPhrase(args.base, labels));
  } else if (args.returnedNft) {
    lanes.push(labels.collateralBack(args.returnedNft));
  }
  if (args.rebate) lanes.push(args.rebate);
  if (args.surplus) lanes.push(labels.swapSurplus(amountPhrase(args.surplus, labels)));
  if (args.extraCollateral) lanes.push(labels.extraCollateral(amountPhrase(args.extraCollateral, labels)));
  if (lanes.length > 0) return joinLanes(lanes);
  if (args.status === 'defaulted' || args.status === 'liquidated') return labels.surplusAfterLiquidation;
  if (args.status === 'internal_matched') return labels.residualAfterMatch;
  return labels.collateralBack(args.collateral);
}

/** Upper-case the first character, so a list whose first lane is written
 *  as a continuation ("an amount left over…") still opens a sentence. */
function capitalizeFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

/** The line beside a defaulted lender claim (UX3-005, revised #2373 r1/r5).
 *  Pure, so the rule is tested rather than read. It NEVER states a figure:
 *  the amount the loan owed at default is not available to the app, and
 *  the loan's current principal is not a substitute (it moves with partial
 *  repayment and settlement, and a buyer of the position never lent it). */
export function defaultRecoveryNote(args: {
  hasHeld: boolean;
  /** True when the recovery is the collateral itself rather than an amount. */
  inKind: boolean;
  labels: Pick<RowLabels, 'compareInKind' | 'recoveryNotComparable'>;
}): string {
  // An in-kind recovery with held proceeds beside it is not purely "the
  // collateral itself", so it gets the general statement.
  if (args.inKind && !args.hasHeld) return args.labels.compareInKind;
  return args.labels.recoveryNotComparable;
}
