// src/facets/SwapToRepayIntentFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
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
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {LibSaleSizing} from "../libraries/LibSaleSizing.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibLopDomain} from "../libraries/LibLopDomain.sol";

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
 *         Sub 1 (#416) is implemented: this facet now owns the
 *         borrower-facing commit / cancel / force-cancel surface,
 *         while Fusion preInteraction / postInteraction /
 *         ERC-1271 dispatch was extracted to `IntentDispatchFacet`
 *         and `LibSwapToRepayIntentSettlement`.
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
    //  derives `maker` = the borrower's vault (#1566 S3e) and
    //  `receiver = address(this)`, sets `makerAmount` to the debt-sized
    //  lot (#2322; it leaves the vault only in the fill since #1566
    //  slice 3), and recomputes the canonical 1inch LOP v4 orderHash
    //  on-chain).
    // ──────────────────────────────────────────────────────────────

    /// @notice §6.2 dapp-flow input. The borrower picks the
    ///         takerAmount + deadline + salt + makerTraits +
    ///         extension; the diamond fills in the maker/receiver/
    ///         asset fields and finalises makerAmount based on the
    ///         actual vault withdraw.
    struct FusionOrderParams {
        /// @dev Borrower-picked principal the order asks for the lot — its
        ///      PRICE on this fixed-price order. Must be at least the lot's own
        ///      slippage-capped floor (#2322 r3), which covers the §5.4 floor
        ///      (`lenderLeg + treasuryLeg + lateFee` with the
        ///      `cfgIntentMinOutputBufferBps` buffer) and can exceed it when
        ///      collateral granularity makes the smallest covering lot worth
        ///      more. {previewSwapToRepayIntentLot} reports that minimum.
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
        address maker;          // the borrower's vault (#1566 S3e)
        address receiver;       // == address(this)
        address makerAsset;     // loan.collateralAsset
        address takerAsset;     // loan.principalAsset
        uint256 makerAmount;    // commit.makerAmount (#2322 — the debt-sized lot, <= loan.collateralAmount; in the vault until the fill)
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
    ///         internal-match + RepayPeriodicFacet's periodic-shortfall
    ///         sale + DefaultedFacet.triggerDefault when they cancel a
    ///         live commit before settling the lender-protection action
    ///         ({forceCancelIntentFor}). The `reason` names the trigger
    ///         the cancel was checked against: HF, past grace, or a
    ///         periodic shortfall due.
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
        TimeDefaultDue,
        /// @dev A periodic-interest period is past its grace with a
        ///      shortfall, and the periodic settlement sells collateral
        ///      for it (#2732).
        PeriodicShortfallDue
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
    /// @dev #2322 — even the loan's WHOLE collateral, valued at the oracle
    ///      less the borrower-facing slippage cap, does not cover the debt
    ///      floor plus the auction buffer, so no lot can back a repayment.
    error IntentCollateralCannotCoverDebtFloor(uint256 minOut);
    /// @dev §5.5 — cancel paths fired against a loanId without a
    ///      live commit.
    error IntentNoCommit(uint256 loanId);
    /// @dev §5.5 — borrower-cancel before `deadline`.
    error IntentNotPastDeadline();
    /// @dev §5.5 — the order's nonce bit is set at the LOP: filled (or
    ///      cancelled there) while the commit is still recorded (Codex
    ///      round-8 P1 #2; read via `bitInvalidatorForOrder` since #1566
    ///      slice 3).
    error IntentAlreadyFilled();
    /// @dev #1566 slice 3 (O1) — a commit recorded under the old custody,
    ///      its lot in the Diamond; refused by name at the pre-hook and the
    ///      teardown. Same selector as the settlement library's declaration.
    error IntentCustodyNotVaultHeld(uint256 loanId);
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
    /// @dev Mirrors `SwapToRepayFacet.UnsupportedLoanShape` (the v1
    ///      sibling keeps this error facet-local rather than on
    ///      `IVaipakamErrors`). v1.1 uses the same conditions: both
    ///      legs ERC20 + both legs Liquid.
    error UnsupportedLoanShape();
    /// @dev Mirrors `SwapToRepayFacet.RepaymentPastGracePeriod`.
    error RepaymentPastGracePeriod();
    /// @dev {forceCancelIntentFor} is restricted to cross-facet calls —
    ///      only a forced close-out the Diamond is running may cancel a
    ///      borrower's intent.
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
     * @notice §5.1 — sizes the debt-sized lot, registers the canonical
     *         orderHash, and has `loan.borrower`'s vault -- the order's
     *         maker (#1566 S3e) -- sign for it and raise its allowance
     *         to Fusion's pinned `LimitOrderProtocol` by the lot. Moves
     *         no collateral: the lot stays in the vault until its own
     *         fill, where the LOP takes it straight to the taker.
     * @param  loanId Loan being repaid. Must be Active + ERC20-on-ERC20
     *         + both legs allowlisted + caller is the current
     *         borrower-NFT owner + HF >=
     *         `cfgIntentMinCommitHF`.
     * @param  params Borrower-picked Fusion-order inputs (see
     *         {FusionOrderParams}). The diamond derives maker /
     *         receiver / assets and sets `makerAmount` to the lot.
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

        // #594 — consolidate a transferred borrower position BEFORE the commit
        // (design D-3 principle 2 — the commit is the state-entering endpoint),
        // so the order's maker -- and the vault the fill later takes the lot
        // from -- is the current holder's vault.
        // Borrower side, skip-not-block.
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
        uint256 endTime = LibLoanClock.maturity(loan);
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
        // #2322 — lock the borrower position for the life of the commit. The
        // commit consolidated the borrower side to the current holder above,
        // and the part of the collateral the auction does not take stays in
        // THAT holder's vault, liened, until the fill. Borrower-side
        // consolidation is skipped while an intent is live and is a no-op once
        // the fill has closed the loan, so a transfer mid-auction would leave
        // the remainder — and any VPFI fee-tier credit on it — anchored to a
        // departed holder. The protocol's native position lock (the one the
        // offset and lender-sale flows use) keeps the holder fixed instead of
        // repairing the anchor afterwards; `_lock` refuses if another flow
        // already holds the lock, so a commit cannot overwrite it. Every
        // teardown (cancel, expired cancel, both force-cancels) and the fill
        // settlement release it.
        LibERC721._lock(loan.borrowerTokenId, LibERC721.LockReason.SwapToRepayIntent);

        // ── §5.1 step 7: minOutput floor (Codex round-10 P1 #5 +
        //    round-11 P1 #3 — must add late fee on top of getPrepayContext) ─
        uint256 minOut = _commitMinOut(loanId, endTime);

        // ── §5.1 step 7b: size the auction lot to the debt (#2322) ──
        // The spec's full-close rule, shared with `swapToRepayFull`
        // through {LibSaleSizing}: collateral the repayment does
        // not need stays pledged. The lot is the least collateral whose
        // slippage-capped oracle value covers `minOut` — the debt floor
        // plus the auction buffer — bounded by the loan's whole
        // collateral. It is sized to the DEBT, not to `takerAmount`: the
        // order is a fixed-price limit order (no amount getter in the
        // canonical extension), so `takerAmount / lot` IS its price, and
        // sizing the lot to `takerAmount` would pin every order at the
        // slippage-cap discount. Sized to the debt, the lot is exactly
        // what a worst-case fill needs to repay; the borrower sets the
        // price by asking more than `minOut` for it, and anything a fill
        // raises above the debt is the borrower's surplus principal —
        // the same shape as the direct close. The remainder never leaves
        // the vault and stays liened throughout the auction.
        //
        // The least ask the commit accepts is the LOT's own slippage
        // floor, not `minOut` (Codex #2341 r3). Sizing guarantees that
        // floor covers `minOut`, but collateral granularity can make it
        // far larger — a coarse-decimal, high-value token whose smallest
        // covering lot is worth much more than the debt. Accepting
        // `minOut` there would let a resolver buy the lot below the worst
        // case the slippage cap allows; requiring the lot's floor keeps
        // "asking the minimum accepts the cap's worst case" true for every
        // lot, as the direct close's `minPrincipalOut` does.
        (uint256 lot, uint256 minTaker) = _sizeCommitLot(loan, minOut);
        if (params.takerAmount < minTaker)
            revert IntentMinOutputBelowFloor(params.takerAmount, minTaker);

        // ── §5.1 step 8 (#1566 slice 3): the lot STAYS in the vault ─
        // The commit moves nothing. The lot leaves `loan.borrower`'s vault
        // only inside its own fill (the LOP pre-hook,
        // `LibSwapToRepayIntentSettlement.preInteractionImpl`), under the
        // fill lock, so no user collateral rests in the Diamond between
        // transactions (#2141). Until then the lien stays at the whole
        // collateral and the borrower's VPFI tier is untouched; the
        // fee-on-transfer refusal moves to the pre-hook's exact-delta check.
        // `custodialCollateral` is the old custody stamp: a new commit never
        // writes it (0 = vault-held), and both ways out refuse a non-zero
        // one (owner decision O1: fresh deploy only).

        // ── §5.1 step 9: compute canonical 1inch LOP v4 orderHash ───
        // Replicates `OrderLib.hash`: EIP-712 over the 8-field Order
        // struct under the LOP's own domain, read from the pinned
        // `cfgFusionLimitOrderProtocol` the way the deployed LOP declares
        // it (ERC-5267 `eip712Domain()`; #2449: the deployed v4 LOP has no
        // `DOMAIN_SEPARATOR()` getter).
        bytes32 lopDomainSeparator = LibLopDomain.separator(s.cfgFusionLimitOrderProtocol);
        // #1566 S3e — the maker is `loan.borrower`'s vault, read from storage
        // (no sanctions screen: a must-complete close-out).
        address vault = s.userVaipakamVaults[loan.borrower];
        bytes32 structHash = keccak256(abi.encode(
            _LIMIT_ORDER_TYPEHASH,
            params.salt,
            uint256(uint160(vault)),                 // maker = the borrower's vault
            uint256(uint160(address(this))),         // receiver = diamond
            uint256(uint160(loan.collateralAsset)),  // makerAsset
            uint256(uint160(loan.principalAsset)),   // takerAsset
            lot,                                     // makingAmount = the lot the LOP takes from the vault
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

        // ── §5.1 step 10 (#1566 S3e): the vault signs and approves ───
        // The vault, not this Diamond, is the order's maker: register the
        // hash on it with this Diamond as the validator (the registry the
        // Seaport listings use), so its ERC-1271 answers through
        // `IntentDispatchFacet.isOrderValid`; and raise its exact allowance
        // to the pinned LOP by the lot (zero-then-set for USDT-style
        // tokens, inside the vault). The orderbook then sees the lot where
        // it rests, approved, and reads the order as fillable.
        VaipakamVaultImplementation(vault).registerListingOrderHash(orderHash, address(this));
        VaipakamVaultImplementation(vault).approveERC20(
            loan.collateralAsset,
            s.cfgFusionLimitOrderProtocol,
            IERC20(loan.collateralAsset).allowance(vault, s.cfgFusionLimitOrderProtocol) + lot
        );

        // ── §5.1 step 11: record commit + reverse index + extension
        //    bytes + bump live count + emit ─────────────────────────────
        s.intentCommits[loanId] = LibVaipakam.SwapToRepayIntentCommit({
            orderHash: orderHash,
            deadline: params.deadline,
            makerAmount: lot,
            takerAmount: params.takerAmount,
            salt: params.salt,
            makerTraits: params.makerTraits,
            extensionHash: extensionHash,
            custodialCollateral: 0, // #1566 slice 3: vault-held; a new commit never writes the stamp
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
            lot,
            params.takerAmount,
            params.deadline
        );
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
     *         time after `deadline`; refuses an order whose nonce bit
     *         the LOP has already set (Codex round-1 P1 #4 + round-8
     *         P1 #2), has the vault stop signing for it and lower its
     *         allowance to the LOP by the lot (#1566 S3e), decrements
     *         the live count, and emits {SwapToRepayIntentCancelled}. Moves no tokens: the lot
     *         never left `loan.borrower`'s vault (#1566 slice 3).
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
     *         can't leave an order live forever).
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
    //  Shared cancel teardown (round-8 P1 #2 — the already-filled
    //  check, read from the order's nonce bit since #1566 slice 3;
    //  round-10 P1 #6 — pinned `lopAtCommit` for the Fusion cancel
    //  call). Moves no tokens: the lot never left the vault.
    // ──────────────────────────────────────────────────────────────

    /// @notice §5.8 layer 2 — force-cancel a live intent commit before
    ///         a lender-protection action settles, so the order cannot
    ///         fill against collateral the action is about to take.
    ///         Every forced close-out calls this ONE entry with the
    ///         trigger it acts on (#2732): the HF liquidations
    ///         (`RiskFacet`, `RiskSplitLiquidationFacet`,
    ///         `RiskMatchLiquidationFacet`) pass
    ///         `HFBelowLiquidationThreshold`, the time-based default
    ///         (`DefaultedFacet.triggerDefault`) passes `TimeDefaultDue`,
    ///         and the periodic-shortfall sale
    ///         (`RepayPeriodicFacet`) passes `PeriodicShortfallDue`.
    ///         No commit live → no-op. A commit live AND the named
    ///         trigger holds now → the commit is torn down and
    ///         {SwapToRepayIntentForceCancelled} carries the reason. A
    ///         commit live AND the trigger does not hold → revert
    ///         `IntentPending`, so the borrower keeps the window the
    ///         design promises.
    /// @dev    `onlyDiamondInternal`. The facet re-checks the trigger
    ///         itself ({_forceCancelDue}) rather than trusting the
    ///         caller's word, so a caller passing the wrong reason
    ///         cannot cancel an intent its own trigger does not
    ///         justify. Before #2732 each trigger had its own entry and
    ///         the periodic-shortfall sale borrowed the HF one, so a
    ///         healthy borrower who missed a periodic payment could
    ///         hold the sale off with a live intent. Same teardown as
    ///         {_executeCancel} (no collateral moves: it never left the
    ///         vault); only the event differs.
    function forceCancelIntentFor(uint256 loanId, ForceCancelReason reason) external {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.SwapToRepayIntentCommit storage commit = s.intentCommits[loanId];
        if (commit.orderHash == bytes32(0)) return;
        if (!_forceCancelDue(s, loanId, reason)) {
            revert IVaipakamErrors.IntentPending(loanId);
        }
        bytes32 orderHash = _teardownCommit(s, loanId, commit);
        emit SwapToRepayIntentForceCancelled(loanId, orderHash, reason, address(this));
    }

    /// @dev Whether the trigger `reason` names holds for `loanId` now —
    ///      the same test the calling close-out applies before it acts:
    ///      HF below `HF_LIQUIDATION_THRESHOLD`; past the loan's grace
    ///      end ({LibLoanClock.graceEnd}); or a periodic settlement due
    ///      with a shortfall to sell for
    ///      ({LibPeriodicInterest.settleableShortfall}).
    function _forceCancelDue(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        ForceCancelReason reason
    ) private view returns (bool) {
        if (reason == ForceCancelReason.HFBelowLiquidationThreshold) {
            return RiskFacet(address(this)).calculateHealthFactor(loanId)
                < LibVaipakam.HF_LIQUIDATION_THRESHOLD;
        }
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (reason == ForceCancelReason.TimeDefaultDue) {
            return block.timestamp >= LibLoanClock.graceEnd(loan);
        }
        return LibPeriodicInterest.settleableShortfall(loan) > 0;
    }

    /// @dev Tears down a live commit per §5.5 — invariant guard,
    ///      the vault's signature and allowance withdrawn, live-count
    ///      decrement, storage cleanup, event. Moves no collateral. Shared body for both cancel
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
    ///      {forceCancelIntentFor} (lender-protection paths).
    ///      Handles: the old-custody refusal (#1566 slice 3, O1), the
    ///      already-filled nonce-bit check (Codex round-8 P1 #2), the
    ///      vault's signing registration revoked and its allowance to the
    ///      LOP lowered by the lot (#1566 S3e: these replace the LOP-side
    ///      `cancelOrder` of round-12 P1 #4, which only the maker could now
    ///      send, and the Diamond's aggregate allowance), the live-count
    ///      decrement, storage cleanup. Moves no tokens: the lot is still in
    ///      the vault.
    ///      Returns the orderHash so the caller can emit the right event.
    function _teardownCommit(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.SwapToRepayIntentCommit storage commit
    ) private returns (bytes32 orderHash) {
        // ── 1. O1: a commit recorded under the old custody is refused ──
        // Its lot is in the Diamond; it is refused by name rather than
        // paid out of the Diamond's balance (fresh deploy only).
        if (commit.custodialCollateral != 0) revert IntentCustodyNotVaultHeld(loanId);
        // ── 1b. Already-filled check: the order's nonce bit ─────────
        // A swap-to-repay order is a bit-invalidator order (no partial
        // fills), and the LOP marks it spent by setting its nonce bit
        // BEFORE the pre-hook; it never writes the remaining-amount slot,
        // so the `rawRemainingInvalidatorForOrder` read this replaces could
        // not see a fill (#1566 slice 3, K10). `bitInvalidatorForOrder`
        // takes the nonce and shifts it itself. Buyback orders use the
        // remaining-amount invalidator (they allow several fills), so no
        // buyback order can set this bit.
        // The maker, whose bit the LOP sets, is the borrower's vault (S3e).
        address vault = s.userVaipakamVaults[s.loans[loanId].borrower];
        uint256 nonce = (commit.makerTraits >> 120) & ((1 << 40) - 1);
        if (
            IOrderMixin(commit.lopAtCommit).bitInvalidatorForOrder(vault, nonce)
                & (1 << (nonce & 0xff)) != 0
        ) revert IntentAlreadyFilled();

        // ── 2. The vault stops signing for the order (#1566 S3e) ────
        // Without the registration the vault's ERC-1271 refuses the order,
        // and with the allowance lowered below (step 4) the LOP could not
        // take the lot either. No LOP-side cancel is needed (only the
        // maker could send one).
        VaipakamVaultImplementation(vault).revokeListingOrderHash(commit.orderHash);

        // ── 3. Nothing to return (#1566 slice 3) ────────────────────
        // The lot never left `loan.borrower`'s vault: a teardown moves no
        // tokens, leaves the lien at the whole collateral and needs no
        // VPFI restamp. That also closes #658 for every commit: a borrower
        // flagged after the commit no longer blocks the cancel or the
        // lender-protection force-cancel, because nothing is credited to
        // their vault.
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // ── 4. The vault's allowance + the live count (#1566 S3e) ───
        {
            uint256 current = IERC20(loan.collateralAsset).allowance(vault, commit.lopAtCommit);
            VaipakamVaultImplementation(vault).approveERC20(
                loan.collateralAsset,
                commit.lopAtCommit,
                current > commit.makerAmount ? current - commit.makerAmount : 0
            );
        }
        s.intentLiveCommitCount -= 1;

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
        // #2322 — release the borrower-position lock the commit took. Reason-
        // checked: a commit made before the lock existed never took it, and
        // must not clear another flow's lock (e.g. a live prepay listing's).
        LibERC721._unlockIfHeldBy(loan.borrowerTokenId, LibERC721.LockReason.SwapToRepayIntent);

        // #594 — every teardown (borrower cancel, permissionless cancel,
        // force-cancel via HF / past-default) leaves the whole collateral in
        // `loan.borrower`'s vault, liened there (since #1566 slice 3 the lot
        // never left it), and a transferred position would leave it stranded
        // on the stored borrower. Hooking the consolidation HERE — not in
        // `_executeCancel` — covers the force-cancel paths that call
        // `_teardownCommit` directly (Codex #655 PR-2 Msj/7dw). The intent is
        // cleared above (`delete s.intentCommits`), so the loan is no longer the
        // live-intent D-3 exclusion; consolidate the borrower side so the
        // collateral moves to the current holder. Self-resolving +
        // skip-not-block makes it safe regardless of caller.
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
        order.maker       = s.userVaipakamVaults[loan.borrower]; // #1566 S3e: the vault is the maker
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

    /// @notice #1566 slice 3 — how much of `loanId`'s live commit rests in the
    ///         Diamond. Always 0 on a Diamond built from this source: the lot
    ///         stays in the borrower's vault until its own fill. Non-zero only
    ///         for a commit recorded under the old custody, which the pre-hook
    ///         and every teardown refuse (`IntentCustodyNotVaultHeld`).
    ///         Exposed for the custody census to read.
    function getIntentCustody(uint256 loanId) external view returns (uint256 diamondHeld) {
        return LibVaipakam.storageSlot().intentCommits[loanId].custodialCollateral;
    }

    /// @notice #2322 — the auction lot {commitSwapToRepayIntent} would put
    ///         up right now, and the least `takerAmount` it would accept.
    /// @dev    Shares the commit's computation ({_commitMinOut} +
    ///         {_sizeCommitLot} → {LibSaleSizing.sizeSale}), so the
    ///         borrower can see the lot before committing. The lot is the
    ///         collateral the debt needs at the worst case; the rest stays in
    ///         the vault, pledged, and is released by the borrower's claim
    ///         after a fill. The order's price is `takerAmount / lot`: asking
    ///         `minTakerAmount` accepts the slippage-cap discount, asking more
    ///         prices the lot higher, and whatever a fill raises above the
    ///         debt is the borrower's surplus principal. Both figures move
    ///         with accrued interest, late fees and oracle updates, so the lot
    ///         the commit actually takes is the one {getIntentCommit} reports
    ///         afterwards, and that — not this preview — is what the order
    ///         posted to the resolver network must carry. Refuses with
    ///         {IntentSurfaceDisabled} when the deployment's master switch
    ///         (`getIntentSwapToRepayEnabled`) is off, as the commit does, so
    ///         it never quotes a capability this deployment has turned off.
    ///         Beyond that it checks only the loan shape and grace window the
    ///         numbers need; it does not apply the commit's authority, HF,
    ///         deadline or allowlist gates.
    /// @param  loanId         The loan to quote.
    /// @return lot            Collateral the commit would put up for the auction (it stays in the
    ///                        borrower's vault until the fill takes it).
    /// @return minTakerAmount The least `takerAmount` the commit accepts: the
    ///                        lot's own slippage-capped floor, which covers
    ///                        the debt floor plus the auction buffer and can
    ///                        exceed it when collateral granularity makes the
    ///                        smallest covering lot worth more.
    function previewSwapToRepayIntentLot(uint256 loanId)
        external
        view
        returns (uint256 lot, uint256 minTakerAmount)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.cfgIntentSwapToRepayEnabled) revert IntentSurfaceDisabled();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert IVaipakamErrors.InvalidLoanStatus();
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20 ||
            loan.collateralAssetType != LibVaipakam.AssetType.ERC20 ||
            loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
        ) revert UnsupportedLoanShape();
        uint256 endTime = LibLoanClock.maturity(loan);
        if (block.timestamp > endTime + LibVaipakam.gracePeriod(loan.durationDays))
            revert RepaymentPastGracePeriod();
        (lot, minTakerAmount) = _sizeCommitLot(loan, _commitMinOut(loanId, endTime));
    }

    /// @dev §5.1 step 7 — the least `takerAmount` a commit accepts: the live
    ///      settlement floor (lender leg + treasury leg + late fee, Codex
    ///      round-10 P1 #5 + round-11 P1 #3) grossed up by the auction buffer.
    ///      The ONE place the commit and its preview derive it from.
    function _commitMinOut(uint256 loanId, uint256 endTime) private view returns (uint256) {
        uint256 floor_ = LibCollateralSettlement.principalPlusAccruedInterest(loanId, block.timestamp)
            + LibCollateralSettlement.treasuryAndPrecloseFee(loanId, block.timestamp)
            + LibVaipakam.calculateLateFee(loanId);
        return (floor_ * (
            LibVaipakam.BASIS_POINTS + LibVaipakam.cfgIntentMinOutputBufferBpsEffective()
        )) / LibVaipakam.BASIS_POINTS;
    }

    /// @dev #2322 — the auction lot: the least collateral whose
    ///      slippage-capped oracle value covers `minOut` (the debt floor plus
    ///      the auction buffer), bounded by the loan's whole collateral,
    ///      through the rule `swapToRepayFull` also uses, together with that
    ///      lot's own slippage floor — the least `takerAmount` the commit
    ///      accepts (always `>= minOut`). Refuses when even the whole
    ///      collateral cannot cover `minOut`.
    function _sizeCommitLot(LibVaipakam.Loan storage loan, uint256 minOut)
        private
        view
        returns (uint256 lot, uint256 minTaker)
    {
        bool covers;
        (covers, lot, minTaker) = LibSaleSizing.sizeSale(
            loan.collateralAsset,
            loan.principalAsset,
            minOut,
            loan.collateralAmount,
            LibVaipakam.cfgMaxSwapToRepaySlippageBps()
        );
        if (!covers) revert IntentCollateralCannotCoverDebtFloor(minOut);
    }
}
