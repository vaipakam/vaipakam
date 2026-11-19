/**
 * #3021 — what a retired position token stood for, from the public indexer
 * (`GET /positions/:tokenId`).
 *
 * The verifier's verdict (live / retired / never minted) is read from the
 * chain and stands on its own. This is the history panel under a RETIRED
 * verdict: the offer or loan the token belonged to, which side, the final
 * status and the terms, and when it was retired. It is an embellishment, so
 * every failure is silence: an unconfigured or unreachable indexer, a body
 * that does not have the shape below, or an index with no record of the
 * token all return null, and the page shows the verdict alone.
 *
 * Every terms field the index cannot back arrives as null and is rendered
 * as "not confirmed", never filled from somewhere else.
 */
import { getJson } from './indexer';

export type PositionSide = 'lender' | 'borrower';
export type RetirementReason = 'position-moved' | 'offer-cancelled' | 'loan-closed';

export interface HistoryLoan {
  kind: 'loan';
  loanId: number;
  side: PositionSide;
  status: string;
  agreed: {
    principal: string | null;
    interestRateBps: number | null;
    durationDays: number | null;
  };
  lastCollateralAmount: string;
  lendingAsset: string;
  collateralAsset: string;
  assetType: number;
  collateralAssetType: number;
  lentTokenId: string;
  collateralTokenId: string;
  closedAt: number | null;
}

export interface HistoryOffer {
  kind: 'offer';
  offerId: number;
  side: PositionSide;
  status: string;
  amount: string;
  amountMax: string | null;
  interestRateBps: number;
  interestRateBpsMax: number | null;
  collateralAmount: string;
  durationDays: number;
  lendingAsset: string;
  collateralAsset: string;
  assetType: number;
  collateralAssetType: number;
  /** The lent NFT's id is not in the offer record; null on this kind. */
  lentTokenId: null;
  collateralTokenId: null;
}

export interface PositionHistory {
  record: HistoryLoan | HistoryOffer;
  retirement: { blockNumber: number; txHash: string; at: number } | null;
  reason: RetirementReason | null;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^\d{1,78}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const REASONS: readonly RetirementReason[] = ['position-moved', 'offer-cancelled', 'loan-closed'];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isUint = (v: unknown): v is string => typeof v === 'string' && UINT_RE.test(v);
const isAddr = (v: unknown): v is string => typeof v === 'string' && ADDRESS_RE.test(v);
const isSide = (v: unknown): v is PositionSide => v === 'lender' || v === 'borrower';
const isStatus = (v: unknown): v is string => typeof v === 'string' && /^[a-z_]{1,32}$/.test(v);
const isAssetType = (v: unknown): v is number => v === 0 || v === 1 || v === 2;
const orNull = <T>(v: unknown, test: (x: unknown) => x is T): v is T | null => v === null || test(v);

function parseLoan(r: Obj): HistoryLoan | null {
  const a = r.agreed;
  if (
    !isCount(r.loanId) ||
    !isSide(r.side) ||
    !isStatus(r.status) ||
    !isObj(a) ||
    !orNull(a.principal, isUint) ||
    !orNull(a.interestRateBps, isCount) ||
    !orNull(a.durationDays, isCount) ||
    !isUint(r.lastCollateralAmount) ||
    !isAddr(r.lendingAsset) ||
    !isAddr(r.collateralAsset) ||
    !isAssetType(r.assetType) ||
    !isAssetType(r.collateralAssetType) ||
    !isUint(r.lentTokenId) ||
    !isUint(r.collateralTokenId) ||
    !orNull(r.closedAt, isCount)
  ) {
    return null;
  }
  return {
    kind: 'loan',
    loanId: r.loanId,
    side: r.side,
    status: r.status,
    agreed: {
      principal: a.principal,
      interestRateBps: a.interestRateBps,
      durationDays: a.durationDays,
    },
    lastCollateralAmount: r.lastCollateralAmount,
    lendingAsset: r.lendingAsset,
    collateralAsset: r.collateralAsset,
    assetType: r.assetType,
    collateralAssetType: r.collateralAssetType,
    lentTokenId: r.lentTokenId,
    collateralTokenId: r.collateralTokenId,
    closedAt: r.closedAt,
  };
}

function parseOffer(r: Obj): HistoryOffer | null {
  if (
    !isCount(r.offerId) ||
    !isSide(r.side) ||
    !isStatus(r.status) ||
    !isUint(r.amount) ||
    !orNull(r.amountMax, isUint) ||
    !isCount(r.interestRateBps) ||
    !orNull(r.interestRateBpsMax, isCount) ||
    !isUint(r.collateralAmount) ||
    !isCount(r.durationDays) ||
    !isAddr(r.lendingAsset) ||
    !isAddr(r.collateralAsset) ||
    !isAssetType(r.assetType) ||
    !isAssetType(r.collateralAssetType)
  ) {
    return null;
  }
  return {
    kind: 'offer',
    offerId: r.offerId,
    side: r.side,
    status: r.status,
    amount: r.amount,
    amountMax: r.amountMax,
    interestRateBps: r.interestRateBps,
    interestRateBpsMax: r.interestRateBpsMax,
    collateralAmount: r.collateralAmount,
    durationDays: r.durationDays,
    lendingAsset: r.lendingAsset,
    collateralAsset: r.collateralAsset,
    assetType: r.assetType,
    collateralAssetType: r.collateralAssetType,
    lentTokenId: null,
    collateralTokenId: null,
  };
}

/**
 * The indexer's answer for `(chainId, tokenId)`, or null for anything the
 * panel must not render: no record, a body for another chain or token, or a
 * body that does not have the expected shape.
 */
export function parsePositionHistory(
  raw: unknown,
  chainId: number,
  tokenId: string,
): PositionHistory | null {
  if (!isObj(raw) || raw.chainId !== chainId || raw.tokenId !== tokenId) return null;
  const rec = raw.record;
  if (!isObj(rec)) return null;
  const record = rec.kind === 'loan' ? parseLoan(rec) : rec.kind === 'offer' ? parseOffer(rec) : null;
  if (record === null) return null;
  const ret = raw.retirement;
  let retirement: PositionHistory['retirement'] = null;
  if (ret !== null) {
    if (!isObj(ret) || !isCount(ret.blockNumber) || !TX_RE.test(String(ret.txHash)) || !isCount(ret.at)) {
      return null;
    }
    retirement = { blockNumber: ret.blockNumber, txHash: String(ret.txHash), at: ret.at };
  }
  const reason =
    retirement !== null && REASONS.includes(raw.reason as RetirementReason)
      ? (raw.reason as RetirementReason)
      : null;
  return { record, retirement, reason };
}

export async function fetchPositionHistory(
  chainId: number,
  tokenId: string,
): Promise<PositionHistory | null> {
  if (!UINT_RE.test(tokenId)) return null;
  const raw = await getJson<unknown>(`/positions/${tokenId}?chainId=${chainId}`);
  return parsePositionHistory(raw, chainId, tokenId);
}
