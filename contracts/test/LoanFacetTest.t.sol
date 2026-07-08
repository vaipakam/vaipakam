// test/LoanFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
 // Added for HF/LTV mocks
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
 // For mock ERC20
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
 // For mock NFT
 // For rentable NFT
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
 // For cutting
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
 // For vault impl
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
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
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";

contract LoanFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender; // User1
    uint256 lenderPk; // #662 — acceptor key (lender accepts Borrower offers)
    address borrower; // User2
    uint256 borrowerPk; // #662 — acceptor key (borrower accepts Lender offers)
    address mockERC20; // Liquid asset
    address mockCollateralERC20; // Second liquid asset (collateral leg)
    address mockIlliquidERC20; // Illiquid asset
    address mockIlliquidCollateralERC20; // Second illiquid asset for collateral leg (SelfCollateralizedOffer invariant)
    address mockNft721; // Rentable NFT
    uint256 constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 constant BASIS_POINTS = 10000;
    uint256 constant RENTAL_BUFFER_BPS = 500;
    uint256 constant MIN_HEALTH_FACTOR = 150 * 1e16; // 1.5 scaled

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
    RiskFacet riskFacet; // Added
    AccessControlFacet accessControlFacet;
    TestMutatorFacet testMutatorFacet;
    HelperTest helperTest;

    // Vault impl
    VaipakamVaultImplementation vaultImpl;

    function setUp() public {
        owner = address(this);
        (lender, lenderPk) = makeAddrAndKey("lender");
        (borrower, borrowerPk) = makeAddrAndKey("borrower");

        // Deploy mocks
        mockERC20 = address(new ERC20Mock("MockLiquid", "MLQ", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockIlliquidERC20 = address(new ERC20Mock("MockIlliquid", "MIL", 18));
        mockIlliquidCollateralERC20 = address(new ERC20Mock("MockIlliquidCol", "MIC", 18));
        mockNft721 = address(new MockRentableNFT721());

        // Mint some assets
        ERC20Mock(mockERC20).mint(lender, 10000 ether);
        ERC20Mock(mockERC20).mint(borrower, 10000 ether);
        ERC20Mock(mockCollateralERC20).mint(lender, 10000 ether);
        ERC20Mock(mockCollateralERC20).mint(borrower, 10000 ether);
        ERC20Mock(mockIlliquidERC20).mint(lender, 10000 ether);
        ERC20Mock(mockIlliquidERC20).mint(borrower, 10000 ether);
        ERC20Mock(mockIlliquidCollateralERC20).mint(lender, 10000 ether);
        ERC20Mock(mockIlliquidCollateralERC20).mint(borrower, 10000 ether);
        MockRentableNFT721(mockNft721).mint(lender, 1);

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
        riskFacet = new RiskFacet(); // Added
        accessControlFacet = new AccessControlFacet();
        testMutatorFacet = new TestMutatorFacet();
        helperTest = new HelperTest();

        // Deploy vault impl
        vaultImpl = new VaipakamVaultImplementation();

        // Cut facets into diamond
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](14);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(offerCreateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferCreateFacetSelectors() // .getOfferCreateFacetSelectors()
        });
        cuts[12] = IDiamondCut.FacetCut({
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
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[8] = IDiamondCut.FacetCut({
            facetAddress: address(testMutatorFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getTestMutatorFacetSelectors()
        });
        cuts[9] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});
        // ConfigFacet — needed by the depth-tiered-LTV init-gate integration
        // tests below (flip `depthTieredLtvEnabled`). Adding it to the cut
        // is safe for the rest of the suite: ConfigFacet selectors live in
        // a disjoint namespace from the other facets here.
        cuts[10] = IDiamondCut.FacetCut({
            facetAddress: address(new ConfigFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getConfigFacetSelectors()
        });

        cuts[11] = IDiamondCut.FacetCut({facetAddress: address(new RiskMatchLiquidationFacet()), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()});
        // #602 — EncumbranceMutateFacet. The offer-create path
        // (`OfferCreateFacet._pullCreatorAssetsClassic`, Lender+ERC20 branch)
        // cross-calls `EncumbranceMutateFacet.createOfferPrincipalLien` (the
        // #566/#407 offer-principal lock), and the loan lifecycle calls its
        // sibling lien mutators. Without this cut every offer-create here
        // reverts `FunctionDoesNotExist`, which broke the whole suite.
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(new EncumbranceMutateFacet()), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getEncumbranceMutateFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        // Diamond born paused (LibPausable). Clear via direct
        // storage write since this fixture doesn't cut AdminFacet.
        vm.store(address(diamond), bytes32(uint256(0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400)), bytes32(0));
        TestMutatorFacet(address(diamond)).setTreasuryAddress(address(diamond));

        // Init vault factory with impl
        vm.prank(owner);
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();

        // Mock approvals
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        ERC20(mockIlliquidERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockIlliquidERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        ERC20(mockIlliquidCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20(mockIlliquidCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        MockRentableNFT721(mockNft721).approve(address(diamond), 1);

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

        // // Mock oracle: Set liquid for mockERC20, illiquid for others
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
                OracleFacet.checkLiquidity.selector,
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
                OracleFacet.checkLiquidity.selector,
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
        ERC20(mockIlliquidCollateralERC20).approve(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender),
            type(uint256).max
        );
        vm.prank(borrower);
        ERC20(mockIlliquidCollateralERC20).approve(
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

    // // Helper to get selectors (placeholder; in practice, implement or use loupe)
    // function getSelectors(
    //     address facet
    // ) internal view returns (bytes4[] memory selectors) {
    //     selectors = new bytes4[](0); // Adjust as needed
    // }

    // Helper to create offer
    function createOffer(
        address lendingAsset,
        address collateralAsset,
        LibVaipakam.AssetType assetType,
        uint256 amount,
        uint256 collateralAmount,
        uint256 durationDays,
        uint256 tokenId,
        uint256 quantity
    ) internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
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
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: amount,
                interestRateBpsMax: 500,
                collateralAmountMax: collateralAmount,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    function testInitiateLoanSuccessful() public {
        // #998 S15: collateral bumped 1500→2000 ether to clear the new
        // create-time collateral floor (~1875 ether for a 1000-ether liquid
        // ERC-20 lender offer); 2000*0.85/1000 = 1.7 still clears the 1.5 HF
        // init gate at accept.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );

        // vm.prank(owner);
        // // deal(mockERC20, user2, 1000 ether);
        // deal(mockERC20, lender, 10000000 * 1e18);
        // deal(mockERC20, borrower, 10000 * 1e18);
        // // mockOraclePrice(mockERC20, 1e6, 6); // Low price to < $2k
        // // Mock Oracle: Liquid for ERC20, Illiquid for NFT
        // mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        // mockOracleLiquidity(mockNft721, LibVaipakam.LiquidityStatus.Illiquid);
        // mockOraclePrice(mockERC20, 1e8, 8); // $1 price, 8 decimals

        // #662 — build + sign the typed AcceptTerms BEFORE expectEmit so the
        // helper's diamond view-calls don't get matched against the emit.
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectEmit(true, true, true, true);
        // Enriched event carries principal + collateralAmount so indexers
        // can render a loan card without a follow-up getLoanDetails read.
        emit LoanFacet.LoanInitiated(
            1,
            offerId,
            lender,
            borrower,
            1000 ether,
            2000 ether
        );
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(
            offerId,
            _t,
            _sig
        );

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            loanId
        );
        assertEq(loan.principal, 1000 ether);
        assertEq(loan.lender, lender);
        assertEq(loan.borrower, borrower);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    function testInitiateLoanRevertsLowHF() public {
        // Mock low HF
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(1e18 - 1) // < 1.5e18
        );

        // #998 S15: 2000 ether clears the create-time collateral floor so the
        // offer is created; the mocked low calculateHealthFactor (not consulted
        // by the create bound) still trips the loan-init HF gate at acceptOffer.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );

        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(); // IVaipakamErrors.HealthFactorTooLow.selector
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, _t, _sig);
    }

    function testInitiateLoanRevertsHighLTV() public {
        // Mock high LTV > loanInitMaxLtvBps (8000)
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(8001)
        );

        // #998 S15: 2000 ether clears the create-time collateral floor so the
        // offer is created; the mocked high calculateLTV (not consulted by the
        // create bound) still trips the loan-init LTV gate at acceptOffer.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );

        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(); // IVaipakamErrors.LTVExceeded.selector
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, _t, _sig);
    }

    function testInitiateLoanRevertsIlliquidAssetAndNoConsent() public {
        uint256 offerId = createOffer(
            mockERC20,
            mockIlliquidERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            1500 ether,
            30,
            0,
            0
        );

        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, false, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(IVaipakamErrors.RiskAndTermsConsentRequired.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, _t, _sig);
    }

    function testInitiateLoanForNFT() public {
        uint256 offerId = createOffer(
            mockNft721,
            mockERC20,
            LibVaipakam.AssetType.ERC721,
            10 ether,
            15 ether,
            30,
            1,
            1
        );

        // Mock HF/LTV for NFT (illiquid collateral $0, but per specs allow with consent; assume revert or adjust)
        // For NFT lending, collateral is ERC20 (liquid), lending is NFT (illiquid ok)
        LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            1
        );
        assertEq(loan.principal, 10 ether);
        assertEq(loan.lender, lender);
        assertEq(loan.borrower, borrower);
        assertEq(uint8(loan.assetType), uint8(LibVaipakam.AssetType.ERC721));
    }

    function testGetLoanDetails() public {
        // #998 S15: collateral bumped 1500→2000 ether to clear the create floor.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );

        LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            1
        );
        assertEq(loan.principal, 1000 ether);
        assertEq(loan.collateralAmount, 2000 ether);
        assertEq(loan.durationDays, 30);
    }

    function testInitiateLoanRevertsInvalidOffer() public {
        // REVIEW: offerId 999 doesn't exist — buildTerms reads a zeroed offer,
        // the contract still reverts InvalidOffer before any binding check.
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, 999, true, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(OfferAcceptFacet.InvalidOffer.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(999, _t, _sig); // Non-existent
    }

    /// @dev Covers line 61 TRUE: direct call (not via diamond cross-facet) → CrossFacetCallFailed("Unauthorized")
    function testInitiateLoanRevertsDirectCall() public {
        vm.prank(borrower); // borrower != address(diamond)
        vm.expectRevert(); // CrossFacetCallFailed("Unauthorized")
        LoanFacet(address(diamond)).initiateLoan(1, borrower, false);
    }

    /// @dev Covers line 66 TRUE (offer.id == 0): prank as diamond, non-existent offerId → InvalidOffer
    function testInitiateLoanRevertsNonExistentOfferViaPrank() public {
        vm.prank(address(diamond));
        vm.expectRevert(LoanFacet.InvalidOffer.selector);
        LoanFacet(address(diamond)).initiateLoan(999, borrower, false);
    }

    /// @dev Covers line 66 TRUE (offer.accepted == true): prank as diamond, already-accepted offer → InvalidOffer
    function testInitiateLoanRevertsAlreadyAcceptedOfferViaPrank() public {
        // #998 S15: collateral 1500→2000 ether to clear the create floor.
        uint256 offerId = createOffer(
            mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 2000 ether, 30, 0, 0
        );
        LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId); // marks offer.accepted = true

        // Now call initiateLoan directly for the already-accepted offer
        vm.prank(address(diamond));
        vm.expectRevert(LoanFacet.InvalidOffer.selector);
        LoanFacet(address(diamond)).initiateLoan(offerId, borrower, false);
    }

    /// @dev Covers lines 75-80 TRUE: illiquid lending asset, no acceptor consent → NonLiquidAsset
    function testInitiateLoanRevertsNonLiquidAssetViaPrank() public {
        // Allow diamond to spend lender's mockIlliquidERC20 (needed for createOffer transfer)
        vm.prank(lender);
        ERC20(mockIlliquidERC20).approve(address(diamond), type(uint256).max);

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockIlliquidERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockERC20,
                collateralAmount: 1500 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        // Call initiateLoan via prank with acceptorRiskAndTermsConsent = false → RiskAndTermsConsentRequired
        vm.prank(address(diamond));
        vm.expectRevert(IVaipakamErrors.RiskAndTermsConsentRequired.selector);
        LoanFacet(address(diamond)).initiateLoan(offerId, borrower, false);
    }

    /// @dev Covers line 138 TRUE: calculateLTV staticcall reverts → CrossFacetCallFailed("LTV check failed")
    function testInitiateLoanRevertsLTVCallFailed() public {
        // #998 S15: collateral 1500→2000 ether to clear the create floor.
        uint256 offerId = createOffer(
            mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 2000 ether, 30, 0, 0
        );
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            "ltv revert"
        );
        vm.prank(address(diamond));
        vm.expectRevert(); // CrossFacetCallFailed("LTV check failed")
        LoanFacet(address(diamond)).initiateLoan(offerId, borrower, true);
        vm.clearMockedCalls();
    }

    /// @dev Covers line 152 TRUE: calculateHealthFactor staticcall reverts → CrossFacetCallFailed("HF check failed")
    function testInitiateLoanRevertsHFCallFailed() public {
        // #998 S15: collateral 1500→2000 ether to clear the create floor.
        uint256 offerId = createOffer(
            mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 2000 ether, 30, 0, 0
        );
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            "hf revert"
        );
        vm.prank(address(diamond));
        vm.expectRevert(); // CrossFacetCallFailed("HF check failed")
        LoanFacet(address(diamond)).initiateLoan(offerId, borrower, true);
        vm.clearMockedCalls();
    }

    /// @dev Covers lines 158-165 TRUE: updateNFTStatus call fails → CrossFacetCallFailed("NFT update failed")
    function testInitiateLoanRevertsNFTUpdateFailed() public {
        // #998 S15: collateral 1500→2000 ether to clear the create floor.
        uint256 offerId = createOffer(
            mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 2000 ether, 30, 0, 0
        );
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            "nft update fail"
        );
        vm.prank(address(diamond));
        vm.expectRevert(); // CrossFacetCallFailed("NFT update failed")
        LoanFacet(address(diamond)).initiateLoan(offerId, borrower, true);
        vm.clearMockedCalls();
    }

    /// @dev Covers lines 175-185 TRUE: mintNFT call fails → CrossFacetCallFailed("Mint NFT failed")
    function testInitiateLoanReverts_MintNFTFailed() public {
        // #998 S15: collateral 1500→2000 ether to clear the create floor.
        uint256 offerId = createOffer(
            mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 2000 ether, 30, 0, 0
        );
        // updateNFTStatus will succeed naturally (no ownerOf check after fix)
        // Mock mintNFT to fail
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.mintNFT.selector),
            "mint fail"
        );
        vm.prank(address(diamond));
        vm.expectRevert(); // CrossFacetCallFailed("Mint NFT failed")
        LoanFacet(address(diamond)).initiateLoan(offerId, borrower, true);
        vm.clearMockedCalls();
    }

    /// @dev Covers getLoanConsents view function
    function testGetLoanConsents() public {
        // #998 S15: collateral 1500→2000 ether to clear the create floor.
        uint256 offerId = createOffer(
            mockERC20, mockCollateralERC20, LibVaipakam.AssetType.ERC20,
            1000 ether, 2000 ether, 30, 0, 0
        );
        uint256 loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);

        bool consent = LoanFacet(address(diamond)).getLoanConsents(loanId);
        assertTrue(consent); // Both gave illiquidConsent = true
    }

    /// @dev Non-existent loan returns false for consents
    function testGetLoanConsentsDefault() public view {
        assertFalse(LoanFacet(address(diamond)).getLoanConsents(999));
    }

    /// @dev Non-existent loan returns zeroed struct
    function testGetLoanDetailsNonExistentReturnsEmpty() public view {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(999);
        assertEq(loan.id, 0);
        assertEq(loan.lender, address(0));
    }

    /// @dev Borrower creates offer, lender accepts → roles are correct
    function testInitiateLoanBorrowerOfferType() public {
        // T-051 — pair the direct deal with a counter record so the
        // subsequent vaultWithdrawERC20 inside acceptOffer doesn't
        // underflow protocolTrackedVaultBalance.
        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        deal(mockERC20, lenderVault, 1000 ether);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(lender, mockERC20, 1000 ether);

        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                // #998 S15: this BORROWER offer now hits the create-time lending
                // CEILING (max lending a collateral can back). At 1800 ether the
                // ceiling was 960 ether < the 1000-ether amount → MaxLendingAbove-
                // Ceiling. Raise collateral to 2000 ether (ceiling ≈ 1066 ether ≥
                // 1000) so the offer is created; amount stays 1000 to match the
                // dealt principal. The test only asserts lender/borrower roles.
                collateralAmount: 2000 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 2000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        LibAcceptTestSigner.signAndAccept(address(diamond), lender, lenderPk, offerId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(loan.lender, lender);
        assertEq(loan.borrower, borrower);
    }

    /// @dev Illiquid collateral with both consents creates loan successfully
    function testInitiateLoanIlliquidWithBothConsents() public {
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
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
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        assertTrue(loan.riskAndTermsConsentFromBoth);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    /// @dev Borrower creates NFT offer (ERC721), lender accepts → prepay/buffer fields set correctly
    function testInitiateLoanBorrowerNFTOfferType() public {
        // Lender needs to own the NFT for a Borrower-type NFT offer
        // (when lender accepts, the NFT goes to lender's vault)
        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);

        // Lender must approve the diamond to transfer their NFT
        vm.prank(lender);
        MockRentableNFT721(mockNft721).setApprovalForAll(address(diamond), true);
        // Also approve lender vault
        vm.prank(lender);
        MockRentableNFT721(mockNft721).setApprovalForAll(lenderVault, true);

        // Borrower creates a Borrower-type NFT offer (requesting to rent an NFT)
        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockNft721,
                amount: 10 ether, // daily rental fee
                interestRateBps: 500,
                collateralAsset: mockERC20,
                collateralAmount: 15 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: 1,
                quantity: 1,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 10 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 15 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        // Lender accepts the Borrower offer
        uint256 loanId = LibAcceptTestSigner.signAndAccept(address(diamond), lender, lenderPk, offerId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.lender, lender);
        assertEq(loan.borrower, borrower);
        assertEq(uint8(loan.assetType), uint8(LibVaipakam.AssetType.ERC721));

        // NFT offer: prepayAmount = amount * durationDays
        uint256 expectedPrepay = 10 ether * 30;
        uint256 expectedBuffer = (expectedPrepay * RENTAL_BUFFER_BPS) / BASIS_POINTS;
        assertEq(loan.prepayAmount, expectedPrepay);
        assertEq(loan.bufferAmount, expectedBuffer);
        assertEq(loan.lastDeductTime, block.timestamp);

        // Verify lender/borrower token IDs are assigned correctly for Borrower offer type
        // For Borrower offer: lenderTokenId = acceptor's minted tokenId, borrowerTokenId = offer's positionTokenId
        assertTrue(loan.lenderTokenId > 0);
        assertTrue(loan.borrowerTokenId > 0);
    }

    /// @dev Covers isLenderSaleVehicle=true path (lines 69-80): saleOfferToLoanId[offerId] != 0.
    ///      The offer is treated as a lender-sale vehicle so liquidity, mixed-collateral,
    ///      and LTV/HF checks are all skipped.
    function testInitiateLoanLenderSaleVehicle() public {
        // Create a normal offer first (which we'll mark as a sale vehicle)
        // #998 S15: collateral 1500→2000 ether to clear the create floor.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );

        // Create a real active loan first (the linked loan must be Active)
        uint256 existingLoanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);

        // Create another offer that will be the sale vehicle.
        // #998 S15: a real sale vehicle is a Borrower-shaped offer with 0
        // collateral (exempt from the bound via `skipCeiling`), but this test
        // fabricates one from the generic Lender `createOffer` helper. A liquid
        // Lender offer with 0 collateral now fails the create-time floor, so we
        // give it 2000 ether. The `initiateLoan` sale-vehicle path only RECORDS
        // `offer.collateralAmount` (no transfer — it early-returns before the
        // collateral lock), and this test asserts only status/LIF/treasury, so
        // the collateral value is immaterial to what's exercised.
        uint256 saleOfferId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );

        TestMutatorFacet(address(diamond)).setSaleOfferToLoanIdRaw(saleOfferId, existingLoanId);
        // #951 v2 (Codex #959 bind-to-live) — no collateral snapshot to scaffold:
        // the collateral floor now binds `>=` live at `_bindTermsToOffer` (the
        // accept path). LoanFacet only re-checks the structural invariants
        // (linked-loan Active + self-buy + compliance) exercised here.

        // Now initiate loan directly via prank as diamond (since this goes through
        // cross-facet). Buy as a THIRD party (`lender`), not the linked loan's own
        // borrower — the round-6 self-buy guard rejects `acceptor == borrower`.
        vm.prank(address(diamond));
        uint256 saleLoanId = LoanFacet(address(diamond)).initiateLoan(saleOfferId, lender, false);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(saleLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active));

        // #957 (Codex #989 P3) — the sale vehicle skips the LIF charge, so its
        // LIF receipt must read 0 (no fee paid), while the treasury fee — which
        // is not path-specific — is still snapshotted at the 1% default.
        assertEq(
            loan.loanInitiationFeeBpsAtInit,
            0,
            "sale vehicle records NO LIF (fee is skipped on that accept path)"
        );
        assertEq(
            loan.treasuryFeeBpsAtInit,
            100,
            "treasury fee is still snapshotted on the sale vehicle"
        );
    }

    /// @dev Covers isLenderSaleVehicle=true with linked loan NOT Active (line 77-79):
    ///      When the linked loan is not Active, should revert InvalidOffer.
    function testInitiateLoanLenderSaleVehicleLinkedLoanNotActive() public {
        // Create a normal offer and loan
        // #998 S15: collateral 1500→2000 ether to clear the create floor.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );

        uint256 existingLoanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);

        // Create another offer.
        // #998 S15: same as the sibling sale-vehicle test — a liquid Lender
        // offer with 0 collateral now fails the create-time floor, so give it
        // 2000 ether. The sale-vehicle path records but never transfers this
        // collateral, and the test asserts only the InvalidOffer revert.
        uint256 saleOfferId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );

        TestMutatorFacet(address(diamond)).setSaleOfferToLoanIdRaw(saleOfferId, existingLoanId);

        // Set the linked loan's status to Repaid (not Active)
        LibVaipakam.Loan memory linkedLoan = LoanFacet(address(diamond)).getLoanDetails(existingLoanId);
        linkedLoan.status = LibVaipakam.LoanStatus.Repaid;
        TestMutatorFacet(address(diamond)).setLoan(existingLoanId, linkedLoan);

        vm.prank(address(diamond));
        vm.expectRevert(LoanFacet.InvalidOffer.selector);
        LoanFacet(address(diamond)).initiateLoan(saleOfferId, borrower, false);
    }

    /// @dev Covers the compound HF/LTV skip condition when one asset is liquid and the other
    ///      is illiquid. Creator consents but acceptor does NOT.
    ///      The condition at line 91-96: (illiquid) && !(creatorConsent && acceptorConsent)
    ///      evaluates to true (since acceptor didn't consent), so NonLiquidAsset is reverted.
    function testInitiateLoanIlliquidCreatorConsentsAcceptorDoesNot() public {
        // Create offer with creatorRiskAndTermsConsent = true, illiquid collateral
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
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
                creatorRiskAndTermsConsent: true, // creator consents
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        // acceptor does NOT consent → NonLiquidAsset revert
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, false, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(IVaipakamErrors.RiskAndTermsConsentRequired.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, _t, _sig);
    }

    /// @dev Illiquid + both consents skips HF/LTV checks entirely
    function testInitiateLoanIlliquidBothConsentsSkipsHFLTV() public {
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        mockOracleLiquidity(mockIlliquidCollateralERC20, LibVaipakam.LiquidityStatus.Illiquid);

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockIlliquidERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockIlliquidCollateralERC20,
                collateralAmount: 1500 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        assertTrue(loan.riskAndTermsConsentFromBoth);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active));
        vm.clearMockedCalls();
    }

    // ─── Keeper offer→loan latching (Phase 6) ────────────────────────────────

    /// @dev Phase 6: the offer creator's per-keeper enable latches into
    ///      `loanKeeperEnabled[loanId][keeper]` at acceptance. The old
    ///      "offer keeper bool + both-profile-opt-in" model is gone.
    function testOfferKeeperEnableLatchesToLoan() public {
        address keeper = makeAddr("keeperX");
        vm.prank(lender);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).approveKeeper(
            keeper,
            LibVaipakam.KEEPER_ACTION_ALL
        );

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                // #998 S15: collateral 1500→2000 ether to clear the create floor.
                collateralAmount: 2000 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 2000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        vm.prank(lender);
        ProfileFacet(address(diamond)).setOfferKeeperEnabled(
            offerId,
            keeper,
            true
        );

        uint256 loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);

        assertTrue(
            ProfileFacet(address(diamond)).isLoanKeeperEnabled(loanId, keeper),
            "offer enable latched to loan"
        );
    }

    // ─── Depth-tiered LTV — init-gate integration tests ─────────────
    //
    // Piece B (docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md
    // §4.2): when `ConfigFacet.setDepthTieredLtvEnabled(true)`,
    // `LoanFacet._checkInitialLtvAndHf` caps init-LTV at
    // `min(assetRiskParams.loanInitMaxLtvBps, cfgTierMaxInitLtvBps(
    // getEffectiveLiquidityTier(collateral)))` (50% / 60% / 65% by
    // default) and relaxes the HF floor from `≥ 1.5e18` to `≥ 1e18` —
    // the tier cap is the binding safety buffer, and the protocol
    // invariant `loanInitMaxLtvBps ≤ liqThresholdBps` keeps init HF ≥ 1.
    // Switch-off path is unchanged. These tests cover the `if(tieredOn)`
    // branch the lighter `DepthTieredLtv.t.sol` suite can't reach —
    // mock `getEffectiveLiquidityTier` to control the tier, exercise a
    // full `createOffer` + `acceptOffer` flow against the binding gate.

    /// @dev Borrowing above the Tier-1 50% cap (but inside the
    ///      per-asset `loanInitMaxLtvBps = 8000`) reverts `InitLtvAboveTier`
    ///      with the precise `(ltv, cap)` payload.
    function testDepthTier_initGate_revertsAboveTier1Cap() public {
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(1))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(5200)) // 52% — above the 50% Tier-1 cap
        );
        // HF stays the setUp's 2e18 (≥ 1e18 — switch-on floor).

        // #998 S15: the tiered create floor for a Tier-1 collateral is exactly
        // 2000 ether (LTV-cap floor = 1000/0.50); 2000 meets it (reject is
        // strict `<`), so create passes and the mocked LTV trips the init gate.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.InitLtvAboveTier.selector,
                uint256(5200),
                uint256(5000)
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, _t, _sig);
    }

    /// @dev Same setup as the revert test but LTV inside the Tier-1
    ///      cap → the loan goes Active. Confirms the cap is the only
    ///      thing rejecting in the prior case.
    function testDepthTier_initGate_acceptsBelowTier1Cap() public {
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(1))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(4800)) // 48% — under the 50% Tier-1 cap
        );

        // #998 S15: 2000 ether == the Tier-1 create floor (meets it); the mocked
        // LTV 48% < 50% cap admits the loan at the init gate.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );
        uint256 loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Active)
        );
    }

    /// @dev Switch on, Tier 3 (cap 65%), LTV 60% (passes), HF 1.2e18 —
    ///      below the legacy 1.5e18 floor but above the relaxed 1e18
    ///      floor → succeeds. (Switch off, same HF would revert
    ///      `HealthFactorTooLow` — see `testInitiateLoanRevertsLowHF`.)
    function testDepthTier_initGate_hfFloorRelaxedToOne() public {
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(3))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(6000))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(12 * 1e17)) // 1.2e18 — between the two floors
        );

        // #998 S15: 2000 ether clears the Tier-3 create floor (~1539 ether); the
        // mocked LTV 60% ≤ 65% cap and HF 1.2e18 ≥ relaxed 1e18 floor admit it.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );
        uint256 loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Active)
        );
    }

    /// @dev Switch on, Tier 3, LTV 60% (passes), HF 0.9e18 — below the
    ///      relaxed 1e18 floor → still reverts `HealthFactorTooLow`. The
    ///      relaxed floor is `≥ 1e18` (not-born-already-liquidatable),
    ///      not "no floor".
    function testDepthTier_initGate_hfFloorBelowOneStillReverts() public {
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(3))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(6000))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(9 * 1e17)) // 0.9e18 — below 1.0
        );

        // #998 S15: 2000 ether clears the Tier-3 create floor (~1539 ether); the
        // mocked HF 0.9e18 < relaxed 1e18 floor still trips the init gate.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(IVaipakamErrors.HealthFactorTooLow.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, _t, _sig);
    }

    /// @dev Switch on, Tier 0 (untierable) ⇒ cap is `min(loanInitMaxLtvBps, 0) = 0`
    ///      ⇒ no borrow against a Tier-0 collateral, regardless of
    ///      `loanInitMaxLtvBps`.
    ///
    ///      #998 S15: effective-tier-0 collateral is now rejected fail-fast at
    ///      CREATE (the create bound mirrors the init-gate tier-0 no-borrow
    ///      rule), preempting the init-gate path this test previously exercised.
    ///      The offer can never be created — no collateral bump helps — so the
    ///      assertion is now on the CREATE-time `MinCollateralBelowFloor`
    ///      rejection rather than the accept-time `InitLtvAboveTier`.
    function testDepthTier_initGate_tier0CollateralRejected() public {
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(0))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(4000))
        );

        vm.expectPartialRevert(OfferCreateFacet.MinCollateralBelowFloor.selector);
        createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            1500 ether,
            30,
            0,
            0
        );
    }

    /// @dev Switch on, Tier 2 (cap 60% per library defaults —
    ///      `TIER2_MAX_INIT_LTV_BPS_DEFAULT = 6000`), LTV at 6300 = 63% just
    ///      above the cap → reverts `InitLtvAboveTier(63%, 60%)`. Pins the
    ///      Tier-2 boundary explicitly so a future cap change shows up as a
    ///      failed assertion.
    function testDepthTier_initGate_revertsAboveTier2Cap() public {
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(2))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(6300))
        );

        // #998 S15: 2000 ether clears the Tier-2 create floor (~1667 ether); the
        // mocked LTV 63% > 60% cap trips the init gate as before.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.InitLtvAboveTier.selector,
                uint256(6300),
                uint256(6000)
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, _t, _sig);
    }

    /// @dev Switch on, Tier 3 (cap 65% per library defaults —
    ///      `TIER3_MAX_INIT_LTV_BPS_DEFAULT = 6500`), LTV 7400 = 74% just above
    ///      the cap → reverts `InitLtvAboveTier(74%, 65%)`. Pins the Tier-3
    ///      boundary explicitly so a future cap change shows up as a failed
    ///      assertion. (`effectiveTierMaxInitLtvBps(3)` reads the autonomous
    ///      tier-LTV cache if fresh, else the 6500 library default.)
    function testDepthTier_initGate_revertsAboveTier3Cap() public {
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(3))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(7400))
        );

        // #998 S15: 2000 ether clears the Tier-3 create floor (~1539 ether); the
        // mocked LTV 74% > 65% cap trips the init gate as before.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.InitLtvAboveTier.selector,
                uint256(7400),
                uint256(6500)
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, _t, _sig);
    }

    /// @dev Switch OFF: even with Tier-3 mocked at the keeper level,
    ///      the init gate ignores the tier entirely — only the legacy
    ///      `LTV ≤ loanInitMaxLtvBps` + `HF ≥ 1.5` checks run. LTV 7500% < the
    ///      8000% `loanInitMaxLtvBps`, HF 2e18 ≥ 1.5e18 → loan goes Active.
    ///      Mirror test for `testDepthTier_initGate_acceptsBelowTier1Cap`
    ///      with the kill-switch in its default state.
    function testDepthTier_initGate_switchOffIgnoresTier() public {
        // No setDepthTieredLtvEnabled — default false.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(3))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(7500))
        );
        // HF must clear the legacy 1.5e18 floor.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(2e18)
        );

        // #998 S15: switch OFF ⇒ non-tiered create floor (~1875 ether); 2000
        // clears it, then the legacy init gates admit (LTV 75% < 80%, HF 2 ≥ 1.5).
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );
        uint256 loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "switch off -> tier ignored, legacy gates pass"
        );
    }

    // ── #394 Lever A — runtime, range-bounded admission HF floor ───────────

    /// @dev Unset override ⇒ the live floor is the `MIN_HEALTH_FACTOR`
    ///      constant (1.5e18) — today's behaviour, nothing moves until set.
    function testMinHealthFactor_defaultIsLegacy() public view {
        assertEq(
            RiskFacet(address(diamond)).getMinHealthFactor(),
            150 * 1e16,
            "default admission floor is 1.5e18"
        );
    }

    /// @dev RISK_ADMIN-gated + hard range-bounded `[1.2e18, 2.0e18]`.
    function testMinHealthFactor_setterAccessAndBounds() public {
        // non-RISK_ADMIN rejected
        vm.prank(borrower);
        vm.expectRevert();
        RiskFacet(address(diamond)).setMinHealthFactor(160 * 1e16);

        // below the 1.2e18 floor rejected
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("minHealthFactor"),
                uint256(119 * 1e16),
                uint256(120 * 1e16),
                uint256(200 * 1e16)
            )
        );
        RiskFacet(address(diamond)).setMinHealthFactor(119 * 1e16);

        // above the 2.0e18 ceiling rejected
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("minHealthFactor"),
                uint256(201 * 1e16),
                uint256(120 * 1e16),
                uint256(200 * 1e16)
            )
        );
        RiskFacet(address(diamond)).setMinHealthFactor(201 * 1e16);

        // valid set (owner holds RISK_ADMIN_ROLE) + getter reflects
        RiskFacet(address(diamond)).setMinHealthFactor(170 * 1e16);
        assertEq(
            RiskFacet(address(diamond)).getMinHealthFactor(),
            170 * 1e16,
            "floor retuned to 1.7e18"
        );
    }

    /// @dev The non-tiered init gate reads the RUNTIME floor: a loan whose HF
    ///      (1.6e18) clears the 1.5e18 default is REJECTED once governance
    ///      raises the floor to 1.8e18 — then ADMITTED again after lowering it
    ///      back. Proves the migration from the hard-coded `150*1e16` to
    ///      `minHealthFactor()` is load-bearing, and round-trips on one offer.
    function testMinHealthFactor_initGate_honorsRuntimeFloor() public {
        // Switch OFF (default) — exercise the non-tiered branch.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(6000))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(16 * 1e17)) // 1.6e18 — above 1.5 default, below 1.8
        );

        // #998 S15: 2000 ether clears the non-tiered create floor (~1875 ether);
        // the runtime HF floor is exercised at the init gate via the mocked HF.
        uint256 offerId = createOffer(
            mockERC20,
            mockCollateralERC20,
            LibVaipakam.AssetType.ERC20,
            1000 ether,
            2000 ether,
            30,
            0,
            0
        );

        // Raise the floor above the loan's HF → admission blocked.
        RiskFacet(address(diamond)).setMinHealthFactor(180 * 1e16); // 1.8e18
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory _sig = LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(IVaipakamErrors.HealthFactorTooLow.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, _t, _sig);

        // Lower it back below the HF → the SAME offer now admits. The reverted
        // accept above rolled back its nonce mark, so a fresh sign on the same
        // offerId (nonce) succeeds.
        RiskFacet(address(diamond)).setMinHealthFactor(150 * 1e16); // 1.5e18
        uint256 loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "lowered floor -> HF 1.6e18 clears 1.5e18 -> Active"
        );
    }
}
