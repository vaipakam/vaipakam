// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {RedeployFacets} from "../../script/RedeployFacets.s.sol";
import {ReplaceStaleFacets} from "../../script/ReplaceStaleFacets.s.sol";
import {FacetSelectors} from "../../script/lib/FacetSelectors.sol";
import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {RiskPreviewFacet} from "../../src/facets/RiskPreviewFacet.sol";

/**
 * @title  PartialRefreshRoutingTest
 * @notice #1649 guardrail. The two CURATED partial-refresh scripts each
 *         reinstall a facet whose sale path, since #1503, cross-calls
 *         `RiskPreviewFacet.saleAdmission`:
 *
 *           - `RedeployFacets`      → `EarlyWithdrawalFacet`
 *             (`sellLoanViaBuyOffer`, `createLoanSaleOffer`)
 *           - `ReplaceStaleFacets`  → `OfferAcceptFacet`
 *             (the binding check on the resting-listing accept branch)
 *
 *         Run either against an EXISTING Diamond that predates #1503 and, until
 *         this issue was fixed, you got the worst possible outcome: the new
 *         sale bytecode live, calling a selector nothing routes, so every sale
 *         reverted `FunctionDoesNotExist` through the Diamond fallback. A
 *         compile cannot catch that — the cross-facet call is assembled from a
 *         selector at runtime, so the scripts built and deployed happily.
 *
 * @dev    Why a routing test rather than a fresh-deploy test: `DeployDiamond`
 *         was never affected, because it cuts every facet from scratch. The
 *         hazard is specific to a PARTIAL refresh of a Diamond that already
 *         exists, which is exactly what these two scripts are for, so the
 *         fixture has to be an existing Diamond missing the selector.
 *
 *         The pre-#1503 Diamond is simulated by deploying a current one and
 *         REMOVING `saleAdmission` from it. That is a faithful stand-in for the
 *         property under test — the scripts branch on the loupe's live routing,
 *         not on any facet's bytecode version, so an unrouted selector is
 *         precisely what a pre-#1503 Diamond presents to them. It also pins
 *         the negative directly: {test_PreRefreshFixture_ReproducesTheBreak}
 *         asserts the fixture really does revert `FunctionDoesNotExist`, so
 *         these tests cannot silently pass against a fixture that never
 *         reproduced the bug.
 *
 *         Each script is additionally run a SECOND time against the Diamond it
 *         just refreshed. That is not redundant: the first pass takes the Add
 *         branch of the routing partition and the second takes the Replace
 *         branch, and a diamondCut reverts if the two are swapped — Add rejects
 *         an already-routed selector, Replace rejects an unrouted one. Both
 *         branches therefore get executed, on both scripts.
 *
 * @custom:audit-priority HIGH — this is the live-upgrade path for a
 *         fund-moving settlement surface.
 */
contract PartialRefreshRoutingTest is Test {
    /// @dev Deterministic deployer. `DeployDiamond` keeps every role on the
    ///      deployer when `admin == deployer`, so this same key is authorised
    ///      to diamondCut in the refresh scripts.
    uint256 internal constant DEPLOYER_KEY = 1;
    address internal constant TREASURY = address(0xBEEF);

    address internal diamond;
    address internal deployer;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_KEY);

        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");

        DeployDiamond deployScript = new DeployDiamond();
        deployScript.runWith(deployer, TREASURY, DEPLOYER_KEY);
        diamond = deployScript.diamond();
    }

    // ─── Fixture ──────────────────────────────────────────────────────

    /// @dev Turn the freshly-deployed Diamond into the pre-#1503 shape the
    ///      refresh scripts actually meet in the field: everything current
    ///      EXCEPT `saleAdmission`, which is not routed at all.
    function _unrouteSaleAdmission() internal {
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = RiskPreviewFacet.saleAdmission.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: sels
        });

        vm.prank(deployer);
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
    }

    /// @dev The exact call `LibSaleSolvency.assertSaleSolvent` makes. Returns
    ///      the raw success flag and returndata so a test can tell "the
    ///      Diamond has no such function" apart from "the classifier ran and
    ///      rejected this particular loan".
    function _rawSaleAdmission(uint256 loanId)
        internal
        view
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = diamond.staticcall(
            abi.encodeWithSelector(RiskPreviewFacet.saleAdmission.selector, loanId)
        );
    }

    function _isFunctionDoesNotExist(bytes memory ret)
        internal
        pure
        returns (bool)
    {
        if (ret.length < 4) return false;
        bytes4 sel;
        // forge-lint: disable-next-line(asm-keccak256)
        assembly {
            sel := mload(add(ret, 0x20))
        }
        return sel == VaipakamDiamond.FunctionDoesNotExist.selector;
    }

    // ─── 1. The fixture genuinely reproduces the break ────────────────

    /// @notice Before any refresh runs, the simulated pre-#1503 Diamond fails
    ///         a sale exactly the way the finding describes.
    /// @dev    Without this the two refresh tests below could pass against a
    ///         fixture that was never broken — the classic green-for-the-wrong-
    ///         reason failure for an upgrade-path test.
    function test_PreRefreshFixture_ReproducesTheBreak() public {
        _unrouteSaleAdmission();

        assertEq(
            IDiamondLoupe(diamond).facetAddress(
                RiskPreviewFacet.saleAdmission.selector
            ),
            address(0),
            "fixture should leave saleAdmission unrouted"
        );

        (bool ok, bytes memory ret) = _rawSaleAdmission(1);
        assertFalse(ok, "unrouted selector must not succeed");
        assertTrue(
            _isFunctionDoesNotExist(ret),
            "pre-refresh Diamond should bubble FunctionDoesNotExist - the break this issue is about"
        );
    }

    // ─── 2. RedeployFacets routes the classifier ──────────────────────

    /// @notice `RedeployFacets` reinstalls `EarlyWithdrawalFacet`, so it must
    ///         also route the selector that facet's sale paths call.
    function test_RedeployFacets_RoutesSaleAdmission_OnPre1503Diamond() public {
        _unrouteSaleAdmission();

        RedeployFacets script = new RedeployFacets();
        script.runWith(diamond, DEPLOYER_KEY);

        _assertRiskPreviewFullyRouted();
        _assertSaleAdmissionReachesTheFacet();
    }

    /// @notice Re-running against the Diamond it just refreshed still succeeds.
    /// @dev    Exercises the Replace branch of the partition, which the first
    ///         pass could not reach for `saleAdmission`. An Add here would
    ///         revert ("function already exists"), so this passing is what
    ///         proves the script reads live routing rather than assuming a
    ///         version.
    function test_RedeployFacets_IsIdempotent_OnCurrentDiamond() public {
        _unrouteSaleAdmission();

        RedeployFacets first = new RedeployFacets();
        first.runWith(diamond, DEPLOYER_KEY);

        RedeployFacets second = new RedeployFacets();
        second.runWith(diamond, DEPLOYER_KEY);

        _assertRiskPreviewFullyRouted();
        _assertSaleAdmissionReachesTheFacet();
    }

    // ─── 3. ReplaceStaleFacets routes the classifier ──────────────────

    /// @notice `ReplaceStaleFacets` reinstalls `OfferAcceptFacet`, whose sale
    ///         branch is the BINDING check for a resting listing, so it has the
    ///         same obligation.
    function test_ReplaceStaleFacets_RoutesSaleAdmission_OnPre1503Diamond()
        public
    {
        _unrouteSaleAdmission();

        ReplaceStaleFacets script = new ReplaceStaleFacets();
        script.runWith(diamond, DEPLOYER_KEY);

        _assertRiskPreviewFullyRouted();
        _assertSaleAdmissionReachesTheFacet();
    }

    /// @notice Same idempotence property for the second script.
    function test_ReplaceStaleFacets_IsIdempotent_OnCurrentDiamond() public {
        _unrouteSaleAdmission();

        ReplaceStaleFacets first = new ReplaceStaleFacets();
        first.runWith(diamond, DEPLOYER_KEY);

        ReplaceStaleFacets second = new ReplaceStaleFacets();
        second.runWith(diamond, DEPLOYER_KEY);

        _assertRiskPreviewFullyRouted();
        _assertSaleAdmissionReachesTheFacet();
    }

    // ─── 4. The preview is refreshed with the accept path ─────────────

    /// @notice `ReplaceStaleFacets` re-points `previewAccept` at fresh bytecode
    ///         alongside the accept path it previews.
    /// @dev    Not a routing break — the stale preview stays callable. It is a
    ///         DIVERGENCE break: an un-refreshed preview does not know about the
    ///         sale block, so it quotes an accept as fine and the transaction
    ///         reverts, which is the failure #1503 exists to remove. Asserting
    ///         the route moved to a newly-deployed address is what pins the
    ///         refresh actually happening.
    function test_ReplaceStaleFacets_RefreshesTheOfferPreview() public {
        bytes4 previewSel = FacetSelectors.offerPreview()[0];
        address before = IDiamondLoupe(diamond).facetAddress(previewSel);
        assertTrue(before != address(0), "previewAccept should be routed pre-refresh");

        ReplaceStaleFacets script = new ReplaceStaleFacets();
        script.runWith(diamond, DEPLOYER_KEY);

        address host = IDiamondLoupe(diamond).facetAddress(previewSel);
        assertTrue(host != address(0), "previewAccept must stay routed");
        assertTrue(
            host != before,
            "previewAccept must be re-pointed at the freshly deployed preview facet"
        );
    }

    // ─── Shared assertions ────────────────────────────────────────────

    /// @dev Every one of the facet's selectors routed, and all to the SAME
    ///      address. A partition bug that split the set across the old and new
    ///      facet addresses would leave the Diamond half-upgraded — routed, so
    ///      no `FunctionDoesNotExist`, but running two different builds of the
    ///      same facet. Checking the common host catches that; checking only
    ///      `saleAdmission != address(0)` would not.
    function _assertRiskPreviewFullyRouted() internal view {
        bytes4[] memory sels = FacetSelectors.riskPreview();
        address host = IDiamondLoupe(diamond).facetAddress(sels[0]);
        assertTrue(host != address(0), "RiskPreviewFacet selector 0 unrouted");

        for (uint256 i; i < sels.length; ++i) {
            assertEq(
                IDiamondLoupe(diamond).facetAddress(sels[i]),
                host,
                "every RiskPreviewFacet selector must route to one host facet"
            );
        }
    }

    /// @dev The call the sale guard makes must REACH the facet. A nonexistent
    ///      loan default-inits both liquidity flags to `Liquid` (enum member 0),
    ///      so the classifier proceeds to the health read and reverts on the
    ///      empty loan — a facet-level revert, not the fallback's. Asserting
    ///      "not FunctionDoesNotExist" is therefore the precise statement:
    ///      routing is fixed, and this says nothing about any particular loan's
    ///      admissibility, which is `EarlyWithdrawalFacetTest`'s subject.
    function _assertSaleAdmissionReachesTheFacet() internal view {
        (bool ok, bytes memory ret) = _rawSaleAdmission(1);
        assertFalse(
            _isFunctionDoesNotExist(ret),
            "post-refresh sale path must not bubble FunctionDoesNotExist"
        );
        // Either outcome is fine; what must not happen is the fallback revert.
        ok; // silence unused-variable lint without weakening the assertion
    }
}
