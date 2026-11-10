// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {HelperTest} from "./HelperTest.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibPriceGuard} from "../src/libraries/LibPriceGuard.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {RegistryKeys} from "../src/governance/RegistryKeys.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {MockProtocolRegistry} from "./mocks/MockProtocolRegistry.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title OracleAdminFacetTest
/// @notice The oracle settings the Diamond still holds (the pool factory and
///         the liquidity classification's reference inputs), and the one-shot
///         record of the protocol registry the Diamond finds its price guard
///         by (#3272 part 2). Every price setting is the guard's own and is
///         tested in the guard's suites.
contract OracleAdminFacetTest is SetupTest {
    function setUp() public {
        setupHelper();
    }

    // ─── Non-owner guard coverage ─────────────────────────────────────────────

    function testSetUniswapV3FactoryRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setUniswapV3Factory(address(0xBEEF));
    }

    // ─── Owner-path side effects ──────────────────────────────────────────────

    /// @dev Zero factory collapses {checkLiquidity} to Illiquid via the
    ///      fail-closed factory guard.
    function testOwnerCanZeroUniswapV3Factory() public {
        vm.clearMockedCalls();
        OracleAdminFacet(address(diamond)).setUniswapV3Factory(address(0));
        LibVaipakam.LiquidityStatus status =
            OracleFacet(address(diamond)).checkLiquidity(mockERC20);
        assertEq(
            uint8(status),
            uint8(LibVaipakam.LiquidityStatus.Illiquid),
            "factory=0 fail-closes to Illiquid"
        );
    }

    // ─── Post-audit bounds (ConfigKnobBoundsAudit-2026-05-14) ─────────
    //
    // Gap #3 — `setTierReferenceAssets.assets` is now capped at
    // MAX_TIER_REFERENCE_ASSETS (20) to bound the per-peer iteration
    // in the permissionless `refreshTierLtvCache` hot path.

    function testSetTierReferenceAssets_AcceptsAtBoundary() public {
        // 20 assets — exactly at the cap, must succeed.
        address[] memory assets = new address[](20);
        for (uint256 i = 0; i < 20; ++i) {
            assets[i] = address(SafeCast.toUint160(0x1000 + i));
        }
        OracleAdminFacet(address(diamond)).setTierReferenceAssets(1, assets);
        // Confirm the persisted list has the expected length.
        address[] memory roundTrip =
            OracleAdminFacet(address(diamond)).getTierReferenceAssets(1);
        assertEq(roundTrip.length, 20);
    }

    function testSetTierReferenceAssets_RevertsAboveBoundary() public {
        // 21 assets — just over the cap, must revert.
        address[] memory assets = new address[](21);
        for (uint256 i = 0; i < 21; ++i) {
            assets[i] = address(SafeCast.toUint160(0x1000 + i));
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleAdminFacet.TierReferenceAssetsTooLong.selector,
                uint256(21),
                uint256(20)
            )
        );
        OracleAdminFacet(address(diamond)).setTierReferenceAssets(1, assets);
    }

    function testSetTierReferenceAssets_RevertsHugeList() public {
        // 1000 assets — the "thousands-of-assets DoS the hot-path
        // refresh" exploit shape the cap defends against.
        address[] memory assets = new address[](1000);
        for (uint256 i = 0; i < 1000; ++i) {
            assets[i] = address(SafeCast.toUint160(0x1000 + i));
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleAdminFacet.TierReferenceAssetsTooLong.selector,
                uint256(1000),
                uint256(20)
            )
        );
        OracleAdminFacet(address(diamond)).setTierReferenceAssets(1, assets);
    }

    // ─── #2685: every chain-level oracle setter announces its change ─────────

    function testFactorySetterEmits() public {
        OracleAdminFacet a = OracleAdminFacet(address(diamond));
        vm.expectEmit(false, true, false, false, address(diamond));
        emit LibVaipakam.UniswapV3FactorySet(address(0), address(0xA4));
        a.setUniswapV3Factory(address(0xA4));
    }

    // ─── #3272 part 2: the registry the Diamond finds its price guard by ─────

    function testTheRegistryIsRecordedOnceWithTheGuardsNumeraire() public {
        OracleAdminFacet a = OracleAdminFacet(address(diamond));
        address registry = a.getProtocolRegistry();
        assertTrue(registry != address(0), "recorded at setup");
        assertEq(a.getPriceGuard(), MockProtocolRegistry(registry).pointer(RegistryKeys.PRICE_GUARD));
        assertEq(NumeraireConfigFacet(address(diamond)).getNumeraireSymbol(), bytes32("usd"));

        vm.expectRevert(OracleAdminFacet.AlreadyInitialized.selector);
        a.initializeProtocolRegistry(registry);
    }

    function testOnlyTheAdminRecordsTheRegistry() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).initializeProtocolRegistry(address(0xBEEF));
    }

    function testAFreshDiamondRefusesEveryPriceUntilTheRegistryIsRecorded() public {
        (address d,) = _bareOracleDiamond();
        vm.expectRevert(LibPriceGuard.ProtocolRegistryUnset.selector);
        OracleFacet(d).getAssetPrice(mockERC20);
        vm.expectRevert(LibPriceGuard.ProtocolRegistryUnset.selector);
        OracleFacet(d).getAssetPriceStatus(mockERC20);
        vm.expectRevert(LibPriceGuard.ProtocolRegistryUnset.selector);
        OracleAdminFacet(d).getPriceGuard();
        assertEq(OracleAdminFacet(d).getProtocolRegistry(), address(0));
    }

    function testARegistryThatNamesNoGuardIsRefused() public {
        (address d,) = _bareOracleDiamond();
        vm.expectRevert(abi.encodeWithSelector(OracleAdminFacet.ProtocolRegistryMismatch.selector, address(0xBEEF)));
        OracleAdminFacet(d).initializeProtocolRegistry(address(0xBEEF));

        MockProtocolRegistry empty = new MockProtocolRegistry(address(0));
        vm.expectRevert(abi.encodeWithSelector(OracleAdminFacet.ProtocolRegistryMismatch.selector, address(empty)));
        OracleAdminFacet(d).initializeProtocolRegistry(address(empty));
    }

    /// @dev A guard swapped in by the registry is read from the block it
    ///      lands, but only in the numeraire the Diamond recorded: a guard in
    ///      any other unit is refused by name, never read as "no price".
    function testASwappedGuardIsReadOnlyInTheRecordedNumeraire() public {
        OracleAdminFacet a = OracleAdminFacet(address(diamond));
        MockProtocolRegistry registry = MockProtocolRegistry(a.getProtocolRegistry());

        PriceGuard sameUnit = LibTestPriceGuard.deployGuard(address(this));
        registry.setPointer(RegistryKeys.PRICE_GUARD, address(sameUnit));
        assertEq(a.getPriceGuard(), address(sameUnit), "the swap lands at once");

        PriceGuard.Identity memory eur = LibTestPriceGuard.identity(address(0xE0), LibTestPriceGuard.ETH);
        eur.numeraireSymbol = bytes32("eur");
        PriceGuard otherUnit = LibTestPriceGuard.deployGuard(address(this), eur);
        registry.setPointer(RegistryKeys.PRICE_GUARD, address(otherUnit));
        bytes memory refusal = abi.encodeWithSelector(
            LibPriceGuard.PriceGuardNumeraireMismatch.selector, address(otherUnit), bytes32("usd"), bytes32("eur")
        );
        vm.expectRevert(refusal);
        OracleFacet(address(diamond)).getAssetPrice(mockERC20);
        vm.expectRevert(refusal);
        OracleFacet(address(diamond)).getAssetPriceStatus(mockERC20);
        vm.expectRevert(refusal);
        a.getPriceGuard();
    }

    /// @dev The Diamond holds no write path into the guard: the guard's
    ///      owner is the deploy's admin (the Timelock after the handover),
    ///      and a call from the Diamond is a stranger's.
    function testTheDiamondCannotChangeTheGuard() public {
        PriceGuard guard = PriceGuard(OracleAdminFacet(address(diamond)).getPriceGuard());
        assertTrue(guard.owner() != address(diamond));
        vm.prank(address(diamond));
        vm.expectRevert();
        guard.proposeChange(PriceGuard.Kind.Weth, bytes32(0), bytes32(uint256(uint160(address(0xBEEF)))));
    }

    /// @dev A Diamond with the oracle and its admin facet cut and access
    ///      control initialized, but no registry recorded.
    function _bareOracleDiamond() internal returns (address d, HelperTest h) {
        h = new HelperTest();
        DiamondCutFacet cut = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        d = address(new VaipakamDiamond(address(this), address(cut)));
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = IDiamondCut.FacetCut(
            ArtifactDeploy.deploy(type(OracleFacet).name), IDiamondCut.FacetCutAction.Add, h.getOracleFacetSelectors()
        );
        cuts[1] = IDiamondCut.FacetCut(
            ArtifactDeploy.deploy(type(OracleAdminFacet).name),
            IDiamondCut.FacetCutAction.Add,
            h.getOracleAdminFacetSelectors()
        );
        cuts[2] = IDiamondCut.FacetCut(
            ArtifactDeploy.deploy(type(AccessControlFacet).name),
            IDiamondCut.FacetCutAction.Add,
            h.getAccessControlFacetSelectors()
        );
        IDiamondCut(d).diamondCut(cuts, address(0), "");
        AccessControlFacet(d).initializeAccessControl();
    }
}
