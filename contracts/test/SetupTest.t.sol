// src/test/SetupTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
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
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
 // For mock ERC20
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
 // For mock NFT
 // For rentable NFT
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
 // For cutting
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
 // For escrow impl
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {console} from "forge-std/console.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
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

contract SetupTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender; // User1
    address borrower; // User2
    address mockERC20; // Liquid asset
    address mockCollateralERC20; // Second liquid asset (collateral leg — distinct from lending leg)
    address mockIlliquidERC20; // Illiquid asset
    address mockNFT721; // Rentable NFT
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
    OfferFacet offerFacet;
    ProfileFacet profileFacet;
    OracleFacet oracleFacet;
    VaipakamNFTFacet nftFacet;
    EscrowFactoryFacet escrowFacet;
    LoanFacet loanFacet;
    DefaultedFacet defaultFacet;
    RiskFacet riskFacet; // Added
    RepayFacet repayFacet;
    AdminFacet adminFacet;
    ClaimFacet claimFacet;
    AddCollateralFacet addCollateralFacet;
    AccessControlFacet accessControlFacet;
    MetricsFacet metricsFacet;
    TreasuryFacet treasuryFacet;
    VPFITokenFacet vpfiTokenFacet;
    TestMutatorFacet testMutatorFacet;
    ConfigFacet configFacet;
    HelperTest helperTest;

    // Escrow impl
    VaipakamEscrowImplementation escrowImpl;

    function setupHelper() public {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");

        // Deploy mocks
        mockERC20 = address(new ERC20Mock("MockLiquid", "MLQ", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockIlliquidERC20 = address(new ERC20Mock("MockIlliquid", "MIL", 18));
        mockNFT721 = address(new MockRentableNFT721());
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
        MockRentableNFT721(mockNFT721).mint(lender, 1);

        // Mint output tokens to mock (e.g., principalAsset)
        ERC20Mock(mockERC20).mint(address(mockZeroExProxy), 1000000 ether); // Enough for proceeds
        ERC20Mock(mockCollateralERC20).mint(address(mockZeroExProxy), 1000000 ether);

        // Set mock rate if needed (e.g., for liqBonus)
        ZeroExProxyMock(address(mockZeroExProxy)).setRate(11, 10); // 10% more for profit

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
        metricsFacet = new MetricsFacet();
        treasuryFacet = new TreasuryFacet();
        vpfiTokenFacet = new VPFITokenFacet();
        testMutatorFacet = new TestMutatorFacet();
        configFacet = new ConfigFacet();
        helperTest = new HelperTest();

        // Deploy escrow impl
        escrowImpl = new VaipakamEscrowImplementation();

        // Cut facets into diamond
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](18);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(offerFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferFacetSelectors() // .getOfferFacetSelectors()
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

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Initialize AccessControl roles (must be first — all admin calls require roles)
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Init escrow factory with impl
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
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
        // address(escrowImpl)

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
        MockRentableNFT721(mockNFT721).approve(address(diamond), 1);

        // Mock Oracle: Liquid for ERC20, Illiquid for NFT
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockNFT721, LibVaipakam.LiquidityStatus.Illiquid);
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

        // Set maxLtvBps in risk params (assume owner sets)
        // For mockERC20 collateral: maxLtvBps 8000 (80%)
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(
            mockERC20,
            8000,
            8500,
            300,
            1000
        );
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(
            mockCollateralERC20,
            8000,
            8500,
            300,
            1000
        );

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
                mockNFT721
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidityOnActiveNetwork.selector,
                mockNFT721
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

        // Approve escrows
        vm.prank(lender);
        ERC20(mockERC20).approve(
            EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender),
            type(uint256).max
        );
        vm.prank(borrower);
        ERC20(mockERC20).approve(
            EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(
                borrower
            ),
            type(uint256).max
        );
        vm.prank(lender);
        ERC20(mockCollateralERC20).approve(
            EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender),
            type(uint256).max
        );
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(
            EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(
                borrower
            ),
            type(uint256).max
        );
        vm.prank(lender);
        ERC20(mockIlliquidERC20).approve(
            EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender),
            type(uint256).max
        );
        vm.prank(borrower);
        ERC20(mockIlliquidERC20).approve(
            EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(
                borrower
            ),
            type(uint256).max
        );
        vm.prank(lender);
        IERC721(mockNFT721).setApprovalForAll(
            EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender),
            true
        );
    }
}
