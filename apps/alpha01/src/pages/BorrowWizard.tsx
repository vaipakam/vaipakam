import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWalletClient } from 'wagmi';
import type { Address } from 'viem';
import type { IndexedOffer, ReviewReceiptData } from '@vaipakam/defi-client';
import {
  acceptOfferFlow,
  createBorrowerOffer,
  formatBpsAsPercent,
  matchOffersToBorrowIntent,
  OFFER_DURATION_DEFAULT_DAYS,
} from '@vaipakam/defi-client';
import { shortenAddr } from '@vaipakam/lib/address';
import { EligibilityChecklist } from '../components/EligibilityChecklist';
import { FlowDone } from '../components/FlowDone';
import { HelpLink } from '../components/HelpLink';
import { ReviewReceipt } from '../components/ReviewReceipt';
import { useWallet } from '../context/WalletContext';
import { useSanctionsCheck } from '../hooks/useSanctionsCheck';
import { useLenderOffersForBorrow } from '../hooks/useIndexedOffers';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from '../hooks/useDiamond';
import { baseEligibilityItems } from '../lib/eligibility';

type Step = 'intent' | 'match' | 'request' | 'check' | 'review' | 'done';
type Mode = 'accept' | 'request';

function borrowReceipt(offer: IndexedOffer, borrowAmount: string): ReviewReceiptData {
  return {
    youReceive: {
      label: 'You receive',
      value: `You are borrowing ${borrowAmount || offer.amountMax || offer.amount} (${shortenAddr(offer.lendingAsset)}).`,
      hint: 'Funds land in your vault when the loan starts.',
    },
    youLock: {
      label: 'You lock',
      value: `You are locking ${offer.collateralAmount} (${shortenAddr(offer.collateralAsset)}).`,
      hint: 'Collateral stays in your vault until you repay or default.',
    },
    youMayOwe: {
      label: 'You may owe',
      value: `Principal + ${formatBpsAsPercent(offer.interestRateBps)} interest over ${offer.durationDays} days.`,
    },
    youCanLose: {
      label: 'You can lose',
      value: 'Locked collateral if you do not repay on time.',
      hint: 'If you do not repay, the lender can receive your collateral.',
    },
    fees: {
      label: 'Fees',
      value: 'Protocol fees at settlement. Network gas is separate from Vaipakam protocol fees.',
    },
    whenEnds: {
      label: 'When this ends',
      value: `After ${offer.durationDays} days, or when you fully repay.`,
    },
  };
}

function requestReceipt(amount: string, rate: string, duration: string, collateral: string): ReviewReceiptData {
  return {
    youReceive: {
      label: 'You receive',
      value: 'Nothing yet — funds arrive only when a lender accepts.',
      hint: 'Your borrow request must be matched first.',
    },
    youLock: {
      label: 'You lock',
      value: `${collateral || '—'} collateral now.`,
      hint: 'Collateral is locked while the request is open.',
    },
    youMayOwe: {
      label: 'You may owe',
      value: `Up to ${amount || '—'} principal at ${rate}% over ${duration} days once matched.`,
    },
    youCanLose: {
      label: 'You can lose',
      value: 'Locked collateral if you default after a loan opens.',
    },
    fees: { label: 'Fees', value: 'Protocol fees at settlement (separate from network gas).' },
    whenEnds: { label: 'When this ends', value: 'When cancelled, matched, or the loan closes.' },
  };
}

export function BorrowWizard() {
  const navigate = useNavigate();
  const { address, isCorrectChain, connect, switchToAppChain, activeChain } = useWallet();
  const chain = useReadChain();
  const diamond = useDiamondContract();
  const publicClient = useDiamondPublicClient();
  const { data: walletClient } = useWalletClient();
  const sanctions = useSanctionsCheck(address);
  const { data: offers, isLoading } = useLenderOffersForBorrow();

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

  const matched = useMemo(() => {
    const pool = offers ?? [];
    return matchOffersToBorrowIntent(pool, {
      lendingAsset: lendingAsset || undefined,
      collateralAsset: collateralAsset || undefined,
      durationDays: Number(duration) || undefined,
      maxRateBps: Math.round(Number(maxRate) * 100) || undefined,
    });
  }, [offers, lendingAsset, collateralAsset, duration, maxRate]);

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
      }),
      ...(mode === 'request'
        ? [
            { id: 'collateral', label: 'Collateral amount entered', ok: Number(collateralAmount) > 0 },
            { id: 'amount', label: 'Borrow amount entered', ok: Number(amount) > 0 },
          ]
        : []),
    ],
    [address, chain.name, collateralAmount, connect, consent, isCorrectChain, mode, amount, sanctions, switchToAppChain],
  );

  const allOk = checklist.every((i) => i.ok);

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
      });
      setMode('request');
      setStep('done');
    } catch (e) {
      setTxError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">Borrow assets</h1>
      <p className="page-subtitle">
        Tell us what you need, pick a matching lender offer, or post a borrow request.{' '}
        <HelpLink anchor="borrow" />
      </p>

      <div className="wizard-steps">
        {['intent', 'match', 'check', 'review', 'done'].map((s) => (
          <span key={s} className={`wizard-step ${step === s || (step === 'request' && s === 'match') ? 'active' : ''}`}>
            {s === 'intent' ? 'Your needs' : s === 'match' ? 'Offers' : s === 'check' ? 'Eligibility' : s === 'review' ? 'Review' : 'Done'}
          </span>
        ))}
      </div>

      {step === 'intent' ? (
        <>
          <div className="field">
            <label>Asset to borrow</label>
            <input value={lendingAsset} onChange={(e) => setLendingAsset(e.target.value)} placeholder="Token address" />
          </div>
          <div className="field">
            <label>Amount</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="e.g. 100" />
          </div>
          <div className="field">
            <label>Collateral asset</label>
            <input value={collateralAsset} onChange={(e) => setCollateralAsset(e.target.value)} placeholder="Token address" />
          </div>
          <div className="field">
            <label>Duration (days)</label>
            <input value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" />
          </div>
          <div className="field">
            <label>Maximum interest rate (%)</label>
            <input value={maxRate} onChange={(e) => setMaxRate(e.target.value)} inputMode="decimal" />
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setStep('match')}>
            Find matching offers
          </button>
        </>
      ) : null}

      {step === 'match' ? (
        <>
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
                  {formatBpsAsPercent(o.interestRateBps)} · {o.durationDays} days
                </div>
                <div>Borrow {shortenAddr(o.lendingAsset)} · Lock {shortenAddr(o.collateralAsset)}</div>
              </button>
            ))}
          </div>
          {!isLoading && matched.length === 0 ? (
            <div className="card" style={{ marginTop: 12 }}>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
                No lender offers fit right now. Post a borrow request — collateral locks now and funds arrive when a lender accepts.
              </p>
              <div className="field">
                <label>Collateral to lock</label>
                <input value={collateralAmount} onChange={(e) => setCollateralAmount(e.target.value)} inputMode="decimal" />
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setMode('request');
                  setStep('check');
                }}
              >
                Create a borrow request
              </button>
            </div>
          ) : null}
          <button type="button" className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setStep('intent')}>
            Back
          </button>
        </>
      ) : null}

      {(step === 'check' && (selected || mode === 'request')) ? (
        <>
          <EligibilityChecklist items={checklist} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            I understand the risks and agree to the platform terms.
          </label>
          <div className="sticky-cta" style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setStep('match')}>Back</button>
            <button type="button" className="btn btn-primary" disabled={!allOk} onClick={() => setStep('review')}>
              Continue to review
            </button>
          </div>
        </>
      ) : null}

      {step === 'review' ? (
        <>
          <ReviewReceipt
            data={
              mode === 'accept' && selected
                ? borrowReceipt(selected, amount)
                : requestReceipt(amount, maxRate, duration, collateralAmount)
            }
          />
          {txError ? <div className="banner banner-error">{txError}</div> : null}
          <div className="sticky-cta" style={{ display: 'flex', gap: 8 }}>
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