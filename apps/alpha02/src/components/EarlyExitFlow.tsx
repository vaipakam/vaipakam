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
import { encodeFunctionData } from 'viem';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import {
  assertAssetNotPausedLive,
  assertPositionNftHeldLive,
} from '../contracts/preflights';
import {
  BASIS_POINTS,
  LOAN_STATUS_ACTIVE,
  SECONDS_PER_YEAR,
  durationFitDays,
  readLoanLive,
  sellerEconomics,
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
import { SimulationPreview } from './SimulationPreview';
import type { TxSimInput } from '../contracts/useTxSimulation';
import type { TokenMeta } from '../contracts/erc20';


export function EarlyExitFlow({
  row,
  live,
  chainNow,
  principalMeta,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  onSold,
  busy,
  setBusy,
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
  /** The position left this wallet — the PAGE latches (soldThisSession)
   *  and carries the outcome banner, so a remount of this component
   *  (mode toggle, gate flicker) can't resurrect the stale-indexer
   *  picker inside the ownership-refresh window. */
  onSold: () => void;
  /** SHARED lender-block write lock (also held by the sale-listing
   *  card) — two exit writes must never be in flight together. */
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const offers = useActiveOffers();

  const [error, setError] = useState<string | null>(null);
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

  // #1028 item 2 (round 1) — the instant-exit sale is exactly the
  // preview's best case: both args exist pre-sign, no artefacts, and
  // a stale or consumed buy offer shows up as a would-fail heads-up
  // before the wallet prompt.
  const simTx = useMemo((): TxSimInput | null => {
    if (!walletChain || !selected) return null;
    return {
      to: walletChain.diamondAddress,
      data: encodeFunctionData({
        abi: DIAMOND_ABI_VIEM,
        functionName: 'sellLoanViaBuyOffer',
        args: [BigInt(row.loanId), BigInt(selected.offerId)],
      }),
      value: 0n,
    };
  }, [walletChain, selected, row.loanId]);

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
        (liveLoan.principal * liveLoan.interestRateBps * 2n * 86_400n) /
        (SECONDS_PER_YEAR * BASIS_POINTS);
      if (liveEcon.toSeller + twoDaysInterest < reviewedToSeller) {
        throw new Error(copy.match.termsChanged);
      }
      await write('sellLoanViaBuyOffer', [
        BigInt(row.loanId),
        BigInt(selected.offerId),
      ]);
      onSold();
      setSelectedId(null);
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['positionOwners'] });
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);

  // The selected offer stays VISIBLE even when fresh candidates push
  // it past the display cap — an open review must never belong to a
  // row the user can't see (they'd confirm a hidden, worse-paying
  // offer believing it's one of the shown ones).
  const shown = candidates ? candidates.slice(0, 5) : [];
  if (selected && !shown.some((o) => o.offerId === selected.offerId)) {
    shown.push(selected);
  }

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
            {shown.map((o) => {
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

          {/* Rendered OUTSIDE the selected-guard: the one case where
              the review vanishes entirely (the chosen offer dropped
              out of the book) is exactly when the explanation matters
              most. */}
          {driftNotice ? (
            <div className="banner banner-info" role="status" style={{ marginTop: 12 }}>
              <span className="banner-body">{copy.earlyExit.figureMoved}</span>
            </div>
          ) : null}

          {selected && selectedEcon && toSellerStr ? (
            <div style={{ marginTop: 12 }}>
              {selectedEcon.shortfallBinding ? (
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
                    // Names the exact offer — an open review must
                    // never be ambiguous about which row it binds.
                    youReceive: `~${toSellerStr}, paid straight to your wallet in the same transaction — selling to offer #${selected.offerId} at ${formatBpsAsPercent(selected.interestRateBps)} yearly. Nothing to claim afterwards.`,
                    youLock: copy.earlyExit.receiptLockNothing,
                    youMayOwe: `${copy.earlyExit.receiptOweNothing} ${copy.earlyExit.forfeitNote}`,
                    // max(accrued, shortfall) — never the sum.
                    youCanLose: copy.earlyExit.receiptCanLose,
                    fees: copy.earlyExit.receiptFees,
                    whenThisEnds: copy.earlyExit.receiptEnds,
                  }}
                >
                  <SimulationPreview tx={simTx} />
                </ConfirmReceipt>
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
