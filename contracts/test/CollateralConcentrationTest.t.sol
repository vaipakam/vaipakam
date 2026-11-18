// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {CollateralConcentrationFacet} from "../src/facets/CollateralConcentrationFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {NumeraireValueFacet} from "../src/facets/NumeraireValueFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../src/libraries/LibEncumbrance.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {HelperTest} from "./HelperTest.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

/// @dev Test-only facet: writes the storage the concentration rule reads, so
///      each case sets exactly the state it needs.
contract ConcentrationStoreFacet {
    function setPledged(address asset, uint256 amount) external {
        LibVaipakam.storageSlot().collateralPledged[asset] = amount;
    }

    function setTiered(bool on) external {
        LibVaipakam.storageSlot().protocolCfg.depthTieredLtvEnabled = on;
    }

    function setAssetCeiling(address asset, uint256 bps) external {
        LibVaipakam.storageSlot().assetRiskParams[asset].loanInitMaxLtvBps = bps;
    }
}

/// @dev Runs the lien writer against its own storage, so the pledged total
///      can be checked against every collateral lien change.
contract LienHarness {
    function setLoan(
        uint256 loanId,
        address borrower,
        address collateralAsset,
        uint256 amount,
        LibVaipakam.AssetType collateralType,
        LibVaipakam.AssetType loanType
    ) external {
        LibVaipakam.Loan storage l = LibVaipakam.storageSlot().loans[loanId];
        l.id = loanId;
        l.borrower = borrower;
        l.collateralAsset = collateralAsset;
        l.collateralAssetType = collateralType;
        l.assetType = loanType;
        if (collateralType == LibVaipakam.AssetType.ERC20) l.collateralAmount = amount;
        else if (collateralType == LibVaipakam.AssetType.ERC1155) l.collateralQuantity = amount;
        else l.collateralTokenId = 7;
    }

    function create(uint256 loanId) external {
        LibEncumbrance.createCollateralLien(loanId, LibVaipakam.storageSlot().loans[loanId]);
    }

    function release(uint256 loanId) external {
        LibEncumbrance.releaseCollateralLien(loanId);
    }

    function decrement(uint256 loanId, uint256 amount) external {
        LibEncumbrance.decrementCollateralLien(loanId, amount);
    }

    function increment(uint256 loanId, uint256 amount) external {
        LibEncumbrance.incrementCollateralLien(loanId, amount);
    }

    function recreate(uint256 loanId) external {
        LibEncumbrance.recreateCollateralLien(loanId, LibVaipakam.storageSlot().loans[loanId]);
    }

    function rekey(uint256 oldId, uint256 newId) external returns (bool) {
        return LibEncumbrance.rekeyCollateralLienOnRefinance(
            oldId, newId, LibVaipakam.storageSlot().loans[newId]
        );
    }

    function pledged(address asset) external view returns (uint256) {
        return LibVaipakam.storageSlot().collateralPledged[asset];
    }
}

/**
 * @title CollateralConcentrationTest
 * @notice #3685 — the platform-wide pledged total per collateral asset, the
 *         concentration levels it produces and the loan-opening cap the
 *         High level lowers. Defaults: Caution 5x, High 10x, lowest-tier step
 *         10 points; tier caps 50 / 60 / 65%; tier liquidation LTVs 80 / 85 /
 *         90%; HF floor 1.5.
 */
contract CollateralConcentrationTest is Test {
    VaipakamDiamond diamond;
    CollateralConcentrationFacet cc;
    ConcentrationStoreFacet store;
    address asset = makeAddr("collateral");
    address rando = makeAddr("rando");

    uint256 constant TIER1_DEPTH = 50_000e18;
    uint256 constant TIER2_DEPTH = 500_000e18;
    uint256 constant TIER3_DEPTH = 5_000_000e18;

    function setUp() public {
        DiamondCutFacet cutFacet = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond = new VaipakamDiamond(address(this), address(cutFacet));
        HelperTest helper = new HelperTest();

        bytes4[] memory storeSel = new bytes4[](3);
        storeSel[0] = ConcentrationStoreFacet.setPledged.selector;
        storeSel[1] = ConcentrationStoreFacet.setTiered.selector;
        storeSel[2] = ConcentrationStoreFacet.setAssetCeiling.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(AccessControlFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAccessControlFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(CollateralConcentrationFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getCollateralConcentrationFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(new ConcentrationStoreFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: storeSel
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        cc = CollateralConcentrationFacet(address(diamond));
        store = ConcentrationStoreFacet(address(diamond));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _tier(uint8 t) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getEffectiveLiquidityTier.selector, asset),
            abi.encode(t)
        );
    }

    /// @dev Pledge `value` worth of the asset (amount == value, priced 1:1).
    function _pledgedValue(uint256 value) internal {
        store.setPledged(asset, value);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(NumeraireValueFacet.getNumeraireValue.selector, asset, value, false),
            abi.encode(value)
        );
    }

    function _cap() internal view returns (uint256 cap, uint8 level, bool binds) {
        (cap,, level, binds) = cc.newLoanInitLtvCapBps(asset);
    }

    // ─── Settings ────────────────────────────────────────────────────────

    function test_Defaults() public view {
        (uint16 c, uint16 h, uint16 step) = cc.getConcentrationConfig();
        assertEq(c, 500);
        assertEq(h, 1000);
        assertEq(step, 1000);
        (c, h) = cc.getAssetConcentrationThresholds(asset);
        assertEq(c, 500);
        assertEq(h, 1000);
    }

    function test_SetConfig_BoundsAndEvent() public {
        vm.expectEmit(address(diamond));
        emit CollateralConcentrationFacet.ConcentrationConfigSet(300, 800, 2500);
        cc.setConcentrationConfig(300, 800, 2500);
        (uint16 c, uint16 h, uint16 step) = cc.getConcentrationConfig();
        assertEq(c, 300);
        assertEq(h, 800);
        assertEq(step, 2500);

        // Zero keeps each default.
        cc.setConcentrationConfig(0, 0, 0);
        (c, h, step) = cc.getConcentrationConfig();
        assertEq(c, 500);
        assertEq(h, 1000);
        assertEq(step, 1000);

        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ParameterOutOfRange.selector, bytes32("concentrationCaution"), 199, 200, 2000)
        );
        cc.setConcentrationConfig(199, 1000, 1000);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ParameterOutOfRange.selector, bytes32("concentrationCaution"), 2001, 200, 2000)
        );
        cc.setConcentrationConfig(2001, 3000, 1000);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ParameterOutOfRange.selector, bytes32("concentrationHigh"), 500, 501, 5000)
        );
        cc.setConcentrationConfig(500, 500, 1000);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ParameterOutOfRange.selector, bytes32("concentrationHigh"), 5001, 501, 5000)
        );
        cc.setConcentrationConfig(500, 5001, 1000);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ParameterOutOfRange.selector, bytes32("concentrationStep"), 499, 500, 2500)
        );
        cc.setConcentrationConfig(500, 1000, 499);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ParameterOutOfRange.selector, bytes32("concentrationStep"), 2501, 500, 2500)
        );
        cc.setConcentrationConfig(500, 1000, 2501);
    }

    function test_SetConfig_AdminOnly() public {
        vm.prank(rando);
        vm.expectRevert();
        cc.setConcentrationConfig(300, 800, 1000);
        vm.prank(rando);
        vm.expectRevert();
        cc.setAssetConcentrationConfig(asset, 300, 800);
    }

    function test_AssetConfig_TighterOnly() public {
        vm.expectEmit(address(diamond));
        emit CollateralConcentrationFacet.AssetConcentrationConfigSet(asset, 300, 600);
        cc.setAssetConcentrationConfig(asset, 300, 600);
        (uint16 c, uint16 h) = cc.getAssetConcentrationThresholds(asset);
        assertEq(c, 300);
        assertEq(h, 600);

        // Looser than the platform is refused.
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ParameterOutOfRange.selector, bytes32("assetConcentrationCaution"), 600, 200, 500)
        );
        cc.setAssetConcentrationConfig(asset, 600, 900);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ParameterOutOfRange.selector, bytes32("assetConcentrationHigh"), 1100, 201, 1000)
        );
        cc.setAssetConcentrationConfig(asset, 300, 1100);
        // High must stay above Caution once combined with the platform value.
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ParameterOutOfRange.selector, bytes32("assetConcentrationOrder"), 400, 501, 1000)
        );
        cc.setAssetConcentrationConfig(asset, 0, 400);

        // A later platform tightening below the asset's own value wins.
        cc.setConcentrationConfig(250, 500, 1000);
        (c, h) = cc.getAssetConcentrationThresholds(asset);
        assertEq(c, 250);
        assertEq(h, 500);
    }

    function test_AssetConfig_ZeroAddressRefused() public {
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        cc.setAssetConcentrationConfig(address(0), 300, 600);
    }

    // ─── Levels and the depth reference ─────────────────────────────────

    function test_NothingPledged_IsNormal() public {
        _tier(2);
        store.setTiered(true);
        CollateralConcentrationFacet.Concentration memory c = cc.getConcentration(asset);
        assertEq(c.pledged, 0);
        assertTrue(c.priced);
        assertEq(c.level, LibVaipakam.CONCENTRATION_NORMAL);
        assertEq(c.depthRef, TIER2_DEPTH);
        assertEq(c.capBps, 6000);
    }

    function test_ThresholdBoundaries_Tier2Tiered() public {
        _tier(2);
        store.setTiered(true);

        // Just under 5x: Normal.
        _pledgedValue(TIER2_DEPTH * 5 - 1e18 * 10_000);
        (uint256 cap, uint8 level, bool binds) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_NORMAL);
        assertEq(cap, 6000);
        assertFalse(binds);

        // Exactly 5x: Caution, cap unchanged.
        _pledgedValue(TIER2_DEPTH * 5);
        (cap, level, binds) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_CAUTION);
        assertEq(cap, 6000);
        assertFalse(binds);

        // Exactly 10x: High, cap is tier 1's.
        _pledgedValue(TIER2_DEPTH * 10);
        (cap, level, binds) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_HIGH);
        assertEq(cap, 5000);
        assertTrue(binds);

        CollateralConcentrationFacet.Concentration memory c = cc.getConcentration(asset);
        assertEq(c.ratioX100, 1000);
        assertEq(c.regimeCapBps, 6000);
        assertEq(c.loweredCapBps, 5000);
        assertTrue(c.loweredCapBinds);
    }

    function test_Tier3High_StepsToTier2() public {
        _tier(3);
        store.setTiered(true);
        _pledgedValue(TIER3_DEPTH * 10);
        (uint256 cap, uint8 level, bool binds) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_HIGH);
        assertEq(cap, 6000);
        assertTrue(binds);
    }

    function test_LowestTier_UsesStep() public {
        _tier(1);
        store.setTiered(true);
        _pledgedValue(TIER1_DEPTH * 10);
        (uint256 cap, uint8 level, bool binds) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_HIGH);
        assertEq(cap, 4000); // 50% less the default 10-point step
        assertTrue(binds);

        cc.setConcentrationConfig(0, 0, 2500);
        (cap,,) = _cap();
        assertEq(cap, 2500);
    }

    function test_TierChange_MovesDepthReference() public {
        // The same pledged value is High against tier 2's depth and Normal
        // against tier 3's, ten times deeper.
        _pledgedValue(TIER2_DEPTH * 10);
        store.setTiered(true);
        _tier(2);
        (, uint8 level,) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_HIGH);
        _tier(3);
        CollateralConcentrationFacet.Concentration memory c = cc.getConcentration(asset);
        assertEq(c.depthRef, TIER3_DEPTH);
        assertEq(c.ratioX100, 100);
        assertEq(c.level, LibVaipakam.CONCENTRATION_NORMAL);
        assertEq(c.capBps, 6500);
    }

    function test_AssetThresholds_Apply() public {
        _tier(2);
        store.setTiered(true);
        _pledgedValue(TIER2_DEPTH * 3);
        (, uint8 level,) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_NORMAL);
        cc.setAssetConcentrationConfig(asset, 300, 600);
        (, level,) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_CAUTION);
    }

    function test_Tier0_NotLowered() public {
        _tier(0);
        store.setTiered(true);
        // Tier 0's depth reference is the floor probe ($5k).
        _pledgedValue(5_000e18 * 10);
        (uint256 cap, uint8 level, bool binds) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_HIGH);
        assertEq(cap, 0); // the tiered regime already caps tier 0 at 0
        assertFalse(binds);
    }

    function test_AssetCeiling_BelowLoweredCap_NotBinding() public {
        _tier(2);
        store.setTiered(true);
        store.setAssetCeiling(asset, 4500);
        _pledgedValue(TIER2_DEPTH * 10);
        (uint256 cap, uint8 level, bool binds) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_HIGH);
        assertEq(cap, 4500);
        assertFalse(binds);
    }

    // ─── Untiered regime ────────────────────────────────────────────────

    /// @dev Design decision: a tier-3 asset in the untiered regime is High
    ///      but the lowered cap (tier 2's 60%) is not below what the HF floor
    ///      already allows (90% / 1.5 = 60%), so nothing is lowered and the
    ///      view says so.
    function test_Untiered_Tier3High_CapNotBinding() public {
        _tier(3);
        _pledgedValue(TIER3_DEPTH * 10);
        (uint256 cap, uint8 level, bool binds) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_HIGH);
        assertFalse(binds);
        assertEq(cap, 10_000); // the asset ceiling (unset); the HF gate binds beside it
        CollateralConcentrationFacet.Concentration memory c = cc.getConcentration(asset);
        assertEq(c.regimeCapBps, 6000);
        assertEq(c.loweredCapBps, 6000);
        assertFalse(c.loweredCapBinds);
    }

    function test_Untiered_Tier2High_Binds() public {
        _tier(2);
        _pledgedValue(TIER2_DEPTH * 10);
        (uint256 cap, uint8 level, bool binds) = _cap();
        assertEq(level, LibVaipakam.CONCENTRATION_HIGH);
        assertTrue(binds); // 50% < 85% / 1.5 = 56.66%
        assertEq(cap, 5000);
    }

    function test_Untiered_Tier1High_Binds() public {
        _tier(1);
        _pledgedValue(TIER1_DEPTH * 10);
        (uint256 cap,, bool binds) = _cap();
        assertTrue(binds); // 40% < 80% / 1.5 = 53.33%
        assertEq(cap, 4000);
    }

    // ─── Price ──────────────────────────────────────────────────────────

    function test_Unpriced_ViewSaysUnknown_GateReverts() public {
        _tier(2);
        store.setTiered(true);
        store.setPledged(asset, 1e18);
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(NumeraireValueFacet.getNumeraireValue.selector, asset, 1e18, false),
            "no price"
        );
        CollateralConcentrationFacet.Concentration memory c = cc.getConcentration(asset);
        assertFalse(c.priced);
        assertEq(c.pledgedValue, 0);
        assertEq(c.level, LibVaipakam.CONCENTRATION_NORMAL);
        vm.expectRevert();
        cc.newLoanInitLtvCapBps(asset);
    }

    // ─── The pledged total follows every collateral lien change ─────────

    function test_PledgedTotal_FollowsLienWriter() public {
        LienHarness h = new LienHarness();
        address b = makeAddr("borrower");
        address b2 = makeAddr("borrower2");
        h.setLoan(1, b, asset, 100e18, LibVaipakam.AssetType.ERC20, LibVaipakam.AssetType.ERC20);
        h.setLoan(2, b2, asset, 50e18, LibVaipakam.AssetType.ERC20, LibVaipakam.AssetType.ERC20);

        h.create(1);
        h.create(2);
        assertEq(h.pledged(asset), 150e18);

        h.decrement(1, 30e18); // a partial liquidation slice
        assertEq(h.pledged(asset), 120e18);

        h.increment(1, 10e18); // a top-up
        assertEq(h.pledged(asset), 130e18);

        h.release(1); // repaid
        assertEq(h.pledged(asset), 50e18);
        h.release(1); // idempotent
        assertEq(h.pledged(asset), 50e18);

        h.increment(1, 20e18); // fallback entry re-liens the custody
        assertEq(h.pledged(asset), 70e18);
        h.release(1);

        // Refinance carry-over: the lien moves keys, the total does not move.
        h.setLoan(3, b2, asset, 50e18, LibVaipakam.AssetType.ERC20, LibVaipakam.AssetType.ERC20);
        assertTrue(h.rekey(2, 3));
        assertEq(h.pledged(asset), 50e18);
        h.release(2); // the old id is a tombstone now
        assertEq(h.pledged(asset), 50e18);

        // Obligation handover: released, then re-created for the new borrower.
        h.release(3);
        assertEq(h.pledged(asset), 0);
        h.setLoan(3, b, asset, 50e18, LibVaipakam.AssetType.ERC20, LibVaipakam.AssetType.ERC20);
        h.recreate(3);
        assertEq(h.pledged(asset), 50e18);
    }

    function test_PledgedTotal_CountsErc20CollateralOnly() public {
        LienHarness h = new LienHarness();
        address b = makeAddr("borrower");
        // NFT collateral is liened but not part of the ERC-20 total.
        h.setLoan(1, b, asset, 1, LibVaipakam.AssetType.ERC721, LibVaipakam.AssetType.ERC20);
        h.create(1);
        assertEq(h.pledged(asset), 0);
        h.release(1);
        // A rental loan (the lent asset is an NFT) carries no collateral lien.
        h.setLoan(2, b, asset, 100e18, LibVaipakam.AssetType.ERC20, LibVaipakam.AssetType.ERC721);
        h.create(2);
        assertEq(h.pledged(asset), 0);
    }
}
