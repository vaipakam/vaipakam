// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

// Inheriting DeployDiamond gives us its canonical `_get<Facet>Selectors()`
// methods (CI-guarded by SelectorCoverageTest), so the routing here cannot
// drift. Facet types are imported explicitly (paths mirror DeployDiamond).
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {Deployments} from "./lib/Deployments.sol";
import {DeployDiamond} from "./DeployDiamond.s.sol";
import {DiamondLoupeFacet} from "../src/facets/DiamondLoupeFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {MetricsDashboardFacet} from "../src/facets/MetricsDashboardFacet.sol";
import {PayrollFacet} from "../src/facets/PayrollFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {NFTPrepayListingFacet} from "../src/facets/NFTPrepayListingFacet.sol";
import {NFTPrepayDutchListingFacet} from "../src/facets/NFTPrepayDutchListingFacet.sol";
import {NFTPrepayListingAtomicFacet} from "../src/facets/NFTPrepayListingAtomicFacet.sol";
import {NFTPrepayAutoListFacet} from "../src/facets/NFTPrepayAutoListFacet.sol";
import {OfferParallelSaleFacet} from "../src/facets/OfferParallelSaleFacet.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {MirrorTierReceiverFacet} from "../src/facets/MirrorTierReceiverFacet.sol";
import {ProtocolBroadcastFacet} from "../src/facets/ProtocolBroadcastFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {SignedOfferFacet} from "../src/facets/SignedOfferFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {AggregatorAdapterFactoryFacet} from "../src/facets/AggregatorAdapterFactoryFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {RiskSplitLiquidationFacet} from "../src/facets/RiskSplitLiquidationFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {ReceiverFacet} from "../src/facets/ReceiverFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {MulticallFacet} from "../src/facets/MulticallFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";

/// @dev Minimal ERC-173 view to pre-flight the diamond owner.
interface IOwnable {
    function owner() external view returns (address);
}

/**
 * @title  RefreshAllFacetsInPlace
 * @notice Maintained, undated FULL-facet in-place refresh of an already-deployed
 *         testnet Diamond. Redeploys every cut facet and diamond-cuts the whole
 *         selector set onto the LIVE diamond — Replacing already-routed selectors
 *         and Adding new ones — so the diamond ADDRESS and all on-chain state
 *         (loans, offers, vaults) are preserved.
 *
 *         This replaces the throwaway `CatchUpFacetCut<NNN>` one-offs (one
 *         hand-copied 60+-facet script per sweep, each free to drift from
 *         `DeployDiamond`). Here the facet set AND every selector list are
 *         INHERITED from `DeployDiamond` (`_get<Facet>Selectors()`), so:
 *           - it can never drift from canonical routing, and
 *           - it needs no edit per sweep — just rebuild and run.
 *
 * @dev WHY FULL, NEVER A SUBSET
 *         Recent work (the #951/#959 sale-vehicle redesign and later tranches)
 *         changes shared libraries — LibOfferMatch / LibSaleListing /
 *         LibVaipakam — that are INLINED into many facets. A subset cut would
 *         leave the live diamond with mismatched bytecode across an
 *         inlined-library boundary. Only a full refresh is consistent.
 *
 * @dev STORAGE SAFETY (the load-bearing precondition)
 *         An in-place cut REUSES the diamond's existing storage. It is safe
 *         ONLY while every storage-layout change since the diamond was last cut
 *         is append-only (new fields at the END of `Loan` / the top-level
 *         `Storage` struct, with zero-default handling for pre-existing state).
 *         This holds for the #953→current window (audited: all additions are at
 *         struct end; the new `*AtInit` snapshot fields fall back to config when
 *         read as 0 on old loans). A NON-append-only change (mid-struct insert,
 *         reorder, type change) would silently corrupt live state — in that case
 *         do a FRESH `DeployDiamond` instead. Per owner policy (2026-06-19),
 *         mainnet rollouts are ALWAYS fresh; this in-place path is testnet-only.
 *
 * @dev SCOPE: selectors are Replaced/Added, never Removed. A selector that was
 *         deleted from the codebase stays routed to its old (stale) facet — the
 *         same behaviour as the prior catch-up scripts. Acceptable on testnet;
 *         a fresh deploy is the clean slate if that matters.
 *
 *         Env: ADMIN_PRIVATE_KEY (must be the Diamond's current ERC-173 owner
 *         — the admin account after the deployer->admin handover). The script
 *         reverts up front if it isn't.
 *
 *         Usage (from contracts/, on main) — run once per chain. Use `--slow`:
 *         the admin owner is EIP-7702-delegated on at least Base Sepolia, and a
 *         delegated account may have only one in-flight tx (no gapped nonces).
 *           forge script script/RefreshAllFacetsInPlace.s.sol --sig "refresh()" \
 *             --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow
 *           # then the same with $ARB_SEPOLIA_RPC_URL, $BNB_TESTNET_RPC_URL
 */
contract RefreshAllFacetsInPlace is DeployDiamond {
    struct Item {
        string key; // addresses.json facet key (matches DeployDiamond)
        address impl; // freshly deployed implementation
        bytes4[] selectors; // canonical routing, inherited from DeployDiamond
    }

    // Per-diamondCut selector budget. The single all-facets cut (~700 selectors)
    // is rejected by Base Sepolia as -32003 "gas limit too high"; keeping each
    // batch under this budget holds every cut tx well below the RPC/block cap.
    // Splitting distinct Replace/Add cuts across txs is state-equivalent to one
    // cut (no selector overlap, order-independent).
    uint256 internal constant SELECTOR_BUDGET = 120;

    // Must equal DeployDiamond's `cuts` array length (currently cuts[0..63]).
    // A mismatch means a facet was added to DeployDiamond but not mirrored here.
    uint256 internal constant EXPECTED_FACETS = 65;

    function refresh() external {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || // Base Sepolia
                cid == 421614 || // Arbitrum Sepolia
                cid == 97 || // BNB testnet
                cid == 11155111 || // Ethereum Sepolia
                cid == 11155420 || // OP Sepolia
                cid == 31337, // Anvil
            "RefreshAllFacetsInPlace: testnet only"
        );
        // Only the Diamond's ERC-173 owner may diamondCut. After the
        // deployer->admin handover that owner is the ADMIN key, so sign with it.
        // Pre-flight the match so a wrong key (or a timelock-owned diamond)
        // reverts HERE, before the 63 facet deploys — not after.
        uint256 ownerKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address signer = vm.addr(ownerKey);
        address diamond = Deployments.readDiamond();
        IDiamondLoupe loupe = IDiamondLoupe(diamond);
        address currentOwner = IOwnable(diamond).owner();
        require(
            signer == currentOwner,
            "RefreshAllFacetsInPlace: ADMIN_PRIVATE_KEY is not the diamond owner (handover / timelock?)"
        );

        console.log("=== Full-facet in-place refresh ===");
        console.log("Chain id:", cid);
        console.log("Diamond: ", diamond);
        console.log("Owner:   ", currentOwner);

        vm.startBroadcast(ownerKey);

        Item[] memory items = _deployItems();
        require(items.length == EXPECTED_FACETS, "RefreshAllFacetsInPlace: facet count drift vs DeployDiamond");

        // Split each facet's canonical selector list against the live loupe:
        // routed -> Replace, unrouted -> Add.
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](items.length * 2);
        uint256 nCuts;
        for (uint256 i; i < items.length; ++i) {
            (bytes4[] memory adds, bytes4[] memory reps) = _split(loupe, items[i].selectors);
            if (reps.length > 0) {
                cuts[nCuts++] = IDiamondCut.FacetCut({
                    facetAddress: items[i].impl,
                    action: IDiamondCut.FacetCutAction.Replace,
                    functionSelectors: reps
                });
            }
            if (adds.length > 0) {
                cuts[nCuts++] = IDiamondCut.FacetCut({
                    facetAddress: items[i].impl,
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: adds
                });
            }
            console.log(items[i].key, items[i].impl);
            console.log("   replace:", reps.length, "add:", adds.length);
        }

        // Codex #992 — pause the diamond across the batched cuts so no
        // `whenNotPaused` entry point can be exercised under a partially-
        // refreshed (mixed old/new facet) configuration between batches, or if
        // a later batch reverts. Shared libraries are inlined across facets, so
        // a mixed configuration is exactly the unsafe state this full refresh
        // exists to avoid. The refresh signer is the diamond owner, which on a
        // testnet holds PAUSER/UNPAUSER. Restore ONLY if we paused it (an
        // already-paused diamond is left paused), and only AFTER the post-cut
        // routing verification passes — a failed verify reverts the script
        // before the unpause broadcasts, so a bad refresh is left safely frozen.
        bool wasPaused = AdminFacet(diamond).paused();
        if (!wasPaused) AdminFacet(diamond).pause();

        // Dispatch the cut in selector-budgeted batches so no single diamondCut
        // tx exceeds the RPC/block gas cap.
        uint256 batchStart;
        uint256 batchSelectors;
        for (uint256 i; i < nCuts; ++i) {
            uint256 selLen = cuts[i].functionSelectors.length;
            if (batchSelectors > 0 && batchSelectors + selLen > SELECTOR_BUDGET) {
                _sendBatch(diamond, cuts, batchStart, i);
                batchStart = i;
                batchSelectors = 0;
            }
            batchSelectors += selLen;
        }
        if (nCuts > batchStart) {
            _sendBatch(diamond, cuts, batchStart, nCuts);
        }

        // Post-cut verification: every canonical selector must route to its
        // fresh implementation. Runs BEFORE the unpause (still inside the
        // broadcast; these are view calls) so a failed refresh stays frozen.
        for (uint256 i; i < items.length; ++i) {
            for (uint256 j; j < items[i].selectors.length; ++j) {
                address routed = loupe.facetAddress(items[i].selectors[j]);
                require(routed == items[i].impl, string.concat("verify failed: ", items[i].key));
            }
        }
        console.log("Verified: all selectors route to the fresh implementations.");

        if (!wasPaused) AdminFacet(diamond).unpause();

        vm.stopBroadcast();

        // Persist the new addresses so the deployments sync picks them up.
        for (uint256 i; i < items.length; ++i) {
            Deployments.writeFacet(items[i].key, items[i].impl);
        }
        // Codex #992 — keep `.facetCount` in lockstep with the LIVE diamond.
        // An in-place refresh can Add net-new facets (the count grows), and the
        // deploy-verify phase exact-matches this value against the live
        // `facetAddresses().length`, so a stale count fails verify. Read the
        // live count rather than `items.length` (which excludes the
        // construction-time `diamondCutFacet` and any non-routed map entry).
        Deployments.writeUint(".facetCount", loupe.facetAddresses().length);
        console.log("");
        console.log("addresses.json updated. Next:");
        console.log("  bash script/exportFrontendDeployments.sh");
        console.log("  forge build --skip test && bash script/exportFrontendAbis.sh");
    }

    /// @notice Deploy every cut facet fresh, paired with its canonical
    ///         `addresses.json` key and inherited selector list. The facet set,
    ///         order, types, and getters mirror `DeployDiamond`'s `cuts[0..62]`
    ///         exactly — keep this in lockstep when a facet is added there.
    function _deployItems() private returns (Item[] memory items) {
        items = new Item[](EXPECTED_FACETS);
        items[0] = Item("diamondLoupeFacet", address(new DiamondLoupeFacet()), _getLoupeSelectors());
        items[1] = Item("ownershipFacet", address(new OwnershipFacet()), _getOwnershipSelectors());
        items[2] = Item("accessControlFacet", address(new AccessControlFacet()), _getAccessControlSelectors());
        items[3] = Item("adminFacet", address(new AdminFacet()), _getAdminSelectors());
        items[4] = Item("profileFacet", address(new ProfileFacet()), _getProfileSelectors());
        items[5] = Item("oracleFacet", address(new OracleFacet()), _getOracleSelectors());
        items[6] = Item("oracleAdminFacet", address(new OracleAdminFacet()), _getOracleAdminSelectors());
        items[7] = Item("vaipakamNFTFacet", address(new VaipakamNFTFacet()), _getNftSelectors());
        items[8] = Item("vaultFactoryFacet", address(new VaultFactoryFacet()), _getVaultFactorySelectors());
        items[9] = Item("offerCreateFacet", address(new OfferCreateFacet()), _getOfferCreateSelectors());
        items[10] = Item("loanFacet", address(new LoanFacet()), _getLoanSelectors());
        items[11] = Item("repayFacet", address(new RepayFacet()), _getRepaySelectors());
        items[12] = Item("defaultedFacet", address(new DefaultedFacet()), _getDefaultedSelectors());
        items[13] = Item("riskFacet", address(new RiskFacet()), _getRiskSelectors());
        items[14] = Item("claimFacet", address(new ClaimFacet()), _getClaimSelectors());
        items[15] = Item("addCollateralFacet", address(new AddCollateralFacet()), _getAddCollateralSelectors());
        items[16] = Item("treasuryFacet", address(new TreasuryFacet()), _getTreasurySelectors());
        items[17] = Item("earlyWithdrawalFacet", address(new EarlyWithdrawalFacet()), _getEarlyWithdrawalSelectors());
        items[18] = Item(
            "partialWithdrawalFacet",
            address(new PartialWithdrawalFacet()),
            _getPartialWithdrawalSelectors()
        );
        items[19] = Item("precloseFacet", address(new PrecloseFacet()), _getPrecloseSelectors());
        items[20] = Item("refinanceFacet", address(new RefinanceFacet()), _getRefinanceSelectors());
        items[21] = Item("metricsFacet", address(new MetricsFacet()), _getMetricsSelectors());
        items[22] = Item("vpfiTokenFacet", address(new VPFITokenFacet()), _getVpfiTokenSelectors());
        items[23] = Item("vpfiDiscountFacet", address(new VPFIDiscountFacet()), _getVpfiDiscountSelectors());
        items[24] = Item("consolidationFacet", address(new ConsolidationFacet()), _getConsolidationFacetSelectors());
        items[25] = Item(
            "interactionRewardsFacet",
            address(new InteractionRewardsFacet()),
            _getInteractionRewardsSelectors()
        );
        items[26] = Item("rewardReporterFacet", address(new RewardReporterFacet()), _getRewardReporterSelectors());
        items[27] = Item(
            "rewardAggregatorFacet",
            address(new RewardAggregatorFacet()),
            _getRewardAggregatorSelectors()
        );
        items[28] = Item("configFacet", address(new ConfigFacet()), _getConfigSelectors());
        items[29] = Item("legalFacet", address(new LegalFacet()), _getLegalSelectors());
        items[30] = Item("offerMatchFacet", address(new OfferMatchFacet()), _getOfferMatchSelectors());
        items[31] = Item("offerCancelFacet", address(new OfferCancelFacet()), _getOfferCancelSelectors());
        items[32] = Item(
            "metricsDashboardFacet",
            address(new MetricsDashboardFacet()),
            _getMetricsDashboardSelectors()
        );
        items[33] = Item("payrollFacet", address(new PayrollFacet()), _getPayrollSelectors());
        items[34] = Item(
            "riskMatchLiquidationFacet",
            address(new RiskMatchLiquidationFacet()),
            _getRiskMatchLiquidationSelectors()
        );
        items[35] = Item("offerAcceptFacet", address(new OfferAcceptFacet()), _getOfferAcceptSelectors());
        items[36] = Item("offerMutateFacet", address(new OfferMutateFacet()), _getOfferMutateSelectors());
        items[37] = Item("prepayListingFacet", address(new PrepayListingFacet()), _getPrepayListingSelectors());
        items[38] = Item(
            "nftPrepayListingFacet",
            address(new NFTPrepayListingFacet()),
            _getNFTPrepayListingSelectors()
        );
        items[39] = Item(
            "nftPrepayDutchListingFacet",
            address(new NFTPrepayDutchListingFacet()),
            _getNFTPrepayDutchListingSelectors()
        );
        items[40] = Item(
            "nftPrepayListingAtomicFacet",
            address(new NFTPrepayListingAtomicFacet()),
            _getNFTPrepayListingAtomicSelectors()
        );
        items[41] = Item(
            "nftPrepayAutoListFacet",
            address(new NFTPrepayAutoListFacet()),
            _getNFTPrepayAutoListSelectors()
        );
        items[42] = Item(
            "offerParallelSaleFacet",
            address(new OfferParallelSaleFacet()),
            _getOfferParallelSaleSelectors()
        );
        items[43] = Item("swapToRepayFacet", address(new SwapToRepayFacet()), _getSwapToRepayFacetSelectors());
        items[44] = Item(
            "swapToRepayIntentFacet",
            address(new SwapToRepayIntentFacet()),
            _getSwapToRepayIntentFacetSelectors()
        );
        items[45] = Item("intentConfigFacet", address(new IntentConfigFacet()), _getIntentConfigSelectors());
        items[46] = Item(
            "vpfiDiscountAccumulatorFacet",
            address(new VPFIDiscountAccumulatorFacet()),
            _getVpfiDiscountAccumulatorSelectors()
        );
        items[47] = Item(
            "mirrorTierReceiverFacet",
            address(new MirrorTierReceiverFacet()),
            _getMirrorTierReceiverSelectors()
        );
        items[48] = Item(
            "protocolBroadcastFacet",
            address(new ProtocolBroadcastFacet()),
            _getProtocolBroadcastSelectors()
        );
        items[49] = Item("intentDispatchFacet", address(new IntentDispatchFacet()), _getIntentDispatchFacetSelectors());
        items[50] = Item("autoLifecycleFacet", address(new AutoLifecycleFacet()), _getAutoLifecycleFacetSelectors());
        items[51] = Item(
            "encumbranceMutateFacet",
            address(new EncumbranceMutateFacet()),
            _getEncumbranceMutateFacetSelectors()
        );
        items[52] = Item("repayPeriodicFacet", address(new RepayPeriodicFacet()), _getRepayPeriodicFacetSelectors());
        items[53] = Item("signedOfferFacet", address(new SignedOfferFacet()), _getSignedOfferFacetSelectors());
        items[54] = Item("lenderIntentFacet", address(new LenderIntentFacet()), _getLenderIntentFacetSelectors());
        items[55] = Item(
            "aggregatorAdapterFactoryFacet",
            address(new AggregatorAdapterFactoryFacet()),
            _getAggregatorAdapterFactorySelectors()
        );
        items[56] = Item("backstopFacet", address(new BackstopFacet()), _getBackstopFacetSelectors());
        items[57] = Item(
            "riskSplitLiquidationFacet",
            address(new RiskSplitLiquidationFacet()),
            _getRiskSplitLiquidationSelectors()
        );
        items[58] = Item("numeraireConfigFacet", address(new NumeraireConfigFacet()), _getNumeraireConfigSelectors());
        items[59] = Item("receiverFacet", address(new ReceiverFacet()), _getReceiverFacetSelectors());
        items[60] = Item("riskAccessFacet", address(new RiskAccessFacet()), _getRiskAccessFacetSelectors());
        items[61] = Item(
            "rewardRemittanceFacet",
            address(new RewardRemittanceFacet()),
            _getRewardRemittanceSelectors()
        );
        items[62] = Item("offerPreviewFacet", address(new OfferPreviewFacet()), _getOfferPreviewSelectors());
        // #1104 — RiskPreviewFacet split off RiskAccessFacet (items[60]).
        items[63] = Item("riskPreviewFacet", address(new RiskPreviewFacet()), _getRiskPreviewFacetSelectors());
        // #1212 (E-10 Claim-All) — generic best-effort delegatecall batcher.
        // NEW facet: `_split` routes its selector to Add on an existing diamond
        // (unrouted), so an in-place refresh installs Claim All instead of
        // leaving multicall(Call[]) unrouted while the ABI advertises it.
        items[64] = Item("multicallFacet", address(new MulticallFacet()), _getMulticallFacetSelectors());
        // #1132 (S10 central enforcement) — terminal-transition register host.
    }

    /// @notice Broadcast one bounded diamondCut for `cuts[start..end)`.
    function _sendBatch(address diamond, IDiamondCut.FacetCut[] memory cuts, uint256 start, uint256 end) private {
        IDiamondCut.FacetCut[] memory batch = new IDiamondCut.FacetCut[](end - start);
        uint256 sels;
        for (uint256 i = start; i < end; ++i) {
            batch[i - start] = cuts[i];
            sels += cuts[i].functionSelectors.length;
        }
        IDiamondCut(diamond).diamondCut(batch, address(0), "");
        console.log("  cut batch: entries", end - start, "selectors", sels);
    }

    /// @notice Partition `sels` by live routing: unrouted -> `adds`,
    ///         already-routed -> `reps` (facetAddress returns 0 when unrouted).
    function _split(
        IDiamondLoupe loupe,
        bytes4[] memory sels
    ) private view returns (bytes4[] memory adds, bytes4[] memory reps) {
        uint256 nAdd;
        for (uint256 i; i < sels.length; ++i) {
            if (loupe.facetAddress(sels[i]) == address(0)) nAdd++;
        }
        adds = new bytes4[](nAdd);
        reps = new bytes4[](sels.length - nAdd);
        uint256 ai;
        uint256 ri;
        for (uint256 i; i < sels.length; ++i) {
            if (loupe.facetAddress(sels[i]) == address(0)) {
                adds[ai++] = sels[i];
            } else {
                reps[ri++] = sels[i];
            }
        }
    }
}
