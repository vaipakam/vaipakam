// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {ITreasuryFeeHost} from "../interfaces/ITreasuryFeeHost.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {LibLoanCollateral} from "../libraries/LibLoanCollateral.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibTerms} from "../libraries/LibTerms.sol";
import {LibPriceRead} from "../libraries/LibPriceRead.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibStandingInstructions} from "../libraries/LibStandingInstructions.sol";
import {LibInterestPayment, IInterestPaymentHost} from "../libraries/LibInterestPayment.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {CollateralLienFacet} from "./CollateralLienFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {SettlementLegFacet} from "./SettlementLegFacet.sol";

/**
 * @title StandingInstructionFacet — standing instructions from your own vault (#3681).
 * @notice The holder of a loan's borrower position may place a LOAN RESERVE
 *         in their own vault and switch on up to three instructions, which
 *         anyone may then run:
 *
 *         1. Keep my loan healthy ({runCollateralTopUp}): below the holder's
 *            trigger health factor, move collateral from the collateral
 *            reserve into the loan's lien until the health factor is back at
 *            the holder's target (or the reserve is used up).
 *         2. Pay my interest ({runInterestPayment}): from a period's end, pay
 *            the period's unpaid interest from the payment reserve.
 *         3. Repay at the due date ({runDueRepayment}): from the holder's
 *            chosen time before the due date until grace ends, repay the
 *            loan in full from the payment reserve, all or nothing.
 *
 *         The reserve is the limit: an instruction spends only what its
 *         holder placed in that loan's reserve, and only on that loan. Every
 *         amount is fixed by the loan, the setting and the reserve; the
 *         caller chooses nothing and receives nothing, so no keeper
 *         permission guards these steps.
 *
 *         The reserve is two balances per loan and depositor, both in the
 *         depositor's own vault and encumbered there (`LibEncumbrance` is
 *         their one writer): the PAYMENT reserve in the lending asset (also
 *         drawn by an automatic extension's charge, #2814), and the
 *         COLLATERAL reserve in the collateral asset. The collateral reserve
 *         is not collateral: no liquidation or default takes it and the
 *         health factor does not count it until instruction 1 moves it into
 *         the lien. The reserve follows the DEPOSITOR, not the position: an
 *         instruction runs only while its owner still holds the position.
 *
 *         When an instruction cannot run for a reason its holder should hear
 *         about (the position moved, the reserve is empty or short, a
 *         competing close-out is live, the price is unavailable, the asset or
 *         platform is paused, the account is locked), the executor emits
 *         {StandingInstructionSkipped} and changes nothing. When it is simply
 *         not time yet (not set, not due, healthy, too soon after the last
 *         top-up, nothing owed), it reverts by name.
 *
 * @dev    Design: `docs/DesignsAndPlans/StandingInstructionsDesign.md`.
 *         Interest is booked through `LibInterestPayment`, hosted on
 *         `RepayPeriodicFacet.bookInterestPayment`, which the periodic forced
 *         sale also uses. The full repayment runs through
 *         `RepayFacet.repayLoan` (bound to the reserve), the ordinary repayment with the
 *         holder's payment reserve as the payer.
 */
contract StandingInstructionFacet is DiamondAccessControl, DiamondReentrancyGuard {
    // ─── Types ───────────────────────────────────────────────────────

    /// @notice The holder's settings, as {setStandingInstructions} takes them.
    /// @param topUpTriggerHf   1e18 health factor below which instruction 1
    ///                         runs; 0 switches it off.
    /// @param topUpTargetHf    1e18 health factor instruction 1 restores.
    /// @param payInterest      Instruction 2 on.
    /// @param repayAtDue       Instruction 3 on.
    /// @param repayLeadSeconds How long before the due date instruction 3 may
    ///                         run (0 = at the due date; at most one day).
    struct InstructionInput {
        uint64 topUpTriggerHf;
        uint64 topUpTargetHf;
        bool payInterest;
        bool repayAtDue;
        uint32 repayLeadSeconds;
    }

    /// @notice One loan's reserve and instructions as `holder` sees them.
    /// @param paymentAsset      The lending asset.
    /// @param paymentReserve    `holder`'s payment reserve for the loan.
    /// @param collateralAsset   The collateral asset.
    /// @param collateralReserve `holder`'s collateral reserve for the loan.
    /// @param instructions      The loan's stored instructions.
    /// @param ownerHoldsPosition True when the instructions' owner still holds
    ///                          the borrower position, so they can run.
    /// @param topUpNow          What instruction 1 would move now (0 when it
    ///                          would not run).
    /// @param priceKnown        False when the health factor could not be
    ///                          read; `topUpNow` is then unknown and reads 0.
    /// @param interestShortfall The current period's unpaid interest.
    /// @param interestNow       What instruction 2 would pay now (0 before the
    ///                          period's end).
    /// @param repayDue          The full repayment amount now.
    /// @param repayShortBy      How much the payment reserve lacks for it.
    struct ReserveView {
        address paymentAsset;
        uint256 paymentReserve;
        address collateralAsset;
        uint256 collateralReserve;
        LibVaipakam.StandingInstructions instructions;
        bool ownerHoldsPosition;
        uint256 topUpNow;
        bool priceKnown;
        uint256 interestShortfall;
        uint256 interestNow;
        uint256 repayDue;
        uint256 repayShortBy;
        /// @dev The SKIP_* reason a collateral top-up would be skipped for
        ///      right now on the loan- and account-level checks every run
        ///      makes (holder, pause, account lock, loan busy); 0 = none.
        ///      The reserve and price checks are the fields above.
        uint8 topUpSkipNow;
        /// @dev The same for the interest payment and the due repayment
        ///      (both pay in the loan's principal asset, so one reason).
        uint8 paymentSkipNow;
        /// @dev True when the borrower position has moved and a top-up must
        ///      first consolidate it into the holder's vault; a top-up run
        ///      tries that and is skipped (NOT_CONSOLIDATED) if it cannot.
        bool consolidationPending;
    }

    // ─── Events ──────────────────────────────────────────────────────

    /// @notice `holder` placed `amount` from their wallet into their own
    ///         vault, reserved for `loanId` (`kind`: 0 payment, 1 collateral).
    /// @param reserved What the holder has in that reserve after it.
    /// @custom:event-category state-change/vault-mutation
    event LoanReserveFunded(
        uint256 indexed loanId,
        address indexed holder,
        uint8 kind,
        address asset,
        uint256 amount,
        uint256 reserved
    );

    /// @notice A depositor withdrew `amount` of their unused reserve.
    /// @param reserved What is left in that reserve.
    /// @custom:event-category state-change/vault-mutation
    event LoanReserveWithdrawn(
        uint256 indexed loanId,
        address indexed holder,
        uint8 kind,
        address asset,
        uint256 amount,
        uint256 reserved
    );

    /// @notice The instructions for `loanId` were set by `setBy` for the
    ///         position holder `owner`.
    /// @custom:event-category state-change/loan-mutation
    event StandingInstructionsSet(
        uint256 indexed loanId,
        address indexed owner,
        address setBy,
        uint64 topUpTriggerHf,
        uint64 topUpTargetHf,
        bool payInterest,
        bool repayAtDue,
        uint32 repayLeadSeconds
    );

    /// @notice The instructions for `loanId` were cleared.
    /// @custom:event-category state-change/loan-mutation
    event StandingInstructionsCleared(uint256 indexed loanId, address indexed owner, address by);

    /// @notice Instruction 1 ran: `amount` moved from `holder`'s collateral
    ///         reserve into the loan's collateral, in the same vault.
    /// @param newCollateralAmount The loan's collateral after the top-up, so
    ///                    a reader records the result rather than adding
    ///                    `amount` to its own copy (replay-safe).
    /// @param hfBefore    The health factor before (1e18).
    /// @param hfAfter     The health factor after (1e18; 0 if unreadable).
    /// @param reserveLeft What is left in the collateral reserve.
    /// @custom:event-category state-change/loan-mutation
    event CollateralTopUpRun(
        uint256 indexed loanId,
        address indexed holder,
        uint256 amount,
        uint256 newCollateralAmount,
        uint256 hfBefore,
        uint256 hfAfter,
        uint256 reserveLeft,
        address caller
    );

    /// @notice Instruction 2 ran: `amount` of the period's `shortfall` was
    ///         paid from `holder`'s payment reserve. The lender, seller and
    ///         treasury split is in `LibInterestPayment.InterestPaymentBooked`
    ///         in the same transaction.
    /// @param periodClosed True when the payment closed the period.
    /// @param reserveLeft  What is left in the payment reserve.
    /// @custom:event-category state-change/loan-mutation
    event InterestPaidFromReserve(
        uint256 indexed loanId,
        address indexed holder,
        uint256 amount,
        uint256 shortfall,
        bool periodClosed,
        uint256 reserveLeft,
        address caller
    );

    /// @notice The reserve-paid legs of a repayment. A parked leg is one the
    ///         token refused to deliver (to the treasury, or into the stored
    ///         lender's vault): it waits in `holder`'s vault under a lien, as
    ///         after a hand repayment, and the host's `TreasuryShareParked` /
    ///         `SettlementLegParked` name it.
    /// @custom:event-category state-change/loan-mutation
    event RepaymentLegsFromReserve(
        uint256 indexed loanId,
        address indexed holder,
        uint256 treasuryShare,
        uint256 lenderDue,
        bool treasuryParked,
        bool lenderParked
    );

    /// @notice The pay-my-interest attempt reverted and the instruction was
    ///         skipped ({SKIP_LEG_REFUSED}); `inner` is the attempt's own error
    ///         selector (0 for a bare revert), so the cause is on record.
    /// @custom:event-category informational/notification
    event InterestPaymentAttemptFailed(uint256 indexed loanId, bytes4 inner);

    /// @notice Instruction 3 ran: the loan was repaid in full from
    ///         `holder`'s payment reserve (`RepayFacet`'s `LoanRepaid` and
    ///         `LoanSettlementBreakdown` carry the split).
    /// @custom:event-category state-change/loan-mutation
    event DueRepaymentRun(
        uint256 indexed loanId,
        address indexed holder,
        uint256 amount,
        uint256 reserveLeft,
        address caller
    );

    /// @notice An instruction could not run and changed nothing. `missing`
    ///         is how much the reserve lacks for a repayment (`reason`
    ///         {SKIP_RESERVE_SHORT}), else 0.
    /// @custom:event-category informational/notification
    event StandingInstructionSkipped(
        uint256 indexed loanId,
        uint8 indexed instruction,
        uint8 reason,
        uint256 missing,
        address caller
    );

    /// @notice The governed bounds changed.
    /// @custom:event-category informational/config
    event StandingInstructionConfigSet(
        uint64 triggerMinHf,
        uint64 triggerMaxHf,
        uint64 targetMaxHf,
        uint64 minMarginHf,
        uint32 topUpIntervalSeconds
    );

    // ─── Constants ───────────────────────────────────────────────────

    uint8 internal constant RESERVE_PAYMENT = 0;
    /// @dev `SettlementLegFacet`'s source for a share already in a vault.
    uint8 private constant FROM_VAULT = 1;
    uint8 internal constant RESERVE_COLLATERAL = 1;

    uint8 internal constant INSTRUCTION_TOP_UP = 1;
    uint8 internal constant INSTRUCTION_PAY_INTEREST = 2;
    uint8 internal constant INSTRUCTION_REPAY_AT_DUE = 3;

    // The skip reasons: one list for every standing instruction, in
    // `LibStandingInstructions` (#3752 added four), aliased here.
    uint8 internal constant SKIP_RESERVE_EMPTY = LibStandingInstructions.SKIP_RESERVE_EMPTY;
    uint8 internal constant SKIP_RESERVE_SHORT = LibStandingInstructions.SKIP_RESERVE_SHORT;
    uint8 internal constant SKIP_PRICE_UNAVAILABLE = LibStandingInstructions.SKIP_PRICE_UNAVAILABLE;
    uint8 internal constant SKIP_NOT_CONSOLIDATED = LibStandingInstructions.SKIP_NOT_CONSOLIDATED;
    uint8 internal constant SKIP_LEG_REFUSED = LibStandingInstructions.SKIP_LEG_REFUSED;
    uint8 internal constant SKIP_SANCTIONED = LibStandingInstructions.SKIP_SANCTIONED;

    /// @dev The gas the interest payment's one attempt is given: well above
    ///      a draw, a booking with open seller claims, and the credit.
    uint256 internal constant INTEREST_ATTEMPT_GAS = 1_500_000;

    // ─── Errors ──────────────────────────────────────────────────────

    /// @notice {previewInterestPayment}'s answer: the skip reason
    ///         {runInterestPayment} would record now (0 = it would pay) and
    ///         the amount it would pay.
    /// @dev `inner` is the failed attempt's error selector (0 when it paid,
    ///      or when the skip came before any attempt).
    error InterestPaymentPreview(uint8 skip, uint256 amount, bytes4 inner);
    /// @notice Less gas was left than the interest payment's attempt is
    ///         given; the call reverts so a payable period is never skipped
    ///         for want of gas.
    error InterestPaymentOutOfGas();

    error LoanReserveZeroAmount();
    error LoanReserveNotOffered(uint256 loanId, uint8 kind);
    error StandingInstructionNotOffered(uint256 loanId, uint8 instruction);
    error TopUpBoundsInvalid(uint64 triggerHf, uint64 targetHf);
    error RepayLeadTooLong(uint32 leadSeconds, uint32 max);
    /// @notice The due date already has a plan (automatic extension or
    ///         automatic refinance limits, or the repay instruction).
    error DueDatePlanExists(uint256 loanId);
    error StandingInstructionNotSet(uint256 loanId, uint8 instruction);
    error StandingInstructionNotDue(uint256 loanId, uint8 instruction, uint256 from);
    error StandingInstructionWindowClosed(uint256 loanId, uint8 instruction);
    error LoanHealthAboveTrigger(uint256 loanId, uint256 hf, uint256 trigger);
    error TopUpTooSoon(uint256 loanId, uint256 nextAt);
    error NothingOwed(uint256 loanId);
    error StandingInstructionConfigInvalid();

    // ─── The loan reserve ────────────────────────────────────────────

    /// @notice Place `amount` from the caller's wallet into their own vault,
    ///         reserved for `loanId`: kind 0 the lending asset (payment
    ///         reserve), kind 1 the collateral asset (collateral reserve).
    /// @dev    Only the current borrower-position holder, acting as its own
    ///         manager, may fund. Refused for a loan that is not Active or not
    ///         an ERC-20 loan, for a paused asset and for a sanctioned wallet
    ///         (Tier-1). The collateral reserve is offered only for a liquid,
    ///         priced ERC-20 collateral, since instruction 1 has no trigger
    ///         without a health factor. The caller approves the Diamond for
    ///         exactly `amount` first.
    function fundLoanReserve(uint256 loanId, uint8 kind, uint256 amount) external nonReentrant {
        LibPausable.requireNotPaused();
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibProtectedAccount.requireManager(msg.sender);
        if (amount == 0) revert LoanReserveZeroAmount();
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (loan.startTime == 0 || loan.status != LibVaipakam.LoanStatus.Active) {
            revert IVaipakamErrors.LoanNotActive();
        }
        if (loan.assetType != LibVaipakam.AssetType.ERC20) revert LoanReserveNotOffered(loanId, kind);
        if (LibPositionNFT.ownerOf(loan.borrowerTokenId) != msg.sender) {
            revert IVaipakamErrors.NotNFTOwner();
        }
        address asset = _reserveAsset(loan, kind);
        if (kind == RESERVE_COLLATERAL && !_collateralPriced(loan)) {
            revert LoanReserveNotOffered(loanId, kind);
        }
        LibFacet.requireAssetNotPaused(asset);
        // Wallet -> the caller's own vault through the protocol chokepoint,
        // which records the tracked balance and refuses a short arrival.
        LibFacet.crossFacetCall(
            abi.encodeCall(VaultFactoryFacet.vaultDepositERC20, (msg.sender, asset, amount)),
            IVaipakamErrors.VaultDepositFailed.selector
        );
        uint256 reserved = LibEncumbrance.lienLoanReserve(loanId, msg.sender, kind, asset, amount);
        emit LoanReserveFunded(loanId, msg.sender, kind, asset, amount, reserved);
    }

    /// @notice Withdraw `amount` of `account`'s unused reserve of `kind` for
    ///         `loanId` to the caller, who must be the account's manager (its
    ///         own wallet, or its controller once a replacement retired it).
    /// @dev    Open whatever the loan's state and whoever holds the position:
    ///         the reserve is the depositor's own money. An ordinary vault
    ///         payout under the outflow policy (a protected account's payout
    ///         queues behind its delay). Tier-1 sanctions-gated.
    ///         #3246 part 2 — a RECOVERED account's standing instructions are
    ///         dead and its owner key may be lost, so anyone may return its
    ///         unused reserve to the account's own vault, where it stays free
    ///         for the recovered account's sweep to the recovery address
    ///         (RecoveryAddressClawbackDesign §4.3; the same rule as
    ///         `LenderIntentFacet.withdrawLenderIntentCapital`).
    function withdrawLoanReserve(address account, uint256 loanId, uint8 kind, uint256 amount) external nonReentrant {
        LibPausable.requireNotPaused();
        bool recovered = LibProtectedAccount.isRecovered(account);
        if (!recovered) {
            LibProtectedAccount.requireManager(account);
            LibVaipakam._assertNotSanctioned(msg.sender);
        }
        if (amount == 0) revert LoanReserveZeroAmount();
        address asset = _reserveAsset(LibVaipakam.storageSlot().loans[loanId], kind);
        // Released BEFORE the withdraw, so the chokepoint's guard sees it free.
        uint256 left = LibEncumbrance.unlienLoanReserve(loanId, account, kind, asset, amount);
        if (recovered || msg.sender == account) {
            LibVaultOutflow.toOwner(account, LibVaultOutflow.ERC20, asset, 0, amount, OutflowReason.WITHDRAW);
        } else {
            LibVaultOutflow.toAllowlisted(
                account, LibVaultOutflow.ERC20, asset, 0, amount, msg.sender, OutflowReason.WITHDRAW
            );
        }
        emit LoanReserveWithdrawn(loanId, account, kind, asset, amount, left);
    }

    // ─── Settings ────────────────────────────────────────────────────

    /// @notice Set `loanId`'s standing instructions for its current
    ///         borrower-position holder. The caller is that holder's manager.
    /// @dev    Each instruction is refused where it could not run on the
    ///         loan: the top-up on a loan without a health factor (not both
    ///         legs liquid ERC-20s), the interest payment on a loan without a
    ///         periodic cadence, and the due-date repayment while automatic
    ///         extension or automatic refinance limits stand (one plan for
    ///         the due date). Trigger and target are checked against the
    ///         governed bounds. Replaces any earlier setting.
    function setStandingInstructions(uint256 loanId, InstructionInput calldata cfg) external nonReentrant {
        LibPausable.requireNotPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        LibAuth.requirePositionManager(loan.borrowerTokenId);
        // #3734 — setting a standing instruction is a standing commitment.
        LibTerms.requireCurrent(msg.sender);
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert StandingInstructionNotOffered(loanId, INSTRUCTION_REPAY_AT_DUE);
        }
        if (cfg.topUpTriggerHf != 0) {
            if (
                loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
                loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
                loan.collateralAssetType != LibVaipakam.AssetType.ERC20
            ) revert StandingInstructionNotOffered(loanId, INSTRUCTION_TOP_UP);
            _checkTopUpBounds(cfg.topUpTriggerHf, cfg.topUpTargetHf);
        }
        if (cfg.payInterest && loan.periodicInterestCadence == LibVaipakam.PeriodicInterestCadence.None) {
            revert StandingInstructionNotOffered(loanId, INSTRUCTION_PAY_INTEREST);
        }
        if (cfg.repayAtDue) {
            if (cfg.repayLeadSeconds > LibVaipakam.STANDING_REPAY_LEAD_MAX) {
                revert RepayLeadTooLong(cfg.repayLeadSeconds, LibVaipakam.STANDING_REPAY_LEAD_MAX);
            }
            if (LibStandingInstructions.autoDueDatePlanLive(s, loan)) revert DueDatePlanExists(loanId);
        }
        address owner = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        // #3752 — with the exit instruction set too, the top-up acts first.
        LibStandingInstructions.requireExitBelowTopUp(
            LibStandingInstructions.exitLevelOf(s, loanId, owner), cfg.topUpTriggerHf, _cfgMargin(s)
        );
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        // The interval between two top-ups survives a re-set by the same
        // owner, so re-setting cannot shorten it.
        uint64 last = si.owner == owner ? si.lastTopUpAt : 0;
        s.standingInstructions[loanId] = LibVaipakam.StandingInstructions({
            owner: owner,
            topUpTriggerHf: cfg.topUpTriggerHf,
            topUpTargetHf: cfg.topUpTriggerHf == 0 ? 0 : cfg.topUpTargetHf,
            lastTopUpAt: last,
            payInterest: cfg.payInterest,
            repayAtDue: cfg.repayAtDue,
            repayLeadSeconds: cfg.repayAtDue ? cfg.repayLeadSeconds : 0
        });
        emit StandingInstructionsSet(
            loanId,
            owner,
            msg.sender,
            cfg.topUpTriggerHf,
            cfg.topUpTriggerHf == 0 ? 0 : cfg.topUpTargetHf,
            cfg.payInterest,
            cfg.repayAtDue,
            cfg.repayAtDue ? cfg.repayLeadSeconds : 0
        );
    }

    /// @notice Clear `loanId`'s standing instructions. The caller is the
    ///         manager of the instructions' owner or of the current
    ///         borrower-position holder.
    function clearStandingInstructions(uint256 loanId) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address owner = s.standingInstructions[loanId].owner;
        if (owner == address(0)) revert StandingInstructionNotSet(loanId, 0);
        if (msg.sender != LibProtectedAccount.manager(owner)) {
            LibAuth.requirePositionManager(s.loans[loanId].borrowerTokenId);
        }
        delete s.standingInstructions[loanId];
        emit StandingInstructionsCleared(loanId, owner, msg.sender);
    }

    // ─── Executors (permissionless) ──────────────────────────────────

    /// @notice Instruction 1: move collateral from the holder's collateral
    ///         reserve into the loan's lien, the least that brings the health
    ///         factor back to the holder's target, or the whole reserve if
    ///         that is less. Runs only below the trigger, at most once per
    ///         configured interval.
    function runCollateralTopUp(uint256 loanId) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        if (si.topUpTriggerHf == 0) revert StandingInstructionNotSet(loanId, INSTRUCTION_TOP_UP);
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        uint256 nextAt = uint256(si.lastTopUpAt) + _cfgInterval(s);
        if (si.lastTopUpAt != 0 && block.timestamp < nextAt) revert TopUpTooSoon(loanId, nextAt);

        address holder = si.owner;
        uint8 skip = LibStandingInstructions.commonSkip(s, loanId, loan, holder, loan.collateralAsset);
        // The top-up follows the manual add-collateral's Tier-1 gate: a
        // flagged holder's loan is not strengthened from its reserve.
        if (skip == 0 && LibVaipakam.isSanctionedAddress(holder)) skip = SKIP_SANCTIONED;
        if (skip == 0) skip = _consolidated(loanId, loan, holder);
        uint256 reserve = s.collateralReserve[loanId][holder];
        if (skip == 0 && reserve == 0) skip = SKIP_RESERVE_EMPTY;
        (bool ok, uint256 hf) = _healthFactor(loanId);
        if (skip == 0 && !ok) skip = SKIP_PRICE_UNAVAILABLE;
        if (skip != 0) {
            _skip(loanId, INSTRUCTION_TOP_UP, skip, 0);
            return;
        }
        if (hf >= si.topUpTriggerHf) revert LoanHealthAboveTrigger(loanId, hf, si.topUpTriggerHf);

        uint256 amount = _topUpAmount(loan.collateralAmount, hf, si.topUpTargetHf);
        if (amount > reserve) amount = reserve;
        si.lastTopUpAt = uint64(block.timestamp);
        // The reserve leaves the encumbrance and joins the loan's collateral
        // lien, in the same vault: no tokens move.
        LibEncumbrance.unlienLoanReserve(loanId, holder, RESERVE_COLLATERAL, loan.collateralAsset, amount);
        LibLoanCollateral.add(loan, amount);
        LibFacet.crossFacetCall(
            abi.encodeCall(CollateralLienFacet.incrementCollateralLien, (loanId, amount)),
            bytes4(0)
        );
        (, uint256 hfAfter) = _healthFactor(loanId);
        emit CollateralTopUpRun(
            loanId, holder, amount, loan.collateralAmount, hf, hfAfter, reserve - amount, msg.sender
        );
    }

    /// @notice Instruction 2: from the current period's end, pay its unpaid
    ///         interest from the holder's payment reserve (all of it, or as
    ///         much as the reserve holds). A payment that brings the period to
    ///         fully paid closes it in the same transaction; after a part
    ///         payment the periodic settlement sells only for the rest.
    function runInterestPayment(uint256 loanId) external nonReentrant {
        (uint8 skip, address holder, uint256 amount, uint256 shortfall) = _interestPlan(loanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint64 checkpoint = s.loans[loanId].lastPeriodicInterestSettledAt;
        bytes4 inner;
        if (skip == 0) (skip, inner) = _tryInterestPayment(loanId, holder, amount);
        if (skip != 0) {
            if (skip == SKIP_LEG_REFUSED) emit InterestPaymentAttemptFailed(loanId, inner);
            _skip(loanId, INSTRUCTION_PAY_INTEREST, skip, 0);
            return;
        }
        emit InterestPaidFromReserve(
            loanId,
            holder,
            amount,
            shortfall,
            s.loans[loanId].lastPeriodicInterestSettledAt != checkpoint,
            s.paymentReserve[loanId][holder],
            msg.sender
        );
    }

    /**
     * @notice What {runInterestPayment} would do now, for a keeper: it runs
     *         the payment and then undoes it, reverting
     *         {InterestPaymentPreview} with the skip reason it would record
     *         (0 = it would pay) and the amount. Call it with `eth_call`. It
     *         is the only way to learn {SKIP_LEG_REFUSED} before sending, since
     *         whether a token refuses a delivery is known only by trying it.
     * @dev    Always reverts, so it changes nothing. Reverts with the
     *         instruction's own error where {runInterestPayment} would.
     */
    function previewInterestPayment(uint256 loanId) external nonReentrant {
        (uint8 skip, address holder, uint256 amount,) = _interestPlan(loanId);
        bytes4 inner;
        if (skip == 0) (skip, inner) = _tryInterestPayment(loanId, holder, amount);
        revert InterestPaymentPreview(skip, skip == 0 ? amount : 0, inner);
    }

    /// @notice The payment itself: drawn from `holder`'s payment reserve,
    ///         booked once, and credited to the period. Self-only, run by
    ///         {runInterestPayment} as one attempt, so a delivery the token
    ///         refuses (a frozen lender vault or treasury) undoes the whole
    ///         payment and the instruction is skipped by name, never a bare
    ///         revert (design 4.4). Mid-loan interest does not park: the hand
    ///         path refuses a refused leg too.
    function payInterestFromReserve(uint256 loanId, address holder, uint256 amount) external {
        if (msg.sender != address(this)) revert IVaipakamErrors.UnauthorizedCrossFacetCall();
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        _drawPayment(loanId, holder, loan.principalAsset, amount);
        // The one interest booking, shared with the periodic forced sale.
        (, uint256 settled) = abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeCall(
                    IInterestPaymentHost.bookInterestPayment,
                    (loanId, amount, amount, LibInterestPayment.SOURCE_PAYMENT_RESERVE)
                ),
                bytes4(0)
            ),
            (uint256, uint256)
        );
        // The period is credited only with interest that arrived. A lender
        // delivery that arrives short (a token charging a fee on the way)
        // undoes the whole attempt, which is then skipped by name, so the
        // period's shortfall keeps its own settlement.
        if (settled != amount) revert IVaipakamErrors.TokenDeliveryShort(loan.principalAsset, amount, settled);
        // The period's credit, through its one crediting function, which
        // closes the period inline once it is paid and over.
        LibPeriodicInterest.creditInterestPaid(loan, loanId, amount);
    }

    /// @dev The instruction's own refusals (not set, not active, not due,
    ///      nothing owed) revert; everything after them is a skip reason.
    function _interestPlan(uint256 loanId)
        private
        view
        returns (uint8 skip, address holder, uint256 amount, uint256 shortfall)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        if (!si.payInterest) revert StandingInstructionNotSet(loanId, INSTRUCTION_PAY_INTEREST);
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        uint256 periodEnd = LibPeriodicInterest.periodEndAt(loan);
        if (block.timestamp < periodEnd) {
            revert StandingInstructionNotDue(loanId, INSTRUCTION_PAY_INTEREST, periodEnd);
        }
        shortfall = LibPeriodicInterest.currentShortfall(loan);
        if (shortfall == 0) revert NothingOwed(loanId);
        holder = si.owner;
        skip = LibStandingInstructions.commonSkip(s, loanId, loan, holder, loan.principalAsset);
        uint256 reserve = s.paymentReserve[loanId][holder];
        if (skip == 0 && reserve == 0) skip = SKIP_RESERVE_EMPTY;
        amount = shortfall < reserve ? shortfall : reserve;
    }

    /// @dev One attempt at {payInterestFromReserve}; 0 when it paid, else
    ///      {SKIP_LEG_REFUSED} with nothing changed. Refuses to start without
    ///      the gas the attempt is given, so withholding gas can never turn a
    ///      payable period into a skip.
    function _tryInterestPayment(uint256 loanId, address holder, uint256 amount)
        private
        returns (uint8 skip, bytes4 inner)
    {
        if (gasleft() < INTEREST_ATTEMPT_GAS + INTEREST_ATTEMPT_GAS / 63 + 20_000) {
            revert InterestPaymentOutOfGas();
        }
        (bool ok, bytes memory ret) = address(this).call{gas: INTEREST_ATTEMPT_GAS}(
            abi.encodeCall(this.payInterestFromReserve, (loanId, holder, amount))
        );
        if (ok) return (0, bytes4(0));
        if (ret.length >= 4) inner = bytes4(ret);
        return (SKIP_LEG_REFUSED, inner);
    }

    /// @notice Instruction 3: repay the loan in full from the holder's
    ///         payment reserve, from `repayLeadSeconds` before the due date
    ///         until grace ends, exactly as a manual repayment would (the same
    ///         amounts, the late fee if past the due date, the collateral
    ///         back to the borrower side). All or nothing: a reserve short of
    ///         the full amount changes nothing and says how much is missing.
    /// @dev Holds no reentrancy guard of its own: it makes no external call
    ///      before the repayment, and the repayment it self-calls takes the
    ///      Diamond's guard for the whole movement of funds.
    function runDueRepayment(uint256 loanId) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        if (!si.repayAtDue) revert StandingInstructionNotSet(loanId, INSTRUCTION_REPAY_AT_DUE);
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        uint256 maturity = LibLoanClock.maturity(loan);
        uint256 from = maturity > si.repayLeadSeconds ? maturity - si.repayLeadSeconds : 0;
        if (block.timestamp < from) revert StandingInstructionNotDue(loanId, INSTRUCTION_REPAY_AT_DUE, from);
        if (block.timestamp > LibLoanClock.graceEnd(loan)) {
            revert StandingInstructionWindowClosed(loanId, INSTRUCTION_REPAY_AT_DUE);
        }

        address holder = si.owner;
        uint8 skip = LibStandingInstructions.commonSkip(s, loanId, loan, holder, loan.principalAsset);
        uint256 reserve = s.paymentReserve[loanId][holder];
        uint256 due = _repaymentDue(loan, loanId);
        uint256 missing;
        if (skip == 0 && reserve == 0) skip = SKIP_RESERVE_EMPTY;
        if (skip == 0 && reserve < due) {
            skip = SKIP_RESERVE_SHORT;
            missing = due - reserve;
        }
        if (skip != 0) {
            _skip(loanId, INSTRUCTION_REPAY_AT_DUE, skip, missing);
            return;
        }
        // The ordinary repayment, bound to the holder's payment reserve as
        // payer; it draws exactly what it charges.
        LibStandingInstructions.bindReserveRepayer(loanId, holder);
        LibFacet.crossFacetCall(abi.encodeWithSignature("repayLoan(uint256)", loanId), bytes4(0));
        emit DueRepaymentRun(loanId, holder, due, s.paymentReserve[loanId][holder], msg.sender);
    }

    /// @notice The reserve-paid legs of the due repayment: `holder`'s
    ///         payment reserve for `loanId` is released for exactly
    ///         `treasuryShare + lenderDue`, then the treasury share goes
    ///         through the fee host and the lender's due into the stored
    ///         lender's vault, each refused unless it all arrives. A leg the
    ///         token refuses (a frozen treasury or lender vault) parks in
    ///         `holder`'s vault under a lien, through the same host and the
    ///         same encumbrance writer as a hand repayment's (#3669), so the
    ///         two end in the same state.
    /// @dev    Reached only by self-call from `RepayFacet.repayLoan` on the reserve path
    ///         (so under {runDueRepayment}'s guard), which has computed both
    ///         amounts and books the repayment. It lives here, beside the
    ///         reserve, because RepayFacet has no EIP-170 room for it.
    /// @param  basis The treasury share's fee basis (the interest it is cut
    ///         from), so a parked share keeps its floor (#3649 stage 3).
    /// @return lenderParked Whether the lender's due was parked.
    function payRepaymentFromReserve(
        uint256 loanId,
        address holder,
        uint256 treasuryShare,
        uint256 lenderDue,
        ITreasuryFeeHost.FeeBasis calldata basis
    ) external returns (bool lenderParked) {
        if (msg.sender != address(this)) revert IVaipakamErrors.UnauthorizedCrossFacetCall();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address asset = s.loans[loanId].principalAsset;
        // The reserve is reduced by the whole amount whatever happens next,
        // so a parked leg is never "unused reserve" its depositor could take.
        LibEncumbrance.unlienLoanReserve(loanId, holder, RESERVE_PAYMENT, asset, treasuryShare + lenderDue);
        bool treasuryParked;
        if (treasuryShare != 0) {
            (, treasuryParked) = abi.decode(
                LibFacet.crossFacetCallReturn(
                    abi.encodeCall(
                        SettlementLegFacet.treasuryShareOrPark, (FROM_VAULT, holder, asset, treasuryShare, basis)
                    ),
                    IVaipakamErrors.TreasuryTransferFailed.selector
                ),
                (uint256, bool)
            );
        }
        lenderParked = abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeCall(
                    SettlementLegFacet.deliverLenderDueFromVaultOrPark, (loanId, holder, asset, lenderDue)
                ),
                IVaipakamErrors.VaultDepositFailed.selector
            ),
            (bool)
        );
        emit RepaymentLegsFromReserve(loanId, holder, treasuryShare, lenderDue, treasuryParked, lenderParked);
    }

    // ─── Views ───────────────────────────────────────────────────────

    /// @notice `holder`'s reserve for `loanId`, the loan's instructions, and
    ///         what each instruction would move if run now.
    function getLoanReserve(uint256 loanId, address holder) external view returns (ReserveView memory v) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        v.paymentAsset = loan.principalAsset;
        v.paymentReserve = s.paymentReserve[loanId][holder];
        v.collateralAsset = loan.collateralAsset;
        v.collateralReserve = s.collateralReserve[loanId][holder];
        v.instructions = s.standingInstructions[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) return v;
        address holderNow = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        v.ownerHoldsPosition = v.instructions.owner != address(0) && holderNow == v.instructions.owner;
        v.consolidationPending = loan.borrower != holderNow;
        if (v.instructions.owner != address(0)) {
            v.topUpSkipNow = LibStandingInstructions.commonSkip(s, loanId, loan, v.instructions.owner, loan.collateralAsset);
            if (v.topUpSkipNow == 0 && LibVaipakam.isSanctionedAddress(v.instructions.owner)) {
                v.topUpSkipNow = SKIP_SANCTIONED;
            }
            v.paymentSkipNow = LibStandingInstructions.commonSkip(s, loanId, loan, v.instructions.owner, loan.principalAsset);
        }
        uint256 hf;
        (v.priceKnown, hf) = _healthFactor(loanId);
        if (v.priceKnown && v.instructions.topUpTriggerHf != 0 && hf < v.instructions.topUpTriggerHf) {
            uint256 want = _topUpAmount(loan.collateralAmount, hf, v.instructions.topUpTargetHf);
            v.topUpNow = want < v.collateralReserve ? want : v.collateralReserve;
        }
        if (loan.periodicInterestCadence != LibVaipakam.PeriodicInterestCadence.None) {
            v.interestShortfall = LibPeriodicInterest.currentShortfall(loan);
            if (block.timestamp >= LibPeriodicInterest.periodEndAt(loan)) {
                v.interestNow = v.interestShortfall < v.paymentReserve ? v.interestShortfall : v.paymentReserve;
            }
        }
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            v.repayDue = _repaymentDue(loan, loanId);
            v.repayShortBy = v.repayDue > v.paymentReserve ? v.repayDue - v.paymentReserve : 0;
        }
    }

    /// @notice The governed bounds in force (defaults filled in).
    function getStandingInstructionConfig()
        external
        view
        returns (LibVaipakam.StandingInstructionConfig memory c)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        c = LibVaipakam.StandingInstructionConfig({
            triggerMinHf: _cfgTriggerMin(s),
            triggerMaxHf: _cfgTriggerMax(s),
            targetMaxHf: _cfgTargetMax(s),
            minMarginHf: _cfgMargin(s),
            topUpIntervalSeconds: uint32(_cfgInterval(s))
        });
    }

    // ─── Governance ──────────────────────────────────────────────────

    /// @notice Set the bounds for the top-up instruction, platform-wide.
    ///         Zero keeps a field's default.
    /// @dev    Outer bounds: triggers above 1.0, a target ceiling at most
    ///         3.0 and above the highest trigger by at least the margin, a
    ///         margin of 0.01 to 0.5, an interval of 5 minutes to 1 day.
    ///         Existing settings are not re-checked; the new bounds apply to
    ///         the next set.
    function setStandingInstructionConfig(LibVaipakam.StandingInstructionConfig calldata c)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.standingInstructionCfg = c;
        uint64 tMin = _cfgTriggerMin(s);
        uint64 tMax = _cfgTriggerMax(s);
        uint64 target = _cfgTargetMax(s);
        uint64 margin = _cfgMargin(s);
        uint256 interval = _cfgInterval(s);
        if (
            tMin <= LibVaipakam.STANDING_HF_FLOOR ||
            tMax < tMin ||
            margin < LibVaipakam.STANDING_MIN_MARGIN_FLOOR ||
            margin > LibVaipakam.STANDING_MIN_MARGIN_CEILING ||
            target > LibVaipakam.STANDING_TARGET_CEILING ||
            uint256(target) < uint256(tMax) + margin ||
            interval < LibVaipakam.STANDING_TOPUP_INTERVAL_MIN ||
            interval > LibVaipakam.STANDING_TOPUP_INTERVAL_MAX
        ) revert StandingInstructionConfigInvalid();
        emit StandingInstructionConfigSet(tMin, tMax, target, margin, uint32(interval));
    }

    // ─── Internals ───────────────────────────────────────────────────

    function _reserveAsset(LibVaipakam.Loan storage loan, uint8 kind) private view returns (address) {
        if (kind == RESERVE_PAYMENT) return loan.principalAsset;
        if (kind == RESERVE_COLLATERAL) return loan.collateralAsset;
        revert LibEncumbrance.LoanReserveKindUnknown(kind);
    }

    function _collateralPriced(LibVaipakam.Loan storage loan) private view returns (bool) {
        if (loan.collateralAssetType != LibVaipakam.AssetType.ERC20) return false;
        (bool ok, bytes memory ret) = LibPriceRead.trySelfRead(
            abi.encodeCall(OracleFacet.checkLiquidity, (loan.collateralAsset))
        );
        return ok && ret.length >= 32 &&
            abi.decode(ret, (LibVaipakam.LiquidityStatus)) == LibVaipakam.LiquidityStatus.Liquid;
    }

    /// @dev The collateral lien sits in the STORED borrower's vault; a moved
    ///      position is consolidated into the new holder's vault first (skip-
    ///      not-block), and a top-up waits until it is.
    function _consolidated(uint256 loanId, LibVaipakam.Loan storage loan, address holder)
        private
        returns (uint8)
    {
        if (loan.borrower == holder) return 0;
        LibFacet.crossFacetCall(
            abi.encodeCall(ConsolidationFacet.eagerConsolidateBothSides, (loanId)),
            bytes4(0)
        );
        return loan.borrower == holder ? 0 : SKIP_NOT_CONSOLIDATED;
    }

    function _healthFactor(uint256 loanId) private view returns (bool ok, uint256 hf) {
        bytes memory ret;
        (ok, ret) = LibPriceRead.trySelfRead(abi.encodeCall(RiskFacet.calculateHealthFactor, (loanId)));
        if (ok && ret.length >= 32) hf = abi.decode(ret, (uint256));
        else ok = false;
    }

    /// @dev The health factor is proportional to the collateral amount (one
    ///      collateral asset, one price), so the least top-up to `target` is
    ///      `collateral * (target - hf) / hf`, rounded up.
    function _topUpAmount(uint256 collateral, uint256 hf, uint256 target) private pure returns (uint256) {
        if (hf == 0 || target <= hf) return 0;
        return (collateral * (target - hf) + hf - 1) / hf;
    }

    /// @dev What a full repayment charges now: the same plan `RepayFacet`
    ///      settles (principal, interest net of what is settled, late fee).
    function _repaymentDue(LibVaipakam.Loan storage loan, uint256 loanId) private view returns (uint256) {
        LibSettlement.ERC20Settlement memory plan =
            LibSettlement.computeRepayment(loan, LibVaipakam.calculateLateFee(loanId), block.timestamp);
        return plan.lenderDue + plan.treasuryShare;
    }

    /// @dev The payment reserve's draw for an interest payment: released from
    ///      the reserve, then out of the holder's vault to the Diamond, refused
    ///      unless all of it arrives.
    function _drawPayment(uint256 loanId, address holder, address asset, uint256 amount) private {
        LibEncumbrance.unlienLoanReserve(loanId, holder, RESERVE_PAYMENT, asset, amount);
        // Paying interest stays open to a flagged owner, as repaying does (the
        // lender is made whole): the owner's existing vault is resolved under
        // the move-out exemption, pinned to this payer.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibSanctionedLock.beginMoveOut(s, holder);
        LibVaultOutflow.toDiamondExact(holder, asset, amount, loanId, OutflowReason.STANDING_INSTRUCTION);
        LibSanctionedLock.endMoveOut(s);
    }

    function _skip(uint256 loanId, uint8 instruction, uint8 reason, uint256 missing) private {
        emit StandingInstructionSkipped(loanId, instruction, reason, missing, msg.sender);
    }

    function _checkTopUpBounds(uint64 trigger, uint64 target) private view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (
            trigger < _cfgTriggerMin(s) ||
            trigger > _cfgTriggerMax(s) ||
            uint256(target) < uint256(trigger) + _cfgMargin(s) ||
            target > _cfgTargetMax(s)
        ) revert TopUpBoundsInvalid(trigger, target);
    }

    function _cfgTriggerMin(LibVaipakam.Storage storage s) private view returns (uint64 v) {
        v = s.standingInstructionCfg.triggerMinHf;
        if (v == 0) v = LibVaipakam.STANDING_TRIGGER_MIN_HF_DEFAULT;
    }

    function _cfgTriggerMax(LibVaipakam.Storage storage s) private view returns (uint64 v) {
        v = s.standingInstructionCfg.triggerMaxHf;
        if (v == 0) v = LibVaipakam.STANDING_TRIGGER_MAX_HF_DEFAULT;
    }

    function _cfgTargetMax(LibVaipakam.Storage storage s) private view returns (uint64) {
        return LibStandingInstructions.cfgTargetMax(s);
    }

    function _cfgMargin(LibVaipakam.Storage storage s) private view returns (uint64) {
        return LibStandingInstructions.cfgMargin(s);
    }

    function _cfgInterval(LibVaipakam.Storage storage s) private view returns (uint256) {
        return LibStandingInstructions.cfgInterval(s);
    }
}
