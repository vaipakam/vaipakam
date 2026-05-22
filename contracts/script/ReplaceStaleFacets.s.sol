// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

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

        console.log("OfferFacet:          ", address(offerCreateFacet));
        console.log("OracleFacet:         ", address(oracleFacet));
        console.log("VaultFactoryFacet:  ", address(vaultFactoryFacet));
        console.log("ConfigFacet:         ", address(configFacet));
        console.log("OracleAdminFacet:    ", address(oracleAdminFacet));

        // T-068: RewardReporterFacet is intentionally NOT refreshed here.
        // The LayerZero→CCIP migration changed its selector SET (removed
        // `setLocalEid`, renamed `setBaseEid`→`setBaseChainId`), and a
        // `Replace` cut cannot migrate a facet whose selector set changed
        // — that needs a Remove(old) + Add(new) migration, which a live
        // pre-T-068 diamond gets via the dedicated CCIP deploy/migration
        // path, not this one-off bytecode-refresh script.

        // 7 cuts:
        //   3 Replace (Offer / Oracle / VaultFactory bytecode refresh)
        //   1 Replace + 1 Add (ConfigFacet — existing 28 selectors + 27 missing for protocol-console knobs)
        //   1 Replace + 1 Add (OracleAdminFacet — existing 20 + 10 missing Pyth/admin getters)
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](8);
        cuts[0] = _replace(address(offerCreateFacet), _offerCreateSelectors());
        cuts[7] = _replace(address(offerAcceptFacet), _offerAcceptSelectors());
        cuts[1] = _replace(address(oracleFacet), _oracleSelectors());
        cuts[2] = _replace(address(vaultFactoryFacet), _vaultFactorySelectors());
        cuts[3] = _replace(address(configFacet), _configFacetExistingSelectors());
        cuts[4] = _add(address(configFacet), _configFacetMissingSelectors());
        cuts[5] = _replace(address(oracleAdminFacet), _oracleAdminExistingSelectors());
        cuts[6] = _add(address(oracleAdminFacet), _oracleAdminMissingSelectors());

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        console.log("DiamondCut applied: 5 facets replaced + 37 missing selectors added.");
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

    function _offerAcceptSelectors() internal pure returns (bytes4[] memory s) {
        // Mirrors `DeployDiamond._getOfferAcceptSelectors()` in full —
        // refresh the whole accept surface (Permit2 accept + the
        // `matchOffers` internal entry), not just `acceptOffer`.
        s = new bytes4[](3);
        s[0] = OfferAcceptFacet.acceptOffer.selector;
        s[1] = OfferAcceptFacet.acceptOfferWithPermit.selector;
        s[2] = OfferAcceptFacet.acceptOfferInternal.selector;
    }

    function _oracleSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = OracleFacet.checkLiquidity.selector;
        s[1] = OracleFacet.getAssetPrice.selector;
        s[2] = OracleFacet.calculateLTV.selector;
        s[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
    }

    /// @dev The 28 ConfigFacet selectors currently registered on the
    ///      live diamond (25 from initial DeployDiamond + 3 from the
    ///      first ReplaceStaleFacets Add). Replace targets a fresh
    ///      ConfigFacet bytecode for consolidation.
    function _configFacetExistingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](28);
        s[0] = ConfigFacet.setFeesConfig.selector;
        s[1] = ConfigFacet.setLiquidationConfig.selector;
        s[2] = ConfigFacet.setRiskConfig.selector;
        s[3] = ConfigFacet.setStakingApr.selector;
        s[4] = ConfigFacet.setVpfiTierThresholds.selector;
        s[5] = ConfigFacet.setVpfiTierDiscountBps.selector;
        s[6] = ConfigFacet.setFallbackSplit.selector;
        s[7] = ConfigFacet.getFeesConfig.selector;
        s[8] = ConfigFacet.getLiquidationConfig.selector;
        s[9] = ConfigFacet.getRiskConfig.selector;
        s[10] = ConfigFacet.getStakingAprBps.selector;
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
        s[26] = ConfigFacet.getLoanInitiationFeeBps.selector;
        s[27] = ConfigFacet.getLifMatcherFeeBps.selector;
    }

    /// @dev The 27 ConfigFacet selectors NOT yet registered on the
    ///      live diamond (master-flag single getters + Numeraire/PAD/
    ///      grace/periodic-interest knobs that the protocol console
    ///      reads). Add cut points at the same fresh ConfigFacet
    ///      bytecode used in the Replace cut above.
    function _configFacetMissingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](27);
        s[0] = ConfigFacet.getRangeAmountEnabled.selector;
        s[1] = ConfigFacet.getRangeRateEnabled.selector;
        s[2] = ConfigFacet.getPartialFillEnabled.selector;
        s[3] = ConfigFacet.clearGraceBuckets.selector;
        s[4] = ConfigFacet.setGraceBuckets.selector;
        s[5] = ConfigFacet.getGraceBuckets.selector;
        s[6] = ConfigFacet.getEffectiveGraceSeconds.selector;
        s[7] = ConfigFacet.getGraceSlotBounds.selector;
        s[8] = ConfigFacet.setNumeraire.selector;
        s[9] = ConfigFacet.setMinPrincipalForFinerCadence.selector;
        s[10] = ConfigFacet.setPreNotifyDays.selector;
        s[11] = ConfigFacet.setPeriodicInterestEnabled.selector;
        s[12] = ConfigFacet.setNumeraireSwapEnabled.selector;
        s[13] = ConfigFacet.getPeriodicInterestConfig.selector;
        s[14] = ConfigFacet.getNumeraireSymbol.selector;
        s[15] = ConfigFacet.getEthNumeraireFeed.selector;
        s[16] = ConfigFacet.getMinPrincipalForFinerCadence.selector;
        s[17] = ConfigFacet.getPreNotifyDays.selector;
        s[18] = ConfigFacet.getPeriodicInterestEnabled.selector;
        s[19] = ConfigFacet.getNumeraireSwapEnabled.selector;
        s[20] = ConfigFacet.setPredominantDenominator.selector;
        s[21] = ConfigFacet.setAssetNumeraireDirectFeedOverride.selector;
        s[22] = ConfigFacet.getPredominantDenominator.selector;
        s[23] = ConfigFacet.getPredominantDenominatorSymbol.selector;
        s[24] = ConfigFacet.getEthPadFeed.selector;
        s[25] = ConfigFacet.getPadNumeraireRateFeed.selector;
        s[26] = ConfigFacet.getAssetNumeraireDirectFeedOverride.selector;
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

    function _vaultFactorySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](27);
        s[0] = VaultFactoryFacet.initializeVaultImplementation.selector;
        s[1] = VaultFactoryFacet.getOrCreateUserVault.selector;
        s[2] = VaultFactoryFacet.upgradeVaultImplementation.selector;
        s[3] = VaultFactoryFacet.vaultDepositERC20.selector;
        s[4] = VaultFactoryFacet.vaultWithdrawERC20.selector;
        s[5] = VaultFactoryFacet.vaultDepositERC721.selector;
        s[6] = VaultFactoryFacet.vaultWithdrawERC721.selector;
        s[7] = VaultFactoryFacet.vaultDepositERC1155.selector;
        s[8] = VaultFactoryFacet.vaultWithdrawERC1155.selector;
        s[9] = VaultFactoryFacet.vaultApproveNFT721.selector;
        s[10] = VaultFactoryFacet.vaultSetNFTUser.selector;
        s[11] = VaultFactoryFacet.vaultGetNFTUserOf.selector;
        s[12] = VaultFactoryFacet.vaultGetNFTUserExpires.selector;
        s[13] = VaultFactoryFacet.getOfferAmount.selector;
        s[14] = VaultFactoryFacet.getVaipakamVaultImplementationAddress.selector;
        s[15] = VaultFactoryFacet.getDiamondAddress.selector;
        s[16] = VaultFactoryFacet.setMandatoryVaultUpgrade.selector;
        s[17] = VaultFactoryFacet.upgradeUserVault.selector;
        // T-051 / T-054 — chokepoint deposit + counter-only companions
        // + stuck-token recovery EIP-712 surface.
        s[18] = VaultFactoryFacet.vaultDepositERC20From.selector;
        s[19] = VaultFactoryFacet.recordVaultDepositERC20.selector;
        s[20] = VaultFactoryFacet.getProtocolTrackedVaultBalance.selector;
        s[21] = VaultFactoryFacet.recoverStuckERC20.selector;
        s[22] = VaultFactoryFacet.disown.selector;
        s[23] = VaultFactoryFacet.recoveryDomainSeparator.selector;
        s[24] = VaultFactoryFacet.recoveryAckTextHash.selector;
        s[25] = VaultFactoryFacet.recoveryNonce.selector;
        s[26] = VaultFactoryFacet.vaultBannedSource.selector;
    }
}
