import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWalletClient } from 'wagmi';
import type { Address } from 'viem';
import type { IndexedOffer } from '@vaipakam/defi-client';
import {
  acceptOfferFlow,
  createBorrowerOffer,
  formatBpsAsPercent,
  matchOffersToBorrowIntent,
  netBorrowProceedsWei,
  offerPrincipalWei,
  OFFER_DURATION_DEFAULT_DAYS,
} from '@vaipakam/defi-client';

import { AmountField } from '../components/AmountField';
import { CollateralBalanceHint } from '../components/CollateralBalanceHints';
import { AssetAmount } from '../components/AssetAmount';
import { BasicAssetPicker } from '../components/BasicAssetPicker';
import { DurationSelect } from '../components/DurationSelect';
import { EligibilityChecklist } from '../components/EligibilityChecklist';
import { FlowDone } from '../components/FlowDone';
import { HelpLink } from '../components/HelpLink';
import { ReviewReceipt, type ReviewReceiptView } from '../components/ReviewReceipt';
import { RiskConsentLabel } from '../components/RiskConsentLabel';
import { useWallet } from '../context/WalletContext';
import { useLoanInitiationFeeBps } from '../hooks/useProtocolConfig';
import { useSanctionsCheck } from '../hooks/useSanctionsCheck';
import { useLenderOffersForBorrow } from '../hooks/useIndexedOffers';
import { useSpendableBalance } from '../hooks/useSpendableBalance';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from '../hooks/useDiamond';
import { AdvancedPanel } from '../components/AdvancedPanel';
import { useMode } from '../context/ModeContext';
import {
  borrowAcceptTechnicalDetails,
  borrowRequestTechnicalDetails,
  offerBrowseTechnicalRows,
} from '../lib/advancedReceipt';
import { baseEligibilityItems, sanctionsAllowsProceed } from '../lib/eligibility';

import { assessCollateralBalance, parseHumanAmount } from '../lib/balanceCheck';
import { resolveSymbol } from '../lib/formatAsset';
import {
  hasResolvedTokenDecimals,
  peekTokenMeta,
  requireTokenDecimals,
  useTokenMeta,
  type TokenMeta,
} from '../lib/tokenMeta';

type Step = 'intent' | 'match' | 'check' | 'review' | 'done';
type Mode = 'accept' | 'request';

function borrowReceipt(
  offer: IndexedOffer,
  lendingMeta: TokenMeta | null,
  collateralMeta: TokenMeta | null,
  lifBps: number,
): ReviewReceiptView {
  const principalWei = offerPrincipalWei(offer);
  const lifBpsBig = BigInt(lifBps);
  const netWei = netBorrowProceedsWei(principalWei, lifBpsBig);
  const lifBpsLabel = formatBpsAsPercent(lifBps);
  return {
    youReceive: {
      label: 'You receive',
      value: (
        <>
          <AssetAmount
            mode="raw"
            amount={netWei.toString()}
            address={offer.lendingAsset}
            meta={lendingMeta}
          />{' '}
          in your wallet now (after the upfront loan initiation fee).
        </>
      ),
      hint:
        'You still owe the full headline principal at repayment; only the net amount above is sent to your wallet when you accept.',
    },
    youLock: {
      label: 'You lock',
      value: (
        <>
          <AssetAmount
            mode="raw"
            amount={offer.collateralAmount}
            address={offer.collateralAsset}
            meta={collateralMeta}
            assetType={offer.collateralAssetType}
            tokenId={offer.collateralTokenId}
          />{' '}
          collateral.
        </>
      ),
      hint: 'Collateral stays in your vault until you repay or default.',
    },
    youMayOwe: {
      label: 'You may owe',
      value: `Principal + ${formatBpsAsPercent(offer.interestRateBps)} APR over ${offer.durationDays} days.`,
    },
    youCanLose: {
      label: 'You can lose',
      value: 'Locked collateral if you do not repay on time.',
      hint: 'If you do not repay, the lender can receive your collateral.',
    },
    fees: {
      label: 'Fees',
      value: `${lifBpsLabel} loan initiation fee is deducted upfront from wallet proceeds. Settlement fees apply later at repayment.`,
      hint: 'Network gas is separate from Vaipakam protocol fees.',
    },
    whenEnds: {
      label: 'When this ends',
      value: `After ${offer.durationDays} days, or when you fully repay.`,
    },
    technicalDetails: borrowAcceptTechnicalDetails(offer, lifBps),
  };
}

function requestReceipt(
  amount: string,
  rate: string,
  duration: string,
  collateral: string,
  lendingAsset: string,
  collateralAsset: string,
  lendingMeta: TokenMeta | null,
  collateralMeta: TokenMeta | null,
  lifBps: number,
): ReviewReceiptView {
  return {
    youReceive: {
      label: 'You receive',
      value: 'Nothing yet — funds arrive only when a lender accepts.',
      hint: 'Your borrow request must be matched first.',
    },
    youLock: {
      label: 'You lock',
      value: (
        <>
          <AssetAmount mode="human" amount={collateral} address={collateralAsset} meta={collateralMeta} />{' '}
          collateral now.
        </>
      ),
      hint: 'Collateral is locked while the request is open.',
    },
    youMayOwe: {
      label: 'You may owe',
      value: (
        <>
          Up to{' '}
          <AssetAmount mode="human" amount={amount} address={lendingAsset} meta={lendingMeta} /> principal at{' '}
          {rate}% APR over {duration} days once matched.
        </>
      ),
    },
    youCanLose: {
      label: 'You can lose',
      value: 'Locked collateral if you default after a loan opens.',
    },
    fees: { label: 'Fees', value: 'Protocol fees at settlement (separate from network gas).' },
    whenEnds: { label: 'When this ends', value: 'When cancelled, matched, or the loan closes.' },
    technicalDetails: borrowRequestTechnicalDetails({ maxRate: rate, duration, lifBps }),
  };
}

export function BorrowWizard() {
  const navigate = useNavigate();
  const { mode: uiMode } = useMode();
  const { address, isCorrectChain, connect, switchToAppChain, activeChain } = useWallet();
  const chain = useReadChain();
  const diamond = useDiamondContract();
  const publicClient = useDiamondPublicClient();
  const { data: walletClient } = useWalletClient();
  const sanctions = useSanctionsCheck(address);
  const { data: lifBps = 10 } = useLoanInitiationFeeBps();
  const { data: offers, isLoading, isError: offersError, error: offersErr } = useLenderOffersForBorrow();

  const lendingDefault = chain.predominantStableAddress ?? activeChain?.predominantStableAddress ?? '';
  const collateralDefault = chain.wrappedNativeAddress ?? activeChain?.wrappedNativeAddress ?? '';

  const [step, setStep] = useState<Step>('intent');
  const [mode, setMode] = useState<Mode>('accept');
  const [amount, setAmount] = useState('');
  const [maxRate, setMaxRate] = useState('8');
  const [duration, setDuration] = useState(String(OFFER_DURATION_DEFAULT_DAYS));
  const [lendingAsset, setLendingAsset] = useState(lendingDefault);
  const [collateralAsset, setCollateralAsset] = useState(collateralDefault);
  const [collateralAmount, setCollateralAmount] = useState('');
  const [selected, setSelected] = useState<IndexedOffer | null>(null);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  const lendingMeta = useTokenMeta(lendingAsset || null);
  const collateralMeta = useTokenMeta(collateralAsset || null);
  const selectedLendingMeta = useTokenMeta(selected?.lendingAsset ?? null);
  const selectedCollateralMeta = useTokenMeta(selected?.collateralAsset ?? null);

  useEffect(() => {
    setLendingAsset(lendingDefault || '');
    setCollateralAsset(collateralDefault || '');
  }, [chain.chainId, lendingDefault, collateralDefault]);

  useEffect(() => {
    if (!selected) return;
    const wallet = address?.toLowerCase();
    const stillListed = (offers ?? []).some((o) => o.offerId === selected.offerId);
    const selfTrade = wallet && selected.creator.toLowerCase() === wallet;
    if (!stillListed || selfTrade) {
      setSelected(null);
      if (mode === 'accept') {
        setMode('request');
        setStep('match');
      }
    }
  }, [address, mode, offers, selected]);

  const borrowAmountWei = useMemo(() => {
    if (!hasResolvedTokenDecimals(lendingMeta, lendingAsset, chain.chainId)) return null;
    return parseHumanAmount(amount, lendingMeta!.decimals);
  }, [amount, lendingAsset, lendingMeta, chain.chainId]);

  const matched = useMemo(() => {
    if (borrowAmountWei == null) return [];
    const pool = offers ?? [];
    const parsedRate = Number(maxRate);
    const maxRateBps = Number.isFinite(parsedRate) ? Math.round(parsedRate * 100) : undefined;
    return matchOffersToBorrowIntent(pool, {
      lendingAsset: lendingAsset || undefined,
      collateralAsset: collateralAsset || undefined,
      durationDays: Number(duration) || undefined,
      maxRateBps,
      minBorrowAmountWei: borrowAmountWei,
    });
  }, [borrowAmountWei, offers, lendingAsset, collateralAsset, duration, maxRate]);

  const collateralToken =
    mode === 'accept' && selected ? selected.collateralAsset : collateralAsset;

  const { data: spendableBalance, isLoading: balanceLoading } = useSpendableBalance(
    collateralToken || null,
    address,
  );

  const collateralBalance = useMemo(
    () =>
      assessCollateralBalance({
        needHuman: mode === 'request' ? collateralAmount : '',
        needRaw: mode === 'accept' && selected ? selected.collateralAmount : undefined,
        balance: spendableBalance,
        tokenAddress: collateralToken,
        meta: mode === 'accept' ? selectedCollateralMeta : collateralMeta,
        chainId: chain.chainId,
        loading: balanceLoading,
      }),
    [
      balanceLoading,
      collateralAmount,
      collateralMeta,
      collateralToken,
      mode,
      selected,
      selectedCollateralMeta,
      spendableBalance,
    ],
  );

  const checklist = useMemo(
    () => [
      ...baseEligibilityItems({
        address,
        connect,
        chainName: chain.name,
        isCorrectChain,
        switchChain: () => void switchToAppChain(),
        consent,
        isSanctioned: sanctions.isSanctioned,
        sanctionsLoading: sanctions.loading,
        sanctionsUnverified: sanctions.unverified,
      }),
      ...(mode === 'request'
        ? [
            { id: 'collateral', label: 'Collateral amount entered', ok: Number(collateralAmount) > 0 },
            { id: 'amount', label: 'Borrow amount entered', ok: Number(amount) > 0 },
            {
              id: 'lending-decimals',
              label: lendingMeta?.symbol
                ? `${lendingMeta.symbol} decimals loaded`
                : 'Loading borrow asset decimals…',
              ok: hasResolvedTokenDecimals(lendingMeta, lendingAsset, chain.chainId),
            },
            {
              id: 'collateral-decimals',
              label: collateralMeta?.symbol
                ? `${collateralMeta.symbol} decimals loaded`
                : 'Loading collateral decimals…',
              ok: hasResolvedTokenDecimals(collateralMeta, collateralAsset, chain.chainId),
            },
          ]
        : []),
      ...(mode === 'accept' || mode === 'request'
        ? [
            collateralBalance.loading
              ? {
                  id: 'collateral-balance',
                  label: 'Checking collateral balance…',
                  ok: false,
                }
              : collateralBalance.sufficient === true
                ? {
                    id: 'collateral-balance',
                    label: 'Enough collateral in wallet',
                    ok: true,
                  }
                : collateralBalance.sufficient === false
                  ? {
                      id: 'collateral-balance',
                      label: 'Insufficient collateral balance',
                      ok: false,
                    }
                  : {
                      id: 'collateral-balance',
                      label: 'Collateral balance unavailable',
                      ok: false,
                    },
          ]
        : []),
    ],
    [
      address,
      amount,
      chain.name,
      collateralAmount,
      collateralAsset,
      collateralBalance.loading,
      collateralBalance.sufficient,
      collateralMeta,
      connect,
      consent,
      isCorrectChain,
      lendingAsset,
      lendingMeta,
      mode,
      sanctions,
      switchToAppChain,
    ],
  );

  const allOk =
    checklist.every((i) => i.ok) &&
    sanctionsAllowsProceed({
      isSanctioned: sanctions.isSanctioned,
      sanctionsLoading: sanctions.loading,
      sanctionsUnverified: sanctions.unverified,
    });

  const receiptData = useMemo((): ReviewReceiptView => {
    if (mode === 'accept' && selected) {
      return borrowReceipt(selected, selectedLendingMeta, selectedCollateralMeta, lifBps);
    }
    return requestReceipt(
      amount,
      maxRate,
      duration,
      collateralAmount,
      lendingAsset,
      collateralAsset,
      lendingMeta,
      collateralMeta,
      lifBps,
    );
  }, [
    amount,
    collateralAmount,
    collateralAsset,
    collateralMeta,
    duration,
    lendingAsset,
    lendingMeta,
    maxRate,
    mode,
    selected,
    selectedCollateralMeta,
    selectedLendingMeta,
    lifBps,
  ]);

  async function handleAccept() {
    if (!selected || !walletClient || !chain.diamondAddress) return;
    setSubmitting(true);
    setTxError(null);
    try {
      await acceptOfferFlow({
        diamond,
        publicClient,
        walletClient,
        diamondAddress: chain.diamondAddress as Address,
        chainId: chain.chainId,
        offer: selected,
        consent,
      });
      setStep('done');
    } catch (e) {
      setTxError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRequest() {
    if (!walletClient || !chain.diamondAddress || !lendingAsset || !collateralAsset) return;
    setSubmitting(true);
    setTxError(null);
    try {
      const lendingDecimals = requireTokenDecimals(
        lendingMeta,
        lendingAsset,
        'Borrow asset',
        chain.chainId,
      );
      const collateralDecimals = requireTokenDecimals(
        collateralMeta,
        collateralAsset,
        'Collateral asset',
        chain.chainId,
      );
      await createBorrowerOffer({
        diamond,
        publicClient,
        walletClient,
        diamondAddress: chain.diamondAddress as Address,
        form: {
          offerType: 'borrower',
          assetType: 'erc20',
          lendingAsset,
          amount,
          interestRate: maxRate,
          collateralAsset,
          collateralAmount,
          durationDays: duration,
          riskAndTermsConsent: consent,
        },
        decimals: { lending: lendingDecimals, collateral: collateralDecimals },
      });
      setStep('done');
    } catch (e) {
      setTxError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-frame page-frame--wide">
      <h1 className="page-title">Borrow assets</h1>
      <p className="page-subtitle">
        Tell us what you need, pick a matching lender offer, or post a borrow request.{' '}
        <HelpLink anchor="borrow" />
      </p>

      <div className="wizard-steps">
        {['intent', 'match', 'check', 'review', 'done'].map((s) => (
          <span key={s} className={`wizard-step ${step === s ? 'active' : ''}`}>
            {s === 'intent' ? 'Your needs' : s === 'match' ? 'Offers' : s === 'check' ? 'Eligibility' : s === 'review' ? 'Review' : 'Done'}
          </span>
        ))}
      </div>

      {uiMode === 'basic' ? (
        <p className="form-hint" style={{ marginBottom: 16 }}>
          Basic mode uses blue-chip assets only — your vault stays on the safest risk tier by default.
        </p>
      ) : null}

      {step === 'intent' ? (
        <>
          <div className="wizard-intent-form">
            <BasicAssetPicker
              kind="stablecoin"
              chainId={chain.chainId}
              value={lendingAsset}
              onChange={setLendingAsset}
              label="Asset to borrow"
              hint="Stablecoins and other widely-used borrow assets."
            />
            <AmountField
              label="Amount to borrow"
              value={amount}
              onChange={setAmount}
              placeholder="e.g. 100"
            />
            <BasicAssetPicker
              kind="collateral"
              chainId={chain.chainId}
              value={collateralAsset}
              onChange={setCollateralAsset}
              label="Collateral asset"
              hint="Major liquid assets (top market-cap tokens on this chain)."
            />
            <div className="wizard-intent-terms">
              <DurationSelect value={duration} onChange={setDuration} hint={null} />
              <div className="field">
                <label>Maximum interest rate (% APR)</label>
                <input
                  value={maxRate}
                  onChange={(e) => setMaxRate(e.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. 8"
                />
              </div>
              <p className="form-hint wizard-intent-terms-hint">
                Bucketed durations improve offer matching.
              </p>
            </div>
          </div>
          <div className="wizard-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={borrowAmountWei == null}
              onClick={() => setStep('match')}
            >
              Find matching offers
            </button>
          </div>
        </>
      ) : null}

      {step === 'match' ? (
        <>
          {uiMode === 'advanced' ? (
            <AdvancedPanel title="Your borrow bounds" testId="borrow-bounds-panel" defaultOpen={false}>
              <div>
                Borrow up to <strong>{amount || '—'}</strong>{' '}
                {resolveSymbol(lendingMeta, lendingAsset)} · max {maxRate}% APR · {duration} days
              </div>
              <div>
                Collateral: {resolveSymbol(collateralMeta, collateralAsset)}
                {matched.length > 0 ? ` · ${matched.length} offer${matched.length === 1 ? '' : 's'} in range` : ''}
              </div>
            </AdvancedPanel>
          ) : null}
          {offersError ? (
            <div className="banner banner-error">
              Could not load offers: {offersErr instanceof Error ? offersErr.message : 'Indexer request failed'}
            </div>
          ) : null}
          {isLoading ? <p>Loading offers…</p> : null}
          <div className="position-list">
            {matched.slice(0, 20).map((o) => (
              <button
                key={o.offerId}
                type="button"
                className="position-card"
                style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }}
                onClick={() => {
                  setSelected(o);
                  setMode('accept');
                  setStep('check');
                }}
              >
                <strong>Lender offer #{o.offerId}</strong>
                <div style={{ color: 'var(--text-secondary)' }}>
                  {formatBpsAsPercent(o.interestRateBps)} APR · {o.durationDays} days
                </div>
                <div>
                  Borrow {resolveSymbol(peekTokenMeta(o.lendingAsset, chain.chainId), o.lendingAsset)} · Lock{' '}
                  {resolveSymbol(peekTokenMeta(o.collateralAsset, chain.chainId), o.collateralAsset)}
                </div>
                {uiMode === 'advanced' ? (
                  <div style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {offerBrowseTechnicalRows(o).map((r) => (
                      <span key={r.label} style={{ marginRight: 12 }}>
                        {r.label}: {r.value}
                      </span>
                    ))}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
          {!isLoading && matched.length === 0 ? (
            <div className="card" style={{ marginTop: 12 }}>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
                {offersError
                  ? 'Offer list is unavailable, but you can still post a borrow request on-chain — collateral locks now and funds arrive when a lender accepts.'
                  : 'No lender offers fit right now. Post a borrow request — collateral locks now and funds arrive when a lender accepts.'}
              </p>
              <AmountField
                label="Collateral to lock"
                value={collateralAmount}
                onChange={setCollateralAmount}
                placeholder="e.g. 0.1"
                availableLabel={<CollateralBalanceHint assessment={collateralBalance} variant="available" />}
                shortfallLabel={<CollateralBalanceHint assessment={collateralBalance} variant="shortfall" />}
                hint="Checked against your wallet balance only."
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  Number(collateralAmount) <= 0 || collateralBalance.sufficient === false
                }
                onClick={() => {
                  setMode('request');
                  setStep('check');
                }}
              >
                Create a borrow request
              </button>
            </div>
          ) : null}
          <div className="wizard-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('intent')}>
              Back
            </button>
          </div>
        </>
      ) : null}

      {(step === 'check' && (selected || mode === 'request')) ? (
        <>
          {collateralBalance.shortfall ? (
            <div className="banner banner-warn" style={{ marginBottom: 12 }}>
              <CollateralBalanceHint assessment={collateralBalance} variant="shortfall" />
            </div>
          ) : collateralBalance.available && mode === 'accept' ? (
            <p className="form-hint" style={{ marginBottom: 12 }}>
              <CollateralBalanceHint assessment={collateralBalance} variant="available" />
            </p>
          ) : null}
          <EligibilityChecklist items={checklist} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <RiskConsentLabel />
          </label>
          <div className="sticky-cta wizard-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('match')}>Back</button>
            <button type="button" className="btn btn-primary" disabled={!allOk} onClick={() => setStep('review')}>
              Continue to review
            </button>
          </div>
        </>
      ) : null}

      {step === 'review' ? (
        <>
          <ReviewReceipt data={receiptData} />
          {txError ? <div className="banner banner-error">{txError}</div> : null}
          <div className="sticky-cta wizard-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('check')}>Back</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting || !allOk}
              onClick={() => void (mode === 'accept' ? handleAccept() : handleRequest())}
            >
              {submitting ? 'Confirming…' : mode === 'accept' ? 'Accept offer' : 'Post borrow request'}
            </button>
          </div>
        </>
      ) : null}

      {step === 'done' ? (
        <FlowDone
          title={mode === 'accept' ? 'Loan opened' : 'Borrow request posted'}
          body={
            mode === 'accept'
              ? 'Your loan should appear under Positions shortly. Repay before the due date to reclaim collateral.'
              : 'We will show your request as active until a lender accepts or you cancel.'
          }
          primaryLabel="View positions"
          onPrimary={() => navigate('/positions')}
          secondary={<HelpLink anchor="borrow-after" label="What to watch next" />}
        />
      ) : null}
    </div>
  );
}