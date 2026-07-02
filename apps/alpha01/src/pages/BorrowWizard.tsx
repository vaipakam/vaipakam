import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWalletClient } from 'wagmi';
import type { Address } from 'viem';
import type { IndexedOffer, ReviewReceiptData } from '@vaipakam/defi-client';
import {
  acceptLenderOffer,
  formatBpsAsPercent,
} from '@vaipakam/defi-client';
import { shortenAddr } from '@vaipakam/lib/address';
import { EligibilityChecklist, type ChecklistItem } from '../components/EligibilityChecklist';
import { ReviewReceipt } from '../components/ReviewReceipt';
import { useWallet } from '../context/WalletContext';
import { useLenderOffersForBorrow } from '../hooks/useIndexedOffers';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from '../hooks/useDiamond';

type Step = 'pick' | 'check' | 'review' | 'done';

function borrowReceipt(offer: IndexedOffer): ReviewReceiptData {
  return {
    youReceive: {
      label: 'You receive',
      value: `Borrow up to ${offer.amountMax || offer.amount} (asset ${shortenAddr(offer.lendingAsset)})`,
      hint: 'Funds land in your vault when the loan starts.',
    },
    youLock: {
      label: 'You lock',
      value: `Collateral ${offer.collateralAmount} (${shortenAddr(offer.collateralAsset)})`,
      hint: 'Collateral stays in your vault until you repay or default.',
    },
    youMayOwe: {
      label: 'You may owe',
      value: `Principal + ${formatBpsAsPercent(offer.interestRateBps)} interest over ${offer.durationDays} days`,
    },
    youCanLose: {
      label: 'You can lose',
      value: 'Locked collateral if you do not repay on time.',
      hint: 'The lender can claim collateral after the grace period.',
    },
    fees: {
      label: 'Fees',
      value: 'Protocol fees at settlement (separate from network gas).',
    },
    whenEnds: {
      label: 'When this ends',
      value: `After ${offer.durationDays} days, or when you fully repay.`,
    },
    technicalDetails: [
      { label: 'Offer ID', value: String(offer.offerId) },
      { label: 'Lender', value: shortenAddr(offer.creator) },
    ],
  };
}

export function BorrowWizard() {
  const navigate = useNavigate();
  const { address, isCorrectChain, connect, switchToAppChain } = useWallet();
  const chain = useReadChain();
  const diamond = useDiamondContract();
  const publicClient = useDiamondPublicClient();
  const { data: walletClient } = useWalletClient();
  const { data: offers, isLoading, error } = useLenderOffersForBorrow();

  const [step, setStep] = useState<Step>('pick');
  const [selected, setSelected] = useState<IndexedOffer | null>(null);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  const checklist: ChecklistItem[] = useMemo(
    () => [
      {
        id: 'wallet',
        label: 'Wallet connected',
        ok: Boolean(address),
        fixLabel: 'Connect wallet',
        onFix: connect,
      },
      {
        id: 'chain',
        label: `On ${chain.name}`,
        ok: isCorrectChain,
        fixLabel: 'Switch network',
        onFix: () => void switchToAppChain(),
      },
      {
        id: 'terms',
        label: 'Risk & terms acknowledged',
        ok: consent,
        fixLabel: 'Acknowledge below',
      },
    ],
    [address, chain.name, connect, consent, isCorrectChain, switchToAppChain],
  );

  const allOk = checklist.every((i) => i.ok);

  async function handleAccept() {
    if (!selected || !walletClient || !chain.diamondAddress) return;
    setSubmitting(true);
    setTxError(null);
    try {
      await acceptLenderOffer({
        diamond,
        publicClient,
        walletClient,
        diamondAddress: chain.diamondAddress as Address,
        chainId: chain.chainId,
        offerId: BigInt(selected.offerId),
        consent,
      });
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
      <p className="page-subtitle">Accept a lender offer and lock collateral.</p>

      <div className="wizard-steps">
        {(['pick', 'check', 'review', 'done'] as Step[]).map((s) => (
          <span key={s} className={`wizard-step ${step === s ? 'active' : ''}`}>
            {s === 'pick' ? 'Pick offer' : s === 'check' ? 'Eligibility' : s === 'review' ? 'Review' : 'Done'}
          </span>
        ))}
      </div>

      {step === 'pick' ? (
        <>
          {isLoading ? <p>Loading offers…</p> : null}
          {error ? <div className="banner banner-error">Could not load offers from indexer.</div> : null}
          <div className="position-list">
            {(offers ?? []).slice(0, 20).map((o) => (
              <button
                key={o.offerId}
                type="button"
                className="position-card"
                style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }}
                onClick={() => {
                  setSelected(o);
                  setStep('check');
                }}
              >
                <strong>Offer #{o.offerId}</strong>
                <div style={{ color: 'var(--text-secondary)' }}>
                  Lend {shortenAddr(o.lendingAsset)} · {formatBpsAsPercent(o.interestRateBps)} · {o.durationDays}d
                </div>
                <div>Collateral: {shortenAddr(o.collateralAsset)}</div>
              </button>
            ))}
          </div>
          {!isLoading && (offers?.length ?? 0) === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No lender offers on this chain right now.</p>
          ) : null}
        </>
      ) : null}

      {step === 'check' && selected ? (
        <>
          <EligibilityChecklist items={checklist} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            I understand the risks and agree to the platform terms.
          </label>
          <div className="sticky-cta" style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setStep('pick')}>Back</button>
            <button type="button" className="btn btn-primary" disabled={!allOk} onClick={() => setStep('review')}>
              Continue to review
            </button>
          </div>
        </>
      ) : null}

      {step === 'review' && selected ? (
        <>
          <ReviewReceipt data={borrowReceipt(selected)} />
          {txError ? <div className="banner banner-error">{txError}</div> : null}
          <div className="sticky-cta" style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setStep('check')}>Back</button>
            <button type="button" className="btn btn-primary" disabled={submitting || !allOk} onClick={() => void handleAccept()}>
              {submitting ? 'Confirming…' : 'Accept offer'}
            </button>
          </div>
        </>
      ) : null}

      {step === 'done' ? (
        <div className="card">
          <h2>Loan started</h2>
          <p style={{ marginTop: 8, color: 'var(--text-secondary)' }}>
            Your position should appear shortly. Manage it from Positions.
          </p>
          <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/positions')}>
            View positions
          </button>
        </div>
      ) : null}
    </div>
  );
}