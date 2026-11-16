// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {SettlementLegFacet} from "../src/facets/SettlementLegFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultOutflowFacet} from "../src/facets/VaultOutflowFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {WeirdERC20Mock} from "./mocks/WeirdERC20Mock.sol";
import {defaultQuote} from "./helpers/ForcedSaleQuote.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  WeirdErc20MatrixTest
 * @notice #1220 — the weird-ERC-20 sweep's matrix: each non-standard token
 *         behaviour against the settlement paths, one cell per pair. The
 *         required answers are in `docs/DesignsAndPlans/WeirdErc20HardeningSweepDesign.md`;
 *         fee-on-transfer, in both directions, is held by
 *         `MeasuredDeliveryTest` (#2440) and not repeated here.
 *
 *         Each cell turns ONE behaviour on by etching {WeirdERC20Mock} over
 *         a live `ERC20Mock` (it only appends state, so balances carry over),
 *         after the loan is open, the realistic way such a token reaches a
 *         live position.
 */
contract WeirdErc20MatrixTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant LENDER_TOKEN_ID = 7777;
    uint256 internal constant BORROWER_TOKEN_ID = 8888;
    uint256 internal constant PRINCIPAL = 500 ether;
    uint256 internal constant COLLATERAL = 1_000 ether;

    address internal col;

    function setUp() public {
        setupHelper();
        col = mockCollateralERC20;
    }

    // -- Helpers ------------------------------------------------------------

    function _weird(address token) internal returns (WeirdERC20Mock w) {
        vm.etch(token, address(new WeirdERC20Mock("Weird", "WRD", 18)).code);
        w = WeirdERC20Mock(token);
    }

    function _vault(address user) internal returns (address) {
        return VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function _tracked(address user, address token) internal view returns (uint256) {
        return VaultFactoryFacet(address(diamond)).getTrackedHolding(user, token, 0);
    }

    function _status() internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(address(diamond)).getLoanDetails(LOAN).status;
    }

    /// @dev An Active zero-rate 30-day ERC-20 loan, as `MeasuredDeliveryTest`
    ///      builds it: real position NFTs, the collateral liened in the
    ///      borrower's vault. `liquid` = both legs liquid at par; otherwise
    ///      both illiquid with both parties' consent (the in-kind branch).
    function _scaffold(bool liquid) internal {
        TestMutatorFacet(address(diamond)).mintNFTRaw(lender, LENDER_TOKEN_ID);
        TestMutatorFacet(address(diamond)).mintNFTRaw(borrower, BORROWER_TOKEN_ID);
        vm.startPrank(address(diamond));
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(
            LENDER_TOKEN_ID, LOAN, LibVaipakam.LoanPositionStatus.LoanInitiated
        );
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(
            BORROWER_TOKEN_ID, LOAN, LibVaipakam.LoanPositionStatus.LoanInitiated
        );
        vm.stopPrank();

        LibVaipakam.LiquidityStatus liq =
            liquid ? LibVaipakam.LiquidityStatus.Liquid : LibVaipakam.LiquidityStatus.Illiquid;

        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender;
        l.borrower = borrower;
        l.principalAsset = mockERC20;
        l.principal = PRINCIPAL;
        l.collateralAsset = col;
        l.collateralAmount = COLLATERAL;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.interestRateBps = 0;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        l.lenderTokenId = LENDER_TOKEN_ID;
        l.borrowerTokenId = BORROWER_TOKEN_ID;
        l.liquidationLtvBpsAtInit = 8_500;
        l.riskAndTermsConsentFromBoth = !liquid;
        l.principalLiquidity = liq;
        l.collateralLiquidity = liq;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);

        address bVault = _vault(borrower);
        ERC20Mock(col).mint(bVault, COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower, col, COLLATERAL);
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            LOAN, borrower, col, 0, COLLATERAL, LibVaipakam.AssetType.ERC20
        );
        mockOracleLiquidity(col, liq);
        mockOracleLiquidity(mockERC20, liq);
    }

    function _repay() internal {
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(LOAN);
    }

    function _default() internal {
        _triggerDefault(_pastGraceQuote());
    }

    /// @dev Past grace, and the sale quote the default needs (read before any
    ///      `expectRevert`, which would otherwise apply to this read).
    function _pastGraceQuote() internal returns (uint256) {
        vm.warp(block.timestamp + 61 days);
        return defaultQuote(address(diamond), LOAN);
    }

    function _triggerDefault(uint256 sellQuote) internal {
        vm.prank(makeAddr("defaultKeeper"));
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, sellQuote, defaultAdapterCalls());
    }

    // -- Blacklistable: a frozen party strands only its own leg ------------

    /// @notice The lender's WALLET is frozen in the lending asset. The
    ///         borrower's repayment and both claims still complete, because
    ///         every settlement lands in a vault. Only the lender's own leg
    ///         waits: a withdrawal to the frozen wallet fails, a withdrawal
    ///         may only go to the owner's own wallet, and the repayment stays
    ///         on the books in the lender's vault until the freeze lifts.
    function test_Frozen_LenderWallet_RepayAndClaimsComplete() public {
        _scaffold(true);
        vm.warp(block.timestamp + 10 days);
        WeirdERC20Mock w = _weird(mockERC20);
        w.setFrozen(lender, true);

        _repay();
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Repaid), "the repayment completed");

        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);
        uint256 owed = _tracked(lender, mockERC20);
        assertGe(owed, PRINCIPAL, "the lender's vault holds the repayment");

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(WeirdERC20Mock.AddressFrozen.selector, lender));
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            lender, uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, owed, lender
        );
        assertEq(_tracked(lender, mockERC20), owed, "the repayment waits in the lender's vault");

        w.setFrozen(lender, false);
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            lender, uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, owed, lender
        );
        assertEq(_tracked(lender, mockERC20), 0, "and pays out once the freeze lifts");
    }

    /// @notice The lender's VAULT is frozen in the lending asset.
    /// @dev    #3669: the repayment the token refuses parks in the
    ///         borrower's own vault, liened for the lender side, and the loan
    ///         is Repaid. The lender's claim releases it once the freeze lifts,
    ///         and fails while it holds, leaving the claim open.
    function test_Frozen_LenderVault_RepayParksThenClaimReleases() public {
        _scaffold(true);
        vm.warp(block.timestamp + 10 days);
        address lVault = _vault(lender);
        address bVault = _vault(borrower);
        WeirdERC20Mock w = _weird(mockERC20);
        w.setFrozen(lVault, true);

        _repay();
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Repaid), "the loan is Repaid");
        LibVaipakam.ParkedLeg memory leg = SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN);
        assertEq(leg.payer, borrower, "parked for the borrower as payer");
        assertEq(leg.amount, PRINCIPAL, "the whole leg parked");
        assertEq(_bal(mockERC20, bVault), PRINCIPAL, "it waits in the borrower's vault");
        assertEq(_bal(mockERC20, lVault), 0, "nothing reached the frozen vault");

        vm.prank(lender);
        vm.expectRevert();
        ClaimFacet(address(diamond)).claimAsLender(LOAN);
        assertEq(
            SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN).amount,
            PRINCIPAL,
            "the row stays while the token refuses"
        );

        w.setFrozen(lVault, false);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);
        assertEq(SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN).amount, 0, "row cleared");
        assertEq(_bal(mockERC20, bVault), 0, "the leg left the borrower's vault");
        assertEq(_tracked(lender, mockERC20), PRINCIPAL, "the lender's vault holds the repayment");
    }

    /// @notice The borrower's WALLET is frozen in the collateral asset. The
    ///         in-kind default still completes and pays the lender, because
    ///         the collateral sits in the borrower's vault.
    function test_Frozen_BorrowerWallet_InKindDefaultCompletes() public {
        _scaffold(false);
        _weird(col).setFrozen(borrower, true);

        _default();
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Defaulted), "the default completed");
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);
        assertEq(_tracked(lender, col), COLLATERAL, "the lender's vault holds the collateral");
    }

    /// @notice The borrower's VAULT is frozen in the collateral asset: the
    ///         collateral cannot move at all.
    /// @dev    #3669: the collateral stays in the borrower's vault under the
    ///         loan's lien and the loan is Defaulted. The lender's claim moves
    ///         it once the freeze lifts.
    function test_Frozen_BorrowerVault_InKindDefaultParksThenClaimReleases() public {
        _scaffold(false);
        address bVault = _vault(borrower);
        WeirdERC20Mock w = _weird(col);
        w.setFrozen(bVault, true);

        _default();
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Defaulted), "the loan is Defaulted");
        LibVaipakam.ParkedLeg memory leg = SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN);
        assertEq(leg.payer, borrower, "parked in the borrower's vault");
        assertEq(leg.amount, COLLATERAL, "the whole collateral parked");
        assertTrue(leg.collateralLien, "under the loan's collateral lien");
        assertEq(_bal(col, bVault), COLLATERAL, "the collateral never moved");

        vm.prank(lender);
        vm.expectRevert();
        ClaimFacet(address(diamond)).claimAsLender(LOAN);

        w.setFrozen(bVault, false);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);
        assertEq(SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN).amount, 0, "row cleared");
        assertEq(_tracked(lender, col), COLLATERAL, "the lender's vault holds the collateral");
        assertEq(_tracked(borrower, col), 0, "nothing left on the borrower's books");
    }

    /// @notice The lender's VAULT is frozen in the lending asset when a
    ///         liquid loan defaults.
    /// @dev    #3669: the sale's lender share parks in the borrower's vault,
    ///         liened for the lender side, the loan is Defaulted, and the
    ///         lender's claim releases the share once the freeze lifts.
    function test_Frozen_LenderVault_LiquidDefaultParksThenClaimReleases() public {
        _scaffold(true);
        address lVault = _vault(lender);
        address bVault = _vault(borrower);
        WeirdERC20Mock w = _weird(mockERC20);
        w.setFrozen(lVault, true);
        uint256 bBefore = _bal(mockERC20, bVault);

        _default();
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Defaulted), "the loan is Defaulted");
        LibVaipakam.ParkedLeg memory leg = SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN);
        assertEq(leg.payer, borrower, "parked in the borrower's vault");
        assertGt(leg.amount, 0, "the lender share parked");
        assertFalse(leg.collateralLien, "under its own lien");
        uint256 bAfter = _bal(mockERC20, bVault);
        // The borrower's vault also holds the sale's extra for the borrower.
        assertGe(bAfter - bBefore, leg.amount, "it waits in the borrower's vault");
        assertEq(_bal(mockERC20, lVault), 0, "nothing reached the frozen vault");

        vm.prank(lender);
        vm.expectRevert();
        ClaimFacet(address(diamond)).claimAsLender(LOAN);

        w.setFrozen(lVault, false);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);
        assertEq(SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN).amount, 0, "row cleared");
        assertEq(_bal(mockERC20, bVault), bAfter - leg.amount, "exactly the share left the borrower's vault");
        assertEq(_tracked(lender, mockERC20), leg.amount, "the lender's vault holds it");
    }

    /// @notice The TREASURY is frozen in the lending asset.
    /// @dev    #3669: the repayment completes, and the treasury share waits,
    ///         liened, in the borrower's vault until anyone releases it to the
    ///         treasury once the freeze lifts.
    function test_Frozen_Treasury_RepayParksShareThenReleases() public {
        _scaffold(true);
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(LOAN);
        l.interestRateBps = 1_000;
        TestMutatorFacet(address(diamond)).setLoan(LOAN, l);
        vm.warp(block.timestamp + 10 days);
        address treasury = AdminFacet(address(diamond)).getTreasury();
        address bVault = _vault(borrower);
        WeirdERC20Mock w = _weird(mockERC20);
        w.setFrozen(treasury, true);

        _repay();
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Repaid), "the repayment completed");
        uint256 parked = SettlementLegFacet(address(diamond)).getParkedTreasury(borrower, mockERC20);
        assertGt(parked, 0, "the treasury share parked");
        assertEq(_bal(mockERC20, bVault), parked, "it waits in the borrower's vault");

        vm.expectRevert();
        SettlementLegFacet(address(diamond)).releaseParkedTreasury(borrower, mockERC20);

        w.setFrozen(treasury, false);
        uint256 before = _bal(mockERC20, treasury);
        vm.prank(makeAddr("anyone"));
        SettlementLegFacet(address(diamond)).releaseParkedTreasury(borrower, mockERC20);
        assertEq(_bal(mockERC20, treasury) - before, parked, "the treasury received it");
        assertEq(SettlementLegFacet(address(diamond)).getParkedTreasury(borrower, mockERC20), 0, "row cleared");
        assertEq(_bal(mockERC20, bVault), 0, "nothing left in the borrower's vault");
    }

    // -- Paused: every path refuses, and resumes on unpause ------------------

    function test_Paused_RepayRefusedThenResumes() public {
        _scaffold(true);
        vm.warp(block.timestamp + 10 days);
        WeirdERC20Mock w = _weird(mockERC20);
        w.setPaused(true);

        vm.expectRevert(WeirdERC20Mock.TokenPaused.selector);
        _repay();
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Active), "the loan stays open");

        w.setPaused(false);
        _repay();
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Repaid), "the repayment completes on unpause");
    }

    // -- False return: never read as a payment -------------------------------

    function test_FalseReturn_RepayRefused() public {
        _scaffold(true);
        vm.warp(block.timestamp + 10 days);
        _weird(mockERC20).setReturnsFalse(true);

        vm.expectRevert();
        _repay();
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Active), "the loan stays open");
    }

    // -- Rebasing --------------------------------------------------------------

    /// @notice A negative rebase leaves the borrower's vault holding less
    ///         collateral than the books track. The design's answer is a
    ///         VISIBLE failure at settlement that moves nothing, never a
    ///         payment out of anyone else's tokens.
    function test_RebaseDown_InKindDefault_FailsVisibly() public {
        _scaffold(false);
        address bVault = _vault(borrower);
        _weird(col).rebase(bVault, COLLATERAL / 2);
        address lVault = _vault(lender);

        uint256 q = _pastGraceQuote();
        vm.expectPartialRevert(VaultOutflowFacet.WithdrawWouldUnderflowLien.selector);
        _triggerDefault(q);
        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Active), "the loan stays open");
        assertEq(_bal(col, bVault), COLLATERAL / 2, "nothing left the borrower's vault");
        assertEq(_bal(col, lVault), 0, "nothing reached the lender");
    }

    /// @notice A positive rebase leaves the borrower's vault holding more than
    ///         the books track. The lender is owed the tracked collateral and
    ///         the surplus stays with the vault's owner.
    function test_RebaseUp_InKindDefault_SurplusStaysWithOwner() public {
        _scaffold(false);
        address bVault = _vault(borrower);
        _weird(col).rebase(bVault, COLLATERAL * 2);

        _default();
        (, uint256 claim, ) = ClaimFacet(address(diamond)).getClaimableAmount(LOAN, true);
        assertEq(claim, COLLATERAL, "the lender's claim is the tracked collateral");
        assertEq(_bal(col, bVault), COLLATERAL, "the surplus stays in the borrower's vault");
    }
}
