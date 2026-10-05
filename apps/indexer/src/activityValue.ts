/**
 * #2383 — the asset and amount an activity row moved or offered, normalized at
 * ingest.
 *
 * WHY HERE AND NOT IN THE CLIENT. #2378 tried to rebuild this in the app from
 * each row's raw `args_json`, and three Codex rounds in a row found edges of
 * that one seam: offer terms nested in a `fields` tuple, a loan's amount and
 * asset split across `LoanInitiated` and `LoanInitiatedDetails`, a multicall
 * carrying several offers or loans, a claim event with no asset type, a range
 * offer whose `amount` is only the minimum. Every one of those is knowledge the
 * indexer HAS while it decodes — the ABI shape, the sibling events of the same
 * transaction, the loan and offer records — so the value is fixed once, here.
 *
 * WHAT A ROW CARRIES. `asset` and `assetType` say what moved; `amount` (and
 * `amountMax` for a range) say how much, in the asset's base units, and are set
 * ONLY for a fungible (ERC-20) asset; `tokenId` is set only for an NFT, and
 * `quantity` only for an ERC-1155 (#2383 r1 — one copy and a hundred are
 * different positions; an ERC-721 is always one). Every
 * field is null when this event, its siblings and the records do not establish
 * it — never a guess. An NFT row therefore has no amount, and a claim whose
 * asset type cannot be told apart from the loan record has no type and no
 * amount.
 *
 * WHICH ROW. The value goes on the PRIMARY event of a pair (`OfferCreated`,
 * `OfferCanceled`, `LoanInitiated`) as well as on its `*Details` companion,
 * read from the companion in the same transaction and matched BY ID — so in a
 * multicall each row gets its own offer's or loan's value, never a neighbour's.
 * The companions stay unscoped on the loan/offer timeline (see
 * `DELIBERATELY_NOT_SCOPED`): the value reaches the primary row without making
 * a second timeline entry.
 */

/** LibVaipakam.AssetType. */
export const ASSET_ERC20 = 0;

export interface ActivityValue {
  asset: string | null;
  assetType: number | null;
  amount: string | null;
  amountMax: string | null;
  tokenId: string | null;
  quantity: string | null;
}

export const NO_VALUE: ActivityValue = {
  asset: null,
  assetType: null,
  amount: null,
  amountMax: null,
  tokenId: null,
  quantity: null,
};

/** LibVaipakam.AssetType.ERC1155. */
export const ASSET_ERC1155 = 2;

/** The records a value may need, read once per ingest batch. */
export interface LoanRecord {
  lendingAsset: string;
  assetType: number;
  tokenId: string;
  collateralAsset: string;
  collateralAssetType: number;
  collateralTokenId: string;
  /** The loan's originating offer's prepay asset (an NFT rental's fee
   *  asset), lowercase; null when the offer row is absent. */
  prepayAsset: string | null;
  /** ERC-1155 quantities of the lent asset and of the collateral, from the
   *  originating offer (an NFT leg is whole-or-nothing, so the loan's
   *  quantities are the offer's); null when the offer row is absent. */
  quantity: string | null;
  collateralQuantity: string | null;
}

export interface OfferRecord {
  lendingAsset: string;
  assetType: number;
  tokenId: string;
  quantity: string | null;
}

export interface ActivityValueContext {
  /** `LoanInitiatedDetails.details` by loan id, from this batch. */
  loanDetails: Map<number, Record<string, unknown>>;
  /** `LoanInitiated.principal` by loan id, from this batch. */
  loanPrincipal: Map<number, bigint>;
  /** `OfferCreatedDetails` args by offer id, from this batch. */
  offerCreated: Map<number, Record<string, unknown>>;
  /** `OfferCanceledDetails` args by offer id, from this batch. */
  offerCanceled: Map<number, Record<string, unknown>>;
  loans: Map<number, LoanRecord>;
  offers: Map<number, OfferRecord>;
}

export const emptyContext = (): ActivityValueContext => ({
  loanDetails: new Map(),
  loanPrincipal: new Map(),
  offerCreated: new Map(),
  offerCanceled: new Map(),
  loans: new Map(),
  offers: new Map(),
});

const lower = (v: unknown): string | null => (typeof v === 'string' ? v.toLowerCase() : null);

const big = (v: unknown): bigint | null => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
};

const id = (v: unknown): number | null => {
  const b = big(v);
  return b === null ? null : Number(b);
};

const typeOf = (v: unknown): number | null => {
  const n = id(v);
  return n === null || n < 0 || n > 2 ? null : n;
};

/**
 * Assemble a value from what is known. An amount is kept only for an ERC-20
 * asset; a token id only for an NFT; a quantity only for an ERC-1155. A range
 * is kept only when its ceiling is strictly above the amount — a ceiling of 0
 * (or equal) means "exact".
 */
function value(
  asset: string | null,
  assetType: number | null,
  amount: bigint | null,
  tokenId: bigint | string | null,
  amountMax: bigint | null = null,
  quantity: bigint | string | null = null,
): ActivityValue {
  if (assetType === null) return { ...NO_VALUE, asset };
  if (assetType === ASSET_ERC20) {
    return {
      asset,
      assetType,
      amount: amount === null ? null : amount.toString(),
      amountMax:
        amount !== null && amountMax !== null && amountMax > amount ? amountMax.toString() : null,
      tokenId: null,
      quantity: null,
    };
  }
  const q = quantity === null ? null : big(quantity);
  return {
    asset,
    assetType,
    amount: null,
    amountMax: null,
    tokenId: tokenId === null ? null : tokenId.toString(),
    // A zero quantity is the "not applicable" default a non-1155 row carries,
    // never a real holding — so it is unknown, not "0 copies".
    quantity: assetType === ASSET_ERC1155 && q !== null && q > 0n ? q.toString() : null,
  };
}

/** An offer's value from its terms (OfferCreatedDetails.fields /
 *  OfferCanceledDetails), with the lending asset given separately. */
function offerTermsValue(
  asset: unknown,
  t: Record<string, unknown>,
  quantity: string | null,
): ActivityValue {
  return value(lower(asset), typeOf(t.assetType), big(t.amount), big(t.tokenId), big(t.amountMax), quantity);
}

/** The offer events carry no quantity; the offer record (written earlier in
 *  the same pass, and an NFT leg's quantity cannot be amended) does. */
const offerQuantity = (offerId: number | null, ctx: ActivityValueContext) =>
  offerId === null ? null : ctx.offers.get(offerId)?.quantity ?? null;

function createdValue(offerId: number | null, ctx: ActivityValueContext): ActivityValue {
  const d = offerId === null ? undefined : ctx.offerCreated.get(offerId);
  if (!d || typeof d.fields !== 'object' || d.fields === null) return NO_VALUE;
  return offerTermsValue(d.lendingAsset, d.fields as Record<string, unknown>, offerQuantity(offerId, ctx));
}

function canceledValue(offerId: number | null, ctx: ActivityValueContext): ActivityValue {
  const d = offerId === null ? undefined : ctx.offerCanceled.get(offerId);
  if (!d) return NO_VALUE;
  return offerTermsValue(d.lendingAsset, d, offerQuantity(offerId, ctx));
}

/** A loan's principal value: the asset from its `LoanInitiatedDetails`
 *  sibling (or the loan record), the amount as given. */
function loanPrincipalValue(
  loanId: number | null,
  amount: bigint | null,
  ctx: ActivityValueContext,
): ActivityValue {
  if (loanId === null) return NO_VALUE;
  const d = ctx.loanDetails.get(loanId);
  if (d) return value(lower(d.principalAsset), typeOf(d.assetType), amount, big(d.tokenId), null, big(d.quantity));
  const r = ctx.loans.get(loanId);
  if (r) return value(r.lendingAsset.toLowerCase(), r.assetType, amount, r.tokenId, null, r.quantity);
  return NO_VALUE;
}

/**
 * A claim's value. The claim events carry the asset and amount but NOT the
 * asset type, so the type comes from the loan record: the asset is the loan's
 * principal, its collateral, or its originating offer's prepay asset (an NFT
 * rental's fee asset, always ERC-20). When the asset matches more than one of
 * those with DIFFERENT types, or matches none, the type is unknown — and with
 * it the amount, since an NFT claim's `amount` is not a token amount.
 */
function claimValue(loanId: number | null, args: Record<string, unknown>, ctx: ActivityValueContext): ActivityValue {
  const asset = lower(args.asset);
  const r = loanId === null ? undefined : ctx.loans.get(loanId);
  if (!asset || !r) return { ...NO_VALUE, asset };
  const candidates: { type: number; tokenId: string | null; quantity: string | null }[] = [];
  if (r.lendingAsset.toLowerCase() === asset) {
    candidates.push({ type: r.assetType, tokenId: r.tokenId, quantity: r.quantity });
  }
  if (r.collateralAsset.toLowerCase() === asset) {
    candidates.push({ type: r.collateralAssetType, tokenId: r.collateralTokenId, quantity: r.collateralQuantity });
  }
  if (r.prepayAsset === asset) candidates.push({ type: ASSET_ERC20, tokenId: null, quantity: null });
  const types = new Set(candidates.map((c) => c.type));
  if (types.size !== 1) return { ...NO_VALUE, asset };
  const [only] = candidates;
  // Two NFT candidates of the same type but different token ids cannot say
  // which token moved.
  if (only.type !== ASSET_ERC20 && new Set(candidates.map((c) => c.tokenId)).size !== 1) {
    return { ...NO_VALUE, asset, assetType: only.type };
  }
  return value(asset, only.type, big(args.amount), only.tokenId, null, only.quantity);
}

/** The normalized value of one decoded event. */
export function activityValue(
  eventName: string,
  args: Record<string, unknown>,
  ctx: ActivityValueContext,
): ActivityValue {
  switch (eventName) {
    case 'OfferCreated':
    case 'OfferCreatedDetails':
      return createdValue(id(args.offerId), ctx);
    case 'OfferCanceled':
    case 'OfferCanceledDetails':
      return canceledValue(id(args.offerId), ctx);
    case 'OfferModified': {
      // The amended size, in the offer's own asset.
      const o = ctx.offers.get(id(args.offerId) ?? -1);
      if (!o) return NO_VALUE;
      return value(o.lendingAsset.toLowerCase(), o.assetType, big(args.amount), o.tokenId, big(args.amountMax));
    }
    case 'LoanInitiated':
      return loanPrincipalValue(id(args.loanId), big(args.principal), ctx);
    case 'LoanInitiatedDetails': {
      const loanId = id(args.loanId);
      return loanPrincipalValue(loanId, loanId === null ? null : ctx.loanPrincipal.get(loanId) ?? null, ctx);
    }
    case 'OfferAccepted':
    case 'OfferMatched':
      // The fill this event made, in the child loan's principal asset.
      return loanPrincipalValue(id(args.loanId), big(args.matchAmount), ctx);
    case 'LenderFundsClaimed':
    case 'BorrowerFundsClaimed':
    case 'BorrowerSurplusClaimed':
      return claimValue(id(args.loanId), args, ctx);
    case 'CollateralAdded': {
      // #2383 r1 — the amount added, in the loan's collateral.
      const r = ctx.loans.get(id(args.loanId) ?? -1);
      if (!r) return NO_VALUE;
      return value(
        r.collateralAsset.toLowerCase(),
        r.collateralAssetType,
        big(args.amountAdded),
        r.collateralTokenId,
        null,
        r.collateralQuantity,
      );
    }
    default:
      return NO_VALUE;
  }
}

/** The ids of the records a batch's values need, plus its sibling maps. */
export function collectBatch(
  logs: readonly { eventName: string; args: unknown }[],
): { ctx: ActivityValueContext; loanIds: number[]; offerIds: number[] } {
  const ctx = emptyContext();
  const loanIds = new Set<number>();
  const offerIds = new Set<number>();
  for (const log of logs) {
    const a = (log.args ?? {}) as Record<string, unknown>;
    switch (log.eventName) {
      case 'LoanInitiatedDetails': {
        const l = id(a.loanId);
        if (l !== null && typeof a.details === 'object' && a.details !== null) {
          ctx.loanDetails.set(l, a.details as Record<string, unknown>);
        }
        break;
      }
      case 'LoanInitiated': {
        const l = id(a.loanId);
        const p = big(a.principal);
        if (l !== null && p !== null) ctx.loanPrincipal.set(l, p);
        break;
      }
      case 'OfferCreatedDetails': {
        const o = id(a.offerId);
        if (o !== null) {
          ctx.offerCreated.set(o, a);
          offerIds.add(o); // its record carries the ERC-1155 quantity
        }
        break;
      }
      case 'OfferCanceledDetails': {
        const o = id(a.offerId);
        if (o !== null) {
          ctx.offerCanceled.set(o, a);
          offerIds.add(o);
        }
        break;
      }
      case 'OfferModified': {
        const o = id(a.offerId);
        if (o !== null) offerIds.add(o);
        break;
      }
      case 'OfferAccepted':
      case 'OfferMatched':
      case 'CollateralAdded':
      case 'LenderFundsClaimed':
      case 'BorrowerFundsClaimed':
      case 'BorrowerSurplusClaimed': {
        const l = id(a.loanId);
        if (l !== null) loanIds.add(l);
        break;
      }
    }
  }
  return { ctx, loanIds: [...loanIds], offerIds: [...offerIds] };
}
