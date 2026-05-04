// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title ReplaceStaleFacets
 * @notice Redeploys OfferFacet, OracleFacet and EscrowFactoryFacet and Replaces
 *         every selector they own. Targets the createOffer failure surfacing
 *         `CrossFacetCallFailed(string)` (0x573c3147) on Sepolia — that legacy
 *         error is only reachable through the non-typed `LibRevert.bubbleOnFailure`
 *         path, which current source no longer uses. Replacing these three
 *         facets with freshly-compiled bytecode removes any pre-refactor copy
 *         left on chain.
 *
 * Env vars: PRIVATE_KEY, DIAMOND_ADDRESS
 *
 * Usage:
 *   forge script script/ReplaceStaleFacets.s.sol \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast -vvv
 */
contract ReplaceStaleFacets is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        // Same env-var-prefix normalisation as RedeployFacets — read
        // from deployments/<chain>/addresses.json with chain-prefixed
        // env fallback rather than the bare DIAMOND_ADDRESS.
        address diamond = Deployments.readDiamond();

        console.log("Diamond:", diamond);

        vm.startBroadcast(deployerKey);

        OfferFacet offerFacet = new OfferFacet();
        OracleFacet oracleFacet = new OracleFacet();
        EscrowFactoryFacet escrowFactoryFacet = new EscrowFactoryFacet();
        ConfigFacet configFacet = new ConfigFacet();
        OracleAdminFacet oracleAdminFacet = new OracleAdminFacet();
        RewardReporterFacet rewardReporterFacet = new RewardReporterFacet();

        console.log("OfferFacet:          ", address(offerFacet));
        console.log("OracleFacet:         ", address(oracleFacet));
        console.log("EscrowFactoryFacet:  ", address(escrowFactoryFacet));
        console.log("ConfigFacet:         ", address(configFacet));
        console.log("OracleAdminFacet:    ", address(oracleAdminFacet));
        console.log("RewardReporterFacet: ", address(rewardReporterFacet));

        // 9 cuts:
        //   3 Replace (Offer / Oracle / EscrowFactory bytecode refresh)
        //   1 Replace + 1 Add (ConfigFacet — existing 28 selectors + 27 missing for protocol-console knobs)
        //   1 Replace + 1 Add (OracleAdminFacet — existing 20 + 10 missing Pyth/admin getters)
        //   1 Replace + 1 Add (RewardReporterFacet — existing 11 + 1 missing getRewardGraceSeconds)
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](9);
        cuts[0] = _replace(address(offerFacet), _offerSelectors());
        cuts[1] = _replace(address(oracleFacet), _oracleSelectors());
        cuts[2] = _replace(address(escrowFactoryFacet), _escrowFactorySelectors());
        cuts[3] = _replace(address(configFacet), _configFacetExistingSelectors());
        cuts[4] = _add(address(configFacet), _configFacetMissingSelectors());
        cuts[5] = _replace(address(oracleAdminFacet), _oracleAdminExistingSelectors());
        cuts[6] = _add(address(oracleAdminFacet), _oracleAdminMissingSelectors());
        cuts[7] = _replace(address(rewardReporterFacet), _rewardReporterExistingSelectors());
        cuts[8] = _add(address(rewardReporterFacet), _rewardReporterMissingSelectors());

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        console.log("DiamondCut applied: 6 facets replaced + 38 missing selectors added.");
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

    function _offerSelectors() internal pure returns (bytes4[] memory s) {
        // Post-OfferFacet split: cancelOffer / getCompatibleOffers /
        // getOffer live on OfferCancelFacet now. This script targets
        // only what OfferFacet still owns; pair it with a sibling
        // ReplaceStaleFacets-style cut for OfferCancelFacet if those
        // selectors also need replacement.
        s = new bytes4[](3);
        s[0] = OfferFacet.createOffer.selector;
        s[1] = OfferFacet.acceptOffer.selector;
        s[2] = OfferFacet.getUserEscrow.selector;
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

    /// @dev The 11 RewardReporterFacet selectors registered on the
    ///      live diamond by the initial DeployDiamond run.
    function _rewardReporterExistingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](11);
        s[0] = RewardReporterFacet.closeDay.selector;
        s[1] = RewardReporterFacet.getChainReportSentAt.selector;
        s[2] = RewardReporterFacet.getKnownGlobalInterestNumeraire18.selector;
        s[3] = RewardReporterFacet.getLocalChainInterestNumeraire18.selector;
        s[4] = RewardReporterFacet.getRewardReporterConfig.selector;
        s[5] = RewardReporterFacet.onRewardBroadcastReceived.selector;
        s[6] = RewardReporterFacet.setBaseEid.selector;
        s[7] = RewardReporterFacet.setIsCanonicalRewardChain.selector;
        s[8] = RewardReporterFacet.setLocalEid.selector;
        s[9] = RewardReporterFacet.setRewardGraceSeconds.selector;
        s[10] = RewardReporterFacet.setRewardOApp.selector;
    }

    /// @dev The single missing RewardReporterFacet selector
    ///      (getRewardGraceSeconds — paired with the existing setter).
    function _rewardReporterMissingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = RewardReporterFacet.getRewardGraceSeconds.selector;
    }

    function _escrowFactorySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](27);
        s[0] = EscrowFactoryFacet.initializeEscrowImplementation.selector;
        s[1] = EscrowFactoryFacet.getOrCreateUserEscrow.selector;
        s[2] = EscrowFactoryFacet.upgradeEscrowImplementation.selector;
        s[3] = EscrowFactoryFacet.escrowDepositERC20.selector;
        s[4] = EscrowFactoryFacet.escrowWithdrawERC20.selector;
        s[5] = EscrowFactoryFacet.escrowDepositERC721.selector;
        s[6] = EscrowFactoryFacet.escrowWithdrawERC721.selector;
        s[7] = EscrowFactoryFacet.escrowDepositERC1155.selector;
        s[8] = EscrowFactoryFacet.escrowWithdrawERC1155.selector;
        s[9] = EscrowFactoryFacet.escrowApproveNFT721.selector;
        s[10] = EscrowFactoryFacet.escrowSetNFTUser.selector;
        s[11] = EscrowFactoryFacet.escrowGetNFTUserOf.selector;
        s[12] = EscrowFactoryFacet.escrowGetNFTUserExpires.selector;
        s[13] = EscrowFactoryFacet.getOfferAmount.selector;
        s[14] = EscrowFactoryFacet.getVaipakamEscrowImplementationAddress.selector;
        s[15] = EscrowFactoryFacet.getDiamondAddress.selector;
        s[16] = EscrowFactoryFacet.setMandatoryEscrowUpgrade.selector;
        s[17] = EscrowFactoryFacet.upgradeUserEscrow.selector;
        // T-051 / T-054 — chokepoint deposit + counter-only companions
        // + stuck-token recovery EIP-712 surface.
        s[18] = EscrowFactoryFacet.escrowDepositERC20From.selector;
        s[19] = EscrowFactoryFacet.recordEscrowDepositERC20.selector;
        s[20] = EscrowFactoryFacet.getProtocolTrackedEscrowBalance.selector;
        s[21] = EscrowFactoryFacet.recoverStuckERC20.selector;
        s[22] = EscrowFactoryFacet.disown.selector;
        s[23] = EscrowFactoryFacet.recoveryDomainSeparator.selector;
        s[24] = EscrowFactoryFacet.recoveryAckTextHash.selector;
        s[25] = EscrowFactoryFacet.recoveryNonce.selector;
        s[26] = EscrowFactoryFacet.escrowBannedSource.selector;
    }
}
