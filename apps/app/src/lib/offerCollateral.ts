/**
 * #2378 r1 — what an offer's collateral IS, in words, for the Offer Book
 * card. The card used to fall back to a bare contract address whenever the
 * ERC-20 token details were missing — which is ALWAYS the case for NFT
 * collateral (an ERC-721/1155 has no `decimals()`), and also the case when
 * an ERC-20's details simply failed to load. Either way the lender lost the
 * one figure the card exists to show.
 */
import { AssetType } from './types';
import { formatTokenAmount, shortAddress } from './format';

export function offerCollateralText(args: {
  assetType: number;
  asset: string;
  amount: string | bigint;
  tokenId: string | bigint;
  quantity: string | bigint;
  /** ERC-20 token details, when they loaded. */
  meta: { decimals: number; symbol: string } | undefined;
  /** The token-details read failed (as opposed to still loading). */
  metaFailed: boolean;
  /** #2378 r2 — the indexed amount is only the offer's FLOOR (a borrower
   *  offer can commit a collateral range). Stated as "at least" — unless
   *  `borrowerRange` below says what the range actually is. */
  floorOnly?: boolean;
  /** #2382 — a borrower offer's committed range as the indexer read it:
   *  the effective ceiling and the part earlier matched fills consumed.
   *  `null` in either = not read yet, which keeps the "at least" floor
   *  wording. A direct "fund this request" locks exactly the floor (the
   *  rest is returned to the borrower); a matched fill can lock more, up
   *  to the ceiling still unused; a request already part-filled can only
   *  be matched. */
  borrowerRange?: { ceiling: string | null; filled: string | null };
  /** #2378 r8 — a LENDER offer's collateral is the requirement at its full
   *  amount, and matching scales it to the part taken. Where the offer can
   *  be taken in part (a range, or already partly taken), the figure is
   *  stated as the full-offer requirement rather than as exact. */
  scalesWithAmount?: boolean;
  labels: {
    amountLoading: (token: string) => string;
    /** #2378 r8 — token details failed: the recorded amount is still known,
     *  so it is stated in raw base units with the failure named. */
    amountRaw: (amount: string, token: string) => string;
    atLeast: (amount: string) => string;
    forFullOffer: (amount: string) => string;
    /** #2382 — an unfilled ranged request: the range, the floor a direct
     *  funding locks, and the ceiling a matched fill can reach. */
    range?: (range: string, floor: string, ceiling: string) => string;
    /** #2382 — a request earlier fills have part-used: what is still
     *  committed, and how much is already locked. */
    rangeRemaining?: (range: string, used: string) => string;
  };
}): string {
  const token = shortAddress(args.asset);
  if (args.assetType === AssetType.ERC721) return `NFT ${token} #${args.tokenId}`;
  if (args.assetType === AssetType.ERC1155) {
    const qty = BigInt(args.quantity);
    return `${qty > 1n ? `${qty} × ` : ''}NFT ${token} #${args.tokenId}`;
  }
  // #2382 — the borrower's committed range, once the indexer has read it.
  // Only with token details: a range in raw base units would bury the one
  // figure, so a failed read keeps the floor-only wording below.
  const r = args.borrowerRange;
  if (
    args.meta &&
    r &&
    r.ceiling !== null &&
    r.filled !== null &&
    args.labels.range &&
    args.labels.rangeRemaining
  ) {
    const { decimals, symbol } = args.meta;
    const n = (v: bigint) => formatTokenAmount(v, decimals);
    const floor = BigInt(args.amount);
    const ceiling = BigInt(r.ceiling);
    const filled = BigInt(r.filled);
    if (filled > 0n) {
      const left = ceiling > filled ? ceiling - filled : 0n;
      const range = ceiling > floor && left > floor ? `${n(floor)}–${n(left)} ${symbol}` : `${n(left)} ${symbol}`;
      return args.labels.rangeRemaining(range, `${n(filled)} ${symbol}`);
    }
    if (ceiling > floor) {
      return args.labels.range(
        `${n(floor)}–${n(ceiling)} ${symbol}`,
        `${n(floor)} ${symbol}`,
        `${n(ceiling)} ${symbol}`,
      );
    }
    // Ceiling == floor and nothing used: the figure is exact.
    return `${n(floor)} ${symbol}`;
  }
  let text: string;
  if (args.meta) {
    text = `${formatTokenAmount(BigInt(args.amount), args.meta.decimals)} ${args.meta.symbol}`;
  } else if (args.metaFailed) {
    text = args.labels.amountRaw(BigInt(args.amount).toString(), token);
  } else {
    return args.labels.amountLoading(token);
  }
  if (args.floorOnly) return args.labels.atLeast(text);
  if (args.scalesWithAmount) return args.labels.forFullOffer(text);
  return text;
}
