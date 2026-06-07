// src/facets/SwapToRepayIntentFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IPreInteraction} from "@1inch/limit-order-protocol/contracts/interfaces/IPreInteraction.sol";
import {IPostInteraction} from "@1inch/limit-order-protocol/contracts/interfaces/IPostInteraction.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";

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
    IVaipakamErrors,
    IPreInteraction,
    IPostInteraction,
    IERC1271
{
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
        loanId; params; // silence-unused
        revert NotYetImplemented();
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
        loanId;
        revert NotYetImplemented();
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
        loanId;
        revert NotYetImplemented();
    }

    // ══════════════════════════════════════════════════════════════
    //  Fusion `LimitOrderProtocol` callback hooks
    //  NOT externally callable by users — Fusion's protocol invokes
    //  these atomically inside the fill transaction.
    // ══════════════════════════════════════════════════════════════

    /// @inheritdoc IPreInteraction
    /// @dev §5.1 preInteraction — snapshot the diamond's principal-
    ///      balance baseline into transient storage keyed by
    ///      orderHash so {postInteraction} can compute the actual
    ///      delivered amount via balance-delta (Codex round-7 P1 #6 +
    ///      round-11 P2 #6 — runs on Fusion's normal CALL,
    ///      authorised against `commit.lopAtCommit`, NOT the global
    ///      cfg).
    function preInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    )
        external
    {
        order; extension; orderHash; taker; makingAmount; takingAmount;
        remainingMakingAmount; extraData;
        revert NotYetImplemented();
    }

    /// @inheritdoc IPostInteraction
    /// @dev §5.1 postInteraction — atomic settlement waterfall +
    ///      residual `safeTransfer` to vault + claim record + commit
    ///      teardown + aggregate-allowance decrement. `nonReentrant`
    ///      per Codex round-2 P1 #9; auth-checked against
    ///      `commit.lopAtCommit` per round-10 P1 #6; live-floor
    ///      re-check with `+ lateFee` per round-10 P1 #5.
    function postInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    )
        external
        nonReentrant
    {
        order; extension; orderHash; taker; makingAmount; takingAmount;
        remainingMakingAmount; extraData;
        revert NotYetImplemented();
    }

    // ══════════════════════════════════════════════════════════════
    //  ERC-1271 contract-order signature validation
    //  Fusion's LOP v4 calls via STATICCALL — must stay pure
    //  read-only (Codex round-7 P1 #6).
    // ══════════════════════════════════════════════════════════════

    /// @inheritdoc IERC1271
    /// @dev §5.7 #5 — the only "signature" Fusion needs from the
    ///      diamond is a yes/no on whether this orderHash is a
    ///      registered live commit. Returns the ERC-1271 magic
    ///      value IFF `orderHashToLoanId[hash] != 0 AND
    ///      intentCommits[loanId].orderHash == hash`. Pure
    ///      read-only — no `tstore`, no state mutation.
    function isValidSignature(bytes32 orderHash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        orderHash; signature;
        revert NotYetImplemented();
    }

    // ══════════════════════════════════════════════════════════════
    //  Read surface for the dapp's read-back-then-post pattern
    // ══════════════════════════════════════════════════════════════

    /// @notice §6.2 — dapp reads back the canonical Fusion order for
    ///         this loan's live commit, then posts the full struct
    ///         to 1inch's resolver-pickup endpoint via the
    ///         `apps/agent` worker. Reverts if no commit is live.
    function getIntentCommit(uint256 loanId)
        external
        view
        returns (FusionOrderRead memory order)
    {
        loanId;
        revert NotYetImplemented();
    }
}
