// test/Scenario4_IlliquidCollateral.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
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
 * @title Scenario4_IlliquidCollateral
 * @notice Tests illiquid collateral default flow: both parties consent to illiquid,
 *         loan defaults past grace period, full collateral transfers to lender.
 *         Uses mockUSDC (lending, Liquid) and mockILLIQUID (collateral, Illiquid).
 */
contract Scenario4_IlliquidCollateral is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    address mockUSDC;     // Lending asset (Liquid)
    address mockILLIQUID; // Collateral asset (Illiquid)

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
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    uint256 constant PRINCIPAL  = 1000 ether;
    uint256 constant COLLATERAL = 1500 ether;
    uint256 constant DURATION   = 30; // days
    uint256 constant RATE_BPS   = 500; // 5%

    function mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset), abi.encode(status));
    }

    function mockPrice(address asset, uint256 price, uint8 dec) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset), abi.encode(price, dec));
    }

    function setUp() public {
        owner    = address(this);
        lender   = makeAddr("lender");
        borrower = makeAddr("borrower");

        // Deploy two ERC20 tokens
        mockUSDC     = address(new ERC20Mock("MockUSDC", "USDC", 18));
        mockILLIQUID = address(new ERC20Mock("MockIlliquid", "ILLQ", 18));

        // Mint tokens
        ERC20Mock(mockUSDC).mint(lender,   100000 ether);
        ERC20Mock(mockUSDC).mint(borrower, 100000 ether);
        ERC20Mock(mockILLIQUID).mint(borrower, 100000 ether);

        // Deploy facets
        cutFacet          = new DiamondCutFacet();
        diamond           = new VaipakamDiamond(owner, address(cutFacet));
        offerFacet        = new OfferFacet();
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
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](13);
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
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Initialize diamond admin state
        vm.prank(owner);
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(makeAddr("zeroEx"));
        AdminFacet(address(diamond)).setallowanceTarget(makeAddr("zeroEx"));

        // Token approvals to diamond
        vm.prank(lender);   ERC20(mockUSDC).approve(address(diamond), type(uint256).max);
        vm.prank(borrower); ERC20(mockUSDC).approve(address(diamond), type(uint256).max);
        vm.prank(borrower); ERC20(mockILLIQUID).approve(address(diamond), type(uint256).max);

        // Country and KYC setup
        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        vm.prank(lender);   ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower); ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);

        // Risk params
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockUSDC, 8000, 8500, 300, 1000);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockILLIQUID, 8000, 8500, 300, 1000);

        // Mock oracle: USDC = Liquid, ILLIQUID = Illiquid
        // During offer creation we need both to be illiquid to avoid MixedCollateralNotAllowed.
        // We set them correctly per-test.
        mockLiquidity(mockUSDC,     LibVaipakam.LiquidityStatus.Illiquid);
        mockLiquidity(mockILLIQUID, LibVaipakam.LiquidityStatus.Illiquid);
        mockPrice(mockUSDC, 1e8, 8);
        mockPrice(mockILLIQUID, 1e8, 8);

        // Mock HF and LTV for loan initiation
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));

        // Create escrows and approve tokens to escrows
        address lenderEscrow   = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);

        vm.prank(lender);   ERC20(mockUSDC).approve(lenderEscrow, type(uint256).max);
        vm.prank(borrower); ERC20(mockUSDC).approve(borrowerEscrow, type(uint256).max);
        vm.prank(borrower); ERC20(mockILLIQUID).approve(borrowerEscrow, type(uint256).max);
    }

    // ─── Scenario 4a: Illiquid Collateral Default — Full Transfer to Lender ───

    function test_Scenario4a_IlliquidCollateral_Default_FullTransferToLender() public {
        // Step 1: Lender creates offer with illiquid collateral consent
        // Both assets mocked as illiquid during setUp to avoid MixedCollateralNotAllowed
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockUSDC,
                amount: PRINCIPAL,
                interestRateBps: RATE_BPS,
                collateralAsset: mockILLIQUID,
                collateralAmount: COLLATERAL,
                durationDays: DURATION,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: mockUSDC,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0
            })
        );

        // Step 2: Borrower accepts with illiquid consent = true
        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Verify loan is Active with fallbackConsentFromBoth
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active));
        assertTrue(loan.fallbackConsentFromBoth, "Both parties should have consented to illiquid");
        assertEq(loan.principal, PRINCIPAL);
        assertEq(loan.collateralAmount, COLLATERAL);
        assertEq(loan.collateralAsset, mockILLIQUID);

        // Restore USDC to liquid after loan creation (for oracle checks during default)
        mockLiquidity(mockUSDC, LibVaipakam.LiquidityStatus.Liquid);
        // Keep ILLIQUID as illiquid
        mockLiquidity(mockILLIQUID, LibVaipakam.LiquidityStatus.Illiquid);

        // Step 3: Warp past maturity + grace period
        uint256 endTime = block.timestamp + 30 days;
        uint256 grace = LibVaipakam.gracePeriod(30);
        vm.warp(endTime + grace + 1);

        // Verify loan is defaultable
        assertTrue(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId), "Loan should be defaultable");

        // Step 4: Trigger default (permissionless — anyone can call)
        vm.expectEmit(true, false, false, true);
        emit DefaultedFacet.LoanDefaulted(loanId, true); // fallbackConsentFromBoth = true
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Step 5: Verify loan is Defaulted
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));

        // Step 6: Verify lender claimable = full collateral
        (address claimAsset, uint256 lenderClaimAmount, bool claimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(claimAsset, mockILLIQUID, "Lender claim asset should be illiquid collateral");
        assertEq(lenderClaimAmount, COLLATERAL, "Lender should claim full collateral amount");
        assertFalse(claimed, "Lender should not have claimed yet");

        // Step 7: Verify borrower has no claim (illiquid default = full transfer to lender)
        (, uint256 borrowerClaimAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerClaimAmount, 0, "Borrower should have no claim after illiquid default");

        // Step 8: Lender claims the collateral
        uint256 lenderILLQBefore = IERC20(mockILLIQUID).balanceOf(lender);

        vm.prank(lender);
        vm.expectEmit(true, true, false, true);
        emit ClaimFacet.LenderFundsClaimed(loanId, lender, mockILLIQUID, COLLATERAL);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        // Verify lender received the collateral
        uint256 lenderILLQAfter = IERC20(mockILLIQUID).balanceOf(lender);
        assertEq(lenderILLQAfter - lenderILLQBefore, COLLATERAL, "Lender should receive full collateral");

        // Verify claim is marked as done
        (,, bool lenderClaimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertTrue(lenderClaimed, "Lender claim should be marked as done");

        // Step 9: Loan should be Settled (lender claimed, borrower has nothing to claim)
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled));
    }
}
