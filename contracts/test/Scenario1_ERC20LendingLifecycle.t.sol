// test/Scenario1_ERC20LendingLifecycle.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title Scenario1_ERC20LendingLifecycle
 * @notice End-to-end scenario tests for ERC20 lending: happy-path repay+claim and default+claim.
 *         Uses two ERC20 tokens: mockUSDC (lending, Liquid) and mockWETH (collateral, Liquid).
 */
contract Scenario1_ERC20LendingLifecycle is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    address mockUSDC;
    address mockWETH;

    DiamondCutFacet cutFacet;
    OfferFacet offerFacet;
    OfferCancelFacet offerCancelFacet;
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
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    uint256 constant PRINCIPAL  = 1000 ether;
    uint256 constant COLLATERAL = 1500 ether;
    uint256 constant DURATION   = 30; // days
    uint256 constant RATE_BPS   = 500; // 5%
    uint256 constant TREASURY_FEE_BPS = 100; // 1%
    uint256 constant BASIS_POINTS = 10000;

    function mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset), abi.encode(status));
    }

    function mockPrice(address asset, uint256 price, uint8 dec) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset), abi.encode(price, dec));
    }

    function setUp() public {
        owner   = address(this);
        lender  = makeAddr("lender");
        borrower = makeAddr("borrower");

        // Deploy two ERC20 tokens
        mockUSDC = address(new ERC20Mock("MockUSDC", "USDC", 18));
        mockWETH = address(new ERC20Mock("MockWETH", "WETH", 18));

        // Mint tokens
        ERC20Mock(mockUSDC).mint(lender,   100000 ether);
        ERC20Mock(mockUSDC).mint(borrower, 100000 ether);
        ERC20Mock(mockWETH).mint(lender,   100000 ether);
        ERC20Mock(mockWETH).mint(borrower, 100000 ether);

        // Deploy facets
        cutFacet          = new DiamondCutFacet();
        diamond           = new VaipakamDiamond(owner, address(cutFacet));
        offerFacet        = new OfferFacet();
        offerCancelFacet = new OfferCancelFacet();
        profileFacet      = new ProfileFacet();
        oracleFacet       = new OracleFacet();
        nftFacet          = new VaipakamNFTFacet();
        escrowFacet       = new EscrowFactoryFacet();
        loanFacet         = new LoanFacet();
        riskFacet         = new RiskFacet();
        repayFacet        = new RepayFacet();
        defaultFacet      = new DefaultedFacet();
        adminFacet        = new AdminFacet();
        claimFacet        = new ClaimFacet();
        addCollateralFacet = new AddCollateralFacet();
        accessControlFacet = new AccessControlFacet();
        helperTest        = new HelperTest();

        // Cut all facets into diamond
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](14);
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
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(accessControlFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAccessControlFacetSelectors()});
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Initialize diamond admin state
        vm.prank(owner);
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(makeAddr("zeroEx"));
        AdminFacet(address(diamond)).setallowanceTarget(makeAddr("zeroEx"));

        // Token approvals to diamond
        vm.prank(lender);  ERC20(mockUSDC).approve(address(diamond), type(uint256).max);
        vm.prank(lender);  ERC20(mockWETH).approve(address(diamond), type(uint256).max);
        vm.prank(borrower); ERC20(mockUSDC).approve(address(diamond), type(uint256).max);
        vm.prank(borrower); ERC20(mockWETH).approve(address(diamond), type(uint256).max);

        // Country and KYC setup
        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        vm.prank(lender);  ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower); ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);

        // Risk params for WETH collateral
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockWETH, 8000, 8500, 300, 1000);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockUSDC, 8000, 8500, 300, 1000);

        // Mock oracle: both assets liquid, $1 price
        mockLiquidity(mockUSDC, LibVaipakam.LiquidityStatus.Liquid);
        mockLiquidity(mockWETH, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockUSDC, 1e8, 8);
        mockPrice(mockWETH, 1e8, 8);

        // Mock HF and LTV for loan initiation
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));

        // Create escrows and approve tokens to escrows
        address lenderEscrow  = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);

        vm.prank(lender);  ERC20(mockUSDC).approve(lenderEscrow, type(uint256).max);
        vm.prank(lender);  ERC20(mockWETH).approve(lenderEscrow, type(uint256).max);
        vm.prank(borrower); ERC20(mockUSDC).approve(borrowerEscrow, type(uint256).max);
        vm.prank(borrower); ERC20(mockWETH).approve(borrowerEscrow, type(uint256).max);
    }

    // ─── Scenario 1a: Happy Path — Create Offer, Accept, Repay, Both Claim ───

    function test_Scenario1a_CreateOffer_Accept_Repay_Claims() public {
        // Record initial balances
        uint256 lenderUSDCBefore  = IERC20(mockUSDC).balanceOf(lender);
        uint256 borrowerUSDCBefore = IERC20(mockUSDC).balanceOf(borrower);
        uint256 borrowerWETHBefore = IERC20(mockWETH).balanceOf(borrower);

        // Step 1: Lender creates offer
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockUSDC,
                amount: PRINCIPAL,
                interestRateBps: RATE_BPS,
                collateralAsset: mockWETH,
                collateralAmount: COLLATERAL,
                durationDays: DURATION,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: mockUSDC,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        // Step 2: Borrower accepts the offer (creates loan)
        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Verify loan is Active
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active));
        assertEq(loan.principal, PRINCIPAL);
        assertEq(loan.collateralAmount, COLLATERAL);

        // Step 3: Warp 15 days into the loan
        vm.warp(block.timestamp + 15 days);

        // Step 4: Borrower repays the loan
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // Verify loan is now Repaid
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));

        // Step 5: Lender claims (principal + interest - treasury fee)
        (, uint256 lenderClaimAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(lenderClaimAmount, 0, "Lender should have claimable amount");

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        // Verify lender received funds
        uint256 lenderUSDCAfterClaim = IERC20(mockUSDC).balanceOf(lender);
        assertEq(lenderUSDCAfterClaim - lenderUSDCBefore, lenderClaimAmount - PRINCIPAL, "Lender net gain should equal claim minus principal spent");

        // Step 6: Borrower claims (collateral returned)
        (, uint256 borrowerClaimAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertGt(borrowerClaimAmount, 0, "Borrower should have claimable collateral");

        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        // Step 7: Verify loan is now Settled after both claims
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled));

        // Verify borrower got collateral back
        uint256 borrowerWETHAfter = IERC20(mockWETH).balanceOf(borrower);
        assertEq(borrowerWETHAfter, borrowerWETHBefore, "Borrower should have collateral returned");
    }

    // ─── Scenario 1b: Default Path — Create Offer, Accept, Default, Lender Claims ───

    function test_Scenario1b_CreateOffer_Accept_Default_LenderClaims() public {
        // For the default test, use illiquid collateral path (simpler, no 0x swap needed).
        // Mock both assets as illiquid during offer creation to avoid MixedCollateralNotAllowed.
        mockLiquidity(mockUSDC, LibVaipakam.LiquidityStatus.Illiquid);
        mockLiquidity(mockWETH, LibVaipakam.LiquidityStatus.Illiquid);

        // Step 1: Lender creates offer with illiquid consent
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockUSDC,
                amount: PRINCIPAL,
                interestRateBps: RATE_BPS,
                collateralAsset: mockWETH,
                collateralAmount: COLLATERAL,
                durationDays: DURATION,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: mockUSDC,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        // Step 2: Borrower accepts with illiquid consent = true
        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Restore liquidity mocks after loan creation (for other operations)
        mockLiquidity(mockUSDC, LibVaipakam.LiquidityStatus.Liquid);
        // Keep WETH as illiquid for the default path
        mockLiquidity(mockWETH, LibVaipakam.LiquidityStatus.Illiquid);

        // Verify loan is Active
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active));

        // Step 3: Warp past maturity + grace period (30 days + 3 days grace for 30-day loan + 1)
        uint256 endTime = block.timestamp + 30 days;
        uint256 grace = LibVaipakam.gracePeriod(30);
        vm.warp(endTime + grace + 1);

        // Verify loan is defaultable
        assertTrue(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId), "Loan should be defaultable");

        // Step 4: Trigger default (permissionless)
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Verify loan is Defaulted
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));

        // Step 5: Verify lender has claimable collateral
        (address claimAsset, uint256 lenderClaimAmount, bool claimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(claimAsset, mockWETH, "Lender claim asset should be WETH collateral");
        assertEq(lenderClaimAmount, COLLATERAL, "Lender should claim full collateral");
        assertFalse(claimed, "Should not be claimed yet");

        // Step 6: Lender claims collateral
        uint256 lenderWETHBefore = IERC20(mockWETH).balanceOf(lender);

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        uint256 lenderWETHAfter = IERC20(mockWETH).balanceOf(lender);
        assertEq(lenderWETHAfter - lenderWETHBefore, COLLATERAL, "Lender should receive full collateral");

        // Step 7: Verify borrower has nothing to claim (illiquid default = full collateral to lender)
        (, uint256 borrowerClaimAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerClaimAmount, 0, "Borrower should have no claim after illiquid default");

        // Step 8: Loan should be Settled since lender claimed and borrower has no claim
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled));
    }

    // ─── Scenario 1c: Third-Party Repayment — Repayer != Borrower, collateral stays with borrower ───

    function test_Scenario1c_ThirdPartyRepays_BorrowerClaimsCollateral() public {
        address thirdParty = makeAddr("thirdParty");
        ERC20Mock(mockUSDC).mint(thirdParty, 100000 ether);

        // Step 1: Lender creates offer
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockUSDC,
                amount: PRINCIPAL,
                interestRateBps: RATE_BPS,
                collateralAsset: mockWETH,
                collateralAmount: COLLATERAL,
                durationDays: DURATION,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: mockUSDC,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        // Step 2: Borrower accepts the offer
        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Step 3: Warp 15 days
        vm.warp(block.timestamp + 15 days);

        // Step 4: Third party approves and repays on borrower's behalf
        vm.prank(thirdParty);
        ERC20(mockUSDC).approve(address(diamond), type(uint256).max);
        vm.prank(thirdParty);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // Verify loan is Repaid
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));

        // Step 5: Borrower (not third party) claims collateral back
        (, uint256 borrowerClaimAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerClaimAmount, COLLATERAL, "Borrower should claim full collateral");

        uint256 borrowerWETHBefore = IERC20(mockWETH).balanceOf(borrower);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        uint256 borrowerWETHAfter = IERC20(mockWETH).balanceOf(borrower);
        assertEq(borrowerWETHAfter - borrowerWETHBefore, COLLATERAL, "Borrower should receive full collateral");

        // Step 6: Verify third party has NO claim to collateral
        // (third party is not the borrower NFT holder, so claimAsBorrower would revert)
        vm.prank(thirdParty);
        vm.expectRevert();
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
    }
}
