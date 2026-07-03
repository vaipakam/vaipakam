/**
 * Lender early exit — sell the lender position into an existing open
 * lending ("buy") offer via EarlyWithdrawalFacet.sellLoanViaBuyOffer.
 *
 * Economics (mirrors the facet): the buyer's already-vaulted
 * principal funds the payout; the seller receives
 * `principal − max(accruedForfeited, rateShortfall)` straight to
 * their wallet in the same transaction. The seller pre-approves
 * NOTHING and claims nothing afterwards. The borrower's loan terms
 * (rate, maturity) are untouched — only the lender side migrates.
 *
 * Candidate discovery: ordinary open Lender offers from the indexer,
 * filtered client-side to the facet's admission rules (single-value,
 * unfilled, asset-quadruple continuity, duration within the loan's
 * remaining term, collateral demand within the pledged collateral,
 * amount covering the principal, cost ≤ principal). CRITICAL: a
 * consumed buy offer lingers as "active" in the indexer (the sale
 * path emits no OfferAccepted), so submit ALWAYS re-verifies the
 * offer live (`getOfferDetails.accepted === false`) plus term
 * equality with what was reviewed.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { submitErrorText } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import {
  assertAssetNotPausedLive,
  assertPositionNftHeldLive,
} from '../contracts/preflights';
import {
  LOAN_STATUS_ACTIVE,
  interestAccrualStartOf,
  interestRemainingDaysOf,
  readLoanLive,
  type LoanLive,
} from '../contracts/loanLive';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import { useActiveOffers } from '../data/hooks';
import type { IndexedLoan } from '../data/indexer';
import { AssetType } from '../lib/types';
import {
  formatBpsAsPercent,
  formatDurationDays,
  formatTokenAmount,
} from '../lib/format';
import { ConfirmReceipt } from './ConfirmReceipt';
import type { TokenMeta } from '../contracts/erc20';

const SECONDS_PER_YEAR = 365n * 86_400n;
const BASIS_POINTS = 10_000n;

/** Seller economics of selling into a buy offer — one definition for
 *  the picker rows, the review receipt, and the submit re-check.
 *  Mirrors EarlyWithdrawalFacet's net settlement TO THE WEI:
 *  seconds-precision, elapsed measured from the #641 interest clock,
 *  remaining = remaining-term seconds minus elapsed (floored at 0),
 *  and the shortfall computed as the DIFFERENCE OF THE TWO FLOORED
 *  remaining-interest figures (not one floored difference). The
 *  seller forfeits the LARGER of accrued or shortfall, never both. */
export function sellerEconomics(
  live: LoanLive,
  buyRateBps: bigint,
  chainNow: bigint,
): { cost: bigint; toSeller: bigint; hasShortfall: boolean } {
  const start = interestAccrualStartOf(live);
  const elapsed = chainNow > start ? chainNow - start : 0n;
  const totalSecs = interestRemainingDaysOf(live) * 86_400n;
  const remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0n;
  const denom = SECONDS_PER_YEAR * BASIS_POINTS;
  const accrued = (live.principal * live.interestRateBps * elapsed) / denom;
  const originalRemaining =
    (live.principal * live.interestRateBps * remainingSecs) / denom;
  const newRemaining = (live.principal * buyRateBps * remainingSecs) / denom;
  const shortfall =
    newRemaining > originalRemaining ? newRemaining - originalRemaining : 0n;
  const cost = accrued > shortfall ? accrued : shortfall;
  return {
    cost,
    toSeller: live.principal > cost ? live.principal - cost : 0n,
    hasShortfall: shortfall > 0n,
  };
}

/** The facet's duration-fit bound: the IMMUTABLE term minus whole
 *  days elapsed since the immutable start — NOT the interest clock
 *  (a partial re-stamps that; the borrower-favourability check does
 *  not care). */
function durationFitDays(live: LoanLive, chainNow: bigint): bigint {
  const elapsedDays =
    chainNow > live.startTime ? (chainNow - live.startTime) / 86_400n : 0n;
  return live.durationDays > elapsedDays ? live.durationDays - elapsedDays : 0n;
}

export function EarlyExitFlow({
  row,
  live,
  chainNow,
  principalMeta,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  onSold,
}: {
  row: IndexedLoan;
  live: LoanLive;
  /** Chain time from the parent's live query. */
  chainNow: bigint;
  principalMeta: TokenMeta;
  /** Page-wide single-confirm-surface slot (see PositionDetails). */
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** The position left this wallet — the page latches its actions. */
  onSold: () => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const offers = useActiveOffers();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a successful sale the position belongs to someone else —
  // the card renders nothing (the PAGE banner carries the outcome,
  // surviving this component's unmount when the role flips).
  const [sold, setSold] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const fitDays = durationFitDays(live, chainNow);

  // The facet's admission rules, applied client-side so a doomed
  // candidate never reaches a wallet prompt. Every excluded shape
  // reverts InvalidSaleOffer on-chain.
  const candidates = useMemo(() => {
    if (!offers.data || !address) return offers.data === null ? null : [];
    const me = address.toLowerCase();
    return offers.data
      .filter((o) => {
        if (o.offerType !== 0 || o.assetType !== AssetType.ERC20) return false;
        // Single-value, unfilled (amountMax 0 collapses to amount).
        const amount = BigInt(o.amount);
        const effMax = BigInt(o.amountMax) === 0n ? amount : BigInt(o.amountMax);
        if (effMax !== amount || BigInt(o.amountFilled) !== 0n) return false;
        // Asset-quadruple continuity with the loan.
        if (
          o.lendingAsset.toLowerCase() !== row.lendingAsset.toLowerCase() ||
          o.collateralAsset.toLowerCase() !== row.collateralAsset.toLowerCase() ||
          o.collateralAssetType !== live.collateralAssetType ||
          o.prepayAsset.toLowerCase() !== live.prepayAsset.toLowerCase()
        ) {
          return false;
        }
        // Borrower-favourability + coverage. Duration fit uses the
        // facet's bound: immutable term minus whole elapsed days.
        if (BigInt(o.durationDays) > fitDays) return false;
        if (BigInt(o.collateralAmount) > live.collateralAmount) return false;
        if (amount < live.principal) return false;
        // Expired offers are refused at accept — don't list them.
        if (o.expiresAt && BigInt(o.expiresAt) <= chainNow) return false;
        // Buying out your own position is a no-op with fees.
        if (o.creator.toLowerCase() === me) return false;
        // RateShortfallTooHigh guard.
        const econ = sellerEconomics(live, BigInt(o.interestRateBps), chainNow);
        return econ.cost <= live.principal;
      })
      .sort(
        // Best payout first = lowest buy-offer rate first (the
        // accrued part is identical across candidates; only the
        // shortfall varies, monotonically with the rate).
        (a, b) => a.interestRateBps - b.interestRateBps,
      );
  }, [offers.data, address, row, live, fitDays, chainNow]);

  const selected =
    candidates?.find((o) => o.offerId === selectedId) ?? null;
  const selectedEcon = selected
    ? sellerEconomics(live, BigInt(selected.interestRateBps), chainNow)
    : null;

  const sym = principalMeta.symbol;
  const dec = principalMeta.decimals;
  const toSellerStr =
    selectedEcon !== null
      ? `${formatTokenAmount(selectedEcon.toSeller, dec)} ${sym}`
      : null;

  // The reviewed payout drifts as interest accrues (and as the live
  // loan refreshes) — a stale open review must not stay confirmed.
  // Closing silently reads as a glitch, so a visible notice explains
  // it until the user re-opens the review.
  const [driftNotice, setDriftNotice] = useState(false);
  useEffect(() => {
    if (selectedId !== null) {
      if (confirmOpen) setDriftNotice(true);
      onCloseConfirm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toSellerStr]);

  function choose(offerId: number) {
    setSelectedId(offerId);
    setDriftNotice(false);
    onCloseConfirm(); // a different candidate = a different review
  }

  async function submit() {
    if (!address || !walletChain || !walletClient || !publicClient || !selected) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Tier-1 — the seller receives funds; re-screen live.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // One live batch: seller still holds the lender NFT, the loan
      // itself, chain time, the buy offer's LIVE record (a consumed
      // offer stays "active" in the indexer — the sale path emits no
      // OfferAccepted), and both legs' pause state.
      const [, liveLoan, latestBlock, liveOffer] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.lenderTokenId,
          expectedOwner: address,
        }),
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getOfferDetails',
          args: [BigInt(selected.offerId)],
        }) as Promise<{
          creator: string;
          accepted: boolean;
          offerType: number;
          amount: bigint;
          amountMax: bigint;
          amountFilled: bigint;
          interestRateBps: number;
          durationDays: bigint;
          lendingAsset: string;
          collateralAsset: string;
          collateralAmount: bigint;
          prepayAsset: string;
          expiresAt: bigint;
        }>,
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: row.lendingAsset as `0x${string}`,
        }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: row.collateralAsset as `0x${string}`,
        }),
      ]);
      if (liveLoan.status !== LOAN_STATUS_ACTIVE) {
        setError(copy.errors.loanAlreadySettled);
        return;
      }
      // The reviewed row came from the indexer; offers are mutable
      // and a consumed one lingers as "active" — every term the user
      // reviewed must still hold on-chain, else re-review.
      const liveEffMax =
        liveOffer.amountMax === 0n ? liveOffer.amount : liveOffer.amountMax;
      if (
        liveOffer.accepted ||
        liveOffer.creator.toLowerCase() !== selected.creator.toLowerCase() ||
        Number(liveOffer.offerType) !== 0 ||
        liveOffer.amount !== BigInt(selected.amount) ||
        liveEffMax !== liveOffer.amount ||
        liveOffer.amountFilled !== 0n ||
        Number(liveOffer.interestRateBps) !== selected.interestRateBps ||
        Number(liveOffer.durationDays) !== selected.durationDays ||
        // Collateral demand is mutable (setOfferCollateral) — a
        // post-review bump past the pledge reverts InvalidSaleOffer.
        liveOffer.collateralAmount !== BigInt(selected.collateralAmount) ||
        liveOffer.collateralAmount > liveLoan.collateralAmount ||
        (liveOffer.expiresAt !== 0n && liveOffer.expiresAt <= latestBlock.timestamp)
      ) {
        throw new Error(copy.match.termsChanged);
      }
      // The duration-fit bound moves with chain time — re-check it
      // live (the picker judged it against a ≤60s-old clock).
      if (
        BigInt(liveOffer.durationDays) >
        durationFitDays(liveLoan, latestBlock.timestamp)
      ) {
        throw new Error(copy.match.termsChanged);
      }
      // Recompute the payout with LIVE state + chain time. The
      // reviewed "~" figure shrinks as time elapses — allow up to two
      // days of drift (same pad convention as the repay paths); more
      // means something material moved (partial repay, rate change).
      const liveEcon = sellerEconomics(
        liveLoan,
        BigInt(liveOffer.interestRateBps),
        latestBlock.timestamp,
      );
      if (liveEcon.cost > liveLoan.principal) {
        throw new Error(copy.match.termsChanged);
      }
      const reviewedToSeller = selectedEcon?.toSeller ?? 0n;
      const twoDaysInterest =
        (liveLoan.principal * liveLoan.interestRateBps * 2n) / (365n * 10_000n);
      if (liveEcon.toSeller + twoDaysInterest < reviewedToSeller) {
        throw new Error(copy.match.termsChanged);
      }
      await write('sellLoanViaBuyOffer', [
        BigInt(row.loanId),
        BigInt(selected.offerId),
      ]);
      onSold();
      setSold(true);
      setSelectedId(null);
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['positionOwners'] });
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);

  // Sold this session: the position belongs to someone else now. The
  // PAGE banner carries the outcome; rendering the (stale-indexer)
  // picker again would invite a doomed second sale.
  if (sold) return null;

  return (
    <section className="card">
      <h3>{copy.earlyExit.title}</h3>
      <p className="muted">{copy.earlyExit.blurb}</p>

      {offers.isPending ? (
        // Loading and genuinely-empty must never look the same.
        <p className="muted">{copy.earlyExit.loadingOffers}</p>
      ) : candidates === null ? (
        <p className="muted">{copy.earlyExit.unavailable}</p>
      ) : candidates.length === 0 ? (
        <p className="muted">{copy.earlyExit.none}</p>
      ) : (
        <div>
          <p className="muted" style={{ marginBottom: 8 }}>
            {copy.earlyExit.pickerLead}
          </p>
          <div className="stack" style={{ gap: 8 }}>
            {candidates.slice(0, 5).map((o) => {
              const econ = sellerEconomics(
                live,
                BigInt(o.interestRateBps),
                chainNow,
              );
              const isSelected = o.offerId === selectedId;
              return (
                <button
                  key={o.offerId}
                  type="button"
                  className={`btn ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ justifyContent: 'space-between', width: '100%' }}
                  disabled={busy}
                  onClick={() => choose(o.offerId)}
                >
                  <span>
                    Offer #{o.offerId} · {formatBpsAsPercent(o.interestRateBps)}{' '}
                    yearly · {formatDurationDays(o.durationDays)}
                  </span>
                  <span>
                    {copy.earlyExit.rowReceive(
                      `${formatTokenAmount(econ.toSeller, dec)} ${sym}`,
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {candidates.length > 5 ? (
            // Never a silent cap — the hidden ones pay less (sorted),
            // but their existence is stated.
            <p className="muted" style={{ marginTop: 8 }}>
              {copy.earlyExit.moreOffers(candidates.length - 5)}
            </p>
          ) : null}

          {selected && selectedEcon && toSellerStr ? (
            <div style={{ marginTop: 12 }}>
              {driftNotice ? (
                <div className="banner banner-info" role="status" style={{ marginBottom: 12 }}>
                  <span className="banner-body">{copy.earlyExit.figureMoved}</span>
                </div>
              ) : null}
              {selectedEcon.hasShortfall ? (
                <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                  <span className="banner-body">{copy.earlyExit.shortfallWarn}</span>
                </div>
              ) : null}
              {!confirmOpen ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !walletReady}
                  onClick={() => {
                    setDriftNotice(false);
                    onOpenConfirm();
                  }}
                >
                  {copy.earlyExit.action}
                </button>
              ) : (
                <ConfirmReceipt
                  busy={busy}
                  confirmLabel={copy.earlyExit.confirm}
                  onBack={onCloseConfirm}
                  onConfirm={() => void submit()}
                  disabled={!walletReady}
                  data={{
                    youReceive: `~${toSellerStr}, paid straight to your wallet in the same transaction — nothing to claim afterwards.`,
                    youLock: 'Nothing.',
                    youMayOwe: `Nothing — you approve nothing and pay nothing out of pocket. ${copy.earlyExit.forfeitNote}`,
                    youCanLose: `The interest accrued so far${selectedEcon.hasShortfall ? ' and the rate difference for the remaining term' : ''} — already reflected in the figure above. The exact amount is re-read live when you confirm.`,
                    fees: 'The protocol’s cut comes out of the forfeited interest — never out of your payout beyond the figure shown.',
                    whenThisEnds:
                      'Immediately — your position transfers to the buyer and you’re done with this loan. The borrower’s rate and due date don’t change.',
                  }}
                />
              )}
            </div>
          ) : null}
        </div>
      )}

      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
