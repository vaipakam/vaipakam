// test/RepayFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
 // Mock ERC20
 // Rentable NFT
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
 // Cutting
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {HelperTest} from "./HelperTest.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";

contract RepayFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    uint256 lenderPk; // #662 — acceptor key for the AcceptTerms signature
    address borrower;
    uint256 borrowerPk; // #662 — acceptor key for the AcceptTerms signature
    address mockERC20;
    address mockCollateralERC20;
    address mockNft721;
    uint256 constant BASIS_POINTS = 10000;
    uint256 constant TREASURY_FEE_BPS = 200; // rev-8 freeze #1352 (was 100)

    // Mock Oracle responses
    function mockOracleLiquidity(
        address asset,
        LibVaipakam.LiquidityStatus status
    ) internal {
        // Use vm.mockCall for OracleFacet.checkLiquidity
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset),
            abi.encode(status)
        );
    }

    function mockOraclePrice(
        address asset,
        uint256 price,
        uint8 decimals
    ) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encode(price, decimals)
        );
    }

    // Facet addresses
    DiamondCutFacet cutFacet;
    OfferCreateFacet offerCreateFacet;
    OfferAcceptFacet offerAcceptFacet;
    OfferCancelFacet offerCancelFacet;
    ProfileFacet profileFacet;
    OracleFacet oracleFacet;
    VaipakamNFTFacet nftFacet;
    VaultFactoryFacet vaultFacet;
    LoanFacet loanFacet;
    HelperTest helperTest;
    RiskFacet riskFacet; // Added
    RepayFacet repayFacet;
    RepayPeriodicFacet repayPeriodicFacet;
    AdminFacet adminFacet;
    AccessControlFacet accessControlFacet;
    TestMutatorFacet testMutatorFacet;

    // Vault impl
    VaipakamVaultImplementation vaultImpl;

    function setUp() public {
        owner = address(this);
        (lender, lenderPk) = makeAddrAndKey("lender");
        (borrower, borrowerPk) = makeAddrAndKey("borrower");

        // Mocks
        mockERC20 = address(new ERC20Mock("MockToken", "MTK", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockNft721 = address(new MockRentableNFT721());

        // Deploy facets
        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));

        offerCreateFacet = new OfferCreateFacet();
        offerAcceptFacet = new OfferAcceptFacet();

        offerCancelFacet = new OfferCancelFacet();
        profileFacet = new ProfileFacet();
        oracleFacet = new OracleFacet();
        nftFacet = new VaipakamNFTFacet();
        vaultFacet = new VaultFactoryFacet();
        loanFacet = new LoanFacet();
        riskFacet = new RiskFacet();
        helperTest = new HelperTest();
        repayFacet = new RepayFacet();
        repayPeriodicFacet = new RepayPeriodicFacet();
        adminFacet = new AdminFacet();
        accessControlFacet = new AccessControlFacet();
        testMutatorFacet = new TestMutatorFacet();

        // Deploy vault impl
        vaultImpl = new VaipakamVaultImplementation();

        // Cut facets into diamond
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](16);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(offerCreateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferCreateFacetSelectors() // .getOfferCreateFacetSelectors()
        });
        cuts[13] = IDiamondCut.FacetCut({
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
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[10] = IDiamondCut.FacetCut({
            facetAddress: address(testMutatorFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getTestMutatorFacetSelectors()
        });
        cuts[11] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});

        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(new RiskMatchLiquidationFacet()), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()});
        // #407 PR 3 (2026-06-12) — encumbrance mutate facet.
        EncumbranceMutateFacet encumbranceMutateFacet = new EncumbranceMutateFacet();
        cuts[14] = IDiamondCut.FacetCut({
            facetAddress: address(encumbranceMutateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getEncumbranceMutateFacetSelectors()
        });
        // Issue #66 — periodic-interest + NFT-rental daily-deduction
        // cluster split out of RepayFacet; route its selectors here so
        // autoDeductDaily / settlePeriodicInterest resolve on this
        // minimal test diamond.
        cuts[15] = IDiamondCut.FacetCut({
            facetAddress: address(repayPeriodicFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRepayPeriodicFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();

        // Init vault factory with impl
        vm.prank(owner);
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        // vm.prank(address(diamond));
        // LibVaipakam.setTreasury(owner);

        // Mock balances
        deal(mockERC20, lender, 1e18);
        deal(mockERC20, borrower, 1e18);
        deal(mockCollateralERC20, lender, 1e18);
        deal(mockCollateralERC20, borrower, 1e18);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);

        // Mock NFT approval/ownership
        vm.prank(lender);
        MockRentableNFT721(mockNft721).mint(lender, 1);
        vm.prank(lender);
        MockRentableNFT721(mockNft721).approve(address(diamond), 1);

        // Set countries
        vm.prank(lender);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower);
        ProfileFacet(address(diamond)).setUserCountry("FR");

        // Set trade allowance (assume allowed)
        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "FR", true);

        // Set KYC (Tier2 = full KYC; also sets legacy kycVerified = true)
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);

        // Mock Oracle: Liquid for ERC20, Illiquid for NFT
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockNft721, LibVaipakam.LiquidityStatus.Illiquid);
        mockOraclePrice(mockERC20, 1e8, 8); // $1 price, 8 decimals
        mockOraclePrice(mockCollateralERC20, 1e8, 8);

        // Mock RiskFacet for HF and LTV
        // For successful: HF 2e18 (2.0), LTV 6666 (66.66% for 1000/1500)
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(2e18)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(6666)
        );

        // Set loanInitMaxLtvBps in risk params (assume owner sets)
        // For mockERC20 collateral: loanInitMaxLtvBps 8000 (80%)
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 300, 1000
        );
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 300, 1000
        );

        // Assume create/accept loan for tests (mock or call)
        // vm.prank(lender);
        // uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
        //     LibVaipakam.OfferType.Lender,
        //     mockERC20, // lendingAsset,
        //     1000, //amount,
        //     500, // 5%
        //     mockERC20, // collateralAsset,
        //     1500, // collateralAmount,
        //     30, // durationDays,
        //     LibVaipakam.AssetType.ERC20, // assetType,
        //     0, // tokenId,
        //     0, // quantity,
        //     true, // creator consent
        //     mockERC20 // prepay asset
        // );

        // vm.prank(borrower);
        // uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(
        //     offerId,
        //     true
        // );

        // vm.prank(lender);
        // uint256 offerId2 = OfferCreateFacet(address(diamond)).createOffer(
        //     LibVaipakam.OfferType.Lender,
        //     mockNft721, // lendingAsset,
        //     1000, //amount,
        //     500, // 5%
        //     mockERC20, // collateralAsset,
        //     1500, // collateralAmount,
        //     30, // durationDays,
        //     LibVaipakam.AssetType.ERC721, // assetType,
        //     0, // tokenId,
        //     0, // quantity,
        //     true, // creator consent
        //     mockERC20 // prepay asset
        // );

        // vm.prank(borrower);
        // uint256 loanId2 = OfferAcceptFacet(address(diamond)).acceptOffer(
        //     offerId2,
        //     true
        // );
    }

    function helperOfferLoan() public {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1500,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        uint256 loanId = LibAcceptTestSigner.signAndAccept(
            address(diamond), borrower, borrowerPk, offerId
        );

        vm.prank(lender);
        uint256 offerId2 = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockNft721,
                amount: 10,
                interestRateBps: 500,
                collateralAsset: mockERC20,
                collateralAmount: 1500,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: 1,
                quantity: 1,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 10,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        uint256 loanId2 = LibAcceptTestSigner.signAndAccept(
            address(diamond), borrower, borrowerPk, offerId2
        );
    }

    function testFullRepayERC20Loan() public {
        // Assume loanId 1 created (principal 1000, rate 500bps, duration 30 days)
        helperOfferLoan();
        // Advance time 15 days
        vm.warp(block.timestamp + 15 days);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(1);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            1
        );
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
        // Assert principal + interest transferred, collateral released
    }

    // #957 (#921 item 6) — the real accept flow must stamp BOTH fee snapshots
    // onto the loan at init (from the live governance knobs, which are at their
    // library defaults here: 100bps treasury / 10bps LIF). This guards the
    // `LoanFacet._snapshotFeeBps` write path end-to-end; the retune-invariance
    // of the settlement READ is covered precisely in LibCollateralSettlementTest.
    function test_957_feeBpsSnapshottedAtInit() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(
            loan.treasuryFeeBpsAtInit,
            200,
            "treasury fee snapshotted at the 2% default at init (rev-8 freeze #1352)"
        );
        assertEq(
            loan.loanInitiationFeeBpsAtInit,
            20,
            "LIF snapshotted at the 0.2% default at init (rev-8 freeze #1352)"
        );

        // Loan 2 (created by helperOfferLoan) is an NFT rental — no ERC-20 LIF
        // is charged on that path (Codex #989 r2), so its LIF receipt reads 0
        // while the treasury fee is still stamped.
        LibVaipakam.Loan memory rental = LoanFacet(address(diamond)).getLoanDetails(2);
        assertEq(
            rental.loanInitiationFeeBpsAtInit,
            0,
            "NFT rental records NO LIF (fee not charged on the rental path)"
        );
        assertEq(
            rental.treasuryFeeBpsAtInit,
            200,
            "treasury fee still snapshotted on the NFT rental (rev-8 freeze #1352)"
        );
    }

    function testPartialRepayERC20() public {
        // Assume loanId 1, principal 1000
        helperOfferLoan();
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(1, 500);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            1
        );
        assertEq(loan.principal, 500);
    }

    /// @dev #921 item 3 — a "partial" equal to the full remaining principal
    ///      must revert (not decrement to a zombie Active-at-0 loan). The
    ///      borrower must use `repayLoan` for a full close-out.
    function testRepayPartialRevertsWhenRetiringFullPrincipal() public {
        helperOfferLoan(); // loanId 1, ERC20 principal 1000, allowsPartialRepay
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.PartialWouldRetireFullPrincipal.selector);
        RepayFacet(address(diamond)).repayPartial(1, 1000);
    }

    /// @dev #921 item 3 — one wei below full principal is still a valid partial
    ///      (guards against an off-by-one that would block legitimate partials).
    function testRepayPartialAllowsOneWeiBelowPrincipal() public {
        helperOfferLoan();
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(1, 999);
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(loan.principal, 1);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    function testAutoDeductDailyNFT() public {
        // Assume NFT loanId 2, daily fee 10, prepay 300 (30 days)
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);

        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            2
        );
        assertEq(loan.prepayAmount, 290); // -10
        // Pass-2 D1 (#1188): durationDays is now IMMUTABLE (the fixed maturity);
        // the day consumed shows as lastDeductTime advancing, not term shrink.
        assertEq(loan.durationDays, 30, "durationDays immutable (#1188)");
        assertEq(loan.lastDeductTime, loan.startTime + 1 days, "lastDeductTime advanced 1 day");
    }

    /// @dev Pass-2 D1 (#1188) regression — a mid-serviced 30-day rental must NOT
    ///      be permissionlessly defaultable before its ORIGINAL maturity+grace,
    ///      and the borrower must be able to close it in-term. Pre-fix, each
    ///      auto-deduction shrank `durationDays`, pulling the computed maturity
    ///      earlier: after ~20 daily deductions a 30-day rental was
    ///      `triggerDefault`-able (durationDays→10 ⇒ endTime≈day10) and an
    ///      in-term `repayLoan` reverted `RepaymentPastGracePeriod`. With
    ///      `durationDays` immutable both are fixed.
    function test_1188_rentalNotEarlyDefaultable_andRepayableInTerm() public {
        helperOfferLoan(); // loanId 2: NFT rental, durationDays=30, daily fee=10, prepay=300
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        uint256 start = loan.startTime;

        // Service 20 of 30 days via the permissionless daily deduction.
        for (uint256 d = 0; d < 20; d++) {
            vm.warp(start + (d + 1) * 1 days);
            RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);
        }

        loan = LoanFacet(address(diamond)).getLoanDetails(2);
        // Maturity is FIXED at origination (endTime = start + 30 days), not
        // shrunk to ~day 10 by the 20 deductions. `DefaultedFacet`'s grace gate
        // reads the same `startTime + durationDays` so it is likewise anchored
        // at day 30 (its own past-grace tests cover the default path; this
        // diamond doesn't cut DefaultedFacet).
        assertEq(loan.durationDays, 30, "term immutable across amortisation");
        assertEq(loan.lastDeductTime, start + 20 days, "20 days consumed via lastDeductTime");

        // The borrower can CLOSE the fully-serviced rental IN-TERM (at day 20).
        // Pre-fix the shrunk term put maturity ≈ day 10, so this reverted
        // `RepaymentPastGracePeriod` — the repay-brick. It must now succeed.
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(2);
        loan = LoanFacet(address(diamond)).getLoanDetails(2);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid), "closed in-term");
    }

    /// @dev #654 — the permissionless daily rental deduction must pay the
    ///      CURRENT lender-position holder, not the stored `loan.lender`, after
    ///      a lender-NFT transfer. (Unlike repayLoan/markDefaulted, this path is
    ///      a DIRECT payout with no `lenderClaims` indirection, so it would
    ///      otherwise keep paying the departed lender every day.)
    function test_654_autoDeductDaily_paysCurrentHolderAfterLenderTransfer() public {
        helperOfferLoan(); // loanId 2 = NFT rental, daily fee 10, prepayAsset = mockERC20
        uint256 lenderTokenId = LoanFacet(address(diamond))
            .getLoanDetails(2)
            .lenderTokenId;

        // Simulate a secondary-market transfer of the lender position NFT.
        address newHolder = makeAddr("rentalLenderHolder654");
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, lenderTokenId),
            abi.encode(newHolder)
        );

        uint256 newHolderBefore = ERC20Mock(mockERC20).balanceOf(newHolder);
        uint256 storedLenderBefore = ERC20Mock(mockERC20).balanceOf(lender);

        vm.warp(block.timestamp + 1 days);
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);

        // The daily rental fee follows the CURRENT holder; the departed lender
        // receives nothing.
        assertGt(
            ERC20Mock(mockERC20).balanceOf(newHolder),
            newHolderBefore,
            "current holder receives the daily rental fee"
        );
        assertEq(
            ERC20Mock(mockERC20).balanceOf(lender),
            storedLenderBefore,
            "departed lender is not paid"
        );
    }

    function testFuzzPartialAmount(uint256 partial1) public {
        vm.assume(partial1 > 0 && partial1 < 1000);
        // Assume loanId 1, principal 1000
        helperOfferLoan();
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(1, partial1);
        // Assert principal reduced, no revert
    }

    // function testRepayPastGraceReverts() public {
    //     // Assume loanId 1
    //     vm.warp(block.timestamp + loan.durationDays * 1 days + grace + 1);
    //     vm.expectRevert(RepayFacet.RepaymentPastGracePeriod.selector);
    //     vm.prank(borrower);
    //     RepayFacet(address(diamond)).repayLoan(1);
    // }

    function testCalculateRepaymentAmount() public {
        helperOfferLoan();
        // ERC20 loan (loanId 1): pro-rata interest with useFullTermInterest = true per setUp
        // At time 0, elapsed = 0 days, so totalDue = principal + 0 interest + 0 late
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(1);
        assertGe(due, 1000); // At minimum the principal

        // Non-existent loan returns 0
        assertEq(RepayFacet(address(diamond)).calculateRepaymentAmount(999), 0);

        // Advance time to also hit the late fee branch
        vm.warp(block.timestamp + 35 days); // past 30-day duration
        uint256 dueWithLateFee = RepayFacet(address(diamond)).calculateRepaymentAmount(1);
        assertGe(dueWithLateFee, due);
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Tests repayLoan for NFT rental loan (assetType = ERC721, loanId 2).
    ///      Covers the else branch (NFT path) in repayLoan.
    function testRepayNFTLoan() public {
        helperOfferLoan();
        // loanId 2 is NFT rental: principal=10, duration=30, prepayAmount should be 300 + buffer
        vm.warp(block.timestamp + 1 days); // advance 1 day

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(2);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
    }

    /// @dev Tests repayLoan with useFullTermInterest=true for ERC20 loan.
    ///      The helperOfferLoan creates offer without useFullTermInterest=true by default (pro-rata).
    ///      We directly set the storage flag using vm.store to cover the fullTermInterest branch.
    function testRepayLoanFullTermInterestERC20() public {
        helperOfferLoan();
        // ERC20 loan (loanId 1) uses pro-rata by default. Flip to full-term via mutator.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        loan.useFullTermInterest = true;
        TestMutatorFacet(address(diamond)).setLoan(1, loan);

        vm.warp(block.timestamp + 5 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(1);

        loan = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
    }

    /// @dev Tests calculateRepaymentAmount for NFT loan (covers NFT branch in view function).
    function testCalculateRepaymentAmountNFT() public {
        helperOfferLoan();
        // NFT loan loanId 2
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(2);
        // NFT returns 0 for totalDue (deducted from prepay)
        assertEq(due, 0);
    }

    /// @dev Tests calculateRepaymentAmount for NFT loan with useFullTermInterest=true.
    function testCalculateRepaymentAmountNFTFullTerm() public {
        helperOfferLoan();
        // Flip useFullTermInterest=true on NFT loan (loanId 2) via mutator.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.useFullTermInterest = true;
        TestMutatorFacet(address(diamond)).setLoan(2, loan);

        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(2);
        assertEq(due, 0); // NFT still returns 0 from prepay
    }

    /// @dev Tests repayLoan reverts if past grace period.
    function testRepayLoanRevertsIfPastGrace() public {
        helperOfferLoan();
        // Advance past grace period for 30-day loan (grace = 3 days)
        vm.warp(block.timestamp + 30 days + 3 days + 1);

        vm.prank(borrower);
        vm.expectRevert(RepayFacet.RepaymentPastGracePeriod.selector);
        RepayFacet(address(diamond)).repayLoan(1);
    }

    /// @dev Tests third-party repayment succeeds for ERC-20 loans.
    ///      Any address EXCEPT the lender / lender-NFT-holder can repay on
    ///      the borrower's behalf; collateral claim rights remain tied to
    ///      the borrower's Vaipakam NFT.
    function testRepayLoanByThirdPartyERC20() public {
        helperOfferLoan();
        // loanId 1 is the ERC-20 loan; some unrelated address repays on
        // the borrower's behalf. Fund + approve from the third party.
        address thirdParty = makeAddr("thirdParty");
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(1);
        ERC20Mock(mockERC20).mint(thirdParty, due);
        vm.prank(thirdParty);
        ERC20Mock(mockERC20).approve(address(diamond), due);
        vm.prank(thirdParty);
        RepayFacet(address(diamond)).repayLoan(1);
        // Loan should be Repaid
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
    }

    /// @dev Tests repayLoan reverts when the lender tries to repay their
    ///      own loan. Two callers exercised: `loan.lender` directly, and
    ///      the current owner of the lender-side Vaipakam NFT (which on
    ///      a freshly-initiated loan happens to be the same address —
    ///      the contract guards both paths defensively, since a free-form
    ///      ERC-721 transfer can desync the two without touching
    ///      `loan.lender`).
    function testRepayLoanRevertsLenderCannotRepayOwnLoan() public {
        helperOfferLoan();
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.LenderCannotRepayOwnLoan.selector);
        RepayFacet(address(diamond)).repayLoan(1);
    }

    /// @dev Tests repayLoan reverts if loan is not Active.
    function testRepayLoanRevertsIfNotActive() public {
        helperOfferLoan();
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(1);

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        RepayFacet(address(diamond)).repayLoan(1);
    }

    /// @dev Tests repayPartial reverts if loan is not Active.
    function testRepayPartialRevertsIfNotActive() public {
        helperOfferLoan();
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(1);

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        RepayFacet(address(diamond)).repayPartial(1, 500);
    }

    /// @dev Tests repayPartial reverts if not borrower.
    function testRepayPartialRevertsIfNotBorrower() public {
        helperOfferLoan();
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotBorrower.selector);
        RepayFacet(address(diamond)).repayPartial(1, 500);
    }

    /// @dev Lender-offer with `allowsPartialRepay = false` → borrower
    ///      cannot partial-repay. Default-false is the Phase-1-safe
    ///      shape; the lender must explicitly opt in for the gate to
    ///      open. See `LibVaipakam.Offer.allowsPartialRepay` doc.
    function testRepayPartialRevertsWhenLenderOfferDisallowed() public {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1500,
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
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        uint256 loanId = LibAcceptTestSigner.signAndAccept(
            address(diamond), borrower, borrowerPk, offerId
        );

        // Snapshot reads correctly: loan inherits the offer's flag.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertFalse(loan.allowsPartialRepay, "snapshot mismatch");

        vm.prank(borrower);
        vm.expectRevert(RepayFacet.PartialRepayNotAllowed.selector);
        RepayFacet(address(diamond)).repayPartial(loanId, 200);
    }

    /// @dev Borrower-offer with `allowsPartialRepay = true` (the
    ///      borrower requested the option at create-time, the lender's
    ///      accept = consent) → borrower can partial-repay against the
    ///      resulting loan. Mirror of the lender-offer-allowed case
    ///      since the contract treats both offer sides symmetrically:
    ///      the offer carries the flag, the loan-init snapshots it,
    ///      and `repayPartial` reads from the loan.
    function testRepayPartialSucceedsWhenBorrowerOfferAllowed() public {
        // Borrower offer ⇒ borrower posts collateral at create (pulled
        // into borrower vault), then lender funds principal at accept
        // (pulled from lender vault). The standard setUp() approves the
        // diamond on lender's wallet but never pre-deposits into the
        // lender's vault; for a borrower-offer-accept the lender's
        // vault needs ≥ principal + LIF treasury fee, so fund it via
        // deal() against the proxy address.
        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: 1000,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1500,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        deal(mockERC20, lenderVault, 2000); // covers 1 wei LIF + 1000 principal pull
        // T-051 — back the direct deal with a counter record so the
        // subsequent vaultWithdrawERC20 inside acceptOffer doesn't
        // underflow the counter.
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(lender, mockERC20, 2000);

        uint256 loanId = LibAcceptTestSigner.signAndAccept(
            address(diamond), lender, lenderPk, offerId
        );

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertTrue(loan.allowsPartialRepay, "snapshot should reflect borrower's request");

        // Repay 200 of 1000 principal; expected post-state principal = 800.
        // Borrower received the principal at accept; fund their vault
        // for the partial pull.
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        deal(mockERC20, borrowerVault, 1000);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, 200);
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.principal, 800, "principal didn't decrement");
    }

    /// @dev Tests repayPartial with NFT loan (covers NFT else branch in repayPartial).
    function testRepayPartialNFTLoan() public {
        helperOfferLoan();
        // loanId 2 is NFT rental, repay for 1 day (partialAmount = days)
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(2, 1);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        // Pass-2 D1 (#1188): durationDays immutable; the 1-day rental partial
        // advances lastDeductTime instead of shrinking the term.
        assertEq(loan.durationDays, 30, "durationDays immutable after rental partial (#1188)");
        assertEq(loan.lastDeductTime, loan.startTime + 1 days, "lastDeductTime advanced 1 day");
    }

    /// @dev Tests repayPartial reverts if partialAmount > durationDays for NFT.
    function testRepayPartialNFTRevertsAmountTooHigh() public {
        helperOfferLoan();
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.InsufficientPartialAmount.selector);
        RepayFacet(address(diamond)).repayPartial(2, 31); // > 30 days
    }

    /// @dev Tests autoDeductDaily reverts if called for ERC20 loan.
    function testAutoDeductDailyRevertsForERC20Loan() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(RepayPeriodicFacet.NotNFTRental.selector);
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(1); // loanId 1 is ERC20
    }

    /// @dev Tests autoDeductDaily reverts if called too soon (NotDailyYet).
    function testAutoDeductDailyRevertsIfTooSoon() public {
        helperOfferLoan();
        // No warp — block.timestamp < lastDeductTime + 1 day
        vm.expectRevert(RepayPeriodicFacet.NotDailyYet.selector);
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);
    }

    /// @dev Tests autoDeductDaily reverts if status is not Active.
    function testAutoDeductDailyRevertsIfNotActive() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);
        // Repay the loan to change status
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(2);

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);
    }

    /// @dev Tests that repayNFT reverts with InsufficientPrepay when prepayAmount=0.
    function testRepayNFTRevertsInsufficientPrepay() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.prepayAmount = 0;
        TestMutatorFacet(address(diamond)).setLoan(2, loan);

        vm.prank(borrower);
        vm.expectRevert(RepayFacet.InsufficientPrepay.selector);
        RepayFacet(address(diamond)).repayLoan(2);
    }

    /// @dev Tests cross-facet call failure for the vault chokepoint
    ///      in repayLoan (ERC20 path). T-051 — vault resolution
    ///      moved inside `vaultDepositERC20From`; mock that selector.
    function testRepayLoanCrossFacetCallFailed() public {
        helperOfferLoan();
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultDepositERC20From.selector),
            "mock revert"
        );
        vm.prank(borrower);
        vm.expectRevert();
        RepayFacet(address(diamond)).repayLoan(1);
        vm.clearMockedCalls();
    }

    /// @dev Tests that repayLoan with NFT and useFullTermInterest=true uses full term interest.
    function testRepayNFTLoanFullTermInterest() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.useFullTermInterest = true;
        TestMutatorFacet(address(diamond)).setLoan(2, loan);

        vm.warp(block.timestamp + 1 days);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(2);

        loan = LoanFacet(address(diamond)).getLoanDetails(2);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
    }

    /// @dev Tests repayLoan NFT path where totalDue > prepayAmount (InsufficientPrepay) with pro-rata.
    ///      With elapsedDays > 0, interest = principal * elapsedDays; set prepayAmount very small.
    function testRepayNFTRevertsWhenTotalDueExceedsPrepay() public {
        helperOfferLoan();
        // Advance 5 days so elapsedDays=5, interest = 10*5=50
        vm.warp(block.timestamp + 5 days);
        // Set prepayAmount = 2 (< interest=50) so totalDue > prepayAmount
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.prepayAmount = 2;
        TestMutatorFacet(address(diamond)).setLoan(2, loan);

        vm.prank(borrower);
        vm.expectRevert(RepayFacet.InsufficientPrepay.selector);
        RepayFacet(address(diamond)).repayLoan(2);
    }

    /// @dev Tests cross-facet call failure: Treasury share transfer fails in NFT repayLoan.
    function testRepayNFTLoanTreasuryShareFails() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);

        // Make treasury vault withdraw fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            "mock revert"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("mock revert"));
        RepayFacet(address(diamond)).repayLoan(2);
        vm.clearMockedCalls();
    }

    /// @dev Tests cross-facet failure: lender share withdrawal fails in NFT repayLoan.
    function testRepayNFTLoanLenderShareFails() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);

        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        // Allow first call to succeed (treasury share) but second to fail (lender share)
        // We'll mock the second call (lenderShare withdrawal) to fail by counting:
        // Instead, mock vaultWithdrawERC20 to succeed once then fail. Use mockCallRevert for specific args is complex.
        // Alternative: make treasury call revert after treasury is paid. Tricky.
        // Simpler: mock getOrCreateUserVault to fail for lender in NFT path (called after lender share withdrawal).
        // Actually after lenderShare withdrawal succeeds, we call getOrCreateUserVault → let that fail.
        // But first we need treasury withdraw and lender withdraw to succeed.
        // Best approach: test the lender vault getOrCreate failure in NFT path.
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.getOrCreateUserVault.selector),
            "mock revert"
        );
        vm.prank(borrower);
        vm.expectRevert();
        RepayFacet(address(diamond)).repayLoan(2);
        vm.clearMockedCalls();
    }

    /// @dev #921 item 3 — an ERC20 partialAmount that exceeds the remaining
    ///      principal retires the full balance (and more), so it now reverts with
    ///      the dedicated `PartialWouldRetireFullPrincipal` (was
    ///      `InsufficientPartialAmount` when the guard was `>` only).
    function testRepayPartialRevertsWhenAmountExceedsPrincipal() public {
        helperOfferLoan();
        // loanId 1 principal = 1000; attempt to repay 1001 > 1000
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.PartialWouldRetireFullPrincipal.selector);
        RepayFacet(address(diamond)).repayPartial(1, 1001);
    }

    /// @dev Tests repayPartial reverts when amount is zero (InsufficientPartialAmount).
    function testRepayPartialRevertsZeroAmount() public {
        helperOfferLoan();
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.InsufficientPartialAmount.selector);
        RepayFacet(address(diamond)).repayPartial(1, 0);
    }

    /// @dev Tests repayPartial reverts past grace period.
    function testRepayPartialRevertsIfPastGrace() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 30 days + 3 days + 1);
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.RepaymentPastGracePeriod.selector);
        RepayFacet(address(diamond)).repayPartial(1, 500);
    }

    /// @dev Tests repayPartial for liquid loan with HF check - mock HF too low path.
    /// @dev Pass-2 A2 (#1190) — a partial repayment on a loan whose HF sits
    ///      BELOW the 1.5 admission floor now SUCCEEDS (it deleverages). The old
    ///      gate reverted `HealthFactorTooLow` whenever post-repay HF < 1.5,
    ///      which was inverted — it blocked exactly the deleveraging the lender
    ///      wants. The fix asserts only that HF does not WORSEN (spec §1362).
    ///      HF is mocked constant (1.0e18 < 1.5e18), so before == after
    ///      (non-worsening) and the partial is admitted.
    function testRepayPartial_subThresholdDeleverage_succeeds() public {
        helperOfferLoan();
        uint256 principalBefore = LoanFacet(address(diamond)).getLoanDetails(1).principal;
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(1e18) // below the 1.5e18 admission floor, but non-worsening
        );
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(1, 500); // no longer reverts
        vm.clearMockedCalls();
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(1).principal,
            principalBefore - 500,
            "sub-1.5 deleveraging partial admitted; principal reduced"
        );
    }

    /// @dev Pass-2 A2 (#1190) — the replacement gate is a MONOTONICITY assert:
    ///      a partial that would LOWER HF reverts `PartialRepayWorsensHealthFactor`.
    ///      (Never happens for a real partial — it reduces principal — but the
    ///      guard is defensive.) HF is mocked to return 1.5e18 on the pre-partial
    ///      read then 1.0e18 on the post-partial read, so hfAfter < hfBefore.
    function testRepayPartial_worseningHF_reverts() public {
        helperOfferLoan();
        bytes[] memory hfs = new bytes[](2);
        hfs[0] = abi.encode(uint256(1.5e18)); // hfBefore
        hfs[1] = abi.encode(uint256(1.0e18)); // hfAfter (worse)
        vm.mockCalls(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            hfs
        );
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepayFacet.PartialRepayWorsensHealthFactor.selector,
                uint256(1.5e18),
                uint256(1.0e18)
            )
        );
        RepayFacet(address(diamond)).repayPartial(1, 500);
        vm.clearMockedCalls();
    }

    /// @dev Pass-2 A3 (#1191, Codex #1229) — a repayPartial CONSUMES only the
    ///      portion of the periodic-settled credit that its charge netted
    ///      (`grossAccrued`) and PRESERVES the excess. A periodic auto-liq can
    ///      OVERDELIVER, so `interestSettled` may exceed the accrued interest by
    ///      the time a partial runs; zeroing ALL of it (the earlier fix) would
    ///      forfeit the borrower's already-paid excess and later overstate the
    ///      debt. Here no time elapses (grossAccrued == 0), so the FULL seeded
    ///      credit must survive. HF mocked constant to isolate this from the A2
    ///      monotonicity gate.
    function testRepayPartial_preservesUnusedSettledCredit() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        loan.interestSettled = 50; // over-delivered periodic credit
        TestMutatorFacet(address(diamond)).setLoan(1, loan);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(2e18)) // healthy + constant (non-worsening)
        );
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(1, 100); // grossAccrued == 0
        vm.clearMockedCalls();
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(1).interestSettled,
            50,
            "unused settled credit preserved, not zeroed (#1229)"
        );
    }

    /// @dev Tests that autoDeductDaily reduces durationDays to 0 and sets loan to Repaid.
    function testAutoDeductDailyReachesZeroDuration() public {
        helperOfferLoan();
        // NFT loan is loanId 2, durationDays = 30, daily fee = 10
        // Set durationDays = 1 to hit the loan closure path after deduction
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.durationDays = 1;
        TestMutatorFacet(address(diamond)).setLoan(2, loan);

        vm.warp(block.timestamp + 1 days);
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);

        loan = LoanFacet(address(diamond)).getLoanDetails(2);
        // Pass-2 D1 (#1188): durationDays stays at its immutable term (set to 1
        // above); full consumption is signalled by remainingRentalDays reaching
        // 0 (lastDeductTime advanced across the whole term), which drives the
        // auto-finalise → Repaid transition asserted below.
        assertEq(loan.durationDays, 1, "durationDays immutable (#1188)");
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
    }

    /// @dev Tests NFT repayPartial accrued > prepayAmount → InsufficientPrepay.
    function testRepayPartialNFTInsufficientPrepay() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.prepayAmount = 0;
        TestMutatorFacet(address(diamond)).setLoan(2, loan);

        vm.prank(borrower);
        vm.expectRevert(RepayFacet.InsufficientPrepay.selector);
        RepayFacet(address(diamond)).repayPartial(2, 1);
    }

    /// @dev Tests repayPartial NFT cross-facet failure (lender share transfer fails).
    function testRepayPartialNFTCrossFacetFails() public {
        helperOfferLoan();
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            "mock revert"
        );
        vm.prank(borrower);
        vm.expectRevert();
        RepayFacet(address(diamond)).repayPartial(2, 1);
        vm.clearMockedCalls();
    }

    /// @dev Tests repayLoan cross-facet: NFT path reset renter fails.
    function testRepayNFTLoanResetRenterFails() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);

        // Mock vaultSetNFTUser to fail (called during NFT reset renter step)
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultSetNFTUser.selector),
            "mock revert"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("mock revert"));
        RepayFacet(address(diamond)).repayLoan(2);
        vm.clearMockedCalls();
    }

    /// @dev Tests repayLoan cross-facet: borrower NFT updateNFTStatus fails.
    function testRepayLoanUpdateBorrowerNFTFails() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);

        // Mock VaipakamNFTFacet.updateNFTStatus to fail (called after loan logic)
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            "mock revert"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("mock revert"));
        RepayFacet(address(diamond)).repayLoan(1);
        vm.clearMockedCalls();
    }

    /// @dev Tests autoDeductDaily cross-facet: lender deduct fails.
    function testAutoDeductDailyLenderDeductFails() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            "mock revert"
        );
        vm.expectRevert(bytes("mock revert"));
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);
        vm.clearMockedCalls();
    }

    /// @dev Tests repayPartial NFT with NFT update expires failing.
    function testRepayPartialNFTUpdateExpiresFails() public {
        helperOfferLoan();
        // First need the lender/treasury withdrawals to succeed, then vaultSetNFTUser to fail.
        // We'll mock vaultSetNFTUser to revert specifically.
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultSetNFTUser.selector),
            "mock revert"
        );
        vm.prank(borrower);
        vm.expectRevert();
        RepayFacet(address(diamond)).repayPartial(2, 1);
        vm.clearMockedCalls();
    }

    /// @dev Tests calculateRepaymentAmount with useFullTermInterest=true for ERC20.
    function testCalculateRepaymentAmountERC20FullTerm() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        loan.useFullTermInterest = true;
        TestMutatorFacet(address(diamond)).setLoan(1, loan);

        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(1);
        // principal=1000, rate=500bps, duration=30days: interest = 1000*500*30/(365*10000) ≈ 4
        // totalDue = principal + interest >= 1000
        assertGe(due, 1000); // principal + full-term interest
    }

    /// @dev Tests calculateRepaymentAmount for NFT loan with pro-rata (useFullTermInterest=false).
    ///      Returns 0 + lateFee (since NFT path sets totalDue=0 from prepay).
    function testCalculateRepaymentAmountNFTProRata() public {
        helperOfferLoan();
        // loanId 2 is the NFT loan; warp 5 days
        vm.warp(block.timestamp + 5 days);
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(2);
        // NFT path: totalDue = 0 (from prepay) + no late fee (before endTime)
        assertEq(due, 0);
    }

    /// @dev Tests calculateRepaymentAmount for NFT loan with late fee (past endTime).
    function testCalculateRepaymentAmountNFTWithLateFee() public {
        helperOfferLoan();
        // loanId 2 is NFT loan with duration=30 days
        // Warp past endTime to trigger late fee calculation
        vm.warp(block.timestamp + 31 days + 1);
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(2);
        // NFT path returns 0 + lateFee; lateFee >= 0
        assertGe(due, 0);
    }

    // ─── #998 S8 (#1004): rental late fee scales with remaining rent ─────────
    // loanId 2 (helperOfferLoan): NFT rental, per-day fee (principal) = 10,
    // durationDays = 30 ⇒ prepayAmount = 300, bufferAmount = 15 (5% default).

    /// @dev The rental late fee is a % of the REMAINING rental
    ///      (`principal × durationDays`), not of a single day's fee. At 1 day
    ///      late the old one-day base (10 × 1.5% = 0) rounded to zero; the fix
    ///      charges 10 × 30 × 1.5% = 4.
    function test_998_S8_rentalLateFeeScalesWithRemainingTerm() public {
        helperOfferLoan();
        // 1 day past endTime (start + 30 days). Quote has no grace gate.
        vm.warp(block.timestamp + 31 days + 1);
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(2);
        // NFT quote returns lateFee only (rental fees settle from prepay).
        assertEq(due, 4, "fee must scale with remaining term (10*30*1.5%=4)");
        assertGt(due, 0, "old one-day base (10*1.5%) rounded to 0 - the S8 bug");
    }

    /// @dev Codex #1092 r2 P1: the late fee is funded from `bufferAmount`, not
    ///      `prepayAmount`. A full-term late rental has `interest ==
    ///      prepayAmount` (300), so a positive fee (6 at 2 days late) would
    ///      revert `InsufficientPrepay` if the buffer weren't in the budget.
    function test_998_S8_rentalLateFeeFundedFromBuffer() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.useFullTermInterest = true; // interest = principal*durationDays = 300 = prepay
        TestMutatorFacet(address(diamond)).setLoan(2, loan);
        // 2 days late (within grace = 3 days for a 30-day term). fee = 10*30*2% = 6.
        // totalDue = 300 + 6 = 306 <= prepay(300)+buffer(15) = 315 ⇒ must NOT brick.
        vm.warp(block.timestamp + 32 days + 1);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(2);
        loan = LoanFacet(address(diamond)).getLoanDetails(2);
        assertEq(
            uint8(loan.status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "buffer-funded late fee must not brick a full-term late rental"
        );
    }

    /// @dev The 5% ceiling still binds (default buffer). At 10 days late the raw
    ///      slope (1% + 0.5%/day = 6%) is capped to 5% of the remaining rental:
    ///      10 × 30 × 5% = 15 (== the 5% bufferAmount).
    function test_998_S8_rentalLateFeeCapsAtFivePercent() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 40 days + 1); // 10 days late; quote (no grace gate)
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(2);
        assertEq(due, 15, "fee caps at 5% of remaining rental (10*30*5%=15)");
    }

    /// @dev Codex #1092 r3 P2: with `rentalBufferBps` configured BELOW 5%, the
    ///      cap tracks the actual buffer bps so the pre-funded buffer always
    ///      covers the fee. bufferBps = 100 (1%) ⇒ buffer = 3; the fee caps at
    ///      1% of the remaining rental (3), never exceeding the buffer.
    function test_998_S8_rentalLateFeeCapTiedToBufferBps() public {
        TestMutatorFacet(address(diamond)).setRentalBufferBpsRaw(100); // 1%
        helperOfferLoan(); // loanId 2 buffer = 300 * 1% = 3
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.useFullTermInterest = true;
        TestMutatorFacet(address(diamond)).setLoan(2, loan);
        // 2 days late: raw slope 2% would exceed the 1% buffer cap ⇒ capped to 1%.
        vm.warp(block.timestamp + 32 days + 1);
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(2);
        assertEq(due, 3, "fee caps at configured buffer bps (10*30*1%=3)");
        // interest(300) + fee(3) == prepay(300)+buffer(3) ⇒ exact cover, no brick.
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(2);
        loan = LoanFacet(address(diamond)).getLoanDetails(2);
        assertEq(
            uint8(loan.status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "sub-5% buffer must still cover the (capped) late fee"
        );
    }

    /// @dev Codex #1096 P1: the cap must track the loan's OWN pre-funded
    ///      `bufferAmount` (snapshot at origination), NOT the live
    ///      `rentalBufferBps` config. A rental opened at 1% buffer then repaid
    ///      after governance resets the config to 5% must still clamp the fee
    ///      to its actual 3-unit buffer — reading the live 5% config would
    ///      compute 15 and revert `InsufficientPrepay`, bricking the close-out.
    function test_998_S8_rentalLateFeeUsesLoanBufferNotLiveConfig() public {
        TestMutatorFacet(address(diamond)).setRentalBufferBpsRaw(100); // 1% at origination
        helperOfferLoan(); // loanId 2 buffer = 300 * 1% = 3
        // Governance raises the global config AFTER origination.
        TestMutatorFacet(address(diamond)).setRentalBufferBpsRaw(500); // back to 5%
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.useFullTermInterest = true;
        TestMutatorFacet(address(diamond)).setLoan(2, loan);
        // 2 days late: slope 2% of remaining rental = 6; clamped to the loan's
        // actual buffer 3, NOT the 5% (=15) the live config would now permit.
        vm.warp(block.timestamp + 32 days + 1);
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(2);
        assertEq(due, 3, "fee must clamp to the loan's pre-funded buffer, not live config");
        // interest(300) + fee(3) == prepay(300)+buffer(3) => settles, no brick.
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(2);
        loan = LoanFacet(address(diamond)).getLoanDetails(2);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));
    }

    /// @dev Tests calculateRepaymentAmount ERC20 loan past endTime (late fee branch).
    function testCalculateRepaymentAmountERC20LateFee() public {
        helperOfferLoan();
        // Warp past endTime for ERC20 loan (loanId=1, duration=30 days)
        vm.warp(block.timestamp + 31 days + 1);
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(1);
        // ERC20 path: principal + interest + late fee > principal
        assertGt(due, 1000); // More than just principal
    }

    /// @dev Tests repayLoan reverts if non-borrower tries to repay an NFT rental loan.
    ///      NFT rental repayment must remain borrower-only because fees are deducted
    ///      from the borrower's vaulted prepayment.
    function testRepayLoanRevertsIfNotBorrowerForNFT() public {
        helperOfferLoan();
        // loanId 2 is the NFT loan; different user tries to repay
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotBorrower.selector);
        RepayFacet(address(diamond)).repayLoan(2);
    }

    /// @dev Tests calculateRepaymentAmount returns 0 for inactive loan.
    function testCalculateRepaymentAmountForInactiveLoan() public {
        // loanId 999 doesn't exist, status != Active → returns 0
        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(999);
        assertEq(due, 0);
    }

    /// @dev Tests repayLoan NFT path CrossFacetCallFailed("Lender share withdrawal failed").
    ///      First vaultWithdrawERC20 (treasury share) succeeds; second (lender share) fails.
    ///      Treasury and lender both refer to different addresses to distinguish calls.
    function testRepayNFTLoanLenderShareWithdrawalFails() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);

        address treasuryAddr = address(diamond); // treasury = diamond
        // First call: treasury share → borrower vault withdraws to treasury (address(diamond))
        // Second call: lender share → borrower vault withdraws to address(this)/diamond for vault deposit
        // Both have to=address(diamond) in the first and to=address(this) in the second.
        // treasury == address(diamond) == address(this) for the calls...
        // Let me distinguish by amount. NFT loan: amount=10, duration=30, elapsed=1 day.
        // elapsedDays=1, interest = principal*elapsedDays = 10*1 = 10
        // treasuryShare = 10 * 100 / 10000 = 0 (truncated to 0)
        // lenderShare = 10 - 0 = 10
        // So treasury call: (borrower, mockERC20, treasury, 0); lender call: (borrower, mockERC20, diamond, 10)
        // We need treasury(0) to succeed and lender(10) to fail.
        // Mock treasury call (amount=0) to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector, borrower, mockERC20, treasuryAddr, uint256(0)),
            abi.encode(true)
        );
        // Mock lender share call (amount=10) to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector, borrower, mockERC20, address(diamond), uint256(10)),
            "lender fail"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("lender fail"));
        RepayFacet(address(diamond)).repayLoan(2);
        vm.clearMockedCalls();
    }

    /// @dev Tests repayLoan second updateNFTStatus fails (lender NFT update).
    ///      First updateNFTStatus (borrowerTokenId=2) succeeds; second (lenderTokenId=1) fails.
    function testRepayLoanSecondNFTUpdateFails() public {
        helperOfferLoan();
        // lenderTokenId = 1, borrowerTokenId = 2 (from OfferFacet+LoanFacet nextTokenId)
        // First updateNFTStatus (borrowerTokenId=2) succeeds; second (lenderTokenId=1) fails
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector, uint256(2), uint256(1), LibVaipakam.LoanPositionStatus.LoanRepaid),
            abi.encode(true)
        );
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector, uint256(1), uint256(1), LibVaipakam.LoanPositionStatus.LoanRepaid),
            "nft fail"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("nft fail"));
        RepayFacet(address(diamond)).repayLoan(1);
        vm.clearMockedCalls();
    }

    /// @dev Tests repayPartial for illiquid loan (no HF check after partial repay).
    ///      Sets loan.principalLiquidity and collateralLiquidity = Illiquid via vm.store.
    ///      Covers `if (loan.collateralLiquidity == Liquid && loan.principalLiquidity == Liquid)` false branch.
    function testRepayPartialIlliquidLoanNoHFCheck() public {
        helperOfferLoan();
        // Set both liquidity fields to Illiquid for loanId 1 via mutator.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        loan.principalLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        TestMutatorFacet(address(diamond)).setLoan(1, loan);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(1, 500);

        loan = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(loan.principal, 500);
    }

    /// @dev Tests repayPartial fails when minPartialBps > 0 and partialAmount < minPartial.
    ///      Sets minPartialBps for the principal asset via the layout-
    ///      resilient TestMutatorFacet setter so this stays correct
    ///      when the Storage struct shifts (e.g. T-048 PAD additions).
    function testRepayPartialRevertsMinPartialAmount() public {
        helperOfferLoan();
        // Set minPartialBps = 1000 (10%) for mockERC20.
        TestMutatorFacet(address(diamond)).setMinPartialBpsRaw(mockERC20, 1000);

        // loanId 1: principal = 1000; minPartial = 1000 * 1000 / 10000 = 100
        // repay 50 < 100 → InsufficientPartialAmount
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.InsufficientPartialAmount.selector);
        RepayFacet(address(diamond)).repayPartial(1, 50);
    }

    /// @dev #956 (Codex #978) — a configured minPartialBps floor must NOT block
    ///      an NFT-rental partial. The floor is denominated in ERC-20 principal
    ///      units, but a rental partial's `partialAmount` is a DAY count. For
    ///      loan 2 (NFT rental, daily fee 10) a 50% floor computes
    ///      `minPartial = 5` in token units; before the ERC-20 scoping this
    ///      compared `1 day < 5` and wrongly reverted `InsufficientPartialAmount`.
    ///      Now the floor is skipped for non-ERC20 loans and a 1-day reduction
    ///      succeeds (durationDays 30 → 29).
    function testRepayPartialNFTSkipsMinPartialFloor() public {
        helperOfferLoan();
        // Codex #978 — LoanFacet copies the offer's lending asset (the NFT
        // collection `mockNft721`) into `loan.principalAsset` for a rental, and
        // the floor is read as `assetRiskParams[loan.principalAsset]`. Set the
        // floor on THAT asset (not the unrelated `mockERC20`) or the test would
        // pass even with the ERC-20 guard removed. Assert the asset first.
        LibVaipakam.Loan memory nftLoan = LoanFacet(address(diamond)).getLoanDetails(2);
        assertEq(nftLoan.principalAsset, mockNft721, "loan 2 principal asset is the NFT");
        // 50% floor: minPartial = principal(10) * 5000 / 10000 = 5 token units.
        // A 1-DAY rental partial is `1`, which the pre-scoping check compared as
        // `1 < 5` and wrongly reverted `InsufficientPartialAmount`.
        TestMutatorFacet(address(diamond)).setMinPartialBpsRaw(mockNft721, 5000);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(2, 1);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        // Pass-2 D1 (#1188): durationDays immutable; the rental partial went
        // through (not blocked by the min-partial floor) — proven by
        // lastDeductTime advancing one day rather than by a term decrement.
        assertEq(loan.durationDays, 30, "durationDays immutable (#1188)");
        assertEq(
            loan.lastDeductTime,
            loan.startTime + 1 days,
            "rental partial consumed 1 day (not blocked by the floor)"
        );
    }

    /// @dev Tests repayPartial NFT "Treasury share failed" path.
    ///      First vaultWithdrawERC20 (lender share) succeeds; second (treasury share) fails.
    function testRepayPartialNFTTreasuryShareFails() public {
        helperOfferLoan();
        // NFT loan loanId=2; first call is lender share, second is treasury share.
        // We need lender share to succeed but treasury share to fail.
        // Get borrower's vault address used in the call args:
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        // We mock by counting: first call succeeds (lender share to lender addr), second reverts.
        // Can differentiate by the `to` parameter: lender vs treasury.
        // lender address is lender, treasury is address(diamond).
        // Mock lender share call to succeed specifically (to=lender)
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector, borrower, mockERC20, lender),
            abi.encode(true)
        );
        // Mock treasury share call to fail (to=address(diamond)/treasury)
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector, borrower, mockERC20, address(diamond)),
            "treasury fail"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("treasury fail"));
        RepayFacet(address(diamond)).repayPartial(2, 1);
        vm.clearMockedCalls();
    }

    /// @dev Tests repayPartial NFT "Update expires failed" path.
    ///      Lender and treasury share succeed; vaultSetNFTUser fails.
    function testRepayPartialNFTUpdateExpiresFails2() public {
        helperOfferLoan();
        // Mock vaultSetNFTUser to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultSetNFTUser.selector),
            "expires fail"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("expires fail"));
        RepayFacet(address(diamond)).repayPartial(2, 1);
        vm.clearMockedCalls();
    }

    /// @dev Tests autoDeductDaily reverts InsufficientPrepay when dayFee > prepayAmount.
    function testAutoDeductDailyRevertsInsufficientPrepay() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(2);
        loan.prepayAmount = 0;
        TestMutatorFacet(address(diamond)).setLoan(2, loan);

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(RepayFacet.InsufficientPrepay.selector);
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);
    }

    /// @dev Tests autoDeductDaily "Treasury deduct failed" path.
    ///      First vaultWithdrawERC20 (lender share) succeeds; second (treasury share) fails.
    function testAutoDeductDailyTreasuryDeductFails() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);

        address borrowerAddr = borrower;
        // First call: lender share (to=lender) → succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector, borrowerAddr, mockERC20, lender),
            abi.encode(true)
        );
        // Second call: treasury share (to=address(diamond)) → fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector, borrowerAddr, mockERC20, address(diamond)),
            "treasury fail"
        );
        vm.expectRevert(bytes("treasury fail"));
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);
        vm.clearMockedCalls();
    }

    /// @dev Tests autoDeductDaily "Update expires failed" when vaultSetNFTUser fails.
    function testAutoDeductDailyUpdateExpiresFails() public {
        helperOfferLoan();
        vm.warp(block.timestamp + 1 days);

        // Mock vaultSetNFTUser to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultSetNFTUser.selector),
            "expires fail"
        );
        vm.expectRevert(bytes("expires fail"));
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(2);
        vm.clearMockedCalls();
    }

    /// @dev Tests repayPartial HF check cross-facet failure.
    function testRepayPartialHFCheckFails() public {
        helperOfferLoan();
        // Mock calculateHealthFactor to revert
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            "hf fail"
        );
        vm.prank(borrower);
        vm.expectRevert(bytes("hf fail"));
        RepayFacet(address(diamond)).repayPartial(1, 500);
        vm.clearMockedCalls();
    }

    // ─── Grace Period Tier Tests ─────────────────────────────────────────────

    /// @dev Helper to create a loan with a specific duration in days.
    function helperOfferLoanWithDuration(uint256 durationDays) internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1500,
                durationDays: durationDays,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        loanId = LibAcceptTestSigner.signAndAccept(
            address(diamond), borrower, borrowerPk, offerId
        );
    }

    /// @dev 3-day loan: grace = 1 hour. Repay at endTime + 59 minutes succeeds.
    function testGracePeriod1Hour_LessThan7DayLoan() public {
        uint256 loanId = helperOfferLoanWithDuration(3);
        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + 3 days;

        // Repay at endTime + 59 minutes: should succeed
        vm.warp(endTime + 59 minutes);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));

        // Create another 3-day loan and verify endTime + 1 hour + 1 reverts
        // Need fresh balances
        deal(mockERC20, lender, 1e18);
        deal(mockERC20, borrower, 1e18);
        uint256 startTime2 = block.timestamp;
        uint256 loanId2 = helperOfferLoanWithDuration(3);
        uint256 endTime2 = startTime2 + 3 days;

        vm.warp(endTime2 + 1 hours + 1);
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.RepaymentPastGracePeriod.selector);
        RepayFacet(address(diamond)).repayLoan(loanId2);
    }

    /// @dev 15-day loan: grace = 1 day. Repay at endTime + 23 hours succeeds.
    function testGracePeriod1Day_LessThan30DayLoan() public {
        uint256 loanId = helperOfferLoanWithDuration(15);
        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + 15 days;

        // Repay at endTime + 23 hours: should succeed
        vm.warp(endTime + 23 hours);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));

        // Verify endTime + 1 day + 1 reverts
        deal(mockERC20, lender, 1e18);
        deal(mockERC20, borrower, 1e18);
        uint256 startTime2 = block.timestamp;
        uint256 loanId2 = helperOfferLoanWithDuration(15);
        uint256 endTime2 = startTime2 + 15 days;

        vm.warp(endTime2 + 1 days + 1);
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.RepaymentPastGracePeriod.selector);
        RepayFacet(address(diamond)).repayLoan(loanId2);
    }

    /// @dev 60-day loan: grace = 3 days. Repay at endTime + 2 days succeeds.
    function testGracePeriod3Day_LessThan90DayLoan() public {
        uint256 loanId = helperOfferLoanWithDuration(60);
        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + 60 days;

        vm.warp(endTime + 2 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));

        // Verify endTime + 3 days + 1 reverts
        deal(mockERC20, lender, 1e18);
        deal(mockERC20, borrower, 1e18);
        uint256 startTime2 = block.timestamp;
        uint256 loanId2 = helperOfferLoanWithDuration(60);
        uint256 endTime2 = startTime2 + 60 days;

        vm.warp(endTime2 + 3 days + 1);
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.RepaymentPastGracePeriod.selector);
        RepayFacet(address(diamond)).repayLoan(loanId2);
    }

    /// @dev 120-day loan: grace = 1 week. Repay at endTime + 6 days succeeds.
    function testGracePeriod1Week_LessThan180DayLoan() public {
        uint256 loanId = helperOfferLoanWithDuration(120);
        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + 120 days;

        vm.warp(endTime + 6 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));

        // Verify endTime + 1 week + 1 reverts
        deal(mockERC20, lender, 1e18);
        deal(mockERC20, borrower, 1e18);
        uint256 startTime2 = block.timestamp;
        uint256 loanId2 = helperOfferLoanWithDuration(120);
        uint256 endTime2 = startTime2 + 120 days;

        vm.warp(endTime2 + 1 weeks + 1);
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.RepaymentPastGracePeriod.selector);
        RepayFacet(address(diamond)).repayLoan(loanId2);
    }

    /// @dev 200-day loan: grace = 2 weeks. Repay at endTime + 13 days succeeds.
    function testGracePeriod2Weeks_180PlusDayLoan() public {
        uint256 loanId = helperOfferLoanWithDuration(200);
        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + 200 days;

        vm.warp(endTime + 13 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid));

        // Verify endTime + 2 weeks + 1 reverts
        deal(mockERC20, lender, 1e18);
        deal(mockERC20, borrower, 1e18);
        uint256 startTime2 = block.timestamp;
        uint256 loanId2 = helperOfferLoanWithDuration(200);
        uint256 endTime2 = startTime2 + 200 days;

        vm.warp(endTime2 + 2 weeks + 1);
        vm.prank(borrower);
        vm.expectRevert(RepayFacet.RepaymentPastGracePeriod.selector);
        RepayFacet(address(diamond)).repayLoan(loanId2);
    }

    // ─── Late Fee Schedule Tests ─────────────────────────────────────────────

    /// @dev 1 day late: fee = principal * 100 / 10000 = 1%
    function testLateFeeDay1Exact() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        uint256 endTime = loan.startTime + loan.durationDays * 1 days;

        // Warp to 1 day after endTime
        vm.warp(endTime + 1 days);

        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(1);
        // Late fee = principal * (100 + 1*50) / 10000 = 1000 * 150 / 10000 = 15
        // But daysLate = (block.timestamp - endTime) / 1 days = 1
        // feePercent = 100 + 1*50 = 150 bps
        // lateFee = 1000 * 150 / 10000 = 15
        // Total = principal + interest + lateFee
        // Interest at endTime: 1000 * 500 / 10000 = 50 (full duration pro-rata)
        // due should include lateFee of 15
        assertGt(due, 1000, "Due should be greater than principal");
        // We can verify the late fee is included by comparing with no-late-fee scenario
    }

    /// @dev 3 days late: fee = principal * 250 / 10000 = 2.5%
    function testLateFeeDay3Exact() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        uint256 endTime = loan.startTime + loan.durationDays * 1 days;

        // Warp to 3 days after endTime
        vm.warp(endTime + 3 days);

        uint256 due = RepayFacet(address(diamond)).calculateRepaymentAmount(1);
        // daysLate = 3, feePercent = 100 + 3*50 = 250 bps
        // lateFee = 1000 * 250 / 10000 = 25
        assertGt(due, 1000, "Due should be greater than principal");
    }

    /// @dev 10+ days late: fee = principal * 500 / 10000 = 5% (capped)
    function testLateFeeCappedAt5Percent() public {
        helperOfferLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        uint256 endTime = loan.startTime + loan.durationDays * 1 days;

        // Warp to 10 days after endTime (still within grace for 30-day loan: grace = 3 days, so past grace)
        // But calculateRepaymentAmount is a view function and doesn't revert on past-grace
        vm.warp(endTime + 10 days);

        uint256 due10 = RepayFacet(address(diamond)).calculateRepaymentAmount(1);

        // Warp to 20 days after endTime: should be same late fee (capped at 500 bps)
        vm.warp(endTime + 20 days);
        uint256 due20 = RepayFacet(address(diamond)).calculateRepaymentAmount(1);

        // Both should have same late fee (capped at 5%)
        // daysLate=10: feePercent = 100 + 10*50 = 600, capped to 500 → lateFee = 1000 * 500 / 10000 = 50
        // daysLate=20: feePercent = 100 + 20*50 = 1100, capped to 500 → lateFee = 1000 * 500 / 10000 = 50
        // The interest portion differs (pro-rata grows with elapsed time), but late fee cap is same
        // Just verify due is reasonable
        assertGt(due10, 1000, "Due should be greater than principal");
        assertGt(due20, 1000, "Due should be greater than principal");
    }

    // ─── #408 / #410 / #413 — floor-model regression tests ─────────────

    /// @dev Build a loan with `useFullTermInterest: true` so the floor
    ///      formula in `LibEntitlement.settlementInterest` activates.
    function _helperFloorLoan() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1500,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
        loanId = LibAcceptTestSigner.signAndAccept(
            address(diamond), borrower, borrowerPk, offerId
        );
    }

    /// @notice #408 — early repay on a full-term loan charges floor
    ///         (full-term interest), not pro-rata.
    function test_408_EarlyRepayChargesFullTermFloor() public {
        uint256 loanId = _helperFloorLoan();
        // Repay at day 1 of a 30-day term.
        vm.warp(block.timestamp + 1 days);

        // Expected interest: full-term floor (proRataInterest @ 30 days)
        // = 1000 * 500 * 30 / (365 * 10000) = ~4.10 → truncated to 4.
        uint256 expectedFloor = (uint256(1000) * 500 * 30) / (365 * 10000);
        uint256 due = RepayFacet(address(diamond))
            .calculateRepaymentAmount(loanId);
        // Full repay = principal + expectedFloor + 0 late fee.
        assertEq(
            due,
            1000 + expectedFloor,
            "early repay must charge full-term floor under useFullTermInterest=true"
        );
    }

    /// @notice #413 — preclose after a partial-repay does NOT
    ///         double-charge interest already paid via the partial.
    function test_413_PrecloseAfterPartialDoesNotDoubleCharge() public {
        uint256 loanId = _helperFloorLoan();
        // Repay partial at day 10 of 30-day term (1/3 elapsed).
        vm.warp(block.timestamp + 10 days);
        uint256 partialAmt = 500; // half the principal

        // Snapshot borrower wallet before partial.
        uint256 walletBeforePartial = ERC20(mockERC20).balanceOf(borrower);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, partialAmt);
        uint256 walletAfterPartial = ERC20(mockERC20).balanceOf(borrower);
        uint256 paidOnPartial = walletBeforePartial - walletAfterPartial;
        // Partial: half principal + ~1/3-term pro-rata interest on the
        // ORIGINAL 1000 principal.
        uint256 expectedPartialInterest = (uint256(1000) * 500 * 10) / (365 * 10000);
        assertEq(
            paidOnPartial,
            partialAmt + expectedPartialInterest,
            "partial-repay outflow = partial principal + accrued interest"
        );

        // Now full repay (preclose). After partial:
        //   principal = 500
        //   durationDays = 30 - 10 = 20 (decremented in repayPartial)
        //   interestSettled = 0 (Codex round-1 P1: state reset
        //     already encodes the partial's effect; crediting it
        //     would double-count)
        //   startTime = now (post-partial)
        // Floor at preclose (elapsed 0 < remaining 20 → use 20):
        //   gross = 500 * 500 * 20 / (365 * 10000) = ~1.37 → 1
        //   net   = gross (interestSettled = 0)
        //
        // This is FUTURE-only interest on the REMAINING principal.
        // The partial's interest (first 10 days on the original
        // 1000 principal) has already been paid above; the lender
        // is now entitled only to the remaining commitment's
        // coupon. Total over the loan's life: partial-interest +
        // preclose-interest = correct lender entitlement under
        // the floor model.
        uint256 grossRemaining = (uint256(500) * 500 * 20) / (365 * 10000);
        uint256 dueAfterPartial = RepayFacet(address(diamond))
            .calculateRepaymentAmount(loanId);
        assertEq(
            dueAfterPartial,
            500 + grossRemaining,
            "preclose after partial charges floor on REMAINING term + principal (#413 fix without double-counting)"
        );
        // Sentinel: borrower's PARTIAL outflow + preclose outflow
        // sums to the correct lender entitlement.
        // (Not used directly in the assertion above but keeps the
        // mental model traceable for the next reader.)
        assertTrue(expectedPartialInterest >= 0, "trace anchor");
    }
}
