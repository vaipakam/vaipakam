// test/AddCollateralFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
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
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ZeroExProxyMock} from "./mocks/ZeroExProxyMock.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";

/**
 * @title AddCollateralFacetTest
 * @notice Tests the AddCollateralFacet which allows borrowers to top up liquid
 *         ERC-20 collateral on active loans to reduce LTV and avoid liquidation.
 */
contract AddCollateralFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    address mockERC20;
    address mockCollateralERC20;
    address mockIlliquidERC20;
    address mockNFT721;
    address mockZeroExProxy;

    uint256 constant BASIS_POINTS = 10000;

    // Facet instances
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

        mockERC20 = address(new ERC20Mock("MockLiquid", "MLQ", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockIlliquidERC20 = address(new ERC20Mock("MockIlliquid", "MIL", 18));
        mockNFT721 = address(new MockRentableNFT721());
        mockZeroExProxy = address(new ZeroExProxyMock());

        ERC20Mock(mockERC20).mint(lender, 100000 ether);
        ERC20Mock(mockERC20).mint(borrower, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(lender, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(borrower, 100000 ether);
        ERC20Mock(mockIlliquidERC20).mint(borrower, 100000 ether);
        MockRentableNFT721(mockNFT721).mint(lender, 1);
        ERC20Mock(mockERC20).mint(address(mockZeroExProxy), 1000000 ether);
        ERC20Mock(mockCollateralERC20).mint(address(mockZeroExProxy), 1000000 ether);
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10);

        // Deploy facets
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

        // Cut all facets
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

        // Initialize access control roles (must be first — all admin calls require roles)
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Init admin state
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(mockZeroExProxy);
        AdminFacet(address(diamond)).setallowanceTarget(mockZeroExProxy);

        // Token approvals
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockIlliquidERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        MockRentableNFT721(mockNFT721).approve(address(diamond), 1);

        // Oracle mocks
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockIlliquidERC20, LibVaipakam.LiquidityStatus.Illiquid);
        mockOracleLiquidity(mockNFT721, LibVaipakam.LiquidityStatus.Illiquid);
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);

        // Country / KYC
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

        // Risk params and HF/LTV mocks
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(2e18));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(6666));
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 8500, 300, 1000);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 8500, 300, 1000);

        // Escrow approvals
        vm.prank(lender);
        ERC20(mockERC20).approve(EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockERC20).approve(EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower), type(uint256).max);
        vm.prank(lender);
        ERC20(mockCollateralERC20).approve(EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockIlliquidERC20).approve(EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower), type(uint256).max);
        vm.prank(lender);
        IERC721(mockNFT721).setApprovalForAll(EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender), true);
    }

    /// @dev Creates a lender offer and borrower accepts it to initiate a liquid ERC20 loan.
    function _createActiveLiquidLoan() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1500 ether,
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
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        loanId = 1;
    }

    /// @dev Creates a loan with illiquid collateral (mockIlliquidERC20).
    function _createActiveIlliquidLoan() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockIlliquidERC20,
                collateralAmount: 1500 ether,
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
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        loanId = 1;
    }

    // ─── addCollateral — success ──────────────────────────────────────────────

    function testAddCollateralSuccess() public {
        uint256 loanId = _createActiveLiquidLoan();

        LibVaipakam.Loan memory loanBefore = LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 addAmount = 500 ether;

        vm.prank(borrower);
        vm.expectEmit(true, true, false, false);
        emit AddCollateralFacet.CollateralAdded(loanId, borrower, addAmount, loanBefore.collateralAmount + addAmount, 0, 0);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, addAmount);

        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loanAfter.collateralAmount, loanBefore.collateralAmount + addAmount);
    }

    function testAddCollateralMovesTokensIntoEscrow() public {
        uint256 loanId = _createActiveLiquidLoan();

        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        uint256 escrowBalBefore = IERC20(mockCollateralERC20).balanceOf(borrowerEscrow);
        uint256 borrowerBalBefore = IERC20(mockCollateralERC20).balanceOf(borrower);
        uint256 addAmount = 200 ether;

        vm.prank(borrower);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, addAmount);

        assertEq(IERC20(mockCollateralERC20).balanceOf(borrowerEscrow) - escrowBalBefore, addAmount);
        assertEq(borrowerBalBefore - IERC20(mockCollateralERC20).balanceOf(borrower), addAmount);
    }

    // ─── addCollateral — reverts ──────────────────────────────────────────────

    function testAddCollateralRevertsIfNotEffectiveBorrowerNFTOwner() public {
        uint256 loanId = _createActiveLiquidLoan();

        // Auth is the current borrower-side NFT owner. The lender has no
        // claim on the borrower token, so addCollateral must revert for them.
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 100 ether);
    }

    function testAddCollateralRevertsIfZeroAmount() public {
        uint256 loanId = _createActiveLiquidLoan();

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.InvalidAmount.selector);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 0);
    }

    function testAddCollateralRevertsIfIlliquidAsset() public {
        // Mock principal (mockERC20) as illiquid so both assets match liquidity
        // and MixedCollateralNotAllowed is not triggered during loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 loanId = _createActiveIlliquidLoan();
        // Restore mockERC20 to liquid so the rest of the test suite is unaffected
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.IlliquidAsset.selector);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 100 ether);
    }

    function testAddCollateralRevertsIfLoanNotActive() public {
        uint256 loanId = _createActiveLiquidLoan();

        // Repay to move loan out of Active
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.LoanNotActive.selector);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 100 ether);
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Covers line 101: `if (!success) revert CrossFacetCallFailed("Get borrower escrow failed")`.
    function testAddCollateralGetEscrowFails() public {
        uint256 loanId = _createActiveLiquidLoan();
        // Mock getOrCreateUserEscrow to revert → CrossFacetCallFailed
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector),
            "escrow fail"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("escrow fail"));
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 100 ether);
        vm.clearMockedCalls();
    }

    /// @dev Tests that when calculateHF staticcall fails gracefully, event still emits with newHF=0.
    ///      This covers the `if (success && result.length > 0)` FALSE branch.
    function testAddCollateralHFCalcFailGraceful() public {
        uint256 loanId = _createActiveLiquidLoan();

        // Mock calculateHealthFactor to revert (staticcall failure)
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            "mock revert"
        );
        // Mock calculateLTV to also revert
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            "mock revert"
        );

        LibVaipakam.Loan memory loanBefore = LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 addAmount = 100 ether;

        // Should not revert — failures in HF/LTV calc are swallowed (best-effort)
        vm.prank(borrower);
        vm.expectEmit(true, true, false, false);
        emit AddCollateralFacet.CollateralAdded(loanId, borrower, addAmount, loanBefore.collateralAmount + addAmount, 0, 0);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, addAmount);

        vm.clearMockedCalls();
    }
}
