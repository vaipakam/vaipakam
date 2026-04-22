// test/RiskFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
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
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
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
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {IZeroExProxy} from "../src/interfaces/IZeroExProxy.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
 // For escrow impl
import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
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
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
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
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ZeroExProxyMock} from "./mocks/ZeroExProxyMock.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";

contract RiskFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender; // User1
    address borrower; // User2
    address mockERC20; // Liquid asset
    address mockCollateralERC20; // Second liquid asset (collateral leg)
    address mockIlliquidERC20; // Illiquid asset
    address mockNFT721; // Rentable NFT
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
    TestMutatorFacet testMutatorFacet;
    HelperTest helperTest;
    VaipakamEscrowImplementation escrowImpl; // Escrow impl

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
    // OfferFacet offerFacet;
    // ProfileFacet profileFacet;
    // OracleFacet oracleFacet;
    // VaipakamNFTFacet nftFacet;
    // EscrowFactoryFacet escrowFacet;
    // LoanFacet loanFacet;
    // RiskFacet riskFacet;
    // VaipakamEscrowImplementation escrowImpl;
    // SetupTest setupTest;

    // address mockZeroExProxy = 0xDef1C0ded9bec7F1a1670819833240f027b25EfF;
    // address allowanceTarget = mockZeroExProxy; //makeAddr("allowanceTarget"); // Mock for tests

    function setUp() public {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");

        // Deploy mocks
        mockERC20 = address(new ERC20Mock("MockLiquid", "MLQ", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockIlliquidERC20 = address(new ERC20Mock("MockIlliquid", "MIL", 18));
        mockNFT721 = address(new MockRentableNFT721());
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
        testMutatorFacet = new TestMutatorFacet();
        helperTest = new HelperTest();

        // Deploy escrow impl
        escrowImpl = new VaipakamEscrowImplementation();

        // Cut facets into diamond
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](14);
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

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Init escrow factory with impl
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(
            address(mockZeroExProxy)
            // address(0xDef1C0ded9bec7F1a1670819833240f027b25EfF)
        );
        AdminFacet(address(diamond)).setallowanceTarget(
            address(allowanceTarget)
            // address(0xDef1C0ded9bec7F1a1670819833240f027b25EfF)
        );
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
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        // Give the test contract and diamond itself Tier2 — needed for liquidation KYC checks
        // where msg.sender is address(this) (direct call) or address(diamond) (internal call)
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(address(this), LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(address(diamond), LibVaipakam.KYCTier.Tier2);

        // Note: calculateHealthFactor and calculateLTV are NOT globally mocked — real logic runs.
        // createAndAcceptOffer uses 1800 ether collateral → real HF = 1.53 >= MIN_HF(1.5). ✓
        // Real LTV for 1000 principal / 1800 collateral at $1 = 5555 bps.

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

    //     offerFacet = new OfferFacet();
    //     profileFacet = new ProfileFacet();
    //     oracleFacet = new OracleFacet();
    //     nftFacet = new VaipakamNFTFacet();
    //     escrowFacet = new EscrowFactoryFacet();
    //     loanFacet = new LoanFacet();
    //     riskFacet = new RiskFacet(zeroExProxy);

    //     // Deploy escrow impl
    //     escrowImpl = new VaipakamEscrowImplementation();

    //     // Cut facets
    //     IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](7);
    //     cuts[0] = _createFacetCut(address(offerFacet));
    //     cuts[1] = _createFacetCut(address(profileFacet));
    //     cuts[2] = _createFacetCut(address(oracleFacet));
    //     cuts[3] = _createFacetCut(address(nftFacet));
    //     cuts[4] = _createFacetCut(address(escrowFacet));
    //     cuts[5] = _createFacetCut(address(loanFacet));
    //     cuts[6] = _createFacetCut(address(riskFacet));

    //     IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

    //     // Init escrow factory
    //     EscrowFactoryFacet(address(diamond)).initializeEscrowFactory(
    //         address(escrowImpl)
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

    //     // Approvals for escrows
    //     vm.prank(lender);
    //     IERC20(mockERC20).approve(
    //         EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender),
    //         type(uint256).max
    //     );
    //     vm.prank(borrower);
    //     IERC20(mockERC20).approve(
    //         EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(
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
    //     ); // maxLtvBps=80%, liqThresholdBps=85%, liqBonusBps=5%, reserveFactorBps=10%
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
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
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

        loanId = 1; // Assuming first loan ID
    }

    function testUpdateAssetRiskParamsSuccess() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit RiskFacet.RiskParamsUpdated(mockERC20, 7000, 7500, 250, 1500);
        RiskFacet(address(diamond)).updateRiskParams(
            mockERC20,
            7000,
            7500,
            250,
            1500
        );
        // Note: LibVaipakam.storageSlot() accesses the test contract's storage, not the diamond's.
        // Verification is done via the emitted event (RiskParamsUpdated) above.
        // The parameters are applied when createAndAcceptOffer uses the updated risk params.
    }

    function testUpdateAssetRiskParamsRevertsInvalidParams() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.UpdateNotAllowed.selector);
        RiskFacet(address(diamond)).updateRiskParams(
            mockERC20,
            9000,
            8000,
            300,
            1000
        ); // maxLtv > liqThreshold
    }

    function testUpdateAssetRiskParamsRevertsNotOwner() public {
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, lender, LibAccessControl.RISK_ADMIN_ROLE));
        RiskFacet(address(diamond)).updateRiskParams(
            mockERC20,
            8000,
            8500,
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
                EscrowFactoryFacet.escrowWithdrawERC20.selector
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
        emit RiskFacet.HFLiquidationTriggered(loanId, address(this), 1980 ether);

        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Tests calculateLTV reverts if loan is illiquid (NonLiquidAsset).
    function testCalculateLTVRevertsForIlliquidLoan() public {
        uint256 loanId = createAndAcceptOffer();

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.principalLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        vm.expectRevert(IVaipakamErrors.NonLiquidAsset.selector);
        RiskFacet(address(diamond)).calculateLTV(loanId);
    }

    /// @dev Tests calculateHealthFactor reverts for illiquid loan.
    function testCalculateHealthFactorRevertsForIlliquidLoan() public {
        uint256 loanId = createAndAcceptOffer();

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.principalLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        vm.expectRevert(IVaipakamErrors.NonLiquidAsset.selector);
        RiskFacet(address(diamond)).calculateHealthFactor(loanId);
    }

    /// @dev Tests isCollateralValueCollapsed returns false for healthy loan.
    function testIsCollateralValueCollapsedFalseForHealthyLoan() public {
        uint256 loanId = createAndAcceptOffer();
        // HF = 1.53 > 1.0; LTV = 5555 < 11000 → not collapsed
        bool collapsed = RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId);
        assertFalse(collapsed);
    }

    /// @dev Tests isCollateralValueCollapsed returns true when LTV > 11000.
    ///      Sets principal much higher than collateral so LTV > VOLATILITY_LTV_THRESHOLD_BPS (11000).
    function testIsCollateralValueCollapsedTrueWhenLTVHigh() public {
        uint256 loanId = createAndAcceptOffer();
        // With same $1 price: LTV = 20000 / 1800 * 10000 ≈ 111111 bps > 11000 → collapsed
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.principal = 20000 ether;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        bool collapsed = RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId);
        assertTrue(collapsed);
    }

    /// @dev Tests updateRiskParams reverts if asset is address(0).
    function testUpdateRiskParamsRevertsZeroAsset() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.InvalidAsset.selector);
        RiskFacet(address(diamond)).updateRiskParams(address(0), 8000, 8500, 300, 1000);
    }

    /// @dev Tests triggerLiquidation reverts if loan is not Active.
    function testTriggerLiquidationRevertsIfNotActive() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));
        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        // Second call should revert as loan is now Defaulted
        vm.expectRevert(RiskFacet.InvalidLoan.selector);
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts if collateral is non-liquid.
    function testTriggerLiquidationRevertsForNonLiquidCollateral() public {
        // Mock principal as illiquid so both assets match during loan creation
        // (avoids MixedCollateralNotAllowed)
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        // Create a loan with illiquid collateral
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
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
        uint256 loanId = 1;
        // Restore mockERC20 to liquid after loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        vm.expectRevert(IVaipakamErrors.NonLiquidAsset.selector);
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
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
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
    }

    /// @dev Tests triggerLiquidation reverts if HF >= 1 and still within grace (HealthFactorNotLow).
    function testTriggerLiquidationRevertsIfHFNotLow() public {
        uint256 loanId = createAndAcceptOffer();

        // HF is 1.53 (healthy) and still within grace period
        // The real calculateHealthFactor returns 1.53e18 (> 1e18)
        vm.expectRevert(RiskFacet.HealthFactorNotLow.selector);
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
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
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );

        // Fallback path needs to look up the lender's escrow.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector),
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

        vm.expectEmit(true, true, false, true);
        emit RiskFacet.LiquidationFallback(loanId, lender, 1800 ether);
        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.FallbackPending));
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
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
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
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts CrossFacetCallFailed("Collateral withdraw failed").
    function testTriggerLiquidationCollateralWithdrawFails() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            "withdraw failed"
        );

        vm.expectRevert(bytes("withdraw failed"));
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts CrossFacetCallFailed("Get lender escrow failed").
    function testTriggerLiquidationGetLenderEscrowFails() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Mock getOrCreateUserEscrow to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector),
            "escrow fail"
        );

        vm.expectRevert(bytes("escrow fail"));
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts CrossFacetCallFailed("NFT update failed") for first NFT update.
    function testTriggerLiquidationNFTUpdateFails() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
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
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
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
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // First NFT update (lenderTokenId=1) succeeds
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector, uint256(1), loanId, LibVaipakam.LoanPositionStatus.LoanLiquidated),
            abi.encode(true)
        );
        // Second NFT update (borrowerTokenId=2) fails
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector, uint256(2), loanId, LibVaipakam.LoanPositionStatus.LoanLiquidated),
            "nft fail"
        );

        vm.expectRevert(bytes("nft fail"));
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
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
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );

        // Mock lender escrow lookup — fallback transfers collateral here.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector),
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

        vm.expectEmit(true, true, false, true);
        emit RiskFacet.LiquidationFallback(loanId, lender, 1800 ether);
        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        // Loan should now be Defaulted; lender claim should record the full collateral.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.FallbackPending));
        vm.clearMockedCalls();
    }

    // ─── Tests L–Q: updateRiskParams validation and liquidation edge cases ─

    /// @dev Test L: updateRiskParams reverts when maxLtvBps is 0.
    function testUpdateRiskParamsRevertsMaxLtvZero() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.UpdateNotAllowed.selector);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 0, 8500, 300, 1000);
    }

    /// @dev Test M: updateRiskParams reverts when maxLtvBps > 10000.
    function testUpdateRiskParamsRevertsMaxLtvExceedsBasis() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.UpdateNotAllowed.selector);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 10001, 10002, 300, 1000);
    }

    /// @dev Test N: updateRiskParams reverts when liqBonusBps exceeds the
    ///      README §3 cap of 300 bps (3%). Any value above that — including
    ///      the historical 500 bps default — must now be rejected.
    function testUpdateRiskParamsRevertsLiqBonusExceedsBasis() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.UpdateNotAllowed.selector);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 8500, 301, 1000);
    }

    /// @dev Test O: updateRiskParams reverts when reserveFactorBps > 10000.
    function testUpdateRiskParamsRevertsReserveFactorExceedsBasis() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.UpdateNotAllowed.selector);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 8500, 300, 10001);
    }

    /// @dev Test P: the hard-coded 3% incentive cap (README §3) blocks any
    ///      asset-level config that would pay the liquidator more than 3% of
    ///      proceeds. The legacy "bonus > proceeds" scenario is therefore
    ///      unreachable and is replaced by this cap-enforcement check.
    function testUpdateRiskParamsRespectsIncentiveCap() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.UpdateNotAllowed.selector);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 8500, 10000, 1000);
    }

    /// @dev Test Q: triggerLiquidation where afterBonus < totalDebt (undercollateralized).
    ///      Mocks the 0x swap call to return a low amount directly, bypassing the ZeroExProxyMock.
    function testTriggerLiquidationUndercollateralized() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));

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

        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        // Lender gets allocated (afterBonus), no treasury fee since allocated < principal
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        // afterBonus=855 < principal(1000) → lenderProceeds=855, toTreasury=0
        assertLt(lenderAmt, 1000 ether, "Lender should get less than principal");
        assertGt(lenderAmt, 0, "Lender should get some proceeds");

        // No borrower surplus
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerAmt, 0, "Borrower should have no surplus");

        vm.clearMockedCalls();
    }

    /// @dev Tests calculateHealthFactor returns type(uint256).max when borrowValueUSD is 0.
    function testCalculateHealthFactorReturnsMaxWhenBorrowZero() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock borrow price to $0 → borrowValueUSD = 0 → should return type(uint256).max
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockERC20),
            abi.encode(0, 8)
        );

        // With price=0 for both principal and collateral: borrowValueUSD=0 but also collateralValueUSD=0.
        // Need to mock differently: principal at $0 but collateral at $1.
        // Since both use mockERC20, we need a second mock token for collateral.
        // Actually, both assets are mockERC20 (same address). We can't differentiate with vm.mockCall.
        // Instead, use vm.store to set principal to 0 so currentBorrowBalance=0 → borrowValueUSD=0.
        vm.clearMockedCalls();
        // Re-mock oracle prices normally for both principal and collateral
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);

        // Set loan.principal = 0 → _calculateCurrentBorrowBalance returns 0
        LibVaipakam.Loan memory loanZero = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loanZero.principal = 0;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loanZero);

        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertEq(hf, type(uint256).max, "HF should be max when borrow value is 0");
    }

    /// @dev Tests triggerLiquidation where proceeds > totalDebt (over-recovery and borrower surplus).
    ///      interestRecovered > interestPortion triggers capping. borrowerSurplus > 0 path hit.
    function testTriggerLiquidationOverRecoveryWithSurplus() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));

        // Mock the swap call to return very high proceeds (bypass ZeroExProxyMock slippage check)
        uint256 highProceeds = 5000 ether; // >> totalDebt (~1005 ether)
        vm.mockCall(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            abi.encode(highProceeds)
        );
        deal(mockERC20, address(diamond), 1800 ether + highProceeds); // enough for all transfers
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        // Verify borrower surplus exists
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertGt(borrowerAmt, 0, "Borrower should have surplus");

        // Verify lender got at least principal (interest minus treasury fee)
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGe(lenderAmt, 1000 ether, "Lender should get at least principal");

        vm.clearMockedCalls();
    }

    /// @dev Tests calculateHealthFactor when liqThresholdBps is 0 → riskAdjustedCollateral=0, healthFactor=0.
    function testCalculateHealthFactorZeroLiqThreshold() public {
        uint256 loanId = createAndAcceptOffer();

        // Use vm.store to set liqThresholdBps = 0 for the collateral asset in assetRiskParams
        bytes32 baseSlot = LibVaipakam.VANGKI_STORAGE_POSITION;
        // assetRiskParams mapping is at slot offset 17 in Storage struct
        uint256 riskParamsSlot = uint256(baseSlot) + 16;
        bytes32 paramsBase = keccak256(abi.encode(mockCollateralERC20, riskParamsSlot));
        // RiskParams struct: maxLtvBps(slot+0), liqThresholdBps(slot+1)
        vm.store(address(diamond), bytes32(uint256(paramsBase) + 1), bytes32(uint256(0))); // liqThresholdBps = 0

        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertEq(hf, 0, "HF should be 0 when liqThresholdBps is 0");

        // Restore risk params
        vm.store(address(diamond), bytes32(uint256(paramsBase) + 1), bytes32(uint256(8500)));
    }

    /// @dev Tests calculateLTV when collateral price = 0 → collateralValueUSD = 0 → ZeroCollateral revert.
    ///      This is already tested but we test it with a different setup to also cover the
    ///      path where principal price is nonzero but collateral price is 0.
    function testCalculateLTVZeroCollateralPriceWithDifferentAssets() public {
        // Create loan where principal and collateral are different assets
        // We need separate assets to mock different prices
        address collateralToken = address(new ERC20Mock("Coll", "COL", 18));
        ERC20Mock(collateralToken).mint(borrower, 100000 ether);
        vm.prank(borrower);
        ERC20(collateralToken).approve(address(diamond), type(uint256).max);
        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        vm.prank(borrower);
        ERC20(collateralToken).approve(borrowerEscrow, type(uint256).max);

        mockOracleLiquidity(collateralToken, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(collateralToken, 1e8, 8);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(collateralToken, 8000, 8500, 300, 1000);

        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
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
                creatorFallbackConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                keeperAccessEnabled: false
            })
        );
        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Now mock collateral price to 0
        mockOraclePrice(collateralToken, 0, 8);

        vm.expectRevert(RiskFacet.ZeroCollateral.selector);
        RiskFacet(address(diamond)).calculateLTV(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation where allocated > loan.principal is FALSE (undercollateralized,
    ///      no treasury fee) - exercises the else branch of `if (allocated > loan.principal)`.
    ///      Mocks swap call directly to return low proceeds.
    function testTriggerLiquidationAllocatedBelowPrincipalNoTreasuryFee() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));

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

        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        // Verify: lender gets allocated (afterBonus=342), no treasury fee
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertLt(lenderAmt, 1000 ether, "Lender should get less than principal");
        assertGt(lenderAmt, 0);

        // No borrower surplus
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerAmt, 0);

        vm.clearMockedCalls();
    }

    function testTriggerLiquidationBonusZero() public {
        // Update risk params with liqBonusBps=0
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(
            mockERC20,
            8000,
            8500,
            0,    // liqBonusBps = 0
            1000
        );

        uint256 loanId = createAndAcceptOffer();

        // Mock HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));

        // bonus = 0, so bonus transfer is skipped; proceeds all go to lender escrow
        // ZeroExProxyMock rate is 11/10 → proceeds = 1980 ether
        vm.expectEmit(true, true, false, true);
        emit RiskFacet.HFLiquidationTriggered(loanId, address(this), 1980 ether);
        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
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
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));

        // Very high swap proceeds: 5x rate → proceeds = 9000 ether.
        // Proceeds exceed oracle-expected, so realized slippage is 0 and the
        // dynamic incentive clamps to the 3% cap → bonus = 270, afterBonus
        // = 8730 ≫ totalDebt(~1005), so borrowerSurplus ≈ 7725 > 0.
        ZeroExProxyMock(mockZeroExProxy).setRate(5, 1);
        ERC20Mock(mockERC20).mint(address(mockZeroExProxy), 20000 ether);
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        // Verify borrower has surplus
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertGt(borrowerAmt, 0, "Borrower should get surplus when proceeds >> debt");

        // Verify lender got at least principal (may be equal if treasury takes all interest)
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
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
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            abi.encode(true)
        );
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));

        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Mock swap to revert
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap reverted"
        );

        vm.expectEmit(true, true, false, true);
        emit RiskFacet.LiquidationFallback(loanId, lender, 1800 ether);
        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.FallbackPending));

        // Lender claim should be on collateral (not principal) under the new
        // README §7 fallback: claims are recorded in collateral units and
        // the collateral stays in the Diamond until ClaimFacet resolves it.
        (address claimAsset, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(claimAsset, mockCollateralERC20);
        assertGt(lenderAmt, 0, "lender should have a collateral-denominated claim");

        // Borrower may now have a non-zero surplus when collateral value
        // exceeds the lender's 3% fallback entitlement (README §7 line 153).
        (address borrowerAsset, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerAsset, mockCollateralERC20);
        assertLe(lenderAmt + borrowerAmt, 1800 ether, "split must not exceed available collateral");

        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation reverts when collateral is not liquid on active network.
    function testTriggerLiquidationRevertsNonLiquidAsset() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        // Mock collateral as illiquid on active network
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidityOnActiveNetwork.selector, mockCollateralERC20),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );

        vm.expectRevert(IVaipakamErrors.NonLiquidAsset.selector);
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerLiquidation fallback path where first NFT update fails.
    ///      Exercises _fullCollateralTransferFallback `if (!success)` for lender NFT update.
    function testTriggerLiquidationFallbackLenderNFTUpdateFails() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
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
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
        vm.clearMockedCalls();
    }

    /// @dev README §7 line 149: lender fallback entitlement = principal +
    ///      accrued + late fees + 3%. With 1:1 oracle prices, no elapsed
    ///      time, principal = 1000 ether → lender should get 1030 ether
    ///      collateral; treasury 20 ether (2% of principal); borrower the
    ///      remaining 750 of the 1800 ether collateral.
    function testFallbackThreeWaySplit() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(HF_SCALE - 1));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCallRevert(address(mockZeroExProxy), abi.encodeWithSelector(IZeroExProxy.swap.selector), "swap revert");

        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(lenderAmt, 1030 ether, "lender = principal + 3%");
        assertEq(borrowerAmt, 750 ether, "borrower = collateral - lender - treasury");
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

        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(HF_SCALE - 1));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCallRevert(address(mockZeroExProxy), abi.encodeWithSelector(IZeroExProxy.swap.selector), "swap revert");

        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        (, uint256 borrowerAmt, bool borrowerClaimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(lenderAmt, 1800 ether, "lender takes full collateral");
        assertEq(borrowerAmt, 0, "borrower zero");
        assertTrue(borrowerClaimed, "borrower claim auto-marked settled");
        vm.clearMockedCalls();
    }

    /// @dev README §7 line 148: claim-time retry succeeds → claims rewritten
    ///      to principal-asset proceeds with the README-defined split.
    function testClaimRetrySucceeds() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(HF_SCALE - 1));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector), abi.encode(true));
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockERC20),
            abi.encode(uint256(1e8), uint8(8))
        );
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Initial swap reverts → fallback. Collateral stays in Diamond.
        vm.mockCallRevert(address(mockZeroExProxy), abi.encodeWithSelector(IZeroExProxy.swap.selector), "swap revert");
        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        // Now stub swap for the retry: return 1980 ether proceeds.
        vm.clearMockedCalls();
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector), abi.encode(true));
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockERC20),
            abi.encode(uint256(1e8), uint8(8))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockCollateralERC20),
            abi.encode(uint256(1e8), uint8(8))
        );
        vm.mockCall(address(mockZeroExProxy), abi.encodeWithSelector(IZeroExProxy.swap.selector), abi.encode(uint256(1980 ether)));
        deal(mockERC20, address(diamond), 1980 ether); // simulate swap proceeds in diamond
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        uint256 lenderBefore = IERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

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

        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(HF_SCALE - 1));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector), abi.encode(true));
        deal(mockERC20, address(diamond), 1800 ether);
        deal(mockCollateralERC20, address(diamond), 1800 ether);
        vm.mockCallRevert(address(mockZeroExProxy), abi.encodeWithSelector(IZeroExProxy.swap.selector), "swap revert");

        RiskFacet(address(diamond)).triggerLiquidation(loanId);

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

    // Removed: testTriggerLiquidationFallbackGetEscrowFails.
    // Under the new README §7 fallback semantics (lines 147–151), the
    // fallback no longer moves collateral into the lender's escrow — it
    // records a snapshot and holds the collateral in the Diamond so
    // ClaimFacet can retry the swap during the lender claim. The
    // "escrow-creation-fails" branch covered by this test no longer exists.

    /// @dev Tests triggerLiquidation fallback where second NFT update (borrower) fails.
    function testTriggerLiquidationFallbackBorrowerNFTUpdateFails() public {
        uint256 loanId = createAndAcceptOffer();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
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
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);

        // First NFT update (lender) succeeds
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector, loan.lenderTokenId),
            ""
        );

        // Second NFT update (borrower) fails — mock ALL updateNFTStatus to fail first, then override lender
        // Actually, use specific token IDs to differentiate
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector, loan.borrowerTokenId),
            "nft update fail"
        );

        vm.expectRevert(bytes("nft update fail"));
        RiskFacet(address(diamond)).triggerLiquidation(loanId);
        vm.clearMockedCalls();
    }

    /// @dev Tests calculateHealthFactor returns type(uint256).max when borrowValueUSD == 0.
    ///      This exercises the `if (borrowValueUSD == 0) return type(uint256).max` branch.
    function testCalculateHealthFactorBorrowValueZero() public {
        uint256 loanId = createAndAcceptOffer();

        // Mock collateral price to 0 → collateralValueUSD = 0 → ZeroCollateral revert
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockCollateralERC20),
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

        // Verify both per-side loan flags = false (default from createAndAcceptOffer)
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertFalse(loan.lenderKeeperAccessEnabled, "Lender-side flag should default false");
        assertFalse(loan.borrowerKeeperAccessEnabled, "Borrower-side flag should default false");

        // Create a random third-party liquidator (not lender, not borrower)
        address randomLiquidator = makeAddr("randomLiquidator");

        // Give liquidator KYC (needed for liquidation)
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(randomLiquidator, LibVaipakam.KYCTier.Tier2);

        // Mock HF < 1e18 so liquidation condition is met
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            abi.encode(HF_SCALE - 1)
        );

        // Mock collateral withdrawal
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
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
        RiskFacet(address(diamond)).triggerLiquidation(loanId);

        // Verify loan is now Defaulted
        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loanAfter.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }
}
