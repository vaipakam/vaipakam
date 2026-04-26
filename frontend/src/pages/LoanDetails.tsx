import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useWallet } from "../context/WalletContext";
import { useMode } from "../context/ModeContext";
import { useDiamondContract, useDiamondRead } from "../contracts/useDiamond";
import { useERC20 } from "../contracts/useERC20";
import { useLoan } from "../hooks/useLoan";
import { useKeeperStatus } from "../hooks/useKeeperStatus";
import {
  LoanStatus,
  AssetType,
  Liquidity,
  LOAN_STATUS_LABELS,
  ASSET_TYPE_LABELS,
  LIQUIDITY_LABELS,
} from "../types/loan";
import { decodeContractError } from "../lib/decodeContractError";
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
} from "lucide-react";
import { parseUnits, encodeFunctionData, type Address, type Hex } from "viem";
import { SimulationPreview } from "../components/app/SimulationPreview";
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from "../contracts/abis";
import { AssetSymbol } from "../components/app/AssetSymbol";
import { TokenAmount } from "../components/app/TokenAmount";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { bpsToPercent } from "../lib/format";
import { AddressDisplay } from "../components/app/AddressDisplay";
import { HealthFactorGauge, LTVBar } from "../components/app/RiskGauge";
import { LiquidationProjection } from "../components/app/LiquidationProjection";
import { LenderDiscountCard } from "../components/app/LenderDiscountCard";
import { LiquidateButton } from "../components/app/LiquidateButton";
import { CardInfo } from "../components/CardInfo";
import "./LoanDetails.css";

export default function LoanDetails() {
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [repayConfirming, setRepayConfirming] = useState(false);
  const [addCollateralAmt, setAddCollateralAmt] = useState("");

  // Live LTV / Health Factor from RiskFacet. Both scale to 1e18 on-chain.
  const [ltv, setLtv] = useState<bigint | null>(null);
  const [hf, setHf] = useState<bigint | null>(null);
  const [riskError, setRiskError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!loan || !loanId) {
      setLtv(null);
      setHf(null);
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
          decodeContractError(
            err,
            "Risk metrics unavailable (illiquid position)",
          ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loan, loanId, diamond]);

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

  const availability = getLoanActionAvailability({
    status: loan ? Number(loan.status) : -1,
    role: role ?? "none",
    isOverdue,
    assetType: loan ? Number(loan.assetType) : -1,
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
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setActionError(decodeContractError(err, "Repayment failed"));
      step.failure(err);
    } finally {
      setActionLoading(false);
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

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: "60vh" }}>
        <p>Loading loan #{loanId}...</p>
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
        <h3>Loan Not Found</h3>
        <p>{error || `Loan #${loanId} does not exist.`}</p>
        <Link to="/app" className="btn btn-secondary btn-sm">
          <ArrowLeft size={16} /> Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="loan-details">
      <Link to="/app" className="back-link">
        <ArrowLeft size={16} /> Back to Dashboard
      </Link>

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
              <span className="status-badge lender">You are Lender</span>
            )}
            {isBorrower && (
              <span className="status-badge borrower">You are Borrower</span>
            )}
            {isOverdue && (
              <span className="status-badge defaulted">Overdue</span>
            )}
          </div>
        </div>
        {isActive && (
          <div className="loan-countdown">
            <Clock size={18} />
            <span>{daysRemaining} days remaining</span>
          </div>
        )}
      </div>

      {isLender && Number(loan.assetType) === AssetType.ERC20 && (
        <div style={{ marginBottom: 16 }}>
          <LenderDiscountCard
            loanId={loanId ?? null}
            lender={loan.lender}
          />
        </div>
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
                Stake VPFI into your escrow on this chain and flip the
                platform-level VPFI consent once on your Dashboard. Future
                liquid loans will auto-settle the tier-discounted fee in VPFI.
                Need VPFI?{" "}
                <a href="/app/buy-vpfi" target="_blank" rel="noreferrer">
                  Buy VPFI
                </a>{" "}
                (buy from your preferred chain — routing is handled for you).
              </p>
              <Link to="/app" className="btn btn-secondary btn-sm">
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

      {/* Loan details grid */}
      <div className="loan-grid">
        <div className="card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Loan Terms
            <CardInfo id="loan-details.terms" />
          </div>
          <div className="data-row">
            <span className="data-label">Principal</span>
            <span className="data-value mono">
              <TokenAmount
                amount={loan.principal}
                address={loan.principalAsset}
              />
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">Principal Asset</span>
            <a
              href={`${activeBlockExplorer}/address/${loan.principalAsset}`}
              target="_blank"
              rel="noreferrer"
              className="data-value"
              style={{
                color: "var(--brand)",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <AssetSymbol address={loan.principalAsset} />{" "}
              <ExternalLink size={12} />
            </a>
          </div>
          <div className="data-row">
            <span className="data-label">Interest Rate (APR)</span>
            <span className="data-value">
              {bpsToPercent(loan.interestRateBps)}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">Duration</span>
            <span className="data-value">
              {loan.durationDays.toString()} days
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">Start Date</span>
            <span className="data-value">
              {new Date(Number(loan.startTime) * 1000).toLocaleDateString()}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">End Date</span>
            <span className="data-value">
              {new Date(endTime * 1000).toLocaleDateString()}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">Asset Type</span>
            <span className="data-value">
              {ASSET_TYPE_LABELS[Number(loan.assetType) as AssetType]}
            </span>
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Collateral & Risk
            <CardInfo id="loan-details.collateral-risk" role={role} />
          </div>
          <div className="data-row">
            <span className="data-label">Collateral Amount</span>
            <span className="data-value mono">
              <TokenAmount
                amount={loan.collateralAmount}
                address={loan.collateralAsset}
              />
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">Collateral Asset</span>
            <a
              href={`${activeBlockExplorer}/address/${loan.collateralAsset}`}
              target="_blank"
              rel="noreferrer"
              className="data-value"
              style={{
                color: "var(--brand)",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <AssetSymbol address={loan.collateralAsset} />{" "}
              <ExternalLink size={12} />
            </a>
          </div>
          <div className="data-row">
            <span className="data-label">Principal Liquidity</span>
            <span
              className={`status-badge ${loan.principalLiquidity === 0n ? "active" : "defaulted"}`}
            >
              {LIQUIDITY_LABELS[Number(loan.principalLiquidity) as Liquidity]}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">Collateral Liquidity</span>
            <span
              className={`status-badge ${loan.collateralLiquidity === 0n ? "active" : "defaulted"}`}
            >
              {LIQUIDITY_LABELS[Number(loan.collateralLiquidity) as Liquidity]}
            </span>
          </div>
          <div className="data-row">
            <span className="data-label">LTV</span>
            <LTVBar percent={ltvPercent} />
          </div>
          <div className="data-row">
            <span className="data-label">Health Factor</span>
            <HealthFactorGauge value={hfScaled} />
          </div>
          {riskError && (
            <div className="data-row">
              <span className="data-label">Risk</span>
              <span
                className="data-value"
                style={{ color: "var(--text-tertiary)", fontSize: "0.78rem" }}
              >
                {riskError}
              </span>
            </div>
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

        <div className="card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Parties
            <CardInfo id="loan-details.parties" />
          </div>
          <div className="data-row">
            <span className="data-label">Lender</span>
            <a
              href={`${activeBlockExplorer}/address/${loan.lender}`}
              target="_blank"
              rel="noreferrer"
              className="data-value"
              style={{ color: "var(--brand)", fontSize: "0.82rem" }}
            >
              <AddressDisplay address={loan.lender} withTooltip /> <ExternalLink size={12} />
            </a>
          </div>
          <div className="data-row">
            <span className="data-label">Borrower</span>
            <a
              href={`${activeBlockExplorer}/address/${loan.borrower}`}
              target="_blank"
              rel="noreferrer"
              className="data-value"
              style={{ color: "var(--brand)", fontSize: "0.82rem" }}
            >
              <AddressDisplay address={loan.borrower} withTooltip /> <ExternalLink size={12} />
            </a>
          </div>
          <div className="data-row">
            <span className="data-label">Lender NFT ID</span>
            <Link
              to={`/nft-verifier?contract=${activeDiamondAddr}&id=${loan.lenderTokenId.toString()}`}
              className="data-value mono"
              data-tooltip="Verify on-chain metadata"
              style={{ color: "var(--brand)" }}
            >
              #{loan.lenderTokenId.toString()}
            </Link>
          </div>
          <div className="data-row">
            <span className="data-label">Borrower NFT ID</span>
            <Link
              to={`/nft-verifier?contract=${activeDiamondAddr}&id=${loan.borrowerTokenId.toString()}`}
              className="data-value mono"
              data-tooltip="Verify on-chain metadata"
              style={{ color: "var(--brand)" }}
            >
              #{loan.borrowerTokenId.toString()}
            </Link>
          </div>
          <div className="data-row">
            <span className="data-label">Original Offer</span>
            <span className="data-value">#{loan.offerId.toString()}</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      {availability.repay && (
        <div className="card loan-actions-card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Actions
            <CardInfo id="loan-details.actions" role={role} />
          </div>

          {isFallbackPending && (
            <div className="alert alert-warning" style={{ marginBottom: 12 }}>
              <AlertTriangle size={18} />
              <span>
                Liquidation swap failed and this loan is in{" "}
                <strong>Fallback Pending</strong>.
                {isBorrower
                  ? " You can still cure it by repaying in full, or by adding collateral until Health Factor and LTV return to their initiation thresholds."
                  : " The borrower may still cure the position (full repay or collateral top-up) until the lender finalizes the claim."}
              </span>
            </div>
          )}

          <div className="action-group">
            <h4 className="action-title">Repay Loan</h4>
            <p className="action-desc">
              {isBorrower
                ? "Repay the principal + interest in full to close the loan and release your collateral."
                : "Anyone can repay this loan on behalf of the borrower (full repayment only)."}
            </p>
            {!isBorrower && (
              <div className="alert alert-warning" style={{ marginBottom: 12 }}>
                <AlertTriangle size={18} />
                <span>
                  Repaying this loan does not grant collateral rights.
                  Collateral is claimable only by the current holder of borrower
                  NFT #{loan.borrowerTokenId.toString()}.
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
                  Repay in Full
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
                  <strong>Confirm Full Repayment</strong>
                </div>
                <div className="data-row">
                  <span className="data-label">Loan</span>
                  <span className="data-value">#{loan.id.toString()}</span>
                </div>
                <p style={{ marginTop: 8 }}>
                  This will repay principal plus accrued interest for the full
                  outstanding balance and close (or cure) the loan.
                </p>
                {!isBorrower && (
                  <p style={{ marginTop: 8 }}>
                    <strong>Reminder:</strong> repaying this loan does not grant
                    you collateral rights. Collateral is claimable only by the
                    current holder of borrower NFT #
                    {loan.borrowerTokenId.toString()}.
                  </p>
                )}
                {/* Phase 8b.2 — Blockaid preview of the pending repay tx. */}
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
                    {actionLoading ? "Processing..." : "Confirm & Repay"}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setRepayConfirming(false)}
                    disabled={actionLoading}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {availability.addCollateral && (
            <div className="action-group">
              <h4 className="action-title">Add Collateral</h4>
              <p className="action-desc">
                {isFallbackPending
                  ? "Top up collateral to cure the fallback. The loan reactivates once Health Factor and LTV are back within their initiation thresholds."
                  : "Add more collateral to improve your Health Factor and avoid liquidation."}
              </p>
              <div className="action-row">
                <input
                  className="form-input"
                  type="number"
                  step="any"
                  min="0"
                  placeholder="Amount to add"
                  value={addCollateralAmt}
                  onChange={(e) => setAddCollateralAmt(e.target.value)}
                />
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleAddCollateral}
                  disabled={actionLoading || !addCollateralAmt}
                >
                  {actionLoading ? "Processing..." : "Add Collateral"}
                </button>
              </div>
              {/* Phase 8b.2 — Blockaid preview of the pending addCollateral
                  tx. Hides silently when the amount input is empty or
                  doesn't parse. */}
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
                <h4 className="action-title">Liquidate (HF &lt; 1)</h4>
                <p className="action-desc">
                  This loan is undercollateralized. Any wallet may liquidate
                  — collateral is swapped to principal across the best-priced
                  DEX and the lender is made whole. You collect a liquidator
                  incentive (up to 3% of proceeds, tapering with realized
                  slippage).
                </p>
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
              <h4 className="action-title">Trigger Default</h4>
              <p className="action-desc">
                This loan is overdue. Anyone can trigger the default process.
              </p>
              <button
                className="btn btn-primary btn-sm"
                style={{ background: "var(--accent-red)" }}
                onClick={handleTriggerDefault}
                disabled={actionLoading}
              >
                {actionLoading ? "Processing..." : "Trigger Default"}
              </button>
            </div>
          )}

          {availability.earlyWithdrawal && (
            <div className="action-group">
              <h4 className="action-title">Early Withdrawal</h4>
              <p className="action-desc">
                Exit this loan before maturity by selling your lender position
                to a new lender. Initiating this flow will lock your lender NFT
                from transfer until the sale completes or is cancelled.
              </p>
              <div className="action-row">
                <Link
                  to={`/app/loans/${loan.id.toString()}/early-withdrawal`}
                  className="btn btn-primary btn-sm"
                >
                  Initiate Early Withdrawal
                </Link>
              </div>
            </div>
          )}

          {availability.preclose && (
            <>
              <div className="action-group">
                <h4 className="action-title">Preclose</h4>
                <p className="action-desc">
                  Close this loan early by repaying directly, or by offsetting
                  with a new lender offer. The offset path will lock your
                  borrower NFT from transfer until the new offer is accepted or
                  cancelled.
                </p>
                <div className="action-row">
                  <Link
                    to={`/app/loans/${loan.id.toString()}/preclose`}
                    className="btn btn-primary btn-sm"
                  >
                    Open Preclose Flow
                  </Link>
                </div>
              </div>
              <div className="action-group">
                <h4 className="action-title">Refinance</h4>
                <p className="action-desc">
                  Switch to a new lender with better terms by posting a borrower
                  offer and completing the refinance once accepted.
                </p>
                <div className="action-row">
                  <Link
                    to={`/app/loans/${loan.id.toString()}/refinance`}
                    className="btn btn-primary btn-sm"
                  >
                    Open Refinance Flow
                  </Link>
                </div>
              </div>
            </>
          )}
        </div>
      )}
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
        Keeper delegation
      </span>
      {loading ? (
        <span style={{ fontSize: "0.82rem", opacity: 0.7 }}>Loading keepers…</span>
      ) : keepers.length === 0 ? (
        <div style={{ fontSize: "0.82rem", opacity: 0.8 }}>
          You have no keepers on your global whitelist.{" "}
          <Link to="/app/keepers" style={{ color: "var(--brand)" }}>
            Add one on the Keeper Settings page →
          </Link>{" "}
          before enabling any for this loan.
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
                  <AddressDisplay address={k} withTooltip />
                </span>
              </label>
            );
          })}
          <div style={{ fontSize: "0.72rem", opacity: 0.65 }}>
            A keeper still needs (a) the corresponding action bit set on your{" "}
            <Link to="/app/keepers" style={{ color: "var(--brand)" }}>
              global whitelist
            </Link>{" "}
            and (b) your master keeper-access switch ON before they can drive
            anything on this loan.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Phase 8b.2 — Blockaid preview for the pending `repayLoan` tx on
 * this loan. No form state needed beyond the loan id; the exact
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
 * Phase 8b.2 — Blockaid preview for the pending `addCollateral` tx.
 * Waits for the amount input to parse successfully before asking the
 * API to scan — avoids spamming scans while the user is mid-typing.
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
