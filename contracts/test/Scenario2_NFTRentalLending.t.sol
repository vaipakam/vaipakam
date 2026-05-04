// test/Scenario2_NFTRentalLending.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
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
import {HelperTest} from "./HelperTest.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ZeroExProxyMock} from "./mocks/ZeroExProxyMock.sol";
import {MockZeroExLegacyAdapter} from "./mocks/MockZeroExLegacyAdapter.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";

/**
 * @title Scenario2_NFTRentalLending
 * @notice End-to-end NFT rental lending lifecycle tests.
 *         Scenario 2a: Full lifecycle (repay) and default path for ERC721 rentals.
 *         Daily rental fee = 10 ether, duration = 7 days.
 *         Total rental = 70 ether, buffer (5%) = 3.5 ether, total prepay = 73.5 ether.
 *         Treasury fee = 1% of rental fees.
 */
contract Scenario2_NFTRentalLending is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    address mockUSDC;
    address mockNFT721;
    address mockZeroExProxy;

    uint256 constant BASIS_POINTS = 10000;
    uint256 constant TREASURY_FEE_BPS = 100; // 1%
    uint256 constant RENTAL_BUFFER_BPS = 500; // 5%

    uint256 constant DAILY_FEE = 10 ether;
    uint256 constant DURATION_DAYS = 7;
    uint256 constant TOTAL_RENTAL = DAILY_FEE * DURATION_DAYS; // 70 ether
    uint256 constant BUFFER = (TOTAL_RENTAL * RENTAL_BUFFER_BPS) / BASIS_POINTS; // 3.5 ether
    uint256 constant TOTAL_PREPAY = TOTAL_RENTAL + BUFFER; // 73.5 ether

    // Facet instances
    DiamondCutFacet cutFacet;
    OfferFacet offerFacet;
    OfferCancelFacet offerCancelFacet;
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

    // ─── Mock Helpers ────────────────────────────────────────────────────────

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

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");

        // Deploy mocks
        mockUSDC = address(new ERC20Mock("MockUSDC", "USDC", 18));
        mockNFT721 = address(new MockRentableNFT721());
        mockZeroExProxy = address(new ZeroExProxyMock());

        // Mint assets
        ERC20Mock(mockUSDC).mint(borrower, 100_000 ether);
        // Lender does not need USDC
        MockRentableNFT721(mockNFT721).mint(lender, 1);

        // Mint to ZeroEx mock for any liquidation proceeds
        ERC20Mock(mockUSDC).mint(address(mockZeroExProxy), 1_000_000 ether);
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10);

        // Deploy facets
        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        offerFacet = new OfferFacet();
        offerCancelFacet = new OfferCancelFacet();
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

        // Cut all facets into diamond
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](14);
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
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Initialize admin state
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

        // Token approvals to diamond
        vm.prank(lender);
        MockRentableNFT721(mockNFT721).approve(address(diamond), 1);
        vm.prank(borrower);
        ERC20(mockUSDC).approve(address(diamond), type(uint256).max);

        // Oracle mocks: USDC = Liquid ($1), NFT = Illiquid
        mockOracleLiquidity(mockUSDC, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockNFT721, LibVaipakam.LiquidityStatus.Illiquid);
        mockOraclePrice(mockUSDC, 1e8, 8); // $1 with 8 decimals
        // Mock NFT price for DefaultedFacet KYC check (principalAsset = NFT)
        mockOraclePrice(mockNFT721, 1e8, 8);
        // Mock decimals() on the NFT contract (DefaultedFacet calls IERC20Metadata.decimals on principalAsset)
        vm.mockCall(
            mockNFT721,
            abi.encodeWithSelector(IERC20Metadata.decimals.selector),
            abi.encode(uint8(18))
        );

        // Country setup and trade allowance
        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower);
        ProfileFacet(address(diamond)).setUserCountry("US");

        // KYC Tier2 for both
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);

        // Mock RiskFacet: HF 2e18, LTV 5000
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

        // Risk params for USDC collateral
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockUSDC, 8000, 8500, 300, 1000);

        // Create escrows for both parties (must happen before escrow approvals)
        lenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);

        // Escrow approvals
        vm.prank(borrower);
        ERC20(mockUSDC).approve(borrowerEscrow, type(uint256).max);
        vm.prank(lender);
        ERC20(mockUSDC).approve(lenderEscrow, type(uint256).max);
        vm.prank(lender);
        IERC721(mockNFT721).setApprovalForAll(lenderEscrow, true);
    }

    // ─── Internal Helpers ────────────────────────────────────────────────────

    /// @dev Creates a lender NFT rental offer and has borrower accept it.
    ///      Returns the loanId (always 1 for the first loan).
    function _createAndAcceptNFTRental() internal returns (uint256 loanId) {
        // Lender creates offer
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockNFT721),
                amount: DAILY_FEE,
                interestRateBps: 0,
                collateralAsset: mockUSDC,
                collateralAmount: TOTAL_PREPAY,
                durationDays: DURATION_DAYS,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: 1,
                quantity: 1,
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

        // Borrower accepts offer
        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        loanId = 1; // First loan
    }

    // ─── Test: Full Lifecycle (Happy Path) ───────────────────────────────────

    /**
     * @notice Scenario 2a - ERC721 Rental Full Lifecycle (Happy Path)
     *         1. Lender creates rental offer -> NFT transferred to lender's escrow
     *         2. Borrower accepts -> prepay locked (70 + 3.5 USDC), user rights set
     *         3. Warp 7 days, borrower calls repayLoan
     *         4. Loan status = Repaid
     *         5. Lender claims -> gets rental fees (minus treasury fee) + NFT returned from escrow
     *         6. Borrower claims -> gets buffer refund
     *         7. Verify balances
     */
    function test_Scenario2a_ERC721Rental_FullLifecycle() public {
        uint256 borrowerUSDCBefore = IERC20(mockUSDC).balanceOf(borrower);

        // Step 1 & 2: Create offer and accept
        uint256 loanId = _createAndAcceptNFTRental();

        // Verify loan details
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.principal, DAILY_FEE, "Principal should be daily rental fee");
        assertEq(loan.durationDays, DURATION_DAYS, "Duration should be 7 days");
        assertEq(loan.prepayAsset, mockUSDC, "Prepay asset should be USDC");
        assertEq(uint8(loan.assetType), uint8(LibVaipakam.AssetType.ERC721), "Asset type should be ERC721");
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active), "Loan should be Active");
        assertEq(loan.lender, lender, "Lender mismatch");
        assertEq(loan.borrower, borrower, "Borrower mismatch");
        assertEq(loan.tokenId, 1, "Token ID should be 1");
        assertEq(loan.principalAsset, address(mockNFT721), "Principal asset should be NFT");

        // Verify NFT is in lender's escrow
        assertEq(
            IERC721(mockNFT721).ownerOf(1),
            lenderEscrow,
            "NFT should be in lender's escrow after offer creation"
        );

        // Step 3: Warp 7 days (full duration)
        vm.warp(block.timestamp + 7 days);

        // Step 4: Borrower repays
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // Verify loan status is Repaid
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid), "Loan should be Repaid");

        // Step 5: Lender claims rental fees + NFT
        // Check lender claimable
        (address lenderClaimAsset, uint256 lenderClaimAmount, bool lenderClaimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(lenderClaimAsset, mockUSDC, "Lender claim asset should be USDC");
        assertFalse(lenderClaimed, "Lender should not have claimed yet");

        // Rental fees minus treasury: totalRental * 99% = 70 * 0.99 = 69.3
        uint256 treasuryShare = (TOTAL_RENTAL * TREASURY_FEE_BPS) / BASIS_POINTS;
        uint256 expectedLenderShare = TOTAL_RENTAL - treasuryShare;
        assertEq(lenderClaimAmount, expectedLenderShare, "Lender claim amount mismatch");

        uint256 lenderUSDCBefore = IERC20(mockUSDC).balanceOf(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        // Verify lender received USDC and NFT
        assertEq(
            IERC20(mockUSDC).balanceOf(lender),
            lenderUSDCBefore + expectedLenderShare,
            "Lender USDC balance mismatch after claim"
        );
        assertEq(
            IERC721(mockNFT721).ownerOf(1),
            lender,
            "NFT should be returned to lender after claim"
        );

        // Step 6: Borrower claims buffer refund
        (address borrowerClaimAsset, uint256 borrowerClaimAmount, bool borrowerClaimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerClaimAsset, mockUSDC, "Borrower claim asset should be USDC");
        assertFalse(borrowerClaimed, "Borrower should not have claimed yet");

        // Borrower refund = unused prepay + buffer = (73.5 - 70) + 0 = buffer only = 3.5 ether
        // Actually: refund = prepayAmount - totalDue + bufferAmount
        // totalDue = interest + lateFee = 70 + 0 = 70
        // refund = 70 - 70 + 3.5 = 3.5
        assertEq(borrowerClaimAmount, BUFFER, "Borrower claim amount should be the buffer refund");

        uint256 borrowerUSDCBeforeClaim = IERC20(mockUSDC).balanceOf(borrower);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        assertEq(
            IERC20(mockUSDC).balanceOf(borrower),
            borrowerUSDCBeforeClaim + BUFFER,
            "Borrower USDC balance mismatch after claim"
        );

        // Step 7: Verify loan is settled
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled), "Loan should be Settled");

        // Verify net cost to borrower = totalRental (70 ether) since buffer was refunded
        uint256 borrowerUSDCAfter = IERC20(mockUSDC).balanceOf(borrower);
        uint256 borrowerSpent = borrowerUSDCBefore - borrowerUSDCAfter;
        assertEq(borrowerSpent, TOTAL_RENTAL, "Borrower net cost should equal total rental");
    }

    // ─── Test: Default Path ──────────────────────────────────────────────────

    /**
     * @notice Scenario 2a - ERC721 Rental Default Path
     *         1. Same offer/accept setup
     *         2. Warp past duration + grace period
     *         3. triggerDefault called
     *         4. Lender claims -> gets prepay (full rental) + NFT returned from escrow
     *         5. Buffer goes to treasury
     *         6. Verify loan status = Defaulted
     */
    function test_Scenario2a_ERC721Rental_Default() public {
        // Step 1: Create offer and accept
        uint256 loanId = _createAndAcceptNFTRental();

        // Verify loan is active
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active), "Loan should be Active");

        // Verify NFT is in lender's escrow
        assertEq(
            IERC721(mockNFT721).ownerOf(1),
            lenderEscrow,
            "NFT should be in lender's escrow"
        );

        // Step 2: Warp past duration + grace period
        // For 7-day loans, grace period = 1 day (from LibVaipakam.gracePeriod: durationDays < 30 => 1 day)
        uint256 endTime = loan.startTime + DURATION_DAYS * 1 days;
        uint256 gracePeriod = 1 days; // For durationDays >= 7 and < 30
        vm.warp(endTime + gracePeriod + 1); // Past grace

        // Step 3: Trigger default (permissionless)
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Step 4: Verify loan status = Defaulted
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted), "Loan should be Defaulted");

        // Step 5: Lender claims
        (address lenderClaimAsset, uint256 lenderClaimAmount, bool lenderClaimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(lenderClaimAsset, mockUSDC, "Lender claim asset should be USDC");
        assertFalse(lenderClaimed, "Lender should not have claimed yet");

        // On default, lender gets prepay minus treasury fee (buffer goes to treasury separately)
        uint256 defaultTreasuryFee = (TOTAL_RENTAL * TREASURY_FEE_BPS) / BASIS_POINTS;
        uint256 expectedLenderDefault = TOTAL_RENTAL - defaultTreasuryFee;
        assertEq(lenderClaimAmount, expectedLenderDefault, "Lender should get rental prepay minus treasury fee on default");

        uint256 lenderUSDCBefore = IERC20(mockUSDC).balanceOf(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        // Verify lender received USDC and NFT
        assertEq(
            IERC20(mockUSDC).balanceOf(lender),
            lenderUSDCBefore + expectedLenderDefault,
            "Lender USDC balance mismatch after default claim"
        );
        assertEq(
            IERC721(mockNFT721).ownerOf(1),
            lender,
            "NFT should be returned to lender after default claim"
        );

        // Step 6: Verify no borrower claim on default (borrower loses prepay)
        (, uint256 borrowerClaimAmount,) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerClaimAmount, 0, "Borrower should have no claim on default");
    }
}
