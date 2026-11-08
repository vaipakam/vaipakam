/**
 * LN-48 / LN-49 — a loan's claim, side by side: what the protocol records as
 * owed to the holder of each position once the loan has ended, read as the
 * claim call itself reads it, and split into the payouts the call makes.
 *
 * The lender's claim (`claimAsLender`) pays, from the recorded lender's
 * vault: its claim row (an amount of a token, already net of what past
 * sellers of the position are owed, or an NFT), any funds held for the lender
 * from earlier top-ups, and on a rental the rented NFT itself. The
 * borrower's claim (`claimAsBorrower`), from the recorded borrower's vault:
 * its collateral row, a principal surplus held for the holder, and collateral
 * still under the loan's lien in a token the row cannot carry. Each payout is
 * paid on its own; the claim refuses only when every one is empty.
 *
 * The rules here mirror the protocol's own (`LibCloseoutFreeze`): which loan
 * states each side may claim in, and when a side still has something to pay.
 * The dry run stays the protocol's last word.
 */
type Hex = `0x${string}`;

export type ClaimSide = 'lender' | 'borrower';

/** `LibVaipakam.AssetType`. */
export const ASSET_ERC20 = 0;
export const ASSET_ERC721 = 1;
export const ASSET_ERC1155 = 2;

/** `LibVaipakam.LoanStatus`. */
const REPAID = 1;
const DEFAULTED = 2;
const FALLBACK_PENDING = 4;
const INTERNAL_MATCHED = 5;

const ZERO = '0x0000000000000000000000000000000000000000';

/** One side's claim, as `getClaimable` returns it, with the borrower's two
 *  further rows. */
export interface SideClaim {
  asset: Hex;
  /** The lender row is net of past sellers' share, as the protocol states it. */
  amount: bigint;
  claimed: boolean;
  assetType: number;
  tokenId: bigint;
  quantity: bigint;
  /** Lender side: funds held for the lender (top-ups before the end). */
  heldForLender: bigint;
  /** Lender side: the loan lent an NFT, which comes back with the claim. */
  hasRentalNftReturn: boolean;
  /** Borrower side: the principal surplus held for the holder, unclaimed. */
  surplus: { asset: Hex; amount: bigint } | null;
  /** Borrower side: collateral still under the loan's lien in a token the
   *  collateral row does not carry, paid with it. */
  liened: { asset: Hex; amount: bigint } | null;
}

/** What a payout is, so it is named the same way everywhere. */
export type LaneKind = 'row' | 'held' | 'rentalReturn' | 'surplus' | 'liened';

/** One payout the claim makes. `amount` is a token amount, an ERC-1155
 *  quantity, or 1 for an ERC-721. */
export interface ClaimLane {
  kind: LaneKind;
  asset: Hex;
  assetType: number;
  tokenId: bigint;
  amount: bigint;
}

/** Whether `side` may claim on a loan in `status` at all. A borrower waits
 *  while the loan is in fallback: the lender's claim, or a cure, resolves it
 *  first. */
export function sideClaimableStatus(side: ClaimSide, status: number): boolean {
  if (status === REPAID || status === DEFAULTED || status === INTERNAL_MATCHED) return true;
  return side === 'lender' && status === FALLBACK_PENDING;
}

/** Whether the loan is in fallback (the lender's claim then settles it). */
export const isFallback = (status: number): boolean => status === FALLBACK_PENDING;

/** Whether a page shows `side`'s payout on a loan in `status`: when it can
 *  be collected, and also while it waits on a loan in fallback, so the
 *  borrower is told the payout exists and what it waits for instead of
 *  seeing nothing. */
export function sideShown(side: ClaimSide, status: number): boolean {
  return sideClaimableStatus(side, status) || isFallback(status);
}

/**
 * Whether the side still has a claim to run (unclaimed and something open).
 * On the lender side a claim a close-out recorded counts at a zero amount: a
 * forced close-out that received nothing still leaves one, and running it
 * closes the position. On the borrower side each row counts on its own flag.
 */
export function sideOpen(side: ClaimSide, c: SideClaim, loanAssetType: number): boolean {
  if (side === 'lender') {
    if (c.claimed) return false;
    return c.asset.toLowerCase() !== ZERO || c.amount > 0n || c.heldForLender > 0n || loanAssetType !== ASSET_ERC20 || c.assetType !== ASSET_ERC20;
  }
  return collateralRowOpen(c) || (c.surplus !== null && c.surplus.amount > 0n);
}

function collateralRowOpen(c: SideClaim): boolean {
  return !c.claimed && (c.amount > 0n || c.assetType !== ASSET_ERC20);
}

/** The loan fields a lane needs: what a rental lent and in what it paid. */
export interface LaneLoan {
  assetType: number;
  principalAsset: Hex;
  prepayAsset: Hex;
  tokenId: bigint;
  quantity: bigint;
}

/** The payouts the claim makes, in the order it makes them. Empty rows are
 *  left out: the protocol never withdraws them. */
export function claimLanes(side: ClaimSide, c: SideClaim, loan: LaneLoan): ClaimLane[] {
  const lanes: ClaimLane[] = [];
  const row = (): ClaimLane => ({
    kind: 'row',
    asset: c.asset,
    assetType: c.assetType,
    tokenId: c.tokenId,
    amount: c.assetType === ASSET_ERC721 ? 1n : c.assetType === ASSET_ERC1155 ? c.quantity : c.amount,
  });
  if (side === 'lender') {
    if (c.claimed) return lanes;
    if (c.assetType !== ASSET_ERC20 || c.amount > 0n) lanes.push(row());
    if (c.heldForLender > 0n)
      lanes.push({ kind: 'held', asset: loan.assetType === ASSET_ERC20 ? loan.principalAsset : loan.prepayAsset, assetType: ASSET_ERC20, tokenId: 0n, amount: c.heldForLender });
    if (loan.assetType !== ASSET_ERC20)
      lanes.push({
        kind: 'rentalReturn',
        asset: loan.principalAsset,
        assetType: loan.assetType,
        tokenId: loan.tokenId,
        amount: loan.assetType === ASSET_ERC721 ? 1n : loan.quantity,
      });
    return lanes;
  }
  // The liened collateral is paid whenever the claim runs, which takes an
  // open collateral row or an open surplus.
  if (!sideOpen('borrower', c, loan.assetType)) return lanes;
  if (collateralRowOpen(c)) lanes.push(row());
  if (c.liened && c.liened.amount > 0n) lanes.push({ kind: 'liened', asset: c.liened.asset, assetType: ASSET_ERC20, tokenId: 0n, amount: c.liened.amount });
  if (c.surplus && c.surplus.amount > 0n) lanes.push({ kind: 'surplus', asset: c.surplus.asset, assetType: ASSET_ERC20, tokenId: 0n, amount: c.surplus.amount });
  return lanes;
}

/** Collateral under the loan's lien that the borrower's claim pays beside its
 *  row: live, non-zero, and in another token than the row (the protocol's
 *  own capture rule). */
export function extraLiened(lien: { asset: Hex; amount: bigint; released: boolean } | null, rowAsset: Hex): { asset: Hex; amount: bigint } | null {
  if (!lien || lien.released || lien.amount === 0n) return null;
  if (lien.asset.toLowerCase() === rowAsset.toLowerCase()) return null;
  return { asset: lien.asset, amount: lien.amount };
}
