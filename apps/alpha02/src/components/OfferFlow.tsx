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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CircleCheck, LoaderCircle, Search } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { encodeFunctionData, parseUnits } from 'viem';
import { useActiveChain } from '../chain/useActiveChain';
import { getSupportedChain } from '../chain/chains';
import { useMode } from '../app/ModeContext';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { useAcceptTermsSigning } from '../contracts/useAcceptTerms';
import { SimulationPreview } from './SimulationPreview';
import type { TxSimInput } from '../contracts/useTxSimulation';
import {
  ensureAllowance,
  isAddressLike,
  useTokenBalance,
  useTokenMeta,
} from '../contracts/erc20';
import { useActiveOffers, useOffer } from '../data/hooks';
import { useProtocolFees, bpsToPercentText, readLiveProtocolFees } from '../data/fees';
import { useGraceLabel } from '../data/protocol';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import {
  assertAssetNotPausedLive,
  assertErc20BalanceLive,
  isAssetIlliquidLive,
} from '../contracts/preflights';
import type { IndexedOffer } from '../data/indexer';
import {
  OFFER_DURATION_BUCKETS_DAYS,
  initialOfferForm,
  toCreateOfferPayload,
  validateOfferForm,
  type OfferFormState,
} from '../lib/offerSchema';
import { AssetType } from '../lib/types';
import {
  readLoanLive,
  saleBuyerRemainingInterest,
  type LoanLive,
} from '../contracts/loanLive';
import { saleSettlementNow } from '../data/loanSalePending';
import {
  formatBpsAsPercent,
  formatDate,
  formatDurationDays,
  formatTokenAmount,
  fullTermInterest,
} from '../lib/format';
import { isPlainDecimal, isPositiveDecimal, submitErrorText } from '../lib/errors';
import { copy } from '../content/copy';
import { flowDisabled } from '../lib/killSwitch';
import {
  fetchTokenSecurity,
  isCuratedAsset,
  needsSecurityCheck,
  useTokenSecurity,
  verdictFingerprint,
} from '../data/tokenSecurity';
import {
  makeStepper,
  plannedApprovePrompts,
  readAllowance,
  useAllowanceForPlan,
  type Stepper,
  type SubmitProgress,
} from '../lib/submitProgress';
import { AssetPicker } from './AssetPicker';
import { MarketFreshnessNote } from './MarketFreshnessNote';
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

/** One source for the interest-mode consent line (accept + post).
 *  The pro-rata phrasing is audience-specific: "repaying early costs
 *  less" is the borrower's frame; the lender's is "early repayment
 *  earns less". */
function interestModeNote(
  useFullTermInterest: boolean,
  audience: 'borrower' | 'lender',
): string {
  if (useFullTermInterest) return copy.match.interestModeFullTerm;
  return audience === 'borrower'
    ? copy.match.interestModeProRata
    : copy.match.interestModeProRataLender;
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
  const { address, walletChain, readChain } = useActiveChain();
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
  // #1037 — null while idle; {kind, current, total} during the
  // multi-prompt submission so the button can say WHERE the user is
  // ("Approving… (2 of 3)") instead of one flat waiting state.
  const [progress, setProgress] = useState<SubmitProgress | null>(null);
  const submitting = progress !== null;
  // Synchronous re-entrancy lock for submit() — see the comment there.
  const submitLockRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Set at submit time — after success the offer is consumed and the
  // cached linkage queries reset, so the done screen can't re-derive
  // what KIND of accept just completed.
  const [doneWasSaleBuy, setDoneWasSaleBuy] = useState<string | null>(null);

  // ANY form edit is potentially disclosure-driving — the central rule
  // voids prior consent on every patch that doesn't itself set the
  // consent field. New inputs get the reset for free; forgetting it at
  // a call site is impossible.
  const set = (patch: Partial<OfferFormState>) =>
    setForm((f) => ({
      ...f,
      ...('riskAndTermsConsent' in patch ? {} : { riskAndTermsConsent: false }),
      ...patch,
    }));

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
    // Offer ids repeat across chains — a link minted on one network
    // must never resolve against another. Old links without the param
    // pass through (they predate multi-chain deep links).
    const chainParam = searchParams.get('chain');
    if (chainParam !== null && Number(chainParam) !== readChain.chainId) {
      const target = getSupportedChain(Number(chainParam));
      clear(
        copy.match.wrongChainLink(
          target ? target.name : `network #${chainParam}`,
        ),
      );
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
    setForm((f) => ({ ...f, lendingAsset: row.lendingAsset, riskAndTermsConsent: false }));
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
    searchParams,
    readChain.chainId,
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

  const readClient = usePublicClient({ chainId: readChain.chainId });

  // A Borrower-type offer can be a LOAN-SALE VEHICLE (lender Option-2
  // listing): accepting it buys a RUNNING loan position — principal
  // goes to the exiting lender, the acceptor steps in as lender of a
  // part-elapsed loan whose collateral lives on the linked loan. The
  // indexer has no column for this, so the review reads the link
  // live and must DISCLOSE it before signing (the signed AcceptTerms
  // binds linkedLoanId either way).
  const linkedLoan = useQuery({
    queryKey: ['offerLinkedLoan', readChain.chainId, selected?.offerId],
    enabled: mode === 'accept' && Boolean(readClient) && Boolean(selected),
    staleTime: 60_000,
    queryFn: async () => {
      const linked = (await readClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getOfferLinkedLoanId',
        args: [BigInt(selected!.offerId)],
      })) as bigint;
      return linked.toString();
    },
  });
  const linkedLoanKnown = mode !== 'accept' || linkedLoan.data !== undefined;
  const acceptIsLoanSale =
    mode === 'accept' && linkedLoan.data !== undefined && linkedLoan.data !== '0';
  // Same late-disclosure rule as the illiquid warning: consent given
  // before the sale-vehicle banner appeared must be re-given.
  useEffect(() => {
    if (acceptIsLoanSale) {
      setForm((f) =>
        f.riskAndTermsConsent ? { ...f, riskAndTermsConsent: false } : f,
      );
    }
  }, [acceptIsLoanSale]);

  // #986 P3 — the honest buy-a-running-loan review. A sale-vehicle
  // offer's stored fields misdescribe the deal (zero collateral, a
  // term that already partly elapsed), so the review reads the LINKED
  // LOAN live and describes the position actually being bought. A
  // sale link is discriminated from a preclose-offset link by the
  // creator (sale vehicles are created by the loan's lender); offsets
  // and unknown shapes keep the #951 block. Also preflights the
  // SELLER's settlement funding: `completeLoanSale` pulls the seller's
  // accrued-interest forfeit from the seller's WALLET, and a revoked
  // standing approval fails as an opaque `OfferAcceptFailed` — a
  // doomed buy must be blocked here with a plain reason instead.
  const saleReview = useQuery({
    queryKey: [
      'offerSaleReview',
      readChain.chainId,
      selected?.offerId,
      linkedLoan.data,
      address?.toLowerCase(),
    ],
    enabled:
      acceptIsLoanSale && Boolean(readClient) && Boolean(selected),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: () =>
      readSaleReviewLive(
        readClient!,
        readChain.diamondAddress,
        selected!,
        linkedLoan.data!,
        address,
      ),
  });
  const saleData = saleReview.data;
  const saleLoanLive: LoanLive | null =
    saleData?.kind === 'sale' ? saleData.live : null;
  // The sale review is signable only when every gate is POSITIVELY
  // clear: it is a sale link, the loan is Active and unmatured, and
  // the seller's settlement funding covers completion right now.
  const saleReviewReady =
    saleData?.kind === 'sale' &&
    saleLoanLive !== null &&
    saleLoanLive.status === 0 &&
    !saleData.matured &&
    saleData.sellerCovered &&
    !saleData.selfBuyBlocked;
  // Re-consent when the review-material sale numbers MOVE (first
  // arrival included): a borrower partial-repay or collateral change
  // between refetches rewrites what the receipt shows, and a tick
  // given against the old numbers must not carry over. The decaying
  // remaining-interest estimate is deliberately NOT in the
  // fingerprint — it shrinks every refetch by time passing alone
  // (the receipt says "up to ~"), and resetting consent each minute
  // would make the checkbox effectively untickable.
  const saleFingerprint =
    saleData?.kind === 'sale'
      ? [
          saleData.live.principal,
          saleData.live.collateralAmount,
          saleData.dueAtSec,
          saleData.live.status,
          saleData.matured,
          saleData.sellerCovered,
          saleData.selfBuyBlocked,
        ].join(':')
      : null;
  const prevSaleFingerprint = useRef(saleFingerprint);
  useEffect(() => {
    if (prevSaleFingerprint.current === saleFingerprint) return;
    prevSaleFingerprint.current = saleFingerprint;
    if (saleFingerprint !== null) {
      setForm((f) =>
        f.riskAndTermsConsent ? { ...f, riskAndTermsConsent: false } : f,
      );
    }
  }, [saleFingerprint]);

  const lockedAmount = useMemo(() => {
    if (mode === 'accept' && selected) {
      if (side === 'borrower') return BigInt(selected.collateralAmount);
      // #986 P3 — a sale buy pays the LINKED LOAN's live principal
      // (what the canonical terms bind and the approval pulls), not
      // the listing row's stored amount: after a borrower partial
      // repay the row overstates the price and would block a buyer
      // who can actually afford the purchase.
      return saleData?.kind === 'sale'
        ? saleData.live.principal
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
  }, [mode, selected, form, side, lockedMeta.data, lendingMeta.data, collateralMeta.data, saleData]);

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
          // Partially-filled offers are matcher-only: acceptOffer reverts
          // OfferPartiallyFilled, so never surface them as pickable.
          BigInt(o.amountFilled || '0') === 0n &&
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
  // Governance can lower the duration cap below the client buckets
  // (createOffer reverts OfferDurationExceedsCap above it) — filter
  // the picker and re-validate the selected value against the LIVE
  // cap so the approval tx can't mine ahead of a doomed createOffer.
  const durationOptions = OFFER_DURATION_BUCKETS_DAYS.filter(
    (d) => d <= fees.maxOfferDurationDays,
  );
  const durationValid = Number(form.durationDays) <= fees.maxOfferDurationDays;
  const detailsComplete =
    isAddressLike(form.lendingAsset) &&
    isPositiveDecimal(form.amount) &&
    durationValid;
  const formError = validateOfferForm(form);
  // createOffer rejects lendingAsset == collateralAsset
  // (SelfCollateralizedOffer) — catch it before any approval can mine.
  const selfCollateral =
    isAddressLike(form.lendingAsset) &&
    isAddressLike(form.collateralAsset) &&
    form.lendingAsset.toLowerCase() === form.collateralAsset.toLowerCase();
  const postDetailsComplete =
    detailsComplete &&
    isAddressLike(form.collateralAsset) &&
    isPositiveDecimal(form.collateralAmount) &&
    !selfCollateral &&
    rateValid;

  // ---- Review receipt ----------------------------------------------------
  // One side of the deal being unpriced (illiquid) changes the default
  // outcome to a direct in-kind transfer — the receipt must say so.
  // The warning is the UNION of the indexer row's flags (accept mode)
  // and a LIVE checkLiquidity read of the deal's legs in BOTH modes:
  // live because the indexer can lag an on-chain flip (without the
  // live read, the signer's pre-sign re-check would abort to a
  // re-review that still shows no warning — an inescapable loop), and
  // indexer-united because a live blip must not hide a warning the
  // row already carries.
  const indexerSaysIlliquid =
    mode === 'accept' &&
    selected !== null &&
    (selected.principalLiquidity === 1 || selected.collateralLiquidity === 1);
  const liqLegA = mode === 'post' ? form.lendingAsset : (selected?.lendingAsset ?? '');
  const liqLegB =
    mode === 'post' ? form.collateralAsset : (selected?.collateralAsset ?? '');
  const legLiquidity = useQuery({
    queryKey: [
      'legLiquidity',
      readChain.chainId,
      liqLegA.toLowerCase(),
      liqLegB.toLowerCase(),
    ],
    enabled:
      Boolean(readClient) && isAddressLike(liqLegA) && isAddressLike(liqLegB),
    staleTime: 60_000,
    queryFn: async () => {
      // failClosed: an unreadable liquidity status must land the query
      // in error/retry — silently rendering "no warning" would let the
      // user consent without the in-kind-default disclosure.
      const [lending, collateral] = await Promise.all([
        isAssetIlliquidLive({
          publicClient: readClient!,
          diamondAddress: readChain.diamondAddress,
          asset: liqLegA,
          failClosed: true,
        }),
        isAssetIlliquidLive({
          publicClient: readClient!,
          diamondAddress: readChain.diamondAddress,
          asset: liqLegB,
          failClosed: true,
        }),
      ]);
      return lending || collateral;
    },
  });
  // The liquidity answer gates a DISCLOSURE — signing waits until it
  // is known (in accept mode the indexer flags alone don't count:
  // they can lag the chain in BOTH directions).
  const liquidityKnown = legLiquidity.data !== undefined;
  const reviewIsIlliquid = indexerSaysIlliquid || legLiquidity.data === true;

  // The liquidity query resolves asynchronously — if the illiquid
  // warning appears AFTER the user already ticked consent, that
  // consent predates the disclosure and must be re-given.
  useEffect(() => {
    if (reviewIsIlliquid) {
      setForm((f) =>
        f.riskAndTermsConsent ? { ...f, riskAndTermsConsent: false } : f,
      );
    }
  }, [reviewIsIlliquid]);


  // Receipts must show the grace window repayment is actually judged
  // against — governance buckets can override the default schedule.
  // While the LIVE bucket read is in flight the label is the default
  // schedule's wording, which is wrong on a retuned chain — display
  // may proceed, signing gates on `ready` (like the liquidity check).
  // For a SALE review the bucket keys off the LINKED LOAN's original
  // term (LibVaipakam.gracePeriod(loan.durationDays)) — the offer row
  // may carry a shorter remaining-term duration in a different bucket.
  const activeDurationDays =
    mode === 'accept'
      ? saleData?.kind === 'sale'
        ? Number(saleData.live.durationDays)
        : (selected?.durationDays ?? 0)
      : Number(form.durationDays) || 0;
  const grace = useGraceLabel(activeDurationDays);
  // If the label MOVES after the user already ticked consent (the
  // live bucket read resolving to a non-default window), that consent
  // predates the corrected term — same re-consent rule as the late
  // illiquid/linked-loan disclosures.
  const prevGraceLabel = useRef(grace.label);
  useEffect(() => {
    if (prevGraceLabel.current === grace.label) return;
    prevGraceLabel.current = grace.label;
    setForm((f) =>
      f.riskAndTermsConsent ? { ...f, riskAndTermsConsent: false } : f,
    );
  }, [grace.label]);

  const lifPct = bpsToPercentText(fees.loanInitiationFeeBps);
  const yieldPct = bpsToPercentText(fees.treasuryFeeBps);

  // #1028 item 2 — advisory pre-sign dry run of the EXACT calldata
  // the submit will send. Post mode only: the accept path's calldata
  // carries an EIP-712 AcceptTerms signed at submit time, and
  // fabricating placeholder terms here would duplicate the canonical
  // submit-time builder just to preview a signature-artefact revert.
  // Never feeds canSign — advisory by design.
  const simTx = useMemo((): TxSimInput | null => {
    // Consent gate (round 1): createOffer reverts
    // RiskAndTermsConsentRequired while the checkbox is unticked —
    // previewing that would cry wolf on every valid offer.
    if (mode !== 'post' || !walletChain || !form.riskAndTermsConsent) return null;
    try {
      const payload = toCreateOfferPayload(form, {
        lending: lendingMeta.data?.decimals,
        collateral: collateralMeta.data?.decimals,
      });
      return {
        to: walletChain.diamondAddress,
        data: encodeFunctionData({
          abi: DIAMOND_ABI_VIEM,
          functionName: 'createOffer',
          args: [payload],
        }),
        value: 0n,
        // The submit path grants the deposit-leg allowance first, so
        // the zero-allowance revert at preview time is expected.
        allowAllowanceRevert: true,
      };
    } catch {
      return null; // form not buildable yet — footer stays hidden
    }
  }, [mode, walletChain, form, lendingMeta.data, collateralMeta.data]);

  const receipt = useMemo((): ReceiptData | null => {
    // The conversions below throw on inputs the completeness gates
    // can't fully exclude — never let that take down the page.
    try {
      if (mode === 'accept' && selected) {
        const lending = lendingMeta.data;
        const collateral = selectedCollateralMeta.data;
        if (!lending || !collateral) return null;

        // #986 P3 — sale-vehicle receipt: every number comes from the
        // LINKED LOAN live, never the offer row (which shows zero
        // collateral and a term that already partly elapsed). Renders
        // only when the sale review is fully clear; any other linked
        // state stays receipt-less (and blocked below).
        if (acceptIsLoanSale) {
          if (
            side !== 'lender' ||
            !saleReviewReady ||
            saleData?.kind !== 'sale' ||
            saleData.live.collateralAsset.toLowerCase() !==
              selected.collateralAsset.toLowerCase()
          ) {
            return null;
          }
          const live = saleData.live;
          const principalStr = `${formatTokenAmount(live.principal, lending.decimals)} ${lending.symbol}`;
          const interestStr = `${formatTokenAmount(saleData.buyerInterest, lending.decimals)} ${lending.symbol}`;
          const collateralStr = `${formatTokenAmount(live.collateralAmount, collateral.decimals)} ${collateral.symbol}`;
          const dueStr = formatDate(saleData.dueAtSec);
          const illiquidSuffix = reviewIsIlliquid
            ? ` ${copy.match.illiquidWarning}`
            : '';
          return {
            youReceive: `The lender position of running loan #${saleData.loanId}: up to ~${interestStr} interest from now to the due date if the borrower repays on time, plus the full ${principalStr} principal back.`,
            youLock: `${principalStr} paid now to the exiting lender — the loan itself doesn't change for the borrower.`,
            youMayOwe: 'Nothing — the borrower owes you.',
            youCanLose: `${copy.lend.defaultOutcome} Their ${collateralStr} is already locked.${illiquidSuffix}`,
            fees: copy.fees.lenderYieldFee(yieldPct),
            whenThisEnds: `Repayment is due by ${dueStr} (grace period: ${grace.label}). You then claim your funds.`,
          };
        }
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
        const graceStr = grace.label;
        const illiquidSuffix = reviewIsIlliquid
          ? ` ${copy.match.illiquidWarning}`
          : '';
        // The offer's interest MODE changes what early repayment costs
        // — state it in the consent text (ProjectDetailsREADME).
        const acceptModeNote = interestModeNote(selected.useFullTermInterest, side);

        if (side === 'borrower') {
          return {
            youReceive: `${principalStr} now (minus the ${lifPct} initiation fee).`,
            youLock: `${collateralStr} as collateral, now.`,
            youMayOwe: `${principalStr} plus up to ~${interestStr} interest by the due date. ${acceptModeNote}`,
            youCanLose: `Your ${collateralStr} collateral if you do not repay on time. ${copy.borrow.collateralWarning}${illiquidSuffix}`,
            fees: copy.fees.borrowerLIF(lifPct),
            whenThisEnds: `Repay within ${durationStr} (grace period: ${graceStr}), then claim your collateral back.`,
          };
        }
        return {
          youReceive: `Up to ~${interestStr} interest if the borrower repays on time, plus your ${principalStr} back. ${acceptModeNote}`,
          youLock: `${principalStr} lent to the borrower, now.`,
          youMayOwe: 'Nothing — the borrower owes you.',
          youCanLose: `${copy.lend.defaultOutcome} They lock ${collateralStr}.${illiquidSuffix}`,
          fees: copy.fees.lenderYieldFee(yieldPct),
          whenThisEnds: `Repayment is due within ${durationStr} (grace period: ${graceStr}). You then claim your funds.`,
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
      const graceStr = grace.label;
      // The interest MODE changes what an early repayment costs — the
      // consent text must state it explicitly (ProjectDetailsREADME).
      const modeNote = interestModeNote(form.useFullTermInterest, side);
      const postIlliquidSuffix = reviewIsIlliquid
        ? ` ${copy.match.illiquidWarning}`
        : '';

      if (side === 'lender') {
        return {
          youReceive: `Up to ~${interestStr} interest if the borrower repays on time, plus your ${principalStr} back. ${modeNote}`,
          youLock: `${principalStr} now, until your offer is accepted or you cancel it.`,
          youMayOwe: 'Nothing — the borrower owes you.',
          youCanLose: `${copy.lend.defaultOutcome} They must lock ${collateralStr}.${postIlliquidSuffix}`,
          fees: copy.fees.lenderYieldFee(yieldPct),
          whenThisEnds: `Repayment is due ${durationStr} after a borrower accepts (grace period: ${graceStr}). You then claim your funds.`,
        };
      }
      return {
        youReceive: `${principalStr} when a lender accepts your request.`,
        youLock: `${collateralStr} as collateral, starting now.`,
        youMayOwe: `${principalStr} plus up to ~${interestStr} interest by the due date. ${modeNote}`,
        youCanLose: `Your ${collateralStr} collateral if you do not repay on time. ${copy.borrow.collateralWarning}${postIlliquidSuffix}`,
        fees: copy.fees.borrowerLIF(lifPct),
        whenThisEnds: `Repay within ${durationStr} of acceptance (grace period: ${graceStr}), then claim your collateral back.`,
      };
    } catch {
      return null;
    }
  }, [
    mode,
    selected,
    reviewIsIlliquid,
    grace.label,
    side,
    form,
    postDetailsComplete,
    lifPct,
    yieldPct,
    lendingMeta.data,
    collateralMeta.data,
    selectedCollateralMeta.data,
    acceptIsLoanSale,
    saleData,
    saleReviewReady,
  ]);

  const isOwnSelectedOffer =
    mode === 'accept' &&
    selected !== null &&
    Boolean(address) &&
    selected.creator.toLowerCase() === address!.toLowerCase();

  // #1036 — GoPlus screening of BOTH legs, in BOTH modes. The accept
  // side is the primary defense (a malicious offer is created straight
  // against the contract, so only the acceptor's screen can catch a
  // honeypot leg), but the POST side gates too: createOffer pulls the
  // creator's own ERC-20 into their vault, and the vault records the
  // REQUESTED amount — a fee-on-transfer or otherwise-blocked token
  // locks an underfunded position for the creator themselves. Curated
  // tokens skip (hook self-disables); testnets resolve to
  // 'unsupported' (allowed, noticed); 'block' and 'unknown' (couldn't
  // verify) hold the sign button — fail closed, with copy telling the
  // user why.
  const secLendingLeg =
    mode === 'accept'
      ? {
          addr: selected?.lendingAsset,
          isErc20: selected?.assetType === AssetType.ERC20,
        }
      : { addr: form.lendingAsset, isErc20: form.assetType === 'erc20' };
  const secCollateralLeg =
    mode === 'accept'
      ? {
          addr: selected?.collateralAsset,
          isErc20: selected?.collateralAssetType === AssetType.ERC20,
        }
      : {
          addr: form.collateralAsset,
          isErc20: form.collateralAssetType === 'erc20',
        };
  const acceptLendingSec = useTokenSecurity(
    readChain.chainId,
    secLendingLeg.isErc20 ? secLendingLeg.addr || undefined : undefined,
  );
  const acceptCollateralSec = useTokenSecurity(
    readChain.chainId,
    secCollateralLeg.isErc20 ? secCollateralLeg.addr || undefined : undefined,
  );
  // 'needed' derives from the check's INPUTS (shape + curated), never
  // from query lifecycle state — fetchStatus returns to idle once a
  // query settles, which must not un-gate a bad verdict.
  const securityLegs = [
    {
      leg: 'loan asset',
      needed:
        secLendingLeg.isErc20 &&
        needsSecurityCheck(readChain.chainId, secLendingLeg.addr),
      verdict: acceptLendingSec.data,
      errored: acceptLendingSec.isError,
    },
    {
      leg: 'collateral',
      needed:
        secCollateralLeg.isErc20 &&
        needsSecurityCheck(readChain.chainId, secCollateralLeg.addr),
      verdict: acceptCollateralSec.data,
      errored: acceptCollateralSec.isError,
    },
  ].filter((l) => l.needed);
  // Fail-closed on THREE states: no data yet (loading), a 'block'
  // verdict, and an errored REFETCH — react-query keeps the prior
  // verdict in `data` when a later refetch fails, so `isError` must
  // dominate the stale verdict or an outage would silently un-gate.
  const securityBlocked = securityLegs.filter(
    (l) => l.errored || l.verdict === undefined || l.verdict.kind === 'block',
  );
  const securityWarned = securityLegs.filter(
    (l) => !l.errored && l.verdict?.kind === 'warn',
  );
  const securityUnsupported = securityLegs.filter(
    (l) => l.verdict?.kind === 'unsupported',
  );
  // No mode bypass: post-mode deposits hit the same requested-amount
  // vault accounting the accept path does, so both modes hold on a
  // blocked/unverified leg.
  const securityGateOk = securityBlocked.length === 0;
  // #1028 — operator kill switch. Position-opening flows only; the
  // banner explains, and close-out paths are structurally unkillable
  // (see lib/killSwitch.ts).
  const killed = flowDisabled(mode === 'accept' ? 'accept-offer' : 'post-offer');
  // Late-disclosure rule (same as illiquid/sale banners): a warning
  // or block that ARRIVES after the consent box was ticked voids the
  // consent — it was given against a review without the disclosure.
  // The fingerprint includes the REASON text, not just the verdict
  // kind: consent given against "10% sell tax" must not survive the
  // warning changing to "the owner can pause all transfers".
  const securityFingerprint = securityLegs
    .map(
      (l) =>
        `${l.leg}:${l.errored ? 'errored' : verdictFingerprint(l.verdict)}`,
    )
    .join('|');
  // The fingerprint that was current when the user LAST ticked the
  // consent box (stamped in the checkbox handler). canSign requires
  // it to match the live fingerprint whenever a warning is on screen:
  // the consent-clear effect below runs only AFTER a commit, leaving
  // one render where a freshly-arrived warn and stale consent coexist
  // — this derived gate closes that window without waiting for the
  // effect.
  const securityConsentFpRef = useRef<string | null>(null);
  useEffect(() => {
    if (securityBlocked.length > 0 || securityWarned.length > 0) {
      setForm((f) =>
        f.riskAndTermsConsent ? { ...f, riskAndTermsConsent: false } : f,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [securityFingerprint]);

  const canSign =
    allChecksPass(checks) &&
    receipt !== null &&
    !isOwnSelectedOffer &&
    liquidityKnown &&
    // The reviewed grace window must be the LIVE one — the fallback
    // label can be wrong on a chain with retuned buckets.
    grace.ready &&
    // The linked-loan answer gates a BLOCK, not just a disclosure: a
    // linked offer settles/transfers a running loan and the fresh-loan
    // receipt does not describe those terms — signing waits until the
    // answer is known. A SALE link may sign once its own review is
    // fully clear (#986 P3: loan-derived receipt, loan Active +
    // unmatured, seller settlement funding covered); offset/unknown
    // links never sign here.
    linkedLoanKnown &&
    (!acceptIsLoanSale || saleReviewReady) &&
    securityGateOk &&
    // A disclosed security warning requires consent granted AGAINST
    // the current fingerprint — not merely consent that is still true
    // from before the warning appeared.
    (securityWarned.length === 0 ||
      securityConsentFpRef.current === securityFingerprint) &&
    (mode === 'accept'
      ? selected !== null
      : formError === null && durationValid && !selfCollateral) &&
    // The wallet client hydrates asynchronously after `isConnected`
    // flips true — without this gate a click in that window would
    // no-op silently.
    Boolean(walletClient) &&
    Boolean(publicClient) &&
    !killed &&
    !submitting;

  // ---- Prompt-count pre-disclosure (#1037) --------------------------
  // The review screen states how many wallet prompts this submission
  // takes BEFORE the first one fires. The count needs the live
  // allowance of the leg this wallet pays: covered → the approve
  // prompt drops out; non-zero-but-short → the zero-first reset makes
  // it two. The same numbers drive the runtime plan in submit().
  const planLeg = useMemo(() => {
    if (mode === 'accept') {
      if (!selected) return null;
      const paysCollateral = side === 'borrower';
      const erc20Leg = paysCollateral
        ? selected.collateralAssetType === AssetType.ERC20
        : selected.assetType === AssetType.ERC20;
      if (!erc20Leg) return { token: undefined, amount: 0n, needsSign: true };
      return {
        token: (paysCollateral
          ? selected.collateralAsset
          : selected.lendingAsset) as `0x${string}`,
        amount: paysCollateral
          ? BigInt(selected.collateralAmount)
          : acceptIsLoanSale && saleData?.kind === 'sale'
            ? saleData.live.principal
            : offerPrincipal(selected),
        needsSign: true,
      };
    }
    try {
      const payload = toCreateOfferPayload(form, {
        lending: lendingMeta.data?.decimals,
        collateral: collateralMeta.data?.decimals,
      });
      return {
        token: (side === 'lender'
          ? payload.lendingAsset
          : payload.collateralAsset) as `0x${string}`,
        amount: side === 'lender' ? payload.amountMax : payload.collateralAmount,
        needsSign: false,
      };
    } catch {
      return null; // form not yet convertible — no roadmap to show
    }
  }, [
    mode,
    selected,
    side,
    form,
    lendingMeta.data?.decimals,
    collateralMeta.data?.decimals,
    acceptIsLoanSale,
    saleData,
  ]);
  const planAllowance = useAllowanceForPlan({
    chainId: walletChain?.chainId,
    token: step === 'review' ? planLeg?.token : undefined,
    owner: address as `0x${string}` | undefined,
    spender: walletChain?.diamondAddress,
  });
  const planApprove = planLeg?.token
    ? plannedApprovePrompts(planAllowance.data, planLeg.amount)
    : 0;
  // Allowance still loading / failed → the count is a CEILING (the
  // approve leg planned at 2) and the roadmap must say "up to", not
  // state a number that a zero-first reset would exceed.
  const planKnown = !planLeg?.token || planAllowance.data !== undefined;
  const planTotal =
    planLeg === null ? null : (planLeg.needsSign ? 1 : 0) + planApprove + 1;

  // ---- Submission ----------------------------------------------------
  // Inner helpers THROW on missing prerequisites and return the tx
  // hash — the success screen only ever renders behind a real
  // transaction.
  async function submitPost(stepper: Stepper): Promise<`0x${string}`> {
    if (!receipt || !address || !walletChain || !walletClient || !publicClient) {
      throw new Error(copy.wallet.connectFirst);
    }
    // The checklist's sanctions item is a CACHED read — re-screen the
    // wallet live before any approval can mine.
    await assertWalletNotSanctionedLive(
      publicClient,
      walletChain.diamondAddress,
      address,
    );
    // Liquidity can flip between review and submit (and a stale cached
    // "liquid" can survive a failed refetch) — re-read live, fail
    // closed, and force a re-review if the in-kind-default warning
    // was never shown for what is now an unpriced pair.
    const [postLendingIlliquid, postCollateralIlliquid] = await Promise.all([
      isAssetIlliquidLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        asset: form.lendingAsset,
        failClosed: true,
      }),
      isAssetIlliquidLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        asset: form.collateralAsset,
        failClosed: true,
      }),
    ]);
    if ((postLendingIlliquid || postCollateralIlliquid) && !reviewIsIlliquid) {
      void queryClient.invalidateQueries({ queryKey: ['legLiquidity'] });
      throw new Error(copy.match.termsChanged);
    }
    // The receipt quoted the CACHED fee config (5-min staleTime) — a
    // governance retune inside that window would have the user approve
    // against a stale receipt, or mine an approval ahead of an
    // OfferDurationExceedsCap revert. Re-read live and force a
    // re-review when anything the receipt/validation used moved.
    const liveFees = await readLiveProtocolFees(
      publicClient,
      walletChain.diamondAddress,
    );
    if (
      liveFees.treasuryFeeBps !== fees.treasuryFeeBps ||
      liveFees.loanInitiationFeeBps !== fees.loanInitiationFeeBps ||
      liveFees.maxOfferDurationDays !== fees.maxOfferDurationDays
    ) {
      void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
      throw new Error(copy.match.termsChanged);
    }
    const payload = toCreateOfferPayload(form, {
      lending: lendingMeta.data?.decimals,
      collateral: collateralMeta.data?.decimals,
    });
    const token = (side === 'lender'
      ? payload.lendingAsset
      : payload.collateralAsset) as `0x${string}`;
    const amount = side === 'lender' ? payload.amountMax : payload.collateralAmount;
    // Paused legs make createOffer revert (requireAssetNotPaused), and
    // the checklist's balance item is a CACHED read — re-check all
    // three live, in ONE round-trip (they're independent), before the
    // approval can mine.
    await Promise.all([
      assertAssetNotPausedLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        asset: payload.lendingAsset as `0x${string}`,
      }),
      assertAssetNotPausedLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        asset: payload.collateralAsset as `0x${string}`,
      }),
      assertErc20BalanceLive({
        publicClient,
        token,
        owner: address,
        amount,
        symbol:
          side === 'lender' ? lendingMeta.data?.symbol : collateralMeta.data?.symbol,
      }),
    ]);
    // #1036 — re-verify both legs at SUBMIT time, post mode too: the
    // creator's own ERC-20 goes into vault custody at the requested
    // amount, so a blocked/unverified token must abort before the
    // approval can mine. Same disclosure rules as the accept path —
    // a live verdict differing from the reviewed one is pushed into
    // the query cache so the re-review renders it and voids consent.
    for (const [leg, addr, isErc20] of [
      ['loan asset', form.lendingAsset, form.assetType === 'erc20'],
      [
        'collateral',
        form.collateralAsset,
        form.collateralAssetType === 'erc20',
      ],
    ] as const) {
      if (!isErc20 || !addr) continue;
      if (isCuratedAsset(walletChain.chainId, addr)) continue; // pre-vetted
      const v = await fetchTokenSecurity(walletChain.chainId, addr);
      const cacheKey = ['tokenSecurity', readChain.chainId, addr.toLowerCase()];
      if (v.kind === 'block') {
        queryClient.setQueryData(cacheKey, v);
        throw new Error(copy.tokenSecurity.gateBlock(leg, v.reasons));
      }
      if (v.kind === 'unknown') {
        // RESET (not invalidate) the cached pass: reset drops `data`
        // to undefined immediately, so the gate is closed the moment
        // the submit lock clears — invalidate would keep the stale
        // verdict readable (and the button enabled) while the forced
        // refetch is still in flight. If the outage persists the
        // refetch errors into the blocked banner + "Check again".
        void queryClient.resetQueries({ queryKey: cacheKey });
        throw new Error(copy.tokenSecurity.gateUnknown(leg));
      }
      if (v.kind === 'warn') {
        const reviewed = securityLegs.find((l) => l.leg === leg);
        if (verdictFingerprint(v) !== verdictFingerprint(reviewed?.verdict)) {
          queryClient.setQueryData(cacheKey, v);
          // Clear consent SYNCHRONOUSLY — the fingerprint effect only
          // fires on the next render, and in that window a fast retry
          // would find the (now-cached) warn equal to the reviewed
          // one and sail through un-consented.
          setForm((f) =>
            f.riskAndTermsConsent ? { ...f, riskAndTermsConsent: false } : f,
          );
          throw new Error(copy.tokenSecurity.gateChanged(leg));
        }
      }
    }
    await ensureAllowance({
      publicClient,
      walletClient,
      token,
      owner: address,
      spender: walletChain.diamondAddress,
      amount,
      onPrompt: () => stepper.next('approve'),
    });
    stepper.next('send');
    const { hash } = await write('createOffer', [payload]);
    return hash;
  }

  async function submitAccept(stepper: Stepper): Promise<`0x${string}`> {
    if (!selected || !address || !walletChain || !walletClient || !publicClient) {
      throw new Error(copy.wallet.connectFirst);
    }
    // The reviewed row was fetched from the READ chain — the signature
    // and transaction execute on the WALLET chain. Same offerId on a
    // different chain is a different offer; never cross that silently.
    if (selected.chainId !== walletChain.chainId) {
      throw new Error(copy.match.termsChanged);
    }
    // Re-check ownership at SUBMIT time: the wallet may have connected
    // (or changed) after the offer was selected while disconnected.
    if (selected.creator.toLowerCase() === address.toLowerCase()) {
      throw new Error(copy.match.ownOffer);
    }
    // Re-screen the CONNECTED wallet live — the checklist's sanctions
    // item is a cached read and a flag can land inside its window.
    await assertWalletNotSanctionedLive(
      publicClient,
      walletChain.diamondAddress,
      address,
    );
    // The contract screens the offer CREATOR too — if they were
    // flagged after posting, the accept is doomed; fail before any
    // signature or approval (fail-open on read errors).
    const creatorFlagged = await publicClient
      .readContract({
        address: walletChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'isSanctionedAddress',
        args: [selected.creator as `0x${string}`],
      })
      .catch(() => false);
    if (creatorFlagged) {
      throw new Error(copy.match.counterpartyBlocked);
    }
    // The reviewed receipt quoted fee percentages from the CACHED
    // config — refuse to sign against a stale fee quote.
    const liveFees = await readLiveProtocolFees(
      publicClient,
      walletChain.diamondAddress,
    );
    if (
      liveFees.treasuryFeeBps !== fees.treasuryFeeBps ||
      liveFees.loanInitiationFeeBps !== fees.loanInitiationFeeBps
    ) {
      void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
      throw new Error(copy.match.termsChanged);
    }
    // Sign canonical terms; approval amounts come from the SIGNED
    // terms (canonical), not the indexer row. The REVIEWED terms are
    // passed in so the hook compares canonical-vs-reviewed BEFORE the
    // wallet is asked to sign — the user never signs terms they didn't
    // review, even in the abort path.
    let signed: Awaited<ReturnType<typeof signAcceptTerms>>;
    try {
      // #986 P3 — for a sale-vehicle accept the REVIEW showed the
      // linked loan's live numbers (that is what the receipt promised),
      // and the canonical terms are loan-derived too — so the
      // reviewed-vs-canonical guard must compare against those same
      // values. A move between review and sign (partial repay changing
      // principal, collateral change) still aborts, exactly as wanted.
      const saleReviewed =
        acceptIsLoanSale && saleReviewReady && saleData?.kind === 'sale'
          ? saleData.live
          : null;
      if (acceptIsLoanSale && !saleReviewed) {
        throw new Error(copy.match.termsChanged);
      }
      if (saleReviewed) {
        // The review's seller-funding/maturity/status gates ran on a
        // CACHED read — the seller can revoke or spend their standing
        // approval (or the loan can move) inside the refetch window,
        // and `completeLoanSale` pulls from the seller's wallet DURING
        // this accept. Re-run the same reader fresh so a doomed buy
        // fails here, before any signature or buyer approval can mine.
        const fresh = await readSaleReviewLive(
          publicClient,
          walletChain.diamondAddress,
          selected,
          linkedLoan.data!,
          address,
        );
        if (fresh.kind !== 'sale' || fresh.live.status !== 0) {
          throw new Error(copy.match.saleLoanNotActive);
        }
        if (fresh.matured) {
          throw new Error(copy.match.saleMaturityPassed);
        }
        if (fresh.selfBuyBlocked) {
          throw new Error(copy.match.saleSelfBuy);
        }
        if (!fresh.sellerCovered) {
          throw new Error(copy.match.saleSellerNotCovered);
        }
      }
      // #1036 — re-verify both legs at SUBMIT time (fail closed): the
      // review's verdicts are cached; a flag can land inside their
      // window, and a doomed deal must abort before any signature.
      // A live result that DIFFERS from what the reviewed screen
      // disclosed is pushed into the query cache before aborting, so
      // the re-review renders the new finding (and the fingerprint
      // effect voids the stale consent) — the abort message alone
      // would otherwise be the only place the user ever saw it.
      for (const [leg, addr, isErc20] of [
        ['loan asset', selected.lendingAsset, selected.assetType === AssetType.ERC20],
        [
          'collateral',
          selected.collateralAsset,
          selected.collateralAssetType === AssetType.ERC20,
        ],
      ] as const) {
        if (!isErc20) continue;
        if (isCuratedAsset(walletChain.chainId, addr)) continue; // pre-vetted
        const v = await fetchTokenSecurity(walletChain.chainId, addr);
        const cacheKey = [
          'tokenSecurity',
          readChain.chainId,
          addr.toLowerCase(),
        ];
        if (v.kind === 'block') {
          queryClient.setQueryData(cacheKey, v);
          throw new Error(copy.tokenSecurity.gateBlock(leg, v.reasons));
        }
        if (v.kind === 'unknown') {
          // RESET (not invalidate): reset drops `data` to undefined
          // immediately, closing the gate the moment the submit lock
          // clears — invalidate keeps the stale verdict readable
          // while the forced refetch is in flight. A persistent
          // outage then errors into the blocked banner + "Check
          // again".
          void queryClient.resetQueries({ queryKey: cacheKey });
          throw new Error(copy.tokenSecurity.gateUnknown(leg));
        }
        // A live 'warn' may pass ONLY if the reviewed screen already
        // disclosed this exact warning (same reasons) and consent was
        // given against it. A warn that landed after review — or
        // whose content changed — was never consented to: abort,
        // surface it, re-collect consent.
        if (v.kind === 'warn') {
          const reviewed = securityLegs.find((l) => l.leg === leg);
          if (verdictFingerprint(v) !== verdictFingerprint(reviewed?.verdict)) {
            queryClient.setQueryData(cacheKey, v);
            // Synchronous consent clear — the fingerprint effect only
            // fires next render; a fast retry inside that window would
            // find the cached warn equal to the reviewed one and pass
            // un-consented.
            setForm((f) =>
              f.riskAndTermsConsent ? { ...f, riskAndTermsConsent: false } : f,
            );
            throw new Error(copy.tokenSecurity.gateChanged(leg));
          }
        }
      }
      stepper.next('sign');
      signed = await signAcceptTerms({
        offerId: BigInt(selected.offerId),
        consent: form.riskAndTermsConsent,
        expected: {
          lendingAsset: selected.lendingAsset,
          collateralAsset: selected.collateralAsset,
          amount: saleReviewed ? saleReviewed.principal : offerPrincipal(selected),
          interestRateBps: BigInt(offerRateBps(selected)),
          collateralAmount: saleReviewed
            ? saleReviewed.collateralAmount
            : BigInt(selected.collateralAmount),
          durationDays: saleReviewed
            ? Number(saleReviewed.durationDays)
            : selected.durationDays,
          // The interest MODE the reviewed consent line described — a
          // stale indexer flag must abort before the wallet prompt
          // like any other reviewed term.
          useFullTermInterest: selected.useFullTermInterest,
          // What the review actually SHOWED (indexer flags ∪ live
          // read). If a leg flips illiquid between review and sign,
          // the signer aborts and the re-review — live-driven — now
          // renders the warning, so consent can be re-given against it.
          illiquidWarned: reviewIsIlliquid,
        },
      });
    } catch (err) {
      if (err instanceof Error && err.message === copy.match.termsChanged) {
        void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
        void queryClient.invalidateQueries({ queryKey: ['offer'] });
        // A sale-linked abort usually means the LINKED LOAN moved
        // (partial repay, collateral change) — the loan-derived
        // receipt and consent fingerprint must re-read immediately,
        // not on the next interval, or a retry repeats the same abort
        // against the same stale review.
        void queryClient.invalidateQueries({ queryKey: ['offerSaleReview'] });
        void queryClient.invalidateQueries({ queryKey: ['offerLinkedLoan'] });
      }
      throw err;
    }
    const { terms, signature } = signed;
    const acceptorPaysCollateral = side === 'borrower';
    const paysErc20 = acceptorPaysCollateral
      ? terms.collateralAssetType === AssetType.ERC20
      : terms.assetType === AssetType.ERC20;
    if (paysErc20) {
      const payToken = acceptorPaysCollateral
        ? terms.collateralAsset
        : terms.lendingAsset;
      const payAmount = acceptorPaysCollateral
        ? terms.collateralAmount
        : terms.amount;
      // acceptOffer enforces requireAssetNotPaused on both legs, and
      // approve() succeeds regardless of balance — re-check all three
      // live, in ONE round-trip, before the approval can mine.
      await Promise.all([
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: terms.lendingAsset,
        }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: terms.collateralAsset,
        }),
        assertErc20BalanceLive({
          publicClient,
          token: payToken,
          owner: address,
          amount: payAmount,
          symbol: acceptorPaysCollateral
            ? selectedCollateralMeta.data?.symbol
            : lendingMeta.data?.symbol,
        }),
      ]);
      await ensureAllowance({
        publicClient,
        walletClient,
        token: payToken,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: payAmount,
        onPrompt: () => stepper.next('approve'),
      });
    }
    stepper.next('send');
    const { hash } = await write('acceptOffer', [
      BigInt(selected.offerId),
      terms,
      signature,
    ]);
    return hash;
  }

  async function submit() {
    // #1028 — kill switch backstop: canSign already holds the button,
    // but the switch must also stop a submission entered through any
    // other path.
    if (killed) {
      setSubmitError(copy.killSwitch.disabled);
      return;
    }
    // Re-entrancy lock BEFORE any await: `submitting` derives from
    // state, and state set inside this call isn't visible to a second
    // click landing in the same tick — while the ref is. Without it, a
    // slow allowance read leaves a window where a double-click starts
    // two concurrent submissions (two create-offer transactions with a
    // pre-existing allowance).
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    // Busy immediately (total not yet known — current 0 renders the
    // plain waiting label); the real plan replaces this below.
    setProgress({
      kind: mode === 'accept' ? 'sign' : 'approve',
      current: 0,
      total: 0,
    });
    setSubmitError(null);
    // Runtime plan mirrors the review roadmap: read the allowance NOW
    // (it may have changed since the roadmap rendered) so the step
    // numbers the user watches match the prompts that actually fire.
    let total = 1; // the final transaction
    if (mode === 'accept') total += 1; // the terms signature
    if (planLeg?.token && publicClient && address && walletChain) {
      const cur = await readAllowance({
        publicClient,
        token: planLeg.token,
        owner: address,
        spender: walletChain.diamondAddress,
      });
      total += plannedApprovePrompts(cur, planLeg.amount);
    }
    const stepper = makeStepper(total, setProgress);
    setProgress({ kind: mode === 'accept' ? 'sign' : 'approve', current: 0, total });
    // (progress already non-null from the immediate set above — this
    // just fills in the now-known total for the phase labels.)
    try {
      const wasSale =
        mode === 'accept' && acceptIsLoanSale && saleData?.kind === 'sale'
          ? saleData.loanId
          : null;
      const hash =
        mode === 'accept' ? await submitAccept(stepper) : await submitPost(stepper);
      setTxHash(hash);
      setDoneWasSaleBuy(wasSale);
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
    } catch (err) {
      setSubmitError(submitErrorText(err));
      // The approval may have MINED before the final prompt was
      // rejected — the review re-renders with the allowance changed,
      // so the roadmap must re-read it or it keeps promising an
      // approve step the runtime plan will skip.
      void planAllowance.refetch();
    } finally {
      submitLockRef.current = false;
      setProgress(null);
    }
  }

  // ---- Render ----------------------------------------------------
  // A sale buy did NOT open a fresh loan — the generic accept success
  // ("Loan opened" / funds-lent wording) would misstate what happened.
  const doneTitle =
    mode === 'accept'
      ? doneWasSaleBuy !== null
        ? copy.match.saleBought
        : copy.match.loanOpened
      : text.doneTitle;
  const doneBody =
    mode === 'accept'
      ? doneWasSaleBuy !== null
        ? copy.match.saleBuyerNext(doneWasSaleBuy)
        : text.acceptDoneBody
      : text.doneBody;

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
              {durationOptions.map((d) => (
                <option key={d} value={String(d)}>
                  {formatDurationDays(d)}
                </option>
              ))}
            </select>
            {!durationValid ? (
              <span className="field-hint">
                The protocol currently caps offers at{' '}
                {formatDurationDays(fees.maxOfferDurationDays)} — pick a shorter
                duration.
              </span>
            ) : null}
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
            ) : (
              <>
                {/* Rendered for EMPTY and NON-EMPTY lists alike (it
                    self-gates on cursor staleness): a stale snapshot
                    with a few old matches is just as misleading as a
                    stale empty one — better offers may be missing. */}
                <MarketFreshnessNote />
                {matches.length === 0 ? (
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
                            // A DIFFERENT deal needs a fresh acknowledgement
                            // — never carry consent across selections.
                            set({ riskAndTermsConsent: false });
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
          {selfCollateral ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: -8 }}>
              The collateral must be a different asset than the one being
              borrowed — the protocol rejects same-asset offers.
            </p>
          ) : null}
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
                  onChange={(e) =>
                    // Disclosure-driving term — changing it voids any
                    // consent already given (ProjectDetailsREADME §consent).
                    set({ allowsPartialRepay: e.target.checked })
                  }
                />
                Allow the borrower to repay in parts
              </label>
              <label className="cluster" style={{ fontSize: '0.9rem' }}>
                <input
                  type="checkbox"
                  checked={!form.useFullTermInterest}
                  onChange={(e) =>
                    set({ useFullTermInterest: !e.target.checked })
                  }
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
          {reviewIsIlliquid ? (
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">{copy.match.illiquidWarning}</span>
            </div>
          ) : null}
          {acceptIsLoanSale ? (
            // #986 P3 — a SALE link renders the buy-a-running-loan
            // review; each blocked state names itself (a dead Sign
            // button with no reason reads as broken). Offset/unknown
            // links keep the #951 block.
            saleReviewReady ? (
              <div className="banner banner-info">
                <span className="banner-body">
                  {copy.match.saleVehicleBanner(linkedLoan.data ?? '')}
                </span>
              </div>
            ) : saleReview.isError ? (
              <div className="banner banner-warn" role="alert">
                <span className="banner-body">{copy.match.saleLoanCheckFailed}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void saleReview.refetch()}
                >
                  Retry
                </button>
              </div>
            ) : saleData === undefined ? (
              <div className="banner banner-info">
                <span className="banner-body">{copy.match.saleLoanChecking}</span>
              </div>
            ) : saleData.kind !== 'sale' ? (
              <div className="banner banner-warn" role="alert">
                <span className="banner-body">
                  {copy.match.linkedLoanAcceptBlocked(linkedLoan.data ?? '')}
                </span>
              </div>
            ) : saleData.live.status !== 0 ? (
              <div className="banner banner-warn" role="alert">
                <span className="banner-body">{copy.match.saleLoanNotActive}</span>
              </div>
            ) : saleData.matured ? (
              <div className="banner banner-warn" role="alert">
                <span className="banner-body">{copy.match.saleMaturityPassed}</span>
              </div>
            ) : saleData.selfBuyBlocked ? (
              <div className="banner banner-warn" role="alert">
                <span className="banner-body">{copy.match.saleSelfBuy}</span>
              </div>
            ) : (
              <div className="banner banner-warn" role="alert">
                <span className="banner-body">{copy.match.saleSellerNotCovered}</span>
              </div>
            )
          ) : null}
          {mode === 'accept' && !linkedLoanKnown && linkedLoan.isError ? (
            // Same dead-Sign-button rule as the liquidity gate: a
            // blocked check must name itself and offer the retry.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">
                {copy.match.linkedLoanCheckFailed}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void linkedLoan.refetch()}
              >
                Retry
              </button>
            </div>
          ) : null}
          {!liquidityKnown ? (
            legLiquidity.isError ? (
              // A dead Sign button with no reason reads as broken —
              // name the blocked check and offer the retry.
              <div className="banner banner-warn" role="alert">
                <span className="banner-body">
                  {copy.match.liquidityCheckFailed}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void legLiquidity.refetch()}
                >
                  Retry
                </button>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {copy.match.liquidityChecking}
              </p>
            )
          ) : null}
          {!grace.ready ? (
            grace.isError ? (
              // Same dead-Sign-button rule: the blocked check names
              // itself and offers the retry.
              <div className="banner banner-warn" role="alert">
                <span className="banner-body">
                  {copy.match.graceCheckFailed}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => grace.refetch()}
                >
                  Retry
                </button>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {copy.match.graceChecking}
              </p>
            )
          ) : null}
          <div className="card">
            <h3>Before you sign</h3>
            <Checklist items={checks} />
          </div>
          <div className="card">
            {receipt ? <ReviewReceipt data={receipt} /> : <p className="muted">Preparing your review…</p>}
            {receipt ? <SimulationPreview tx={simTx} /> : null}
            {securityBlocked.length > 0 ? (
              <div className="banner banner-danger" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">
                  {securityBlocked
                    .map((l) =>
                      // An errored leg may still carry a STALE prior
                      // verdict in `data` — report "couldn't check",
                      // never the stale text.
                      l.errored || l.verdict === undefined
                        ? copy.tokenSecurity.gateUnknown(l.leg)
                        : copy.tokenSecurity.gateBlock(
                            l.leg,
                            l.verdict.kind === 'block' ? l.verdict.reasons : [],
                          ),
                    )
                    .join(' ')}
                </span>
                {securityBlocked.some((l) => l.errored) ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ marginTop: 8 }}
                    onClick={() => {
                      void acceptLendingSec.refetch();
                      void acceptCollateralSec.refetch();
                    }}
                  >
                    {copy.tokenSecurity.retry}
                  </button>
                ) : null}
              </div>
            ) : securityWarned.length > 0 ? (
              <div className="banner banner-warn" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">
                  {securityWarned
                    .map((l) =>
                      copy.tokenSecurity.gateWarn(
                        l.leg,
                        l.verdict?.kind === 'warn' ? l.verdict.reasons : [],
                      ),
                    )
                    .join(' ')}
                </span>
              </div>
            ) : securityUnsupported.length > 0 ? (
              <div className="banner banner-info" role="note" style={{ marginTop: 16 }}>
                <span className="banner-body">
                  {securityUnsupported
                    .map((l) => copy.tokenSecurity.gateUnsupported(l.leg))
                    .join(' ')}
                </span>
              </div>
            ) : null}
            {killed ? (
              <div className="banner banner-warn" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{copy.killSwitch.disabled}</span>
              </div>
            ) : null}
            {planTotal !== null ? (
              // #1037 — the roadmap: every wallet prompt named before
              // the first one fires, so a second or third prompt never
              // reads as something going wrong.
              <div className="banner banner-info" role="note" style={{ marginTop: 16 }}>
                <span className="banner-body">
                  {planKnown
                    ? copy.signing.intro(planTotal)
                    : copy.signing.introUpTo(planTotal)}
                  <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
                    {planLeg?.needsSign ? <li>{copy.signing.sign}</li> : null}
                    {!planKnown ? (
                      <li>{copy.signing.approveUnknown}</li>
                    ) : planApprove === 2 ? (
                      <li>{copy.signing.approveReset}</li>
                    ) : planApprove === 1 ? (
                      <li>{copy.signing.approve}</li>
                    ) : null}
                    <li>{mode === 'accept' ? copy.signing.accept : copy.signing.post}</li>
                  </ol>
                </span>
              </div>
            ) : null}
            <label
              className="cluster"
              style={{ marginTop: 16, fontSize: '0.9rem', alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={form.riskAndTermsConsent}
                onChange={(e) => {
                  // Stamp WHAT was on screen when consent was given —
                  // canSign requires this to match the live security
                  // fingerprint while a warning is disclosed.
                  if (e.target.checked) {
                    securityConsentFpRef.current = securityFingerprint;
                  }
                  set({ riskAndTermsConsent: e.target.checked });
                }}
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
                {progress !== null
                  ? progress.current === 0
                    ? 'Waiting for wallet…'
                    : progress.kind === 'sign'
                      ? copy.signing.phaseSign(progress.current, progress.total)
                      : progress.kind === 'approve'
                        ? copy.signing.phaseApprove(progress.current, progress.total)
                        : copy.signing.phaseSend(progress.current, progress.total)
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

// ---- #986 P3: sale-review reader --------------------------------------
// ONE definition for everything the buy-a-running-loan review depends
// on — the review query AND the submit-time recheck call this, so the
// blocked-state reasons and the pre-signature guard can never drift.
// Reads the linked loan live, discriminates sale-vs-offset by creator
// (sale vehicles are created by the loan's lender), and preflights the
// SELLER's settlement funding: `completeLoanSale` pulls the seller's
// accrued-interest forfeit from the seller's WALLET during the buyer's
// transaction, and a revoked/spent standing approval fails on-chain as
// an opaque `OfferAcceptFailed`.
type SaleReview =
  | { kind: 'other' }
  | {
      kind: 'sale';
      loanId: string;
      live: LoanLive;
      dueAtSec: number;
      matured: boolean;
      sellerCovered: boolean;
      /** The connected wallet is the loan's CURRENT borrower —
       *  `LoanFacet.initiateLoan` rejects a self-buy (`acceptor ==
       *  ownerOf(borrowerTokenId)`), so signing must be blocked with a
       *  plain reason instead of letting a doomed accept mine. */
      selfBuyBlocked: boolean;
      buyerInterest: bigint;
    };

const ERC20_ALLOWANCE_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

async function readSaleReviewLive(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  diamondAddress: `0x${string}`,
  offer: IndexedOffer,
  loanId: string,
  buyer: `0x${string}` | undefined,
): Promise<SaleReview> {
  const [live, block] = await Promise.all([
    readLoanLive(client, diamondAddress, BigInt(loanId)),
    client.getBlock({ blockTag: 'latest' }),
  ]);
  if (live.lender.toLowerCase() !== offer.creator.toLowerCase()) {
    return { kind: 'other' };
  }
  const saleRateBps = BigInt(offerRateBps(offer));
  const dueAtSec = Number(live.startTime + live.durationDays * 86_400n);
  const matured = block.timestamp >= BigInt(dueAtSec);
  // Same definition the listing flow approved against
  // (`saleSettlementNow`), read from the wallet the pull binds to
  // (the stored lender — consolidated to the NFT holder at listing).
  const requiredNow = saleSettlementNow(live, saleRateBps, block.timestamp);
  const [allowance, balance, currentBorrower] = await Promise.all([
    client.readContract({
      address: live.principalAsset,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [live.lender, diamondAddress],
    }) as Promise<bigint>,
    client.readContract({
      address: live.principalAsset,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'balanceOf',
      args: [live.lender],
    }) as Promise<bigint>,
    // The CURRENT borrower — the self-buy guard on-chain keys on the
    // borrower-NFT holder, not the stored origination borrower. FAIL
    // CLOSED on a read failure: a stored-borrower fallback would
    // under-block a transferred position's current borrower, letting
    // a doomed self-buy reach signing. A throw here surfaces as the
    // review's named check-failed state with a retry (query path) or
    // aborts before any signature/approval (submit path).
    client.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'ownerOf',
      args: [live.borrowerTokenId],
    }) as Promise<`0x${string}`>,
  ]);
  return {
    kind: 'sale',
    loanId,
    live,
    dueAtSec,
    matured,
    // `_acceptOffer` pays the buyer's principal to the seller's WALLET
    // BEFORE `completeLoanSaleInternal` runs, so the settlement pull
    // can spend those just-received proceeds — the seller's PRE-sale
    // balance only needs to cover what the principal doesn't. The
    // allowance can't be topped up mid-transaction, so it must cover
    // the full pull on its own.
    sellerCovered:
      allowance >= requiredNow && balance + live.principal >= requiredNow,
    selfBuyBlocked:
      buyer !== undefined &&
      currentBorrower.toLowerCase() === buyer.toLowerCase(),
    buyerInterest: saleBuyerRemainingInterest(live, saleRateBps, block.timestamp),
  };
}
