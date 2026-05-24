// test/Scenario8_BorrowerPreclose.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
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
    OfferCreateFacet offerCreateFacet;
    OfferAcceptFacet offerAcceptFacet;
    OfferCancelFacet offerCancelFacet;
    ProfileFacet profileFacet;
    OracleFacet oracleFacet;
    VaipakamNFTFacet nftFacet;
    VaultFactoryFacet vaultFacet;
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

    address lenderVault;
    address borrowerVault;
    address newBorrowerVault;

    function mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset), abi.encode(status));
    }
    function mockPrice(address asset, uint256 price, uint8 dec) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset), abi.encode(price, dec));
    }
    function mockHealthFactor(uint256 loanId, uint256 hf) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(hf));
    }
    function mockLtv(uint256 loanId, uint256 ltv) internal {
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
        offerCreateFacet = new OfferCreateFacet();
        offerAcceptFacet = new OfferAcceptFacet();
        offerCancelFacet = new OfferCancelFacet();
        profileFacet = new ProfileFacet();
        oracleFacet = new OracleFacet();
        nftFacet = new VaipakamNFTFacet();
        vaultFacet = new VaultFactoryFacet();
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

        TestMutatorFacet testMutatorFacet = new TestMutatorFacet();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](18);
        cuts[0]  = IDiamondCut.FacetCut({facetAddress: address(offerCreateFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCreateFacetSelectors()});
        cuts[17] = IDiamondCut.FacetCut({
            facetAddress: address(offerAcceptFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferAcceptFacetSelectors()
        });
        cuts[1]  = IDiamondCut.FacetCut({facetAddress: address(profileFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getProfileFacetSelectors()});
        cuts[2]  = IDiamondCut.FacetCut({facetAddress: address(oracleFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOracleFacetSelectors()});
        cuts[3]  = IDiamondCut.FacetCut({facetAddress: address(nftFacet),            action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaipakamNftFacetSelectors()});
        cuts[4]  = IDiamondCut.FacetCut({facetAddress: address(vaultFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaultFactoryFacetSelectors()});
        cuts[5]  = IDiamondCut.FacetCut({facetAddress: address(loanFacet),           action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getLoanFacetSelectors()});
        cuts[6]  = IDiamondCut.FacetCut({facetAddress: address(riskFacet),           action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskFacetSelectors()});
        cuts[7]  = IDiamondCut.FacetCut({facetAddress: address(repayFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRepayFacetSelectors()});
        cuts[8]  = IDiamondCut.FacetCut({facetAddress: address(adminFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAdminFacetSelectors()});
        cuts[9]  = IDiamondCut.FacetCut({facetAddress: address(defaultFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getDefaultedFacetSelectors()});
        cuts[10] = IDiamondCut.FacetCut({facetAddress: address(claimFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getClaimFacetSelectors()});
        cuts[11] = IDiamondCut.FacetCut({facetAddress: address(addCollateralFacet),  action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAddCollateralFacetSelectors()});
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(precloseFacet),       action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getPrecloseFacetSelectors()});
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(accessControlFacet),  action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAccessControlFacetSelectors()});
        cuts[14] = IDiamondCut.FacetCut({facetAddress: address(testMutatorFacet),    action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getTestMutatorFacetSelectors()});
        cuts[15] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});
        cuts[16] = IDiamondCut.FacetCut({facetAddress: address(new RiskMatchLiquidationFacet()), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();

        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
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
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 300, 1000);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 300, 1000);
        TestMutatorFacet(address(diamond)).setTierLiquidationLtvBpsAllRaw(8500, 8500, 8500);

        mockLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockERC20, 1e8, 8);
        mockLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockCollateralERC20, 1e8, 8);

        // Create vaults and approve
        lenderVault      = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        borrowerVault    = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        newBorrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(newBorrower);
        vm.prank(lender);      ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        vm.prank(borrower);    ERC20(mockERC20).approve(borrowerVault, type(uint256).max);
        vm.prank(newBorrower); ERC20(mockERC20).approve(newBorrowerVault, type(uint256).max);
        vm.prank(lender);      ERC20(mockCollateralERC20).approve(lenderVault, type(uint256).max);
        vm.prank(borrower);    ERC20(mockCollateralERC20).approve(borrowerVault, type(uint256).max);
        vm.prank(newBorrower); ERC20(mockCollateralERC20).approve(newBorrowerVault, type(uint256).max);

        // Set diamond's country and KYC (needed for cross-facet offer creation in Option 3)
        vm.prank(address(diamond));
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(address(diamond), LibVaipakam.KYCTier.Tier2);

        // Create active loan: lender creates Lender offer, borrower accepts
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
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
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );
        vm.prank(borrower);
        activeLoanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // Give diamond some ERC20 for internal transfers (treasury fee etc.)
        ERC20Mock(mockERC20).mint(address(diamond), 100000 ether);
    }

    // ─── Scenario 8a: Transfer Obligation Via Borrower Offer (Option 2) ──────

    function test_Scenario8a_TransferObligationViaOffer() public {
        // Warp 1 day so there is accrued interest
        vm.warp(block.timestamp + 1 days);

        // newBorrower creates a Borrower offer (matching loan terms)
        vm.prank(newBorrower);
        uint256 borrowerOfferId = OfferCreateFacet(address(diamond)).createOffer(
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
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        // Record balances before transfer
        uint256 borrowerBalBefore = ERC20(mockERC20).balanceOf(borrower);

        // Mock cross-facet calls for vault withdraw (collateral release) and NFT operations
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector), "");
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.mintNFT.selector), "");
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        // Mock HF check to return healthy value
        mockHealthFactor(activeLoanId, 2e18);

        // Expect LoanObligationTransferred event
        vm.expectEmit(true, true, true, false);
        // Topic-only check (data=false in expectEmit above); zero placeholders.
        // (loanId, origBorrower, newBorrower, shortfall, newBorrowerTokenId,
        //  newCollateralAmount, newInterestRateBps, newDurationDays,
        //  newDueTimestamp, newHealthFactor)
        emit PrecloseFacet.LoanObligationTransferred(activeLoanId, borrower, newBorrower, 0, 0, 0, 0, 0, 0, 0);

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
        LibVaipakam.Offer memory offer = OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
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
            abi.encodeWithSelector(OfferCreateFacet.createOfferInternal.selector),
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

        // Step 3: Simulate offer acceptance by writing offer.accepted = true
        // and creator = borrower via the layout-resilient mutator (the
        // pre-T-048 path used hand-packed vm.store on a slot offset that
        // shifted under the PAD storage extension; routing through the
        // named-field setter on TestMutatorFacet keeps this stable).
        // With native NFT locking, completeOffset authorizes via
        // requireBorrowerNFTOwnerOrKeeper — the NFT stays with the
        // borrower, so prank(borrower) is sufficient even though
        // offer.creator is set here.
        LibVaipakam.Offer memory acceptedOffer;
        acceptedOffer.creator = borrower;
        acceptedOffer.accepted = true;
        TestMutatorFacet(address(diamond)).setOffer(expectedNewOfferId, acceptedOffer);

        // Mock cross-facet NFT calls for completeOffset
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        // Expect OffsetCompleted event — (originalLoanId, newOfferId,
        // borrower, newStatus). data=false, so newStatus is a placeholder.
        vm.expectEmit(true, true, true, false);
        emit PrecloseFacet.OffsetCompleted(activeLoanId, expectedNewOfferId, borrower, 0);

        // Complete the offset (permissionless)
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).completeOffset(activeLoanId);

        // Verify: original loan is now Repaid
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid), "Original loan should be Repaid");

        vm.clearMockedCalls();
    }
}
