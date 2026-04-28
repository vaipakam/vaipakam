import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { parseAbi, parseUnits, type Abi, type Address, type Hex, encodeFunctionData } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { useWallet } from "../context/WalletContext";
import { useMode } from "../context/ModeContext";
import { useDiamondContract } from "../contracts/useDiamond";
import { useERC20 } from "../contracts/useERC20";
import { useOfferForm } from "../hooks/useOfferForm";
import {
  isNFTRental,
  gracePeriodLabel,
  MIN_OFFER_DURATION_DAYS,
  MAX_OFFER_DURATION_DAYS,
  type OfferFormState,
  type OfferAssetKind,
  type OfferSide,
} from "../lib/offerSchema";
import { decodeContractError } from "../lib/decodeContractError";
import { beginStep, emit } from "../lib/journeyLog";
import { DEFAULT_CHAIN } from "../contracts/config";
import { AlertTriangle, Info, CheckCircle, Wallet, Coins } from "lucide-react";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { SanctionsBanner } from "../components/app/SanctionsBanner";
import { RiskDisclosures } from "../components/app/RiskDisclosures";
import { SimulationPreview } from "../components/app/SimulationPreview";
import { LiquidityPreflightBanner } from "../components/app/LiquidityPreflightBanner";
import { useLiquidityPreflight } from "../hooks/useLiquidityPreflight";
import { usePermit2Signing } from "../hooks/usePermit2Signing";
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from "../contracts/abis";
import { L as Link } from "../components/L";
import { AssetPicker } from "../components/app/AssetPicker";
import { TokenInfoTag } from "../components/app/TokenInfoTag";
import { useAssetType, type DetectedAssetType } from "../hooks/useAssetType";
import { CardInfo } from "../components/CardInfo";
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
  const { t } = useTranslation();
  const { address, chainId, activeChain, isCorrectChain } = useWallet();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { mode } = useMode();
  const showAdvanced = mode === "advanced";
  const diamond = useDiamondContract();
  const { sign: permit2Sign, canSign: permit2CanSign } = usePermit2Signing();
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

  // Bounds come from `offerSchema.ts` so the validator, this inline
  // out-of-range check, and the Offer Book duration filter never drift
  // apart. Empty string is treated as "not yet entered" rather than
  // invalid — submit-time validation still catches the blank case.
  const durationOutOfRange = (() => {
    const raw = form.durationDays;
    if (raw === "") return false;
    const n = Number(raw);
    return !Number.isFinite(n) || n < MIN_OFFER_DURATION_DAYS || n > MAX_OFFER_DURATION_DAYS;
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

      // Permit2 eligibility: OfferFacet.createOfferWithPermit only accepts
      // ERC-20 creator pulls. Pre-compute the target token+amount so we
      // can skip the classic `approve` leg entirely when the wallet can
      // sign a Permit2 payload.
      const permit2Target: { token: Address; amount: bigint } | null = (() => {
        if (form.offerType === "lender") {
          if (form.assetType === "erc20") {
            return {
              token: form.lendingAsset as Address,
              amount: payload.amount,
            };
          }
          return null;
        }
        if (form.assetType === "erc20") {
          if (form.collateralAssetType === "erc20") {
            return {
              token: form.collateralAsset as Address,
              amount: payload.collateralAmount,
            };
          }
          return null;
        }
        const prepayBase = payload.amount * BigInt(payload.durationDays);
        const totalPrepay =
          (prepayBase * (BASIS_POINTS + RENTAL_BUFFER_BPS)) / BASIS_POINTS;
        return { token: form.prepayAsset as Address, amount: totalPrepay };
      })();

      if (permit2Target && permit2CanSign) {
        // Try the single-tx Permit2 path first. On any failure — wallet
        // refuses EIP-712, no Permit2 allowance, user cancels, unexpected
        // revert — fall through to the classic approve+create flow below.
        const permitStep = beginStep({ ...ctx, step: "createOffer-permit2" });
        try {
          setStep("creating");
          const { permit, signature } = await permit2Sign({
            token: permit2Target.token,
            amount: permit2Target.amount,
            spender: diamondAddr as Address,
          });
          const tx = await (
            diamond as unknown as {
              createOfferWithPermit: (
                p: unknown,
                permit: unknown,
                signature: Hex,
              ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
            }
          ).createOfferWithPermit(payload, permit, signature);
          setTxHash(tx.hash);
          await tx.wait();
          permitStep.success({ note: `tx ${tx.hash} via Permit2` });
          setStep("success");
          submit.success();
          return;
        } catch (permitErr) {
          permitStep.failure(permitErr);
          // fall through to classic path
        }
      }

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
        <h3>{t('createOffer.connectTitle')}</h3>
        <p>{t('createOffer.connectBody')}</p>
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
        <h3>{t('createOffer.successTitle')}</h3>
        <p>{t('createOffer.successBody')}</p>
        {txHash && (
          <a
            href={`${(activeChain && isCorrectChain ? activeChain.blockExplorer : null) ?? DEFAULT_CHAIN.blockExplorer}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm"
            style={{ marginBottom: 8 }}
          >
            {t('createOffer.viewTransaction')}
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
            {t('createOffer.createAnother')}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => navigate("/app/offers")}
          >
            {t('createOffer.viewOfferBook')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="create-offer">
      <div className="page-header">
        <h1 className="page-title">{t('appNav.createOffer')}</h1>
        <p className="page-subtitle">
          {form.offerType === "lender"
            ? t('createOffer.subtitleLender')
            : t('createOffer.subtitleBorrower')}
        </p>
      </div>

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

      {/* Phase 4.3 — pre-flight Chainalysis sanctions check on the
          connected wallet. Renders nothing when the oracle isn't
          configured on this chain or when the wallet is clean; on a
          hit, users see the reason BEFORE they sign the createOffer
          tx that would otherwise revert at the protocol layer. */}
      {address && (
        <SanctionsBanner
          address={address as `0x${string}`}
          label={t('banners.sanctionsLabelWallet')}
        />
      )}

      <form onSubmit={handleSubmit}>
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">
            {t('createOffer.offerType')}
            <CardInfo id="create-offer.offer-type" />
          </div>
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
              {t('createOffer.iWantToLend')}
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
              {t('createOffer.iWantToBorrow')}
            </button>
          </div>

          {/* Asset-type detection indicator moved out of the Offer Type
              card to sit inline next to the Lending Asset address field
              (where the detection actually applies). The form-state
              `assetType` is still auto-set by the detection effect — only
              the visual indicator was relocated. */}
        </div>

        {!isIlliquidForm && (
          <div
            className="card"
            style={{
              marginBottom: 20,
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
                {form.offerType === "borrower" ? (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>
                      {t('lenderDiscountCard.borrowerTitle')}
                    </div>
                    <p className="stat-label" style={{ margin: "0 0 8px" }}>
                      {t('lenderDiscountCard.borrowerBody1')}
                      <a href="/buy-vpfi" target="_blank" rel="noopener noreferrer">
                        {t('lenderDiscountCard.buyVpfi')}
                      </a>
                      {t('lenderDiscountCard.routingNote')}
                    </p>
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>
                      {t('lenderDiscountCard.lenderTitle')}
                    </div>
                    <p className="stat-label" style={{ margin: "0 0 8px" }}>
                      {t('lenderDiscountCard.lenderBody1')}
                      <a href="/buy-vpfi" target="_blank" rel="noopener noreferrer">
                        {t('lenderDiscountCard.buyVpfi')}
                      </a>
                      {t('lenderDiscountCard.routingNote')}
                    </p>
                  </>
                )}
                <Link to="/app" className="btn btn-secondary btn-sm">
                  {t('lenderDiscountCard.enableConsent')}
                </Link>
              </div>
            </div>
          </div>
        )}

        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">
            {isRental ? t('createOffer.nftDetails') : t('createOffer.lendingAsset')}
            <CardInfo
              id={
                isRental
                  ? 'create-offer.nft-details'
                  : 'create-offer.lending-asset'
              }
              role={isRental ? undefined : form.offerType}
            />
          </div>

          <div className="form-group">
            {isRental ? (
              <>
                <label className="form-label">
                  {t('createOffer.nftContractAddress')}
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
                    ? t('createOffer.hintAddressLocked')
                    : t('createOffer.hintNftAddressManual')}
                </span>
              </>
            ) : (
              <>
                <AssetPicker
                  mode="top"
                  chainId={chainId}
                  value={form.lendingAsset}
                  onChange={(addr) => setField("lendingAsset", addr)}
                  label={`${t('createOffer.tokenContractAddressLabel')}${lockAssetContinuity ? ` ${t('createOffer.lockedSuffix')}` : ""}`}
                  required
                  disabled={lockAssetContinuity}
                  hint={
                    lockAssetContinuity
                      ? t('createOffer.hintAddressLockedShort')
                      : undefined
                  }
                />
                {/* Trust + identification block: symbol + name + market-
                    cap rank when the address is on the CoinGecko
                    registry, on-chain symbol/name fallback otherwise,
                    block-explorer link, and a phishing warning when
                    the address is unlisted or ranked outside top 200.
                    Visible to both Basic and Advanced users — phishing
                    protection isn't gated. The decimals field is the
                    only Advanced-only detail (kept inside the
                    component). */}
                {/* The bare on-chain "detected ERC-20" classification
                    badge stays Advanced-only — a technical diagnostic
                    that rides on the same line as symbol/name/decimals
                    via TokenInfoTag's inlineBadge slot. */}
                <TokenInfoTag
                  chainId={chainId}
                  address={form.lendingAsset}
                  blockExplorer={
                    activeChain?.blockExplorer ?? DEFAULT_CHAIN.blockExplorer
                  }
                  showAdvanced={showAdvanced}
                  inlineBadge={
                    showAdvanced ? (
                      <DetectionBadge
                        detection={lendingDetection}
                        selected={form.assetType}
                      />
                    ) : null
                  }
                />
              </>
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">
                {isRental ? t('createOffer.dailyRentalFee') : t('createOffer.amount')}
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
                  ? t('createOffer.hintAmountDaily')
                  : t('createOffer.hintAmountTokens')}
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">
                {t('createOffer.interestRate')}
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
              <span className="form-hint">{t('createOffer.hintInterestBps')}</span>
            </div>
          </div>

          {isRental && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('createOffer.tokenId')}</label>
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
                  <label className="form-label">{t('createOffer.quantity')}</label>
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
              {t('createOffer.duration')}
            </label>
            <input
              id="create-offer-duration"
              className={`form-input ${durationOutOfRange ? "form-input-error" : ""}`}
              type="number"
              min={MIN_OFFER_DURATION_DAYS}
              max={MAX_OFFER_DURATION_DAYS}
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
                <>{t('createOffer.hintDurationOutOfRange')}</>
              ) : (
                <>
                  {t('createOffer.hintDurationGracePrefix')}{' '}
                  {form.durationDays
                    ? gracePeriodLabel(parseInt(form.durationDays, 10))
                    : t('createOffer.hintDurationEnterToSee')}
                </>
              )}
            </span>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">
            {t('createOffer.collateral')}
            <CardInfo id="create-offer.collateral" role={form.offerType} />
          </div>

          {(isRental || lockAssetContinuity) && (
            <div className="form-group">
              <AssetPicker
                mode="stablecoin"
                chainId={chainId}
                value={form.prepayAsset}
                onChange={(addr) => setField("prepayAsset", addr)}
                label={`${t('createOffer.prepayAssetLabel')}${lockAssetContinuity ? ` ${t('createOffer.lockedSuffix')}` : ""}`}
                hint={
                  lockAssetContinuity
                    ? t('createOffer.hintAddressLockedShort')
                    : t('createOffer.prepayAssetHint')
                }
                disabled={lockAssetContinuity}
              />
            </div>
          )}

          {/* Collateral-asset-type detection indicator moved inline below
              the Collateral address field (see below) — same pattern as
              the Lending Asset card. Form-state `collateralAssetType` is
              still auto-set by the detection effect; only the visual
              indicator was relocated. */}

          <div className="form-group">
            {form.collateralAssetType === "erc20" ? (
              <>
                <AssetPicker
                  mode="top"
                  chainId={chainId}
                  value={form.collateralAsset}
                  onChange={(addr) => setField("collateralAsset", addr)}
                  label={`${t('createOffer.collateralContractAddressLabel')}${lockAssetContinuity ? ` ${t('createOffer.lockedSuffix')}` : ""}`}
                  disabled={lockAssetContinuity}
                  hint={
                    lockAssetContinuity
                      ? t('createOffer.hintAddressLockedShort')
                      : undefined
                  }
                />
                <TokenInfoTag
                  chainId={chainId}
                  address={form.collateralAsset}
                  blockExplorer={
                    activeChain?.blockExplorer ?? DEFAULT_CHAIN.blockExplorer
                  }
                  showAdvanced={showAdvanced}
                  inlineBadge={
                    showAdvanced ? (
                      <DetectionBadge
                        detection={collateralDetection}
                        selected={form.collateralAssetType}
                      />
                    ) : null
                  }
                />
              </>
            ) : (
              <>
                <label className="form-label">
                  {t('createOffer.collateralContractAddress')}
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
                    ? t('createOffer.hintAddressLocked')
                    : t('createOffer.hintNftAddressManual')}
                </span>
              </>
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('createOffer.collateralAmount')}</label>
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
                <label className="form-label">{t('createOffer.collateralTokenId')}</label>
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
                <label className="form-label">{t('createOffer.collateralQuantity')}</label>
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
            surfaced to every user, not hidden behind "advanced options".
            No CardInfo (i) icon next to the title: a help-tooltip cue
            confuses the reader into treating the disclosures as
            optional reading rather than the required dual-consent
            surface they are. The title text stays so the section is
            still labelled. */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">
            {t('createOffer.riskDisclosures')}
          </div>

          <RiskDisclosures />

          <label className="checkbox-row" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={form.fallbackConsent}
              onChange={(e) => setField("fallbackConsent", e.target.checked)}
            />
            <span>{t('riskDisclosures.checkboxLabel')}</span>
          </label>
        </div>

        {showAdvanced && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-title">
              {t('createOffer.advancedOptions')}
              <CardInfo id="create-offer.advanced-options" />
            </div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.keeperAccess}
                onChange={(e) => setField("keeperAccess", e.target.checked)}
              />
              <span>
                {t('createOffer.keeperAccessLabel')}
                <small
                  style={{ display: "block", opacity: 0.75, marginTop: 2 }}
                >
                  {t('createOffer.keeperAccessHintPrefix')}
                  <strong>{t('createOffer.keeperAccessHintPositionLevel')}</strong>
                  {t('createOffer.keeperAccessHintMid1')}
                  <strong>{t('createOffer.keeperAccessHintNot')}</strong>
                  {t('createOffer.keeperAccessHintMid2')}
                  <em>{t('createOffer.keeperAccessHintAlso')}</em>
                  {t('createOffer.keeperAccessHintSuffix')}
                </small>
              </span>
            </label>
          </div>
        )}

        {/* Phase 7b.1 — 0x liquidity preflight. UX-only guard that
            checks 0x can route the user's collateral → principal pair
            at acceptable slippage BEFORE they commit. The on-chain
            `OracleFacet.checkLiquidity` 3-V3-clone OR-logic is the
            actual security boundary; this banner exists so a user
            doesn't sign a tx that would leave them with a hard-to-
            liquidate loan. Skipped automatically for NFT rentals and
            non-ERC20 collateral. */}
        <CreateOfferLiquidityPreflight
          form={form}
          chainId={chainId}
          diamondAddr={
            ((activeChain && isCorrectChain
              ? activeChain.diamondAddress
              : null) ?? DEFAULT_CHAIN.diamondAddress) as Address
          }
        />

        {/* Phase 8b.2 — Blockaid preview of the pending createOffer
            tx. Encodes the current form state into calldata so the
            user sees exactly what their approval + create will move
            before signing. Silently hides when the form isn't
            buildable yet (missing required fields / decimals still
            loading) or when the Blockaid API key isn't configured. */}
        <CreateOfferSimulationPreview
          toPayload={toPayload}
          diamondAddr={
            ((activeChain && isCorrectChain
              ? activeChain.diamondAddress
              : null) ?? DEFAULT_CHAIN.diamondAddress) as Address
          }
        />

        <div className="form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={step !== "form" || !form.fallbackConsent}
            data-tooltip={
              step === "form" && !form.fallbackConsent
                ? t('riskDisclosures.checkboxLabel')
                : undefined
            }
          >
            {step === "approving"
              ? t('createOffer.approving')
              : step === "creating"
                ? t('createOffer.creating')
                : t('appNav.createOffer')}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/app/offers")}
          >
            {t('common.cancel')}
          </button>
        </div>

        <div className="alert alert-info" style={{ marginTop: 16 }}>
          <Info size={18} />
          <span>{t('createOffer.lockAssetsAlert')}</span>
        </div>

        {form.assetType === "erc20" && (
          <div className="alert alert-info" style={{ marginTop: 12 }}>
            <Info size={18} />
            <span>
              <strong>{t('createOffer.lifLabel')}</strong>{' '}
              {form.offerType === "lender"
                ? t('createOffer.lifLenderBody')
                : t('createOffer.lifBorrowerBody')}
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
  // The badge used to sit inline next to a "Asset Type" label — the
  // leading "· " was a label/value separator. Now that the badge
  // renders standalone below the address field, the separator is
  // orphan visual noise, so it's gone.
  if (detection.loading) {
    return (
      <span className="asset-detect-badge asset-detect-pending">
        detecting…
      </span>
    );
  }
  if (!detection.type) return null;
  if (detection.type === "unknown") {
    return (
      <span className="asset-detect-badge asset-detect-unknown">
        could not auto-detect
      </span>
    );
  }
  const label = DETECTION_LABEL[detection.type];
  const matches = detection.type === selected;
  return (
    <span
      className={`asset-detect-badge ${matches ? "asset-detect-match" : "asset-detect-mismatch"}`}
    >
      detected {label}
    </span>
  );
}

/**
 * Phase 8b.2 — encodes the pending createOffer calldata from the
 * current form state and hands it to SimulationPreview. Catches
 * conversion errors (form still incomplete, bad numeric input) and
 * silently hides the panel instead of surfacing an ugly trace.
 */
function CreateOfferSimulationPreview({
  toPayload,
  diamondAddr,
}: {
  // Accept any 0-arg function returning a CreateOfferPayload-shaped
  // struct — avoids a type-import cycle for this wrapper component.
  toPayload: () => unknown;
  diamondAddr: Address;
}) {
  let data: Hex | null = null;
  try {
    const payload = toPayload();
    data = encodeFunctionData({
      abi: DIAMOND_ABI,
      functionName: "createOffer",
      args: [payload],
    }) as Hex;
  } catch {
    data = null;
  }
  return (
    <SimulationPreview tx={data ? { to: diamondAddr, data, value: 0n } : null} />
  );
}

const PREFLIGHT_WORKER_ORIGIN =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_HF_WATCHER_ORIGIN ?? null;

/**
 * Phase 7b.1 — wraps {useLiquidityPreflight} for CreateOffer's form
 * shape. Translates the form state into the hook's input contract
 * (ERC20 collateral + ERC20 principal + bigint amount), then renders
 * the {LiquidityPreflightBanner}. Skipped automatically for NFT
 * rentals and non-ERC20 collateral via the hook's enabled gate.
 *
 * Decimals approximation: we don't await an on-chain decimals() read
 * here for snappy form feedback. A 6-decimal collateral (USDC, USDT)
 * gets queried at 1e12× the user's intended size, which 0x will
 * usually classify as "no route" — a false-negative banner. The
 * banner is informational; submission is never blocked. The actual
 * createOffer + acceptOffer flows compute decimals via on-chain
 * calls. A future iteration can read decimals here too.
 */
function CreateOfferLiquidityPreflight({
  form,
  chainId,
  diamondAddr,
}: {
  form: OfferFormState;
  chainId: number | undefined | null;
  diamondAddr: Address;
}) {
  let amount: bigint = 0n;
  if (form.assetType === "erc20" && form.collateralAssetType === "erc20") {
    try {
      amount = parseUnits(form.collateralAmount || "0", 18);
    } catch {
      amount = 0n;
    }
  }
  const result = useLiquidityPreflight({
    collateralAsset: (form.collateralAsset || null) as Address | null,
    principalAsset:
      form.assetType === "erc20"
        ? ((form.lendingAsset || null) as Address | null)
        : null,
    collateralAmount: amount,
    collateralAssetType: form.collateralAssetType,
    chainId,
    diamond: diamondAddr,
    workerOrigin: PREFLIGHT_WORKER_ORIGIN,
  });
  return <LiquidityPreflightBanner result={result} compact />;
}
