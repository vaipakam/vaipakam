/**
 * Guided offer flow — the shared engine behind Borrow and Lend.
 *
 * Same three steps either side (BasicUserUXSimplification.md):
 *   1. Details    — only the inputs the job needs, bucketed duration,
 *                   plain role-asymmetric wording.
 *   2. Review     — eligibility checklist (fixable items), the
 *                   six-row review receipt, and the single risk+terms
 *                   consent. Sign only unlocks when every check passes.
 *   3. Done       — what changed + one primary next action.
 *
 * On sign it approves the asset the creator locks (lender: principal,
 * borrower: collateral) for the Diamond, then calls
 * `createOffer(payload)` with the battle-tested payload mapping from
 * lib/offerSchema. Advanced mode reveals opt-ins (partial repayment,
 * pro-rata interest) without changing the flow shape.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, LoaderCircle } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { useActiveChain } from '../chain/useActiveChain';
import { useMode } from '../app/ModeContext';
import { useDiamondWrite } from '../contracts/diamond';
import {
  ensureAllowance,
  isAddressLike,
  useTokenBalance,
  useTokenMeta,
} from '../contracts/erc20';
import {
  OFFER_DURATION_BUCKETS_DAYS,
  gracePeriodLabel,
  initialOfferForm,
  toCreateOfferPayload,
  validateOfferForm,
  type OfferFormState,
} from '../lib/offerSchema';
import {
  formatDurationDays,
  formatTokenAmount,
  fullTermInterest,
} from '../lib/format';
import { copy } from '../content/copy';
import { AssetPicker } from './AssetPicker';
import { Checklist, allChecksPass } from './Checklist';
import { ReviewReceipt, type ReceiptData } from './ReviewReceipt';
import { StepNav } from './StepNav';
import { useEligibility } from './useEligibility';

const STEPS = ['Details', 'Review & sign', 'Done'] as const;

type Side = 'lender' | 'borrower';

interface SideCopy {
  title: string;
  lede: string;
  amountLabel: string;
  amountHint: string;
  rateLabel: string;
  rateHint: string;
  collateralLabel: string;
  collateralHint: string;
  submitLabel: string;
  doneTitle: string;
  doneBody: string;
}

const SIDE_COPY: Record<Side, SideCopy> = {
  lender: {
    title: copy.lend.title,
    lede: copy.lend.lede,
    amountLabel: 'How much do you want to lend?',
    amountHint: 'This amount is locked while your offer is open. Cancel any time before acceptance.',
    rateLabel: 'Yearly interest rate you want (%)',
    rateHint: copy.lend.yieldNotGuaranteed,
    collateralLabel: 'Collateral you require from the borrower',
    collateralHint: 'The borrower must lock this before they get your tokens.',
    submitLabel: copy.lend.postOffer,
    doneTitle: copy.lend.posted,
    doneBody: copy.lend.postedNext,
  },
  borrower: {
    title: copy.borrow.title,
    lede: copy.borrow.lede,
    amountLabel: 'How much do you want to borrow?',
    amountHint: 'Funds arrive when a lender accepts your request.',
    rateLabel: 'Highest yearly interest rate you’ll accept (%)',
    rateHint: 'Lenders offering at or below this rate can fund you.',
    collateralLabel: 'Collateral you will lock',
    collateralHint: copy.borrow.lockNow,
    submitLabel: copy.borrow.postRequest,
    doneTitle: copy.borrow.posted,
    doneBody: copy.borrow.postedNext,
  },
};

export function OfferFlow({ side }: { side: Side }) {
  const text = SIDE_COPY[side];
  const { isAdvanced } = useMode();
  const { address, walletChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<OfferFormState>({
    ...initialOfferForm,
    offerType: side,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const set = (patch: Partial<OfferFormState>) =>
    setForm((f) => ({ ...f, ...patch }));

  // Live token facts for both legs.
  const lendingMeta = useTokenMeta(form.lendingAsset || undefined);
  const collateralMeta = useTokenMeta(form.collateralAsset || undefined);

  // What the CREATOR locks at create time (approval + balance target):
  // lender → principal; borrower → collateral.
  const lockedAssetAddress = side === 'lender' ? form.lendingAsset : form.collateralAsset;
  const lockedMeta = side === 'lender' ? lendingMeta : collateralMeta;
  const lockedBalance = useTokenBalance(lockedAssetAddress || undefined);

  const lockedAmount = useMemo(() => {
    const meta = lockedMeta.data;
    const raw = side === 'lender' ? form.amount : form.collateralAmount;
    if (!meta || !raw || Number(raw) <= 0) return undefined;
    try {
      const payload = toCreateOfferPayload(form, {
        lending: lendingMeta.data?.decimals,
        collateral: collateralMeta.data?.decimals,
      });
      return side === 'lender' ? payload.amountMax : payload.collateralAmount;
    } catch {
      return undefined;
    }
  }, [form, side, lockedMeta.data, lendingMeta.data, collateralMeta.data]);

  const checks = useEligibility({
    asset: lockedAssetAddress
      ? {
          meta: lockedMeta.data,
          metaError: lockedMeta.isError,
          balance: lockedBalance.data,
          required: lockedAmount,
        }
      : undefined,
    consent: form.riskAndTermsConsent,
  });

  const formError = validateOfferForm(form);
  const detailsComplete =
    isAddressLike(form.lendingAsset) &&
    isAddressLike(form.collateralAsset) &&
    Number(form.amount) > 0 &&
    Number(form.collateralAmount) > 0 &&
    form.interestRate !== '';

  const receipt = useMemo((): ReceiptData | null => {
    const lending = lendingMeta.data;
    const collateral = collateralMeta.data;
    if (!lending || !collateral || !detailsComplete) return null;
    const payload = toCreateOfferPayload(form, {
      lending: lending.decimals,
      collateral: collateral.decimals,
    });
    const principal = payload.amountMax; // headline amount both sides
    const rateBps = side === 'lender' ? payload.interestRateBps : payload.interestRateBpsMax;
    const interest = fullTermInterest(principal, rateBps, payload.durationDays);
    const principalStr = `${formatTokenAmount(principal, lending.decimals)} ${lending.symbol}`;
    const interestStr = `${formatTokenAmount(interest, lending.decimals)} ${lending.symbol}`;
    const collateralStr = `${formatTokenAmount(payload.collateralAmount, collateral.decimals)} ${collateral.symbol}`;
    const durationStr = formatDurationDays(payload.durationDays);
    const grace = gracePeriodLabel(payload.durationDays);

    if (side === 'lender') {
      return {
        youReceive: `Up to ~${interestStr} interest if the borrower repays on time, plus your ${principalStr} back.`,
        youLock: `${principalStr} now, until your offer is accepted or you cancel it.`,
        youMayOwe: 'Nothing — the borrower owes you.',
        youCanLose: `${copy.lend.defaultOutcome} They must lock ${collateralStr}.`,
        fees: `${copy.fees.lenderYieldFee}`,
        whenThisEnds: `Repayment is due ${durationStr} after a borrower accepts (grace period: ${grace}). You then claim your funds.`,
      };
    }
    return {
      youReceive: `${principalStr} when a lender accepts your request.`,
      youLock: `${collateralStr} as collateral, starting now.`,
      youMayOwe: `${principalStr} plus up to ~${interestStr} interest by the due date.`,
      youCanLose: `Your ${collateralStr} collateral if you do not repay on time. ${copy.borrow.collateralWarning}`,
      fees: `${copy.fees.borrowerLIF}`,
      whenThisEnds: `Repay within ${durationStr} of acceptance (grace period: ${grace}), then claim your collateral back.`,
    };
  }, [form, side, detailsComplete, lendingMeta.data, collateralMeta.data]);

  const canSign =
    allChecksPass(checks) &&
    formError === null &&
    receipt !== null &&
    !submitting;

  async function submit() {
    if (!receipt || !address || !walletChain || !walletClient || !publicClient) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = toCreateOfferPayload(form, {
        lending: lendingMeta.data?.decimals,
        collateral: collateralMeta.data?.decimals,
      });
      // The Diamond pulls the creator's locked side at create time.
      const token = (side === 'lender'
        ? payload.lendingAsset
        : payload.collateralAsset) as `0x${string}`;
      const amount = side === 'lender' ? payload.amountMax : payload.collateralAmount;
      await ensureAllowance({
        publicClient,
        walletClient,
        token,
        owner: address,
        spender: walletChain.diamondAddress,
        amount,
      });
      const { hash } = await write('createOffer', [payload]);
      setTxHash(hash);
      setStep(2);
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmitError(
        /rejected|denied|cancel/i.test(message)
          ? copy.errors.txRejected
          : `${copy.errors.txFailed} (${message.slice(0, 160)})`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">{text.title}</h1>
      <p className="page-lede">{text.lede}</p>
      <StepNav steps={STEPS} current={step} />

      {step === 0 ? (
        <div className="card">
          <AssetPicker
            id="lending-asset"
            label={side === 'lender' ? 'Asset to lend' : 'Asset to borrow'}
            value={form.lendingAsset}
            onChange={(v) => set({ lendingAsset: v })}
          />
          <div className="field">
            <label htmlFor="amount">{text.amountLabel}</label>
            <input
              id="amount"
              className="input"
              inputMode="decimal"
              placeholder="0.0"
              value={form.amount}
              onChange={(e) => set({ amount: e.target.value.trim() })}
            />
            <span className="field-hint">{text.amountHint}</span>
          </div>
          <div className="field">
            <label htmlFor="rate">{text.rateLabel}</label>
            <input
              id="rate"
              className="input"
              inputMode="decimal"
              placeholder="5"
              value={form.interestRate}
              onChange={(e) => set({ interestRate: e.target.value.trim() })}
            />
            <span className="field-hint">{text.rateHint}</span>
          </div>
          <div className="field">
            <label htmlFor="duration">Duration</label>
            <select
              id="duration"
              className="input"
              value={form.durationDays}
              onChange={(e) => set({ durationDays: e.target.value })}
            >
              {OFFER_DURATION_BUCKETS_DAYS.map((d) => (
                <option key={d} value={String(d)}>
                  {formatDurationDays(d)}
                </option>
              ))}
            </select>
          </div>
          <AssetPicker
            id="collateral-asset"
            label={text.collateralLabel}
            hint={text.collateralHint}
            value={form.collateralAsset}
            onChange={(v) => set({ collateralAsset: v })}
          />
          <div className="field">
            <label htmlFor="collateral-amount">Collateral amount</label>
            <input
              id="collateral-amount"
              className="input"
              inputMode="decimal"
              placeholder="0.0"
              value={form.collateralAmount}
              onChange={(e) => set({ collateralAmount: e.target.value.trim() })}
            />
          </div>

          {isAdvanced ? (
            <fieldset
              style={{ border: 'none', margin: '0 0 16px', padding: 0 }}
              className="stack"
            >
              <legend className="muted" style={{ paddingBottom: 8 }}>
                Advanced options
              </legend>
              <label className="cluster" style={{ fontSize: '0.9rem' }}>
                <input
                  type="checkbox"
                  checked={form.allowsPartialRepay}
                  onChange={(e) => set({ allowsPartialRepay: e.target.checked })}
                />
                Allow the borrower to repay in parts
              </label>
              <label className="cluster" style={{ fontSize: '0.9rem' }}>
                <input
                  type="checkbox"
                  checked={!form.useFullTermInterest}
                  onChange={(e) => set({ useFullTermInterest: !e.target.checked })}
                />
                Charge interest only for time used (pro-rata) instead of the full term
              </label>
            </fieldset>
          ) : null}

          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!detailsComplete}
            onClick={() => setStep(1)}
          >
            Continue to review
          </button>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="stack">
          <div className="card">
            <h3>Before you sign</h3>
            <Checklist items={checks} />
          </div>
          <div className="card">
            {receipt ? <ReviewReceipt data={receipt} /> : null}
            <label
              className="cluster"
              style={{ marginTop: 16, fontSize: '0.9rem', alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={form.riskAndTermsConsent}
                onChange={(e) => set({ riskAndTermsConsent: e.target.checked })}
                style={{ marginTop: 3 }}
              />
              <span style={{ flex: 1 }}>{copy.consentLabel}</span>
            </label>
            {submitError ? (
              <div className="banner banner-danger" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{submitError}</span>
              </div>
            ) : null}
            <div className="cluster" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep(0)}
                disabled={submitting}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={!canSign}
                onClick={() => void submit()}
              >
                {submitting ? (
                  <LoaderCircle className="spin" aria-hidden size={18} />
                ) : null}
                {submitting ? 'Waiting for wallet…' : text.submitLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <CircleCheck
            aria-hidden
            size={40}
            style={{ color: 'var(--ok)', marginBottom: 8 }}
          />
          <h2>{text.doneTitle}</h2>
          <p className="muted">{text.doneBody}</p>
          {txHash && walletChain ? (
            <p className="muted">
              <a
                href={`${walletChain.blockExplorer}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View the transaction
              </a>
            </p>
          ) : null}
          <Link to="/positions" className="btn btn-primary">
            View my positions
          </Link>
        </div>
      ) : null}
    </div>
  );
}
