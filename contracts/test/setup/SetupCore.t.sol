// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {TestBase} from "./TestBase.t.sol";
import {HelperTest} from "../HelperTest.sol";

import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

// 12 universal facets — every test needs the diamond surface, the
// auth + admin gates, the Oracle + OracleAdmin pair, Profile (sanctions
// + KYC), VaultFactory, and the 3 broadly-needed shared-infra facets
// (Config setters, Legal/ToS, TestMutator direct-write hook). Domain
// facets (Offer / Loan / Risk / Repay / Default / Reward / Metrics /
// Treasury / Lifecycle) live in family-specific mixins.
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../../src/facets/DiamondLoupeFacet.sol";
import {OwnershipFacet} from "../../src/facets/OwnershipFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {LegalFacet} from "../../src/facets/LegalFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";

import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";

import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockRentableNFT721} from "../mocks/MockRentableNFT721.sol";
import {ZeroExProxyMock} from "../mocks/ZeroExProxyMock.sol";
import {MockZeroExLegacyAdapter} from "../mocks/MockZeroExLegacyAdapter.sol";

/// @title SetupCore — Diamond + 13 universally-needed facets + mocks.
/// @notice The narrowest base a clean-room test should inherit. Provides
///         a routed Diamond with:
///           - Standard EIP-2535: Cut, Loupe, Ownership
///           - Auth: AccessControl, Admin
///           - Identity: Profile (sanctions + KYC), Legal (ToS)
///           - Oracle pair: OracleFacet + OracleAdminFacet
///           - Vault: VaultFactory + per-user vault impl
///           - Position NFT: VaipakamNFTFacet
///           - Test infra: ConfigFacet (universal config setters),
///             TestMutatorFacet (test-only direct-write hook)
///         + the standard mock token/NFT/0x-proxy fixture and the runtime
///         bootstrap every test needs (unpause, treasury set, swap adapter
///         registered, ERC20 approvals from lender+borrower, mock oracle
///         prices + liquidity).
///
/// @dev Why 13 facets in Core instead of the originally-designed 8:
///        Real-world test usage analysis (Stage 2 audit prep) showed that
///        ConfigFacet, TestMutatorFacet, and OracleAdminFacet are needed
///        by many "narrow" tests across multiple families — Metrics tests
///        need ConfigFacet + TestMutator; Treasury tests need
///        ConfigFacet + TestMutator; OracleAdmin tests need OracleFacet
///        + OracleAdminFacet as a pair. Pushing them down to Core avoids
///        duplicating cuts across every family base.
///
/// @dev Compile cost vs the old `SetupTest`:
///        - 13 facet TYPE imports + 4 mock TYPE imports vs the old 39
///          facet types. ~60 % fewer facet-type references in the
///          inheriting test contract's IR.
///        - One small `diamondCut(cuts[12])` instead of `diamondCut(cuts[38])`.
///        - Each inheriting test contract's IR no longer flattens the
///          unused 26 facet types.
abstract contract SetupCore is TestBase {
    // ─── Diamond + impl ──────────────────────────────────────────────────
    VaipakamDiamond internal diamond;
    VaipakamVaultImplementation internal vaultImpl;

    // ─── Core facets ─────────────────────────────────────────────────────
    DiamondCutFacet internal cutFacet;
    DiamondLoupeFacet internal diamondLoupeFacet;
    OwnershipFacet internal ownershipFacet;
    AccessControlFacet internal accessControlFacet;
    AdminFacet internal adminFacet;
    ProfileFacet internal profileFacet;
    OracleFacet internal oracleFacet;
    OracleAdminFacet internal oracleAdminFacet;
    VaultFactoryFacet internal vaultFacet;
    ConfigFacet internal configFacet;
    LegalFacet internal legalFacet;
    VaipakamNFTFacet internal nftFacet;
    TestMutatorFacet internal testMutatorFacet;

    // ─── Mocks (state fields) ────────────────────────────────────────────
    address internal mockERC20;            // Liquid lending leg
    address internal mockCollateralERC20;  // Liquid collateral leg
    address internal mockIlliquidERC20;    // Illiquid asset
    address internal mockNft721;           // Rentable NFT collateral
    address internal mockZeroExProxy;      // 0x-style swap aggregator mock

    // ─── Selector helper ─────────────────────────────────────────────────
    /// @dev Kept as a contract instance for parity with the old `SetupTest`
    ///      during the staged audit. A follow-up stage (0c) will convert
    ///      `HelperTest` to a stateless `internal pure` library — its
    ///      1,243 LOC would then drop out of every inheriting test's IR.
    HelperTest internal helperTest;

    // ─── setUp ────────────────────────────────────────────────────────────
    function setUp() public virtual override {
        super.setUp(); // TestBase: owner / lender / borrower

        helperTest = new HelperTest();
        vaultImpl = new VaipakamVaultImplementation();

        _deployMocks();
        _deployCoreFacetsAndDiamond();
        _cutCoreFacets();
        _bootstrapDiamond();
        _seedMockOracles();
        _seedIdentityAndTierDefaults();
    }

    // ─── Phase 1: mock fixture ───────────────────────────────────────────
    function _deployMocks() private {
        mockERC20 = address(new ERC20Mock("MockLiquid", "MLQ", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockIlliquidERC20 = address(new ERC20Mock("MockIlliquid", "MIL", 18));
        mockNft721 = address(new MockRentableNFT721());
        mockZeroExProxy = address(new ZeroExProxyMock());

        // Seed actor balances + the 0x mock's output liquidity.
        ERC20Mock(mockERC20).mint(lender, 100_000 ether);
        ERC20Mock(mockERC20).mint(borrower, 100_000 ether);
        ERC20Mock(mockCollateralERC20).mint(lender, 100_000 ether);
        ERC20Mock(mockCollateralERC20).mint(borrower, 100_000 ether);
        ERC20Mock(mockIlliquidERC20).mint(borrower, 100_000 ether);
        MockRentableNFT721(mockNft721).mint(lender, 1);

        // Mock swap proceeds — the legacy adapter pulls outputs from this
        // address on every quote.
        ERC20Mock(mockERC20).mint(mockZeroExProxy, 1_000_000 ether);
        ERC20Mock(mockCollateralERC20).mint(mockZeroExProxy, 1_000_000 ether);
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10); // 10 % bonus → liquidator profit
    }

    // ─── Phase 2: deploy facets + Diamond ────────────────────────────────
    function _deployCoreFacetsAndDiamond() private {
        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));

        diamondLoupeFacet = new DiamondLoupeFacet();
        ownershipFacet = new OwnershipFacet();
        accessControlFacet = new AccessControlFacet();
        adminFacet = new AdminFacet();
        profileFacet = new ProfileFacet();
        oracleFacet = new OracleFacet();
        oracleAdminFacet = new OracleAdminFacet();
        vaultFacet = new VaultFactoryFacet();
        configFacet = new ConfigFacet();
        legalFacet = new LegalFacet();
        nftFacet = new VaipakamNFTFacet();
        testMutatorFacet = new TestMutatorFacet();
    }

    // ─── Phase 3: cut into the Diamond ───────────────────────────────────
    function _cutCoreFacets() private {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](12);
        cuts[0] = _cutEntry(address(diamondLoupeFacet), helperTest.getDiamondLoupeFacetSelectors());
        cuts[1] = _cutEntry(address(ownershipFacet), helperTest.getOwnershipFacetSelectors());
        cuts[2] = _cutEntry(address(accessControlFacet), helperTest.getAccessControlFacetSelectors());
        cuts[3] = _cutEntry(address(adminFacet), helperTest.getAdminFacetSelectors());
        cuts[4] = _cutEntry(address(profileFacet), helperTest.getProfileFacetSelectors());
        cuts[5] = _cutEntry(address(oracleFacet), helperTest.getOracleFacetSelectors());
        cuts[6] = _cutEntry(address(oracleAdminFacet), helperTest.getOracleAdminFacetSelectors());
        cuts[7] = _cutEntry(address(vaultFacet), helperTest.getVaultFactoryFacetSelectors());
        cuts[8] = _cutEntry(address(configFacet), helperTest.getConfigFacetSelectors());
        cuts[9] = _cutEntry(address(legalFacet), helperTest.getLegalFacetSelectors());
        cuts[10] = _cutEntry(address(nftFacet), helperTest.getVaipakamNFTFacetSelectors());
        cuts[11] = _cutEntry(address(testMutatorFacet), helperTest.getTestMutatorFacetSelectors());
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    // ─── Phase 4: bootstrap state ────────────────────────────────────────
    function _bootstrapDiamond() private {
        // AccessControl roles first — every subsequent admin call requires roles.
        AccessControlFacet(address(diamond)).initializeAccessControl();

        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();

        AdminFacet(address(diamond)).setTreasury(address(diamond));

        // The Diamond is born paused (last write of the constructor in
        // VaipakamDiamond.sol — `LibPausable.pause()`). Flip the bit back
        // now that PAUSER_ROLE is in effect; pause-specific tests
        // re-pause inside their own scope.
        AdminFacet(address(diamond)).unpause();

        AdminFacet(address(diamond)).setZeroExProxy(mockZeroExProxy);
        AdminFacet(address(diamond)).setallowanceTarget(mockZeroExProxy);

        // Register the legacy-shim swap adapter at slot 0 so any test
        // exercising the liquidation swap path hits the 0x mock through
        // the standard ISwapAdapter abstraction. Tests that need a
        // richer adapter chain push more via `addSwapAdapter` in their
        // own setUp.
        MockZeroExLegacyAdapter legacyShim = new MockZeroExLegacyAdapter(mockZeroExProxy);
        AdminFacet(address(diamond)).addSwapAdapter(address(legacyShim));

        // Lender + borrower pre-approve the Diamond for the standard
        // mock-token surface so loan / repay / claim flows don't need
        // to set approvals inline.
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
    }

    // ─── Phase 5: oracle defaults ────────────────────────────────────────
    function _seedMockOracles() private {
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockNft721, LibVaipakam.LiquidityStatus.Illiquid);
        mockOracleLiquidity(mockIlliquidERC20, LibVaipakam.LiquidityStatus.Illiquid);
        mockOraclePrice(mockERC20, 1e8, 8);            // $1
        mockOraclePrice(mockCollateralERC20, 1e8, 8);  // $1
    }

    // ─── Phase 6: identity + tier-liquidation defaults ───────────────────
    /// @dev Bootstrap the identity gates + tier-liquidation thresholds that
    ///      the old `SetupTest.setupHelper()` set unconditionally. Every
    ///      inheriting test assumes these defaults are in place: trade
    ///      allowance enabled US↔FR, both actors in "US", both at KYC
    ///      Tier-2, and the per-tier liquidation thresholds pinned to the
    ///      legacy 8500/8500/8500 value the test corpus historically
    ///      tuned its HF math against. KYC enforcement is OFF by default
    ///      (CLAUDE.md retail policy), so the Tier-2 stamps are
    ///      defensive — tests that flip enforcement on need them.
    function _seedIdentityAndTierDefaults() private {
        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "FR", true);

        vm.prank(lender);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower);
        ProfileFacet(address(diamond)).setUserCountry("US");

        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);

        // Pin per-tier liquidation threshold to the legacy 85 % value the
        // test corpus historically tuned its HF math against (production
        // defaults 90/85/80 + the cross-tier monotonic invariant are
        // covered by the dedicated tier-liquidation setter tests).
        // Direct-write via TestMutator avoids the chicken-and-egg where
        // some tests' diamonds don't cut ConfigFacet — and we have
        // ConfigFacet here in Core so the value is read-back safe.
        TestMutatorFacet(address(diamond)).setTierLiquidationLtvBpsAllRaw(8500, 8500, 8500);
    }

    // ─── Helpers (callable from inheriting bases & tests) ────────────────
    function _cutEntry(address facet, bytes4[] memory selectors)
        private
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    function mockOracleLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset),
            abi.encode(status)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidityOnActiveNetwork.selector, asset),
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
}
