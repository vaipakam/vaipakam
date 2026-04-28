import { useState } from "react";
import { useParams } from "react-router-dom";
import { L as Link } from "../components/L";
import { useTranslation } from "react-i18next";
import { maxUint256 as MaxUint256, parseUnits } from "viem";
import { AlertTriangle, ArrowLeft, CheckCircle } from "lucide-react";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { useWallet } from "../context/WalletContext";
import { useDiamondContract } from "../contracts/useDiamond";
import { useERC20 } from "../contracts/useERC20";
import { useLoan } from "../hooks/useLoan";
import { usePositionLock, LockReason } from "../hooks/usePositionLock";
import { AssetType, LoanStatus } from "../types/loan";
import { decodeContractError } from "../lib/decodeContractError";
import { beginStep } from "../lib/journeyLog";
import { DEFAULT_CHAIN } from "../contracts/config";
import { TransferLockWarning } from "../components/app/TransferLockWarning";
import { InterestImplicationWarning } from "../components/app/InterestImplicationWarning";
import { RiskDisclosures } from "../components/app/RiskDisclosures";
import { AssetSymbol } from "../components/app/AssetSymbol";
import { TokenAmount } from "../components/app/TokenAmount";
import { bpsToPercent } from "../lib/format";
import { CardInfo } from "../components/CardInfo";
import "./LoanDetails.css";

type Option = "direct" | "offset" | "transfer";
type Step = "idle" | "review" | "submitting" | "success";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Borrower Preclose — README §8 Options 1, 2 & 3.
 * - Option 1 (direct): pay principal + full-term interest; loan closes.
 * - Option 2 (transfer): accept an existing Borrower Offer from a replacement
 *   borrower. Contract-enforced asset continuity + lender-favorability rules
 *   (PrecloseFacet.transferObligationViaOffer) — atomic, no NFT lock.
 * - Option 3 (offset): create a lender offer to replace Liam; the borrower-side
 *   Vaipakam NFT is natively locked for transfer until completeOffset or cancel.
 */
export default function BorrowerPreclose() {
  const { t } = useTranslation();
  const { loanId } = useParams();
  const { address, chainId, activeChain, isCorrectChain } = useWallet();
  // Active-chain Diamond + explorer, falling back to DEFAULT_CHAIN when the
  // wallet is disconnected or on an unsupported chain. Approvals must hit
  // the Diamond on the user's current chain, not DEFAULT_CHAIN.
  const activeDiamondAddr =
    (activeChain && isCorrectChain ? activeChain.diamondAddress : null) ??
    DEFAULT_CHAIN.diamondAddress;
  const activeBlockExplorer =
    (activeChain && isCorrectChain ? activeChain.blockExplorer : null) ??
    DEFAULT_CHAIN.blockExplorer;
  const diamond = useDiamondContract();
  const { loan, borrowerHolder, loading, error, reload } = useLoan(loanId);
  const erc20 = useERC20(loan?.principalAsset ?? null);
  const collateralErc20 = useERC20(loan?.collateralAsset ?? null);
  const { lock, reload: reloadLock } = usePositionLock(
    loan?.borrowerTokenId ?? null,
  );

  const [opt, setOpt] = useState<Option>("direct");
  const [step, setStep] = useState<Step>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Option 3 form
  const [rate, setRate] = useState("");
  const [duration, setDuration] = useState("");
  const [collateralAmt, setCollateralAmt] = useState("");
  const [fallbackConsent, setFallbackConsent] = useState(false);

  // Option 2 form
  const [transferOfferId, setTransferOfferId] = useState("");

  const isBorrower =
    !!loan &&
    !!address &&
    !!borrowerHolder &&
    borrowerHolder.toLowerCase() === address.toLowerCase();
  const isActive = !!loan && Number(loan.status) === LoanStatus.Active;
  const isErc20Loan = !!loan && Number(loan.assetType) === AssetType.ERC20;
  const inProgress = lock === LockReason.PrecloseOffset;

  const ctxBase = {
    area: "preclose" as const,
    wallet: address,
    chainId,
    loanId,
    role: "borrower" as const,
  };

  const ensureAllowance = async (needed: bigint) => {
    if (!erc20 || !address || needed === 0n) return;
    const diamondAddr = activeDiamondAddr;
    const current = (await erc20.allowance(address, diamondAddr)) as bigint;
    if (current >= needed) return;
    const tx = await erc20.approve(diamondAddr, needed);
    await tx.wait();
  };

  const handleDirect = async () => {
    if (!loan) return;
    setTxError(null);
    setTxHash(null);
    setStep("submitting");
    const s = beginStep({
      ...ctxBase,
      flow: "precloseDirect",
      step: "submit-tx",
    });
    try {
      if (isErc20Loan) {
        // Principal + full-term interest pulled via safeTransferFrom on ERC-20
        // preclose. Use max allowance so partial rounding differences from the
        // fee split don't force a second approval round-trip.
        await ensureAllowance(MaxUint256);
      }
      const tx = await diamond.precloseDirect(loan.id);
      setTxHash(tx.hash);
      await tx.wait();
      await reload();
      await reloadLock();
      setStep("success");
      s.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setTxError(decodeContractError(err, "Direct preclose failed"));
      setStep("idle");
      s.failure(err);
    }
  };

  const handleTransferViaOffer = async () => {
    if (!loan) return;
    setTxError(null);
    setTxHash(null);
    let offerId: bigint;
    try {
      offerId = BigInt(transferOfferId);
    } catch {
      setTxError("Enter a valid Borrower Offer ID.");
      return;
    }
    if (offerId <= 0n) {
      setTxError("Offer ID must be a positive integer.");
      return;
    }
    setStep("submitting");
    const s = beginStep({
      ...ctxBase,
      flow: "transferObligationViaOffer",
      step: "submit-tx",
      offerId: offerId.toString(),
    });
    try {
      // Alice pays accrued interest + shortfall + treasury fee to Liam. The new
      // borrower's collateral is already locked in his escrow from offer
      // creation, so we only need to authorize the principal-asset pull.
      await ensureAllowance(MaxUint256);
      const tx = await diamond.transferObligationViaOffer(loan.id, offerId);
      setTxHash(tx.hash);
      await tx.wait();
      await reload();
      await reloadLock();
      setStep("success");
      s.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setTxError(decodeContractError(err, "Transfer via offer failed"));
      setStep("review");
      s.failure(err);
    }
  };

  const handleOffset = async () => {
    if (!loan) return;
    setTxError(null);
    setTxHash(null);
    const rateBps = Math.round(Number(rate) * 100);
    const durationDays = Math.round(Number(duration));
    if (!Number.isFinite(rateBps) || rateBps <= 0) {
      setTxError("Enter a valid interest rate greater than 0%.");
      return;
    }
    if (!Number.isFinite(durationDays) || durationDays <= 0) {
      setTxError("Enter a valid duration in days.");
      return;
    }
    let collateralAmount: bigint;
    try {
      let decimals = 18;
      if (collateralErc20) {
        try {
          decimals = Number(await collateralErc20.decimals());
        } catch {
          decimals = 18;
        }
      }
      collateralAmount = parseUnits(collateralAmt || "0", decimals);
    } catch {
      setTxError("Enter a valid collateral amount (e.g. 100 or 100.5).");
      return;
    }
    setStep("submitting");
    const s = beginStep({
      ...ctxBase,
      flow: "offsetWithNewOffer",
      step: "submit-tx",
    });
    try {
      // Alice repays Liam (principal + accrued + shortfall + treasury fee) AND
      // deposits a fresh principal for the new lender offer — we can't know
      // exact shortfall client-side, so request max approval once.
      await ensureAllowance(MaxUint256);
      const tx = await diamond.offsetWithNewOffer(
        loan.id,
        BigInt(rateBps),
        BigInt(durationDays),
        loan.collateralAsset,
        collateralAmount,
        fallbackConsent,
        ZERO_ADDRESS,
      );
      setTxHash(tx.hash);
      await tx.wait();
      await reload();
      await reloadLock();
      setStep("success");
      s.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setTxError(decodeContractError(err, t('preclose.offsetCreationFailed')));
      setStep("review");
      s.failure(err);
    }
  };

  const handleComplete = async () => {
    if (!loan) return;
    setTxError(null);
    setTxHash(null);
    setStep("submitting");
    const s = beginStep({
      ...ctxBase,
      flow: "completeOffset",
      step: "submit-tx",
    });
    try {
      const tx = await diamond.completeOffset(loan.id);
      setTxHash(tx.hash);
      await tx.wait();
      await reload();
      await reloadLock();
      setStep("success");
      s.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setTxError(decodeContractError(err, "Complete offset failed"));
      setStep("idle");
      s.failure(err);
    }
  };

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
        <Link to="/app" className="btn btn-secondary btn-sm">
          <ArrowLeft size={16} /> {t('loanDetails.backToDashboard')}
        </Link>
      </div>
    );
  }

  if (!isBorrower) {
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
        <h3>{t('loanFlow.borrowerOnly')}</h3>
        <p>{t('loanFlow.borrowerOnlyPreclose')}</p>
        <Link
          to={`/app/loans/${loan.id.toString()}`}
          className="btn btn-secondary btn-sm"
        >
          <ArrowLeft size={16} /> {t('loanFlow.backToLoan')}
        </Link>
      </div>
    );
  }

  return (
    <div className="loan-details">
      <Link to={`/app/loans/${loan.id.toString()}`} className="back-link">
        <ArrowLeft size={16} /> {t('loanFlow.backToLoan')} #{loan.id.toString()}
      </Link>

      <div className="loan-header">
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {t('preclose.pageTitle', { id: loan.id.toString() })}
            <CardInfo id="preclose.overview" />
          </h1>
          <p className="page-subtitle">{t('preclose.pageSubtitle')}</p>
        </div>
      </div>

      {!isActive && (
        <div className="alert alert-warning">
          <AlertTriangle size={18} />
          <span>{t('loanFlow.notActivePreclose')}</span>
        </div>
      )}

      {txHash && (
        <div className="alert alert-success">
          <CheckCircle size={18} />
          <span>
            {t('loanFlow.txSubmitted')}{" "}
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

      {txError && <ErrorAlert message={txError} />}

      <div className="card">
        <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {t('loanFlow.positionSummary')}
          <CardInfo id="preclose.position-summary" />
        </div>
        <div className="data-row">
          <span className="data-label">{t('loanDetails.principal')}</span>
          <span className="data-value">
            <TokenAmount
              amount={loan.principal}
              address={loan.principalAsset}
            />{" "}
            <AssetSymbol address={loan.principalAsset} />
          </span>
        </div>
        <div className="data-row">
          <span className="data-label">{t('loanFlow.rate')}</span>
          <span className="data-value">
            {bpsToPercent(loan.interestRateBps)}%
          </span>
        </div>
        <div className="data-row">
          <span className="data-label">{t('loanDetails.duration')}</span>
          <span className="data-value">
            {loan.durationDays.toString()} {t('loanDetails.daysSuffix')}
          </span>
        </div>
        <div className="data-row">
          <span className="data-label">{t('loanFlow.borrowerNft')}</span>
          <span className="data-value mono">
            #{loan.borrowerTokenId.toString()}
          </span>
        </div>
      </div>

      {inProgress && (
        <div className="card">
          <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {t('preclose.inProgressTitle')}
            <CardInfo id="preclose.in-progress" />
          </div>
          <TransferLockWarning
            mode="active"
            lock={lock}
            tokenId={loan.borrowerTokenId}
          />
          <p className="action-desc" style={{ marginTop: 12 }}>
            A replacement lender offer is live for this loan. As soon as a new
            borrower accepts it, the offset completes automatically in the same
            transaction — your original collateral is released and the original
            loan closes with no extra click. The manual button below is only
            needed as a recovery hook if auto-completion didn't run. To abort
            before acceptance, cancel the linked lender offer from the Offer
            Book.
          </p>
          <div className="action-row">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleComplete}
              disabled={step === "submitting"}
            >
              {step === "submitting"
                ? t('loanDetails.processing')
                : t('preclose.completeOffsetRecovery')}
            </button>
            <Link to="/app/offers" className="btn btn-secondary btn-sm">
              {t('preclose.viewOfferBook')}
            </Link>
          </div>
        </div>
      )}

      {isActive && !inProgress && (
        <div className="card loan-actions-card">
          <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {t('preclose.choosePathTitle')}
            <CardInfo id="preclose.choose-path" />
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button
              className={`btn btn-sm ${opt === "direct" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => {
                setOpt("direct");
                setStep("idle");
              }}
              disabled={step === "submitting"}
            >
              {t('preclose.directPath')}
            </button>
            <button
              className={`btn btn-sm ${opt === "transfer" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => {
                setOpt("transfer");
                setStep("idle");
              }}
              disabled={step === "submitting" || !isErc20Loan}
              data-tooltip={
                !isErc20Loan
                  ? "Transfer path is ERC-20 only in Phase 1"
                  : undefined
              }
            >
              {t('preclose.transferPath')}
            </button>
            <button
              className={`btn btn-sm ${opt === "offset" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => {
                setOpt("offset");
                setStep("idle");
              }}
              disabled={step === "submitting" || !isErc20Loan}
              data-tooltip={
                !isErc20Loan
                  ? t('preclose.offsetTooltipPhase1')
                  : undefined
              }
            >
              {t('preclose.offsetPath')}
            </button>
          </div>

          {opt === "direct" && (
            <div className="action-group">
              <h4 className="action-title">{t('preclose.directPrecloseTitle')}</h4>
              <p className="action-desc">{t('preclose.directPrecloseDesc')}</p>
              <InterestImplicationWarning kind="preclose-direct" />
              <div className="action-row" style={{ marginTop: 12 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleDirect}
                  disabled={step === "submitting"}
                  style={{ background: "var(--accent-red)" }}
                >
                  {step === "submitting" ? t('loanDetails.processing') : t('preclose.payAndCloseLoan')}
                </button>
              </div>
            </div>
          )}

          {opt === "transfer" && isErc20Loan && (
            <div className="action-group">
              <h4 className="action-title">
                {t('preclose.transferToBorrowerTitle')}
              </h4>
              {step === "review" || step === "submitting" ? (
                <>
                  <div className="data-row" style={{ marginTop: 12 }}>
                    <span className="data-label">{t('preclose.borrowerOfferIdLabel')}</span>
                    <span className="data-value">#{transferOfferId}</span>
                  </div>
                  <p className="action-desc" style={{ marginTop: 12 }}>
                    {t('preclose.transferReviewBody')}
                  </p>
                  <InterestImplicationWarning kind="preclose-transfer" />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleTransferViaOffer}
                      disabled={step === "submitting"}
                    >
                      {step === "submitting"
                        ? t('preclose.submittingDots')
                        : t('preclose.confirmAndTransfer')}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setStep("idle")}
                      disabled={step === "submitting"}
                    >
                      {t('preclose.back')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="action-desc">{t('preclose.transferIntroBody')}</p>
                  <ul
                    className="action-desc"
                    style={{ marginLeft: 18, marginTop: 4 }}
                  >
                    <li>{t('preclose.transferRuleSameAssets')}</li>
                    <li>{t('preclose.transferRuleAmountEqual')}</li>
                    <li>{t('preclose.transferRuleCollateralGte')}</li>
                    <li>{t('preclose.transferRuleDurationLte')}</li>
                    <li>{t('preclose.transferRuleNewBorrower')}</li>
                  </ul>
                  <div
                    className="action-row"
                    style={{ alignItems: "flex-end", marginTop: 8 }}
                  >
                    <div style={{ flex: 1 }}>
                      <label className="form-label">{t('preclose.borrowerOfferIdInputLabel')}</label>
                      <input
                        className="form-input"
                        type="text"
                        placeholder="e.g. 42"
                        value={transferOfferId}
                        onChange={(e) => setTransferOfferId(e.target.value)}
                      />
                    </div>
                    <Link to="/app/offers" className="btn btn-secondary btn-sm">
                      {t('preclose.browseOfferBook')}
                    </Link>
                  </div>
                  <div className="action-row" style={{ marginTop: 12 }}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setStep("review")}
                      disabled={!transferOfferId}
                    >
                      {t('preclose.reviewTransfer')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {opt === "offset" && isErc20Loan && (
            <div className="action-group">
              <h4 className="action-title">{t('preclose.offsetTitle')}</h4>
              {step === "review" || step === "submitting" ? (
                <>
                  <TransferLockWarning
                    mode="pre-confirm"
                    flow="preclose"
                    tokenId={loan.borrowerTokenId}
                    role="borrower"
                  />
                  <InterestImplicationWarning kind="preclose-offset" />
                  <div className="data-row" style={{ marginTop: 12 }}>
                    <span className="data-label">{t('preclose.newRateLabel')}</span>
                    <span className="data-value">{rate}%</span>
                  </div>
                  <div className="data-row">
                    <span className="data-label">{t('preclose.newDurationLabel')}</span>
                    <span className="data-value">{duration} {t('preclose.daysSuffix')}</span>
                  </div>
                  <div className="data-row">
                    <span className="data-label">
                      {t('preclose.requiredCollateralForBorrower')}
                    </span>
                    <span className="data-value">
                      {collateralAmt}{" "}
                      <AssetSymbol address={loan.collateralAsset} />
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleOffset}
                      disabled={step === "submitting"}
                    >
                      {step === "submitting"
                        ? t('preclose.submittingDots')
                        : t('preclose.confirmAndCreateOffset')}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setStep("idle")}
                      disabled={step === "submitting"}
                    >
                      {t('preclose.back')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="action-desc">{t('preclose.offsetIntroBody')}</p>
                  <div
                    className="action-row"
                    style={{ alignItems: "flex-end" }}
                  >
                    <div style={{ flex: 1 }}>
                      <label className="form-label">{t('preclose.newRateInputLabel')}</label>
                      <input
                        className="form-input"
                        type="number"
                        step="any"
                        min="0"
                        placeholder="e.g. 4"
                        value={rate}
                        onChange={(e) => setRate(e.target.value)}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className="form-label">{t('preclose.newDurationInputLabel')}</label>
                      <input
                        className="form-input"
                        type="number"
                        min="1"
                        step="1"
                        placeholder="e.g. 30"
                        value={duration}
                        onChange={(e) => setDuration(e.target.value)}
                      />
                    </div>
                  </div>
                  <div
                    className="action-row"
                    style={{ alignItems: "flex-end", marginTop: 8 }}
                  >
                    <div style={{ flex: 1 }}>
                      <label className="form-label">{t('preclose.requiredCollateralLabel')}</label>
                      <input
                        className="form-input"
                        type="number"
                        step="any"
                        min="0"
                        placeholder="e.g. 1500"
                        value={collateralAmt}
                        onChange={(e) => setCollateralAmt(e.target.value)}
                      />
                      <span className="form-hint">{t('preclose.amountWholeTokensHint')}</span>
                    </div>
                  </div>
                  <RiskDisclosures />
                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      marginTop: 8,
                      alignItems: "center",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={fallbackConsent}
                      onChange={(e) => setFallbackConsent(e.target.checked)}
                    />
                    <span>{t('riskDisclosures.checkboxLabel')}</span>
                  </label>
                  <div className="action-row" style={{ marginTop: 12 }}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setStep("review")}
                      disabled={!rate || !duration || !collateralAmt || !fallbackConsent}
                    >
                      {t('preclose.reviewOffsetOffer')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
