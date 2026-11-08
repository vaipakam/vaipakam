/**
 * LN-48 / LN-49 — what collecting one side of a loan's claim stands on, read
 * in one go through the wallet's connection: the loan as stored, who holds
 * that side's position, the protocol pause, the side's claim as the protocol
 * records it (the lender's net of what past sellers are owed, with the
 * sellers' share read beside it; the borrower's with its held surplus and any
 * collateral still under the loan's lien in another token), the wallet's
 * protected account mode (which decides where the payment lands), and the
 * protocol's own dry run of this very claim, which also screens the wallet
 * against the sanctions list and a frozen claim's recorded party.
 *
 * A claim moves nothing out of the wallet and asks no approval: the protocol
 * pays from the recorded party's vault to the position's holder.
 */
import { readPositionOwnerFor } from '../positions/positionNft';
import type { Abi, Log, PublicClient } from 'viem';
import { AdminFacetABI, ClaimFacetABI, LoanFacetABI, MetricsFacetABI, SellerClaimFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { claimVerdict } from '../eligibility/claim';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal, Verdict } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { payoutRoute, readProtection, type PayoutRoute, type Protection } from '../protection/payout';
import { routeChanged } from '../protection/payoutCopy';
import { askThrough } from '../tx/simulate';
import { matchIncentives } from './claimLog';
import type { PaidIncentive } from './claimOutcome';
import { claimLanes, extraLiened, sideClaimableStatus, type ClaimLane, type ClaimSide, type SideClaim } from './loanClaim';

type Hex = `0x${string}`;

const LOAN = LoanFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const METRICS = MetricsFacetABI as Abi;
const SELLER = SellerClaimFacetABI as Abi;
export const CLAIM = ClaimFacetABI as Abi;

/** The call each side's claim runs. */
export const claimFunction = (side: ClaimSide) => (side === 'lender' ? 'claimAsLender' : 'claimAsBorrower');

export interface LoanClaimReview {
  identity: string;
  loanId: bigint;
  side: ClaimSide;
  loan: LoanDetails;
  holder: Hex | null;
  paused: boolean | null;
  claim: SideClaim | null;
  /** The payouts the claim makes now, in order. */
  lanes: ClaimLane[];
  /** Lender side: what past sellers of the position take from the claim
   *  before the holder (already left out of the row); null when unread or
   *  the borrower side. */
  sellersShare: bigint | null;
  protection: Protection | null;
  /** Where the payment lands, from the wallet's mode and the paying vault. */
  route: PayoutRoute;
  /** The protocol's dry run of this claim now: null when it passes, its
   *  refusal when it refuses, 'unread' when it could not be run. Asked only
   *  when the app's own rule is open. */
  dryRun: Refusal | null | 'unread';
  verdict: Verdict;
  readAt: number;
}

async function maybe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

type ClaimableTuple = readonly [Hex, bigint, boolean, number, bigint, bigint, bigint, boolean];

/** One side's claim as the protocol records it, or null when a read failed. */
export async function readSideClaim(c: PublicClient, diamond: Hex, loanId: bigint, side: ClaimSide, at: { blockNumber?: bigint } = {}): Promise<SideClaim | null> {
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[]) => maybe(c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>);
  const lender = side === 'lender';
  const [row, surplus, lien] = await Promise.all([
    read<ClaimableTuple>(CLAIM, 'getClaimable', [loanId, lender]),
    lender ? null : read<readonly [Hex, bigint, boolean]>(CLAIM, 'getBorrowerSurplusClaim', [loanId]),
    lender ? null : read<{ asset: Hex; amount: bigint; released: boolean }>(METRICS, 'getLoanCollateralLien', [loanId]),
  ]);
  if (row === null || (!lender && (surplus === null || lien === null))) return null;
  const [asset, amount, claimed, assetType, tokenId, quantity, heldForLender, hasRentalNftReturn] = row;
  return {
    asset,
    amount,
    claimed,
    assetType: Number(assetType),
    tokenId,
    quantity,
    heldForLender,
    hasRentalNftReturn,
    surplus: surplus && !surplus[2] && surplus[1] > 0n ? { asset: surplus[0], amount: surplus[1] } : null,
    liened: lender ? null : extraLiened(lien, asset),
  };
}

export async function readLoanClaimReview(
  own: OwnStateClient,
  diamond: Hex,
  loanId: bigint,
  side: ClaimSide,
  identity: string,
  copy: Pick<CopyAccess, 'text'>,
): Promise<LoanClaimReview> {
  const account = own.account;
  const facts = await own
    .read(async (c: PublicClient) => {
      const loan = (await c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [loanId] })) as LoanDetails;
      const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => maybe(c.readContract({ address: diamond, abi, functionName, args }) as Promise<T>);
      const asked = sideClaimableStatus(side, Number(loan.status));
      const [holder, paused, claim, sellersShare, protection] = await Promise.all([
        // #3205: the side's LIVE holder through the position-NFT door; a
        // retired (or burned) token has none.
        maybe(readPositionOwnerFor(c, diamond, side === 'lender' ? loan.lenderTokenId : loan.borrowerTokenId)),
        read<boolean>(ADMIN, 'paused'),
        asked ? readSideClaim(c, diamond, loanId, side) : null,
        side === 'lender' && asked ? read<bigint>(SELLER, 'getSellersShareOfLenderClaim', [loanId]) : null,
        readProtection(c, diamond, account),
      ]);
      return { loan, holder, paused, claim, sellersShare, protection };
    })
    .then((x) => x.value);
  const readAt = Date.now();
  const { loan } = facts;
  const verdict = claimVerdict(
    { side, status: Number(loan.status), loanAssetType: Number(loan.assetType), paused: facts.paused, holder: facts.holder, claim: facts.claim },
    account,
    copy,
    readAt,
  );
  const lanes = facts.claim
    ? claimLanes(side, facts.claim, {
        assetType: Number(loan.assetType),
        principalAsset: loan.principalAsset,
        prepayAsset: loan.prepayAsset,
        tokenId: loan.tokenId,
        quantity: loan.quantity,
      })
    : [];
  let dryRun: LoanClaimReview['dryRun'] = null;
  if (verdict.state === 'open') {
    const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: CLAIM, functionName: claimFunction(side), args: [loanId], account }));
    dryRun = dry.kind === 'reverted' ? refusalFromError(dry.error) : dry.kind === 'unreadable' ? 'unread' : null;
  }
  // The claim pays from the vault of the party recorded for the side.
  const source = side === 'lender' ? loan.lender : loan.borrower;
  return {
    identity,
    loanId,
    side,
    loan,
    holder: facts.holder,
    paused: facts.paused,
    claim: facts.claim,
    lanes,
    sellersShare: facts.sellersShare,
    protection: facts.protection,
    route: payoutRoute(facts.protection, account, source),
    dryRun,
    verdict,
    readAt,
  };
}

/** Every loan field the receipt states or the claim's route depends on: a
 *  change to any reopens the review. */
export const CLAIM_STATED_LOAN_FIELDS = [
  'status',
  'assetType',
  'principalAsset',
  'collateralAsset',
  'lender',
  'borrower',
  'lenderTokenId',
  'borrowerTokenId',
] as const satisfies readonly (keyof LoanDetails)[];

const laneKey = (l: ClaimLane) => `${l.kind}:${l.asset.toLowerCase()}:${l.assetType}:${l.tokenId}:${l.amount}`;

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. A claim's figures do not move with prices: any change to a
 *  payout reopens the review. */
export function loanClaimChanged(a: LoanClaimReview, b: LoanClaimReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (CLAIM_STATED_LOAN_FIELDS.some((k) => a.loan[k] !== b.loan[k])) return text('repay.changedLoan');
  if (a.holder !== b.holder || a.paused !== b.paused) return text('repay.changedHolders');
  if (a.lanes.map(laneKey).join('|') !== b.lanes.map(laneKey).join('|') || a.sellersShare !== b.sellersShare) return text('loanClaim.changedPayout');
  if (routeChanged(a, b)) return text('payout.changed');
  if (a.verdict.state !== b.verdict.state || a.verdict.refusals[0]?.code !== b.verdict.refusals[0]?.code) return text('repay.changedVerdict');
  return null;
}

/** What stops the review here, in words (empty when nothing does). */
export function loanClaimBlockers(r: LoanClaimReview, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  if (r.verdict.state !== 'open') return [r.verdict.refusals[0]?.reason ?? ''];
  if (r.dryRun === 'unread') return [copy.text('loanClaim.dryRunUnread')];
  if (r.dryRun !== null) return [copy.format('repay.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

/** The matching rewards a claim's transaction paid the claimant (a lender
 *  claim on a loan in fallback runs the protocol's match first, with the
 *  claimant as its matcher), each with its token: the principal token of the
 *  leg's loan, read from the protocol's record of that loan. A token that
 *  could not be read stays null, and the finish card says so. */
export async function readPaidIncentives(own: OwnStateClient, diamond: Hex, r: Pick<LoanClaimReview, 'loanId' | 'loan'>, logs: readonly Log[]): Promise<PaidIncentive[]> {
  const paid = matchIncentives(logs, diamond, r.loanId, own.account);
  if (paid.length === 0) return [];
  const others = [...new Set(paid.filter((p) => p.loanId !== r.loanId).map((p) => p.loanId))];
  const assets = new Map<bigint, Hex | null>([[r.loanId, r.loan.principalAsset]]);
  if (others.length > 0) {
    const read = await maybe(
      own
        .read((c: PublicClient) =>
          Promise.all(others.map((id) => maybe(c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [id] }) as Promise<LoanDetails>))),
        )
        .then((x) => x.value),
    );
    others.forEach((id, i) => assets.set(id, read?.[i]?.principalAsset ?? null));
  }
  return paid.map((p) => ({ loanId: p.loanId, amount: p.amount, asset: assets.get(p.loanId) ?? null }));
}
