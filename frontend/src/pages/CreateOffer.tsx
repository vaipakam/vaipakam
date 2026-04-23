import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { parseAbi, type Abi, type Address } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { useWallet } from "../context/WalletContext";
import { useMode } from "../context/ModeContext";
import { useDiamondContract } from "../contracts/useDiamond";
import { useERC20 } from "../contracts/useERC20";
import { useOfferForm } from "../hooks/useOfferForm";
import {
  isNFTRental,
  gracePeriodLabel,
  type OfferFormState,
  type OfferAssetKind,
  type OfferSide,
} from "../lib/offerSchema";
import { decodeContractError } from "../lib/decodeContractError";
import {
  FALLBACK_CONSENT_TITLE,
  FALLBACK_CONSENT_BODY,
  FALLBACK_CONSENT_CHECKBOX_LABEL,
} from "../lib/fallbackTerms";
import { beginStep, emit } from "../lib/journeyLog";
import { DEFAULT_CHAIN } from "../contracts/config";
import { AlertTriangle, Info, CheckCircle, Wallet, Coins } from "lucide-react";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { Link } from "react-router-dom";
import { AssetPicker } from "../components/app/AssetPicker";
import { useAssetType, type DetectedAssetType } from "../hooks/useAssetType";
import "./CreateOffer.css";

type SubmitStep = "form" | "approving" | "creating" | "success";

const RENTAL_BUFFER_BPS = 500n;
const BASIS_POINTS = 10000n;

const NFT_APPROVAL_ABI = parseAbi([
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
]) as unknown as Abi;

const ERC20_APPROVE_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]) as unknown as Abi;

export default function CreateOffer() {
  const { address, chainId, activeChain, isCorrectChain } = useWallet();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { mode } = useMode();
  const showAdvanced = mode === "advanced";
  const diamond = useDiamondContract();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Deep-link prefill from the Refinance / Offset flows. When `from=refinance`
  // (or `from=offset`), the query string encodes the original loan's asset
  // continuity fields — principal, collateral, and prepay asset types must
  // match or the on-chain settlement reverts. We prefill the form and show a
  // banner so the user doesn't discover the mismatch via a failed tx.
  const prefill = useMemo<Partial<OfferFormState> | undefined>(() => {
    const from = searchParams.get("from");
    if (from !== "refinance" && from !== "offset") return undefined;
    const get = (k: string) => searchParams.get(k) ?? undefined;
    const ot = get("offerType");
    const at = get("collateralAssetType") as OfferAssetKind | undefined;
    const out: Partial<OfferFormState> = {};
    if (ot === "lender" || ot === "borrower") out.offerType = ot as OfferSide;
    const la = get("lendingAsset");
    if (la) out.lendingAsset = la;
    const ca = get("collateralAsset");
    if (ca) out.collateralAsset = ca;
    const pa = get("prepayAsset");
    if (pa) out.prepayAsset = pa;
    if (at === "erc20" || at === "erc721" || at === "erc1155")
      out.collateralAssetType = at;
    return out;
  }, [searchParams]);
  const deepLinkFrom = searchParams.get("from");
  const deepLinkLoanId = searchParams.get("loanId");
  // Asset-continuity fields the contract requires to match the original loan
  // (RefinanceFacet.refinanceLoan / PrecloseFacet.offsetWithNewOffer). Render
  // them disabled + badged when arrived from a refinance/offset deep-link so
  // the UI matches the contract instead of promising "locked" via copy.
  const lockAssetContinuity =
    deepLinkFrom === "refinance" || deepLinkFrom === "offset";

  const {
    state: form,
    setField,
    reset,
    validate,
    toPayload,
  } = useOfferForm(prefill);
  const erc20 = useERC20(form.lendingAsset || null);
  const collateralErc20 = useERC20(
    form.collateralAssetType === "erc20" ? form.collateralAsset || null : null,
  );
  const isRental = isNFTRental(form.assetType);

  // Auto-detect asset standards (ERC-20/721/1155) whenever the user enters or
  // selects a contract address. Keeps the Asset Type toggles honest with what
  // the contract actually implements. Skipped while `lockAssetContinuity` —
  // refinance/offset flows must preserve the pinned original-loan types.
  const lendingDetection = useAssetType(form.lendingAsset || null);
  const collateralDetection = useAssetType(form.collateralAsset || null);

  useEffect(() => {
    if (lockAssetContinuity) return;
    const detected = lendingDetection.type;
    if (!detected || detected === "unknown") return;
    if (detected !== form.assetType) setField("assetType", detected);
  }, [lendingDetection.type, form.assetType, lockAssetContinuity, setField]);

  useEffect(() => {
    if (lockAssetContinuity) return;
    const detected = collateralDetection.type;
    if (!detected || detected === "unknown") return;
    if (detected !== form.collateralAssetType)
      setField("collateralAssetType", detected);
  }, [
    collateralDetection.type,
    form.collateralAssetType,
    lockAssetContinuity,
    setField,
  ]);
  // Statically-detectable illiquid leg: any non-ERC-20 asset is illiquid by
  // definition (no Chainlink feed). ERC-20/ERC-20 pairs may still turn out
  // illiquid on-chain if the token lacks an oracle / deep pool — we can't
  // know without querying OracleFacet.checkLiquidity, so for those cases we
  // keep the consent checkbox available but don't auto-assert the warning.
  const isIlliquidForm =
    form.assetType !== "erc20" || form.collateralAssetType !== "erc20";

  const [step, setStep] = useState<SubmitStep>("form");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Contract accepts 1–365 days (LoanFacet.initiateLoan bounds); flag
  // out-of-range entries inline so the user sees the constraint before
  // submitting. Empty string is treated as "not yet entered" rather than
  // invalid — submit-time validation still catches the blank case.
  const durationOutOfRange = (() => {
    const raw = form.durationDays;
    if (raw === "") return false;
    const n = Number(raw);
    return !Number.isFinite(n) || n < 1 || n > 365;
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) return;
    setError(null);

    const flow =
      form.offerType === "lender" ? "createLenderOffer" : "createBorrowerOffer";
    const ctx = {
      area: "offer-create" as const,
      flow,
      wallet: address,
      chainId,
    };

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      emit({
        ...ctx,
        step: "validate-form",
        status: "failure",
        errorType: "validation",
        errorMessage: validationError,
      });
      return;
    }

    const submit = beginStep({ ...ctx, step: "submit" });
    try {
      // Resolve on-chain decimals for both assets so "100" in the form maps
      // to 100 whole tokens regardless of whether the token is 6-decimal or
      // 18-decimal. Falls back to 18 when the contract doesn't expose
      // decimals() (rare, non-standard tokens).
      const resolveDecimals = async (
        contract: typeof erc20,
        assetType: string,
      ): Promise<number | undefined> => {
        if (!contract || assetType !== "erc20") return undefined;
        try {
          const d = await contract.decimals();
          return Number(d);
        } catch {
          return 18;
        }
      };

      const [lendingDecimals, collateralDecimals] = await Promise.all([
        resolveDecimals(erc20, form.assetType),
        resolveDecimals(collateralErc20, form.collateralAssetType),
      ]);

      const payload = toPayload({
        lending: lendingDecimals,
        collateral: collateralDecimals,
      });

      // OfferFacet.createOffer() locks the creator's side (lender principal
      // or borrower collateral/prepay) into their escrow at creation time, so
      // both sides must pre-approve on the Diamond regardless of offerType.
      // Multi-network: approve the Diamond on the wallet's active chain —
      // falling back to DEFAULT_CHAIN would mis-target approvals for users
      // connected to a non-default deployment.
      const diamondAddr =
        (activeChain && isCorrectChain ? activeChain.diamondAddress : null) ??
        DEFAULT_CHAIN.diamondAddress;
      type Erc20Approvable = {
        allowance: (o: string, s: string) => Promise<bigint>;
        approve: (
          s: string,
          n: bigint,
        ) => Promise<{ wait: () => Promise<unknown> }>;
      };
      const asErc20Approvable = (c: unknown): Erc20Approvable =>
        c as Erc20Approvable;
      const ensureErc20 = async (token: Erc20Approvable, needed: bigint) => {
        const current = await token.allowance(address, diamondAddr);
        if (current < needed) {
          const tx = await token.approve(diamondAddr, needed);
          await tx.wait();
        }
      };
      const ensureNftApproval = async (assetAddr: string) => {
        if (!walletClient || !publicClient) {
          throw new Error("wallet not connected");
        }
        const already = (await publicClient.readContract({
          address: assetAddr as Address,
          abi: NFT_APPROVAL_ABI,
          functionName: "isApprovedForAll",
          args: [address as Address, diamondAddr as Address],
        })) as boolean;
        if (!already) {
          const hash = await walletClient.writeContract({
            address: assetAddr as Address,
            abi: NFT_APPROVAL_ABI,
            functionName: "setApprovalForAll",
            args: [diamondAddr as Address, true],
            account: walletClient.account!,
            chain: walletClient.chain,
          });
          await publicClient.waitForTransactionReceipt({ hash });
        }
      };

      setStep("approving");
      const approveStep = beginStep({ ...ctx, step: "approve-assets" });
      try {
        if (form.offerType === "lender") {
          if (form.assetType === "erc20" && erc20) {
            await ensureErc20(asErc20Approvable(erc20), payload.amount);
          } else if (
            form.assetType === "erc721" ||
            form.assetType === "erc1155"
          ) {
            await ensureNftApproval(form.lendingAsset);
          }
        } else {
          // Borrower path: pre-approve whatever OfferFacet pulls at create.
          if (form.assetType === "erc20") {
            if (form.collateralAssetType === "erc20" && collateralErc20) {
              await ensureErc20(
                asErc20Approvable(collateralErc20),
                payload.collateralAmount,
              );
            } else if (
              form.collateralAssetType === "erc721" ||
              form.collateralAssetType === "erc1155"
            ) {
              await ensureNftApproval(form.collateralAsset);
            }
          } else {
            // NFT rental: borrower prepays `amount * days * (1 + buffer)`
            // in prepayAsset. Approval amount mirrors OfferFacet's transfer.
            if (!walletClient || !publicClient) {
              throw new Error("wallet not connected");
            }
            const prepayBase = payload.amount * BigInt(payload.durationDays);
            const totalPrepay =
              (prepayBase * (BASIS_POINTS + RENTAL_BUFFER_BPS)) / BASIS_POINTS;
            const current = (await publicClient.readContract({
              address: form.prepayAsset as Address,
              abi: ERC20_APPROVE_ABI,
              functionName: "allowance",
              args: [address as Address, diamondAddr as Address],
            })) as bigint;
            if (current < totalPrepay) {
              const hash = await walletClient.writeContract({
                address: form.prepayAsset as Address,
                abi: ERC20_APPROVE_ABI,
                functionName: "approve",
                args: [diamondAddr as Address, totalPrepay],
                account: walletClient.account!,
                chain: walletClient.chain,
              });
              await publicClient.waitForTransactionReceipt({ hash });
            }
          }
        }
        approveStep.success();
      } catch (err) {
        approveStep.failure(err);
        throw err;
      }

      setStep("creating");
      const txStep = beginStep({ ...ctx, step: "createOffer-tx" });
      const tx = await diamond.createOffer(payload);
      setTxHash(tx.hash);
      await tx.wait();
      txStep.success({ note: `tx ${tx.hash}` });
      setStep("success");
      submit.success();
    } catch (err) {
      setError(decodeContractError(err, "Transaction failed"));
      setStep("form");
      submit.failure(err);
    }
  };

  if (!address) {
    return (
      <div className="empty-state" style={{ minHeight: "60vh" }}>
        <div className="empty-state-icon">
          <Wallet size={28} />
        </div>
        <h3>Connect Your Wallet</h3>
        <p>Connect your wallet to create offers on Vaipakam.</p>
      </div>
    );
  }

  if (step === "success") {
    return (
      <div className="empty-state" style={{ minHeight: "60vh" }}>
        <div
          className="empty-state-icon"
          style={{
            background: "rgba(16, 185, 129, 0.1)",
            color: "var(--accent-green)",
          }}
        >
          <CheckCircle size={28} />
        </div>
        <h3>Offer Created Successfully!</h3>
        <p>
          Your offer has been submitted on-chain and a Vaipakam position NFT has
          been minted.
        </p>
        {txHash && (
          <a
            href={`${(activeChain && isCorrectChain ? activeChain.blockExplorer : null) ?? DEFAULT_CHAIN.blockExplorer}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm"
            style={{ marginBottom: 8 }}
          >
            View Transaction
          </a>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              reset();
              setStep("form");
              setTxHash(null);
            }}
          >
            Create Another
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => navigate("/app/offers")}
          >
            View Offer Book
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="create-offer">
      <div className="page-header">
        <h1 className="page-title">Create Offer</h1>
        <p className="page-subtitle">
          {form.offerType === "lender"
            ? "Create a lending offer — specify what you want to lend and your terms."
            : "Create a borrowing offer — specify what you need and the collateral you can provide."}
        </p>
      </div>

      {form.offerType === "borrower" && !isIlliquidForm && (
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
                Borrowing a liquid ERC-20? Save up to 24% on the initiation fee
                with VPFI
              </div>
              <p className="stat-label" style={{ margin: "0 0 8px" }}>
                Hold VPFI in your escrow and enable the one-time platform-level
                VPFI consent on your Dashboard. The protocol then auto-deducts
                the tier-discounted fee in VPFI. Need VPFI?{" "}
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

      {deepLinkFrom === "refinance" && deepLinkLoanId && (
        <div className="alert alert-warning" role="alert">
          <AlertTriangle size={18} />
          <span>
            Refinancing loan #{deepLinkLoanId}.{" "}
            <strong>
              Keep the lending asset, collateral asset, collateral asset type,
              and prepay asset unchanged
            </strong>{" "}
            — the refinance settlement reverts if any of those don't match the
            original loan. You can adjust rate, amount, duration, and collateral
            amount freely.
          </span>
        </div>
      )}
      {deepLinkFrom === "offset" && deepLinkLoanId && (
        <div className="alert alert-warning" role="alert">
          <AlertTriangle size={18} />
          <span>
            Offsetting loan #{deepLinkLoanId}.{" "}
            <strong>
              Keep the lending asset, collateral asset, and prepay asset
              unchanged
            </strong>{" "}
            — the offset completion reverts if any of those don't match the
            original loan.
          </span>
        </div>
      )}

      {error && <ErrorAlert message={error} />}

      <form onSubmit={handleSubmit}>
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">Offer Type</div>
          <div className="offer-type-toggle">
            <button
              type="button"
              className={`toggle-btn ${form.offerType === "lender" ? "active" : ""}`}
              onClick={() => setField("offerType", "lender")}
              disabled={lockAssetContinuity}
              data-tooltip={
                lockAssetContinuity
                  ? "Offer type fixed by the originating flow"
                  : undefined
              }
            >
              I want to Lend
            </button>
            <button
              type="button"
              className={`toggle-btn ${form.offerType === "borrower" ? "active" : ""}`}
              onClick={() => setField("offerType", "borrower")}
              disabled={lockAssetContinuity}
              data-tooltip={
                lockAssetContinuity
                  ? "Offer type fixed by the originating flow"
                  : undefined
              }
            >
              I want to Borrow
            </button>
          </div>

          {showAdvanced && (
            <div style={{ marginTop: 20 }}>
              <div className="form-label">
                Asset Type
                <DetectionBadge
                  detection={lendingDetection}
                  selected={form.assetType}
                />
              </div>
              <div className="form-hint">
                Auto-detected from the lending-asset contract address. Paste or
                pick an address below to populate this.
              </div>
            </div>
          )}
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">
            {isRental ? "NFT Details" : "Lending Asset"}
          </div>

          <div className="form-group">
            {isRental ? (
              <>
                <label className="form-label">
                  NFT Contract Address
                  {lockAssetContinuity && (
                    <span className="form-lock-badge"> · locked</span>
                  )}
                </label>
                <input
                  className="form-input"
                  placeholder="0x..."
                  value={form.lendingAsset}
                  onChange={(e) =>
                    setField("lendingAsset", e.target.value.trim())
                  }
                  readOnly={lockAssetContinuity}
                  disabled={lockAssetContinuity}
                  required
                />
                <span className="form-hint">
                  {lockAssetContinuity
                    ? "Pinned to the original loan — the settlement reverts on a mismatch."
                    : "Enter the NFT collection's contract address manually."}
                </span>
              </>
            ) : (
              <AssetPicker
                mode="top"
                chainId={chainId}
                value={form.lendingAsset}
                onChange={(addr) => setField("lendingAsset", addr)}
                label={`Token Contract Address${lockAssetContinuity ? " · locked" : ""}`}
                required
                disabled={lockAssetContinuity}
                hint={
                  lockAssetContinuity
                    ? "Pinned to the original loan."
                    : undefined
                }
              />
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">
                {isRental ? "Daily Rental Fee" : "Amount"}
              </label>
              <input
                className="form-input"
                type="number"
                step="any"
                min="0"
                placeholder={isRental ? "10" : "1000"}
                value={form.amount}
                onChange={(e) => setField("amount", e.target.value)}
                required
              />
              <span className="form-hint">
                {isRental
                  ? "Daily rate in whole tokens"
                  : "Amount in whole tokens (scaled on-chain using the token's decimals)"}
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">
                Interest Rate / Rental Rate (APR %)
              </label>
              <input
                className="form-input"
                type="number"
                step="0.01"
                min="0"
                placeholder="5.00"
                value={form.interestRate}
                onChange={(e) => setField("interestRate", e.target.value)}
                required
              />
              <span className="form-hint">
                Stored in basis points (5% = 500 BPS)
              </span>
            </div>
          </div>

          {isRental && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Token ID</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  placeholder="1234"
                  value={form.tokenId}
                  onChange={(e) => setField("tokenId", e.target.value)}
                  required
                />
              </div>
              {form.assetType === "erc1155" && (
                <div className="form-group">
                  <label className="form-label">Quantity</label>
                  <input
                    className="form-input"
                    type="number"
                    min="1"
                    placeholder="1"
                    value={form.quantity}
                    onChange={(e) => setField("quantity", e.target.value)}
                    required
                  />
                </div>
              )}
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="create-offer-duration">
              Duration (Days)
            </label>
            <input
              id="create-offer-duration"
              className={`form-input ${durationOutOfRange ? "form-input-error" : ""}`}
              type="number"
              min="1"
              max="365"
              step="1"
              placeholder="30"
              value={form.durationDays}
              onChange={(e) => setField("durationDays", e.target.value)}
              aria-invalid={durationOutOfRange || undefined}
              aria-describedby="create-offer-duration-hint"
              required
            />
            <span
              id="create-offer-duration-hint"
              className={`form-hint ${durationOutOfRange ? "form-hint-error" : ""}`}
              role={durationOutOfRange ? "alert" : undefined}
            >
              {durationOutOfRange ? (
                <>Enter Duration between 1 and 365</>
              ) : (
                <>
                  Grace period:{" "}
                  {form.durationDays
                    ? gracePeriodLabel(parseInt(form.durationDays, 10))
                    : "enter duration to see"}
                </>
              )}
            </span>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">Collateral</div>

          {(isRental || lockAssetContinuity) && (
            <div className="form-group">
              <AssetPicker
                mode="stablecoin"
                chainId={chainId}
                value={form.prepayAsset}
                onChange={(addr) => setField("prepayAsset", addr)}
                label={`Prepayment Asset (Stablecoin)${lockAssetContinuity ? " · locked" : ""}`}
                hint={
                  lockAssetContinuity
                    ? "Pinned to the original loan."
                    : "Stablecoin used for rental fee prepayment + 5% buffer"
                }
                disabled={lockAssetContinuity}
              />
            </div>
          )}

          {showAdvanced && (
            <div className="form-group">
              <label className="form-label">
                Collateral Asset Type
                {lockAssetContinuity && (
                  <span className="form-lock-badge"> · locked</span>
                )}
                <DetectionBadge
                  detection={collateralDetection}
                  selected={form.collateralAssetType}
                />
              </label>
              <div className="form-hint">
                Auto-detected from the collateral contract address.
              </div>
            </div>
          )}

          <div className="form-group">
            {form.collateralAssetType === "erc20" ? (
              <AssetPicker
                mode="top"
                chainId={chainId}
                value={form.collateralAsset}
                onChange={(addr) => setField("collateralAsset", addr)}
                label={`Collateral Contract Address${lockAssetContinuity ? " · locked" : ""}`}
                disabled={lockAssetContinuity}
                hint={
                  lockAssetContinuity
                    ? "Pinned to the original loan."
                    : undefined
                }
              />
            ) : (
              <>
                <label className="form-label">
                  Collateral Contract Address
                  {lockAssetContinuity && (
                    <span className="form-lock-badge"> · locked</span>
                  )}
                </label>
                <input
                  className="form-input"
                  placeholder="0x..."
                  value={form.collateralAsset}
                  onChange={(e) =>
                    setField("collateralAsset", e.target.value.trim())
                  }
                  readOnly={lockAssetContinuity}
                  disabled={lockAssetContinuity}
                />
                <span className="form-hint">
                  {lockAssetContinuity
                    ? "Pinned to the original loan — the settlement reverts on a mismatch."
                    : "Enter the NFT collection's contract address manually."}
                </span>
              </>
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Collateral Amount</label>
              <input
                className="form-input"
                type="number"
                step="any"
                min="0"
                placeholder="1500"
                value={form.collateralAmount}
                onChange={(e) => setField("collateralAmount", e.target.value)}
              />
            </div>
            {form.collateralAssetType !== "erc20" && (
              <div className="form-group">
                <label className="form-label">Collateral Token ID</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={form.collateralTokenId}
                  onChange={(e) =>
                    setField("collateralTokenId", e.target.value)
                  }
                />
              </div>
            )}
            {form.collateralAssetType === "erc1155" && (
              <div className="form-group">
                <label className="form-label">Collateral Quantity</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={form.collateralQuantity}
                  onChange={(e) =>
                    setField("collateralQuantity", e.target.value)
                  }
                />
              </div>
            )}
          </div>
        </div>

        {/* Risk disclosures — per README §Frontend Warnings, these must be
            surfaced to every user, not hidden behind "advanced options". */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">Risk Disclosures</div>

          <div className="alert alert-warning" style={{ marginTop: 0 }}>
            <AlertTriangle size={18} />
            <div>
              <strong>{FALLBACK_CONSENT_TITLE}.</strong> {FALLBACK_CONSENT_BODY}
            </div>
          </div>

          <label className="checkbox-row" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={form.fallbackConsent}
              onChange={(e) => setField("fallbackConsent", e.target.checked)}
            />
            <span>{FALLBACK_CONSENT_CHECKBOX_LABEL}</span>
          </label>
        </div>

        {showAdvanced && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-title">Advanced Options</div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.keeperAccess}
                onChange={(e) => setField("keeperAccess", e.target.checked)}
              />
              <span>
                Enable authorized keeper / third-party execution access
                <small
                  style={{ display: "block", opacity: 0.75, marginTop: 2 }}
                >
                  This is the <strong>position-level</strong> flag only. By
                  itself it is <strong>not</strong> sufficient — before any
                  keeper can act on your behalf you must <em>also</em> enable
                  keeper access and add the keeper to your whitelist in your
                  advanced profile (Keepers page). Keeper authority is
                  role-scoped: your own profile opt-in + whitelist govern only
                  the actions your side is entitled to.
                </small>
              </span>
            </label>
          </div>
        )}

        <div className="form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={step !== "form"}
          >
            {step === "approving"
              ? "Approving Tokens..."
              : step === "creating"
                ? "Creating Offer..."
                : "Create Offer"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/app/offers")}
          >
            Cancel
          </button>
        </div>

        <div className="alert alert-info" style={{ marginTop: 16 }}>
          <Info size={18} />
          <span>
            Creating an offer will lock your assets in your personal escrow and
            mint a Vaipakam position NFT. The accepting party pays gas to
            initiate the loan.
          </span>
        </div>

        {form.assetType === "erc20" && (
          <div className="alert alert-info" style={{ marginTop: 12 }}>
            <Info size={18} />
            <span>
              <strong>Loan Initiation Fee (0.1%):</strong>{" "}
              {form.offerType === "lender"
                ? "When your offer is accepted, 0.1% of the lending amount will be routed to the Vaipakam treasury before the borrower receives the remaining 99.9%. The borrower still repays the full principal."
                : "When your request is funded, 0.1% of the lending amount will be routed to the Vaipakam treasury before you receive the remaining 99.9%. You still repay the full principal."}
            </span>
          </div>
        )}
      </form>
    </div>
  );
}

const DETECTION_LABEL: Record<DetectedAssetType, string> = {
  erc20: "ERC-20",
  erc721: "ERC-721",
  erc1155: "ERC-1155",
  unknown: "unknown",
};

function DetectionBadge({
  detection,
  selected,
}: {
  detection: { type: DetectedAssetType | null; loading: boolean };
  selected: OfferAssetKind;
}) {
  if (detection.loading) {
    return (
      <span className="asset-detect-badge asset-detect-pending">
        {" "}
        · detecting…
      </span>
    );
  }
  if (!detection.type) return null;
  if (detection.type === "unknown") {
    return (
      <span className="asset-detect-badge asset-detect-unknown">
        {" "}
        · could not auto-detect
      </span>
    );
  }
  const label = DETECTION_LABEL[detection.type];
  const matches = detection.type === selected;
  return (
    <span
      className={`asset-detect-badge ${matches ? "asset-detect-match" : "asset-detect-mismatch"}`}
    >
      {" "}
      · detected {label}
    </span>
  );
}
