// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title RedeployFacets
 * @notice Redeploys the six facets modified for README §3 compliance
 *         (role-scoped keeper model, dynamic liquidator incentive, and
 *         2% treasury liquidation handling fee) and diamond-cuts every
 *         selector to the new implementation via Replace.
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
        DefaultedFacet defaultedFacet = new DefaultedFacet();
        LoanFacet loanFacet = new LoanFacet();
        PrecloseFacet precloseFacet = new PrecloseFacet();
        EarlyWithdrawalFacet earlyWithdrawalFacet = new EarlyWithdrawalFacet();
        ProfileFacet profileFacet = new ProfileFacet();

        console.log("RiskFacet:            ", address(riskFacet));
        console.log("DefaultedFacet:       ", address(defaultedFacet));
        console.log("LoanFacet:            ", address(loanFacet));
        console.log("PrecloseFacet:        ", address(precloseFacet));
        console.log("EarlyWithdrawalFacet: ", address(earlyWithdrawalFacet));
        console.log("ProfileFacet:         ", address(profileFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](7);
        cuts[0] = _replace(address(riskFacet), _riskSelectors());
        cuts[1] = _replace(address(defaultedFacet), _defaultedSelectors());
        cuts[2] = _replace(address(loanFacet), _loanSelectors());
        cuts[3] = _replace(address(precloseFacet), _precloseSelectors());
        cuts[4] = _replace(address(earlyWithdrawalFacet), _earlyWithdrawalSelectors());
        cuts[5] = _replace(address(profileFacet), _profileSelectors());
        // #394 (Codex #647 round-5) — the runtime HF-floor knob selectors are
        // NEW (not on a pre-#394 diamond), so they must be ADDED, not Replaced.
        // `LibDiamond.replaceFunctions` reverts when the old facet address is
        // zero, so folding them into the Replace above would brick this upgrade
        // before governance could expose the knob.
        cuts[6] = _add(address(riskFacet), _riskAddSelectors());

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        console.log("DiamondCut applied: 6 facets replaced + 2 risk selectors added.");
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
}
