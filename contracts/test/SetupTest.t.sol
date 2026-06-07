// src/test/SetupTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferParallelSaleFacet} from "../src/facets/OfferParallelSaleFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {MetricsDashboardFacet} from "../src/facets/MetricsDashboardFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {PayrollFacet} from "../src/facets/PayrollFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
 // For mock ERC20
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
 // For mock NFT
 // For rentable NFT
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
 // For cutting
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
 // For vault impl
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferParallelSaleFacet} from "../src/facets/OfferParallelSaleFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
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
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {console} from "forge-std/console.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ZeroExProxyMock} from "./mocks/ZeroExProxyMock.sol";
import {MockZeroExLegacyAdapter} from "./mocks/MockZeroExLegacyAdapter.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
// #229 — Close the remaining test-vs-prod facet drift. Post-#228
// SetupTest cut 27 production facets + TestMutatorFacet (test-only)
// = 28 cut[] entries; production cuts 36 (per
// DiamondFacetNames.cutFacetNames()) + DiamondCutFacet via
// constructor = 37 routed facets. The 9 production facets below
// were the gap.
//
// Why each is safe-additive (no init wiring required):
//   - DiamondLoupeFacet + OwnershipFacet — pure read surfaces.
//   - OracleAdminFacet — admin-only setters; deployer already holds
//     all roles via `initializeAccessControl()`.
//   - LegalFacet — sanctions oracle defaults to address(0)
//     (fail-open, per CLAUDE.md retail-deploy policy).
//   - VPFIDiscountFacet + StakingRewardsFacet + InteractionRewardsFacet
//     + RewardAggregatorFacet + RewardReporterFacet — state read on
//     demand from shared storage; zero defaults are valid for every
//     happy-path consumer.
import {DiamondLoupeFacet} from "../src/facets/DiamondLoupeFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {StakingRewardsFacet} from "../src/facets/StakingRewardsFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
// #168 Track A — narrow (not yet close) the test-vs-prod drift. The
// production diamond cuts these four facets
// (DiamondFacetNames.cutFacetNames() + DeployDiamond.s.sol §5), but
// SetupTest historically omitted them. The drift forced every test
// that mutates a loan past creation (preclose / refinance / partial
// withdrawal / lender early-withdrawal) to roll its own bespoke
// `setUp`, which is exactly the duplication Track A is folding away.
// Same strict-additive pattern as the OfferMatchFacet addition for
// #173 (see the comment above the OfferMatchFacet cut below): no
// existing SetupTest consumer routes these selectors today, so adding
// the cuts can only add reachable surface — it can't break anything.
// The remaining 9-facet production gap is tracked as #229.
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {NFTPrepayListingFacet} from "../src/facets/NFTPrepayListingFacet.sol";
import {NFTPrepayDutchListingFacet} from "../src/facets/NFTPrepayDutchListingFacet.sol";
import {NFTPrepayListingAtomicFacet} from "../src/facets/NFTPrepayListingAtomicFacet.sol";
import {NFTPrepayAutoListFacet} from "../src/facets/NFTPrepayAutoListFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";

contract SetupTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender; // User1
    address borrower; // User2
    address mockERC20; // Liquid asset
    address mockCollateralERC20; // Second liquid asset (collateral leg — distinct from lending leg)
    address mockIlliquidERC20; // Illiquid asset
    address mockNft721; // Rentable NFT
    address mockZeroExProxy;
    uint256 constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 constant BASIS_POINTS = 10000;
    uint256 constant RENTAL_BUFFER_BPS = 500;
    uint256 constant MIN_HEALTH_FACTOR = 150 * 1e16; // 1.5 scaled

    // address constant ZERO_EX_PROXY = 0xDef1C0ded9bec7F1a1670819833240f027b25EfF;

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
        // Also mock the execution-routing variant used by RiskFacet /
        // DefaultedFacet (README §1 two-layer liquidity model).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidityOnActiveNetwork.selector, asset),
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
    OfferParallelSaleFacet offerParallelSaleFacet;
    OfferAcceptFacet offerAcceptFacet;
    OfferCancelFacet offerCancelFacet;
    // OfferMatchFacet — Range Orders Phase 1 matching surface (#46).
    // Production diamond cuts it (DiamondFacetNames §4 + DeployDiamond
    // step 5e); SetupTest's test diamond previously omitted it, which
    // was a latent drift between test and prod. Fix landed alongside
    // BorrowerPartialFillTest (#173) so matchOffers / previewMatch
    // become reachable from every test that inherits SetupTest.
    OfferMatchFacet offerMatchFacet;
    // OfferMutateFacet — #193 in-place modification surface
    // (setOfferAmount / setOfferRate / setOfferCollateral +
    // combined modifyOffer). Carved into its own facet mirroring
    // the OfferCancel / OfferMatch pattern; cut into the production
    // diamond at cuts[36] in DeployDiamond.s.sol.
    OfferMutateFacet offerMutateFacet;
    ProfileFacet profileFacet;
    OracleFacet oracleFacet;
    VaipakamNFTFacet nftFacet;
    VaultFactoryFacet vaultFacet;
    LoanFacet loanFacet;
    DefaultedFacet defaultFacet;
    RiskFacet riskFacet; // Added
    RiskMatchLiquidationFacet riskMatchLiquidationFacet;
    RepayFacet repayFacet;
    SwapToRepayFacet swapToRepayFacet;
    // T-090 v1.1 (#389) — intent-based swap-to-repay sibling facet.
    SwapToRepayIntentFacet swapToRepayIntentFacet;
    IntentConfigFacet intentConfigFacet;
    AdminFacet adminFacet;
    ClaimFacet claimFacet;
    AddCollateralFacet addCollateralFacet;
    AccessControlFacet accessControlFacet;
    MetricsFacet metricsFacet;
    MetricsDashboardFacet metricsDashboardFacet;
    TreasuryFacet treasuryFacet;
    PayrollFacet payrollFacet;
    VPFITokenFacet vpfiTokenFacet;
    TestMutatorFacet testMutatorFacet;
    ConfigFacet configFacet;
    // #168 Track A — Phase-2 facet quartet routed to close the
    // test-vs-prod drift. Imports + cut entries below.
    EarlyWithdrawalFacet earlyWithdrawalFacet;
    PartialWithdrawalFacet partialWithdrawalFacet;
    PrecloseFacet precloseFacet;
    PrepayListingFacet prepayListingFacet;
    NFTPrepayListingFacet nftPrepayListingFacet;
    NFTPrepayDutchListingFacet nftPrepayDutchListingFacet;
    NFTPrepayListingAtomicFacet nftPrepayListingAtomicFacet;
    NFTPrepayAutoListFacet nftPrepayAutoListFacet;
    RefinanceFacet refinanceFacet;
    // #229 — final 9-facet superset closure.
    DiamondLoupeFacet diamondLoupeFacet;
    OwnershipFacet ownershipFacet;
    OracleAdminFacet oracleAdminFacet;
    LegalFacet legalFacet;
    VPFIDiscountFacet vpfiDiscountFacet;
    StakingRewardsFacet stakingRewardsFacet;
    InteractionRewardsFacet interactionRewardsFacet;
    RewardAggregatorFacet rewardAggregatorFacet;
    RewardReporterFacet rewardReporterFacet;
    HelperTest helperTest;

    // Vault impl
    VaipakamVaultImplementation vaultImpl;

    function setupHelper() public {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");

        // Deploy mocks
        mockERC20 = address(new ERC20Mock("MockLiquid", "MLQ", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockIlliquidERC20 = address(new ERC20Mock("MockIlliquid", "MIL", 18));
        mockNft721 = address(new MockRentableNFT721());
        mockZeroExProxy = address(new ZeroExProxyMock());
        address allowanceTarget = mockZeroExProxy; //makeAddr("allowanceTarget"); // Mock for tests
        console.log("mockZeroExProxy: ", mockZeroExProxy);

        // Mint some assets
        ERC20Mock(mockERC20).mint(lender, 100000 ether);
        ERC20Mock(mockERC20).mint(borrower, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(lender, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(borrower, 100000 ether);
        // ERC20Mock(mockIlliquidERC20).mint(lender, 100000 ether);
        ERC20Mock(mockIlliquidERC20).mint(borrower, 100000 ether);
        MockRentableNFT721(mockNft721).mint(lender, 1);

        // Mint output tokens to mock (e.g., principalAsset)
        ERC20Mock(mockERC20).mint(address(mockZeroExProxy), 1000000 ether); // Enough for proceeds
        ERC20Mock(mockCollateralERC20).mint(address(mockZeroExProxy), 1000000 ether);

        // Set mock rate if needed (e.g., for liqBonus)
        ZeroExProxyMock(address(mockZeroExProxy)).setRate(11, 10); // 10% more for profit

        // Deploy facets
        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));

        offerCreateFacet = new OfferCreateFacet();
        offerParallelSaleFacet = new OfferParallelSaleFacet();
        offerAcceptFacet = new OfferAcceptFacet();
        offerCancelFacet = new OfferCancelFacet();
        offerMatchFacet = new OfferMatchFacet();
        offerMutateFacet = new OfferMutateFacet();
        profileFacet = new ProfileFacet();
        oracleFacet = new OracleFacet();
        nftFacet = new VaipakamNFTFacet();
        vaultFacet = new VaultFactoryFacet();
        loanFacet = new LoanFacet();
        defaultFacet = new DefaultedFacet();
        riskFacet = new RiskFacet();
        riskMatchLiquidationFacet = new RiskMatchLiquidationFacet();
        repayFacet = new RepayFacet();
        swapToRepayFacet = new SwapToRepayFacet();
        swapToRepayIntentFacet = new SwapToRepayIntentFacet();
        intentConfigFacet = new IntentConfigFacet();
        adminFacet = new AdminFacet();
        claimFacet = new ClaimFacet();
        addCollateralFacet = new AddCollateralFacet();
        accessControlFacet = new AccessControlFacet();
        metricsFacet = new MetricsFacet();
        metricsDashboardFacet = new MetricsDashboardFacet();
        treasuryFacet = new TreasuryFacet();
        payrollFacet = new PayrollFacet();
        vpfiTokenFacet = new VPFITokenFacet();
        testMutatorFacet = new TestMutatorFacet();
        configFacet = new ConfigFacet();
        // #168 Track A — Phase-2 facet quartet construction (cut below).
        earlyWithdrawalFacet = new EarlyWithdrawalFacet();
        partialWithdrawalFacet = new PartialWithdrawalFacet();
        precloseFacet = new PrecloseFacet();
        prepayListingFacet = new PrepayListingFacet();
        nftPrepayListingFacet = new NFTPrepayListingFacet();
        nftPrepayDutchListingFacet = new NFTPrepayDutchListingFacet();
        nftPrepayListingAtomicFacet = new NFTPrepayListingAtomicFacet();
        nftPrepayAutoListFacet = new NFTPrepayAutoListFacet();
        refinanceFacet = new RefinanceFacet();
        // #229 — final 9-facet superset closure (cut below).
        diamondLoupeFacet = new DiamondLoupeFacet();
        ownershipFacet = new OwnershipFacet();
        oracleAdminFacet = new OracleAdminFacet();
        legalFacet = new LegalFacet();
        vpfiDiscountFacet = new VPFIDiscountFacet();
        stakingRewardsFacet = new StakingRewardsFacet();
        interactionRewardsFacet = new InteractionRewardsFacet();
        rewardAggregatorFacet = new RewardAggregatorFacet();
        rewardReporterFacet = new RewardReporterFacet();
        helperTest = new HelperTest();

        // Deploy vault impl
        vaultImpl = new VaipakamVaultImplementation();

        // Cut facets into diamond. #229 closes the test-vs-prod drift
        // that #168 Track A narrowed: 28 → 37 cut[] entries, matching
        // the 36 facets DiamondFacetNames.cutFacetNames() enumerates
        // plus TestMutatorFacet (test-only, intentionally on top of
        // the production superset).
        //
        // SetupTest is now a STRICT SUPERSET of production: every facet
        // in DiamondFacetNames.cutFacetNames() is routed here, plus
        // TestMutatorFacet for test-only direct-write hooks. The 9
        // production facets added in #229 (slots 28-36 below) —
        // DiamondLoupeFacet, OwnershipFacet, OracleAdminFacet,
        // LegalFacet, VPFIDiscountFacet, StakingRewardsFacet,
        // InteractionRewardsFacet, RewardAggregatorFacet,
        // RewardReporterFacet — are pure additive cuts with no
        // post-init wiring required. Their shared-storage state reads
        // resolve to zero defaults; happy-path consumers see the same
        // diamond shape they always did, now with reachable selectors
        // for the previously-unrouted facets.
        //
        // Historical context: #168 Track A (PR #228) added the
        // Preclose / Refinance / EarlyWithdrawal / PartialWithdrawal
        // quartet at slots 24-27 to unblock the PauseGating fold —
        // those slots stay where they are.
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](47);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(offerCreateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferCreateFacetSelectors() // .getOfferCreateFacetSelectors()
        });
        cuts[22] = IDiamondCut.FacetCut({
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
        cuts[13] = IDiamondCut.FacetCut({
            facetAddress: address(testMutatorFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getTestMutatorFacetSelectors()
        });
        cuts[14] = IDiamondCut.FacetCut({
            facetAddress: address(metricsFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getMetricsFacetSelectors()
        });
        cuts[15] = IDiamondCut.FacetCut({
            facetAddress: address(vpfiTokenFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVPFITokenFacetSelectors()
        });
        cuts[16] = IDiamondCut.FacetCut({
            facetAddress: address(treasuryFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getTreasuryFacetSelectors()
        });
        cuts[17] = IDiamondCut.FacetCut({
            facetAddress: address(configFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getConfigFacetSelectors()
        });
        // OfferCancelFacet — cancelOffer + read views, carved out of
        // OfferFacet for the EIP-170 split. Same selectors land on
        // the diamond.
        cuts[18] = IDiamondCut.FacetCut({
            facetAddress: address(offerCancelFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferCancelFacetSelectors()
        });
        // AnalyticalGettersDesign §3.1 — per-user dashboard surface.
        cuts[19] = IDiamondCut.FacetCut({
            facetAddress: address(metricsDashboardFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getMetricsDashboardFacetSelectors()
        });
        // T-600 — founder/contributor salary streams.
        cuts[20] = IDiamondCut.FacetCut({
            facetAddress: address(payrollFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getPayrollFacetSelectors()
        });
        cuts[21] = IDiamondCut.FacetCut({
            facetAddress: address(riskMatchLiquidationFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()
        });
        // OfferMatchFacet — Range Orders Phase 1 matching surface
        // (`matchOffers` + `previewMatch`). The production deploy cuts
        // it (DeployDiamond.s.sol step 5e + DiamondFacetNames §4); this
        // entry closes the test-vs-prod drift for #173's coverage work.
        // No existing test calls these selectors today, so adding the
        // cut is a strict superset — every existing test sees the same
        // pre-#173 diamond shape plus two new view/external selectors.
        cuts[23] = IDiamondCut.FacetCut({
            facetAddress: address(offerMatchFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferMatchFacetSelectors()
        });
        // #168 Track A — production facet quartet. Each one is cut by
        // DeployDiamond.s.sol (steps in §5); their selector lists live
        // in HelperTest. Pause-gated tests, preclose / refinance flows,
        // partial-withdrawal and lender-early-withdrawal tests can now
        // inherit from SetupTest instead of rolling bespoke setUps.
        cuts[24] = IDiamondCut.FacetCut({
            facetAddress: address(precloseFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getPrecloseFacetSelectors()
        });
        cuts[25] = IDiamondCut.FacetCut({
            facetAddress: address(refinanceFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRefinanceFacetSelectors()
        });
        cuts[26] = IDiamondCut.FacetCut({
            facetAddress: address(earlyWithdrawalFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getEarlyWithdrawalFacetSelectors()
        });
        cuts[27] = IDiamondCut.FacetCut({
            facetAddress: address(partialWithdrawalFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getPartialWithdrawalFacetSelectors()
        });
        // #229 — final 9-facet closure. Slots 28-36 mirror
        // DiamondFacetNames.cutFacetNames()'s remaining entries.
        cuts[28] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupeFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getDiamondLoupeFacetSelectors()
        });
        cuts[29] = IDiamondCut.FacetCut({
            facetAddress: address(ownershipFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOwnershipFacetSelectors()
        });
        cuts[30] = IDiamondCut.FacetCut({
            facetAddress: address(oracleAdminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOracleAdminFacetSelectors()
        });
        cuts[31] = IDiamondCut.FacetCut({
            facetAddress: address(legalFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getLegalFacetSelectors()
        });
        cuts[32] = IDiamondCut.FacetCut({
            facetAddress: address(vpfiDiscountFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVPFIDiscountFacetSelectors()
        });
        cuts[33] = IDiamondCut.FacetCut({
            facetAddress: address(stakingRewardsFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getStakingRewardsFacetSelectors()
        });
        cuts[34] = IDiamondCut.FacetCut({
            facetAddress: address(interactionRewardsFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getInteractionRewardsFacetSelectors()
        });
        cuts[35] = IDiamondCut.FacetCut({
            facetAddress: address(rewardAggregatorFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRewardAggregatorFacetSelectors()
        });
        cuts[36] = IDiamondCut.FacetCut({
            facetAddress: address(rewardReporterFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRewardReporterFacetSelectors()
        });
        // #193 — in-place offer modification facet.
        cuts[37] = IDiamondCut.FacetCut({
            facetAddress: address(offerMutateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferMutateFacetSelectors()
        });
        // T-086 step 5 — PrepayListingFacet (executor↔diamond trust
        // boundary for Seaport prepay collateral sales).
        cuts[38] = IDiamondCut.FacetCut({
            facetAddress: address(prepayListingFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getPrepayListingFacetSelectors()
        });
        // T-086 step 6 — NFTPrepayListingFacet (borrower-facing
        // post / update / cancel / cancelExpired entry points +
        // view helpers for the FIXED-PRICE prepay listing flow).
        cuts[39] = IDiamondCut.FacetCut({
            facetAddress: address(nftPrepayListingFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getNFTPrepayListingFacetSelectors()
        });
        // T-086 Round-5 Block B (#309) — NFTPrepayDutchListingFacet
        // (Dutch-decay post + update sibling facet).
        cuts[40] = IDiamondCut.FacetCut({
            facetAddress: address(nftPrepayDutchListingFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getNFTPrepayDutchListingFacetSelectors()
        });
        // T-086 Round-6 / Block D (#345) — NFTPrepayListingAtomicFacet
        // (atomic match-rotation via Seaport matchAdvancedOrders;
        // kills the v1 English-mode race window §15.3 deliberately
        // accepted).
        cuts[41] = IDiamondCut.FacetCut({
            facetAddress: address(nftPrepayListingAtomicFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getNFTPrepayListingAtomicFacetSelectors()
        });
        // T-086 Round-7 (#355) — NFTPrepayAutoListFacet (permissionless
        // grace-period autoListAtFloorOnGrace entry point).
        cuts[42] = IDiamondCut.FacetCut({
            facetAddress: address(nftPrepayAutoListFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getNFTPrepayAutoListFacetSelectors()
        });
        // T-086 Round-8 (#358) — OfferParallelSaleFacet (borrow-OR-sell
        // postParallelSaleListing + releaseParallelSaleLock entry points;
        // carved off OfferCreateFacet for viaIR jump-table headroom).
        cuts[43] = IDiamondCut.FacetCut({
            facetAddress: address(offerParallelSaleFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferParallelSaleFacetSelectors()
        });
        // T-090 — Borrower-initiated swap-to-repay facet.
        cuts[44] = IDiamondCut.FacetCut({
            facetAddress: address(swapToRepayFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getSwapToRepayFacetSelectors()
        });
        // T-090 v1.1 (#389) — intent-based swap-to-repay sibling facet.
        cuts[45] = IDiamondCut.FacetCut({
            facetAddress: address(swapToRepayIntentFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getSwapToRepayIntentFacetSelectors()
        });
        // T-090 v1.1 (#389) intent-based swap-to-repay config facet.
        cuts[46] = IDiamondCut.FacetCut({
            facetAddress: address(intentConfigFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getIntentConfigFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Initialize AccessControl roles (must be first — all admin calls require roles)
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Init vault factory with impl
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
        AdminFacet(address(diamond)).setTreasury(address(diamond));

        // Unpause the diamond. The Diamond is born paused (see
        // `VaipakamDiamond.constructor` — `LibPausable.pause()` is the
        // last constructor write) so the half-cut window between the
        // raw deploy and the diamondCut above stays frozen on
        // mainnet. In tests we need facet entry points reachable, so
        // flip the bit back as soon as PAUSER_ROLE is in effect (i.e.
        // right after `initializeAccessControl`). Without this every
        // `whenNotPaused` path in every test would revert
        // `EnforcedPause`. Pause-specific tests
        // (`PauseGatingTest.t.sol`) re-pause and re-unpause inside
        // their own scope so this default doesn't stop them from
        // exercising the gated semantics.
        AdminFacet(address(diamond)).unpause();
        AdminFacet(address(diamond)).setZeroExProxy(
            address(mockZeroExProxy)
            // address(0xDef1C0ded9bec7F1a1670819833240f027b25EfF)
        );
        AdminFacet(address(diamond)).setallowanceTarget(
            address(allowanceTarget)
            // address(0xDef1C0ded9bec7F1a1670819833240f027b25EfF)
        );

        // Phase 7a: register the legacy-shim swap adapter as slot 0 in
        // the failover chain so the existing test corpus exercises the
        // same 0x mock through the new ISwapAdapter abstraction. Tests
        // that need richer chains push additional adapters via
        // `addSwapAdapter` in their own setUp.
        MockZeroExLegacyAdapter legacyShim = new MockZeroExLegacyAdapter(
            address(mockZeroExProxy)
        );
        AdminFacet(address(diamond)).addSwapAdapter(address(legacyShim));
        // address(vaultImpl)

        // Mock balances
        // deal(mockERC20, lender, 1e18);
        // deal(mockERC20, borrower, 1e18);
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
        MockRentableNFT721(mockNft721).approve(address(diamond), 1);

        // Mock Oracle: Liquid for ERC20, Illiquid for NFT
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockNft721, LibVaipakam.LiquidityStatus.Illiquid);
        mockOracleLiquidity(
            mockIlliquidERC20,
            LibVaipakam.LiquidityStatus.Illiquid
        );
        mockOraclePrice(mockERC20, 1e8, 8); // $1 price, 8 decimals
        mockOraclePrice(mockCollateralERC20, 1e8, 8); // $1 price, 8 decimals

        // Set trade allowance (assume allowed)
        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "FR", true);

        // Set user countries (for sanctions)
        vm.prank(lender);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower);
        ProfileFacet(address(diamond)).setUserCountry("US");

        // Set KYC (Tier2 = full KYC; also sets legacy kycVerified = true)
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);

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
        RiskFacet(address(diamond)).updateRiskParams(
            mockERC20,
            8000,
            300,
            1000
        );
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 300, 1000
        );

        // PR2 of internal-match work (2026-05-14) — per-tier
        // LIQUIDATION threshold replaces the retired per-asset
        // `liqThresholdBps`. Tests historically tuned HF math against
        // an 85% (8500 BPS) threshold; pin every tier to 8500 here so
        // every loan's snapshot lands on the legacy value. Production
        // defaults (9000 / 8500 / 8000) and the cross-tier monotonic
        // invariant are exercised by the dedicated tier-liquidation
        // setter tests. Uses the TestMutatorFacet direct-write
        // helper because some downstream test diamonds don't cut
        // `ConfigFacet`.
        TestMutatorFacet(address(diamond)).setTierLiquidationLtvBpsAllRaw(8500, 8500, 8500);

        // Mock oracle: Set liquid for mockERC20, illiquid for others.
        // Mock both the classification (checkLiquidity) and execution-routing
        // (checkLiquidityOnActiveNetwork) variants — README §1 two-layer model.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidity.selector,
                mockERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Liquid)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidityOnActiveNetwork.selector,
                mockERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Liquid)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidity.selector,
                mockCollateralERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Liquid)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidityOnActiveNetwork.selector,
                mockCollateralERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Liquid)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidity.selector,
                mockIlliquidERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidityOnActiveNetwork.selector,
                mockIlliquidERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidity.selector,
                mockNft721
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidityOnActiveNetwork.selector,
                mockNft721
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );

        // Mock prices: $1 for simplicity
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockERC20
            ),
            abi.encode(1e8, 8) // $1, 8 decimals
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(1e8, 8) // $1, 8 decimals
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockIlliquidERC20
            ),
            abi.encode(1e8, 8) // Even if illiquid, for calc
        );

        // Approve vaults
        vm.prank(lender);
        ERC20(mockERC20).approve(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender),
            type(uint256).max
        );
        vm.prank(borrower);
        ERC20(mockERC20).approve(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
                borrower
            ),
            type(uint256).max
        );
        vm.prank(lender);
        ERC20(mockCollateralERC20).approve(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender),
            type(uint256).max
        );
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
                borrower
            ),
            type(uint256).max
        );
        vm.prank(lender);
        ERC20(mockIlliquidERC20).approve(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender),
            type(uint256).max
        );
        vm.prank(borrower);
        ERC20(mockIlliquidERC20).approve(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
                borrower
            ),
            type(uint256).max
        );
        vm.prank(lender);
        IERC721(mockNft721).setApprovalForAll(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender),
            true
        );
    }
}
