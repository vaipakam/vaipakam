// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {Deployments} from "./lib/Deployments.sol";
import {FacetSelectors} from "./lib/FacetSelectors.sol";

/**
 * @title ReplaceStaleFacets
 * @notice Redeploys OfferFacet, OracleFacet and VaultFactoryFacet and Replaces
 *         every selector they own. Targets the createOffer failure surfacing
 *         `CrossFacetCallFailed(string)` (0x573c3147) on Sepolia — that legacy
 *         error is only reachable through the non-typed `LibRevert.bubbleOnFailure`
 *         path, which current source no longer uses. Replacing these three
 *         facets with freshly-compiled bytecode removes any pre-refactor copy
 *         left on chain.
 *
 * Env vars: DEPLOYER_PRIVATE_KEY, DIAMOND_ADDRESS
 *
 * Usage:
 *   forge script script/ReplaceStaleFacets.s.sol \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast -vvv
 */
contract ReplaceStaleFacets is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        // Same env-var-prefix normalisation as RedeployFacets — read
        // from deployments/<chain>/addresses.json with chain-prefixed
        // env fallback rather than the bare DIAMOND_ADDRESS.
        address diamond = Deployments.readDiamond();

        console.log("Diamond:", diamond);

        vm.startBroadcast(deployerKey);

        OfferCreateFacet offerCreateFacet = new OfferCreateFacet();
        OfferAcceptFacet offerAcceptFacet = new OfferAcceptFacet();
        OracleFacet oracleFacet = new OracleFacet();
        VaultFactoryFacet vaultFactoryFacet = new VaultFactoryFacet();
        ConfigFacet configFacet = new ConfigFacet();
        OracleAdminFacet oracleAdminFacet = new OracleAdminFacet();
        // #394 (Codex #647 round-3) — the numeraire / PAD / periodic-interest
        // selectors were carved out of ConfigFacet into NumeraireConfigFacet.
        // They must be cut to THIS facet's address, not ConfigFacet's, or they
        // misroute to ConfigFacet bytecode that no longer implements them.
        NumeraireConfigFacet numeraireConfigFacet = new NumeraireConfigFacet();

        console.log("OfferFacet:          ", address(offerCreateFacet));
        console.log("OracleFacet:         ", address(oracleFacet));
        console.log("VaultFactoryFacet:  ", address(vaultFactoryFacet));
        console.log("ConfigFacet:         ", address(configFacet));
        console.log("NumeraireConfigFacet:", address(numeraireConfigFacet));
        console.log("OracleAdminFacet:    ", address(oracleAdminFacet));

        // T-068: RewardReporterFacet is intentionally NOT refreshed here.
        // The LayerZero→CCIP migration changed its selector SET (removed
        // `setLocalEid`, renamed `setBaseEid`→`setBaseChainId`), and a
        // `Replace` cut cannot migrate a facet whose selector set changed
        // — that needs a Remove(old) + Add(new) migration, which a live
        // pre-T-068 diamond gets via the dedicated CCIP deploy/migration
        // path, not this one-off bytecode-refresh script.

        // RL-1 (Codex #1302 P2) — the shared `FacetSelectors.vaultFactory()`
        // list now grows over time (it gained `vaultCreditFromDiamondERC20`),
        // and a blanket `Replace` of the full list reverts on any diamond
        // that doesn't route a newly-added selector yet. Partition by live
        // routing (the `RedeployFacets` pattern) so routed selectors get a
        // Replace and not-yet-routed ones get an Add — the script stays
        // correct for every future addition to the shared list.
        (bytes4[] memory vfAdd, bytes4[] memory vfReplace) =
            _partitionByRouting(diamond, _vaultFactorySelectors());

        // #1352 (Codex P2) — the offer-accept "missing" list now mixes
        // already-routed selectors (`calculateTransactionValueNumeraire` /
        // `verifyAndBindAccept`, live since #627/#662) with a genuinely-new one
        // (`chargeBorrowerLifAndDeliver`, the HoldOnly LIF self-call target). A
        // blanket `Add` of the whole list reverts on any diamond that already
        // routes the first two (`LibDiamond.addFunctions` rejects a routed
        // selector). Partition by live routing exactly like the VaultFactory
        // path: already-routed missing selectors fold into the offer-accept
        // Replace (re-point them at the fresh bytecode), only the unrouted ones
        // get an Add — kept as a conditional tail so an empty Add never reverts.
        (bytes4[] memory oaAdd, bytes4[] memory oaReplace) =
            _partitionByRouting(diamond, _offerAcceptMissingSelectors());

        // 9 base cuts + one conditional tail Add per non-empty {vfAdd, oaAdd}:
        //   3 Replace (OfferCreate / Oracle / VaultFactory bytecode refresh)
        //   1 Replace + 1 Add (ConfigFacet — existing + protocol-console knobs)
        //   1 Add (NumeraireConfigFacet — numeraire/PAD/periodic selectors)
        //   1 Replace + 1 Add (OracleAdminFacet — existing + Pyth/admin getters)
        //   1 Replace (OfferAcceptFacet — base + already-routed new selectors)
        //   [+1 Add] (VaultFactoryFacet — selectors not routed yet)
        //   [+1 Add] (OfferAcceptFacet — genuinely-new selectors not routed yet)
        uint256 tailCount =
            (vfAdd.length > 0 ? 1 : 0) + (oaAdd.length > 0 ? 1 : 0);
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](
            9 + tailCount
        );
        cuts[0] = _replace(address(offerCreateFacet), _offerCreateSelectors());
        cuts[1] = _replace(address(oracleFacet), _oracleSelectors());
        cuts[2] = _replace(address(vaultFactoryFacet), vfReplace);
        cuts[3] = _replace(address(configFacet), _configFacetExistingSelectors());
        cuts[4] = _add(address(configFacet), _configFacetMissingSelectors());
        cuts[5] = _replace(address(oracleAdminFacet), _oracleAdminExistingSelectors());
        cuts[6] = _add(address(oracleAdminFacet), _oracleAdminMissingSelectors());
        // Re-point the offer-accept base selectors AND any already-routed new
        // selectors at the fresh bytecode in one Replace.
        cuts[7] = _replace(
            address(offerAcceptFacet),
            _concat(_offerAcceptSelectors(), oaReplace)
        );
        // #394 (Codex #647 round-3) — Add the carved-out numeraire/PAD/periodic
        // selectors to the NumeraireConfigFacet address (NOT ConfigFacet).
        cuts[8] = _add(address(numeraireConfigFacet), _getNumeraireConfigSelectors());
        uint256 t = 9;
        if (vfAdd.length > 0) {
            cuts[t++] = _add(address(vaultFactoryFacet), vfAdd);
        }
        // #627 / #1352 — the genuinely-unrouted offer-accept selectors (KYC-value
        // view + HoldOnly LIF self-call target). A Replace would revert on these
        // (not yet routed); Add is correct.
        if (oaAdd.length > 0) {
            cuts[t++] = _add(address(offerAcceptFacet), oaAdd);
        }

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        console.log(
            "DiamondCut applied: facets replaced; missing selectors added (VF + offer-accept):",
            vfAdd.length + oaAdd.length
        );
    }

    /// @dev Concatenate two selector lists (base Replace set + already-routed
    ///      new selectors) into one Replace cut.
    function _concat(bytes4[] memory a, bytes4[] memory b)
        internal
        pure
        returns (bytes4[] memory out)
    {
        out = new bytes4[](a.length + b.length);
        for (uint256 i; i < a.length; i++) {
            out[i] = a[i];
        }
        for (uint256 j; j < b.length; j++) {
            out[a.length + j] = b[j];
        }
    }

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

    /// @dev RL-1 (Codex #1302 P2) — split `selectors` into the subset the
    ///      live diamond already routes (safe to Replace) and the subset it
    ///      doesn't (must be Add — a Replace of an unrouted selector
    ///      reverts). Mirrors `RedeployFacets._partitionByRouting`.
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

    function _offerCreateSelectors() internal pure returns (bytes4[] memory s) {
        // OfferFacet split into OfferCreateFacet / OfferAcceptFacet
        // (Issue #67). This MUST mirror `DeployDiamond._getOfferCreateSelectors()`
        // in full — a `Replace` cut that moves only a subset would leave
        // the unlisted selectors (createOfferWithPermit / createOfferInternal)
        // pointed at the old facet, splitting the diamond across stale and
        // new code. cancelOffer / getCompatibleOffers / getOffer are on
        // OfferCancelFacet — refresh those via a sibling cut if needed.
        s = new bytes4[](4);
        s[0] = OfferCreateFacet.createOffer.selector;
        s[1] = OfferCreateFacet.getUserVault.selector;
        s[2] = OfferCreateFacet.createOfferWithPermit.selector;
        s[3] = OfferCreateFacet.createOfferInternal.selector;
    }

    /// @dev The OfferAccept selectors already routed on a live diamond (the
    ///      original 3 + `previewAccept` from #196, all in
    ///      `DeployDiamond._getOfferAcceptSelectors()`) — Replace them onto the
    ///      fresh bytecode. The brand-new `calculateTransactionValueNumeraire`
    ///      (#627) is NOT yet routed, so it goes in the sibling Add cut
    ///      ({_offerAcceptMissingSelectors}) — a Replace of an unrouted selector
    ///      would revert.
    function _offerAcceptSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = OfferAcceptFacet.acceptOffer.selector;
        s[1] = OfferAcceptFacet.acceptOfferWithPermit.selector;
        s[2] = OfferAcceptFacet.acceptOfferInternal.selector;
        // #980 — `previewAccept` moved to the new `OfferPreviewFacet`. A facet
        // MOVE is not a Replace on OfferAcceptFacet, and adding a brand-new facet
        // is a fresh-deploy concern (DeployDiamond routes OfferPreviewFacet), so
        // the selector deliberately leaves this curated replace list.
    }

    /// @dev OfferAccept selectors introduced after the live diamond was cut, so
    ///      they need an Add (not a Replace). #627: the public KYC-value view.
    ///      #662: `verifyAndBindAccept` (the gated cross-facet hop SignedOfferFacet
    ///      uses) — brand-new. (The EIP-712 digest is computed off-chain; the
    ///      `hashAcceptTerms` view was removed for EIP-170 headroom, #730.)
    ///
    ///      NOTE (#662 selector changes): `acceptOffer`'s signature changed from
    ///      `(uint256,bool)` to `(uint256,AcceptTerms,bytes)`, a DIFFERENT 4-byte
    ///      selector — and likewise `SignedOfferFacet.acceptSignedOffer` /
    ///      `acceptSignedOfferWithPermit` (now carrying `(AcceptTerms,bytes)`).
    ///      A true live refresh would Remove each old selector + Add the new one
    ///      (and SignedOfferFacet is not even scoped by this script — a
    ///      pre-existing gap, it predates #662). Pre-live (no production diamond
    ///      — see CLAUDE.md) the canonical path is a fresh `DeployDiamond` (whose
    ///      `_getOfferAcceptSelectors` + `_getSignedOfferSelectors` use `.selector`
    ///      and so already route the NEW selectors), and this refresh script is
    ///      regenerated at the first real deploy (Codex #724 r2 P2).
    function _offerAcceptMissingSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](3);
        s[0] = OfferAcceptFacet.calculateTransactionValueNumeraire.selector;
        s[1] = OfferAcceptFacet.verifyAndBindAccept.selector;
        // #1352 (Codex P2) — the HoldOnly LIF charge is a cross-facet self-call
        // to this new external selector. A stale-facet Replace that swaps in
        // the new accept bytecode WITHOUT routing this selector would revert
        // every fresh ERC-20 non-sale accept at the LIF delivery step.
        s[2] = OfferAcceptFacet.chargeBorrowerLifAndDeliver.selector;
    }

    /// @dev #778 — a Replace cut MUST carry the facet's FULL selector surface;
    ///      the prior 4-of-18 hand-list would leave 14 selectors on stale
    ///      bytecode. Sourced from the shared {FacetSelectors} single source
    ///      (parity-tested against the compiled ABI).
    function _oracleSelectors() internal pure returns (bytes4[] memory) {
        return FacetSelectors.oracle();
    }

    /// @dev The 28 ConfigFacet selectors currently registered on the
    ///      live diamond (25 from initial DeployDiamond + 3 from the
    ///      first ReplaceStaleFacets Add). Replace targets a fresh
    ///      ConfigFacet bytecode for consolidation.
    function _configFacetExistingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](26);
        s[0] = ConfigFacet.setFeesConfig.selector;
        s[1] = ConfigFacet.setLiquidationConfig.selector;
        s[2] = ConfigFacet.setRiskConfig.selector;
        // #687-B: setStakingApr (was [3]) / getStakingAprBps (was [10]) removed
        // with the 5% staking yield; tail entries fill the freed slots.
        s[3] = ConfigFacet.getLoanInitiationFeeBps.selector;
        s[4] = ConfigFacet.setVpfiTierThresholds.selector;
        s[5] = ConfigFacet.setVpfiTierDiscountBps.selector;
        s[6] = ConfigFacet.setFallbackSplit.selector;
        s[7] = ConfigFacet.getFeesConfig.selector;
        s[8] = ConfigFacet.getLiquidationConfig.selector;
        s[9] = ConfigFacet.getRiskConfig.selector;
        s[10] = ConfigFacet.getLifMatcherFeeBps.selector; // #687-B: reused (was getStakingAprBps)
        s[11] = ConfigFacet.getFallbackSplit.selector;
        s[12] = ConfigFacet.getVpfiTierThresholds.selector;
        s[13] = ConfigFacet.getVpfiTierDiscountBps.selector;
        s[14] = ConfigFacet.getProtocolConfigBundle.selector;
        s[15] = ConfigFacet.getProtocolConstants.selector;
        s[16] = ConfigFacet.setRangeAmountEnabled.selector;
        s[17] = ConfigFacet.setRangeRateEnabled.selector;
        s[18] = ConfigFacet.setPartialFillEnabled.selector;
        s[19] = ConfigFacet.getMasterFlags.selector;
        s[20] = ConfigFacet.setLifMatcherFeeBps.selector;
        s[21] = ConfigFacet.setAutoPauseDurationSeconds.selector;
        s[22] = ConfigFacet.setMaxOfferDurationDays.selector;
        s[23] = ConfigFacet.setNotificationFee.selector;
        s[24] = ConfigFacet.getNotificationFeeConfig.selector;
        s[25] = ConfigFacet.getTreasuryFeeBps.selector;
        // #687-B: former [26] getLoanInitiationFeeBps + [27] getLifMatcherFeeBps
        // relocated into the slots freed by the removed staking selectors.
    }

    /// @dev The 27 ConfigFacet selectors NOT yet registered on the
    ///      live diamond (master-flag single getters + Numeraire/PAD/
    ///      grace/periodic-interest knobs that the protocol console
    ///      reads). Add cut points at the same fresh ConfigFacet
    ///      bytecode used in the Replace cut above.
    function _configFacetMissingSelectors() internal pure returns (bytes4[] memory s) {
        // ONLY the selectors ConfigFacet still implements post-split. The
        // numeraire / PAD / periodic-interest selectors moved out and are
        // cut to NumeraireConfigFacet's address via
        // `_getNumeraireConfigSelectors()` (see cuts[9]); routing them to
        // ConfigFacet here would misroute to bytecode that no longer
        // implements them (Codex #647 round-3).
        s = new bytes4[](8);
        s[0] = ConfigFacet.getRangeAmountEnabled.selector;
        s[1] = ConfigFacet.getRangeRateEnabled.selector;
        s[2] = ConfigFacet.getPartialFillEnabled.selector;
        s[3] = ConfigFacet.clearGraceBuckets.selector;
        s[4] = ConfigFacet.setGraceBuckets.selector;
        s[5] = ConfigFacet.getGraceBuckets.selector;
        s[6] = ConfigFacet.getEffectiveGraceSeconds.selector;
        s[7] = ConfigFacet.getGraceSlotBounds.selector;
    }

    /// @dev #394 (Codex #647 round-3) — the 19 numeraire / PAD /
    ///      periodic-interest selectors carved out of ConfigFacet into
    ///      `NumeraireConfigFacet`. Added to the NumeraireConfigFacet address
    ///      so a live pre-split diamond routes them to bytecode that
    ///      implements them. Mirrors `DeployDiamond._getNumeraireConfigSelectors`.
    function _getNumeraireConfigSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](19);
        s[0] = NumeraireConfigFacet.setNumeraire.selector;
        s[1] = NumeraireConfigFacet.setMinPrincipalForFinerCadence.selector;
        s[2] = NumeraireConfigFacet.setPreNotifyDays.selector;
        s[3] = NumeraireConfigFacet.setPeriodicInterestEnabled.selector;
        s[4] = NumeraireConfigFacet.setNumeraireSwapEnabled.selector;
        s[5] = NumeraireConfigFacet.getPeriodicInterestConfig.selector;
        s[6] = NumeraireConfigFacet.getNumeraireSymbol.selector;
        s[7] = NumeraireConfigFacet.getEthNumeraireFeed.selector;
        s[8] = NumeraireConfigFacet.getMinPrincipalForFinerCadence.selector;
        s[9] = NumeraireConfigFacet.getPreNotifyDays.selector;
        s[10] = NumeraireConfigFacet.getPeriodicInterestEnabled.selector;
        s[11] = NumeraireConfigFacet.getNumeraireSwapEnabled.selector;
        s[12] = NumeraireConfigFacet.setPredominantDenominator.selector;
        s[13] = NumeraireConfigFacet.setAssetNumeraireDirectFeedOverride.selector;
        s[14] = NumeraireConfigFacet.getPredominantDenominator.selector;
        s[15] = NumeraireConfigFacet.getPredominantDenominatorSymbol.selector;
        s[16] = NumeraireConfigFacet.getEthPadFeed.selector;
        s[17] = NumeraireConfigFacet.getPadNumeraireRateFeed.selector;
        s[18] = NumeraireConfigFacet.getAssetNumeraireDirectFeedOverride.selector;
    }

    /// @dev The 20 OracleAdminFacet selectors registered on the live
    ///      diamond by the initial DeployDiamond run.
    function _oracleAdminExistingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](20);
        s[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        s[1] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        s[2] = OracleAdminFacet.setEthUsdFeed.selector;
        s[3] = OracleAdminFacet.setSequencerUptimeFeed.selector;
        s[4] = OracleAdminFacet.setStableTokenFeed.selector;
        s[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        s[6] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        s[7] = OracleAdminFacet.setWethContract.selector;
        s[8] = OracleAdminFacet.setApi3ServerV1.selector;
        s[9] = OracleAdminFacet.setDIAOracleV2.selector;
        s[10] = OracleAdminFacet.setTellorOracle.selector;
        s[11] = OracleAdminFacet.setFeedOverride.selector;
        s[12] = OracleAdminFacet.setSecondaryOracleMaxDeviationBps.selector;
        s[13] = OracleAdminFacet.setSecondaryOracleMaxStaleness.selector;
        s[14] = OracleAdminFacet.getApi3ServerV1.selector;
        s[15] = OracleAdminFacet.getDIAOracleV2.selector;
        s[16] = OracleAdminFacet.getTellorOracle.selector;
        s[17] = OracleAdminFacet.getFeedOverride.selector;
        s[18] = OracleAdminFacet.getSecondaryOracleMaxDeviationBps.selector;
        s[19] = OracleAdminFacet.getSecondaryOracleMaxStaleness.selector;
    }

    /// @dev The 10 OracleAdminFacet selectors NOT yet registered (Pyth
    ///      cross-check oracle setters + 5 individual getters). Add
    ///      cut points at the fresh OracleAdminFacet bytecode.
    function _oracleAdminMissingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](10);
        s[0] = OracleAdminFacet.setPythOracle.selector;
        s[1] = OracleAdminFacet.setPythCrossCheckFeedId.selector;
        s[2] = OracleAdminFacet.setPythMaxStalenessSeconds.selector;
        s[3] = OracleAdminFacet.setPythCrossCheckMaxDeviationBps.selector;
        s[4] = OracleAdminFacet.setPythConfidenceMaxBps.selector;
        s[5] = OracleAdminFacet.getPythOracle.selector;
        s[6] = OracleAdminFacet.getPythNumeraireFeedId.selector;
        s[7] = OracleAdminFacet.getPythMaxStalenessSeconds.selector;
        s[8] = OracleAdminFacet.getPythNumeraireMaxDeviationBps.selector;
        s[9] = OracleAdminFacet.getPythConfidenceMaxBps.selector;
    }

    // RewardReporterFacet selector helpers removed (T-068) — see the
    // note in `run()`: the eid→chainId migration changed the facet's
    // selector set, so a `Replace`-based refresh no longer applies.

    /// @dev #778 — the prior hand-list carried only 27 of the facet's 31
    ///      selectors (omitting e.g. `vaultSetNFTUser1155`,
    ///      `getVaultVersionInfo`), so a Replace cut left the rest on stale
    ///      bytecode. Sourced from the shared {FacetSelectors} single source
    ///      (parity-tested against the compiled ABI).
    function _vaultFactorySelectors() internal pure returns (bytes4[] memory) {
        return FacetSelectors.vaultFactory();
    }
}
