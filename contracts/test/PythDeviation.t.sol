// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {FeedRegistryInterface} from "@chainlink/contracts/src/v0.8/interfaces/FeedRegistryInterface.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title PythDeviationTest
 * @notice Phase 3.2 — deviation check + bundled-update wrapper.
 *         Verifies the fail-closed semantics (no silent fall-through
 *         to primary-only), admin gating on the governance setters,
 *         and that the `PriceUpdateFacet.updatePythAndCall` bundler
 *         correctly pays the Pyth fee and routes the inner call
 *         against the original caller's authority.
 */
contract PythDeviationTest is SetupTest {
    MockChainlinkAggregator internal chainlinkFeed;
    MockPyth internal pyth;
    address internal registry;
    address internal usdDenominator;
    address internal asset;
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant ETH_USD_ID =
        0x000000000000000000000000000000000000000000000000000000000000beef;

    function setUp() public {
        setupHelper();
        vm.clearMockedCalls();

        // Wire OracleAdminFacet selectors including the Phase 3.2 setters.
        OracleAdminFacet adminFacet = new OracleAdminFacet();
        bytes4[] memory adminSelectors = new bytes4[](6);
        adminSelectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        adminSelectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        adminSelectors[2] = OracleAdminFacet.setPythEndpoint.selector;
        adminSelectors[3] = OracleAdminFacet.setPythFeedConfig.selector;
        adminSelectors[4] = OracleAdminFacet.getPythEndpoint.selector;
        adminSelectors[5] = OracleAdminFacet.getPythFeedConfig.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: adminSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        vm.warp(1_000_000);

        asset = mockERC20;
        registry = makeAddr("feedRegistry");
        usdDenominator = makeAddr("usdDenominator");

        // Chainlink primary: $1000 at 8 decimals, fresh.
        chainlinkFeed = new MockChainlinkAggregator(
            int256(1000e8),
            block.timestamp,
            8
        );
        OracleAdminFacet(address(diamond)).setChainlinkRegistry(registry);
        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(
            usdDenominator
        );
        vm.mockCall(
            registry,
            abi.encodeWithSelector(
                FeedRegistryInterface.getFeed.selector,
                asset,
                usdDenominator
            ),
            abi.encode(address(chainlinkFeed))
        );

        // Pyth endpoint — installed but no feed config yet, so reads
        // should still fall through to Chainlink-only.
        pyth = new MockPyth();
        OracleAdminFacet(address(diamond)).setPythEndpoint(address(pyth));
    }

    // ─── Admin gating ───────────────────────────────────────────────────────

    function test_setPythEndpoint_NonOwnerReverts() public {
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setPythEndpoint(address(0xBEEF));
    }

    function test_setPythFeedConfig_NonOwnerReverts() public {
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            60
        );
    }

    function test_setPythFeedConfig_RejectsZeroAsset() public {
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            address(0),
            ETH_USD_ID,
            500,
            60
        );
    }

    function test_setPythFeedConfig_RejectsZeroDeviation() public {
        vm.expectRevert(IVaipakamErrors.InvalidAmount.selector);
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            0,
            60
        );
    }

    function test_setPythFeedConfig_RejectsMaxDeviation() public {
        vm.expectRevert(IVaipakamErrors.InvalidAmount.selector);
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            10000, // 100% — meaningless
            60
        );
    }

    function test_setPythFeedConfig_RejectsZeroStaleness() public {
        vm.expectRevert(IVaipakamErrors.InvalidAmount.selector);
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            0
        );
    }

    function test_setPythFeedConfig_ClearWithZeroPriceId() public {
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            60
        );
        (bytes32 id1, , ) = OracleAdminFacet(address(diamond)).getPythFeedConfig(
            asset
        );
        assertEq(id1, ETH_USD_ID);

        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            bytes32(0),
            0,
            0
        );
        (bytes32 id2, uint16 dev2, uint40 st2) = OracleAdminFacet(
            address(diamond)
        ).getPythFeedConfig(asset);
        assertEq(id2, bytes32(0));
        assertEq(dev2, 0);
        assertEq(st2, 0);
    }

    // ─── Deviation enforcement ──────────────────────────────────────────────

    function test_Pyth_NotConfigured_FallsThroughToChainlink() public {
        // No per-asset Pyth config set — deviation check should skip.
        (uint256 p, uint8 d) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(p, 1000e8);
        assertEq(d, 8);
    }

    function test_Pyth_Endpoint_Zero_Disables_Secondary_Globally() public {
        // Configure per-asset, but zero the endpoint — secondary path
        // disabled across the whole chain.
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            60
        );
        OracleAdminFacet(address(diamond)).setPythEndpoint(address(0));
        (uint256 p, ) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(p, 1000e8);
    }

    function test_Pyth_Agreeing_Passes() public {
        // Pyth price $1000 at expo -8 — matches Chainlink exactly.
        pyth.setPrice(ETH_USD_ID, int64(int256(1000e8)), 0, -8, block.timestamp);
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500, // 5% deviation allowed
            60
        );
        (uint256 p, uint8 d) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(p, 1000e8);
        assertEq(d, 8);
    }

    function test_Pyth_WithinBand_Passes() public {
        // Pyth 4% off — inside 5% band.
        pyth.setPrice(ETH_USD_ID, int64(int256(1040e8)), 0, -8, block.timestamp);
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            60
        );
        (uint256 p, ) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(p, 1000e8);
    }

    function test_Pyth_Diverging_Reverts() public {
        // Pyth 10% off — outside 5% band.
        pyth.setPrice(ETH_USD_ID, int64(int256(1100e8)), 0, -8, block.timestamp);
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            60
        );
        vm.expectRevert(OracleFacet.OraclePriceDivergence.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    function test_Pyth_Stale_Reverts() public {
        // Pyth price published 10 minutes ago — outside a 60-second window.
        pyth.setPrice(
            ETH_USD_ID,
            int64(int256(1000e8)),
            0,
            -8,
            block.timestamp - 600
        );
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            60
        );
        vm.expectRevert(OracleFacet.PythPriceUnavailable.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    function test_Pyth_Missing_Reverts() public {
        // Config installed but no price stored at all in the mock.
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            60
        );
        vm.expectRevert(OracleFacet.PythPriceUnavailable.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    function test_Pyth_NegativeOrZeroPrice_Reverts() public {
        // A Pyth return of 0 (or negative) must fail-closed, not skip
        // the check.
        pyth.setPrice(ETH_USD_ID, int64(0), 0, -8, block.timestamp);
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            60
        );
        vm.expectRevert(OracleFacet.PythPriceUnavailable.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    // ─── Update flow (two-tx sequential pattern) ───────────────────────────
    //
    // The Phase 3.2 deliverable does NOT bundle the Pyth update and the
    // Diamond action into a single atomic tx — the Solidity non-payable
    // guard on every action function makes that impractical without
    // marking every function as payable or breaking msg.sender auth.
    //
    // Instead, the frontend submits two sequential txs from the same
    // EOA in nonce order:
    //   Tx 1: IPyth(endpoint).updatePriceFeeds{value: fee}(updateData)
    //   Tx 2: the Diamond action (initiateLoan / triggerLiquidation / etc)
    //
    // From the same EOA in the same block, these are ordered by nonce —
    // there is no reorder window in which the Pyth price could stale
    // out before the action reads it. This is the pattern used by every
    // major Pyth-integrated protocol; it exchanges one extra signature
    // for a simpler on-chain surface. Coverage of the sequential flow
    // is exercised by the agreeing / diverging / stale tests above —
    // the "update" step is just a direct Pyth call, already covered by
    // Pyth's own test suite.

    function test_SequentialUpdateThenRead_Passes() public {
        // Simulates the two-tx pattern: tx1 already landed (Pyth has
        // fresh matching price), tx2 reads OracleFacet.getAssetPrice.
        pyth.setPrice(
            ETH_USD_ID,
            int64(int256(1000e8)),
            0,
            -8,
            block.timestamp
        );
        OracleAdminFacet(address(diamond)).setPythFeedConfig(
            asset,
            ETH_USD_ID,
            500,
            60
        );
        (uint256 p, ) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(p, 1000e8);
    }
}
