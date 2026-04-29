// test/Scenario2b_ERC1155RentalLending.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {ERC1155RentableMock} from "./mocks/ERC1155RentableMock.sol";
import {HelperTest} from "./HelperTest.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ZeroExProxyMock} from "./mocks/ZeroExProxyMock.sol";
import {MockZeroExLegacyAdapter} from "./mocks/MockZeroExLegacyAdapter.sol";

/**
 * @title Scenario2b_ERC1155RentalLending
 * @notice End-to-end NFT rental lending lifecycle tests for ERC-1155.
 *         Mirrors Scenario 2a (ERC-721) but exercises the ERC-1155 quantity
 *         path: lender offers 5 of token id 1, daily fee 10e18, 7-day
 *         duration. Prepay = 7*10 + 5% buffer = 73.5e18.
 */
contract Scenario2b_ERC1155RentalLending is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    address mockUSDC;
    address mockNFT1155;
    address mockZeroExProxy;

    uint256 constant BASIS_POINTS = 10000;
    uint256 constant TREASURY_FEE_BPS = 100; // 1%
    uint256 constant RENTAL_BUFFER_BPS = 500; // 5%

    uint256 constant DAILY_FEE = 10 ether; // daily fee for the 5-token bundle
    uint256 constant DURATION_DAYS = 7;
    uint256 constant QUANTITY = 5;
    uint256 constant TOKEN_ID = 1;
    uint256 constant TOTAL_RENTAL = DAILY_FEE * DURATION_DAYS; // 70 ether
    uint256 constant BUFFER = (TOTAL_RENTAL * RENTAL_BUFFER_BPS) / BASIS_POINTS; // 3.5 ether
    uint256 constant TOTAL_PREPAY = TOTAL_RENTAL + BUFFER; // 73.5 ether

    DiamondCutFacet cutFacet;
    OfferFacet offerFacet;
    ProfileFacet profileFacet;
    OracleFacet oracleFacet;
    VaipakamNFTFacet nftFacet;
    EscrowFactoryFacet escrowFacet;
    LoanFacet loanFacet;
    DefaultedFacet defaultFacet;
    RiskFacet riskFacet;
    RepayFacet repayFacet;
    AdminFacet adminFacet;
    ClaimFacet claimFacet;
    AddCollateralFacet addCollateralFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;
    VaipakamEscrowImplementation escrowImpl;

    address lenderEscrow;
    address borrowerEscrow;

    function mockOracleLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset),
            abi.encode(status)
        );
    }

    function mockOraclePrice(address asset, uint256 price, uint8 decimals) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encode(price, decimals)
        );
    }

    function setUp() public {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");

        mockUSDC = address(new ERC20Mock("MockUSDC", "USDC", 18));
        mockNFT1155 = address(new ERC1155RentableMock());
        mockZeroExProxy = address(new ZeroExProxyMock());

        ERC20Mock(mockUSDC).mint(borrower, 100_000 ether);
        ERC1155RentableMock(mockNFT1155).mint(lender, TOKEN_ID, 10);

        ERC20Mock(mockUSDC).mint(address(mockZeroExProxy), 1_000_000 ether);
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10);

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        offerFacet = new OfferFacet();
        profileFacet = new ProfileFacet();
        oracleFacet = new OracleFacet();
        nftFacet = new VaipakamNFTFacet();
        escrowFacet = new EscrowFactoryFacet();
        loanFacet = new LoanFacet();
        defaultFacet = new DefaultedFacet();
        riskFacet = new RiskFacet();
        repayFacet = new RepayFacet();
        adminFacet = new AdminFacet();
        claimFacet = new ClaimFacet();
        addCollateralFacet = new AddCollateralFacet();
        accessControlFacet = new AccessControlFacet();
        helperTest = new HelperTest();
        escrowImpl = new VaipakamEscrowImplementation();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](13);
        cuts[0] = IDiamondCut.FacetCut({facetAddress: address(offerFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferFacetSelectors()});
        cuts[1] = IDiamondCut.FacetCut({facetAddress: address(profileFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getProfileFacetSelectors()});
        cuts[2] = IDiamondCut.FacetCut({facetAddress: address(oracleFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOracleFacetSelectors()});
        cuts[3] = IDiamondCut.FacetCut({facetAddress: address(nftFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaipakamNFTFacetSelectors()});
        cuts[4] = IDiamondCut.FacetCut({facetAddress: address(escrowFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getEscrowFactoryFacetSelectors()});
        cuts[5] = IDiamondCut.FacetCut({facetAddress: address(loanFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getLoanFacetSelectors()});
        cuts[6] = IDiamondCut.FacetCut({facetAddress: address(riskFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskFacetSelectors()});
        cuts[7] = IDiamondCut.FacetCut({facetAddress: address(repayFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRepayFacetSelectors()});
        cuts[8] = IDiamondCut.FacetCut({facetAddress: address(adminFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAdminFacetSelectors()});
        cuts[9] = IDiamondCut.FacetCut({facetAddress: address(defaultFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getDefaultedFacetSelectors()});
        cuts[10] = IDiamondCut.FacetCut({facetAddress: address(claimFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getClaimFacetSelectors()});
        cuts[11] = IDiamondCut.FacetCut({facetAddress: address(addCollateralFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAddCollateralFacetSelectors()});
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(accessControlFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAccessControlFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(mockZeroExProxy);
        AdminFacet(address(diamond)).setallowanceTarget(mockZeroExProxy);

        // Phase 7a: register the legacy ZeroEx shim as adapter slot 0
        // so triggerLiquidation / triggerDefault / claimAsLenderWithRetry
        // route through LibSwap into the existing ZeroExProxyMock.
        AdminFacet(address(diamond)).addSwapAdapter(
            address(new MockZeroExLegacyAdapter(address(mockZeroExProxy)))
        );

        vm.prank(borrower);
        ERC20(mockUSDC).approve(address(diamond), type(uint256).max);

        mockOracleLiquidity(mockUSDC, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockNFT1155, LibVaipakam.LiquidityStatus.Illiquid);
        mockOraclePrice(mockUSDC, 1e8, 8);
        mockOraclePrice(mockNFT1155, 1e8, 8);
        vm.mockCall(
            mockNFT1155,
            abi.encodeWithSelector(IERC20Metadata.decimals.selector),
            abi.encode(uint8(18))
        );

        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower);
        ProfileFacet(address(diamond)).setUserCountry("US");

        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(2e18)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(5000)
        );

        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockUSDC, 8000, 8500, 300, 1000);

        lenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);

        vm.prank(borrower);
        ERC20(mockUSDC).approve(borrowerEscrow, type(uint256).max);
        vm.prank(lender);
        ERC20(mockUSDC).approve(lenderEscrow, type(uint256).max);
        vm.prank(lender);
        IERC1155(mockNFT1155).setApprovalForAll(address(diamond), true);
        vm.prank(lender);
        IERC1155(mockNFT1155).setApprovalForAll(lenderEscrow, true);
    }

    /// @dev Creates the lender's ERC1155 rental offer and has the borrower accept.
    function _createAndAcceptNFTRental() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockNFT1155),
                amount: DAILY_FEE,
                interestRateBps: 0,
                collateralAsset: mockUSDC,
                collateralAmount: TOTAL_PREPAY,
                durationDays: DURATION_DAYS,
                assetType: LibVaipakam.AssetType.ERC1155,
                tokenId: TOKEN_ID,
                quantity: QUANTITY,
                creatorFallbackConsent: true,
                prepayAsset: mockUSDC,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false
            })
        );

        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        loanId = 1;
    }

    /**
     * @notice Scenario 2b — ERC1155 Rental Full Lifecycle (Happy Path)
     *         1. Lender creates offer (5 of id 1) → escrow holds the tokens
     *         2. Borrower accepts → prepay locked, user rights set
     *         3. Warp 7 days, borrower repays
     *         4. Lender claims → rental fees minus treasury, ERC1155 returned
     *         5. Borrower claims → buffer refund
     *         6. Loan Settled
     */
    function test_Scenario2b_ERC1155Rental_FullLifecycle() public {
        uint256 borrowerUSDCBefore = IERC20(mockUSDC).balanceOf(borrower);

        // Precondition: full 10-unit bundle in lender's wallet.
        assertEq(
            IERC1155(mockNFT1155).balanceOf(lender, TOKEN_ID),
            10,
            "Lender starts with the full 10 bundle"
        );

        uint256 loanId = _createAndAcceptNFTRental();

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.principal, DAILY_FEE, "principal should be the daily fee");
        assertEq(loan.durationDays, DURATION_DAYS, "duration 7 days");
        assertEq(loan.prepayAsset, mockUSDC, "prepay asset should be USDC");
        assertEq(uint8(loan.assetType), uint8(LibVaipakam.AssetType.ERC1155), "ERC1155 asset type");
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active), "loan Active");
        assertEq(loan.lender, lender, "lender mismatch");
        assertEq(loan.borrower, borrower, "borrower mismatch");
        assertEq(loan.tokenId, TOKEN_ID, "token id should be 1");
        assertEq(loan.quantity, QUANTITY, "quantity should be 5");
        assertEq(loan.principalAsset, address(mockNFT1155), "principal asset should be the ERC1155");

        // Bundle still sits in lender's escrow while the rental is live.
        assertEq(
            IERC1155(mockNFT1155).balanceOf(lenderEscrow, TOKEN_ID),
            QUANTITY,
            "Escrow retains ERC1155 while rental is live"
        );
        assertEq(
            IERC1155(mockNFT1155).balanceOf(borrower, TOKEN_ID),
            0,
            "Borrower never physically holds the ERC1155 (user rights only)"
        );

        vm.warp(block.timestamp + DURATION_DAYS * 1 days);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid), "loan Repaid");

        (address lenderClaimAsset, uint256 lenderClaimAmount, bool lenderClaimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(lenderClaimAsset, mockUSDC, "lender claim asset USDC");
        assertFalse(lenderClaimed, "lender not yet claimed");

        uint256 treasuryShare = (TOTAL_RENTAL * TREASURY_FEE_BPS) / BASIS_POINTS;
        uint256 expectedLenderShare = TOTAL_RENTAL - treasuryShare;
        assertEq(lenderClaimAmount, expectedLenderShare, "lender claim amount mismatch");

        uint256 lenderUSDCBefore = IERC20(mockUSDC).balanceOf(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        assertEq(
            IERC20(mockUSDC).balanceOf(lender),
            lenderUSDCBefore + expectedLenderShare,
            "lender USDC balance mismatch after claim"
        );
        // ERC1155 returned from escrow to lender
        assertEq(
            IERC1155(mockNFT1155).balanceOf(lender, TOKEN_ID),
            10, // back to full bundle
            "ERC1155 bundle returned to lender on claim"
        );
        assertEq(
            IERC1155(mockNFT1155).balanceOf(lenderEscrow, TOKEN_ID),
            0,
            "Escrow drained after claim"
        );

        (address borrowerClaimAsset, uint256 borrowerClaimAmount, bool borrowerClaimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerClaimAsset, mockUSDC, "borrower claim asset USDC");
        assertFalse(borrowerClaimed, "borrower not yet claimed");
        assertEq(borrowerClaimAmount, BUFFER, "borrower refund should be the buffer");

        uint256 borrowerUSDCBeforeClaim = IERC20(mockUSDC).balanceOf(borrower);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        assertEq(
            IERC20(mockUSDC).balanceOf(borrower),
            borrowerUSDCBeforeClaim + BUFFER,
            "borrower USDC balance mismatch after claim"
        );

        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled), "loan Settled");

        uint256 borrowerUSDCAfter = IERC20(mockUSDC).balanceOf(borrower);
        uint256 borrowerSpent = borrowerUSDCBefore - borrowerUSDCAfter;
        assertEq(borrowerSpent, TOTAL_RENTAL, "net cost should equal total rental");
    }

    /**
     * @notice Scenario 2b — ERC1155 Rental Default Path
     *         Warps past duration + grace, permissionless defaultOrLiquidate,
     *         lender gets full prepay (minus treasury) + bundle; borrower claim = 0.
     */
    function test_Scenario2b_ERC1155Rental_Default() public {
        uint256 loanId = _createAndAcceptNFTRental();

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active), "loan Active");

        // Bundle parked in lender's escrow while rental is live.
        assertEq(
            IERC1155(mockNFT1155).balanceOf(lenderEscrow, TOKEN_ID),
            QUANTITY,
            "escrow holds rental bundle"
        );

        uint256 endTime = loan.startTime + DURATION_DAYS * 1 days;
        uint256 gracePeriod = 1 days;
        vm.warp(endTime + gracePeriod + 1);

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted), "loan Defaulted");

        (address lenderClaimAsset, uint256 lenderClaimAmount, bool lenderClaimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(lenderClaimAsset, mockUSDC, "lender claim asset USDC");
        assertFalse(lenderClaimed, "lender not yet claimed");

        uint256 defaultTreasuryFee = (TOTAL_RENTAL * TREASURY_FEE_BPS) / BASIS_POINTS;
        uint256 expectedLenderDefault = TOTAL_RENTAL - defaultTreasuryFee;
        assertEq(
            lenderClaimAmount,
            expectedLenderDefault,
            "lender should get prepay minus treasury on default"
        );

        uint256 lenderUSDCBefore = IERC20(mockUSDC).balanceOf(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        assertEq(
            IERC20(mockUSDC).balanceOf(lender),
            lenderUSDCBefore + expectedLenderDefault,
            "lender USDC mismatch after default claim"
        );
        // ERC1155 returned to lender on default (rental bundle reverts to owner)
        assertEq(
            IERC1155(mockNFT1155).balanceOf(lender, TOKEN_ID),
            10,
            "ERC1155 bundle returned to lender on default"
        );

        (, uint256 borrowerClaimAmount,) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerClaimAmount, 0, "borrower has no claim on default");
    }
}
