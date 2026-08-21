/**
 * Loan detail — the command center for one position. Basic mode
 * answers the five questions at the top (role, state, what's locked,
 * what you can do now, what happens if you do nothing) and offers ONE
 * primary action for the current state:
 *   borrower + active  → Repay (allowance handled inline)
 *   borrower + repaid  → Claim collateral back
 *   lender  + repaid   → Claim principal + interest
 *   lender  + defaulted→ Claim the collateral
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleCheck, LoaderCircle, ShieldPlus, ShieldQuestion } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  parseUnits,
} from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, captureTxError } from '../lib/errors';
import { useLoan } from '../data/hooks';
import { FEE_MODE_FULL, FEE_MODE_HOLD_ONLY, useFeeEntitlement } from '../data/tariff';
import { VPFI_DECIMALS } from '../data/vpfi';
import { isRevert } from '../data/liveLoanRow';
import { useLoanRisk, healthView } from '../data/risk';
import { formatRemaining, useGraceSeconds } from '../data/grace';
import { assertWalletNotSanctionedLive, useSanctionsCheck } from '../data/sanctions';
import {
  assertErc20BalanceLive,
  assertPositionNftHeldLive,
  isAssetIlliquidLive,
  readGraceSecondsLive,
} from '../contracts/preflights';
import {
  LOAN_STATUS_ACTIVE,
  loanEndTimeOf,
  readLoanLive,
  readRepaymentDueLive,
  MIN_SALE_LISTING_SECONDS,
} from '../contracts/loanLive';
import { useActiveChain } from '../chain/useActiveChain';
import { useMode } from '../app/ModeContext';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, useTokenBalance, useTokenMeta } from '../contracts/erc20';
import {
  formatBpsAsPercent,
  formatDate,
  formatDurationDays,
  formatTokenAmount,
  fullTermInterest,
  shortAddress,
} from '../lib/format';
import { flowDisabled } from '../lib/killSwitch';
import { loanStateView, loanStateLabel } from '../lib/loanState';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { type ReceiptData } from '../components/ReviewReceipt';
import { ConfirmReceipt } from '../components/ConfirmReceipt';
import { RefinanceFlow } from '../components/RefinanceFlow';
import { RefinancePendingCard } from '../components/RefinancePendingCard';
import { EarlyRepayOptionsCard } from '../components/EarlyRepayOptionsCard';
import { LenderExitOptionsCard } from '../components/LenderExitOptionsCard';
import { ObligationTransferFlow } from '../components/ObligationTransferFlow';
import { OffsetFlow } from '../components/OffsetFlow';
import { OffsetPendingCard } from '../components/OffsetPendingCard';
import { SaleListingHoldCard } from '../components/SaleListingHoldCard';
import {
  probeSaleHoldLive,
  useSaleListingHold,
} from '../data/saleListingHold';
import { LOCK_PRECLOSE_OFFSET, useOffsetPending } from '../data/offsetPending';
import { EarlyExitFlow } from '../components/EarlyExitFlow';
import { loanSaleListingEnabled, LoanSaleFlow } from '../components/LoanSaleFlow';
import { LoanSalePendingCard } from '../components/LoanSalePendingCard';
import { LoanKeeperCard } from '../components/LoanKeeperCard';
import { LOCK_EARLY_WITHDRAWAL_SALE, useLoanSalePending } from '../data/loanSalePending';
import { useRefinancePending } from '../data/refinancePending';
import { ZERO_ADDRESS } from '../lib/offerSchema';
import {
  AssetType,
  LIVE_STATUS_TO_INDEXED,
  LoanStatus,
} from '../lib/types';
import { tipAware } from '../chain/railHealth';

type Action = 'repay' | 'claim-borrower' | 'claim-lender' | null;
/** The page's inline confirm surfaces — ONE open at a time, so two
 *  review receipts can never invite conflicting signatures at once. */
type ConfirmSurface =
  | 'action'
  | 'collateral'
  | 'partial'
  | 'preclose'
  | 'refinance'
  | 'transfer'
  | 'offset'
  | 'early-exit'
  | 'loan-sale'
  | 'sale-teardown';

export function PositionDetails() {
  const { loanId: loanIdParam } = useParams();
  // Remount the page per loan: React Router reuses the same element
  // when only the :loanId param changes, and this page's latches
  // (claimed, closedThisSession, doneMessage, typed inputs) describe
  // ONE loan — leaking them onto the next would hide the repay button
  // on a different, still-open loan.
  return <PositionDetailsInner key={loanIdParam ?? 'none'} loanIdParam={loanIdParam} />;
}

/** #1355 — user-facing word for a stamped `FeeEntitlementMode`. */
function feeModeWord(mode: number): string {
  if (mode === FEE_MODE_FULL) return copy.tariff.modeFull;
  if (mode === FEE_MODE_HOLD_ONLY) return copy.tariff.modeHold;
  return copy.tariff.modeNone;
}

function PositionDetailsInner({ loanIdParam }: { loanIdParam: string | undefined }) {
  const loanId = Number(loanIdParam);
  const loan = useLoan(Number.isFinite(loanId) ? loanId : undefined);
  // #1355 — the loan's stamped fee-entitlement record (per-party VPFI
  // fee modes + absorbed tariffs). Zero-default for a loan that never
  // touched the tariff path; the display keys off the Full stamps.
  const feeEnt = useFeeEntitlement(Number.isFinite(loanId) ? loanId : undefined);
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();

  const { isAdvanced, setMode } = useMode();
  // #1037 — which prompt the in-flight action is on (null = idle).
  // One shared phase for the page's actions (they share the busy
  // lock already); a status banner narrates approve → submit.
  const [phase, setPhase] = useState<null | 'pending' | 'approving' | 'submitting'>(null);
  const busy = phase !== null;
  // Child action cards (keeper toggles, sale/refinance flows) still
  // speak boolean busy — adapt onto the phase state so the page-level
  // narration banner covers their prompts too (as plain 'waiting').
  const setBusy = (b: boolean) => setPhase(b ? 'pending' : null);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [collateralInput, setCollateralInput] = useState('');
  const [partialInput, setPartialInput] = useState('');
  // A successful claim doesn't change the indexer row's status, so
  // without this latch the button would re-enable and invite a
  // second, reverting claim. PER SIDE: one wallet can hold BOTH
  // position NFTs, and claiming one side must not hide the other
  // side's still-unclaimed action after the role flips.
  const [claimed, setClaimed] = useState({ borrower: false, lender: false });
  // Same indexer lag after a full repay or preclose: the row stays
  // "active" until the indexer catches up, so without this latch the
  // repay button and the close-early card would re-appear and invite
  // a second, reverting submit (LoanNotActive).
  const [closedThisSession, setClosedThisSession] = useState(false);
  // Lender-side sibling of closedThisSession: after a successful
  // position sale the indexer still shows this wallet as lender for
  // a window — the latch lives on the PAGE so an EarlyExitFlow
  // remount (mode toggle) can't resurrect the stale picker.
  const [soldThisSession, setSoldThisSession] = useState(false);
  // Position writes show the six-row receipt BEFORE any wallet prompt.
  // One slot (not one flag per surface) — opening a surface closes any
  // other, so two receipts never invite conflicting signatures.
  const [confirmingSurface, setConfirmingSurface] =
    useState<ConfirmSurface | null>(null);

  // For rentals the "principal" leg is the NFT contract — no ERC-20
  // metadata to read there.
  const loanIsRental =
    loan.data !== null &&
    loan.data !== undefined &&
    loan.data.assetType !== AssetType.ERC20;
  const principalMeta = useTokenMeta(
    loanIsRental ? undefined : loan.data?.lendingAsset,
  );
  // NFT collateral (ERC-721/1155) has no ERC-20 metadata to read.
  const collateralIsNft =
    loan.data !== null &&
    loan.data !== undefined &&
    loan.data.collateralAssetType !== AssetType.ERC20;
  const collateralMeta = useTokenMeta(
    collateralIsNft ? undefined : (loan.data?.collateralAsset ?? undefined),
  );

  // Claim rights and role permissions travel with the POSITION NFTs,
  // not the original addresses — a wallet that bought/received a
  // lender- or borrower-side NFT must see that side's actions. Read
  // the current owners (Diamond is the ERC-721); fall back to the
  // historical addresses when the reads are unavailable.
  const { readChain } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const nftOwners = useQuery({
    queryKey: ['positionOwners', readChain.chainId, loan.data?.loanId],
    enabled: Boolean(loan.data) && Boolean(readClient),
    refetchInterval: tipAware(60_000, Boolean(readChain.wsUrl)),
    queryFn: async () => {
      const row = loan.data!;
      // Tri-state per side: an address (live owner), 'burned' (the
      // token positively no longer exists — its claim was made), or a
      // THROW on transport errors so the query lands in error state.
      // Collapsing burned and unreadable into one null previously let
      // the historical party look actionable on burned positions.
      const ownerOf = async (
        tokenId: string,
      ): Promise<string | 'burned'> => {
        if (!/^[1-9]\d*$/.test(tokenId)) return 'burned';
        try {
          return (await readClient!.readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'ownerOf',
            args: [BigInt(tokenId)],
          })) as string;
        } catch (err) {
          const isRevert =
            err instanceof BaseError &&
            (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
              err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
          if (isRevert) return 'burned';
          throw err;
        }
      };
      const [lenderOwner, borrowerOwner] = await Promise.all([
        ownerOf(row.lenderTokenId),
        ownerOf(row.borrowerTokenId),
      ]);
      return { lenderOwner, borrowerOwner };
    },
  });

  // 'checking' while the owner reads are in flight — actions render
  // only once the role is CONFIRMED, so a transferred position never
  // flashes controls at its previous holder. 'unverified' when the
  // owner reads FAILED: the historical addresses are NOT a safe
  // fallback (full repay is permissionless — a stale "borrower" could
  // spend real tokens closing a position that now belongs to someone
  // else), so a failed read stays non-actionable instead.
  /** Whether this wallet currently holds the LENDER position NFT.
   *
   *  NOT `role === 'lender'` (Codex r13 P2). The resolver below tests
   *  the borrower side first and returns immediately, so a wallet
   *  holding BOTH NFTs — which this file explicitly recognises as
   *  possible — is `borrower` and never reaches the lender branch.
   *  Every lender sale surface was gated on that value, so the whole
   *  feature was invisible to a valid current lender.
   *
   *  Declared BEFORE the queries rather than beside the render gates
   *  (Codex r18 P2). My first fix mounted the chooser and tools from
   *  this predicate while `bannerTerms` and `useLoanSalePending` still
   *  keyed on `role` — so for a dual holder those reads never ran, the
   *  maturity stayed unknown, the sale lock stayed checking, and both
   *  rows sat permanently unavailable with no Advanced switch offered.
   *  A card that renders and can never answer is worse than one that
   *  does not render: the first fix turned an invisible feature into a
   *  visibly broken one.
   *
   *  Still scoped to the LENDER SALE path — `role` also drives claims,
   *  NFT links and a dozen copy branches whose dual-holder behaviour is
   *  pre-existing and belongs to its own change. */
  const isLenderHolder =
    // `isError` DISQUALIFIES the cached owner set, it does not merely
    // rank below it (Codex r24 P2). TanStack retains `nftOwners.data`
    // through a failed refetch, so after the lender NFT moved and the
    // next poll failed, this still named the FORMER holder — and the
    // chooser, the lender-only reads and the Advanced sale forms all
    // stayed mounted for a wallet whose every submission the live
    // ownership preflight can only reject.
    //
    // This is the fourth consumer of the same rule (`loanLive`, the
    // fee entitlement and the sale lock came first), and the one place
    // it decides whether a whole surface exists rather than what one
    // row says. Fail-closed is cheap here: the surfaces reappear on the
    // next successful poll.
    !nftOwners.isError &&
    nftOwners.data?.lenderOwner !== undefined &&
    nftOwners.data.lenderOwner !== 'burned' &&
    address !== undefined &&
    nftOwners.data.lenderOwner.toLowerCase() === address.toLowerCase();

  const role: 'lender' | 'borrower' | 'viewer' | 'checking' | 'unverified' =
    useMemo(() => {
      const row = loan.data;
      if (!row || !address) return 'viewer';
      const me = address.toLowerCase();
      const owners = nftOwners.data;
      if (owners) {
        if (owners.borrowerOwner !== 'burned' && owners.borrowerOwner.toLowerCase() === me) {
          return 'borrower';
        }
        if (owners.lenderOwner !== 'burned' && owners.lenderOwner.toLowerCase() === me) {
          return 'lender';
        }
        // Burned side = that claim was already made; the historical
        // address gets NO actionable role from it.
        return 'viewer';
      }
      if (nftOwners.isError) return 'unverified';
      return 'checking';
    }, [loan.data, address, nftOwners.data, nftOwners.isError]);

  // OBS-2 (#988) — the action gate must not trust a stale indexer row.
  // One cheap live status read reconciles a row that still says
  // "active" after the loan settled/liquidated on-chain; without it, a
  // stalled indexer leaves a live "Repay" button on a terminal loan
  // (doomed write). Enabled only while the ROW looks open — a terminal
  // row only gets more terminal, so nothing to reconcile there. This is
  // deliberately separate from `loanLive` below, which is scoped to
  // advanced-mode strategy cards; the status truth matters in Basic
  // mode too. (Declared BEFORE `risk`/`loanLive` so their enablement
  // can follow the RECONCILED status, not the stale row.)
  // HOISTED so the readiness failure flags can read the SAME
  // expression the query is enabled by (Codex #1858 r4). A flag that
  // restates a query's enablement is a second statement of it, and this
  // PR chain is entirely about what those do.
  const liveStatusEnabled =
    Boolean(readClient) &&
    Boolean(loan.data) &&
    (loan.data?.status === 'active' || loan.data?.status === 'fallback_pending');
  const liveStatus = useQuery({
    queryKey: ['loanLiveStatus', readChain.chainId, loan.data?.loanId],
    enabled: liveStatusEnabled,
    staleTime: 15_000,
    refetchInterval: tipAware(30_000, Boolean(readChain.wsUrl)),
    // Returns the STATUS plus the interest mode: the same single
    // getLoanDetails call answers both, and the early-repay chooser
    // needs the mode in Basic mode too (the loanLive strategy read is
    // advanced-only by design; asserting the full-term default for a
    // pro-rata loan misprices the close-early options — Codex #1500
    // r2). No extra RPC — the read already fetched the whole struct.
    queryFn: async () => {
      const live = await readLoanLive(
        readClient!,
        readChain.diamondAddress,
        loan.data!.loanId,
      );
      return {
        status: live.status,
        useFullTermInterest: live.useFullTermInterest,
        // #1503 PR-H (Codex r1 P2) — the LENDER chooser needs the
        // cadence in Basic mode for exactly the reason the line above
        // needs the interest mode: `loanLive` is advanced-only, so
        // sourcing from it left every Basic-mode lender permanently on
        // "still reading this loan's interest schedule" and never told
        // whether they are paid during the term or only at the end —
        // the card's central disclosure, silently dead in the mode it
        // was built to serve. Same call, same struct, no extra RPC.
        periodicInterestCadence: live.periodicInterestCadence,
        // Third field lifted out of the SAME struct, for the third time
        // and the same reason (Codex r24 P2). `readLoanLive` returns
        // `lenderForfeitFrom === undefined` when the optional seller-
        // window call fails softly — on an unrefreshed deployment, say
        // — and neither sale tool can quote a price without it.
        //
        // The advanced-only `loanLive` already carried that verdict
        // into the readiness chain. Basic mode read the identical
        // struct and threw the field away, so a Basic-mode lender was
        // shown both rows as available AND offered the Advanced switch,
        // and only after taking it did the rows turn to "failed". The
        // switch was an invitation to discover a dead end.
        sellerWindowReadable: live.lenderForfeitFrom !== undefined,
      };
    },
  });

  // Effectively OPEN for the live-read enablements: a stale
  // `fallback_pending` row whose live status already CURED back to
  // Active must light up the same live reads an `active` row gets —
  // otherwise the health/strategy cards sit on "Checking…" and the
  // close/refinance/exit actions stay hidden until the indexer
  // catches up (#982 round-5).
  const effectivelyActive =
    loan.data?.status === 'active' ||
    (loan.data?.status === 'fallback_pending' &&
      liveStatus.data?.status === LoanStatus.Active);

  // HF/LTV apply only to active, priced (ERC-20) loans; the hook maps
  // the illiquid-leg revert to `priced: false`.
  const risk = useLoanRisk(
    loan.data?.loanId,
    Boolean(loan.data && effectivelyActive && !loanIsRental),
  );

  // Sanctions: addCollateral and both claim paths screen msg.sender on
  // chain — gate them BEFORE the approval/click so a flagged wallet
  // never pays gas for a doomed tx. Repay/close stays open (Tier-2
  // wind-down is deliberately unscreened).
  const sanctions = useSanctionsCheck();
  const sanctionsClear = sanctions.ready && !sanctions.flagged;

  // Page-owned pending-refinance state — deliberately independent of
  // the strategy cards' mount gates. A live request interlocks the
  // repay-family surfaces (a changed principal or a settled loan
  // strands the frozen-amount request) and keeps its own card below.
  const refi = useRefinancePending(
    loanId,
    loanIsRental || !loan.data
      ? undefined
      : (loan.data.lendingAsset as `0x${string}`),
  );
  const refinancePending = refi.offerId !== null;
  // The partial/preclose interlocks exist to protect an ACCEPTABLE
  // request from being stranded by a changed principal or a settled
  // loan. An EXPIRED request can't be accepted by anyone, so it stops
  // blocking — and neither can one whose loan is strictly past its
  // grace window (the #1189 admission gate rejects the accept).
  // While verification is still loading, keep blocking — the
  // conservative side.
  const refinanceBlocking =
    refinancePending &&
    refi.state?.expired !== true &&
    refi.state?.pastGrace !== true;

  // Lender-side sibling: a live Option-2 sale listing. Existence is
  // the CHAIN's say-so (positionLock on the lender NFT), so a listing
  // made on another device still shows and interlocks here.
  const sale = useLoanSalePending(
    loanId,
    loan.data?.lenderTokenId,
    loanIsRental || !loan.data
      ? undefined
      : (loan.data.lendingAsset as `0x${string}`),
    // Lender-side viewers only (the hook also self-enables on a
    // device marker) — borrowers/spectators must not pay the polling
    // cost for a watch their wallet can't answer.
    // `isLenderHolder`, not `role` — a dual-position holder must get
    // this read or the sale-lock verdict never resolves (Codex r18 P2).
    !loanIsRental && Boolean(loan.data) && isLenderHolder,
  );
  /** A listing that SUPPRESSES another surface must be verified.
   *
   *  One principle, because the three consumers of `listed` differ in
   *  which direction an error hurts (Codex r15 P2):
   *
   *    - This one HIDES the instant-exit tool. A retained `listed:
   *      true` from a failed refetch therefore removes a working exit
   *      from a lender whose position another device already unlocked,
   *      so it must be health-checked — and is, here.
   *    - The chooser's rows are blocked the same way, and already
   *      fall back to `'checking'`.
   *    - The pending card BELOW only ever adds a surface, and the
   *      surface it adds is the cancel button. Hiding it on a failed
   *      poll would strip the lender's only way to unwind a listing
   *      that may well still be live — and the borrower stays frozen
   *      meanwhile. It stays mounted deliberately.
   *
   *  So: a stale listing may still SHOW something, never SUPPRESS
   *  something. Deriving all three from one boolean would have to pick
   *  one of those, and either choice is wrong for the other case. */
  const salePending = sale.state?.listed === true && !sale.isError;

  // Borrower-side view of the SAME lender-sale listing (#1503 PR-A
  // follow-up): the teardown probe classifies whether a listing holds
  // this loan's preclose/collateral-withdrawal options ('live'), can
  // be freed right now ('clearable'), or isn't there ('none').
  // Borrower viewers only — the lender has their own pending card.
  // Gated to OPEN loans (Codex #1511 r1 P2): on a terminal loan the
  // teardown also succeeds (the seller-hygiene branch), but there are
  // no borrower options left to free and no cooldown is stamped —
  // that cleanup is the SELLER's story (#1506), not this card's.
  // Contract-mirroring sale-eligibility (Codex #1511 r7):
  // createLoanSaleOffer requires ERC-20 principal AND ERC-20
  // collateral (SaleOfferCollateralMustBeERC20) — a loan outside that
  // shape can never carry a listing, so it must not pay the probes or
  // ever fail closed on them.
  const saleEligible = !loanIsRental && !collateralIsNft;
  const saleHold = useSaleListingHold(
    loanId,
    loan.data?.lenderTokenId ?? '',
    // `effectivelyActive`, not the raw indexed status (Codex #1511 r2):
    // a cured fallback_pending row gets its borrower actions back from
    // the live reconciliation before the indexer catches up — the hold
    // notice and cleanup must come back with them. An UNCURED
    // fallback_pending loan stays probed too (Codex #1511 r11): its
    // full-repay CURE surface still renders, and an accepted sale must
    // pause that cure with the explanation up front rather than let
    // the live pre-write gate block it as a surprise.
    Boolean(loan.data) &&
      saleEligible &&
      role === 'borrower' &&
      (effectivelyActive || loan.data?.status === 'fallback_pending'),
  );
  // Durable success flag — keeps the card (and its confirmation)
  // mounted after the post-teardown refetch flips the probe to
  // 'none' (Codex #1511 r1 P2). (`saleListingHeld` itself is derived
  // below, after the reconciled `row` exists.)
  const [saleHoldCleared, setSaleHoldCleared] = useState(false);
  // …and un-latched the moment a NEW listing appears (Codex #1511 r2):
  // a lender relist after the cooldown must show the fresh hold, not
  // a stale "freed" confirmation. Reset ONLY on 'live' — a relist
  // always starts live (bounded ≥ 1 h; the registered rails observe it
  // well inside that), whereas 'clearable' also occurs in the moment
  // between our own teardown and its refetch, where resetting would
  // unmount the confirmation it exists to preserve.
  const [saleHoldDrained, setSaleHoldDrained] = useState(false);
  // Render-phase ADJUSTMENT, not an effect (#1520; Codex #1683 r1). The latch
  // is history-dependent — `saleHoldDrained` records that a 'none' probe has
  // been observed SINCE the latch was set, which no function of the current
  // `saleHold.data` can reconstruct — but needing the STATE never justified
  // writing it from an effect. The same transitions run here, with the 'none'
  // branch guarded by `!saleHoldDrained` so it settles instead of looping, and
  // React re-renders before painting rather than committing a frame that still
  // shows the superseded confirmation.
  if (saleHoldCleared) {
    // 'none' marks the old lifecycle fully drained (our teardown's
    // refetch landed). After that, ANY later listing state — 'live',
    // or 'clearable' when a suspended tab slept through the whole
    // live phase (Codex #1511 r6) — is a NEW lifecycle and unlatches
    // the confirmation. Before the drain, 'clearable' is still our
    // own pre-refetch teardown state and must NOT reset.
    if (saleHold.data === 'none') {
      if (!saleHoldDrained) setSaleHoldDrained(true);
    } else if (
      saleHold.data === 'live' ||
      // 'accepted' resets regardless of the drain marker (Codex #1511
      // r10): our own teardown can never produce it, so it always
      // signals a NEW lifecycle — and its warning must outrank the
      // old confirmation.
      saleHold.data === 'accepted' ||
      (saleHold.data === 'clearable' && saleHoldDrained)
    ) {
      setSaleHoldCleared(false);
      setSaleHoldDrained(false);
    }
  } else if (saleHoldDrained) {
    setSaleHoldDrained(false);
  }
  // A chain switch keeps this component mounted (its key is the loan
  // id), so the latch must not carry one chain's success onto another
  // chain's loan N (Codex #1511 r7). The ref lets in-flight async
  // continuations (the onCleared verification below) detect that the
  // chain moved under them and discard their result instead of
  // re-latching the freshly reset state (Codex #1511 r11).
  const saleHoldChainRef = useRef(readChain.chainId);
  // The resets run as a render-phase ADJUSTMENT so no frame is committed
  // carrying the previous chain's confirmation (#1520; Codex #1683 r1).
  const [saleHoldChain, setSaleHoldChain] = useState(readChain.chainId);
  if (saleHoldChain !== readChain.chainId) {
    setSaleHoldChain(readChain.chainId);
    setSaleHoldCleared(false);
    setSaleHoldDrained(false);
    // The open REVIEW is chain-scoped too. Leaving the slot set would
    // let the card remount on the destination chain with its
    // confirmation already open — one click from sending a cleanup the
    // borrower never opened a review for, against a different chain's
    // listing. Only this surface's slot is cleared; other flows own
    // their own reset.
    setConfirmingSurface((sfc) => (sfc === 'sale-teardown' ? null : sfc));
  }
  // The ref advances in a LAYOUT effect, not a passive one (Codex #1683 r1).
  // I had argued the guard and the state it protects must move together, so
  // both had to stay post-commit; a layout effect dissolves that trade. It
  // runs synchronously during the commit, before an outstanding continuation
  // can resume, so the guard is never stale while the reset above is already
  // applied — and a continuation resolving BEFORE the commit restarts the
  // chain-change render, which reapplies the reset. Neither ordering leaves
  // the wrong-chain relatch window open.
  useLayoutEffect(() => {
    saleHoldChainRef.current = readChain.chainId;
  }, [readChain.chainId]);

  // The LIVE re-check every settlement write runs immediately before
  // sending (Codex #1511 r5 P1): the cached state can be a tip
  // interval old, and an acceptance landing inside that window must
  // not slip through. Fail closed on RPC failure.
  //
  // Declared HERE, in the hooks region, and NOT down with the derived
  // flags it reads alongside: everything below the loading/not-found
  // early returns is conditional, so a hook there is skipped on the
  // loading render and called on the next one — "Rendered more hooks
  // than during the previous render", on every page load. It needs
  // nothing from the reconciled row, so it belongs up here.
  const assertSaleSettlementSafe = useCallback(async (): Promise<
    string | null
  > => {
    // A loan that can never be listed (non-ERC-20 principal or
    // collateral) has nothing to probe (Codex #1511 r7).
    if (!saleEligible) return null;
    if (!publicClient || !walletChain || !loan.data) {
      return copy.saleHold.checkFailed;
    }
    try {
      const state = await probeSaleHoldLive(
        publicClient,
        walletChain.diamondAddress,
        loanId,
        loan.data.lenderTokenId,
        address ?? undefined,
      );
      if (state === 'accepted') {
        // Block ONLY while the loan is genuinely Active. A sale
        // completion reverts LoanNotActive on anything else, so on a
        // non-Active loan there is no completion left to strand — and
        // blocking would trap the borrower permanently, since nothing
        // they can reach from a blocked UI returns the loan to Active.
        // Read live rather than trusting the reconciled row: this gate
        // exists precisely because cached state can be stale.
        const live = await readLoanLive(
          publicClient,
          walletChain.diamondAddress,
          loanId,
        );
        return Number(live.status) === LOAN_STATUS_ACTIVE
          ? copy.saleHold.completionPaused
          : null;
      }
      // An unrecognized decoded revert is as unanswered as an RPC
      // failure (Codex #1511 r8) — the hook fails closed on it, and
      // the write gate must match.
      if (state === 'unknown') return copy.saleHold.checkFailed;
      return null;
    } catch {
      return copy.saleHold.checkFailed;
    }
  }, [saleEligible, publicClient, walletChain, loan.data, loanId, address]);

  // Live-offset state (preclose Option 3) — chain-authoritative
  // (PrecloseOffset lock on the borrower NFT), page-owned like the
  // refinance marker: a live offset interlocks the repay-family
  // surfaces (a settlement through any other path strands the linked
  // offer) and keeps its own standing card below.
  const offsetPend = useOffsetPending(
    loanId,
    loan.data?.borrowerTokenId,
    loanIsRental || !loan.data
      ? undefined
      : (loan.data.lendingAsset as `0x${string}`),
    // Enabled for the borrower-side holder REGARDLESS of the indexed
    // loan status (Codex #1500 r4 P1). A funded offset offer stays
    // locked and cancellable after the loan settles some other way,
    // and the terminal-row case is exactly when the cancel-to-unwind
    // card matters most — gating on an open row hid it (and never
    // recorded `loanActive` at all) right after a full repay, leaving
    // the escrow stranded with no surface to release it.
    Boolean(loan.data) && !loanIsRental && role === 'borrower',
  );
  // The listing ended off-page (a buyer accepted, or it was cancelled
  // elsewhere) — surface the outcome once via the page banner.
  // Consumed as a render-phase adjustment (#1520; Codex #1683 r1). I had
  // claimed this would mutate an external store during render — wrong:
  // `endedNotice` is `useState` inside a hook called by this component, so it
  // is the same fiber. Clearing it makes the condition false on the immediate
  // re-render while `doneMessage` keeps the banner up, and the hook has
  // already cleared its marker before the notice is observed, so an ordinary
  // refetch cannot recreate it.
  if (sale.endedNotice) {
    setDoneMessage(copy.loanSale.ended);
    sale.clearEndedNotice();
  }

  // Live loan snapshot — interest MODE and the re-stampable accrual
  // clock live only on-chain (the indexer row lacks them). The quoted
  // preclose figure is the contract's OWN settlement math
  // (`calculateRepaymentAmount` routes through the same
  // settlementInterestNet as `computePreclose`: full-term floor,
  // interest already settled by partials, chain time) — never a
  // hand-derived formula that can drift from what is pulled.
  // `chainNow` rides along so time gates never trust the local clock.
  // Only the advanced strategy cards consume this (borrower:
  // close-early/refinance; lender: early exit) — don't burn three
  // RPC reads a minute for viewers or basic mode. Hoisted for the same
  // reason as `liveStatusEnabled` above.
  const loanLiveEnabled =
    Boolean(readClient) &&
    Boolean(loan.data) &&
    effectivelyActive &&
    !loanIsRental &&
    isAdvanced &&
    (role === 'borrower' || role === 'lender');
  const loanLive = useQuery({
    queryKey: ['loanLive', readChain.chainId, loan.data?.loanId],
    enabled: loanLiveEnabled,
    staleTime: 30_000,
    refetchInterval: tipAware(60_000, Boolean(readChain.wsUrl)),
    queryFn: async () => {
      const [live, calcDue, latestBlock, saleLock] = await Promise.all([
        readLoanLive(readClient!, readChain.diamondAddress, loan.data!.loanId),
        readRepaymentDueLive(
          readClient!,
          readChain.diamondAddress,
          loan.data!.loanId,
        ),
        readClient!.getBlock({ blockTag: 'latest' }),
        // The lender NFT's position lock — a live sale listing
        // (EarlyWithdrawalSale) freezes the listing's economics at the
        // CURRENT principal, so the borrower's partial-repay surface
        // must know about it too, not just the lender's exit block.
        // null = unknown (read failed) — the submit-time gate is the
        // authoritative check; this render copy is best-effort.
        (readClient!
          .readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'positionLock',
            args: [BigInt(loan.data!.lenderTokenId)],
          })
          .then((v) => Number(v))
          .catch(() => null)) as Promise<number | null>,
      ]);
      return { live, calcDue, chainNow: latestBlock.timestamp, saleLock };
    },
  });

  // Balance gates: approve() succeeds regardless of balance, so check
  // the wallet actually holds the typed amount before any approval.
  const collateralBalance = useTokenBalance(
    loanIsRental || collateralIsNft ? undefined : loan.data?.collateralAsset,
  );
  const principalBalance = useTokenBalance(
    loanIsRental ? undefined : loan.data?.lendingAsset,
  );
  const collateralInputWei = useMemo(() => {
    if (!collateralMeta.data || !isPositiveDecimal(collateralInput)) return null;
    try {
      const wei = parseUnits(collateralInput, collateralMeta.data.decimals);
      // A positive decimal below the token's precision parses to 0 wei
      // — the contract rejects zero amounts, so treat it as invalid.
      return wei > 0n ? wei : null;
    } catch {
      return null;
    }
  }, [collateralInput, collateralMeta.data]);
  const partialInputWei = useMemo(() => {
    if (!principalMeta.data || !isPositiveDecimal(partialInput)) return null;
    try {
      const wei = parseUnits(partialInput, principalMeta.data.decimals);
      return wei > 0n ? wei : null;
    } catch {
      return null;
    }
  }, [partialInput, principalMeta.data]);
  // Minute tick so a countdown left on screen stays honest.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);
  // UX-004 (Codex #1166 r1) — term fields for any TIME GATE must come
  // from the chain, not the indexer row: a keeper extend/transfer
  // re-stamps startTime/durationDays on-chain while the row lags, and
  // a stale row would tell a borrower grace expired while repayment is
  // still valid. `loanLive` above is advanced-mode-only by design (RPC
  // diet), so this is a separate single read enabled exactly when the
  // ROW looks past due — the only state that renders the banner.
  // The candidate gate fires an HOUR before the local-clock due
  // boundary (Codex #1166 r3): the local clock only decides when to
  // START the chain-time read — chain time then decides whether the
  // banner shows. A device clock slow by less than the margin can no
  // longer delay the warning; skews beyond an hour break TLS long
  // before they break us.
  const rowPastDueCandidate = Boolean(
    loan.data &&
      (loan.data.status === 'active' || loan.data.status === 'fallback_pending') &&
      loan.data.assetType === AssetType.ERC20 &&
      loan.data.startTime + loan.data.durationDays * 86400 < nowSec + 3600,
  );
  // #1503 PR-H (Codex r2 P2) — a LENDER viewing an active position needs
  // the live terms whether or not the INDEXED row looks close to due,
  // because that row can be wrong in the one direction that matters
  // here. `PrecloseFacet.transferObligationViaOffer` permits a SHORTER
  // replacement maturity and rewrites `durationDays`/`startTime`
  // (PrecloseFacet.sol:753-755, 1164-1166); until the indexer catches
  // up, `rowPastDueCandidate` is computed from the older, later term
  // and stays false. The exit chooser would then read "not past due"
  // from a read that never ran, and advertise two sales the contracts
  // refuse on a position that has actually matured.
  //
  // Scoped to lender viewers of open ERC-20 positions rather than made
  // unconditional: that is exactly the population the chooser serves,
  // and it keeps the extra poll off every other viewer of every other
  // position.
  //
  // KNOWN SIDE EFFECT, stated rather than left to be discovered: every
  // other consumer of `bannerTerms` now has data for these viewers
  // where it previously had none, so for a LENDER (only — borrowers are
  // excluded by the role clause) `termsStartSec` / `termsDurationDays`
  // switch from the indexer row to LIVE terms, `bannerNowSec` switches
  // from the raw device clock to the chain-anchored one, and
  // `liveSaysFallbackPending` / `showGraceBanner` become computable
  // instead of constant. Each of those moves in the same direction as
  // this fix — chain truth over indexed truth — so the grace banner
  // gets MORE accurate for lenders, not differently wrong. Flagged
  // because it is a behaviour change on a surface this PR does not
  // otherwise touch.
  const lenderNeedsLiveTerms = Boolean(
    loan.data &&
      // Same reason as the sale-lock read above (Codex r18 P2).
      isLenderHolder &&
      !loanIsRental &&
      (loan.data.status === 'active' ||
        loan.data.status === 'fallback_pending') &&
      loan.data.assetType === AssetType.ERC20,
  );
  // Hoisted for the same reason as `liveStatusEnabled` above.
  const bannerTermsEnabled =
    Boolean(readClient) && (rowPastDueCandidate || lenderNeedsLiveTerms);
  const bannerTerms = useQuery({
    queryKey: ['graceBannerTerms', readChain.chainId, loan.data?.loanId],
    enabled: bannerTermsEnabled,
    staleTime: 30_000,
    refetchInterval: tipAware(60_000, Boolean(readChain.wsUrl)),
    // chainNow rides along (Codex #1166 r2): the contracts gate on
    // block.timestamp, so the banner must not trust a skewed device
    // clock. fetchedAtLocal lets the countdown advance between
    // refetches without re-introducing the skew.
    queryFn: async () => {
      const [live, latestBlock] = await Promise.all([
        readLoanLive(readClient!, readChain.diamondAddress, loan.data!.loanId),
        readClient!.getBlock({ blockTag: 'latest' }),
      ]);
      return {
        live,
        chainNow: Number(latestBlock.timestamp),
        fetchedAtLocal: Math.floor(Date.now() / 1000),
      };
    },
  });
  // UX-004 — the grace window, read for DISPLAY (previously read only
  // inside submit handlers, so a past-due borrower could never see how
  // long they had). Static protocol config per (chain, duration) —
  // cached long in the hook. Rentals resolve their window elsewhere.
  // Keyed on the LIVE duration whenever ANY live read has it (a keeper
  // extend can land the loan in a different grace bucket): loanLive is
  // the advanced-mode strategy read and refreshes fastest, bannerTerms
  // is the any-mode past-due read; the indexer row is the last resort
  // (Codex #1256 r3 — the #1235 gates combine live term fields with
  // this bucket, so a row-bucketed grace could mis-gate them).
  const grace = useGraceSeconds(
    loan.data && loan.data.assetType === AssetType.ERC20
      ? loanLive.data
        ? Number(loanLive.data.live.durationDays)
        : bannerTerms.data
          ? Number(bannerTerms.data.live.durationDays)
          : loan.data.durationDays
      : undefined,
  );

  const collateralOverBalance =
    collateralInputWei !== null &&
    collateralBalance.data !== undefined &&
    collateralInputWei > collateralBalance.data;
  const partialOverBalance =
    partialInputWei !== null &&
    principalBalance.data !== undefined &&
    partialInputWei > principalBalance.data;

  if (loan.isLoading) {
    return <EmptyState icon={LoaderCircle} title={copy.positions.details.loadingLoan} />;
  }
  if (!loan.data) {
    return (
      <UnavailableState body={copy.positions.details.notFound} />
    );
  }

  // OBS-2 (#988) — reconcile the indexer row against the live chain
  // status ONCE, here, so every consumer below (action gate, state
  // badge, cards, receipts) sees the same truth. Overrides only toward
  // MORE settled — with ONE deliberate exception: a live "active" DOES
  // override a `fallback_pending` row, because that state is
  // REVERSIBLE (a borrower cure returns the loan to Active, after
  // which claimAsLender rejects — the stale row would keep a doomed
  // lender claim button). A live "active" never resurrects actions on
  // a row the indexer already closed (that direction is replica lag,
  // and the claim paths re-check live at submit anyway).
  // Indexed as a plain number map so an unknown FUTURE enum value
  // yields undefined (→ no override) instead of a lying type.
  const liveOverride =
    liveStatus.data === undefined
      ? undefined
      : liveStatus.data.status !== LoanStatus.Active
        ? (
            LIVE_STATUS_TO_INDEXED as Record<
              number,
              (typeof LIVE_STATUS_TO_INDEXED)[LoanStatus] | undefined
            >
          )[liveStatus.data.status]
        : loan.data.status === 'fallback_pending'
          ? ('active' as const)
          : undefined;
  const statusIsReconciled =
    liveOverride !== undefined && liveOverride !== loan.data.status;
  const row = statusIsReconciled
    ? { ...loan.data, status: liveOverride! }
    : loan.data;
  const view = loanStateView(row);
  const isRental = row.assetType !== AssetType.ERC20;
  // Judged on the RECONCILED status (live override folded in): a loan
  // the chain already knows is terminal must not show the hold card
  // even while the indexed row lags (Codex #1511 r1 P2).
  // 'clearable' additionally requires a POSITIVE live Active reading
  // (Codex #1511 r9): with the indexed row stale-active and the live
  // status pending/failed, the teardown also succeeds on a TERMINAL
  // loan (the seller-hygiene branch — no borrower options to free, no
  // cooldown stamped), and the borrower cleanup invite must not
  // render on that ambiguity. 'live' needs no such confirmation — the
  // SaleListingLoanStillLive revert itself proves the loan is live
  // on-chain. 'accepted' stays presented on the indexed row alone:
  // its only effect is a protective pause on flows that would revert
  // on a terminal loan anyway.
  const liveActiveConfirmed =
    liveStatus.data?.status === LoanStatus.Active;
  const saleListingHeld =
    row.status === 'active' &&
    (saleHold.data === 'live' ||
      (saleHold.data === 'clearable' && liveActiveConfirmed) ||
      // Accepted-awaiting-completion keeps `loanToSaleOfferId` set, so
      // the offset path stays refused (Codex #1511 r3).
      saleHold.data === 'accepted');
  // Accepted-awaiting-completion additionally pauses the borrower's
  // SETTLEMENT flows (Codex #1511 r4 P1): the buyer's principal has
  // already moved, and completeLoanSale requires the loan still
  // Active — a repay/close here terminalizes it and permanently
  // strands the recovery completion; a partial changes the principal
  // the buyer funded. UI-level protection (the contract's Tier-2
  // repay stays open by design); the contract-side close-out guard
  // for this window belongs to the #1503 PR-E slice.
  // ACTIVE only — deliberately NOT fallback_pending. Round 11 widened
  // this and the pre-merge review caught the deadlock: a sale
  // completion requires an Active loan (_completeLoanSaleImpl reverts
  // LoanNotActive), an accepted listing can be neither cancelled nor
  // torn down, and nothing the borrower can do from a paused UI
  // returns the loan to Active — while claimAsLender stays open to the
  // counterparty throughout. The pause would be permanent, it would
  // protect a completion that is already unreachable, and it would
  // shut the borrower's last settlement door. The window is real only
  // while the loan is Active; there it genuinely is momentary.
  const saleCompletionPending =
    row.status === 'active' && saleHold.data === 'accepted';
  // The same fact, stated instead of enforced: on a fallback_pending
  // loan the borrower still needs to KNOW an accepted sale is linked
  // (it changes what their choice costs), but must not be blocked by
  // it. Renders as a warning inside the repay review, never a gate.
  const saleAcceptedOnFallback =
    row.status === 'fallback_pending' && saleHold.data === 'accepted';
  // Fail CLOSED while the accepted-sale question is unanswered (Codex
  // #1511 r5 P1): the settlement surfaces wait on the probe rather
  // than opening on its undefined initial state. False on the
  // pre-refresh Diamond (no probe exists there — pre-PR behaviour).
  // Mirrors saleCompletionPending's scope: this flag pauses the same
  // surfaces, so widening it to fallback_pending would reintroduce the
  // deadlock above by a slower route (an unanswerable probe holding
  // the cure shut indefinitely).
  const saleHoldResolving =
    row.status === 'active' && saleHold.resolving === true;
  const principal = principalMeta.data;
  const collateral = collateralMeta.data;
  const interest = fullTermInterest(
    BigInt(row.principal),
    row.interestRateBps,
    row.durationDays,
  );
  // Claimable proper-close group: repaid, or an internal match (which
  // records claim rows for both sides). `settled` is deliberately NOT
  // here — ClaimFacet rejects Settled on BOTH claim paths
  // (InvalidLoanStatus): it means the claims are already consumed, so
  // a settled row gets no action.
  const properClose =
    row.status === 'repaid' || row.status === 'internal_matched';
  // UX-001 — every terminal status: the receipt must stop presenting a
  // live obligation ("Owed") or a live default warning once the loan
  // is over. fallback_pending stays "live" (still being settled).
  const loanOver =
    row.status === 'repaid' ||
    row.status === 'settled' ||
    row.status === 'internal_matched' ||
    row.status === 'defaulted' ||
    row.status === 'liquidated';

  // UX-004 — past-due escalation. Once past due the only signal used
  // to be a small "Past due" badge; now we show the concrete deadline:
  // due date + grace window, counted down live. Term fields prefer the
  // LIVE read (a keeper extend re-stamps them while the row lags); on
  // read failure we fall back to the row rather than hide a warning —
  // the repay submit path re-checks live and is authoritative.
  const termsStartSec = bannerTerms.data
    ? Number(bannerTerms.data.live.startTime)
    : row.startTime;
  const termsDurationDays = bannerTerms.data
    ? Number(bannerTerms.data.live.durationDays)
    : row.durationDays;
  const termsEndSec = termsStartSec + termsDurationDays * 86400;
  // Anchor "now" to CHAIN time when the live read has it (Codex #1166
  // r2): the repay/default gates run on block.timestamp, so a skewed
  // device clock must not flip the banner to "no longer accepts
  // repayment" early — or keep a countdown alive late. The local tick
  // only advances the anchor between refetches.
  const bannerNowSec = bannerTerms.data
    ? bannerTerms.data.chainNow + (nowSec - bannerTerms.data.fetchedAtLocal)
    : nowSec;
  const graceDeadline =
    grace.data !== undefined ? termsEndSec + Number(grace.data) : null;
  const graceRemaining = graceDeadline !== null ? graceDeadline - bannerNowSec : null;
  // Codex #1166 r4 — the LIVE status can be ahead of both the row and
  // the separate liveStatus query: a loan that already entered
  // FallbackPending on-chain is still fully curable by repayment, so
  // neither the "repayment no longer accepted" copy nor the repay
  // suppression may fire for it — the cure banner takes over instead.
  // ONE resolution of "what is this loan's status right now", shared by
  // every gate that asks. Rounds 8, 9, 10 and 11 each found a different
  // gate with its own ad-hoc precedence over these same three reads,
  // written in a different order each time — `maturity` consulted
  // `loanLive` while the terminal gate did not, `fallbackPending`
  // consulted neither. Fixing them one at a time is what produced four
  // rounds of the same finding, so the precedence lives here once and
  // the gates read it.
  //
  // All three reads hit the same chain, so none is more AUTHORITATIVE
  // than another — disagreement between them is staleness, not
  // conflict. What ranks them is scope: `loanLive` is the richest and
  // is refetched with the strategy surfaces, `liveStatus` is the
  // always-on read built for exactly this question, and `bannerTerms`
  // is the banner's own. `loanLive` is advanced-only, so in Basic mode
  // the order simply starts at `liveStatus`.
  //
  // `isError` DISQUALIFIES a source rather than lowering its rank: a
  // failed refetch leaves TanStack holding the previous result, and
  // that cached answer is exactly the one that predates the change the
  // gate needs to see. Ranking it below a healthy source would still
  // let it win whenever the healthy sources are absent.
  //
  // DO NOT harmonise `maturity` (below) onto this order. It reads the
  // same two queries in the OPPOSITE sequence, deliberately, because it
  // asks a different KIND of question: maturity is a comparison against
  // a clock, and only `bannerTerms` carries an anchored one it can
  // advance between polls (`chainNow + elapsed`) — `loanLive.chainNow`
  // is frozen at fetch. Unifying the two orders would silently put a
  // stopped clock in front of a running one, so the past-due boundary
  // would stop arriving until something else refetched. Status has no
  // clock in it, so freshness is the only axis and this order stands.
  // All three arrive decoded off a contract read, so each is a plain
  // number; `LoanStatus` is a numeric enum and every other comparison
  // in this file already relies on that. Cast once here, at the single
  // point the value is resolved, rather than at each reader.
  // Every healthy live answer, in rank order. Rank decides only when
  // they disagree about a NON-terminal status — see below.
  /** Has every status query that WILL run finished running?
   *
   *  A query is settled when it has succeeded, errored, or is disabled
   *  and therefore never going to fetch — TanStack leaves a disabled
   *  query `isPending` with `fetchStatus: 'idle'`, which is why the
   *  third arm is needed and why `isPending` alone cannot be used.
   *
   *  Read ONLY by the chooser's readiness attribute (#1855). Nothing
   *  rendered depends on it, so a wrong answer here cannot change what a
   *  lender sees — only whether an external check believes the card has
   *  finished deciding. */
  const sourceSettled = (q: { isSuccess: boolean; isError: boolean; fetchStatus: string }) =>
    q.isSuccess || q.isError || q.fetchStatus === 'idle';
  const statusSourcesSettled = [loanLive, liveStatus, bannerTerms].every(sourceSettled);
  /** The same question for the MATURITY verdict, over its own sources.
   *
   *  A SEPARATE LIST, not a reuse of the one above (Codex #1858 r3).
   *  `maturity` below reconciles `bannerTerms` and `loanLive` only —
   *  `liveStatus` carries a status enum, not a term — so asking the
   *  status list here would make a past-due page wait on a query that
   *  cannot change the answer. What the two share is the settled
   *  PREDICATE; what differs is which queries the derivation reads, and
   *  each list is written beside the derivation it belongs to.
   *
   *  Needed because `maturity` answers `'unknown'` on DISAGREEMENT. A
   *  `'past'` from the source that landed first is provisional: an
   *  in-grace keeper extension moves the due date forward, so the
   *  second read arriving with a longer term flips the verdict and
   *  would retract a readiness answer already published as settled. */
  const maturitySourcesSettled = [loanLive, bannerTerms].every(sourceSettled);
  /** Did an ENABLED source stop without contributing an answer?
   *
   *  Settled and answered are not the same thing (Codex #1858 r4).
   *  `sourceSettled` counts `isError` as settled, which is right for
   *  "is anything still in flight" and wrong as a basis for publishing
   *  a verdict: an errored query keeps its `refetchInterval`, so a
   *  later poll can succeed and change the answer. A `past` read off
   *  the one source that landed, with the other errored, can become
   *  `unknown` on that recovery; an errored status source can come
   *  back FallbackPending and shut both jumps. Either way a `ready`
   *  already published retracts, with no chain transition behind it —
   *  the same defect as round 3, one level further out.
   *
   *  Gated on the query's OWN enablement const rather than on a
   *  restatement of it: a disabled query that errored while it was
   *  enabled keeps `isError` forever, and reading that flag alone
   *  would report a Basic-mode page as failed over a query it does not
   *  consult. */
  const sourceFailed = (q: { isError: boolean }, enabled: boolean) => enabled && q.isError;
  const maturitySourcesFailed =
    sourceFailed(bannerTerms, bannerTermsEnabled) || sourceFailed(loanLive, loanLiveEnabled);
  const statusSourcesFailed =
    sourceFailed(liveStatus, liveStatusEnabled) || maturitySourcesFailed;

  const liveStatusCandidates: (LoanStatus | undefined)[] = [
    loanLive.data && !loanLive.isError
      ? (loanLive.data.live.status as LoanStatus)
      : undefined,
    liveStatus.data && !liveStatus.isError
      ? (liveStatus.data.status as LoanStatus)
      : undefined,
    bannerTerms.data && !bannerTerms.isError
      ? (bannerTerms.data.live.status as LoanStatus)
      : undefined,
  ];

  /** Whether the optional seller-window call inside `readLoanLive`
   *  answered — `false` when a HEALTHY snapshot carries
   *  `lenderForfeitFrom === undefined`, which is how that call fails
   *  softly (an unrefreshed deployment, say). Neither sale tool can
   *  quote a price without it.
   *
   *  **Derived from all three sources in ONE place, deliberately**
   *  (Codex r25 P2). THREE queries call `readLoanLive` and every one of
   *  them carries this verdict; the readiness chain consulted them one
   *  at a time, and each round of review added the next. r19 wired
   *  `loanLive`, which is advanced-only, so Basic mode never saw it.
   *  r24 added `liveStatus`, which is always-on but disabled once the
   *  loan leaves Active/FallbackPending. r25 found `bannerTerms`,
   *  enabled independently of both, healthy, holding the same answer,
   *  and ignored.
   *
   *  Three rounds, three clauses, one question — which is the shape
   *  this whole card exists to prevent, occurring inside it. So this is
   *  the structural form rather than a fourth clause: the question is
   *  asked once, of every source, and a consumer reads the verdict
   *  instead of re-deriving it. A fourth `readLoanLive` caller changes
   *  this array and nothing else.
   *
   *  `isError` disqualifies each snapshot for the usual reason — a
   *  cached `true` is not evidence the window read works now — and any
   *  healthy source reporting the failure is enough, matching how
   *  `saleAttemptable` treats a non-Active status. */
  const sellerWindowReadable: boolean | undefined = (() => {
    const answers = [
      loanLive.data && !loanLive.isError
        ? loanLive.data.live.lenderForfeitFrom !== undefined
        : undefined,
      liveStatus.data && !liveStatus.isError
        ? liveStatus.data.sellerWindowReadable
        : undefined,
      bannerTerms.data && !bannerTerms.isError
        ? bannerTerms.data.live.lenderForfeitFrom !== undefined
        : undefined,
    ].filter((a): a is boolean => a !== undefined);
    if (answers.length === 0) return undefined;
    // Fail closed on disagreement: one healthy source proving the
    // window cannot be read is enough, because both tools need it and
    // neither retries.
    return answers.every(Boolean);
  })();

  /** The live status, with TERMINAL answers outranking rank itself.
   *
   *  Rank alone was wrong (Codex r13 P2). These queries poll at
   *  different intervals — `liveStatus` every 30s, `loanLive` every
   *  60s — so after a repayment or default the lower-ranked read can
   *  hold the newer answer while the higher-ranked one still serves a
   *  healthy, cached `Active`. Fixed precedence then ignored the
   *  fresher truth for up to a poll, keeping the rows and both sale
   *  tools open on a loan that had already settled.
   *
   *  The fix is not a freshness comparison, which would need
   *  per-query timestamps this page does not track. It is that
   *  terminal statuses are ABSORBING: a loan never returns to Active
   *  from Repaid, Settled, Defaulted or InternalMatched. So a healthy
   *  source reporting one cannot be wrong-because-stale — it can only
   *  be ahead. Any healthy terminal answer therefore wins outright,
   *  and rank decides only among the non-terminal ones, where the
   *  same reasoning does not hold (a FallbackPending CAN cure back). */
  const resolvedLoanStatus: LoanStatus | undefined =
    liveStatusCandidates.find(
      (st) =>
        st !== undefined &&
        st !== LoanStatus.Active &&
        st !== LoanStatus.FallbackPending,
    ) ?? liveStatusCandidates.find((st) => st !== undefined);

  /** `loanLive`'s chain clock, ADVANCED by local elapsed time.
   *
   *  `chainNow` freezes at the poll that fetched it, so every gate
   *  comparing against it raw reads a stopped clock between polls
   *  (Codex r20/r22 P2). I fixed that for the chooser's `maturity`
   *  first and left the two siblings on the frozen value — so the
   *  chooser could block while both Advanced forms stayed mounted, and
   *  the final-hour cutoff could miss its boundary when `bannerTerms`
   *  was unavailable.
   *
   *  Hoisted so there is ONE advanced clock rather than three chances
   *  to forget. Chain-anchored still: the device supplies the elapsed
   *  DELTA only, never an absolute time, and `Math.max(0, …)` keeps a
   *  backwards clock from moving the boundary the wrong way. */
  const loanLiveNowSec: bigint | undefined =
    loanLive.data && !loanLive.isError
      ? loanLive.data.chainNow +
        BigInt(
          Math.max(0, Math.floor(nowSec - loanLive.dataUpdatedAt / 1000)),
        )
      : undefined;

  /** Whether the loan is open enough for a SALE to be attempted.
   *
   *  The indexed row and the live reads can disagree in both
   *  directions, and this exists so the chooser's rows and the tools
   *  those rows jump to never resolve that disagreement differently
   *  (Codex r12 P2). They did: admitting `fallback_pending` to the
   *  chooser while the tool block still demanded an indexed `active`
   *  meant a cured-but-unindexed loan showed both sale rows as
   *  available, offered the Basic-mode switch, and mounted no tools —
   *  jump buttons scrolling to anchors that did not exist. A chooser
   *  whose whole purpose is to stop dead ends had become one.
   *
   *  It is deliberately `effectivelyActive` ITSELF rather than a
   *  richer reconciliation, and that is the second half of the same
   *  lesson (Codex r14 P2). My first attempt resolved the status from
   *  the widest set of live reads, which made the chooser MORE willing
   *  than the tools: `loanLive` — the query the whole strategy block
   *  waits on — is enabled from `effectivelyActive`, so a cure that
   *  only `bannerTerms` had seen offered the Advanced switch and then
   *  parked both rows on "checking" forever behind a query that could
   *  never run. A different dead end reached by the opposite door.
   *
   *  The invariant is not "use the best available answer", it is
   *  "rows and tools must answer the same question the same way". So
   *  this shares the tools' own predicate by construction rather than
   *  by agreement, and cannot drift from it. Where that predicate
   *  cannot see a cure, the honest result is a row that says the sale
   *  is unavailable — not one offered against a tool that cannot
   *  load.
   *
   *  Widening it means widening `effectivelyActive`, which is the
   *  right place: `bannerTerms` is declared AFTER `loanLive`, so
   *  feeding it into that enablement is a hook-reorder on a page where
   *  hook order has already caused a crash (#1521). Not worth it for a
   *  case both other live reads failing already covers. */
  const saleAttemptable =
    effectivelyActive &&
    // ...but a live read that AFFIRMATIVELY says otherwise wins
    // (Codex r13 P2). `effectivelyActive` starts from the indexed row
    // and only ever WIDENS it — a `fallback_pending` row cured to
    // Active. It never narrows, so when the row still says `active`
    // and `loanLive` already reports Repaid, Defaulted or
    // FallbackPending, it stayed true and this mounted both sale forms
    // during the indexer's catch-up window.
    //
    // Round 14 made the rows and the tools agree; it did not make them
    // right, and I reported that as closing the class. Agreement is
    // necessary and not sufficient — two surfaces can agree on a stale
    // answer.
    //
    // Affirmative only: an unread or errored status leaves this alone,
    // because failing closed on a missing answer is the permanent
    // dead end this card has met three times.
    // ANY healthy source that affirmatively reports a non-Active
    // status blocks, not just the top-ranked one (Codex r20 P2).
    //
    // The terminal-precedence fix left FallbackPending resolved by
    // rank alone, on the reasoning that it can cure back to Active so
    // an older one must not override a newer Active. That is right
    // about the RESOLVED STATUS and wrong about SALE AVAILABILITY:
    // both entrypoints require exactly `Active`, so a fresher
    // 30-second read seeing the transition is enough to know a
    // submission would be refused right now, whatever the 60-second
    // read still has cached.
    //
    // Fails CLOSED on purpose, and the asymmetry is the argument: a
    // false block is a row that says unavailable and clears on the
    // next poll, while a false offer is a form filled in for a
    // transaction that reverts. Only affirmative answers count — an
    // unread or errored source still says nothing.
    !liveStatusCandidates.some(
      (st) => st !== undefined && st !== LoanStatus.Active,
    );

  // `isError` disqualifies the snapshot here too (Codex r26 P2). This
  // consumer predates the health-check rule and was missed when the
  // rule was applied to `liveStatusCandidates`, then made REACHABLE by
  // widening `bannerTerms` to lender viewers: a cached FallbackPending
  // that the borrower has since cured, plus a failed refetch, left the
  // urgent cure banner up for a dual holder while the healthy
  // `liveStatus` read said Active.
  //
  // The banner is the most alarming thing this page renders, so a
  // stale one is the worst place for the exception.
  const liveSaysFallbackPending =
    !bannerTerms.isError &&
    bannerTerms.data?.live.status === LoanStatus.FallbackPending;
  // Past-due is decided by CHAIN-anchored time against (preferably
  // live) terms — not by view.state, whose daysRemaining derives from
  // the device clock (Codex #1166 r3). A failed grace read keeps a
  // generic warning instead of silencing the alert (also r3).
  const showGraceBanner =
    row.status === 'active' &&
    !liveSaysFallbackPending &&
    !loanOver &&
    !isRental &&
    !closedThisSession &&
    (graceRemaining !== null || grace.isError) &&
    // Live terms say the loan is genuinely past due (a keeper extend
    // makes this false and the banner honestly disappears)…
    termsEndSec < bannerNowSec &&
    // …and never render from row terms while the live read is still
    // in flight for a past-due candidate.
    !(rowPastDueCandidate && bannerTerms.isLoading);
  // Codex #1166 r3 — once grace is VERIFIABLY over (live-confirmed
  // terms + a successful grace read), the contract rejects ordinary
  // repay (RepaymentPastGracePeriod), so offering the Repay button
  // would only manufacture a doomed submit. Boundary follows the
  // contract's own `>` semantics (repay is still accepted AT
  // graceEnd). fallback_pending cures stay exempt — including when
  // only the LIVE read knows the loan is FallbackPending (r4).
  const graceVerifiablyOver =
    bannerTerms.data !== undefined &&
    !liveSaysFallbackPending &&
    graceRemaining !== null &&
    graceRemaining < 0;
  // Codex #1166 r4 — the definitive "no longer accepts repayment"
  // wording is allowed ONLY with live-confirmed terms; from row-only
  // terms an expired computation downgrades to the unknown-deadline
  // warning (the exact stale-row case the live read exists to avoid).
  const gracePhase: 'unknown' | 'countdown' | 'over' =
    graceRemaining === null
      ? 'unknown'
      : graceRemaining >= 0
        ? 'countdown'
        : bannerTerms.data
          ? 'over'
          : 'unknown';
  // Codex #1166 r2 — fallback_pending is the OTHER post-grace danger
  // state (a failed default settling), and its loanStateView is
  // "Being settled", so the overdue banner above never fires. The
  // borrower can still cure by full repayment until the lender
  // finalizes — say so where the collateral is most at risk.
  const showFallbackCureBanner =
    (row.status === 'fallback_pending' ||
      (row.status === 'active' && liveSaysFallbackPending)) &&
    !isRental &&
    role === 'borrower' &&
    !closedThisSession;
  // Rendered-length string for the "if nothing happens" gloss on any
  // live loan (not just overdue ones).
  const graceLengthStr =
    grace.data !== undefined ? formatRemaining(Number(grace.data)) : undefined;

  const action: Action = (() => {
    // Side-scoped: a claim on one side must not suppress the other.
    if (role === 'borrower' && claimed.borrower) return null;
    if (role === 'lender' && claimed.lender) return null;
    // fallback_pending is CURABLE: the contracts still accept full
    // repayment (and add-collateral) while a failed liquidation waits
    // for retry — never leave the borrower without the cure action.
    if (
      role === 'borrower' &&
      !closedThisSession &&
      (row.status === 'active' || row.status === 'fallback_pending')
    ) {
      // Grace verifiably over on an ACTIVE loan → the contract rejects
      // repay; the banner above explains. The fallback_pending cure is
      // contract-exempt and must keep its action (Codex #1166 r3).
      if (row.status === 'active' && graceVerifiablyOver) return null;
      return 'repay';
    }
    // Claimable proper-close terminals: repaid or internal_matched
    // (ClaimFacet accepts both; the on-chain claimables discovery
    // (#988) surfaces them). For the borrower an internal match may
    // hold only a residual/rebate — the submit path preflights
    // getClaimable so a zero-entitlement claim errors gracefully
    // instead of prompting a doomed write.
    if (role === 'borrower' && properClose) return 'claim-borrower';
    // After a default/liquidation the borrower may still have a
    // residual entitlement (liquidation surplus) — the Claim Center
    // lists these rows, so this page must offer the claim.
    if (
      role === 'borrower' &&
      (row.status === 'defaulted' || row.status === 'liquidated')
    ) {
      return 'claim-borrower';
    }
    if (role === 'lender' && properClose) return 'claim-lender';
    if (role === 'lender' && (row.status === 'defaulted' || row.status === 'liquidated')) {
      return 'claim-lender';
    }
    // fallback_pending is claimable for the LENDER too: claimAsLender
    // runs the claim-time fallback resolution (ClaimFacet accepts
    // FallbackPending), so the lender can finalize instead of waiting
    // on a keeper retry. (The borrower's cure path is handled above.)
    if (role === 'lender' && row.status === 'fallback_pending') {
      return 'claim-lender';
    }
    return null;
  })();

  async function run(kind: Exclude<Action, null>) {
    if (!address || !walletChain || !walletClient || !publicClient) return;
    // Accepted-sale completion window (Codex #1511 r4 P1 + r5 P1): a
    // repay here terminalizes the loan and permanently strands the
    // buyer's recovery completion. Cached fast-path, then a LIVE
    // re-check — the cached state can be a tip interval old.
    if (kind === 'repay') {
      if (saleCompletionPending || saleHoldResolving) {
        setError(copy.saleHold.completionPaused);
        return;
      }
      // Hold the page lock ACROSS the live probe (Codex #1511 r6) —
      // the await must not leave Confirm and the sibling surfaces
      // clickable while this handler is in flight.
      setPhase('pending');
      const blocked = await assertSaleSettlementSafe();
      if (blocked) {
        setPhase(null);
        setError(blocked);
        return;
      }
    }
    setPhase('pending');
    setError(null);
    try {
      if (kind === 'repay') {
        const [calcDue, latestBlock, liveGate] = await Promise.all([
          readRepaymentDueLive(publicClient, walletChain.diamondAddress, row.loanId),
          publicClient.getBlock({ blockTag: 'latest' }),
          // The LIVE loan, unconditionally (OBS-2 #988): its STATUS is
          // the authoritative repayability gate for rentals too, and
          // for ERC-20 loans its term fields feed the grace math below
          // (a keeper extendLoanInPlace moves durationDays under the
          // indexer row; the contract judges gracePeriod on the live
          // term).
          readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        ]);
        const chainNow = latestBlock.timestamp;
        // repayLoan accepts only Active + FallbackPending (the cure
        // path). Anything else means the loan already settled or was
        // liquidated — abort BEFORE any balance check, approval, or
        // wallet prompt instead of estimating a doomed write. This is
        // the submit-side twin of the render-time reconciliation: it
        // covers the race where the user clicks before the live-status
        // query lands.
        if (
          liveGate.status !== LoanStatus.Active &&
          liveGate.status !== LoanStatus.FallbackPending
        ) {
          setError(copy.errors.loanAlreadySettled);
          return;
        }
        // Two more independent live reads, one round-trip: the role
        // came from a CACHED ownerOf (repayLoan is PERMISSIONLESS — a
        // stale "borrower" could pay off a position whose claim now
        // belongs to someone else), and the grace window is judged by
        // CHAIN time against the LIVE buckets.
        const [, graceSec] = await Promise.all([
          assertPositionNftHeldLive({
            publicClient,
            diamondAddress: walletChain.diamondAddress,
            tokenId: row.borrowerTokenId,
            expectedOwner: address,
          }),
          // Grace only gates ERC-20 repays — don't spend a read on
          // rental closes.
          row.assetType === AssetType.ERC20
            ? readGraceSecondsLive({
                publicClient,
                diamondAddress: walletChain.diamondAddress,
                durationDays: Number(liveGate.durationDays),
              })
            : Promise.resolve(0n),
        ]);
        // repayLoan reverts RepaymentPastGracePeriod once past the
        // grace window — fail BEFORE the approval, judged on the LIVE
        // term fields (see the liveGate read above).
        if (row.assetType === AssetType.ERC20) {
          const endTime = liveGate.startTime + liveGate.durationDays * 86_400n;
          if (chainNow > endTime + graceSec) {
            setError(copy.errors.pastGrace);
            return;
          }
        }
        // calculateRepaymentAmount returns 0 for any non-Active status
        // — but repayLoan ACCEPTS FallbackPending (the cure path) and
        // still pulls principal + interest. Estimate the pull from the
        // live loan so the cure flow gets a real allowance; the
        // estimate only over-approves (repayLoan pulls what it
        // recomputes) and the pad below is never spent.
        let totalDue = calcDue;
        // Keyed on the LIVE status (not the row's): the cure estimate
        // must fire exactly when the chain says FallbackPending, even
        // if the indexer row hasn't caught up to that state yet.
        if (totalDue === 0n && liveGate.status === LoanStatus.FallbackPending) {
          const live = liveGate;
          const elapsedDays =
            chainNow > live.startTime ? (chainNow - live.startTime) / 86_400n : 0n;
          const interestEst =
            (live.principal * live.interestRateBps * (elapsedDays + 2n)) /
            (365n * 10_000n);
          // Late fees mirror LibVaipakam.calculateLateFee: 1% base +
          // 0.5%/day past maturity, CAPPED at 5%. Judge maturity by the
          // LIVE term (a keeper extend moves it), pad one day-step, and
          // clamp — an uncapped estimate blocks a borrower who holds
          // enough for the real capped pull once ~8 days late.
          const endTimeLive = live.startTime + live.durationDays * 86_400n;
          const daysPastEnd =
            chainNow > endTimeLive ? (chainNow - endTimeLive) / 86_400n : 0n;
          let lateFeeBps = 100n + (daysPastEnd + 2n) * 50n;
          if (lateFeeBps > 500n) lateFeeBps = 500n;
          const lateFeeEst = (live.principal * lateFeeBps) / 10_000n;
          totalDue = live.principal + interestEst + lateFeeEst;
        }
        if (row.assetType === AssetType.ERC20 && totalDue > 0n) {
          // The owed amount STEPS UP at each elapsed-day boundary
          // (whole-day interest flooring) and by the late fee — an
          // exact-amount approval can be short by the time repayLoan
          // executes. Pad by ~2 days of interest + the worst single
          // late-fee jump (the 1% base landing when a repay signed
          // just before maturity mines just after it, plus a 0.5%
          // day-step — same bound as the preclose pad, Codex #1256
          // r1); repayLoan only pulls the recomputed amount, so the
          // pad is never spent.
          const principal = BigInt(row.principal);
          const pad =
            fullTermInterest(principal, row.interestRateBps, 2) +
            (principal * 150n) / 10_000n;
          // approve() succeeds no matter the balance — check the wallet
          // holds the PADDED amount before asking for an approval
          // signature: a wallet holding exactly totalDue can still be
          // short when repayLoan recomputes across a boundary, which
          // would burn the approval on a doomed transferFrom.
          await assertErc20BalanceLive({
            publicClient,
            token: row.lendingAsset as `0x${string}`,
            owner: address,
            amount: totalDue + pad,
            symbol: principalMeta.data?.symbol,
          });
          await ensureAllowance({
            onPrompt: () => setPhase('approving'),
            publicClient,
            walletClient,
            token: row.lendingAsset as `0x${string}`,
            owner: address,
            spender: walletChain.diamondAddress,
            amount: totalDue + pad,
          });
        }
        setPhase('submitting');
        // LATE re-gate (Codex #1511 r10 P1): the entry gate ran before
        // the reads/approval steps above — a buyer acceptance can land
        // during them. Re-check immediately before the protocol write;
        // the on-chain close-out guard that fully closes the signing
        // race is the #1503 PR-E slice.
        {
          const blockedLate = await assertSaleSettlementSafe();
          if (blockedLate) {
            setPhase(null);
            setError(blockedLate);
            return;
          }
        }
        await write('repayLoan', [BigInt(row.loanId)]);
        setClosedThisSession(true);
        setDoneMessage(
          isRental
            ? copy.positions.details.done.rentalClosed
            : copy.positions.details.done.repaid,
        );
      } else if (kind === 'claim-borrower') {
        // Claims screen msg.sender on-chain and the page's gate is a
        // CACHED read — re-screen live before the wallet prompt.
        await assertWalletNotSanctionedLive(
          publicClient,
          walletChain.diamondAddress,
          address,
        );
        // Entitlement preflight: claimAsBorrower reverts NothingToClaim
        // when the record is empty — a real case for a fully-covered
        // internal match (only a residual/rebate is borrower-claimable)
        // and a zero-surplus liquidation. Fail with plain copy instead
        // of a doomed wallet prompt. Best-effort: a failed READ falls
        // through to the write (the wallet estimate still guards).
        try {
          const [res, rebate] = await Promise.all([
            publicClient.readContract({
              address: walletChain.diamondAddress,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'getClaimable',
              args: [BigInt(row.loanId), false],
            }) as Promise<{
              amount?: bigint;
              claimed?: boolean;
              assetType?: bigint;
              1?: bigint;
              2?: boolean;
              3?: bigint;
            }>,
            publicClient
              .readContract({
                address: walletChain.diamondAddress,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'getBorrowerLifRebate',
                args: [BigInt(row.loanId)],
              })
              .then(
                (r) =>
                  (Array.isArray(r)
                    ? ((r as readonly bigint[])[0] ?? 0n)
                    : ((r as { rebateAmount?: bigint }).rebateAmount ?? 0n)),
                (e) => {
                  // Old ABI without the Phase-5 view REVERTS → truly no
                  // rebate. A TRANSPORT failure must NOT read as zero —
                  // that would falsely block a rebate-only claim — so
                  // rethrow to the outer catch, which falls through to
                  // the write (whose own estimate still guards).
                  if (isRevert(e)) return 0n;
                  throw e;
                },
              ),
          ]);
          const amount = res.amount ?? res[1] ?? 0n;
          const alreadyClaimed = res.claimed ?? res[2] ?? false;
          const assetType = Number(res.assetType ?? res[3] ?? 0n);
          const actionable =
            amount > 0n || assetType !== AssetType.ERC20 || rebate > 0n;
          if (alreadyClaimed || !actionable) {
            setError(copy.errors.nothingToClaim);
            return;
          }
        } catch {
          // Read failed (transport) — proceed; the write path's own
          // estimate surfaces any revert.
        }
        setPhase('submitting');
        await write('claimAsBorrower', [BigInt(row.loanId)]);
        setClaimed((c) => ({ ...c, borrower: true }));
        setDoneMessage(copy.claims.claimed);
      } else {
        await assertWalletNotSanctionedLive(
          publicClient,
          walletChain.diamondAddress,
          address,
        );
        setPhase('submitting');
        await write('claimAsLender', [BigInt(row.loanId)]);
        setClaimed((c) => ({ ...c, lender: true }));
        setDoneMessage(copy.claims.claimed);
      }
      setConfirmingSurface(null);
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
      void queryClient.invalidateQueries({ queryKey: ['claimables'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setPhase(null);
    }
  }

  const principalStr = principal
    ? `${formatTokenAmount(row.principal, principal.decimals)} ${principal.symbol}`
    : '…';
  const interestStr = principal
    ? `${formatTokenAmount(interest, principal.decimals)} ${principal.symbol}`
    : '…';
  async function runAddCollateral() {
    if (!address || !walletChain || !walletClient || !publicClient || !collateralMeta.data) return;
    setPhase('pending');
    setError(null);
    try {
      const wei = parseUnits(collateralInput, collateralMeta.data.decimals);
      // addCollateral screens msg.sender — re-screen live before the
      // approval (the page gate is a cached read).
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // Three independent live gates, one round-trip: addCollateral
      // authorizes the CURRENT borrower-position holder
      // (requireBorrowerNftOwner), approve() ignores balances, and the
      // contract rejects top-ups on unpriced collateral
      // (IlliquidAsset; fail-open read — the contract still guards).
      const [, , collateralIlliquid] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.borrowerTokenId,
          expectedOwner: address,
        }),
        assertErc20BalanceLive({
          publicClient,
          token: row.collateralAsset as `0x${string}`,
          owner: address,
          amount: wei,
          symbol: collateralMeta.data.symbol,
        }),
        isAssetIlliquidLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: row.collateralAsset,
        }),
      ]);
      if (collateralIlliquid) {
        setError(copy.errors.collateralNotPriced);
        return;
      }
      await ensureAllowance({
            onPrompt: () => setPhase('approving'),
        publicClient,
        walletClient,
        token: row.collateralAsset as `0x${string}`,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: wei,
      });
      setPhase('submitting');
      await write('addCollateral', [BigInt(row.loanId), wei]);
      setDoneMessage(copy.positions.details.done.collateralAdded);
      setCollateralInput('');
      setConfirmingSurface(null);
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanRisk'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setPhase(null);
    }
  }

  async function runPartialRepay() {
    if (!address || !walletChain || !walletClient || !publicClient || !principalMeta.data) return;
    // Accepted-sale completion window (Codex #1511 r4 P1 + r5 P1):
    // the buyer funded the ACCEPTED principal — a partial now changes
    // it under the in-flight purchase. Cached fast-path + LIVE
    // re-check.
    if (saleCompletionPending || saleHoldResolving) {
      setError(copy.saleHold.completionPaused);
      return;
    }
    // Lock held across the live probe (Codex #1511 r6).
    setPhase('pending');
    {
      const blocked = await assertSaleSettlementSafe();
      if (blocked) {
        setPhase(null);
        setError(blocked);
        return;
      }
    }
    setError(null);
    try {
      const wei = parseUnits(partialInput, principalMeta.data.decimals);
      // repayPartial pulls MORE than the typed amount: the accrued
      // interest to now (lender + treasury split) rides along in the
      // same transferFrom set. Approve and balance-check the full pull
      // from the LIVE loan (row.principal / startTime go stale after a
      // prior partial re-stamps the accrual clock).
      const [live, latestBlock, borrowerLock] = await Promise.all([
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        // The contract accrues by block.timestamp — a slow browser
        // clock must not under-approve past the two-day pad.
        publicClient.getBlock({ blockTag: 'latest' }),
        // (The lender NFT's sale-listing lock is deliberately NOT read
        // here any more — Codex #1511 r1 P1: repayPartial has no
        // listing hold on-chain and the buyer's acceptance re-binds to
        // the shrunk principal, so a listing never blocks a partial.)
        // Codex #1500 r4 P1 — the BORROWER position's lock, read live
        // here rather than trusted from the render-time offsetPending
        // branch. `repayPartial` has NO offset guard on chain, so a
        // partial posted after a cross-device offset went live would
        // succeed and shrink the principal the linked offer is pinned
        // to, stranding its escrow until someone cancels. Fail CLOSED:
        // an unreadable lock blocks the partial (this read THROWS).
        publicClient
          .readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'positionLock',
            args: [BigInt(row.borrowerTokenId)],
          })
          .then((v) => Number(v)),
      ]);
      // The indexer row said Active — but another tab/device may have
      // settled the loan inside its lag window, and repayPartial
      // reverts InvalidLoanStatus after the approval already mined.
      if (live.status !== LOAN_STATUS_ACTIVE) {
        setError(copy.errors.loanAlreadySettled);
        return;
      }
      // repayPartial enforces the SAME grace window as repayLoan
      // (RepaymentPastGracePeriod) — judge it by chain time against
      // the live buckets, keyed on the LIVE duration (a keeper extend
      // moves it under the indexer row), before any approval.
      const graceSec = await readGraceSecondsLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        durationDays: Number(live.durationDays),
      });
      if (
        latestBlock.timestamp >
        live.startTime + live.durationDays * 86_400n + graceSec
      ) {
        setError(copy.errors.pastGrace);
        return;
      }
      // NOTE deliberately NO sale-listing guard here (Codex #1511 r1
      // P1): repayPartial carries no listing hold on-chain, and the
      // buyer's acceptance binds to the loan's CURRENT principal — a
      // partial repayment during a listing shrinks the claim and the
      // pending buyer simply re-signs. The pre-binding UI block that
      // lived here contradicted both.
      if (borrowerLock === LOCK_PRECLOSE_OFFSET) {
        setError(copy.offset.blockedOtherPaths);
        return;
      }
      // A partial equal to the FULL remaining principal is accepted by
      // the contract but leaves the loan Active at principal 0 —
      // settlement (and collateral release) needs the real repay path.
      if (wei >= live.principal) {
        setError(copy.errors.partialOverPrincipal);
        return;
      }
      // repayPartial authorizes the CURRENT borrower-position holder
      // (stored-anchor auth after consolidation) — re-check live so a
      // stale role fails before the approval.
      await assertPositionNftHeldLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        tokenId: row.borrowerTokenId,
        expectedOwner: address,
      });
      // repayPartial pays the CURRENT lender-position holder DIRECTLY
      // and reverts if that wallet is sanctioned — screen the resolved
      // holder before the approval (full repay stays open: it defers
      // the lender's proceeds to a screened claim instead).
      const lenderHolder = (await publicClient
        .readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'ownerOf',
          args: [BigInt(row.lenderTokenId)],
        })
        .catch(() => null)) as string | null;
      if (lenderHolder) {
        const lenderFlagged = await publicClient
          .readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'isSanctionedAddress',
            args: [lenderHolder as `0x${string}`],
          })
          .catch(() => false);
        if (lenderFlagged) {
          setError(copy.errors.lenderBlockedPartial);
          return;
        }
      }
      const accrualStart =
        live.interestAccrualStart !== 0n ? live.interestAccrualStart : live.startTime;
      const nowSec = latestBlock.timestamp;
      const elapsedDays = nowSec > accrualStart ? (nowSec - accrualStart) / 86_400n : 0n;
      // +2 days pad for day-boundary steps while the tx is pending —
      // the contract pulls only the recomputed accrued, never the pad.
      const accrued =
        (live.principal * live.interestRateBps * (elapsedDays + 2n)) /
        (365n * 10_000n);
      const required = wei + accrued;
      await assertErc20BalanceLive({
        publicClient,
        token: row.lendingAsset as `0x${string}`,
        owner: address,
        amount: required,
        symbol: principalMeta.data.symbol,
      });
      await ensureAllowance({
            onPrompt: () => setPhase('approving'),
        publicClient,
        walletClient,
        token: row.lendingAsset as `0x${string}`,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: required,
      });
      setPhase('submitting');
      // LATE re-gate (Codex #1511 r10 P1): the entry gate ran before
      // the reads/approval steps above — a buyer acceptance can land
      // during them. Re-check immediately before the protocol write;
      // the on-chain close-out guard that fully closes the signing
      // race is the #1503 PR-E slice.
      {
        const blockedLate = await assertSaleSettlementSafe();
        if (blockedLate) {
          setPhase(null);
          setError(blockedLate);
          return;
        }
      }
      await write('repayPartial', [BigInt(row.loanId), wei]);
      setDoneMessage(copy.positions.details.done.partialRepaid);
      setPartialInput('');
      setConfirmingSurface(null);
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      // The close-early quote (loanLive.calcDue) changes with every
      // partial — without this it keeps quoting the pre-partial figure.
      void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
      void queryClient.invalidateQueries({ queryKey: ['loanRisk'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setPhase(null);
    }
  }

  async function runPreclose() {
    if (!address || !walletChain || !walletClient || !publicClient || !principalMeta.data) return;
    // NOTE deliberately NO guard for a LIVE/expired listing here
    // (Codex #1511 r2): `precloseDirect` carries no
    // `loanToSaleOfferId` check on-chain — the listing's hold is on
    // the OFFSET path and collateral withdrawal, never the direct
    // close. The ACCEPTED completion window is different (Codex
    // #1511 r4 P1): a close there terminalizes the loan and strands
    // the buyer's recovery completion.
    if (saleCompletionPending || saleHoldResolving) {
      setError(copy.saleHold.completionPaused);
      return;
    }
    // Lock held across the live probe (Codex #1511 r6).
    setPhase('pending');
    {
      const blocked = await assertSaleSettlementSafe();
      if (blocked) {
        setPhase(null);
        setError(blocked);
        return;
      }
    }
    setError(null);
    try {
      // precloseDirect is a Tier-1 entry point — live re-screen, plus
      // the ownership/clock reads, one round-trip.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      const [, live, calcDue, latestBlock] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.borrowerTokenId,
          expectedOwner: address,
        }),
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        readRepaymentDueLive(publicClient, walletChain.diamondAddress, row.loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
      ]);
      // The card's grace gate ran on a CACHED chain clock (a
      // backgrounded tab stops refetching) — re-judge live against
      // the LIVE term fields and the LIVE grace bucket. Since #1189,
      // precloseDirect stays valid THROUGH the grace window (charging
      // the same late fee repayLoan does — calcDue already includes
      // it) and reverts strictly past it, so mirror exactly that
      // boundary (#1235).
      const graceSec = await readGraceSecondsLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        durationDays: Number(live.durationDays),
      });
      if (
        latestBlock.timestamp >
        live.startTime + live.durationDays * 86_400n + graceSec
      ) {
        setError(copy.errors.preclosePastGrace);
        return;
      }
      // `calculateRepaymentAmount` IS the preclose figure — it and
      // `computePreclose` route through the same settlementInterestNet
      // (full-term floor max(elapsed, remaining), interest already
      // settled by partials, CHAIN time). It returns 0 for any
      // non-Active loan — but 0 on a still-ACTIVE loan is the legal
      // "principal fully paid down via partials" state, where
      // precloseDirect is exactly the call that settles and releases
      // the collateral (pulling nothing), so only a non-Active status
      // aborts.
      if (calcDue === 0n && live.status !== LOAN_STATUS_ACTIVE) {
        setError(copy.errors.loanAlreadySettled);
        return;
      }
      // The owed amount steps up at each elapsed-day boundary while
      // the tx is pending — pad by ~2 days of interest plus the
      // worst single late-fee jump: a close signed just before
      // maturity that mines just after it picks up the 1% base fee
      // at once, and an in-grace close crossing a day boundary steps
      // 0.5% (Codex #1256 r1 — 1% + 0.5% covers both). precloseDirect
      // pulls only what it recomputes, so the pad is never spent.
      const due =
        calcDue +
        (live.principal * live.interestRateBps * 2n) / (365n * 10_000n) +
        (live.principal * 150n) / 10_000n;
      await assertErc20BalanceLive({
        publicClient,
        token: row.lendingAsset as `0x${string}`,
        owner: address,
        amount: due,
        symbol: principalMeta.data.symbol,
      });
      await ensureAllowance({
            onPrompt: () => setPhase('approving'),
        publicClient,
        walletClient,
        token: row.lendingAsset as `0x${string}`,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: due,
      });
      setPhase('submitting');
      // LATE re-gate (Codex #1511 r10 P1): the entry gate ran before
      // the reads/approval steps above — a buyer acceptance can land
      // during them. Re-check immediately before the protocol write;
      // the on-chain close-out guard that fully closes the signing
      // race is the #1503 PR-E slice.
      {
        const blockedLate = await assertSaleSettlementSafe();
        if (blockedLate) {
          setPhase(null);
          setError(blockedLate);
          return;
        }
      }
      await write('precloseDirect', [BigInt(row.loanId)]);
      setClosedThisSession(true);
      setDoneMessage(copy.preclose.done);
      setConfirmingSurface(null);
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
      void queryClient.invalidateQueries({ queryKey: ['claimables'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setPhase(null);
    }
  }

  // NFT collateral is identified by collateralTokenId/quantity — its
  // fungible `collateralAmount` is normally ZERO, so amount alone must
  // not decide "no collateral" (that would hide a real NFT pledge).
  const hasCollateral =
    row.collateralAsset.toLowerCase() !== ZERO_ADDRESS &&
    (BigInt(row.collateralAmount) > 0n ||
      row.collateralAssetType !== AssetType.ERC20);
  const collateralStr = !hasCollateral
    ? copy.positions.details.noCollateral
    : row.collateralAssetType !== AssetType.ERC20
      ? `NFT ${shortAddress(row.collateralAsset)} #${row.collateralTokenId}`
      : collateral
        ? `${formatTokenAmount(row.collateralAmount, collateral.decimals)} ${collateral.symbol}`
        : '…';
  const nftStr = `NFT ${shortAddress(row.lendingAsset)} #${row.tokenId}`;
  const dueDate = formatDate(row.startTime + row.durationDays * 86_400);
  // #1235/#1236 — the borrower's early-close and refinance windows
  // extend THROUGH the grace period since contract #1189 (both charge
  // the repay-parity late fee there; strictly past grace they revert).
  // Judged by chain time against the LIVE term fields. While the
  // grace bucket is still loading, degrade to the pre-grace boundary
  // (conservative: the surface appears once the bucket lands — it
  // never lingers past the real window).
  const liveEndTime = loanLive.data
    ? loanLive.data.live.startTime + loanLive.data.live.durationDays * 86_400n
    : null;
  const livePastDue =
    liveEndTime !== null && loanLive.data!.chainNow > liveEndTime;
  const liveWithinGraceWindow =
    liveEndTime !== null &&
    loanLive.data!.chainNow <= liveEndTime + (grace.data ?? 0n);

  const actionLabel =
    action === 'repay'
      ? isRental
        ? copy.positions.details.actions.closeRental
        : copy.positions.details.actions.repay
      : action === 'claim-borrower'
        ? isRental
          ? copy.positions.details.actions.claimBuffer
          : row.status === 'repaid'
            ? copy.positions.details.actions.claimCollateral
            : // defaulted/liquidated surplus OR internal-match residual +
              // VPFI rebate — either may be zero, so never promise it.
              copy.positions.details.actions.claimResidual
        : action === 'claim-lender'
          ? isRental
            ? copy.positions.details.actions.claimFeesNft
            : properClose
              ? copy.positions.details.actions.claimFunds
              : copy.positions.details.actions.claimRecovered
          : null;

  // Six-row receipt for the pending position write — same shape and
  // rows as every create/accept flow (WebsiteReadme intended-behaviour).
  const actionReceipt: ReceiptData | null =
    action === 'repay'
      ? {
          youReceive: isRental
            ? copy.positions.details.receipt.bufferBack
            : hasCollateral
              ? copy.positions.details.collateralBackAfterRepay(collateralStr)
              : copy.positions.details.receipt.noCollateralBack,
          youLock: copy.positions.details.receipt.nothingNew,
          youMayOwe: isRental
            ? copy.positions.details.receipt.oweRentalPrepaid
            : copy.positions.details.owedPrincipalPlusInterest(principalStr),
          youCanLose: copy.positions.details.receipt.loseNothingBeyondOwed,
          fees: copy.positions.details.receipt.feesRepay,
          whenThisEnds: copy.positions.details.receipt.endsRepay,
        }
      : action === 'claim-borrower'
        ? {
            youReceive: isRental
              ? copy.positions.details.receipt.bufferBackShort
              : row.status === 'repaid'
                ? hasCollateral
                  ? copy.positions.details.collateralBackPlain(collateralStr)
                  : copy.positions.details.receipt.owedNoCollateral
                : row.status === 'internal_matched'
                  ? copy.positions.details.receipt.internalResidual
                  : copy.positions.details.receipt.liquidationResidual,
            youLock: copy.positions.details.receipt.nothing,
            youMayOwe: copy.positions.details.receipt.nothing,
            youCanLose: copy.positions.details.receipt.nothing,
            fees: copy.positions.details.receipt.feesNone,
            whenThisEnds: copy.positions.details.receipt.endsClaim,
          }
        : action === 'claim-lender'
          ? {
              youReceive: isRental
                ? copy.positions.details.receipt.rentalFeesAndNft
                : properClose
                  ? copy.positions.details.principalPlusInterest(principalStr)
                  : // Liquid-collateral defaults settle by SWAP — the
                    // lender's claim pays proceeds in the loan asset,
                    // not the collateral itself. Only in-kind (illiquid)
                    // paths hand over the raw collateral, so promise
                    // neither specifically.
                    hasCollateral
                    ? copy.positions.details.recoveredSummary(principal?.symbol ?? copy.positions.details.loanAssetFallback, collateralStr)
                    : copy.positions.details.receipt.recoveredNoCollateral,
              youLock: copy.positions.details.receipt.nothing,
              youMayOwe: copy.positions.details.receipt.nothing,
              youCanLose: copy.positions.details.receipt.nothing,
              fees: properClose && !isRental
                ? copy.positions.details.receipt.feesYield
                : isRental
                  ? copy.positions.details.receipt.feesRental
                  : copy.positions.details.receipt.feesNone,
              whenThisEnds: copy.positions.details.receipt.endsClaim,
            }
          : null;

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1 className="page-title">
            {isRental ? copy.positions.details.titleRental : copy.positions.details.titleLoan} #{row.loanId}
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            {isRental
              ? role === 'borrower'
                ? copy.positions.details.youRent(nftStr)
                : role === 'lender'
                  ? copy.positions.details.nftRentedOut(nftStr)
                  : copy.positions.details.nftRentalBetween(nftStr)
              : role === 'borrower'
                ? copy.positions.details.youBorrowed(principalStr)
                : role === 'lender'
                  ? copy.positions.details.youLent(principalStr)
                  : copy.positions.details.loanBetween(principalStr)}
          </p>
        </div>
        <span className={`badge badge-${view.badge}`}>{loanStateLabel(view, copy.loanState)}</span>
      </div>

      {statusIsReconciled &&
      row.status !== 'active' &&
      row.status !== 'fallback_pending' ? (
        // OBS-2 (#988) — the badge above shows the LIVE on-chain state,
        // which is ahead of the Positions list. Say so, or the mismatch
        // reads as a bug. TERMINAL reconciliations only: the copy says
        // the position "closed on-chain", which is wrong both for the
        // fallback-cure direction (back to active) and for a live
        // FallbackPending (curable — repay/top-up still offered).
        <div className="banner banner-info" role="status">
          <span className="banner-body">{copy.positions.settledAhead}</span>
        </div>
      ) : null}

      {showGraceBanner ? (
        // UX-004 — the past-due countdown. role="alert": this is the
        // one moment on the page where losing collateral is imminent.
        <div className="banner banner-danger" role="alert">
          {/* Role-branched three ways (Codex #1166 r3): a viewer — no
              wallet, neither position, or owner read still checking —
              must never be told to repay a loan they can't repay. */}
          <span className="banner-body">
            {gracePhase === 'unknown'
              ? role === 'lender'
                ? copy.positions.graceUnknownLender
                : role === 'borrower'
                  ? copy.positions.graceUnknownBorrower
                  : copy.positions.graceUnknownViewer
              : gracePhase === 'countdown'
                ? role === 'lender'
                  ? copy.positions.graceCountdownLender(formatRemaining(graceRemaining!))
                  : role === 'borrower'
                    ? copy.positions.graceCountdownBorrower(formatRemaining(graceRemaining!))
                    : copy.positions.graceCountdownViewer(formatRemaining(graceRemaining!))
                : role === 'lender'
                  ? copy.positions.graceOverLender
                  : role === 'borrower'
                    ? copy.positions.graceOverBorrower
                    : copy.positions.graceOverViewer}
          </span>
        </div>
      ) : showFallbackCureBanner ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{copy.positions.fallbackCureBorrower}</span>
        </div>
      ) : null}

      <section className="card">
        <dl className="receipt" style={{ margin: 0 }}>
          <div className="receipt-row">
            <dt>{copy.positions.details.labels.locked}</dt>
            <dd>
              {isRental
                ? copy.positions.details.nftStaysVault(nftStr, hasCollateral ? copy.positions.details.vaultCollateralSuffix(collateralStr) : '')
                : copy.positions.details.lockedCollateralBorrower(collateralStr)}
            </dd>
          </div>
          <div className="receipt-row">
            <dt>{copy.positions.details.labels.owed}</dt>
            <dd>
              {isRental
                ? copy.positions.details.owedRentalPrepaid
                : loanOver
                  ? row.status === 'repaid'
                    ? copy.positions.owedRepaid(principalStr)
                    : row.status === 'defaulted' || row.status === 'liquidated'
                      ? hasCollateral
                        ? copy.positions.owedDefaulted
                        : copy.positions.owedDefaultedNoCollateral
                      : copy.positions.owedClosed
                  : copy.positions.details.owedPrincipalUpToInterest(principalStr, interestStr)}
            </dd>
          </div>
          <div className="receipt-row">
            <dt>{copy.positions.details.labels.terms}</dt>
            <dd>
              {isRental
                ? copy.positions.details.termsRental(
                    formatDurationDays(row.durationDays),
                    dueDate,
                  )
                : copy.positions.details.termsLoan(
                    formatBpsAsPercent(row.interestRateBps),
                    formatDurationDays(row.durationDays),
                    dueDate,
                  )}
            </dd>
          </div>
          {!isRental &&
          feeEnt.data?.stamped &&
          (feeEnt.data.borrowerMode === FEE_MODE_FULL ||
            feeEnt.data.lenderMode === FEE_MODE_FULL) ? (
            // #1355 — per-party VPFI fee-mode stamps + absorbed
            // tariffs. Rendered only when a party actually paid the
            // Full tariff — the default HoldOnly/None stamps carry no
            // information a user acts on here.
            <div className="receipt-row">
              <dt>{copy.tariff.sectionTitle}</dt>
              <dd>
                {copy.tariff.borrowerModeLabel}:{' '}
                {feeModeWord(feeEnt.data.borrowerMode)}
                {feeEnt.data.borrowerTariffPaid > 0n
                  ? ` (${copy.tariff.tariffPaidLine(
                      formatTokenAmount(feeEnt.data.borrowerTariffPaid, VPFI_DECIMALS),
                    )})`
                  : ''}
                {' · '}
                {copy.tariff.lenderModeLabel}:{' '}
                {feeModeWord(feeEnt.data.lenderMode)}
                {feeEnt.data.lenderTariffPaid > 0n
                  ? ` (${copy.tariff.tariffPaidLine(
                      formatTokenAmount(feeEnt.data.lenderTariffPaid, VPFI_DECIMALS),
                    )})`
                  : ''}
                {feeEnt.data.lenderMode === FEE_MODE_FULL ? (
                  <>
                    {' '}
                    <span className="muted">{copy.tariff.nftTravelNote}</span>
                  </>
                ) : null}
              </dd>
            </div>
          ) : null}
          {isAdvanced && (role === 'borrower' || role === 'lender') ? (
            // Position control travels with this NFT — the id links
            // to the verifier so its holder can prove (or a buyer can
            // check) exactly what it controls.
            <div className="receipt-row">
              <dt>{copy.nftVerifier.positionRowLabel}</dt>
              <dd>
                <Link
                  to={`/nft/${role === 'lender' ? row.lenderTokenId : row.borrowerTokenId}`}
                >
                  #{role === 'lender' ? row.lenderTokenId : row.borrowerTokenId}
                </Link>{' '}
                <span className="muted">
                  {copy.nftVerifier.positionRowNote(role)}
                </span>
              </dd>
            </div>
          ) : null}
          {!isRental && row.status === 'active' && !risk.data ? (
            // A missing risk read must LOOK missing — hiding the row
            // would render a possibly-liquidatable loan as complete.
            <div className="receipt-row">
              <dt>{copy.positions.details.labels.health}</dt>
              <dd>
                {risk.isError
                  ? copy.positions.details.healthReadFailed
                  : copy.positions.details.healthChecking}
              </dd>
            </div>
          ) : null}
          {!isRental && row.status === 'active' && risk.data ? (
            <div className="receipt-row">
              <dt>{copy.positions.details.labels.health}</dt>
              <dd>
                {risk.data.priced ? (
                  <>
                    <span className={`badge badge-${healthView(risk.data).badge}`}>
                      {healthView(risk.data).label}
                    </span>{' '}
                    {copy.risk.explain}
                    {isAdvanced ? (
                      <>
                        {' '}
                        <span className="muted">
                          {copy.risk.advancedDetail(
                            healthView(risk.data).ratio,
                            healthView(risk.data).ltvPct,
                            healthView(risk.data).dropToLiquidationPct
                              ? copy.risk.advancedDetailDrop(
                                  healthView(risk.data).dropToLiquidationPct!,
                                )
                              : '',
                          )}
                        </span>
                      </>
                    ) : null}
                  </>
                ) : (
                  copy.risk.notPriced
                )}
              </dd>
            </div>
          ) : null}
          <div className="receipt-row receipt-risk">
            <dt>{loanOver ? copy.positions.details.labels.whatNext : copy.positions.details.labels.ifNothing}</dt>
            <dd>
              {loanOver
                ? isRental
                  ? copy.positions.whatNextRentalEnded
                  : row.status === 'repaid'
                    ? role === 'borrower'
                      ? copy.positions.whatNextRepaidBorrower
                      : role === 'lender'
                        ? copy.positions.whatNextRepaidLender
                        : copy.positions.whatNextRepaidViewer
                    : row.status === 'defaulted' || row.status === 'liquidated'
                      ? role === 'borrower'
                        ? copy.positions.whatNextDefaultedBorrower
                        : role === 'lender'
                          ? copy.positions.whatNextDefaultedLender
                          : copy.positions.whatNextDefaultedViewer
                      : row.status === 'internal_matched'
                        ? role === 'borrower'
                          ? copy.positions.whatNextInternalMatchBorrower
                          : role === 'lender'
                            ? copy.positions.whatNextInternalMatchLender
                            : copy.positions.whatNextInternalMatchViewer
                        : copy.positions.whatNextClosed
                : isRental
                  ? role === 'borrower'
                    ? copy.positions.details.whatIfNothingRentalRenter
                    : role === 'lender'
                      ? copy.positions.details.whatIfNothingRentalOwner
                      : copy.positions.details.whatIfNothingRentalViewer
                  : role === 'borrower'
                    ? copy.positions.whatIfNothingBorrower(
                        collateral?.symbol ?? copy.positions.details.lockedSymbolFallback,
                        graceLengthStr ? `${graceLengthStr} ` : '',
                      )
                    : role === 'lender'
                      ? copy.positions.whatIfNothingLender(graceLengthStr ? `${graceLengthStr} ` : '')
                      : // #1166 live-review follow-up — a wallet holding
                        // neither position is never addressed as a party.
                        copy.positions.whatIfNothingViewer(graceLengthStr ? `${graceLengthStr} ` : '')}
            </dd>
          </div>
        </dl>
      </section>

      {/* #1033 — one-line alerts nudge: deadlines happen while the
          site is closed, and the borrower on an active loan is the
          person who most needs to hear about them. */}
      {role === 'borrower' &&
      row.status === 'active' &&
      !closedThisSession &&
      !isRental ? (
        <p className="muted" style={{ margin: 0 }}>
          <Link to="/settings">{copy.alerts.loanNudge}</Link>
        </p>
      ) : null}

      {/* Early-repayment CHOOSER (FunctionalSpecs §8) — every way out
          of an active loan named in one place, in BOTH modes, before
          any flow opens. Hidden while an offset is live (the pending
          card below owns the story then) and once grace is verifiably
          over (every borrower door is shut). */}
      {/* Borrower-side listing-hold notice — rendered on the CHAIN's
          say-so (the teardown probe), so a listing made by the lender
          on any device shows here. Sits above the chooser: it is the
          "why" for the chooser's held close-early row. */}
      {role === 'borrower' &&
      !closedThisSession &&
      !isRental &&
      // The latched confirmation must not outlive the loan (Codex
      // #1511 r7): once the reconciled status is terminal there is no
      // action window to talk about.
      row.status === 'active' &&
      (saleListingHeld || saleHoldCleared) ? (
        <SaleListingHoldCard
          loanId={loanId}
          state={saleHold.data ?? 'unknown'}
          cleared={saleHoldCleared}
          confirmOpen={confirmingSurface === 'sale-teardown'}
          onOpenConfirm={() => setConfirmingSurface('sale-teardown')}
          onCloseConfirm={() =>
            setConfirmingSurface((s) => (s === 'sale-teardown' ? null : s))
          }
          busy={busy}
          setBusy={setBusy}
          onCleared={() => {
            // Latch only if the loan is still LIVE post-mining (Codex
            // #1511 r10): a terminal transition between the render-time
            // read and the receipt means the teardown took the
            // seller-hygiene branch — no cooldown was stamped, so the
            // action-window confirmation would be false. Left
            // unlatched, the card simply unmounts on the refetch.
            //
            // "Live" is Active OR FallbackPending, matching the
            // contract exactly: teardownStaleSaleListing routes both to
            // teardownExpired, which stamps the relist cooldown. An
            // Active-only test would swallow the success confirmation
            // for a loan that slipped into fallback while the review
            // was open — a cleanup that really did run, and really did
            // start the borrower's window.
            // Bind the whole continuation to the chain this card was
            // RENDERED on. Read from the closure, never from the ref:
            // onCleared fires only after the teardown tx has mined, so
            // a switch during that (multi-second) write has ALREADY
            // moved the ref — snapshotting it here would compare the
            // new chain against itself and always pass. The running
            // freeOptions instance still holds this render's callback,
            // so this value is the pre-switch chain, which is exactly
            // what the ref must be compared against.
            const startedOnChainId = readChain.chainId;
            void (async () => {
              try {
                if (!publicClient || !walletChain) return;
                if (saleHoldChainRef.current !== startedOnChainId) return;
                const live = await readLoanLive(
                  publicClient,
                  walletChain.diamondAddress,
                  row.loanId,
                );
                if (saleHoldChainRef.current !== startedOnChainId) return;
                const st = Number(live.status);
                if (
                  st === LOAN_STATUS_ACTIVE ||
                  st === LoanStatus.FallbackPending
                ) {
                  setSaleHoldCleared(true);
                }
              } catch {
                // Unverifiable → stay unlatched (fail closed).
              }
            })();
          }}
        />
      ) : null}

      {role === 'borrower' &&
      row.status === 'active' &&
      !closedThisSession &&
      !isRental &&
      !offsetPend.pending &&
      !graceVerifiablyOver ? (
        <EarlyRepayOptionsCard
          isAdvanced={isAdvanced}
          onSwitchToAdvanced={() => setMode('advanced')}
          partialAllowed={row.allowsPartialRepay}
          useFullTermInterest={
            loanLive.data?.live.useFullTermInterest ??
            liveStatus.data?.useFullTermInterest
          }
          // Chain-anchored only (Codex #1500 r2): the device clock or
          // a lagging indexer row must never mark a path expired while
          // the chain-authoritative cards below still permit it. With
          // no live read in hand the hint stays false — the target
          // cards enforce the real gates.
          pastDueHint={
            loanLive.data
              ? loanLive.data.chainNow > loanEndTimeOf(loanLive.data.live)
              : bannerTerms.data
                ? BigInt(bannerTerms.data.chainNow) >
                  loanEndTimeOf(bannerTerms.data.live)
                : false
          }
          refinancePending={refinanceBlocking}
          refinanceEligible={Boolean(
            address && address.toLowerCase() === row.borrower.toLowerCase(),
          )}
          saleListingHeld={saleListingHeld}
          saleCompletionPending={saleCompletionPending}
          saleHoldChecking={saleHoldResolving}
        />
      ) : null}

      {role === 'borrower' &&
      (row.status === 'active' || row.status === 'fallback_pending') &&
      !closedThisSession &&
      !isRental &&
      hasCollateral &&
      collateral ? (
        <section className="card">
          <div className="card-title">
            <ShieldPlus aria-hidden />
            <h3 style={{ margin: 0 }}>{copy.positions.details.addCollateral.title}</h3>
          </div>
          <p className="muted">
            {copy.positions.details.toppingUp(collateral.symbol)}
          </p>
          <div className="cluster">
            <input
              aria-label={copy.positions.details.addCollateral.amountAria}
              className="input"
              style={{ flex: 1 }}
              inputMode="decimal"
              placeholder="0.0"
              value={collateralInput}
              onChange={(e) => setCollateralInput(e.target.value.trim())}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={
                busy ||
                !onSupportedChain ||
                !walletClient ||
                !publicClient ||
                !sanctionsClear ||
                collateralInputWei === null ||
                // balance still loading → over-balance can't be judged
                // yet, so hold the button rather than let a short
                // wallet through to a doomed approval.
                collateralBalance.data === undefined ||
                collateralOverBalance
              }
              onClick={() => setConfirmingSurface('collateral')}
            >
              {copy.positions.details.addCollateral.button}
            </button>
          </div>
          {collateralOverBalance ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {collateralInputWei !== null && collateralBalance.data !== undefined
                ? copy.errors.needMoreBy(
                    formatTokenAmount(
                      collateralInputWei - collateralBalance.data,
                      collateral.decimals,
                    ),
                    collateral.symbol,
                  )
                : copy.errors.needMore(collateral.symbol)}
            </p>
          ) : null}
          {confirmingSurface === 'collateral' && collateralInputWei !== null ? (
            <div style={{ marginTop: 16 }}>
              <ConfirmReceipt
                busy={busy}
                confirmLabel={copy.positions.details.addCollateral.confirm}
                onBack={() => setConfirmingSurface(null)}
                onConfirm={() => void runAddCollateral()}
                data={{
                  youReceive:
                    row.status === 'fallback_pending'
                      ? copy.positions.details.addCollateral.receiveFallbackCure
                      : copy.positions.details.addCollateral.receiveSafer,
                  youLock: copy.positions.details.addCollateralReceipt(collateralInput, collateral.symbol),
                  youMayOwe: copy.positions.details.addCollateral.oweNothingMore,
                  youCanLose:
                    row.status === 'fallback_pending'
                      ? copy.positions.details.addCollateral.loseFallback
                      : copy.positions.details.addCollateral.loseNormal,
                  fees: copy.positions.details.receipt.feesNone,
                  whenThisEnds: copy.positions.details.addCollateral.endsImmediately,
                }}
              >
                {row.status === 'fallback_pending' ? (
                  // A fallback-pending top-up CURES only if it restores
                  // the loan's required health thresholds — a partial
                  // top-up leaves the lender able to claim AND puts the
                  // added collateral at stake. Never let the generic
                  // "safer now" copy stand alone here.
                  <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                    <span className="banner-body">
                      {copy.positions.details.addCollateral.fallbackWarn}
                    </span>
                  </div>
                ) : null}
                {saleAcceptedOnFallback ? (
                  // The OTHER cure needs the same disclosure. A top-up
                  // big enough to cure returns the loan to Active,
                  // which is exactly the condition the stranded sale
                  // was waiting on — so this signature can hand the
                  // lender position to a buyer. The repay review says
                  // so; this one must too, or the consequence lands
                  // only on whichever cure the borrower happens not to
                  // pick.
                  <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                    <span className="banner-body">
                      {copy.saleHold.acceptedOnFallback}
                    </span>
                  </div>
                ) : null}
              </ConfirmReceipt>
            </div>
          ) : null}
        </section>
      ) : null}

      {isAdvanced &&
      role === 'borrower' &&
      row.status === 'active' &&
      !closedThisSession &&
      !isRental &&
      row.allowsPartialRepay &&
      principal ? (
        <section className="card" id="partial-repay-card">
          <h3>{copy.positions.details.partial.title}</h3>
          <p className="muted">
            {copy.positions.details.partial.blurb}
          </p>
          {!offsetPend.pendingKnown || saleHoldResolving ? (
            // Fail CLOSED until the chain has answered whether an
            // offset lock is live (it can exist cross-device): a
            // partial under an unseen offset would drift the linked
            // offer from the loan it settles (Codex #1500 r1).
            <p className="muted" style={{ margin: 0 }}>
              {copy.earlyRepay.checkingInterlocks}
            </p>
          ) : offsetPend.pending ? (
            // A live offset's linked offer escrowed the CURRENT
            // principal — a partial under it would drift the offer
            // from the loan it settles. Cancel the offset first.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">
                {copy.offset.blockedOtherPaths}
              </span>
            </div>
          ) : saleCompletionPending ? (
            // Accepted-sale completion window (Codex #1511 r4 P1): the
            // buyer funded the ACCEPTED principal — a partial now
            // changes it under the in-flight purchase.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">
                {copy.saleHold.completionPaused}
              </span>
            </div>
          ) : refinanceBlocking ? (
            // A live refinance request is frozen at the CURRENT
            // principal — a partial would strand it unacceptable
            // forever (the contract rejects any accept once amount >
            // live principal). Explain instead of failing later.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">
                {copy.refinance.partialBlockedByPending}
              </span>
            </div>
          ) : (
          // NOTE deliberately NO sale-listing branch here (Codex #1511
          // r1 P1): a listing never holds partial repayment — the
          // buyer's acceptance binds to the CURRENT principal and
          // re-signs after a paydown, so the pre-binding "would
          // mislead the buyer" freeze that lived here was stale.
          <>
          <div className="cluster">
            <input
              aria-label={copy.positions.details.partial.amountAria}
              className="input"
              style={{ flex: 1 }}
              inputMode="decimal"
              placeholder="0.0"
              value={partialInput}
              onChange={(e) => setPartialInput(e.target.value.trim())}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={
                busy ||
                !onSupportedChain ||
                !walletClient ||
                !publicClient ||
                partialInputWei === null ||
                principalBalance.data === undefined ||
                partialOverBalance
              }
              onClick={() => setConfirmingSurface('partial')}
            >
              {copy.positions.details.partial.button}
            </button>
          </div>
          {partialOverBalance ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {partialInputWei !== null && principalBalance.data !== undefined
                ? copy.errors.needMoreBy(
                    formatTokenAmount(
                      partialInputWei - principalBalance.data,
                      principal.decimals,
                    ),
                    principal.symbol,
                  )
                : copy.errors.needMore(principal.symbol)}
            </p>
          ) : null}
          {confirmingSurface === 'partial' && partialInputWei !== null ? (
            <div style={{ marginTop: 16 }}>
              <ConfirmReceipt
                busy={busy}
                confirmLabel={copy.positions.details.partial.confirm}
                onBack={() => setConfirmingSurface(null)}
                onConfirm={() => void runPartialRepay()}
                data={{
                  youReceive: copy.positions.details.partial.receiveSmallerDebt,
                  youLock: copy.positions.details.receipt.nothing,
                  youMayOwe: copy.positions.details.partialOwe(partialInput, principal.symbol),
                  youCanLose: copy.positions.details.partial.loseNothingBeyondPayment,
                  fees: copy.positions.details.partial.feesAccrued,
                  whenThisEnds: copy.positions.details.partial.endsPrincipalDrops,
                }}
              />
            </div>
          ) : null}
          </>
          )}
        </section>
      ) : null}

      {/* A flagged wallet sees no close-early surface at all rather
          than a dead button — its open path is the Tier-2 repay
          above. Everyone else gets a visible checking/error state
          while the live reads are in flight (never a silently absent
          feature), and the full card only once the live loan has
          landed: the quoted figure and mode note come from it, and
          the grace-window gate is judged by CHAIN time against the
          LIVE term fields (a wrong device clock or a stale indexer
          row must not decide it). */}
      {isAdvanced &&
      role === 'borrower' &&
      row.status === 'active' &&
      !closedThisSession &&
      !isRental &&
      principal &&
      !(sanctions.ready && sanctions.flagged) ? (
        !loanLive.data ||
        !sanctions.ready ||
        feeEnt.data === undefined ||
        !offsetPend.pendingKnown ? (
          // Codex #1412 r1 — the fee-entitlement read is part of the
          // preclose disclosure set (a paid Full tariff is NOT
          // refunded on an early close), so the close-early surface
          // holds in the checking/failed state until that read is
          // known, exactly like the live-loan and sanctions reads.
          // Codex #1500 r1 — same fail-closed posture for the offset
          // LOCK read: a cross-device offset could be live, and every
          // settlement tool below would strand its funded linked
          // offer, so nothing renders until the chain has answered.
          <section className="card">
            <h3>{copy.preclose.title}</h3>
            <p className="muted">
              {loanLive.isError || feeEnt.isError || offsetPend.isError
                ? copy.preclose.checkFailed
                : copy.preclose.checking}
            </p>
          </section>
        ) : (
        <>
        {liveWithinGraceWindow ? (
        <section className="card" id="preclose-card">
          <h3>{copy.preclose.title}</h3>
          <p className="muted">
            {copy.preclose.blurb}{' '}
            {loanLive.data.live.useFullTermInterest
              ? copy.preclose.fullTermNote
              : copy.preclose.proRataNote}
          </p>
          {feeEnt.data &&
          (feeEnt.data.borrowerTariffPaid > 0n ||
            feeEnt.data.lenderTariffPaid > 0n) ? (
            // #1355 — a paid Full tariff was priced on the whole term
            // at open; an early close refunds none of it. Said HERE,
            // before the confirm surface opens.
            <div className="banner banner-info" role="note">
              <span className="banner-body">
                {copy.tariff.precloseNoRefundWarn}
              </span>
            </div>
          ) : null}
          {livePastDue ? (
            // #1235 — in the grace window the close stays open but the
            // quoted figure now carries the repay-parity late fee, and
            // the door shuts when grace ends. Say both before the
            // confirm surface opens.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">{copy.preclose.graceNote}</span>
            </div>
          ) : null}
          {saleHoldResolving ? (
            // Fail CLOSED while the accepted-sale probe is unanswered
            // (Codex #1511 r5 P1).
            <p className="muted" style={{ margin: 0 }}>
              {copy.earlyRepay.checkingInterlocks}
            </p>
          ) : saleCompletionPending ? (
            // Accepted-sale completion window (Codex #1511 r4 P1): a
            // close here terminalizes the loan and strands the
            // buyer's recovery completion.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">
                {copy.saleHold.completionPaused}
              </span>
            </div>
          ) : offsetPend.pending ? (
            // A live offset settles this loan when its offer is
            // accepted — closing another way first strands the
            // linked offer. Cancel the offset instead.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">
                {copy.offset.blockedOtherPaths}
              </span>
            </div>
          ) : refinanceBlocking ? (
            // A live refinance request is frozen against THIS loan —
            // settling it early would strand the request forever.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">
                {copy.refinance.precloseBlockedByPending}
              </span>
            </div>
          ) : confirmingSurface !== 'preclose' ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !onSupportedChain || !walletClient || !publicClient}
              onClick={() => setConfirmingSurface('preclose')}
            >
              {copy.preclose.action}
            </button>
          ) : (
            <div style={{ marginTop: 8 }}>
              <ConfirmReceipt
                busy={busy}
                confirmLabel={copy.preclose.confirm}
                onBack={() => setConfirmingSurface(null)}
                onConfirm={() => void runPreclose()}
                // The wallet can disconnect or hop chains while this
                // receipt is open — a click must land on a disabled
                // button, not on runPreclose's silent early return.
                disabled={!onSupportedChain || !walletClient || !publicClient}
                data={{
                  youReceive: hasCollateral
                    ? copy.positions.details.collateralBackAfterClose(collateralStr)
                    : copy.positions.details.receipt.noCollateralBack,
                  youLock: copy.positions.details.receipt.nothingNew,
                  youMayOwe: `${copy.positions.details.paidNow(
                    formatTokenAmount(loanLive.data.calcDue, principal.decimals),
                    principal.symbol,
                  )} ${
                    loanLive.data.live.useFullTermInterest
                      ? copy.preclose.fullTermNote
                      : copy.preclose.proRataNote
                  }${
                    livePastDue ? ` ${copy.preclose.graceFeeReceiptNote}` : ''
                  } ${copy.positions.details.exactAmountNote}`,
                  youCanLose: copy.positions.details.receipt.loseNothingBeyondPay,
                  fees: copy.positions.details.receipt.feesPreclose,
                  whenThisEnds: copy.positions.details.receipt.endsPreclose,
                }}
              />
            </div>
          )}
        </section>
        ) : // Strictly past the grace window (by live chain time + live
          // term + live grace bucket): every borrower door is shut —
          // preclose and repay both revert past grace; resolution
          // belongs to the default process now (#1189/#1235).
          null}
        {/* Refinance FORM — shares the strategy gates with
            close-early (advanced borrower, live-verified Active,
            sanctions-clear — Tier-1 at accept), PLUS: only the
            ORIGINAL borrower (carry-over binds to the borrower
            stored at init; a transferred position would silently
            re-pledge fresh collateral), and only while NO request is
            already live (the pending surface is the page-owned card
            below, which outlives these gates). Keyed by chain so a
            chain switch re-seeds per-chain state. */}
        {!refinancePending &&
        !offsetPend.pending &&
        // Accepted-sale completion window (Codex #1511 r4 P1): a
        // carry-over refinance settles this loan and strands the
        // buyer's recovery completion — hidden like the other
        // settlement flows; the chooser row says why.
        !saleCompletionPending &&
        !saleHoldResolving &&
        address &&
        address.toLowerCase() === row.borrower.toLowerCase() ? (
          <div id="refinance-card">
            <RefinanceFlow
              key={readChain.chainId}
              preSubmitBlock={assertSaleSettlementSafe}
              row={row}
              live={loanLive.data.live}
              chainNow={loanLive.data.chainNow}
              graceSeconds={grace.data}
              principalMeta={principal}
              confirmOpen={confirmingSurface === 'refinance'}
              onOpenConfirm={() => setConfirmingSurface('refinance')}
              onCloseConfirm={() =>
                setConfirmingSurface((s) => (s === 'refinance' ? null : s))
              }
              onPosted={refi.remember}
              busy={busy}
              setBusy={setBusy}
            />
          </div>
        ) : null}
        {/* Preclose Option 2 (obligation handover) + Option 3 (offset)
            — pre-maturity only (both need a replacement term that ends
            before the original due date; the contracts enforce the
            same bound seconds-precise), never while another linked
            vehicle (refinance request / offset) is live on this loan. */}
        {!livePastDue &&
        !refinanceBlocking &&
        !offsetPend.pending &&
        // Accepted-sale completion window (Codex #1511 r5 P1): the
        // handover rewrites borrower/collateral/duration/rate under
        // the buyer's funded acceptance — paused (and waited on) like
        // the other settlement flows. The chooser rows say why.
        !saleCompletionPending &&
        !saleHoldResolving ? (
          <>
            <ObligationTransferFlow
              preSubmitBlock={assertSaleSettlementSafe}
              row={row}
              live={loanLive.data.live}
              chainNow={loanLive.data.chainNow}
              principalMeta={principal}
              collateralMeta={collateralIsNft ? undefined : (collateral ?? undefined)}
              collateralIsNft={collateralIsNft}
              confirmOpen={confirmingSurface === 'transfer'}
              onOpenConfirm={() => setConfirmingSurface('transfer')}
              onCloseConfirm={() =>
                setConfirmingSurface((s) => (s === 'transfer' ? null : s))
              }
              onDone={() => {
                setClosedThisSession(true);
                setDoneMessage(copy.transferOb.done);
              }}
              busy={busy}
              setBusy={setBusy}
            />
            {loanLive.data.saleLock !== LOCK_EARLY_WITHDRAWAL_SALE &&
            !saleListingHeld ? (
              // Hidden when EITHER independent signal reports the sale
              // lifecycle (Codex #1511 r7): the loanLive lock cache and
              // the hold probe refresh on different rails, and the form
              // must not render while either says the offset would
              // revert.
              <OffsetFlow
                key={`offset-${readChain.chainId}`}
                row={row}
                live={loanLive.data.live}
                chainNow={loanLive.data.chainNow}
                principalMeta={principal}
                collateralMeta={collateralIsNft ? undefined : (collateral ?? undefined)}
                confirmOpen={confirmingSurface === 'offset'}
                onOpenConfirm={() => setConfirmingSurface('offset')}
                onCloseConfirm={() =>
                  setConfirmingSurface((s) => (s === 'offset' ? null : s))
                }
                onPosted={offsetPend.remember}
                busy={busy}
                setBusy={setBusy}
              />
            ) : null}
          </>
        ) : null}
        </>
        )
      ) : null}

      {/* Lender awareness layer (LenderEarlyWithdrawalUXDesign, Layer 1)
          — deliberately OUTSIDE the `isAdvanced` gate below, which is
          the substance of this card. Until it existed, a lender in
          Basic mode saw nothing at all about their position: not the
          sale paths, and not the fact that waiting is itself a choice
          that costs no sale forfeiture. Same placement rule as the
          borrower's chooser, which also sits above its Advanced tools.

          Flagged wallets still see nothing (Tier-1), and a rental is
          excluded entirely — lender early withdrawal does not cover
          rentals in Phase 1. */}
      {isLenderHolder &&
      // Codex r10 P2 — `fallback_pending` belongs here, not only
      // `active`. r9 added copy telling a lender that a loan settling
      // through its fallback path blocks both sales and that waiting
      // still applies; a strict `active` gate made that copy reachable
      // ONLY while the indexer was still behind, and unmounted the
      // whole card the moment the indexer caught up — losing the
      // explanation precisely when it became true. The live-status
      // exclusion below already admits `FallbackPending`; this is the
      // indexed half agreeing with it. Same pairing as
      // `claimables.ts`'s open-loan test and the withdraw block above.
      (row.status === 'active' || row.status === 'fallback_pending') &&
      // Codex r4 P2 — the INDEXED row saying `active` is not enough.
      // Reconciliation (`effectivelyActive`) consults only
      // `liveStatus.data`, so when that read fails or holds an older
      // Active result while `bannerTerms` has already returned a
      // TERMINAL live status, an unclaimed lender kept this card after
      // an early repayment or default — and before the indexed maturity
      // both sale rows showed as available, against contracts that
      // reject the terminal loan with `LoanNotActive`.
      //
      // Blocks only on an AFFIRMATIVE terminal answer, never on a
      // missing one: `bannerTerms.data === undefined` leaves the card
      // mounted. Failing closed on an unanswered read is the
      // permanent-dead-end trap this card has already met twice.
      !(
        resolvedLoanStatus !== undefined &&
        resolvedLoanStatus !== LoanStatus.Active &&
        resolvedLoanStatus !== LoanStatus.FallbackPending
      ) &&
      !soldThisSession &&
      !isRental &&
      !(sanctions.ready && sanctions.flagged) ? (
        <LenderExitOptionsCard
          isAdvanced={isAdvanced}
          onSwitchToAdvanced={() => setMode('advanced')}
          // Undefined ONLY while a read is genuinely in flight — the
          // card then renders its neutral checking line rather than
          // asserting the at-close shape, which would misstate WHEN a
          // periodically-settling lender is paid.
          //
          // Sourced from `liveStatus` (BOTH modes) rather than
          // `loanLive` (advanced-only). Reading it from the strategy
          // query made "undefined" permanent in Basic mode, so the
          // checking line never resolved — Codex r1 P2. `loanLive`
          // stays as the preferred source when it IS loaded, since it
          // refreshes faster.
          //
          // `bannerTerms` is the THIRD source, and omitting it was the
          // same defect one door along (Codex r17 P2): it is enabled
          // independently of the other two, so when `liveStatus` fails
          // without data this page can be holding a perfectly good
          // cadence in a snapshot it simply was not consulting — and
          // the row then said the schedule could not be read, about a
          // schedule it had just read.
          periodicInterestCadence={
            loanLive.data?.live.periodicInterestCadence ??
            liveStatus.data?.periodicInterestCadence ??
            (bannerTerms.isError
              ? undefined
              : bannerTerms.data?.live.periodicInterestCadence)
          }
          // A FAILED read arrives as the same `undefined` a loading one
          // does (Codex r7 P2), and the checking line then promises an
          // answer that is not coming. `liveStatus` is the source that
          // runs in BOTH modes, so its error is the one that decides:
          // in Basic `loanLive` is disabled and never errors, so
          // reading its flag there would keep this false forever.
          // A read that succeeded ANYWHERE outranks a failure
          // elsewhere: the claim is about whether the schedule is
          // known, not about which query answered.
          // A LOADING fallback is not a failed one (Codex r26 P2). The
          // banner clause read `isError || data?.cadence === undefined`,
          // and an in-flight query satisfies the second half — no data
          // yet — so with `liveStatus` errored and `bannerTerms` still
          // on the wire this reported "failed" and told the lender the
          // schedule could not be read, recommending a reload, while a
          // query that can answer was mid-request.
          //
          // The whole point of splitting failed from checking was that
          // a persistent failure must not wear a transient's clothes.
          // This had it the other way round.
          cadenceReadFailed={
            loanLive.data?.live.periodicInterestCadence === undefined &&
            liveStatus.data?.periodicInterestCadence === undefined &&
            (bannerTerms.isError ||
              (bannerTerms.data !== undefined &&
                bannerTerms.data.live.periodicInterestCadence === undefined) ||
              bannerTerms.fetchStatus === 'idle') &&
            (liveStatus.isError || (isAdvanced && loanLive.isError))
          }
          // Chain-anchored only, same rule as the borrower chooser's
          // pastDueHint: a device clock or lagging indexer row must
          // never flip the sale rows to "past due" while the
          // chain-authoritative cards below still permit a sale.
          //
          // Falls back to `bannerTerms` for the same reason as the
          // cadence above — with only `loanLive` in the chain, Basic
          // mode always took the `false` branch and a past-due lender
          // was told both sales were available (Codex r1 P2). This is
          // the identical fallback the borrower chooser already uses.
          // Codex r3 P2 — ANCHORED chain time, not the raw poll snapshot.
          // `chainNow` is captured per refetch, so on a polling-only
          // deployment a lender sitting on the page across maturity kept
          // seeing the sale rows until the next successful poll, while
          // the contract had already begun refusing. `bannerNowSec`
          // advances that anchor by the local tick between refetches —
          // the device clock supplies only the DELTA, never the
          // authority, which is the same rule the grace banner uses
          // (Codex #1166 r2).
          //
          // `termsEndSec` is preferred over `loanLive` here because it
          // resolves from bannerTerms' LIVE terms when present, which is
          // what the r2 fix widened the gate to guarantee for lenders;
          // `loanLive` is fresher but carries no local anchor.
          //
          // `>=`, not `>` (Codex r3 P2): the Advanced tool block gates
          // on a STRICT `<`, so at exactly the maturity second the
          // tools do not mount while a `>` here still reported the
          // position as pre-maturity — the rows showed as available
          // and their jumps had nothing to scroll to. Both contracts
          // refuse a new exit at that boundary too, so the boundary
          // second belongs on the past-due side.
          // THREE-valued (Codex r6 P2). The old `: false` tail was a
          // verdict from a read that had not answered: `termsEndSec`
          // and `bannerNowSec` both fall back to the INDEXER row and
          // the DEVICE clock when `bannerTerms` has no data, and in
          // Basic mode `loanLive` is disabled outright — so an errored
          // terms read left the card asserting "not past due" with no
          // authoritative source behind it, on the one question that
          // refuses both exits.
          //
          // Not a dead end: `bannerTerms` is enabled for exactly this
          // case (`lenderNeedsLiveTerms`), so unknown clears on the
          // next refetch rather than persisting the way an un-runnable
          // query would.
          //
          // `!bannerTerms.isError` matters even though `.data` is set
          // (Codex r8 P2): TanStack RETAINS the last success when a
          // background refetch fails, and an obligation transfer
          // re-stamps `startTime`/`durationDays` on the loan
          // (`PrecloseFacet:1164`), so a cached LATER due date can
          // outlive the live term. Falling through to `loanLive`, and
          // to `'unknown'` when it cannot answer either, fails closed
          // instead of trusting a snapshot the chain has moved past.
          //
          // The order here is the REVERSE of `resolvedLoanStatus`'s and
          // that is intentional — see the note there. This branch needs
          // an anchored clock, which only `bannerTerms` carries; the
          // status resolution needs only a fresh enum. Same two
          // queries, two different questions, two orders.
          // DISAGREEMENT between two healthy sources resolves to
          // `'unknown'`, not to the higher-ranked one (Codex r13 P2).
          //
          // The terminal-status trick does not transfer here: maturity
          // is not absorbing. An in-grace keeper extension re-stamps
          // `startTime`/`durationDays` and moves the due date FORWARD,
          // so a cached `past` can outlive the live term — and an
          // obligation transfer re-stamps it too, so a cached date can
          // equally be LATER than the truth. Neither direction is
          // safe, and this page tracks no per-query timestamps to
          // break the tie with.
          //
          // So when the two disagree we genuinely do not know which is
          // current, and the card's own doctrine applies: say so
          // rather than pick. `'unknown'` already blocks both rows
          // with an honest line and clears on the next refetch, and
          // the alternative — asserting `past` on a loan the contracts
          // would happily sell — is a wrong answer about the one fact
          // that closes both exits.
          maturity={(() => {
            const banner =
              bannerTerms.data && !bannerTerms.isError
                ? bannerNowSec >= termsEndSec
                  ? 'past'
                  : 'current'
                : undefined;
            const live =
              loanLive.data && !loanLive.isError
                ? // ADVANCED by local elapsed, exactly as the banner
                  // path does (Codex r20 P2). `chainNow` is frozen at
                  // the poll that fetched it, so on a 60-second cycle a
                  // snapshot taken shortly before maturity kept
                  // reporting `current` for up to a minute after the
                  // contracts had begun refusing — the fallback was
                  // reading a stopped clock.
                  //
                  // `dataUpdatedAt` is TanStack's own fetch stamp, so
                  // this needs no change to `readLoanLive`'s shape —
                  // which twelve other consumers share and none of them
                  // needed widening for a maturity question.
                  //
                  // Still chain-ANCHORED: the device supplies only the
                  // elapsed delta, never the absolute time, so a wrong
                  // device clock shifts the boundary by its drift
                  // rather than by its absolute error.
                  (loanLiveNowSec ?? loanLive.data.chainNow) >=
                  loanEndTimeOf(loanLive.data.live)
                  ? 'past'
                  : 'current'
                : undefined;
            if (banner !== undefined && live !== undefined) {
              return banner === live ? banner : 'unknown';
            }
            return banner ?? live ?? 'unknown';
          })()}
          // Chain-anchored, and only asserted when a live term is
          // actually known — an unread term must not claim the window
          // is too short (Codex r18 P2). Shares the tool's own
          // constant rather than mirroring it.
          listingWindowTooShort={(() => {
            // BOTH healthy sources, not the first one that answers
            // (Codex r26 P2). The neighbouring maturity branch already
            // reconciles them and this one did not — a preference
            // order, which is only sound when the sources cannot
            // disagree. They can: an obligation transfer SHORTENS the
            // loan, and these two queries refresh on different
            // intervals, so one healthy snapshot can be inside the
            // cutoff while the other is still pre-maturity.
            //
            // Where the maturity branch answers `'unknown'` on
            // disagreement, this one fails CLOSED — either healthy
            // source inside the cutoff blocks. The asymmetry is
            // deliberate: `maturity` feeds copy that must not assert a
            // due date it cannot establish, while this feeds an
            // availability verdict, and a false block is a row that
            // reads unavailable and clears on the next poll, against a
            // false offer that is a form filled in for a transaction
            // the tool's live preflight then rejects.
            const verdicts: boolean[] = [];
            if (bannerTerms.data && !bannerTerms.isError) {
              verdicts.push(
                termsEndSec > bannerNowSec &&
                  BigInt(termsEndSec - bannerNowSec) < MIN_SALE_LISTING_SECONDS,
              );
            }
            if (loanLive.data && !loanLive.isError) {
              const end = loanEndTimeOf(loanLive.data.live);
              // Advanced, not frozen — same clock as the maturity
              // branch above (Codex r22 P2).
              const now = loanLiveNowSec ?? loanLive.data.chainNow;
              verdicts.push(
                end > now && BigInt(end - now) < MIN_SALE_LISTING_SECONDS,
              );
            }
            // No healthy source: an unread term must not claim the
            // window is too short (Codex r18 P2). The maturity gate
            // covers the unknown case on its own.
            return verdicts.some(Boolean);
          })()}
          // Sync env read (`VITE_DISABLED_FLOWS`), no query behind it.
          listingFlowDisabled={flowDisabled('post-offer')}
          // EVERY prerequisite the anchored tools are gated on, not
          // just the fee read (Codex r6 P2). The Advanced block takes
          // its stand-in branch — omitting both anchors — on
          // `!loanLive.data || !sanctions.ready` as well, and needs
          // `principal` to mount at all, so keying only on `feeEnt`
          // reported ready while the anchors were absent. That showed
          // immediately on a Basic→Advanced switch and persisted
          // through a `loanLive` error.
          //
          // `loanLive` is required ONLY in Advanced, and that
          // asymmetry is the point rather than an oversight: the query
          // is disabled in Basic, so demanding it there would pin both
          // rows shut behind a read that is not running — the
          // permanent-dead-end trap this card has hit twice. In Basic
          // the mode-independent prerequisites are checkable and the
          // rest becomes knowable on the switch, where the tool block
          // states them itself.
          saleTools={
            // `isError` FIRST, before the `data === undefined` test
            // (Codex r16 P2). TanStack keeps the last success through a
            // failed refetch, so an errored-but-cached entitlement has
            // `data` defined — and round 14 made `lenderFeeModeFull`
            // reject exactly that record. Leaving this gate trusting it
            // meant one consumer distrusting the cache while its
            // sibling accepted it, on the same query: the rows opened
            // WITHOUT the Full-plan disclosure, which is the thing this
            // prerequisite exists to wait for. My own r14 fix created
            // that asymmetry by fixing one side of it.
            feeEnt.isError || feeEnt.data === undefined
              ? feeEnt.isError
                ? 'failed'
                : 'checking'
              : !principal
                ? // Codex r8 P2 — `principalMeta` exhausting its retry
                  // leaves `principal` undefined forever, and the
                  // Advanced block is gated on it too, so neither
                  // anchor ever mounts. Reporting that as "still
                  // reading the fee terms" was wrong twice over: wrong
                  // cause, and a wait that never ends.
                  // r9 P2 fixed the half I left: the wait was gone,
                  // the false cause was not — it still blamed a read
                  // that had SUCCEEDED.
                  principalMeta.isError
                  ? 'failed'
                  : 'checking'
                : !sanctions.ready
                  ? 'checking'
                : // Codex r10 P2 — a THIRD prerequisite, landing in the
                  // fee-terms sentence exactly as the token read had in
                  // r8. That is what settled the question: the failure
                  // states collapsed rather than growing a third name
                  // to keep straight. See `SaleToolsState`.
                  // `isError` disqualifies the cached snapshot, it does
                  // not merely rank below it (Codex r20 P2). TanStack
                  // retains `loanLive.data` through a failed refetch,
                  // so this said "ready" on a snapshot that may predate
                  // a partial repayment or an obligation transfer made
                  // elsewhere — and `LoanSaleFlow` would then render and
                  // confirm against obsolete principal and terms while
                  // its submit path silently re-read the changed values.
                  // A receipt the lender approved for different numbers
                  // than the ones that execute.
                  //
                  // Same rule the fee-entitlement and sale-lock gates
                  // already use; this was the third consumer of that
                  // rule and the one I kept missing.
                  isAdvanced && (!loanLive.data || loanLive.isError)
                  ? loanLive.isError
                    ? 'failed'
                    : 'checking'
                  : // A FOURTH prerequisite, and the only one that is
                    // not a query state (Codex r19 P2). `readLoanLive`
                    // deliberately returns data with
                    // `live.lenderForfeitFrom === undefined` when the
                    // optional seller-window call fails, so `loanLive`
                    // looks healthy while neither tool can price a
                    // sale: `EarlyExitFlow` resolves its candidates to
                    // unavailable and `LoanSaleFlow` disables both
                    // actions. Without this the chooser advertised two
                    // exits that cannot be started, and its jumps
                    // landed on cards offering nothing.
                    //
                    // `failed`, not `checking`: the window call has
                    // already failed and nothing is retrying it, so a
                    // waiting line would promise an answer that is not
                    // coming — the trap this card met three times.
                    //
                    // ONE hoisted verdict over all three `readLoanLive`
                    // callers (Codex r25 P2) — see `sellerWindowReadable`
                    // beside the status resolution. This site grew a
                    // clause per review round, one source at a time,
                    // which is the defect the card exists to prevent
                    // happening inside the card.
                    //
                    // `undefined` means no healthy source has answered
                    // yet, which the earlier arms already cover, so only
                    // an explicit `false` is a failure here.
                    sellerWindowReadable === false
                    ? 'failed'
                    : 'ready'
          }
          listingSupportedOnChain={loanSaleListingEnabled(readChain.chainId)}
          collateralIsNft={collateralIsNft}
          // Wait-row timing only: a partial repay pays the lender that
          // share plus its accrued interest DURING the term, so the
          // at-close wording is false for these loans (Codex r4 P2).
          allowsPartialRepay={row.allowsPartialRepay}
          // Mirrors the pending card's cancel gate — BOTH halves of it
          // (`state.offerId && state.isHolder`). The holder half fails
          // on its own: the hook's isolated `ownerOf` returns
          // `isHolder: false` on a read failure while a locally
          // remembered offer id stays verified, so keying on the id
          // alone promised a cancel that failure had already removed
          // (Codex r5 P2 for the id, r7 P2 for the holder).
          // A null `offerId` means two different things and only one
          // of them is "made elsewhere" (Codex r18 P2). When the link
          // read FAILED we could not tell, so telling the lender their
          // listing was created on another device is a fabricated
          // cause — and the same failure would otherwise have wiped the
          // local marker, taking the cancel path with it. Verification
          // failure maps to the unverified line, which says we cannot
          // confirm rather than naming a place.
          saleCancel={
            sale.state?.offerIdVerifyFailed === true
              ? 'no-unverified'
              : sale.state?.offerId == null
                ? 'no-elsewhere'
                : sale.state.isHolder === true
                  ? 'yes'
                  : 'no-unverified'
          }
          // Affirmative FallbackPending only (Codex r8 P2). Both sale
          // entry points require exactly Active, so the rows go — but
          // the card STAYS, because the status is not terminal and the
          // wait row is still the honest answer. An unread status is
          // not a fallback-pending one, so this never guesses.
          //
          // Health-checked on BOTH sources, and the healthy one wins
          // (Codex r9 P2). I applied this rule to `maturity` in r8 and
          // not here: a cached FallbackPending retained through a
          // failed refetch kept blocking both rows after the borrower
          // had cured the loan, even while the independent live-status
          // read said Active. A stale blocker is as wrong as a stale
          // permission — it just fails in the safe-looking direction.
          // ANY healthy source, not the ranked winner (Codex r21 P2).
          // The r20 fix made `saleAttemptable` fail closed on an
          // affirmative non-Active from any source — but left this
          // prop, and `saleTools`, reading the RANKED resolution. So
          // when the faster status poll saw FallbackPending while the
          // slower strategy read still served a cached Active, the
          // tools unmounted and the rows went on advertising both
          // exits, complete with the Basic-mode switch and jump
          // buttons pointing at blocks that were no longer there.
          //
          // I fixed the tool side and not the row side of the very
          // split this card exists to prevent.
          fallbackPending={liveStatusCandidates.some(
            (st) => st === LoanStatus.FallbackPending,
          )}
          // The companion fact `fallbackPending` cannot carry (#1855):
          // that prop is a `.some(...)`, so `false` means either "not
          // fallback" or "no read has answered". Only the readiness
          // attribute consults this; nothing rendered depends on it.
          //
          // EVERY enabled source, not any one of them (Codex #1858 r2).
          // The first version asked whether some candidate was defined,
          // which proves one query answered and says nothing about the
          // others — so `bannerTerms` returning Active first published a
          // settled `ready`/`yes`, and `liveStatus` could then arrive
          // with FallbackPending and flip it to `ready`/`no`. That is the
          // same self-unsettling verdict the prop was added to prevent,
          // reintroduced by measuring the wrong thing.
          statusSettled={statusSourcesSettled}
          maturitySettled={maturitySourcesSettled}
          maturityReadFailed={maturitySourcesFailed}
          statusReadFailed={statusSourcesFailed}
          // Tri-state, not a boolean (Codex r1 P2): `sale.state` is
          // undefined while the listing read is in flight and stays so
          // if it errors. Collapsing that to `false` showed BOTH sale
          // exits as available on a position whose lock had never been
          // checked — and the listing lock refuses both paths.
          // FOUR states, not three — see `SaleLockState`. The lock query
          // is gated on a valid lender position token, so with no such
          // token it never runs and its data is undefined FOREVER.
          // Folding that into 'checking' would pin both sale rows shut
          // behind a permanent spinner, which is the same
          // unknown-presented-as-known defect one door over. Distinguish
          // "no read is possible" from "the read has not answered".
          // Answers "might a buyer still complete", NOT "may I offer
          // the row" — see `listingMayStand`. An affirmative cached
          // listing keeps the COST lines up even when the poll that
          // would reconfirm it has errored, because the held balance
          // and the reward entry stay at risk until something proves
          // otherwise. Falls back to false only when we have never
          // seen a listing at all.
          listingMayStand={sale.state?.listed === true}
          saleLock={
            !loan.data?.lenderTokenId ||
            !/^[1-9]\d*$/.test(String(loan.data.lenderTokenId))
              ? 'unknown'
              : sale.state === undefined
                ? // A failed INITIAL read is `'unknown'`, not
                  // `'checking'` (Codex r13 P2). With no successful
                  // result to retain, "still checking" describes a
                  // read that has already given up — the
                  // permanent-spinner trap, in its third location.
                  // Reusing `'unknown'` rather than adding a seventh
                  // state: it already means "no claim, ask the tools",
                  // which is exactly right, and this card's review
                  // history is largely the cost of widening unions one
                  // case at a time.
                  // ...and `'unknown'` was the WRONG replacement
                  // (Codex r20 P2): the row builder treats it as
                  // non-blocking, so an initial failure on a position
                  // that may already carry a listing offered both rows
                  // and mounted both forms against submissions the
                  // contracts would refuse. "No claim" is right for a
                  // read that is not POSSIBLE and wrong for one that
                  // failed — the first cannot be retried, the second
                  // must fail closed. `'checking'` blocks and, unlike
                  // the spinner case r13 fixed, the query is live and
                  // retrying, so the wait genuinely does end.
                  sale.isError
                  ? 'checking'
                  : 'checking'
                : sale.state.listed === true
                  ? // Codex r10 P2 — this used to say a cached LISTED
                    // stays authoritative because "the lock clears only
                    // by cancel or teardown, both actions this device
                    // would see". The premise is false, and in two
                    // ways: a cancel can be made from ANOTHER device,
                    // and the expired-listing teardown is
                    // PERMISSIONLESS, so anyone at all can clear it.
                    // Neither reaches this browser, so a failed poll
                    // can leave `listed: true` cached over a position
                    // that is already free — blocking both exits,
                    // keeping the pending card, and naming sale losses
                    // as still pending.
                    //
                    // Symmetric with the cached-CLEAR case below, and
                    // for the identical reason: through a failed poll
                    // neither answer is evidence. Back to 'checking' —
                    // the read CAN answer, so it is a wait, not a dead
                    // end.
                    sale.isError
                    ? 'checking'
                    : 'listed'
                  : // A cached CLEAR does not (Codex r9 P2). Another
                    // device can list inside a failed-poll window, and
                    // offering both exits on a now-locked position
                    // sends the lender to a preflight refusal. Back to
                    // 'checking' — the read CAN answer, so it is a
                    // wait, not a dead end.
                    sale.isError
                    ? 'checking'
                    : 'clear'
          }
          // Free — the sale rows already wait on `feeEnt`, so reading
          // the stamp here adds no query. Defaults to false while the
          // read is absent, which is the safe direction for a COST
          // line: naming a loss that does not apply would be worse
          // than the row's existing silence, and the rows are held
          // unavailable until this read lands anyway.
          // `!isError` as well as `.data` (Codex r14 P2). TanStack
          // RETAINS the last success through a failed refetch, and
          // `repriceFeeEntitlementOnExtension` DOWNGRADES a lender Full
          // stamp to None when a keeper extends the loan in place — so
          // a cached Full record can outlive the plan it describes, and
          // the card would price a sunk original-term tariff as a cost
          // of selling. Falling back to silence is right for a cost
          // line: an unstated loss is a gap, a stated non-loss is a
          // false comparison the lender may act on.
          lenderFeeModeFull={
            feeEnt.data !== undefined &&
            !feeEnt.isError &&
            feeEnt.data.lenderMode === FEE_MODE_FULL
          }
          // See the prop's own note: no cheap client read exists for
          // the held-for-lender balance, so this stays false and the
          // refusal surfaces in the listing tool instead.
          heldVpfiUnresolved={false}
          // KNOWN GAP, deferred (Codex r1 P2). This is always false for
          // a lender today, and NOT because the enabled flag is set to
          // `role === 'borrower'` — `useOffsetPending` seeds from a
          // browser-LOCAL marker written by the borrower's own session,
          // so a lender's browser has nothing to read no matter how the
          // flag is set. Surfacing it needs a chain read of the
          // loan→offset-offer link, which is tracked with the other
          // deferred pre-checks. Until then the listing tool still
          // refuses `OffsetActiveOnLoan` correctly; the cost is a
          // wasted click, not a wrong action.
          // Passed as a LITERAL, not as `offsetPend.pending`: reading
          // the hook here would look wired while being structurally
          // false, which is the exact unknown-presented-as-known shape
          // this card keeps getting caught by. A literal makes the gap
          // legible to the next reader.
          borrowerOffsetPending={false}
          // 'unknown' on purpose — the candidate list comes from
          // `useActiveOffers`, a full page walk this page does not
          // otherwise make. Hoisting it would put that walk on every
          // lender who merely opens a position.
          instantSellCandidates="unknown"
        />
      ) : null}

      {/* Lender strategy — early exit by selling the position into a
          matching open lending offer. Same gate conventions as the
          borrower block: flagged wallets see nothing (Tier-1),
          checking/error states are visible, the full card requires
          the live loan and pre-maturity by chain time. The done
          message goes to the PAGE banner (the role flips to viewer
          as soon as the ownership read refreshes, unmounting this
          block). */}
      {isAdvanced &&
      // `isLenderHolder`, not `role` — same reason as the chooser
      // above, and they MUST use the same test or a dual-position
      // holder sees rows with no tools behind them.
      isLenderHolder &&
      // NOT the raw indexed row — see `saleAttemptable`. The chooser's
      // rows and this block must agree, or a row is offered with
      // nothing behind it.
      saleAttemptable &&
      !soldThisSession &&
      !isRental &&
      principal &&
      !(sanctions.ready && sanctions.flagged) ? (
        // Errored cached terms are NOT a basis for the full form —
        // same rule as the readiness verdict above (Codex r20 P2).
        !loanLive.data || loanLive.isError || !sanctions.ready ? (
          <section className="card">
            <h3>{copy.earlyExit.title}</h3>
            <p className="muted">
              {loanLive.isError
                ? copy.earlyExit.checkFailed
                : copy.earlyExit.checking}
            </p>
          </section>
        ) : salePending ? (
          // A live sale listing owns the lender's exit story — the
          // pending card below explains and offers cancel/restore.
          null
        ) : (loanLiveNowSec ?? loanLive.data.chainNow) <
          loanLive.data.live.startTime +
            loanLive.data.live.durationDays * 86_400n ? (
          // `isError` too, not just absence (Codex r19 P2). TanStack
          // retains the last success through a failed refetch, so this
          // branch let both FORMS mount on a cached entitlement the
          // chooser above had already classified as failed — and the
          // stale record can misdescribe a Full plan an in-place
          // extension already removed. The chooser saying "cannot
          // start" while its destinations stay actionable is the same
          // rows-versus-tools split as r12 and r13, on a third
          // prerequisite.
          feeEnt.isError || feeEnt.data === undefined ? (
            // Codex #1412 r4 (P3) — the travels-with-the-NFT note is
            // part of the sale disclosure set for a Full-stamped
            // position, so the sale CTAs hold until the fee-
            // entitlement read settles (or shows its failed state) —
            // same rule as the borrower preclose disclosure.
            <section className="card">
              <p className="muted" style={{ margin: 0 }}>
                {feeEnt.isError
                  ? copy.tariff.saleDisclosureFailed
                  : copy.tariff.saleDisclosureChecking}
              </p>
            </section>
          ) : (
          <>
          {feeEnt.data.lenderMode === FEE_MODE_FULL ? (
            // #1355 / Codex #1412 r2 — the Full fee mode is loan-scoped
            // and keyed to the position's current holder, so a sale
            // carries it to the buyer. Said BEFORE both sale surfaces
            // (the instant early-exit sale below completes inside its
            // own card, so a note after it would arrive too late).
            <div className="banner banner-info" role="note">
              <span className="banner-body">{copy.tariff.nftTravelNote}</span>
            </div>
          ) : null}
          {/* Anchor for the Layer-1 chooser's "sell now" jump. The flow
              renders its own card, so the id lives on a wrapper rather
              than being threaded through as a prop. */}
          <div id="early-exit-card">
          <EarlyExitFlow
            row={row}
            live={loanLive.data.live}
            chainNow={loanLive.data.chainNow}
            principalMeta={principal}
            confirmOpen={confirmingSurface === 'early-exit'}
            onOpenConfirm={() => setConfirmingSurface('early-exit')}
            onCloseConfirm={() =>
              setConfirmingSurface((s) => (s === 'early-exit' ? null : s))
            }
            onSold={() => {
              setSoldThisSession(true);
              setDoneMessage(copy.earlyExit.done);
            }}
            busy={busy}
            setBusy={setBusy}
          />
          </div>
          {/* Anchor for the chooser's "list it" jump. */}
          <section className="card" id="loan-sale-card">
            {/* NFT collateral joins the network gate rather than
                getting a branch of its own (Codex r13 P2). The chooser
                already marks the listing row unavailable for it, but
                this block mounted the full form regardless, and
                `EarlyWithdrawalFacet:275-281` rejects every submission
                with `SaleOfferCollateralMustBeERC20` — the chooser and
                its own destination contradicting each other, which is
                the round-12 dead end with the surfaces swapped. */}
            {loanSaleListingEnabled(readChain.chainId) && !collateralIsNft ? (
              <LoanSaleFlow
                row={row}
                live={loanLive.data.live}
                principalMeta={principal}
                confirmOpen={confirmingSurface === 'loan-sale'}
                onOpenConfirm={() => setConfirmingSurface('loan-sale')}
                onCloseConfirm={() =>
                  setConfirmingSurface((s) => (s === 'loan-sale' ? null : s))
                }
                onListed={(offerId) => {
                  sale.remember(offerId);
                  setDoneMessage(copy.loanSale.done);
                }}
                busy={busy}
                setBusy={setBusy}
              />
            ) : (
              // Issue #951 — the on-chain listing entry point reverts
              // today; an honest note beats a form whose final wallet
              // step can never succeed.
              // NFT collateral gets its own sentence: the network
              // case is temporary and the collateral case is a scope
              // limit, so one message cannot serve both without
              // misdescribing one of them.
              <>
                <h3 style={{ marginBottom: 4 }}>{copy.loanSale.title}</h3>
                <p className="muted" style={{ margin: 0 }}>
                  {collateralIsNft
                    ? copy.lenderExit.options.listUnavailableNft
                    : copy.loanSale.listingUnavailable}
                </p>
              </>
            )}
          </section>
          </>
          )
        ) : null
      ) : null}

      {/* The live sale listing's standing surface — chain-authoritative
          (positionLock), outside the strategy gates so it survives
          data hiccups, mode switches, and other-device listings. */}
      {sale.state?.listed &&
      !isRental &&
      address &&
      // Bound to the wallet the settlement pull binds to — a
      // non-holder on the listing device must not see funding
      // verdicts (or grant approvals) for someone else's sale.
      // `isLenderHolder` joins the test (Codex r20 P2). The chooser
      // tells a lender their position is already listed and points at
      // THIS card — so if it does not mount, the row names a control
      // that is not there. For a dual-position holder `role` is
      // `borrower`, and the hook's independent `ownerOf` can fail on
      // its own, so both existing halves could be false while the
      // page's own owner read had already confirmed lender ownership.
      (isLenderHolder || role === 'lender' || sale.state.isHolder) ? (
        <LoanSalePendingCard
          loanId={row.loanId}
          lenderTokenId={row.lenderTokenId}
          state={sale.state}
          principalAsset={row.lendingAsset as `0x${string}`}
          principalMeta={principal ?? undefined}
          busy={busy}
          setBusy={setBusy}
          onCleared={sale.clear}
          onDone={setDoneMessage}
        />
      ) : null}

      {/* The live request's standing surface — rendered on the MARKER
          alone, outside every strategy gate (mode, loanLive
          readiness, sanctions, loan status, maturity): the banner,
          funding watch, and cancel affordance must survive all of
          those windows, including the loan settling another way. */}
      {/* The live offset's standing surface — rendered on the CHAIN's
          say-so (PrecloseOffset lock), outside every strategy gate,
          same rationale as the refinance pending card below. */}
      {offsetPend.pending && !isRental && role === 'borrower' ? (
        <OffsetPendingCard
          loanId={row.loanId}
          borrowerTokenId={row.borrowerTokenId}
          offerId={offsetPend.offerId}
          state={offsetPend.state}
          principalAsset={row.lendingAsset as `0x${string}`}
          principalMeta={principal ?? undefined}
          busy={busy}
          setBusy={setBusy}
          onCleared={offsetPend.clear}
          onDone={setDoneMessage}
        />
      ) : null}

      {refi.offerId &&
      !isRental &&
      address &&
      address.toLowerCase() === row.borrower.toLowerCase() ? (
        <RefinancePendingCard
          loanId={row.loanId}
          offerId={refi.offerId}
          state={refi.state}
          principalAsset={row.lendingAsset as `0x${string}`}
          principalMeta={principal ?? undefined}
          busy={busy}
          setBusy={setBusy}
          onCleared={refi.clear}
          onDone={setDoneMessage}
        />
      ) : null}

      {/* Per-loan keeper enables — third leg of the keeper trio
          (Settings holds the master switch + whitelist). Either
          confirmed position holder can flip it; hidden entirely when
          the viewer has no approved keepers. */}
      {isAdvanced &&
      (role === 'borrower' || role === 'lender') &&
      row.status === 'active' &&
      !closedThisSession &&
      !soldThisSession &&
      // Same scope as every lifecycle card keepers can drive here —
      // alpha02 offers none of those flows on rentals, so arming
      // keepers for one would be a switch with no in-app story.
      !isRental ? (
        <LoanKeeperCard loanId={row.loanId} busy={busy} setBusy={setBusy} />
      ) : null}

      {doneMessage ? (
        <div className="banner banner-info" role="status">
          <CircleCheck aria-hidden />
          <span className="banner-body">{doneMessage}</span>
        </div>
      ) : null}
      {busy ? (
        <div className="banner banner-info" role="status">
          <span className="banner-body">
            {phase === 'approving'
              ? copy.positions.details.phase.approving
              : phase === 'submitting'
                ? copy.positions.details.phase.submitting
                : copy.positions.details.phase.waiting}
          </span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}

      {action === 'repay' && (saleCompletionPending || saleHoldResolving) && !isRental ? (
        // Accepted-sale completion window (Codex #1511 r4 P1): repay
        // is normally the never-blocked safety valve, but here it
        // would terminalize the loan under the buyer's committed
        // funds and permanently strand the recovery completion. The
        // window is momentary (post-refresh acceptance auto-completes
        // atomically; this state is the legacy mid-flight shape).
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">
            {saleCompletionPending
              ? copy.saleHold.completionPaused
              : copy.earlyRepay.checkingInterlocks}
          </span>
        </div>
      ) : actionLabel && action && actionReceipt ? (
        confirmingSurface === 'action' ? (
          // Position writes go through the SAME six-row review surface
          // as every other write flow — the wallet prompt is never the
          // first place the user sees what a click will do.
          <section className="card" id="repay-action">
            <ConfirmReceipt
              busy={busy}
              confirmLabel={copy.positions.details.confirmAction(actionLabel)}
              onBack={() => setConfirmingSurface(null)}
              onConfirm={() => void run(action)}
              // wallet/public client hydrate async after connect —
              // without this the first click lands in run()'s early
              // return and silently does nothing.
              disabled={
                !onSupportedChain ||
                !walletClient ||
                !publicClient ||
                (action !== 'repay' && !sanctionsClear)
              }
              data={actionReceipt}
            >
              {action === 'repay' && refinancePending && !isRental ? (
                // Repay stays open with a pending refinance request
                // (it's the safety valve — never block it), but the
                // request's fate must be stated before signing.
                <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                  <span className="banner-body">
                    {copy.refinance.repayWarnPending}
                  </span>
                </div>
              ) : null}
              {action === 'repay' && saleAcceptedOnFallback && !isRental ? (
                // Stated, not enforced: the linked purchase is already
                // stranded by the fallback state, so this settlement
                // is the borrower's to make — but it decides the
                // purchase's fate, so say so before they sign.
                <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                  <span className="banner-body">
                    {copy.saleHold.acceptedOnFallback}
                  </span>
                </div>
              ) : null}
              {action === 'repay' && offsetPend.pending && !isRental ? (
                // Same rule for a live offset: repay stays open (the
                // safety valve), but settling this way strands the
                // linked offset offer — say so before signing.
                <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                  <span className="banner-body">
                    {copy.offset.blockedOtherPaths}
                  </span>
                </div>
              ) : null}
            </ConfirmReceipt>
          </section>
        ) : (
          <button
            type="button"
            id="repay-action"
            className="btn btn-primary btn-block"
            disabled={
              busy ||
              !onSupportedChain ||
              (action !== 'repay' && !sanctionsClear)
            }
            onClick={() => setConfirmingSurface('action')}
          >
            {actionLabel}
          </button>
        )
      ) : role === 'unverified' ? (
        <div className="banner banner-warn" role="alert">
          <ShieldQuestion aria-hidden />
          <span className="banner-body">
            {copy.positions.details.roleUnverified}
          </span>
        </div>
      ) : role === 'viewer' ? (
        <div className="banner banner-info">
          <ShieldQuestion aria-hidden />
          <span className="banner-body">
            {copy.positions.details.connectToAct}
          </span>
        </div>
      ) : role === 'checking' ? (
        // UX-025 — while the on-chain role read is in flight, render a
        // disabled placeholder instead of nothing, so a borrower
        // mid-repay sees the action is coming rather than a receipt with
        // no button beneath it.
        <button type="button" className="btn btn-primary btn-block" disabled>
          {copy.positions.details.confirmingRole}
        </button>
      ) : null}

      <p className="muted">
        <Link to="/positions">{copy.positions.details.backToPositions}</Link>
      </p>
    </div>
  );
}
