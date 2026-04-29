// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title KYCTierEnforcementIntegration
 * @notice End-to-end integration coverage for the Phase-1 load-bearing
 *         compliance gate: with country-pair restrictions disabled (see
 *         {LibVaipakam.canTradeBetween}), the tiered KYC thresholds are
 *         the sole on-chain policy blocking high-value activity by
 *         unverified wallets.
 *
 *         Covers the full matrix:
 *           - Tier 0 (no KYC)  — allowed only below $1,000 USD notional.
 *           - Tier 1 (email)   — allowed in the $1,000 – $9,999 band.
 *           - Tier 2 (full)    — allowed at $10,000+.
 *
 *         Each rung is exercised via the full offer → accept path so the
 *         test doubles as a regression guard for `OfferFacet.acceptOffer`
 *         and `_calculateTransactionValueUSD`, not just the
 *         `ProfileFacet.meetsKYCRequirement` view (which has unit-level
 *         coverage).
 *
 *         Enforcement is toggled on in `setUp()` via
 *         `AdminFacet.setKYCEnforcement(true)` — mirrors the ops flip
 *         that will happen at production bring-up once the KYC admin
 *         role has onboarded its first cohort.
 */
contract KYCTierEnforcementIntegration is Test {
    VaipakamDiamond internal diamond;
    address internal owner;
    address internal lender; // always Tier-2, creates offers
    address internal borrower; // KYC tier varies per test
    address internal mockUSDC;
    address internal mockWETH;

    uint256 constant DURATION = 30;
    uint256 constant RATE_BPS = 500;

    // Priced at $1 / 1 USDC and $2000 / 1 WETH below. The transaction-value
    // calculation sums BOTH legs (principal + collateral) in USD, so the
    // collateral leg is kept deliberately tiny so that the principal
    // dominates the threshold math. With COLLATERAL_ERC20 = 0.05 ether the
    // collateral contributes a flat ~$100 to valueUSD regardless of band:
    //   400   USDC principal → valueUSD ≈ $500   (under $1k → Tier-0 ok)
    //   2,500 USDC principal → valueUSD ≈ $2,600 (requires Tier-1)
    //   15,000 USDC principal → valueUSD ≈ $15,100 (requires Tier-2)
    // HF is oracle-mocked to 2.0 so the small collateral doesn't fail the
    // Health-Factor gate at acceptOffer.
    uint256 constant PRINCIPAL_UNDER_TIER0 = 400 ether;
    uint256 constant PRINCIPAL_BETWEEN_TIER0_AND_TIER1 = 2_500 ether;
    uint256 constant PRINCIPAL_ABOVE_TIER1 = 15_000 ether;
    uint256 constant COLLATERAL_ERC20 = 0.05 ether; // ~$100 at $2k WETH

    HelperTest internal helperTest;

    function setUp() public {
        owner = address(this);
        lender = makeAddr("kyc-int-lender");
        borrower = makeAddr("kyc-int-borrower");

        mockUSDC = address(new ERC20Mock("MockUSDC", "USDC", 18));
        mockWETH = address(new ERC20Mock("MockWETH", "WETH", 18));
        ERC20Mock(mockUSDC).mint(lender, 1_000_000 ether);
        ERC20Mock(mockUSDC).mint(borrower, 1_000_000 ether);
        ERC20Mock(mockWETH).mint(lender, 10_000 ether);
        ERC20Mock(mockWETH).mint(borrower, 10_000 ether);

        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        helperTest = new HelperTest();
        _cutCoreFacets();

        AccessControlFacet(address(diamond)).initializeAccessControl();
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(makeAddr("zeroEx"));
        AdminFacet(address(diamond)).setallowanceTarget(makeAddr("zeroExAllowance"));

        // Country-pair sanctions are disabled at the protocol level (Phase 1)
        // but the trade-allowance storage still accepts writes; setting US-US
        // keeps the existing negative tests honest without touching behaviour.
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        RiskFacet(address(diamond)).updateRiskParams(mockUSDC, 8000, 8500, 300, 1000);
        RiskFacet(address(diamond)).updateRiskParams(mockWETH, 8000, 8500, 300, 1000);

        _mockOracle();

        // Lender pinned at Tier-2 so it never becomes the gating side — every
        // revert below is attributable to the borrower's tier state.
        _onboardActorAtTier(lender, LibVaipakam.KYCTier.Tier2);
        // Borrower starts at Tier-0 (default). Individual tests upgrade the
        // tier mid-flow to exercise the threshold boundaries.
        _onboardActorAtTier(borrower, LibVaipakam.KYCTier.Tier0);

        // Flip KYC enforcement on — this is what makes the tier check
        // load-bearing. Without this, meetsKYCRequirement returns true
        // unconditionally and the test wouldn't assert anything useful.
        AdminFacet(address(diamond)).setKYCEnforcement(true);
    }

    // ─── Tier-0: blocked above $1k threshold ────────────────────────────

    /// @notice A Tier-0 borrower can accept a small (< $1k) offer — the
    ///         tiered-KYC gate is a no-op below the Tier-0 threshold.
    function test_Tier0_AllowedBelowTier0Threshold() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_UNDER_TIER0);
        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(L.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    /// @notice A Tier-0 borrower attempting a $2.5k loan reverts
    ///         KYCRequired — Tier-1 is the minimum for the $1k–$10k band.
    function test_Tier0_BlockedAboveTier0Threshold() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_BETWEEN_TIER0_AND_TIER1);
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.KYCRequired.selector);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ─── Tier-1: passes the middle band, blocked above $10k ─────────────

    /// @notice After the borrower upgrades to Tier-1, the same $2.5k offer
    ///         now accepts cleanly. Guards against a regression where the
    ///         tier comparison inverts or the threshold math drifts.
    function test_Tier1_AllowedInMiddleBand() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_BETWEEN_TIER0_AND_TIER1);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier1);
        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(L.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    /// @notice A Tier-1 borrower attempting a $15k loan reverts KYCRequired.
    ///         Tier-2 is the minimum above the $10k threshold.
    function test_Tier1_BlockedAboveTier1Threshold() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_ABOVE_TIER1);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier1);
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.KYCRequired.selector);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ─── Tier-2: unlimited ───────────────────────────────────────────────

    /// @notice Tier-2 borrower clears every threshold. End-to-end proof that
    ///         the full KYC gate chains through OfferFacet.acceptOffer.
    function test_Tier2_AllowedAboveTier1Threshold() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_ABOVE_TIER1);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(L.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    // ─── Enforcement toggle — confirms the gate can be disabled ─────────

    /// @notice With KYC enforcement OFF, the same Tier-0 borrower can take
    ///         the $2.5k loan that previously reverted. Exercises the
    ///         global bypass flag at {AdminFacet.setKYCEnforcement}.
    function test_EnforcementOff_Tier0AllowedAboveThreshold() public {
        AdminFacet(address(diamond)).setKYCEnforcement(false);
        uint256 offerId = _lenderOffer(PRINCIPAL_BETWEEN_TIER0_AND_TIER1);
        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(L.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _lenderOffer(uint256 principal) internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockUSDC,
                amount: principal,
                interestRateBps: RATE_BPS,
                collateralAsset: mockWETH,
                collateralAmount: COLLATERAL_ERC20,
                durationDays: DURATION,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(0),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false
            })
        );
    }

    function _cutCoreFacets() internal {
        OfferFacet offerFacet = new OfferFacet();
        ProfileFacet profileFacet = new ProfileFacet();
        OracleFacet oracleFacet = new OracleFacet();
        VaipakamNFTFacet nftFacet = new VaipakamNFTFacet();
        EscrowFactoryFacet escrowFacet = new EscrowFactoryFacet();
        LoanFacet loanFacet = new LoanFacet();
        RiskFacet riskFacet = new RiskFacet();
        AdminFacet adminFacet = new AdminFacet();
        AccessControlFacet accessControlFacet = new AccessControlFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](9);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(offerFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(profileFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getProfileFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(oracleFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOracleFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(nftFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaipakamNFTFacetSelectors()
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(escrowFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getEscrowFactoryFacetSelectors()
        });
        cuts[5] = IDiamondCut.FacetCut({
            facetAddress: address(loanFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getLoanFacetSelectors()
        });
        cuts[6] = IDiamondCut.FacetCut({
            facetAddress: address(riskFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRiskFacetSelectors()
        });
        cuts[7] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[8] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    function _mockOracle() internal {
        _mockLiquidity(mockUSDC, LibVaipakam.LiquidityStatus.Liquid);
        _mockLiquidity(mockWETH, LibVaipakam.LiquidityStatus.Liquid);
        _mockPrice(mockUSDC, 1e8, 8); // $1 per USDC
        _mockPrice(mockWETH, 2000e8, 8); // $2000 per WETH — collateral well above HF floor
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(2e18))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(5000))
        );
    }

    function _mockLiquidity(
        address asset,
        LibVaipakam.LiquidityStatus status
    ) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset),
            abi.encode(status)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidityOnActiveNetwork.selector,
                asset
            ),
            abi.encode(status)
        );
    }

    function _mockPrice(address asset, uint256 price, uint8 decs) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encode(price, decs)
        );
    }

    function _onboardActorAtTier(
        address user,
        LibVaipakam.KYCTier tier
    ) internal {
        vm.prank(user);
        ProfileFacet(address(diamond)).setUserCountry("US");
        ProfileFacet(address(diamond)).updateKYCTier(user, tier);
        address escrow =
            EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user);
        vm.startPrank(user);
        ERC20(mockUSDC).approve(address(diamond), type(uint256).max);
        ERC20(mockWETH).approve(address(diamond), type(uint256).max);
        ERC20(mockUSDC).approve(escrow, type(uint256).max);
        ERC20(mockWETH).approve(escrow, type(uint256).max);
        vm.stopPrank();
    }
}
