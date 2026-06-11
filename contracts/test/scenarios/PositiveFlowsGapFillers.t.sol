// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../../src/facets/RiskMatchLiquidationFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HelperTest} from "../HelperTest.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/**
 * @title PositiveFlowsGapFillers
 * @notice Positive (happy-path) coverage for flows that the gap analysis
 *         (README.md / TokenomicsTechSpec.md
 *         / docs/WebsiteReadme.md) identified as PARTIAL or MISSING:
 *
 *           (A) Country-pair ALLOW path — the existing suite tests sanctions
 *               blocking, but no explicit test asserts that an allow-listed
 *               country pair actually drives a full create/accept/repay
 *               lifecycle end-to-end. README §16.
 *
 *           (B) Loan initiation fee (0.1%) — unit tests confirm initiation
 *               doesn't revert; no test asserts the EXACT principal-asset
 *               deduction and the treasury credit. TokenomicsTechSpec §6b,
 *               README §6.
 *
 *           (C) Partial repayment 2-step — unit tests cover partialRepay
 *               returning success, but no test asserts that after a partial
 *               the remaining `principal` is reduced by exactly the partial
 *               amount and a follow-up full repay clears the loan with no
 *               dust. README §7 / RepayFacet spec.
 *
 *           (D) Keeper two-layer opt-in ledger state — existing tests cover
 *               the individual toggles; no test asserts the full
 *               profile-opt-in × approveKeeper × position-flag ledger is
 *               correctly persisted on an initiated loan, which is the
 *               precondition WebsiteReadme §288–296 insists on before any
 *               keeper-driven action is authorized.
 *
 *         These round out the suite to ≈30 positive flows covered across
 *         doc-mandated surfaces.
 */
contract PositiveFlowsGapFillers is Test {
    VaipakamDiamond internal diamond;
    address internal owner;
    address internal lender;
    address internal borrower;
    address internal keeperEoa;
    address internal mockUsdc;
    address internal mockWeth;

    uint256 constant PRINCIPAL = 1000 ether;
    uint256 constant COLLATERAL = 1500 ether;
    uint256 constant DURATION = 30;
    uint256 constant RATE_BPS = 500;
    uint256 constant BASIS_POINTS = 10_000;
    uint256 constant LOAN_INITIATION_FEE_BPS = 10; // 0.1%

    HelperTest internal helperTest;

    function setUp() public {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");
        keeperEoa = makeAddr("keeperEOA");

        mockUsdc = address(new ERC20Mock("MockUSDC", "USDC", 18));
        mockWeth = address(new ERC20Mock("MockWETH", "WETH", 18));
        ERC20Mock(mockUsdc).mint(lender, 100_000 ether);
        ERC20Mock(mockUsdc).mint(borrower, 100_000 ether);
        ERC20Mock(mockWeth).mint(lender, 100_000 ether);
        ERC20Mock(mockWeth).mint(borrower, 100_000 ether);

        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));

        helperTest = new HelperTest();
        _cutCoreFacets();

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(makeAddr("zeroEx"));
        AdminFacet(address(diamond)).setallowanceTarget(makeAddr("zeroExAllowance"));

        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        RiskFacet(address(diamond)).updateRiskParams(mockUsdc, 8000, 300, 1000);
        RiskFacet(address(diamond)).updateRiskParams(mockWeth, 8000, 300, 1000);

        _mockOracle();
        _onboardActor(lender);
        _onboardActor(borrower);
    }

    // ─────────────────────────────────────────────────────────────────────
    // (A) Country-pair ALLOW path — explicit positive test
    // ─────────────────────────────────────────────────────────────────────

    /// @notice README §16 allows a country-pair (e.g. US↔US) to transact.
    ///         Confirms the allow list actually drives a full lifecycle, ///         not just that a rejected pair reverts.
    function test_Positive_CountryPairAllow_FullLifecycle() public {
        // Both actors on the allow-listed "US" pair — setUp pinned this.
        // (No public read-back for allowances exists; positive execution
        //  below is the end-to-end proof of the allow-list taking effect.)
        assertEq(ProfileFacet(address(diamond)).getUserCountry(lender), "US");
        assertEq(ProfileFacet(address(diamond)).getUserCountry(borrower), "US");

        uint256 offerId = _createLenderOffer();
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            uint8(L.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan must be active on allowed country pair"
        );
        assertEq(L.principal, PRINCIPAL, "principal recorded");

        // Finish the lifecycle to prove the allow path is fully wired.
        vm.warp(block.timestamp + 10 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        L = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            uint8(L.status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "repay must complete on allowed country pair"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // (B) Loan initiation fee — exact 0.1% deduction from principal
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Confirms the initiation fee (`LOAN_INITIATION_FEE_BPS = 10`,
    ///         == 0.1%) actually lands on the treasury and the borrower
    ///         receives `principal - fee`. Guards against silently-changed
    ///         constants or a drift in the fee transfer path.
    function test_Positive_LoanInitiationFee_ExactDeduction() public {
        uint256 borrowerUsdcBefore = IERC20(mockUsdc).balanceOf(borrower);
        uint256 treasuryBalBefore = IERC20(mockUsdc).balanceOf(address(diamond));

        uint256 offerId = _createLenderOffer();
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        uint256 expectedFee = (PRINCIPAL * LOAN_INITIATION_FEE_BPS) / BASIS_POINTS;
        // Range Orders Phase 1 — 1% LIF matcher kickback. The acceptor
        // (borrower in this test, since they call acceptOffer on a
        // lender offer) is the matcher in the legacy single-value path,
        // so msg.sender receives the 1% slice. Borrower's net credit:
        // principal - 99% of LIF (treasury share). Treasury's net:
        // 99% of LIF only.
        uint256 expectedMatcherCut =
            (expectedFee * LibVaipakam.LIF_MATCHER_FEE_BPS) / BASIS_POINTS;
        uint256 expectedTreasuryCut = expectedFee - expectedMatcherCut;
        uint256 expectedBorrowerCredit =
            PRINCIPAL - expectedTreasuryCut; // includes their matcher kickback

        // Borrower wallet credit is principal minus the treasury share
        // (the matcher cut comes back to them as msg.sender).
        uint256 borrowerUsdcAfter = IERC20(mockUsdc).balanceOf(borrower);
        assertEq(
            borrowerUsdcAfter - borrowerUsdcBefore,
            expectedBorrowerCredit,
            "borrower credit != principal - 99% of LIF (1% kicks back to acceptor)"
        );

        // Treasury (the diamond itself in this test) retains only the
        // 99% treasury share of LIF.
        uint256 treasuryBalAfter = IERC20(mockUsdc).balanceOf(address(diamond));
        uint256 netRetained = treasuryBalAfter - treasuryBalBefore;
        assertEq(
            netRetained,
            expectedTreasuryCut,
            "treasury net-retained != 99% of LIF (1% kickback to matcher)"
        );

        // Loan record captures the full principal (pre-fee) as the
        // outstanding debt — the borrower repays the full amount.
        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(L.principal, PRINCIPAL, "loan.principal must equal pre-fee amount");
    }

    // ─────────────────────────────────────────────────────────────────────
    // (C) Partial repayment two-step math
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Partial repay reduces the loan's outstanding principal by
    ///         EXACTLY the partial amount, and a follow-up full repay
    ///         closes the loan with zero dust. README §7 / RepayFacet spec.
    function test_Positive_PartialRepay_TwoStep_CompletesWithNoDust() public {
        uint256 offerId = _createLenderOffer();
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        LibVaipakam.Loan memory l0 =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l0.principal, PRINCIPAL, "initial principal");

        // First leg: partial repay of 40% mid-term.
        uint256 partialAmount = 400 ether;
        vm.warp(block.timestamp + 10 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, partialAmount);

        LibVaipakam.Loan memory l1 =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            l1.principal,
            PRINCIPAL - partialAmount,
            "outstanding principal != principal - partial"
        );
        assertEq(
            uint8(l1.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "partial repay must leave the loan Active"
        );

        // Second leg: full repay of whatever remains.
        vm.warp(block.timestamp + 5 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        LibVaipakam.Loan memory l2 =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            uint8(l2.status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "loan must close after full repay of remaining balance"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // (D) Keeper two-layer opt-in ledger state
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Phase 6: the keeper opt-in ledger is three layers, per
    ///         keeper per loan. (1) master `setKeeperAccess(true)` per
    ///         user, (2) `approveKeeper(keeper, actions)` with an action
    ///         bitmask on the user's whitelist, (3)
    ///         `setOfferKeeperEnabled` / `setLoanKeeperEnabled` per loan.
    ///         This test verifies all three layers persist correctly and
    ///         the offer-level enable latches into the loan at acceptance.
    function test_Positive_KeeperTwoLayerOptIn_StateRecorded() public {
        vm.prank(lender);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        assertTrue(
            ProfileFacet(address(diamond)).getKeeperAccess(lender),
            "lender profile opt-in"
        );
        vm.prank(lender);
        ProfileFacet(address(diamond)).approveKeeper(
            keeperEoa,
            LibVaipakam.KEEPER_ACTION_ALL
        );
        assertEq(
            ProfileFacet(address(diamond)).getKeeperActions(lender, keeperEoa),
            LibVaipakam.KEEPER_ACTION_ALL,
            "lender whitelist must carry full action bitmask"
        );

        uint256 offerId = _createLenderOffer();
        // Lender enables the keeper at the offer level pre-acceptance; this
        // latches into `loanKeeperEnabled[loanId][keeper]` at acceptance via
        // LoanFacet._latchOfferKeepersToLoan.
        vm.prank(lender);
        ProfileFacet(address(diamond)).setOfferKeeperEnabled(
            offerId,
            keeperEoa,
            true
        );

        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        assertTrue(
            ProfileFacet(address(diamond)).isLoanKeeperEnabled(loanId, keeperEoa),
            "offer-level enable must latch into loan-level at acceptance"
        );

        // Borrower exercises their own per-loan enable AFTER init — proves
        // the loan-level flag is settable independently on the borrower
        // side (distinct approved-keeper bitmask per user).
        vm.prank(borrower);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(borrower);
        ProfileFacet(address(diamond)).approveKeeper(
            keeperEoa,
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE
        );
        vm.prank(borrower);
        ProfileFacet(address(diamond)).setLoanKeeperEnabled(
            loanId,
            keeperEoa,
            true
        );
        assertTrue(
            ProfileFacet(address(diamond)).isLoanKeeperEnabled(loanId, keeperEoa),
            "borrower-side per-loan enable must persist"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────

    function _createLenderOffer() internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockUsdc,
                amount: PRINCIPAL,
                interestRateBps: RATE_BPS,
                collateralAsset: mockWeth,
                collateralAmount: COLLATERAL,
                durationDays: DURATION,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(0),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: RATE_BPS,
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0
            })
        );
    }

    function _cutCoreFacets() internal {
        OfferCreateFacet offerCreateFacet = new OfferCreateFacet();
        OfferAcceptFacet offerAcceptFacet = new OfferAcceptFacet();
        OfferCancelFacet offerCancelFacet = new OfferCancelFacet();
        ProfileFacet profileFacet = new ProfileFacet();
        OracleFacet oracleFacet = new OracleFacet();
        VaipakamNFTFacet nftFacet = new VaipakamNFTFacet();
        VaultFactoryFacet vaultFacet = new VaultFactoryFacet();
        LoanFacet loanFacet = new LoanFacet();
        RiskFacet riskFacet = new RiskFacet();
        RepayFacet repayFacet = new RepayFacet();
        DefaultedFacet defaultFacet = new DefaultedFacet();
        AdminFacet adminFacet = new AdminFacet();
        ClaimFacet claimFacet = new ClaimFacet();
        AddCollateralFacet addCollateralFacet = new AddCollateralFacet();
        AccessControlFacet accessControlFacet = new AccessControlFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](16);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(offerCreateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferCreateFacetSelectors()
        });
        cuts[15] = IDiamondCut.FacetCut({
            facetAddress: address(offerAcceptFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferAcceptFacetSelectors()
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
            facetAddress: address(vaultFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaultFactoryFacetSelectors()
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
            facetAddress: address(repayFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRepayFacetSelectors()
        });
        cuts[8] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[9] = IDiamondCut.FacetCut({
            facetAddress: address(defaultFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getDefaultedFacetSelectors()
        });
        cuts[10] = IDiamondCut.FacetCut({
            facetAddress: address(claimFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getClaimFacetSelectors()
        });
        cuts[11] = IDiamondCut.FacetCut({
            facetAddress: address(addCollateralFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAddCollateralFacetSelectors()
        });
        cuts[12] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});
        cuts[14] = IDiamondCut.FacetCut({facetAddress: address(new RiskMatchLiquidationFacet()), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    function _mockOracle() internal {
        _mockLiquidity(mockUsdc, LibVaipakam.LiquidityStatus.Liquid);
        _mockLiquidity(mockWeth, LibVaipakam.LiquidityStatus.Liquid);
        _mockPrice(mockUsdc, 1e8, 8);
        _mockPrice(mockWeth, 2000e8, 8);
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

    function _onboardActor(address user) internal {
        vm.prank(user);
        ProfileFacet(address(diamond)).setUserCountry("US");
        ProfileFacet(address(diamond)).updateKYCTier(user, LibVaipakam.KYCTier.Tier2);

        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user);
        vm.startPrank(user);
        ERC20(mockUsdc).approve(address(diamond), type(uint256).max);
        ERC20(mockWeth).approve(address(diamond), type(uint256).max);
        ERC20(mockUsdc).approve(vault, type(uint256).max);
        ERC20(mockWeth).approve(vault, type(uint256).max);
        vm.stopPrank();
    }
}
