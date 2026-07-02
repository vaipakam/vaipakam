/**
 * Guided offer flow — the shared engine behind Borrow and Lend,
 * covering journeys B1/B2 (borrower) and L1/L2 (lender) from
 * docs/TestScopes/BasicUserJourneyMap.md:
 *
 *   Details → Offers → [Your terms, post-only] → Review & sign → Done
 *
 * After the user says what asset and roughly how much, the flow first
 * shows MATCHING OPEN OFFERS (accept path — the loan opens
 * immediately); posting their own offer/request is the explicit
 * fallback. Both paths end at the same six-row review receipt and
 * fixable-items checklist, and the single risk+terms consent.
 *
 * Accept path mechanics (#662): the acceptor signs an EIP-712
 * `AcceptTerms` built from the CANONICAL on-chain offer
 * (contracts/useAcceptTerms.ts), the acceptor-side ERC-20 is approved
 * for the exact canonical amount, then `acceptOffer(id, terms, sig)`.
 * Post path: approve the locked side, then `createOffer(payload)`
 * with the verbatim-copied offerSchema mapping.
 *
 * Deep link: `?offer=<id>` (the Offer Book's "Use this offer") lands
 * directly on Review with that offer selected, when it is still open
 * and on this flow's side of the market.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CircleCheck, LoaderCircle, Search } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { parseUnits } from 'viem';
import { useActiveChain } from '../chain/useActiveChain';
import { useMode } from '../app/ModeContext';
import { useDiamondWrite } from '../contracts/diamond';
import { useAcceptTermsSigning } from '../contracts/useAcceptTerms';
import {
  ensureAllowance,
  isAddressLike,
  useTokenBalance,
  useTokenMeta,
} from '../contracts/erc20';
import { useActiveOffers, useOffer } from '../data/hooks';
import { useProtocolFees, bpsToPercentText } from '../data/fees';
import type { IndexedOffer } from '../data/indexer';
import {
  OFFER_DURATION_BUCKETS_DAYS,
  gracePeriodLabel,
  initialOfferForm,
  toCreateOfferPayload,
  validateOfferForm,
  type OfferFormState,
} from '../lib/offerSchema';
import { AssetType } from '../lib/types';
import {
  formatBpsAsPercent,
  formatDurationDays,
  formatTokenAmount,
  fullTermInterest,
} from '../lib/format';
import { isPlainDecimal, isPositiveDecimal, submitErrorText } from '../lib/errors';
import { copy } from '../content/copy';
import { AssetPicker } from './AssetPicker';
import { Checklist, allChecksPass, type CheckItem } from './Checklist';
import { ReviewReceipt, type ReceiptData } from './ReviewReceipt';
import { StepNav } from './StepNav';
import { useEligibility } from './useEligibility';

type Side = 'lender' | 'borrower';
type FlowStep = 'details' | 'choose' | 'terms' | 'review' | 'done';
type FlowMode = 'accept' | 'post';

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
  matchTitle: string;
  matchLede: string;
  matchEmpty: string;
  orPost: string;
  acceptSubmitLabel: string;
  acceptDoneBody: string;
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
    matchTitle: copy.match.lendTitle,
    matchLede: copy.match.lendLede,
    matchEmpty: copy.match.emptyLend,
    orPost: copy.match.orPostLend,
    acceptSubmitLabel: 'Fund this borrower',
    acceptDoneBody: copy.match.lenderNext,
  },
  borrower: {
    title: copy.borrow.title,
    lede: copy.borrow.lede,
    amountLabel: 'How much do you want to borrow?',
    amountHint: 'We’ll look for lenders offering close to this amount.',
    rateLabel: 'Highest yearly interest rate you’ll accept (%)',
    rateHint: 'Lenders offering at or below this rate can fund you.',
    collateralLabel: 'Collateral you will lock',
    collateralHint: copy.borrow.lockNow,
    submitLabel: copy.borrow.postRequest,
    doneTitle: copy.borrow.posted,
    doneBody: copy.borrow.postedNext,
    matchTitle: copy.match.borrowTitle,
    matchLede: copy.match.borrowLede,
    matchEmpty: copy.match.emptyBorrow,
    orPost: copy.match.orPostBorrow,
    acceptSubmitLabel: 'Borrow this now',
    acceptDoneBody: copy.match.borrowerNext,
  },
};

/** The headline principal of an offer row, role-correct: a lender
 *  offer's size is `amountMax`; a borrower request's is `amount`
 *  (mirrors `_bindTermsToOffer` for direct accepts). */
function offerPrincipal(offer: IndexedOffer): bigint {
  return BigInt(offer.offerType === 0 ? offer.amountMax : offer.amount);
}

function offerRateBps(offer: IndexedOffer): number {
  return offer.offerType === 0 ? offer.interestRateBps : offer.interestRateBpsMax;
}

function MatchOfferRow({
  offer,
  side,
  onChoose,
}: {
  offer: IndexedOffer;
  side: Side;
  onChoose: () => void;
}) {
  const lendingMeta = useTokenMeta(offer.lendingAsset);
  const collateralMeta = useTokenMeta(offer.collateralAsset);
  const principal = offerPrincipal(offer);
  const amountStr = lendingMeta.data
    ? `${formatTokenAmount(principal, lendingMeta.data.decimals)} ${lendingMeta.data.symbol}`
    : '…';
  const collateralStr = collateralMeta.data
    ? `${formatTokenAmount(offer.collateralAmount, collateralMeta.data.decimals)} ${collateralMeta.data.symbol}`
    : '…';

  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">
          {side === 'borrower' ? 'Borrow' : 'Lend'} {amountStr} at{' '}
          {formatBpsAsPercent(offerRateBps(offer))} yearly
        </span>
        <br />
        <span className="row-sub">
          {formatDurationDays(offer.durationDays)} ·{' '}
          {side === 'borrower'
            ? `you lock ${collateralStr} as collateral`
            : `they lock ${collateralStr} as collateral`}{' '}
          · offer #{offer.offerId}
        </span>
      </span>
      <button type="button" className="btn btn-primary btn-sm" onClick={onChoose}>
        {copy.match.choose}
      </button>
    </div>
  );
}

export function OfferFlow({ side }: { side: Side }) {
  const text = SIDE_COPY[side];
  const { isAdvanced } = useMode();
  const { address, walletChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const { sign: signAcceptTerms } = useAcceptTermsSigning();
  const fees = useProtocolFees();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [step, setStep] = useState<FlowStep>('details');
  const [mode, setMode] = useState<FlowMode>('post');
  const [selected, setSelected] = useState<IndexedOffer | null>(null);
  const [form, setForm] = useState<OfferFormState>({
    ...initialOfferForm,
    offerType: side,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const set = (patch: Partial<OfferFormState>) =>
    setForm((f) => ({ ...f, ...patch }));

  // ---- Deep link (?offer=<id>) from the Offer Book -------------------
  // Validates the SAME rules as the browse path (side, open, ERC-20
  // both legs, not my own offer) and turns every dead link into a
  // plain-language notice instead of a silent hang.
  const offerParam = searchParams.get('offer');
  const offerParamValid =
    offerParam !== null && /^\d+$/.test(offerParam.trim()) && offerParam.trim() !== '';
  const deepLinkId = offerParamValid ? Number(offerParam) : undefined;
  const deepLinkQuery = useOffer(deepLinkId);
  useEffect(() => {
    if (offerParam === null || selected || step !== 'details') return;
    const clear = (notice: string) => {
      setDeepLinkNotice(notice);
      setSearchParams({}, { replace: true });
    };
    if (!offerParamValid) {
      clear(copy.match.offerNotFound);
      return;
    }
    if (deepLinkQuery.isLoading) return; // genuinely still loading
    const row = deepLinkQuery.data;
    if (row === null || row === undefined) {
      // 404 / pruned / indexer down — getJson collapses them to null.
      clear(copy.match.offerNotFound);
      return;
    }
    const wantedType = side === 'borrower' ? 0 : 1;
    if (row.offerType !== wantedType) {
      clear(copy.match.wrongSide);
      return;
    }
    if (
      row.assetType !== AssetType.ERC20 ||
      row.collateralAssetType !== AssetType.ERC20
    ) {
      clear(copy.match.wrongKind);
      return;
    }
    if (address && row.creator.toLowerCase() === address.toLowerCase()) {
      clear(copy.match.ownOffer);
      return;
    }
    if (row.status !== 'active') {
      clear(copy.match.offerGone);
      return;
    }
    setForm((f) => ({ ...f, lendingAsset: row.lendingAsset }));
    setSelected(row);
    setMode('accept');
    setStep('review');
  }, [
    offerParam,
    offerParamValid,
    deepLinkQuery.isLoading,
    deepLinkQuery.data,
    selected,
    step,
    side,
    address,
    setSearchParams,
  ]);

  // ---- Token facts ----------------------------------------------------
  const lendingMeta = useTokenMeta(form.lendingAsset || undefined);
  const collateralMeta = useTokenMeta(form.collateralAsset || undefined);
  // Accept mode: the selected offer's collateral leg (borrower side pays it).
  const selectedCollateralMeta = useTokenMeta(selected?.collateralAsset);

  // What the connected wallet must PAY/LOCK for the current path:
  //   post+lender    → principal            (form.lendingAsset)
  //   post+borrower  → collateral           (form.collateralAsset)
  //   accept+borrower→ offer's collateral   (selected.collateralAsset)
  //   accept+lender  → offer's principal    (selected.lendingAsset)
  const lockedAssetAddress =
    mode === 'accept' && selected
      ? side === 'borrower'
        ? selected.collateralAsset
        : selected.lendingAsset
      : side === 'lender'
        ? form.lendingAsset
        : form.collateralAsset;
  const lockedMeta =
    mode === 'accept' && selected
      ? side === 'borrower'
        ? selectedCollateralMeta
        : lendingMeta
      : side === 'lender'
        ? lendingMeta
        : collateralMeta;
  const lockedBalance = useTokenBalance(lockedAssetAddress || undefined);

  const lockedAmount = useMemo(() => {
    if (mode === 'accept' && selected) {
      return side === 'borrower'
        ? BigInt(selected.collateralAmount)
        : BigInt(selected.amount);
    }
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
  }, [mode, selected, form, side, lockedMeta.data, lendingMeta.data, collateralMeta.data]);

  // The leg the user does NOT pay still gates the receipt — surface
  // it as a fixable item instead of an eternal "Preparing your review…".
  const counterMeta =
    mode === 'accept' && selected
      ? side === 'borrower'
        ? lendingMeta
        : selectedCollateralMeta
      : side === 'lender'
        ? collateralMeta
        : lendingMeta;
  const counterAssetAddress =
    mode === 'accept' && selected
      ? side === 'borrower'
        ? selected.lendingAsset
        : selected.collateralAsset
      : side === 'lender'
        ? form.collateralAsset
        : form.lendingAsset;

  const baseChecks = useEligibility({
    asset: lockedAssetAddress
      ? {
          meta: lockedMeta.data,
          metaError: lockedMeta.isError,
          balance: lockedBalance.data,
          required: lockedAmount,
        }
      : undefined,
    counterAsset: counterAssetAddress
      ? {
          label:
            side === 'borrower' ? 'Borrowed asset' : 'Collateral asset',
          meta: counterMeta.data,
          metaError: counterMeta.isError,
        }
      : undefined,
    consent: form.riskAndTermsConsent,
  });
  // The receipt's fee row must quote the GOVERNED values — hold the
  // sign button until the live config read lands rather than letting
  // users sign against compile-time defaults.
  const checks = useMemo(
    (): CheckItem[] => [
      ...baseChecks,
      {
        id: 'live-fees',
        label: fees.ready ? 'Live fee terms loaded' : 'Loading live fee terms…',
        state: fees.ready ? 'pass' : 'pending',
      },
    ],
    [baseChecks, fees.ready],
  );

  // ---- Matching offers -------------------------------------------------
  const activeOffers = useActiveOffers();
  const desiredWei = useMemo(() => {
    if (!lendingMeta.data || !form.amount || Number(form.amount) <= 0) return null;
    try {
      return parseUnits(form.amount, lendingMeta.data.decimals);
    } catch {
      return null;
    }
  }, [form.amount, lendingMeta.data]);

  const matches = useMemo(() => {
    const rows = activeOffers.data;
    if (!Array.isArray(rows) || !isAddressLike(form.lendingAsset)) return rows === null ? null : [];
    const wantedType = side === 'borrower' ? 0 : 1;
    const abs = (v: bigint) => (v < 0n ? -v : v);
    return rows
      .filter(
        (o) =>
          o.offerType === wantedType &&
          o.assetType === AssetType.ERC20 &&
          o.collateralAssetType === AssetType.ERC20 &&
          o.lendingAsset.toLowerCase() === form.lendingAsset.toLowerCase() &&
          (!address || o.creator.toLowerCase() !== address.toLowerCase()),
      )
      .sort((a, b) => {
        if (desiredWei !== null) {
          const da = abs(offerPrincipal(a) - desiredWei);
          const db = abs(offerPrincipal(b) - desiredWei);
          if (da !== db) return da < db ? -1 : 1;
        }
        // Better rate breaks ties: borrowers want low, lenders want high.
        return side === 'borrower'
          ? offerRateBps(a) - offerRateBps(b)
          : offerRateBps(b) - offerRateBps(a);
      })
      .slice(0, 5);
  }, [activeOffers.data, form.lendingAsset, side, address, desiredWei]);

  // ---- Step plumbing ----------------------------------------------------
  const stepLabels =
    mode === 'post'
      ? (['Details', 'Offers', 'Your terms', 'Review & sign', 'Done'] as const)
      : (['Details', 'Offers', 'Review & sign', 'Done'] as const);
  const stepIndex =
    step === 'details'
      ? 0
      : step === 'choose'
        ? 1
        : step === 'terms'
          ? 2
          : step === 'review'
            ? mode === 'post'
              ? 3
              : 2
            : stepLabels.length - 1;

  // Strict decimal gating — Number('1e18') > 0 and Number('abc') < 0
  // checks let inputs through that parseUnits/BigInt later throw on.
  // Rate is additionally capped at 100% APR: the contract rejects
  // anything above MAX_INTEREST_BPS (10,000), and without the client
  // cap the approval tx would mine before createOffer reverts.
  const MAX_RATE_PERCENT = 100;
  const rateValid =
    isPlainDecimal(form.interestRate) &&
    Number(form.interestRate) <= MAX_RATE_PERCENT;
  const detailsComplete =
    isAddressLike(form.lendingAsset) && isPositiveDecimal(form.amount);
  const formError = validateOfferForm(form);
  const postDetailsComplete =
    detailsComplete &&
    isAddressLike(form.collateralAsset) &&
    isPositiveDecimal(form.collateralAmount) &&
    rateValid;

  // ---- Review receipt ----------------------------------------------------
  // One side of the deal being unpriced (illiquid) changes the default
  // outcome to a direct in-kind transfer — the receipt must say so.
  const selectedIsIlliquid =
    mode === 'accept' &&
    selected !== null &&
    (selected.principalLiquidity === 1 || selected.collateralLiquidity === 1);

  const lifPct = bpsToPercentText(fees.loanInitiationFeeBps);
  const yieldPct = bpsToPercentText(fees.treasuryFeeBps);

  const receipt = useMemo((): ReceiptData | null => {
    // The conversions below throw on inputs the completeness gates
    // can't fully exclude — never let that take down the page.
    try {
      if (mode === 'accept' && selected) {
        const lending = lendingMeta.data;
        const collateral = selectedCollateralMeta.data;
        if (!lending || !collateral) return null;
        const principal = offerPrincipal(selected);
        const interest = fullTermInterest(
          principal,
          offerRateBps(selected),
          selected.durationDays,
        );
        const principalStr = `${formatTokenAmount(principal, lending.decimals)} ${lending.symbol}`;
        const interestStr = `${formatTokenAmount(interest, lending.decimals)} ${lending.symbol}`;
        const collateralStr = `${formatTokenAmount(selected.collateralAmount, collateral.decimals)} ${collateral.symbol}`;
        const durationStr = formatDurationDays(selected.durationDays);
        const grace = gracePeriodLabel(selected.durationDays);
        const illiquidSuffix = selectedIsIlliquid
          ? ` ${copy.match.illiquidWarning}`
          : '';

        if (side === 'borrower') {
          return {
            youReceive: `${principalStr} now (minus the ${lifPct} initiation fee).`,
            youLock: `${collateralStr} as collateral, now.`,
            youMayOwe: `${principalStr} plus up to ~${interestStr} interest by the due date.`,
            youCanLose: `Your ${collateralStr} collateral if you do not repay on time. ${copy.borrow.collateralWarning}${illiquidSuffix}`,
            fees: copy.fees.borrowerLIF(lifPct),
            whenThisEnds: `Repay within ${durationStr} (grace period: ${grace}), then claim your collateral back.`,
          };
        }
        return {
          youReceive: `Up to ~${interestStr} interest if the borrower repays on time, plus your ${principalStr} back.`,
          youLock: `${principalStr} lent to the borrower, now.`,
          youMayOwe: 'Nothing — the borrower owes you.',
          youCanLose: `${copy.lend.defaultOutcome} They lock ${collateralStr}.${illiquidSuffix}`,
          fees: copy.fees.lenderYieldFee(yieldPct),
          whenThisEnds: `Repayment is due within ${durationStr} (grace period: ${grace}). You then claim your funds.`,
        };
      }

      // Post mode — receipt from the user's own terms.
      const lending = lendingMeta.data;
      const collateral = collateralMeta.data;
      if (!lending || !collateral || !postDetailsComplete) return null;
      const payload = toCreateOfferPayload(form, {
        lending: lending.decimals,
        collateral: collateral.decimals,
      });
      const principal = payload.amountMax;
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
          fees: copy.fees.lenderYieldFee(yieldPct),
          whenThisEnds: `Repayment is due ${durationStr} after a borrower accepts (grace period: ${grace}). You then claim your funds.`,
        };
      }
      return {
        youReceive: `${principalStr} when a lender accepts your request.`,
        youLock: `${collateralStr} as collateral, starting now.`,
        youMayOwe: `${principalStr} plus up to ~${interestStr} interest by the due date.`,
        youCanLose: `Your ${collateralStr} collateral if you do not repay on time. ${copy.borrow.collateralWarning}`,
        fees: copy.fees.borrowerLIF(lifPct),
        whenThisEnds: `Repay within ${durationStr} of acceptance (grace period: ${grace}), then claim your collateral back.`,
      };
    } catch {
      return null;
    }
  }, [
    mode,
    selected,
    selectedIsIlliquid,
    side,
    form,
    postDetailsComplete,
    lifPct,
    yieldPct,
    lendingMeta.data,
    collateralMeta.data,
    selectedCollateralMeta.data,
  ]);

  const canSign =
    allChecksPass(checks) &&
    receipt !== null &&
    (mode === 'accept' ? selected !== null : formError === null) &&
    // The wallet client hydrates asynchronously after `isConnected`
    // flips true — without this gate a click in that window would
    // no-op silently.
    Boolean(walletClient) &&
    Boolean(publicClient) &&
    !submitting;

  // ---- Submission ----------------------------------------------------
  // Inner helpers THROW on missing prerequisites and return the tx
  // hash — the success screen only ever renders behind a real
  // transaction.
  async function submitPost(): Promise<`0x${string}`> {
    if (!receipt || !address || !walletChain || !walletClient || !publicClient) {
      throw new Error(copy.wallet.connectFirst);
    }
    const payload = toCreateOfferPayload(form, {
      lending: lendingMeta.data?.decimals,
      collateral: collateralMeta.data?.decimals,
    });
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
    return hash;
  }

  async function submitAccept(): Promise<`0x${string}`> {
    if (!selected || !address || !walletChain || !walletClient || !publicClient) {
      throw new Error(copy.wallet.connectFirst);
    }
    // The reviewed row was fetched from the READ chain — the signature
    // and transaction execute on the WALLET chain. Same offerId on a
    // different chain is a different offer; never cross that silently.
    if (selected.chainId !== walletChain.chainId) {
      throw new Error(copy.match.termsChanged);
    }
    // Sign canonical terms; approval amounts come from the SIGNED
    // terms (canonical), not the indexer row.
    const { terms, signature } = await signAcceptTerms({
      offerId: BigInt(selected.offerId),
      consent: form.riskAndTermsConsent,
    });
    // The canonical terms must still MATCH what the user reviewed —
    // the creator can edit an offer in place, and the indexer row can
    // lag the OfferModified event.
    const reviewedMatchesSigned =
      terms.lendingAsset.toLowerCase() === selected.lendingAsset.toLowerCase() &&
      terms.collateralAsset.toLowerCase() === selected.collateralAsset.toLowerCase() &&
      terms.amount === offerPrincipal(selected) &&
      terms.interestRateBps === BigInt(offerRateBps(selected)) &&
      terms.collateralAmount === BigInt(selected.collateralAmount) &&
      Number(terms.durationDays) === selected.durationDays;
    if (!reviewedMatchesSigned) {
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['offer'] });
      throw new Error(copy.match.termsChanged);
    }
    const acceptorPaysCollateral = side === 'borrower';
    const paysErc20 = acceptorPaysCollateral
      ? terms.collateralAssetType === AssetType.ERC20
      : terms.assetType === AssetType.ERC20;
    if (paysErc20) {
      await ensureAllowance({
        publicClient,
        walletClient,
        token: acceptorPaysCollateral ? terms.collateralAsset : terms.lendingAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: acceptorPaysCollateral ? terms.collateralAmount : terms.amount,
      });
    }
    const { hash } = await write('acceptOffer', [
      BigInt(selected.offerId),
      terms,
      signature,
    ]);
    return hash;
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const hash = mode === 'accept' ? await submitAccept() : await submitPost();
      setTxHash(hash);
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
    } catch (err) {
      setSubmitError(submitErrorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Render ----------------------------------------------------
  const doneTitle = mode === 'accept' ? copy.match.loanOpened : text.doneTitle;
  const doneBody = mode === 'accept' ? text.acceptDoneBody : text.doneBody;

  return (
    <div>
      <h1 className="page-title">{text.title}</h1>
      <p className="page-lede">{text.lede}</p>
      <StepNav steps={stepLabels} current={stepIndex} />

      {deepLinkNotice && step === 'details' ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{deepLinkNotice}</span>
        </div>
      ) : null}

      {step === 'details' ? (
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
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!detailsComplete}
            onClick={() => {
              setSelected(null);
              setStep('choose');
            }}
          >
            See matching offers
          </button>
        </div>
      ) : null}

      {step === 'choose' ? (
        <div className="stack">
          <div className="card">
            <div className="card-title">
              <Search aria-hidden />
              <h2 style={{ margin: 0 }}>{text.matchTitle}</h2>
            </div>
            <p className="muted">{text.matchLede}</p>
            {activeOffers.isLoading ? (
              <p className="muted">Looking for matches…</p>
            ) : matches === null ? (
              <p className="muted">{copy.match.unavailable}</p>
            ) : matches.length === 0 ? (
              <p className="muted">{text.matchEmpty}</p>
            ) : (
              <>
                <div className="row-list">
                  {matches.map((o) => (
                    <MatchOfferRow
                      key={o.offerId}
                      offer={o}
                      side={side}
                      onChoose={() => {
                        setSelected(o);
                        setMode('accept');
                        setStep('review');
                      }}
                    />
                  ))}
                </div>
                <p className="muted" style={{ marginTop: 8 }}>
                  {copy.match.wholeOfferNote}
                </p>
              </>
            )}
          </div>
          <div className="cluster">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('details')}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => {
                setSelected(null);
                setMode('post');
                setStep('terms');
              }}
            >
              {text.orPost}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'terms' ? (
        <div className="card">
          <div className="field">
            <label htmlFor="rate">{text.rateLabel}</label>
            <input
              id="rate"
              className={`input ${form.interestRate !== '' && !rateValid ? 'input-invalid' : ''}`}
              inputMode="decimal"
              placeholder="5"
              value={form.interestRate}
              onChange={(e) => set({ interestRate: e.target.value.trim() })}
            />
            <span className="field-hint">
              {form.interestRate !== '' && !rateValid
                ? `Enter a number between 0 and ${MAX_RATE_PERCENT} — the protocol caps rates at ${MAX_RATE_PERCENT}% yearly.`
                : text.rateHint}
            </span>
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

          <div className="cluster">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('choose')}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={!postDetailsComplete}
              onClick={() => setStep('review')}
            >
              Continue to review
            </button>
          </div>
        </div>
      ) : null}

      {step === 'review' ? (
        <div className="stack">
          {mode === 'accept' && selected ? (
            <div className="banner banner-info">
              <span className="banner-body">
                You’re {side === 'borrower' ? 'accepting lending offer' : 'funding borrow request'}{' '}
                #{selected.offerId}. {copy.match.wholeOfferNote}
              </span>
            </div>
          ) : null}
          {selectedIsIlliquid ? (
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">{copy.match.illiquidWarning}</span>
            </div>
          ) : null}
          <div className="card">
            <h3>Before you sign</h3>
            <Checklist items={checks} />
          </div>
          <div className="card">
            {receipt ? <ReviewReceipt data={receipt} /> : <p className="muted">Preparing your review…</p>}
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
                onClick={() => setStep(mode === 'post' ? 'terms' : 'choose')}
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
                {submitting
                  ? 'Waiting for wallet…'
                  : mode === 'accept'
                    ? text.acceptSubmitLabel
                    : text.submitLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <CircleCheck
            aria-hidden
            size={40}
            style={{ color: 'var(--ok)', marginBottom: 8 }}
          />
          <h2>{doneTitle}</h2>
          <p className="muted">{doneBody}</p>
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
