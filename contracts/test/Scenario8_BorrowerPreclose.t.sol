// test/Scenario8_BorrowerPreclose.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
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
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title Scenario8_BorrowerPreclose
 * @notice Integration tests for borrower preclose workflows.
 *         Scenario 8a: Transfer obligation via existing Borrower Offer (Option 2).
 *         Scenario 8b: Offset with new Lender Offer, new borrower accepts (Option 3).
 */
contract Scenario8_BorrowerPreclose is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    address newBorrower;
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
    PrecloseFacet precloseFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    uint256 activeLoanId;
    uint256 constant PRINCIPAL  = 1000 ether;
    uint256 constant COLLATERAL = 1800 ether;

    address lenderEscrow;
    address borrowerEscrow;
    address newBorrowerEscrow;

    function mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset), abi.encode(status));
    }
    function mockPrice(address asset, uint256 price, uint8 dec) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset), abi.encode(price, dec));
    }
    function mockHealthFactor(uint256 loanId, uint256 hf) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(hf));
    }
    function mockLTV(uint256 loanId, uint256 ltv) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId), abi.encode(ltv));
    }

    function setUp() public {
        owner = address(this);
        lender      = makeAddr("lender");
        borrower    = makeAddr("borrower");
        newBorrower = makeAddr("newBorrower");

        mockERC20 = address(new ERC20Mock("Token", "TKN", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockZeroExProxy = makeAddr("zeroEx");

        ERC20Mock(mockERC20).mint(lender,      100000 ether);
        ERC20Mock(mockERC20).mint(borrower,    100000 ether);
        ERC20Mock(mockERC20).mint(newBorrower, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(lender,      100000 ether);
        ERC20Mock(mockCollateralERC20).mint(borrower,    100000 ether);
        ERC20Mock(mockCollateralERC20).mint(newBorrower, 100000 ether);

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
        precloseFacet = new PrecloseFacet();
        accessControlFacet = new AccessControlFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](14);
        cuts[0]  = IDiamondCut.FacetCut({facetAddress: address(offerFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferFacetSelectors()});
        cuts[1]  = IDiamondCut.FacetCut({facetAddress: address(profileFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getProfileFacetSelectors()});
        cuts[2]  = IDiamondCut.FacetCut({facetAddress: address(oracleFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOracleFacetSelectors()});
        cuts[3]  = IDiamondCut.FacetCut({facetAddress: address(nftFacet),            action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaipakamNFTFacetSelectors()});
        cuts[4]  = IDiamondCut.FacetCut({facetAddress: address(escrowFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getEscrowFactoryFacetSelectors()});
        cuts[5]  = IDiamondCut.FacetCut({facetAddress: address(loanFacet),           action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getLoanFacetSelectors()});
        cuts[6]  = IDiamondCut.FacetCut({facetAddress: address(riskFacet),           action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskFacetSelectors()});
        cuts[7]  = IDiamondCut.FacetCut({facetAddress: address(repayFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRepayFacetSelectors()});
        cuts[8]  = IDiamondCut.FacetCut({facetAddress: address(adminFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAdminFacetSelectors()});
        cuts[9]  = IDiamondCut.FacetCut({facetAddress: address(defaultFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getDefaultedFacetSelectors()});
        cuts[10] = IDiamondCut.FacetCut({facetAddress: address(claimFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getClaimFacetSelectors()});
        cuts[11] = IDiamondCut.FacetCut({facetAddress: address(addCollateralFacet),  action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAddCollateralFacetSelectors()});
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(precloseFacet),       action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getPrecloseFacetSelectors()});
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(accessControlFacet),  action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAccessControlFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(mockZeroExProxy);
        AdminFacet(address(diamond)).setallowanceTarget(mockZeroExProxy);

        vm.prank(lender);      ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);    ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(newBorrower); ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);      ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);    ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(newBorrower); ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);

        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        vm.prank(lender);      ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower);    ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(newBorrower); ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(newBorrower, LibVaipakam.KYCTier.Tier2);

        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 8500, 300, 1000);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 8500, 300, 1000);

        mockLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockERC20, 1e8, 8);
        mockLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockCollateralERC20, 1e8, 8);

        // Create escrows and approve
        lenderEscrow      = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        borrowerEscrow    = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        newBorrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newBorrower);
        vm.prank(lender);      ERC20(mockERC20).approve(lenderEscrow, type(uint256).max);
        vm.prank(borrower);    ERC20(mockERC20).approve(borrowerEscrow, type(uint256).max);
        vm.prank(newBorrower); ERC20(mockERC20).approve(newBorrowerEscrow, type(uint256).max);
        vm.prank(lender);      ERC20(mockCollateralERC20).approve(lenderEscrow, type(uint256).max);
        vm.prank(borrower);    ERC20(mockCollateralERC20).approve(borrowerEscrow, type(uint256).max);
        vm.prank(newBorrower); ERC20(mockCollateralERC20).approve(newBorrowerEscrow, type(uint256).max);

        // Set diamond's country and KYC (needed for cross-facet offer creation in Option 3)
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
                collateralQuantity: 0
            })
        );
        vm.prank(borrower);
        activeLoanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Give diamond some ERC20 for internal transfers (treasury fee etc.)
        ERC20Mock(mockERC20).mint(address(diamond), 100000 ether);
    }

    // ─── Scenario 8a: Transfer Obligation Via Borrower Offer (Option 2) ──────

    function test_Scenario8a_TransferObligationViaOffer() public {
        // Warp 1 day so there is accrued interest
        vm.warp(block.timestamp + 1 days);

        // newBorrower creates a Borrower offer (matching loan terms)
        vm.prank(newBorrower);
        uint256 borrowerOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
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
                collateralQuantity: 0
            })
        );

        // Record balances before transfer
        uint256 borrowerBalBefore = ERC20(mockERC20).balanceOf(borrower);

        // Mock cross-facet calls for escrow withdraw (collateral release) and NFT operations
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector), "");
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.mintNFT.selector), "");
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        // Mock HF check to return healthy value
        mockHealthFactor(activeLoanId, 2e18);

        // Expect LoanObligationTransferred event
        vm.expectEmit(true, true, true, false);
        emit PrecloseFacet.LoanObligationTransferred(activeLoanId, borrower, newBorrower, 0);

        // Original borrower transfers obligation
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(activeLoanId, borrowerOfferId);

        // Verify: loan.borrower is now newBorrower
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(loan.borrower, newBorrower, "Loan borrower should be newBorrower");

        // Verify: loan collateral updated to newBorrower's collateral amount
        assertEq(loan.collateralAmount, COLLATERAL, "Collateral amount should match newBorrower's offer");

        // Verify: loan duration updated to newBorrower's offer duration
        assertEq(loan.durationDays, 29, "Duration should be updated to offer's duration");

        // Verify: loan start time reset to current block
        assertEq(loan.startTime, block.timestamp, "Start time should be reset");

        // Verify: borrower offer is marked accepted
        LibVaipakam.Offer memory offer = OfferFacet(address(diamond)).getOffer(borrowerOfferId);
        assertTrue(offer.accepted, "Borrower offer should be marked accepted");

        // Verify: original borrower paid accrued interest (balance decreased)
        uint256 borrowerBalAfter = ERC20(mockERC20).balanceOf(borrower);
        assertLt(borrowerBalAfter, borrowerBalBefore, "Borrower should have paid accrued interest");

        vm.clearMockedCalls();
    }

    // ─── Scenario 8b: Offset With New Offer, Then Accept (Option 3) ──────────

    function test_Scenario8b_OffsetWithNewOffer_ThenAccept() public {
        // Warp 1 day
        vm.warp(block.timestamp + 1 days);

        // Record borrower balance before offset
        uint256 borrowerBalBefore = ERC20(mockERC20).balanceOf(borrower);

        // Step 1: borrower calls offsetWithNewOffer to create a Lender offer
        // This internally: pays accrued + shortfall to lender, creates Lender offer via cross-facet
        // Mock the cross-facet createOffer call to return a known offerId
        uint256 expectedNewOfferId = 3;
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OfferFacet.createOffer.selector),
            abi.encode(expectedNewOfferId)
        );

        vm.expectEmit(true, true, true, false);
        emit PrecloseFacet.OffsetOfferCreated(activeLoanId, expectedNewOfferId, borrower, 0);

        vm.prank(borrower);
        uint256 newOfferId = PrecloseFacet(address(diamond)).offsetWithNewOffer(
            activeLoanId, 500, 29, mockCollateralERC20, COLLATERAL, true, mockERC20
        );
        assertEq(newOfferId, expectedNewOfferId, "Returned offerId should match expected");

        vm.clearMockedCalls();

        // Re-apply oracle mocks after clearMockedCalls
        mockLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockERC20, 1e8, 8);
        mockLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockCollateralERC20, 1e8, 8);

        // Verify: borrower paid principal + accrued interest (balance decreased significantly)
        uint256 borrowerBalAfter = ERC20(mockERC20).balanceOf(borrower);
        assertLt(borrowerBalAfter, borrowerBalBefore, "Borrower should have paid principal + interest");
        // Borrower paid at least PRINCIPAL (1000 ether) + accrued
        assertLt(borrowerBalAfter, borrowerBalBefore - PRINCIPAL, "Borrower should have paid at least principal");

        // Step 2: Verify completeOffset requires the offer to be accepted
        // First, it should revert with OffsetOfferNotAccepted
        vm.expectRevert(PrecloseFacet.OffsetOfferNotAccepted.selector);
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).completeOffset(activeLoanId);

        // Step 3: Simulate offer acceptance by writing offer.accepted = true in storage.
        // Also backfill creator = borrower, since createOffer was mocked above (defaulting
        // creator to 0). With native NFT locking, completeOffset authorizes via
        // requireBorrowerNFTOwnerOrKeeper — the NFT stays with the borrower, so
        // prank(borrower) is sufficient even though offer.creator is set here.
        bytes32 baseSlot = LibVaipakam.VANGKI_STORAGE_POSITION;
        // offers mapping is at storage offset 13 in LibVaipakam.Storage
        uint256 offersSlot = uint256(baseSlot) + 13;
        bytes32 offerBase = keccak256(abi.encode(expectedNewOfferId, offersSlot));
        // Post-repack Offer layout: slot 1 packs creator(20) + offerType(1) + principalLiquidity(1)
        // + collateralLiquidity(1) + accepted(1) + ... — accepted is at byte offset 23 of slot 1,
        // creator occupies the low 20 bytes.
        bytes32 acceptedSlot = bytes32(uint256(offerBase) + 1);
        uint256 packed = uint256(uint160(borrower)) | (uint256(1) << 184);
        vm.store(address(diamond), acceptedSlot, bytes32(packed));

        // Mock cross-facet NFT calls for completeOffset
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        // Expect OffsetCompleted event
        vm.expectEmit(true, true, true, false);
        emit PrecloseFacet.OffsetCompleted(activeLoanId, expectedNewOfferId, borrower);

        // Complete the offset (permissionless)
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).completeOffset(activeLoanId);

        // Verify: original loan is now Repaid
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid), "Original loan should be Repaid");

        vm.clearMockedCalls();
    }
}
