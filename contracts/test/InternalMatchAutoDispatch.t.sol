// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {FeeOnTransferERC20Mock} from "./mocks/FeeOnTransferERC20Mock.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {liquidationQuote} from "./helpers/ForcedSaleQuote.sol";

/**
 * @title InternalMatchAutoDispatch.t.sol
 * @notice EC-003 Phase 3 — exercises the new
 *         `attemptInternalMatchAutoDispatch` helper directly + via
 *         the cross-facet dispatch path. End-to-end auto-dispatch
 *         from `triggerLiquidation` / `triggerDefault` /
 *         `claimAsLenderWithRetry` requires a heavier integration
 *         setup (HF mocks + sequencer + KYC + liquidity classifier);
 *         that broader coverage lives in the scenario suite.
 */
contract InternalMatchAutoDispatchTest is SetupTest {
    uint256 internal constant LOAN_A = 9001;
    uint256 internal constant LOAN_B = 9002;
    address internal matcher;
    address internal borrowerB;
    address internal lenderB;

    function setUp() public {
        setupHelper();
        matcher = makeAddr("matcher");
        borrowerB = makeAddr("borrowerB");
        lenderB = makeAddr("lenderB");

        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
    }

    function _seedLoan(
        uint256 id,
        address lender_,
        address borrower_,
        address principal,
        uint256 principalAmt,
        address collateral,
        uint256 collateralAmt
    ) internal {
        LibVaipakam.Loan memory l;
        l.id = id;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = principal;
        l.principal = principalAmt;
        l.collateralAsset = collateral;
        l.collateralAmount = collateralAmt;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        // #658 (Codex #680 P2) — give the synthetic loan distinct minted
        // position-NFT IDs so the liquidation family's eager-consolidation hook
        // can resolve `ownerOf`; mocking each to its stored owner (below) makes
        // the consolidation a clean `AlreadyConsolidated` no-op, so the
        // auto-dispatch behaviour under test is unaffected. (id is non-zero, so
        // 2*id / 2*id+1 are distinct, non-zero, and collision-free across loans.)
        l.borrowerTokenId = id * 2;
        l.lenderTokenId = id * 2 + 1;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(id, l);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, id * 2),
            abi.encode(borrower_)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, id * 2 + 1),
            abi.encode(lender_)
        );

        address bVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(borrower_);
        ERC20Mock(collateral).mint(bVault, collateralAmt);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower_, collateral, collateralAmt
        );
    }

    function _mockLtv(uint256 loanId, uint256 ltv) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId),
            abi.encode(ltv)
        );
    }

    // ─── onlyDiamondInternal coverage ───────────────────────────────

    function test_attemptAutoDispatch_eoa_reverts() public {
        // Direct EOA call to the external function should hit
        // `onlyDiamondInternal` and revert.
        vm.expectRevert(RiskMatchLiquidationFacet.OnlyDiamondInternal.selector);
        RiskMatchLiquidationFacet(address(diamond)).attemptInternalMatchAutoDispatch(LOAN_A, matcher);
    }

    function test_executeAutoDispatchMatch_eoa_reverts() public {
        // #2625 item 3 — the self-call match body is Diamond-internal too.
        vm.expectRevert(RiskMatchLiquidationFacet.OnlyDiamondInternal.selector);
        RiskMatchLiquidationFacet(address(diamond)).executeAutoDispatchMatch(LOAN_A, LOAN_B, matcher);
    }

    // ─── #2625 item 3 — a short leg refuses the match, nothing moves ─

    /// @dev Charge 1% on every transfer of `token` out of `from` only.
    function _chargeTransfersFrom(address token, address from) internal {
        vm.etch(token, address(new FeeOnTransferERC20Mock("FoT", "FOT", 18)).code);
        FeeOnTransferERC20Mock(token).setFeeBps(100);
        FeeOnTransferERC20Mock(token).setChargedSender(from);
    }

    /// @notice A leg that delivers short is refused: the auto-dispatch reports
    ///         the refusal, returns false so the caller runs the loan's own
    ///         liquidation (which pays the lender first), and nothing the
    ///         match would have moved has moved.
    function test_2625_autoDispatch_shortLeg_refusedNothingMoves() public {
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        _mockLtv(LOAN_A, 9_000);
        _mockLtv(LOAN_B, 9_000);

        address aLenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address aBorrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        address bBorrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrowerB);
        // Leg X moves B's collateral (mockERC20) out of borrowerB's vault:
        // lender share 990, charge 9, so A's lender would receive 981.
        _chargeTransfersFrom(mockERC20, bBorrowerVault);

        uint256 aLenderX = IERC20(mockERC20).balanceOf(aLenderVault);
        uint256 bBorrowerX = IERC20(mockERC20).balanceOf(bBorrowerVault);
        uint256 aBorrowerY = IERC20(mockCollateralERC20).balanceOf(aBorrowerVault);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit RiskMatchLiquidationFacet.InternalMatchRefusedShortDelivery(
            LOAN_A, LOAN_B, mockERC20, 990, 981
        );
        vm.prank(address(diamond));
        bool dispatched = RiskMatchLiquidationFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A, matcher);
        assertFalse(dispatched, "a short leg refuses the match");

        LibVaipakam.Loan memory aAfter = LoanFacet(address(diamond)).getLoanDetails(LOAN_A);
        LibVaipakam.Loan memory bAfter = LoanFacet(address(diamond)).getLoanDetails(LOAN_B);
        assertEq(uint8(aAfter.status), uint8(LibVaipakam.LoanStatus.Active), "A untouched");
        assertEq(uint8(bAfter.status), uint8(LibVaipakam.LoanStatus.Active), "B untouched");
        assertEq(aAfter.principal, 1000, "A owes what it owed");
        assertEq(bAfter.principal, 1000, "B owes what it owed");
        assertEq(aAfter.collateralAmount, 1000, "A keeps its collateral");
        assertEq(bAfter.collateralAmount, 1000, "B keeps its collateral");
        assertEq(IERC20(mockERC20).balanceOf(aLenderVault), aLenderX, "nothing reached A's lender");
        assertEq(IERC20(mockERC20).balanceOf(bBorrowerVault), bBorrowerX, "nothing left B's vault");
        assertEq(IERC20(mockCollateralERC20).balanceOf(aBorrowerVault), aBorrowerY, "leg Y unwound too");
        assertEq(IERC20(mockERC20).balanceOf(matcher), 0, "no incentive paid");
        assertEq(IERC20(mockCollateralERC20).balanceOf(matcher), 0, "no incentive paid");
    }

    /// @notice Only the short-delivery refusal is caught. Any other failure
    ///         inside the match still reverts the caller, as before #2625, so a
    ///         failure cannot quietly turn into a skipped match.
    function test_2625_autoDispatch_otherRevertBubbles() public {
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        _mockLtv(LOAN_A, 9_000);
        _mockLtv(LOAN_B, 9_000);
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encodeWithSelector(IVaipakamErrors.VaultTransferFailed.selector)
        );

        vm.expectRevert(IVaipakamErrors.VaultTransferFailed.selector);
        vm.prank(address(diamond));
        RiskMatchLiquidationFacet(address(diamond)).attemptInternalMatchAutoDispatch(LOAN_A, matcher);
    }

    /// @notice Codex #3082 r1 P1 — inside the internal-match priority window a
    ///         refused match must not leave the loan stuck: the window holds a
    ///         loan only while a match can run, so the same `triggerLiquidation`
    ///         goes on to the loan's own liquidation instead of reverting
    ///         `InternalMatchOnlyBand`. (Without a candidate the same LTV
    ///         reverts the band error: `InternalMatchPriorityWindowTest`.)
    function test_2625_inWindow_refusedMatch_liquidationProceeds() public {
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        // A sits inside the band [8500, 8700); B is matchable.
        _mockLtv(LOAN_A, 8_600);
        _mockLtv(LOAN_B, 9_000);
        _chargeTransfersFrom(mockERC20, VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrowerB));
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.sequencerHealthy.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, LOAN_A),
            abi.encode(uint256(0.9e18))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidityOnActiveNetwork.selector, mockCollateralERC20),
            abi.encode(uint8(LibVaipakam.LiquidityStatus.Liquid))
        );

        uint256 sellQuote = liquidationQuote(address(diamond), LOAN_A);
        // The external sale itself then fails here (no adapter calls), which
        // rolls the whole call back; what matters is that it was reached: the
        // call got past the window gate to the swap step.
        vm.expectRevert(abi.encodeWithSelector(LibSwap.NoEnabledSwapRoute.selector, LOAN_A));
        RiskFacet(address(diamond)).triggerLiquidation(LOAN_A, sellQuote, new LibSwap.AdapterCall[](0));
    }

    // ─── No-candidate fall-through (returns false) ──────────────────

    function test_attemptAutoDispatch_killSwitchOff_returnsFalse() public {
        // Disable internal-match → auto-dispatch is inert.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(false);

        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);

        // Invoke via cross-facet pattern — pretend Diamond is calling us.
        vm.prank(address(diamond));
        bool dispatched = RiskMatchLiquidationFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A, matcher);
        assertFalse(dispatched);
    }

    function test_attemptAutoDispatch_noOpposingCandidate_returnsFalse() public {
        // Only one loan in the asset pair; no opposing-direction counterparty.
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);

        vm.prank(address(diamond));
        bool dispatched = RiskMatchLiquidationFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A, matcher);
        assertFalse(dispatched);
    }

    // ─── Happy path: auto-dispatch fires + settles ──────────────────

    function test_attemptAutoDispatch_validCandidate_settlesAndReturnsTrue() public {
        // Two opposing-direction Active loans, both liquidatable. The
        // helper should match them, transition both to InternalMatched,
        // and pay the 1% matcher bonus to `msg.sender`.
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        // LTV mocks — both legs need LTV >= floor (8500) to pass the
        // view's gate AND _executeTwoWayMatch's per-leg LTV check.
        _mockLtv(LOAN_A, 9_000);
        _mockLtv(LOAN_B, 9_000);

        address aLenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);
        address bLenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lenderB);

        uint256 aLenderXBefore = IERC20(mockERC20).balanceOf(aLenderVault);
        uint256 bLenderYBefore = IERC20(mockCollateralERC20).balanceOf(bLenderVault);

        // Cross-facet pattern — simulate `matcher` calling Diamond,
        // which delegates to RiskFacet's gated entry. `msg.sender` of
        // the inner call is the Diamond, satisfying onlyDiamondInternal.
        vm.prank(address(diamond));
        bool dispatched = RiskMatchLiquidationFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A, matcher);
        assertTrue(dispatched);

        LibVaipakam.Loan memory aAfter = LoanFacet(address(diamond)).getLoanDetails(LOAN_A);
        LibVaipakam.Loan memory bAfter = LoanFacet(address(diamond)).getLoanDetails(LOAN_B);
        assertEq(uint8(aAfter.status), uint8(LibVaipakam.LoanStatus.InternalMatched));
        assertEq(uint8(bAfter.status), uint8(LibVaipakam.LoanStatus.InternalMatched));
        assertEq(aAfter.principal, 0);
        assertEq(bAfter.principal, 0);

        // Lender payouts: 990 each leg (1000 - 1% matcher fee).
        assertEq(IERC20(mockERC20).balanceOf(aLenderVault) - aLenderXBefore, 990);
        assertEq(IERC20(mockCollateralERC20).balanceOf(bLenderVault) - bLenderYBefore, 990);
        // Matcher bonus (1% per leg) goes to the `matcher` threaded
        // into `attemptInternalMatchAutoDispatch` — NOT `msg.sender`,
        // which inside the `onlyDiamondInternal` cross-facet call is
        // `address(diamond)`. The Diamond must not pocket the fee.
        assertEq(IERC20(mockERC20).balanceOf(matcher), 10, "leg-X incentive to the threaded matcher");
        assertEq(IERC20(mockCollateralERC20).balanceOf(matcher), 10, "leg-Y incentive to the threaded matcher");
        assertEq(IERC20(mockERC20).balanceOf(address(diamond)), 0, "incentive must not strand on the Diamond");
        assertEq(IERC20(mockCollateralERC20).balanceOf(address(diamond)), 0, "incentive must not strand on the Diamond");
    }

    /// @notice #817 — a sanctioned matcher does NOT skip the objective internal
    ///         match (skipping would let a flagged caller degrade settlement to
    ///         the external/FallbackPending path). The match still executes and
    ///         transitions both legs to InternalMatched, but the 1% bonus is
    ///         DENIED: the incentive is zeroed and folded into each lender's
    ///         share, so the honest lenders are made fully whole (full `moved`,
    ///         not `moved − incentive`) and no value reaches the flagged wallet.
    function test_attemptAutoDispatch_sanctionedMatcher_settlesWithoutBonus() public {
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        _mockLtv(LOAN_A, 9_000);
        _mockLtv(LOAN_B, 9_000);

        address aLenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address bLenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lenderB);
        uint256 aBefore = IERC20(mockERC20).balanceOf(aLenderVault);
        uint256 bBefore = IERC20(mockCollateralERC20).balanceOf(bLenderVault);

        MockSanctionsList m = new MockSanctionsList();
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(matcher, true);

        vm.prank(address(diamond));
        bool dispatched = RiskMatchLiquidationFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A, matcher);
        assertTrue(dispatched, "match must still execute for a sanctioned matcher");

        // Both legs settled.
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(LOAN_A).status),
            uint8(LibVaipakam.LoanStatus.InternalMatched)
        );
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(LOAN_B).status),
            uint8(LibVaipakam.LoanStatus.InternalMatched)
        );
        // Lenders get the FULL moved amount (incentive folded back), not 990.
        assertEq(IERC20(mockERC20).balanceOf(aLenderVault) - aBefore, 1000);
        assertEq(IERC20(mockCollateralERC20).balanceOf(bLenderVault) - bBefore, 1000);
        // No bonus reached the flagged matcher.
        assertEq(IERC20(mockERC20).balanceOf(matcher), 0);
        assertEq(IERC20(mockCollateralERC20).balanceOf(matcher), 0);
    }

    // ─── LTV-floor gate on Active candidates ────────────────────────

    function test_attemptAutoDispatch_candidateBelowLtvFloor_returnsFalse() public {
        // Loan B exists in the opposing pair but its LTV is BELOW the
        // floor (healthy loan). The view's LTV-floor gate should skip
        // it; auto-dispatch falls through with no match.
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        // A is liquidatable; B is healthy (LTV 5000 < floor 8500).
        _mockLtv(LOAN_A, 9_000);
        _mockLtv(LOAN_B, 5_000);

        vm.prank(address(diamond));
        bool dispatched = RiskMatchLiquidationFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A, matcher);
        assertFalse(dispatched, "healthy candidate must not be force-liquidated");
    }

    // ─── Caller-side terminal short-circuit ─────────────────────────

    function test_attemptAutoDispatch_callerNotMatchable_returnsFalse() public {
        // The caller-loan is in a terminal status — auto-dispatch returns
        // false without trying to settle.
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            LOAN_A,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );

        vm.prank(address(diamond));
        bool dispatched = RiskMatchLiquidationFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A, matcher);
        assertFalse(dispatched);
    }

    // ─── End-to-end — matcher incentive reaches the triggering EOA ──

    function test_triggerLiquidation_autoDispatch_paysIncentiveToCaller() public {
        // PR #21 review regression. An external EOA calls
        // `triggerLiquidation`; the EC-003 Phase 3 auto-dispatch fires
        // and settles the loan internally. The 1% matcher incentive
        // MUST reach that EOA — not `address(diamond)`. The auto-
        // dispatch reaches the match body through an
        // `onlyDiamondInternal` cross-facet call, so `msg.sender`
        // inside it is the Diamond; the fix threads the triggering
        // EOA explicitly as `matcher`.
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        // Both legs need LTV >= floor (8500) for the candidate view's
        // gate AND `_executeTwoWayMatch`'s per-leg LTV check.
        _mockLtv(LOAN_A, 9_000);
        _mockLtv(LOAN_B, 9_000);
        // `triggerLiquidation` gates: sequencer healthy + HF < 1e18.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.sequencerHealthy.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, LOAN_A),
            abi.encode(uint256(0.9e18))
        );

        address keeper = makeAddr("keeperEOA");
        LibSwap.AdapterCall[] memory noCalls = new LibSwap.AdapterCall[](0);

        uint256 sellQuote = liquidationQuote(address(diamond), LOAN_A);
        vm.prank(keeper);
        RiskFacet(address(diamond)).triggerLiquidation(LOAN_A, sellQuote, noCalls);

        // Auto-dispatch settled both loans internally.
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(LOAN_A).status),
            uint8(LibVaipakam.LoanStatus.InternalMatched),
            "A internally matched via triggerLiquidation auto-dispatch"
        );
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(LOAN_B).status),
            uint8(LibVaipakam.LoanStatus.InternalMatched),
            "B matched"
        );
        // The 1% per-leg incentive went to the triggering EOA, and the
        // Diamond pocketed nothing.
        assertEq(IERC20(mockERC20).balanceOf(keeper), 10, "leg-X incentive to the EOA caller");
        assertEq(IERC20(mockCollateralERC20).balanceOf(keeper), 10, "leg-Y incentive to the EOA caller");
        assertEq(IERC20(mockERC20).balanceOf(address(diamond)), 0, "incentive not stranded on Diamond");
        assertEq(IERC20(mockCollateralERC20).balanceOf(address(diamond)), 0, "incentive not stranded on Diamond");
    }
}
