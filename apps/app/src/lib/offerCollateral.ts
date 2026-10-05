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
   *  wording.
   *
   *  TERMS ONLY (#2382 r4). The card states what the request commits — the
   *  collateral held for it now (`ceiling − filled`) — and its floor, and
   *  says plainly that what a fill locks depends on how it is filled. It does
   *  NOT narrate what each path locks: that depends on the path (a direct
   *  funding, a matched fill, a carry-over refinance that pins the old
   *  loan's collateral) and on the deployment (whether partial fills are
   *  on), and four review rounds each found a sentence one of those
   *  contradicted. Facts the indexer holds do not go stale that way. */
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
    /** #2382 — an unfilled ranged request: what it commits now (the
     *  ceiling — the whole of it is held) and its floor. */
    range?: (committed: string, floor: string) => string;
    /** #2382 — a request earlier fills have part-used: exactly what is still
     *  committed, and what earlier fills CONSUMED (a running total, not what
     *  is locked today — a resulting loan may have settled since). */
    rangeRemaining?: (remaining: string, used: string, floor: string) => string;
    /** #2382 r2/r4 — the same, when what is left is below the request's
     *  floor: stated as that fact. */
    remainingBelowFloor?: (remaining: string, used: string, floor: string) => string;
    /** #2382 r1/r4 — an unfilled single-value request: what it commits. */
    single?: (amount: string) => string;
    /** #2382 r6 — the range text above, with its figures in raw base units
     *  because the token's details could not be read: the failure named once,
     *  the known commitment still stated. */
    inBaseUnits?: (text: string, token: string) => string;
  };
}): string {
  const token = shortAddress(args.asset);
  if (args.assetType === AssetType.ERC721) return `NFT ${token} #${args.tokenId}`;
  if (args.assetType === AssetType.ERC1155) {
    const qty = BigInt(args.quantity);
    return `${qty > 1n ? `${qty} × ` : ''}NFT ${token} #${args.tokenId}`;
  }
  // #2382 — the borrower's committed range, once the indexer has read it.
  // With token details the figures are token amounts; when the details could
  // not be read they are raw base units with the failure named (#2382 r6) —
  // a known commitment is stated either way, never reduced to "at least" the
  // floor. While the details are still loading, the loading wording below.
  const r = args.borrowerRange;
  if (
    (args.meta || args.metaFailed) &&
    args.labels.inBaseUnits &&
    r &&
    r.ceiling !== null &&
    r.filled !== null &&
    args.labels.range &&
    args.labels.rangeRemaining &&
    args.labels.remainingBelowFloor &&
    args.labels.single
  ) {
    const meta = args.meta;
    // `amt` renders one figure: a token amount, or raw base units.
    const amt = (v: bigint) => (meta ? `${formatTokenAmount(v, meta.decimals)} ${meta.symbol}` : v.toString());
    const inBaseUnits = args.labels.inBaseUnits;
    const wrap = (text: string) => (meta ? text : inBaseUnits(text, token));
    const floor = BigInt(args.amount);
    const ceiling = BigInt(r.ceiling);
    const filled = BigInt(r.filled);
    if (filled > 0n) {
      // Exactly what is still committed (`ceiling − filled`), never a range:
      // a range here read as the commitment and understated it (#2382 r2).
      // `filled` is cumulative — consumed by earlier fills, not necessarily
      // locked now.
      const left = ceiling > filled ? ceiling - filled : 0n;
      const remaining = amt(left);
      const used = amt(filled);
      // A remainder below a ranged request's floor is stated as exactly
      // that, never presented as available for a fill (#2382 r2/r4).
      if (ceiling > floor && left < floor) {
        return wrap(args.labels.remainingBelowFloor(remaining, used, amt(floor)));
      }
      // The same terms as an unfilled request (#2382 r5): what is held, the
      // floor, and the fill-dependence — none drops out after a first fill.
      return wrap(args.labels.rangeRemaining(remaining, used, amt(floor)));
    }
    if (ceiling > floor) {
      // The whole ceiling is held for an unfilled ranged request (#2382 r4),
      // so that is the commitment; the floor is stated as the request's term.
      return wrap(args.labels.range(amt(ceiling), amt(floor)));
    }
    // Ceiling == floor and nothing used: the request commits exactly this.
    return wrap(args.labels.single(amt(floor)));
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
