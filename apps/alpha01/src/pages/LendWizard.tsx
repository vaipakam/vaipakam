import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ReviewReceiptData } from '@vaipakam/defi-client';
import { createLenderOffer, OFFER_DURATION_DEFAULT_DAYS } from '@vaipakam/defi-client';
import { shortenAddr } from '@vaipakam/lib/address';
import { EligibilityChecklist, type ChecklistItem } from '../components/EligibilityChecklist';
import { ReviewReceipt } from '../components/ReviewReceipt';
import { useWallet } from '../context/WalletContext';
import { useReadChain, useDiamondContract } from '../hooks/useDiamond';
import { DEFAULT_CHAIN } from '../lib/chains';

type Step = 'inputs' | 'check' | 'review' | 'done';

export function LendWizard() {
  const navigate = useNavigate();
  const { address, isCorrectChain, connect, switchToAppChain, activeChain } = useWallet();
  const chain = useReadChain();
  const diamond = useDiamondContract();

  const [step, setStep] = useState<Step>('inputs');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('5');
  const [duration, setDuration] = useState(String(OFFER_DURATION_DEFAULT_DAYS));
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  const lendingAsset = chain.predominantStableAddress ?? activeChain?.predominantStableAddress ?? '';
  const collateralAsset = chain.wrappedNativeAddress ?? activeChain?.wrappedNativeAddress ?? '';

  const checklist: ChecklistItem[] = useMemo(
    () => [
      { id: 'wallet', label: 'Wallet connected', ok: Boolean(address), fixLabel: 'Connect', onFix: connect },
      { id: 'chain', label: `On ${chain.name}`, ok: isCorrectChain, fixLabel: 'Switch', onFix: () => void switchToAppChain() },
      { id: 'amount', label: 'Lend amount entered', ok: Number(amount) > 0 },
      { id: 'terms', label: 'Risk & terms acknowledged', ok: consent },
    ],
    [address, amount, chain.name, connect, consent, isCorrectChain, switchToAppChain],
  );

  const allOk = checklist.every((i) => i.ok);

  const receipt: ReviewReceiptData = {
    youReceive: {
      label: 'You receive',
      value: `${rate}% interest if matched`,
      hint: 'Interest accrues over the loan term when a borrower accepts.',
    },
    youLock: {
      label: 'You lock',
      value: `${amount || '—'} (${shortenAddr(lendingAsset || '0x0')})`,
      hint: 'Principal stays in your vault until matched or you cancel the offer.',
    },
    youMayOwe: { label: 'You may owe', value: 'Nothing beyond gas to create the offer.' },
    youCanLose: {
      label: 'You can lose',
      value: 'Locked principal if the borrower defaults (you claim collateral).',
    },
    fees: { label: 'Fees', value: 'Treasury yield fee at settlement (separate from gas).' },
    whenEnds: {
      label: 'When this ends',
      value: `Offer duration ${duration} days, or until cancelled.`,
    },
  };

  async function handleCreate() {
    if (!lendingAsset || !collateralAsset) {
      setTxError('Chain defaults not configured for this network.');
      return;
    }
    setSubmitting(true);
    setTxError(null);
    try {
      await createLenderOffer({
        diamond,
        form: {
          offerType: 'lender',
          assetType: 'erc20',
          lendingAsset,
          amount,
          interestRate: rate,
          collateralAsset,
          collateralAmount: '0',
          durationDays: duration,
          riskAndTermsConsent: consent,
        },
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
      <h1 className="page-title">Earn by lending</h1>
      <p className="page-subtitle">Post a lender offer — borrowers can accept when terms match.</p>

      {step === 'inputs' ? (
        <>
          <div className="field">
            <label>Amount to lend</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 100" inputMode="decimal" />
          </div>
          <div className="field">
            <label>Interest rate (% APR)</label>
            <input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" />
          </div>
          <div className="field">
            <label>Duration (days)</label>
            <input value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" />
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
            Asset pair defaults to {shortenAddr(lendingAsset || 'chain default')} / {shortenAddr(collateralAsset || 'chain default')} on {chain.name || DEFAULT_CHAIN.name}.
          </p>
          <button type="button" className="btn btn-primary" disabled={Number(amount) <= 0} onClick={() => setStep('check')}>
            Continue
          </button>
        </>
      ) : null}

      {step === 'check' ? (
        <>
          <EligibilityChecklist items={checklist} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            I understand the risks and agree to the platform terms.
          </label>
          <div className="sticky-cta" style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setStep('inputs')}>Back</button>
            <button type="button" className="btn btn-primary" disabled={!allOk} onClick={() => setStep('review')}>Review</button>
          </div>
        </>
      ) : null}

      {step === 'review' ? (
        <>
          <ReviewReceipt data={receipt} />
          {txError ? <div className="banner banner-error">{txError}</div> : null}
          <div className="sticky-cta" style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setStep('check')}>Back</button>
            <button type="button" className="btn btn-primary" disabled={submitting || !allOk} onClick={() => void handleCreate()}>
              {submitting ? 'Posting…' : 'Post lender offer'}
            </button>
          </div>
        </>
      ) : null}

      {step === 'done' ? (
        <div className="card">
          <h2>Offer posted</h2>
          <p style={{ marginTop: 8, color: 'var(--text-secondary)' }}>Borrowers can accept from the offer book.</p>
          <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/positions')}>
            View positions
          </button>
        </div>
      ) : null}
    </div>
  );
}