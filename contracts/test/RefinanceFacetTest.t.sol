// test/RefinanceFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
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
 * @title RefinanceFacetTest
 * @notice Tests RefinanceFacet: refinanceLoan (two-step: Borrower Offer accepted, then refinance).
 */
contract RefinanceFacetTest is Test {
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
    RefinanceFacet refinanceFacet;
    AccessControlFacet accessControlFacet;
    TestMutatorFacet testMutatorFacet;
    HelperTest helperTest;

    uint256 activeLoanId;
    uint256 borrowerOfferId; // Alice's Borrower Offer for refinancing
    uint256 constant PRINCIPAL  = 1000 ether;
    uint256 constant COLLATERAL = 1800 ether;

    function mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset), abi.encode(status));
    }
    function mockPrice(address asset, uint256 price, uint8 dec) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset), abi.encode(price, dec));
    }

    function setUp() public {
        owner     = address(this);
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
        refinanceFacet = new RefinanceFacet();
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
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(refinanceFacet),     action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRefinanceFacetSelectors()});
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

        address lenderEscrow   = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        address newLenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newLender);
        address borrowerEscrow  = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        vm.prank(lender);    ERC20(mockERC20).approve(lenderEscrow, type(uint256).max);
        vm.prank(newLender); ERC20(mockERC20).approve(newLenderEscrow, type(uint256).max);
        vm.prank(borrower);  ERC20(mockERC20).approve(borrowerEscrow, type(uint256).max);
        vm.prank(lender);    ERC20(mockCollateralERC20).approve(lenderEscrow, type(uint256).max);
        vm.prank(newLender); ERC20(mockCollateralERC20).approve(newLenderEscrow, type(uint256).max);
        vm.prank(borrower);  ERC20(mockCollateralERC20).approve(borrowerEscrow, type(uint256).max);

        // Create active loan: Lender A -> Borrower (Alice)
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
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );
        vm.prank(borrower);
        activeLoanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Alice creates a Borrower Offer for refinancing (lower rate = better terms)
        vm.prank(borrower);
        borrowerOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 400,
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
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        ERC20Mock(mockERC20).mint(address(diamond), 100000 ether);
    }

    /// @dev Helper to deposit principal into newLender's escrow and accept Alice's borrower offer.
    function _acceptBorrowerOffer(uint256 offerId) internal returns (uint256 loanId) {
        // newLender must deposit principal into their escrow before acceptOffer can withdraw it
        address newLenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newLender);
        vm.prank(newLender);
        ERC20(mockERC20).transfer(newLenderEscrow, PRINCIPAL);
        vm.prank(newLender);
        loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ─── refinanceLoan reverts ────────────────────────────────────────────────

    function testRefinanceLoanRevertsNotNFTOwner() public {
        // Phase 6: refinanceLoan is a borrower-entitled strategic flow.
        // Non-borrower-NFT callers without keeper auth revert with
        // KeeperAccessRequired (the unified requireKeeperFor gate).
        _acceptBorrowerOffer(borrowerOfferId);

        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.KeeperAccessRequired.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
    }

    function testRefinanceLoanRevertsNonExistentLoan() public {
        // Non-existent loan has borrowerTokenId = 0 which is not minted;
        // ownerOf reverts with OZ's ERC721NonexistentToken(0).
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 0)
        );
        RefinanceFacet(address(diamond)).refinanceLoan(999, borrowerOfferId);
    }

    function testRefinanceLoanRevertsInvalidOffer_LenderType() public {
        // Create a Lender-type offer (should be rejected — refinance requires Borrower offer)
        vm.prank(newLender);
        uint256 badOffer = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 400,
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
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, badOffer);
    }

    function testRefinanceLoanRevertsOfferNotAccepted() public {
        // Offer exists but not yet accepted
        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.OfferNotAccepted.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
    }

    function testRefinanceLoanRevertsNotOfferCreator() public {
        // Create a Borrower offer by someone else
        address otherBorrower = makeAddr("otherBorrower");
        ERC20Mock(mockERC20).mint(otherBorrower, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(otherBorrower, 100000 ether);
        vm.prank(otherBorrower); ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(otherBorrower); ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(otherBorrower); ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner); ProfileFacet(address(diamond)).updateKYCTier(otherBorrower, LibVaipakam.KYCTier.Tier2);
        address otherEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(otherBorrower);
        vm.prank(otherBorrower); ERC20(mockERC20).approve(otherEscrow, type(uint256).max);
        vm.prank(otherBorrower); ERC20(mockCollateralERC20).approve(otherEscrow, type(uint256).max);

        vm.prank(otherBorrower);
        uint256 otherOffer = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 400,
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
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        // Accept it
        _acceptBorrowerOffer(otherOffer);

        // Alice tries to use someone else's offer
        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, otherOffer);
    }

    // ─── refinanceLoan success ────────────────────────────────────────────────

    function testRefinanceLoanSuccess() public {
        // Step 1: newLender accepts Alice's Borrower Offer → new loan created
        _acceptBorrowerOffer(borrowerOfferId);

        // Mock the complex cross-facet calls inside refinanceLoan
        vm.mockCall(address(diamond), abi.encodeWithSelector(RepayFacet.calculateRepaymentAmount.selector), abi.encode(PRINCIPAL + 10 ether));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(2e18));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
    }

    /// @dev After refinance, the borrower's escrow must hold exactly newCol of
    ///      collateral (not oldCol + newCol). The old deposit is refunded to
    ///      the borrower's wallet — otherwise it would be permanently stranded
    ///      since no claim path records it.
    function testRefinanceRefundsFullOldCollateralToBorrower() public {
        // Step 1: newLender accepts Alice's Borrower Offer → new loan created
        _acceptBorrowerOffer(borrowerOfferId);

        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);

        // Sanity: at this point the escrow holds oldCol + newCol (same collateral token).
        uint256 escrowBefore = ERC20(mockCollateralERC20).balanceOf(borrowerEscrow);
        assertEq(escrowBefore, COLLATERAL * 2, "escrow should hold old + new collateral");

        uint256 walletBefore = ERC20(mockCollateralERC20).balanceOf(borrower);
        uint256 principalWalletBefore = ERC20(mockERC20).balanceOf(borrower);

        // Only mock the risk calls (HF/LTV); let the real escrow withdrawal run
        // so we can verify the balance invariants end-to-end.
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(2e18));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));

        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);

        // Escrow now holds only the new loan's collateral.
        assertEq(
            ERC20(mockCollateralERC20).balanceOf(borrowerEscrow),
            COLLATERAL,
            "escrow must retain exactly newCol after refinance"
        );

        // Borrower wallet received the full old collateral back (collateral-side only).
        uint256 walletAfter = ERC20(mockCollateralERC20).balanceOf(borrower);
        assertEq(
            walletAfter,
            walletBefore + COLLATERAL,
            "borrower wallet must receive full old collateral refund"
        );
        // silence unused variable warning
        principalWalletBefore;

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));

        vm.clearMockedCalls();
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Covers InvalidRefinanceOffer when refinance offer amount < oldLoan.principal
    function testRefinanceLoanRevertsInvalidOfferAmountTooLow() public {
        // Create a new borrower offer with amount < PRINCIPAL
        vm.prank(borrower);
        uint256 smallOffer = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL / 2,
                interestRateBps: 400,
                collateralAsset: mockCollateralERC20,
                collateralAmount: COLLATERAL / 2,
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
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        // Accept it (deposit half principal since offer is PRINCIPAL/2)
        address nlEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newLender);
        vm.prank(newLender);
        ERC20(mockERC20).transfer(nlEscrow, PRINCIPAL / 2);
        vm.prank(newLender);
        OfferFacet(address(diamond)).acceptOffer(smallOffer, true);

        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, smallOffer);
    }

    /// @dev Covers LoanNotActive in refinanceLoan (loan status != Active — explicitly Repaid)
    function testRefinanceLoanRevertsLoanStatusRepaid() public {
        // newLender accepts first
        _acceptBorrowerOffer(borrowerOfferId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        loan.status = LibVaipakam.LoanStatus.Repaid;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);

        vm.expectRevert(IVaipakamErrors.LoanNotActive.selector);
        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
    }

    /// @dev Covers HealthFactorTooLow in refinanceLoan
    function testRefinanceLoanRevertsHealthFactorTooLow() public {
        _acceptBorrowerOffer(borrowerOfferId);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RepayFacet.calculateRepaymentAmount.selector), abi.encode(PRINCIPAL + 10 ether));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        // Return HF below min
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(0.5e18)));

        vm.expectRevert(IVaipakamErrors.HealthFactorTooLow.selector);
        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Covers LTVExceeded in refinanceLoan (LTV > maxLtvBps)
    function testRefinanceLoanRevertsLTVExceeded() public {
        _acceptBorrowerOffer(borrowerOfferId);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RepayFacet.calculateRepaymentAmount.selector), abi.encode(PRINCIPAL + 10 ether));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        // Return LTV above maxLtvBps (8000 bps); pass 9000 > 8000
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(9000)));

        vm.expectRevert(IVaipakamErrors.LTVExceeded.selector);
        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Covers shortfall payment branch in refinanceLoan (new interest < old expected)
    function testRefinanceLoanWithShortfallPaid() public {
        _acceptBorrowerOffer(borrowerOfferId);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RepayFacet.calculateRepaymentAmount.selector), abi.encode(PRINCIPAL));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        ERC20Mock(mockERC20).mint(borrower, 10 ether);

        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
        vm.clearMockedCalls();
    }

    /// @dev Covers CrossFacetCallFailed("Collateral refund failed") in refinanceLoan.
    ///      Refinance always refunds the full old collateral back to the borrower
    ///      (the new loan's collateral was already deposited by the borrower offer).
    function testRefinanceLoanCollateralRefundFails() public {
        _acceptBorrowerOffer(borrowerOfferId);

        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            "withdraw fail"
        );

        vm.prank(borrower);
        vm.expectRevert(bytes("withdraw fail"));
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Covers CrossFacetCallFailed("Old lender NFT update failed") in refinanceLoan.
    function testRefinanceLoanNFTUpdateFails() public {
        _acceptBorrowerOffer(borrowerOfferId);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RepayFacet.calculateRepaymentAmount.selector), abi.encode(PRINCIPAL));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            "nft fail"
        );

        vm.prank(borrower);
        vm.expectRevert(bytes("nft fail"));
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Covers CrossFacetCallFailed("Get lender escrow failed") in refinanceLoan.
    function testRefinanceLoanGetLenderEscrowFails() public {
        _acceptBorrowerOffer(borrowerOfferId);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RepayFacet.calculateRepaymentAmount.selector), abi.encode(PRINCIPAL));
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector),
            "escrow fail"
        );

        vm.prank(borrower);
        vm.expectRevert(bytes("escrow fail"));
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Covers CrossFacetCallFailed("HF calc failed") in refinanceLoan.
    function testRefinanceLoanHFCalcFails() public {
        _acceptBorrowerOffer(borrowerOfferId);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RepayFacet.calculateRepaymentAmount.selector), abi.encode(PRINCIPAL));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            "hf fail"
        );

        vm.prank(borrower);
        vm.expectRevert(bytes("hf fail"));
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Covers CrossFacetCallFailed("LTV calc failed") in refinanceLoan.
    function testRefinanceLoanLTVCalcFails() public {
        _acceptBorrowerOffer(borrowerOfferId);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RepayFacet.calculateRepaymentAmount.selector), abi.encode(PRINCIPAL));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            "ltv fail"
        );

        vm.prank(borrower);
        vm.expectRevert(bytes("ltv fail"));
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Helper to set collateralAssetType on both a loan and an offer via TestMutatorFacet.
    function _setCollateralAssetType(uint256 loanId, uint256 offerId, uint8 assetTypeVal) internal {
        LibVaipakam.AssetType assetType = LibVaipakam.AssetType(assetTypeVal);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.collateralAssetType = assetType;
        loan.collateralTokenId = 42;
        if (assetTypeVal == 2) loan.collateralQuantity = 10;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        LibVaipakam.Offer memory offer = OfferFacet(address(diamond)).getOffer(offerId);
        offer.collateralAssetType = assetType;
        TestMutatorFacet(address(diamond)).setOffer(offerId, offer);
    }

    /// @dev Covers ERC721 collateral refund branch in refinanceLoan.
    function testRefinanceLoanERC721CollateralRefund() public {
        _acceptBorrowerOffer(borrowerOfferId);

        _setCollateralAssetType(activeLoanId, borrowerOfferId, 1); // ERC721

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC721.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
        vm.clearMockedCalls();
    }

    /// @dev Covers ERC1155 collateral refund branch in refinanceLoan.
    function testRefinanceLoanERC1155CollateralRefund() public {
        _acceptBorrowerOffer(borrowerOfferId);

        _setCollateralAssetType(activeLoanId, borrowerOfferId, 2); // ERC1155

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
        vm.clearMockedCalls();
    }

    /// @dev Covers InvalidRefinanceOffer when collateralAssetType doesn't match.
    function testRefinanceLoanRevertsCollateralAssetTypeMismatch() public {
        // Force the old loan's collateralAssetType to ERC721; borrowerOfferId still has ERC20.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        loan.collateralAssetType = LibVaipakam.AssetType.ERC721;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);

        _acceptBorrowerOffer(borrowerOfferId);

        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
    }

    // ─── Test E: Non-ERC20 loan reverts InvalidRefinanceOffer ─────────────

    /// @dev Covers assetType != ERC20 branch (line 75-76) in refinanceLoan.
    function testRefinanceLoanRevertsNonERC20Loan() public {
        _acceptBorrowerOffer(borrowerOfferId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        loan.assetType = LibVaipakam.AssetType.ERC721;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);

        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
    }

    // ─── Test F: Lending asset mismatch reverts InvalidRefinanceOffer ────

    /// @dev Covers lendingAsset mismatch branch (line 87) in refinanceLoan.
    function testRefinanceLoanRevertsLendingAssetMismatch() public {
        // Create a new ERC20 for different lending asset
        address otherERC20 = address(new ERC20Mock("Other", "OTH", 18));
        ERC20Mock(otherERC20).mint(borrower, 100000 ether);
        ERC20Mock(otherERC20).mint(newLender, 100000 ether);
        vm.prank(borrower); ERC20(otherERC20).approve(address(diamond), type(uint256).max);
        vm.prank(newLender); ERC20(otherERC20).approve(address(diamond), type(uint256).max);
        mockLiquidity(otherERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(otherERC20, 1e8, 8);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(otherERC20, 8000, 8500, 300, 1000);
        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        address nlEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newLender);
        vm.prank(borrower); ERC20(otherERC20).approve(borrowerEscrow, type(uint256).max);
        vm.prank(newLender); ERC20(otherERC20).approve(nlEscrow, type(uint256).max);

        // Borrower creates offer with different lendingAsset
        vm.prank(borrower);
        uint256 badOffer = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: otherERC20,
                amount: PRINCIPAL,
                interestRateBps: 400,
                collateralAsset: mockERC20,
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
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        // Accept the offer
        vm.prank(newLender); ERC20(otherERC20).transfer(nlEscrow, PRINCIPAL);
        vm.prank(newLender);
        OfferFacet(address(diamond)).acceptOffer(badOffer, true);

        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, badOffer);
    }

    // ─── Test G: Collateral asset mismatch reverts InvalidRefinanceOffer ──

    /// @dev Covers collateralAsset mismatch branch (line 88) in refinanceLoan.
    function testRefinanceLoanRevertsCollateralAssetMismatch() public {
        // Create a different ERC20 for collateral
        address otherERC20 = address(new ERC20Mock("Other", "OTH", 18));
        ERC20Mock(otherERC20).mint(borrower, 100000 ether);
        ERC20Mock(otherERC20).mint(newLender, 100000 ether);
        vm.prank(borrower); ERC20(otherERC20).approve(address(diamond), type(uint256).max);
        vm.prank(newLender); ERC20(otherERC20).approve(address(diamond), type(uint256).max);
        mockLiquidity(otherERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(otherERC20, 1e8, 8);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(otherERC20, 8000, 8500, 300, 1000);
        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        address nlEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newLender);
        vm.prank(borrower); ERC20(otherERC20).approve(borrowerEscrow, type(uint256).max);
        vm.prank(newLender); ERC20(otherERC20).approve(nlEscrow, type(uint256).max);

        // Borrower creates offer with same lendingAsset but different collateralAsset
        vm.prank(borrower);
        uint256 badOffer = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 400,
                collateralAsset: otherERC20,
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
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        vm.prank(newLender); ERC20(mockERC20).transfer(nlEscrow, PRINCIPAL);
        vm.prank(newLender);
        OfferFacet(address(diamond)).acceptOffer(badOffer, true);

        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, badOffer);
    }

    // ─── Test H: Prepay asset mismatch reverts InvalidRefinanceOffer ──────

    /// @dev Covers prepayAsset mismatch branch (line 90) in refinanceLoan.
    function testRefinanceLoanRevertsPrepayAssetMismatch() public {
        // Create a different ERC20 for prepayAsset
        address otherERC20 = address(new ERC20Mock("Other", "OTH", 18));
        ERC20Mock(otherERC20).mint(borrower, 100000 ether);
        vm.prank(borrower); ERC20(otherERC20).approve(address(diamond), type(uint256).max);
        mockLiquidity(otherERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(otherERC20, 1e8, 8);
        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        address nlEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newLender);
        vm.prank(borrower); ERC20(otherERC20).approve(borrowerEscrow, type(uint256).max);

        // Borrower creates offer with different prepayAsset
        vm.prank(borrower);
        uint256 badOffer = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 400,
                collateralAsset: mockCollateralERC20,
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: otherERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        vm.prank(newLender); ERC20(mockERC20).transfer(nlEscrow, PRINCIPAL);
        vm.prank(newLender);
        OfferFacet(address(diamond)).acceptOffer(badOffer, true);

        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, badOffer);
    }

    // ─── Test I: No linked loan reverts ─────────────────────────────────────

    /// @dev Covers newLoanId == 0 branch (line 94) - accepted offer but no linked loan in offerIdToLoanId.
    function testRefinanceLoanRevertsNoLinkedLoan() public {
        // Create a borrower offer and manipulate it to appear accepted without a real loan
        vm.prank(borrower);
        uint256 fakeOffer = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 400,
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
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        // Accept the offer properly, then clear the offerIdToLoanId mapping
        // to simulate an accepted offer with no linked loan.
        address nlEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newLender);
        vm.prank(newLender); ERC20(mockERC20).transfer(nlEscrow, PRINCIPAL);
        vm.prank(newLender);
        OfferFacet(address(diamond)).acceptOffer(fakeOffer, true);

        // Clear the offerIdToLoanId mapping via the layout-resilient
        // mutator so newLoanId lookup returns 0.
        TestMutatorFacet(address(diamond)).setOfferIdToLoanIdRaw(fakeOffer, 0);

        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, fakeOffer);
    }

    // ─── Test J: Borrower NFT status update fails reverts CrossFacetCallFailed ───

    /// @dev Covers CrossFacetCallFailed on the second updateNFTStatus call
    ///      (borrower-side NFT transition to LoanRepaid) in refinanceLoan.
    function testRefinanceLoanBorrowerNFTStatusUpdateFails() public {
        _acceptBorrowerOffer(borrowerOfferId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                activeLoanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            "borrower nft fail"
        );

        vm.prank(borrower);
        vm.expectRevert(bytes("borrower nft fail"));
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Covers ERC721 collateral refund failure branch in refinanceLoan.
    function testRefinanceLoanERC721CollateralRefundFails() public {
        _acceptBorrowerOffer(borrowerOfferId);

        _setCollateralAssetType(activeLoanId, borrowerOfferId, 1); // ERC721

        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC721.selector),
            "withdraw fail"
        );

        vm.prank(borrower);
        vm.expectRevert(bytes("withdraw fail"));
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Covers ERC1155 collateral refund failure branch in refinanceLoan.
    function testRefinanceLoanERC1155CollateralRefundFails() public {
        _acceptBorrowerOffer(borrowerOfferId);

        _setCollateralAssetType(activeLoanId, borrowerOfferId, 2); // ERC1155

        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector),
            "withdraw fail"
        );

        vm.prank(borrower);
        vm.expectRevert(bytes("withdraw fail"));
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);
        vm.clearMockedCalls();
    }

    /// @dev Covers the zero collateral amount path (oldCol == 0) in refinanceLoan.
    ///      When collateralAmount is 0, no ERC20 collateral transfer is needed.
    function testRefinanceLoanZeroCollateralAmount() public {
        _acceptBorrowerOffer(borrowerOfferId);

        LibVaipakam.Loan memory oldLoan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        oldLoan.collateralAmount = 0;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, oldLoan);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, borrowerOfferId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
        vm.clearMockedCalls();
    }

    /// @dev Covers newExpectedInterest >= oldExpectedInterest (no shortfall) branch.
    function testRefinanceLoanNoShortfallHigherNewRate() public {
        // Create a new borrower offer with same rate as original (no shortfall)
        vm.prank(borrower);
        uint256 sameRateOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
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
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        _acceptBorrowerOffer(sameRateOfferId);

        vm.mockCall(address(diamond), abi.encodeWithSelector(RepayFacet.calculateRepaymentAmount.selector), abi.encode(PRINCIPAL));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(uint256(2e18)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(5000)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(activeLoanId, sameRateOfferId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
        vm.clearMockedCalls();
    }
}
