import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { L as Link } from "../components/L";
import { useTranslation } from "react-i18next";
import { useWallet } from "../context/WalletContext";
import { useMode } from "../context/ModeContext";
import { useDiamondContract, useDiamondRead } from "../contracts/useDiamond";
import { useERC20 } from "../contracts/useERC20";
import { useLoan } from "../hooks/useLoan";
import { useLoanCollateralLien } from "../hooks/useLoanCollateralLien";
import { useKeeperStatus } from "../hooks/useKeeperStatus";
import {
  LoanStatus,
  AssetType,
  Liquidity,
  LOAN_STATUS_LABELS,
  ASSET_TYPE_LABELS,
  LIQUIDITY_LABELS,
} from "../types/loan";
import { decodeContractError } from "@vaipakam/lib/decodeContractError";
import { beginStep } from "../lib/journeyLog";
import { getLoanActionAvailability } from "../lib/loanActions";
import { DEFAULT_CHAIN } from "../contracts/config";
import {
  ArrowLeft,
  ExternalLink,
  AlertTriangle,
  CheckCircle,
  Clock,
  Coins,
  Wallet,
} from "lucide-react";
import { parseUnits, encodeFunctionData, type Address, type Hex } from "viem";
import { SimulationPreview } from "../components/app/SimulationPreview";
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from "@vaipakam/contracts/abis";
import { AssetLink } from "../components/app/AssetLink";
import { TokenAmount } from "../components/app/TokenAmount";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { bpsToPercent, formatDate } from "../lib/format";
import { AddressDisplay } from "../components/app/AddressDisplay";
import { PerThingKeeperToggles } from "../components/app/PerThingKeeperToggles";
import AutoLifecycleLoanCapsCard from "../components/app/AutoLifecycleLoanCapsCard";
import { HealthFactorGauge, LTVBar } from "../components/app/RiskGauge";
import { LiquidationProjection } from "../components/app/LiquidationProjection";
import { LenderDiscountCard } from "../components/app/LenderDiscountCard";
import { LiquidateButton } from "../components/app/LiquidateButton";
import { ClaimActionBar } from "../components/app/ClaimActionBar";
import { LoanTimeline } from "../components/app/LoanTimeline";
import { SanctionsBanner } from "../components/app/SanctionsBanner";
import { CardInfo } from "../components/CardInfo";
import { PeriodicInterestCheckpointCard } from "../components/loanDetails/PeriodicInterestCheckpointCard";
import { CollateralLienCard } from "../components/loanDetails/CollateralLienCard";
import { PrepayListingBanner } from "../components/loanDetails/PrepayListingBanner";
import { PrepayListingActions } from "../components/loanDetails/PrepayListingActions";
import { OpenSeaOffersSection } from "../components/loanDetails/OpenSeaOffersSection";
import { SwapToRepayPanel } from "../components/loanDetails/SwapToRepayPanel";
import { SwapToRepayIntentPanel } from "../components/loanDetails/SwapToRepayIntentPanel";
import { useNFTPrepayListing } from "../hooks/useNFTPrepayListing";
import "./LoanDetails.css";

export default function LoanDetails() {
  const { t } = useTranslation();
  const { loanId } = useParams();
  const { address, chainId, activeChain, isCorrectChain } = useWallet();
  // Active-chain Diamond + explorer, falling back to DEFAULT_CHAIN when the
  // wallet is disconnected or on an unsupported chain. Used for approvals
  // (must target the right Diamond) and for explorer deep-links (must match
  // the chain the user's tx actually landed on).
  const activeDiamondAddr =
    (activeChain && isCorrectChain ? activeChain.diamondAddress : null) ??
    DEFAULT_CHAIN.diamondAddress;
  const activeBlockExplorer =
    (activeChain && isCorrectChain ? activeChain.blockExplorer : null) ??
    DEFAULT_CHAIN.blockExplorer;
  const { mode } = useMode();
  const showAdvanced = mode === "advanced";
  const diamond = useDiamondContract();
  const {
    loan,
    lenderHolder,
    borrowerHolder,
    loading,
    error,
    reload: loadLoan,
  } = useLoan(loanId);
  // #564 D.1 — on-chain collateral lien backing this loan, surfaced in the
  // CollateralLienCard below the Collateral & Risk card for both parties.
  // `reloadLien` is re-pulled after any on-chain mutation that changes the
  // lien (add-collateral increments it; repay / default / preclose /
  // refinance / claim release it) so the card never goes stale.
  const { lien: collateralLien, reload: reloadLien } =
    useLoanCollateralLien(loanId);
  // Convenience composite for the panel/hook success callbacks that take a
  // single `onAfterSuccess`: refresh the loan state AND the lien card in
  // one go after any mutation that may have changed the lien.
  const loadLoanAndLien = useCallback(() => {
    loadLoan();
    reloadLien();
  }, [loadLoan, reloadLien]);
  // Per README §3 lines 190–191 keeper authority follows the current
  // Phase 6: the old "whitelist-status" two-layer summary lived next to
  // the per-side keeper bools on the loan struct. Both are gone; the new
  // `LoanKeeperPicker` renders live per-keeper state directly so the
  // useKeeperStatus hook is no longer consumed here. Kept the import
  // path intact for potential future reuse on other surfaces.
  useKeeperStatus(lenderHolder || null, borrowerHolder || null);
  // Signer-connected ERC-20 contracts for the loan's principal / collateral
  // assets. Used to read decimals() and to approve the Diamond before repay
  // and add-collateral, which pull tokens via safeTransferFrom.
  const principalErc20 = useERC20(loan?.principalAsset ?? null);
  const collateralErc20 = useERC20(loan?.collateralAsset ?? null);

  // Action state
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<ReactNode | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [repayConfirming, setRepayConfirming] = useState(false);
  const [addCollateralAmt, setAddCollateralAmt] = useState("");

  // Live LTV / Health Factor from RiskFacet. Both scale to 1e18 on-chain.
  const [ltv, setLtv] = useState<bigint | null>(null);
  const [hf, setHf] = useState<bigint | null>(null);
  const [riskError, setRiskError] = useState<string | null>(null);
  // A loan with at least one illiquid leg has no defined LTV / HF — calling
  // `calculateLTV` / `calculateHealthFactor` reverts with
  // `IlliquidLoanNoRiskMath`. Detect that up front from the loan struct's
  // own liquidity flags so we can skip the multicall and render the
  // dedicated explainer instead of letting a contract revert bubble up
  // as raw error text.
  const isIlliquidLoan = !!loan && (
    Number(loan.principalLiquidity) !== 0 ||
    Number(loan.collateralLiquidity) !== 0
  );
  useEffect(() => {
    let cancelled = false;
    if (!loan || !loanId) {
      setLtv(null);
      setHf(null);
      return;
    }
    if (isIlliquidLoan) {
      // No on-chain price for at least one leg — risk math is undefined.
      // Clear any prior values so the explainer renders cleanly.
      setLtv(null);
      setHf(null);
      setRiskError(null);
      return;
    }
    (async () => {
      setRiskError(null);
      try {
        const [ltvRaw, hfRaw] = await Promise.all([
          diamond.calculateLTV(BigInt(loanId)) as Promise<bigint>,
          diamond.calculateHealthFactor(BigInt(loanId)) as Promise<bigint>,
        ]);
        if (cancelled) return;
        setLtv(ltvRaw);
        setHf(hfRaw);
      } catch (err) {
        if (cancelled) return;
        setLtv(null);
        setHf(null);
        setRiskError(
          decodeContractError(err, t('loanDetails.riskMetricsUnavailable')),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loan, loanId, diamond, isIlliquidLoan, t]);

  const ltvPercent = ltv === null ? null : Number(ltv) / 1e16;
  const hfScaled = hf === null ? null : Number(hf) / 1e18;

  // Native NFT locking keeps the position NFT with its owner throughout
  // strategic flows, so authority is a plain ownerOf match.
  const isHolder = (holder: string): boolean => {
    if (!address || !holder) return false;
    return holder.toLowerCase() === address.toLowerCase();
  };
  const isLender = !!loan && isHolder(lenderHolder);
  const isBorrower = !!loan && isHolder(borrowerHolder);
  const isActive = !!loan && Number(loan.status) === LoanStatus.Active;
  const isFallbackPending =
    !!loan && Number(loan.status) === LoanStatus.FallbackPending;
  // Borrower may still cure via full repay or collateral top-up while
  // FallbackPending (until the lender finalizes the claim).
  const canAct = isActive || isFallbackPending;

  const endTime = loan
    ? Number(loan.startTime) + Number(loan.durationDays) * 86400
    : 0;
  const now = Math.floor(Date.now() / 1000);
  const isOverdue = now > endTime && isActive;
  const daysRemaining = isActive
    ? Math.max(0, Math.ceil((endTime - now) / 86400))
    : 0;

  const role: "lender" | "borrower" | undefined = isLender
    ? "lender"
    : isBorrower
      ? "borrower"
      : undefined;
  const ctxBase = {
    wallet: address,
    chainId,
    loanId: loanId ?? undefined,
    role,
  };

  // T-086 step 13 — indexer-backed listing state. Owned by the page so
  // a SINGLE hook instance feeds both the banner (everyone) and the
  // action group (borrower). Wiring `onAfterSuccess` to `loadLoan` here
  // means a successful post/update/cancel also re-pulls the on-chain
  // loan + holders state in the same await chain as the hook's own
  // indexer reload — so banner state, action mode, and on-chain reads
  // all switch over atomically. Codex caught the dual-hook variant on
  // PR #308 review; this is the single-source-of-truth fix.
  const prepayListing = useNFTPrepayListing(loanId, {
    onAfterSuccess: loadLoan,
  });
  const prepayListingState = prepayListing.listing;

  // T-086 — read live grace seconds for the loan's duration tier so we
  // can render the prepay-listing action up to (and including) the grace
  // window, matching `NFTPrepayListingFacet.postPrepayListing`'s strict
  // `block.timestamp < endTime + gracePeriod(durationDays)` upper bound.
  // A read failure (older deploy / RPC blip) leaves `graceSeconds` null;
  // the gate then collapses to `!isOverdue`, hiding the surface the
  // moment the loan goes overdue — a safe default that just causes a
  // small UX miss inside the grace window.
  const [prepayGraceSeconds, setPrepayGraceSeconds] = useState<bigint | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    if (!loan) return;
    (async () => {
      try {
        const d = diamond as unknown as {
          getEffectiveGraceSeconds: (durationDays: bigint) => Promise<bigint>;
        };
        const g = await d.getEffectiveGraceSeconds(BigInt(loan.durationDays));
        if (!cancelled) setPrepayGraceSeconds(g);
      } catch {
        if (!cancelled) setPrepayGraceSeconds(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diamond, loan]);
  // Tick state — bumps `nowSec` once per minute (cheap) so the
  // grace-boundary comparison below re-evaluates if the user leaves
  // the page mounted across the boundary crossing. Without this, a
  // page opened pre-grace would keep showing the action surface
  // forever even after `now >= endTime + gracePeriod`. Codex P3 fix
  // round 3 on PR #308.
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);
  // When the live grace read fails, collapse to the `isOverdue`
  // fallback so the child receives the same conservative gate the
  // availability context uses. Without this, an overdue loan with no
  // live listing on a chain where the read is failing would render
  // the post form despite the diamond rejecting post/update past
  // grace. Codex round-3 P2 fix on PR #308.
  const pastPrepayGrace =
    prepayGraceSeconds === null
      ? isOverdue
      : !!loan &&
        BigInt(nowSec) >= BigInt(endTime) + prepayGraceSeconds;

  const availability = getLoanActionAvailability({
    status: loan ? Number(loan.status) : -1,
    role: role ?? "none",
    isOverdue,
    assetType: loan ? Number(loan.assetType) : -1,
    collateralAssetType: loan ? Number(loan.collateralAssetType) : -1,
    allowsPrepayListing: !!loan && Boolean(loan.allowsPrepayListing),
    pastPrepayGrace:
      prepayGraceSeconds === null
        ? // Fallback: collapse to `isOverdue` when the live read failed.
          isOverdue
        : pastPrepayGrace,
    showAdvanced,
    walletConnected: !!address,
  });

  // RepayFacet/AddCollateralFacet pull tokens via safeTransferFrom, so the
  // caller must approve the Diamond for at least `needed` before submitting.
  const ensureErc20Allowance = async (
    token: ReturnType<typeof useERC20>,
    needed: bigint,
  ) => {
    if (!token || !address || needed === 0n) return;
    const diamondAddr = activeDiamondAddr;
    const current = (await token.allowance(address, diamondAddr)) as bigint;
    if (current >= needed) return;
    const tx = await token.approve(diamondAddr, needed);
    await tx.wait();
  };

  const handleRepay = async () => {
    if (!loan) return;
    setRepayConfirming(false);
    setActionLoading(true);
    setActionError(null);
    setTxHash(null);
    const step = beginStep({
      ...ctxBase,
      area: "repay",
      flow: "repayLoan",
      step: "submit-tx",
    });
    // T-086 — gate the prepay-sale friendly-error detection on
    // BOTH the post-revert Settled status AND the fact that the
    // page-level state knew about a live OpenSea listing for this
    // loan at the moment of the repay click. Codex round-1 P2 fix
    // on PR #318 — without this guard, ANY repay attempt on an
    // already-Settled loan (e.g. user navigated to a stale tab
    // after the loan was claimed and Settled by another flow)
    // would surface the OpenSea sale message. ClaimFacet,
    // LibLifecycle's Repaid→Settled / Defaulted→Settled / InternalMatched→Settled
    // edges all use Settled too. Gating on the live listing
    // snapshot ensures the message only fires for the actual
    // race scenario the user is most likely encountering.
    const hadLiveListing = !!prepayListingState;
    try {
      // ERC-20 loans: principal + interest (+ lateFee) are pulled from the
      // caller at repay time. NFT rental loans use prepay and generally
      // return 0 here (lateFee aside), so allowance is a no-op for them.
      const totalDue = (await diamond.calculateRepaymentAmount(
        BigInt(loanId!),
      )) as bigint;
      if (Number(loan.assetType) === AssetType.ERC20 && totalDue > 0n) {
        await ensureErc20Allowance(principalErc20, totalDue);
      }
      const tx = await diamond.repayLoan(BigInt(loanId!));
      setTxHash(tx.hash);
      await tx.wait();
      loadLoan();
      // Repay releases the collateral lien — refresh the card.
      reloadLien();
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      // T-086 — when the borrower's repay races a buyer's
      // Seaport.fulfillOrder in the same block and the buyer's tx wins
      // EVM ordering, the loan flips to Settled (prepay sale waterfall
      // routed the proceeds directly to the lender + treasury + the
      // wallet holding the borrower-position NFT — Seaport
      // consideration[2].recipient). The borrower's repay reverts
      // `InvalidLoanStatus()` from RepayFacet; the generic decode
      // would surface "loan not Active" which doesn't tell the
      // borrower what actually happened.
      const friendly = await maybeDecodePrepaySaleSettlement(hadLiveListing);
      setActionError(friendly ?? decodeContractError(err, "Repayment failed"));
      step.failure(err);
      // Refresh the page-level loan state so the banner + actions
      // card switch to the post-Settled view. Also refresh the lien —
      // a race-lost repay may have transitioned the loan terminal
      // (e.g. prepay-sale settlement), releasing the lien.
      loadLoan();
      reloadLien();
    } finally {
      setActionLoading(false);
    }
  };

  /** Detect the "loan was settled via Seaport prepay sale" terminal
   *  outcome. Returns the tailored JSX message on hit, `null`
   *  otherwise so the caller falls through to the generic
   *  `decodeContractError`.
   *
   *  Two-pronged gate (Codex round-1 P2 on PR #318):
   *    1. `hadLiveListing` — the page-level prepay-listing snapshot
   *       was non-null when the repay click started. Without this,
   *       any stale-tab repay on an already-Settled loan (e.g.
   *       reached Settled via ClaimFacet / a LibLifecycle edge from
   *       Repaid / Defaulted / InternalMatched) would mis-attribute
   *       the outcome to a prepay sale.
   *    2. Post-revert chain read confirms `status === Settled`.
   *
   *  Combined, the gate is essentially deterministic for the actual
   *  race scenario this PR addresses.
   */
  const maybeDecodePrepaySaleSettlement = async (
    hadLiveListing: boolean,
  ): Promise<ReactNode | null> => {
    if (!hadLiveListing) return null;
    try {
      const refreshed = (await diamond.getLoanDetails(
        BigInt(loanId!),
      )) as { status: bigint };
      if (Number(refreshed.status) !== LoanStatus.Settled) return null;
      // No /claims link — the Seaport order routes the borrower
      // remainder DIRECTLY to the wallet currently holding the
      // borrower-position NFT (`pctx.borrowerNftOwner` in
      // `LibPrepayOrder._components.consideration[2].recipient`).
      // `ClaimFacet.claimAsBorrower` also rejects Settled loans, so
      // sending the user to /claims would show nothing for them to
      // collect. The message instead explains the direct-route.
      // Codex round-1 P2 fix on PR #318.
      return <span>{t('loanDetails.repayPrepaySaleMessage')}</span>;
    } catch {
      // Fall through to the generic decode if the read fails. Users
      // would see the generic "Repayment failed" message and can
      // refresh manually.
      return null;
    }
  };

  const handleAddCollateral = async () => {
    if (!addCollateralAmt || !loan) return;
    setActionLoading(true);
    setActionError(null);
    setTxHash(null);
    const step = beginStep({
      ...ctxBase,
      area: "add-collateral",
      flow: "addCollateral",
      step: "submit-tx",
    });
    try {
      // Read the collateral's on-chain decimals so "100" in the form maps to
      // 100 whole tokens whether the asset is 6-decimal (USDC) or 18-decimal.
      let decimals = 18;
      if (collateralErc20) {
        try {
          decimals = Number(await collateralErc20.decimals());
        } catch {
          // Fall back to 18 if the token is non-standard / doesn't expose decimals().
        }
      }
      const amount = parseUnits(addCollateralAmt, decimals);
      await ensureErc20Allowance(collateralErc20, amount);
      const tx = await diamond.addCollateral(BigInt(loanId!), amount);
      setTxHash(tx.hash);
      await tx.wait();
      loadLoan();
      // Add-collateral increments the on-chain lien — refresh the card.
      reloadLien();
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setActionError(decodeContractError(err, "Add collateral failed"));
      step.failure(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleTriggerDefault = async () => {
    setActionLoading(true);
    setActionError(null);
    setTxHash(null);
    const step = beginStep({
      ...ctxBase,
      area: "liquidation",
      flow: "triggerDefault",
      step: "submit-tx",
    });
    try {
      // Phase 7a: triggerDefault now takes a ranked AdapterCall[] try-list.
      // This simple "Trigger Default" button is a grace-period-expired
      // fallback path — we submit an empty array so the swap chain
      // short-circuits to FallbackPending (illiquid collateral path or
      // lender-claim route). Users wanting an optimized swap-based
      // default should use the `LiquidateButton` on the same page,
      // which fetches quotes from all DEX venues first.
      const tx = await (
        diamond as unknown as {
          triggerDefault: (
            id: bigint,
            calls: { adapterIdx: bigint; data: `0x${string}` }[],
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).triggerDefault(BigInt(loanId!), []);
      setTxHash(tx.hash);
      await tx.wait();
      loadLoan();
      // Default releases / transfers the collateral — refresh the lien.
      reloadLien();
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setActionError(decodeContractError(err, "Trigger default failed"));
      step.failure(err);
    } finally {
      setActionLoading(false);
    }
  };

  // Phase 6: per-keeper per-loan enable toggle. Authority for the call
  // binds to the current lender or borrower NFT owner (contract checks);
  // msg.sender only needs to own one of the two NFTs. The keeper must
  // already be on the caller's global whitelist (approveKeeper) with the
  // relevant action bits.
  const handleToggleLoanKeeper = async (keeper: string, nextEnabled: boolean) => {
    setActionLoading(true);
    setActionError(null);
    setTxHash(null);
    const step = beginStep({
      ...ctxBase,
      area: "keeper",
      flow: "setLoanKeeperEnabled",
      step: "submit-tx",
    });
    try {
      const tx = await (
        diamond as unknown as {
          setLoanKeeperEnabled: (
            loanId: bigint,
            keeper: string,
            enabled: boolean,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).setLoanKeeperEnabled(BigInt(loanId!), keeper, nextEnabled);
      setTxHash(tx.hash);
      await tx.wait();
      loadLoan();
      step.success({
        note: `tx ${tx.hash} keeper=${keeper} enabled=${nextEnabled}`,
      });
    } catch (err) {
      setActionError(
        decodeContractError(err, "Update loan keeper enable failed"),
      );
      step.failure(err);
    } finally {
      setActionLoading(false);
    }
  };

  // Phase 4 polish — every page inside `<AppLayout>` requires a
  // connected wallet. LoanDetails used to render the full panel
  // read-only pre-connect (since loan state is public on-chain), but
  // the post-batch UX direction is "all in-app pages are wallet-gated;
  // public Analytics is the read-only surface". This avoids two sources
  // of truth for chain selection (read chain vs wallet chain) and
  // matches the rest of the in-app empty-state pattern.
  if (!address) {
    return (
      <div className="empty-state" style={{ minHeight: "60vh" }}>
        <div className="empty-state-icon">
          <Wallet size={28} />
        </div>
        <h3>{t('loanDetails.connectTitle')}</h3>
        <p>{t('loanDetails.connectBody')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: "60vh" }}>
        <p>{t('loanDetails.loadingLoan', { id: loanId })}</p>
      </div>
    );
  }

  if (error || !loan) {
    return (
      <div className="empty-state" style={{ minHeight: "60vh" }}>
        <div
          className="empty-state-icon"
          style={{
            background: "rgba(239,68,68,0.1)",
            color: "var(--accent-red)",
          }}
        >
          <AlertTriangle size={28} />
        </div>
        <h3>{t('loanDetails.loanNotFound')}</h3>
        <p>{error || t('loanDetails.loanNotFoundBody', { id: loanId })}</p>
        <Link to="" className="btn btn-secondary btn-sm">
          <ArrowLeft size={16} /> {t('loanDetails.backToDashboard')}
        </Link>
      </div>
    );
  }

  return (
    <div className="loan-details">
      <Link to="" className="back-link">
        <ArrowLeft size={16} /> {t('loanDetails.backToDashboard')}
      </Link>

      {address && (
        <SanctionsBanner
          address={address as `0x${string}`}
          label={t('banners.sanctionsLabelWallet')}
        />
      )}

      <div className="loan-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Loan #{loan.id.toString()}
            <CardInfo id="loan-details.overview" />
          </h1>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <span
              className={`status-badge ${LOAN_STATUS_LABELS[Number(loan.status) as LoanStatus].toLowerCase()}`}
            >
              {LOAN_STATUS_LABELS[Number(loan.status) as LoanStatus]}
            </span>
            {isLender && (
              <span className="status-badge lender">{t('loanDetails.youAreLender')}</span>
            )}
            {isBorrower && (
              <span className="status-badge borrower">{t('loanDetails.youAreBorrower')}</span>
            )}
            {isOverdue && (
              <span className="status-badge defaulted">{t('loanDetails.overdue')}</span>
            )}
          </div>
        </div>
        {isActive && (
          <div className="loan-countdown">
            <Clock size={18} />
            <span>{t('loanDetails.daysRemaining', { count: daysRemaining })}</span>
          </div>
        )}
      </div>

      <ClaimActionBar
        loan={loan}
        lenderHolder={lenderHolder ? lenderHolder.toLowerCase() : null}
        borrowerHolder={borrowerHolder ? borrowerHolder.toLowerCase() : null}
        address={address ? address.toLowerCase() : null}
        chainId={chainId}
        blockExplorer={activeBlockExplorer}
        onClaimed={() => {
          // A claim is the terminal release of the collateral lien —
          // refresh both the loan state and the lien card together.
          loadLoan();
          reloadLien();
        }}
      />

      {/* T-086 step 13 — live prepay-listing state. Visible to everyone
          (lender/borrower/third-party) when a Seaport listing is live; the
          borrower's management surface (update/cancel) lives in the
          Actions card below. */}
      {prepayListingState && (
        <PrepayListingBanner
          listing={prepayListingState}
          principalAsset={loan.principalAsset}
          chainId={chainId ?? DEFAULT_CHAIN.chainId}
          collateralAsset={loan.collateralAsset}
          collateralTokenId={loan.collateralTokenId}
        />
      )}

      {isLender && Number(loan.assetType) === AssetType.ERC20 && (
        <div style={{ marginBottom: 16 }}>
          <LenderDiscountCard
            loanId={loanId ?? null}
            lender={loan.lender}
          />
        </div>
      )}

      {/* T-092 #511 sub (#521) — per-loan auto-refinance + auto-extend
          caps editor. Visible to the borrower-NFT owner (refinance +
          extend-borrower caps) and the lender-NFT owner (extend-lender
          caps). The card hides itself when the AutoLifecycle facet
          isn't readable on the current chain. */}
      {(isBorrower || isLender) && (
        <AutoLifecycleLoanCapsCard
          loanId={BigInt(loanId ?? '0')}
          isBorrower={isBorrower}
          isLender={isLender}
          // T-092-B (#531) — NFT collateral has asymmetric default
          // outcome (full collateral transfer to lender on default,
          // no swap). The card surfaces a stark warning so the
          // borrower / lender consciously consents.
          collateralIsNft={
            Number(loan.collateralAssetType) === AssetType.ERC721 ||
            Number(loan.collateralAssetType) === AssetType.ERC1155
          }
          // T-092 (#545) — pass the loan's endTime so the card can
          // render the in-grace-window pre-grace warning when
          // applicable. Defaults to 0 (no warning) for non-active
          // loans.
          loanEndTime={isActive ? endTime : 0}
        />
      )}

      {isBorrower && Number(loan.assetType) === AssetType.ERC20 && (
        <div
          className="card"
          style={{
            marginBottom: 16,
            borderColor: "var(--brand)",
            background: "rgba(79, 70, 229, 0.06)",
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <Coins
              size={18}
              style={{ color: "var(--brand)", flexShrink: 0, marginTop: 2 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>
                Planning your next borrow? Enable the platform VPFI consent to
                save up to 24%
              </div>
              <p className="stat-label" style={{ margin: "0 0 8px" }}>
                Stake VPFI into your Vaipakam Vault on this chain and flip the
                platform-level VPFI consent once on your Dashboard. Future
                liquid loans will auto-settle the tier-discounted fee in VPFI.
                Need VPFI?{" "}
                <a href="/buy-vpfi" target="_blank" rel="noopener noreferrer">
                  Buy VPFI
                </a>{" "}
                (buy from your preferred chain — routing is handled for you).
              </p>
              <Link to="" className="btn btn-secondary btn-sm">
                Enable consent on Dashboard
              </Link>
            </div>
          </div>
        </div>
      )}

      {actionError && <ErrorAlert message={actionError} />}

      {txHash && (
        <div className="alert alert-success">
          <CheckCircle size={18} />
          <span>
            Transaction submitted:{" "}
            <a
              href={`${activeBlockExplorer}/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "underline" }}
            >
              {txHash.slice(0, 20)}...
            </a>
          </span>
        </div>
      )}

      {/* T-034 PR2 — Periodic Interest Payment checkpoint card. Hidden
          when the loan's cadence is None (today's terminal-only flow);
          visible above the main loan grid otherwise so the upcoming
          period and its expected interest are the FIRST thing the user
          sees on the loan detail page. The "Pay now" button (visible
          to the borrower when shortfall > 0) scrolls to the existing
          partial-repay surface lower on the page — `repayPartial`
          settles the accrued interest as part of any principal-
          reduction call, so a single small partial repay closes the
          period when timed past the boundary. */}
      <PeriodicInterestCheckpointCard
        loanId={BigInt(loanId!)}
        principalAsset={loan.principalAsset}
        isBorrower={role === 'borrower'}
        onPayNowClick={() => {
          const el = document.getElementById('loan-actions-card');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      />

      {/* Loan details grid */}
      <div className="loan-grid">
        <div className="card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('loanDetails.loanTerms')}
            <CardInfo id="loan-details.terms" />
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.principal')}</span>
            <span className="data-value mono">
              <TokenAmount
                amount={loan.principal}
                address={loan.principalAsset}
              />
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.principalAsset')}</span>
            <span
              className="data-value"
              style={{ color: "var(--brand)" }}
            >
              {Number(loan.assetType) === 0 ? (
                <AssetLink
                  kind="erc20"
                  chainId={chainId ?? 0}
                  address={loan.principalAsset}
                />
              ) : (
                <AssetLink
                  kind="nft"
                  chainId={chainId ?? 0}
                  address={loan.principalAsset}
                  tokenId={loan.tokenId ?? 0n}
                />
              )}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.interestRateApr')}</span>
            <span className="data-value">
              {bpsToPercent(loan.interestRateBps)}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.duration')}</span>
            <span className="data-value">
              {loan.durationDays.toString()} {t('loanDetails.daysSuffix')}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.startDate')}</span>
            <span className="data-value">
              {formatDate(Number(loan.startTime) * 1000)}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.endDate')}</span>
            <span className="data-value">
              {formatDate(endTime * 1000)}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.assetType')}</span>
            <span className="data-value">
              {ASSET_TYPE_LABELS[Number(loan.assetType) as AssetType]}
            </span>
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('loanDetails.collateralAndRisk')}
            <CardInfo id="loan-details.collateral-risk" role={role} />
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.collateralAmount')}</span>
            <span className="data-value mono">
              <TokenAmount
                amount={loan.collateralAmount}
                address={loan.collateralAsset}
              />
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.collateralAsset')}</span>
            <span
              className="data-value"
              style={{ color: "var(--brand)" }}
            >
              {Number(loan.collateralAssetType) === 0 ? (
                <AssetLink
                  kind="erc20"
                  chainId={chainId ?? 0}
                  address={loan.collateralAsset}
                />
              ) : (
                <AssetLink
                  kind="nft"
                  chainId={chainId ?? 0}
                  address={loan.collateralAsset}
                  tokenId={loan.collateralTokenId ?? 0n}
                />
              )}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.principalLiquidity')}</span>
            <span
              className={`status-badge ${loan.principalLiquidity === 0n ? "active" : "defaulted"}`}
            >
              {LIQUIDITY_LABELS[Number(loan.principalLiquidity) as Liquidity]}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.collateralLiquidity')}</span>
            <span
              className={`status-badge ${loan.collateralLiquidity === 0n ? "active" : "defaulted"}`}
            >
              {LIQUIDITY_LABELS[Number(loan.collateralLiquidity) as Liquidity]}
            </span>
          </div>
          {isIlliquidLoan ? (
            <div className="data-row">
              <span className="data-label">{t('loanDetails.risk')}</span>
              <span
                className="data-value"
                style={{ fontSize: "0.85rem", lineHeight: 1.45 }}
              >
                {t('loanDetails.illiquidRiskExplainer')}
              </span>
            </div>
          ) : (
            <>
              <div className="data-row">
                <span className="data-label">{t('loanDetails.ltv')}</span>
                <LTVBar percent={ltvPercent} />
              </div>
              <div className="data-row">
                <span className="data-label">{t('loanDetails.healthFactor')}</span>
                <HealthFactorGauge value={hfScaled} />
              </div>
              {riskError && (
                <div className="data-row">
                  <span className="data-label">{t('loanDetails.risk')}</span>
                  <span
                    className="data-value"
                    style={{ color: "var(--text-tertiary)", fontSize: "0.78rem" }}
                  >
                    {riskError}
                  </span>
                </div>
              )}
            </>
          )}
          {/* Phase 8a.2: liquidation-price projection + what-if sliders.
              Derived from the live HF; auto-hidden when HF is null
              (NFT rental / illiquid / oracle gap). */}
          {Number(loan.assetType) === 0 && (
            <LiquidationProjection
              loan={{
                principal: loan.principal,
                collateralAmount: loan.collateralAmount,
                principalAsset: loan.principalAsset,
                collateralAsset: loan.collateralAsset,
                // Lender-opt-in gate — drives whether the partial-repay
                // slider renders. Loan struct carries the flag from
                // the source offer; default false matches contract.
                allowsPartialRepay:
                  (loan as { allowsPartialRepay?: boolean }).allowsPartialRepay ??
                  false,
              }}
              hfScaled={hfScaled}
              collateralDecimals={18}
              principalDecimals={18}
            />
          )}
          {/* Phase 6: per-keeper per-loan enable picker. Shown whenever the
              viewer is an NFT holder for either side of the loan. For each
              keeper on the viewer's global whitelist, the checkbox reflects
              `isLoanKeeperEnabled(loanId, keeper)` and toggling calls
              `setLoanKeeperEnabled`. Empty whitelist deep-links to
              KeeperSettings — the "no keepers added yet, add some there"
              onboarding nudge. Keepers still need (a) the relevant action
              bit set on the viewer's global whitelist and (b) the viewer's
              master switch on before they can actually drive anything. */}
          {(isLender || isBorrower) && canAct && (
            <LoanKeeperPicker
              loanId={BigInt(loanId!)}
              actionLoading={actionLoading}
              onToggle={handleToggleLoanKeeper}
            />
          )}
        </div>

        {/* #564 D.1 — collateral-lien card. Shown to either loan party;
            renders nothing when there is no live lien. Passes the page's
            existing `role` so lender/borrower see role-specific copy.
            #564 D.3 (NFT metadata) is contract/worker-side, out of scope
            here. */}
        {(isLender || isBorrower) && (
          <CollateralLienCard
            lien={collateralLien}
            blockExplorer={activeBlockExplorer}
            role={role}
          />
        )}

        <div className="card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('loanDetails.parties')}
            <CardInfo id="loan-details.parties" />
          </div>
          <div className="data-row">
            <span className="data-label">{t('common.lender')}</span>
            <a
              href={`${activeBlockExplorer}/address/${loan.lender}`}
              target="_blank"
              rel="noreferrer"
              className="data-value"
              style={{ color: "var(--brand)", fontSize: "0.82rem" }}
            >
              <AddressDisplay address={loan.lender} withTooltip copyable /> <ExternalLink size={12} />
            </a>
          </div>
          <div className="data-row">
            <span className="data-label">{t('common.borrower')}</span>
            <a
              href={`${activeBlockExplorer}/address/${loan.borrower}`}
              target="_blank"
              rel="noreferrer"
              className="data-value"
              style={{ color: "var(--brand)", fontSize: "0.82rem" }}
            >
              <AddressDisplay address={loan.borrower} withTooltip copyable /> <ExternalLink size={12} />
            </a>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.lenderNftId')}</span>
            <Link
              to={`/nft-verifier?contract=${activeDiamondAddr}&id=${loan.lenderTokenId.toString()}`}
              target="_blank"
              rel="noopener noreferrer"
              className="data-value mono"
              data-tooltip="Verify on-chain metadata (opens in new tab)"
              style={{ color: "var(--brand)", display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              #{loan.lenderTokenId.toString()}
              <ExternalLink size={12} />
            </Link>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.borrowerNftId')}</span>
            <Link
              to={`/nft-verifier?contract=${activeDiamondAddr}&id=${loan.borrowerTokenId.toString()}`}
              target="_blank"
              rel="noopener noreferrer"
              className="data-value mono"
              data-tooltip="Verify on-chain metadata (opens in new tab)"
              style={{ color: "var(--brand)", display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              #{loan.borrowerTokenId.toString()}
              <ExternalLink size={12} />
            </Link>
          </div>
          <div className="data-row">
            <span className="data-label">{t('loanDetails.originalOffer')}</span>
            <span className="data-value">
              <Link to={`/offers/${loan.offerId.toString()}`}>
                #{loan.offerId.toString()}
              </Link>
            </span>
          </div>
        </div>
      </div>

      {/* Actions */}
      {availability.repay && (
        <div id="loan-actions-card" className="card loan-actions-card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('loanDetails.actions')}
            <CardInfo id="loan-details.actions" role={role} />
          </div>

          {isFallbackPending && (
            <div className="alert alert-warning" style={{ marginBottom: 12 }}>
              <AlertTriangle size={18} />
              <span>
                {t('loanDetails.fallbackPendingAlertPrefix')}{" "}
                <strong>{t('loanDetails.fallbackPendingLabel')}</strong>.{" "}
                {isBorrower
                  ? t('loanDetails.fallbackPendingBorrower')
                  : t('loanDetails.fallbackPendingLender')}
              </span>
            </div>
          )}

          <div className="action-group">
            <h4 className="action-title">{t('loanDetails.repayLoan')}</h4>
            <p className="action-desc">
              {isBorrower
                ? t('loanDetails.repayDescBorrower')
                : t('loanDetails.repayDescOther')}
            </p>
            {!isBorrower && (
              <div className="alert alert-warning" style={{ marginBottom: 12 }}>
                <AlertTriangle size={18} />
                <span>
                  {t('loanDetails.repayNonBorrowerWarning', { tokenId: loan.borrowerTokenId.toString() })}
                </span>
              </div>
            )}

            {!repayConfirming ? (
              <div className="action-row">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setRepayConfirming(true)}
                  disabled={actionLoading}
                >
                  {t('loanDetails.repayInFull')}
                </button>
              </div>
            ) : (
              <div
                className="alert alert-warning"
                style={{ display: "block", marginBottom: 0 }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    marginBottom: 8,
                  }}
                >
                  <AlertTriangle size={18} />
                  <strong>{t('loanDetails.confirmFullRepayment')}</strong>
                </div>
                <div className="data-row">
                  <span className="data-label">{t('loanDetails.loanLabel')}</span>
                  <span className="data-value">#{loan.id.toString()}</span>
                </div>
                <p style={{ marginTop: 8 }}>
                  {t('loanDetails.repayConfirmBody')}
                </p>
                {!isBorrower && (
                  <p style={{ marginTop: 8 }}>
                    <strong>{t('loanDetails.repayConfirmReminderHead')}</strong>{' '}
                    {t('loanDetails.repayConfirmReminderBody', { tokenId: loan.borrowerTokenId.toString() })}
                  </p>
                )}
                {/* ET-001 — pre-sign eth_call preflight of the pending repay tx. */}
                <RepaySimulationPreview
                  loanId={BigInt(loanId!)}
                  diamondAddr={activeDiamondAddr as Address}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleRepay}
                    disabled={actionLoading}
                  >
                    {actionLoading ? t('loanDetails.processing') : t('loanDetails.confirmAndRepay')}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setRepayConfirming(false)}
                    disabled={actionLoading}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* T-090 #403 — borrower-initiated swap-to-repay. Mirrors
              the on-chain `SwapToRepayFacet.swapToRepayFull` gating
              EXACTLY so we never show a button that would always
              revert:
              - borrower-NFT-owner authority (Sub 1 Codex round-1 P1 #3)
              - NOT also the lender-side holder OR the original
                `loan.lender` (Codex PR #409 round-2 P2 #1 +
                round-3 P2 #1 — the contract checks BOTH the current
                lender-NFT holder AND `loan.lender` for the
                self-repay guard; the original lender could have
                transferred the lender NFT away and later landed on
                the borrower NFT)
              - Active status only (FallbackPending rejected on-chain)
              - NOT past grace (contract reverts
                `RepaymentPastGracePeriod`; round-2 P2 #3 + round-3
                P2 #2 — the panel re-checks at submit-click time to
                close the up-to-60s stale-minute-tick window)
              - both asset types ERC20 (P2 #4 Sub 1)
              - both legs Liquid (`UnsupportedLoanShape` otherwise) */}
          {isBorrower &&
            !isLender &&
            !!loan.lender &&
            !!address &&
            address.toLowerCase() !== loan.lender.toLowerCase() &&
            isActive &&
            !pastPrepayGrace &&
            !isIlliquidLoan &&
            Number(loan.assetType) === AssetType.ERC20 &&
            Number(loan.collateralAssetType) === AssetType.ERC20 &&
            activeDiamondAddr && (
              <SwapToRepayPanel
                loanId={BigInt(loanId!)}
                chainId={chainId ?? DEFAULT_CHAIN.chainId}
                collateralAsset={loan.collateralAsset as Address}
                collateralAmount={loan.collateralAmount}
                principalAsset={loan.principalAsset as Address}
                diamondAddress={activeDiamondAddr as Address}
                graceUntilSec={
                  prepayGraceSeconds === null
                    ? endTime
                    : endTime + Number(prepayGraceSeconds)
                }
                actionLoading={actionLoading}
                onActionLoadingChange={setActionLoading}
                onAfterSuccess={loadLoanAndLien}
              />
            )}

          {/* T-090 v1.1 (#389) Sub 3 (#418) — best-price intent
              variant. Same eligibility gates as the atomic
              SwapToRepayPanel above (the on-chain v1.1 facet
              re-enforces identical conditions: ERC20-on-ERC20,
              both legs Liquid, not past grace, lender exclusion,
              not lender-NFT holder). Both panels render
              simultaneously; the borrower picks atomic vs
              best-price per-swap.

              Codex round-1 PR #423 P2 — the `!pastPrepayGrace`
              clause is intentionally OMITTED here (vs the atomic
              panel) because if the borrower committed an intent
              that gets clamped close to grace end, they MUST
              keep a path to `cancelSwapToRepayIntent` even after
              `pastPrepayGrace` flips. The panel surfaces its
              own internal pending-state read; commit submission
              still reverts on-chain when the deadline check
              fails (the contract enforces deadline <= grace), so
              there is no risk of accidentally committing post-grace.
          */}
          {isBorrower &&
            !isLender &&
            !!loan.lender &&
            !!address &&
            address.toLowerCase() !== loan.lender.toLowerCase() &&
            isActive &&
            !isIlliquidLoan &&
            Number(loan.assetType) === AssetType.ERC20 &&
            Number(loan.collateralAssetType) === AssetType.ERC20 &&
            activeDiamondAddr && (
              <SwapToRepayIntentPanel
                loanId={BigInt(loanId!)}
                chainId={chainId ?? DEFAULT_CHAIN.chainId}
                collateralAsset={loan.collateralAsset as Address}
                collateralAmount={loan.collateralAmount}
                principalAsset={loan.principalAsset as Address}
                principalAmount={loan.principal}
                diamondAddress={activeDiamondAddr as Address}
                graceUntilSec={
                  prepayGraceSeconds === null
                    ? endTime
                    : endTime + Number(prepayGraceSeconds)
                }
                actionLoading={actionLoading}
                onActionLoadingChange={setActionLoading}
                onAfterSuccess={loadLoanAndLien}
              />
            )}

          {availability.addCollateral && (
            <div className="action-group">
              <h4 className="action-title">{t('loanDetails.addCollateral')}</h4>
              <p className="action-desc">
                {isFallbackPending
                  ? t('loanDetails.addCollateralFallbackDesc')
                  : t('loanDetails.addCollateralNormalDesc')}
              </p>
              <div className="action-row">
                <input
                  className="form-input"
                  type="number"
                  step="any"
                  min="0"
                  placeholder={t('loanDetails.amountToAdd')}
                  value={addCollateralAmt}
                  onChange={(e) => setAddCollateralAmt(e.target.value)}
                />
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleAddCollateral}
                  disabled={actionLoading || !addCollateralAmt}
                >
                  {actionLoading ? t('loanDetails.processing') : t('loanDetails.addCollateral')}
                </button>
              </div>
              {/* ET-001 — pre-sign eth_call preflight of the pending
                  addCollateral tx. Hides silently when the amount input
                  is empty or doesn't parse. */}
              <AddCollateralSimulationPreview
                loanId={BigInt(loanId!)}
                amountRaw={addCollateralAmt}
                diamondAddr={activeDiamondAddr as Address}
              />
            </div>
          )}

          {/* Phase 7a — HF-based liquidation with on-the-fly quote
              orchestration across 0x / 1inch / UniswapV3 / Balancer V2.
              Surfaces for any HF-liquidatable Active loan (HF < 1).
              Renders above the "Trigger Default" card since HF-based
              liquidation is the faster path when both apply. */}
          {isActive &&
            hf !== null &&
            hf < 10n ** 18n &&
            activeDiamondAddr && (
              <div className="action-group">
                <h4 className="action-title">{t('loanDetails.liquidateHfLt1')}</h4>
                <p className="action-desc">{t('loanDetails.liquidateHfDesc')}</p>
                <LiquidateButton
                  loanId={BigInt(loanId!)}
                  chainId={chainId ?? 0}
                  collateralAsset={loan.collateralAsset as Address}
                  collateralAmount={loan.collateralAmount}
                  principalAsset={loan.principalAsset as Address}
                  diamondAddress={activeDiamondAddr as Address}
                />
              </div>
            )}

          {availability.triggerDefault && (
            <div className="action-group">
              <h4 className="action-title">{t('loanDetails.triggerDefault')}</h4>
              <p className="action-desc">{t('loanDetails.triggerDefaultDesc')}</p>
              <button
                className="btn btn-primary btn-sm"
                style={{ background: "var(--accent-red)" }}
                onClick={handleTriggerDefault}
                disabled={actionLoading}
              >
                {actionLoading ? t('loanDetails.processing') : t('loanDetails.triggerDefault')}
              </button>
            </div>
          )}

          {availability.earlyWithdrawal && (
            <div className="action-group">
              <h4 className="action-title">{t('loanDetails.earlyWithdrawal')}</h4>
              <p className="action-desc">{t('loanDetails.earlyWithdrawalDesc')}</p>
              <div className="action-row">
                <Link
                  to={`/loans/${loan.id.toString()}/early-withdrawal`}
                  className="btn btn-primary btn-sm"
                >
                  {t('loanDetails.initiateEarlyWithdrawal')}
                </Link>
              </div>
            </div>
          )}

          {availability.preclose && (
            <>
              <div className="action-group">
                <h4 className="action-title">{t('loanDetails.preclose')}</h4>
                <p className="action-desc">{t('loanDetails.precloseDesc')}</p>
                <div className="action-row">
                  <Link
                    to={`/loans/${loan.id.toString()}/preclose`}
                    className="btn btn-primary btn-sm"
                  >
                    {t('loanDetails.openPrecloseFlow')}
                  </Link>
                </div>
              </div>
              <div className="action-group">
                <h4 className="action-title">{t('loanDetails.refinance')}</h4>
                <p className="action-desc">{t('loanDetails.refinanceDesc')}</p>
                <div className="action-row">
                  <Link
                    to={`/loans/${loan.id.toString()}/refinance`}
                    className="btn btn-primary btn-sm"
                  >
                    {t('loanDetails.openRefinanceFlow')}
                  </Link>
                </div>
              </div>
            </>
          )}

        </div>
      )}

      {/* T-086 step 13 — Seaport prepay listing surface. Rendered
          OUTSIDE the `availability.repay` wrapper so a stale listing
          still has a cancel button after the loan transitions away
          from Active — the on-chain `cancelPrepayListing`
          intentionally has no status gate. The component owns its
          own card wrapper so its `return null` (past-grace + no
          listing, or still loading) doesn't leave an empty card in
          the DOM. Codex round-4 P3 fix on PR #308. The page-level
          gate also drops the surface entirely while the indexer
          fetch is in flight (`prepayListing.loading`) — `listing
          === null` is the hook's documented loading sentinel; we
          mustn't briefly show post mode on a loan that already
          has a live listing. Codex round-4 P3 fix on PR #308. */}
      {address &&
        isBorrower &&
        !prepayListing.loading &&
        prepayListingState !== null &&
        (availability.prepayListing || !!prepayListingState) && (
          <PrepayListingActions
            loanId={BigInt(loanId!)}
            principalAsset={loan.principalAsset}
            borrowerTokenId={loan.borrowerTokenId}
            prepayListing={prepayListing}
            hasLiveListing={!!prepayListingState}
            pastPrepayGrace={pastPrepayGrace}
            loanIsActive={isActive}
          />
        )}

      {/* T-086 Round-5 Block C (#309 Mode B) — OpenSea Offers
          section for the pragmatic English-auction flow. Mounted
          right after the prepay-listing actions card so the borrower
          sees the actions surface AND the live offers panel on the
          same scroll. Read-side polling lives inside the section
          itself; matching an offer rotates the canonical Seaport
          order via `prepayListing.updatePrepayListing`. v1 ships
          the fee-free path; fee-enforced collection support is a
          follow-up that re-fetches the OpenSea schedule at match
          time. */}
      {/* Codex P2 review #328 — also gate on !pastPrepayGrace.
          `availability.prepayListing` intentionally stays true
          post-grace so the borrower can still CANCEL stale
          listings, but `updatePrepayListing` reverts once
          `block.timestamp >= gracePeriodEnd`. Showing an enabled
          Match button after grace would produce guaranteed-to-
          revert transactions; we drop the offers section entirely
          + let the borrower use the cancel path inside the
          actions card. */}
      {address &&
        isBorrower &&
        !prepayListing.loading &&
        prepayListingState !== null &&
        availability.prepayListing &&
        !pastPrepayGrace &&
        typeof chainId === 'number' && (
          <OpenSeaOffersSection
            loanId={BigInt(loanId!)}
            chainId={chainId}
            principalAsset={loan.principalAsset}
            collateralAsset={loan.collateralAsset}
            collateralTokenId={loan.collateralTokenId}
            collateralQuantity={loan.collateralQuantity}
            prepayListing={prepayListing}
          />
        )}

      {/* Per-loan keeper toggles (gate 3 of the Phase-6 keeper auth
          model). Each NFT holder sees their own whitelist's keepers
          with the per-loan flag inline — toggling here writes the
          shared `loanKeeperEnabled[loanId][keeper]` flag. Per-side
          authority is enforced at call time by each side's own
          action-bitmask, so showing both cards (when the connected
          wallet holds both NFTs) is correct: each lists keepers
          from msg.sender's whitelist. */}
      {isLender && lenderHolder && (
        <PerThingKeeperToggles
          kind="loan"
          loanId={loan.id}
          ownerAddress={lenderHolder}
          side="lender"
        />
      )}
      {isBorrower && borrowerHolder && (
        <PerThingKeeperToggles
          kind="loan"
          loanId={loan.id}
          ownerAddress={borrowerHolder}
          side="borrower"
        />
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('loanTimeline.title')}
          <CardInfo id="loan-details.timeline" />
        </div>
        <p className="stat-label" style={{ margin: '0 0 12px' }}>
          {t('loanTimeline.subtitle')}
        </p>
        <LoanTimeline
          loanId={loan.id.toString()}
          blockExplorer={activeBlockExplorer}
          principalAsset={loan.principalAsset ?? null}
          collateralAsset={loan.collateralAsset ?? null}
        />
      </div>
    </div>
  );
}


interface LoanKeeperPickerProps {
  loanId: bigint;
  actionLoading: boolean;
  onToggle: (keeper: string, enabled: boolean) => Promise<void> | void;
}

/**
 * Per-loan per-keeper enable picker (Phase 6). Reads the connected
 * user's global whitelist via `getApprovedKeepers` and renders one
 * checkbox per keeper, bound to `isLoanKeeperEnabled(loanId, keeper)`.
 * Empty whitelist shows a deep-link prompt to add keepers on the
 * KeeperSettings page — closes the "how do I get a keeper enabled on
 * this loan" flow-of-control gap.
 */
function LoanKeeperPicker({ loanId, actionLoading, onToggle }: LoanKeeperPickerProps) {
  const { t } = useTranslation();
  const { address } = useWallet();
  const diamondRo = useDiamondRead();
  const [keepers, setKeepers] = useState<string[]>([]);
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = [...((await diamondRo.getApprovedKeepers(address)) as string[])];
        if (cancelled) return;
        setKeepers(list);
        const map: Record<string, boolean> = {};
        for (const k of list) {
          try {
            const on = (await (
              diamondRo as unknown as {
                isLoanKeeperEnabled: (id: bigint, keeper: string) => Promise<boolean>;
              }
            ).isLoanKeeperEnabled(loanId, k)) as boolean;
            map[k.toLowerCase()] = on;
          } catch {
            map[k.toLowerCase()] = false;
          }
        }
        if (!cancelled) setEnabledMap(map);
      } catch {
        if (!cancelled) setKeepers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, diamondRo, loanId, refreshTick]);

  return (
    <div className="data-row" style={{ flexDirection: "column", alignItems: "flex-start" }}>
      <span className="data-label" style={{ marginBottom: 8 }}>
        {t('loanDetails.keeperDelegation')}
      </span>
      {loading ? (
        <span style={{ fontSize: "0.82rem", opacity: 0.7 }}>{t('loanDetails.loadingKeepers')}</span>
      ) : keepers.length === 0 ? (
        <div style={{ fontSize: "0.82rem", opacity: 0.8 }}>
          {t('loanDetails.noKeepersWhitelistPrefix')}{' '}
          <Link to="/keepers" style={{ color: "var(--brand)" }}>
            {t('loanDetails.noKeepersWhitelistLink')}
          </Link>{' '}
          {t('loanDetails.noKeepersWhitelistSuffix')}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.82rem" }}>
          {keepers.map((k) => {
            const on = enabledMap[k.toLowerCase()] ?? false;
            return (
              <label
                key={k}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={actionLoading}
                  onChange={async () => {
                    await onToggle(k, !on);
                    setRefreshTick((t) => t + 1);
                  }}
                />
                <span style={{ fontSize: "0.78rem", fontFamily: 'var(--font-mono, monospace)' }}>
                  <AddressDisplay address={k} withTooltip copyable />
                </span>
              </label>
            );
          })}
          <div style={{ fontSize: "0.72rem", opacity: 0.65 }}>
            {t('loanDetails.keeperHintPrefixA')}{' '}
            <Link to="/keepers" style={{ color: "var(--brand)" }}>
              {t('loanDetails.keeperHintGlobalWhitelist')}
            </Link>{' '}
            {t('loanDetails.keeperHintSuffix')}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ET-001 — pre-sign eth_call preflight for the pending `repayLoan`
 * tx on this loan. No form state needed beyond the loan
 * id; the exact
 * repay amount is resolved inside the contract from stored state.
 */
function RepaySimulationPreview({
  loanId,
  diamondAddr,
}: {
  loanId: bigint;
  diamondAddr: Address;
}) {
  const data = encodeFunctionData({
    abi: DIAMOND_ABI,
    functionName: "repayLoan",
    args: [loanId],
  }) as Hex;
  return (
    <SimulationPreview tx={{ to: diamondAddr, data, value: 0n }} />
  );
}

/**
 * ET-001 — pre-sign eth_call preflight for the pending
 * `addCollateral` tx. Waits for the amount input to parse
 * successfully before running the eth_call — avoids spamming the
 * RPC while the user is mid-typing.
 */
function AddCollateralSimulationPreview({
  loanId,
  amountRaw,
  diamondAddr,
}: {
  loanId: bigint;
  amountRaw: string;
  diamondAddr: Address;
}) {
  let data: Hex | null = null;
  try {
    if (amountRaw) {
      // Default to 18 decimals; exact conversion happens on-chain.
      // Preview only needs the calldata to be valid ABI.
      const amount = parseUnits(amountRaw, 18);
      if (amount > 0n) {
        data = encodeFunctionData({
          abi: DIAMOND_ABI,
          functionName: "addCollateral",
          args: [loanId, amount],
        }) as Hex;
      }
    }
  } catch {
    data = null;
  }
  return (
    <SimulationPreview tx={data ? { to: diamondAddr, data, value: 0n } : null} />
  );
}
