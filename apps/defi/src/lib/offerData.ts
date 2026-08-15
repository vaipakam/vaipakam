/**
 * Offer row shape, the raw→view mapper, and the enum labels the tables render.
 *
 * Split out of `pages/OfferBook.tsx` so that page exports components and
 * nothing else; a module mixing a component with plain values makes editing
 * the page a full reload instead of a hot swap. Nothing here touches React —
 * `MyOffersTable`, `useMyOffers` and `offerSnapshot` were already reaching
 * into the page for it, which is the shape that says it never belonged there.
 */

export const OFFER_TYPE_LABELS = ['Lender', 'Borrower'] as const;
export const LIQUIDITY_LABELS = ['Liquid', 'Illiquid'] as const;
export const ASSET_TYPE_LABELS = ['ERC-20', 'ERC-721', 'ERC-1155'] as const;

export interface OfferData {
  id: bigint;
  creator: string;
  offerType: number;
  lendingAsset: string;
  amount: bigint;
  /** #183 (Canonical Limit-Order Phase 2) — the lender's max-provide
   *  ceiling (lender side: headline), or for borrower offers the
   *  derived upper bound. Direct-accept on a lender offer locks the
   *  loan principal at this value. See
   *  `docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md` §2.2. */
  amountMax: bigint;
  interestRateBps: bigint;
  /** #183 — the borrower's max-rate ceiling (borrower side: headline),
   *  or for lender offers the protocol upper-sanity cap
   *  (`MAX_INTEREST_BPS`). Direct-accept on a borrower offer locks the
   *  loan rate at this value. */
  interestRateBpsMax: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
  /** #183 — the borrower's max-collateral commit (borrower side:
   *  headline; ranged in design §2.2 but Phase 2 frontend ships
   *  `collateralAmountMax == collateralAmount` until a range UI lands).
   *  Lender offers stay structurally single-value
   *  (`collateralAmount == collateralAmountMax`). */
  collateralAmountMax: bigint;
  durationDays: bigint;
  principalLiquidity: number;
  collateralLiquidity: number;
  accepted: boolean;
  assetType: number;
  tokenId: bigint;
  /** Creator-set opt-in for borrower-initiated partial repay on the
   *  resulting loan. The acceptor's act of accepting IS their consent;
   *  there's no acceptor-side override. Snapshotted to
   *  `Loan.allowsPartialRepay` at init and gates `RepayFacet.repayPartial`. */
  allowsPartialRepay: boolean;
  /** #408 / #784 — creator's term-interest mode. `true` (default) = borrower
   *  owes the FULL-TERM interest even on early repay; `false` = pro-rata to
   *  elapsed time. Drives the #784 risk-disclosure line on the accept flow. */
  useFullTermInterest: boolean;
  /** T-034 — lender-set Periodic Interest Payment cadence
   *  (0 = None ... 4 = Annual). Snapshotted onto the loan at acceptance.
   *  Acceptors must explicitly acknowledge non-`None` cadences before
   *  the accept button enables. */
  periodicInterestCadence: number;
  // Phase 6: per-keeper per-offer enable flags live in
  // `s.offerKeeperEnabled[offerId][keeper]`. No single flag on the offer
  // struct. Per-offer keeper selection is surfaced on the offer card
  // only for the creator — see OfferKeeperPicker.

  // ── Fields populated by `getOffer` reads / `OfferCreatedDetails`
  //    events. Marked optional so legacy construction sites (event-
  //    payload stubs, cancelled-row identity stubs) typecheck without
  //    threading every site through a migration. Consumers that need
  //    these values default to 0n / 0 when undefined.
  /** Unix-seconds stamp of `createOffer` (uint64 in storage). #164
   *  introduced the slot to drive the partial-fill cooldown
   *  (`MIN_OFFER_CANCEL_DELAY` = 5 minutes from this stamp). */
  createdAt?: bigint;
  /** Cumulative principal already consumed across partial-fill
   *  matches (Range Orders Phase 1 / #102). `0` on a fresh
   *  unmatched offer; non-zero only when matching is active. */
  amountFilled?: bigint;
  /** #195 — GTT / offer-expiry. `0n` is the GTC sentinel (today's
   *  default; never expires). Non-zero = absolute unix-seconds
   *  deadline; the contract refuses to fill the offer past this
   *  timestamp, and the permissionless cancelOffer path can clean
   *  it up with the refund routed to the creator. */
  expiresAt?: bigint;
  /** #125 — DEX-style fill-mode flavour
   *  (0 = Partial / 1 = Aon / 2 = Ioc). Default 0 preserves
   *  backward-compat with every legacy offer. */
  fillMode?: number;
  /** T-086 Round-8 §19.7e + Codex round-13 P2 #2 — NFT-collateral
   *  asset type (0 = ERC20, 1 = ERC721, 2 = ERC1155). Surfaced
   *  alongside `collateralTokenId` so the MyOffersTable "Sold" row
   *  (and any other NFT-collateral-shape consumer) can render the
   *  cell as "NFT #N" instead of falling back to an ERC20 amount.
   *  Optional because legacy event-payload-derived OfferData shapes
   *  predate the indexer-side wiring. */
  collateralAssetType?: number;
  /** T-086 Round-8 §19.7e + Codex round-13 P2 #2 — NFT collateral
   *  token id. See {@link collateralAssetType} above. */
  collateralTokenId?: bigint;
  /** T-086 Round-8 §19.7e + Codex round-16 P2 #1 — ERC1155 NFT
   *  collateral "number of copies". For ERC721 the cell ignores it
   *  (always 1). Optional same as the other NFT-shape fields. */
  collateralQuantity?: bigint;
  /** #735 item 3 — the NFT-rental prepayment token (zero address for
   *  non-rentals). Surfaced so the accept flow can rebuild the exact
   *  risk-access PairId when recording a strict-mode mid-tier
   *  acknowledgement (the gate keys an NFT-rental lend leg off this token,
   *  not the rented NFT). Optional for legacy event-derived shapes. */
  prepayAsset?: string;
}

export type RawOffer = {
  id: bigint;
  creator: string;
  offerType: bigint | number;
  lendingAsset: string;
  amount: bigint;
  /** #183 — present on every offer post Phase 2 (the create-time
   *  auto-collapse was dropped). Indexer / on-chain `getOffer` reads
   *  surface it natively. Marked optional so legacy raw shapes that
   *  predate the indexer ABI bump still narrow correctly; the
   *  `toOfferData` mapper falls back to `amount` when absent. */
  amountMax?: bigint;
  interestRateBps: bigint;
  /** #183 — same pattern as `amountMax` above. */
  interestRateBpsMax?: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
  /** #183 — same pattern as `amountMax` above. */
  collateralAmountMax?: bigint;
  durationDays: bigint;
  principalLiquidity: bigint | number;
  collateralLiquidity: bigint | number;
  accepted: boolean;
  assetType: bigint | number;
  tokenId: bigint;
  allowsPartialRepay?: boolean;
  /** #784 — optional so any raw shape that omits it defaults to full-term
   *  (the conservative disclosure) in `toOfferData`. */
  useFullTermInterest?: boolean;
  periodicInterestCadence?: bigint | number;
  /** #168 / #241 — partial-fill cancel-cooldown driver. */
  createdAt?: bigint;
  /** Range Orders Phase 1 / #102 — partial-fill cumulative consumed. */
  amountFilled?: bigint;
  /** #195 — GTT deadline; `0n` = GTC. */
  expiresAt?: bigint;
  /** #125 — fill-mode flavour: 0 Partial / 1 AON / 2 IOC. */
  fillMode?: bigint | number;
  /** T-086 Round-8 §19.7e + Codex round-13 P2 #2 — NFT-collateral
   *  asset type (0 = ERC20, 1 = ERC721, 2 = ERC1155). Bubbled up
   *  through `indexedToRawOffer`; legacy event-payload shapes leave
   *  it `undefined`. */
  collateralAssetType?: number | bigint;
  /** T-086 Round-8 §19.7e + Codex round-13 P2 #2 — NFT collateral
   *  token id. See {@link collateralAssetType} above. */
  collateralTokenId?: bigint;
  /** T-086 Round-8 §19.7e + Codex round-16 P2 #1 — ERC1155 NFT
   *  collateral "number of copies". For ERC721 the cell ignores it
   *  (always 1). Optional same as the other NFT-shape fields. */
  collateralQuantity?: bigint;
  /** #735 item 3 — NFT-rental prepayment token (zero address / undefined for
   *  non-rentals); bubbled through `indexedToRawOffer`. */
  prepayAsset?: string;
};

export function toOfferData(r: RawOffer): OfferData {
  return {
    id: r.id,
    creator: r.creator,
    offerType: Number(r.offerType),
    lendingAsset: r.lendingAsset,
    amount: r.amount,
    // #183 — fall back to the floor field when the raw shape doesn't
    // carry the max (legacy ABI / pre-indexer-bump rows). Under
    // Phase 2 the on-chain shape always carries a non-zero max, so
    // the fallback only matters for transitional reads.
    amountMax: r.amountMax ?? r.amount,
    interestRateBps: r.interestRateBps,
    interestRateBpsMax: r.interestRateBpsMax ?? r.interestRateBps,
    collateralAsset: r.collateralAsset,
    collateralAmount: r.collateralAmount,
    collateralAmountMax: r.collateralAmountMax ?? r.collateralAmount,
    durationDays: r.durationDays,
    principalLiquidity: Number(r.principalLiquidity),
    collateralLiquidity: Number(r.collateralLiquidity),
    accepted: r.accepted,
    assetType: Number(r.assetType),
    tokenId: r.tokenId,
    allowsPartialRepay: r.allowsPartialRepay ?? false,
    // #784 — default true: full-term is the protocol default, and it's the
    // conservative disclosure if a legacy raw shape omits the field.
    useFullTermInterest: r.useFullTermInterest ?? true,
    periodicInterestCadence: Number(r.periodicInterestCadence ?? 0),
    // #241 — thread through every field the MyOffers cooldown / GTT
    // chip relies on. Each is optional so any raw shape that omits
    // the field (legacy event-payload stubs, cancelled-row identity
    // stubs) leaves the corresponding OfferData field undefined, and
    // every consumer defaults undefined to a 0n / Partial sentinel.
    createdAt: r.createdAt,
    amountFilled: r.amountFilled,
    expiresAt: r.expiresAt,
    fillMode: r.fillMode === undefined ? undefined : Number(r.fillMode),
    // T-086 Round-8 §19.7e + Codex round-13 P2 #2 — bubble NFT
    // collateral type + token id through so the MyOffersTable "Sold"
    // row can render proper NFT-shape collateral cells. Same
    // undefined-defaulting pattern as the optional fields above.
    collateralAssetType:
      r.collateralAssetType === undefined ? undefined : Number(r.collateralAssetType),
    collateralTokenId: r.collateralTokenId,
    // Codex round-16 P2 #1 — ERC1155 collateral copy count.
    collateralQuantity: r.collateralQuantity,
    // #735 item 3 — NFT-rental prepay token for the mid-tier-ack PairId rebuild.
    prepayAsset: r.prepayAsset,
  };
}
