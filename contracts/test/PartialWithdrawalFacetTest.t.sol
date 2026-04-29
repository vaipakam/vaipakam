// test/PartialWithdrawalFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title PartialWithdrawalFacetTest
 * @notice Tests PartialWithdrawalFacet: partialWithdrawCollateral and calculateMaxWithdrawable.
 */
contract PartialWithdrawalFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    address mockERC20;
    address mockCollateralERC20;
    address mockZeroExProxy;

    DiamondCutFacet cutFacet;
    OfferFacet offerFacet;
    ProfileFacet profileFacet;
    OracleFacet oracleFacet;
    VaipakamNFTFacet nftFacet;
    EscrowFactoryFacet escrowFacet;
    LoanFacet loanFacet;
    RiskFacet riskFacet;
    RepayFacet repayFacet;
    DefaultedFacet defaultFacet;
    AdminFacet adminFacet;
    ClaimFacet claimFacet;
    AddCollateralFacet addCollateralFacet;
    PartialWithdrawalFacet partialFacet;
    AccessControlFacet accessControlFacet;
    TestMutatorFacet testMutatorFacet;
    HelperTest helperTest;

    uint256 activeLoanId;
    uint256 constant PRINCIPAL   = 1000 ether;
    uint256 constant COLLATERAL  = 1800 ether;

    function mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset), abi.encode(status));
    }
    function mockPrice(address asset, uint256 price, uint8 dec) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset), abi.encode(price, dec));
    }

    function setUp() public {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");

        mockERC20 = address(new ERC20Mock("Token", "TKN", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockZeroExProxy = makeAddr("zeroEx");

        ERC20Mock(mockERC20).mint(lender, 100000 ether);
        ERC20Mock(mockERC20).mint(borrower, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(lender, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(borrower, 100000 ether);

        cutFacet = new DiamondCutFacet();
        diamond  = new VaipakamDiamond(owner, address(cutFacet));
        offerFacet = new OfferFacet();
        profileFacet = new ProfileFacet();
        oracleFacet = new OracleFacet();
        nftFacet = new VaipakamNFTFacet();
        escrowFacet = new EscrowFactoryFacet();
        loanFacet = new LoanFacet();
        riskFacet = new RiskFacet();
        repayFacet = new RepayFacet();
        defaultFacet = new DefaultedFacet();
        adminFacet = new AdminFacet();
        claimFacet = new ClaimFacet();
        addCollateralFacet = new AddCollateralFacet();
        partialFacet = new PartialWithdrawalFacet();
        accessControlFacet = new AccessControlFacet();
        testMutatorFacet = new TestMutatorFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](15);
        cuts[0]  = IDiamondCut.FacetCut({facetAddress: address(offerFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferFacetSelectors()});
        cuts[1]  = IDiamondCut.FacetCut({facetAddress: address(profileFacet),       action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getProfileFacetSelectors()});
        cuts[2]  = IDiamondCut.FacetCut({facetAddress: address(oracleFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOracleFacetSelectors()});
        cuts[3]  = IDiamondCut.FacetCut({facetAddress: address(nftFacet),           action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaipakamNFTFacetSelectors()});
        cuts[4]  = IDiamondCut.FacetCut({facetAddress: address(escrowFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getEscrowFactoryFacetSelectors()});
        cuts[5]  = IDiamondCut.FacetCut({facetAddress: address(loanFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getLoanFacetSelectors()});
        cuts[6]  = IDiamondCut.FacetCut({facetAddress: address(riskFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskFacetSelectors()});
        cuts[7]  = IDiamondCut.FacetCut({facetAddress: address(repayFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRepayFacetSelectors()});
        cuts[8]  = IDiamondCut.FacetCut({facetAddress: address(adminFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAdminFacetSelectors()});
        cuts[9]  = IDiamondCut.FacetCut({facetAddress: address(defaultFacet),       action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getDefaultedFacetSelectors()});
        cuts[10] = IDiamondCut.FacetCut({facetAddress: address(claimFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getClaimFacetSelectors()});
        cuts[11] = IDiamondCut.FacetCut({facetAddress: address(addCollateralFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAddCollateralFacetSelectors()});
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(partialFacet),       action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getPartialWithdrawalFacetSelectors()});
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(accessControlFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAccessControlFacetSelectors()});
        cuts[14] = IDiamondCut.FacetCut({facetAddress: address(testMutatorFacet),   action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getTestMutatorFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(mockZeroExProxy);
        AdminFacet(address(diamond)).setallowanceTarget(mockZeroExProxy);

        vm.prank(lender);   ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower); ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);   ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower); ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);

        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        vm.prank(lender);   ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower); ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);

        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 8500, 300, 1000);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 8500, 300, 1000);

        mockLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockERC20, 1e8, 8);
        mockLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockCollateralERC20, 1e8, 8);

        address lenderEscrow  = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        vm.prank(lender);   ERC20(mockERC20).approve(lenderEscrow, type(uint256).max);
        vm.prank(borrower); ERC20(mockERC20).approve(borrowerEscrow, type(uint256).max);
        vm.prank(lender);   ERC20(mockCollateralERC20).approve(lenderEscrow, type(uint256).max);
        vm.prank(borrower); ERC20(mockCollateralERC20).approve(borrowerEscrow, type(uint256).max);

        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
            })
        );
        vm.prank(borrower);
        activeLoanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ─── partialWithdrawCollateral reverts ───────────────────────────────────

    function testPartialWithdrawRevertsNotBorrower() public {
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotBorrower.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 100 ether);
    }

    function testPartialWithdrawRevertsLoanNotActive() public {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        loan.status = LibVaipakam.LoanStatus.Repaid;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.LoanNotActive.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 100 ether);
        // Restore status to Active
        loan.status = LibVaipakam.LoanStatus.Active;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);
    }

    function testPartialWithdrawRevertsAmountTooHigh() public {
        vm.prank(borrower);
        vm.expectRevert(PartialWithdrawalFacet.AmountTooHigh.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, COLLATERAL + 1);
    }

    function testPartialWithdrawRevertsAmountZero() public {
        vm.prank(borrower);
        vm.expectRevert(PartialWithdrawalFacet.AmountTooHigh.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 0);
    }

    function testPartialWithdrawRevertsIlliquidAsset() public {
        // Override liquidity to Illiquid
        mockLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Illiquid);

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.IlliquidAsset.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 100 ether);
    }

    function testPartialWithdrawRevertsHealthFactorTooLow() public {
        // Withdraw nearly all collateral → HF too low
        // 1800 - 1700 = 100 ether remaining collateral; HF = 100 * 0.85 / 1000 = 0.085 < 1.5
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.HealthFactorTooLow.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 1700 ether);
    }

    // ─── partialWithdrawCollateral success ───────────────────────────────────

    function testPartialWithdrawSuccess() public {
        // Withdraw small amount so HF stays above 1.5
        // After withdrawal: collateral = 1800 - 100 = 1700; HF = 1700 * 0.85 / 1000 = 1.445... < 1.5
        // Need to be more careful. Let's try 200 ether withdrawal:
        // After: 1800 - 200 = 1600; HF = 1600 * 0.85 / 1000 = 1.36 < 1.5. Still too low.
        // Let's try 100 ether: 1800 - 100 = 1700; still < 1.5.
        // With PRINCIPAL=1000, COLLATERAL=1800, price $1 each, liqThreshold=8500 bps:
        // HF = (collateral * 0.85) / principal
        // For HF >= 1.5: collateral * 0.85 >= 1500 → collateral >= 1765
        // Max withdrawal: 1800 - 1765 = 35 ether
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));

        vm.expectEmit(true, true, false, false);
        emit PartialWithdrawalFacet.PartialCollateralWithdrawn(activeLoanId, borrower, 30 ether, 0, 0);
        vm.prank(borrower);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(loan.collateralAmount, COLLATERAL - 30 ether);
    }

    // ─── calculateMaxWithdrawable ─────────────────────────────────────────────

    function testCalculateMaxWithdrawableReturnsZeroInactiveLoan() public view {
        assertEq(PartialWithdrawalFacet(address(diamond)).calculateMaxWithdrawable(999), 0);
    }

    function testCalculateMaxWithdrawableReturnsZeroIlliquid() public {
        mockLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Illiquid);
        assertEq(PartialWithdrawalFacet(address(diamond)).calculateMaxWithdrawable(activeLoanId), 0);
    }

    function testCalculateMaxWithdrawableReturnsPositive() public {
        uint256 maxAmount = PartialWithdrawalFacet(address(diamond)).calculateMaxWithdrawable(activeLoanId);
        // With 1800 collateral, 1000 principal, price $1, liqThreshold 8500 bps:
        // HF = (col * 0.85) / 1000 >= 1.5 → col >= 1765
        // max withdrawal = 1800 - 1765 = 35
        assertGt(maxAmount, 0);
        assertLe(maxAmount, 36 ether);
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Covers LTVExceeded branch in partialWithdrawCollateral.
    ///      Set a low maxLtvBps via updateRiskParams so post-withdrawal LTV exceeds it.
    function testPartialWithdrawRevertsLTVExceeded() public {
        // Set risk params: maxLtvBps=100 (1%), liqThresholdBps=9000, so HF passes but LTV fails
        // With collateral=1800, principal=10 (store low principal):
        //   HF = 1800*0.9/10 = 162 > 1.5 (passes)
        //   LTV_after_withdraw = borrowVal/collVal_after; even small withdrawal → LTV>1%
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 100, 9000, 300, 1000);

        // Set principal = 1000 ether; collateral = 1800 ether via mutator.
        // After withdrawal of 30: LTV = 1000/1770 * 10000 ≈ 5650 > maxLtvBps=100 → LTVExceeded
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        loan.principal = 1000 ether;
        loan.collateralAmount = 1800 ether;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.LTVExceeded.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);
        vm.clearMockedCalls();

        // Restore risk params
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 8500, 300, 1000);
    }

    /// @dev Covers CrossFacetCallFailed("Withdraw failed") in partialWithdrawCollateral
    function testPartialWithdrawCrossFacetFails() public {
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            "withdraw failed"
        );

        vm.expectRevert(bytes("withdraw failed"));
        vm.prank(borrower);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);
        vm.clearMockedCalls();
    }

    /// @dev Covers calculateMaxWithdrawable returns 0 when collateralAmount == 0
    function testCalculateMaxWithdrawableReturnsZeroWhenNoCollateral() public {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        loan.collateralAmount = 0;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);

        assertEq(PartialWithdrawalFacet(address(diamond)).calculateMaxWithdrawable(activeLoanId), 0);
    }
}
