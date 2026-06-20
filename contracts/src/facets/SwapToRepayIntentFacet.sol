// src/facets/SwapToRepayIntentFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibCollateralSettlement} from "../libraries/LibCollateralSettlement.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IPreInteraction} from "@1inch/limit-order-protocol/contracts/interfaces/IPreInteraction.sol";
import {IPostInteraction} from "@1inch/limit-order-protocol/contracts/interfaces/IPostInteraction.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {MakerTraits} from "@1inch/limit-order-protocol/contracts/libraries/MakerTraitsLib.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";

/**
 * @title SwapToRepayIntentFacet
 * @author Vaipakam Developer Team
 * @notice T-090 v1.1 (#389) — borrower-initiated intent-based
 *         swap-to-repay surface, sibling to the v1 atomic
 *         `SwapToRepayFacet`. The borrower commits a 1inch Fusion
 *         (Limit Order Protocol v4) order whose maker / recipient /
 *         postInteraction target is the diamond; a resolver fills it
 *         on Fusion's orderbook; the diamond's `postInteraction`
 *         hook runs the canonical settlement waterfall atomically
 *         with the fill.
 *
 *         For larger swaps (5-figure principal, illiquid pairs, MEV-
 *         sensitive flows) the protocol-level slippage cap on v1's
 *         AMM-route path is binding but the execution price is still
 *         meaningfully worse than what a solver-based protocol can
 *         deliver. Intent-based settlement gives the borrower
 *         solver-guaranteed pricing + MEV resistance at the cost of
 *         a 1-2 minute settlement window.
 *
 *         Full architecture, eligibility gates, settlement waterfall,
 *         force-cancel pattern across liquidation entry points, and
 *         the 7-issue Codex-resolution trail
 *         (rounds 1-12 + Sub 1 deferrals) live in
 *         `docs/DesignsAndPlans/SwapToRepayIntentBased.md`.
 *
 *         This file is the **skeleton kickoff** for Sub 1 (#416).
 *         Entry-point signatures + custom errors + events are
 *         load-bearing for the surrounding deploy-sanity wiring +
 *         the ABI export; bodies are `revert NotYetImplemented()`
 *         placeholders that subsequent commits on the
 *         `feature/t090-416-intent-facet-contracts` branch fill in
 *         per the design doc sections cited in each function's
 *         natspec.
 *
 *         Sub 1 implementation order (per Sub 1 #416 + design §11):
 *           1. {commitSwapToRepayIntent} — full §5.1 commit sequence.
 *           2. {preInteraction} + {postInteraction} — transient-storage
 *              baseline + atomic settlement waterfall.
 *           3. {cancelSwapToRepayIntent} + {cancelExpiredIntent} —
 *              already-filled pre-check + safeTransfer-before-
 *              recordVaultDeposit (Codex round-11 P1 #1).
 *           4. {isValidSignature} — pure ERC-1271 binding check.
 *           5. {getIntentCommit} — projection for the dapp's
 *              read-back-then-post pattern (Codex round-7 P1 #4).
 *           6. The 13 `IntentPending` guards on voluntary-close /
 *              collateral-mutating facet entry points.
 *           7. The 6+1 force-cancel branches on HF-liquidation +
 *              time-default entry points.
 *           8. Tests.
 */
contract SwapToRepayIntentFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    // T-087 Sub 3.B — the IPreInteraction / IPostInteraction /
    // IERC1271 interface implementations moved to
    // `IntentDispatchFacet`; this facet now owns only the borrower-
    // facing commit + cancel + force-cancel surface. The dispatch
    // facet reads `s.orderHashKind[orderHash]` (stamped here at
    // commit time, cleared in the teardown helper) to know which
    // settlement library to call.
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    //  Borrower-supplied commit inputs (Codex round-5 P1 #1 +
    //  round-7 P1 #4 — full structured-order shape; the diamond
    //  derives `maker = receiver = address(this)`, finalises
    //  `makerAmount = custodialCollateral` post-withdraw, and
    //  recomputes the canonical 1inch LOP v4 orderHash on-chain).
    // ──────────────────────────────────────────────────────────────

    /// @notice §6.2 dapp-flow input. The borrower picks the
    ///         takerAmount + deadline + salt + makerTraits +
    ///         extension; the diamond fills in the maker/receiver/
    ///         asset fields and finalises makerAmount based on the
    ///         actual vault withdraw.
    struct FusionOrderParams {
        /// @dev Borrower-picked principal-side minimum. Must clear
        ///      the §5.4 floor: `lenderLeg + treasuryLeg + lateFee`
        ///      with the `cfgIntentMinOutputBufferBps` buffer.
        uint256 takerAmount;
        /// @dev Auction end. Must satisfy the §5.1 step 2 bounds
        ///      (`min/maxAuctionSeconds`) AND be `<=
        ///      loan.endTime + gracePeriod` (Codex round-5 P2 #5)
        ///      AND equal `makerTraits.expiration()` (Codex round-8
        ///      P1 #5).
        uint64 deadline;
        /// @dev Borrower-supplied; low 160 bits must equal
        ///      `uint160(uint256(keccak256(params.extension)))` per
        ///      LOP v4's extension-binding rule (Codex round-8 P1 #1).
        uint256 salt;
        /// @dev Packed 1inch LOP v4 trait bits. Required ON:
        ///      `hasExtension`, `needPreInteractionCall`,
        ///      `needPostInteractionCall`; required OFF:
        ///      `usePermit2` (round-10 P2 #3),
        ///      `allowPartialFills` + `allowMultipleFills`
        ///      (round-10 P2 #4); expiration sub-field must equal
        ///      `deadline`.
        uint256 makerTraits;
        /// @dev Extension bytes encoding the diamond's preInteraction
        ///      + postInteraction targets (per LOP v4's extension
        ///      ABI). Stored separately keyed by `keccak256(ext)` in
        ///      `LibVaipakam.intentExtensionBytes`.
        bytes extension;
    }

    /// @notice §5.2 / §6.2 read-back projection used by the dapp to
    ///         post the canonical Fusion order to 1inch's
    ///         resolver-pickup endpoint after the commit lands.
    ///         Returned by {getIntentCommit}.
    struct FusionOrderRead {
        address maker;          // == address(this)
        address receiver;       // == address(this)
        address makerAsset;     // loan.collateralAsset
        address takerAsset;     // loan.principalAsset
        uint256 makerAmount;    // commit.makerAmount (== custodial == loan.collateralAmount)
        uint256 takerAmount;
        uint64  deadline;
        uint256 salt;
        uint256 makerTraits;
        bytes   extension;
    }

    // ──────────────────────────────────────────────────────────────
    //  Events (state-change / loan-mutation per indexer's
    //  event-coverage script — apps/indexer Sub 2 #417 wires the
    //  handlers)
    // ──────────────────────────────────────────────────────────────

    /// @notice Emitted by {commitSwapToRepayIntent}. Indexer creates
    ///         the `swap_to_repay_intents` row; loan stays Active.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayIntentCommitted(
        uint256 indexed loanId,
        bytes32 indexed orderHash,
        address indexed committedBy,
        uint256 makerAmount,
        uint256 takerAmount,
        uint64 deadline
    );

    /// @notice Emitted by {postInteraction} on a successful fill;
    ///         loan flips to Repaid in the same tx via the canonical
    ///         settlement waterfall.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayIntentFilled(
        uint256 indexed loanId,
        bytes32 indexed orderHash,
        uint256 consumed,
        uint256 delivered,
        uint256 residualToBorrowerVault
    );

    /// @notice Emitted by {cancelSwapToRepayIntent} +
    ///         {cancelExpiredIntent}. `cancelledBy` is `msg.sender`
    ///         so the indexer can attribute borrower vs
    ///         permissionless-poke in the activity feed.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayIntentCancelled(
        uint256 indexed loanId,
        bytes32 indexed orderHash,
        address indexed cancelledBy
    );

    /// @notice Emitted by the force-cancel branches in
    ///         RiskFacet's HF-liquidation + RiskMatchLiquidationFacet's
    ///         internal-match + RepayFacet's auto-period-shortfall +
    ///         DefaultedFacet.triggerDefault when they cancel a live
    ///         commit to clear custody before settling the
    ///         lender-protection action. The `reason` discriminator
    ///         drives the indexer's activity-feed copy + lets ops
    ///         distinguish HF-trigger from time-trigger.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayIntentForceCancelled(
        uint256 indexed loanId,
        bytes32 indexed orderHash,
        ForceCancelReason reason,
        address indexed source
    );

    /// @notice Reason discriminator on
    ///         {SwapToRepayIntentForceCancelled}.
    enum ForceCancelReason {
        /// @dev HF dropped below `HF_LIQUIDATION_THRESHOLD` mid-commit.
        HFBelowLiquidationThreshold,
        /// @dev Loan past `endTime + gracePeriod` while a commit was
        ///      still live (borrower committed late + auction outlived
        ///      the time-default window).
        TimeDefaultDue
    }

    // ──────────────────────────────────────────────────────────────
    //  Custom errors (each maps to a numbered design-doc reference
    //  so the audit trail stays self-explanatory)
    // ──────────────────────────────────────────────────────────────

    /// @dev §5.6 master switch is OFF on this chain.
    error IntentSurfaceDisabled();
    /// @dev Codex round-8 P1 #6 — neither leg can enter the surface
    ///      until its token is admin-allowlisted.
    error IntentTokenNotAllowed(address token);
    /// @dev §5.5 — no-double-commit guard.
    error IntentAlreadyCommitted(uint256 loanId);
    /// @dev Codex round-2 P1 #6 — reverse-index uniqueness; the same
    ///      orderHash can't be registered for two loans.
    error IntentOrderHashAlreadyInUse(bytes32 orderHash);
    /// @dev §5.4 — borrower's takerAmount must clear the floor.
    error IntentMinOutputBelowFloor(uint256 provided, uint256 required);
    /// @dev §5.1 step 4 — pre-commit HF gate.
    error IntentBlockedHFTooLow(uint256 currentHF, uint256 minHF);
    /// @dev §5.1 step 2 — order-field validation (maker / receiver /
    ///      assets / deadline bounds / extension hash).
    /// @param fieldHash short identifier of which field failed
    ///                  (`keccak256("maker")`, `keccak256("receiver")`,
    ///                   …). Off-chain decoder maps to a human label.
    error IntentOrderFieldsMismatch(bytes32 fieldHash);
    /// @dev §5.1 step 2 — makerTraits bit-pattern enforcement
    ///      (hasExtension / needPreInteractionCall /
    ///      needPostInteractionCall / usePermit2 /
    ///      allowPartialFills / allowMultipleFills / expiration).
    /// @param reasonHash short identifier of which bit failed.
    error IntentMakerTraitsMismatch(bytes32 reasonHash);
    /// @dev Codex round-6 P1 #4 — `received != loan.collateralAmount`
    ///      on the vault withdraw means the collateral token is
    ///      fee-on-transfer / rebasing (defense-in-depth alongside
    ///      the admin allowlist).
    error IntentCollateralFeeOnTransferUnsupported(
        uint256 received,
        uint256 requested
    );
    /// @dev §5.5 — cancel paths fired against a loanId without a
    ///      live commit.
    error IntentNoCommit(uint256 loanId);
    /// @dev §5.5 — borrower-cancel before `deadline`.
    error IntentNotPastDeadline();
    /// @dev §5.5 — order already filled / pending-postInteraction
    ///      (read via `LOP.rawRemainingInvalidatorForOrder`;
    ///      Codex round-8 P1 #2).
    error IntentAlreadyFilled();
    /// @dev §5.5 — cancelExpired before
    ///      `deadline + cfgIntentCancelGraceSeconds`.
    error IntentNotPastCancelGrace();
    /// @dev §5.1 postInteraction step 1 — `orderHashToLoanId[hash]`
    ///      was zero (no commit registered for this orderHash).
    error IntentNotRegistered(bytes32 orderHash);
    /// @dev §5.1 postInteraction step 2 — caller is not the pinned
    ///      `commit.lopAtCommit`.
    error IntentPostInteractionUnauthorized(address caller);
    /// @dev §5.1 preInteraction — caller is not the pinned
    ///      `commit.lopAtCommit`.
    error IntentPreInteractionUnauthorized(address caller);
    /// @dev §5.1 preInteraction — orderHash binding-check failure
    ///      (reverse-index mismatch).
    error IntentPreInteractionUnknownOrder(bytes32 orderHash);
    /// @dev §5.1 postInteraction step 4 — `actualDelivered` (live
    ///      principal balance delta measured via the transient
    ///      baseline) is below the recomputed live floor.
    error IntentDeliveredBelowLiveFloor(uint256 actualDelivered, uint256 liveFloor);
    /// @dev Sub 1 scaffolding placeholder. Subsequent commits on
    ///      this branch replace each `revert NotYetImplemented()`
    ///      with the body documented inline against the design doc.
    error NotYetImplemented();
    /// @dev Mirrors `SwapToRepayFacet.UnsupportedLoanShape` (the v1
    ///      sibling keeps this error facet-local rather than on
    ///      `IVaipakamErrors`). v1.1 uses the same conditions: both
    ///      legs ERC20 + both legs Liquid.
    error UnsupportedLoanShape();
    /// @dev Mirrors `SwapToRepayFacet.RepaymentPastGracePeriod`.
    error RepaymentPastGracePeriod();
    /// @dev `internalForceCancelIntent` is restricted to cross-facet
    ///      calls — direct user invocation would bypass the
    ///      trigger-condition check the caller facet runs first.
    error OnlyDiamondInternal();

    // ──────────────────────────────────────────────────────────────
    //  1inch LOP v4 makerTraits bit constants (per
    //  `lib/limit-order-protocol/contracts/libraries/MakerTraitsLib.sol`
    //  — recorded inline so the bit checks at §5.1 step 2 are
    //  self-contained and audit-greppable).
    // ──────────────────────────────────────────────────────────────
    uint256 private constant _NO_PARTIAL_FILLS_FLAG = 1 << 255;
    uint256 private constant _ALLOW_MULTIPLE_FILLS_FLAG = 1 << 254;
    uint256 private constant _PRE_INTERACTION_CALL_FLAG = 1 << 252;
    uint256 private constant _POST_INTERACTION_CALL_FLAG = 1 << 251;
    uint256 private constant _HAS_EXTENSION_FLAG = 1 << 249;
    uint256 private constant _USE_PERMIT2_FLAG = 1 << 248;
    /// @dev LOP v4 rejects any fill that combines epoch-manager
    ///      checking with the bit-invalidator path. Our orders use
    ///      the bit-invalidator path (no partial / no multiple
    ///      fills), so accepting `needCheckEpochManager` would
    ///      produce an unfillable order. Codex round-2 PR #420 P2.
    uint256 private constant _NEED_CHECK_EPOCH_MANAGER_FLAG = 1 << 250;
    /// @dev LOP v4 bit 247: when set on a WETH taker asset, the
    ///      protocol unwraps WETH and sends native ETH to the
    ///      `receiver` (the diamond). `postInteraction` then
    ///      measures `IERC20(loan.principalAsset).balanceOf(this)`
    ///      which would see ZERO (the ETH lives in the diamond's
    ///      contract balance, not the ERC20 balance) and revert
    ///      `IntentDeliveredBelowLiveFloor` even though the resolver
    ///      paid in full. Codex round-3 PR #420 P2.
    uint256 private constant _UNWRAP_WETH_FLAG = 1 << 247;
    /// @dev Expiration sub-field: bits 80-119 (40-bit uint).
    uint256 private constant _EXPIRATION_OFFSET = 80;
    uint256 private constant _UINT40_MASK = (1 << 40) - 1;

    /// @dev EIP-712 typehash for the 1inch LOP v4 `Order` struct —
    ///      hardcoded from
    ///      `lib/limit-order-protocol/contracts/OrderLib.sol:34`. The
    ///      LOP library's `OrderLib.hash` uses inline-assembly
    ///      `calldatacopy` which is unusable from a memory-built
    ///      order; we recompute via `abi.encode` against the same
    ///      typehash and the LOP's domain separator (fetched at
    ///      commit time from `cfgFusionLimitOrderProtocol`).
    bytes32 private constant _LIMIT_ORDER_TYPEHASH = keccak256(
        "Order("
            "uint256 salt,"
            "address maker,"
            "address receiver,"
            "address makerAsset,"
            "address takerAsset,"
            "uint256 makingAmount,"
            "uint256 takingAmount,"
            "uint256 makerTraits"
        ")"
    );

    /// @dev Field-identifier hashes used in `IntentOrderFieldsMismatch`
    ///      reverts so an off-chain decoder can map back to the
    ///      specific failed field. Kept as constants (not strings)
    ///      so the calldata-side decoder is deterministic across
    ///      bytecode changes.
    bytes32 private constant _FIELD_DEADLINE = keccak256("deadline");
    bytes32 private constant _FIELD_SALT_EXTENSION = keccak256("salt-extension-binding");
    bytes32 private constant _FIELD_EXTENSION_LAYOUT = keccak256("extension-layout");
    bytes32 private constant _FIELD_NONCE_REUSED = keccak256("makerTraits-nonce-reused");
    bytes32 private constant _REASON_HAS_EXTENSION = keccak256("hasExtension");
    bytes32 private constant _REASON_PRE_INTERACTION = keccak256("needPreInteractionCall");
    bytes32 private constant _REASON_POST_INTERACTION = keccak256("needPostInteractionCall");
    bytes32 private constant _REASON_PARTIAL_FILLS = keccak256("allowPartialFills");
    bytes32 private constant _REASON_MULTIPLE_FILLS = keccak256("allowMultipleFills");
    bytes32 private constant _REASON_USE_PERMIT2 = keccak256("usePermit2");
    bytes32 private constant _REASON_NEED_CHECK_EPOCH_MANAGER = keccak256("needCheckEpochManager");
    bytes32 private constant _REASON_UNWRAP_WETH = keccak256("unwrapWeth");
    bytes32 private constant _REASON_EXPIRATION_MISMATCH = keccak256("expiration-mismatch");

    // ══════════════════════════════════════════════════════════════
    //  Borrower-facing entry points
    // ══════════════════════════════════════════════════════════════

    /**
     * @notice §5.1 — atomically pulls the borrower's collateral into
     *         the diamond's custody, registers the canonical
     *         orderHash for ERC-1271 binding, and approves Fusion's
     *         pinned `LimitOrderProtocol` for the aggregate-per-token
     *         maker amount so a resolver can pull the collateral on
     *         fill.
     * @param  loanId Loan being repaid. Must be Active + ERC20-on-ERC20
     *         + both legs allowlisted + caller is the current
     *         borrower-NFT owner + HF >=
     *         `cfgIntentMinCommitHF`.
     * @param  params Borrower-picked Fusion-order inputs (see
     *         {FusionOrderParams}). The diamond derives maker /
     *         receiver / assets and finalises `makerAmount` from the
     *         actual vault withdraw.
     * @dev    `nonReentrant` per Codex round-12 P1 #6.
     */
    function commitSwapToRepayIntent(
        uint256 loanId,
        FusionOrderParams calldata params
    )
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // ── §5.6 master switch ──────────────────────────────────────
        if (!s.cfgIntentSwapToRepayEnabled) revert IntentSurfaceDisabled();

        LibVaipakam.Loan storage loan = s.loans[loanId];

        // #594 — consolidate a transferred borrower position BEFORE the intent
        // commit pulls the collateral into Diamond custody (design D-3 principle
        // 2 — the commit is the state-entering endpoint), so the committed
        // collateral comes from the current holder's vault. Borrower side,
        // skip-not-block.
        LibConsolidation.consolidateToHolder(
            loanId, false, LibConsolidation.Ctx.Tier2CloseOut
        );

        // ── §5.1 step 1: eligibility gates ──────────────────────────
        // Active + ERC20-on-ERC20 + both legs Liquid + tokens on
        // both per-token allowlists + caller is the current
        // borrower-NFT holder + caller is not the lender (latched
        // OR current NFT holder) + not past grace.
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert IVaipakamErrors.InvalidLoanStatus();
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20 ||
            loan.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) revert UnsupportedLoanShape();
        if (
            loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
        ) revert UnsupportedLoanShape();
        if (!s.cfgIntentAllowedPrincipalTokens[loan.principalAsset])
            revert IntentTokenNotAllowed(loan.principalAsset);
        if (!s.cfgIntentAllowedCollateralTokens[loan.collateralAsset])
            revert IntentTokenNotAllowed(loan.collateralAsset);
        LibAuth.requireBorrowerNftOwner(loan);
        if (msg.sender == loan.lender) revert IVaipakamErrors.LenderCannotRepayOwnLoan();
        if (IERC721(address(this)).ownerOf(loan.lenderTokenId) == msg.sender)
            revert IVaipakamErrors.LenderCannotRepayOwnLoan();
        uint256 endTime = uint256(loan.startTime) + uint256(loan.durationDays) * LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();

        // ── §5.1 step 2: field + makerTraits binding checks ─────────
        // Deadline bounds (Codex round-8 P1 #5 + round-5 P2 #5).
        // Use effective getters so a deploy where governance
        // enabled the surface without explicitly setting every knob
        // still gets the documented defaults (Codex round-1 PR #420
        // P2 #4).
        uint32 minAuctionSec = LibVaipakam.cfgIntentMinAuctionSecondsEffective();
        uint32 maxAuctionSec = LibVaipakam.cfgIntentMaxAuctionSecondsEffective();
        if (
            params.deadline <= block.timestamp ||
            params.deadline < block.timestamp + minAuctionSec ||
            params.deadline > block.timestamp + maxAuctionSec ||
            uint256(params.deadline) > graceEnd
        ) revert IntentOrderFieldsMismatch(_FIELD_DEADLINE);
        // makerTraits bits (Codex round-8 P1 #1 + round-10 P2 #3/#4):
        uint256 mt = params.makerTraits;
        if ((mt & _HAS_EXTENSION_FLAG) == 0)
            revert IntentMakerTraitsMismatch(_REASON_HAS_EXTENSION);
        if ((mt & _PRE_INTERACTION_CALL_FLAG) == 0)
            revert IntentMakerTraitsMismatch(_REASON_PRE_INTERACTION);
        if ((mt & _POST_INTERACTION_CALL_FLAG) == 0)
            revert IntentMakerTraitsMismatch(_REASON_POST_INTERACTION);
        // `allowPartialFills()` returns TRUE when the NO_PARTIAL bit
        // is CLEAR — we require partial-fills DISALLOWED so the
        // NO_PARTIAL flag must be SET.
        if ((mt & _NO_PARTIAL_FILLS_FLAG) == 0)
            revert IntentMakerTraitsMismatch(_REASON_PARTIAL_FILLS);
        if ((mt & _ALLOW_MULTIPLE_FILLS_FLAG) != 0)
            revert IntentMakerTraitsMismatch(_REASON_MULTIPLE_FILLS);
        if ((mt & _USE_PERMIT2_FLAG) != 0)
            revert IntentMakerTraitsMismatch(_REASON_USE_PERMIT2);
        if ((mt & _NEED_CHECK_EPOCH_MANAGER_FLAG) != 0)
            revert IntentMakerTraitsMismatch(_REASON_NEED_CHECK_EPOCH_MANAGER);
        if ((mt & _UNWRAP_WETH_FLAG) != 0)
            revert IntentMakerTraitsMismatch(_REASON_UNWRAP_WETH);
        // makerTraits expiration sub-field must match `params.deadline`
        // (Codex round-8 P1 #5 — without this, Fusion can fill past
        // our Vaipakam-side gate).
        if (((mt >> _EXPIRATION_OFFSET) & _UINT40_MASK) != uint256(params.deadline))
            revert IntentMakerTraitsMismatch(_REASON_EXPIRATION_MISMATCH);
        // salt low-160 bits == keccak256(extension) (Codex round-8
        // P1 #1 — LOP v4's extension-binding rule).
        bytes32 extensionHash = keccak256(params.extension);
        if ((params.salt & ((1 << 160) - 1)) != uint256(uint160(uint256(extensionHash))))
            revert IntentOrderFieldsMismatch(_FIELD_SALT_EXTENSION);
        // Extension-layout validation (Codex round-1 PR #420 P1 #1)
        // — extension bytes MUST bytewise match the canonical
        // layout {canonicalExtension} returns. Without this a
        // borrower can supply extension bytes whose hash matches
        // the salt but whose pre+post-interaction targets point at
        // a malicious contract, causing LOP to call into that
        // contract on fill.
        if (extensionHash != keccak256(canonicalExtension()))
            revert IntentOrderFieldsMismatch(_FIELD_EXTENSION_LAYOUT);
        // Nonce uniqueness (Codex round-1 PR #420 P1 #2) —
        // makerTraits.nonceOrEpoch field (bits 120-159, uint40) is
        // the LOP bit-invalidator slot key for our no-partial /
        // no-multi orders. Two live commits sharing the same nonce
        // land in the same bit-slot and the first fill invalidates
        // BOTH; refuse reuse.
        uint40 nonce = uint40((params.makerTraits >> 120) & ((1 << 40) - 1));
        if (s.intentNonceUsed[nonce])
            revert IntentMakerTraitsMismatch(_FIELD_NONCE_REUSED);
        s.intentNonceUsed[nonce] = true;

        // ── §5.1 step 4: pre-commit HF gate (Codex round-10 P1 #1
        //    — HF_SCALE-scaled comparison) ────────────────────────────
        // Cross-facet staticcall to RiskFacet (we're already inside
        // the diamond; the call routes via the Diamond fallback).
        uint256 currentHF = RiskFacet(address(this)).calculateHealthFactor(loanId);
        // Effective getter so a deploy that hasn't called
        // `setIntentMinCommitHF` still ships the documented 1.2e18
        // gate (Codex round-1 PR #420 P2 #4).
        uint256 minHF = LibVaipakam.cfgIntentMinCommitHFEffective();
        if (currentHF < minHF) revert IntentBlockedHFTooLow(currentHF, minHF);

        // ── §5.1 step 5: no-double-commit ───────────────────────────
        if (s.intentCommits[loanId].orderHash != bytes32(0))
            revert IntentAlreadyCommitted(loanId);

        // ── §5.1 step 7: minOutput floor (Codex round-10 P1 #5 +
        //    round-11 P1 #3 — must add late fee on top of getPrepayContext) ─
        uint256 lenderLeg = LibCollateralSettlement.principalPlusAccruedInterest(
            loanId, block.timestamp
        );
        uint256 treasuryLeg = LibCollateralSettlement.treasuryAndPrecloseFee(
            loanId, block.timestamp
        );
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        uint256 floor_ = lenderLeg + treasuryLeg + lateFee;
        uint256 minOut = (floor_ * (
            LibVaipakam.BASIS_POINTS + LibVaipakam.cfgIntentMinOutputBufferBpsEffective()
        )) / LibVaipakam.BASIS_POINTS;
        if (params.takerAmount < minOut)
            revert IntentMinOutputBelowFloor(params.takerAmount, minOut);

        // ── §5.1 step 8: pull collateral + reject fee-on-transfer ───
        // Balance-delta accounting AND require received == requested
        // (Codex round-4 P1 #5 + round-6 P1 #4): fee-on-transfer
        // collateral is rejected outright since cancel + claim-
        // record paths would otherwise drift away from
        // `loan.collateralAmount`.
        IERC20 collateralToken = IERC20(loan.collateralAsset);
        uint256 balanceBefore = collateralToken.balanceOf(address(this));
        // #569 §4.4 (2026-06-13) — temporary-custody decrement. The
        // full collateral is pulled into Diamond custody while the loan
        // stays Active (the intent may later fill → close, or be
        // cancelled → collateral restored to the vault). Drop the lien
        // to zero BEFORE the withdraw so the chokepoint guard passes;
        // `_teardownCommit` re-increments it when the collateral returns
        // to the vault, and the fill-settlement path releases it on
        // close. Revert-safe: a failed withdraw rolls back the decrement.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.decrementCollateralLien.selector,
                loanId,
                loan.collateralAmount
            ),
            bytes4(0)
        );
        VaultFactoryFacet(address(this)).vaultWithdrawERC20(
            loan.borrower, loan.collateralAsset, address(this), loan.collateralAmount
        );
        uint256 received = collateralToken.balanceOf(address(this)) - balanceBefore;
        if (received != loan.collateralAmount)
            revert IntentCollateralFeeOnTransferUnsupported(received, loan.collateralAmount);
        uint256 custodialCollateral = received;

        // ── §5.1 step 9: compute canonical 1inch LOP v4 orderHash ───
        // Replicates `OrderLib.hash`: EIP-712 over the 8-field Order
        // struct using LOP's own DOMAIN_SEPARATOR (fetched on-chain
        // for the pinned `cfgFusionLimitOrderProtocol`).
        bytes32 lopDomainSeparator = _fetchLopDomainSeparator(s.cfgFusionLimitOrderProtocol);
        bytes32 structHash = keccak256(abi.encode(
            _LIMIT_ORDER_TYPEHASH,
            params.salt,
            uint256(uint160(address(this))),         // maker = diamond
            uint256(uint160(address(this))),         // receiver = diamond
            uint256(uint160(loan.collateralAsset)),  // makerAsset
            uint256(uint160(loan.principalAsset)),   // takerAsset
            custodialCollateral,                     // makingAmount = actual received
            params.takerAmount,                      // takingAmount
            params.makerTraits
        ));
        bytes32 orderHash = keccak256(
            abi.encodePacked(bytes2(0x1901), lopDomainSeparator, structHash)
        );

        // ── §5.1 step 6 (deferred): orderHash uniqueness ────────────
        if (s.orderHashToLoanId[orderHash] != 0)
            revert IntentOrderHashAlreadyInUse(orderHash);
        // T-087 Sub 3.B round-2 P1 #2 — also check the shared
        // discriminator slot. A swap orderHash that happens to
        // collide with a live BUYBACK orderHash would otherwise
        // overwrite the BUYBACK kind here, mis-routing future
        // callbacks for that hash into the swap-to-repay arm.
        if (s.orderHashKind[orderHash] != bytes32(0))
            revert IntentOrderHashAlreadyInUse(orderHash);

        // ── §5.1 step 10: aggregate allowance management
        //    (zero-then-set for USDT-style tokens) ─────────────────────
        s.intentAggregateAllowance[loan.collateralAsset] += custodialCollateral;
        IERC20(loan.collateralAsset).forceApprove(s.cfgFusionLimitOrderProtocol, 0);
        IERC20(loan.collateralAsset).forceApprove(
            s.cfgFusionLimitOrderProtocol,
            s.intentAggregateAllowance[loan.collateralAsset]
        );

        // ── §5.1 step 11: record commit + reverse index + extension
        //    bytes + bump live count + emit ─────────────────────────────
        s.intentCommits[loanId] = LibVaipakam.SwapToRepayIntentCommit({
            orderHash: orderHash,
            deadline: params.deadline,
            makerAmount: custodialCollateral,
            takerAmount: params.takerAmount,
            salt: params.salt,
            makerTraits: params.makerTraits,
            extensionHash: extensionHash,
            custodialCollateral: custodialCollateral,
            committedByForRecord: msg.sender,
            lopAtCommit: s.cfgFusionLimitOrderProtocol
        });
        s.orderHashToLoanId[orderHash] = loanId;
        // T-087 Sub 3.B — stamp the kind discriminator so
        // `IntentDispatchFacet` routes Fusion's preInteraction /
        // postInteraction / isValidSignature callbacks for this
        // orderHash into `LibSwapToRepayIntentSettlement`. Cleared
        // at every teardown path (cancel / expired-cancel / force-
        // cancel / library's postInteraction settlement).
        s.orderHashKind[orderHash] = LibVaipakam.ORDER_KIND_SWAP_TO_REPAY;
        // Refcount per extension hash (Codex round-1 PR #420 P2 #3).
        // First commit at this hash stores the bytes; subsequent
        // commits sharing the same hash just bump the counter.
        if (s.intentExtensionBytesRefCount[extensionHash] == 0) {
            s.intentExtensionBytes[extensionHash] = params.extension;
        }
        s.intentExtensionBytesRefCount[extensionHash] += 1;
        s.intentLiveCommitCount += 1;

        emit SwapToRepayIntentCommitted(
            loanId,
            orderHash,
            msg.sender,
            custodialCollateral,
            params.takerAmount,
            params.deadline
        );
    }

    /// @dev Fetch LOP's EIP-712 DOMAIN_SEPARATOR via staticcall (no
    ///      IDomainSeparator interface in the LOP submodule, but
    ///      the standard EIP-712 `DOMAIN_SEPARATOR()` selector
    ///      `0x3644e515` is honoured by every audited LOP build).
    function _fetchLopDomainSeparator(address lop) private view returns (bytes32) {
        (bool ok, bytes memory ret) = lop.staticcall(
            abi.encodeWithSignature("DOMAIN_SEPARATOR()")
        );
        require(ok && ret.length == 32, "lop ds");
        return abi.decode(ret, (bytes32));
    }

    /// @notice Returns the canonical LOP v4 extension bytes the
    ///         borrower MUST supply at commit time (Codex round-1
    ///         PR #420 P1 #1 — without this check a borrower can
    ///         supply extension bytes that pass the salt-extension
    ///         binding but encode the WRONG pre+post-interaction
    ///         targets, causing LOP to call into an attacker-
    ///         controlled contract during fill).
    ///
    ///         Layout per `lib/limit-order-protocol/contracts/libraries/ExtensionLib.sol`:
    ///         the extension is a 32-byte offsets-word header
    ///         followed by concatenated field bytes. Each of the 9
    ///         dynamic fields stores its end-offset as a 28-bit
    ///         value packed into the offsets word at position
    ///         `i * 28`. For our shape (PreInteractionData =
    ///         `address(this)`, PostInteractionData =
    ///         `address(this)`, all other fields empty):
    ///           - field index 6 (PreInteractionData) end-offset = 20
    ///           - field index 7 (PostInteractionData) end-offset = 40
    ///           - field index 8 (CustomData) end-offset = 40
    ///           - all other field end-offsets = 0
    ///         field content = `address(this) || address(this)`
    ///         (20 + 20 bytes). Total extension length = 32 + 40
    ///         = 72 bytes.
    /// @dev    The dapp mirrors this construction off-chain so the
    ///         borrower-supplied `params.extension` matches the
    ///         canonical layout this returns.
    function canonicalExtension() public view returns (bytes memory) {
        // Codex round-2 PR #420 P1 — LOP v4's `OffsetsLib.get`
        // decodes each field's end-offset with `bitShift = index *
        // 32`, NOT `* 28`. The round-1 fix used the wrong slot
        // width which would have made LOP decode the
        // PreInteractionData / PostInteractionData targets at the
        // wrong byte offsets, calling random bytes as if they were
        // addresses.
        uint256 offsets = (uint256(20) << (6 * 32))
                        | (uint256(40) << (7 * 32))
                        | (uint256(40) << (8 * 32));
        return abi.encodePacked(offsets, address(this), address(this));
    }

    /**
     * @notice §5.5 — borrower-NFT-owner cancel path. Callable any
     *         time after `deadline`; pre-checks Fusion's
     *         `rawRemainingInvalidatorForOrder` so a fill that just
     *         landed but hasn't been postInteraction-finalised can't
     *         be cleared out (Codex round-1 P1 #4 + round-8 P1 #2).
     *         Returns custodial collateral to `loan.borrower`'s vault
     *         (NOT the current NFT owner's vault — Codex round-2
     *         P1 #3), decrements the aggregate allowance + live
     *         count, and emits {SwapToRepayIntentCancelled}.
     */
    function cancelSwapToRepayIntent(uint256 loanId)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.SwapToRepayIntentCommit storage commit = s.intentCommits[loanId];
        if (commit.orderHash == bytes32(0)) revert IntentNoCommit(loanId);

        // Authority: current borrower-NFT holder (Codex round-2
        // P2 #6 — claim rights follow the NFT, not the commit-time
        // owner).
        LibAuth.requireBorrowerNftOwner(s.loans[loanId]);

        // Borrower can only cancel after Fusion's auction deadline
        // — before that the order is still fillable on the
        // resolver-pickup endpoint.
        if (block.timestamp < commit.deadline) revert IntentNotPastDeadline();

        _executeCancel(s, loanId, commit, msg.sender);
    }

    /**
     * @notice §5.5 — permissionless cancel-of-expired safety net.
     *         Callable after
     *         `deadline + cfgIntentCancelGraceSeconds`. Same already-
     *         filled pre-check + same return target as
     *         {cancelSwapToRepayIntent}. Bypasses the §5.6 master
     *         switch IFF a commit exists (so a chain-toggle-off
     *         can't strand custodial collateral).
     */
    function cancelExpiredIntent(uint256 loanId)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.SwapToRepayIntentCommit storage commit = s.intentCommits[loanId];
        if (commit.orderHash == bytes32(0)) revert IntentNoCommit(loanId);

        // Grace window starts at Fusion's `deadline` and runs for
        // `cfgIntentCancelGraceSeconds` (default 24h). During that
        // window only the current borrower-NFT holder may cancel —
        // keeps a keeper / opportunist from front-running the
        // borrower's own clean recovery path.
        if (
            block.timestamp <
                uint256(commit.deadline) + uint256(LibVaipakam.cfgIntentCancelGraceSecondsEffective())
        ) revert IntentNotPastCancelGrace();

        _executeCancel(s, loanId, commit, msg.sender);
    }

    // ──────────────────────────────────────────────────────────────
    //  Shared cancel teardown (Codex round-11 P1 #1 —
    //  safeTransfer-before-recordVaultDeposit; round-8 P1 #2 —
    //  rawRemainingInvalidatorForOrder; round-10 P1 #6 —
    //  pinned `lopAtCommit` for the Fusion cancel call)
    // ──────────────────────────────────────────────────────────────

    /// @notice §5.8 layer 2 — force-cancel a live intent commit to
    ///         clear custody before a lender-protection action
    ///         settles. Called by `RiskFacet`'s 4 HF-liquidation
    ///         entry points + `RiskMatchLiquidationFacet.triggerInternalMatchLiquidation`
    ///         + `RepayFacet._autoLiquidatePeriodShortfall` +
    ///         `DefaultedFacet.triggerDefault` AFTER they confirm
    ///         their respective trigger condition (HF <
    ///         HF_LIQUIDATION_THRESHOLD for the HF paths; loan past
    ///         `endTime + gracePeriod` for the time-default path).
    /// @dev    `onlyDiamondInternal` — restricted to cross-facet
    ///         calls. The trigger-condition check is the caller's
    ///         responsibility (the diamond's reentrancy guard
    ///         already wraps the outer entry point). Identical
    ///         teardown to {_executeCancel}: Fusion cancel, return
    ///         collateral to `loan.borrower` vault, aggregate-
    ///         allowance + live-count decrement, storage cleanup;
    ///         the only difference is the event emitted (
    ///         {SwapToRepayIntentForceCancelled} with reason
    ///         discriminator + source facet attribution).
    function internalForceCancelIntent(uint256 loanId, ForceCancelReason reason)
        external
    {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.SwapToRepayIntentCommit storage commit = s.intentCommits[loanId];
        if (commit.orderHash == bytes32(0)) revert IntentNoCommit(loanId);

        bytes32 orderHash = _teardownCommit(s, loanId, commit);

        emit SwapToRepayIntentForceCancelled(loanId, orderHash, reason, msg.sender);
    }

    /// @notice One-liner force-cancel helper for HF-liquidation
    ///         entry points (`RiskFacet`'s four triggers,
    ///         `RiskMatchLiquidationFacet.triggerInternalMatchLiquidation`,
    ///         `RepayFacet._autoLiquidatePeriodShortfall`). If no
    ///         commit is live → no-op. If a commit is live AND
    ///         HF < `HF_LIQUIDATION_THRESHOLD` → force-cancel +
    ///         emit `SwapToRepayIntentForceCancelled` with
    ///         `HFBelowLiquidationThreshold` reason. If a commit
    ///         is live AND HF is still healthy → revert
    ///         `IntentPending` so the borrower keeps the 5min + 24h
    ///         window the design promises.
    /// @dev    `onlyDiamondInternal`. Callers wire this as the
    ///         FIRST line of their entry point (before any other
    ///         vault-touching work). Replaces the temporary
    ///         `LibVaipakam.assertNoLiveIntentCommit` placeholder
    ///         the round-2 checkpoint used.
    function forceCancelIntentIfHFBelowOrRevert(uint256 loanId) external {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.intentCommits[loanId].orderHash == bytes32(0)) return;
        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hf >= LibVaipakam.HF_LIQUIDATION_THRESHOLD) {
            revert IVaipakamErrors.IntentPending(loanId);
        }
        LibVaipakam.SwapToRepayIntentCommit storage commit = s.intentCommits[loanId];
        bytes32 orderHash = _teardownCommit(s, loanId, commit);
        emit SwapToRepayIntentForceCancelled(
            loanId, orderHash, ForceCancelReason.HFBelowLiquidationThreshold, address(this)
        );
    }

    /// @notice One-liner force-cancel helper for
    ///         `DefaultedFacet.triggerDefault`. If no commit is
    ///         live → no-op. If a commit is live AND
    ///         `block.timestamp >= endTime + gracePeriod` →
    ///         force-cancel + emit
    ///         `SwapToRepayIntentForceCancelled` with
    ///         `TimeDefaultDue` reason. If a commit is live AND
    ///         the loan isn't past grace yet → revert
    ///         `IntentPending`.
    /// @dev    `onlyDiamondInternal`. Same wiring pattern as
    ///         {forceCancelIntentIfHFBelowOrRevert}.
    function forceCancelIntentIfPastDefaultOrRevert(uint256 loanId) external {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.intentCommits[loanId].orderHash == bytes32(0)) return;
        LibVaipakam.Loan storage loan = s.loans[loanId];
        uint256 endTime = uint256(loan.startTime)
            + uint256(loan.durationDays) * LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp < graceEnd) {
            revert IVaipakamErrors.IntentPending(loanId);
        }
        LibVaipakam.SwapToRepayIntentCommit storage commit = s.intentCommits[loanId];
        bytes32 orderHash = _teardownCommit(s, loanId, commit);
        emit SwapToRepayIntentForceCancelled(
            loanId, orderHash, ForceCancelReason.TimeDefaultDue, address(this)
        );
    }

    /// @dev Tears down a live commit per §5.5 — invariant guard,
    ///      Fusion cancel, collateral return to `loan.borrower`'s
    ///      vault, aggregate-allowance + live-count decrements,
    ///      storage cleanup, event. Shared body for both cancel
    ///      paths; the per-path authority + timing checks live in
    ///      their respective external entry points.
    function _executeCancel(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.SwapToRepayIntentCommit storage commit,
        address cancelledBy
    ) private {
        bytes32 orderHash = _teardownCommit(s, loanId, commit);
        emit SwapToRepayIntentCancelled(loanId, orderHash, cancelledBy);
    }

    /// @dev Shared commit-teardown body used by {_executeCancel}
    ///      (borrower / permissionless paths) and
    ///      {internalForceCancelIntent} (lender-protection paths).
    ///      Handles: already-filled pre-check (Codex round-8 P1 #2),
    ///      Fusion `cancelOrder` (round-12 P1 #4),
    ///      safeTransfer-then-recordVaultDeposit return (round-11
    ///      P1 #1), aggregate-allowance + live-count decrement +
    ///      Fusion approval re-set, storage cleanup. Returns the
    ///      orderHash so the caller can emit the right event.
    function _teardownCommit(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.SwapToRepayIntentCommit storage commit
    ) private returns (bytes32 orderHash) {
        // ── 1. Already-filled pre-check (Codex round-8 P1 #2) ───────
        uint256 remainingRaw = IOrderMixin(commit.lopAtCommit)
            .rawRemainingInvalidatorForOrder(address(this), commit.orderHash);
        // Bit-invalidator mode → fully-spent slot returns
        // `type(uint256).max`; remaining-amount mode → fully-filled
        // returns 1. Any non-zero is "already filled / in progress".
        if (remainingRaw != 0) revert IntentAlreadyFilled();

        // ── 2. Cancel Fusion-side ───────────────────────────────────
        IOrderMixin(commit.lopAtCommit).cancelOrder(
            MakerTraits.wrap(commit.makerTraits),
            commit.orderHash
        );

        // ── 3. Return custodial collateral to `loan.borrower`'s
        //       vault (Codex round-2 P1 #3 + round-11 P1 #1) ────────
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #594 Codex #659 P1 — the return targets the STORED `loan.borrower`'s
        // vault (where the lien is reinstated), which may have transferred + been
        // sanctions-flagged AFTER the commit. The collateral is in Diamond
        // custody right now (NOT in the vault), so the consolidation hook below
        // can't pre-run to re-anchor — and during the live commit it was the D-3
        // exclusion anyway. Resolve this ONE transient return sanctions-exempt:
        // the funds land in the stale vault only momentarily, then the hook (end
        // of this fn, after the commit is cleared) moves them out to the current
        // holder. Pinned to the exact `loan.borrower` (Codex round-3 D); the
        // cancel/force-cancel callers are `nonReentrant`, so nothing else
        // resolves a flagged vault in the window.
        s.consolidationMoveFromUser = loan.borrower;
        address borrowerVault = LibFacet.getOrCreateVault(loan.borrower);
        IERC20(loan.collateralAsset).safeTransfer(
            borrowerVault, commit.custodialCollateral
        );
        LibVaipakam.recordVaultDeposit(
            loan.borrower, loan.collateralAsset, commit.custodialCollateral
        );
        s.consolidationMoveFromUser = address(0);
        // #569 §4.4 (2026-06-13) — temporary-custody restore. The
        // collateral is back in the borrower's vault and the loan stays
        // Active, so re-instate the lien that `commitSwapToRepayIntent`
        // decremented to zero. Without this, a borrower who commits then
        // cancels an intent would leave their (still-pledged) collateral
        // unprotected by the chokepoint guard.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.incrementCollateralLien.selector,
                loanId,
                commit.custodialCollateral
            ),
            bytes4(0)
        );

        // ── 4. Aggregate-allowance + live-count decrements ──────────
        s.intentAggregateAllowance[loan.collateralAsset] -=
            commit.custodialCollateral;
        s.intentLiveCommitCount -= 1;
        IERC20(loan.collateralAsset).forceApprove(commit.lopAtCommit, 0);
        if (s.intentAggregateAllowance[loan.collateralAsset] != 0) {
            IERC20(loan.collateralAsset).forceApprove(
                commit.lopAtCommit,
                s.intentAggregateAllowance[loan.collateralAsset]
            );
        }

        // ── 5. Storage cleanup ──────────────────────────────────────
        orderHash = commit.orderHash;
        bytes32 extensionHash = commit.extensionHash;
        delete s.orderHashToLoanId[orderHash];
        // T-087 Sub 3.B — clear the kind discriminator so the
        // dispatcher can't route a Fusion callback for this
        // orderHash post-teardown.
        delete s.orderHashKind[orderHash];
        // Refcount-aware delete (Codex round-1 PR #420 P2 #3) — only
        // the LAST teardown for this extensionHash deletes the bytes.
        s.intentExtensionBytesRefCount[extensionHash] -= 1;
        if (s.intentExtensionBytesRefCount[extensionHash] == 0) {
            delete s.intentExtensionBytes[extensionHash];
        }
        delete s.intentCommits[loanId];

        // #594 — every teardown (borrower cancel, permissionless cancel,
        // force-cancel via HF / past-default) returns the custodial collateral
        // to `loan.borrower`'s vault + reinstates the lien there (Codex round-2
        // P1 #3), which re-strands it for a transferred position. Hooking the
        // consolidation HERE — not in `_executeCancel` — covers the force-cancel
        // paths that call `_teardownCommit` directly (Codex #655 PR-2 Msj/7dw).
        // The intent is cleared above (`delete s.intentCommits`), so the loan is
        // no longer the live-intent D-3 exclusion; consolidate the borrower side
        // so the returned collateral moves to the current holder. Self-resolving
        // + skip-not-block makes it safe regardless of caller.
        LibConsolidation.consolidateToHolder(
            loanId, false, LibConsolidation.Ctx.Tier2CloseOut
        );
    }


    // ══════════════════════════════════════════════════════════════
    //  Read surface for the dapp's read-back-then-post pattern
    // ══════════════════════════════════════════════════════════════

    /// @notice §6.2 — dapp reads back the canonical Fusion order for
    ///         this loan's live commit, then posts the full struct
    ///         to 1inch's resolver-pickup endpoint via the
    ///         `apps/agent` worker. Reverts {IntentNoCommit} if no
    ///         commit is live.
    /// @dev    Reconstructs the derivable fields (maker / receiver /
    ///         assets) from the loan + diamond identity, returns the
    ///         stored fields verbatim, and resolves the extension
    ///         bytes from `intentExtensionBytes[extensionHash]` so
    ///         the dapp doesn't need a second on-chain read.
    function getIntentCommit(uint256 loanId)
        external
        view
        returns (FusionOrderRead memory order)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.SwapToRepayIntentCommit storage commit = s.intentCommits[loanId];
        if (commit.orderHash == bytes32(0)) revert IntentNoCommit(loanId);
        LibVaipakam.Loan storage loan = s.loans[loanId];
        order.maker       = address(this);
        order.receiver    = address(this);
        order.makerAsset  = loan.collateralAsset;
        order.takerAsset  = loan.principalAsset;
        order.makerAmount = commit.makerAmount;
        order.takerAmount = commit.takerAmount;
        order.deadline    = commit.deadline;
        order.salt        = commit.salt;
        order.makerTraits = commit.makerTraits;
        order.extension   = s.intentExtensionBytes[commit.extensionHash];
    }
}
