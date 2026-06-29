import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { parseAbi, parseUnits, formatUnits, type Abi, type Address, type Hex, encodeFunctionData } from "viem";
import { useWalletClient } from "wagmi";
import { useWallet } from "../context/WalletContext";
import { useMode } from "../context/ModeContext";
import { useDiamondContract, useDiamondPublicClient } from "../contracts/useDiamond";
import { useERC20 } from "../contracts/useERC20";
import { useOfferForm } from "../hooks/useOfferForm";
import { useProtocolConfig } from "../hooks/useProtocolConfig";
import { usePeriodicInterestConfig } from "../hooks/usePeriodicInterestConfig";
import { PeriodicInterestCadenceField } from "../components/createOffer/PeriodicInterestCadenceField";
import {
  isNFTRental,
  gracePeriodLabel,
  MIN_OFFER_DURATION_DAYS,
  MAX_OFFER_DURATION_DAYS,
  OFFER_DURATION_BUCKETS_DAYS,
  type OfferFormState,
  type OfferAssetKind,
  type OfferSide,
} from "../lib/offerSchema";
import { decodeContractError } from "@vaipakam/lib/decodeContractError";
import { beginStep, emit } from "../lib/journeyLog";
import { DEFAULT_CHAIN } from "../contracts/config";
import { AlertTriangle, Info, CheckCircle, Wallet, Coins } from "lucide-react";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { SanctionsBanner } from "../components/app/SanctionsBanner";
import { RiskDisclosures, RiskConsentLabel } from "../components/app/RiskDisclosures";
import { SimulationPreview } from "../components/app/SimulationPreview";
import { LiquidityPreflightBanner } from "../components/app/LiquidityPreflightBanner";
import { OfferRiskPreview } from "../components/app/OfferRiskPreview";
import { useLiquidityPreflight } from "../hooks/useLiquidityPreflight";
import {
  useMidTierAckGate,
  type RiskPairId,
  type MidTierAckGate,
} from "../hooks/useMidTierAckGate";

/** Map the form's asset-kind string to the contract's `AssetType` enum
 *  (0 = ERC20, 1 = ERC721, 2 = ERC1155) for the risk-access PairId. */
const ASSET_KIND_ENUM: Record<OfferAssetKind, number> = {
  erc20: 0,
  erc721: 1,
  erc1155: 2,
};
import { useAssetLiquidity } from "../hooks/useAssetLiquidity";
import { usePermit2Signing } from "../hooks/usePermit2Signing";
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from "@vaipakam/contracts/abis";
import { L as Link } from "../components/L";
import { AssetPicker } from "../components/app/AssetPicker";
import { Picker } from "@vaipakam/ui/Picker";
import { TokenInfoTag } from "../components/app/TokenInfoTag";
import { useAssetType, type DetectedAssetType } from "../hooks/useAssetType";
import { CardInfo } from "../components/CardInfo";
import "./CreateOffer.css";

type SubmitStep = "form" | "approving" | "creating" | "success";

// Math constant only — `RENTAL_BUFFER_BPS` was previously hardcoded
// here at 500n (5%) but now flows from the live protocol-config bundle
// (`getProtocolConfigBundle().rentalBufferBps`). The component reads it
// via `useProtocolConfig()` and feeds it into the prepay calculation.
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
  const publicClient = useDiamondPublicClient();
  const { data: walletClient } = useWalletClient();
  const { mode } = useMode();
  const showAdvanced = mode === "advanced";
  // Range Orders Phase 1 — the two range-input UIs are gated on BOTH
  // the user being in Advanced mode AND governance having flipped
  // the relevant master flag on. When either is false we render the
  // single-value form unchanged (form.amountMax / form.interestRateMax
  // stay empty → the schema's auto-collapse produces 0 in the payload
  // → the contract treats the offer as single-value).
  // protocolConfig is fetched below; the flags are surfaced through
  // its bundle. While the config is still loading (`null`) we err on
  // the side of "ranges off" so users never see broken sliders during
  // the first render.
  const diamond = useDiamondContract();
  const { sign: permit2Sign, canSign: permit2CanSign } = usePermit2Signing();
  // Live protocol config — `rentalBufferBps` was previously hardcoded
  // at 500n (5%) on this page; the contract exposes it via
  // `getProtocolConfigBundle` and any governance change should flow
  // straight through to the prepay calculation below.
  const { config: protocolConfig } = useProtocolConfig();
  // T-034 — Periodic Interest Payment config; null while loading or on
  // older deploys without the surface (treated as feature disabled).
  const { config: periodicConfig } = usePeriodicInterestConfig();
  const rentalBufferBps = protocolConfig
    ? BigInt(protocolConfig.rentalBufferBps)
    : 500n; // fall back to compile-time default during the first render
  // Issue #165 / ADR-0010 §17 — under the canonical limit-order GTC
  // semantic the user enters ONE value per field per role; the
  // contract's min/max routing happens in `toCreateOfferPayload`.
  // The legacy Advanced-mode min/max sliders are no longer the
  // canonical surface. We force these flags off so the dual-input
  // row at lines ~1042-1089 stays hidden under every mode. The form-
  // state `amountMax` / `interestRateMax` / `collateralAmountMax`
  // fields remain in `OfferFormState` for backwards-compat with any
  // deep-linked URL that still carries them, but the payload
  // translation ignores them under the GTC mapping.
  const showAmountRange = false;
  const showRateRange = false;
  // Banner-copy interpolation params for the lender / borrower discount
  // banners — surface live treasury fee, loan-initiation fee, and the
  // top-tier discount % so governance changes flow into the marketing
  // copy without a frontend redeploy.
  const discountBannerParams = protocolConfig
    ? {
        treasuryFee: protocolConfig.treasuryFeeBps % 100 === 0
          ? (protocolConfig.treasuryFeeBps / 100).toString()
          : (protocolConfig.treasuryFeeBps / 100).toFixed(2).replace(/\.?0+$/, ''),
        loanInitiationFee: protocolConfig.loanInitiationFeeBps % 100 === 0
          ? (protocolConfig.loanInitiationFeeBps / 100).toString()
          : (protocolConfig.loanInitiationFeeBps / 100).toFixed(2).replace(/\.?0+$/, ''),
        maxDiscount: (() => {
          const max = Math.max(...protocolConfig.tierDiscountBps);
          return max % 100 === 0
            ? (max / 100).toString()
            : (max / 100).toFixed(2).replace(/\.?0+$/, '');
        })(),
      }
    : { treasuryFee: '1', loanInitiationFee: '0.1', maxDiscount: '24' };
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Deep-link prefill. Two sources:
  //  - `from=refinance|offset` — the Refinance / Offset flows; the query
  //    string encodes the original loan's asset-continuity fields
  //    (principal, collateral, prepay asset types must match or the
  //    on-chain settlement reverts). We prefill + lock those fields and
  //    show a banner so the user doesn't discover the mismatch via a
  //    failed tx.
  //  - `from=market-widget` — the OfferBook's "Lend / Borrow at market
  //    rate" widget. Prefills side, the asset pair, lending amount, the
  //    auto-computed minimum collateral, the duration bucket, and (when
  //    a prior match exists) the market mid rate. Nothing is locked —
  //    the user reviews/adjusts everything here, and the min-collateral
  //    floor is re-enforced by the form's HF≥1.5 validation, not by
  //    disabling the field.
  const prefill = useMemo<Partial<OfferFormState> | undefined>(() => {
    const from = searchParams.get("from");
    if (from !== "refinance" && from !== "offset" && from !== "market-widget")
      return undefined;
    const get = (k: string) => searchParams.get(k) ?? undefined;
    const out: Partial<OfferFormState> = {};
    if (from === "market-widget") {
      const side = get("side");
      if (side === "lender" || side === "borrower") out.offerType = side as OfferSide;
      const la = get("lendingAsset");
      if (la) out.lendingAsset = la;
      const ca = get("collateralAsset");
      if (ca) out.collateralAsset = ca;
      const amt = get("amount");
      if (amt) out.amount = amt;
      const collAmt = get("collateralAmount");
      if (collAmt) out.collateralAmount = collAmt;
      const dur = get("durationDays");
      if (dur && /^\d+$/.test(dur)) out.durationDays = dur;
      const rate = get("interestRate");
      if (rate) out.interestRate = rate;
      return out;
    }
    const ot = get("offerType");
    const at = get("collateralAssetType") as OfferAssetKind | undefined;
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

  // #735 item 3 — the progressive-risk gate enforces a strict-mode mid-tier
  // acknowledgement at CREATE too (`OfferCreateFacet`), not only at accept. Build
  // the risk-access pair from the live form and ask the contract whether THIS
  // creator must record a mid-tier ack for it before the create would succeed.
  // The contract view returns false unless it's genuinely a strict-mode mid-tier
  // block, so it's a no-op on every other deployment / pair (e.g. the gate off).
  const createPair = useMemo<RiskPairId | null>(() => {
    if (!form.lendingAsset || !form.collateralAsset) return null;
    try {
      return {
        lendAsset: form.lendingAsset,
        lendType: ASSET_KIND_ENUM[form.assetType],
        lendTokenId: BigInt(form.tokenId || "0"),
        collAsset: form.collateralAsset,
        collType: ASSET_KIND_ENUM[form.collateralAssetType],
        collTokenId: BigInt(form.collateralTokenId || "0"),
        prepayAsset:
          form.prepayAsset || "0x0000000000000000000000000000000000000000",
      };
    } catch {
      // A token-id field mid-typing (non-numeric) would throw in BigInt — treat
      // the pair as not-yet-buildable rather than crashing the form.
      return null;
    }
  }, [
    form.lendingAsset,
    form.assetType,
    form.tokenId,
    form.collateralAsset,
    form.collateralAssetType,
    form.collateralTokenId,
    form.prepayAsset,
  ]);
  const midTierGate = useMidTierAckGate(createPair);

  // Auto-detect asset standards (ERC-20/721/1155) whenever the user enters or
  // selects a contract address. Keeps the Asset Type toggles honest with what
  // the contract actually implements. Skipped while `lockAssetContinuity` —
  // refinance/offset flows must preserve the pinned original-loan types.
  const lendingDetection = useAssetType(form.lendingAsset || null);
  const collateralDetection = useAssetType(form.collateralAsset || null);
  // Live `checkLiquidity` on the ERC-20 collateral (NFT collateral is
  // expected-illiquid — the cross-chain "thin here" warning only makes
  // sense for an ERC-20 we'd expect to be liquid but isn't on this
  // chain). Drives the warning banner below.
  // #796 — drives the in-kind disclosure + submit gate. The default swap-vs-
  // in-kind decision is COLLATERAL-driven on-chain (`DefaultedFacet.triggerDefault`
  // routes on `checkLiquidityOnActiveNetwork(loan.collateralAsset)`), so only the
  // collateral's live liquidity matters here — an illiquid lending leg does NOT
  // force in-kind when the collateral is liquid (Codex r4 P2, superseding the r2
  // lending-leg read which has been removed).
  const collateralLiquidityStatus = useAssetLiquidity(
    form.collateralAssetType === "erc20" ? form.collateralAsset || null : null,
  );

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

  // T-086 Round-8 (#358) §19.5 — Codex round-13 P2 #1 — reset the
  // `allowsParallelSale` opt-in to false the moment the form leaves
  // the eligibility window (borrower offer + ERC721/ERC1155
  // collateral). Without this reset the toggle stays `true` in state
  // even though it's hidden from the UI; `toCreateOfferPayload`
  // would then submit `allowsParallelSale: true` + `fillMode = 1` on
  // a lender / ERC20-collateral offer, and `OfferCreateFacet` would
  // reject the tx with `ParallelSaleRequiresBorrowerOffer` or
  // `ParallelSaleRequiresNFTCollateral`. Defensive UX guard.
  useEffect(() => {
    if (!form.allowsParallelSale) return;
    // Codex round-16 P2 #4 — `OfferParallelSaleFacet._validatePostParallelSale`
    // ALSO rejects offers whose principal (lendingAsset) is non-ERC20
    // with `UnsupportedPrincipalForParallelSale`. Without this added
    // gate, an NFT-principal borrower offer (`assetType == ERC721 /
    // ERC1155`) with NFT collateral could still tick the toggle and
    // submit, only to revert at create time. Mirror the contract's
    // eligibility: borrower + ERC20 principal + NFT collateral.
    const eligible =
      form.offerType === "borrower" &&
      form.assetType === "erc20" &&
      (form.collateralAssetType === "erc721" ||
        form.collateralAssetType === "erc1155");
    if (!eligible) {
      setField("allowsParallelSale", false);
    }
  }, [
    form.allowsParallelSale,
    form.offerType,
    form.assetType,
    form.collateralAssetType,
    setField,
  ]);

  // #784 (Codex P2) — the Risk Disclosures term-interest line depends on the
  // offer's `assetType` (NFT rentals omit it), `useFullTermInterest`, and
  // `allowsPartialRepay` (the latter rendered BELOW the consent box in Advanced
  // Options). If any of these change after the user already ticked consent, the
  // binding disclosure text changed off-screen — force a fresh acknowledgement
  // by clearing consent. The ref seeds to the initial signature so mount is a
  // no-op; only a real post-mount change clears.
  // #796 (Codex r1 P2) — also key on the collateral's liquidity status: an
  // ERC-20 collateral that resolves to `illiquid` flips the in-kind disclosure
  // on, so a consent ticked before the async read resolved must re-prompt.
  const disclosureSig = `${form.assetType}|${form.useFullTermInterest}|${form.allowsPartialRepay}|${form.collateralAssetType}|${collateralLiquidityStatus}`;
  const disclosureSigRef = useRef(disclosureSig);
  useEffect(() => {
    if (disclosureSigRef.current === disclosureSig) return;
    disclosureSigRef.current = disclosureSig;
    if (form.riskAndTermsConsent) setField("riskAndTermsConsent", false);
  }, [disclosureSig, form.riskAndTermsConsent, setField]);

  // Live wallet-balance check. Compares the wallet's current balance
  // of the asset that will be pulled at offer-create time (lender →
  // lendingAsset, borrower-ERC20 → collateralAsset) against the
  // required amount, and surfaces a `balanceShortfall` shape the
  // form renders inline under the relevant input. Re-runs whenever
  // the asset, amount, max, or wallet changes — so a user who is
  // mid-typing sees the shortfall update in real time and can adjust
  // before the approve / create roundtrips. Uses a 250ms debounce
  // so each keystroke doesn't fire an RPC roundtrip.
  useEffect(() => {
    if (!address) {
      setBalanceShortfall(null);
      return;
    }
    type BalanceReader = {
      balanceOf: (a: string) => Promise<bigint>;
      decimals: () => Promise<number | bigint>;
      symbol: () => Promise<string>;
    };
    const readMeta = async (
      token: BalanceReader,
    ): Promise<{ decimals: number; symbol: string }> => {
      const [d, s] = await Promise.all([
        token.decimals().catch(() => 18 as number),
        token.symbol().catch(() => "tokens"),
      ]);
      return { decimals: Number(d), symbol: s };
    };
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        if (form.offerType === "lender" && form.assetType === "erc20" && erc20) {
          const { decimals, symbol } = await readMeta(
            erc20 as unknown as BalanceReader,
          );
          // Use amountMax if present, else amount.
          const minStr = form.amount.trim();
          const maxStr = form.amountMax.trim();
          const target = maxStr !== "" ? maxStr : minStr;
          if (target === "" || Number(target) <= 0) {
            if (!cancelled) setBalanceShortfall(null);
            return;
          }
          const need = parseUnits(target, decimals);
          const have = await (erc20 as unknown as BalanceReader).balanceOf(
            address as string,
          );
          if (cancelled) return;
          setBalanceShortfall(
            have < need
              ? { have, need, decimals, symbol, side: "lender" }
              : null,
          );
        } else if (
          form.offerType === "borrower" &&
          form.assetType === "erc20" &&
          form.collateralAssetType === "erc20" &&
          collateralErc20
        ) {
          const { decimals, symbol } = await readMeta(
            collateralErc20 as unknown as BalanceReader,
          );
          const target = form.collateralAmount.trim();
          if (target === "" || Number(target) <= 0) {
            if (!cancelled) setBalanceShortfall(null);
            return;
          }
          const need = parseUnits(target, decimals);
          const have = await (
            collateralErc20 as unknown as BalanceReader
          ).balanceOf(address as string);
          if (cancelled) return;
          setBalanceShortfall(
            have < need
              ? { have, need, decimals, symbol, side: "collateral" }
              : null,
          );
        } else {
          if (!cancelled) setBalanceShortfall(null);
        }
      } catch {
        // Swallow — a transient RPC blip shouldn't paint a stale or
        // misleading shortfall warning.
        if (!cancelled) setBalanceShortfall(null);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [
    address,
    form.offerType,
    form.assetType,
    form.collateralAssetType,
    form.amount,
    form.amountMax,
    form.collateralAmount,
    erc20,
    collateralErc20,
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
  // Live "you don't have enough X" feedback rendered under the
  // amount/collateral input so the user catches the shortfall before
  // hitting submit. Computed in a useEffect that re-runs as the
  // user types — see `balanceShortfall` block below.
  const [balanceShortfall, setBalanceShortfall] = useState<{
    have: bigint;
    need: bigint;
    decimals: number;
    symbol: string;
    side: "lender" | "collateral";
  } | null>(null);

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

  /**
   * Maps a `validateOfferForm` error to a localised user-facing string.
   * Each error code maps 1:1 to an `i18n` key under
   * `createOffer.validate.<code>`. The duration-out-of-range case
   * interpolates the live MIN/MAX bounds so the locale string can use
   * `{{min}}` / `{{max}}` placeholders.
   */
  const formatValidationError = (err: ReturnType<typeof validate>): string => {
    if (!err) return '';
    if (err.code === 'durationOutOfRange') {
      return t('createOffer.validate.durationOutOfRange', { min: err.min, max: err.max });
    }
    return t(`createOffer.validate.${err.code}`);
  };

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
      const localized = formatValidationError(validationError);
      setError(localized);
      emit({
        ...ctx,
        step: "validate-form",
        status: "failure",
        errorType: "validation",
        errorMessage: localized,
      });
      return;
    }

    // #735 item 3 — re-check the progressive-risk create gate HERE, not only on the
    // disabled button: an Enter keypress or a programmatic submit can fire
    // `onSubmit` while the verdict is loading or blocked, which would otherwise
    // send approvals + a createOffer the gate reverts (Codex #740 r8). Mirror the
    // button's `riskBlocked` exactly.
    const riskUnknown =
      createPair !== null &&
      (!midTierGate.tierKnown || !midTierGate.known);
    if (
      midTierGate.tierTooLow ||
      midTierGate.illiquidConsentNeeded ||
      midTierGate.blocked ||
      riskUnknown
    ) {
      const msg = midTierGate.tierTooLow
        ? "Raise your vault's risk tier to cover this pair first (Risk Access settings)."
        : midTierGate.illiquidConsentNeeded
          ? "Record the per-pair illiquid consent for this pair first."
          : midTierGate.blocked
            ? "Record the strict-mode mid-tier acknowledgement for this pair first."
            : "Checking the progressive-risk requirements — try again in a moment.";
      setError(msg);
      emit({
        ...ctx,
        step: "validate-form",
        status: "failure",
        errorType: "validation",
        errorMessage: msg,
      });
      return;
    }

    // #796 (Codex #809 r3/r5 P2) — mirror the button's `liquidityPending` block
    // here too: an Enter keypress / programmatic submit could otherwise fire
    // `onSubmit` while the ERC-20 collateral's liquidity read is unresolved,
    // before the in-kind disclosure line has had a chance to render and
    // (re)clear a prematurely-ticked consent. We treat BOTH `loading` and
    // `unknown` as unresolved (r5): a transient read failure returns `unknown`
    // for a valid ERC-20 the on-chain `checkLiquidity` may still classify
    // illiquid, so don't let submit slip through on it — a retry re-reads.
    if (
      form.collateralAssetType === "erc20" &&
      !!form.collateralAsset &&
      (collateralLiquidityStatus === "loading" ||
        collateralLiquidityStatus === "unknown")
    ) {
      const msg = "Checking asset liquidity to finalise the risk disclosures — try again in a moment.";
      setError(msg);
      emit({
        ...ctx,
        step: "validate-form",
        status: "failure",
        errorType: "validation",
        errorMessage: msg,
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
      // or borrower collateral/prepay) into their vault at creation time, so
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

      // Range Orders Phase 1 — lender pre-vaults the upper bound of
      // the amount range so partial fills can draw from the same
      // pool. `payload.amountMax` is 0 in single-value / collapsed
      // mode, in which case we fall back to `payload.amount` (the
      // single value the contract will use). When range mode is
      // active, the lender's approval / Permit2 sign covers the
      // ceiling, not the minimum — otherwise the contract's pull
      // (`params.amountMax`) would revert on insufficient allowance.
      const lenderPullAmount = payload.amountMax > 0n
        ? payload.amountMax
        : payload.amount;

      // Final guard against the inline `balanceShortfall` useEffect:
      // if the user fired submit while the inline check still flags
      // a shortfall, refuse to call any approve/create txs. The
      // inline UI already shows the actionable message under the
      // relevant input.
      if (balanceShortfall) {
        const have = formatUnits(
          balanceShortfall.have,
          balanceShortfall.decimals,
        );
        const need = formatUnits(
          balanceShortfall.need,
          balanceShortfall.decimals,
        );
        const sym = balanceShortfall.symbol;
        const msg =
          balanceShortfall.side === "lender"
            ? `Insufficient ${sym} balance: wallet holds ${have} ${sym}, offer requires ${need} ${sym}.`
            : `Insufficient ${sym} balance: wallet holds ${have} ${sym}, offer requires ${need} ${sym}.`;
        setError(msg);
        submit.failure(new Error(msg));
        return;
      }
      // Permit2 eligibility: OfferFacet.createOfferWithPermit only accepts
      // ERC-20 creator pulls. Pre-compute the target token+amount so we
      // can skip the classic `approve` leg entirely when the wallet can
      // sign a Permit2 payload.
      const permit2Target: { token: Address; amount: bigint } | null = (() => {
        if (form.offerType === "lender") {
          if (form.assetType === "erc20") {
            return {
              token: form.lendingAsset as Address,
              amount: lenderPullAmount,
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
          (prepayBase * (BASIS_POINTS + rentalBufferBps)) / BASIS_POINTS;
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
            // Approve the upper bound of the range — see
            // lenderPullAmount derivation above.
            await ensureErc20(asErc20Approvable(erc20), lenderPullAmount);
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
              (prepayBase * (BASIS_POINTS + rentalBufferBps)) / BASIS_POINTS;
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
            onClick={() => navigate("/offers")}
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
      {/* Came in via the OfferBook "Lend / Borrow at market rate"
          widget. One of three banners: illiquid collateral (the widget
          couldn't auto-compute a minimum — no `collateralAmount` was
          passed), posting at the current market rate (an `interestRate`
          was passed), or the first offer for this pair (neither). */}
      {deepLinkFrom === "market-widget" &&
        (!searchParams.get("collateralAmount") ? (
          <div className="alert alert-warning" role="alert">
            <AlertTriangle size={18} />
            <span>{t('createOffer.marketWidgetIlliquidBanner')}</span>
          </div>
        ) : searchParams.get("interestRate") ? (
          <div className="alert alert-info" role="status">
            <span>
              {t('createOffer.marketWidgetBanner', {
                rate: searchParams.get("interestRate"),
              })}
            </span>
          </div>
        ) : (
          <div className="alert alert-warning" role="alert">
            <AlertTriangle size={18} />
            <span>{t('createOffer.firstOfferBanner')}</span>
          </div>
        ))}
      {/* Cross-chain "thin here" warning — the chosen ERC-20 collateral
          is classified `Illiquid` by `checkLiquidity` on *this* chain
          (an asset can be deep on its home chain and thin elsewhere).
          Shows however the user got here. NFT collateral is excluded
          (the hook is fed `null` for it) — "illiquid" is expected for
          NFTs and the mutual-consent disclosures cover that case. */}
      {collateralLiquidityStatus === "illiquid" && (
        <div className="alert alert-warning" role="alert">
          <AlertTriangle size={18} />
          <span>{t('liquidityNotice.thinCollateralOnChain')}</span>
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
                      {t('lenderDiscountCard.borrowerTitle', discountBannerParams)}
                    </div>
                    <p className="stat-label" style={{ margin: "0 0 8px" }}>
                      {t('lenderDiscountCard.borrowerBody1', discountBannerParams)}
                      <a href="/vpfi-vault" target="_blank" rel="noopener noreferrer">
                        {t('lenderDiscountCard.buyVpfi')}
                      </a>
                      {t('lenderDiscountCard.routingNote')}
                    </p>
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>
                      {t('lenderDiscountCard.lenderTitle', discountBannerParams)}
                    </div>
                    <p className="stat-label" style={{ margin: "0 0 8px" }}>
                      {t('lenderDiscountCard.lenderBody1', discountBannerParams)}
                      <a href="/vpfi-vault" target="_blank" rel="noopener noreferrer">
                        {t('lenderDiscountCard.buyVpfi')}
                      </a>
                      {t('lenderDiscountCard.routingNote')}
                    </p>
                  </>
                )}
                <Link to="" className="btn btn-secondary btn-sm">
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
              {/* Issue #165 / ADR-0010 §17.1 — role-asymmetric labels.
                  The user enters their headline number: lender's "Lend
                  up to X" (ceiling); borrower's "Borrow at least Y"
                  (floor). `toCreateOfferPayload` routes it into the
                  contract's `amount` / `amountMax` per role. NFT
                  rentals stay symmetric (single-value daily fee). */}
              <label className="form-label">
                {isRental
                  ? t('createOffer.dailyRentalFee')
                  : form.offerType === 'lender'
                    ? t('createOffer.amountLender')
                    : t('createOffer.amountBorrower')}
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
              {/* Role-asymmetric rate label. Lender's "min %" is the
                  floor (`interestRateBps`); borrower's "max %" is the
                  ceiling (`interestRateBpsMax`). `toCreateOfferPayload`
                  fills the opposite end with the protocol cap
                  (`MAX_INTEREST_BPS = 10000` / `0`). */}
              <label className="form-label">
                {form.offerType === 'lender'
                  ? t('createOffer.interestRateLender')
                  : t('createOffer.interestRateBorrower')}
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

          {/* Range Orders Phase 1 — upper-bound inputs. Rendered only
              when (a) governance has flipped the relevant master flag
              ON via ConfigFacet AND (b) the user opted into Advanced
              mode AND (c) we're not on an NFT-rental offer (rentals
              are single-fill in Phase 1). When this row is hidden
              `form.amountMax` / `form.interestRateMax` stay empty,
              `toCreateOfferPayload` collapses them to 0, and the
              contract treats the offer as single-value. */}
          {(showAmountRange || showRateRange) && !isRental && (
            <div className="form-row">
              {showAmountRange ? (
                <div className="form-group">
                  <label className="form-label">
                    {t('createOffer.amountMax')}
                  </label>
                  <input
                    className="form-input"
                    type="number"
                    step="any"
                    min="0"
                    placeholder={form.amount || "2000"}
                    value={form.amountMax}
                    onChange={(e) => setField("amountMax", e.target.value)}
                  />
                  <span className="form-hint">
                    {t('createOffer.hintAmountMax')}
                  </span>
                </div>
              ) : (
                <div className="form-group" />
              )}
              {showRateRange ? (
                <div className="form-group">
                  <label className="form-label">
                    {t('createOffer.interestRateMax')}
                  </label>
                  <input
                    className="form-input"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder={form.interestRate || "6.00"}
                    value={form.interestRateMax}
                    onChange={(e) =>
                      setField("interestRateMax", e.target.value)
                    }
                  />
                  <span className="form-hint">
                    {t('createOffer.hintInterestRateMax')}
                  </span>
                </div>
              ) : (
                <div className="form-group" />
              )}
            </div>
          )}

          {/* Live wallet-balance shortfall — see the
              `balanceShortfall` useEffect above. Renders only on
              the lender side (the borrower-side render lives
              under the collateral-amount input below) and once
              the user has typed enough to compute a meaningful
              shortfall. Red text is the same `--accent-red`
              token used by validation errors elsewhere on the
              form so the visual treatment is consistent. */}
          {balanceShortfall?.side === "lender" && (
            <p
              className="form-hint"
              style={{ color: "var(--accent-red, #ef4444)", marginTop: -4 }}
            >
              Insufficient {balanceShortfall.symbol} balance — wallet holds{" "}
              {formatUnits(balanceShortfall.have, balanceShortfall.decimals)}{" "}
              {balanceShortfall.symbol}, offer requires{" "}
              {formatUnits(balanceShortfall.need, balanceShortfall.decimals)}{" "}
              {balanceShortfall.symbol}
              {showAmountRange ? " (the maximum amount you offered to lend)" : ""}.
            </p>
          )}

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
            {/* Visual label — Picker's trigger is a <button>, not a
                native form input, so the htmlFor association doesn't
                apply. Screen-reader text comes from the Picker's
                `ariaLabel` prop below; sighted users still see this
                label above the trigger. */}
            <span className="form-label">
              {t('createOffer.duration')}
            </span>
            {/* Bucketed duration picker. Frontend convention only — the
                contract still accepts any integer in
                [MIN_OFFER_DURATION_DAYS, MAX_OFFER_DURATION_DAYS]. The
                bucket list lives on `OFFER_DURATION_BUCKETS_DAYS` so the
                picker, the OfferBook duration filter, and any future
                surface (preclose-via-offer, refinance) all share the
                same set; widening or narrowing the buckets is a
                one-line change at the source. */}
            <Picker
              items={OFFER_DURATION_BUCKETS_DAYS.map((d) => ({
                value: String(d),
                label: t('createOffer.durationBucket', { count: d }),
              }))}
              value={form.durationDays}
              onSelect={(v) => setField("durationDays", v)}
              ariaLabel={t('createOffer.durationPickerAria')}
              minWidth={180}
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
                    : t('createOffer.prepayAssetHint', {
                        rentalBuffer: protocolConfig
                          ? protocolConfig.rentalBufferBps / 100
                          : 5,
                      })
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
              {/* Issue #165 / ADR-0010 §17.1 — role-asymmetric collateral
                  label. Lender's "Require at least Z" sets the floor
                  (`collateralAmount`, single-value per #164 lender
                  invariant); borrower's "Lock up to W" sets the ceiling
                  (`collateralAmountMax`, pre-vaulted). The payload
                  translation routes accordingly. */}
              <label className="form-label">
                {form.offerType === 'lender'
                  ? t('createOffer.collateralAmountLender')
                  : t('createOffer.collateralAmountBorrower')}
              </label>
              <input
                className="form-input"
                type="number"
                step="any"
                min="0"
                placeholder="1500"
                value={form.collateralAmount}
                onChange={(e) => setField("collateralAmount", e.target.value)}
              />
              {/* Live shortfall hint for borrower-side ERC-20
                  collateral pulls — see the `balanceShortfall`
                  useEffect above. Same shape as the lender hint
                  rendered under the amount row. */}
              {balanceShortfall?.side === "collateral" && (
                <span
                  className="form-hint"
                  style={{ color: "var(--accent-red, #ef4444)" }}
                >
                  Insufficient {balanceShortfall.symbol} balance — wallet holds{" "}
                  {formatUnits(
                    balanceShortfall.have,
                    balanceShortfall.decimals,
                  )}{" "}
                  {balanceShortfall.symbol}, offer requires{" "}
                  {formatUnits(
                    balanceShortfall.need,
                    balanceShortfall.decimals,
                  )}{" "}
                  {balanceShortfall.symbol}.
                </span>
              )}
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

          {/* Tier 2 #4 — live HF / LTV preview during offer creation.
              Renders only in Advanced mode, only for ERC-20 / ERC-20
              pairs (NFT-rental loans don't have a meaningful HF). The
              component itself bails to `null` if the asset addresses
              aren't valid yet or the oracles revert, so it's safe to
              mount unconditionally inside the gate. The two-way bound
              sliders update form state via `setField` so dragging them
              also updates the number inputs above. */}
          {showAdvanced && (
            <OfferRiskPreview
              lendingAsset={form.lendingAsset}
              collateralAsset={form.collateralAsset}
              amountMin={form.amount}
              amountMax={form.amountMax}
              collateralAmount={form.collateralAmount}
              lendingAssetType={form.assetType}
              collateralAssetType={form.collateralAssetType}
              showAmountRange={showAmountRange}
              onAmountMinChange={(v) => setField("amount", v)}
              onAmountMaxChange={(v) => setField("amountMax", v)}
              onCollateralAmountChange={(v) =>
                setField("collateralAmount", v)
              }
            />
          )}
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

          {/* #784 — reflect the term-interest mode this offer is being created
              with (default full-term), so the creator sees plainly what the
              borrower commits to. ERC-20 loans only: NFT rentals settle prepaid
              rental fees, not APR interest, so the line is omitted there (Codex
              P2) — `undefined` ⇒ RiskDisclosures renders no term-interest line. */}
          <RiskDisclosures
            fullTermInterest={
              form.assetType === 'erc20' ? form.useFullTermInterest : undefined
            }
            allowsPartialRepay={form.allowsPartialRepay}
            /* #796 — collateral settles in-kind on default ONLY for ERC-20
               (lending) offers (`form.assetType === 'erc20'`): an NFT-principal
               rental doesn't use the collateral-in-kind default path — it resets
               the renter and pays out prepaid fees — so the line must not show
               for rentals (Codex r3 P2). The decision is COLLATERAL-driven
               (`DefaultedFacet.triggerDefault` routes on the collateral's
               liquidity), so within an ERC-20 offer it fires when the COLLATERAL
               is an NFT (no oracle / no swap) or an illiquid ERC-20 — NOT for an
               illiquid lending leg with liquid collateral (Codex r4 P2). */
            collateralInKind={
              form.assetType === 'erc20' &&
              (form.collateralAssetType !== 'erc20' ||
                collateralLiquidityStatus === 'illiquid')
            }
          />

          <label className="checkbox-row" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={form.riskAndTermsConsent}
              onChange={(e) => setField("riskAndTermsConsent", e.target.checked)}
            />
            <span><RiskConsentLabel /></span>
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

            {/* Borrower-initiated partial repay is off by default — the
                acceptor's act of accepting IS their consent, so the
                creator must opt in for the gate to open. Hint text
                varies by offer side because the consent semantics flip:
                a lender-offer creator is the lender consenting up
                front; a borrower-offer creator is asking for partial-
                repay rights and the lender's accept = consent. */}
            <label className="checkbox-row" style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={form.allowsPartialRepay}
                onChange={(e) => setField("allowsPartialRepay", e.target.checked)}
              />
              <span>
                {t('createOffer.allowsPartialRepayLabel')}
                <small
                  style={{ display: "block", opacity: 0.75, marginTop: 2 }}
                >
                  {form.offerType === 'lender'
                    ? t('createOffer.allowsPartialRepayHintLender')
                    : t('createOffer.allowsPartialRepayHintBorrower')}
                </small>
              </span>
            </label>

            {/* T-086 Round-8 (#358) §19.5 — borrow-OR-sell parallel-sale
                opt-in. Only valid on Borrower offers with NFT
                collateral (ERC721 / ERC1155); the contract gate at
                `OfferCreateFacet` rejects lender / non-NFT-collateral
                cases at create time with
                `ParallelSaleRequiresBorrowerOffer` /
                `ParallelSaleRequiresNFTCollateral`. Toggle visibility
                here mirrors that contract gate so the UX never offers
                an opt-in the contract would reject.

                Aon fill mode is forced automatically when this toggle
                is on (see {@link toCreateOfferPayload} in offerSchema.ts
                — `fillMode: s.allowsParallelSale ? 1 : 0`). The
                contract's round-8 P2 #4 gate
                (`ParallelSaleRequiresAonFillMode`) rejects Partial /
                IOC offers with parallel-sale enabled because those
                fill modes create multiple loans against a single
                offer's collateral. */}
            {form.offerType === 'borrower' &&
              form.assetType === 'erc20' &&
              (form.collateralAssetType === 'erc721' ||
                form.collateralAssetType === 'erc1155') && (
                <label className="checkbox-row" style={{ marginTop: 12 }}>
                  <input
                    type="checkbox"
                    checked={form.allowsParallelSale}
                    onChange={(e) =>
                      setField("allowsParallelSale", e.target.checked)
                    }
                  />
                  <span>
                    {t('createOffer.allowsParallelSaleLabel')}
                    <small
                      style={{
                        display: "block",
                        opacity: 0.75,
                        marginTop: 2,
                      }}
                    >
                      {t('createOffer.allowsParallelSaleHint')}
                    </small>
                  </span>
                </label>
              )}

            {/* T-092 #511 sub (#523) — refinance-tagged offer flow.
                Only valid on Borrower offers with ERC20 principal.
                When non-empty, the form auto-forces Aon fill mode at
                payload-build time (see `toCreateOfferPayload` in
                offerSchema.ts) and the contract enforces the
                borrower's per-loan `autoRefinanceCaps` at both create
                AND accept. Leave the input empty for a standard
                Borrower offer with no refinance intent. */}
            {form.offerType === 'borrower' &&
              form.assetType === 'erc20' && (
                <label className="form-row" style={{ marginTop: 12, display: 'block' }}>
                  <span style={{ display: 'block', marginBottom: 4 }}>
                    {t('createOffer.refinanceTargetLabel')}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder={t('createOffer.refinanceTargetPlaceholder')}
                    value={form.refinanceTargetLoanId}
                    onChange={(e) =>
                      setField("refinanceTargetLoanId", e.target.value)
                    }
                    style={{ width: 160 }}
                  />
                  <small
                    style={{
                      display: 'block',
                      opacity: 0.75,
                      marginTop: 2,
                    }}
                  >
                    {t('createOffer.refinanceTargetHint')}
                  </small>
                  {/* T-092 (#544) — best-effort warning when the
                      refinance-tag input is non-empty. Surfaces the
                      reality that tagging the offer for refinance
                      doesn't guarantee a match in time. */}
                  {form.refinanceTargetLoanId !== '' && (
                    <div
                      className="alert alert-warning"
                      role="alert"
                      style={{ marginTop: 8 }}
                    >
                      {t('createOffer.refinanceTargetBestEffortWarning')}
                    </div>
                  )}
                </label>
              )}

            {/* T-034 — Periodic Interest Payment cadence dropdown.
                Hidden entirely when the master kill-switch is off OR
                either side is illiquid. The component handles the
                null-render rules itself; we just pass the inputs.

                `principalLiquidity` / `collateralLiquidity` are derived
                from the form's asset-type fields here as a proxy
                (ERC20-on-both-legs ⇒ Liquid, anything else ⇒ Illiquid).
                A finer truth — Chainlink-priced + AMM-swappable — is
                what the contract actually checks; the proxy here just
                drives the UI's visibility, and the contract is the
                authoritative gate. */}
            <PeriodicInterestCadenceField
              value={form.periodicInterestCadence}
              onChange={(v) => setField("periodicInterestCadence", v)}
              durationDays={parseInt(form.durationDays || "0", 10)}
              principalLiquidity={form.assetType === 'erc20' ? 0 : 1}
              collateralLiquidity={form.collateralAssetType === 'erc20' ? 0 : 1}
              principalAssetType={
                form.assetType === 'erc20' ? 0 : form.assetType === 'erc721' ? 1 : 2
              }
              collateralAssetType={
                form.collateralAssetType === 'erc20'
                  ? 0
                  : form.collateralAssetType === 'erc721'
                  ? 1
                  : 2
              }
              periodicInterestEnabled={
                periodicConfig?.periodicInterestEnabled ?? false
              }
              threshold1e18={
                periodicConfig?.minPrincipalForFinerCadence1e18 ?? 0n
              }
            />
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

        {/* ET-001 — pre-sign eth_call preflight of the pending
            createOffer tx. Encodes the current form state into
            calldata so the user sees whether it would revert before
            signing. Silently hides when the form isn't buildable yet
            (missing required fields / decimals still loading). */}
        <CreateOfferSimulationPreview
          toPayload={toPayload}
          diamondAddr={
            ((activeChain && isCorrectChain
              ? activeChain.diamondAddress
              : null) ?? DEFAULT_CHAIN.diamondAddress) as Address
          }
        />

        {/* #735 item 3 — strict-mode mid-tier acknowledgement at CREATE. When the
            creator is in strict mode and this pair is mid-tier without a fresh
            ack, the create would revert; offer to record it here and block submit
            until it's effective. */}
        <CreateMidTierAckBanner gate={midTierGate} />

        <div className="form-actions">
          {/* Pre-flight validation runs the same `validateOfferForm` shape
              the submit handler uses. Disabling the button (with the
              reason as a tooltip) replaces the previous "click → see
              error" loop, so users with empty asset addresses, a zero
              amount, an out-of-range duration, or no fallback-consent
              checkbox now see why the button is greyed out before
              clicking. */}
          {(() => {
            const validationError = validate();
            // #735 item 3 — block submit on the progressive-risk create gate too.
            // The gate checks the creator's TIER first, then the strict-mode
            // mid-tier acknowledgement (Codex #740 r4), so surface both — and
            // block while either verdict is still unknown (loading / failed read),
            // since `useMidTierAckGate` leaves the flags false until they resolve
            // and a create could otherwise slip through and revert. The
            // missing-facet case sets *Known=true, so gate-less diamonds aren't
            // affected.
            const tierTooLow = midTierGate.tierTooLow;
            const tierUnknown = createPair !== null && !midTierGate.tierKnown;
            const midTierBlocked = midTierGate.blocked;
            const midTierUnknown = createPair !== null && !midTierGate.known;
            const illiquidConsent = midTierGate.illiquidConsentNeeded;
            // #796 (Codex r2/r5 P2) — close the in-kind-disclosure race: while
            // the ERC-20 collateral's liquidity read is unresolved the in-kind
            // line can't render, so a fast creator could tick consent and submit
            // before it resolves to `illiquid`. Block submit until the read
            // settles to a definite `liquid`/`illiquid`. `unknown` is treated as
            // unresolved (r5): a transient read failure on a valid ERC-20 can
            // still be classified illiquid on-chain, so don't let it through;
            // an invalid collateral address is already caught by `validate()`,
            // and a no-diamond chain can't submit anyway.
            const liquidityPending =
              form.collateralAssetType === "erc20" &&
              !!form.collateralAsset &&
              (collateralLiquidityStatus === "loading" ||
                collateralLiquidityStatus === "unknown");
            const riskBlocked =
              tierTooLow ||
              tierUnknown ||
              midTierBlocked ||
              midTierUnknown ||
              illiquidConsent ||
              liquidityPending;
            const tooltip = step === "form" && validationError
              ? formatValidationError(validationError)
              : step === "form" && tierTooLow
                ? "Raise your vault's risk tier to cover this pair first (Risk Access settings)."
                : step === "form" && illiquidConsent
                  ? "Record the per-pair illiquid consent for this pair first."
                  : step === "form" && midTierBlocked
                    ? "Record the strict-mode mid-tier acknowledgement for this pair first."
                    : step === "form" && (tierUnknown || midTierUnknown)
                      ? "Checking the progressive-risk requirements…"
                      : step === "form" && liquidityPending
                        ? "Checking asset liquidity to finalise the risk disclosures…"
                        : undefined;
            return (
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  step !== "form" || validationError !== null || riskBlocked
                }
                data-tooltip={tooltip}
              >
                {step === "approving"
                  ? t('createOffer.approving')
                  : step === "creating"
                    ? t('createOffer.creating')
                    : t('appNav.createOffer')}
              </button>
            );
          })()}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/offers")}
          >
            {t('common.cancel')}
          </button>
        </div>

        <div className="alert alert-info" style={{ marginTop: 16 }}>
          <Info size={18} />
          <span>{t('createOffer.lockAssetsAlert')}</span>
        </div>

        {form.assetType === "erc20" && (() => {
          // Pre-compute the LIF interpolation params from the live
          // protocol-config so the alert reads "Loan Initiation Fee
          // (0.1%): … remaining 99.9%" using the deployed bps, not a
          // baked-in `0.1` / `99.9`.
          const lifBps = protocolConfig ? protocolConfig.loanInitiationFeeBps : 10;
          const lifPctNum = lifBps / 100;
          const lifPct = lifPctNum % 1 === 0
            ? lifPctNum.toString()
            : lifPctNum.toFixed(2).replace(/\.?0+$/, '');
          const netNum = 100 - lifPctNum;
          const netPct = netNum % 1 === 0
            ? netNum.toString()
            : netNum.toFixed(2).replace(/\.?0+$/, '');
          const lifParams = { loanInitiationFee: lifPct, borrowerNet: netPct };
          return (
            <div className="alert alert-info" style={{ marginTop: 12 }}>
              <Info size={18} />
              <span>
                <strong>{t('createOffer.lifLabel', lifParams)}</strong>{' '}
                {form.offerType === "lender"
                  ? t('createOffer.lifLenderBody', lifParams)
                  : t('createOffer.lifBorrowerBody', lifParams)}
              </span>
            </div>
          );
        })()}
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

/**
 * #735 item 3 — create-time strict-mode mid-tier acknowledgement.
 *
 * The progressive-risk gate enforces a strict-mode vault's per-pair mid-tier
 * acknowledgement at offer CREATION too, so a strict-mode creator building a
 * mid-tier (liquid-but-not-blue-chip) pair would otherwise hit an opaque revert.
 * This banner reads the contract's own `midTierStrictBlocked(creator, pair)`
 * (via {@link useMidTierAckGate}) and, when blocked, lets the creator record the
 * acknowledgement in place. Because the acknowledgement is not atomic
 * sign-and-use, on a deployment with an opt-up cooldown it becomes effective only
 * after that window (up to 30 days) — so the copy never promises a quick unblock,
 * and the submit button stays disabled while `blocked` holds.
 */
function CreateMidTierAckBanner({ gate }: { gate: MidTierAckGate }) {
  // The create gate checks the creator's TIER before the mid-tier acknowledgement,
  // so when the tier is too low (Codex #740 r4) recording the ack alone can't
  // unblock — point at the tier prerequisite instead of presenting the ack as the
  // fix. (Submit is already blocked by the parent on `tierTooLow`.)
  // Only show the consent-recorded 'stays blocked' copy while the consent is still
  // needed (a nonzero cooldown). On a zero-cooldown deploy the record clears the
  // gate immediately and the submit enables, so the copy would contradict it
  // (Codex #740 r13).
  if (gate.consentRecorded && gate.illiquidConsentNeeded) {
    return (
      <div
        role="status"
        style={{
          margin: "0.75rem 0",
          padding: "0.6rem 0.8rem",
          borderRadius: 8,
          fontSize: "0.85rem",
          background: "rgba(220,160,30,0.10)",
          border: "1px solid rgba(220,160,30,0.35)",
        }}
      >
        Per-pair consent recorded. If an opt-up cooldown is configured it becomes
        effective only after that window; creating stays blocked until then.
      </div>
    );
  }
  // IlliquidCustom pair the vault has the tier for but lacks a fresh per-pair
  // consent — the create gate reverts IlliquidPairNotConsented (Codex #740 r9).
  if (gate.illiquidConsentNeeded && gate.consentPending) {
    // Already recorded and cooling down — don't restamp (Codex #740 r10).
    return (
      <div
        role="status"
        style={{
          margin: "0.75rem 0",
          padding: "0.6rem 0.8rem",
          borderRadius: 8,
          fontSize: "0.85rem",
          background: "rgba(220,160,30,0.10)",
          border: "1px solid rgba(220,160,30,0.35)",
        }}
      >
        Per-pair consent is recorded and cooling down — it becomes effective once
        the cooldown elapses; creating stays blocked until then.
      </div>
    );
  }
  // Offer the contextual consent write right here — but hold it until the cooldown
  // reads settle so a repeat can't restamp a still-cooling consent (Codex r12).
  if (gate.illiquidConsentNeeded && !gate.pendingKnown) {
    return (
      <div role="status" style={{ margin: "0.75rem 0", fontSize: "0.85rem", opacity: 0.85 }}>
        Checking the per-pair consent status…
      </div>
    );
  }
  if (gate.illiquidConsentNeeded) {
    return (
      <div
        role="status"
        style={{
          margin: "0.75rem 0",
          padding: "0.6rem 0.8rem",
          borderRadius: 8,
          fontSize: "0.85rem",
          background: "rgba(220,160,30,0.10)",
          border: "1px solid rgba(220,160,30,0.35)",
        }}
      >
        <div style={{ marginBottom: "0.4rem" }}>
          This is an illiquid pair, so it needs a deliberate per-pair consent before
          you can create the offer.
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={gate.consentRecording}
          onClick={() => void gate.recordConsent()}
        >
          {gate.consentRecording
            ? "Recording consent…"
            : "Record per-pair consent"}
        </button>
        {gate.consentError && (
          <div
            role="alert"
            style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "var(--danger, #d66)" }}
          >
            {gate.consentError}
          </div>
        )}
      </div>
    );
  }
  if (gate.tierTooLow) {
    return (
      <div
        role="status"
        style={{
          margin: "0.75rem 0",
          padding: "0.6rem 0.8rem",
          borderRadius: 8,
          fontSize: "0.85rem",
          background: "rgba(220,160,30,0.10)",
          border: "1px solid rgba(220,160,30,0.35)",
        }}
      >
        This pair needs a higher risk tier than your vault currently holds. Raise
        your tier in Risk Access settings first; the strict-mode acknowledgement is
        collected here once your tier covers the pair.
      </div>
    );
  }
  // A mid-tier ack already recorded and cooling down — don't offer a repeat write
  // (it would restamp the cooldown, Codex #740 r10).
  if (gate.midTierAckPending && !gate.recorded) {
    return (
      <div
        role="status"
        style={{
          margin: "0.75rem 0",
          padding: "0.6rem 0.8rem",
          borderRadius: 8,
          fontSize: "0.85rem",
          background: "rgba(220,160,30,0.10)",
          border: "1px solid rgba(220,160,30,0.35)",
        }}
      >
        Mid-tier acknowledgement is recorded and cooling down — it becomes effective
        once the cooldown elapses; creating stays blocked until then.
      </div>
    );
  }
  // Once the gate clears (e.g. a zero-cooldown record made the ack effective), the
  // submit button enables, so don't keep telling the user creating is blocked
  // (Codex #740 r12). Only surface while still blocked.
  if (!gate.blocked) return null;
  // Hold the ack write until the cooldown reads settle (Codex r12).
  if (!gate.recorded && !gate.pendingKnown) {
    return (
      <div role="status" style={{ margin: "0.75rem 0", fontSize: "0.85rem", opacity: 0.85 }}>
        Checking your acknowledgement status…
      </div>
    );
  }
  return (
    <div
      role="status"
      style={{
        margin: "0.75rem 0",
        padding: "0.6rem 0.8rem",
        borderRadius: 8,
        fontSize: "0.85rem",
        background: "rgba(220,160,30,0.10)",
        border: "1px solid rgba(220,160,30,0.35)",
      }}
    >
      {gate.recorded ? (
        <span>
          Mid-tier acknowledgement recorded for this pair. If an opt-up cooldown is
          configured it becomes effective only after that window (which a
          deployment may set up to 30 days); creating stays blocked until then.
        </span>
      ) : (
        <>
          <div style={{ marginBottom: "0.4rem" }}>
            Strict mode is on for your vault, and this is a mid-tier pair, so it
            needs a fresh explicit acknowledgement before you can create the offer.
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={gate.recording}
            onClick={() => void gate.record()}
          >
            {gate.recording
              ? "Recording acknowledgement…"
              : "Record mid-tier acknowledgement"}
          </button>
          {gate.error && (
            <div
              role="alert"
              style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "var(--danger, #d66)" }}
            >
              {gate.error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
    .VITE_AGENT_ORIGIN ?? null;

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
