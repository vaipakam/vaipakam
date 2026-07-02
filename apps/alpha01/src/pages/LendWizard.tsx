import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWalletClient } from 'wagmi';
import type { Address } from 'viem';
import type { IndexedOffer } from '@vaipakam/defi-client';
import {
  acceptOfferFlow,
  createLenderOffer,
  formatBpsAsPercent,
  OFFER_DURATION_DEFAULT_DAYS,
} from '@vaipakam/defi-client';
import { AmountField } from '../components/AmountField';
import { AssetAmount } from '../components/AssetAmount';
import { AssetSymbolLink } from '../components/AssetSymbolLink';
import { DurationSelect } from '../components/DurationSelect';
import { EligibilityChecklist } from '../components/EligibilityChecklist';
import { FlowDone } from '../components/FlowDone';
import { HelpLink } from '../components/HelpLink';
import { ReviewReceipt, type ReviewReceiptView } from '../components/ReviewReceipt';
import { RiskConsentLabel } from '../components/RiskConsentLabel';
import { useWallet } from '../context/WalletContext';
import { useSanctionsCheck } from '../hooks/useSanctionsCheck';
import { useBorrowerOffersForLend } from '../hooks/useBorrowerOffers';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from '../hooks/useDiamond';
import { baseEligibilityItems, sanctionsAllowsProceed } from '../lib/eligibility';

import {
  hasResolvedTokenDecimals,
  peekTokenMeta,
  requireTokenDecimals,
  useTokenMeta,
  type TokenMeta,
} from '../lib/tokenMeta';

type Path = 'fund' | 'create';
type Step = 'choose' | 'pick' | 'inputs' | 'check' | 'review' | 'done';

function fundReceipt(
  offer: IndexedOffer,
  lendingMeta: TokenMeta | null,
  collateralMeta: TokenMeta | null,
): ReviewReceiptView {
  return {
    youReceive: {
      label: 'You receive',
      value: `Expected interest if the borrower repays on time (${formatBpsAsPercent(offer.interestRateBpsMax || offer.interestRateBps)} APR).`,
      hint: 'Interest is not guaranteed — it depends on borrower repayment.',
    },
    youLock: {
      label: 'You lock',
      value: (
        <>
          <AssetAmount mode="raw" amount={offer.amount} address={offer.lendingAsset} meta={lendingMeta} /> until
          the loan closes.
        </>
      ),
      hint: 'Principal moves to your vault custody for the loan term.',
    },
    youMayOwe: { label: 'You may owe', value: 'Protocol yield fee at settlement (separate from gas).' },
    youCanLose: {
      label: 'You can lose',
      value: (
        <>
          Recovery depends on{' '}
          <AssetAmount
            mode="raw"
            amount={offer.collateralAmount}
            address={offer.collateralAsset}
            meta={collateralMeta}
            assetType={offer.collateralAssetType}
            tokenId={offer.collateralTokenId}
          />{' '}
          collateral if the borrower defaults.
        </>
      ),
      hint: 'Illiquid collateral may transfer in full on default.',
    },
    fees: { label: 'Fees', value: 'Treasury yield fee at settlement. Network gas is separate.' },
    whenEnds: { label: 'When this ends', value: `After ${offer.durationDays} days or borrower repayment.` },
  };
}

function createReceipt(
  amount: string,
  rate: string,
  duration: string,
  lendingAsset: string,
  lendingMeta: TokenMeta | null,
): ReviewReceiptView {
  return {
    youReceive: {
      label: 'You receive',
      value: `${rate}% APR expected interest when matched`,
      hint: 'Expected interest if the borrower repays on time — not guaranteed.',
    },
    youLock: {
      label: 'You lock',
      value: (
        <>
          <AssetAmount mode="human" amount={amount} address={lendingAsset} meta={lendingMeta} /> until accepted or
          cancelled
        </>
      ),
      hint: 'Lent asset stays in your vault until the offer is accepted or cancelled.',
    },
    youMayOwe: { label: 'You may owe', value: 'Nothing beyond gas to post the offer.' },
    youCanLose: {
      label: 'You can lose',
      value: 'Principal remains locked until a borrower accepts or you cancel.',
    },
    fees: { label: 'Fees', value: 'Protocol yield fee at settlement (separate from gas).' },
    whenEnds: { label: 'When this ends', value: `Offer duration ${duration} days, or until cancelled.` },
  };
}

export function LendWizard() {
  const navigate = useNavigate();
  const { address, isCorrectChain, connect, switchToAppChain, activeChain } = useWallet();
  const chain = useReadChain();
  const diamond = useDiamondContract();
  const publicClient = useDiamondPublicClient();
  const { data: walletClient } = useWalletClient();
  const sanctions = useSanctionsCheck(address);
  const { data: borrowerOffers, isLoading } = useBorrowerOffersForLend();

  const [path, setPath] = useState<Path>('fund');
  const [step, setStep] = useState<Step>('choose');
  const [selected, setSelected] = useState<IndexedOffer | null>(null);
  const [amount, setAmount] = useState('');
  const [collateralAmount, setCollateralAmount] = useState('');
  const [rate, setRate] = useState('5');
  const [duration, setDuration] = useState(String(OFFER_DURATION_DEFAULT_DAYS));
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  const lendingAsset = chain.predominantStableAddress ?? activeChain?.predominantStableAddress ?? '';
  const collateralAsset = chain.wrappedNativeAddress ?? activeChain?.wrappedNativeAddress ?? '';

  const lendingMeta = useTokenMeta(lendingAsset || null);
  const collateralMeta = useTokenMeta(collateralAsset || null);
  const selectedLendingMeta = useTokenMeta(selected?.lendingAsset ?? null);
  const selectedCollateralMeta = useTokenMeta(selected?.collateralAsset ?? null);

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
      ...(path === 'create'
        ? [
            { id: 'amount', label: 'Lend amount entered', ok: Number(amount) > 0 },
            {
              id: 'collateral',
              label: 'Collateral requirement entered',
              ok: Number(collateralAmount) > 0,
            },
            {
              id: 'lending-decimals',
              label: lendingMeta?.symbol
                ? `${lendingMeta.symbol} decimals loaded`
                : 'Loading lending token decimals…',
              ok: hasResolvedTokenDecimals(lendingMeta, lendingAsset),
            },
          ]
        : []),
    ],
    [
      address,
      amount,
      chain.name,
      collateralAmount,
      connect,
      consent,
      isCorrectChain,
      lendingAsset,
      lendingMeta,
      path,
      sanctions,
      switchToAppChain,
    ],
  );

  const allOk =
    checklist.every((i) => i.ok) &&
    sanctionsAllowsProceed({ isSanctioned: sanctions.isSanctioned, sanctionsLoading: sanctions.loading });

  const receiptData = useMemo((): ReviewReceiptView => {
    if (path === 'fund' && selected) {
      return fundReceipt(selected, selectedLendingMeta, selectedCollateralMeta);
    }
    return createReceipt(amount, rate, duration, lendingAsset, lendingMeta);
  }, [amount, duration, lendingAsset, lendingMeta, path, rate, selected, selectedCollateralMeta, selectedLendingMeta]);

  async function handleFund() {
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

  async function handleCreate() {
    if (!walletClient || !chain.diamondAddress || !lendingAsset || !collateralAsset) return;
    setSubmitting(true);
    setTxError(null);
    try {
      const lendingDecimals = requireTokenDecimals(lendingMeta, lendingAsset, 'Lending asset');
      const collateralDecimals = requireTokenDecimals(
        collateralMeta,
        collateralAsset,
        'Collateral asset',
      );
      await createLenderOffer({
        diamond,
        publicClient,
        walletClient,
        diamondAddress: chain.diamondAddress as Address,
        form: {
          offerType: 'lender',
          assetType: 'erc20',
          lendingAsset,
          amount,
          interestRate: rate,
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
      <h1 className="page-title">Earn by lending</h1>
      <p className="page-subtitle">
        Fund a borrower request or post your own lending offer. <HelpLink anchor="lend" />
      </p>

      {step === 'choose' ? (
        <div className="intent-grid">
          <button type="button" className="intent-card" onClick={() => { setPath('fund'); setStep('pick'); }}>
            <h3>Fund a borrower request</h3>
            <p>Accept an existing borrow request and earn interest.</p>
          </button>
          <button type="button" className="intent-card" onClick={() => { setPath('create'); setStep('inputs'); }}>
            <h3>Create a lending offer</h3>
            <p>Make funds available for borrowers to accept.</p>
          </button>
        </div>
      ) : null}

      {step === 'pick' ? (
        <>
          {isLoading ? <p>Loading borrower requests…</p> : null}
          <div className="position-list">
            {(borrowerOffers ?? []).slice(0, 20).map((o) => (
              <button
                key={o.offerId}
                type="button"
                className="position-card"
                style={{ textAlign: 'left', width: '100%' }}
                onClick={() => { setSelected(o); setStep('check'); }}
              >
                <strong>Request #{o.offerId}</strong>
                <div style={{ color: 'var(--text-secondary)' }}>
                  Wants <AssetSymbolLink address={o.lendingAsset} meta={peekTokenMeta(o.lendingAsset)} /> ·{' '}
                  {formatBpsAsPercent(o.interestRateBpsMax || o.interestRateBps)} APR
                </div>
                <div>
                  Collateral:{' '}
                  <AssetSymbolLink address={o.collateralAsset} meta={peekTokenMeta(o.collateralAsset)} />
                </div>
              </button>
            ))}
          </div>
          {!isLoading && (borrowerOffers?.length ?? 0) === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No borrower requests right now. Try creating a lending offer.</p>
          ) : null}
          <div className="wizard-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('choose')}>Back</button>
          </div>
        </>
      ) : null}

      {step === 'inputs' ? (
        <>
          <div className="wizard-intent-form">
            <AmountField
              label="Amount to lend"
              value={amount}
              onChange={setAmount}
              placeholder="e.g. 1000"
            />
            <AmountField
              label="Collateral borrowers must lock"
              value={collateralAmount}
              onChange={setCollateralAmount}
              placeholder="e.g. 0.1"
              hint="Minimum collateral required to accept this offer."
            />
            <div className="wizard-intent-terms">
              <DurationSelect value={duration} onChange={setDuration} hint={null} />
              <div className="field">
                <label>Interest rate (% APR)</label>
                <input
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. 6"
                />
              </div>
              <p className="form-hint wizard-intent-terms-hint">
                Bucketed durations improve offer matching.
              </p>
            </div>
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Pair: <AssetSymbolLink address={lendingAsset} meta={lendingMeta} /> lent against{' '}
            <AssetSymbolLink address={collateralAsset} meta={peekTokenMeta(collateralAsset)} /> collateral.
          </p>
          <div className="wizard-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('choose')}>Back</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                Number(amount) <= 0 ||
                Number(collateralAmount) <= 0 ||
                !hasResolvedTokenDecimals(lendingMeta, lendingAsset)
              }
              onClick={() => setStep('check')}
            >
              Continue
            </button>
          </div>
        </>
      ) : null}

      {step === 'check' ? (
        <>
          <EligibilityChecklist items={checklist} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <RiskConsentLabel />
          </label>
          <div className="sticky-cta wizard-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(path === 'fund' ? 'pick' : 'inputs')}>Back</button>
            <button type="button" className="btn btn-primary" disabled={!allOk} onClick={() => setStep('review')}>Review</button>
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
              onClick={() => void (path === 'fund' ? handleFund() : handleCreate())}
            >
              {submitting ? 'Confirming…' : path === 'fund' ? 'Fund borrower' : 'Post lending offer'}
            </button>
          </div>
        </>
      ) : null}

      {step === 'done' ? (
        <FlowDone
          title={path === 'fund' ? 'Loan funded' : 'Lending offer posted'}
          body={path === 'fund' ? 'Track the active loan from Positions. Claim proceeds after repayment.' : 'Borrowers can accept from the offer book.'}
          primaryLabel="View positions"
          onPrimary={() => navigate('/positions')}
        />
      ) : null}
    </div>
  );
}