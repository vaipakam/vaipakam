// test/PrepayListingFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {IVaipakamPrepayContext} from "../src/seaport/IVaipakamPrepayContext.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Integration tests for the diamond-side `PrepayListingFacet`
///         (T-086 step 5). Exercises:
///           - `setCollateralListingExecutor` / `getCollateralListingExecutor`
///             admin surface.
///           - `executorFinalizePrepaySale` privileged-caller gate
///             (msg.sender == storedExecutor) + happy-path split and
///             state mutation (#2876).
///
///         The view path (`getPrepayContext`) is exercised end-to-end
///         in the executor's unit tests via a mock diamond; here we
///         confirm the real diamond's implementation also returns
///         sensible values when the loan record is scaffolded.
contract PrepayListingFacetTest is SetupTest {
    address internal mockExecutor;
    address internal mockExecutor2;
    address internal someOtherUser;
    address internal _scLender;
    address internal _scBorrower;

    uint256 internal constant TEST_LOAN_ID = 9_876;

    function setUp() public {
        setupHelper();
        mockExecutor = makeAddr("collateralListingExecutorMock");
        mockExecutor2 = makeAddr("collateralListingExecutorMock2");
        someOtherUser = makeAddr("someOtherUser");
        _scLender = makeAddr("plf_lender");
        _scBorrower = makeAddr("plf_borrower");
    }

    // ─── Admin setter / getter ──────────────────────────────────────────

    function test_setCollateralListingExecutor_revertsForNonAdmin() public {
        vm.prank(someOtherUser);
        vm.expectRevert(); // LibAccessControl.AccessControlUnauthorizedAccount
        PrepayListingFacet(address(diamond)).setCollateralListingExecutor(mockExecutor);
    }

    function test_setCollateralListingExecutor_happyPath() public {
        // SetupTest grants ADMIN_ROLE to `owner` via the initialize
        // call; that's the address we prank.
        vm.prank(owner);
        PrepayListingFacet(address(diamond)).setCollateralListingExecutor(mockExecutor);
        assertEq(
            PrepayListingFacet(address(diamond)).getCollateralListingExecutor(),
            mockExecutor,
            "executor address round-trips through storage"
        );
    }

    function test_setCollateralListingExecutor_rotation() public {
        vm.prank(owner);
        PrepayListingFacet(address(diamond)).setCollateralListingExecutor(mockExecutor);

        vm.prank(owner);
        PrepayListingFacet(address(diamond)).setCollateralListingExecutor(mockExecutor2);

        assertEq(
            PrepayListingFacet(address(diamond)).getCollateralListingExecutor(),
            mockExecutor2,
            "rotation overwrites the previous executor"
        );
    }

    function test_setCollateralListingExecutor_disableViaZero() public {
        vm.prank(owner);
        PrepayListingFacet(address(diamond)).setCollateralListingExecutor(mockExecutor);

        vm.prank(owner);
        PrepayListingFacet(address(diamond)).setCollateralListingExecutor(address(0));

        assertEq(
            PrepayListingFacet(address(diamond)).getCollateralListingExecutor(),
            address(0),
            "setting to address(0) disables the path"
        );
    }

    // ─── executorFinalizePrepaySale ─────────────────────────────────────

    function test_executorFinalizePrepaySale_revertsExecutorNotSet() public {
        // No executor configured (default address(0)).
        vm.prank(mockExecutor);
        vm.expectRevert(PrepayListingFacet.ExecutorNotSet.selector);
        PrepayListingFacet(address(diamond)).executorFinalizePrepaySale(TEST_LOAN_ID, 0);
    }

    function test_executorFinalizePrepaySale_revertsNotExecutor() public {
        vm.prank(owner);
        PrepayListingFacet(address(diamond)).setCollateralListingExecutor(mockExecutor);

        vm.prank(someOtherUser);
        vm.expectRevert(
            abi.encodeWithSelector(
                PrepayListingFacet.NotExecutor.selector,
                someOtherUser,
                mockExecutor
            )
        );
        PrepayListingFacet(address(diamond)).executorFinalizePrepaySale(TEST_LOAN_ID, 0);
    }

    function test_executorFinalizePrepaySale_revertsIfLoanNotActive() public {
        vm.prank(owner);
        PrepayListingFacet(address(diamond)).setCollateralListingExecutor(mockExecutor);

        // Scaffold a loan in Settled status — finalize should refuse.
        _scaffoldLoan(TEST_LOAN_ID, LibVaipakam.LoanStatus.Settled);

        vm.prank(mockExecutor);
        vm.expectRevert(
            abi.encodeWithSelector(
                PrepayListingFacet.PrepayLoanNotActive.selector,
                TEST_LOAN_ID,
                LibVaipakam.LoanStatus.Settled
            )
        );
        PrepayListingFacet(address(diamond)).executorFinalizePrepaySale(TEST_LOAN_ID, 0);
    }

    function test_executorFinalizePrepaySale_happyPath() public {
        vm.prank(owner);
        PrepayListingFacet(address(diamond)).setCollateralListingExecutor(mockExecutor);

        // Scaffold an Active loan with the minimal fields the
        // finalization callback touches.
        _scaffoldLoan(TEST_LOAN_ID, LibVaipakam.LoanStatus.Active);

        // #2876 — the buyer's proceeds leg paid the Diamond: the floor (what
        // a repayment now owes the lender and the treasury) plus 3 ether.
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(address(diamond)).getPrepayContext(TEST_LOAN_ID, block.timestamp);
        uint256 proceeds = pctx.lenderLeg + pctx.treasuryLeg + 3 ether;
        ERC20Mock(mockERC20).mint(address(diamond), proceeds);

        vm.prank(mockExecutor);
        PrepayListingFacet(address(diamond)).executorFinalizePrepaySale(TEST_LOAN_ID, proceeds);

        // The sale closes the loan as a repayment: the lender's due waits in
        // the stored lender's vault for the claim, and the borrower holder's
        // wallet takes everything above the floor.
        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(_scLender);
        assertEq(IERC20(mockERC20).balanceOf(lenderVault), pctx.lenderLeg, "lender's due in the lender vault");
        assertEq(IERC20(mockERC20).balanceOf(_scLender), 0, "nothing paid to the lender wallet at the sale");
        (, uint256 owed, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(TEST_LOAN_ID, true);
        assertEq(owed, pctx.lenderLeg, "the lender's claim names its due");
        assertFalse(claimed, "the lender has not claimed yet");
        assertEq(IERC20(mockERC20).balanceOf(_scBorrower), 3 ether, "borrower holder paid the remainder");

        LibVaipakam.Loan memory readBack = _readLoan(TEST_LOAN_ID);
        assertEq(
            uint256(readBack.status),
            uint256(LibVaipakam.LoanStatus.Repaid),
            "loan transitioned to Repaid"
        );
    }

    // ─── Internal helpers ───────────────────────────────────────────────

    function _scaffoldLoan(uint256 id, LibVaipakam.LoanStatus status) internal {
        LibVaipakam.Loan memory loan;
        loan.id = id;
        loan.lender = _scLender;
        loan.borrower = _scBorrower;
        loan.status = status;
        loan.principal = 100e18;
        loan.principalAsset = mockERC20;
        loan.lenderTokenId = 91_001;
        loan.borrowerTokenId = 91_002;
        loan.interestRateBps = 1_200;
        loan.startTime = uint64(block.timestamp);
        loan.durationDays = 30;
        // #2876 — the settlement resolves the live position holders, so the
        // two position NFTs exist. LibVPFIDiscount on a loan with no LIF state
        // is a no-op.
        TestMutatorFacet(address(diamond)).setLoan(id, loan);
        TestMutatorFacet(address(diamond)).mintNFTRaw(_scLender, loan.lenderTokenId);
        TestMutatorFacet(address(diamond)).mintNFTRaw(_scBorrower, loan.borrowerTokenId);
    }

    function _readLoan(uint256 id) internal view returns (LibVaipakam.Loan memory loan) {
        // Use the LoanFacet getter exposed by SetupTest's cut.
        // Imports inherited via SetupTest.
        bytes memory data = abi.encodeWithSignature("getLoanDetails(uint256)", id);
        (bool ok, bytes memory ret) = address(diamond).staticcall(data);
        require(ok, "getLoanDetails failed");
        loan = abi.decode(ret, (LibVaipakam.Loan));
    }
}
