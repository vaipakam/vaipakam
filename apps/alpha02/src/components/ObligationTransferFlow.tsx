/**
 * Borrower preclose Option 2 — hand the loan's obligation to a
 * replacement borrower by consuming their standing Borrower Offer
 * (PrecloseFacet.transferObligationViaOffer). Atomic: the new
 * borrower's collateral (already escrowed at their offer creation)
 * replaces the exiting borrower's, the exiting borrower pays accrued
 * interest + the lender rate top-up in the same transaction, and the
 * lender keeps the same position.
 *
 * The picker lists ONLY offers the contract would accept — the
 * asset-continuity + lender-favourability triad is mirrored here so a
 * doomed pick is never offered:
 *   - Borrower offer, active, unfilled, not a sale vehicle
 *   - same lending/collateral/prepay assets + collateral asset type
 *   - offer amount range covers the loan's outstanding principal
 *   - offer collateral >= the loan's collateral
 *   - now + offer duration <= the loan's ORIGINAL maturity
 *   - a different wallet than the exiting borrower
 * Refinance-tagged offers can't be told apart on the indexed row, so
 * they're filtered by the live `getOfferDetails` read at submit
 * (which also re-checks everything above against live state).
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance } from '../contracts/erc20';
import {
  assertErc20BalanceLive,
  assertPositionNftHeldLive,
} from '../contracts/preflights';
import {
  loanEndTimeOf,
  LOAN_STATUS_ACTIVE,
  readLoanLive,
  transferEconomicsOf,
  type LoanLive,
} from '../contracts/loanLive';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import { useActiveOffers } from '../data/hooks';
import type { IndexedLoan, IndexedOffer } from '../data/indexer';
import {
  formatBpsAsPercent,
  formatDurationDays,
  formatTokenAmount,
  fullTermInterest,
  shortAddress,
} from '../lib/format';
import { AssetType } from '../lib/types';
import { ConfirmReceipt } from './ConfirmReceipt';
import type { TokenMeta } from '../contracts/erc20';

/** Mirror of the contract's candidate admission — exported for the
 *  submit-time re-check (same predicate, live values). */
function offerEligible(
  o: IndexedOffer,
  live: LoanLive,
  chainNow: bigint,
  myAddress: string,
): boolean {
  if (o.offerType !== 1) return false; // Borrower offers only
  if (o.status !== 'active') return false;
  if (o.isSaleVehicle) return false;
  if (o.assetType !== AssetType.ERC20) return false;
  if (o.lendingAsset.toLowerCase() !== live.principalAsset.toLowerCase())
    return false;
  if (o.collateralAsset.toLowerCase() !== live.collateralAsset.toLowerCase())
    return false;
  if (o.collateralAssetType !== live.collateralAssetType) return false;
  if (o.prepayAsset.toLowerCase() !== live.prepayAsset.toLowerCase())
    return false;
  if (BigInt(o.amountFilled) !== 0n) return false;
  const amt = BigInt(o.amount);
  const amtMax = BigInt(o.amountMax);
  if (amtMax === 0n) {
    if (amt !== live.principal) return false;
  } else if (amt > live.principal || live.principal > amtMax) {
    return false;
  }
  if (BigInt(o.collateralAmount) < live.collateralAmount) return false;
  if (chainNow + BigInt(o.durationDays) * 86_400n > loanEndTimeOf(live))
    return false;
  if (o.creator.toLowerCase() === myAddress.toLowerCase()) return false;
  if (o.expiresAt && BigInt(o.expiresAt) !== 0n && BigInt(o.expiresAt) <= chainNow)
    return false;
  return true;
}

export function ObligationTransferFlow({
  row,
  live,
  chainNow,
  principalMeta,
  collateralMeta,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  onDone,
  busy,
  setBusy,
}: {
  row: IndexedLoan;
  live: LoanLive;
  /** Chain time from the parent's live query — never the device clock. */
  chainNow: bigint;
  principalMeta: TokenMeta;
  /** Undefined for NFT collateral — the candidate line degrades. */
  collateralMeta: TokenMeta | undefined;
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** The handover settled — the parent latches + banners. */
  onDone: () => void;
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
  const [pickedId, setPickedId] = useState<number | null>(null);

  const candidates = useMemo(() => {
    if (!offers.data || !address) return offers.data;
    const list = offers.data.filter((o) =>
      offerEligible(o, live, chainNow, address),
    );
    // Cheapest handover first (accrued is common to all — the offer's
    // rate/duration decide the top-up).
    return list
      .map((o) => ({
        o,
        cost: transferEconomicsOf(
          live,
          BigInt(o.interestRateBps),
          BigInt(o.durationDays),
          chainNow,
        ),
      }))
      .sort((a, b) => (a.cost.total < b.cost.total ? -1 : 1))
      .map((x) => x.o);
  }, [offers.data, address, live, chainNow]);

  const picked = useMemo(
    () => candidates?.find((o) => o.offerId === pickedId) ?? null,
    [candidates, pickedId],
  );
  const economics = picked
    ? transferEconomicsOf(
        live,
        BigInt(picked.interestRateBps),
        BigInt(picked.durationDays),
        chainNow,
      )
    : null;

  // A picked offer can drop out of the candidate list (accepted or
  // cancelled elsewhere, or the book refetched) — close the review
  // rather than let a stale receipt invite a doomed signature.
  useEffect(() => {
    if (pickedId !== null && candidates && !picked) {
      setPickedId(null);
      onCloseConfirm();
    }
  }, [pickedId, candidates, picked, onCloseConfirm]);

  const dec = principalMeta.decimals;
  const sym = principalMeta.symbol;
  const fmt = (v: bigint) => `${formatTokenAmount(v, dec)} ${sym}`;

  function collateralStrOf(o: IndexedOffer): string {
    if (o.collateralAssetType !== AssetType.ERC20 || !collateralMeta) {
      return `NFT ${shortAddress(o.collateralAsset)}`;
    }
    return `${formatTokenAmount(o.collateralAmount, collateralMeta.decimals)} ${collateralMeta.symbol}`;
  }

  async function submit() {
    if (!address || !walletChain || !walletClient || !publicClient) return;
    if (!picked || !economics) return;
    // The handover consumes an existing offer — same kill switch as
    // the direct accept path during an OfferFacet incident.
    if (flowDisabled('accept-offer')) {
      setError(copy.killSwitch.disabled);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // transferObligationViaOffer is Tier-1 — live re-screen first.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      const [, liveLoan, liveOffer, latestBlock] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.borrowerTokenId,
          expectedOwner: address,
        }),
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getOfferDetails',
          args: [BigInt(picked.offerId)],
        }) as Promise<{
          creator: string;
          accepted: boolean;
          amount: bigint;
          amountMax: bigint;
          amountFilled: bigint;
          refinanceTargetLoanId: bigint;
          interestRateBps: bigint;
          durationDays: bigint;
          collateralAmount: bigint;
          expiresAt: bigint;
        }>,
        publicClient.getBlock({ blockTag: 'latest' }),
      ]);
      if (liveLoan.status !== LOAN_STATUS_ACTIVE) {
        setError(copy.errors.loanAlreadySettled);
        return;
      }
      // Live re-check of the offer: gone/accepted/filled offers, a
      // refinance-tagged offer (single-purpose, #576 — invisible on
      // the indexed row), or drifted terms all fail HERE, before any
      // approval, instead of as an opaque revert.
      const gone =
        liveOffer.creator ===
          '0x0000000000000000000000000000000000000000' ||
        liveOffer.accepted ||
        liveOffer.amountFilled !== 0n ||
        liveOffer.refinanceTargetLoanId !== 0n ||
        // Amount range must cover the LIVE principal (a partial repay
        // mid-flight shrinks it under an exact-amount offer).
        (liveOffer.amountMax === 0n
          ? liveOffer.amount !== liveLoan.principal
          : liveOffer.amount > liveLoan.principal ||
            liveLoan.principal > liveOffer.amountMax) ||
        liveOffer.collateralAmount < liveLoan.collateralAmount ||
        (liveOffer.expiresAt !== 0n &&
          liveOffer.expiresAt <= latestBlock.timestamp) ||
        latestBlock.timestamp + liveOffer.durationDays * 86_400n >
          loanEndTimeOf(liveLoan);
      if (gone) {
        setError(copy.transferOb.offerGone);
        void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
        return;
      }
      // Offers are MUTABLE in place (modifyOffer) — if any reviewed
      // term drifted since the picker rendered (a lowered rate grows
      // the shortfall the borrower pays; a changed duration moves it
      // too), the receipt's figures no longer describe this handover.
      // Force a fresh review against current terms instead of quietly
      // paying more than was reviewed (Codex #1500 r1 P1).
      if (
        liveOffer.interestRateBps !== BigInt(picked.interestRateBps) ||
        liveOffer.durationDays !== BigInt(picked.durationDays) ||
        liveOffer.collateralAmount !== BigInt(picked.collateralAmount)
      ) {
        setError(copy.match.termsChanged);
        void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
        setPickedId(null);
        onCloseConfirm();
        return;
      }
      // The pull = accrued (seconds-precise, keeps growing while the
      // tx is pending) + shortfall. Recompute from live figures; the
      // BALANCE gate checks what the contract can actually pull now
      // (seconds-precision growth over a pending tx is negligible —
      // a short-by-seconds wallet only makes the whole tx revert
      // safely), while the ALLOWANCE keeps a ~2-day interest pad so a
      // day-boundary in flight can't strand an otherwise-funded
      // handover; the contract pulls only what it recomputes, so the
      // pad is never spent (Codex #1500 r1).
      const liveCost = transferEconomicsOf(
        liveLoan,
        liveOffer.interestRateBps,
        liveOffer.durationDays,
        latestBlock.timestamp,
      );
      const pad = fullTermInterest(
        liveLoan.principal,
        Number(liveLoan.interestRateBps),
        2,
      );
      if (liveCost.total > 0n) {
        await assertErc20BalanceLive({
          publicClient,
          token: liveLoan.principalAsset,
          owner: address,
          amount: liveCost.total,
          symbol: sym,
        });
      }
      if (liveCost.total + pad > 0n) {
        await ensureAllowance({
          publicClient,
          walletClient,
          token: liveLoan.principalAsset,
          owner: address,
          spender: walletChain.diamondAddress,
          amount: liveCost.total + pad,
        });
      }
      await write('transferObligationViaOffer', [
        BigInt(row.loanId),
        BigInt(picked.offerId),
      ]);
      onDone();
      onCloseConfirm();
      setPickedId(null);
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
      void queryClient.invalidateQueries({ queryKey: ['claimables'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);

  return (
    <section className="card" id="transfer-card">
      <h3>{copy.transferOb.title}</h3>
      <p className="muted">{copy.transferOb.blurb}</p>

      {offers.isLoading || candidates === undefined ? (
        <p className="muted">{copy.transferOb.checking}</p>
      ) : candidates === null ? (
        <p className="muted">{copy.transferOb.bookUnavailable}</p>
      ) : candidates.length === 0 ? (
        <p className="muted">{copy.transferOb.noneFound}</p>
      ) : !confirmOpen ? (
        <>
          <p className="field-label" style={{ marginBottom: 4 }}>
            {copy.transferOb.pickLabel}
          </p>
          <div className="stack" style={{ gap: 8 }}>
            {candidates.map((o) => {
              const cost = transferEconomicsOf(
                live,
                BigInt(o.interestRateBps),
                BigInt(o.durationDays),
                chainNow,
              );
              return (
                <div className="item-row" key={o.offerId}>
                  <div className="row-main">
                    <div className="row-title">
                      {copy.transferOb.candidateLine(
                        String(o.offerId),
                        formatBpsAsPercent(o.interestRateBps),
                        formatDurationDays(o.durationDays),
                        collateralStrOf(o),
                      )}
                    </div>
                    <div className="row-sub">
                      {copy.transferOb.yourCostLine(fmt(cost.total))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !walletReady}
                    onClick={() => {
                      setPickedId(o.offerId);
                      onOpenConfirm();
                    }}
                  >
                    {copy.transferOb.select}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      ) : picked && economics ? (
        <div style={{ marginTop: 8 }}>
          <p className="muted" style={{ marginBottom: 8 }}>
            {copy.transferOb.selected(String(picked.offerId))}{' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => {
                setPickedId(null);
                onCloseConfirm();
              }}
            >
              {copy.transferOb.changePick}
            </button>
          </p>
          <ConfirmReceipt
            busy={busy}
            confirmLabel={copy.transferOb.confirm}
            onBack={() => {
              setPickedId(null);
              onCloseConfirm();
            }}
            onConfirm={() => void submit()}
            disabled={!walletReady || flowDisabled('accept-offer')}
            data={{
              youReceive: copy.transferOb.receiptReceive,
              youLock: copy.transferOb.receiptLock,
              youMayOwe: copy.transferOb.receiptOwe(
                fmt(economics.total),
                fmt(economics.accrued),
                fmt(economics.shortfall),
              ),
              youCanLose: copy.transferOb.receiptLose,
              fees: copy.transferOb.receiptFees,
              whenThisEnds: copy.transferOb.receiptEnds,
            }}
          />
        </div>
      ) : null}

      {flowDisabled('accept-offer') ? (
        <div className="banner banner-warn" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{copy.killSwitch.disabled}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
