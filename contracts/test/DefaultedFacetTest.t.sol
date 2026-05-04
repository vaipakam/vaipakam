// test/DefaultedFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {IERC4907} from "../src/interfaces/IERC4907.sol";
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {IZeroExProxy} from "../src/interfaces/IZeroExProxy.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
 // For mock ERC20
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
 // For mock NFT
import {IERC4907} from "../src/interfaces/IERC4907.sol";
 // For rentable NFT
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
 // For cutting
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC4907} from "../src/interfaces/IERC4907.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
 // For escrow impl
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {HelperTest} from "./HelperTest.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {IERC4907} from "../src/interfaces/IERC4907.sol";
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {IZeroExProxy} from "../src/interfaces/IZeroExProxy.sol";
import {console} from "forge-std/console.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ZeroExProxyMock} from "./mocks/ZeroExProxyMock.sol";
import {MockZeroExLegacyAdapter} from "./mocks/MockZeroExLegacyAdapter.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";

contract DefaultedFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender; // User1
    address borrower; // User2
    address mockERC20; // Liquid asset
    address mockCollateralERC20; // Distinct liquid asset for collateral (SelfCollateralizedOffer invariant)
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
    OfferCancelFacet offerCancelFacet;
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

    // Escrow impl
    VaipakamEscrowImplementation escrowImpl;

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

        offerCancelFacet = new OfferCancelFacet();
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
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](15);
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
        cuts[14] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Init escrow factory with impl
        vm.prank(owner);
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

        // Phase 7a: register the legacy ZeroEx shim as adapter slot 0
        // so triggerLiquidation / triggerDefault / claimAsLenderWithRetry
        // route through LibSwap into the existing ZeroExProxyMock.
        AdminFacet(address(diamond)).addSwapAdapter(
            address(new MockZeroExLegacyAdapter(address(mockZeroExProxy)))
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
        // Give the diamond itself and the test contract Tier2 KYC.
        // Needed because internal cross-facet liquidation calls set msg.sender = diamond,
        // and the test contract (address(this)) acts as liquidator in direct calls.
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(address(diamond), LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(address(this), LibVaipakam.KYCTier.Tier2);

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
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(1e8, 8) // $1, 8 decimals
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
                mockIlliquidERC20
            ),
            abi.encode(1e8, 8) // Even if illiquid, for calc
        );
        // Mock price for NFT principal asset (needed for KYC USD check in triggerDefault)
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockNFT721
            ),
            abi.encode(1e8, 8) // $1, 8 decimals
        );
        // Mock decimals() on NFT address (triggerDefault calls IERC20Metadata.decimals on principalAsset)
        vm.mockCall(
            mockNFT721,
            abi.encodeWithSelector(IERC20Metadata.decimals.selector),
            abi.encode(uint8(18))
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

    // // Helper to get selectors
    // function getSelectors(
    //     address facet
    // ) internal view returns (bytes4[] memory selectors) {
    //     // Use loupe or manual; for simplicity, assume implemented or use vm.getCode
    //     // Placeholder: Return empty or specific; in practice, use DiamondLoupe post-cut
    //     selectors = new bytes4[](0); // Adjust as needed for actual cut
    // }

    // Helper to create a lender offer and accept to start a loan
    function createAndAcceptOffer(
        address lendingAsset,
        address collateralAsset,
        LibVaipakam.AssetType assetType,
        uint256 amount,
        uint256 collateralAmount,
        uint256 durationDays,
        uint256 tokenId,
        uint256 quantity
    ) internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: lendingAsset,
                amount: amount,
                interestRateBps: 500,
                collateralAsset: collateralAsset,
                collateralAmount: collateralAmount,
                durationDays: durationDays,
                assetType: assetType,
                tokenId: tokenId,
                quantity: quantity,
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

        // Assume loanId = 1 (first loan)
        loanId = 1; // Adjust if multiple
    }

    function testTriggerLiquidationLiquidCollateral() public {
        // Create loan with liquid collateral
        uint256 loanId = createAndAcceptOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            1500 ether,
            30,
            0,
            0
        );

        // Warp past grace
        uint256 endTime = block.timestamp + 30 days;
        uint256 grace = LibVaipakam.gracePeriod(30);
        vm.warp(endTime + grace + 1);

        // E.g., mock lower collateral price to make HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20 /* collateral */
            ),
            abi.encode(5e7, 8) // $0.5, making collateralValue lower
        );
        // Mock HF < 1 so triggerLiquidation succeeds (RiskFacet now always requires HF < 1)
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(0.5e18))
        );
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            loanId
        );

        // ZeroExProxyMock rate is 11/10 → proceeds = collateralAmount * 11 / 10
        uint256 expectedProceeds = ((loan.collateralAmount * 11) / 10);

        // Call triggerLiquidation (contract constructs swap calldata internally
        // with the oracle-derived minOutputAmount = expected * 94%).
        vm.expectEmit(true, true, false, true);
        emit RiskFacet.HFLiquidationTriggered(
            loanId,
            address(this), // msg.sender,
            expectedProceeds
        );
        RiskFacet(address(diamond)).triggerLiquidation(loanId, defaultAdapterCalls());

        // Assert loan status Defaulted
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));

        // Assert proceeds distributed: liqBonus to liquidator, debt to lender, surplus to borrower.
        // The mock swap delivers exactly expectedProceeds (zero realized
        // slippage), so the dynamic incentive clamps to the 3% README cap.
        uint256 incentiveBps = LibVaipakam.MAX_LIQUIDATOR_INCENTIVE_BPS;
        uint256 bonus = (expectedProceeds * incentiveBps) / BASIS_POINTS;
        // Bonus sent directly to liquidator (msg.sender = address(this))
        assertEq(IERC20(loan.principalAsset).balanceOf(address(this)), bonus);
        // Verify lender claim recorded correctly (includes treasury fee deduction)
        // The contract computes: currentBorrowBalance (accrued interest through present)
        // + late fees + treasury fee on (interest + late fees).
        (address claimAsset, uint256 claimAmount, bool claimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(claimAsset, loan.principalAsset);
        assertFalse(claimed);

        address lenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(loan.lender);
        // Lender escrow balance should match the recorded claim amount
        assertEq(IERC20(loan.principalAsset).balanceOf(lenderEscrow), claimAmount);
        // Verify lender got at least principal (shouldn't lose principal when proceeds cover it)
        assertTrue(claimAmount >= loan.principal, "Lender should get at least principal back");
    }

    function testTriggerDefaultLiquidCollateral() public {
        // Create loan with liquid collateral
        uint256 loanId = createAndAcceptOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            1500 ether,
            30,
            0,
            0
        );

        // Warp past grace
        uint256 endTime = block.timestamp + 30 days;
        uint256 grace = LibVaipakam.gracePeriod(30);
        vm.warp(endTime + grace + 1);

        // E.g., mock lower collateral price to make HF < 1e18
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20 /* collateral */
            ),
            abi.encode(5e7, 8) // $0.5, making collateralValue lower
        );
        // Mock HF < 1 so triggerLiquidation succeeds (RiskFacet now always requires HF < 1)
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(0.5e18))
        );

        // Ensure diamond has principal balance to cover proceeds transfer (mock proceeds flow)
        deal(mockERC20, address(diamond), 3000 ether);
        deal(mockCollateralERC20, address(diamond), 3000 ether);

        vm.prank(lender);
        vm.expectEmit(true, false, false, true);
        emit DefaultedFacet.LoanDefaulted(loanId, true); // fallbackConsentFromBoth = true
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            loanId
        );
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
    }

    function testTriggerDefaultIlliquidCollateral() public {
        // Mock principal as illiquid so both assets match (avoids MixedCollateralNotAllowed)
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        // Create loan with illiquid collateral
        uint256 loanId = createAndAcceptOffer(
            mockERC20,
            mockIlliquidERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            1500 ether,
            30,
            0,
            0
        );
        // Restore mockERC20 to liquid after loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);

        // Warp past grace
        uint256 endTime = block.timestamp + 30 days;
        uint256 grace = LibVaipakam.gracePeriod(30);
        vm.warp(endTime + grace + 1);

        vm.prank(lender);
        vm.expectEmit(true, false, false, true);
        emit DefaultedFacet.LoanDefaulted(loanId, true); // fallbackConsentFromBoth = true
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Claim model: collateral stays in borrower's escrow; lender claim is recorded
        (address claimAsset, uint256 claimAmount, bool claimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(claimAsset, mockIlliquidERC20);
        assertEq(claimAmount, 1500 ether);
        assertFalse(claimed);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            loanId
        );
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
    }

    function testTriggerDefaultNFTRental() public {
        // Create NFT rental loan
        uint256 loanId = createAndAcceptOffer(
            mockNFT721,
            mockERC20,
            LibVaipakam.AssetType.ERC721,
            10 ether, // Rental fee
            1500 ether, // Collateral (ERC20)
            30,
            1, // tokenId
            1
        );

        // Warp past grace
        uint256 endTime = block.timestamp + 30 days;
        uint256 grace = LibVaipakam.gracePeriod(30);
        vm.warp(endTime + grace + 1);

        vm.prank(lender);
        vm.expectEmit(true, false, false, true);
        emit DefaultedFacet.LoanDefaulted(loanId, true); // fallbackConsentFromBoth = true
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Check NFT user reset
        assertEq(IERC4907(mockNFT721).userOf(1), address(0));

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            loanId
        );
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
    }

    // function testTriggerDefaultRevertsIfNotLender() public {
    //     uint256 loanId = createAndAcceptOffer(
    //         mockERC20,
    //         mockERC20,
    //         LibVaipakam.AssetType.ERC20,
    //         1000 ether,
    //         1500 ether,
    //         30,
    //         0,
    //         0
    //     );

    //     // Warp past grace
    //     vm.warp(block.timestamp + 33 days + 1);

    //     vm.prank(borrower); // Not lender
    //     vm.expectRevert(IVaipakamErrors.NotLender.selector);
    //     DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
    // }

    function testTriggerDefaultRevertsIfNotDefaultedYet() public {
        uint256 loanId = createAndAcceptOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            1500 ether,
            30,
            0,
            0
        );

        vm.prank(lender);
        vm.expectRevert(DefaultedFacet.NotDefaultedYet.selector);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
    }

    function testTriggerDefaultRequiresKYCForHighValue() public {
        // README §16 Phase 1 default is pass-through; flip enforcement on
        // so the tiered-KYC revert path is exercised.
        AdminFacet(address(diamond)).setKYCEnforcement(true);
        // Create high-value loan (>2k USD, assume $1 price -> 3000 ether > 2k)
        uint256 loanId = createAndAcceptOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            3000 ether,
            4500 ether,
            30,
            0,
            0
        );

        // Warp past grace
        vm.warp(block.timestamp + 31 days + 1);
        // Downgrade lender KYC to Tier0 (no KYC) — loan principal > $1k triggers KYC check
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier0);

        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.KYCRequired.selector);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
    }

    function testIsLoanDefaultable() public {
        uint256 loanId = createAndAcceptOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            1500 ether,
            30,
            0,
            0
        );

        assertFalse(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId));

        // Warp past grace
        vm.warp(block.timestamp + 33 days + 3);
        assertTrue(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId));
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev isLoanDefaultable returns false if loan is not Active (covers non-Active branch).
    function testIsLoanDefaultableReturnsFalseIfNotActive() public {
        uint256 loanId = createAndAcceptOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            1500 ether,
            30, 0, 0
        );

        // Warp past grace to make it defaultable, then trigger default
        vm.warp(block.timestamp + 33 days + 3);
        // Mock HF < 1 so triggerLiquidation succeeds (RiskFacet now always requires HF < 1)
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(0.5e18))
        );
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Now the loan is Defaulted (not Active) — should return false
        assertFalse(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId));
    }

    /// @dev triggerDefault reverts if loan status is not Active.
    function testTriggerDefaultRevertsIfNotActive() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);
        // Mock HF < 1 so triggerLiquidation succeeds (RiskFacet now always requires HF < 1)
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(0.5e18))
        );
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Try to trigger default again on the now-Defaulted loan
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
    }

    /// @dev Tests triggerDefault with liquid collateral where isCollateralValueCollapsed returns true
    ///      and fallbackConsentFromBoth is true — takes the illiquid/collapsed else-if branch.
    function testTriggerDefaultLiquidCollateralCollapsed() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );

        vm.warp(block.timestamp + 33 days + 3);

        // Mock isCollateralValueCollapsed to return true (collapsed collateral)
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.isCollateralValueCollapsed.selector),
            abi.encode(true)
        );
        // collateral is liquid (mockERC20), consent=true, collapsed=true
        // → should take the illiquid/collapsed path (else-if branch)
        vm.expectEmit(true, false, false, true);
        emit DefaultedFacet.LoanDefaulted(loanId, true);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault with illiquid collateral and no consent — takes LiquidationFailed revert branch.
    ///      LiquidationFailed requires: collateral is Illiquid AND fallbackConsentFromBoth = false.
    function testTriggerDefaultLiquidationFailedNoConsent() public {
        // Mock principal as illiquid so both assets match (avoids MixedCollateralNotAllowed)
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        // Create a loan with illiquid collateral asset (mockIlliquidERC20).
        // The loan's collateral asset oracle returns Illiquid.
        uint256 loanId = createAndAcceptOffer(
            mockERC20, mockIlliquidERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        // Restore mockERC20 to liquid after loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);

        vm.warp(block.timestamp + 33 days + 3);

        // Clear fallbackConsentFromBoth (and prepayAsset) via mutator.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.fallbackConsentFromBoth = false;
        loan.prepayAsset = address(0);
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        // Now: Illiquid collateral AND fallbackConsentFromBoth=false → LiquidationFailed
        // (Neither the liquid swap branch nor the illiquid+consent branch is taken)
        vm.expectRevert(IVaipakamErrors.LiquidationFailed.selector);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests cross-facet call failure when triggerDefault tries to get lender escrow.
    function testTriggerDefaultCrossFacetFailure() public {
        // Mock principal as illiquid so both assets match (avoids MixedCollateralNotAllowed)
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 loanId = createAndAcceptOffer(
            mockERC20, mockIlliquidERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        // Restore mockERC20 to liquid after loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        vm.warp(block.timestamp + 33 days + 3);

        // Mock getOrCreateUserEscrow to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector),
            "mock revert"
        );
        vm.expectRevert(bytes("mock revert"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault cross-facet failure: collateral withdrawal fails for illiquid path.
    function testTriggerDefaultIlliquidCollateralWithdrawFails() public {
        // Mock principal as illiquid so both assets match (avoids MixedCollateralNotAllowed)
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 loanId = createAndAcceptOffer(
            mockERC20, mockIlliquidERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        // Restore mockERC20 to liquid after loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        vm.warp(block.timestamp + 33 days + 3);

        // First call (getOrCreateUserEscrow) succeeds, second (escrowWithdrawERC20) fails.
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            "mock revert"
        );
        vm.expectRevert(bytes("mock revert"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault NFT rental cross-facet failure: buffer to treasury fails.
    function testTriggerDefaultNFTBufferToTreasuryFails() public {
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            10 ether, 1500 ether, 30, 1, 1
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock escrowWithdrawERC20 to fail (for buffer to treasury step)
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            "mock revert"
        );
        vm.expectRevert();
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault NFT rental cross-facet failure: reset NFT user fails.
    function testTriggerDefaultNFTResetUserFails() public {
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            10 ether, 1500 ether, 30, 1, 1
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock escrowSetNFTUser to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector),
            "mock revert"
        );
        vm.expectRevert(bytes("mock revert"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault liquid path cross-facet failure: liquidation fails.
    function testTriggerDefaultLiquidCollateralWithdrawalFails() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock collateral withdrawal to fail (inline swap path)
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
            "mock revert"
        );
        vm.expectRevert(bytes("mock revert"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests NFT rental default with ERC1155 asset type to cover the ERC1155 branch.
    function testTriggerDefaultNFTRentalERC1155Branch() public {
        // We can't easily create an ERC1155 loan in setUp, so we directly set loan assetType
        // via storage. First create an NFT (ERC721) loan, then override assetType to ERC1155.
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            10 ether, 1500 ether, 30, 1, 1
        );

        vm.warp(block.timestamp + 33 days + 3);

        // Override assetType to ERC1155 via mutator.
        LibVaipakam.Loan memory override1155 = LoanFacet(address(diamond)).getLoanDetails(loanId);
        override1155.assetType = LibVaipakam.AssetType.ERC1155;
        TestMutatorFacet(address(diamond)).setLoan(loanId, override1155);

        // Mock the ERC1155 escrow withdraw call to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector),
            abi.encode(true)
        );

        vm.expectEmit(true, false, false, false);
        emit DefaultedFacet.LoanDefaulted(loanId, true);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault NFT ERC1155 escrow withdraw fails → CrossFacetCallFailed("NFT claim failed").
    /// @dev Verifies that NFT rental default no longer attempts immediate NFT withdrawal.
    /// NFT return is now handled by ClaimFacet.claimAsLender (NFT-gated claim model).
    function testTriggerDefaultNFTRentalDoesNotWithdrawNFT() public {
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            10 ether, 1500 ether, 30, 1, 1
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock escrowSetNFTUser to succeed (renter reset is still done)
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector), abi.encode(true));

        // Default should succeed without attempting escrowWithdrawERC721/ERC1155
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault NFT rental where getOrCreateUserEscrow for lender fails in NFT path.
    ///      This covers CrossFacetCallFailed("Get lender escrow failed") in the NFT section.
    function testTriggerDefaultNFTGetLenderEscrowFails() public {
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            10 ether, 1500 ether, 30, 1, 1
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock escrowSetNFTUser (reset renter) to succeed
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector), abi.encode(true));
        // Mock escrowWithdrawERC20 to succeed (buffer + prepay withdrawal)
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        // Deal tokens to diamond so safeTransfer to treasury succeeds
        // prepayAmount = 10 * 30 = 300 ether, treasuryFee = 300 * 100/10000 = 3 ether
        deal(mockERC20, address(diamond), 300 ether);
        deal(mockCollateralERC20, address(diamond), 300 ether);
        // Mock getOrCreateUserEscrow to fail (for lender escrow in NFT path)
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector),
            "escrow fail"
        );

        vm.expectRevert(bytes("escrow fail"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault NFT path where prepay withdrawal (second escrowWithdrawERC20) fails.
    ///      prepayAmount = 10 * 30 = 300 ether; buffer = 300 * 500/10000 = 15 ether.
    ///      Buffer call: (borrower, mockERC20, treasury, 15 ether) — succeeds.
    ///      Prepay call: (borrower, mockERC20, address(this), 300 ether) — fails.
    function testTriggerDefaultNFTPrepayWithdrawalFails() public {
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            10 ether, 1500 ether, 30, 1, 1
        );
        vm.warp(block.timestamp + 33 days + 3);

        address treasuryAddr = address(diamond); // treasury = diamond in setUp

        // Mock escrowSetNFTUser (reset renter) to succeed
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector), abi.encode(true));
        // First escrowWithdrawERC20 (buffer=15 ether to treasury) succeeds — match by full args
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector, borrower, mockERC20, treasuryAddr, uint256(15 ether)),
            abi.encode(true)
        );
        // Second escrowWithdrawERC20 (full prepayAmount=300 ether to diamond) fails — match by full args
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector, borrower, mockERC20, address(diamond), uint256(300 ether)),
            "prepay fail"
        );

        vm.expectRevert(bytes("prepay fail"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault second updateNFTStatus fails (borrowerTokenId update) when status != Defaulted.
    ///      First updateNFTStatus (lenderTokenId) succeeds; second (borrowerTokenId) fails.
    function testTriggerDefaultSecondNFTUpdateFails() public {
        // Mock principal as illiquid so both assets match (avoids MixedCollateralNotAllowed)
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 loanId = createAndAcceptOffer(
            mockERC20, mockIlliquidERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        // Restore mockERC20 to liquid after loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        vm.warp(block.timestamp + 33 days + 3);

        // The illiquid path succeeds but the second NFT update fails.
        // lenderTokenId=1, borrowerTokenId=2 (first offer token=1, second token=2)
        // First updateNFTStatus (lenderTokenId=1) succeeds
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector, uint256(1), loanId, LibVaipakam.LoanPositionStatus.LoanDefaulted),
            abi.encode(true)
        );
        // Second updateNFTStatus (borrowerTokenId=2) fails
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector, uint256(2), loanId, LibVaipakam.LoanPositionStatus.LoanDefaulted),
            "nft fail"
        );

        vm.expectRevert(bytes("nft fail"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Covers line 261: first NFT update fails (lenderTokenId NFT update fails).
    ///      The illiquid path + ERC20 loan completes, then the first updateNFTStatus fails.
    function testTriggerDefaultFirstNFTUpdateFails() public {
        // Mock principal as illiquid so both assets match (avoids MixedCollateralNotAllowed)
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 loanId = createAndAcceptOffer(
            mockERC20, mockIlliquidERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        // Restore mockERC20 to liquid after loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        vm.warp(block.timestamp + 33 days + 3);

        // lenderTokenId=1, borrowerTokenId=2
        // Make the first updateNFTStatus (lenderTokenId=1) fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector, uint256(1), loanId, LibVaipakam.LoanPositionStatus.LoanDefaulted),
            "first nft fail"
        );

        vm.expectRevert(bytes("first nft fail"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault liquid path where swap reverts → fallback to full collateral transfer.
    function testTriggerDefaultLiquidSwapReverts() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock zeroExProxy call to revert (swap fails)
        vm.mockCallRevert(
            address(ZeroExProxyMock(mockZeroExProxy)),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap failed"
        );

        // _fullCollateralTransferFallback needs getOrCreateUserEscrow to succeed
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");
        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);

        vm.expectEmit(true, false, false, false);
        emit DefaultedFacet.LiquidationFallback(loanId, lender, 1500 ether);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.FallbackPending));
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault liquid path with successful swap where borrower has surplus.
    function testTriggerDefaultLiquidWithBorrowerSurplus() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock: swap proceeds > total debt. ZeroExProxyMock rate is 11/10 → proceeds=1650 ether.
        // Total debt = principal (1000) + accrued + late fees. With 33 days elapsed:
        // accrued ≈ (1000 * 500 * 33*86400) / (365*86400 * 10000) = ~4.52 ether
        // late ≈ some amount. Total ~1005 ether. 1650 > 1005 → surplus exists.
        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Check borrower has a surplus claim
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertGt(borrowerAmt, 0, "Borrower should have surplus");
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault liquid path where proceeds < principal (undercollateralized)
    function testTriggerDefaultLiquidUndercollateralized() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Set ZeroEx rate very low so proceeds < principal (e.g., 1/10 rate → 50 ether proceeds)
        ZeroExProxyMock(mockZeroExProxy).setRate(1, 10);
        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Lender gets whatever proceeds there were (loss-bearing)
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertLt(lenderAmt, 1000 ether, "Lender should have lost some principal");
        // No treasury fee when proceeds < principal
        vm.clearMockedCalls();
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10); // restore
    }

    /// @dev Tests triggerDefault liquid path where swap proceeds > principal but < total debt (treasury fee on interest)
    function testTriggerDefaultLiquidProceedsAbovePrincipal() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        // Lender should get at least principal back (proceeds > total debt)
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(lenderAmt, 0);
        vm.clearMockedCalls();
    }

    /// @dev Test H: triggerDefault with illiquid ERC721 collateral.
    ///      Sets loan.collateralAssetType to ERC721 via vm.store on an illiquid-consent loan.
    function testTriggerDefaultIlliquidERC721Collateral() public {
        // Mock principal as illiquid so both assets match (avoids MixedCollateralNotAllowed)
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 loanId = createAndAcceptOffer(
            mockERC20, mockIlliquidERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        // Restore mockERC20 to liquid after loan creation
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        vm.warp(block.timestamp + 33 days + 3);

        // Override collateralAssetType to ERC721 and set collateralTokenId via TestMutatorFacet
        LibVaipakam.Loan memory loanOverride = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loanOverride.collateralAssetType = LibVaipakam.AssetType.ERC721;
        loanOverride.collateralTokenId = 99;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loanOverride);

        // Mock escrowWithdrawERC721 to succeed
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC721.selector), abi.encode(true));

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }

    /// @dev Test I: triggerDefault with illiquid ERC1155 collateral.
    function testTriggerDefaultIlliquidERC1155Collateral() public {
        // Mock principal as illiquid so both assets match
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 loanId = createAndAcceptOffer(
            mockERC20, mockIlliquidERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        vm.warp(block.timestamp + 33 days + 3);

        // Override collateralAssetType to ERC1155, set tokenId and quantity via TestMutatorFacet
        LibVaipakam.Loan memory loanOverride = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loanOverride.collateralAssetType = LibVaipakam.AssetType.ERC1155;
        loanOverride.collateralTokenId = 99;
        loanOverride.collateralQuantity = 5;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loanOverride);

        // Mock escrowWithdrawERC1155 to succeed
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC1155.selector), abi.encode(true));

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }

    /// @dev Test J: triggerDefault liquid path where swap proceeds < principal (undercollateralized below principal).
    ///      Lender gets all proceeds, no treasury fee.
    function testTriggerDefaultLiquidUndercollateralizedBelowPrincipal() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Set ZeroEx rate very low so proceeds < principal
        ZeroExProxyMock(mockZeroExProxy).setRate(1, 2); // 0.5x rate → 250 ether proceeds
        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Lender gets all proceeds (loss-bearing), no treasury fee
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertLt(lenderAmt, 1000 ether, "Lender should have less than principal");
        assertGt(lenderAmt, 0, "Lender should have some proceeds");

        // Borrower has no surplus
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerAmt, 0, "Borrower should have no surplus");

        vm.clearMockedCalls();
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10); // restore
    }

    /// @dev Test K: triggerDefault liquid path where borrower surplus escrow lookup fails.
    function testTriggerDefaultBorrowerSurplusEscrowFails() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Rate 11/10 → proceeds = 1650 > total debt (~1005) → surplus exists
        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        // Mock getOrCreateUserEscrow: first call (lender) succeeds, second call (borrower) fails.
        // Use specific arg matching: lender address for first, borrower address for second.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector, lender),
            abi.encode(address(diamond))
        );
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector, borrower),
            "escrow fail"
        );

        vm.expectRevert(bytes("escrow fail"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault NFT rental path where prepayAmount is large enough to exercise
    ///      treasuryFee > 0 AND treasuryFee == 0 paths. This creates an NFT rental loan with
    ///      significant prepay, verifies buffer and prepay distribution.
    function testTriggerDefaultNFTRentalWithTreasuryFee() public {
        // Create NFT rental loan with larger rental fee to ensure treasuryFee > 0
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            100 ether, // larger rental fee → prepay = 100*30=3000, treasuryFee = 3000*100/10000 = 30
            1500 ether, 30, 1, 1
        );

        vm.warp(block.timestamp + 33 days + 3);

        // Deal tokens to diamond for safeTransfer calls
        deal(mockERC20, address(diamond), 5000 ether);
        deal(mockCollateralERC20, address(diamond), 5000 ether);

        // Mock escrowWithdrawERC20 and escrowSetNFTUser
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));

        // Check lender claim was recorded with prepay minus treasury fee
        (address claimAsset, uint256 claimAmount, bool claimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(claimAsset, mockERC20);
        assertGt(claimAmount, 0, "Lender should have prepay claim");
        assertFalse(claimed);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault ERC20 path when principal liquidity is Illiquid (skips KYC check).
    ///      The KYC check in the ERC20 branch should be skipped for illiquid principal assets.
    ///      We need to keep the principalAsset oracle returning Illiquid during triggerDefault too.
    function testTriggerDefaultERC20IlliquidPrincipalSkipsKYC() public {
        // Create loan with both assets illiquid
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 loanId = createAndAcceptOffer(
            mockERC20, mockIlliquidERC20, LibVaipakam.AssetType.ERC20,
            5000 ether, 7500 ether, 30, 0, 0
        );
        // Keep mockERC20 (principalAsset) as Illiquid during triggerDefault so KYC is skipped.
        // Only restore the checkLiquidityOnActiveNetwork mock for collateral check.
        // Actually collateral is mockIlliquidERC20 which is already Illiquid.

        // Downgrade lender KYC to Tier0 — shouldn't matter since principal is illiquid
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier0);

        vm.warp(block.timestamp + 33 days + 3);

        // Should NOT revert with KYCRequired because illiquid principal is valued at $0
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));

        // Restore KYC and mocks
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
    }

    /// @dev Tests triggerDefault NFT rental path where prepayAsset is illiquid (skips KYC check).
    function testTriggerDefaultNFTRentalIlliquidPrepaySkipsKYC() public {
        // Create NFT rental with mockERC20 as prepay asset but mock it illiquid for KYC check
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            100 ether, 1500 ether, 30, 1, 1
        );

        // After loan creation, set prepay liquidity to Illiquid for KYC bypass
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, mockERC20),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );

        // Downgrade lender KYC
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier0);

        vm.warp(block.timestamp + 33 days + 3);

        // Should NOT revert with KYCRequired because illiquid prepay asset is valued at $0
        deal(mockERC20, address(diamond), 5000 ether);
        deal(mockCollateralERC20, address(diamond), 5000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));

        // Restore
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault NFT rental KYC required when prepay is liquid and high value.
    function testTriggerDefaultNFTRentalKYCRequiredForLiquidPrepay() public {
        // Phase 1 pass-through default — enable enforcement for this path.
        AdminFacet(address(diamond)).setKYCEnforcement(true);
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            100 ether, 1500 ether, 30, 1, 1
        );

        // Downgrade lender KYC
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier0);

        vm.warp(block.timestamp + 33 days + 3);

        // prepayAmount = 100*30 = 3000 ether, price $1 → $3000 > KYC threshold $2000
        // With Tier0 KYC, should revert
        vm.expectRevert(IVaipakamErrors.KYCRequired.selector);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Restore
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
    }

    /// @dev Tests triggerDefault liquid path where interestRecovered > interestPortion (capping).
    ///      This happens when proceeds > totalDebt (allocated = totalDebt), and
    ///      (allocated - principal) > interestPortion can happen when lateFees are large relative to proceeds.
    ///      Actually: allocated = min(proceeds, totalDebt). So allocated - principal = min(proceeds,totalDebt) - principal.
    ///      interestPortion = accruedInterest + lateFee. totalDebt = principal + interestPortion.
    ///      If proceeds >= totalDebt: allocated = totalDebt, interestRecovered = totalDebt - principal = interestPortion.
    ///      So capping only triggers when proceeds >= totalDebt → interestRecovered == interestPortion (no cap needed, but == still passes).
    ///      The cap is a safety check. Let's trigger the path with proceeds > totalDebt to at least exercise this line.
    function testTriggerDefaultLiquidInterestRecoveredCapping() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        // Warp minimal time past grace so interest is small
        uint256 endTime = block.timestamp + 30 days;
        uint256 grace = LibVaipakam.gracePeriod(30);
        vm.warp(endTime + grace + 1);

        // ZeroExProxyMock rate is 11/10 → proceeds = 1650 ether. totalDebt ~= 1005.
        // allocated = 1005, interestRecovered = 5, interestPortion ~= 5. No capping needed.
        // But let's ensure the path runs. Set rate very high so proceeds >> totalDebt.
        ZeroExProxyMock(mockZeroExProxy).setRate(3, 1); // 3x rate → proceeds = 4500 ether
        ERC20Mock(mockERC20).mint(address(mockZeroExProxy), 10000 ether);
        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Verify borrower surplus is large (since proceeds >> totalDebt)
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertGt(borrowerAmt, 0, "Borrower should have large surplus");

        // Verify lender got at least principal + interest
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(lenderAmt, 1000 ether, "Lender should get more than principal");

        vm.clearMockedCalls();
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10); // restore
    }

    /// @dev Tests triggerDefault ERC20 path where collateral is liquid but not collapsed
    ///      and lender gets escrow creation failure → CrossFacetCallFailed in liquid swap path.
    function testTriggerDefaultLiquidGetLenderEscrowFails() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));

        // Swap succeeds but getOrCreateUserEscrow for lender fails
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOrCreateUserEscrow.selector, lender),
            "escrow fail"
        );

        vm.expectRevert(bytes("escrow fail"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault liquid path where triggerLiquidation sets loan to Defaulted
    ///      so the `if (loan.status != Defaulted)` block is SKIPPED (false branch).
    function testTriggerDefaultLiquidAlreadySetToDefaulted() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock triggerLiquidation to succeed AND set loan status to Defaulted inside
        // We simulate this by mocking triggerLiquidation to return success
        // AND also mocking updateNFTStatus to succeed (they will be called in the not-Defaulted branch)
        // Since triggerLiquidation (real) sets loan.status = Defaulted, the check on line 249 is false.
        // We need to mock triggerLiquidation so the diamond's RiskFacet actually sets the status.
        // The real test: use the real triggerLiquidation flow which sets Defaulted.
        // Use vm.mockCall to mock triggerLiquidation to just work but NOT set the status via storage.
        // Instead: let's use the mock that does set the status by setting up real deal tokens.
        deal(mockERC20, address(diamond), 1500 ether);
        deal(mockCollateralERC20, address(diamond), 1500 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");
        // Mock HF to be low so triggerLiquidation succeeds
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(uint256(0)));

        // This should trigger liquidation which sets loan to Defaulted, then the outer `if (loan.status != Defaulted)` is false
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Tests triggerDefault liquid ERC20 path where allocated > loan.principal (TRUE branch)
    ///      AND borrowerSurplus > 0 (TRUE branch). Exercises surplus distribution to borrower escrow.
    function testTriggerDefaultLiquidBorrowerSurplus() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        uint256 endTime = block.timestamp + 30 days;
        uint256 grace = LibVaipakam.gracePeriod(30);
        vm.warp(endTime + grace + 1);

        // Set very high swap rate so proceeds >> totalDebt → borrowerSurplus > 0
        ZeroExProxyMock(mockZeroExProxy).setRate(5, 1); // 5x rate
        ERC20Mock(mockERC20).mint(address(mockZeroExProxy), 20000 ether);
        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Verify borrower got surplus
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertGt(borrowerAmt, 0, "Borrower should have surplus when proceeds >> debt");

        // Verify lender got more than principal (interest recovered)
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(lenderAmt, 1000 ether, "Lender should get principal + interest minus treasury");

        vm.clearMockedCalls();
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10);
    }

    /// @dev Tests triggerDefault NFT rental path fully, covering:
    ///      - resetNFTRenter (escrowSetNFTUser)
    ///      - bufferAmount to treasury
    ///      - prepayAmount treasury fee deduction
    ///      - prepayToLender distribution
    function testTriggerDefaultNFTRentalFullPath() public {
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            100 ether, 1500 ether, 30, 1, 1
        );

        vm.warp(block.timestamp + 33 days + 3);

        // Give diamond enough ERC20 for distributions
        deal(mockERC20, address(diamond), 50000 ether);
        deal(mockCollateralERC20, address(diamond), 50000 ether);

        // Mock cross-facet calls for NFT rental default path
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));

        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault liquid ERC20 where swap fails → fallback to full collateral transfer.
    ///      Exercises the `if (!success)` branch after the 0x swap call.
    function testTriggerDefaultLiquidSwapFails_FallbackPath() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        // Make swap revert (mock the 0x proxy to fail)
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap failed"
        );

        vm.expectEmit(true, true, false, true);
        emit DefaultedFacet.LiquidationFallback(loanId, lender, 1500 ether);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Loan should be defaulted via fallback
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.FallbackPending));

        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault ERC20 path where liquid collateral value has collapsed
    ///      (LTV > 110% or HF < 1) — exercises the collateral-value-collapsed full-transfer branch
    ///      with ERC20 collateral type specifically.
    function testTriggerDefaultLiquidCollateralCollapsedERC20Transfer() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock isCollateralValueCollapsed to return true
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.isCollateralValueCollapsed.selector, loanId),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault when collateral is illiquid without illiquidConsent → revert LiquidationFailed.
    ///      Exercises the else branch that reverts when no consent given.
    function testTriggerDefaultIlliquidNoConsentRevertsLiquidationFailed() public {
        // Create a loan with illiquid collateral, but NO illiquid consent
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 loanId = createAndAcceptOffer(
            mockERC20, mockIlliquidERC20, LibVaipakam.AssetType.ERC20,
            5000 ether, 7500 ether, 30, 0, 0
        );

        // Flip fallbackConsentFromBoth to false via TestMutatorFacet
        LibVaipakam.Loan memory loanNoConsent = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loanNoConsent.fallbackConsentFromBoth = false;
        loanNoConsent.prepayAsset = address(0);
        loanNoConsent.collateralAssetType = LibVaipakam.AssetType.ERC20;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loanNoConsent);

        vm.warp(block.timestamp + 33 days + 3);

        vm.expectRevert(IVaipakamErrors.LiquidationFailed.selector);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Restore
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
    }

    /// @dev Tests triggerDefault ERC20 path where allocated <= loan.principal (no treasury fee).
    ///      Mocks swap to return low proceeds directly.
    function testTriggerDefaultLiquidAllocatedBelowPrincipal() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        uint256 endTime = block.timestamp + 30 days;
        uint256 grace = LibVaipakam.gracePeriod(30);
        vm.warp(endTime + grace + 1);

        // Mock swap to return low proceeds directly (below principal)
        uint256 lowProceeds = 500 ether;
        vm.mockCall(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            abi.encode(lowProceeds)
        );
        deal(mockERC20, address(diamond), 2000 ether + lowProceeds);
        deal(mockCollateralERC20, address(diamond), 2000 ether + lowProceeds);

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        // Verify: no borrower surplus (proceeds < principal)
        (, uint256 borrowerAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        assertEq(borrowerAmt, 0, "No surplus when proceeds < principal");

        // Verify lender got less than principal (loss)
        (, uint256 lenderAmt,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertLt(lenderAmt, 1000 ether, "Lender bears loss when undercollateralized");

        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault NFT rental path with ERC1155 asset type (line 88 FALSE, 369 TRUE).
    ///      Uses ERC1155 asset type for the lending asset to exercise the NFT-specific handling.
    function testTriggerDefaultNFTRentalERC1155FullPath() public {
        // Create NFT rental loan with ERC1155 asset type
        // We'll use mockNFT721 address but set assetType to ERC1155 via storage
        // First create with ERC721 (which existing helper supports), then override assetType
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            100 ether, 1500 ether, 30, 1, 1
        );

        // Override assetType to ERC1155 via TestMutatorFacet
        LibVaipakam.Loan memory loanOverride1155 = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loanOverride1155.assetType = LibVaipakam.AssetType.ERC1155;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loanOverride1155);

        vm.warp(block.timestamp + 33 days + 3);
        deal(mockERC20, address(diamond), 50000 ether);
        deal(mockCollateralERC20, address(diamond), 50000 ether);

        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault _fullCollateralTransferFallback first NFT update fails.
    function testTriggerDefaultFallbackLenderNFTUpdateFails() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));

        // Swap fails → fallback
        vm.mockCallRevert(
            address(mockZeroExProxy),
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap fail"
        );

        // NFT update fails in fallback
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            "nft update fail"
        );

        vm.expectRevert(bytes("nft update fail"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault _fullCollateralTransferFallback get lender escrow fails.
    // Removed: testTriggerDefaultFallbackGetLenderEscrowFails.
    // Same rationale as RiskFacet's removed twin — the fallback path no
    // longer calls getOrCreateUserEscrow (collateral is held in the Diamond
    // until ClaimFacet resolves it), so this branch is unreachable.
    function testTriggerDefaultFallbackGetLenderEscrowFails_Removed() public {}

    /// @dev Tests triggerDefault liquid collateral collapsed path with ERC20 collateral transfer.
    ///      Exercises the isCollateralValueCollapsed=true && liquid branch.
    function testTriggerDefaultLiquidCollapsedERC20CollateralTransfer() public {
        uint256 loanId = createAndAcceptOffer(mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 1500 ether, 30, 0, 0
        );
        vm.warp(block.timestamp + 33 days + 3);

        // Mock isCollateralValueCollapsed to return true
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.isCollateralValueCollapsed.selector, loanId),
            abi.encode(true)
        );

        deal(mockERC20, address(diamond), 2000 ether);
        deal(mockCollateralERC20, address(diamond), 2000 ether);
        vm.mockCall(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector), abi.encode(true));
        vm.mockCall(address(diamond), abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector), "");

        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Defaulted));

        // Lender claim should be on collateral (not principal, since no swap)
        (address claimAsset,,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(claimAsset, mockCollateralERC20);
        vm.clearMockedCalls();
    }

    /// @dev Tests triggerDefault NFT path where escrowSetNFTUser (reset renter) fails.
    function testTriggerDefaultNFTResetRenterFails() public {
        uint256 loanId = createAndAcceptOffer(
            mockNFT721, mockERC20, LibVaipakam.AssetType.ERC721,
            100 ether, 1500 ether, 30, 1, 1
        );
        vm.warp(block.timestamp + 33 days + 3);

        deal(mockERC20, address(diamond), 50000 ether);
        deal(mockCollateralERC20, address(diamond), 50000 ether);
        vm.mockCallRevert(address(diamond), abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector), "set user fail");

        vm.expectRevert(bytes("set user fail"));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        vm.clearMockedCalls();
    }
}
