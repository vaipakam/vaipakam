// script/DeployDiamond.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
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
import {OfferParallelSaleFacet} from "../src/facets/OfferParallelSaleFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {SignedOfferFacet} from "../src/facets/SignedOfferFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {AggregatorAdapterFactoryFacet} from "../src/facets/AggregatorAdapterFactoryFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {ReceiverFacet} from "../src/facets/ReceiverFacet.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {MulticallFacet} from "../src/facets/MulticallFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {RiskSplitLiquidationFacet} from "../src/facets/RiskSplitLiquidationFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {PayrollFacet} from "../src/facets/PayrollFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {NFTPrepayListingFacet} from "../src/facets/NFTPrepayListingFacet.sol";
import {NFTPrepayDutchListingFacet} from "../src/facets/NFTPrepayDutchListingFacet.sol";
import {NFTPrepayListingAtomicFacet} from "../src/facets/NFTPrepayListingAtomicFacet.sol";
import {NFTPrepayAutoListFacet} from "../src/facets/NFTPrepayAutoListFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {MetricsDashboardFacet} from "../src/facets/MetricsDashboardFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
// T-087 Sub 2.C — mirror-side Diamond ingress for the cross-chain
// tier push; the `userTierCache` writer.
import {MirrorTierReceiverFacet} from "../src/facets/MirrorTierReceiverFacet.sol";
// T-087 Sub 2.D — protocol-funded mirror broadcast orchestrator.
import {ProtocolBroadcastFacet} from "../src/facets/ProtocolBroadcastFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {Deployments} from "./lib/Deployments.sol";

contract DeployDiamond is Script {
    // ── Deployed addresses (logged at the end) ──────────────────────────
    // `public` so the deploy-integration test (Issue #72) can read the
    // built Diamond after calling `run()` — the script's own
    // `Deployments.writeDiamond(...)` artifact path is FS-write and only
    // useful for downstream operator scripts; an in-process test reads
    // the storage var directly.
    address public diamond;
    address public diamondCutFacet;

    /// @notice Operator entry point — reads `ADMIN_ADDRESS`,
    ///         `TREASURY_ADDRESS`, `DEPLOYER_PRIVATE_KEY` from env and
    ///         delegates to `runWith(...)`. Foundry's `forge script
    ///         DeployDiamond --broadcast` invokes this.
    function run() external virtual {
        runWith(
            vm.envAddress("ADMIN_ADDRESS"),
            vm.envAddress("TREASURY_ADDRESS"),
            vm.envUint("DEPLOYER_PRIVATE_KEY")
        );
    }

    /// @notice Parameterised entry point — same deploy logic, but admin /
    ///         treasury / deployer-key are passed directly instead of read
    ///         from env vars.
    /// @dev    Issue #72 — env-var-driven invocation races under Foundry's
    ///         default-parallel test runner (`vm.setEnv` writes to the
    ///         PROCESS env, shared across every test thread, so two tests
    ///         calling `run()` concurrently with different admins can
    ///         clobber each other's `ADMIN_ADDRESS` mid-broadcast). The
    ///         deploy-integration test calls `runWith(...)` directly to
    ///         pass admin / treasury / deployer-key as Solidity args — no
    ///         env-var round-trip, no parallel-test race. Production
    ///         `forge script` invocations keep using `run()` and are
    ///         unaffected.
    function runWith(
        address admin,
        address treasury,
        uint256 deployerKey
    ) public virtual {
        address deployerAddr = vm.addr(deployerKey);

        console.log("=== Vaipakam Diamond Deployment ===");
        console.log("Admin:   ", admin);
        console.log("Treasury:", treasury);
        console.log("Deployer:", deployerAddr);

        vm.startBroadcast(deployerKey);

        // ── Step 1: Deploy all facets ───────────────────────────────────
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        DiamondLoupeFacet loupeFacet = new DiamondLoupeFacet();
        OwnershipFacet ownershipFacet = new OwnershipFacet();
        AccessControlFacet accessControlFacet = new AccessControlFacet();
        AdminFacet adminFacet = new AdminFacet();
        ProfileFacet profileFacet = new ProfileFacet();
        OracleFacet oracleFacet = new OracleFacet();
        OracleAdminFacet oracleAdminFacet = new OracleAdminFacet();
        VaipakamNFTFacet nftFacet = new VaipakamNFTFacet();
        VaultFactoryFacet vaultFactoryFacet = new VaultFactoryFacet();
        OfferCreateFacet offerCreateFacet = new OfferCreateFacet();
        // T-086 Round-8 (#358) — borrow-OR-sell parallel-sale facet
        // (carved off OfferCreateFacet — see _getOfferParallelSaleSelectors).
        OfferParallelSaleFacet offerParallelSaleFacet = new OfferParallelSaleFacet();
        OfferAcceptFacet offerAcceptFacet = new OfferAcceptFacet();
        OfferPreviewFacet offerPreviewFacet = new OfferPreviewFacet();
        // Range Orders Phase 1 EIP-170 split: matchOffers + previewMatch
        // live on a separate facet to keep OfferFacet under the
        // 24576-byte runtime-bytecode ceiling.
        OfferMatchFacet offerMatchFacet = new OfferMatchFacet();
        // Same EIP-170 pressure split out cancelOffer + read views into
        // OfferCancelFacet. Selectors land on the diamond identically;
        // frontend / keeper-bot bindings unaffected by the move.
        OfferCancelFacet offerCancelFacet = new OfferCancelFacet();
        // #193 — in-place offer modification surface. Carved into its
        // own facet for the same EIP-170 reason the cancel + match
        // halves were; selectors land on the diamond identically.
        OfferMutateFacet offerMutateFacet = new OfferMutateFacet();
        LoanFacet loanFacet = new LoanFacet();
        RepayFacet repayFacet = new RepayFacet();
        RepayPeriodicFacet repayPeriodicFacet = new RepayPeriodicFacet();
        SwapToRepayFacet swapToRepayFacet = new SwapToRepayFacet();
        // T-090 v1.1 (#389) — intent-based swap-to-repay sibling facet.
        SwapToRepayIntentFacet swapToRepayIntentFacet = new SwapToRepayIntentFacet();
        // T-087 Sub 3.B — the 1inch LOP v4 callback dispatcher;
        // owns preInteraction / postInteraction / isValidSignature
        // for BOTH the repay path and the buyback path.
        IntentDispatchFacet intentDispatchFacet = new IntentDispatchFacet();
        // T-092 Phase 1 (#499) — consent surface for auto-lend /
        // auto-refinance / auto-extend. Setters + readers only;
        // Phase 2/3 wire the caps into RefinanceFacet + add the
        // extendLoanInPlace executor.
        AutoLifecycleFacet autoLifecycleFacet = new AutoLifecycleFacet();
        // #407 PR 2 — thin cross-facet mutate surface for the
        // vault encumbrance sub-ledger; see facet natspec.
        EncumbranceMutateFacet encumbranceMutateFacet = new EncumbranceMutateFacet();
        // #1132 (S10 central enforcement) — diamond-internal host that performs
        // a loan's TERMINAL status transition AND records both holders'
        // fail-closed frozen-claimant markers in one place; see facet natspec.
        // #396 v0.5 — gasless signed off-chain offer book fill surface.
        SignedOfferFacet signedOfferFacet = new SignedOfferFacet();
        // #393 v1 — LenderIntentVault standing-terms surface.
        LenderIntentFacet lenderIntentFacet = new LenderIntentFacet();
        // #398 v1.5 — per-aggregator ERC-4626 adapter factory.
        AggregatorAdapterFactoryFacet aggregatorAdapterFactoryFacet =
            new AggregatorAdapterFactoryFacet();
        // #399 v2.5 — treasury-seeded backstop vault governance + Role-A drive.
        BackstopFacet backstopFacet = new BackstopFacet();
        ReceiverFacet receiverFacet = new ReceiverFacet();
        ConsolidationFacet consolidationFacet = new ConsolidationFacet();
        // #671 — self-sovereign progressive risk-access facet.
        RiskAccessFacet riskAccessFacet = new RiskAccessFacet();
        // #1104 — read-only risk preview cluster + cross-facet gate asserts,
        // split off RiskAccessFacet for EIP-170 headroom.
        RiskPreviewFacet riskPreviewFacet = new RiskPreviewFacet();
        // #1212 (E-10 Claim-All) — generic best-effort delegatecall batcher.
        MulticallFacet multicallFacet = new MulticallFacet();
        // T-090 v1.1 (#389) — intent-based swap-to-repay config knobs.
        // Carved off `ConfigFacet` after the round-2 PR #420 CI block
        // pushed it past EIP-170.
        IntentConfigFacet intentConfigFacet = new IntentConfigFacet();
        DefaultedFacet defaultedFacet = new DefaultedFacet();
        RiskFacet riskFacet = new RiskFacet();
        RiskMatchLiquidationFacet riskMatchLiquidationFacet =
            new RiskMatchLiquidationFacet();
        RiskSplitLiquidationFacet riskSplitLiquidationFacet =
            new RiskSplitLiquidationFacet();
        ClaimFacet claimFacet = new ClaimFacet();
        AddCollateralFacet addCollateralFacet = new AddCollateralFacet();
        TreasuryFacet treasuryFacet = new TreasuryFacet();
        PayrollFacet payrollFacet = new PayrollFacet();
        EarlyWithdrawalFacet earlyWithdrawalFacet = new EarlyWithdrawalFacet();
        PartialWithdrawalFacet partialWithdrawalFacet = new PartialWithdrawalFacet();
        PrecloseFacet precloseFacet = new PrecloseFacet();
        PrepayListingFacet prepayListingFacet = new PrepayListingFacet();
        NFTPrepayListingFacet nftPrepayListingFacet = new NFTPrepayListingFacet();
        NFTPrepayDutchListingFacet nftPrepayDutchListingFacet = new NFTPrepayDutchListingFacet();
        NFTPrepayListingAtomicFacet nftPrepayListingAtomicFacet = new NFTPrepayListingAtomicFacet();
        NFTPrepayAutoListFacet nftPrepayAutoListFacet = new NFTPrepayAutoListFacet();
        RefinanceFacet refinanceFacet = new RefinanceFacet();
        MetricsFacet metricsFacet = new MetricsFacet();
        MetricsDashboardFacet metricsDashboardFacet = new MetricsDashboardFacet();
        VPFITokenFacet vpfiTokenFacet = new VPFITokenFacet();
        VPFIDiscountFacet vpfiDiscountFacet = new VPFIDiscountFacet();
        VPFIDiscountAccumulatorFacet vpfiDiscountAccumulatorFacet =
            new VPFIDiscountAccumulatorFacet();
        // T-087 Sub 2.C — mirror-side tier-push receiver facet.
        MirrorTierReceiverFacet mirrorTierReceiverFacet =
            new MirrorTierReceiverFacet();
        // T-087 Sub 2.D — protocol-funded mirror broadcast orchestrator.
        ProtocolBroadcastFacet protocolBroadcastFacet =
            new ProtocolBroadcastFacet();
        InteractionRewardsFacet interactionRewardsFacet = new InteractionRewardsFacet();
        // #1306 follow-up — read-only lens carved off InteractionRewardsFacet
        // for EIP-170 headroom (view/getter surface only, shared storage).
        InteractionRewardsLensFacet interactionRewardsLensFacet =
            new InteractionRewardsLensFacet();
        RewardReporterFacet rewardReporterFacet = new RewardReporterFacet();
        RewardAggregatorFacet rewardAggregatorFacet = new RewardAggregatorFacet();
        RewardRemittanceFacet rewardRemittanceFacet = new RewardRemittanceFacet();
        ConfigFacet configFacet = new ConfigFacet();
        // #394 (Codex #647) — numeraire / PAD / periodic-interest config
        // carved off `ConfigFacet` to keep it under EIP-170. Sibling
        // facet sharing LibVaipakam storage.
        NumeraireConfigFacet numeraireConfigFacet = new NumeraireConfigFacet();
        // LegalFacet — Phase 4.1 Terms-of-Service acceptance gate. The
        // gate stays disabled until governance writes a non-zero
        // `currentTosVersion` via `LegalFacet.setCurrentTos`; cutting
        // the facet now keeps that surface reachable on the deployed
        // Diamond instead of leaving it as dead code.
        LegalFacet legalFacet = new LegalFacet();

        console.log("All 35 facets deployed.");

        // ── Step 2: Deploy Diamond ──────────────────────────────────────
        // Deployer is the initial ERC-173 owner so it can execute the
        // diamondCut below. If admin != deployer, Step 6 transfers ownership
        // + every role to admin and renounces them from deployer, leaving
        // the post-script topology (owner=admin, all roles on admin) matching
        // the Phase-1 runbook.
        VaipakamDiamond vaipakamDiamond = new VaipakamDiamond(
            deployerAddr,
            address(cutFacet)
        );
        diamond = address(vaipakamDiamond);
        diamondCutFacet = address(cutFacet);
        console.log("Diamond deployed at:", diamond);

        // ── Step 3: Build facet cuts ────────────────────────────────────
        // 37 facets (DiamondCutFacet already added by constructor)
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](66);

        cuts[0] = _buildCut(address(loupeFacet), _getLoupeSelectors());
        cuts[1] = _buildCut(address(ownershipFacet), _getOwnershipSelectors());
        cuts[2] = _buildCut(address(accessControlFacet), _getAccessControlSelectors());
        cuts[3] = _buildCut(address(adminFacet), _getAdminSelectors());
        cuts[4] = _buildCut(address(profileFacet), _getProfileSelectors());
        cuts[5] = _buildCut(address(oracleFacet), _getOracleSelectors());
        cuts[6] = _buildCut(address(oracleAdminFacet), _getOracleAdminSelectors());
        cuts[7] = _buildCut(address(nftFacet), _getNftSelectors());
        cuts[8] = _buildCut(address(vaultFactoryFacet), _getVaultFactorySelectors());
        cuts[9] = _buildCut(address(offerCreateFacet), _getOfferCreateSelectors());
        cuts[10] = _buildCut(address(loanFacet), _getLoanSelectors());
        cuts[11] = _buildCut(address(repayFacet), _getRepaySelectors());
        cuts[12] = _buildCut(address(defaultedFacet), _getDefaultedSelectors());
        cuts[13] = _buildCut(address(riskFacet), _getRiskSelectors());
        cuts[14] = _buildCut(address(claimFacet), _getClaimSelectors());
        cuts[15] = _buildCut(address(addCollateralFacet), _getAddCollateralSelectors());
        cuts[16] = _buildCut(address(treasuryFacet), _getTreasurySelectors());
        cuts[17] = _buildCut(address(earlyWithdrawalFacet), _getEarlyWithdrawalSelectors());
        cuts[18] = _buildCut(address(partialWithdrawalFacet), _getPartialWithdrawalSelectors());
        cuts[19] = _buildCut(address(precloseFacet), _getPrecloseSelectors());
        cuts[20] = _buildCut(address(refinanceFacet), _getRefinanceSelectors());
        cuts[21] = _buildCut(address(metricsFacet), _getMetricsSelectors());
        cuts[22] = _buildCut(address(vpfiTokenFacet), _getVpfiTokenSelectors());
        cuts[23] = _buildCut(address(vpfiDiscountFacet), _getVpfiDiscountSelectors());
        // #687-B: the StakingRewardsFacet (5% VPFI staking yield) was removed.
        // Slot 24 is reused by the #594 consolidation facet (was slot 60) so the
        // fixed-size cut array stays hole-free after shrinking 61 -> 60.
        cuts[24] = _buildCut(
            address(consolidationFacet),
            _getConsolidationFacetSelectors()
        );
        cuts[25] = _buildCut(address(interactionRewardsFacet), _getInteractionRewardsSelectors());
        cuts[26] = _buildCut(address(rewardReporterFacet), _getRewardReporterSelectors());
        cuts[27] = _buildCut(address(rewardAggregatorFacet), _getRewardAggregatorSelectors());
        cuts[28] = _buildCut(address(configFacet), _getConfigSelectors());
        cuts[29] = _buildCut(address(legalFacet), _getLegalSelectors());
        cuts[30] = _buildCut(address(offerMatchFacet), _getOfferMatchSelectors());
        cuts[31] = _buildCut(address(offerCancelFacet), _getOfferCancelSelectors());
        cuts[32] = _buildCut(address(metricsDashboardFacet), _getMetricsDashboardSelectors());
        cuts[33] = _buildCut(address(payrollFacet), _getPayrollSelectors());
        cuts[34] = _buildCut(
            address(riskMatchLiquidationFacet),
            _getRiskMatchLiquidationSelectors()
        );
        // #66 + #633 — split-route HF liquidator carved out of RiskFacet.
        cuts[57] = _buildCut(
            address(riskSplitLiquidationFacet),
            _getRiskSplitLiquidationSelectors()
        );
        // Issue #67 — OfferFacet's accept half. The create half is
        // cuts[9]; both replace the former single `offerFacet` cut.
        cuts[35] = _buildCut(
            address(offerAcceptFacet),
            _getOfferAcceptSelectors()
        );
        // #980 — OfferPreviewFacet (the `previewAccept` view split out of
        // OfferAcceptFacet for EIP-170 headroom).
        cuts[62] = _buildCut(
            address(offerPreviewFacet),
            _getOfferPreviewSelectors()
        );
        // #193 — in-place offer modification facet, sibling of the
        // create / accept / cancel / match facets above.
        cuts[36] = _buildCut(
            address(offerMutateFacet),
            _getOfferMutateSelectors()
        );
        // T-086 step 5 — `PrepayListingFacet` (executor↔diamond trust
        // boundary for Seaport prepay collateral sales). Hosts the
        // bundled view the executor reads + the privileged
        // finalization callback + the executor-address admin setter.
        cuts[37] = _buildCut(
            address(prepayListingFacet),
            _getPrepayListingSelectors()
        );
        // T-086 step 6 — `NFTPrepayListingFacet` (borrower-facing
        // post / update / cancel / cancelExpired entry points for
        // the FIXED-PRICE Seaport prepay listing flow + view helpers).
        cuts[38] = _buildCut(
            address(nftPrepayListingFacet),
            _getNFTPrepayListingSelectors()
        );
        // T-086 Round-5 Block B (#309) — `NFTPrepayDutchListingFacet`
        // (Dutch-decay post + update entry points, sibling facet
        // sharing LibVaipakam storage with NFTPrepayListingFacet).
        cuts[39] = _buildCut(
            address(nftPrepayDutchListingFacet),
            _getNFTPrepayDutchListingSelectors()
        );
        // T-086 Round-6 / Block D (#345) — `NFTPrepayListingAtomicFacet`
        // (atomic match-rotation entry point via Seaport
        // `matchAdvancedOrders`; kills the v1 English-mode race
        // window §15.3 deliberately accepted). Single selector +
        // shares LibVaipakam storage with the two sibling listing
        // facets.
        cuts[40] = _buildCut(
            address(nftPrepayListingAtomicFacet),
            _getNFTPrepayListingAtomicSelectors()
        );
        // T-086 Round-7 (#355) — `NFTPrepayAutoListFacet`
        // (permissionless `autoListAtFloorOnGrace` entry point;
        // sibling facet sharing LibVaipakam storage with the other
        // three prepay-listing facets). Single selector.
        cuts[41] = _buildCut(
            address(nftPrepayAutoListFacet),
            _getNFTPrepayAutoListSelectors()
        );
        // T-086 Round-8 (#358) — `OfferParallelSaleFacet`
        // (borrower-only `postParallelSaleListing` +
        // `releaseParallelSaleLock` entry points for the no-loan
        // borrow-OR-sell flow). Carved off OfferCreateFacet to stay
        // under solc's viaIR jump-table reservation ceiling.
        cuts[42] = _buildCut(
            address(offerParallelSaleFacet),
            _getOfferParallelSaleSelectors()
        );
        // T-090 — Borrower-initiated swap-to-repay surface. Its own
        // facet to keep RepayFacet bytecode under EIP-170 and to
        // cleanly isolate the new LibSwap dependency surface.
        cuts[43] = _buildCut(
            address(swapToRepayFacet),
            _getSwapToRepayFacetSelectors()
        );
        // T-090 v1.1 (#389) — intent-based swap-to-repay sibling.
        // Hosts the commit / cancel / cancelExpired entry points +
        // the 1inch Fusion `LimitOrderProtocol` pre/postInteraction
        // hooks + ERC-1271 `isValidSignature` + the read-back
        // projection. Carved into its own facet to keep audit
        // surface localised to the Fusion-binding code path; the v1
        // atomic surface stays unchanged.
        cuts[44] = _buildCut(
            address(swapToRepayIntentFacet),
            _getSwapToRepayIntentFacetSelectors()
        );
        // T-090 v1.1 (#389) intent-based swap-to-repay config facet.
        cuts[45] = _buildCut(
            address(intentConfigFacet),
            _getIntentConfigSelectors()
        );
        // T-087 Sub 1.B — single-home VPFI discount accumulator facet
        // (ring-buffer math + lifecycle bookkeeping). Carved off
        // {LibVPFIDiscount} so settlement facets stay under EIP-170.
        cuts[46] = _buildCut(
            address(vpfiDiscountAccumulatorFacet),
            _getVpfiDiscountAccumulatorSelectors()
        );
        // T-087 Sub 2.C — mirror-side tier-push receiver facet.
        cuts[47] = _buildCut(
            address(mirrorTierReceiverFacet),
            _getMirrorTierReceiverSelectors()
        );
        // T-087 Sub 2.D — protocol-funded mirror broadcast orchestrator.
        cuts[48] = _buildCut(
            address(protocolBroadcastFacet),
            _getProtocolBroadcastSelectors()
        );
        // T-087 Sub 3.B — 1inch LOP v4 callback dispatcher.
        cuts[49] = _buildCut(
            address(intentDispatchFacet),
            _getIntentDispatchFacetSelectors()
        );
        // T-092 Phase 1 (#499) — auto-lifecycle consent surface.
        cuts[50] = _buildCut(
            address(autoLifecycleFacet),
            _getAutoLifecycleFacetSelectors()
        );
        // #407 PR 2 — encumbrance mutate surface.
        cuts[51] = _buildCut(
            address(encumbranceMutateFacet),
            _getEncumbranceMutateFacetSelectors()
        );
        // Issue #66 — periodic-interest + NFT-rental daily-deduction
        // cluster, split out of RepayFacet to keep both facets under the
        // EIP-170 runtime-bytecode limit. Shares LibVaipakam storage.
        cuts[52] = _buildCut(
            address(repayPeriodicFacet),
            _getRepayPeriodicFacetSelectors()
        );
        // #396 v0.5 — gasless signed off-chain offer book. A creator
        // signs offer terms once off-chain; a counterparty fills here,
        // materializing the signed offer into a normal on-chain offer +
        // immediately accepting it. See `SignedOfferFacet.sol` natspec.
        cuts[53] = _buildCut(
            address(signedOfferFacet),
            _getSignedOfferFacetSelectors()
        );
        // #393 v1 — LenderIntentVault standing-terms surface. A lender
        // registers set-and-forget bounds; a permissioned solver fills
        // concrete offers within them via OfferMatchFacet.matchIntent.
        cuts[54] = _buildCut(
            address(lenderIntentFacet),
            _getLenderIntentFacetSelectors()
        );
        // #398 v1.5 — per-aggregator ERC-4626 adapter factory (provision +
        // version registry + aggregator-pull migration + mandatory floor).
        cuts[55] = _buildCut(
            address(aggregatorAdapterFactoryFacet),
            _getAggregatorAdapterFactorySelectors()
        );
        // #399 v2.5 — treasury-seeded backstop vault governance (provision +
        // seed + caps + kill-switches) + Role-A auto-counterparty drive.
        cuts[56] = _buildCut(
            address(backstopFacet),
            _getBackstopFacetSelectors()
        );
        // #394 (Codex #647) — numeraire / PAD / periodic-interest config
        // surface carved off ConfigFacet to keep it under EIP-170.
        cuts[58] = _buildCut(
            address(numeraireConfigFacet),
            _getNumeraireConfigSelectors()
        );
        // #594 — gated+pinned ERC-721/1155 receiver hooks on the Diamond, so it
        // can transiently hold an NFT for the consolidation two-leg move (D-6).
        cuts[59] = _buildCut(
            address(receiverFacet),
            _getReceiverFacetSelectors()
        );
        // #671 — self-sovereign progressive risk-access. Per-vault tier opt-up
        // (direct + EIP-712 self-submit) + per-pair consent / ack setters + the
        // admin levers (terms-version bump, opt-up cooldown, protocol-managed-
        // vault exemptions) + views. See `RiskAccessFacet.sol` natspec.
        cuts[60] = _buildCut(
            address(riskAccessFacet),
            _getRiskAccessFacetSelectors()
        );
        cuts[61] = _buildCut(address(rewardRemittanceFacet), _getRewardRemittanceSelectors());
        // #1104 — RiskPreviewFacet: the read-only preview cluster + the two
        // cross-facet gate asserts split off `RiskAccessFacet` (cuts[60]) so both
        // facets keep EIP-170 header room. Shares the same `LibRiskAccess` gate
        // logic through the diamond.
        cuts[63] = _buildCut(
            address(riskPreviewFacet),
            _getRiskPreviewFacetSelectors()
        );
        // #1212 (E-10 Claim-All) — generic best-effort delegatecall batcher
        // (`multicall(Call[])`). Stateless; preserves msg.sender so each
        // batched claim self-authorizes. See `MulticallFacet.sol` natspec.
        cuts[64] = _buildCut(
            address(multicallFacet),
            _getMulticallFacetSelectors()
        );
        // #1306 follow-up — InteractionRewardsLensFacet: the read-only view /
        // getter surface split off InteractionRewardsFacet (cuts[25]) for
        // EIP-170 headroom. Shares LibVaipakam storage; the 14 view selectors
        // route here instead of the (now leaner) mutating facet.
        cuts[65] = _buildCut(
            address(interactionRewardsLensFacet),
            _getInteractionRewardsLensSelectors()
        );
        // #594 — standalone holder-only consolidation entry points are cut at
        // slot 24 (see the #687-B note above).

        // ── Step 4: Execute diamond cut ─────────────────────────────────
        // Apply the facet cuts in fixed-size BATCHES so no single
        // `diamondCut` tx exceeds the RPC's per-tx gas cap. drpc caps
        // `eth_sendRawTransaction` at ~18M gas on Base Sepolia; the full
        // 61-facet cut estimates ~17.7M, and even the previous two-half
        // split now lands one half at ~17.7M (the facet set grew past
        // what two halves can carry), which forge's gas buffer pushes
        // over the cap. Batches of `CUTS_PER_BATCH` facets keep each cut
        // ~7M — comfortably under the cap even with the default 1.3x
        // buffer — and auto-scale as facets are added. Any chain that
        // accepts the single all-facets cut also accepts these batches;
        // strictly safer.
        // 4 facets/batch keeps each diamondCut ~2.7M gas; even with
        // forge's default 1.3x send-buffer that's ~3.5M — under the
        // largest facet-CREATE tx (~5.3M) drpc already accepts on Base
        // Sepolia, so every batch clears drpc's per-tx cap (an observed
        // hard wall below 17.7M) WHILE keeping the 1.3x buffer that
        // prevents small post-cut config calls from running out of the
        // 63/64-forwarded delegatecall gas. Auto-scales as facets grow.
        uint256 CUTS_PER_BATCH = 4;
        uint256 applied = 0;
        while (applied < cuts.length) {
            uint256 n = cuts.length - applied;
            if (n > CUTS_PER_BATCH) n = CUTS_PER_BATCH;
            IDiamondCut.FacetCut[] memory batch = new IDiamondCut.FacetCut[](n);
            for (uint256 i = 0; i < n; i++) {
                batch[i] = cuts[applied + i];
            }
            IDiamondCut(diamond).diamondCut(batch, address(0), "");
            applied += n;
            console.log("Diamond cut batch complete; facets applied:", applied);
            // Post-batch sanity: the loupe must report EXACTLY the facets
            // applied so far. The constructor-installed DiamondCutFacet is
            // NOT in `facetAddresses[]` (it writes the selector mapping
            // directly, bypassing the loupe registry), so the expected
            // count equals `applied`. A silently-reverted or mis-routed
            // facet write inside a batch trips this require before the
            // next batch dispatches, so no half-cut state is left behind.
            uint256 actualApplied =
                DiamondLoupeFacet(diamond).facetAddresses().length;
            require(
                actualApplied == applied,
                "DeployDiamond: batch cut did not register all facets"
            );
        }

        // Issue #72 — per-selector ownership assertion. The count check
        // above only proves "N distinct facet addresses are registered";
        // it would still pass if any selector got mis-routed (e.g. two
        // facets share a selector and the second cut overwrote the
        // first's route silently). Walk `cuts[]` — the source of truth
        // for what we just dispatched — and assert each selector resolves
        // on the live diamond to *that cut's* facet address. Catches:
        //   - Selector collisions where the later cut clobbered an
        //     earlier facet's selector without any per-cut revert.
        //   - A facet that compiled but whose runtime bytecode didn't
        //     register the expected selector set (impossible in well-
        //     formed Solidity, but the assertion is cheap and the failure
        //     mode silent without it).
        //   - Drift between the script's `_getXSelectors()` list and the
        //     actual on-chain routing (catches mismatches that the static
        //     SelectorCoverageTest would miss when run against the live
        //     deploy rather than its mirror).
        //
        // O(total selectors) — same loop the diamondCut itself walked,
        // run again as read-only loupe queries against the just-built
        // diamond. Reverts the entire broadcast if any selector is
        // mis-routed; no half-state is persisted because Foundry rolls
        // back the broadcast on require failure.
        DiamondLoupeFacet loupe = DiamondLoupeFacet(diamond);
        for (uint256 i = 0; i < cuts.length; i++) {
            for (uint256 j = 0; j < cuts[i].functionSelectors.length; j++) {
                bytes4 sel = cuts[i].functionSelectors[j];
                address routed = loupe.facetAddress(sel);
                require(
                    routed == cuts[i].facetAddress,
                    "DeployDiamond: selector routed to wrong facet"
                );
            }
        }

        // ── Step 5: Post-deployment initialization ──────────────────────
        // 5a. Initialize access control (grants all roles to admin)
        AccessControlFacet(diamond).initializeAccessControl();
        console.log("AccessControl initialized.");

        // 5b. Set treasury address
        AdminFacet(diamond).setTreasury(treasury);
        console.log("Treasury set:", treasury);

        // 5c. Initialize vault implementation (deploys template)
        VaultFactoryFacet(diamond).initializeVaultImplementation();
        console.log("Vault implementation initialized.");

        // 5d. Initialize NFT metadata
        VaipakamNFTFacet(diamond).initializeNFT();
        console.log("NFT initialized.");

        // 5e. Unpause the protocol. The Diamond is born paused (see
        //     `VaipakamDiamond.constructor` — `LibPausable.pause()` is
        //     the last constructor write) so the half-cut window
        //     between `diamondCut 1/2` and `diamondCut 2/2` cannot be
        //     exploited via half-2 selectors. By this point every
        //     facet in `cuts` is cut, every init call above has
        //     landed, and the post-cut facet-count assertion
        //     (`actualAfterCut2 == cuts.length`) has passed — safe
        //     to flip the bit back. The deployer holds PAUSER_ROLE
        //     from Step 5a's `initializeAccessControl`, so this call
        //     succeeds without an extra grant. Mainnet operators that
        //     want a multi-eye review window before unpausing can
        //     comment this line out and run a separate manual
        //     `setPaused(false)` after `--phase verify` confirms the
        //     post-cut state.
        AdminFacet(diamond).unpause();
        console.log("Protocol unpaused.");

        // 5f. Enable the canonical-limit-order (GTC) master flags
        //     (Issue #102 / ADR-0010). Each is governance-tunable via
        //     ConfigFacet.set*Enabled and defaults `false` at the
        //     contract level — the kill-switch convention from ADR-0005.
        //     Fresh Vaipakam deploys come up in GTC mode (lender ceiling
        //     / borrower floor, partial-fill both sides, full range on
        //     amount + rate + collateral) by FLIPPING THESE HERE rather
        //     than changing the storage default. Operators that want a
        //     conservative bake on a brand-new deployment can comment
        //     these four lines out and call them manually after a
        //     review window.
        //
        //     The deployer holds ADMIN_ROLE (granted by
        //     initializeAccessControl at Step 5a above), so these calls
        //     succeed before the Step 6 handover.
        ConfigFacet(diamond).setRangeAmountEnabled(true);
        ConfigFacet(diamond).setRangeRateEnabled(true);
        ConfigFacet(diamond).setRangeCollateralEnabled(true);
        ConfigFacet(diamond).setPartialFillEnabled(true);
        console.log("GTC master flags enabled (range amount/rate/collateral + partial-fill).");

        // ── Step 6: Handover to admin (only when admin != deployer) ─────
        // Phase-1 testnet pattern: deployer EOA signs the deploy but the
        // long-lived privileged EOA is a separate admin address. After the
        // handover below, deployer holds NO roles and NO ERC-173 ownership;
        // admin holds DEFAULT_ADMIN + every sub-role + ERC-173 ownership.
        // When admin == deployer (single-EOA anvil / CI setup) this block
        // is a no-op and the deployer retains everything.
        if (admin != deployerAddr) {
            // Single source of truth — the library exposes the canonical
            // role list (Findings 00010). Adding a new role to
            // `LibAccessControl.grantableRoles()` automatically flows
            // here AND through `initializeAccessControl`, so the deploy
            // script can never grant a strict subset of what the
            // library granted (which used to leave roles unowned or on
            // the deployer post-handover).
            bytes32[] memory roles = LibAccessControl.grantableRoles();

            // 6a. Grant every role to admin (deployer holds DEFAULT_ADMIN
            //     from initializeAccessControl above, which is the role
            //     admin for every other role).
            for (uint256 i = 0; i < roles.length; i++) {
                AccessControlFacet(diamond).grantRole(roles[i], admin);
            }
            console.log("All roles granted to admin:", roles.length);

            // 6b. Transfer ERC-173 ownership (gates future diamondCut).
            OwnershipFacet(diamond).transferOwnership(admin);
            console.log("ERC-173 ownership transferred to:", admin);

            // 6c. Renounce every role from deployer. DEFAULT_ADMIN_ROLE
            //     (index 0 by the library's convention) is renounced
            //     LAST so if any earlier step had reverted the deployer
            //     still holds the root admin and can recover.
            for (uint256 i = roles.length; i > 0; i--) {
                AccessControlFacet(diamond).renounceRole(
                    roles[i - 1],
                    deployerAddr
                );
            }
            console.log("Deployer renounced all roles:", roles.length);
        } else {
            console.log("admin == deployer, skipping handover.");
        }

        vm.stopBroadcast();

        // ── Step 7: Persist deployment artifact ─────────────────────────
        // Write the Diamond + vault-impl addresses to
        // `deployments/<chain-slug>/addresses.json`. Every subsequent
        // script (Configure*, Wire*, Upgrade*, seeders, smoke tests)
        // reads from this file via `Deployments.readDiamond()` etc.
        // — operators no longer need to chain-prefix env vars across
        // every follow-on broadcast. The file is committed and is the
        // canonical source of truth post-deploy. Writes happen OUTSIDE
        // the broadcast (no on-chain effect) so a missing FS-write
        // permission only fails the file step, not the deploy.
        //
        // Issue #72 — operator/test escape hatch: set
        // `DEPLOY_SKIP_ARTIFACTS=true` to bypass the addresses.json
        // writes entirely. The deploy-integration test sets this so a
        // `forge test` run can exercise `run()` end-to-end (Steps 1–6
        // including the per-selector ownership assertion above) without
        // clobbering the committed `deployments/anvil/addresses.json`
        // every CI invocation. Also useful for dry-run-style local
        // experiments where the operator wants to deploy + inspect the
        // diamond without overwriting the artifact in their working tree.
        if (vm.envOr("DEPLOY_SKIP_ARTIFACTS", false)) {
            console.log("DEPLOY_SKIP_ARTIFACTS=true -- skipping addresses.json writes.");
            return;
        }

        Deployments.writeChainHeader();
        Deployments.writeDiamond(diamond);

        // Issue #69 — record the authoritative facet count into
        // addresses.json so the shell verify phase exact-matches the
        // live diamond against it. This is the single source of truth:
        // no hardcoded facet count drifts in the deploy scripts.
        // Written here, after `vm.stopBroadcast()` and alongside the
        // other artifact writes — never mid-broadcast — so a revert in
        // Step 5/6 can't leave a `.facetCount` that disagrees with the
        // `.diamond` / facet-address keys still describing the prior
        // deploy.
        Deployments.writeUint(".facetCount", cuts.length);

        // Per-chain context that downstream scripts (and the frontend
        // env builder) consume directly from addresses.json:
        //   - chainSlug:   stable identifier matching the directory
        //   - lzEndpoint:  LayerZero V2 EndpointV2 for this chain
        //   - lzEid:       LayerZero V2 endpoint id
        //   - deployBlock: l2 block in which the Diamond proxy was created
        //                  (frontend uses this as the lower-bound for
        //                  log scans — `eth_getLogs(fromBlock=deployBlock)`).
        //                  On Arbitrum chains the EVM `block.number` opcode
        //                  returns the l1 block (sequencer-approximate),
        //                  NOT the l2 block where the deploy actually
        //                  landed. `Deployments.writeDeployBlock()` (no
        //                  arg) reads ArbSys.arbBlockNumber() on Arb
        //                  chains and falls through to block.number
        //                  elsewhere. Do NOT pass block.number directly
        //                  from this script.
        //   - vaultImpl:  per-user UUPS vault template the factory
        //                  clones; surfaced via `getVaipakamVaultImplementationAddress()`
        //   - weth/treasury/admin: shared addresses every operator UI
        //                  cross-references against the .env they hold
        //
        // All of these are stable for the lifetime of this Diamond
        // deploy; rewriting them on each run is idempotent.
        Deployments.writeChainSlug();
        Deployments.writeLzEid(Deployments.lzEidForChain());
        Deployments.writeDeployBlock();
        Deployments.writeVaultImpl(
            VaultFactoryFacet(diamond)
                .getVaipakamVaultImplementationAddress()
        );
        Deployments.writeTreasury(treasury);
        Deployments.writeAdmin(admin);

        // Per-facet addresses — written under `.facets.<key>`. The
        // Diamond proxy is the only address frontend / dApp callers
        // need at runtime, but per-facet addresses are surfaced so
        // explorer-link UIs (PublicDashboard "Transparency" block) can
        // deep-link to the actual implementation contract for each
        // selector group, and so post-deploy upgrade scripts have a
        // stable handle without re-reading the broadcast log.
        Deployments.writeFacet("diamondCutFacet",         address(cutFacet));
        Deployments.writeFacet("diamondLoupeFacet",       address(loupeFacet));
        Deployments.writeFacet("ownershipFacet",          address(ownershipFacet));
        Deployments.writeFacet("accessControlFacet",      address(accessControlFacet));
        Deployments.writeFacet("adminFacet",              address(adminFacet));
        Deployments.writeFacet("profileFacet",            address(profileFacet));
        Deployments.writeFacet("oracleFacet",             address(oracleFacet));
        Deployments.writeFacet("oracleAdminFacet",        address(oracleAdminFacet));
        Deployments.writeFacet("vaipakamNFTFacet",        address(nftFacet));
        Deployments.writeFacet("vaultFactoryFacet",      address(vaultFactoryFacet));
        Deployments.writeFacet("offerCreateFacet",        address(offerCreateFacet));
        Deployments.writeFacet("offerParallelSaleFacet",  address(offerParallelSaleFacet));
        Deployments.writeFacet("offerAcceptFacet",        address(offerAcceptFacet));
        Deployments.writeFacet("offerMatchFacet",         address(offerMatchFacet));
        Deployments.writeFacet("offerCancelFacet",        address(offerCancelFacet));
        // #193 / Codex round-2 — persist OfferMutateFacet for explorer
        // transparency links, operator scripts, and upgrade audits.
        Deployments.writeFacet("offerMutateFacet",        address(offerMutateFacet));
        Deployments.writeFacet("loanFacet",               address(loanFacet));
        Deployments.writeFacet("repayFacet",              address(repayFacet));
        Deployments.writeFacet("repayPeriodicFacet",      address(repayPeriodicFacet));
        Deployments.writeFacet("swapToRepayFacet",        address(swapToRepayFacet));
        Deployments.writeFacet("defaultedFacet",          address(defaultedFacet));
        Deployments.writeFacet("riskFacet",               address(riskFacet));
        Deployments.writeFacet("riskMatchLiquidationFacet", address(riskMatchLiquidationFacet));
        Deployments.writeFacet("riskSplitLiquidationFacet", address(riskSplitLiquidationFacet));
        Deployments.writeFacet("claimFacet",              address(claimFacet));
        Deployments.writeFacet("addCollateralFacet",      address(addCollateralFacet));
        Deployments.writeFacet("treasuryFacet",           address(treasuryFacet));
        Deployments.writeFacet("payrollFacet",            address(payrollFacet));
        Deployments.writeFacet("earlyWithdrawalFacet",    address(earlyWithdrawalFacet));
        Deployments.writeFacet("partialWithdrawalFacet",  address(partialWithdrawalFacet));
        Deployments.writeFacet("precloseFacet",           address(precloseFacet));
        Deployments.writeFacet("prepayListingFacet",      address(prepayListingFacet));
        Deployments.writeFacet("refinanceFacet",          address(refinanceFacet));
        Deployments.writeFacet("metricsFacet",            address(metricsFacet));
        Deployments.writeFacet("metricsDashboardFacet",   address(metricsDashboardFacet));
        Deployments.writeFacet("vpfiTokenFacet",          address(vpfiTokenFacet));
        Deployments.writeFacet("vpfiDiscountFacet",       address(vpfiDiscountFacet));
        Deployments.writeFacet("vpfiDiscountAccumulatorFacet", address(vpfiDiscountAccumulatorFacet));
        Deployments.writeFacet("mirrorTierReceiverFacet", address(mirrorTierReceiverFacet));
        Deployments.writeFacet("protocolBroadcastFacet", address(protocolBroadcastFacet));
        Deployments.writeFacet("interactionRewardsFacet", address(interactionRewardsFacet));
        Deployments.writeFacet("interactionRewardsLensFacet", address(interactionRewardsLensFacet));
        Deployments.writeFacet("rewardReporterFacet",     address(rewardReporterFacet));
        Deployments.writeFacet("rewardAggregatorFacet",   address(rewardAggregatorFacet));
        Deployments.writeFacet("rewardRemittanceFacet",   address(rewardRemittanceFacet));
        Deployments.writeFacet("configFacet",             address(configFacet));
        // #394 (Codex #647 round-8 P2) — persist the carved-out NumeraireConfigFacet
        // so addresses.json (explorer verification / upgrade scripts / audits) can
        // locate its selector group.
        Deployments.writeFacet("numeraireConfigFacet",    address(numeraireConfigFacet));
        Deployments.writeFacet("legalFacet",              address(legalFacet));
        Deployments.writeFacet("autoLifecycleFacet",      address(autoLifecycleFacet));
        Deployments.writeFacet("encumbranceMutateFacet",  address(encumbranceMutateFacet));
        // #393 v1 — LenderIntentVault standing-terms surface.
        Deployments.writeFacet("lenderIntentFacet",       address(lenderIntentFacet));
        // #671 — progressive risk-access facet (per-vault tiers + consent).
        Deployments.writeFacet("riskAccessFacet",         address(riskAccessFacet));
        Deployments.writeFacet("riskPreviewFacet",        address(riskPreviewFacet));
        Deployments.writeFacet("multicallFacet",          address(multicallFacet));

        console.log(
            "Wrote addresses to deployments/",
            Deployments.chainSlug(),
            "/addresses.json"
        );

        // ── Summary ─────────────────────────────────────────────────────
        console.log("");
        console.log("=== Deployment Summary ===");
        console.log("Diamond:              ", diamond);
        console.log("DiamondCutFacet:      ", address(cutFacet));
        console.log("DiamondLoupeFacet:    ", address(loupeFacet));
        console.log("OwnershipFacet:       ", address(ownershipFacet));
        console.log("AccessControlFacet:   ", address(accessControlFacet));
        console.log("AdminFacet:           ", address(adminFacet));
        console.log("ProfileFacet:         ", address(profileFacet));
        console.log("OracleFacet:          ", address(oracleFacet));
        console.log("OracleAdminFacet:     ", address(oracleAdminFacet));
        console.log("VaipakamNFTFacet:     ", address(nftFacet));
        console.log("VaultFactoryFacet:   ", address(vaultFactoryFacet));
        console.log("OfferCreateFacet:     ", address(offerCreateFacet));
        console.log("OfferParallelSaleFacet:", address(offerParallelSaleFacet));
        console.log("OfferAcceptFacet:     ", address(offerAcceptFacet));
        console.log("OfferMatchFacet:      ", address(offerMatchFacet));
        console.log("OfferCancelFacet:     ", address(offerCancelFacet));
        console.log("OfferMutateFacet:     ", address(offerMutateFacet));
        console.log("LoanFacet:            ", address(loanFacet));
        console.log("RepayFacet:           ", address(repayFacet));
        console.log("RepayPeriodicFacet:   ", address(repayPeriodicFacet));
        console.log("SwapToRepayFacet:     ", address(swapToRepayFacet));
        console.log("DefaultedFacet:       ", address(defaultedFacet));
        console.log("RiskFacet:            ", address(riskFacet));
        console.log("RiskMatchLiquidationFacet:", address(riskMatchLiquidationFacet));
        console.log("RiskSplitLiquidationFacet:", address(riskSplitLiquidationFacet));
        console.log("ClaimFacet:           ", address(claimFacet));
        console.log("AddCollateralFacet:   ", address(addCollateralFacet));
        console.log("TreasuryFacet:        ", address(treasuryFacet));
        console.log("PayrollFacet:         ", address(payrollFacet));
        console.log("EarlyWithdrawalFacet: ", address(earlyWithdrawalFacet));
        console.log("PartialWithdrawalFacet:", address(partialWithdrawalFacet));
        console.log("PrecloseFacet:        ", address(precloseFacet));
        console.log("PrepayListingFacet:   ", address(prepayListingFacet));
        console.log("NFTPrepayListingFacet:", address(nftPrepayListingFacet));
        console.log("NFTPrepayDutchListingFacet:", address(nftPrepayDutchListingFacet));
        console.log("NFTPrepayListingAtomicFacet:", address(nftPrepayListingAtomicFacet));
        console.log("RefinanceFacet:       ", address(refinanceFacet));
        console.log("MetricsFacet:         ", address(metricsFacet));
        console.log("MetricsDashboardFacet:", address(metricsDashboardFacet));
        console.log("VPFITokenFacet:       ", address(vpfiTokenFacet));
        console.log("VPFIDiscountFacet:    ", address(vpfiDiscountFacet));
        console.log("VPFIDiscountAccumulatorFacet:", address(vpfiDiscountAccumulatorFacet));
        console.log("MirrorTierReceiverFacet:", address(mirrorTierReceiverFacet));
        console.log("ProtocolBroadcastFacet:", address(protocolBroadcastFacet));
        console.log("InteractionRewardsFacet:", address(interactionRewardsFacet));
        console.log("InteractionRewardsLensFacet:", address(interactionRewardsLensFacet));
        console.log("RewardReporterFacet:  ", address(rewardReporterFacet));
        console.log("RewardAggregatorFacet:", address(rewardAggregatorFacet));
        console.log("RewardRemittanceFacet:", address(rewardRemittanceFacet));
        console.log("ConfigFacet:          ", address(configFacet));
        console.log("NumeraireConfigFacet: ", address(numeraireConfigFacet));
        console.log("RiskAccessFacet:      ", address(riskAccessFacet));
        console.log("RiskPreviewFacet:     ", address(riskPreviewFacet));
        console.log("Admin:                ", admin);
        console.log("Treasury:             ", treasury);
        console.log("");
        console.log("!! Cross-chain reward plumbing still requires per-chain wiring:");
        console.log("   - RewardReporterFacet.setRewardMessenger / setBaseChainId");
        console.log("   - RewardReporterFacet.setIsCanonicalRewardChain (true only on Base)");
        console.log("   - RewardAggregatorFacet.setExpectedSourceChainIds (Base only)");
        console.log("   See docs/ops/DeploymentRunbook.md section 3.");
    }

    // ── Helper: build a FacetCut struct ─────────────────────────────────
    function _buildCut(
        address facet,
        bytes4[] memory selectors
    ) internal pure returns (IDiamondCut.FacetCut memory) {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    // ── Selector arrays (mirrors HelperTest.sol) ────────────────────────

    function _getLoupeSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = bytes4(keccak256("facets()"));
        s[1] = bytes4(keccak256("facetFunctionSelectors(address)"));
        s[2] = bytes4(keccak256("facetAddresses()"));
        s[3] = bytes4(keccak256("facetAddress(bytes4)"));
        s[4] = bytes4(keccak256("supportsInterface(bytes4)"));
    }

    function _getOwnershipSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = OwnershipFacet.transferOwnership.selector;
        s[1] = OwnershipFacet.owner.selector;
    }

    function _getAccessControlSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](15);
        s[0] = AccessControlFacet.initializeAccessControl.selector;
        s[1] = AccessControlFacet.grantRole.selector;
        s[2] = AccessControlFacet.revokeRole.selector;
        s[3] = AccessControlFacet.renounceRole.selector;
        s[4] = AccessControlFacet.hasRole.selector;
        s[5] = AccessControlFacet.getRoleAdmin.selector;
        s[6] = AccessControlFacet.DEFAULT_ADMIN_ROLE.selector;
        s[7] = AccessControlFacet.ADMIN_ROLE.selector;
        s[8] = AccessControlFacet.PAUSER_ROLE.selector;
        s[9] = AccessControlFacet.KYC_ADMIN_ROLE.selector;
        s[10] = AccessControlFacet.ORACLE_ADMIN_ROLE.selector;
        s[11] = AccessControlFacet.RISK_ADMIN_ROLE.selector;
        s[12] = AccessControlFacet.VAULT_ADMIN_ROLE.selector;
        // Hot-path role-revoke for incident response. Distinct from
        // the timelocked `revokeRole` so a Pauser (or other emergency
        // role-holder) can pull a compromised key without waiting
        // 48h. See AccessControlFacet implementation for the role
        // gate that scopes this.
        s[13] = AccessControlFacet.emergencyRevokeRole.selector;
        // Atomic role + ERC-173 ownership handover (Item 3 of the
        // 2026-05-06 rehearsal follow-ups). Replaces the legacy
        // 23-tx grant + transferOwnership + renounce sequence.
        // Gated by `onlyRole(DEFAULT_ADMIN_ROLE)`.
        s[14] = AccessControlFacet.transferAdmin.selector;
    }

    function _getAdminSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](48);
        s[0] = AdminFacet.setTreasury.selector;
        s[1] = AdminFacet.getTreasury.selector;
        s[2] = AdminFacet.setZeroExProxy.selector;
        s[3] = AdminFacet.setallowanceTarget.selector;
        s[4] = AdminFacet.pause.selector;
        s[5] = AdminFacet.unpause.selector;
        s[6] = AdminFacet.paused.selector;
        s[7] = AdminFacet.setKYCEnforcement.selector;
        s[8] = AdminFacet.isKYCEnforcementEnabled.selector;
        s[9] = AdminFacet.pauseAsset.selector;
        s[10] = AdminFacet.unpauseAsset.selector;
        s[11] = AdminFacet.isAssetPaused.selector;
        s[12] = AdminFacet.addSwapAdapter.selector;
        s[13] = AdminFacet.removeSwapAdapter.selector;
        s[14] = AdminFacet.reorderSwapAdapters.selector;
        s[15] = AdminFacet.getSwapAdapters.selector;
        s[16] = AdminFacet.setPancakeswapV3Factory.selector;
        s[17] = AdminFacet.getPancakeswapV3Factory.selector;
        s[18] = AdminFacet.setSushiswapV3Factory.selector;
        s[19] = AdminFacet.getSushiswapV3Factory.selector;
        // Auto-pause primitive (Phase 1 follow-up): WATCHER_ROLE-gated
        // entry that freezes the protocol for
        // `cfgAutoPauseDurationSeconds` while humans investigate. Plus
        // a `pausedUntil` view for the frontend countdown.
        s[20] = AdminFacet.autoPause.selector;
        s[21] = AdminFacet.pausedUntil.selector;
        // Depth-tiered LTV (Piece B follow-up b) — Uni-V2-fork family
        // setters/getters consulted by `OracleFacet.getLiquidityTier`'s
        // route search alongside the V3 trio. Zero ⇒ that leg skipped.
        s[22] = AdminFacet.setUniswapV2Factory.selector;
        s[23] = AdminFacet.getUniswapV2Factory.selector;
        s[24] = AdminFacet.setSushiswapV2Factory.selector;
        s[25] = AdminFacet.getSushiswapV2Factory.selector;
        s[26] = AdminFacet.setPancakeswapV2Factory.selector;
        s[27] = AdminFacet.getPancakeswapV2Factory.selector;
        // T-092 (#508) — auto-lifecycle admin kill switches.
        s[28] = AdminFacet.setAutoLendEnabled.selector;
        s[29] = AdminFacet.setAutoRefinanceEnabled.selector;
        s[30] = AdminFacet.setAutoExtendEnabled.selector;
        // Codex round-1 P2 — getters.
        s[31] = AdminFacet.getAutoLendEnabled.selector;
        s[32] = AdminFacet.getAutoRefinanceEnabled.selector;
        s[33] = AdminFacet.getAutoExtendEnabled.selector;
        // #633 — per-venue swap-adapter pause + feature kill-switches.
        s[34] = AdminFacet.setSwapAdapterDisabled.selector;
        s[35] = AdminFacet.isSwapAdapterDisabled.selector;
        s[36] = AdminFacet.setAggregatorAdaptersPaused.selector;
        s[37] = AdminFacet.setKeepersPaused.selector;
        s[38] = AdminFacet.setPeerLtvReadsPaused.selector;
        s[39] = AdminFacet.keepersPaused.selector;
        // #395 — graduated partial-liquidation sizing (Approach A).
        s[40] = AdminFacet.setPartialLiquidationSizing.selector;
        s[41] = AdminFacet.getPartialLiquidationSizing.selector;
        // #400 -- pluggable quote-time rate model.
        s[42] = AdminFacet.setRateModel.selector;
        s[43] = AdminFacet.getRateModel.selector;
        s[44] = AdminFacet.disableRateModel.selector;
        s[45] = AdminFacet.setRateModelMaxDeviationBps.selector;
        s[46] = AdminFacet.getRateModelMaxDeviationBps.selector;
        s[47] = AdminFacet.getMaxPartialLiquidationCloseFactorBps.selector;
    }

    function _getProfileSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](30);
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
        s[15] = ProfileFacet.setLoanKeeperEnabled.selector;
        s[16] = ProfileFacet.isApprovedKeeper.selector;
        // Phase 6 additions
        s[17] = ProfileFacet.setOfferKeeperEnabled.selector;
        s[18] = ProfileFacet.setKeeperActions.selector;
        s[19] = ProfileFacet.getKeeperActions.selector;
        s[20] = ProfileFacet.isLoanKeeperEnabled.selector;
        s[21] = ProfileFacet.isOfferKeeperEnabled.selector;
        // Phase 4.3 sanctions-screen surface. The oracle is set per
        // chain (Chainalysis-style); when unset the on-chain
        // `isSanctionedAddress` returns false and offer-create /
        // offer-accept simply skip the screen.
        s[22] = ProfileFacet.setSanctionsOracle.selector;
        s[23] = ProfileFacet.getSanctionsOracle.selector;
        s[24] = ProfileFacet.isSanctionedAddress.selector;
        // #1123 — confirmed-flagged registry sync (permissionless) + read + the
        // self-only movement-gate host.
        s[25] = ProfileFacet.refreshSanctionsFlag.selector;
        s[26] = ProfileFacet.isSanctionsConfirmedFlagged.selector;
        s[27] = ProfileFacet.enforcePositionMoveNotSanctioned.selector;
        s[28] = ProfileFacet.enforcePositionSaleMove.selector;
        // #1144 — registry-aware prepay-sale fill bar (read by CollateralListingExecutor).
        s[29] = ProfileFacet.isRecipientBarred.selector;
    }

    function _getOracleSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](18);
        s[0] = OracleFacet.checkLiquidity.selector;
        s[1] = OracleFacet.getAssetPrice.selector;
        s[2] = OracleFacet.calculateLTV.selector;
        s[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
        s[4] = OracleFacet.getAssetRiskProfile.selector;
        s[5] = OracleFacet.getIlliquidAssets.selector;
        s[6] = OracleFacet.isAssetSupported.selector;
        s[7] = OracleFacet.getSequencerUptimeFeed.selector;
        s[8] = OracleFacet.sequencerHealthy.selector;
        // AnalyticalGettersDesign §3.4 — daily price-snapshot ring
        // buffer for historical TVL reconstruction.
        s[9] = OracleFacet.captureDailyPriceSnapshot.selector;
        s[10] = OracleFacet.getHistoricalAssetPrice.selector;
        // Depth-tiered LTV (Piece B) — the on-chain liquidity-tier
        // authority + the keeper-min effective tier the loan-init LTV
        // cap consults. See
        // docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md §4.2.
        s[11] = OracleFacet.getLiquidityTier.selector;
        s[12] = OracleFacet.getEffectiveLiquidityTier.selector;
        // Phase 2 of AutonomousLtvAndOracleFallback.md — try-wrapped
        // `getAssetPrice` for callers (LibFallback) that need to detect
        // oracle-quorum unavailability without reverting.
        s[13] = OracleFacet.tryGetAssetPrice.selector;
        // Phase 4 of AutonomousLtvAndOracleFallback.md — autonomous
        // tier-LTV cache. Permissionless refresh + the two views the
        // loan-init gate / protocol-console consume.
        s[14] = OracleFacet.refreshTierLtvCache.selector;
        s[15] = OracleFacet.getTierLtvCacheEntry.selector;
        s[16] = OracleFacet.getEffectiveTierMaxInitLtvBps.selector;
        // #638 — read-only live-secondary-feed counter, consumed only by the
        // backstop oracle-coverage gate (LibBackstopOracleGate).
        s[17] = OracleFacet.countLiveSecondaryOracleFeeds.selector;
    }

    function _getOracleAdminSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](34);
        s[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        s[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        s[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        s[3] = OracleAdminFacet.setWethContract.selector;
        s[4] = OracleAdminFacet.setEthUsdFeed.selector;
        s[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        s[6] = OracleAdminFacet.setStableTokenFeed.selector;
        s[7] = OracleAdminFacet.setSequencerUptimeFeed.selector;
        // Phase 3.1 — per-feed override: tighten staleness or set a
        // minimum-valid-answer floor for a specific Chainlink
        // aggregator. Only ever stricter than the global default;
        // the override never loosens.
        s[8] = OracleAdminFacet.setFeedOverride.selector;
        s[9] = OracleAdminFacet.getFeedOverride.selector;
        // Phase 7b.2 — Soft 2-of-N secondary oracle quorum across
        // Tellor + API3 + DIA. Each address can be unset on chains
        // where the secondary isn't deployed; when EVERY secondary
        // is unavailable the protocol falls back to Chainlink-only
        // (graceful) per OracleFacet._enforceSecondaryQuorum.
        s[10] = OracleAdminFacet.setTellorOracle.selector;
        s[11] = OracleAdminFacet.getTellorOracle.selector;
        s[12] = OracleAdminFacet.setApi3ServerV1.selector;
        s[13] = OracleAdminFacet.getApi3ServerV1.selector;
        s[14] = OracleAdminFacet.setDIAOracleV2.selector;
        s[15] = OracleAdminFacet.getDIAOracleV2.selector;
        s[16] = OracleAdminFacet.setSecondaryOracleMaxDeviationBps.selector;
        s[17] = OracleAdminFacet.getSecondaryOracleMaxDeviationBps.selector;
        s[18] = OracleAdminFacet.setSecondaryOracleMaxStaleness.selector;
        s[19] = OracleAdminFacet.getSecondaryOracleMaxStaleness.selector;
        // Phase 7b.3 — Pyth cross-check + per-knob single-value getters
        // consumed by the protocol-console knob registry.
        s[20] = OracleAdminFacet.setPythOracle.selector;
        s[21] = OracleAdminFacet.getPythOracle.selector;
        s[22] = OracleAdminFacet.setPythCrossCheckFeedId.selector;
        s[23] = OracleAdminFacet.getPythNumeraireFeedId.selector;
        s[24] = OracleAdminFacet.setPythMaxStalenessSeconds.selector;
        s[25] = OracleAdminFacet.getPythMaxStalenessSeconds.selector;
        s[26] = OracleAdminFacet.setPythCrossCheckMaxDeviationBps.selector;
        s[27] = OracleAdminFacet.getPythNumeraireMaxDeviationBps.selector;
        s[28] = OracleAdminFacet.setPythConfidenceMaxBps.selector;
        s[29] = OracleAdminFacet.getPythConfidenceMaxBps.selector;
        // Phase 3 of AutonomousLtvAndOracleFallback.md — per-chain
        // peer-lending-protocol addresses the autonomous tier-LTV cache
        // reads (Aave V3 PoolDataProvider, Compound V3 Comet, Morpho-Blue).
        // Set via owner-only setter; Phase 4 builds the refresh function
        // on top of these addresses.
        s[30] = OracleAdminFacet.setPeerProtocolAddresses.selector;
        s[31] = OracleAdminFacet.getPeerProtocolAddresses.selector;
        // Phase 4 of AutonomousLtvAndOracleFallback.md — per-tier
        // reference asset list (constitution-level governance set).
        s[32] = OracleAdminFacet.setTierReferenceAssets.selector;
        s[33] = OracleAdminFacet.getTierReferenceAssets.selector;
    }

    function _getNftSelectors() internal pure returns (bytes4[] memory s) {
        // supportsInterface is intentionally omitted — DiamondLoupeFacet owns
        // that selector. _registerNftInterfaces() writes the ERC-721 / metadata
        // interface IDs into LibDiamond storage so the Loupe's implementation
        // returns true for them.
        s = new bytes4[](29);
        s[0] = VaipakamNFTFacet.mintNFT.selector;
        s[1] = VaipakamNFTFacet.updateNFTStatus.selector;
        s[2] = VaipakamNFTFacet.burnNFT.selector;
        s[3] = VaipakamNFTFacet.tokenURI.selector;
        s[4] = VaipakamNFTFacet.initializeNFT.selector;
        s[5] = bytes4(keccak256("ownerOf(uint256)"));
        s[6] = VaipakamNFTFacet.contractURI.selector;
        s[7] = VaipakamNFTFacet.setContractImageURI.selector;
        s[8] = VaipakamNFTFacet.royaltyInfo.selector;
        s[9] = VaipakamNFTFacet.setDefaultRoyalty.selector;
        // Status-keyed image URI scheme (replaces the prior 4-slot
        // setLoanImageURIs). Granular per-(LoanPositionStatus,
        // isLender) overrides + per-side defaults + a read-back view.
        s[10] = VaipakamNFTFacet.setImageURIForStatus.selector;
        // Native ERC-721 + lock API added in the transfer-lock refactor.
        s[11] = VaipakamNFTFacet.name.selector;
        s[12] = VaipakamNFTFacet.symbol.selector;
        s[13] = VaipakamNFTFacet.balanceOf.selector;
        s[14] = VaipakamNFTFacet.approve.selector;
        s[15] = VaipakamNFTFacet.getApproved.selector;
        s[16] = VaipakamNFTFacet.setApprovalForAll.selector;
        s[17] = VaipakamNFTFacet.isApprovedForAll.selector;
        s[18] = VaipakamNFTFacet.transferFrom.selector;
        // `safeTransferFrom` is overloaded, so we hash the full signatures.
        s[19] = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
        s[20] = bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"));
        s[21] = VaipakamNFTFacet.positionLock.selector;
        // IERC721Enumerable — enumerable without event scans.
        s[22] = bytes4(keccak256("totalSupply()"));
        s[23] = bytes4(keccak256("tokenByIndex(uint256)"));
        s[24] = bytes4(keccak256("tokenOfOwnerByIndex(address,uint256)"));
        s[25] = VaipakamNFTFacet.nftStatusOf.selector;
        // OpenSea `external_url` admin config — sets the base URL
        // emitted in tokenURI's JSON for marketplace deep-links.
        s[26] = VaipakamNFTFacet.setExternalUrlBase.selector;
        // Status-keyed image URI scheme companions:
        s[27] = VaipakamNFTFacet.setDefaultImage.selector;
        s[28] = VaipakamNFTFacet.getImageURIFor.selector;
    }

    function _getVaultFactorySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](32);
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
        s[18] = VaultFactoryFacet.getUserVaultAddress.selector;
        s[19] = VaultFactoryFacet.getVaultVersionInfo.selector;
        s[20] = VaultFactoryFacet.vaultSetNFTUser1155.selector;
        s[21] = VaultFactoryFacet.vaultGetNFTQuantity.selector;
        // T-051 / T-054 — chokepoint deposit + counter-only companions.
        // `vaultDepositERC20From` is the third-party-payer variant
        // RepayFacet uses to pull repayment funds from the borrower
        // into the lender's vault; without this selector cut, every
        // ERC-20 loan repayment reverts with FunctionDoesNotExist.
        s[22] = VaultFactoryFacet.vaultDepositERC20From.selector;
        s[23] = VaultFactoryFacet.recordVaultDepositERC20.selector;
        s[24] = VaultFactoryFacet.getProtocolTrackedVaultBalance.selector;
        // T-054 PR-3 — stuck-token recovery EIP-712 surface.
        s[25] = VaultFactoryFacet.recoverStuckERC20.selector;
        s[26] = VaultFactoryFacet.disown.selector;
        s[27] = VaultFactoryFacet.recoveryDomainSeparator.selector;
        s[28] = VaultFactoryFacet.recoveryAckTextHash.selector;
        s[29] = VaultFactoryFacet.recoveryNonce.selector;
        s[30] = VaultFactoryFacet.vaultBannedSource.selector;
        // RL-1 — Diamond-funded vault credit primitive (reward
        // claim-to-vault delivery).
        s[31] = VaultFactoryFacet.vaultCreditFromDiamondERC20.selector;
    }

    /// @dev Issue #67 — `OfferFacet` was split into `OfferCreateFacet`
    ///      and `OfferAcceptFacet` for EIP-170 headroom. The former
    ///      `_getOfferSelectors()` seven entries are partitioned across
    ///      the two getters below; selector VALUES are unchanged.
    function _getOfferCreateSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = OfferCreateFacet.createOffer.selector;
        s[1] = OfferCreateFacet.getUserVault.selector;
        // Phase 8b.1 Permit2 addition.
        s[2] = OfferCreateFacet.createOfferWithPermit.selector;
        // Cross-facet entry used by `PrecloseFacet.offsetWithNewOffer`
        // (Option 3) to mint a new lender offer without colliding on
        // the shared diamond reentrancy guard the caller already holds.
        // `address(this)`-only gated inside the facet body.
        s[3] = OfferCreateFacet.createOfferInternal.selector;
        // #396 v0.5 — cross-facet materialize entries used by
        // `SignedOfferFacet` to mint a normal on-chain offer from a
        // signed off-chain offer (vault-backed + wallet-backed Permit2
        // witness). `address(this)`-only gated inside the facet body.
        s[4] = OfferCreateFacet.createSignedOfferVault.selector;
        s[5] = OfferCreateFacet.createSignedOfferWallet.selector;
        // #400 — quote-time rate-model resolver (read-only guidance / the
        // entry automated pricing flows call; manual offers are untouched).
        s[6] = OfferCreateFacet.quoteOfferRateBps.selector;
    }

    /// @dev T-086 Round-8 (#358) — borrow-OR-sell parallel-sale facet
    ///      selectors. Carved off `OfferCreateFacet` so solc's viaIR
    ///      jump-table reservation stays under the "Tag too large" ICE
    ///      ceiling.
    function _getOfferParallelSaleSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = OfferParallelSaleFacet.postParallelSaleListing.selector;
        s[1] = OfferParallelSaleFacet.releaseParallelSaleLock.selector;
        // #1144 (S10 Invariant B) — permissionless offer-keyed prepay-sale
        // sanctions sync (register flagged consideration recipients + cancel).
        s[2] = OfferParallelSaleFacet.syncPrepaySaleOffer.selector;
    }

    function _getOfferAcceptSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = OfferAcceptFacet.acceptOffer.selector;
        // Phase 8b.1 Permit2 addition.
        s[1] = OfferAcceptFacet.acceptOfferWithPermit.selector;
        // Cross-facet entry point used exclusively by
        // `OfferMatchFacet.matchOffers` to invoke the same
        // `_acceptOffer` plumbing without re-acquiring the shared
        // nonReentrant lock. `address(this)`-only gated inside the
        // facet body — EOAs cannot call it through the fallback.
        s[2] = OfferAcceptFacet.acceptOfferInternal.selector;
        // #980 — `previewAccept` moved to `OfferPreviewFacet`
        // (`_getOfferPreviewSelectors`) to free OfferAcceptFacet EIP-170 headroom.
        // #627 — public KYC-value view; the aggregator adapter calls it to
        // screen its real principal at the exact accept-path valuation.
        s[3] = OfferAcceptFacet.calculateTransactionValueNumeraire.selector;
        // #662 — anti-phishing accept-term binding surface. `verifyAndBindAccept`
        // is the diamond-internal gated cross-facet hop SignedOfferFacet uses to
        // share the one binding implementation (`address(this)`-only, like
        // `acceptOfferInternal`). The EIP-712 digest is computed client-side
        // (frontend `signTypedData`; tests `LibAcceptTerms.digestFor`) — there is
        // no on-chain `hashAcceptTerms` view (removed for EIP-170 headroom, #730).
        // The direct-path offerKey (`keccak256(abi.encode(offerId))`) is likewise
        // client-side.
        s[4] = OfferAcceptFacet.verifyAndBindAccept.selector;
        // `cancelOffer`, `getCompatibleOffers`, `getOffer`, and
        // `getOfferDetails` live on `OfferCancelFacet` — see
        // `_getOfferCancelSelectors`.
    }

    /// @dev #980 — `OfferPreviewFacet.previewAccept`, split out of
    ///      OfferAcceptFacet for EIP-170 headroom. Single view selector.
    function _getOfferPreviewSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = OfferPreviewFacet.previewAccept.selector;
    }

    /// @dev OfferMatchFacet — Range Orders Phase 1 bot-driven offer
    ///      matching surface. Carved out of OfferFacet to bring it
    ///      under EIP-170; same selectors, separate facet.
    function _getOfferMatchSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        // `matchOffers` is the write entry bots submit; `previewMatch`
        // is the structured-error view they consult before
        // submitting. `matchSignedOffer` (#396 v0.6) is the keeper entry
        // for filling a signed off-chain offer against an on-chain
        // counterparty. `matchIntent` (#393 v1-b) fills a lender's
        // standing intent. All gated on the `partialFillEnabled` master
        // flag inside the facet body.
        s[0] = OfferMatchFacet.matchOffers.selector;
        s[1] = OfferMatchFacet.previewMatch.selector;
        s[2] = OfferMatchFacet.matchSignedOffer.selector;
        s[3] = OfferMatchFacet.matchIntent.selector;
    }

    /// @dev OfferCancelFacet — cancellation + read views carved out of
    ///      `OfferFacet` to bring it under EIP-170. Same selectors,
    ///      separate facet — frontend and keeper-bot bindings
    ///      unaffected by the move.
    function _getOfferCancelSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](6);
        s[0] = OfferCancelFacet.cancelOffer.selector;
        s[1] = OfferCancelFacet.getCompatibleOffers.selector;
        s[2] = OfferCancelFacet.getOffer.selector;
        s[3] = OfferCancelFacet.getOfferDetails.selector;
        // #662/#725 — linked-loan getter for the AcceptTerms.linkedLoanId field.
        s[4] = OfferCancelFacet.getOfferLinkedLoanId.selector;
        // #951 v2 — permissionless stale-sale-listing teardown.
        s[5] = OfferCancelFacet.teardownStaleSaleListing.selector;
    }

    /// @dev OfferMutateFacet — #193 in-place modification surface
    ///      (setOfferAmount / setOfferRate / setOfferCollateral +
    ///      combined modifyOffer). Sibling of OfferCancel / OfferMatch.
    function _getOfferMutateSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = OfferMutateFacet.setOfferAmount.selector;
        s[1] = OfferMutateFacet.setOfferRate.selector;
        s[2] = OfferMutateFacet.setOfferCollateral.selector;
        s[3] = OfferMutateFacet.modifyOffer.selector;
    }

    function _getLoanSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = LoanFacet.initiateLoan.selector;
        s[1] = LoanFacet.getLoanDetails.selector;
        s[2] = LoanFacet.getLoanConsents.selector;
        // T-032 — notification-bill writer entry. NOTIF_BILLER_ROLE-gated.
        s[3] = LoanFacet.markNotifBilled.selector;
    }

    function _getRepaySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = RepayFacet.repayLoan.selector;
        s[1] = RepayFacet.repayPartial.selector;
        s[2] = RepayFacet.calculateRepaymentAmount.selector;
    }

    /// @dev Issue #66 — the NFT-rental daily-deduction loop and the
    ///      T-034 periodic-interest settlement cluster were split out of
    ///      RepayFacet into RepayPeriodicFacet to keep both facets under
    ///      the EIP-170 24,576-byte runtime limit. These four external
    ///      selectors now route to RepayPeriodicFacet.
    function _getRepayPeriodicFacetSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](4);
        s[0] = RepayPeriodicFacet.autoDeductDaily.selector;
        s[1] = RepayPeriodicFacet.previewPeriodicSettle.selector;
        s[2] = RepayPeriodicFacet.nextPeriodCheckpoint.selector;
        s[3] = RepayPeriodicFacet.settlePeriodicInterest.selector;
    }

    /// T-090 — Borrower-initiated swap-to-repay facet selectors.
    function _getSwapToRepayFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = SwapToRepayFacet.swapToRepayFull.selector;
        s[1] = SwapToRepayFacet.swapToRepayPartial.selector;
    }

    /// T-090 v1.1 (#389) — intent-based swap-to-repay facet selectors.
    /// Per design §5.1 + §6.2:
    ///   • 3 borrower-facing entry points (commit / cancel / cancelExpired)
    ///   • 2 Fusion `LimitOrderProtocol` callbacks (pre/postInteraction)
    ///   • 1 ERC-1271 binding check (`isValidSignature`)
    ///   • 1 read-back view for the dapp's commit-then-post pattern.
    function _getSwapToRepayIntentFacetSelectors() internal pure returns (bytes4[] memory s) {
        // T-087 Sub 3.B — preInteraction / postInteraction /
        // isValidSignature moved to the new IntentDispatchFacet; this
        // facet now owns 8 selectors instead of 11.
        s = new bytes4[](8);
        s[0] = SwapToRepayIntentFacet.commitSwapToRepayIntent.selector;
        s[1] = SwapToRepayIntentFacet.cancelSwapToRepayIntent.selector;
        s[2] = SwapToRepayIntentFacet.cancelExpiredIntent.selector;
        s[3] = SwapToRepayIntentFacet.getIntentCommit.selector;
        // §5.8 layer 2 — force-cancel surface (onlyDiamondInternal).
        s[4] = SwapToRepayIntentFacet.internalForceCancelIntent.selector;
        s[5] = SwapToRepayIntentFacet.forceCancelIntentIfHFBelowOrRevert.selector;
        s[6] = SwapToRepayIntentFacet.forceCancelIntentIfPastDefaultOrRevert.selector;
        // Dapp read surface for the canonical extension bytes.
        s[7] = SwapToRepayIntentFacet.canonicalExtension.selector;
    }

    /// @notice T-087 Sub 3.B — the three 1inch LOP v4 callbacks
    ///         (preInteraction / postInteraction / isValidSignature)
    ///         dispatched by `s.orderHashKind[orderHash]` into either
    ///         `LibSwapToRepayIntentSettlement` (the T-090 v1.1 path)
    ///         or `LibTreasuryBuyback` (the Sub 3 buyback path).
    function _getIntentDispatchFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = IntentDispatchFacet.preInteraction.selector;
        s[1] = IntentDispatchFacet.postInteraction.selector;
        s[2] = IntentDispatchFacet.isValidSignature.selector;
    }

    /// @notice T-092 Phase 1 (#499) — auto-lifecycle consent surface.
    ///         Setters + readers for auto-lend / auto-opt-in / per-loan
    ///         refinance caps + per-loan + per-side extend caps.
    function _getAutoLifecycleFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](13);
        s[0] = AutoLifecycleFacet.setAutoLendConsent.selector;
        s[1] = AutoLifecycleFacet.getAutoLendConsent.selector;
        s[2] = AutoLifecycleFacet.setAutoOptInOnNewLoan.selector;
        s[3] = AutoLifecycleFacet.getAutoOptInOnNewLoan.selector;
        s[4] = AutoLifecycleFacet.setDefaultAutoRefinanceCaps.selector;
        s[5] = AutoLifecycleFacet.getDefaultAutoRefinanceCaps.selector;
        s[6] = AutoLifecycleFacet.setAutoRefinanceCaps.selector;
        s[7] = AutoLifecycleFacet.getAutoRefinanceCaps.selector;
        s[8] = AutoLifecycleFacet.setAutoExtendBorrowerCaps.selector;
        s[9] = AutoLifecycleFacet.getAutoExtendBorrowerCaps.selector;
        s[10] = AutoLifecycleFacet.setAutoExtendLenderCaps.selector;
        s[11] = AutoLifecycleFacet.getAutoExtendLenderCaps.selector;
        // T-092 Phase 3 (#503) — extendLoanInPlace executor.
        s[12] = AutoLifecycleFacet.extendLoanInPlace.selector;
    }

    /// @notice #407 PR 2 (2026-06-12) — encumbrance mutate facet
    ///         selectors. Single entry today; will grow as the
    ///         offer-principal-lock impl PR adds the lock create /
    ///         decrement / release surface.
    function _getEncumbranceMutateFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](19);
        s[0] = EncumbranceMutateFacet.releaseCollateralLien.selector;
        // #407 PR 4 round-1 (2026-06-12) — decrement/increment cross-
        // facet entries used by active-loan slice flows + addCollateral.
        s[1] = EncumbranceMutateFacet.decrementCollateralLien.selector;
        s[2] = EncumbranceMutateFacet.incrementCollateralLien.selector;
        // #569 §4.4 (2026-06-13) — rekey create-leg for obligation transfer.
        s[3] = EncumbranceMutateFacet.recreateCollateralLien.selector;
        // T-407-C (#566, 2026-06-13) — offer-principal lock selectors.
        s[4] = EncumbranceMutateFacet.createOfferPrincipalLien.selector;
        s[5] = EncumbranceMutateFacet.decrementOfferPrincipalLien.selector;
        s[6] = EncumbranceMutateFacet.releaseOfferPrincipalLien.selector;
        s[7] = EncumbranceMutateFacet.incrementOfferPrincipalLien.selector;
        // #954 — swap-to-repay close-out freeze helpers hosted here (EIP-170).
        s[8] = EncumbranceMutateFacet.freezeLenderProceeds.selector;
        s[9] = EncumbranceMutateFacet.freezeOrPayBorrowerSurplus.selector;
        // #998 S10 (#1006) — fail-closed frozen-claimant markers (EIP-170 host).
        s[10] = EncumbranceMutateFacet.recordSanctionsFrozenClaimant.selector;
        s[11] = EncumbranceMutateFacet.recordSanctionsFrozenClaimantBoth.selector;
        // #998 S10 (#1006) — one-call lender-payoff park+freeze (PrecloseFacet EIP-170).
        s[12] = EncumbranceMutateFacet.parkLenderPayoffAndFreeze.selector;
        // #998 S10 (#1006, r4) — registry-aware fail-closed gate host (ClaimFacet backstop).
        s[13] = EncumbranceMutateFacet.assertNotFrozenParty.selector;
        // #998 S10 (#1006) Class B — Active-loan inline lender-share pay-or-freeze
        // hosts (RepayPeriodicFacet + RepayFacet servicing paths, EIP-170).
        s[14] = EncumbranceMutateFacet.freezeOrPayActiveLenderResident.selector;
        s[15] = EncumbranceMutateFacet.freezeOrPayActiveLenderFromPayer.selector;
        s[16] = EncumbranceMutateFacet.freezeOrPayActiveLenderFromVault.selector;
        // #1132 (S10 central enforcement) — terminal-transition + both-holder
        // frozen-claimant register host (hosted here, not a separate facet, so it
        // is cut into every diamond that already cuts this mutate host).
        s[17] = EncumbranceMutateFacet.terminalize.selector;
        s[18] = EncumbranceMutateFacet.terminalizeFromAny.selector;
    }

    /// @notice #396 v0.5 — gasless signed off-chain offer book selectors.
    ///         Two fill entry points (vault-backed + wallet-backed via
    ///         Permit2 witness), signer-only cancel + batch nonce
    ///         invalidation, and the four read views.
    function _getSignedOfferFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](8);
        s[0] = SignedOfferFacet.acceptSignedOffer.selector;
        s[1] = SignedOfferFacet.acceptSignedOfferWithPermit.selector;
        s[2] = SignedOfferFacet.cancelSignedOffer.selector;
        s[3] = SignedOfferFacet.invalidateSignedOfferNonce.selector;
        s[4] = SignedOfferFacet.hashSignedOffer.selector;
        s[5] = SignedOfferFacet.signedOfferOrderHash.selector;
        s[6] = SignedOfferFacet.signedOfferFilledAmount.selector;
        s[7] = SignedOfferFacet.isSignedOfferNonceUsed.selector;
    }

    function _getLenderIntentFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](12);
        s[0] = LenderIntentFacet.setLenderIntent.selector;
        s[1] = LenderIntentFacet.cancelLenderIntent.selector;
        s[2] = LenderIntentFacet.setLenderIntentEnabled.selector;
        s[3] = LenderIntentFacet.isLenderIntentEnabled.selector;
        s[4] = LenderIntentFacet.getLenderIntent.selector;
        s[5] = LenderIntentFacet.getLenderIntentLivePrincipal.selector;
        s[6] = LenderIntentFacet.releaseIntentExposure.selector;
        s[7] = LenderIntentFacet.fundLenderIntent.selector;
        s[8] = LenderIntentFacet.withdrawLenderIntentCapital.selector;
        s[9] = LenderIntentFacet.getLenderIntentCapital.selector;
        s[10] = LenderIntentFacet.rollIntentLoan.selector;
        s[11] = LenderIntentFacet.getLenderIntentsByOwner.selector;
    }

    function _getRiskAccessFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](29);
        s[0] = RiskAccessFacet.setVaultRiskTier.selector;
        s[1] = RiskAccessFacet.setIlliquidPairConsent.selector;
        s[2] = RiskAccessFacet.setVaultRiskTierBySig.selector;
        s[3] = RiskAccessFacet.setIlliquidPairConsentBySig.selector;
        // #730 r5 — terms changes are a commit-reveal (commit+reveal selectors),
        // replacing the removed single-call `bumpRiskTermsVersion`. A fresh deploy
        // routes only these. UPGRADE NOTE: any diamond upgraded from a build that
        // routed `bumpRiskTermsVersion()`/`(bytes32)` MUST REMOVE that selector when
        // adding these — else the legacy path could advance the version without the
        // hash. See docs/DesignsAndPlans/AcceptAckFreshnessAnchorDesign.md §5.
        s[4] = RiskAccessFacet.commitRiskTermsBump.selector;
        s[5] = RiskAccessFacet.setRiskAccessUnlockCooldown.selector;
        s[6] = RiskAccessFacet.setProtocolManagedVault.selector;
        s[7] = RiskAccessFacet.getVaultRiskTier.selector;
        s[8] = RiskAccessFacet.getEffectiveRiskTier.selector;
        s[9] = RiskAccessFacet.getCurrentRiskTermsVersion.selector;
        s[10] = RiskAccessFacet.getRiskAccessUnlockCooldown.selector;
        s[11] = RiskAccessFacet.getRiskTierUnlockAt.selector;
        s[12] = RiskAccessFacet.isProtocolManagedVault.selector;
        s[13] = RiskAccessFacet.riskAccessNonceUsed.selector;
        s[14] = RiskAccessFacet.hasIlliquidPairConsent.selector;
        s[15] = RiskAccessFacet.pairRequiredRiskLevel.selector;
        s[16] = RiskAccessFacet.setRiskStrictMode.selector;
        s[17] = RiskAccessFacet.setRiskStrictModeBySig.selector;
        s[18] = RiskAccessFacet.setMidTierPairAck.selector;
        s[19] = RiskAccessFacet.setMidTierPairAckBySig.selector;
        s[20] = RiskAccessFacet.getRiskStrictMode.selector;
        s[21] = RiskAccessFacet.getStrictModeStrictUntil.selector;
        s[22] = RiskAccessFacet.midTierStrictBlocked.selector;
        s[23] = RiskAccessFacet.getCurrentRiskTermsHash.selector; // #730 r3
        s[24] = RiskAccessFacet.revealRiskTermsBump.selector; // #730 r5 commit-reveal
        s[25] = RiskAccessFacet.getPendingRiskTermsCommitment.selector; // #730 r5
        s[26] = RiskAccessFacet.getVaultRiskTierVersion.selector; // #735 in-place re-affirm
        s[27] = RiskAccessFacet.isPairConsentPending.selector; // #735 item 3 pending-consent
        s[28] = RiskAccessFacet.isMidTierAckPending.selector; // #735 item 3 pending-ack
    }

    /// @dev #1104 — the read-only preview cluster + the two cross-facet gate
    ///      asserts, split off `RiskAccessFacet` into its own `RiskPreviewFacet`
    ///      so both facets keep EIP-170 header room. All 7 are `view`.
    function _getRiskPreviewFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = RiskPreviewFacet.previewOfferAcceptBlock.selector;
        s[1] = RiskPreviewFacet.assertMatchAllowed.selector;
        s[2] = RiskPreviewFacet.previewMatchRiskBlock.selector;
        s[3] = RiskPreviewFacet.assertObligationTransferAllowed.selector;
        s[4] = RiskPreviewFacet.acceptMidTierAckPair.selector; // #735 item 3 sale-aware ack pair
        s[5] = RiskPreviewFacet.previewCreatorBlock.selector; // #735 item 3 creator-side gate
        s[6] = RiskPreviewFacet.previewIntent.selector; // #625 WI-2b intent-fill preview
    }

    /// @dev #1212 (E-10 Claim-All) — the single generic batching entry point.
    function _getMulticallFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = MulticallFacet.multicall.selector;
    }

    function _getAggregatorAdapterFactorySelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](11);
        s[0] = AggregatorAdapterFactoryFacet.initializeAdapterImplementation.selector;
        s[1] = AggregatorAdapterFactoryFacet.createAggregatorAdapter.selector;
        s[2] = AggregatorAdapterFactoryFacet.upgradeAdapterImplementation.selector;
        s[3] = AggregatorAdapterFactoryFacet.upgradeAggregatorAdapter.selector;
        s[4] = AggregatorAdapterFactoryFacet.setMandatoryAdapterUpgrade.selector;
        s[5] = AggregatorAdapterFactoryFacet.setAggregatorHaircutBps.selector;
        s[6] = AggregatorAdapterFactoryFacet.aggregatorAdapterTemplate.selector;
        s[7] = AggregatorAdapterFactoryFacet.currentAggregatorAdapterVersion.selector;
        s[8] = AggregatorAdapterFactoryFacet.mandatoryAggregatorAdapterVersion.selector;
        s[9] = AggregatorAdapterFactoryFacet.getAggregatorAdapterVersion.selector;
        s[10] = AggregatorAdapterFactoryFacet.isAggregatorAdapter.selector;
    }

    function _getBackstopFacetSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](25);
        s[0] = BackstopFacet.initializeBackstopVaultImplementation.selector;
        s[1] = BackstopFacet.provisionBackstopVault.selector;
        s[2] = BackstopFacet.upgradeBackstopVault.selector;
        s[3] = BackstopFacet.setBackstopIntent.selector;
        s[4] = BackstopFacet.seedBackstopOrigination.selector;
        s[5] = BackstopFacet.withdrawBackstopToTreasury.selector;
        s[6] = BackstopFacet.setOfferBackstopEligible.selector;
        s[7] = BackstopFacet.backstopFill.selector;
        s[8] = BackstopFacet.backstopClaim.selector;
        s[9] = BackstopFacet.sweepBackstopToken.selector;
        s[10] = BackstopFacet.sweepBackstopNFT.selector;
        s[11] = BackstopFacet.claimBackstopRewards.selector;
        s[12] = BackstopFacet.setBackstopEnabled.selector;
        s[13] = BackstopFacet.setBackstopFillEnabled.selector;
        s[14] = BackstopFacet.setMinBackstopDelay.selector;
        s[15] = BackstopFacet.getBackstopVault.selector;
        // #399 backstop v0 Role B — absorb governance.
        s[16] = BackstopFacet.setBackstopAbsorbEnabled.selector;
        s[17] = BackstopFacet.setBackstopAbsorbCap.selector;
        s[18] = BackstopFacet.seedBackstopAbsorb.selector;
        s[19] = BackstopFacet.sweepBackstopAbsorbCollateral.selector;
        s[20] = BackstopFacet.releaseBackstopAbsorbExposure.selector;
        s[21] = BackstopFacet.getBackstopAbsorbInfo.selector;
        s[22] = BackstopFacet.withdrawBackstopAbsorbToTreasury.selector;
        // #638 — backstop-only min-secondary-oracle-coverage knob.
        s[23] = BackstopFacet.setBackstopMinSecondaryOracleCoverage.selector;
        s[24] = BackstopFacet.getBackstopMinSecondaryOracleCoverage.selector;
    }

    /// #594 — Diamond NFT receiver hooks (gated+pinned, D-6).
    function _getReceiverFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = ReceiverFacet.onERC721Received.selector;
        s[1] = ReceiverFacet.onERC1155Received.selector;
        s[2] = ReceiverFacet.onERC1155BatchReceived.selector;
    }

    /// #594 — standalone holder-only consolidation entry points.
    function _getConsolidationFacetSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](6);
        s[0] = ConsolidationFacet.consolidateCollateralToHolder.selector;
        s[1] = ConsolidationFacet.consolidatePrincipalToHolder.selector;
        s[2] = ConsolidationFacet.eagerConsolidateToHolder.selector;
        s[3] = ConsolidationFacet.eagerConsolidateBothSides.selector;
        s[4] = ConsolidationFacet.restampCollateralVpfiAfterWithdraw.selector;
        s[5] = ConsolidationFacet.restampUserVpfiInternal.selector;
    }

    function _getDefaultedSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = DefaultedFacet.triggerDefault.selector;
        s[1] = DefaultedFacet.isLoanDefaultable.selector;
    }

    function _getRiskSelectors() internal pure returns (bytes4[] memory s) {
        // `triggerLiquidationSplit` was relocated to
        // `RiskSplitLiquidationFacet` (#66 + #633 split — see
        // `_getRiskSplitLiquidationSelectors`) so the `LibSwap.swapWithSplit`
        // inline lands in fresh headroom rather than tipping RiskFacet over
        // the EIP-170 limit.
        s = new bytes4[](9);
        s[0] = RiskFacet.updateRiskParams.selector;
        s[1] = RiskFacet.calculateLTV.selector;
        s[2] = RiskFacet.calculateHealthFactor.selector;
        s[3] = RiskFacet.isCollateralValueCollapsed.selector;
        s[4] = RiskFacet.triggerLiquidation.selector;
        // #394 Lever A — runtime, range-bounded loan-admission HF floor.
        s[7] = RiskFacet.setMinHealthFactor.selector;
        s[8] = RiskFacet.getMinHealthFactor.selector;
        // Partial HF-restore liquidator (Piece B follow-up — partials).
        // Sweeps only `fractionBps` of remaining collateral, leaves loan
        // Active with reduced size and unchanged maturity. Strict
        // HF-improves + HF>=1 post-mutation gates.
        s[5] = RiskFacet.triggerPartialLiquidation.selector;
        // FlashLoanLiquidationPath.md — liquidator-buys-at-discount.
        // Caller pays `totalDebt` in principal-asset; protocol seizes
        // collateral at per-tier discount and delivers to `recipient`.
        // Master kill-switch `discountPathEnabled` off by default — the
        // selector is wired but the entry-point reverts
        // `DiscountPathDisabled` until governance flips it on per chain.
        s[6] = RiskFacet.triggerLiquidationDiscounted.selector;
    }

    /// @dev Selectors for `RiskMatchLiquidationFacet` — the internal-match
    ///      liquidation cluster extracted from `RiskFacet` (Issue #66) so
    ///      neither facet exceeds the EIP-170 size limit.
    ///        - `triggerInternalMatchLiquidation` — permissionless 2-loan
    ///          or 3-loan internal match. Kill-switch `internalMatchEnabled`
    ///          defaults `false`, so the selector is dormant on a fresh
    ///          deploy.
    ///        - `attemptInternalMatchAutoDispatch` — `onlyDiamondInternal`
    ///          auto-dispatch hook the HF-liquidation / default / claim
    ///          entry points call before falling through to the
    ///          aggregator path. Wired for cross-facet routing; not
    ///          EOA-callable.
    function _getRiskMatchLiquidationSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](2);
        s[0] = RiskMatchLiquidationFacet.triggerInternalMatchLiquidation.selector;
        s[1] = RiskMatchLiquidationFacet.attemptInternalMatchAutoDispatch.selector;
    }

    /// @dev Selectors for `RiskSplitLiquidationFacet` — the higher-LTV-aware
    ///      split-route HF liquidator carved out of `RiskFacet` (#66 + #633)
    ///      so the `LibSwap.swapWithSplit` inline (incl. the disabled-venue
    ///      guard) lands in fresh headroom instead of tipping RiskFacet over
    ///      the EIP-170 size limit. Single entry point; permissionless;
    ///      atomic-revert-on-leg-failure with no soft-failure fallback.
    function _getRiskSplitLiquidationSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](1);
        s[0] = RiskSplitLiquidationFacet.triggerLiquidationSplit.selector;
    }

    function _getClaimSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](10);
        s[0] = ClaimFacet.claimAsLender.selector;
        s[1] = ClaimFacet.claimAsBorrower.selector;
        s[2] = ClaimFacet.getClaimableAmount.selector;
        s[3] = ClaimFacet.getClaimable.selector;
        s[4] = ClaimFacet.getBorrowerLifRebate.selector;
        s[5] = ClaimFacet.claimAsLenderWithRetry.selector;
        s[6] = ClaimFacet.getFallbackSnapshot.selector;
        // #399 backstop v0 Role B — liquidator-of-last-resort.
        s[7] = ClaimFacet.setLenderBackstopOptIn.selector;
        s[8] = ClaimFacet.claimAsLenderViaBackstop.selector;
        s[9] = ClaimFacet.getBorrowerSurplusClaim.selector;
    }

    function _getAddCollateralSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = AddCollateralFacet.addCollateral.selector;
    }

    function _getTreasurySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](56);
        s[0] = TreasuryFacet.claimTreasuryFees.selector;
        s[1] = TreasuryFacet.getTreasuryBalance.selector;
        s[2] = TreasuryFacet.mintVPFI.selector;
        s[3] = TreasuryFacet.convertTreasuryAsset.selector;
        // T-087 Sub 3.A — buyback remittance + admin + reads.
        s[4] = TreasuryFacet.remitBuyback.selector;
        s[5] = TreasuryFacet.absorbRemittance.selector;
        s[6] = TreasuryFacet.creditBuybackBudget.selector;
        s[7] = TreasuryFacet.setBuybackAllowedToken.selector;
        s[8] = TreasuryFacet.setBuybackNoConvert.selector;
        s[9] = TreasuryFacet.setBuybackDestToken.selector;
        s[10] = TreasuryFacet.setBuybackRemittanceReceiver.selector;
        s[11] = TreasuryFacet.setCrossChainMessenger.selector;
        s[12] = TreasuryFacet.getBuybackBudget.selector;
        s[13] = TreasuryFacet.getBaseBuybackBudget.selector;
        s[14] = TreasuryFacet.getBuybackDestToken.selector;
        s[15] = TreasuryFacet.isBuybackAllowedToken.selector;
        s[16] = TreasuryFacet.isBuybackNoConvert.selector;
        s[17] = TreasuryFacet.getCrossChainMessenger.selector;
        s[18] = TreasuryFacet.getBuybackRemittanceReceiver.selector;
        // T-087 Sub 3.B — buyback intent ledger.
        s[19] = TreasuryFacet.commitBuybackIntent.selector;
        s[20] = TreasuryFacet.expireBuybackIntent.selector;
        s[21] = TreasuryFacet.getBuybackOrder.selector;
        s[22] = TreasuryFacet.getOrderHashKind.selector;
        // #687-C: getStakingPoolBuybackBudget removed; slot 23 reused by the
        // former tail entry (was s[56]) to keep this array hole-free.
        s[23] = TreasuryFacet.getKeeperRewardTwapMaxAgeSec.selector;
        s[24] = TreasuryFacet.setBuybackMaxTranche.selector;
        s[25] = TreasuryFacet.getBuybackMaxTranche.selector;
        // T-087 Sub 3.C — validated buyback commit + TWAP config.
        s[26] = TreasuryFacet.commitBuybackIntentValidated.selector;
        s[27] = TreasuryFacet.canonicalBuybackExtension.selector;
        s[28] = TreasuryFacet.setBuybackTwapMaxWindowSec.selector;
        s[29] = TreasuryFacet.getBuybackTwapMaxWindowSec.selector;
        s[30] = TreasuryFacet.isBuybackValidated.selector;
        s[31] = TreasuryFacet.getBuybackConsumedSoFar.selector;
        // T-087 Sub 3 add-on #472 — priority router config.
        s[32] = TreasuryFacet.setRewardEmissionsTopUpTarget.selector;
        s[33] = TreasuryFacet.getRewardEmissionsTopUpTarget.selector;
        s[34] = TreasuryFacet.getRewardEmissionsBudget.selector;
        s[35] = TreasuryFacet.setKeeperRewardTopUpTarget.selector;
        s[36] = TreasuryFacet.getKeeperRewardTopUpTarget.selector;
        s[37] = TreasuryFacet.getKeeperRewardBudget.selector;
        // T-087 Sub 3 add-on #473 — productive treasury reserve.
        s[38] = TreasuryFacet.setTreasuryYieldVenue.selector;
        s[39] = TreasuryFacet.setTreasuryExternalYieldMaxBps.selector;
        s[40] = TreasuryFacet.setAaveV3Pool.selector;
        s[41] = TreasuryFacet.setLidoStaking.selector;
        s[42] = TreasuryFacet.deployTreasuryYield.selector;
        s[43] = TreasuryFacet.withdrawTreasuryYield.selector;
        s[44] = TreasuryFacet.getTreasuryYieldVenue.selector;
        s[45] = TreasuryFacet.getTreasuryDeployedExternal.selector;
        s[46] = TreasuryFacet.getTreasuryExternalYieldMaxBps.selector;
        s[47] = TreasuryFacet.getAaveV3Pool.selector;
        s[48] = TreasuryFacet.getLidoStaking.selector;
        // T-087 Sub 3 add-on #474 — keeper VPFI rewards config.
        s[49] = TreasuryFacet.setKeeperRewardMultBps.selector;
        s[50] = TreasuryFacet.getKeeperRewardMultBps.selector;
        s[51] = TreasuryFacet.setKeeperRewardCashOutSpreadBps.selector;
        s[52] = TreasuryFacet.getKeeperRewardCashOutSpreadBps.selector;
        s[53] = TreasuryFacet.setKeeperRewardEnabled.selector;
        s[54] = TreasuryFacet.getKeeperRewardEnabled.selector;
        s[55] = TreasuryFacet.setKeeperRewardTwapMaxAgeSec.selector;
        // #687-C: former s[56] getKeeperRewardTwapMaxAgeSec relocated to s[23].
    }

    function _getPayrollSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](8);
        s[0] = PayrollFacet.createPayrollStream.selector;
        s[1] = PayrollFacet.fundPayrollStream.selector;
        s[2] = PayrollFacet.setPayrollRate.selector;
        s[3] = PayrollFacet.setPayrollStreamPaused.selector;
        s[4] = PayrollFacet.withdrawSalary.selector;
        s[5] = PayrollFacet.getPayrollStream.selector;
        s[6] = PayrollFacet.getWithdrawableSalary.selector;
        s[7] = PayrollFacet.getPayrollStreamCount.selector;
    }

    function _getEarlyWithdrawalSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = EarlyWithdrawalFacet.sellLoanViaBuyOffer.selector;
        s[1] = EarlyWithdrawalFacet.createLoanSaleOffer.selector;
        s[2] = EarlyWithdrawalFacet.completeLoanSale.selector;
        // #951 (Codex #959) — cross-facet completion entry for the
        // accept-then-complete auto-link (skips the outer nonReentrant guard).
        s[3] = EarlyWithdrawalFacet.completeLoanSaleInternal.selector;
    }

    function _getPartialWithdrawalSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = PartialWithdrawalFacet.partialWithdrawCollateral.selector;
        s[1] = PartialWithdrawalFacet.calculateMaxWithdrawable.selector;
    }

    function _getPrecloseSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = PrecloseFacet.precloseDirect.selector;
        s[1] = PrecloseFacet.offsetWithNewOffer.selector;
        s[2] = PrecloseFacet.completeOffset.selector;
        s[3] = PrecloseFacet.transferObligationViaOffer.selector;
        // Cross-facet entry consumed by `OfferFacet._acceptOffer`'s
        // auto-link block when a third party accepts an offset offer.
        // Same `address(this)`-only gate as `acceptOfferInternal`.
        s[4] = PrecloseFacet.completeOffsetInternal.selector;
    }

    /// @dev T-086 step 5 — `PrepayListingFacet` selectors. Hosts the
    ///      executor↔diamond trust boundary for Seaport prepay
    ///      collateral sales: the bundled view the executor reads,
    ///      the privileged finalization callback (msg.sender ==
    ///      collateralListingExecutor gate), and the admin setter +
    ///      read-side for the executor address.
    function _getPrepayListingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = PrepayListingFacet.getPrepayContext.selector;
        s[1] = PrepayListingFacet.executorFinalizePrepaySale.selector;
        s[2] = PrepayListingFacet.setCollateralListingExecutor.selector;
        s[3] = PrepayListingFacet.getCollateralListingExecutor.selector;
        // T-086 Round-8 (#358) §19.7 — 3 offer-keyed executor→diamond
        // callbacks. Gated by `msg.sender ==
        // s.offerPrepayListingExecutor[offerId]` inside the facet body.
        s[4] = PrepayListingFacet.markOfferConsumedBySale.selector;
        s[5] = PrepayListingFacet.recordOfferSaleProceeds.selector;
        s[6] = PrepayListingFacet.assertOfferFillNotSanctioned.selector;
    }

    /// @dev T-086 step 6 — `NFTPrepayListingFacet` selectors. Hosts the
    ///      borrower-facing post / update / cancel / cancelExpired
    ///      entry points for the FIXED-PRICE Seaport prepay listing
    ///      flow, plus three view helpers (`getPrepayListingOrderHash`,
    ///      `getPrepayListingBufferBps`, `getPrepayListingEnabled`)
    ///      read by the frontend + indexer when rendering listing
    ///      status.
    ///      Round-5 Block B (#309) — the Dutch entry points live on
    ///      a sibling facet ({NFTPrepayDutchListingFacet}, see
    ///      {_getNFTPrepayDutchListingSelectors}) to keep this
    ///      facet's bytecode within solc's jump-table reservation
    ///      budget.
    function _getNFTPrepayListingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](10);
        s[0] = NFTPrepayListingFacet.postPrepayListing.selector;
        s[1] = NFTPrepayListingFacet.updatePrepayListing.selector;
        s[2] = NFTPrepayListingFacet.cancelPrepayListing.selector;
        s[3] = NFTPrepayListingFacet.cancelExpiredPrepayListing.selector;
        // #1144 (S10 Invariant B) — permissionless loan-keyed prepay-sale
        // sanctions sync (register flagged consideration recipients + cancel).
        s[9] = NFTPrepayListingFacet.syncPrepaySaleListing.selector;
        s[4] = NFTPrepayListingFacet.getPrepayListingOrderHash.selector;
        s[5] = NFTPrepayListingFacet.getPrepayListingBufferBps.selector;
        // Round-3 fix on PR #308 — Codex P2: frontend needs to read the
        // master kill-switch to render the action surface as
        // "unavailable on this chain" instead of a form that reverts at
        // submit with `PrepayListingDisabled`.
        s[6] = NFTPrepayListingFacet.getPrepayListingEnabled.selector;
        // T-086 Round-7 (#355) — borrower-only clear of the auto-list
        // opt-out flag, counter-action to the sticky flag set by
        // `cancelPrepayListing` during the grace window (§18.7).
        s[7] = NFTPrepayListingFacet.clearAutoListOptOut.selector;
        // T-086 Round-7 follow-up (Codex round-13 P2 #3) — production
        // getter for the auto-list opt-out flag, so the indexer / UI
        // can render the live state without optimistic-retry against
        // the auto-list reverts.
        s[8] = NFTPrepayListingFacet.getPrepayListingAutoListOptedOut.selector;
    }

    /// @dev T-086 Round-5 Block B (#309) — `NFTPrepayDutchListingFacet`
    ///      selectors. Dutch-decay entry points sharing
    ///      {LibVaipakam} storage + the same recorder interface as
    ///      {NFTPrepayListingFacet}. The split is bytecode-budget
    ///      driven (see facet natspec); the indexer + dapp see the
    ///      same canonical `PrepayListingPosted` /
    ///      `PrepayListingUpdated` event-topic hashes regardless of
    ///      which facet emitted.
    function _getNFTPrepayDutchListingSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = NFTPrepayDutchListingFacet.postPrepayDutchListing.selector;
        s[1] = NFTPrepayDutchListingFacet.updatePrepayDutchListing.selector;
    }

    /// @dev T-086 Round-6 / Block D (#345) — `NFTPrepayListingAtomicFacet`
    ///      selector. ONE external entry point: `matchOpenSeaOffer`,
    ///      the atomic match-rotation flow that closes the v1
    ///      English-mode race window §15.3 deliberately accepted.
    ///      Shares LibVaipakam storage with the two sibling listing
    ///      facets; emits its own `PrepayListingMatched` event
    ///      (distinct from `PrepayListingPosted` / `PrepayListingUpdated`)
    ///      per the Round-6 design doc §17.7.
    function _getNFTPrepayListingAtomicSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = NFTPrepayListingAtomicFacet.matchOpenSeaOffer.selector;
    }

    /// @dev T-086 Round-7 (#355) — `NFTPrepayAutoListFacet` selectors.
    ///      Single permissionless entry point
    ///      `autoListAtFloorOnGrace(uint256 loanId)`; the
    ///      `clearAutoListOptOut` borrower-side counter-action lives
    ///      on `NFTPrepayListingFacet` alongside `cancelPrepayListing`
    ///      (the cancel path is where the opt-out flag gets set).
    function _getNFTPrepayAutoListSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = NFTPrepayAutoListFacet.autoListAtFloorOnGrace.selector;
    }

    function _getRefinanceSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = RefinanceFacet.refinanceLoan.selector;
        // T-092-H (#549) — atomic accept-and-refinance internal entry.
        // Cut here so the diamond fallback routes the cross-facet call
        // from OfferAcceptFacet / OfferMatchFacet into RefinanceFacet.
        s[1] = RefinanceFacet.refinanceLoanFromAccept.selector;
    }

    function _getVpfiTokenSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](10);
        s[0] = VPFITokenFacet.setVPFIToken.selector;
        s[1] = VPFITokenFacet.getVPFIToken.selector;
        s[2] = VPFITokenFacet.getVPFITotalSupply.selector;
        s[3] = VPFITokenFacet.getVPFICap.selector;
        s[4] = VPFITokenFacet.getVPFICapHeadroom.selector;
        s[5] = VPFITokenFacet.getVPFIMinter.selector;
        s[6] = VPFITokenFacet.getVPFIBalanceOf.selector;
        s[7] = VPFITokenFacet.setCanonicalVPFIChain.selector;
        s[8] = VPFITokenFacet.isCanonicalVpfiChain.selector;
        s[9] = VPFITokenFacet.getVPFISnapshot.selector;
    }

    function _getVpfiDiscountSelectors() internal pure returns (bytes4[] memory s) {
        // #687-A: the fixed-rate SALE surface was removed (buyVPFIWithETH,
        // processBridgedBuy, quoteFixedRateBuy, getVPFISoldTo[ByChainId],
        // setVPFIBuyCaps/Enabled, set/getBridgedBuyReceiver, getVPFIBuyConfig,
        // setVPFIBuyRate). The kept consumptive fee-discount surface remains,
        // plus the renamed discount-price config (getVPFIDiscountConfig /
        // setVPFIDiscountRate) that the discount quote depends on.
        s = new bytes4[](18);
        s[0] = VPFIDiscountFacet.depositVPFIToVault.selector;
        s[1] = VPFIDiscountFacet.quoteVPFIDiscount.selector;
        s[2] = VPFIDiscountFacet.getVPFIDiscountConfig.selector;
        s[3] = VPFIDiscountFacet.setVPFIDiscountRate.selector;
        s[4] = VPFIDiscountFacet.setVPFIDiscountETHPriceAsset.selector;
        s[5] = VPFIDiscountFacet.emitDiscountApplied.selector;
        s[6] = VPFIDiscountFacet.setVPFIDiscountConsent.selector;
        s[7] = VPFIDiscountFacet.getVPFIDiscountConsent.selector;
        s[8] = VPFIDiscountFacet.emitYieldFeeDiscountApplied.selector;
        s[9] = VPFIDiscountFacet.quoteVPFIDiscountFor.selector;
        s[10] = VPFIDiscountFacet.getVPFIDiscountTier.selector;
        s[11] = VPFIDiscountFacet.withdrawVPFIFromVault.selector;
        s[12] = VPFIDiscountFacet.getUserVpfiDiscountState.selector;
        // Phase 8b.1 Permit2 addition.
        s[13] = VPFIDiscountFacet.depositVPFIToVaultWithPermit.selector;
        // T-087 Sub 1.D — post-gate EFFECTIVE_TIER + EFFECTIVE_BPS getter.
        s[14] = VPFIDiscountFacet.getEffectiveDiscount.selector;
        // T-087 Sub 4 — balance-mutation-free tier rollup.
        s[15] = VPFIDiscountFacet.pokeMyTier.selector;
        // T-087 Sub 4 round-2 P2 — public tracked-balance getter.
        s[16] = VPFIDiscountFacet.getTrackedVPFIBalance.selector;
        // T-087 Sub 4 round-3 P2 #1 — tracked-tier getter.
        s[17] = VPFIDiscountFacet.getTrackedVPFIDiscountTier.selector;
    }

    // #687-B: _getStakingRewardsSelectors removed with the 5% VPFI staking yield.

    function _getInteractionRewardsSelectors() internal pure returns (bytes4[] memory s) {
        // #1306 follow-up — the read-only view/getter selectors (incl. the
        // RL-3 reads getRewardEntryExpiry + getUserRewardEntryIds) moved to
        // {InteractionRewardsLensFacet} (see _getInteractionRewardsLensSelectors).
        // This facet keeps the mutating claim/sweep/admin surface + the
        // diamond-internal reward-lifecycle hooks.
        s = new bytes4[](11);
        s[0] = InteractionRewardsFacet.claimInteractionRewards.selector;
        s[1] = InteractionRewardsFacet.setInteractionLaunchTimestamp.selector;
        s[2] = InteractionRewardsFacet.setInteractionCapVpfiPerEth.selector;
        s[3] = InteractionRewardsFacet.sweepForfeitedInteractionRewards.selector;
        // #969 / S5 — diamond-internal reward-lifecycle hooks for PrecloseFacet.
        s[4] = InteractionRewardsFacet.precloseRewardClose.selector;
        s[5] = InteractionRewardsFacet.precloseRewardTransferObligation.selector;
        // #1067 / S13 Part 2 — diamond-internal terminal reward-close hooks
        // (self-only; fired best-effort by the terminal facets).
        s[6] = InteractionRewardsFacet.liquidationRewardClose.selector;
        s[7] = InteractionRewardsFacet.terminalRewardClose.selector;
        s[8] = InteractionRewardsFacet.transferLenderRewardEntry.selector;
        // RL-1 — explicit-delivery claim (vault default / wallet opt-out).
        s[9] = InteractionRewardsFacet.claimInteractionRewardsTo.selector;
        // RL-3 (#1305) — the mutating claim-horizon sweep (its id-keyed
        // read views live on the lens facet).
        s[10] = InteractionRewardsFacet.sweepExpiredInteractionRewards.selector;
    }

    /// @dev #1306 follow-up — read-only view/getter surface split off
    ///      {InteractionRewardsFacet} into {InteractionRewardsLensFacet} for
    ///      EIP-170 headroom. These 14 selectors route to the lens facet.
    function _getInteractionRewardsLensSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](16);
        s[0] = InteractionRewardsLensFacet.getInteractionLaunchTimestamp.selector;
        s[1] = InteractionRewardsLensFacet.getInteractionCurrentDay.selector;
        s[2] = InteractionRewardsLensFacet.getInteractionAnnualRateBps.selector;
        s[3] = InteractionRewardsLensFacet.getInteractionHalfPoolForDay.selector;
        s[4] = InteractionRewardsLensFacet.getInteractionLastClaimedDay.selector;
        s[5] = InteractionRewardsLensFacet.getInteractionDayEntry.selector;
        s[6] = InteractionRewardsLensFacet.previewInteractionRewards.selector;
        s[7] = InteractionRewardsLensFacet.getInteractionPoolRemaining.selector;
        s[8] = InteractionRewardsLensFacet.getInteractionPoolPaidOut.selector;
        s[9] = InteractionRewardsLensFacet.getInteractionSnapshot.selector;
        s[10] = InteractionRewardsLensFacet.getInteractionClaimability.selector;
        s[11] = InteractionRewardsLensFacet.getInteractionCapVpfiPerEth.selector;
        s[12] = InteractionRewardsLensFacet.getInteractionCapVpfiPerEthRaw.selector;
        s[13] = InteractionRewardsLensFacet.getUserRewardEntries.selector;
        // RL-3 (#1305) — the read-only claim-horizon views.
        s[14] = InteractionRewardsLensFacet.getUserRewardEntryIds.selector;
        s[15] = InteractionRewardsLensFacet.getRewardEntryExpiry.selector;
    }

    function _getRewardReporterSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](11);
        s[0] = RewardReporterFacet.closeDay.selector;
        s[1] = RewardReporterFacet.onRewardBroadcastReceived.selector;
        s[2] = RewardReporterFacet.setRewardMessenger.selector;
        // T-068: `setLocalEid` removed — a chain's own identity is
        // `block.chainid`, no longer a settable endpoint id.
        s[3] = RewardReporterFacet.setBaseChainId.selector;
        s[4] = RewardReporterFacet.setIsCanonicalRewardChain.selector;
        s[5] = RewardReporterFacet.setRewardGraceSeconds.selector;
        s[6] = RewardReporterFacet.getLocalChainInterestNumeraire18.selector;
        s[7] = RewardReporterFacet.getChainReportSentAt.selector;
        s[8] = RewardReporterFacet.getRewardReporterConfig.selector;
        s[9] = RewardReporterFacet.getKnownGlobalInterestNumeraire18.selector;
        // Single-field getter for the protocol-console knob registry.
        s[10] = RewardReporterFacet.getRewardGraceSeconds.selector;
    }

    /// T-087 Sub 1.B — single-home accumulator facet (ring-buffer
    /// math + lifecycle bookkeeping). Both selectors are gated to
    /// `msg.sender == address(this)` so an EOA can never invoke
    /// them directly; library wrappers route through the Diamond's
    /// fallback. See {VPFIDiscountAccumulatorFacet.sol} for the
    /// extraction rationale.
    function _getVpfiDiscountAccumulatorSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](4);
        s[0] = VPFIDiscountAccumulatorFacet.rollupUserDiscount.selector;
        s[1] = VPFIDiscountAccumulatorFacet.effectiveTierAndBps.selector;
        // T-087 Sub 2.A — projected tier-expiry view (off-chain
        // monitoring + Sub 2.B CCIP payload source + test inspection).
        s[2] = VPFIDiscountAccumulatorFacet.getTierExpirySec.selector;
        // RL-1 — broadcast-free rollup used by the Diamond-funded vault
        // credit primitive on the reward claim-to-vault path.
        s[3] = VPFIDiscountAccumulatorFacet.rollupUserDiscountLocal.selector;
    }

    /// T-087 Sub 2.C — mirror-side tier-push receiver facet. Both
    /// selectors are gated to `msg.sender == s.rewardMessenger`; the
    /// `VaipakamRewardMessenger` contract forwards inbound
    /// `MSG_TYPE_TIER_UPDATED` / `MSG_TYPE_VERSION_BUMPED` here.
    function _getMirrorTierReceiverSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](4);
        s[0] = MirrorTierReceiverFacet.onTierUpdateReceived.selector;
        s[1] = MirrorTierReceiverFacet.onVersionBumpedReceived.selector;
        // Public read surface — off-chain monitoring + tests.
        s[2] = MirrorTierReceiverFacet.getUserTierCache.selector;
        s[3] = MirrorTierReceiverFacet.getCurrentTierTableVersion.selector;
    }

    /// T-087 Sub 2.D — protocol-funded mirror broadcast orchestrator.
    /// `protocolBroadcastTierUpdate` is gated to `msg.sender ==
    /// address(this)`; the accumulator's rollup path reaches it via
    /// the diamond's fallback.
    function _getProtocolBroadcastSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](5);
        s[0] = ProtocolBroadcastFacet.protocolBroadcastTierUpdate.selector;
        s[1] = ProtocolBroadcastFacet.topUpBroadcastBudget.selector;
        s[2] = ProtocolBroadcastFacet.withdrawBudget.selector;
        s[3] = ProtocolBroadcastFacet.getProtocolBroadcastBudget.selector;
        s[4] = ProtocolBroadcastFacet.getUserTierPushNonce.selector;
    }

    function _getConfigSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](82);
        // Setters
        s[0] = ConfigFacet.setFeesConfig.selector;
        s[1] = ConfigFacet.setLiquidationConfig.selector;
        s[2] = ConfigFacet.setRiskConfig.selector;
        // #687-B: setStakingApr (was s[3]) / getStakingAprBps (was s[10])
        // removed with the 5% VPFI staking yield. The two freed slots are
        // reused by the former tail entries so this fixed-size selector
        // array stays hole-free (SelectorCoverage compares the set).
        s[3] = ConfigFacet.setMirrorTierMaxAgeSec.selector;
        s[4] = ConfigFacet.setVpfiTierThresholds.selector;
        s[5] = ConfigFacet.setVpfiTierDiscountBps.selector;
        // Abnormal-market fallback: lender-bonus + treasury bps split
        // applied when every swap adapter fails / under-fills. Default
        // 3% / 2% per LibVaipakam constants, governance-tunable.
        s[6] = ConfigFacet.setFallbackSplit.selector;
        // Getters
        s[7] = ConfigFacet.getFeesConfig.selector;
        s[8] = ConfigFacet.getLiquidationConfig.selector;
        s[9] = ConfigFacet.getRiskConfig.selector;
        s[10] = ConfigFacet.setTwaMinStakedDays.selector; // #687-B: reused (was getStakingAprBps)
        s[11] = ConfigFacet.getFallbackSplit.selector;
        s[12] = ConfigFacet.getVpfiTierThresholds.selector;
        s[13] = ConfigFacet.getVpfiTierDiscountBps.selector;
        s[14] = ConfigFacet.getProtocolConfigBundle.selector;
        s[15] = ConfigFacet.getProtocolConstants.selector;
        // Range Orders Phase 1 master kill-switch flags. Default false
        // on a fresh deploy; governance flips them via the setters
        // below. See docs/RangeOffersDesign.md §15 for the staged-
        // enablement rationale (each flag can be toggled
        // independently to roll out range / partial-fill behavior).
        s[16] = ConfigFacet.setRangeAmountEnabled.selector;
        s[17] = ConfigFacet.setRangeRateEnabled.selector;
        s[18] = ConfigFacet.setPartialFillEnabled.selector;
        s[19] = ConfigFacet.getMasterFlags.selector;
        // Range Orders Phase 1 — governance-tunable matcher BPS.
        s[20] = ConfigFacet.setLifMatcherFeeBps.selector;
        // Auto-pause window duration setter (Phase 1 follow-up).
        s[21] = ConfigFacet.setAutoPauseDurationSeconds.selector;
        // Findings 00025 — governance-tunable max loan duration.
        s[22] = ConfigFacet.setMaxOfferDurationDays.selector;
        // T-032 / Numeraire generalization (Phase 1) — notification fee knob (now in
        // numeraire-units) + bundled getter. The per-knob
        // `setNotificationFeeUsdOracle` was retired; the protocol's
        // reference currency is the global numeraireOracle (set via
        // setNumeraire on the T-034 surface).
        s[23] = ConfigFacet.setNotificationFee.selector;
        s[24] = ConfigFacet.getNotificationFeeConfig.selector;
        // Single-field fee getters added for the protocol-console knob
        // schema (which expects per-knob single-value getters; the
        // tuple-returning getFeesConfig doesn't fit). See
        // frontend/src/lib/protocolConsoleKnobs.ts.
        s[25] = ConfigFacet.getTreasuryFeeBps.selector;
        s[26] = ConfigFacet.getLoanInitiationFeeBps.selector;
        s[27] = ConfigFacet.getLifMatcherFeeBps.selector;
        // Single-field master-flag getters (companion of getMasterFlags).
        s[28] = ConfigFacet.getRangeAmountEnabled.selector;
        s[29] = ConfigFacet.getRangeRateEnabled.selector;
        s[30] = ConfigFacet.getPartialFillEnabled.selector;
        // T-044 admin-configurable loan-default grace schedule.
        s[31] = ConfigFacet.setGraceBuckets.selector;
        s[32] = ConfigFacet.clearGraceBuckets.selector;
        s[33] = ConfigFacet.getGraceBuckets.selector;
        s[34] = ConfigFacet.getEffectiveGraceSeconds.selector;
        s[35] = ConfigFacet.getGraceSlotBounds.selector;
        // T-034 / T-048 numeraire / PAD / periodic-interest knobs were
        // carved out into `NumeraireConfigFacet` (#394 Codex #647) — see
        // `_getNumeraireConfigSelectors()`.
        // Depth-tiered LTV (Piece B) — governance globals (all default
        // to library constants until set; the master kill-switch
        // `depthTieredLtvEnabled` defaults false) + the off-chain
        // liquidity-confidence relay write (`setKeeperTier`, KEEPER_ROLE)
        // + the frontend bundle / single-field getters. See
        // docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md §4.2.
        s[36] = ConfigFacet.setDepthTieredLtvEnabled.selector;
        s[37] = ConfigFacet.setLiquiditySlippageBps.selector;
        s[38] = ConfigFacet.setTwapGuard.selector;
        s[39] = ConfigFacet.setLiquidityTierSizes.selector;
        s[40] = ConfigFacet.setTierMaxInitLtvBps.selector;
        s[41] = ConfigFacet.setPaaAssets.selector;
        s[42] = ConfigFacet.setKeeperTier.selector;
        s[43] = ConfigFacet.getDepthTieredLtvEnabled.selector;
        s[44] = ConfigFacet.getPaaAssets.selector;
        s[45] = ConfigFacet.getKeeperTier.selector;
        s[46] = ConfigFacet.getDepthTierConfigBundle.selector;
        // Liquidator hardening (item 2) — close-factor ceiling setter
        // for `RiskFacet.triggerPartialLiquidation`. Default 10_000 = no
        // cap (the keeper picks the smallest fraction that restores
        // HF>=1); governance may tighten to Aave-style 5_000 (50%) etc.
        s[47] = ConfigFacet.setMaxPartialLiquidationCloseFactorBps.selector;
        // Phase 7 of AutonomousLtvAndOracleFallback.md — per-tier
        // LTV safety-box parameters: atomic setter (all three tiers
        // updated in one call so the cross-tier monotonic invariant
        // is never temporarily broken) + bundle getter.
        s[48] = ConfigFacet.setTierLtvParams.selector;
        s[49] = ConfigFacet.getTierLtvParams.selector;
        // FlashLoanLiquidationPath.md — per-tier liquidator-discount
        // governance: master kill-switch + atomic per-tier setter +
        // effective-value bundle view. The kill-switch defaults
        // `false` so a fresh deploy ships with the discount path
        // inert; governance flips on per chain after audit sign-off.
        s[50] = ConfigFacet.setDiscountPathEnabled.selector;
        s[51] = ConfigFacet.setTierLiqDiscountBps.selector;
        s[52] = ConfigFacet.getTierLiqDiscountBps.selector;
        // PR2 of internal-match work (2026-05-14) — per-tier
        // LIQUIDATION threshold setter + view. Replaces the retired
        // per-asset `RiskParams.liqThresholdBps`. See
        // InternalLiquidationLedger.md §0.
        s[53] = ConfigFacet.setTierLiquidationLtvBps.selector;
        s[54] = ConfigFacet.getTierLiquidationLtvBps.selector;
        // PR3 of internal-match work (2026-05-15) — kill-switch +
        // priority-window + bot-incentive setters + bundle view for
        // the internal-liquidation match path. See
        // InternalLiquidationLedger.md §0.
        s[55] = ConfigFacet.setInternalMatchEnabled.selector;
        s[56] = ConfigFacet.setInternalMatchConfig.selector;
        s[57] = ConfigFacet.getInternalMatchConfigBundle.selector;
        // T-600 — treasury-conversion knobs.
        s[58] = ConfigFacet.setTreasuryConvertTargets.selector;
        s[59] = ConfigFacet.setTreasuryConvertThresholds.selector;
        s[60] = ConfigFacet.getTreasuryConvertConfig.selector;
        // Issue #164 — borrower-side collateral range master flag.
        // Defaults `false` on a fresh deploy; flipped on by governance
        // via the setter below. See docs/RangeOffersDesign.md §3.
        s[61] = ConfigFacet.setRangeCollateralEnabled.selector;
        // T-086 step 6 — prepay-listing safety buffer setter. Read
        // by `NFTPrepayListingFacet.{postPrepayListing,
        // updatePrepayListing}` when validating askPrice against
        // the live floor. Default 0 (post-deploy unconfigured =
        // listing-path blocked); ADMIN sets to e.g. 200 bps (2%).
        s[62] = ConfigFacet.setPrepayListingBufferBps.selector;
        // T-086 step 6 — prepay-listing master kill-switch. Default
        // false; ADMIN flips on once steps 7 (vault approval) + 10
        // (default-flow lock-bypass) are wired end-to-end.
        s[63] = ConfigFacet.setPrepayListingEnabled.selector;
        // T-086 Round-7 (#355) — Dutch B-cond-3b "decays to floor too
        // late" safe-margin in seconds. Bounded at set time by
        // `MIN_LOAN_GRACE_PERIOD - 60`. Default 0 (B-cond-3b safe-
        // margin policy disabled until governance configures).
        s[64] = ConfigFacet.setPrepayListingDutchGraceMarginSec.selector;
        // T-086 Round-7 (#355) — default Seaport conduit key the
        // permissionless `autoListAtFloorOnGrace` Case A posts under.
        // Default `bytes32(0)` (auto-list Case A blocked until
        // governance configures).
        s[65] = ConfigFacet.setPrepayListingAutoListConduitKey.selector;
        // T-090 — Borrower-initiated swap-to-repay slippage cap (BPS).
        // Default 300 (3%) via `cfgMaxSwapToRepaySlippageBps`'s zero
        // fallback; setter is ADMIN_ROLE-only and bounded by
        // `MAX_SLIPPAGE_BPS = 2500` (25%).
        s[66] = ConfigFacet.setMaxSwapToRepaySlippageBps.selector;
        s[67] = ConfigFacet.getMaxSwapToRepaySlippageBps.selector;
        // T-087 Sub 1.A — ring-buffer TWA + mirror-cache knobs. Storage
        // scaffolding only in 1.A; consumption lands in Sub 1.B onward.
        s[68] = ConfigFacet.setTwaRecentDays.selector;
        s[69] = ConfigFacet.setTwaWindowDays.selector;
        s[70] = ConfigFacet.setTwaRecentWeight.selector;
        // #687-B: former s[71] setTwaMinStakedDays + s[72] setMirrorTierMaxAgeSec
        // were relocated into the slots freed by the removed staking selectors.
        // #671 — progressive risk-access gate master kill-switch + getter.
        s[71] = ConfigFacet.setRiskAccessGateEnabled.selector;
        s[72] = ConfigFacet.getRiskAccessGateEnabled.selector;
        // #956 (#921 item 5) — per-asset min-partial floor setter + RiskParams view.
        s[73] = ConfigFacet.setAssetMinPartialBps.selector;
        s[74] = ConfigFacet.getAssetRiskParams.selector;
        // #1222 (Phase A1a) — VPFI recycling governor knobs.
        s[75] = ConfigFacet.setRecycleMarginBps.selector;
        s[76] = ConfigFacet.setRecycleTariffKPer1e18EthDay.selector;
        s[77] = ConfigFacet.getRecycleConfig.selector;
        // Governor PR-3a (#1217) — recycle-bucket transparency reads.
        s[78] = ConfigFacet.getRecycleBucket.selector;
        s[79] = ConfigFacet.getRecycledCreditedByDay.selector;
        // RL-3 (#1305) — reward claim-horizon knob.
        s[80] = ConfigFacet.setRewardClaimHorizonDays.selector;
        s[81] = ConfigFacet.getRewardClaimHorizonDays.selector;
    }

    /// T-034 / T-048 numeraire / PAD / periodic-interest config
    /// selectors. Carved off `ConfigFacet` (#394 Codex #647) into the
    /// sibling `NumeraireConfigFacet` to keep ConfigFacet under the
    /// EIP-170 24,576-byte runtime limit.
    function _getNumeraireConfigSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](19);
        // T-034 Periodic Interest Payment knobs + master kill-switches +
        // per-knob single-value getters consumed by the protocol-console
        // knob registry.
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
        // T-048 Predominantly Available Denominator (PAD) — atomic
        // rotation setter + per-asset numeraire-direct override setter
        // + 5 individual getters consumed by the protocol-console
        // knob registry.
        s[12] = NumeraireConfigFacet.setPredominantDenominator.selector;
        s[13] = NumeraireConfigFacet.setAssetNumeraireDirectFeedOverride.selector;
        s[14] = NumeraireConfigFacet.getPredominantDenominator.selector;
        s[15] = NumeraireConfigFacet.getPredominantDenominatorSymbol.selector;
        s[16] = NumeraireConfigFacet.getEthPadFeed.selector;
        s[17] = NumeraireConfigFacet.getPadNumeraireRateFeed.selector;
        s[18] = NumeraireConfigFacet.getAssetNumeraireDirectFeedOverride.selector;
    }

    /// T-090 v1.1 (#389) — intent-based swap-to-repay config
    /// selectors. Carved off `ConfigFacet` after round-2 PR #420 CI
    /// block on EIP-170.
    function _getIntentConfigSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](16);
        s[0] = IntentConfigFacet.setIntentSwapToRepayEnabled.selector;
        s[1] = IntentConfigFacet.setIntentMinCommitHF.selector;
        s[2] = IntentConfigFacet.setIntentMinOutputBufferBps.selector;
        s[3] = IntentConfigFacet.setIntentAuctionSecondsBounds.selector;
        s[4] = IntentConfigFacet.setIntentCancelGraceSeconds.selector;
        s[5] = IntentConfigFacet.setFusionLimitOrderProtocol.selector;
        s[6] = IntentConfigFacet.setIntentAllowedPrincipalToken.selector;
        s[7] = IntentConfigFacet.setIntentAllowedCollateralToken.selector;
        s[8] = IntentConfigFacet.getIntentSwapToRepayEnabled.selector;
        s[9] = IntentConfigFacet.getIntentMinCommitHF.selector;
        s[10] = IntentConfigFacet.getIntentMinOutputBufferBps.selector;
        s[11] = IntentConfigFacet.getIntentAuctionSecondsBounds.selector;
        s[12] = IntentConfigFacet.getIntentCancelGraceSeconds.selector;
        s[13] = IntentConfigFacet.getFusionLimitOrderProtocol.selector;
        s[14] = IntentConfigFacet.getIntentAllowedPrincipalToken.selector;
        s[15] = IntentConfigFacet.getIntentAllowedCollateralToken.selector;
    }

    function _getRewardAggregatorSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](16);
        s[0] = RewardAggregatorFacet.onChainReportReceived.selector;
        s[1] = RewardAggregatorFacet.finalizeDay.selector;
        s[2] = RewardAggregatorFacet.forceFinalizeDay.selector;
        s[3] = RewardAggregatorFacet.broadcastGlobal.selector;
        s[4] = RewardAggregatorFacet.setExpectedSourceChainIds.selector;
        s[5] = RewardAggregatorFacet.isChainReported.selector;
        s[6] = RewardAggregatorFacet.getChainReport.selector;
        s[7] = RewardAggregatorFacet.getChainDailyReportCount.selector;
        s[8] = RewardAggregatorFacet.getDailyFirstReportAt.selector;
        s[9] = RewardAggregatorFacet.getDailyGlobalInterest.selector;
        s[10] = RewardAggregatorFacet.getExpectedSourceChainIds.selector;
        s[11] = RewardAggregatorFacet.isDayReadyToFinalize.selector;
        s[12] = RewardAggregatorFacet.backfillDayInclusion.selector;
        // Governor PR-3b (#1217) — day-pool stamp + commitment-state reads.
        s[13] = RewardAggregatorFacet.getDayPoolStamp.selector;
        s[14] = RewardAggregatorFacet.getGovernorCommitState.selector;
        // Governor PR-3c (#1217) — the D* cutover arming (one-shot admin).
        s[15] = RewardAggregatorFacet.setGovernorCommitArmedFromDay.selector;
    }

    function _getRewardRemittanceSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](12);
        s[0] = RewardRemittanceFacet.remitRewardBudget.selector;
        s[1] = RewardRemittanceFacet.setRewardRemittanceKeeper.selector;
        s[2] = RewardRemittanceFacet.quoteRewardBudget.selector;
        s[3] = RewardRemittanceFacet.getRewardBudgetRemitted.selector;
        s[4] = RewardRemittanceFacet.getRewardBudgetRemittedTotal.selector;
        s[5] = RewardRemittanceFacet.getRewardBudgetRemittedGlobal.selector;
        s[6] = RewardRemittanceFacet.getRewardRemittanceKeeper.selector;
        s[7] = RewardRemittanceFacet.setRewardRemittanceReceiver.selector;
        s[8] = RewardRemittanceFacet.onRewardBudgetReceived.selector;
        s[9] = RewardRemittanceFacet.getRewardRemittanceReceiver.selector;
        s[10] = RewardRemittanceFacet.getRewardBudgetReceivedTotal.selector;
        s[11] = RewardRemittanceFacet.quoteRemittanceFee.selector;
    }

    function _getMetricsSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](51);
        s[0] = MetricsFacet.getProtocolTVL.selector;
        s[1] = MetricsFacet.getProtocolStats.selector;
        s[2] = MetricsFacet.getUserCount.selector;
        s[3] = MetricsFacet.getActiveLoansCount.selector;
        s[4] = MetricsFacet.getActiveOffersCount.selector;
        s[5] = MetricsFacet.getTotalInterestEarnedNumeraire.selector;
        s[6] = MetricsFacet.getTreasuryMetrics.selector;
        // Legacy overload — disambiguated by full signature now that
        // the per-asset overload (added in §A.2) shares the name.
        s[7] = bytes4(keccak256("getRevenueStats(uint256)"));
        s[8] = MetricsFacet.getActiveLoansPaginated.selector;
        s[9] = MetricsFacet.getActiveOffersByAsset.selector;
        s[10] = MetricsFacet.getLoanSummary.selector;
        s[11] = MetricsFacet.getVaultStats.selector;
        s[12] = MetricsFacet.getNFTRentalDetails.selector;
        s[13] = MetricsFacet.getTotalNFTsInVaultByCollection.selector;
        s[14] = MetricsFacet.getUserSummary.selector;
        s[15] = MetricsFacet.getUserActiveLoans.selector;
        s[16] = MetricsFacet.getUserActiveOffers.selector;
        s[17] = MetricsFacet.getUserNFTsInVault.selector;
        s[18] = MetricsFacet.getProtocolHealth.selector;
        s[19] = MetricsFacet.getBlockTimestamp.selector;
        // Reverse-index enumeration (no event-scan dependency).
        s[20] = MetricsFacet.getGlobalCounts.selector;
        s[21] = MetricsFacet.getUserLoanCount.selector;
        s[22] = MetricsFacet.getUserOfferCount.selector;
        s[23] = MetricsFacet.isOfferCancelled.selector;
        s[24] = MetricsFacet.getUserLoansPaginated.selector;
        s[25] = MetricsFacet.getUserOffersPaginated.selector;
        s[26] = MetricsFacet.getUserLoansByStatusPaginated.selector;
        s[27] = MetricsFacet.getUserOffersByStatePaginated.selector;
        s[28] = MetricsFacet.getAllLoansPaginated.selector;
        s[29] = MetricsFacet.getAllOffersPaginated.selector;
        s[30] = MetricsFacet.getLoansByStatusPaginated.selector;
        s[31] = MetricsFacet.getOffersByStatePaginated.selector;
        // Range Orders Phase 1 — asset-agnostic paginated active-offer
        // scan, symmetric with `getActiveLoansPaginated`. Consumed by
        // the keeper-bot's `offerMatcher` detector to enumerate the
        // order book each tick.
        s[32] = MetricsFacet.getActiveOffersPaginated.selector;
        // Position-NFT live summary — single source of truth for
        // marketplace `tokenURI` rendering AND the frontend's NFT
        // verifier UI. Returns realized loan terms, locked collateral,
        // and claim state in one structured read.
        s[33] = MetricsFacet.getNFTPositionSummary.selector;
        // AnalyticalGettersDesign §3.2 — rolling-window per-asset
        // treasury accrual. Overload of the legacy
        // `getRevenueStats(uint256)` at index 7; selector hashed
        // explicitly because `.selector` is ambiguous on overloads.
        s[34] = bytes4(keccak256("getRevenueStats(address,uint16)"));
        s[35] = MetricsFacet.getActiveOffersByAssetPair.selector;
        // Struct-array variant of getUserOffersPaginated — one round
        // trip returns full Offer rows so the frontend skips the
        // multicall fan-out for per-user offer detail tables.
        s[36] = MetricsFacet.getUserAllOffersWithDetails.selector;
        // OfferBook 2-filter UX skinny-ranking view — surfaces the
        // sort-relevant subset of every active offer in a
        // (lending, collateral) pair so the frontend can sort across
        // the entire bucket without per-offer hydration. Pairs with
        // {getActiveOffersByAssetPair} (id-only) and {getOffer}
        // (full struct, single id).
        s[37] = MetricsFacet.getActiveOffersByAssetPairRanked.selector;

        // §8b — NFT-holder-keyed enumeration (secondary-market-safe).
        // Mirrors `userLoanIds`/`userOfferIds` views above but uses
        // ERC721Enumerable + reverse maps so secondary-market recipients
        // are included. See MetricsFacet:734-ish "§8b" block.
        s[38] = MetricsFacet.getUserPositionLoans.selector;
        s[39] = MetricsFacet.getUserPositionOffers.selector;
        // PR3 of internal-match work (2026-05-15) — paginated
        // active-loan view filtered by current LTV. Internal-match
        // bots use this per block to discover candidates; returns
        // empty while `internalMatchEnabled == false`.
        s[40] = MetricsFacet.getMatchEligibleLoans.selector;
        // EC-003 Phase 2 — O(K) opposing-pair lookup. Off-chain callers
        // pre-flight before submitting `triggerInternalMatchLiquidation`;
        // Phase 3 auto-dispatch in triggerLiquidation / triggerDefault /
        // claimAsLenderWithRetry consults this view internally.
        s[41] = MetricsFacet.hasInternalMatchCandidate.selector;
        // #407 (2026-06-12) — Vault encumbrance sub-ledger read
        // surface. Provability views for the per-loan collateral
        // lien (and future offer-principal lock) work.
        s[42] = MetricsFacet.getLoanCollateralLien.selector;
        s[43] = MetricsFacet.getOfferPrincipalLien.selector;
        s[44] = MetricsFacet.getEncumbered.selector;
        s[45] = MetricsFacet.getFreeBalance.selector;
        s[46] = MetricsFacet.getActiveLenderIntents.selector; // #625 WI-2a
        s[47] = MetricsFacet.getRollableIntentLoans.selector; // #625 WI-2c
        // #769 — paginated forms of the §8b position views, so a wallet griefed
        // with a huge position-NFT inventory can't make the unbounded
        // balanceOf-loop `eth_call` revert and break the holder's reads.
        s[48] = MetricsFacet.getUserPositionLoansPaginated.selector;
        s[49] = MetricsFacet.getUserPositionOffersPaginated.selector;
        // #955 (#921 item 4) — single-offer canonical lifecycle state, so a
        // Scenario-A consumed-by-sale terminal is visible to integrators without
        // the `ownerOf`-liveness heuristic.
        s[50] = MetricsFacet.getOfferState.selector;
    }

    /// AnalyticalGettersDesign §3.1 — per-user dashboard surface. One
    /// scalar snapshot + three paginated list views collapse the
    /// frontend Dashboard's 13-RPC first-load into 3 calls.
    function _getMetricsDashboardSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](9);
        s[0] = MetricsDashboardFacet.getUserDashboardSnapshot.selector;
        s[1] = MetricsDashboardFacet.getUserDashboardLoans.selector;
        s[2] = MetricsDashboardFacet.getUserDashboardOffers.selector;
        s[3] = MetricsDashboardFacet.getUserDashboardClaimables.selector;
        s[4] = MetricsDashboardFacet.getUserDashboardLoansBothSides.selector;
        // Public pagination cap — exposed on the Diamond so a UI can
        // size its page requests. Was missed in this cut list; surfaced
        // by the Issue #71 selector-coverage guardrail. `MAX_PAGE_LIMIT`
        // is a `public constant`; its auto-getter has no type-level
        // `.selector`, so the signature is hashed directly.
        s[5] = bytes4(keccak256("MAX_PAGE_LIMIT()"));
        // #1025 — bulk wallet-dashboard batch-by-id views + their public cap.
        s[6] = MetricsDashboardFacet.getOffersWithState.selector;
        s[7] = MetricsDashboardFacet.getLoansBatch.selector;
        // `MAX_BATCH_IDS` is likewise a `public constant`; hash its signature.
        s[8] = bytes4(keccak256("MAX_BATCH_IDS()"));
    }

    /// Phase 4.1 — Terms-of-Service acceptance gate. The gate stays
    /// disabled while `currentTosVersion == 0` (default at deploy);
    /// once governance writes a non-zero version + content hash via
    /// `setCurrentTos`, the frontend requires every wallet to call
    /// `acceptTerms(version, hash)` before reaching `/app/*` routes.
    function _getLegalSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = LegalFacet.acceptTerms.selector;
        s[1] = LegalFacet.setCurrentTos.selector;
        s[2] = LegalFacet.hasAcceptedCurrentTerms.selector;
        s[3] = LegalFacet.getCurrentTos.selector;
        s[4] = LegalFacet.getUserTosAcceptance.selector;
    }
}
