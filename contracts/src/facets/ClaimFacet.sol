// src/facets/ClaimFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LenderIntentFacet} from "./LenderIntentFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {LibBackstopOracleGate} from "../libraries/LibBackstopOracleGate.sol";
import {RiskMatchLiquidationFacet} from "./RiskMatchLiquidationFacet.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/**
 * @title ClaimFacet
 * @author Vaipakam Developer Team
 * @notice This facet implements the claim-based fund distribution model for the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Uses shared LibVaipakam storage.
 *      After a loan is resolved (Repaid, Defaulted), funds are held in vault as "claimable".
 *      Lenders present their Vaipakam NFT to claim their principal + interest (or rental fees on default).
 *      Borrowers present their Vaipakam NFT to claim their collateral (or refund on rental repay).
 *      NFTs are burned only after the respective party successfully claims.
 *      Once both parties claim (or one party has nothing to claim), the loan status is set to Settled.
 *      Treasury fees are transferred immediately at resolution time and do not go through this facet.
 *      Custom errors, ReentrancyGuard, Pausable. Cross-facet calls for vault and NFT operations.
 *      Expand for Phase 2 (e.g., partial claims, time-locked claims, NFT-based access control delegation).
 */
contract ClaimFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    DiamondAccessControl,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when a lender claims their funds.
    /// @param loanId The resolved loan ID.
    /// @param claimant The address claiming the funds (must own the lender NFT).
    /// @param asset The token address claimed.
    /// @param amount The amount claimed.
    /// @param newBothClaimed True iff the borrower side has ALSO already
    ///        claimed (or had nothing to claim) — when true the loan is
    ///        about to settle and the position NFTs are about to burn.
    ///        EventSourcingAudit §3.11 — lets cache-merge consumers update
    ///        the row's terminal-status and NFT-burn-imminent state from
    ///        this single event.
    /// @custom:event-category state-change/claim-mutation
    event LenderFundsClaimed(
        uint256 indexed loanId,
        address indexed claimant,
        address asset,
        uint256 amount,
        bool newBothClaimed
    );

    /// @notice Emitted when a borrower claims their collateral or refund.
    /// @param loanId The resolved loan ID.
    /// @param claimant The address claiming the funds (must own the borrower NFT).
    /// @param asset The token address claimed.
    /// @param amount The amount claimed.
    /// @param newBothClaimed True iff the lender side has ALSO already
    ///        claimed — see {LenderFundsClaimed} for semantics.
    /// @custom:event-category state-change/claim-mutation
    event BorrowerFundsClaimed(
        uint256 indexed loanId,
        address indexed claimant,
        address asset,
        uint256 amount,
        bool newBothClaimed
    );

    /// @notice Emitted when both parties have claimed and the loan is fully settled.
    /// @param loanId The now-settled loan ID.
    /// @custom:event-category state-change/loan-mutation
    event LoanSettled(uint256 indexed loanId);

    /// @notice Emitted when a claim-time liquidation retry runs.
    /// @param loanId The loan under claim.
    /// @param succeeded True if the retry swap cleared the 6% slippage gate.
    /// @param proceeds Principal-asset proceeds received on success, 0 on failure.
    /// @custom:event-category informational/claim
    event ClaimRetryExecuted(
        uint256 indexed loanId,
        bool succeeded,
        uint256 proceeds
    );

    /// @notice Emitted when a borrower claims their Phase 5 LIF VPFI rebate.
    /// @param loanId The loan whose rebate was credited at proper settlement.
    /// @param claimant The address receiving the VPFI (borrower NFT holder).
    /// @param amount VPFI wei transferred.
    /// @param newVaultVpfiBalance Borrower's post-claim VPFI vault balance
    ///        (sum of any prior staked / discount-tier balance plus this
    ///        rebate). EventSourcingAudit §3.20 — frontend updates the
    ///        "VPFI balance is now X" UI directly from the event.
    /// @custom:event-category state-change/reward-claim
    event BorrowerLifRebateClaimed(
        uint256 indexed loanId,
        address indexed claimant,
        uint256 amount,
        uint256 newVaultVpfiBalance
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    // NotNFTOwner inherited from IVaipakamErrors
    /// @notice Funds for this loan side have already been claimed.
    error AlreadyClaimed();
    /// @notice Nothing is claimable for this loan side.
    error NothingToClaim();
    // InvalidLoanStatus and CrossFacetCallFailed inherited from IVaipakamErrors

    // ── #399 backstop v0 Role B (liquidator-of-last-resort) ─────────────────
    /// @notice Role B (absorb) is not currently enabled (master or absorb switch off).
    error BackstopAbsorbDisabled();
    /// @notice The backstop vault has not been provisioned (Role A PR1 step).
    error BackstopVaultUnset();
    /// @notice The loan is not in a state the backstop can absorb (not
    ///         FallbackPending / no active snapshot / topped-up / no lender opt-in).
    error NotBackstopAbsorbable();
    /// @notice The lender slice is worth less than `lenderPrincipalDue` at the
    ///         current oracle (underwater / oracle-unavailable) — absorb refused;
    ///         the lender uses the normal in-kind claim instead.
    error BackstopUndercollateralized();
    /// @notice The absorb would exceed the governance per-pair absorb cap.
    error BackstopAbsorbCapExceeded();
    /// @notice The per-pair absorb-cash bucket has insufficient seeded cash.
    error BackstopAbsorbInsufficientCash();
    /// @notice No objective swap retry was attempted before the buyout — the
    ///         keeper must supply a real `retryCalls` try-list (or one must have
    ///         run via a prior claim) so resolution-first isn't bypassed.
    error BackstopRetryRequired();
    /// @notice #633 — delegated keepers are globally paused by governance.
    error KeepersPaused();
    /// @notice The loan's principal asset is the live VPFI token (e.g. after a
    ///         `vpfiToken` rotation onto a seeded pair) — VPFI's discount/staking
    ///         accounting can't be bypassed by a generic cash payout, so the
    ///         absorb refuses (mirrors the seed-time VPFI guard).
    error BackstopVpfiPrincipalUnsupported();

    /// @notice A lender (current NFT owner) opted a FallbackPending loan into the
    ///         Role-B cash exit (or revoked it).
    /// @custom:event-category state-change/claim-mutation
    event LenderBackstopOptInSet(
        uint256 indexed loanId,
        address indexed lenderNftOwner,
        bool optedIn
    );

    /// @notice The backstop absorbed a FallbackPending loan's lender slice for
    ///         cash (Role B). The current lender-NFT owner was paid
    ///         `lenderPrincipalDue` from the absorb-cash bucket; the backstop
    ///         warehouses `lenderCollateral`.
    /// @custom:event-category state-change/loan-mutation
    event BackstopAbsorbedLoan(
        uint256 indexed loanId,
        address indexed lenderNftOwner,
        uint256 cashPaid,
        uint256 collateralAbsorbed
    );
    /// @notice Mirror of {DefaultedFacet.LoanDefaulted} (same signature ⇒ same
    ///         topic hash) emitted when the Role-B keeper path resolves a
    ///         FallbackPending loan to Defaulted via the retry swap (no buyout),
    ///         so the indexer flips the loan terminal even though no claim event
    ///         fires in this tx. Indexer-handled.
    /// @custom:event-category state-change/loan-mutation
    event LoanDefaulted(
        uint256 indexed loanId,
        bool riskAndTermsConsentFromBoth,
        LibVaipakam.LoanStatus newStatus
    );

    // ─── External Functions ───────────────────────────────────────────────────

    /**
     * @notice Allows the lender to claim their funds after a loan is resolved.
     * @dev Caller must own the lender's Vaipakam position NFT (proven via ERC721.ownerOf).
     *      Transfers the recorded claimable amount from the lender's vault to the caller.
     *      Burns the lender's NFT after a successful claim.
     *      If the borrower has already claimed (or has nothing to claim), sets loan to Settled.
     *      Reverts if loan is Active, Settled, or already claimed.
     *      Emits LenderFundsClaimed and optionally LoanSettled.
     * @param loanId The ID of the resolved loan.
     */
    function claimAsLender(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        // No retry-swap try-list supplied — fallback collateral is
        // distributed as recorded by the original liquidation. Phase
        // 7a default behaviour for lenders who don't bring quotes.
        LibSwap.AdapterCall[] memory empty = new LibSwap.AdapterCall[](0);
        _claimAsLenderImpl(loanId, empty);
    }

    /**
     * @notice Phase 7a counterpart to {claimAsLender}: lender (or a
     *         keeper acting on the lender's NFT) supplies a ranked
     *         retry try-list when the loan is in `FallbackPending`.
     *         Frontend / HF watcher fetches fresh quotes from 0x /
     *         1inch / UniV3 / Balancer, ranks by expected output, and
     *         submits — same shape as
     *         {RiskFacet.triggerLiquidation}'s second argument.
     *
     *         Behaviour identical to {claimAsLender} when the loan is
     *         Repaid / Defaulted (retryCalls ignored). For a
     *         `FallbackPending` loan the library iterates the try-list,
     *         commits on first success, and rewrites the lender +
     *         borrower claims to principal-asset proceeds. Total
     *         failure leaves the recorded collateral split intact and
     *         transitions the loan terminally to Defaulted.
     * @param loanId      Resolved loan id.
     * @param retryCalls  Caller-ranked AdapterCall[] for the retry swap.
     *                    Empty array is equivalent to the no-retry
     *                    variant.
     */
    function claimAsLenderWithRetry(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata retryCalls
    ) external nonReentrant whenNotPaused {
        // Forward calldata-typed array as memory through the impl by
        // copying. The length is bounded (~4 entries in practice) so
        // the copy cost is negligible.
        uint256 n = retryCalls.length;
        LibSwap.AdapterCall[] memory copied = new LibSwap.AdapterCall[](n);
        for (uint256 i = 0; i < n; ++i) {
            copied[i] = LibSwap.AdapterCall({
                adapterIdx: retryCalls[i].adapterIdx,
                data: retryCalls[i].data
            });
        }
        _claimAsLenderImpl(loanId, copied);
    }

    // ─── #399 backstop v0 Role B — liquidator-of-last-resort ──────────────────

    /**
     * @notice Lender opt-in to the Role-B cash exit on a FallbackPending loan.
     * @dev Only the CURRENT lender-position NFT owner may authorize (or revoke)
     *      the backstop cash buyout — this opt-in is the lender's
     *      state-terminating choice, so the borrower cure window
     *      (`addCollateral`/`repayLoan`) stays open until the keeper actually
     *      executes. The flag is re-checked at execution, so a later borrower
     *      cure (loan leaves FallbackPending) harmlessly voids it. Setting
     *      `optIn = true` requires the absorbable shape now; revoking
     *      (`false`) is always allowed. See BackstopVaultV0Design.md §5.
     */
    function setLenderBackstopOptIn(uint256 loanId, bool optIn)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibAuth.requireLenderNftOwner(loan);
        // Tier-1 sanctions: the opt-in authorizes a future fund flow to this owner.
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (optIn) {
            // Absorbable shape: FallbackPending + live snapshot + NOT topped-up
            // (a top-up routes the normal claim, see {claimAsLenderViaBackstop}).
            if (
                loan.status != LibVaipakam.LoanStatus.FallbackPending ||
                !s.fallbackSnapshot[loanId].active ||
                LibVaipakam.hasActiveFallbackTopUp(loanId)
            ) revert NotBackstopAbsorbable();
        }
        // Store the AUTHORIZING owner (not a bare bool): the keeper buyout requires
        // the authorizer to still be the current NFT owner, so a transfer voids it.
        s.lenderBackstopOptIn[loanId] = optIn ? msg.sender : address(0);
        emit LenderBackstopOptInSet(loanId, msg.sender, optIn);
    }

    /**
     * @notice Role B — keeper-executed cash buyout of a FallbackPending loan's
     *         lender slice. The current lender-NFT owner is paid
     *         `lenderPrincipalDue` in cash from the backstop's absorb bucket and
     *         the backstop warehouses `lenderCollateral`; treasury + borrower
     *         slices route exactly as the normal fallback distribution.
     * @dev `KEEPER_ROLE`-gated (the protocol's designated keeper, the same actor
     *      that drives liquidations) so the objective swap retry isn't
     *      caller-gameable — a lender can't force a buyout by passing a
     *      deliberately-reverting `retryCalls`. Lender authorizes via
     *      {setLenderBackstopOptIn}; the par-guard is the real safety (the
     *      backstop acquires collateral worth >= the cash it pays).
     *      Resolution-first: the calldata-free internal-match auto-dispatch + the
     *      keeper's best-effort retry run first — if either clears the loan, no
     *      backstop capital is spent and the lender claims the principal proceeds
     *      through the normal path. Topped-up loans are excluded (normal claim).
     */
    function claimAsLenderViaBackstop(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata retryCalls
    ) external nonReentrant whenNotPaused onlyRole(LibAccessControl.KEEPER_ROLE) {
        uint256 n = retryCalls.length;
        LibSwap.AdapterCall[] memory copied = new LibSwap.AdapterCall[](n);
        for (uint256 i = 0; i < n; ++i) {
            copied[i] = LibSwap.AdapterCall({
                adapterIdx: retryCalls[i].adapterIdx,
                data: retryCalls[i].data
            });
        }
        _claimViaBackstopImpl(loanId, copied);
    }

    function _claimViaBackstopImpl(
        uint256 loanId,
        LibSwap.AdapterCall[] memory retryCalls
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Role-B gates: master pause + the independent absorb switch.
        if (
            !LibVaipakam.cfgBackstopEnabled() ||
            !LibVaipakam.cfgBackstopAbsorbEnabled()
        ) revert BackstopAbsorbDisabled();
        // #633 — global keeper pause also freezes this KEEPER_ROLE-driven path.
        if (LibVaipakam.cfgKeepersPaused()) revert KeepersPaused();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopVaultUnset();

        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];
        // The cash recipient is the CURRENT lender-NFT owner (the keeper is just
        // the executor). The opt-in must have been set by THIS owner — a transfer
        // after opt-in voids it (the stored authorizer no longer matches).
        address nftOwner = IERC721(address(this)).ownerOf(loan.lenderTokenId);
        if (
            loan.status != LibVaipakam.LoanStatus.FallbackPending ||
            !snap.active ||
            s.lenderBackstopOptIn[loanId] != nftOwner ||
            LibVaipakam.hasActiveFallbackTopUp(loanId)
        ) revert NotBackstopAbsorbable();

        // The absorb pays cash in the loan's principal asset. If `vpfiToken` was
        // rotated onto it after the bucket was seeded, refuse — VPFI's
        // discount/staking accounting must not be bypassed by a generic payout
        // (mirrors the seed-time guard; Role A's matchIntent re-checks similarly).
        if (loan.principalAsset == s.vpfiToken) {
            revert BackstopVpfiPrincipalUnsupported();
        }

        // Sanctions: the executing keeper AND the cash recipient (current NFT owner).
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam._assertNotSanctioned(nftOwner);

        // ── Resolution-first. The internal-match auto-dispatch is calldata-free
        //    and objective; it always runs. A FULL match clears `snap.active`
        //    (loan → InternalMatched, lender paid in principal + recorded as a
        //    claim) — no backstop spend, lender claims normally.
        RiskMatchLiquidationFacet(address(this))
            .attemptInternalMatchAutoDispatch(loanId, msg.sender);
        if (!snap.active) return;

        // The keeper's best-effort retry swap. Success → distribute principal
        // proceeds + go terminal; lender claims normally (no backstop spend).
        if (retryCalls.length > 0 && !snap.retryAttempted) {
            snap.retryAttempted = true;
            (bool ok, uint256 proceeds) = _attemptRetrySwap(loanId, loan, retryCalls);
            emit ClaimRetryExecuted(loanId, ok, proceeds);
            if (ok) {
                _distributeRetryProceeds(loanId, loan, snap, proceeds);
                snap.active = false;
                LibLifecycle.transition(
                    loan,
                    LibVaipakam.LoanStatus.FallbackPending,
                    LibVaipakam.LoanStatus.Defaulted
                );
                // Terminal default hooks — same as the absorb branch: the retry
                // swap is an HF-liquidation outcome (collateral sold to cover the
                // lender), so the borrower forfeits any LIF VPFI and interaction
                // rewards close. The deferred fallback entry never ran them; no
                // double-run (this returns; the absorb branch isn't reached).
                LibVPFIDiscount.forfeitBorrowerLif(loan);
                LibInteractionRewards.closeLoan(loanId, false, false);
                // Emit a terminal signal: no claim/absorb event fires in this
                // keeper tx, so without this the indexer would leave the loan
                // stuck pre-terminal until the lender later claims.
                emit LoanDefaulted(
                    loanId, loan.riskAndTermsConsentFromBoth, loan.status
                );
                return;
            }
        }

        // A PARTIAL internal-match rescue can scale the snapshot's lender slice to
        // zero (proceeds recorded in `heldForLender`) while leaving the loan
        // FallbackPending with `snap.active` still true. There is nothing for the
        // backstop to buy — return WITHOUT spending absorb cash (reverting here
        // would roll back that objective rescue); the lender finalizes via the
        // normal claim, which pays the `heldForLender`.
        if (snap.lenderCollateral == 0) return;

        // Require an OBJECTIVE retry to have actually been attempted (this call or
        // a prior `claimAsLenderWithRetry`) before any backstop cash is spent — the
        // advertised resolution-first swap must run, not be skipped by passing an
        // empty `retryCalls`. The calldata-free internal-match auto-dispatch above
        // always runs regardless; this gate adds the swap leg.
        if (!snap.retryAttempted) revert BackstopRetryRequired();

        // ── Resolution failed → the backstop buys the lender slice for cash.
        _absorbLenderSlice(loanId, loan, snap, vault, nftOwner);
    }

    /// @dev The backstop-specific failure branch (§5). Routes treasury + borrower
    ///      slices EXACTLY as the vanilla fallback distribution; diverts ONLY the
    ///      lender slice to the backstop vault; pays the lender cash from the
    ///      absorb bucket; marks the lender claim cash-satisfied; goes terminal.
    function _absorbLenderSlice(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibVaipakam.FallbackSnapshot storage snap,
        address vault,
        address nftOwner
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address p = loan.principalAsset;
        address c = loan.collateralAsset;
        uint256 due = snap.lenderPrincipalDue;

        // #638 — Role B warehouses this collateral with TREASURY cash. Enforce
        // the governance-set minimum live-secondary-oracle coverage before the
        // treasury takes single-feed-priced collateral onto its books. No-op
        // when the knob is 0 (default). Backstop-scoped — the general
        // permissionless close-out path (`claimAsLender` proper) never calls it.
        LibBackstopOracleGate.assertCoverage(c);

        // Par-guard — compare the lender slice's oracle VALUE directly (not the
        // rounded-down required-collateral, which could accept a low-decimal slice
        // up to one base unit of value below par). `sliceValue == 0` ⇒ oracle
        // unavailable ⇒ refuse. Tolerate only 1 PRINCIPAL wei (sub-economic) for
        // the snapshot's integer-division rounding, so a solvent absorb isn't
        // spuriously rejected while an underwater slice still reverts.
        uint256 sliceValue = LibFallback.principalEquivalent(
            address(this), snap.lenderCollateral, c, p
        );
        if (sliceValue == 0 || sliceValue + 1 < due) {
            revert BackstopUndercollateralized();
        }

        // Absorb-cash + cap accounting. The exposure counter tracks cash spent on
        // collateral NOT yet resold; released only on realized-cash sale (§5.1).
        if (s.backstopAbsorbCash[p][c] < due) {
            revert BackstopAbsorbInsufficientCash();
        }
        if (s.backstopAbsorbExposure[p][c] + due > s.backstopAbsorbCap[p][c]) {
            revert BackstopAbsorbCapExceeded();
        }
        s.backstopAbsorbCash[p][c] -= due;
        s.backstopAbsorbExposure[p][c] += due;

        // ── Distribute the Diamond-held collateral. Treasury + borrower slices
        //    route exactly as {_distributeFallbackCollateral}; ONLY the lender
        //    slice is diverted to the backstop vault (warehoused for resale).
        if (snap.treasuryCollateral > 0) {
            IERC20(c).safeTransfer(s.treasury, snap.treasuryCollateral);
            LibFacet.recordTreasuryAccrual(c, snap.treasuryCollateral);
        }
        if (snap.borrowerCollateral > 0) {
            address borrowerVault = LibFacet.getOrCreateVault(loan.borrower);
            IERC20(c).safeTransfer(borrowerVault, snap.borrowerCollateral);
            LibVaipakam.recordVaultDeposit(loan.borrower, c, snap.borrowerCollateral);
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.incrementCollateralLien.selector,
                    loanId,
                    snap.borrowerCollateral
                ),
                bytes4(0)
            );
        }
        uint256 absorbed = snap.lenderCollateral;
        if (absorbed > 0) {
            address bsVault = LibFacet.getOrCreateVault(vault);
            IERC20(c).safeTransfer(bsVault, absorbed);
            LibVaipakam.recordVaultDeposit(vault, c, absorbed);
            // Track the warehoused collateral so `sweepBackstopAbsorbCollateral`
            // can never reach seeded absorb CASH sharing the same vault/token.
            s.backstopWarehousedCollateral[c] += absorbed;
        }
        snap.active = false;
        // The lender claim is cash-satisfied here (not paid via the record).
        s.lenderClaims[loanId].claimed = true;

        // Release the originating intent's exposure + any VPFI reservation, like
        // the normal claim — the lender's principal returns to their control.
        if (s.intentOrigin[loanId].owner != address(0)) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    LenderIntentFacet.releaseIntentExposure.selector,
                    loanId
                ),
                bytes4(0)
            );
        }
        LibEncumbrance.releaseLenderProceeds(loanId, loan.lender);

        // Pay the lender (current NFT owner) CASH = lenderPrincipalDue from the
        // backstop vault's absorb-cash balance.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                vault,
                p,
                nftOwner,
                due
            ),
            VaultWithdrawFailed.selector
        );

        // Release any heldForLender (prior partial-rescue proceeds) from the
        // lender's OWN vault reservation to the NFT owner — its existing balance,
        // NOT re-paid from the absorb bucket (§5). FallbackPending ⇒ ERC20 loan.
        uint256 held = s.heldForLender[loanId];
        if (held > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.lender,
                    p,
                    nftOwner,
                    held
                ),
                VaultWithdrawFailed.selector
            );
        }

        s.lenderBackstopOptIn[loanId] = address(0);

        // Burn the lender NFT + go terminal (mirrors the vanilla claim tail).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanClosed
            ),
            NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                loan.lenderTokenId
            ),
            NFTBurnFailed.selector
        );
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.FallbackPending,
            LibVaipakam.LoanStatus.Defaulted
        );

        // Terminal hooks the direct default/liquidation paths run (DefaultedFacet /
        // RiskFacet) but the deferred FallbackPending entry did NOT: forfeit any
        // up-front borrower LIF VPFI to treasury (a default is not a proper close)
        // and close interaction-reward accounting (borrower forfeits, lender keeps).
        // Both are no-ops when there's nothing held/open; the full-internal-match
        // path returns earlier (these don't double-run). Per the CLAUDE.md invariant
        // that every default terminal MUST forfeitBorrowerLif.
        LibVPFIDiscount.forfeitBorrowerLif(loan);
        LibInteractionRewards.closeLoan(loanId, false, false);

        // #569 borrower-lien fold (same as the vanilla Defaulted path): record the
        // re-liened borrower residual as the borrower claim so the verified
        // borrower-NFT owner can withdraw + release it atomically.
        {
            LibVaipakam.ClaimInfo storage bClaim = s.borrowerClaims[loanId];
            LibVaipakam.Encumbrance storage lienRow = s.loanCollateralLien[loanId];
            uint256 owedCollateral = lienRow.released ? 0 : lienRow.amount;
            if (
                owedCollateral > 0 &&
                (bClaim.amount == 0 || bClaim.asset == c)
            ) {
                bClaim.asset = c;
                bClaim.amount = owedCollateral;
                bClaim.assetType = LibVaipakam.AssetType.ERC20;
                bClaim.tokenId = 0;
                bClaim.quantity = 0;
                bClaim.claimed = false;
            }
        }

        emit BackstopAbsorbedLoan(loanId, nftOwner, due, absorbed);

        // Settle if the borrower side is already done / has nothing.
        LibVaipakam.ClaimInfo storage borrowerClaim = s.borrowerClaims[loanId];
        bool borrowerHasNothing = borrowerClaim.amount == 0 &&
            borrowerClaim.assetType == LibVaipakam.AssetType.ERC20 &&
            s.borrowerLifRebate[loanId].rebateAmount == 0;
        if (borrowerClaim.claimed || borrowerHasNothing) {
            LibLifecycle.transition(
                loan,
                LibVaipakam.LoanStatus.Defaulted,
                LibVaipakam.LoanStatus.Settled
            );
            emit LoanSettled(loanId);
        }
    }

    function _claimAsLenderImpl(
        uint256 loanId,
        LibSwap.AdapterCall[] memory retryCalls
    ) internal {
        // Tier-1 sanctions gate. Funds flow OUT to msg.sender on
        // claim — bright-line OFAC violation if the recipient is
        // sanctioned. See `LibVaipakam.isSanctionedAddress` policy
        // block for the full Tier-1/Tier-2 split. No-op when the
        // oracle is unset.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // Loan must be resolved (Repaid, Defaulted, FallbackPending awaiting
        // the lender's one-shot retry, or InternalMatched). Active or already
        // Settled is rejected.
        // #585 — InternalMatched is now a claimable terminal for the lender:
        // an internal match records the matched proceeds as a lender claim
        // (RiskMatchLiquidationFacet._settleFallbackOrTransitionPostMatch),
        // which the current lender-position holder withdraws here. The
        // FallbackPending-only block below is skipped for InternalMatched
        // (no claim-time retry/auto-dispatch), so this falls straight through
        // to the standard claim-record payout.
        if (
            loan.status != LibVaipakam.LoanStatus.Repaid &&
            loan.status != LibVaipakam.LoanStatus.Defaulted &&
            loan.status != LibVaipakam.LoanStatus.FallbackPending &&
            loan.status != LibVaipakam.LoanStatus.InternalMatched
        ) revert InvalidLoanStatus();

        // Already-claimed guard FIRST. A successful claim burns the
        // lender position NFT, so on a double-claim attempt
        // `requireLenderNftOwner` below would revert
        // `ERC721NonexistentToken` on the burned token — this guard
        // must run before it so the caller sees the precise
        // `AlreadyClaimed()` error. (`claim` is a storage pointer; a
        // claim-time full match REWRITES the record with the matched
        // proceeds (#585) — the pointer reflects that fresh value when
        // the payout reads it below.)
        LibVaipakam.ClaimInfo storage claim = s.lenderClaims[loanId];
        if (claim.claimed) revert AlreadyClaimed();

        // EC-007 — verify lender position-NFT ownership BEFORE the
        // claim-time fallback resolution. `_resolveFallbackIfActive`
        // runs the internal-match auto-dispatch, which pays the 1%
        // matcher bonus to `msg.sender`. Gating ownership here keeps
        // `claimAsLender` / `claimAsLenderWithRetry` lender-owner-only,
        // so a third party cannot call the claim entry point purely to
        // trigger the match and skim the matcher incentive. (Without
        // this, the `fullyResolved` early-return path below would
        // bypass the post-resolution ownership check entirely.)
        LibAuth.requireLenderNftOwner(loan);

        // README §7 lines 147–151: if this loan fell back to the claim-time
        // settlement path, attempt one more liquidation before paying the
        // lender. Success rewrites claims to principal-asset amounts; failure
        // leaves them as the collateral split recorded by the fallback. Once
        // resolved, the loan is terminally Defaulted (no further cure).
        if (loan.status == LibVaipakam.LoanStatus.FallbackPending) {
            // #585 — the return value (fully-resolved) is intentionally
            // discarded. A full claim-time internal match now RECORDS the
            // matched proceeds as a lender claim (it no longer deletes the
            // record), so we always fall through to the standard payout
            // below, which pays `msg.sender` (the verified NFT owner /
            // matcher), burns the lender NFT, and settles. The old early
            // `return` existed only to dodge a `NothingToClaim()` revert on
            // the then-deleted record — no longer a risk. The status-gated
            // blocks below (FallbackPending → Defaulted force, Defaulted
            // lien-fold) naturally no-op once the loan is `InternalMatched`.
            _resolveFallbackIfActive(loanId, loan, retryCalls);
            // EC-003 Phase 3 — the auto-dispatch inside
            // `_resolveFallbackIfActive` may have transitioned the
            // loan to `InternalMatched` (on a full match). Only force
            // the FallbackPending → Defaulted terminal when the loan
            // is STILL FallbackPending (i.e., auto-dispatch didn't
            // fire, OR partial-match left a residual). The Defaulted
            // transition's allow-list edge from FallbackPending stays
            // unchanged.
            if (loan.status == LibVaipakam.LoanStatus.FallbackPending) {
                LibLifecycle.transition(
                    loan,
                    LibVaipakam.LoanStatus.FallbackPending,
                    LibVaipakam.LoanStatus.Defaulted
                );
            }
            // #569 Gap C (round-6 P1 + round-9 P1) — fold the borrower's
            // vault collateral lien into the borrower claim. The lien
            // tracks EXACTLY the collateral sitting in loan.borrower's vault
            // owed to the borrower-position holder: the fallback snapshot
            // residual (re-liened in `_distributeFallbackCollateral`, Gap A)
            // PLUS any FallbackPending top-up (folded into loan.collateralAmount
            // and liened, round-4). Recording that TOTAL as the borrower
            // claim (and KEEPING the lien) lets the verified-NFT-owner
            // `claimAsBorrower` withdraw it + release atomically (with the
            // burn backstop as the structural guarantee). A bare release
            // would free it to the stored `loan.borrower`, who may have
            // transferred the position away — the drain.
            //
            // round-9 P1 — gate on Defaulted, NOT FallbackPending. A
            // claim-time RETRY SUCCESS inside `_resolveFallbackIfActive`
            // drives the loan straight to Defaulted (leaving an
            // empty/claimed borrower row + a dangling top-up lien); the
            // old FallbackPending-only gate skipped this path, stranding
            // the top-up. The Defaulted gate covers both the no-cure
            // transition above AND the retry-success terminal.
            //
            // Guard: only fold when there is no conflicting DIFFERENT-asset
            // claim already present (a non-zero retry-swap principal
            // surplus — `_distributeRetryProceeds`). Overwriting that with
            // the collateral total was the round-6 clobber bug; in that
            // retry-surplus + top-up case the top-up is instead paid out
            // as a second asset by `claimAsBorrower` (round-8). round-7 P1:
            // read the amount ONLY from an ACTIVE lien — `releaseCollateralLien`
            // zeroes the aggregate + the per-loan amount on release, but a
            // never-reactivated released row must not be folded. ERC20-only.
            if (loan.status == LibVaipakam.LoanStatus.Defaulted) {
                LibVaipakam.ClaimInfo storage bClaim = s.borrowerClaims[loanId];
                LibVaipakam.Encumbrance storage lienRow = s.loanCollateralLien[loanId];
                uint256 owedCollateral = lienRow.released ? 0 : lienRow.amount;
                if (
                    owedCollateral > 0 &&
                    (bClaim.amount == 0 || bClaim.asset == loan.collateralAsset)
                ) {
                    bClaim.asset = loan.collateralAsset;
                    bClaim.amount = owedCollateral;
                    bClaim.assetType = LibVaipakam.AssetType.ERC20;
                    bClaim.tokenId = 0;
                    bClaim.quantity = 0;
                    bClaim.claimed = false;
                }
            }
        }

        // Claimable if there's a recorded amount, or heldForLender funds, or an NFT rental to return,
        // or an NFT collateral claim (for ERC-20 loans defaulting into NFT collateral).
        // `claim` + the already-claimed guard were resolved at the top
        // of this function; re-read nothing here.
        bool hasHeld = s.heldForLender[loanId] > 0;
        bool hasRentalNft = loan.assetType != LibVaipakam.AssetType.ERC20;
        bool hasNftCollateralClaim = claim.assetType != LibVaipakam.AssetType.ERC20;
        if (claim.amount == 0 && !hasHeld && !hasRentalNft && !hasNftCollateralClaim) revert NothingToClaim();

        // Lender position-NFT ownership was already verified at the top
        // of this function (before the claim-time fallback resolution).

        // Mark claimed before transfer to prevent re-entrancy
        claim.claimed = true;

        // #393 v1-b — if this loan was opened via `matchIntent`, release the
        // originating lender intent's live-principal cap: the principal is now
        // returning to the lender's control, so it frees up. Routed to
        // LenderIntentFacet (the heavy triple-mapping decrement sits behind one
        // cross-facet boundary, not inlined into every transition facet — RiskFacet
        // is at the EIP-170 edge). Keyed off the per-loan ORIGINATING intent, so a
        // sold lender position still releases the original owner's counter. Gated
        // on the cheap per-loan origin check so a non-intent loan skips the hop
        // entirely (no wasted gas, no LenderIntentFacet-routing dependency).
        if (s.intentOrigin[loanId].owner != address(0)) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    LenderIntentFacet.releaseIntentExposure.selector, loanId
                ),
                bytes4(0)
            );
        }

        // #585/#592 — release any VPFI lender-proceeds reservation BEFORE the
        // withdraw, so the vault-withdraw guard sees the proceeds as free
        // (the reservation exists precisely to block the stored lender's
        // unstake front-run until this gated claim runs). No-op for every
        // loan that never reserved (non-VPFI, or paths not yet wired) —
        // keyed off `s.lenderProceedsEncumbered[loanId]`.
        //
        // #592 (LenderProceedsReservationV2 §4.1) — the reservation records the
        // asset it was ticked under (the asset actually deposited into the
        // lender vault: `principalAsset` for cash closes, `collateralAsset` for
        // an in-kind/illiquid default — VPFI is collateral-eligible).
        // `releaseLenderProceeds` releases under that RECORDED asset, so the
        // caller passes no asset: the decrement always hits the same aggregate
        // the reserve ticked, even when the claim record's asset differs.
        LibEncumbrance.releaseLenderProceeds(loanId, loan.lender);

        // Transfer claimable assets from lender's vault to claimant (if any)
        if (claim.assetType == LibVaipakam.AssetType.ERC20) {
            if (claim.amount > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        loan.lender,
                        claim.asset,
                        msg.sender,
                        claim.amount
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        } else if (claim.assetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    loan.lender,
                    claim.asset,
                    claim.tokenId,
                    msg.sender
                ),
                NFTTransferFailed.selector
            );
        } else if (claim.assetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    loan.lender,
                    claim.asset,
                    claim.tokenId,
                    claim.quantity,
                    msg.sender
                ),
                NFTTransferFailed.selector
            );
        }

        // If heldForLender funds exist from prior preclose top-ups, withdraw those too.
        // These are in the payment asset (principalAsset for ERC20, prepayAsset for NFT).
        uint256 held = s.heldForLender[loanId];
        if (held > 0) {
            address payAsset = loan.assetType == LibVaipakam.AssetType.ERC20
                ? loan.principalAsset
                : loan.prepayAsset;
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.lender,
                    payAsset,
                    msg.sender,
                    held
                ),
                VaultWithdrawFailed.selector
            );
        }

        // For NFT rentals: return the vaulted rental NFT to the lender
        if (loan.assetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    msg.sender
                ),
                VaultTransferFailed.selector
            );
        } else if (loan.assetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    loan.quantity,
                    msg.sender
                ),
                VaultTransferFailed.selector
            );
        }

        // Update lender's NFT to "Loan Closed" before burning (per README)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanClosed
            ),
            NFTStatusUpdateFailed.selector
        );

        // Burn the lender's NFT
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector, loan.lenderTokenId),
            NFTBurnFailed.selector
        );

        // If borrower already claimed or has nothing to claim, settle the loan.
        // Phase 5: a pending borrower LIF rebate counts as "something to
        // claim" so the loan stays in Repaid/Defaulted until the borrower
        // also runs their claim — this preserves the NFT-owner gating on
        // the rebate payout inside `claimAsBorrower`.
        LibVaipakam.ClaimInfo storage borrowerClaim = s.borrowerClaims[loanId];
        bool borrowerHasNothing = borrowerClaim.amount == 0 &&
            borrowerClaim.assetType == LibVaipakam.AssetType.ERC20 &&
            s.borrowerLifRebate[loanId].rebateAmount == 0;
        bool willSettle = borrowerClaim.claimed || borrowerHasNothing;

        emit LenderFundsClaimed(
            loanId,
            msg.sender,
            claim.asset,
            claim.amount,
            // §3.11 — newBothClaimed signals "loan is about to settle and
            // NFTs are about to burn" rather than the literal "borrower
            // flag flipped". When the borrower has nothing to claim
            // (illiquid default, NFT rental terminal, etc.) the
            // borrowerClaim.claimed flag stays false but the loan still
            // settles immediately on the lender claim.
            willSettle
        );

        if (willSettle) {
            // #585 P2 (Codex round-2) — a ZERO-residual internal match leaves
            // the borrower with no claim row, so the borrower would never run
            // `claimAsBorrower` (it reverts `NothingToClaim` before settle,
            // `InvalidLoanStatus` after), leaving a transferable borrower
            // position NFT pointing at a Settled loan. Burn it here as part of
            // the lender-driven settle. Gated on `borrowerHasNothing` (so a
            // borrower who DID claim — over-collateralized residual — already
            // burned their own NFT) and on the InternalMatched terminal (other
            // "borrower has nothing" terminals keep their existing behaviour).
            if (
                borrowerHasNothing &&
                loan.status == LibVaipakam.LoanStatus.InternalMatched
            ) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaipakamNFTFacet.burnNFT.selector,
                        loan.borrowerTokenId
                    ),
                    NFTBurnFailed.selector
                );
            }
            LibLifecycle.transitionFromAny(loan, LibVaipakam.LoanStatus.Settled);
            emit LoanSettled(loanId);
        }
    }

    /**
     * @notice Allows the borrower to claim their collateral (or rental refund) after a loan is resolved.
     * @dev Caller must own the borrower's Vaipakam position NFT (proven via ERC721.ownerOf).
     *      Transfers the recorded claimable amount from the borrower's vault to the caller.
     *      Burns the borrower's NFT after a successful claim.
     *      If the lender has already claimed (or has nothing to claim), sets loan to Settled.
     *      Reverts if loan is Active, Settled, already claimed, or nothing to claim (e.g., on default).
     *      Emits BorrowerFundsClaimed and optionally LoanSettled.
     * @param loanId The ID of the resolved loan.
     */
    function claimAsBorrower(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate. Same reasoning as claimAsLender —
        // funds flow OUT to msg.sender; sanctioned recipient blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // Borrower can only claim after the loan is terminally Repaid,
        // Defaulted, or InternalMatched. FallbackPending is explicitly
        // blocked: during that window the borrower can still cure via
        // addCollateral/repayLoan, so handing them the collateral split
        // would short-circuit the cure policy.
        // #577 — InternalMatched is a terminal close: an over-collateralized
        // full internal match leaves a residual liened in loan.borrower's
        // vault with a borrowerClaims row owed to the current borrower-NFT
        // holder. Accept it here so the holder can retrieve the residual
        // (the lien is released atomically below, the same anti-drain
        // release-at-claim flow proper closes use).
        if (
            loan.status != LibVaipakam.LoanStatus.Repaid &&
            loan.status != LibVaipakam.LoanStatus.Defaulted &&
            loan.status != LibVaipakam.LoanStatus.InternalMatched
        ) revert InvalidLoanStatus();

        LibVaipakam.ClaimInfo storage claim = s.borrowerClaims[loanId];
        if (claim.claimed) revert AlreadyClaimed();
        // NFT collateral claims have amount=0 but tokenId/quantity as payload.
        // Phase 5 / §5.2b adds a second claimable lane: any pending VPFI
        // rebate credited at proper settlement (borrowerLifRebate). Loans
        // that paid LIF in the lending asset, or defaulted/liquidated,
        // have rebateAmount == 0 and no-op that branch below.
        bool hasNftClaim = claim.assetType != LibVaipakam.AssetType.ERC20;
        uint256 lifRebate = s.borrowerLifRebate[loanId].rebateAmount;
        if (claim.amount == 0 && !hasNftClaim && lifRebate == 0) {
            revert NothingToClaim();
        }

        // Verify caller owns the borrower's Vaipakam position NFT
        LibAuth.requireBorrowerNftOwner(loan);

        // Mark claimed before transfer to prevent re-entrancy
        claim.claimed = true;

        // #569 round-8 P2 (#578) — capture a liened collateral amount that
        // the single `borrowerClaims` row CANNOT carry because it is paying
        // a DIFFERENT asset (the rare FallbackPending non-curing top-up +
        // lender-retry-success principal-surplus combination: the claim row
        // holds the principal surplus, but a collateral top-up is still
        // liened in `loan.borrower`'s vault). Without paying it out here it
        // would be released by the burn backstop and left for a
        // transferred-away stored borrower to drain. The lien is the source
        // of truth for owed collateral, so claimAsBorrower pays it out as a
        // SECOND asset below. Captured BEFORE the release zeroes it. ERC20-
        // only; skipped in the common case where the claim already IS the
        // liened collateral (`lr.asset == claim.asset`).
        LibVaipakam.Encumbrance storage lr = s.loanCollateralLien[loanId];
        address extraLienedAsset;
        uint256 extraLienedAmt;
        if (!lr.released && lr.amount > 0 && lr.asset != claim.asset) {
            extraLienedAsset = lr.asset;
            extraLienedAmt = lr.amount;
        }

        // #569 Codex #572 round-4 P2 — release the collateral lien
        // ATOMICALLY here, immediately before the claim withdrawal,
        // rather than at the proper-close terminal. Proper-close paths
        // (RepayFacet, PrecloseFacet direct, SwapToRepayFacet) leave the
        // borrower's collateral in `loan.borrower`'s vault as this claim
        // row; releasing the lien at the terminal would let the stored
        // borrower (when the borrower-position NFT has been transferred
        // to a different claimant) drain that collateral via
        // `withdrawVPFIFromVault` between the terminal and this claim.
        // Holding the lien until the claim closes the window: the
        // release + withdraw are one atomic step driven by the rightful
        // NFT-owner claimant, and the guard would otherwise block this
        // withdraw while the lien is live. Idempotent + ERC20-only
        // (D-1): a no-op on default/liquidation paths (already released)
        // and on NFT-collateral claims (never liened).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseCollateralLien.selector,
                loanId
            ),
            bytes4(0)
        );

        // #661 — release the VPFI borrower-surplus reservation (mirror of the
        // lender release above) immediately BEFORE the withdraw, so the unstake
        // free-balance guard sees the surplus as free. Keyed off the per-loan
        // record under the asset it was reserved with → a no-op for every loan
        // that never reserved a surplus (non-VPFI, or no liquid-default surplus).
        LibEncumbrance.releaseBorrowerProceeds(loanId, loan.borrower);

        // Transfer claimable collateral from borrower's vault to claimant
        if (claim.assetType == LibVaipakam.AssetType.ERC20) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.borrower,
                    claim.asset,
                    msg.sender,
                    claim.amount
                ),
                VaultWithdrawFailed.selector
            );
        } else if (claim.assetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    loan.borrower,
                    claim.asset,
                    claim.tokenId,
                    msg.sender
                ),
                VaultWithdrawFailed.selector
            );
        } else if (claim.assetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    loan.borrower,
                    claim.asset,
                    claim.tokenId,
                    claim.quantity,
                    msg.sender
                ),
                VaultWithdrawFailed.selector
            );
        }

        // #569 round-8 P2 (#578) — pay out the liened collateral the claim
        // row couldn't carry (captured above). The lien was released just
        // above, so the guard permits this withdraw; routing it to the
        // rightful NFT-owner claimant closes the transferred-position drain
        // where the burn backstop would otherwise free it to the stored
        // borrower. Common case: extraLienedAmt == 0 (claim IS the liened
        // collateral) → no-op.
        if (extraLienedAmt > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.borrower,
                    extraLienedAsset,
                    msg.sender,
                    extraLienedAmt
                ),
                VaultWithdrawFailed.selector
            );
        }

        // #658 PR-B (Codex #690 round-4 + round-6) — when VPFI has just left
        // `loan.borrower`'s vault via the withdraw(s) above, re-stamp so the
        // vault owner doesn't keep fee-tier / staking credit on VPFI that is no
        // longer vaulted (the claim-time half of the direct-preclose close-out;
        // also the same post-withdraw restamp the liquidation + refinance hosts
        // run). `loan.borrower` is the consolidated current holder on a
        // transferred position, or the stored borrower otherwise — either way it
        // is the vault the VPFI left.
        //
        // VPFI can leave via THREE forms here, so the collateral-keyed
        // `restampCollateralVpfiAfterWithdraw` is insufficient (it only fires
        // when the loan COLLATERAL is VPFI): (1) VPFI collateral, (2) a VPFI
        // principal-SURPLUS claim row whose collateral is some other token, and
        // (3) a still-liened VPFI top-up paid via `extraLienedAmt` while the
        // rewritten claim row is non-VPFI. Gate on the actually-withdrawn assets
        // and use the USER-keyed restamp so all three are covered; the common
        // non-VPFI claim never reaches ConsolidationFacet.
        // Guard on a configured VPFI token first: when `s.vpfiToken` is unset
        // (address(0)) a bare `extraLienedAsset == s.vpfiToken` would be
        // `0 == 0` for the common no-extra-lien case and fire a spurious
        // cross-call. There is no VPFI to restamp without a token anyway.
        if (
            s.vpfiToken != address(0) &&
            (claim.asset == s.vpfiToken || extraLienedAsset == s.vpfiToken)
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    ConsolidationFacet.restampUserVpfiInternal.selector,
                    loan.borrower
                ),
                bytes4(0)
            );
        }

        // Phase 5 / §5.2b — transfer any pending borrower LIF VPFI rebate.
        // The Diamond custody-holds the rebate slice between settlement
        // (settleBorrowerLifProper) and this claim; zero it out and
        // transfer to the claimant in one step.
        if (lifRebate > 0) {
            s.borrowerLifRebate[loanId].rebateAmount = 0;
            address vpfi = s.vpfiToken;
            if (vpfi != address(0)) {
                IERC20(vpfi).safeTransfer(msg.sender, lifRebate);
                emit BorrowerLifRebateClaimed(
                    loanId,
                    msg.sender,
                    lifRebate,
                    LibVPFIDiscount.vaultVpfiBalance(msg.sender)
                );
            }
        }

        // Update borrower's NFT to "Loan Closed" before burning (per README)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanClosed
            ),
            NFTStatusUpdateFailed.selector
        );

        // Burn the borrower's NFT
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector, loan.borrowerTokenId),
            NFTBurnFailed.selector
        );

        // If lender already claimed or truly has nothing to claim, settle the loan.
        // Must check heldForLender, NFT rental returns, and NFT collateral claims.
        // Note: the borrower LIF rebate is paid out in the same tx above, so
        // it doesn't gate the Settled transition — once the borrower's
        // claimAsBorrower has run, every borrower-side payout has cleared.
        LibVaipakam.ClaimInfo storage lenderClaim = s.lenderClaims[loanId];
        bool lenderHasHeld = s.heldForLender[loanId] > 0;
        bool lenderHasRentalNft = loan.assetType != LibVaipakam.AssetType.ERC20;
        bool lenderHasNftCollateralClaim = lenderClaim.assetType != LibVaipakam.AssetType.ERC20;
        bool lenderFullyClaimed = lenderClaim.claimed;
        bool lenderHasNothing = lenderClaim.amount == 0 && !lenderHasHeld && !lenderHasRentalNft && !lenderHasNftCollateralClaim;
        bool willSettle = lenderFullyClaimed || lenderHasNothing;
        // #585 — for an InternalMatched loan the lender side is now closed
        // through the standard lender claim path: the match records the
        // matched proceeds as a `lenderClaims` row owed to the current
        // lender-position holder (`claimAsLender` accepts InternalMatched).
        // So the natural settle predicate above composes correctly — a
        // borrower claim settles the loan only once the lender has claimed
        // (`lenderFullyClaimed`) or genuinely has nothing. The #577
        // unconditional `willSettle = false` override (which deferred the
        // close until this lender-side lifecycle existed) is therefore
        // removed: keeping it would now wrongly strand a fully-claimed loan
        // in InternalMatched.
        emit BorrowerFundsClaimed(
            loanId,
            msg.sender,
            claim.asset,
            claim.amount,
            // §3.11 — newBothClaimed signals "loan is about to settle"
            // (NFTs about to burn) — see LenderFundsClaimed for rationale.
            willSettle
        );

        if (willSettle) {
            LibLifecycle.transitionFromAny(loan, LibVaipakam.LoanStatus.Settled);
            emit LoanSettled(loanId);
        }
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    /// @dev Resolves a pending fallback snapshot at claim time. When
    ///      `retryCalls` is non-empty and no retry has yet been tried,
    ///      we run the swap one more time through the Phase-7a adapter
    ///      failover chain under the same 6% slippage gate used at
    ///      liquidation time. On success: collateral held in the
    ///      Diamond is converted to principal-asset proceeds and split
    ///      per README §7 (lender due first, then 2% treasury, surplus
    ///      to borrower); claims are rewritten accordingly. On failure
    ///      (empty try-list, all adapters reverted, or borrower claim
    ///      path): the pre-recorded collateral split is pushed from
    ///      the Diamond to lender/treasury/borrower vaults.
    /// @dev Returns `true` when a claim-time internal match FULLY resolved
    ///      the loan (transitioned it to `InternalMatched`). Returns `false`
    ///      for the partial-match, no-match, and retry-swap paths.
    ///      #585 — the caller now DISCARDS this value: a full match records
    ///      the matched proceeds as a lender claim (it no longer deletes the
    ///      record), so every path falls through to the standard claim-record
    ///      payout. The bool is retained only as a status signal for any
    ///      future caller; it no longer gates control flow in
    ///      `_claimAsLenderImpl`.
    function _resolveFallbackIfActive(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibSwap.AdapterCall[] memory retryCalls
    ) internal returns (bool fullyResolved) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];
        if (!snap.active) return false;

        // EC-003 Phase 3 / EC-007 — internal-match-first at claim time.
        // The candidate pool grows between keeper-tick and lender-claim
        // (fresh Active counterparties, freshly-failed FallbackPending
        // loans), so this is the safety net for keeper outages + the
        // race between keeper scan and lender claim.
        //
        // The auto-dispatch may:
        //   - FULLY match the loan → it transitions FallbackPending →
        //     InternalMatched, `snap.active` is cleared, the lender is
        //     paid in the principal asset by the match settlement, and
        //     (#585) the matched proceeds are RECORDED as a lender claim.
        //     We detect this below by re-reading `snap.active` and return
        //     `true`; the caller discards it and falls through to pay the
        //     just-recorded claim to the verified NFT owner.
        //   - PARTIALLY match the loan → it stays FallbackPending, the
        //     snapshot is scaled to the residual, `snap.active` STAYS
        //     true. We must NOT return — we fall through to the
        //     distribution path so the (scaled) residual is paid out.
        //   - not match at all → `snap.active` unchanged; same
        //     fall-through.
        //
        // EC-003 Phase 3 (#21) — `msg.sender` is threaded as the
        // explicit `matcher`. `_claimAsLenderImpl` has already verified
        // it owns the lender position NFT (EC-007 hoisted that check
        // ahead of this call), so the lender who triggers their own
        // claim-time rescue is the matcher and earns the 1% bonus.
        RiskMatchLiquidationFacet(address(this)).attemptInternalMatchAutoDispatch(loanId, msg.sender);
        // EC-007 — a full match consumed the snapshot and (#585) recorded
        // the matched proceeds as a lender claim. Report it as fully
        // resolved; the caller discards this and falls through to pay the
        // recorded claim. (Pre-#585 this returned early to dodge a
        // `NothingToClaim()` revert on the then-deleted record — no longer
        // a risk now that the record is written.)
        if (!snap.active) return true;

        bool retrySucceeded;
        uint256 proceeds;
        // #591 — a topped-up FallbackPending loan's collateral is split between
        // the borrower's vault (the AddCollateral top-up, liened) and Diamond
        // custody (the snapshot). `_attemptRetrySwap` now swaps ONLY the
        // Diamond-held portion (it derives `diamondPortion` from the lien), so
        // it never draws on same-token custody belonging to OTHER fallback
        // loans. The vault top-up stays liened, owed to the borrower, and is
        // resolved through the in-kind distribution. No top-up guard needed.
        if (
            retryCalls.length > 0 &&
            !snap.retryAttempted
        ) {
            snap.retryAttempted = true;
            (retrySucceeded, proceeds) = _attemptRetrySwap(loanId, loan, retryCalls);
            emit ClaimRetryExecuted(loanId, retrySucceeded, proceeds);
        }

        if (retrySucceeded) {
            _distributeRetryProceeds(loanId, loan, snap, proceeds);
        } else {
            _distributeFallbackCollateral(loanId, loan, snap);
        }
        snap.active = false;
        // Partial-match / no-match / retry-swap: the (scaled) residual is
        // now recorded in the lender claim records — the caller must run
        // the normal claim-record payout.
        return false;
    }

    /// @dev Phase 7a — runs the retry swap through {LibSwap.swapWithFailover}.
    ///      `retryCalls` is the lender / keeper-supplied ranked
    ///      try-list across registered adapters. Returns (false, 0) if
    ///      every adapter reverted or the try-list was empty (still
    ///      over the 6% slippage ceiling, thin liquidity, or any
    ///      technical failure).
    function _attemptRetrySwap(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibSwap.AdapterCall[] memory retryCalls
    ) internal returns (bool, uint256) {
        // #591 — swap ONLY the Diamond-held portion of the collateral. For a
        // topped-up FallbackPending loan, `loan.collateralAmount` includes the
        // AddCollateral top-up which sits in the borrower's vault (liened), NOT
        // in Diamond custody; swapping the whole `collateralAmount` from the
        // Diamond would draw on same-token custody belonging to OTHER fallback
        // loans. The snapshot `lenderPrincipalDue` / `treasuryPrincipalDue`
        // that `_distributeRetryProceeds` distributes against already describe
        // only the Diamond (snapshot) portion, and the vault top-up stays
        // liened — owed to the borrower — through the in-kind path. For a loan
        // with no top-up the lien amount is 0, so this equals
        // `loan.collateralAmount` (unchanged behaviour).
        uint256 diamondPortion = LibVaipakam.hasActiveFallbackTopUp(loanId)
            ? loan.collateralAmount - LibVaipakam.storageSlot().loanCollateralLien[loanId].amount
            : loan.collateralAmount;
        uint256 expected = _expectedSwapOutput(
            loan.collateralAsset,
            loan.principalAsset,
            diamondPortion
        );
        uint256 minOut = (expected *
            (LibVaipakam.BASIS_POINTS -
                LibVaipakam.cfgMaxLiquidationSlippageBps())) /
            LibVaipakam.BASIS_POINTS;

        // LibSwap takes calldata; we have memory here. Solidity
        // doesn't auto-convert memory→calldata for library internal
        // calls, so swap to an inline assembly trick OR call a small
        // wrapper that takes calldata. Cleanest: declare a tiny
        // external `_libSwapWrapper(...)` selector via address(this).
        // Skipping that complexity by inlining the iteration here —
        // mirrors LibSwap.swapWithFailover with a memory try-list.
        return _swapWithFailoverMem(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            diamondPortion,
            minOut,
            address(this),
            retryCalls
        );
    }

    /// @dev Memory-array variant of {LibSwap.swapWithFailover}.
    ///      Identical semantics + invariants — only the try-list is
    ///      `memory` (came from the storage-copied retry list above)
    ///      instead of `calldata`. Kept local to ClaimFacet because
    ///      the only caller is {_attemptRetrySwap}; promoting it to
    ///      LibSwap would force every caller to overload their try-
    ///      list location.
    function _swapWithFailoverMem(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        LibSwap.AdapterCall[] memory calls
    ) internal returns (bool, uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 registered = s.swapAdapters.length;
        if (registered == 0) revert LibSwap.NoSwapAdaptersConfigured();
        uint256 n = calls.length;
        if (n == 0) return (false, 0);

        for (uint256 i = 0; i < n; ++i) {
            uint256 idx = calls[i].adapterIdx;
            if (idx >= registered) {
                revert LibSwap.AdapterIndexOutOfRange(idx, registered);
            }
            address adapter = s.swapAdapters[idx];
            // #633 — skip a governance-paused venue (mirrors LibSwap.swapWithFailover),
            // so the per-venue kill-switch also covers claim/backstop retry swaps.
            if (s.swapAdapterDisabled[adapter]) continue;
            SafeERC20.forceApprove(IERC20(inputToken), adapter, 0);
            SafeERC20.forceApprove(IERC20(inputToken), adapter, inputAmount);
            try
                ISwapAdapter(adapter).execute(
                    inputToken,
                    outputToken,
                    inputAmount,
                    minOutputAmount,
                    recipient,
                    calls[i].data
                )
            returns (uint256 out_) {
                SafeERC20.forceApprove(IERC20(inputToken), adapter, 0);
                emit LibSwap.SwapAdapterAttempted(loanId, idx, adapter, true);
                emit LibSwap.SwapAdapterSucceeded(loanId, idx, adapter, out_);
                return (true, out_);
            } catch {
                SafeERC20.forceApprove(IERC20(inputToken), adapter, 0);
                emit LibSwap.SwapAdapterAttempted(loanId, idx, adapter, false);
            }
        }
        emit LibSwap.SwapAllAdaptersFailed(loanId);
        return (false, 0);
    }

    /// @dev Distributes principal-asset proceeds from a successful retry
    ///      swap. Lender first (up to their `lenderPrincipalDue` = principal
    ///      + accrued + late fees + 3%), then treasury (2%), then borrower
    ///      surplus. Rewrites the lender and borrower claim records to the
    ///      principal asset so the normal withdrawal flow below works.
    function _distributeRetryProceeds(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibVaipakam.FallbackSnapshot storage snap,
        uint256 proceeds
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        uint256 lenderGets;
        uint256 treasuryGets;
        uint256 borrowerGets;
        if (proceeds <= snap.lenderPrincipalDue) {
            lenderGets = proceeds;
        } else {
            lenderGets = snap.lenderPrincipalDue;
            uint256 rem = proceeds - lenderGets;
            treasuryGets = snap.treasuryPrincipalDue <= rem
                ? snap.treasuryPrincipalDue
                : rem;
            borrowerGets = rem - treasuryGets;
        }

        if (treasuryGets > 0) {
            IERC20(loan.principalAsset).safeTransfer(s.treasury, treasuryGets);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, treasuryGets);
        }

        if (lenderGets > 0) {
            address lenderVault = LibFacet.getOrCreateVault(loan.lender);
            IERC20(loan.principalAsset).safeTransfer(lenderVault, lenderGets);
            // T-051 — Diamond-side transfer to vault ticks the
            // protocolTrackedVaultBalance counter so the eventual
            // claimAsLender's vaultWithdrawERC20 doesn't underflow.
            LibVaipakam.recordVaultDeposit(loan.lender, loan.principalAsset, lenderGets);
        }
        if (borrowerGets > 0) {
            address borrowerVault = LibFacet.getOrCreateVault(loan.borrower);
            IERC20(loan.principalAsset).safeTransfer(borrowerVault, borrowerGets);
            LibVaipakam.recordVaultDeposit(loan.borrower, loan.principalAsset, borrowerGets);
            // #661 (Codex #674 P1) — the FallbackPending retry is a FOURTH
            // borrower-VPFI-surplus terminal: reserve it against the unstake
            // path, like the default / liquidation surplus sites. Released in
            // `claimAsBorrower` (which runs `releaseBorrowerProceeds`). No-op for
            // non-VPFI. (The lender retry-proceeds reserve is the separate
            // pre-existing #592 gap noted on `lenderProceedsEncumbered`.)
            if (loan.principalAsset == s.vpfiToken) {
                LibEncumbrance.encumberBorrowerProceeds(
                    loanId, loan.borrower, loan.principalAsset, borrowerGets
                );
            }
        }

        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderGets,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: borrowerGets,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: borrowerGets == 0
        });
    }

    /// @dev Pushes the pre-recorded collateral split from the Diamond into
    ///      the lender vault / treasury / borrower vault. Used when the
    ///      retry swap failed or was skipped (borrower-first claim).
    function _distributeFallbackCollateral(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibVaipakam.FallbackSnapshot storage snap
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (snap.treasuryCollateral > 0) {
            IERC20(loan.collateralAsset).safeTransfer(
                s.treasury,
                snap.treasuryCollateral
            );
            LibFacet.recordTreasuryAccrual(loan.collateralAsset, snap.treasuryCollateral);
        }

        if (snap.lenderCollateral > 0) {
            address lenderVault = LibFacet.getOrCreateVault(loan.lender);
            IERC20(loan.collateralAsset).safeTransfer(lenderVault, snap.lenderCollateral);
            LibVaipakam.recordVaultDeposit(loan.lender, loan.collateralAsset, snap.lenderCollateral);
        }
        if (snap.borrowerCollateral > 0) {
            address borrowerVault = LibFacet.getOrCreateVault(loan.borrower);
            IERC20(loan.collateralAsset).safeTransfer(borrowerVault, snap.borrowerCollateral);
            LibVaipakam.recordVaultDeposit(loan.borrower, loan.collateralAsset, snap.borrowerCollateral);
            // #569 Gap A — RE-LIEN the borrower residual pushed BACK into
            // the vault here. The lien was released at liquidation/default
            // ENTRY (when the full collateral left to Diamond custody); the
            // borrower-residual claim row was recorded then too. This is the
            // custody RETURN leg — the residual now sits in loan.borrower's
            // vault owed to the borrower-position holder, so it must be
            // encumbered through the window until `claimAsBorrower` releases
            // it (and the burn backstop guarantees release). Without this,
            // a transferred-away stored borrower could drain the residual
            // (VPFI via withdrawVPFIFromVault) before the rightful holder
            // claims. ERC20-only (create-if-absent on the released row).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.incrementCollateralLien.selector,
                    loanId,
                    snap.borrowerCollateral
                ),
                bytes4(0)
            );
        }
        // Claim records were already written in the collateral asset at
        // fallback time; nothing to rewrite here. loanId retained for
        // symmetry with _distributeRetryProceeds and for future hooks.
        loanId;
    }

    /// @dev Oracle-derived expected swap output in principal-asset units.
    ///      Mirrors RiskFacet/DefaultedFacet so the retry path uses the
    ///      same 6% slippage semantics.
    function _expectedSwapOutput(
        address collateralAsset,
        address principalAsset,
        uint256 collateralAmount
    ) internal view returns (uint256) {
        (uint256 colPrice, uint8 colFeedDec) = OracleFacet(address(this))
            .getAssetPrice(collateralAsset);
        (uint256 prinPrice, uint8 prinFeedDec) = OracleFacet(address(this))
            .getAssetPrice(principalAsset);
        if (prinPrice == 0) return 0;
        uint8 colTokenDec = IERC20Metadata(collateralAsset).decimals();
        uint8 prinTokenDec = IERC20Metadata(principalAsset).decimals();
        return
            (collateralAmount * colPrice * (10 ** prinTokenDec) *
                (10 ** prinFeedDec)) /
            (prinPrice * (10 ** colTokenDec) * (10 ** colFeedDec));
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    /**
     * @notice Returns the claimable ERC-20 amount and claim status for a lender
     *         or borrower side of a loan.
     * @dev Returns (address(0), 0, false) if no claim has been recorded (e.g.
     *      loan still Active). For NFT-asset claims or held-for-lender funds
     *      use {getClaimable} — those cases carry `amount == 0` but are still
     *      claimable.
     * @param loanId The loan ID to query.
     * @param isLender True to query the lender side; false for the borrower side.
     * @return asset The ERC-20 token address claimable.
     * @return amount The claimable amount.
     * @return claimed Whether the funds have already been claimed.
     */
    function getClaimableAmount(
        uint256 loanId,
        bool isLender
    )
        external
        view
        returns (
            address asset,
            uint256 amount,
            bool claimed
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ClaimInfo storage claim = isLender
            ? s.lenderClaims[loanId]
            : s.borrowerClaims[loanId];
        return (claim.asset, claim.amount, claim.claimed);
    }

    /// @notice Phase 5 borrower LIF VPFI rebate state for a given loan.
    /// @dev `vpfiHeld` > 0 while the loan is live and took the VPFI fee
    ///      path at init; zero once settlement runs. `rebateAmount` > 0
    ///      after a proper settlement (repay / preclose / refinance-old-
    ///      loan) credited the borrower; zero after
    ///      `claimAsBorrower` paid it out, after a default/liquidation
    ///      forfeiture, or on loans that never took the VPFI path. A
    ///      loan is "rebate-actionable" iff `rebateAmount > 0`.
    /// @param loanId Loan to query.
    /// @return rebateAmount Claimable VPFI (18 dec) the borrower NFT owner
    ///                      receives on their next `claimAsBorrower`.
    /// @return vpfiHeld     VPFI currently held by the Diamond against this
    ///                      loan pending settlement. Zero after any
    ///                      terminal transition.
    function getBorrowerLifRebate(uint256 loanId)
        external
        view
        returns (uint256 rebateAmount, uint256 vpfiHeld)
    {
        LibVaipakam.BorrowerLifRebate storage r =
            LibVaipakam.storageSlot().borrowerLifRebate[loanId];
        return (r.rebateAmount, r.vpfiHeld);
    }

    /// @notice Full claim payload for the requested side of a loan — use
    ///         this over `getClaimableAmount` when the claim may be an
    ///         NFT (ERC-721/1155) or when held-for-lender funds exist, as
    ///         those cases carry `amount == 0` but are still claimable.
    /// @dev Treat the claim as actionable when:
    ///         `!claimed && (amount > 0 || assetType != ERC20 ||
    ///                      heldForLender > 0 || hasRentalNftReturn)`
    ///      — mirroring the guards in `claimAsLender` / `claimAsBorrower`.
    ///      Phase 5 adds the borrower LIF rebate; query
    ///      {getBorrowerLifRebate} for that lane.
    function getClaimable(
        uint256 loanId,
        bool isLender
    )
        external
        view
        returns (
            address asset,
            uint256 amount,
            bool claimed,
            LibVaipakam.AssetType assetType,
            uint256 tokenId,
            uint256 quantity,
            uint256 heldForLender,
            bool hasRentalNftReturn
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ClaimInfo storage claim = isLender
            ? s.lenderClaims[loanId]
            : s.borrowerClaims[loanId];
        asset = claim.asset;
        amount = claim.amount;
        claimed = claim.claimed;
        assetType = claim.assetType;
        tokenId = claim.tokenId;
        quantity = claim.quantity;
        if (isLender) {
            heldForLender = s.heldForLender[loanId];
            // NFT-asset loans (ERC-721/1155 lent out) entitle the lender to
            // reclaim the NFT at resolution even when no fungible amount
            // was recorded against the claim struct.
            hasRentalNftReturn =
                s.loans[loanId].assetType != LibVaipakam.AssetType.ERC20;
        }
    }

    /// @notice Returns the fallback-path settlement snapshot for a loan.
    /// @dev    Emitted alongside `LiquidationFallback` and persisted to
    ///         `s.fallbackSnapshot[loanId]` whenever a liquid-collateral
    ///         loan falls through to the claim-time settlement path
    ///         (DEX swap reverted or exceeded the 6% slippage ceiling).
    ///         Frontends use this to render the lender / treasury /
    ///         borrower three-way collateral split alongside the
    ///         principal-due figures, without parsing logs. While
    ///         `active == false`, the loan never entered the fallback
    ///         path — the other view return values are zero.
    /// @param loanId Loan to query.
    /// @return lenderCollateral     Collateral units routed to the lender if
    ///                              the claim-time retry fails (principal +
    ///                              interest + late fees + 3% bonus, capped
    ///                              at available collateral).
    /// @return treasuryCollateral   Collateral units routed to treasury
    ///                              (≈2% of principal, or zero if
    ///                              undercollateralized).
    /// @return borrowerCollateral   Remainder back to the borrower.
    /// @return lenderPrincipalDue   Principal-asset amount the lender is
    ///                              owed if the claim-time swap retry
    ///                              succeeds (drives the proceeds split).
    /// @return treasuryPrincipalDue Principal-asset amount routed to
    ///                              treasury when the retry succeeds.
    /// @return active               True iff this loan is in the fallback
    ///                              path (snapshot is meaningful).
    /// @return retryAttempted       True iff `ClaimFacet` already ran the
    ///                              one-shot claim-time retry against this
    ///                              snapshot.
    function getFallbackSnapshot(uint256 loanId)
        external
        view
        returns (
            uint256 lenderCollateral,
            uint256 treasuryCollateral,
            uint256 borrowerCollateral,
            uint256 lenderPrincipalDue,
            uint256 treasuryPrincipalDue,
            bool active,
            bool retryAttempted
        )
    {
        LibVaipakam.FallbackSnapshot storage snap =
            LibVaipakam.storageSlot().fallbackSnapshot[loanId];
        return (
            snap.lenderCollateral,
            snap.treasuryCollateral,
            snap.borrowerCollateral,
            snap.lenderPrincipalDue,
            snap.treasuryPrincipalDue,
            snap.active,
            snap.retryAttempted
        );
    }
}
