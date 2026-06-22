// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskSplitLiquidationFacet} from "../src/facets/RiskSplitLiquidationFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title RedeployFacets
 * @notice Redeploys the curated facet set (originally the six README §3
 *         facets — role-scoped keeper model, dynamic liquidator incentive,
 *         2% treasury liquidation handling fee — plus RiskSplitLiquidationFacet
 *         and ConsolidationFacet, added in #658 so the liquidation family's
 *         eager-consolidation cross-facet dependency stays internally
 *         consistent on a curated redeploy) and diamond-cuts every selector to
 *         the new implementation, Replacing routed selectors and Adding new ones.
 *
 * @dev    SCOPE — this is a CURATED INCREMENTAL refresh of a fixed facet set,
 *         for iterating on those specific facets on an existing diamond. It is
 *         NOT, and must not be used as, a complete rollout of a change that
 *         spans many facets. In particular it is **not the #394 rollout**: #394
 *         touched 13 facets, several only via INLINED libraries (LibRiskMath →
 *         OfferCreateFacet / OfferMatchFacet; LibMetricsTypes →
 *         MetricsDashboardFacet / MetricsFacet) whose bytecode changes don't
 *         show up as direct facet edits. Cherry-picking a subset here would
 *         leave a live diamond with mismatched bytecode across the inlined-lib
 *         boundary.
 *
 *         Rollout policy (owner, 2026-06-19): **every facet is (re)deployed
 *         FRESH via `DeployDiamond.s.sol`** — that is the canonical path for any
 *         change that crosses a shared library, so the whole selector set is
 *         consistent by construction. Use this script only for narrow,
 *         single-facet dev/testnet iteration on the curated set above.
 *
 * Env vars: DEPLOYER_PRIVATE_KEY, DIAMOND_ADDRESS
 *
 * Usage:
 *   forge script script/RedeployFacets.s.sol \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast -vvv
 */
contract RedeployFacets is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        // Read from deployments/<chain>/addresses.json with chain-prefixed
        // env fallback. Replaces the previous unprefixed `DIAMOND_ADDRESS`
        // env which was inconsistent with sibling scripts and risked
        // broadcasting against the wrong Diamond if env state was stale.
        address diamond = Deployments.readDiamond();

        console.log("Diamond:", diamond);

        vm.startBroadcast(deployerKey);

        RiskFacet riskFacet = new RiskFacet();
        // #658 — the split liquidation path (triggerLiquidationSplit) got the
        // SAME eager-consolidation + post-withdraw VPFI-restamp wiring as the
        // RiskFacet liquidation entries, so refresh it together with RiskFacet
        // to avoid a half-applied liquidation family (new RiskFacet + stale
        // split path) on a curated redeploy.
        RiskSplitLiquidationFacet riskSplitLiquidationFacet =
            new RiskSplitLiquidationFacet();
        DefaultedFacet defaultedFacet = new DefaultedFacet();
        LoanFacet loanFacet = new LoanFacet();
        PrecloseFacet precloseFacet = new PrecloseFacet();
        EarlyWithdrawalFacet earlyWithdrawalFacet = new EarlyWithdrawalFacet();
        // #658 PR-B2 — refinance gained the lender-side eager-consolidation hook
        // (cross-calls ConsolidationFacet, like precloseDirect). Refresh it
        // alongside Preclose so a curated redeploy doesn't leave refinance on
        // stale bytecode that skips the consolidation while preclose applies it.
        RefinanceFacet refinanceFacet = new RefinanceFacet();
        ProfileFacet profileFacet = new ProfileFacet();
        // #658 — the refreshed RiskFacet liquidation paths cross-call
        // ConsolidationFacet's eager-consolidation + post-withdraw VPFI-restamp
        // entries. Those selectors are NEW (added in #658), so a curated
        // RiskFacet-only refresh would leave the upgraded RiskFacet calling
        // unrouted selectors and bubble a revert mid-liquidation. Redeploy
        // ConsolidationFacet alongside and cut its selectors (Replace the two
        // pre-existing #594 standalone entries, Add the three new #658 ones —
        // partitioned by live routing, same as the #394 HF-floor knob).
        ConsolidationFacet consolidationFacet = new ConsolidationFacet();

        console.log("RiskFacet:            ", address(riskFacet));
        console.log("RiskSplitLiquidation: ", address(riskSplitLiquidationFacet));
        console.log("DefaultedFacet:       ", address(defaultedFacet));
        console.log("LoanFacet:            ", address(loanFacet));
        console.log("PrecloseFacet:        ", address(precloseFacet));
        console.log("EarlyWithdrawalFacet: ", address(earlyWithdrawalFacet));
        console.log("RefinanceFacet:       ", address(refinanceFacet));
        console.log("ProfileFacet:         ", address(profileFacet));
        console.log("ConsolidationFacet:   ", address(consolidationFacet));

        // #394 (Codex #647 rounds 5+7) — the runtime HF-floor knob selectors
        // need an Add on a PRE-#394 diamond (not yet routed → Replace reverts on
        // a zero old facet) but a Replace on a SAME-VERSION diamond (already
        // routed → Add reverts as "exists"). A static choice can't serve both,
        // so partition them by the live diamond's routing via the loupe: Add the
        // unrouted, Replace the already-routed. This makes the script correct
        // against any target diamond.
        (bytes4[] memory hfToAdd, bytes4[] memory hfToReplace) =
            _partitionByRouting(diamond, _riskAddSelectors());
        // #658 — same Add/Replace-by-routing split for the ConsolidationFacet
        // selector set: on a current-version diamond the two #594 standalone
        // entries are already routed (Replace) and the three #658 entries are
        // new (Add); on a pre-#594 diamond all five would be new (Add).
        (bytes4[] memory consToAdd, bytes4[] memory consToReplace) =
            _partitionByRouting(diamond, _consolidationSelectors());

        uint256 nExtra =
            (hfToAdd.length > 0 ? 1 : 0) + (hfToReplace.length > 0 ? 1 : 0) +
            (consToAdd.length > 0 ? 1 : 0) + (consToReplace.length > 0 ? 1 : 0);
        IDiamondCut.FacetCut[] memory cuts =
            new IDiamondCut.FacetCut[](8 + nExtra);
        cuts[0] = _replace(address(riskFacet), _riskSelectors());
        cuts[1] = _replace(address(defaultedFacet), _defaultedSelectors());
        cuts[2] = _replace(address(loanFacet), _loanSelectors());
        cuts[3] = _replace(address(precloseFacet), _precloseSelectors());
        cuts[4] = _replace(address(earlyWithdrawalFacet), _earlyWithdrawalSelectors());
        cuts[5] = _replace(address(profileFacet), _profileSelectors());
        // #658 — triggerLiquidationSplit is already routed on a current diamond
        // (relocated to RiskSplitLiquidationFacet in #66/#633), so a plain
        // Replace repoints it to the refreshed bytecode.
        cuts[6] = _replace(address(riskSplitLiquidationFacet), _riskSplitSelectors());
        // #658 PR-B2 — refinance selectors are already routed on a current
        // diamond, so a plain Replace repoints them to the consolidation-aware
        // bytecode.
        cuts[7] = _replace(address(refinanceFacet), _refinanceSelectors());
        uint256 idx = 8;
        if (hfToReplace.length > 0) {
            cuts[idx++] = _replace(address(riskFacet), hfToReplace);
        }
        if (hfToAdd.length > 0) {
            cuts[idx++] = _add(address(riskFacet), hfToAdd);
        }
        if (consToReplace.length > 0) {
            cuts[idx++] = _replace(address(consolidationFacet), consToReplace);
        }
        if (consToAdd.length > 0) {
            cuts[idx++] = _add(address(consolidationFacet), consToAdd);
        }

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        console.log("DiamondCut applied: 8 facets replaced + ConsolidationFacet.");
        console.log("  HF selectors added:   ", hfToAdd.length);
        console.log("  HF selectors replaced:", hfToReplace.length);
        console.log("  Cons selectors added: ", consToAdd.length);
        console.log("  Cons selectors repl.: ", consToReplace.length);
    }

    function _replace(address facet, bytes4[] memory selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: selectors
        });
    }

    /// @dev #394 (Codex #647 round-5) — Add cut for brand-new selectors not yet
    ///      routed on the target diamond (Replace would revert on a zero old facet).
    function _add(address facet, bytes4[] memory selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    /// @dev #394 (Codex #647 round-7) — split `selectors` into those NOT yet
    ///      routed on `diamond` (need Add) and those already routed (need
    ///      Replace), using the loupe's `facetAddress` (returns `address(0)`
    ///      for an unrouted selector). Lets one script serve both a pre-#394
    ///      diamond (selectors new) and a same-version diamond (selectors
    ///      present) without `Add`/`Replace` reverting on the wrong one.
    function _partitionByRouting(address diamond, bytes4[] memory selectors)
        internal
        view
        returns (bytes4[] memory toAdd, bytes4[] memory toReplace)
    {
        bool[] memory routed = new bool[](selectors.length);
        uint256 addN;
        uint256 replN;
        for (uint256 i; i < selectors.length; i++) {
            routed[i] =
                IDiamondLoupe(diamond).facetAddress(selectors[i]) != address(0);
            if (routed[i]) replN++;
            else addN++;
        }
        toAdd = new bytes4[](addN);
        toReplace = new bytes4[](replN);
        uint256 a;
        uint256 r;
        for (uint256 i; i < selectors.length; i++) {
            if (routed[i]) toReplace[r++] = selectors[i];
            else toAdd[a++] = selectors[i];
        }
    }

    // ── Selector arrays (mirror DeployDiamond.s.sol) ────────────────────

    function _riskSelectors() internal pure returns (bytes4[] memory s) {
        // Mirrors `DeployDiamond._getRiskFacetSelectors` (kept in lockstep).
        // Was stale at 5 — missing the #395 partial/discounted liquidators and
        // the #394 runtime HF-floor knob (Codex #647 round-4), so a same-version
        // testnet redeploy through this script silently dropped routing for
        // `setMinHealthFactor`/`getMinHealthFactor` and governance could not use
        // the no-redeploy risk-appetite knob. Now the full 9.
        // NOTE: this `Replace` assumes the target diamond was deployed with the
        // current `DeployDiamond` (all 9 already routed) — the realistic
        // pre-live / testnet flow. Cross-version upgrades of a PRE-#394 diamond
        // (where the last 2 are genuinely new and need an `Add`, not `Replace`)
        // are handled by the comprehensive deploy-modernization track, not this
        // same-version bytecode-refresh script.
        // The 7 selectors a pre-#394 (post-#395) diamond already routes — safe
        // to Replace. The two #394 HF-floor selectors are NEW and go through
        // `_riskAddSelectors()` (an Add cut) instead — see the cut wiring above.
        s = new bytes4[](7);
        s[0] = RiskFacet.updateRiskParams.selector;
        s[1] = RiskFacet.calculateLTV.selector;
        s[2] = RiskFacet.calculateHealthFactor.selector;
        s[3] = RiskFacet.isCollateralValueCollapsed.selector;
        s[4] = RiskFacet.triggerLiquidation.selector;
        s[5] = RiskFacet.triggerPartialLiquidation.selector;
        s[6] = RiskFacet.triggerLiquidationDiscounted.selector;
    }

    /// @dev #394 (Codex #647 round-5) — the runtime HF-floor knob selectors,
    ///      ADDED (not Replaced) because they don't exist on a pre-#394 diamond.
    function _riskAddSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = RiskFacet.setMinHealthFactor.selector;
        s[1] = RiskFacet.getMinHealthFactor.selector;
    }

    /// @dev #658 — RiskSplitLiquidationFacet's single selector, mirrors
    ///      `DeployDiamond._getRiskSplitLiquidationSelectors`.
    function _riskSplitSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = RiskSplitLiquidationFacet.triggerLiquidationSplit.selector;
    }

    function _defaultedSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = DefaultedFacet.triggerDefault.selector;
        s[1] = DefaultedFacet.isLoanDefaultable.selector;
    }

    function _loanSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = LoanFacet.initiateLoan.selector;
        s[1] = LoanFacet.getLoanDetails.selector;
        s[2] = LoanFacet.getLoanConsents.selector;
    }

    function _precloseSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = PrecloseFacet.precloseDirect.selector;
        s[1] = PrecloseFacet.offsetWithNewOffer.selector;
        s[2] = PrecloseFacet.completeOffset.selector;
        s[3] = PrecloseFacet.transferObligationViaOffer.selector;
    }

    function _earlyWithdrawalSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = EarlyWithdrawalFacet.sellLoanViaBuyOffer.selector;
        s[1] = EarlyWithdrawalFacet.createLoanSaleOffer.selector;
        s[2] = EarlyWithdrawalFacet.completeLoanSale.selector;
    }

    /// @dev #658 PR-B2 — RefinanceFacet selectors, mirrors
    ///      `DeployDiamond._getRefinanceSelectors` (kept in lockstep).
    function _refinanceSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = RefinanceFacet.refinanceLoan.selector;
        s[1] = RefinanceFacet.refinanceLoanFromAccept.selector;
    }

    function _profileSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](15);
        s[0] = ProfileFacet.updateKYCStatus.selector;
        s[1] = ProfileFacet.getUserCountry.selector;
        s[2] = ProfileFacet.isKYCVerified.selector;
        s[3] = ProfileFacet.setTradeAllowance.selector;
        s[4] = ProfileFacet.setUserCountry.selector;
        s[5] = ProfileFacet.updateKYCTier.selector;
        s[6] = ProfileFacet.getKYCTier.selector;
        s[7] = ProfileFacet.meetsKYCRequirement.selector;
        s[8] = ProfileFacet.updateKYCThresholds.selector;
        s[9] = ProfileFacet.getKYCThresholds.selector;
        s[10] = ProfileFacet.setKeeperAccess.selector;
        s[11] = ProfileFacet.getKeeperAccess.selector;
        s[12] = ProfileFacet.approveKeeper.selector;
        s[13] = ProfileFacet.revokeKeeper.selector;
        s[14] = ProfileFacet.getApprovedKeepers.selector;
    }

    /// @dev #658 — full ConsolidationFacet selector set, mirrors
    ///      `DeployDiamond._getConsolidationFacetSelectors` (kept in lockstep).
    ///      Indices 0-1 are the #594 standalone holder entries (already routed
    ///      on a current diamond → Replace); 2-4 are the #658 internal-only
    ///      eager + post-withdraw-restamp entries the refreshed RiskFacet now
    ///      cross-calls (new → Add). `_partitionByRouting` sorts them by live
    ///      routing so this is correct against any target diamond version.
    function _consolidationSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = ConsolidationFacet.consolidateCollateralToHolder.selector;
        s[1] = ConsolidationFacet.consolidatePrincipalToHolder.selector;
        s[2] = ConsolidationFacet.eagerConsolidateToHolder.selector;
        s[3] = ConsolidationFacet.eagerConsolidateBothSides.selector;
        s[4] = ConsolidationFacet.restampCollateralVpfiAfterWithdraw.selector;
    }
}
