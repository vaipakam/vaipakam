/**
 * #3845 — post a request to take over THIS loan's debt
 * (`OfferCreateFacet.createTakeoverOffer`, #3844).
 *
 * Shown on a loan's page to a connected wallet that holds neither of its
 * positions. The request is a Borrower offer naming the loan: it stays off
 * the offer book, no lender can fill it, and only the loan's current
 * borrower can use it, through the handover (`ObligationTransferFlow`).
 * The requester's collateral is locked in the requester's own vault when
 * the request is posted, and released when it is cancelled.
 *
 * The rules a usable request must meet live in `data/takeoverRequest`, and
 * submit re-reads the loan and re-checks them live before any approval, so
 * a request the handover would refuse is never posted. What the page says
 * is what the chain does: the debt taken on is the loan's principal, the
 * rate is the requester's own, and the request's expiry is the last moment
 * its term still ends by the loan's due date.
 *
 * Scope: ERC-20 lending with ERC-20 collateral (see the data module); the
 * card says so for any other loan instead of offering a request that
 * could not be built.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { ensureAllowance, type TokenMeta } from '../contracts/erc20';
import { assertErc20BalanceLive } from '../contracts/preflights';
import { readTxValidUntil } from '../contracts/txDeadline';
import { loanEndTimeOf, readLoanLive, type LoanLive } from '../contracts/loanLive';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import {
  checkTakeoverTerms,
  maxTakeoverDays,
  takeoverRequestExpiry,
  takeoverScope,
  toTakeoverOfferPayload,
  type TakeoverScopeRefusal,
  type TakeoverSourceLoan,
  type TakeoverTermsRefusal,
} from '../data/takeoverRequest';
import type { IndexedLoan } from '../data/indexer';
import { percentToBps } from '../lib/offerSchema';
import {
  exactUnitsOrNull,
  formatBpsAsPercent,
  formatDateTime,
  formatTokenAmountExact,
} from '../lib/format';
import { useReviewConsent } from '../hooks/useReviewConsent';
import { ConsentWithdrawnNote } from './ConsentWithdrawnNote';
import { ConfirmReceipt } from './ConfirmReceipt';

function sourceOf(live: LoanLive, row: IndexedLoan): TakeoverSourceLoan {
  return {
    status: live.status,
    principal: live.principal,
    principalAsset: live.principalAsset,
    // The lent asset's kind is fixed at the loan's start; the row carries it.
    assetType: row.assetType,
    collateralAsset: live.collateralAsset,
    collateralAssetType: live.collateralAssetType,
    collateralAmount: live.collateralAmount,
    prepayAsset: live.prepayAsset,
    allowsPartialRepay: live.allowsPartialRepay,
    useFullTermInterest: live.useFullTermInterest,
  };
}

function scopeText(r: TakeoverScopeRefusal): string {
  switch (r) {
    case 'not-active':
      return copy.takeoverRequest.notActive;
    case 'rental':
      return copy.takeoverRequest.rental;
    case 'nft-collateral':
      return copy.takeoverRequest.nftCollateral;
    case 'no-term-left':
      return copy.takeoverRequest.noTermLeft;
  }
}

export function TakeoverRequestFlow({
  row,
  principalMeta,
  collateralMeta,
}: {
  row: IndexedLoan;
  principalMeta: TokenMeta;
  /** Undefined for NFT collateral or while loading. */
  collateralMeta: TokenMeta | undefined;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const termsVerdict = useTermsBlockNonExitWrites();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [rateInput, setRateInput] = useState('');
  const [durationInput, setDurationInput] = useState('');
  const [collateralInput, setCollateralInput] = useState('');

  // The loan as the chain has it, read only once the visitor opens the
  // form (a page visit by itself costs no reads).
  const liveQuery = useQuery({
    queryKey: ['takeoverRequestLoan', walletChain?.chainId, row.loanId],
    enabled: open && Boolean(publicClient && walletChain),
    staleTime: 30_000,
    queryFn: async () => {
      const [live, block] = await Promise.all([
        readLoanLive(publicClient!, walletChain!.diamondAddress, row.loanId),
        publicClient!.getBlock({ blockTag: 'latest' }),
      ]);
      return { live, chainNow: block.timestamp };
    },
  });
  const live = liveQuery.data?.live;
  const chainNow = liveQuery.data?.chainNow ?? 0n;
  const source = live ? sourceOf(live, row) : null;
  const maturity = live ? loanEndTimeOf(live, chainNow) : 0n;
  const scope = source ? takeoverScope(source, maturity, chainNow) : null;
  const maxDays = live ? maxTakeoverDays(maturity, chainNow) : 0;

  const pSym = principalMeta.symbol;
  const pDec = principalMeta.decimals;
  const cSym = collateralMeta?.symbol ?? '';
  const cDec = collateralMeta?.decimals;

  // Seed the form from the loan once it is read: the loan's own rate, the
  // longest term that fits, and the collateral securing it now.
  if (live && scope === null && collateralMeta && rateInput === '' && durationInput === '' && collateralInput === '') {
    setRateInput(String(Number(live.interestRateBps) / 100));
    setDurationInput(String(maxDays));
    setCollateralInput(formatTokenAmountExact(live.collateralAmount, collateralMeta.decimals).replace(/,/g, ''));
  }

  const rateBps = rateInput.trim() === '' ? null : percentToBps(rateInput.trim());
  const durationDays = /^\d+$/.test(durationInput) ? parseInt(durationInput, 10) : null;
  const collateralAmount = cDec === undefined ? null : exactUnitsOrNull(collateralInput, cDec);
  const termsRefusal: TakeoverTermsRefusal | 'incomplete' | null =
    !source || rateBps === null || durationDays === null || collateralAmount === null
      ? 'incomplete'
      : checkTakeoverTerms(source, { rateBps, durationDays, collateralAmount }, maturity, chainNow);
  const expiresAt =
    durationDays !== null && durationDays >= 1 ? takeoverRequestExpiry(maturity, durationDays) : null;

  // Consent covers exactly what was reviewed.
  const consent = useReviewConsent([
    row.loanId,
    rateBps,
    durationDays,
    collateralAmount,
    expiresAt,
    live?.principal,
    live?.collateralAmount,
    address,
    walletChain?.chainId,
  ]);

  function setTerm(setter: (v: string) => void, value: string) {
    setter(value);
    setConfirmOpen(false);
  }

  async function submit() {
    if (flowDisabled('post-offer')) {
      setError(copy.killSwitch.disabled);
      return;
    }
    if (!address || !walletChain || !walletClient || !publicClient) return;
    if (rateBps === null || durationDays === null || collateralAmount === null || !consent.given) return;
    setBusy(true);
    setError(null);
    try {
      await assertWalletNotSanctionedLive(publicClient, walletChain.diamondAddress, address);
      // Re-read the loan and judge the reviewed terms against it now: the
      // collateral it holds, its status and its due date can all move.
      const [fresh, block] = await Promise.all([
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
      ]);
      const freshSource = sourceOf(fresh, row);
      const freshMaturity = loanEndTimeOf(fresh, block.timestamp);
      const freshScope = takeoverScope(freshSource, freshMaturity, block.timestamp);
      if (freshScope) throw new Error(scopeText(freshScope));
      const freshExpiry = takeoverRequestExpiry(freshMaturity, durationDays);
      if (
        checkTakeoverTerms(freshSource, { rateBps, durationDays, collateralAmount }, freshMaturity, block.timestamp) ||
        fresh.principal !== live?.principal ||
        freshExpiry !== expiresAt ||
        freshExpiry <= block.timestamp
      ) {
        void queryClient.invalidateQueries({ queryKey: ['takeoverRequestLoan'] });
        throw new Error(copy.match.termsChanged);
      }
      const payload = toTakeoverOfferPayload(freshSource, {
        rateBps,
        durationDays,
        collateralAmount,
        expiresAt: freshExpiry,
        consent: true,
      });
      // Refuse before the approval: this page is exempt from the Terms
      // gate so a borrower can repay, but posting a request is not an exit.
      const verdict = termsVerdict();
      if (verdict !== 'ok') {
        throw new Error(verdict === 'unknown' ? copy.errors.termsCheckUnavailable : copy.errors.termsNotAccepted);
      }
      await assertErc20BalanceLive({
        publicClient,
        token: freshSource.collateralAsset,
        owner: address,
        amount: collateralAmount,
        symbol: cSym,
      });
      await ensureAllowance({
        publicClient,
        walletClient,
        token: freshSource.collateralAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: collateralAmount,
      });
      const validUntil = await readTxValidUntil(publicClient);
      await write('createTakeoverOffer', [BigInt(row.loanId), payload, validUntil]);
      consent.clear();
      setConfirmOpen(false);
      setDone(copy.takeoverRequest.done);
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  const walletReady = onSupportedChain && Boolean(walletClient) && Boolean(publicClient);
  const principalStr = live ? `${formatTokenAmountExact(live.principal, pDec)} ${pSym}` : '';
  const loanCollateralStr =
    live && cDec !== undefined ? `${formatTokenAmountExact(live.collateralAmount, cDec)} ${cSym}` : '';
  const yourCollateralStr =
    collateralAmount !== null && cDec !== undefined ? `${formatTokenAmountExact(collateralAmount, cDec)} ${cSym}` : '';
  const rateStr = rateBps !== null ? formatBpsAsPercent(rateBps) : '';

  return (
    <section className="card" data-testid="takeover-request">
      <h3>{copy.takeoverRequest.title}</h3>
      <p className="muted">{copy.takeoverRequest.blurb}</p>
      {!open ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!walletReady || flowDisabled('post-offer')}
          onClick={() => setOpen(true)}
        >
          {copy.takeoverRequest.start}
        </button>
      ) : liveQuery.isLoading ? (
        <p className="muted">{copy.takeoverRequest.reading}</p>
      ) : !live ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{copy.takeoverRequest.readFailed}</span>
        </div>
      ) : scope ? (
        <div className="banner banner-info" role="status">
          <span className="banner-body">{scopeText(scope)}</span>
        </div>
      ) : !collateralMeta ? (
        <p className="muted">{copy.takeoverRequest.reading}</p>
      ) : (
        <div>
          <ul className="muted" style={{ marginBottom: 12 }}>
            <li>{copy.takeoverRequest.factPrincipal(principalStr)}</li>
            <li>{copy.takeoverRequest.factRate(formatBpsAsPercent(Number(live.interestRateBps)))}</li>
            <li>{copy.takeoverRequest.factDue(formatDateTime(Number(maturity)))}</li>
            <li>{copy.takeoverRequest.factCollateral(loanCollateralStr)}</li>
          </ul>
          <div className="cluster">
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{copy.takeoverRequest.rateLabel}</span>
              <input
                className="input"
                inputMode="decimal"
                value={rateInput}
                onChange={(e) => setTerm(setRateInput, e.target.value.trim())}
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{copy.takeoverRequest.durationLabel}</span>
              <input
                className="input"
                inputMode="numeric"
                value={durationInput}
                onChange={(e) => setTerm(setDurationInput, e.target.value.trim())}
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{copy.takeoverRequest.collateralLabel(cSym)}</span>
              <input
                className="input"
                inputMode="decimal"
                value={collateralInput}
                onChange={(e) => setTerm(setCollateralInput, e.target.value.trim())}
              />
            </label>
          </div>
          {termsRefusal === 'rate' || (rateInput !== '' && rateBps === null) ? (
            <p className="field-hint" role="alert" style={{ color: 'var(--danger)' }}>
              {copy.takeoverRequest.rateRange}
            </p>
          ) : null}
          {termsRefusal === 'duration' || (durationInput !== '' && durationDays === null) ? (
            <p className="field-hint" role="alert" style={{ color: 'var(--danger)' }}>
              {copy.takeoverRequest.durationRange(String(maxDays))}
            </p>
          ) : null}
          {termsRefusal === 'collateral-short' || (collateralInput !== '' && collateralAmount === null) ? (
            <p className="field-hint" role="alert" style={{ color: 'var(--danger)' }}>
              {copy.takeoverRequest.collateralMin(loanCollateralStr)}
            </p>
          ) : null}
          <p className="muted">{copy.takeoverRequest.rateNote}</p>
          {expiresAt !== null && termsRefusal === null ? (
            <p className="muted">{copy.takeoverRequest.usableUntil(formatDateTime(Number(expiresAt)))}</p>
          ) : null}
          <p className="muted">
            {copy.takeoverRequest.waitNote} {copy.takeoverRequest.keepsSettings}
          </p>
          {!confirmOpen ? (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: 12 }}
              disabled={busy || !walletReady || termsRefusal !== null || flowDisabled('post-offer')}
              onClick={() => setConfirmOpen(true)}
            >
              {copy.takeoverRequest.action}
            </button>
          ) : (
            <div style={{ marginTop: 16 }}>
              <label className="cluster" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={consent.given}
                  onChange={(e) => consent.set(e.target.checked)}
                  style={{ marginTop: 4 }}
                />
                <span>{copy.takeoverRequest.consentLabel}</span>
              </label>
              <ConsentWithdrawnNote consent={consent} />
              <ConfirmReceipt
                busy={busy}
                confirmLabel={copy.takeoverRequest.confirm}
                onBack={() => setConfirmOpen(false)}
                onConfirm={() => void submit()}
                disabled={!walletReady || !consent.given || termsRefusal !== null || flowDisabled('post-offer')}
                data={{
                  youReceive: copy.takeoverRequest.receiptReceive,
                  youLock: copy.takeoverRequest.receiptLock(yourCollateralStr),
                  youMayOwe: copy.takeoverRequest.receiptOwe(principalStr, rateStr),
                  youCanLose: copy.takeoverRequest.receiptLose,
                  fees: copy.takeoverRequest.receiptFees,
                  whenThisEnds: `${expiresAt !== null ? copy.takeoverRequest.usableUntil(formatDateTime(Number(expiresAt))) : ''} ${copy.takeoverRequest.receiptEnds}`.trim(),
                }}
              />
            </div>
          )}
        </div>
      )}
      {flowDisabled('post-offer') ? (
        <div className="banner banner-warn" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{copy.killSwitch.disabled}</span>
        </div>
      ) : null}
      {done ? (
        <div className="banner banner-info" role="status" style={{ marginTop: 12 }}>
          <span className="banner-body">{done}</span>
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
