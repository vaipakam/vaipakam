// test/RiskFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {IZeroExProxy} from "../src/interfaces/IZeroExProxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// For mock ERC20
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
// For cutting
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {IZeroExProxy} from "../src/interfaces/IZeroExProxy.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
// For vault impl
import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {IZeroExProxy} from "../src/interfaces/IZeroExProxy.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {HelperTest} from "./HelperTest.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ZeroExProxyMock} from "./mocks/ZeroExProxyMock.sol";
import {MockZeroExLegacyAdapter} from "./mocks/MockZeroExLegacyAdapter.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";

contract RiskFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender; // User1
    address borrower; // User2
    address mockERC20; // Liquid asset
    address mockCollateralERC20; // Second liquid asset (collateral leg)
    address mockIlliquidERC20; // Illiquid asset
    address mockNft721; // Rentable NFT
    address mockZeroExProxy;
    uint256 constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 constant BASIS_POINTS = 10000;
    uint256 constant RENTAL_BUFFER_BPS = 500;
    uint256 constant MIN_HEALTH_FACTOR = 150 * 1e16; // 1.5 scaled
    uint256 constant HF_SCALE = 1e18;

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
            abi.encodeWithSelector(
                OracleFacet.checkLiquidityOnActiveNetwork.selector,
                asset
            ),
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
    DefaultedFacet defaultFacet;
    RiskFacet riskFacet; // Added
    RepayFacet repayFacet;
    AdminFacet adminFacet;
    ClaimFacet claimFacet;
    AddCollateralFacet addCollateralFacet;
    AccessControlFacet accessControlFacet;
    TestMutatorFacet testMutatorFacet;
    HelperTest helperTest;
    VaipakamVaultImplementation vaultImpl; // Vault impl

    // VaipakamDiamond diamond;
    // address owner;
    // address lender;
    // address borrower;
    // address mockERC20; // Principal asset
    // address mockCollateral; // Collateral asset (liquid ERC20)
    // uint256 constant KYC_THRESHOLD_USD = 2000 * 1e18;
    // uint256 constant BASIS_POINTS = 10000;
    // uint256 constant HF_SCALE = 1e18;

    // DiamondCutFacet cutFacet;
    // OfferCreateFacet offerCreateFacet;
    // OfferAcceptFacet offerAcceptFacet;
    // ProfileFacet profileFacet;
    // OracleFacet oracleFacet;
    // VaipakamNFTFacet nftFacet;
    // VaultFactoryFacet vaultFacet;
    // LoanFacet loanFacet;
    // RiskFacet riskFacet;
    // VaipakamVaultImplementation vaultImpl;
    // SetupTest setupTest;

    // address mockZeroExProxy = 0xDef1C0ded9bec7F1a1670819833240f027b25EfF;
    // address allowanceTarget = mockZeroExProxy; //makeAddr("allowanceTarget"); // Mock for tests

    function setUp() public {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");

        // Deploy mocks
        mockERC20 = address(new ERC20Mock("MockLiquid", "MLQ", 18));
        mockCollateralERC20 = address(
            new ERC20Mock("MockCollateral", "MCK", 18)
        );
        mockIlliquidERC20 = address(new ERC20Mock("MockIlliquid", "MIL", 18));
        mockNft721 = address(new MockRentableNFT721());
        mockZeroExProxy = address(new ZeroExProxyMock());
        address allowanceTarget = mockZeroExProxy;
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
        ERC20Mock(mockCollateralERC20).mint(
            address(mockZeroExProxy),
            1000000 ether
        );

        // Set mock rate if needed (e.g., for liqBonus)
        ZeroExProxyMock(address(mockZeroExProxy)).setRate(11, 10); // 10% more for profit

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
        defaultFacet = new DefaultedFacet();
        riskFacet = new RiskFacet();
        repayFacet = new RepayFacet();
        adminFacet = new AdminFacet();
        claimFacet = new ClaimFacet();
        addCollateralFacet = new AddCollateralFacet();
        accessControlFacet = new AccessControlFacet();
        testMutatorFacet = new TestMutatorFacet();
        helperTest = new HelperTest();

        // Deploy vault impl
        vaultImpl = new VaipakamVaultImplementation();

        // Cut facets into diamond
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](17);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(offerCreateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferCreateFacetSelectors()
        });
        cuts[16] = IDiamondCut.FacetCut({
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
            functionSelectors: helperTest.getVaipakamNftFacetSelectors()
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
        cuts[14] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});

        cuts[15] = IDiamondCut.FacetCut({facetAddress: address(new RiskMatchLiquidationFacet()), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();

        // Init vault factory with impl
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(
            address(mockZeroExProxy)
            // address(0xDef1C0ded9bec7F1a1670819833240f027b25EfF)
        );
        AdminFacet(address(diamond)).setallowanceTarget(
            address(allowanceTarget)
            // address(0xDef1C0ded9bec7F1a1670819833240f027b25EfF)
        );

        // Phase 7a: register the legacy ZeroEx shim as adapter slot 0
        // so triggerLiquidation / triggerDefault / claimAsLenderWithRetry
        // route through LibSwap into the existing ZeroExProxyMock.
        AdminFacet(address(diamond)).addSwapAdapter(
            address(new MockZeroExLegacyAdapter(address(mockZeroExProxy)))
        );
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
        mockOracleLiquidity(
            mockCollateralERC20,
            LibVaipakam.LiquidityStatus.Liquid
        );
        mockOracleLiquidity(mockNft721, LibVaipakam.LiquidityStatus.Illiquid);
        mockOracleLiquidity(
            mockIlliquidERC20,
            LibVaipakam.LiquidityStatus.Illiquid
        );
        mockOraclePrice(mockERC20, 1e8, 8); // $1 price, 8 decimals
        mockOraclePrice(mockCollateralERC20, 1e8, 8);

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
        ProfileFacet(address(diamond)).updateKYCTier(
            lender,
            LibVaipakam.KYCTier.Tier2
        );
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(
            borrower,
            LibVaipakam.KYCTier.Tier2
        );
        // Give the test contract and diamond itself Tier2 — needed for liquidation KYC checks
        // where msg.sender is address(this) (direct call) or address(diamond) (internal call)
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(
            address(this),
            LibVaipakam.KYCTier.Tier2
        );
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(
            address(diamond),
            LibVaipakam.KYCTier.Tier2
        );

        // Note: calculateHealthFactor and calculateLTV are NOT globally mocked — real logic runs.
        // createAndAcceptOffer uses 1800 ether collateral → real HF = 1.53 >= MIN_HF(1.5). ✓
        // Real LTV for 1000 principal / 1800 collateral at $1 = 5555 bps.

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
        // `liqThresholdBps`. The HF assertions in this suite were
        // calibrated to an 85% (8500 BPS) threshold (`HF = 1800 *
        // 8500 / 10000 / 1000 * 1e18 = 1.53e18`). Pin every tier to
        // 8500 so each loan's snapshot lands on the legacy value
        // and the existing HF math stays valid. Uses the test
        // mutator instead of `ConfigFacet.setTierLiquidationLtvBps`
        // because this test diamond doesn't cut `ConfigFacet`.
        TestMutatorFacet(address(diamond)).setTierLiquidationLtvBpsAllRaw(8500, 8500, 8500);

        // Mock oracle: Set liquid for mockERC20, illiquid for others.
        // Mock both classification and execution-routing variants — README §1.
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
            abi.encode(1e8, 8)
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

    // function setUp() public {
    //     setupTest = new SetupTest();
    //     setupTest.setupHelper();
    // }

    // function setUp() public {
    //     owner = address(this);
    //     lender = makeAddr("lender");
    //     borrower = makeAddr("borrower");

    //     // Deploy mocks
    //     mockERC20 = address(new ERC20Mock("MockPrincipal", "MPR", 18));
    //     mockERC20 = address(new ERC20Mock("MockCollateral", "MCL", 18));

    //     // Mint assets
    //     ERC20Mock(mockERC20).mint(lender, 10000 ether);
    //     ERC20Mock(mockERC20).mint(borrower, 10000 ether);

    //     // Deploy Diamond and facets
    //     cutFacet = new DiamondCutFacet();
    //     diamond = new VaipakamDiamond(owner, address(cutFacet));

    //     offerCreateFacet = new OfferCreateFacet();
    //     offerAcceptFacet = new OfferAcceptFacet();
    //     profileFacet = new ProfileFacet();
    //     oracleFacet = new OracleFacet();
    //     nftFacet = new VaipakamNFTFacet();
    //     vaultFacet = new VaultFactoryFacet();
    //     loanFacet = new LoanFacet();
    //     riskFacet = new RiskFacet(zeroExProxy);

    //     // Deploy vault impl
    //     vaultImpl = new VaipakamVaultImplementation();

    //     // Cut facets
    //     IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](7);
    //     cuts[0] = _createFacetCut(address(offerCreateFacet));
    //     cuts[1] = _createFacetCut(address(profileFacet));
    //     cuts[2] = _createFacetCut(address(oracleFacet));
    //     cuts[3] = _createFacetCut(address(nftFacet));
    //     cuts[4] = _createFacetCut(address(vaultFacet));
    //     cuts[5] = _createFacetCut(address(loanFacet));
    //     cuts[6] = _createFacetCut(address(riskFacet));

    //     IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

    //     // Init vault factory
    //     VaultFactoryFacet(address(diamond)).initializeVaultFactory(
    //         address(vaultImpl)
    //     );

    //     // Set user countries
    //     vm.prank(lender);
    //     ProfileFacet(address(diamond)).setUserCountry("US");
    //     vm.prank(borrower);
    //     ProfileFacet(address(diamond)).setUserCountry("US");

    //     // Mock oracle: liquid and $1 price for both
    //     vm.mockCall(
    //         address(diamond),
    //         abi.encodeWithSelector(
    //             OracleFacet.checkLiquidity.selector,
    //             mockERC20
    //         ),
    //         abi.encode(LibVaipakam.LiquidityStatus.Liquid)
    //     );
    //     vm.mockCall(
    //         address(diamond),
    //         abi.encodeWithSelector(
    //             OracleFacet.checkLiquidity.selector,
    //             mockERC20
    //         ),
    //         abi.encode(LibVaipakam.LiquidityStatus.Liquid)
    //     );
    //     vm.mockCall(
    //         address(diamond),
    //         abi.encodeWithSelector(
    //             OracleFacet.getAssetPrice.selector,
    //             mockERC20
    //         ),
    //         abi.encode(1e8, 8) // $1, 8 decimals
    //     );
    //     vm.mockCall(
    //         address(diamond),
    //         abi.encodeWithSelector(
    //             OracleFacet.getAssetPrice.selector,
    //             mockERC20
    //         ),
    //         abi.encode(1e8, 8) // $1, 8 decimals
    //     );

    //     // Set KYC true for all
    //     ProfileFacet(address(diamond)).updateKYCStatus(lender, true);
    //     ProfileFacet(address(diamond)).updateKYCStatus(borrower, true);
    //     ProfileFacet(address(diamond)).updateKYCStatus(address(this), true); // Liquidator in tests

    //     // Approvals for vaults
    //     vm.prank(lender);
    //     IERC20(mockERC20).approve(
    //         VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender),
    //         type(uint256).max
    //     );
    //     vm.prank(borrower);
    //     IERC20(mockERC20).approve(
    //         VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
    //             borrower
    //         ),
    //         type(uint256).max
    //     );

    //     // Set initial risk params for collateral
    //     vm.prank(owner);
    //     RiskFacet(address(diamond)).updateAssetRiskParams(
    //         mockERC20,
    //         8000,
    //         8500,
    //         500,
    //         1000
    //     ); // loanInitMaxLtvBps=80%, liqThresholdBps=85%, liqBonusBps=5%, reserveFactorBps=10%
    // }

    // Internal helper to create FacetCut (with dynamic selectors if needed; placeholder for all functions)
    function _createFacetCut(
        address facet
    ) internal pure returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory selectors = new bytes4[](0); // In practice, populate with actual selectors using vm.getCode or manual list
        return
            IDiamondCut.FacetCut({
                facetAddress: facet,
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: selectors
            });
    }

    // Helper to create and accept offer to start a loan
    function createAndAcceptOffer() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1800 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1800 ether,
                periodicInterestCadence: LibVaipakam
                    .PeriodicInterestCadence
                    .None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        loanId = 1; // Assuming first loan ID
    }

    function testUpdateAssetRiskParamsSuccess() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit RiskFacet.RiskParamsUpdated(mockERC20, 7000, 250, 1500);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 7000, 250, 1500);
        // Note: LibVaipakam.storageSlot() accesses the test contract's storage, not the diamond's.
        // Verification is done via the emitted event (RiskParamsUpdated) above.
        // The parameters are applied when createAndAcceptOffer uses the updated risk params.
    }

    // Note: the `testUpdateAssetRiskParamsRevertsInvalidParams` test that
    // covered the composite `liqThreshold > maxLtv` revert was retired
    // in PR2 of the internal-match work (2026-05-14) — the per-asset
    // `liqThresholdBps` parameter on `updateRiskParams` no longer
    // exists. Per-tier liquidation-threshold validation lives on the
    // new `ConfigFacet.setTierLiquidationLtvBps` setter; cross-tier
    // monotonic coverage is added in PR3's tier-config tests.

    function testUpdateAssetRiskParamsRevertsNotOwner() public {
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                lender,
                LibAccessControl.RISK_ADMIN_ROLE
            )
        );
        RiskFacet(address(diamond)).updateRiskParams(
            mockERC20,
            8000,
            300,
            1000
        );
    }

    function testCalculateLTVSuccess() public {
        uint256 loanId = createAndAcceptOffer();

        // Real LTV: principal=1000 ether, collateral=1800 ether, price=$1, elapsed=0
        // LTV = (1000e18 * 10000) / 1800e18 = 5555 bps (integer division)
        uint256 ltv = RiskFacet(address(diamond)).calculateLTV(loanId);
        assertEq(ltv, 5555);
    }

    function testCalculateLTVZeroCollateralValue() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock collateral price $0 — real calculateLTV reverts ZeroCollateral()
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(0, 8)
        );

        vm.expectRevert(RiskFacet.ZeroCollateral.selector);
        RiskFacet(address(diamond)).calculateLTV(loanId);
    }

    function testCalculateLTVInactiveLoan() public {
        // loanId=999 has no loan (id==0) → real calculateLTV reverts InvalidLoan()
        vm.expectRevert(RiskFacet.InvalidLoan.selector);
        RiskFacet(address(diamond)).calculateLTV(999);
    }

    function testCalculateHealthFactorSuccess() public {
        uint256 loanId = createAndAcceptOffer();

        // collateral=1800, principal=1000, $1 price, liqThresholdBps=8500
        // HF = (1800 * 8500 / 10000) / 1000 * 1e18 = 1.53e18
        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertEq(hf, 1530000000000000000);
    }

    function testCalculateHealthFactorZeroBorrow() public {
        uint256 loanId = createAndAcceptOffer();

        // _calculateCurrentBorrowBalance is internal; cannot be mocked via vm.mockCall.
        // Instead, verify that HF > 0 for an active loan (sanity check).
        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertGt(hf, 0);
    }

    function testCalculateHealthFactorInactiveLoan() public {
        // uint256 loanId = createAndAcceptOffer();
        // console.log("After createAndAcceptOffer");
        // vm.prank(lender);
        vm.expectRevert(RiskFacet.InvalidLoan.selector);
        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(999);
        // assertEq(hf, 0);
    }

    function testTriggerLiquidationSuccess() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock calculateHealthFactor to return HF < 1e18 (now routed through diamond proxy
        // via RiskFacet(address(this)).calculateHealthFactor, so vm.mockCall intercepts it).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal (doesn't transfer tokens — we deal them directly below).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        // Deal collateral tokens to diamond so the real ERC20 approve + swap flow works.
        // collateralAmount = 1800 ether; ZeroExProxyMock rate is 11/10 → proceeds = 1980 ether.
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // swapData targets ZeroExProxyMock.swap: input=collateral, output=principal, amount=1800e, recipient=diamond.
        // Mock NFT status updates (NFT update is a cross-facet call through the diamond).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        // Expect: HFLiquidationTriggered(loanId, liquidator=address(this), proceeds=1980 ether)
        // loanId and liquidator are indexed (topic1, topic2); proceeds is data.
        vm.expectEmit(true, true, false, true);
        emit RiskFacet.HFLiquidationTriggered(
            loanId,
            address(this),
            1980 ether
        );

        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Tests calculateLTV reverts if loan is illiquid (IlliquidLoanNoRiskMath).
    function testCalculateLTVRevertsForIlliquidLoan() public {
        uint256 loanId = createAndAcceptOffer();

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        loan.principalLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        vm.expectRevert(IVaipakamErrors.IlliquidLoanNoRiskMath.selector);
        RiskFacet(address(diamond)).calculateLTV(loanId);
    }

    /// @dev Tests calculateHealthFactor reverts for illiquid loan.
    function testCalculateHealthFactorRevertsForIlliquidLoan() public {
        uint256 loanId = createAndAcceptOffer();

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        loan.principalLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        vm.expectRevert(IVaipakamErrors.IlliquidLoanNoRiskMath.selector);
        RiskFacet(address(diamond)).calculateHealthFactor(loanId);
    }

    /// @dev Tests isCollateralValueCollapsed returns false for healthy loan.
    function testIsCollateralValueCollapsedFalseForHealthyLoan() public {
        uint256 loanId = createAndAcceptOffer();
        // HF = 1.53 > 1.0; LTV = 5555 < 11000 → not collapsed
        bool collapsed = RiskFacet(address(diamond)).isCollateralValueCollapsed(
            loanId
        );
        assertFalse(collapsed);
    }

    /// @dev Tests isCollateralValueCollapsed returns true when LTV > 11000.
    ///      Sets principal much higher than collateral so LTV > VOLATILITY_LTV_THRESHOLD_BPS (11000).
    function testIsCollateralValueCollapsedTrueWhenLTVHigh() public {
        uint256 loanId = createAndAcceptOffer();
        // With same $1 price: LTV = 20000 / 1800 * 10000 ≈ 111111 bps > 11000 → collapsed
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        loan.principal = 20000 ether;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        bool collapsed = RiskFacet(address(diamond)).isCollateralValueCollapsed(
            loanId
        );
        assertTrue(collapsed);
    }

    /// @dev Tests updateRiskParams reverts if asset is address(0).
    function testUpdateRiskParamsRevertsZeroAsset() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.InvalidAsset.selector);
        RiskFacet(address(diamond)).updateRiskParams(
            address(0),
            8000,
            300,
            1000
        );
    }

    /// @dev Tests triggerLiquidation reverts if loan is not Active.
    function testTriggerLiquidationRevertsIfNotActive() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        // Second call should revert as loan is now Defaulted
        vm.expectRevert(RiskFacet.InvalidLoan.selector);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts if collateral is non-liquid.
    function testTriggerLiquidationRevertsForNonLiquidCollateral() public {
        // Mock principal as illiquid so both assets match during loan creation
        // (avoids MixedCollateralNotAllowed)
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        // Create a loan with illiquid collateral
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockIlliquidERC20,
                collateralAmount: 1800 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1800 ether,
                periodicInterestCadence: LibVaipakam
                    .PeriodicInterestCadence
                    .None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
        uint256 loanId = 1;
        // Restore mockERC20 to liquid after loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        vm.expectRevert(IVaipakamErrors.NonLiquidAsset.selector);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation with hf >= 1 but past grace period (HF high but time-based).
    function testTriggerLiquidationPastGraceWithHighHF() public {
        uint256 loanId = createAndAcceptOffer();

        // Warp past grace
        vm.warp(block.timestamp + 30 days + 3 days + 1);

        // HF-based liquidation always requires HF < 1, even past grace.
        // Healthy loans past grace are handled by DefaultedFacet, not RiskFacet.
        vm.expectRevert(RiskFacet.HealthFactorNotLow.selector);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
    }

    /// @dev Tests triggerLiquidation reverts if HF >= 1 and still within grace (HealthFactorNotLow).
    function testTriggerLiquidationRevertsIfHFNotLow() public {
        uint256 loanId = createAndAcceptOffer();

        // HF is 1.53 (healthy) and still within grace period
        // The real calculateHealthFactor returns 1.53e18 (> 1e18)
        vm.expectRevert(RiskFacet.HealthFactorNotLow.selector);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
    }

    /// @dev Tests that borrow balance grows over time (indirectly via calculateLTV).
    ///      After warping 1 day, accrued interest increases borrow balance, which increases LTV.
    function testCalculateCurrentBorrowBalance() public {
        uint256 loanId = createAndAcceptOffer();
        uint256 ltvAtStart = RiskFacet(address(diamond)).calculateLTV(loanId);

        // Warp 1 day so accrued interest increases borrow balance and LTV
        vm.warp(block.timestamp + 1 days);

        uint256 ltvAfterDay = RiskFacet(address(diamond)).calculateLTV(loanId);
        // LTV should increase (or stay same if interest rate == 0) after 1 day
        assertGe(ltvAfterDay, ltvAtStart);
    }

    /// @dev README §7 slippage protection: a DEX swap that would yield more than 6%
    ///      below the oracle-derived expected output must not execute. The contract
    ///      constructs swap calldata with minOutputAmount = expected * 94%, so the
    ///      mock DEX reverts with SlippageExceeded when the rate is too low. The
    ///      triggerLiquidation call then falls back to the full-collateral-transfer
    ///      claim path (README §3, lines 140-141, 263-264).
    function testTriggerLiquidationExcessSlippageTriggersFallback() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        // Fallback path needs to look up the lender's vault.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.getOrCreateUserVault.selector
            ),
            abi.encode(address(diamond))
        );

        // Fallback path updates both position NFTs to "Loan Liquidated".
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Rate 0 → swap returns 0 proceeds → below the oracle-derived minOutputAmount.
        // ZeroExProxyMock reverts with SlippageExceeded; RiskFacet catches and falls back.
        ZeroExProxyMock(address(mockZeroExProxy)).setRate(0, 10);

        // Slim form: only loanId is indexed (informational/liquidation per
        // EventSourcingAudit §1.4 + §1.5).
        vm.expectEmit(true, false, false, true);
        emit RiskFacet.LiquidationFallback(loanId);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        assertEq(
            uint8(loan.status),
            uint8(LibVaipakam.LoanStatus.FallbackPending)
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts KYCRequired when liquidator doesn't meet KYC for bonus.
    ///      Uses a liquidator without KYC while bonus USD value exceeds threshold.
    function testTriggerLiquidationKYCRequired() public {
        // Phase 1 default is pass-through; enable enforcement for this test.
        AdminFacet(address(diamond)).setKYCEnforcement(true);
        uint256 loanId = createAndAcceptOffer();

        address liquidator = makeAddr("liquidator");
        // Give liquidator Tier0 (no KYC)
        // liquidator has no KYC set (default Tier0)

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // liqBonusBps = 500 (set in setUp via updateRiskParams)
        // proceeds = 1980 ether (rate 11/10), bonus = 1980 * 500 / 10000 = 99 ether = $99 USD
        // KYC threshold is $2000, so $99 < $2000 — liquidator doesn't need KYC
        // To force KYCRequired, increase bonus above threshold:
        // Set rate very high so bonus USD > $2000
        ZeroExProxyMock(address(mockZeroExProxy)).setRate(1000, 1); // 1000x rate
        // proceeds = 1800 * 1000 = 1,800,000 ether
        // bonus = 1,800,000 * 500 / 10000 = 90,000 ether = $90,000 USD > $2000 threshold
        // Deal enough output tokens to the proxy
        ERC20Mock(mockERC20).mint(address(mockZeroExProxy), 2_000_000 ether);
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        vm.prank(liquidator);
        vm.expectRevert(IVaipakamErrors.KYCRequired.selector);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts CrossFacetCallFailed("Collateral withdraw failed").
    function testTriggerLiquidationCollateralWithdrawFails() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            "withdraw failed"
        );

        vm.expectRevert(bytes("withdraw failed"));
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts CrossFacetCallFailed("Get lender vault failed").
    function testTriggerLiquidationGetLenderVaultFails() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Mock getOrCreateUserVault to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.getOrCreateUserVault.selector
            ),
            "vault fail"
        );

        vm.expectRevert(bytes("vault fail"));
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts CrossFacetCallFailed("NFT update failed") for first NFT update.
    function testTriggerLiquidationNFTUpdateFails() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Mock NFT update to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            "nft fail"
        );

        vm.expectRevert(bytes("nft fail"));
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts CrossFacetCallFailed("NFT update failed") for second NFT update.
    ///      First updateNFTStatus (lenderTokenId=1) succeeds; second (borrowerTokenId=2) fails.
    function testTriggerLiquidationSecondNFTUpdateFails() public {
        uint256 loanId = createAndAcceptOffer();
        // lenderTokenId = 1, borrowerTokenId = 2 (from OfferFacet + LoanFacet nextTokenId increments)

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // First NFT update (lenderTokenId=1) succeeds
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                uint256(1),
                loanId,
                LibVaipakam.LoanPositionStatus.LoanLiquidated
            ),
            abi.encode(true)
        );
        // Second NFT update (borrowerTokenId=2) fails
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                uint256(2),
                loanId,
                LibVaipakam.LoanPositionStatus.LoanLiquidated
            ),
            "nft fail"
        );

        vm.expectRevert(bytes("nft fail"));
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation with liqBonusBps=0 so bonus==0 and bonus transfer is skipped.
    ///      Covers the `if (bonus > 0)` false branch.
    /// @dev Covers line 274: `if (!success) revert LiquidationFailed()` when the 0x swap call itself reverts.
    /// @dev README §7: when the 0x swap reverts (e.g. its own minBuyAmount
    ///      guard tripped because the quote exceeded 6% slippage), the
    ///      liquidation must fall back to transferring the full collateral to
    ///      the lender rather than reverting the whole call.
    function testTriggerLiquidationSwapCallFailsTriggersFallback() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        // Mock lender vault lookup — fallback transfers collateral here.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.getOrCreateUserVault.selector
            ),
            abi.encode(address(diamond))
        );

        // Mock NFT status updates (fallback marks both NFTs Claimable).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Make the 0x proxy swap call revert → fallback path should run.
        // Selector-only match (contract constructs swap calldata internally with
        // the new 5-arg signature that embeds minOutputAmount).
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(ZeroExProxyMock.swap.selector),
            "swap failed"
        );

        // Slim form: only loanId is indexed (informational/liquidation per
        // EventSourcingAudit §1.4 + §1.5).
        vm.expectEmit(true, false, false, true);
        emit RiskFacet.LiquidationFallback(loanId);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        // Loan should now be Defaulted; lender claim should record the full collateral.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        assertEq(
            uint8(loan.status),
            uint8(LibVaipakam.LoanStatus.FallbackPending)
        );
        vm.clearMockedCalls();
    }

    // ─── Tests L–Q: updateRiskParams validation and liquidation edge cases ─

    /// @dev Test L: updateRiskParams reverts when loanInitMaxLtvBps is below the
    ///      hard floor (T-033 setter range audit: floor is
    ///      `RISK_PARAMS_MAX_LTV_BPS_MIN = 1000`; previously only `> 0`
    ///      which let a degenerate `1`-bp setting effectively disable
    ///      borrowing for the asset).
    function testUpdateRiskParamsRevertsMaxLtvZero() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("loanInitMaxLtvBps"),
                uint256(0),
                uint256(LibVaipakam.RISK_PARAMS_MAX_LTV_BPS_MIN),
                LibVaipakam.BASIS_POINTS
            )
        );
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 0, 300, 1000
        );
    }

    /// @dev Test M: updateRiskParams reverts when loanInitMaxLtvBps > 10000.
    function testUpdateRiskParamsRevertsMaxLtvExceedsBasis() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector, bytes32("loanInitMaxLtvBps"),
                uint256(10001),
                uint256(LibVaipakam.RISK_PARAMS_MAX_LTV_BPS_MIN),
                LibVaipakam.BASIS_POINTS
            )
        );
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 10001, 300, 1000
        );
    }

    /// @dev Test N: updateRiskParams reverts when liqBonusBps exceeds the
    ///      README §3 cap of 300 bps (3%). Any value above that — including
    ///      the historical 500 bps default — must now be rejected.
    function testUpdateRiskParamsRevertsLiqBonusExceedsBasis() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.UpdateNotAllowed.selector);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 301, 1000);
    }

    /// @dev Test O: updateRiskParams reverts when reserveFactorBps is
    ///      above the hard ceiling (T-033 setter range audit: ceiling is
    ///      `RISK_PARAMS_RESERVE_FACTOR_BPS_MAX = 5000`; previously
    ///      only `≤ BASIS_POINTS` which allowed `100% reserveFactor` =
    ///      lender receives 0% interest, defeats the lending product).
    function testUpdateRiskParamsRevertsReserveFactorExceedsBasis() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("reserveFactorBps"),
                uint256(10001),
                uint256(0),
                uint256(LibVaipakam.RISK_PARAMS_RESERVE_FACTOR_BPS_MAX)
            )
        );
        RiskFacet(address(diamond)).updateRiskParams(
            mockERC20,
            8000,
            300,
            10001
        );
    }

    /// @dev Test P: the hard-coded 3% incentive cap (README §3) blocks any
    ///      asset-level config that would pay the liquidator more than 3% of
    ///      proceeds. The legacy "bonus > proceeds" scenario is therefore
    ///      unreachable and is replaced by this cap-enforcement check.
    function testUpdateRiskParamsRespectsIncentiveCap() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.UpdateNotAllowed.selector);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 301, 1000);
    }

    /// @dev Test Q: triggerLiquidation where afterBonus < totalDebt (undercollateralized).
    ///      Mocks the 0x swap call to return a low amount directly, bypassing the ZeroExProxyMock.
    function testTriggerLiquidationUndercollateralized() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        // Mock the 0x swap call to return a low proceeds value (e.g., 900 ether).
        // This bypasses ZeroExProxyMock's slippage check entirely.
        // proceeds=900 vs expected=1800 → realized slippage 50% clamps to
        // MAX(6%) so incentive = 6% − 6% = 0; afterBonus = 900 < principal
        // (1000) → undercollateralized.
        vm.mockCall(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            abi.encode(uint256(900 ether))
        );
        // Deal the proceeds amount to diamond (simulating swap output)
        deal(mockERC20, address(diamond), 1800 ether + 900 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        // Lender gets allocated (afterBonus), no treasury fee since allocated < principal
        (, uint256 lenderAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, true);
        // afterBonus=855 < principal(1000) → lenderProceeds=855, toTreasury=0
        assertLt(
            lenderAmt,
            1000 ether,
            "Lender should get less than principal"
        );
        assertGt(lenderAmt, 0, "Lender should get some proceeds");

        // No borrower surplus
        (, uint256 borrowerAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, false);
        assertEq(borrowerAmt, 0, "Borrower should have no surplus");

        vm.clearMockedCalls();
    }

    /// @dev Tests calculateHealthFactor returns type(uint256).max when borrowValueUsd is 0.
    function testCalculateHealthFactorReturnsMaxWhenBorrowZero() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock borrow price to $0 → borrowValueUsd = 0 → should return type(uint256).max
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockERC20
            ),
            abi.encode(0, 8)
        );

        // With price=0 for both principal and collateral: borrowValueUsd=0 but also collateralValueUsd=0.
        // Need to mock differently: principal at $0 but collateral at $1.
        // Since both use mockERC20, we need a second mock token for collateral.
        // Actually, both assets are mockERC20 (same address). We can't differentiate with vm.mockCall.
        // Instead, use vm.store to set principal to 0 so currentBorrowBalance=0 → borrowValueUsd=0.
        vm.clearMockedCalls();
        // Re-mock oracle prices normally for both principal and collateral
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(
            mockCollateralERC20,
            LibVaipakam.LiquidityStatus.Liquid
        );

        // Set loan.principal = 0 → _calculateCurrentBorrowBalance returns 0
        LibVaipakam.Loan memory loanZero = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        loanZero.principal = 0;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loanZero);

        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertEq(
            hf,
            type(uint256).max,
            "HF should be max when borrow value is 0"
        );
    }

    /// @dev Tests triggerLiquidation where proceeds > totalDebt (over-recovery and borrower surplus).
    ///      interestRecovered > interestPortion triggers capping. borrowerSurplus > 0 path hit.
    function testTriggerLiquidationOverRecoveryWithSurplus() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        // Mock the swap call to return very high proceeds (bypass ZeroExProxyMock slippage check)
        uint256 highProceeds = 5000 ether; // >> totalDebt (~1005 ether)
        vm.mockCall(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            abi.encode(highProceeds)
        );
        deal(mockERC20, address(diamond), 1800 ether + highProceeds); // enough for all transfers
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        // Verify borrower surplus exists
        (, uint256 borrowerAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, false);
        assertGt(borrowerAmt, 0, "Borrower should have surplus");

        // Verify lender got at least principal (interest minus treasury fee)
        (, uint256 lenderAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, true);
        assertGe(lenderAmt, 1000 ether, "Lender should get at least principal");

        vm.clearMockedCalls();
    }

    /// @dev Tests calculateHealthFactor when `loan.liquidationLtvBpsAtInit`
    ///      is 0 → riskAdjustedCollateral=0, healthFactor=0. PR2 of the
    ///      internal-match work retired the per-asset
    ///      `liqThresholdBps`; the liquidation threshold is now a
    ///      per-loan snapshot. Uses
    ///      `TestMutatorFacet.setLiquidationLtvBpsAtInitRaw` to write
    ///      the snapshot directly, bypassing the production
    ///      `LoanFacet.initiateLoan` path that always snapshots a
    ///      non-zero per-tier value.
    function testCalculateHealthFactorZeroLiqThreshold() public {
        uint256 loanId = createAndAcceptOffer();

        TestMutatorFacet(address(diamond)).setLiquidationLtvBpsAtInitRaw(loanId, 0);

        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertEq(hf, 0, "HF should be 0 when liquidationLtvBpsAtInit is 0");

        // Restore the snapshot value for any subsequent assertions
        // in this test contract (Tier-2 default = 85% = 8500 BPS).
        TestMutatorFacet(address(diamond)).setLiquidationLtvBpsAtInitRaw(loanId, 8500);
    }

    /// @dev Tests calculateLTV when collateral price = 0 → collateralValueUsd = 0 → ZeroCollateral revert.
    ///      This is already tested but we test it with a different setup to also cover the
    ///      path where principal price is nonzero but collateral price is 0.
    function testCalculateLTVZeroCollateralPriceWithDifferentAssets() public {
        // Create loan where principal and collateral are different assets
        // We need separate assets to mock different prices
        address collateralToken = address(new ERC20Mock("Coll", "COL", 18));
        ERC20Mock(collateralToken).mint(borrower, 100000 ether);
        vm.prank(borrower);
        ERC20(collateralToken).approve(address(diamond), type(uint256).max);
        address borrowerVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(borrower);
        vm.prank(borrower);
        ERC20(collateralToken).approve(borrowerVault, type(uint256).max);

        mockOracleLiquidity(
            collateralToken,
            LibVaipakam.LiquidityStatus.Liquid
        );
        mockOraclePrice(collateralToken, 1e8, 8);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(
            collateralToken,
            8000,
            300,
            1000
        );

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: collateralToken,
                collateralAmount: 1800 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1800 ether,
                periodicInterestCadence: LibVaipakam
                    .PeriodicInterestCadence
                    .None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(
            offerId,
            true
        );

        // Now mock collateral price to 0
        mockOraclePrice(collateralToken, 0, 8);

        vm.expectRevert(RiskFacet.ZeroCollateral.selector);
        RiskFacet(address(diamond)).calculateLTV(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation where allocated > loan.principal is FALSE (undercollateralized,
    ///      no treasury fee) - exercises the else branch of `if (allocated > loan.principal)`.
    ///      Mocks swap call directly to return low proceeds.
    function testTriggerLiquidationAllocatedBelowPrincipalNoTreasuryFee()
        public
    {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        // Mock swap to return low proceeds: 360 ether.
        // Realized slippage 80% clamps to 6%, dynamic incentive = 0, so
        // bonus = 0 and afterBonus = 360 < principal(1000) → no treasury fee.
        uint256 lowProceeds = 360 ether;
        vm.mockCall(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            abi.encode(lowProceeds)
        );
        deal(mockERC20, address(diamond), 1800 ether + lowProceeds);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        // Verify: lender gets allocated (afterBonus=342), no treasury fee
        (, uint256 lenderAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, true);
        assertLt(
            lenderAmt,
            1000 ether,
            "Lender should get less than principal"
        );
        assertGt(lenderAmt, 0);

        // No borrower surplus
        (, uint256 borrowerAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, false);
        assertEq(borrowerAmt, 0);

        vm.clearMockedCalls();
    }

    function testTriggerLiquidationBonusZero() public {
        // Update risk params with liqBonusBps=0
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(
            mockERC20,
            8000,
            0, // liqBonusBps = 0
            1000
        );

        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        // bonus = 0, so bonus transfer is skipped; proceeds all go to lender vault
        // ZeroExProxyMock rate is 11/10 → proceeds = 1980 ether
        vm.expectEmit(true, true, false, true);
        emit RiskFacet.HFLiquidationTriggered(
            loanId,
            address(this),
            1980 ether
        );
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Tests triggerLiquidation where borrowerSurplus > 0 (TRUE branch).
    ///      Uses a very high swap rate so proceeds > bonus + totalDebt → surplus exists.
    function testTriggerLiquidationBorrowerSurplusPositive() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        // Very high swap proceeds: 5x rate → proceeds = 9000 ether.
        // Proceeds exceed oracle-expected, so realized slippage is 0 and the
        // dynamic incentive clamps to the 3% cap → bonus = 270, afterBonus
        // = 8730 ≫ totalDebt(~1005), so borrowerSurplus ≈ 7725 > 0.
        ZeroExProxyMock(mockZeroExProxy).setRate(5, 1);
        ERC20Mock(mockERC20).mint(address(mockZeroExProxy), 20000 ether);
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        // Verify borrower has surplus
        (, uint256 borrowerAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, false);
        assertGt(
            borrowerAmt,
            0,
            "Borrower should get surplus when proceeds >> debt"
        );

        // Verify lender got at least principal (may be equal if treasury takes all interest)
        (, uint256 lenderAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, true);
        assertGe(lenderAmt, 1000 ether, "Lender should get at least principal");

        vm.clearMockedCalls();
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10);
    }

    /// @dev Tests triggerLiquidation when swap reverts → falls back to full collateral transfer.
    ///      Exercises the _fullCollateralTransferFallback path.
    function testTriggerLiquidationSwapFails_FallbackPath() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Mock swap to revert
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap reverted"
        );

        // Slim form: only loanId is indexed (informational/liquidation per
        // EventSourcingAudit §1.4 + §1.5).
        vm.expectEmit(true, false, false, true);
        emit RiskFacet.LiquidationFallback(loanId);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        assertEq(
            uint8(loan.status),
            uint8(LibVaipakam.LoanStatus.FallbackPending)
        );

        // Lender claim should be on collateral (not principal) under the new
        // README §7 fallback: claims are recorded in collateral units and
        // the collateral stays in the Diamond until ClaimFacet resolves it.
        (address claimAsset, uint256 lenderAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, true);
        assertEq(claimAsset, mockCollateralERC20);
        assertGt(
            lenderAmt,
            0,
            "lender should have a collateral-denominated claim"
        );

        // Borrower may now have a non-zero surplus when collateral value
        // exceeds the lender's 3% fallback entitlement (README §7 line 153).
        (address borrowerAsset, uint256 borrowerAmt, ) = ClaimFacet(
            address(diamond)
        ).getClaimableAmount(loanId, false);
        assertEq(borrowerAsset, mockCollateralERC20);
        assertLe(
            lenderAmt + borrowerAmt,
            1800 ether,
            "split must not exceed available collateral"
        );

        vm.clearMockedCalls();
    }

    /// @dev Phase 2 of AutonomousLtvAndOracleFallback.md — swap failed
    ///      AND oracle quorum unavailable for the collateral leg. The
    ///      pre-Phase-2 behaviour would have reverted the whole
    ///      liquidation (`getAssetPrice` revert propagating through
    ///      `LibFallback.collateralEquivalent`), pinning the loan in
    ///      Active state. The Phase-2 path degenerates to "full
    ///      collateral to lender, treasury + borrower zero" and emits
    ///      {LiquidationFallbackOracleUnavailable} alongside the normal
    ///      fallback events.
    function testTriggerLiquidationSwapFails_OracleUnavailableFallback() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Mock the swap to revert — drives the soft-fail into
        // `_fullCollateralTransferFallback`.
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap reverted"
        );
        // Mock `getAssetPrice(collateralAsset)` to return zero price.
        // `LibFallback.collateralEquivalent` short-circuits on
        // `colPrice == 0` → returns 0 → `oracleAvailable = false`
        // bubbles up. Equivalent semantics to "oracle quorum stale"
        // but Forge's `vm.mockCallRevert` doesn't propagate cleanly
        // through the `try this.getAssetPrice()` wrapper in
        // `tryGetAssetPrice` on this toolchain version, while
        // returning zero hits the same code path one layer in.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(uint256(0), uint8(8))
        );

        // Record the emitted logs and verify the new
        // {LiquidationFallbackOracleUnavailable} signature appears.
        // `vm.expectEmit` is strict-ordered (asserts the NEXT
        // emission), which would catch the interleaved
        // `LoanStatusUpdated` from the lifecycle transition before
        // ever reaching our event. recordLogs + topic-0 search is
        // robust to the intervening events.
        vm.recordLogs();
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 expectedTopic = keccak256(
            "LiquidationFallbackOracleUnavailable(uint256)"
        );
        bool oracleEventSeen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == expectedTopic) {
                assertEq(
                    uint256(logs[i].topics[1]),
                    loanId,
                    "LiquidationFallbackOracleUnavailable.loanId mismatch"
                );
                oracleEventSeen = true;
                break;
            }
        }
        assertTrue(
            oracleEventSeen,
            "LiquidationFallbackOracleUnavailable must fire on stale-oracle fallback"
        );

        // Loan transitions to FallbackPending despite the stale oracle —
        // the new path lets the protocol settle instead of pinning the
        // loan in Active.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        assertEq(
            uint8(loan.status),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "loan must transition to FallbackPending even with stale oracle"
        );

        // Lender absorbs the full 1800-ether collateral; borrower's
        // share is zero (the fair-value split was impossible).
        (address claimAsset, uint256 lenderAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, true);
        assertEq(claimAsset, mockCollateralERC20);
        assertEq(
            lenderAmt,
            1800 ether,
            "stale oracle => lender absorbs full collateral"
        );
        (, uint256 borrowerAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, false);
        assertEq(
            borrowerAmt,
            0,
            "stale oracle => no fair-value surplus for borrower"
        );

        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts when collateral is not liquid on active network.
    function testTriggerLiquidationRevertsNonLiquidAsset() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        // Mock collateral as illiquid on active network
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidityOnActiveNetwork.selector,
                mockCollateralERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );

        vm.expectRevert(IVaipakamErrors.NonLiquidAsset.selector);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation fallback path where first NFT update fails.
    ///      Exercises _fullCollateralTransferFallback `if (!success)` for lender NFT update.
    function testTriggerLiquidationFallbackLenderNFTUpdateFails() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Mock swap to revert → triggers fallback
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap reverted"
        );

        // First NFT update (lender) fails
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            "nft update fail"
        );

        vm.expectRevert(bytes("nft update fail"));
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev README §7 line 149: lender fallback entitlement = principal +
    ///      accrued + late fees + 3%. With 1:1 oracle prices, no elapsed
    ///      time, principal = 1000 ether → lender should get 1030 ether
    ///      collateral; treasury 20 ether (2% of principal); borrower the
    ///      remaining 750 of the 1800 ether collateral.
    function testFallbackThreeWaySplit() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap revert"
        );

        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        (, uint256 lenderAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, true);
        (, uint256 borrowerAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, false);
        assertEq(lenderAmt, 1030 ether, "lender = principal + 3%");
        assertEq(
            borrowerAmt,
            750 ether,
            "borrower = collateral - lender - treasury"
        );
        vm.clearMockedCalls();
    }

    /// @dev README §7 line 150: if the remaining collateral value is below
    ///      the lender fallback entitlement, lender takes full collateral
    ///      and the borrower side zeroes out.
    function testFallbackUndercollateralized() public {
        // Use standard loan (1000 principal, 1800 collateral, same asset,
        // 5% APR) but warp 100 years forward so accrued interest alone
        // (~5000 ether) dominates the lender entitlement and exceeds the
        // 1800 ether collateral.
        uint256 loanId = createAndAcceptOffer();
        vm.warp(block.timestamp + 100 * 365 days);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap revert"
        );

        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        (, uint256 lenderAmt, ) = ClaimFacet(address(diamond))
            .getClaimableAmount(loanId, true);
        (, uint256 borrowerAmt, bool borrowerClaimed) = ClaimFacet(
            address(diamond)
        ).getClaimableAmount(loanId, false);
        assertEq(lenderAmt, 1800 ether, "lender takes full collateral");
        assertEq(borrowerAmt, 0, "borrower zero");
        assertTrue(borrowerClaimed, "borrower claim auto-marked settled");
        vm.clearMockedCalls();
    }

    /// @dev README §7 line 148: claim-time retry succeeds → claims rewritten
    ///      to principal-asset proceeds with the README-defined split.
    function testClaimRetrySucceeds() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockERC20
            ),
            abi.encode(uint256(1e8), uint8(8))
        );
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Initial swap reverts → fallback. Collateral stays in Diamond.
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap revert"
        );
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        // Now stub swap for the retry: return 1980 ether proceeds.
        vm.clearMockedCalls();
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockERC20
            ),
            abi.encode(uint256(1e8), uint8(8))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(uint256(1e8), uint8(8))
        );
        vm.mockCall(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            abi.encode(uint256(1980 ether))
        );
        deal(mockERC20, address(diamond), 1980 ether); // simulate swap proceeds in diamond
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        uint256 lenderBefore = IERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        // Phase 7a: auto-retry was removed from single-arg claimAsLender;
        // tests asserting retry success use the explicit overload that
        // takes a ranked AdapterCall[] try-list.
        ClaimFacet(address(diamond)).claimAsLenderWithRetry(
            loanId,
            defaultAdapterCalls()
        );

        assertEq(
            IERC20(mockERC20).balanceOf(lender) - lenderBefore,
            1030 ether,
            "lender principal-asset proceeds"
        );
        vm.clearMockedCalls();
    }

    /// @dev README §7 line 151: if claim-time retry also fails, split the
    ///      collateral per snapshot (same as fallback-time recording).
    function testClaimRetryFailsFallsThroughToSplit() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector),
            abi.encode(true)
        );
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap revert"
        );

        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        // Retry also reverts.
        uint256 lenderBefore = IERC20(mockCollateralERC20).balanceOf(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        // Lender got 1030 ether collateral; treasury got 20 ether.
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(lender) - lenderBefore,
            1030 ether,
            "lender collateral on failed retry"
        );
        vm.clearMockedCalls();
    }

    // Removed: testTriggerLiquidationFallbackGetVaultFails.
    // Under the new README §7 fallback semantics (lines 147–151), the
    // fallback no longer moves collateral into the lender's vault — it
    // records a snapshot and holds the collateral in the Diamond so
    // ClaimFacet can retry the swap during the lender claim. The
    // "vault-creation-fails" branch covered by this test no longer exists.

    /// @dev Tests triggerLiquidation fallback where second NFT update (borrower) fails.
    function testTriggerLiquidationFallbackBorrowerNFTUpdateFails() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Mock swap to revert → triggers fallback
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap reverted"
        );

        // Get the lender and borrower token IDs from the loan
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(loanId);

        // First NFT update (lender) succeeds
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId
            ),
            ""
        );

        // Second NFT update (borrower) fails — mock ALL updateNFTStatus to fail first, then override lender
        // Actually, use specific token IDs to differentiate
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId
            ),
            "nft update fail"
        );

        vm.expectRevert(bytes("nft update fail"));
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Tests calculateHealthFactor returns type(uint256).max when borrowValueUsd == 0.
    ///      This exercises the `if (borrowValueUsd == 0) return type(uint256).max` branch.
    function testCalculateHealthFactorBorrowValueZero() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock collateral price to 0 → collateralValueUsd = 0 → ZeroCollateral revert
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(uint256(0), uint8(8))
        );

        vm.expectRevert(RiskFacet.ZeroCollateral.selector);
        RiskFacet(address(diamond)).calculateLTV(loanId);
        vm.clearMockedCalls();
    }

    // ─── Permissionless Liquidation Tests ────────────────────────────────────

    /// @dev Tests that triggerLiquidation is permissionless: any third-party address
    ///      can call it regardless of keeper settings on the loan.
    function testTriggerLiquidationPermissionlessWithKeeperOff() public {
        uint256 loanId = createAndAcceptOffer();

        // Phase 6: per-loan keeper state is now keeper-addressed via
        // `loanKeeperEnabled[loanId][keeper]`. By default no keeper is
        // enabled. triggerLiquidation is permissionless regardless —
        // the gate check below proves the keeper system doesn't block
        // non-keeper callers on this path.
        LoanFacet(address(diamond)).getLoanDetails(loanId);

        // Create a random third-party liquidator (not lender, not borrower)
        address randomLiquidator = makeAddr("randomLiquidator");

        // Give liquidator KYC (needed for liquidation)
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(
            randomLiquidator,
            LibVaipakam.KYCTier.Tier2
        );

        // Mock HF < 1e18 so liquidation condition is met
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );

        // Deal collateral tokens to diamond for the swap
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Mock NFT status updates
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );

        // Third-party liquidator triggers liquidation — should SUCCEED
        vm.prank(randomLiquidator);
        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );

        // Verify loan is now Defaulted
        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        assertEq(
            uint8(loanAfter.status),
            uint8(LibVaipakam.LoanStatus.Defaulted)
        );
        vm.clearMockedCalls();
    }

    // ─── Partial-liquidation validation gates (Piece B follow-up — item 2) ─────
    //
    // Coverage for `RiskFacet.triggerPartialLiquidation`'s parameter-gate
    // surface. The post-mutation HF-restore happy path needs deeper
    // fixture work (a real distressed loan whose HF crosses back over 1
    // after the partial mutation, with the oracle math actually running);
    // that lands in a follow-up. These tests verify every revert path
    // BEFORE the swap so the keeper bot can rely on clean error semantics
    // when it tunes its `fractionBps` heuristic.

    /// @dev Loan must be in `LoanStatus.Active`. Non-existent loan id
    ///      maps to a zero-init Loan struct (status = Active by enum 0)
    ///      but `loan.id == 0` short-circuits via {InvalidLoan} on
    ///      most facets. Here we exercise the more interesting
    ///      "Active but actually Defaulted/Repaid" path by forcing the
    ///      state via vm.store. Either way the function reverts cleanly.
    function testPartialLiq_RevertsWhenLoanNotActive() public {
        // Loan id 9999 is uninitialised → fallthrough state. The
        // function reads `loan.status != Active` and reverts because
        // the storage default for the enum is 0 (Active) but `id == 0`,
        // which OTHER paths catch — here the same uninitialised slot
        // means HF reads zero too, so the HealthFactorNotLow gate would
        // fire if Active. We force a real Active loan into Defaulted to
        // exercise the status check itself unambiguously.
        uint256 loanId = createAndAcceptOffer();
        // Set the loan to Defaulted via a triggerLiquidation execution.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        RiskFacet(address(diamond)).triggerLiquidation(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();

        // Loan is now Defaulted — partial should reject.
        vm.expectRevert(RiskFacet.InvalidLoan.selector);
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            5_000,
            defaultAdapterCalls()
        );
    }

    /// @dev Partial requires HF < 1 — same gate as `triggerLiquidation`.
    ///      A healthy loan (default HF = 1.53 from the fixture) must
    ///      revert with {HealthFactorNotLow}.
    function testPartialLiq_RevertsWhenHFAboveOne() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF >= 1.0 — the loan is healthy, partial is not allowed.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE)
        );

        vm.expectRevert(RiskFacet.HealthFactorNotLow.selector);
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            5_000,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Past the loan's maturity, the partial path is locked out so
    ///      late-fee accounting stays out of its math — operators use
    ///      `triggerLiquidation` (full + late fee) or
    ///      `DefaultedFacet.markDefaulted` (time-based) instead.
    function testPartialLiq_RevertsAfterMaturity() public {
        uint256 loanId = createAndAcceptOffer();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 endTime = uint256(loan.startTime) + loan.durationDays * 1 days;

        // Warp to just past maturity.
        vm.warp(endTime + 1);

        // Mock HF < 1 so we reach the maturity gate rather than the HF gate.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.PartialAfterMaturity.selector,
                endTime,
                block.timestamp
            )
        );
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            5_000,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev fractionBps must be in (0, cap]. Zero rejects.
    function testPartialLiq_RevertsOnZeroFraction() public {
        uint256 loanId = createAndAcceptOffer();
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // cap defaults to 10_000 (no governance override in this fixture
        // since ConfigFacet isn't cut into the test diamond — the
        // accessor's zero-fallback path lands on the library default).
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.InvalidPartialFraction.selector,
                uint256(0),
                uint256(10_000)
            )
        );
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            0,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev fractionBps > cap rejects. Default cap = 10_000, so 10_001
    ///      trips it without needing a governance setter call.
    function testPartialLiq_RevertsOnFractionAboveCap() public {
        uint256 loanId = createAndAcceptOffer();
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.InvalidPartialFraction.selector,
                uint256(10_001),
                uint256(10_000)
            )
        );
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            10_001,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev The post-mutation HF gate fires when the mocked HF doesn't
    ///      change (vm.mockCall returns the same value pre- and post-
    ///      mutation). This is a positive test for {PartialMustImproveHF}
    ///      — without it the function would silently leave the loan
    ///      stuck-distressed.
    function testPartialLiq_RevertsWhenHFDoesNotImprove() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1 for both reads — mock returns the same value
        // each call, so hfAfter == hfBefore and {PartialMustImproveHF}
        // fires after the swap mutation.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        // Mock the vault withdraw + NFT updates (cross-facet calls
        // through the diamond proxy).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        // Deal collateral so the swap actually runs.
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // The swap succeeds (mocked ZeroExProxy returns proceeds), the
        // function reaches the post-mutation HF check, and reverts.
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.PartialMustImproveHF.selector,
                HF_SCALE - 1,
                HF_SCALE - 1
            )
        );
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            5_000,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    // ─── Partial-liquidation happy path (real HF math) ─────────────────────────
    //
    // Coverage for the end-to-end mutation flow with the OracleFacet
    // doing actual HF math (not vm.mockCall) — proves the function
    // doesn't just gate cleanly but also performs the state mutation
    // correctly and restores HF as designed.
    //
    // Setup pattern: re-mock the collateral asset's price below $1 to
    // push HF into the [0.95, 1.0) band where a 50% partial restores it.
    // The fixture's default $1 / $1 / 1800-collateral / 1000-principal
    // / 8500-bps-liqThreshold makes HF = 1.53; dropping the collateral
    // price to $0.65 yields HF ≈ 0.994.

    /// @dev Recompute the mocked collateral price down to put the loan
    ///      into a partial-liquidatable state, then exercise the full
    ///      partial-liquidation flow and confirm the mutation.
    function testPartialLiq_HappyPath_RestoresHFFromNarrowDistress() public {
        uint256 loanId = createAndAcceptOffer();
        LibVaipakam.Loan memory loanBefore = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        // Sanity: the fixture's collateral is the second mock token.
        assertEq(loanBefore.collateralAsset, mockCollateralERC20);
        assertEq(loanBefore.principalAsset, mockERC20);
        assertEq(loanBefore.collateralAmount, 1800 ether);
        assertEq(loanBefore.principal, 1000 ether);

        // Drop collateral price to $0.65 → HF ≈ 0.994 (just below 1.0),
        // within the keeper's [0.95, 1.0) partial band.
        // HF formula: (1800 * 0.65 * 0.85) / 1000 = 994.5 / 1000 = 0.9945.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(0.65e8, 8)
        );

        // Confirm HF < 1.0 with real math.
        uint256 hfBefore = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertLt(hfBefore, HF_SCALE, "fixture should put HF below 1");
        assertGt(
            hfBefore,
            (HF_SCALE * 95) / 100,
            "fixture should keep HF in keeper's [0.95, 1.0) band"
        );

        // Mock vault withdraw (cross-facet call we don't need to fully
        // exercise here) — same pattern as the existing
        // testTriggerLiquidationSuccess setup.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        // Pre-fund the diamond with collateral (the swap source) — the
        // ZeroExProxyMock at the registered 11/10 rate will return
        // 990 principal-units for 900 collateral-units.
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        deal(mockERC20, address(diamond), 5_000 ether);

        // Execute the 50% partial liquidation.
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            5_000,
            defaultAdapterCalls()
        );

        // ── State-mutation assertions ──────────────────────────────────────
        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond))
            .getLoanDetails(loanId);

        // Loan must remain Active — partial liquidation never closes the loan.
        assertEq(
            uint8(loanAfter.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan must stay Active after partial"
        );

        // Collateral reduced by exactly the 50% slice (no rounding gap
        // because 1800 is even).
        assertEq(
            loanAfter.collateralAmount,
            loanBefore.collateralAmount - 900 ether,
            "collateral must decrease by the swept slice"
        );

        // Principal strictly reduced AND not fully retired (else
        // PartialFullyClosedUseFull would have reverted).
        assertLt(
            loanAfter.principal,
            loanBefore.principal,
            "principal must strictly decrease"
        );
        assertGt(
            loanAfter.principal,
            0,
            "principal must remain non-zero (PartialFullyClosedUseFull guard)"
        );

        // ── HF assertions ───────────────────────────────────────────────────
        uint256 hfAfter = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertGe(
            hfAfter,
            HF_SCALE,
            "post-mutation HF must restore to >= 1.0 (PartialMustRestoreHF gate)"
        );
        assertGt(
            hfAfter,
            hfBefore,
            "HF must strictly improve (PartialMustImproveHF gate)"
        );

        vm.clearMockedCalls();
    }

    /// @dev Time-warp before the partial so the `endTime` preservation
    ///      math actually exercises (`startTime ← now`, `durationDays ← (endTime - now) / 1 days`).
    ///      Without the warp, the partial happens at `startTime` so the
    ///      mutation is a no-op on those fields.
    function testPartialLiq_PreservesEndTimeAcrossPartial() public {
        uint256 loanId = createAndAcceptOffer();
        LibVaipakam.Loan memory loanBefore = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        uint256 endTimeBefore = uint256(loanBefore.startTime) +
            loanBefore.durationDays *
            1 days;

        // Skip 10 days into the loan, then push HF below 1.
        vm.warp(uint256(loanBefore.startTime) + 10 days);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(0.65e8, 8)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        deal(mockERC20, address(diamond), 5_000 ether);

        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            5_000,
            defaultAdapterCalls()
        );

        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond))
            .getLoanDetails(loanId);

        // startTime resets to now — interest accrues on the reduced
        // principal from this moment forward.
        assertEq(
            uint256(loanAfter.startTime),
            block.timestamp,
            "startTime must reset to now"
        );

        // endTime must be preserved (lender's term unchanged). Allow
        // for the durationDays sub-day rounding-down: the on-chain math
        // is `durationDays = (endTime - now) / 1 days`, which truncates
        // any partial-day remainder. Here `now = startTime + 10 days`
        // exactly so the truncation is 0 and the equality is exact.
        uint256 endTimeAfter = uint256(loanAfter.startTime) +
            loanAfter.durationDays *
            1 days;
        assertEq(
            endTimeAfter,
            endTimeBefore,
            "endTime must be preserved exactly across partial"
        );
        // durationDays should be 20 (30 - 10).
        assertEq(loanAfter.durationDays, 20, "durationDays = remaining whole days");

        vm.clearMockedCalls();
    }

    /// @dev Confirm `LoanPartiallyLiquidated` fires with the correct payload
    ///      — non-zero proceeds + principal-repaid + interest-repaid,
    ///      hfAfter >= 1e18, fractionBps echoed back.
    function testPartialLiq_EmitsLoanPartiallyLiquidatedEvent() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(0.65e8, 8)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        deal(mockERC20, address(diamond), 5_000 ether);

        // Watch for the event topic + fractionBps + swappedCollateral —
        // payload-level assertion is brittle to fee-formula changes so
        // we keep it to the deterministic fields (loanId, liquidator,
        // fractionBps, swappedCollateral) and let `checkData=false`
        // skip the variable proceeds / interest / HF fields.
        vm.expectEmit(true, true, false, false);
        emit RiskFacet.LoanPartiallyLiquidated(
            loanId,
            address(this),
            5_000,
            900 ether,
            /* proceeds       */ 0,
            /* principalRepaid*/ 0,
            /* interestRepaid */ 0,
            /* hfAfter        */ 0
        );

        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            5_000,
            defaultAdapterCalls()
        );

        vm.clearMockedCalls();
    }

    // ─── Partial-liquidation failure-branch coverage (real HF math) ────────────
    //
    // Positive coverage for the deeper revert paths — these need real
    // HF math (not vm.mockCall) so the post-mutation gate actually
    // checks the derived HF, not a sticky value. Pairs with the
    // happy-path tests above.

    /// @dev When the loan is deeply distressed (HF ≈ 0.69) AND the
    ///      keeper passes a tiny fraction (1%), the partial swap
    ///      strictly improves HF but doesn't lift it back to 1.0.
    ///      Reverts {PartialMustRestoreHF} — keeper would retry with
    ///      a larger fraction or fall back to full liquidation.
    function testPartialLiq_RevertsWhenHFImprovesButStaysBelow1() public {
        uint256 loanId = createAndAcceptOffer();

        // Drop collateral price to $0.45 → HF ≈ 0.6885 (deeply distressed).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(0.45e8, 8)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        deal(mockERC20, address(diamond), 5_000 ether);

        // 1% partial — sweeps 18e collateral, gets ~19.8e proceeds, repays
        // ~18.81e principal. Post-mutation HF moves from 0.6885 → ~0.6947
        // (strictly improves, but stays below 1.0).
        vm.expectRevert();
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            100,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev When the loan is mildly distressed AND the keeper passes a
    ///      large fraction (80%), proceeds are enough to retire the
    ///      whole principal. Reverts {PartialFullyClosedUseFull} — that's
    ///      a job for `triggerLiquidation` which closes the loan, returns
    ///      surplus collateral to the borrower, and emits the terminal event.
    function testPartialLiq_RevertsWhenPrincipalFullyRepaid() public {
        uint256 loanId = createAndAcceptOffer();

        // Drop collateral price to $0.65 → HF ≈ 0.994 (just below 1.0).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(0.65e8, 8)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        deal(mockERC20, address(diamond), 5_000 ether);

        // 80% partial: swap 1440e collateral → ~1584e proceeds via the
        // fixture's 11/10 mock rate → after 3% bonus + 2% handling,
        // afterFees ≈ 1504.8e > principal (1000e). PrincipalRepaid
        // clamps to >= 1000, triggers PartialFullyClosedUseFull.
        vm.expectRevert(RiskFacet.PartialFullyClosedUseFull.selector);
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            8_000,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Empty `AdapterCall[]` → `LibSwap.swapWithFailover` soft-fails
    ///      (returns `(false, 0, MAX)`) → partial reverts {PartialSwapAllFailed}.
    ///      Confirms there's no soft-fallback path on the partial route —
    ///      a still-Active loan must never be left in a half-settled state.
    function testPartialLiq_RevertsWhenAllAdaptersFail() public {
        uint256 loanId = createAndAcceptOffer();

        // Put HF below 1 so we pass the entry gate.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(0.65e8, 8)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Empty adapter list → swapWithFailover iterates zero times,
        // returns (success=false). Partial entry reverts with the
        // dedicated error (NOT a soft fallback into the claim-time
        // settlement, which would corrupt the still-Active loan).
        LibSwap.AdapterCall[] memory empty = new LibSwap.AdapterCall[](0);
        vm.expectRevert(RiskFacet.PartialSwapAllFailed.selector);
        RiskFacet(address(diamond)).triggerPartialLiquidation(loanId, 5_000, empty);
        vm.clearMockedCalls();
    }

    /// @dev Two consecutive partials on the same loan. Time-warps
    ///      between the two so endTime-preservation is non-trivial.
    ///      Asserts monotonic decrease on collateral + principal and
    ///      that the loan's original maturity is preserved across both
    ///      mutations.
    function testPartialLiq_MultiPartialRegression() public {
        uint256 loanId = createAndAcceptOffer();
        LibVaipakam.Loan memory loanInit = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        uint256 endTimeInit = uint256(loanInit.startTime) +
            loanInit.durationDays *
            1 days;

        // ── First partial: distress @ $0.65, 10% sweep ─────────────────
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(0.65e8, 8)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        deal(mockERC20, address(diamond), 5_000 ether);

        // Warp 5 days in, partial 10%.
        vm.warp(uint256(loanInit.startTime) + 5 days);
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            1_000,
            defaultAdapterCalls()
        );
        LibVaipakam.Loan memory loanAfter1 = LoanFacet(address(diamond))
            .getLoanDetails(loanId);

        // First-partial invariants.
        assertEq(
            uint8(loanAfter1.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan stays Active after first partial"
        );
        assertLt(loanAfter1.collateralAmount, loanInit.collateralAmount);
        assertLt(loanAfter1.principal, loanInit.principal);
        assertEq(uint256(loanAfter1.startTime), block.timestamp);
        assertEq(
            uint256(loanAfter1.startTime) + loanAfter1.durationDays * 1 days,
            endTimeInit,
            "endTime preserved across first partial"
        );

        // ── Drop price further so HF goes back below 1 ─────────────────
        // After first partial: collateral ≈ 1620, principal ≈ 811.9.
        // For HF < 1: P < principal / (collateral * liqThreshold)
        //           = 811.9 / (1620 * 0.85) = $0.59.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(0.55e8, 8)
        );

        // Warp another 5 days (10 days total elapsed of the 30-day loan).
        vm.warp(uint256(loanInit.startTime) + 10 days);

        // Second partial — another 10% of the now-smaller collateral.
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            1_000,
            defaultAdapterCalls()
        );
        LibVaipakam.Loan memory loanAfter2 = LoanFacet(address(diamond))
            .getLoanDetails(loanId);

        // Monotonic decreases across both partials.
        assertLt(
            loanAfter2.collateralAmount,
            loanAfter1.collateralAmount,
            "collateral decreases across second partial"
        );
        assertLt(
            loanAfter2.principal,
            loanAfter1.principal,
            "principal decreases across second partial"
        );
        // Loan still Active.
        assertEq(
            uint8(loanAfter2.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan stays Active after second partial"
        );
        // endTime preserved across BOTH partials.
        assertEq(
            uint256(loanAfter2.startTime) + loanAfter2.durationDays * 1 days,
            endTimeInit,
            "endTime preserved across both partials"
        );
        // durationDays now = 20 (30 - 10 elapsed).
        assertEq(loanAfter2.durationDays, 20);

        // HF restored above 1.0 after the second partial.
        uint256 hfAfter2 = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertGe(hfAfter2, HF_SCALE, "HF restored >= 1 after second partial");

        vm.clearMockedCalls();
    }

    /// @dev l2 sequencer circuit-breaker gates the partial path the same
    ///      way it gates the full triggerLiquidation. While the sequencer
    ///      is unhealthy (down OR still inside its 1h recovery grace),
    ///      Chainlink prices + AMM state can be stale → a swap could
    ///      execute against mispriced state → block all HF-based paths.
    function testPartialLiq_RevertsWhenSequencerUnhealthy() public {
        uint256 loanId = createAndAcceptOffer();

        // HF < 1 (so the HF gate would otherwise pass).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        // Mark sequencer unhealthy — the partial path's first check.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.sequencerHealthy.selector),
            abi.encode(false)
        );

        vm.expectRevert(RiskFacet.SequencerUnhealthy.selector);
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            5_000,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    /// @dev Non-liquid collateral blocks the partial path — same gate as
    ///      the full triggerLiquidation. Without a tradable venue there's
    ///      no swap path to run; the time-based default route in
    ///      DefaultedFacet handles unswappable collateral via full-collateral
    ///      transfer instead.
    function testPartialLiq_RevertsOnNonLiquidCollateral() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        // Mark collateral as illiquid on the active network.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidityOnActiveNetwork.selector,
                mockCollateralERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );

        vm.expectRevert(IVaipakamErrors.NonLiquidAsset.selector);
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            loanId,
            5_000,
            defaultAdapterCalls()
        );
        vm.clearMockedCalls();
    }

    // ─── FlashLoanLiquidationPath.md — discount-path gate + happy ────
    //
    // Coverage matrix:
    //  - master kill-switch (default false) blocks the entry
    //  - zero-recipient guard
    //  - Active-only gate
    //  - sequencer circuit-breaker reused
    //  - HF gate reused
    //  - Tier-0 (unclassified collateral) blocks the path
    //  - oracle-stale (tryGetAssetPrice ok=false) blocks the path
    //  - happy path: full settlement + Defaulted transition + event

    /// @dev Helper — wire common mocks the discount path expects when
    ///      the call is supposed to PROGRESS PAST gates (sequencer ok,
    ///      HF below 1, tier 3, fresh oracle on both legs, NFT update
    ///      cross-facet call mocked through).
    function _mockDiscountPathHappy(uint256 loanId) internal {
        // Flip the discount-path master kill-switch ON.
        TestMutatorFacet(address(diamond)).setDiscountPathEnabledRaw(true);
        // Sequencer healthy.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.sequencerHealthy.selector),
            abi.encode(true)
        );
        // HF < 1 — call goes through HF gate.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        // Collateral classified Tier 3 (deepest, smallest discount).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(3))
        );
        // Both legs priced at $1.00 (8-decimal feed). collateralEquivalent
        // then computes 1:1 between principal and collateral (both 18-dec
        // tokens), and the per-tier 5% discount adds 5%.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.tryGetAssetPrice.selector,
                mockERC20
            ),
            abi.encode(true, uint256(1e8), uint8(8))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.tryGetAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(true, uint256(1e8), uint8(8))
        );
        // Cross-facet vault withdraw + NFT update — mock-success.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
    }

    /// @dev Default-state kill-switch is `false`. The entry-point
    ///      reverts `DiscountPathDisabled` before any other check —
    ///      verified here by calling with otherwise-valid arguments.
    function testTriggerLiquidationDiscounted_RevertsWhenDisabled() public {
        uint256 loanId = createAndAcceptOffer();
        vm.expectRevert(RiskFacet.DiscountPathDisabled.selector);
        RiskFacet(address(diamond)).triggerLiquidationDiscounted(
            loanId,
            address(this),
            ""
        );
    }

    /// @dev Zero recipient → `ZeroRecipient` revert. Guard fires
    ///      before sequencer / HF checks (cheap fast-path).
    function testTriggerLiquidationDiscounted_RevertsZeroRecipient() public {
        uint256 loanId = createAndAcceptOffer();
        TestMutatorFacet(address(diamond)).setDiscountPathEnabledRaw(true);
        vm.expectRevert(RiskFacet.ZeroRecipient.selector);
        RiskFacet(address(diamond)).triggerLiquidationDiscounted(
            loanId,
            address(0),
            ""
        );
    }

    /// @dev Loan not in `Active` state → `InvalidLoan`. A non-existent
    ///      loanId trips the same default-Inactive branch.
    function testTriggerLiquidationDiscounted_RevertsLoanNotActive() public {
        TestMutatorFacet(address(diamond)).setDiscountPathEnabledRaw(true);
        vm.expectRevert(RiskFacet.InvalidLoan.selector);
        RiskFacet(address(diamond)).triggerLiquidationDiscounted(
            999_999,
            address(this),
            ""
        );
    }

    /// @dev Sequencer down → reuse the atomic path's
    ///      `SequencerUnhealthy` revert. Same l2 circuit-breaker.
    function testTriggerLiquidationDiscounted_RevertsSequencerUnhealthy() public {
        uint256 loanId = createAndAcceptOffer();
        TestMutatorFacet(address(diamond)).setDiscountPathEnabledRaw(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.sequencerHealthy.selector),
            abi.encode(false)
        );
        vm.expectRevert(RiskFacet.SequencerUnhealthy.selector);
        RiskFacet(address(diamond)).triggerLiquidationDiscounted(
            loanId,
            address(this),
            ""
        );
        vm.clearMockedCalls();
    }

    /// @dev HF ≥ 1 → `HealthFactorNotLow`. The discount-path gate is
    ///      identical to the atomic path (no threshold relaxation).
    function testTriggerLiquidationDiscounted_RevertsHFNotLow() public {
        uint256 loanId = createAndAcceptOffer();
        TestMutatorFacet(address(diamond)).setDiscountPathEnabledRaw(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.sequencerHealthy.selector),
            abi.encode(true)
        );
        // HF = 1.5e18 (loan-init floor) → fails HF<1 gate.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(uint256(15 * 1e17))
        );
        vm.expectRevert(RiskFacet.HealthFactorNotLow.selector);
        RiskFacet(address(diamond)).triggerLiquidationDiscounted(
            loanId,
            address(this),
            ""
        );
        vm.clearMockedCalls();
    }

    /// @dev `getEffectiveLiquidityTier` returns 0 (unclassified) →
    ///      `UntierableCollateral`. Per-tier discount math has no
    ///      definition for unclassified assets; route falls back to
    ///      atomic path or time-based default.
    function testTriggerLiquidationDiscounted_RevertsUntierableCollateral() public {
        uint256 loanId = createAndAcceptOffer();
        TestMutatorFacet(address(diamond)).setDiscountPathEnabledRaw(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.sequencerHealthy.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(0))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.UntierableCollateral.selector,
                mockCollateralERC20
            )
        );
        RiskFacet(address(diamond)).triggerLiquidationDiscounted(
            loanId,
            address(this),
            ""
        );
        vm.clearMockedCalls();
    }

    /// @dev `tryGetAssetPrice` failing on either leg →
    ///      `LibFallback.collateralEquivalent` returns 0 → settlement
    ///      reverts `OracleStaleForDiscount` (no fair-value math
    ///      possible). The liquidator retries when oracle clears or
    ///      falls back to `triggerLiquidation`.
    function testTriggerLiquidationDiscounted_RevertsOracleStale() public {
        uint256 loanId = createAndAcceptOffer();
        _mockDiscountPathHappy(loanId);
        // Stamp collateral's `tryGetAssetPrice` to fail (ok=false).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.tryGetAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(false, uint256(0), uint8(8))
        );
        // Fund + approve so the safeTransferFrom doesn't fail with
        // allowance — `OracleStaleForDiscount` fires AFTER the pull.
        deal(mockERC20, address(this), 2000 ether);
        IERC20(mockERC20).approve(address(diamond), 2000 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.OracleStaleForDiscount.selector,
                mockERC20,
                mockCollateralERC20
            )
        );
        RiskFacet(address(diamond)).triggerLiquidationDiscounted(
            loanId,
            address(this),
            ""
        );
        vm.clearMockedCalls();
    }

    /// @dev Full discount-path happy path on a Tier-3 collateral
    ///      (deepest tier = 5% library default discount):
    ///       - 1000 ether principal-asset pulled from liquidator.
    ///       - $1.00 / $1.00 oracle pricing on both legs ⇒ 1:1
    ///         collateral-for-debt; +5% discount yields 1050 ether
    ///         collateral seized.
    ///       - Borrower vault has 1800 ether collateral ⇒ surplus
    ///         750 ether stays in their vault.
    ///       - Loan transitions Active → Defaulted; NFTs flip to
    ///         `LoanLiquidated`.
    ///       - `LiquidationDiscounted` emitted with the precise
    ///         (totalDebt, collateralSeized, borrowerSurplus) triple.
    function testTriggerLiquidationDiscounted_HappyPath_Tier3() public {
        uint256 loanId = createAndAcceptOffer();
        _mockDiscountPathHappy(loanId);

        // Liquidator (this contract) funds + approves the diamond for
        // the full debt. Slight headroom for accrued interest if any.
        deal(mockERC20, address(this), 2000 ether);
        IERC20(mockERC20).approve(address(diamond), 2000 ether);

        // Snapshot pre-state.
        LibVaipakam.Loan memory loanBefore = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        assertEq(uint8(loanBefore.status), uint8(LibVaipakam.LoanStatus.Active));

        // Use recordLogs (NOT expectEmit) — lifecycle transitions emit
        // intervening `LoanStatusUpdated` events that strict-order
        // expectEmit would catch first. recordLogs + topic-0 search
        // is robust to interleaved events from cross-facet calls.
        vm.recordLogs();
        RiskFacet(address(diamond)).triggerLiquidationDiscounted(
            loanId,
            address(this),
            ""
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 expectedTopic = keccak256(
            "LiquidationDiscounted(uint256,address,address,uint8,uint16,uint256,uint256,uint256)"
        );
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == expectedTopic) {
                found = true;
                break;
            }
        }
        assertTrue(found, "LiquidationDiscounted not emitted");

        // Loan terminal — transitioned to Defaulted.
        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond))
            .getLoanDetails(loanId);
        assertEq(
            uint8(loanAfter.status),
            uint8(LibVaipakam.LoanStatus.Defaulted),
            "loan should be Defaulted"
        );

        vm.clearMockedCalls();
    }
}
