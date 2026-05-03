// test/ClaimFacetTest.t.sol
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
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ZeroExProxyMock} from "./mocks/ZeroExProxyMock.sol";
import {MockZeroExLegacyAdapter} from "./mocks/MockZeroExLegacyAdapter.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";

/**
 * @title ClaimFacetTest
 * @notice Tests the claim-based fund distribution model: lender and borrower
 *         must present their Vaipakam NFT after loan resolution to collect funds.
 */
contract ClaimFacetTest is Test {
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
    TestMutatorFacet testMutatorFacet;
    HelperTest helperTest;
    VaipakamEscrowImplementation escrowImpl;

    function _setLoanAssetType(uint256 loanId, LibVaipakam.AssetType at) internal {
        LibVaipakam.Loan memory ld = LoanFacet(address(diamond)).getLoanDetails(loanId);
        ld.assetType = at;
        TestMutatorFacet(address(diamond)).setLoan(loanId, ld);
    }

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
        testMutatorFacet = new TestMutatorFacet();
        helperTest = new HelperTest();
        escrowImpl = new VaipakamEscrowImplementation();

        // Cut all facets
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
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(testMutatorFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getTestMutatorFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Initialize access control roles
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Init admin state
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(mockZeroExProxy);
        AdminFacet(address(diamond)).setallowanceTarget(mockZeroExProxy);

        // Phase 7a: register the legacy ZeroEx shim as adapter slot 0
        // so triggerLiquidation / triggerDefault / claimAsLenderWithRetry
        // route through LibSwap into the existing ZeroExProxyMock.
        AdminFacet(address(diamond)).addSwapAdapter(
            address(new MockZeroExLegacyAdapter(address(mockZeroExProxy)))
        );

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
        mockOraclePrice(mockERC20, 1e8, 8); // $1 with 8 decimals
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

    /// @dev Creates a lender offer and borrower accepts it to initiate a loan.
    function _createAndAcceptERC20Loan(
        uint256 principalAmount,
        uint256 collateralAmount,
        uint256 durationDays
    ) internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: principalAmount,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: collateralAmount,
                durationDays: durationDays,
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
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        loanId = 1; // First loan
    }

    /// @dev Repays the loan so it transitions to Repaid state, enabling claims.
    function _repayLoan(uint256 loanId) internal {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        // Provide enough for interest; actual amount calculated by repaymentAmount
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
    }

    // ─── getClaimableAmount ───────────────────────────────────────────────────

    function testGetClaimableAmountActiveReturnsZero() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        (address asset, uint256 amount, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(asset, address(0));
        assertEq(amount, 0);
        assertFalse(claimed);
    }

    function testGetClaimableAmountAfterRepay() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Lender should have a claim (principal + interest)
        (, uint256 lenderAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(lenderAmount, 0);

        // Borrower should have a claim (collateral)
        (, uint256 borrowerAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertGt(borrowerAmount, 0);
    }

    // ─── claimAsLender ────────────────────────────────────────────────────────

    function testClaimAsLenderSuccessAfterRepay() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        (, uint256 claimAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);

        uint256 lenderBalBefore = IERC20(mockERC20).balanceOf(lender);

        vm.prank(lender);
        vm.expectEmit(true, true, false, true);
        emit ClaimFacet.LenderFundsClaimed(loanId, lender, mockERC20, claimAmount);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        // Lender received the funds
        assertEq(IERC20(mockERC20).balanceOf(lender) - lenderBalBefore, claimAmount);

        // Claim marked as done
        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertTrue(claimed);
    }

    function testClaimAsLenderRevertsIfActiveLoan() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);

        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
    }

    function testClaimAsLenderRevertsIfAlreadyClaimed() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        vm.prank(lender);
        vm.expectRevert(ClaimFacet.AlreadyClaimed.selector);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
    }

    function testClaimAsLenderRevertsIfNotNFTOwner() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // borrower tries to claim as lender
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
    }

    // ─── claimAsBorrower ──────────────────────────────────────────────────────

    function testClaimAsBorrowerSuccessAfterRepay() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        (, uint256 claimAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);

        uint256 borrowerBalBefore = IERC20(mockCollateralERC20).balanceOf(borrower);

        vm.prank(borrower);
        vm.expectEmit(true, true, false, true);
        emit ClaimFacet.BorrowerFundsClaimed(loanId, borrower, mockCollateralERC20, claimAmount);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        assertEq(IERC20(mockCollateralERC20).balanceOf(borrower) - borrowerBalBefore, claimAmount);

        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertTrue(claimed);
    }

    function testClaimAsBorrowerRevertsIfNothingToClaim() public {
        // After default with illiquid collateral, borrower has no claim (full collateral goes to lender)
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);

        // Warp past grace period
        uint256 endTime = block.timestamp + 30 days;
        vm.warp(endTime + LibVaipakam.gracePeriod(30) + 1);

        // Mock illiquid for collateral to take the illiquid default path
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, mockCollateralERC20),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Borrower has no claim after illiquid default
        vm.prank(borrower);
        vm.expectRevert(ClaimFacet.NothingToClaim.selector);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
    }

    function testClaimAsBorrowerRevertsIfActiveLoan() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
    }

    function testClaimAsBorrowerRevertsIfNotNFTOwner() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // lender tries to claim as borrower
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
    }

    // ─── Loan Settled ─────────────────────────────────────────────────────────

    function testLoanSettledAfterBothClaim() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Lender claims
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        // Borrower claims — should settle the loan
        vm.prank(borrower);
        vm.expectEmit(true, false, false, false);
        emit ClaimFacet.LoanSettled(loanId);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled));
    }

    function testLoanSettledWhenLenderClaimsAndBorrowerHasNoClaim() public {
        // Illiquid default: only lender has claim; borrower has nothing → loan settles when lender claims
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);

        uint256 endTime = block.timestamp + 30 days;
        vm.warp(endTime + LibVaipakam.gracePeriod(30) + 1);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, mockCollateralERC20),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Loan is Defaulted; borrower has no claim — lender claiming should settle immediately
        vm.prank(lender);
        vm.expectEmit(true, false, false, false);
        emit ClaimFacet.LoanSettled(loanId);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled));
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Tests claimAsLender reverts if loan is Settled (not Repaid/Defaulted).
    function testClaimAsLenderRevertsIfLoanSettled() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Both parties claim to settle the loan
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        // Now try to claim again after the loan is Settled
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
    }

    /// @dev Tests claimAsBorrower reverts if already claimed.
    function testClaimAsBorrowerRevertsIfAlreadyClaimed() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        vm.prank(borrower);
        vm.expectRevert(ClaimFacet.AlreadyClaimed.selector);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
    }

    /// @dev Tests that claimAsBorrower settles the loan when lender has already claimed.
    function testLoanSettledWhenBorrowerClaimsAndLenderAlreadyClaimed() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Lender claims first
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        // Borrower claims — loan should settle
        vm.prank(borrower);
        vm.expectEmit(true, false, false, false);
        emit ClaimFacet.LoanSettled(loanId);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled));
    }

    /// @dev Tests cross-facet call failure in claimAsLender (escrow withdraw fails).
    function testClaimAsLenderCrossFacetFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Mock escrowWithdrawERC20 to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            "mock revert"
        );
        vm.prank(lender);
        vm.expectRevert(bytes("mock revert"));
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests cross-facet call failure in claimAsBorrower (escrow withdraw fails).
    function testClaimAsBorrowerCrossFacetFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Mock escrowWithdrawERC20 to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            "mock revert"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("mock revert"));
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests getClaimableAmount for lender with isLender=true after default (covers Defaulted status branch).
    function testGetClaimableAmountAfterDefault() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);

        uint256 endTime = block.timestamp + 30 days;
        vm.warp(endTime + LibVaipakam.gracePeriod(30) + 1);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, mockCollateralERC20),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        (, uint256 lenderAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(lenderAmount, 0);
    }

    /// @dev Covers CrossFacetCallFailed("Burn lender NFT failed") in claimAsLender.
    function testClaimAsLenderBurnNFTFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Allow escrow withdraw but fail burnNFT
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector),
            "burn failed"
        );
        vm.prank(lender);
        vm.expectRevert(bytes("burn failed"));
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Covers CrossFacetCallFailed("Burn borrower NFT failed") in claimAsBorrower.
    function testClaimAsBorrowerBurnNFTFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Allow escrow withdraw but fail burnNFT
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector),
            "burn failed"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("burn failed"));
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Covers line 101: `if (claim.amount == 0) revert NothingToClaim()` in claimAsLender.
    ///      Sets loan to Repaid state with lender claim amount = 0 (before any claim is set).
    function testClaimAsLenderRevertsIfNothingToClaim() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Zero out lenderClaims[loanId].amount via vm.store
        // lenderClaims is at BASE+22
        TestMutatorFacet(address(diamond)).setLenderClaimAmountRaw(loanId, 0);

        vm.prank(lender);
        vm.expectRevert(ClaimFacet.NothingToClaim.selector);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
    }

    /// @dev Covers heldForLender > 0 path in claimAsLender.
    function testClaimAsLenderWithHeldForLender() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Set heldForLender[loanId] > 0 via vm.store
        TestMutatorFacet(address(diamond)).setHeldForLenderRaw(loanId, 50 ether);

        // Mint enough to lender's escrow for the held amount
        address lenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        ERC20Mock(mockERC20).mint(lenderEscrow, 50 ether);

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertTrue(claimed);
    }

    /// @dev Covers held-for-lender claim failure path.
    function testClaimAsLenderHeldForLenderFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Set heldForLender > 0
        TestMutatorFacet(address(diamond)).setHeldForLenderRaw(loanId, 50 ether);

        // Mock first escrow withdraw to succeed (claim.amount), second to fail (held)
        // Since we can't easily differentiate, mock all escrow withdrawals to fail after
        // the first claim transfer. Use a different approach: set claim.amount = 0 so
        // only held path is taken, then mock it to fail.
        TestMutatorFacet(address(diamond)).setLenderClaimAmountRaw(loanId, 0);

        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            "mock fail"
        );

        vm.prank(lender);
        vm.expectRevert(bytes("mock fail"));
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Covers hasHeld=true path making NothingToClaim check pass when claim.amount=0
    function testClaimAsLenderWithHeldOnlyNoClaimAmount() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Set claim.amount = 0 but heldForLender > 0
        TestMutatorFacet(address(diamond)).setLenderClaimAmountRaw(loanId, 0);

        TestMutatorFacet(address(diamond)).setHeldForLenderRaw(loanId, 50 ether);

        address lenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        ERC20Mock(mockERC20).mint(lenderEscrow, 50 ether);

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertTrue(claimed);
    }

    /// @dev Covers ERC721 return path in claimAsLender.
    function testClaimAsLenderERC721Return() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Override loan assetType to ERC721 to trigger ERC721 return branch
        _setLoanAssetType(loanId, LibVaipakam.AssetType.ERC721);

        // Mock the escrow withdraw ERC721 to succeed
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC721.selector), abi.encode(true));

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertTrue(claimed);
        vm.clearMockedCalls();
    }

    /// @dev Covers ERC1155 return path in claimAsLender.
    function testClaimAsLenderERC1155Return() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Override loan assetType to ERC1155
        _setLoanAssetType(loanId, LibVaipakam.AssetType.ERC1155);

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector), abi.encode(true));

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertTrue(claimed);
        vm.clearMockedCalls();
    }

    /// @dev Covers ERC721 return failure path.
    function testClaimAsLenderERC721ReturnFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        _setLoanAssetType(loanId, LibVaipakam.AssetType.ERC721);

        vm.mockCallRevert(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC721.selector), "fail");

        vm.prank(lender);
        vm.expectRevert(bytes("fail"));
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Covers ERC1155 return failure path.
    function testClaimAsLenderERC1155ReturnFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        _setLoanAssetType(loanId, LibVaipakam.AssetType.ERC1155);

        vm.mockCallRevert(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector), "fail");

        vm.prank(lender);
        vm.expectRevert(bytes("fail"));
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.clearMockedCalls();
    }

    // ─── Tests A–G: NFT-typed claims and settlement edge cases ─────────

    /// @dev Test A: claimAsLender with ERC721 claim asset type.
    function testClaimAsLenderWithERC721ClaimAsset() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Override lenderClaims[loanId].assetType to ERC721 (=1) via vm.store
        TestMutatorFacet(address(diamond)).setLenderClaimNFTFieldsRaw(loanId, LibVaipakam.AssetType.ERC721, 42, 0);

        // Mock escrowWithdrawERC721 to succeed (for the ERC721 claim transfer)
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC721.selector), abi.encode(true));

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertTrue(claimed);
        vm.clearMockedCalls();
    }

    /// @dev Test B: claimAsLender with ERC1155 claim asset type.
    function testClaimAsLenderWithERC1155ClaimAsset() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        TestMutatorFacet(address(diamond)).setLenderClaimNFTFieldsRaw(loanId, LibVaipakam.AssetType.ERC1155, 42, 10);

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector), abi.encode(true));

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertTrue(claimed);
        vm.clearMockedCalls();
    }

    /// @dev Test C: claimAsBorrower with ERC721 claim asset type.
    function testClaimAsBorrowerWithERC721ClaimAsset() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        TestMutatorFacet(address(diamond)).setBorrowerClaimNFTFieldsRaw(loanId, LibVaipakam.AssetType.ERC721, 42, 0);

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC721.selector), abi.encode(true));

        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertTrue(claimed);
        vm.clearMockedCalls();
    }

    /// @dev Test D: claimAsBorrower with ERC1155 claim asset type.
    function testClaimAsBorrowerWithERC1155ClaimAsset() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        TestMutatorFacet(address(diamond)).setBorrowerClaimNFTFieldsRaw(loanId, LibVaipakam.AssetType.ERC1155, 42, 10);

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector), abi.encode(true));

        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertTrue(claimed);
        vm.clearMockedCalls();
    }

    /// @dev Test E: claimAsLender with ERC721 claim asset type, transfer fails.
    function testClaimAsLenderERC721TransferFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        TestMutatorFacet(address(diamond)).setLenderClaimNFTFieldsRaw(loanId, LibVaipakam.AssetType.ERC721, 42, 0);

        vm.mockCallRevert(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC721.selector), "nft fail");

        vm.prank(lender);
        vm.expectRevert(bytes("nft fail"));
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Test F: claimAsBorrower with ERC1155 claim asset type, transfer fails.
    function testClaimAsBorrowerERC1155TransferFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        TestMutatorFacet(address(diamond)).setBorrowerClaimNFTFieldsRaw(loanId, LibVaipakam.AssetType.ERC1155, 42, 10);

        vm.mockCallRevert(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector), "nft fail");

        vm.prank(borrower);
        vm.expectRevert(bytes("nft fail"));
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Test G: Loan settles when lender claims and borrower claim amount is 0 with ERC20 type.
    function testLoanSettledWhenBorrowerClaimAmountZero() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Set borrowerClaims[loanId]: amount=0, assetType=ERC20(0), claimed=false
        TestMutatorFacet(address(diamond)).setBorrowerClaimAmountRaw(loanId, 0);
        TestMutatorFacet(address(diamond)).setBorrowerClaimNFTFieldsRaw(
            loanId,
            LibVaipakam.AssetType.ERC20,
            0,
            0
        );
        // The `claimed` field defaults to false on a fresh ClaimInfo;
        // _repayLoan never marks claimed=true, so no setter needed.

        // Lender claims; borrower has nothing to claim (amount=0, ERC20) → loan settles
        vm.prank(lender);
        vm.expectEmit(true, false, false, false);
        emit ClaimFacet.LoanSettled(loanId);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled));
    }

    /// @dev Covers lenderClaim.amount == 0 settle path in claimAsBorrower.
    ///      When borrower claims but lender claim amount is 0, loan settles immediately.
    function testClaimAsBorrowerSettlesWhenLenderHasNoClaim() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Manually zero out lenderClaims[loanId].amount via vm.store
        // lenderClaims is at BASE+22 (mapping), slot = keccak256(abi.encode(loanId, BASE+22))
        TestMutatorFacet(address(diamond)).setLenderClaimAmountRaw(loanId, 0);

        vm.prank(borrower);
        vm.expectEmit(true, false, false, false);
        emit ClaimFacet.LoanSettled(loanId);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Settled));
        vm.clearMockedCalls();
    }

    // ─── Additional branch coverage: ERC1155 claim failure, ERC721 borrower claim failure,
    //     lenderHasHeld prevents settle, lenderHasNFTCollateralClaim prevents settle ─────

    /// @dev Covers ERC1155 claim transfer failure path in claimAsLender (line 148-149).
    function testClaimAsLenderERC1155ClaimTransferFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Override lenderClaims[loanId] to a non-zero ERC1155 NFT claim
        // (assetType=2, tokenId=42, quantity=10), keeping amount = 0
        // so the path under test is the NFT-claim transfer, not the
        // ERC20 amount transfer.
        TestMutatorFacet(address(diamond)).setLenderClaimAmountRaw(loanId, 0);
        TestMutatorFacet(address(diamond)).setLenderClaimNFTFieldsRaw(
            loanId,
            LibVaipakam.AssetType.ERC1155,
            42,
            10
        );

        // Mock escrowWithdrawERC1155 to fail
        vm.mockCallRevert(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector), "nft fail");

        vm.prank(lender);
        vm.expectRevert(bytes("nft fail"));
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Covers ERC721 claim transfer failure path in claimAsBorrower (line 273-282).
    function testClaimAsBorrowerERC721ClaimTransferFails() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Override borrowerClaims[loanId].assetType to ERC721 (=1) via vm.store
        TestMutatorFacet(address(diamond)).setBorrowerClaimNFTFieldsRaw(loanId, LibVaipakam.AssetType.ERC721, 42, 0);

        // Mock escrowWithdrawERC721 to fail
        vm.mockCallRevert(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC721.selector), "nft fail");

        vm.prank(borrower);
        vm.expectRevert(bytes("nft fail"));
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Covers lenderHasHeld check in claimAsBorrower (line 319): when borrower claims first
    ///      and heldForLender > 0, loan should NOT settle (lender still has unclaimed held funds).
    function testClaimAsBorrowerDoesNotSettleWhenLenderHasHeld() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Set heldForLender[loanId] > 0 so lender still has something to claim
        TestMutatorFacet(address(diamond)).setHeldForLenderRaw(loanId, 50 ether);

        // Borrower claims first
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        // Loan should NOT be settled because lender still has held funds
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid), "Loan must not settle when lender has held funds");
    }

    /// @dev Covers lenderHasNFTCollateralClaim check in claimAsBorrower (line 321):
    ///      when borrower claims first and lenderClaim.assetType != ERC20, loan should NOT settle.
    function testClaimAsBorrowerDoesNotSettleWhenLenderHasNFTCollateralClaim() public {
        uint256 loanId = _createAndAcceptERC20Loan(1000 ether, 1500 ether, 30);
        _repayLoan(loanId);

        // Set lenderClaims[loanId].assetType to ERC721 (=1), but amount=0 and not claimed
        TestMutatorFacet(address(diamond)).setLenderClaimAmountRaw(loanId, 0);
        TestMutatorFacet(address(diamond)).setLenderClaimNFTFieldsRaw(
            loanId,
            LibVaipakam.AssetType.ERC721,
            0,
            0
        );

        // Borrower claims first
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        // Loan should NOT be settled because lender has an NFT collateral claim
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid), "Loan must not settle when lender has NFT collateral claim");
    }
}
