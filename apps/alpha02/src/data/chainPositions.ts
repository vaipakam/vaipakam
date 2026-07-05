/**
 * Chain-authoritative discovery of the wallet's OWN positions.
 *
 * Why: the indexer ingests on a once-per-minute cron, so a freshly
 * mined createOffer/acceptOffer took 30–60s to appear under
 * My positions while the page silently showed the old list. A
 * wallet's own open offers and held loan positions are exactly
 * enumerable from the Diamond in a handful of cheap paginated reads,
 * so these hooks' lists are hydrated from the CHAIN (authoritative
 * for existence + status, visible within a block of the tx) and the
 * indexer contributes only what the chain cannot see — history whose
 * position NFTs are burned (claimed/cancelled rows) and offers held
 * via a transferred NFT. Same authoritative-chain move as the #988
 * claimables discovery.
 *
 * Failure contract: each function returns `null` when the CHAIN side
 * is unavailable (view missing on this deploy, or transport failure)
 * — callers then fall back to the indexer alone, which is exactly the
 * pre-chain-authoritative behaviour.
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { IndexedOffer } from './indexer';
import type { PositionLoan } from './hooks';
import { readLoanRowLive, isRevert } from './liveLoanRow';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const PAGE = 200n;
/** Runaway bound on enumeration loops — a wallet whose inventory
 *  exceeds this is out of scope for the retail surface; the loop
 *  throws (→ chain side unavailable) instead of serving a silent
 *  truncation as complete. */
const WALK_CAP = 2000;

/** MetricsFacet.OfferState — the CANONICAL offer lifecycle (the raw
 *  getOffer struct cannot express a ConsumedBySale terminal; see
 *  #955). Index-aligned with the Solidity enum. */
const OFFER_STATE: readonly IndexedOffer['status'][] = [
  'active',
  'accepted',
  'cancelled',
  'consumed_by_sale',
];

/** Read one offer live and map it onto the indexer-row shape.
 *  Returns `null` for a deleted slot (cancelled-unfilled offers
 *  delete their storage) or an unknown FUTURE state-enum value —
 *  honest "can't represent", mirroring readLoanRowLive. Safe because
 *  the hooks treat the chain enumeration as the SOLE row source when
 *  it answers: a null here just means "not one of your current
 *  positions", and no stale indexed row is merged over it. Throws on
 *  transport failure (callers must not treat that as "gone"). */
export async function readOfferRowLive(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  chainId: number,
  offerId: number,
): Promise<IndexedOffer | null> {
  const [o, stateRaw] = (await Promise.all([
    publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getOffer',
      args: [BigInt(offerId)],
    }),
    publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getOfferState',
      args: [BigInt(offerId)],
    }),
  ])) as [Record<string, unknown>, number | bigint];
  let status = OFFER_STATE[Number(stateRaw)];
  if (!o.creator || String(o.creator).toLowerCase() === ZERO_ADDR) return null;
  if (status === undefined) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  // GTT expiry overlay on an Open row. Wall clock is the right basis
  // here: on a live network it tracks block time within seconds, and
  // this mirrors the indexer's own clock-derived 'expired' status.
  if (status === 'active' && Number(o.expiresAt ?? 0) !== 0 && nowSec >= Number(o.expiresAt)) {
    status = 'expired';
  }
  return {
    chainId,
    offerId,
    status,
    creator: String(o.creator),
    offerType: Number(o.offerType),
    lendingAsset: String(o.lendingAsset),
    collateralAsset: String(o.collateralAsset),
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    principalLiquidity: Number(o.principalLiquidity),
    collateralLiquidity: Number(o.collateralLiquidity),
    tokenId: String(o.tokenId),
    collateralTokenId: String(o.collateralTokenId),
    quantity: String(o.quantity),
    collateralQuantity: String(o.collateralQuantity),
    amount: String(o.amount),
    amountMax: String(o.amountMax),
    amountFilled: String(o.amountFilled),
    interestRateBps: Number(o.interestRateBps),
    interestRateBpsMax: Number(o.interestRateBpsMax),
    collateralAmount: String(o.collateralAmount),
    durationDays: Number(o.durationDays),
    positionTokenId: String(o.positionTokenId),
    prepayAsset: String(o.prepayAsset),
    useFullTermInterest: Boolean(o.useFullTermInterest),
    creatorRiskAndTermsConsent: Boolean(o.creatorRiskAndTermsConsent),
    allowsPartialRepay: Boolean(o.allowsPartialRepay),
    firstSeenBlock: 0,
    firstSeenAt: Number(o.createdAt) || nowSec,
    updatedAt: nowSec,
    createdAt: Number(o.createdAt) || undefined,
    expiresAt: Number(o.expiresAt) || undefined,
    fillMode: Number(o.fillMode),
  };
}

/** Every loan position the wallet CURRENTLY HOLDS, role decided by
 *  WHICH position NFT it holds (held tokenId == lenderTokenId →
 *  lender side; == borrowerTokenId → borrower side) — a bought or
 *  transferred position surfaces for its new holder, matching the
 *  indexer's current-owner columns. `null` = chain side unavailable. */
export async function readOwnLoanRowsLive(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  chainId: number,
  address: `0x${string}`,
): Promise<PositionLoan[] | null> {
  const pairs: { loanId: number; heldTokenId: string }[] = [];
  try {
    for (let offset = 0n; ; offset += PAGE) {
      const [ids, tokenIds, total] = (await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getUserPositionLoansPaginated',
        args: [address, offset, PAGE],
      })) as readonly [readonly bigint[], readonly bigint[], bigint];
      for (let i = 0; i < ids.length; i++) {
        pairs.push({ loanId: Number(ids[i]), heldTokenId: String(tokenIds[i]) });
      }
      if (offset + PAGE >= total) break;
      if (offset >= BigInt(WALK_CAP)) return null; // truncated ≠ complete
    }
  } catch (e) {
    if (!isRevert(e)) return null; // transport — chain side unknown
    try {
      // Pre-#769 deploys only carry the unbounded view.
      const legacy = (await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getUserPositionLoans',
        args: [address],
      })) as readonly [readonly bigint[], readonly bigint[]];
      for (let i = 0; i < legacy[0].length; i++) {
        pairs.push({
          loanId: Number(legacy[0][i]),
          heldTokenId: String(legacy[1][i]),
        });
      }
    } catch {
      return null; // both views unavailable
    }
  }
  try {
    const rows = await Promise.all(
      pairs.map(async ({ loanId, heldTokenId }): Promise<PositionLoan | null> => {
        const row = await readLoanRowLive(publicClient, diamond, chainId, loanId);
        if (!row) return null; // unknown id / unrepresentable status
        const role =
          heldTokenId === row.lenderTokenId
            ? ('lender' as const)
            : heldTokenId === row.borrowerTokenId
              ? ('borrower' as const)
              : null;
        if (!role) return null; // NFT not a side token of this loan
        return { ...row, role };
      }),
    );
    return rows.filter((r): r is PositionLoan => r !== null);
  } catch {
    return null; // a row read failed — never a confident partial list
  }
}

/** Result of {@link readOwnOfferRowsLive}. `heldLegOk === false`
 *  means NEITHER holder view exists on this deploy: the created leg
 *  still answered (rows are complete for created offers), but
 *  held-via-transfer listings could not be chain-enumerated — the
 *  caller must keep the indexer's by-current-holder rows for that
 *  leg instead of treating `rows` as the whole truth. */
export interface OwnOfferRead {
  rows: IndexedOffer[];
  heldLegOk: boolean;
}

/** Every offer the wallet CREATED plus every OPEN offer whose
 *  position NFT it currently HOLDS (a received/bought listing),
 *  hydrated live — covers both the freshly posted offer and the
 *  freshly transferred one before the indexer ingests either.
 *  `null` = chain side unavailable. */
export async function readOwnOfferRowsLive(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  chainId: number,
  address: `0x${string}`,
): Promise<OwnOfferRead | null> {
  const ids = new Set<number>();
  let heldLegOk = true;
  // Leg 1 — the creator's lifetime offer index. Any failure here
  // (transport OR a deploy without the view) disables the chain
  // source: created offers are the fix's core promise.
  try {
    for (let offset = 0n; ; offset += PAGE) {
      const [page, total] = (await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getUserOffersPaginated',
        args: [address, offset, PAGE],
      })) as readonly [readonly bigint[], bigint];
      for (const id of page) ids.add(Number(id));
      if (ids.size >= Number(total) || page.length === 0) break;
      if (offset >= BigInt(WALK_CAP)) return null; // truncated ≠ complete
    }
  } catch {
    return null;
  }
  // Leg 2 — OPEN offers whose position NFT the wallet holds
  // (offerIdByPositionTokenId over the ERC721Enumerable inventory;
  // totalBalance bounds the walk like the loans view). A REVERT means
  // the paginated view is absent on this deploy — fall back to the
  // legacy unbounded view, and if that's absent too, continue with
  // the created leg alone (never let a missing holder view disable
  // live created-offer discovery). Transport failures still fail the
  // whole chain source closed.
  try {
    for (let offset = 0n; ; offset += PAGE) {
      const [offerIds, , totalBalance] = (await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getUserPositionOffersPaginated',
        args: [address, offset, PAGE],
      })) as readonly [readonly bigint[], readonly bigint[], bigint];
      for (const id of offerIds) ids.add(Number(id));
      if (offset + PAGE >= totalBalance) break;
      if (offset >= BigInt(WALK_CAP)) return null; // truncated ≠ complete
    }
  } catch (e) {
    if (!isRevert(e)) return null; // transport — chain side unknown
    try {
      const [legacyIds] = (await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getUserPositionOffers',
        args: [address],
      })) as readonly [readonly bigint[], readonly bigint[]];
      for (const id of legacyIds) ids.add(Number(id));
    } catch (e2) {
      if (!isRevert(e2)) return null;
      // Both holder views absent — an older deploy. Created-offer
      // discovery still stands; held-via-transfer listings stay
      // indexer-only there, and the flag tells the caller to keep
      // the indexed by-current-holder rows for that leg.
      heldLegOk = false;
    }
  }
  try {
    const rows = await Promise.all(
      [...ids].map((id) => readOfferRowLive(publicClient, diamond, chainId, id)),
    );
    return { rows: rows.filter((r): r is IndexedOffer => r !== null), heldLegOk };
  } catch {
    return null; // a row read failed — never a confident partial list
  }
}
