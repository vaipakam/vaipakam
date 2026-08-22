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
 *         reinstall facets whose sale paths, since #1503, cross-call
 *         `RiskPreviewFacet.saleAdmission`:
 *
 *           - `RedeployFacets`      → `EarlyWithdrawalFacet`
 *             (`createLoanSaleOffer`, `completeLoanSale`)
 *           - `RedeployFacets`      → `EarlyWithdrawalDirectFacet`
 *             (`sellLoanViaBuyOffer`)
 *           - `ReplaceStaleFacets`  → `OfferAcceptFacet`
 *             (the binding check on the resting-listing accept branch)
 *
 *         THREE hosts, not two, since #1780 split the direct lender-exit route
 *         into its own facet. The cross-call is inside `LibSaleSolvency`, which
 *         inlines into each caller, so the host set is "whoever calls that
 *         library" — nothing a compile enumerates. `RedeployFacets` reinstalls
 *         both early-withdrawal halves and routes `saleAdmission` once, so the
 *         cases below still cover the pair; the enumeration is what tells the
 *         author of a FUTURE curated script that the direct facet is a sale
 *         host too.
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

    /// @notice `RedeployFacets` reinstalls both early-withdrawal facets
    ///         (`EarlyWithdrawalFacet` and, since #1780,
    ///         `EarlyWithdrawalDirectFacet`), so it must also route the selector
    ///         their sale paths call. One assertion covers both: the routing is
    ///         a property of the Diamond after the script runs, not per-host.
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

    // ─── 5. The WHOLE surface is refreshed, not part of it ────────────

    /// @notice Every selector of every facet `ReplaceStaleFacets` refreshes must
    ///         end up on ONE address — the freshly deployed one.
    ///
    /// @dev    Codex #1635 r5. The routing partition fixed which ACTION each
    ///         selector gets; it said nothing about the set being complete, and
    ///         it was not. The script hand-maintained its own lists and they had
    ///         drifted: 34 of ConfigFacet's 90 selectors, 30 of
    ///         OracleAdminFacet's 34, 4 of OfferCreateFacet's 7. A refresh
    ///         re-points only what it names, so the omitted selectors kept
    ///         resolving to the PREVIOUS facet address — one logical facet
    ///         serving calls from two different builds, with the script
    ///         reporting success. Nothing reverted, so no existing test noticed.
    ///
    ///         This is the shape of bug the earlier routing tests could not see:
    ///         they asked "is `saleAdmission` reachable?", which stays true when
    ///         56 of ConfigFacet's selectors are stale. Asserting a single
    ///         common host across each facet's FULL authoritative surface is
    ///         what pins it, and sourcing that surface from the same
    ///         `DeployDiamond` getters the script now uses means the assertion
    ///         cannot drift away from the script it guards.
    function test_ReplaceStaleFacets_RefreshesEachFacetsEntireSurface() public {
        SelectorSurfaceHarness surface = new SelectorSurfaceHarness();

        ReplaceStaleFacets script = new ReplaceStaleFacets();
        script.runWith(diamond, DEPLOYER_KEY);

        _assertSingleHost(surface.configSelectors(), "ConfigFacet");
        _assertSingleHost(surface.oracleAdminSelectors(), "OracleAdminFacet");
        _assertSingleHost(surface.offerCreateSelectors(), "OfferCreateFacet");
        _assertSingleHost(surface.offerAcceptSelectors(), "OfferAcceptFacet");
        _assertSingleHost(
            surface.offerAcceptFeeSelectors(),
            "OfferAcceptFeeFacet"
        );
        _assertSingleHost(surface.oracleSelectors(), "OracleFacet");
        _assertSingleHost(surface.vaultFactorySelectors(), "VaultFactoryFacet");
        _assertSingleHost(surface.numeraireConfigSelectors(), "NumeraireConfigFacet");
        _assertSingleHost(surface.riskPreviewSelectors(), "RiskPreviewFacet");
        _assertSingleHost(surface.offerPreviewSelectors(), "OfferPreviewFacet");
    }

    // ─── 6. The #1835 split migrates on an already-deployed Diamond ───

    /// @dev Put the Diamond back into its PRE-split shape: the borrower-LIF
    ///      charge co-hosted on `OfferAcceptFacet`, which is where every
    ///      Diamond deployed before #1835 still routes it. A `Replace` onto an
    ///      address that no longer implements the selector is exactly what the
    ///      field state is — the route is stale, not absent, which is why it
    ///      cannot be found by looking for reverts at cut time.
    function _coHostFeeSelectorOnAcceptFacet()
        internal
        returns (address preSplitHost)
    {
        SelectorSurfaceHarness surface = new SelectorSurfaceHarness();
        bytes4[] memory fee = surface.offerAcceptFeeSelectors();
        preSplitHost = IDiamondLoupe(diamond).facetAddress(
            surface.offerAcceptSelectors()[0]
        );

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: preSplitHost,
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: fee
        });

        vm.prank(deployer);
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
    }

    /// @notice The fixture really does reproduce the pre-split shape.
    /// @dev    Same discipline as `test_PreRefreshFixture_ReproducesTheBreak`
    ///         above: without this, the migration test below could pass against
    ///         a Diamond that was already correct and prove nothing.
    function test_PreSplitFixture_CoHostsTheFeeSelector() public {
        SelectorSurfaceHarness surface = new SelectorSurfaceHarness();
        bytes4 fee = surface.offerAcceptFeeSelectors()[0];
        bytes4 accept = surface.offerAcceptSelectors()[0];

        assertTrue(
            IDiamondLoupe(diamond).facetAddress(fee)
                != IDiamondLoupe(diamond).facetAddress(accept),
            "a freshly deployed Diamond must already have the two split apart"
        );

        _coHostFeeSelectorOnAcceptFacet();

        assertEq(
            IDiamondLoupe(diamond).facetAddress(fee),
            IDiamondLoupe(diamond).facetAddress(accept),
            "fixture must leave both selectors on one host"
        );
    }

    /// @notice `ReplaceStaleFacets` must re-point the borrower-LIF charge onto
    ///         its own facet when it meets a Diamond that predates #1835.
    ///
    /// @dev    #1835 moved `chargeBorrowerLifAndDeliver` off `OfferAcceptFacet`,
    ///         so it left that facet's selector list. A refresh re-points only
    ///         what it names — so had the script not gained a cut for the new
    ///         host, the selector would keep resolving to the OLD
    ///         `OfferAcceptFacet` address while every other accept selector
    ///         moved to the new one. The accept would then run new bytecode up
    ///         to its self-call and pre-split bytecode after it: one logical
    ///         facet serving one transaction from two builds, with the script
    ///         reporting success. That is the #778/#779 failure arriving by the
    ///         opposite door — a selector DROPPED from a list rather than
    ///         omitted from one — and no accept test can see it, because on a
    ///         Diamond this test's fixture reproduces, the stale route still
    ///         answers.
    function test_ReplaceStaleFacets_MigratesTheFeeSelector_OnPreSplitDiamond()
        public
    {
        SelectorSurfaceHarness surface = new SelectorSurfaceHarness();
        bytes4 fee = surface.offerAcceptFeeSelectors()[0];

        address stale = _coHostFeeSelectorOnAcceptFacet();

        ReplaceStaleFacets script = new ReplaceStaleFacets();
        script.runWith(diamond, DEPLOYER_KEY);

        address host = IDiamondLoupe(diamond).facetAddress(fee);
        assertTrue(host != address(0), "fee selector must stay routed");
        assertTrue(
            host != stale,
            "fee selector still on the pre-split OfferAcceptFacet address"
        );
        assertTrue(
            host
                != IDiamondLoupe(diamond).facetAddress(
                    surface.offerAcceptSelectors()[0]
                ),
            "fee selector must not be re-co-hosted on the refreshed accept facet"
        );
    }

    /// @dev Guards the guard: if the authoritative surfaces were ever reduced to
    ///      the sizes the drifted hand-kept lists had, the test above would
    ///      still pass while checking almost nothing. Pinning the counts means a
    ///      silent shrink has to be noticed and deliberately re-pinned.
    function test_AuthoritativeSurfacesAreNotTriviallySmall() public {
        SelectorSurfaceHarness surface = new SelectorSurfaceHarness();
        assertGt(
            surface.configSelectors().length,
            34,
            "ConfigFacet surface must exceed the 34 the drifted list carried"
        );
        assertGt(
            surface.oracleAdminSelectors().length,
            30,
            "OracleAdminFacet surface must exceed the 30 the drifted list carried"
        );
        assertGt(
            surface.offerCreateSelectors().length,
            4,
            "OfferCreateFacet surface must exceed the 4 the drifted list carried"
        );
    }

    // ─── Shared assertions ────────────────────────────────────────────

    /// @dev Assert every selector is routed AND they all share one host. A
    ///      partial refresh shows up here as two distinct non-zero addresses.
    function _assertSingleHost(bytes4[] memory selectors, string memory facet)
        internal
        view
    {
        require(selectors.length > 0, "empty surface");
        address host = IDiamondLoupe(diamond).facetAddress(selectors[0]);
        assertTrue(host != address(0), string.concat(facet, ": first selector unrouted"));
        for (uint256 i = 1; i < selectors.length; i++) {
            address h = IDiamondLoupe(diamond).facetAddress(selectors[i]);
            assertTrue(
                h != address(0),
                string.concat(facet, ": a selector of its surface is unrouted")
            );
            assertEq(
                h,
                host,
                string.concat(
                    facet,
                    ": surface split across two builds - only part of it was refreshed"
                )
            );
        }
    }

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

/**
 * @title  SelectorSurfaceHarness
 * @notice Exposes the AUTHORITATIVE per-facet selector lists to the test.
 *
 * @dev    Codex #1635 r5. Deliberately extends `ReplaceStaleFacets` rather than
 *         re-listing the selectors: the assertion must read the very lists the
 *         script cuts from, or the guard could pass while the script refreshed
 *         something narrower. The getters are `internal` on `DeployDiamond`, so
 *         a thin subclass is how a test reaches them.
 */
contract SelectorSurfaceHarness is ReplaceStaleFacets {
    function configSelectors() external pure returns (bytes4[] memory) {
        return _getConfigSelectors();
    }

    function oracleAdminSelectors() external pure returns (bytes4[] memory) {
        return _getOracleAdminSelectors();
    }

    function offerCreateSelectors() external pure returns (bytes4[] memory) {
        return _getOfferCreateSelectors();
    }

    function offerAcceptSelectors() external pure returns (bytes4[] memory) {
        return _getOfferAcceptSelectors();
    }

    function offerAcceptFeeSelectors() external pure returns (bytes4[] memory) {
        return _getOfferAcceptFeeSelectors();
    }

    function oracleSelectors() external pure returns (bytes4[] memory) {
        return _getOracleSelectors();
    }

    function vaultFactorySelectors() external pure returns (bytes4[] memory) {
        return _getVaultFactorySelectors();
    }

    function numeraireConfigSelectors() external pure returns (bytes4[] memory) {
        return _getNumeraireConfigSelectors();
    }

    function riskPreviewSelectors() external pure returns (bytes4[] memory) {
        return _getRiskPreviewFacetSelectors();
    }

    function offerPreviewSelectors() external pure returns (bytes4[] memory) {
        return _getOfferPreviewSelectors();
    }
}
