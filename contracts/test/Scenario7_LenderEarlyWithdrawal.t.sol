// test/Scenario7_LenderEarlyWithdrawal.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
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
 * @title Scenario7_LenderEarlyWithdrawal
 * @notice Integration tests for lender early withdrawal (loan sale) workflows.
 *         Scenario 7a: Sell loan via buy offer (Option 1).
 *         Scenario 7b: Create sale offer, new lender accepts (Option 2).
 */
contract Scenario7_LenderEarlyWithdrawal is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address newLender;
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
    EarlyWithdrawalFacet earlyFacet;
    AccessControlFacet accessControlFacet;
    TestMutatorFacet testMutatorFacet;
    HelperTest helperTest;

    uint256 activeLoanId;
    uint256 constant PRINCIPAL  = 1000 ether;
    uint256 constant COLLATERAL = 1800 ether;

    address lenderEscrow;
    address newLenderEscrow;
    address borrowerEscrow;

    function mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset), abi.encode(status));
    }
    function mockPrice(address asset, uint256 price, uint8 dec) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset), abi.encode(price, dec));
    }

    function setUp() public {
        owner = address(this);
        lender    = makeAddr("lender");
        newLender = makeAddr("newLender");
        borrower  = makeAddr("borrower");

        mockERC20 = address(new ERC20Mock("Token", "TKN", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockZeroExProxy = makeAddr("zeroEx");

        ERC20Mock(mockERC20).mint(lender,    100000 ether);
        ERC20Mock(mockERC20).mint(newLender, 100000 ether);
        ERC20Mock(mockERC20).mint(borrower,  100000 ether);
        ERC20Mock(mockCollateralERC20).mint(lender,    100000 ether);
        ERC20Mock(mockCollateralERC20).mint(newLender, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(borrower,  100000 ether);

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
        earlyFacet = new EarlyWithdrawalFacet();
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
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(earlyFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getEarlyWithdrawalFacetSelectors()});
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(accessControlFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAccessControlFacetSelectors()});
        cuts[14] = IDiamondCut.FacetCut({facetAddress: address(testMutatorFacet),   action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getTestMutatorFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(mockZeroExProxy);
        AdminFacet(address(diamond)).setallowanceTarget(mockZeroExProxy);

        vm.prank(lender);    ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(newLender); ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);  ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);    ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(newLender); ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);  ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);

        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        vm.prank(lender);    ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(newLender); ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower);  ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(newLender, LibVaipakam.KYCTier.Tier2);
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

        lenderEscrow    = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        newLenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newLender);
        borrowerEscrow  = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        vm.prank(lender);    ERC20(mockERC20).approve(lenderEscrow, type(uint256).max);
        vm.prank(newLender); ERC20(mockERC20).approve(newLenderEscrow, type(uint256).max);
        vm.prank(borrower);  ERC20(mockERC20).approve(borrowerEscrow, type(uint256).max);
        vm.prank(lender);    ERC20(mockCollateralERC20).approve(lenderEscrow, type(uint256).max);
        vm.prank(newLender); ERC20(mockCollateralERC20).approve(newLenderEscrow, type(uint256).max);
        vm.prank(borrower);  ERC20(mockCollateralERC20).approve(borrowerEscrow, type(uint256).max);

        // Set diamond's country and KYC (needed for cross-facet offer creation in Option 2)
        vm.prank(address(diamond));
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(address(diamond), LibVaipakam.KYCTier.Tier2);

        // Create active loan: lender creates Lender offer, borrower accepts
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
                keeperAccessEnabled: false
            })
        );
        vm.prank(borrower);
        activeLoanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Mint tokens to diamond for internal transfers (treasury fee etc.)
        ERC20Mock(mockERC20).mint(address(diamond), 100000 ether);
    }

    // ─── Scenario 7a: Sell Loan Via Buy Offer (Option 1) ─────────────────────

    function test_Scenario7a_SellLoanViaBuyOffer() public {
        // Warp 1 day so there is accrued interest
        vm.warp(block.timestamp + 1 days);

        // Record lender balance before sale
        uint256 lenderBalBefore = ERC20(mockERC20).balanceOf(lender);

        // newLender creates a Lender offer (buy offer) with duration=29 (remaining days)
        vm.prank(newLender);
        uint256 buyOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: COLLATERAL,
                durationDays: 29,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                keeperAccessEnabled: false
            })
        );

        // Mock cross-facet NFT calls (escrow withdraw works natively)
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector), "");
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.mintNFT.selector), "");

        // Expect LoanSold event
        vm.expectEmit(true, true, true, false);
        emit EarlyWithdrawalFacet.LoanSold(activeLoanId, lender, newLender, 0);

        // Original lender sells the loan
        vm.prank(lender);
        EarlyWithdrawalFacet(address(diamond)).sellLoanViaBuyOffer(activeLoanId, buyOfferId);

        // Verify: loan.lender is now newLender
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(loan.lender, newLender, "Loan lender should be newLender");

        // Verify: buyOffer is marked accepted
        LibVaipakam.Offer memory offer = OfferFacet(address(diamond)).getOffer(buyOfferId);
        assertTrue(offer.accepted, "Buy offer should be marked accepted");

        // Net settlement: lender receives `principal - liamCost` directly —
        // accrued is netted out of Noah's principal rather than pulled from
        // Liam.  escrowWithdrawERC20 is mocked, so the diamond needs tokens
        // to pay Liam; that funding happens in the test helper. Here we just
        // assert balance strictly INCREASED by roughly principal - accrued.
        uint256 lenderBalAfter = ERC20(mockERC20).balanceOf(lender);
        assertGt(lenderBalAfter, lenderBalBefore, "Lender should have received net principal");

        vm.clearMockedCalls();
    }

    // ─── Scenario 7b: Create Sale Offer, New Lender Accepts (Option 2) ───────

    function test_Scenario7b_CreateSaleOffer_NewLenderAccepts() public {
        // Warp 1 day
        vm.warp(block.timestamp + 1 days);

        // Step 1: Original lender creates a loan sale offer
        // Mock the cross-facet createOffer call to return a known saleOfferId
        uint256 expectedSaleOfferId = 3; // offer 1 = lender offer, offer 2 = this sale
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OfferFacet.createOffer.selector),
            abi.encode(expectedSaleOfferId)
        );

        vm.prank(lender);
        EarlyWithdrawalFacet(address(diamond)).createLoanSaleOffer(activeLoanId, 500, true);

        vm.clearMockedCalls();

        // Re-apply oracle mocks after clearMockedCalls
        mockLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockERC20, 1e8, 8);

        // Verify: loanToSaleOfferId is set (via storage read)
        // The createLoanSaleOffer wrote s.loanToSaleOfferId[activeLoanId] = expectedSaleOfferId
        // We verify this indirectly: calling completeLoanSale should not revert with SaleNotLinked
        // but will revert with SaleOfferNotAccepted since the offer is not yet accepted.

        // Step 2: Simulate completing the sale by calling completeLoanSale
        // To test completeLoanSale, we need:
        //   - s.loanToSaleOfferId[activeLoanId] != 0  (set above)
        //   - s.offers[saleOfferId].accepted = true    (need to mock/set)
        //   - s.offerIdToLoanId[saleOfferId] points to a temp loan with a valid lender

        // Since completeLoanSale requires complex state (temp loan from acceptOffer),
        // we mock the cross-facet calls and verify the key state transitions.

        // First verify SaleOfferNotAccepted revert (proves the link was created)
        vm.expectRevert(EarlyWithdrawalFacet.SaleOfferNotAccepted.selector);
        vm.prank(lender);
        EarlyWithdrawalFacet(address(diamond)).completeLoanSale(activeLoanId);

        // Now set up state for a successful completeLoanSale:
        // Mark the sale offer accepted and backfill creator=lender. With the
        // native-lock design the auth check is requireLenderNFTOwnerOrKeeper
        // against the *current* lender NFT owner, and mocked cross-facet
        // calls leave the NFT in place as it was before createLoanSaleOffer.
        LibVaipakam.Offer memory saleOffer = OfferFacet(address(diamond)).getOffer(expectedSaleOfferId);
        saleOffer.accepted = true;
        saleOffer.creator = lender;
        TestMutatorFacet(address(diamond)).setOffer(expectedSaleOfferId, saleOffer);

        // offerIdToLoanId is a plain uint=>uint mapping (offset 27) — independent of
        // Loan/Offer layout, so vm.store is fine here.
        bytes32 baseSlot = LibVaipakam.VANGKI_STORAGE_POSITION;
        uint256 offerIdToLoanSlot = uint256(baseSlot) + 27;
        bytes32 tempLoanSlotKey = keccak256(abi.encode(expectedSaleOfferId, offerIdToLoanSlot));
        uint256 tempLoanId = 999;
        vm.store(address(diamond), tempLoanSlotKey, bytes32(tempLoanId));

        // Set temp loan's lender to newLender via mutator (empty Loan with lender populated).
        LibVaipakam.Loan memory tempLoanInit;
        tempLoanInit.lender = newLender;
        TestMutatorFacet(address(diamond)).setLoan(tempLoanId, tempLoanInit);

        // Mock all cross-facet calls that completeLoanSale makes
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector), "");
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.mintNFT.selector), "");
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));

        // Expect LoanSaleCompleted event
        vm.expectEmit(true, true, true, false);
        emit EarlyWithdrawalFacet.LoanSaleCompleted(activeLoanId, lender, newLender);

        // Complete the sale (permissionless call)
        vm.prank(lender);
        EarlyWithdrawalFacet(address(diamond)).completeLoanSale(activeLoanId);

        // Verify: loan.lender is now newLender
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(loan.lender, newLender, "Loan lender should be newLender after sale completion");

        // Verify: temp loan status is Repaid (status at offset 13, packed with liquidity)
        LibVaipakam.Loan memory tempLoan = LoanFacet(address(diamond)).getLoanDetails(tempLoanId);
        assertEq(uint8(tempLoan.status), uint8(LibVaipakam.LoanStatus.Repaid), "Temp loan should be Repaid");

        vm.clearMockedCalls();
    }
}
