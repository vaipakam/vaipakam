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
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaipakamNFTMetadataFacet} from "../src/facets/VaipakamNFTMetadataFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {FallbackCustodyFacet} from "../src/facets/FallbackCustodyFacet.sol";
import {SwapAttemptFacet} from "../src/facets/SwapAttemptFacet.sol";
import {TreasuryFeeFacet} from "../src/facets/TreasuryFeeFacet.sol";
import {NotificationFeeFacet} from "../src/facets/NotificationFeeFacet.sol";
import {ForcedSaleFacet} from "../src/facets/ForcedSaleFacet.sol";
import {SaleExitVerdictFacet} from "../src/facets/SaleExitVerdictFacet.sol";
import {NumeraireValueFacet} from "../src/facets/NumeraireValueFacet.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {Deployments} from "./lib/Deployments.sol";
import {StorageLayoutRecord} from "./lib/StorageLayoutRecord.sol";
import {FacetSelectors} from "./lib/FacetSelectors.sol";
import {RefinanceRecordRollout} from "./lib/RefinanceRecordRollout.sol";
import {ArtifactDeploy} from "./lib/ArtifactDeploy.sol";
import {SellerClaimFacet} from "../src/facets/SellerClaimFacet.sol";

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
 *   forge script script/RedeployFacets.s.sol --ffi \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast -vvv
 */
contract RedeployFacets is Script {
    /// @notice #1566 S2b - the target Diamond predates vault-held fallback
    ///         custody, so this curated refresh refuses it; see
    ///         {_requireVaultHeldFallbackCustody}.
    error PredatesVaultHeldFallbackCustody(address diamond);
    /// @notice #1566 slice 3 - the target Diamond predates the fill lock; see
    ///         {_requireSlice3Diamond}.
    error PredatesSlice3FillLock(address diamond);
    /// @notice #666 - the target Diamond's OracleFacet predates the three-way
    ///         price status; see {_requireOraclePriceStatus}.
    error PredatesOraclePriceStatus(address diamond);
    /// @notice #902 - the target Diamond predates the per-rental renter rows;
    ///         see {_requirePerRentalRenterRows}.
    error PredatesPerRentalRenterRows(address diamond);
    /// @notice #2419 - the target Diamond predates the 1e18 numeraire value
    ///         rule; see {_requireNumeraireValueRule}.
    error PredatesNumeraireValueRule(address diamond);
    /// @notice #1209 / #1808 - the target Diamond predates the interest ledger;
    ///         see {_requireInterestLedger}.
    error PredatesInterestLedger(address diamond);
    /// @notice #668 / #935 - the target Diamond predates the loan clock (the
    ///         global pause credit); see {_requireLoanClock}.
    error PredatesLoanClock(address diamond);
    /// @notice #1820 - the target Diamond predates the tier record seam; see
    ///         {_requireTierRecordSeam}.
    error PredatesTierRecordSeam(address diamond);
    /// @notice #2957 - the target Diamond predates the position NFT metadata
    ///         split; see {_requireNftMetadataSplit}.
    error PredatesNftMetadataSplit(address diamond);
    /// @notice #3009 / #3025 - the target Diamond's OfferPreviewFacet predates
    ///         the cadence admission host; see {_requireCadenceAdmissionHost}.
    error PredatesCadenceAdmissionHost(address diamond);

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        // Read from deployments/<chain>/addresses.json with chain-prefixed
        // env fallback. Replaces the previous unprefixed `DIAMOND_ADDRESS`
        // env which was inconsistent with sibling scripts and risked
        // broadcasting against the wrong Diamond if env state was stale.
        runWith(Deployments.readDiamond(), deployerKey);
    }

    /**
     * @notice Parameterised entry — same body as {run}, with the target and the
     *         signer passed in rather than read from the environment.
     *
     * @dev    #1649. Exists so `PartialRefreshRoutingTest` can drive this script
     *         against a Diamond it built in-process. The alternative,
     *         `vm.setEnv`, writes the PROCESS environment shared by every
     *         parallel test thread, so two tests refreshing different Diamonds
     *         would clobber each other mid-broadcast — the same race
     *         `DeployDiamond.runWith` was introduced to avoid. Production
     *         invocation is unchanged: {run} reads the env and calls straight
     *         through here, so the test exercises the real cut assembly rather
     *         than a copy of it.
     */
    function runWith(address diamond, uint256 deployerKey) public {
        console.log("Diamond:", diamond);
        // #2092 item 1 — refuse code that drops a storage-layout fact this
        // chain records, before anything is broadcast (needs `--ffi`); the
        // record is rewritten once the cut is in. In this body rather than in
        // {run}, so `--sig runWith(...)` cannot skip it; the in-process tests
        // skip it by the library's own rule ({StorageLayoutRecord.active}).
        StorageLayoutRecord.requireAppendOnly("RedeployFacets", diamond);
        // #2407 — the refinance-request record spans facets this curated set
        // does not carry; refuse a Diamond that has not had it rolled out.
        RefinanceRecordRollout.assertInstalled(diamond);
        // #1566 S2b - refuse a Diamond from before vault-held fallback
        // custody, before anything is broadcast; see
        // {_requireVaultHeldFallbackCustody}.
        _requireVaultHeldFallbackCustody(diamond);
        // #1566 slice 3 - and one from before the fill lock; see {_requireSlice3Diamond}.
        _requireSlice3Diamond(diamond);
        // #666 - and one whose OracleFacet cannot answer the fallback's
        // price-status read; see {_requireOraclePriceStatus}.
        _requireOraclePriceStatus(diamond);
        // #902 - and one from before the per-rental renter rows; see
        // {_requirePerRentalRenterRows}.
        _requirePerRentalRenterRows(diamond);
        // #2419 - and one from before the 1e18 numeraire value rule; see
        // {_requireNumeraireValueRule}.
        _requireNumeraireValueRule(diamond);
        // #668 / #935 - and one from before the loan clock; see
        // {_requireLoanClock}.
        _requireLoanClock(diamond);
        // #1820 - and one from before the tier record seam; see
        // {_requireTierRecordSeam}.
        _requireTierRecordSeam(diamond);
        // #2957 - and one from before the NFT metadata split; see
        // {_requireNftMetadataSplit}.
        _requireNftMetadataSplit(diamond);
        // #3009 / #3025 - and one whose OfferPreviewFacet cannot answer the
        // origination cadence check; see {_requireCadenceAdmissionHost}.
        _requireCadenceAdmissionHost(diamond);
        // #1209 / #1808 - and one from before the interest ledger; see
        // {_requireInterestLedger}.
        _requireInterestLedger(diamond);

        vm.startBroadcast(deployerKey);

        RiskFacet riskFacet = RiskFacet(ArtifactDeploy.deploy(type(RiskFacet).name));
        // #658 — the split liquidation path (triggerLiquidationSplit) got the
        // SAME eager-consolidation + post-withdraw VPFI-restamp wiring as the
        // RiskFacet liquidation entries, so refresh it together with RiskFacet
        // to avoid a half-applied liquidation family (new RiskFacet + stale
        // split path) on a curated redeploy.
        RiskSplitLiquidationFacet riskSplitLiquidationFacet =
            RiskSplitLiquidationFacet(ArtifactDeploy.deploy(type(RiskSplitLiquidationFacet).name));
        DefaultedFacet defaultedFacet = DefaultedFacet(ArtifactDeploy.deploy(type(DefaultedFacet).name));
        LoanFacet loanFacet = LoanFacet(ArtifactDeploy.deploy(type(LoanFacet).name));
        PrecloseFacet precloseFacet = PrecloseFacet(ArtifactDeploy.deploy(type(PrecloseFacet).name));
        EarlyWithdrawalFacet earlyWithdrawalFacet = EarlyWithdrawalFacet(ArtifactDeploy.deploy(type(EarlyWithdrawalFacet).name));
        // #1780 — the direct lender-exit route now lives in its own facet. It
        // must be refreshed WITH the listed route, not instead of it: the two
        // were one contract, so a curated redeploy that carried only
        // EarlyWithdrawalFacet would leave `sellLoanViaBuyOffer` pointing at
        // the pre-split bytecode while the listed route moved on — the exact
        // half-applied-family failure #1649 documents for the sale classifier.
        EarlyWithdrawalDirectFacet earlyWithdrawalDirectFacet =
            EarlyWithdrawalDirectFacet(ArtifactDeploy.deploy(type(EarlyWithdrawalDirectFacet).name));
        // #658 PR-B2 — refinance gained the lender-side eager-consolidation hook
        // (cross-calls ConsolidationFacet, like precloseDirect). Refresh it
        // alongside Preclose so a curated redeploy doesn't leave refinance on
        // stale bytecode that skips the consolidation while preclose applies it.
        RefinanceFacet refinanceFacet = RefinanceFacet(ArtifactDeploy.deploy(type(RefinanceFacet).name));
        // #658 PR-B2 — claimAsBorrower gained the post-withdraw VPFI restamp
        // (the claim-time half of the direct-preclose close-out). Refresh
        // ClaimFacet so a curated redeploy doesn't leave the claim path on stale
        // bytecode that skips the restamp after a preclosed borrower claims VPFI.
        ClaimFacet claimFacet = ClaimFacet(ArtifactDeploy.deploy(type(ClaimFacet).name));
        // #691 — the internal-match executors (triggerInternalMatchLiquidation +
        // attemptInternalMatchAutoDispatch) gained the eager-consolidation +
        // VPFI-restamp hooks. Refresh RiskMatchLiquidationFacet so a curated
        // redeploy doesn't leave transferred-position internal matches bypassing
        // the new consolidation while the rest of the close-out family is
        // upgraded.
        RiskMatchLiquidationFacet riskMatchFacet = RiskMatchLiquidationFacet(ArtifactDeploy.deploy(type(RiskMatchLiquidationFacet).name));
        ProfileFacet profileFacet = ProfileFacet(ArtifactDeploy.deploy(type(ProfileFacet).name));
        // #658 — the refreshed RiskFacet liquidation paths cross-call
        // ConsolidationFacet's eager-consolidation + post-withdraw VPFI-restamp
        // entries. Those selectors are NEW (added in #658), so a curated
        // RiskFacet-only refresh would leave the upgraded RiskFacet calling
        // unrouted selectors and bubble a revert mid-liquidation. Redeploy
        // ConsolidationFacet alongside and cut its selectors (partitioned by
        // live routing, same as the #394 HF-floor knob).
        ConsolidationFacet consolidationFacet = ConsolidationFacet(ArtifactDeploy.deploy(type(ConsolidationFacet).name));
        // #1817 / #1820 — every refreshed facet that moves VPFI refreshes the
        // owner's tier record through `VPFIDiscountAccumulatorFacet.syncTierRecord`,
        // and `LibTierRecord.refresh` deliberately NO-OPS on
        // `FunctionDoesNotExist` (its minimal-fixture rule). Deploy the
        // accumulator alongside and route its FULL surface (partitioned by
        // live routing below) so its code is the refreshed facets' build.
        VPFIDiscountAccumulatorFacet accumulatorFacet =
            VPFIDiscountAccumulatorFacet(ArtifactDeploy.deploy(type(VPFIDiscountAccumulatorFacet).name));
        // #1123 — VaipakamNFTFacet inlines the fail-closed movement gate into
        // transferFrom/safeTransferFrom, and VaultFactoryFacet registers a
        // recovery-banned wallet into the confirmed-flagged registry. A curated
        // redeploy MUST re-cut both or raw transfers / recovery bans stay on the
        // old fail-open bytecode while the rest of the movement surface is upgraded.
        VaipakamNFTFacet nftFacet = VaipakamNFTFacet(ArtifactDeploy.deploy(type(VaipakamNFTFacet).name));
        VaultFactoryFacet vaultFactoryFacet = VaultFactoryFacet(ArtifactDeploy.deploy(type(VaultFactoryFacet).name));
        // #1649 — #1503 gave both `EarlyWithdrawalFacet` sale entry points
        // (`sellLoanViaBuyOffer`, `createLoanSaleOffer`) a cross-facet call to
        // `RiskPreviewFacet.saleAdmission`. That selector is NEW, so refreshing
        // EarlyWithdrawalFacet alone would install sale code that calls an
        // unrouted selector — every sale reverting `FunctionDoesNotExist`
        // through the fallback, with the new bytecode live. Deploy the
        // classifier's host alongside and cut its selectors (partitioned by
        // routing below), exactly as #658 does for ConsolidationFacet.
        RiskPreviewFacet riskPreviewFacet = RiskPreviewFacet(ArtifactDeploy.deploy(type(RiskPreviewFacet).name));
        // #1209 / #1808 — the same dependency, one step further out. Every
        // open-loan interest payout goes through EncumbranceMutateFacet's
        // pay-or-freeze entries, which pay open seller claims first, and
        // RepayPeriodicFacet pays the periodic interest through them. Refresh
        // the sale routes without them and the interest ledger is kept by only
        // some of the paths that move interest. (This pairing first existed for
        // #1503 item 28's paid-through mark, now retired.)
        RepayPeriodicFacet repayPeriodicFacet = RepayPeriodicFacet(ArtifactDeploy.deploy(type(RepayPeriodicFacet).name));
        EncumbranceMutateFacet encumbranceMutateFacet = EncumbranceMutateFacet(ArtifactDeploy.deploy(type(EncumbranceMutateFacet).name));
        // #1566 slice 2 - RiskFacet and DefaultedFacet now ENTER the fallback, and
        // ClaimFacet retries its swap and disposes of it, by self-calling this
        // host. Its selectors are NEW on any Diamond cut before the split, so
        // refreshing those three without it installs code that calls unrouted
        // selectors: a liquidation or default whose swap fails, and every claim
        // of a fallback-pending loan, would revert `FunctionDoesNotExist` through
        // the Diamond fallback - the half-applied family #658 and #1649 document.
        // Deploy it alongside and route its FULL surface (partitioned by live
        // routing below), in the same cut as its callers. Since S2b a Diamond
        // from before vault-held fallback custody never reaches this point:
        // `runWith` refuses it first (`_requireVaultHeldFallbackCustody`).
        FallbackCustodyFacet fallbackCustodyFacet = FallbackCustodyFacet(ArtifactDeploy.deploy(type(FallbackCustodyFacet).name));
        // #2472 - the swap-attempt host. Risk, Defaulted, ForcedSale and
        // FallbackCustody run every failover attempt by self-calling it, so it
        // rides the same cut as those callers. On a pre-#2472 Diamond its one
        // selector is unrouted and partitions to an Add below.
        SwapAttemptFacet swapAttemptFacet = SwapAttemptFacet(ArtifactDeploy.deploy(type(SwapAttemptFacet).name));
        // #2440 - the treasury fee host. Defaulted, Preclose, Refinance,
        // EarlyWithdrawal and RepayPeriodic move every fee into the treasury by
        // self-calling it, so it rides the same cut as those callers. On a
        // pre-#2440 Diamond its two selectors are unrouted and partition to an
        // Add below.
        TreasuryFeeFacet treasuryFeeFacet = TreasuryFeeFacet(ArtifactDeploy.deploy(type(TreasuryFeeFacet).name));
        // #2419 - the valuation host. RiskFacet (every LTV / HF read),
        // RiskPreviewFacet (LibRiskMath) and every KYC comparison (Defaulted,
        // RiskSplitLiquidation, and Loan, Preclose and EarlyWithdrawalDirect
        // through LibCompliance) value through it by self-call, so it rides
        // the same cut. The target already routes it
        // ({_requireNumeraireValueRule}); a selector added to the host later
        // partitions to an Add below.
        NumeraireValueFacet numeraireValueFacet = NumeraireValueFacet(ArtifactDeploy.deploy(type(NumeraireValueFacet).name));
        // #2769 - the paid-notification fee host. Its charge moved off
        // LoanFacet and its consent off ProfileFacet, both refreshed here, so
        // it rides the same cut: on a Diamond that still routes the charge to
        // an old LoanFacet, refreshing LoanFacet alone would leave every bill
        // on that old code. Already-routed selectors partition to a Replace
        // that moves them here; unrouted ones to an Add.
        NotificationFeeFacet notificationFeeFacet = NotificationFeeFacet(ArtifactDeploy.deploy(type(NotificationFeeFacet).name));
        // #2795 - the forced-sale host. RepayPeriodicFacet reads the sale plan
        // and settles every periodic sale by self-calling it, so it rides the
        // same cut: refreshing RepayPeriodicFacet alone would revert
        // `FunctionDoesNotExist` on every periodic settlement that sells. On a
        // pre-#2795 Diamond its selectors are unrouted and partition to an Add.
        ForcedSaleFacet forcedSaleFacet = ForcedSaleFacet(ArtifactDeploy.deploy(type(ForcedSaleFacet).name));

        console.log("RiskFacet:            ", address(riskFacet));
        console.log("RiskSplitLiquidation: ", address(riskSplitLiquidationFacet));
        console.log("DefaultedFacet:       ", address(defaultedFacet));
        console.log("LoanFacet:            ", address(loanFacet));
        console.log("PrecloseFacet:        ", address(precloseFacet));
        console.log("EarlyWithdrawalFacet: ", address(earlyWithdrawalFacet));
        console.log("EarlyWithdrawalDirect:", address(earlyWithdrawalDirectFacet));
        console.log("RefinanceFacet:       ", address(refinanceFacet));
        console.log("ClaimFacet:           ", address(claimFacet));
        console.log("RiskMatchLiquidation: ", address(riskMatchFacet));
        console.log("ProfileFacet:         ", address(profileFacet));
        console.log("ConsolidationFacet:   ", address(consolidationFacet));
        console.log("VPFIDiscountAccum.:   ", address(accumulatorFacet));
        console.log("RiskPreviewFacet:     ", address(riskPreviewFacet));
        console.log("RepayPeriodicFacet:   ", address(repayPeriodicFacet));
        console.log("EncumbranceMutate:    ", address(encumbranceMutateFacet));
        console.log("FallbackCustodyFacet: ", address(fallbackCustodyFacet));
        console.log("SwapAttemptFacet:     ", address(swapAttemptFacet));
        console.log("TreasuryFeeFacet:     ", address(treasuryFeeFacet));
        console.log("NumeraireValueFacet:  ", address(numeraireValueFacet));
        console.log("NotificationFeeFacet: ", address(notificationFeeFacet));
        console.log("ForcedSaleFacet:      ", address(forcedSaleFacet));

        // #394 (Codex #647 rounds 5+7) — the runtime HF-floor knob selectors
        // need an Add on a PRE-#394 diamond (not yet routed → Replace reverts on
        // a zero old facet) but a Replace on a SAME-VERSION diamond (already
        // routed → Add reverts as "exists"). A static choice can't serve both,
        // so partition them by the live diamond's routing via the loupe: Add the
        // unrouted, Replace the already-routed. This makes the script correct
        // against any target diamond.
        (bytes4[] memory hfToAdd, bytes4[] memory hfToReplace) =
            _partitionByRouting(diamond, _riskAddSelectors());
        // #2696 — `updateRiskParams` dropped the retired reserve factor, so its
        // selector changed: the new one is partitioned with the Add set above
        // (an Add on a pre-#2696 Diamond, a Replace after), and the old one is
        // Removed wherever it is still routed (empty on a fresh or migrated
        // Diamond, so the step is idempotent).
        bytes4[] memory retiredRiskSetter = new bytes4[](1);
        retiredRiskSetter[0] = FacetSelectors.retiredUpdateRiskParamsSelector();
        (, bytes4[] memory riskToRemove) = _partitionByRouting(diamond, retiredRiskSetter);
        // #658 — same Add/Replace-by-routing split for the ConsolidationFacet
        // selector set: on a current-version diamond the two #594 standalone
        // entries are already routed (Replace) and the three #658 entries are
        // new (Add); on a pre-#594 diamond all five would be new (Add).
        (bytes4[] memory consToAdd, bytes4[] memory consToReplace) =
            _partitionByRouting(diamond, _consolidationSelectors());
        // #2083 — DefaultedFacet gained the `defaultKycAdmission` view, new on
        // a pre-#2083 diamond (Add) and routed after (Replace). The routed
        // subset is never empty (`isLoanDefaultable` is routed on every
        // existing diamond), so the fixed Replace slot below stays valid.
        (bytes4[] memory dfToAdd, bytes4[] memory dfToReplace) =
            _partitionByRouting(diamond, _defaultedSelectors());
        // #1810 — EarlyWithdrawalFacet gained `createLoanSaleOfferBound`, so
        // its list is partitioned like the others: on a pre-#1810 diamond the
        // three older selectors are routed (Replace) and the bound entry is
        // new (Add); the routed subset is never empty (createLoanSaleOffer is
        // routed on every existing diamond), so the fixed Replace slot below
        // stays valid.
        (bytes4[] memory ewToAdd, bytes4[] memory ewToReplace) =
            _partitionByRouting(diamond, _earlyWithdrawalSelectors());
        // #1922 (#1503 item 6) — EarlyWithdrawalDirectFacet gained the bound
        // entry `sellLoanViaBuyOfferBound`, so its list is no longer a blanket
        // Replace (the #1780 assumption below is now stale). On a pre-#1922
        // diamond `sellLoanViaBuyOffer` is routed (Replace) and the bound entry
        // is new (Add); a blanket Replace would revert on the unrouted new
        // selector. The routed subset is never empty (`sellLoanViaBuyOffer` is
        // routed on every post-#1780 diamond), so the fixed Replace slot stays
        // valid.
        (bytes4[] memory ewdToAdd, bytes4[] memory ewdToReplace) =
            _partitionByRouting(diamond, _earlyWithdrawalDirectSelectors());
        // #2349 — RefinanceFacet gained `refinanceLoanFromMatch` (the matcher-
        // fill route). On a pre-#2349 diamond `refinanceLoan` and
        // `refinanceLoanFromAccept` are routed (Replace) and the match entry is
        // new (Add). The routed subset is never empty (`refinanceLoan` is routed
        // on every existing diamond), so the fixed Replace slot stays valid.
        (bytes4[] memory refiToAdd, bytes4[] memory refiToReplace) =
            _partitionByRouting(diamond, _refinanceSelectors());
        // #1817 r9 — the accumulator's surface, same Add/Replace-by-routing
        // split. {_requireTierRecordSeam} has already refused a Diamond that
        // does not route `syncTierRecord`, so on every accepted target the
        // whole surface is routed (Replace).
        (bytes4[] memory accToAdd, bytes4[] memory accToReplace) =
            _partitionByRouting(diamond, _accumulatorSelectors());
        // #954 (Codex #981 r-EIP170 P2) — ClaimFacet gained a NEW selector
        // (`getBorrowerSurplusClaim`) alongside its 8 already-routed ones. On a
        // current-version diamond the 8 are routed (Replace) and the new one is
        // unrouted (Add); a blanket Replace would revert on the new selector
        // (Replace requires a non-zero existing facet). Same Add/Replace-by-
        // routing split as the HF knob + Consolidation sets above.
        (bytes4[] memory claimToAdd, bytes4[] memory claimToReplace) =
            _partitionByRouting(diamond, _claimSelectors());
        // #1980 — `getBorrowerLifRebate` retired with the borrower LIF
        // VPFI-custody path, so it is gone from `_claimSelectors()`. Remove it
        // wherever it is still routed, or it stays live on the old ClaimFacet
        // bytecode (empty on a fresh Diamond, so the step is idempotent).
        bytes4[] memory retiredClaim = new bytes4[](1);
        retiredClaim[0] = FacetSelectors.retiredBorrowerLifRebateSelector();
        (, bytes4[] memory claimToRemove) = _partitionByRouting(diamond, retiredClaim);
        // #1123 — ProfileFacet gained THREE new selectors (refreshSanctionsFlag,
        // isSanctionsConfirmedFlagged, enforcePositionSaleMove + enforcePositionMove)
        // alongside its already-routed ones. Same Add/Replace-by-routing split as
        // Claim/HF/Consolidation: a blanket Replace would revert on the unrouted
        // new selectors on a pre-#1123 diamond (Replace requires a non-zero
        // existing facet).
        (bytes4[] memory profToAdd, bytes4[] memory profToReplace) =
            _partitionByRouting(diamond, _profileSelectors());
        // #1221 — the keeper action bitmask widened uint8→uint16, which CHANGED
        // the 4-byte selectors of approveKeeper/setKeeperActions. The NEW uint16
        // selectors are Add'ed/Replace'd via `_profileSelectors()` above, but on
        // a diamond cut BEFORE this PR the OLD uint8 selectors stay routed to the
        // stale ProfileFacet bytecode unless explicitly REMOVED — leaving a
        // duplicate, obsolete entry point live alongside the new ABI. Partition
        // the legacy selectors by routing and Remove only those still present
        // (the `toReplace` slot = the currently-routed subset); on a fresh or
        // already-migrated diamond the subset is empty and no Remove is cut, so
        // the step is idempotent.
        (, bytes4[] memory profToRemove) =
            _partitionByRouting(diamond, _legacyProfileRemovedSelectors());
        // #1123 — VaipakamNFTFacet (inline transfer gate) + VaultFactoryFacet
        // (recovery-ban register) partitioned by routing. On a current-version
        // diamond every selector is already routed (all Replace); the split just
        // keeps the script correct against a pre-existing diamond too.
        (bytes4[] memory nftToAdd, bytes4[] memory nftToReplace) =
            _partitionByRouting(diamond, FacetSelectors.vaipakamNFT());
        (bytes4[] memory vfToAdd, bytes4[] memory vfToReplace) =
            _partitionByRouting(diamond, FacetSelectors.vaultFactory());
        // #1566 transport epochs 3b-ii-A (Codex #2276 r13 P2, r14 P2) — the
        // four-argument vault credit is NOT removed: it stays on the refreshed
        // VaultFactoryFacet as a compatibility entry inside
        // `FacetSelectors.vaultFactory()`, so this Replace re-routes it and a
        // RewardClaimFacet from before the epoch leg keeps delivering to the
        // vault. Removing it without cutting every caller atomically left
        // such a caller's self-call failing into wallet delivery.
        // #1649 — the sale classifier's host. On a pre-#1503 diamond the seven
        // older preview selectors are routed (Replace) and `saleAdmission` is
        // not (Add); on a current one all eight are routed. The partition makes
        // one script correct against both, and the Add is the half that keeps a
        // refreshed EarlyWithdrawalFacet's sale paths from reverting.
        (bytes4[] memory rpToAdd, bytes4[] memory rpToReplace) =
            _partitionByRouting(diamond, FacetSelectors.riskPreview());
        // #2459 r4 — `previewIntent` gained the route's outer initiator, so its
        // selector CHANGED: the new one is in `riskPreview()` above, and the old
        // one is Removed wherever it is still routed (empty on a fresh or
        // migrated Diamond, so the step is idempotent).
        bytes4[] memory retiredPreview = new bytes4[](1);
        retiredPreview[0] = FacetSelectors.retiredPreviewIntentSelector();
        (, bytes4[] memory rpToRemove) = _partitionByRouting(diamond, retiredPreview);

        // The interest payout entries. `RepayPeriodicFacet`'s surface is
        // unchanged (plain Replace). `EncumbranceMutateFacet`'s retired 3-arg
        // resident payout (#1503 item 28) is Removed wherever still routed; the
        // #1209 entries are already routed on every Diamond this script admits
        // (`_requireInterestLedger`).
        (bytes4[] memory rpsToAdd, bytes4[] memory rpsToReplace) =
            _partitionByRouting(diamond, FacetSelectors.repayPeriodic());
        (bytes4[] memory encToAdd, bytes4[] memory encToReplace) =
            _partitionByRouting(diamond, FacetSelectors.encumbranceMutate());
        bytes4[] memory retiredResident = new bytes4[](1);
        retiredResident[0] = FacetSelectors.retiredResidentPayoutSelector();
        (, bytes4[] memory encToRemove) =
            _partitionByRouting(diamond, retiredResident);
        // #1566 slice 2 - the fallback-custody host. The S2b boundary check at
        // the top of `runWith` admits only a Diamond that already routes the
        // S2b surface, so today every selector partitions to Replace; the
        // partition stays so a selector added to the host later is an Add, as
        // for every other facet here. Sourced from the one list the deploy
        // also cuts.
        (bytes4[] memory fcToAdd, bytes4[] memory fcToReplace) =
            _partitionByRouting(diamond, FacetSelectors.fallbackCustody());
        // #2472 - the swap-attempt host, from the one list the deploy cuts.
        (bytes4[] memory saToAdd, bytes4[] memory saToReplace) =
            _partitionByRouting(diamond, FacetSelectors.swapAttempt());
        // #2440 - the treasury fee host, from the one list the deploy cuts.
        (bytes4[] memory tfToAdd, bytes4[] memory tfToReplace) =
            _partitionByRouting(diamond, FacetSelectors.treasuryFee());
        // #2419 - the valuation host, from the one list the deploy cuts.
        (bytes4[] memory nvToAdd, bytes4[] memory nvToReplace) =
            _partitionByRouting(diamond, FacetSelectors.numeraireValue());
        // #2769 - the paid-notification fee host, from the one list the deploy cuts.
        (bytes4[] memory nfToAdd, bytes4[] memory nfToReplace) =
            _partitionByRouting(diamond, FacetSelectors.notificationFee());
        // #2795 - the forced-sale host, from the one list the deploy cuts.
        (bytes4[] memory fsToAdd, bytes4[] memory fsToReplace) =
            _partitionByRouting(diamond, FacetSelectors.forcedSale());

        // #2796 - every forced-sale entry point gained the caller's sell
        // amount, so each selector CHANGED: the new ones are Add/Replace by
        // routing and the retired shapes are Removed wherever still routed
        // (idempotent: nothing is removed on a fresh or migrated Diamond).
        IDiamondCut.FacetCut[] memory sellCuts =
            _forcedSaleEntryCuts(diamond, address(defaultedFacet));
        // #1841 - both lender-exit entries gate on SaleExitVerdictFacet by
        // self-call, so the host rides the same cut as the two entries above.
        IDiamondCut.FacetCut[] memory verdictCuts = _saleExitVerdictCuts(diamond);

        uint256 nExtra = sellCuts.length + verdictCuts.length +
            (hfToAdd.length > 0 ? 1 : 0) + (hfToReplace.length > 0 ? 1 : 0) +
            (riskToRemove.length > 0 ? 1 : 0) +
            (consToAdd.length > 0 ? 1 : 0) + (consToReplace.length > 0 ? 1 : 0) +
            (ewToAdd.length > 0 ? 1 : 0) +
            (ewdToAdd.length > 0 ? 1 : 0) +
            (refiToAdd.length > 0 ? 1 : 0) +
            (accToAdd.length > 0 ? 1 : 0) + (accToReplace.length > 0 ? 1 : 0) +
            (claimToAdd.length > 0 ? 1 : 0) + (claimToReplace.length > 0 ? 1 : 0) +
            (claimToRemove.length > 0 ? 1 : 0) +
            (profToAdd.length > 0 ? 1 : 0) + (profToReplace.length > 0 ? 1 : 0) +
            (nftToAdd.length > 0 ? 1 : 0) + (nftToReplace.length > 0 ? 1 : 0) +
            (vfToAdd.length > 0 ? 1 : 0) + (vfToReplace.length > 0 ? 1 : 0) +
            (rpToAdd.length > 0 ? 1 : 0) + (rpToReplace.length > 0 ? 1 : 0) +
            (rpsToAdd.length > 0 ? 1 : 0) + (rpsToReplace.length > 0 ? 1 : 0) +
            (encToAdd.length > 0 ? 1 : 0) + (encToReplace.length > 0 ? 1 : 0) +
            (encToRemove.length > 0 ? 1 : 0) +
            (profToRemove.length > 0 ? 1 : 0) +
            (rpToRemove.length > 0 ? 1 : 0) +
            (fcToAdd.length > 0 ? 1 : 0) + (fcToReplace.length > 0 ? 1 : 0) +
            (saToAdd.length > 0 ? 1 : 0) + (saToReplace.length > 0 ? 1 : 0) +
            (tfToAdd.length > 0 ? 1 : 0) + (tfToReplace.length > 0 ? 1 : 0) +
            (nvToAdd.length > 0 ? 1 : 0) + (nvToReplace.length > 0 ? 1 : 0) +
            (nfToAdd.length > 0 ? 1 : 0) + (nfToReplace.length > 0 ? 1 : 0) +
            (fsToAdd.length > 0 ? 1 : 0) + (fsToReplace.length > 0 ? 1 : 0) +
            (dfToAdd.length > 0 ? 1 : 0);
        IDiamondCut.FacetCut[] memory cuts =
            new IDiamondCut.FacetCut[](9 + nExtra);
        cuts[0] = _replace(address(riskFacet), _riskSelectors());
        cuts[1] = _replace(address(defaultedFacet), dfToReplace);
        cuts[2] = _replace(address(loanFacet), _loanSelectors());
        cuts[3] = _replace(address(precloseFacet), _precloseSelectors());
        cuts[4] = _replace(address(earlyWithdrawalFacet), ewToReplace);
        // #658 — triggerLiquidationSplit is already routed on a current diamond
        // (relocated to RiskSplitLiquidationFacet in #66/#633), so a plain
        // Replace repoints it to the refreshed bytecode.
        cuts[5] = _replace(address(riskSplitLiquidationFacet), _riskSplitSelectors());
        // #658 PR-B2 — refinance selectors are already routed on a current
        // diamond, so a plain Replace repoints them to the consolidation-aware
        // bytecode. #2349 — only the ROUTED subset goes through this Replace;
        // the new match entry is Add'ed below on a pre-#2349 diamond.
        cuts[6] = _replace(address(refinanceFacet), refiToReplace);
        // #691 — RiskMatch selectors are already routed on a current diamond
        // (triggerInternalMatchLiquidation + the cross-facet-only
        // attemptInternalMatchAutoDispatch), so a plain Replace repoints them to
        // the consolidation-aware bytecode.
        cuts[7] = _replace(address(riskMatchFacet), _riskMatchSelectors());
        // #1780 — `sellLoanViaBuyOffer` is already routed on every existing
        // diamond (it was part of EarlyWithdrawalFacet's surface), so it is a
        // plain Replace that repoints the selector to the new address.
        // #1922 — the bound entry `sellLoanViaBuyOfferBound` is NOT routed on a
        // pre-#1922 diamond, so only the routed subset (`ewdToReplace`) may go
        // through this fixed Replace; the unrouted bound selector (`ewdToAdd`) is
        // issued as an Add in the partitioned block below.
        cuts[8] = _replace(address(earlyWithdrawalDirectFacet), ewdToReplace);
        // ProfileFacet + ClaimFacet are partitioned below (not fixed Replaces)
        // because each gained new-and-possibly-unrouted selectors.
        uint256 idx = 9;
        for (uint256 i = 0; i < sellCuts.length; i++) {
            cuts[idx++] = sellCuts[i];
        }
        for (uint256 i = 0; i < verdictCuts.length; i++) {
            cuts[idx++] = verdictCuts[i];
        }
        if (riskToRemove.length > 0) {
            cuts[idx++] = _remove(riskToRemove);
        }
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
        // #2083 — the default-KYC verdict view is an Add on a pre-#2083
        // diamond; on a current one the subset is empty and no Add is cut.
        if (dfToAdd.length > 0) {
            cuts[idx++] = _add(address(defaultedFacet), dfToAdd);
        }
        // #1810 — the quote-bound listing entry is an Add on any pre-#1810
        // diamond (the routed subset went through the fixed Replace above).
        if (ewToAdd.length > 0) {
            cuts[idx++] = _add(address(earlyWithdrawalFacet), ewToAdd);
        }
        // #1922 (#1503 item 6) — the bound direct-sale entry is an Add on any
        // pre-#1922 diamond (the routed `sellLoanViaBuyOffer` went through the
        // fixed Replace above); on a current diamond the subset is empty and no
        // Add is cut.
        if (ewdToAdd.length > 0) {
            cuts[idx++] = _add(address(earlyWithdrawalDirectFacet), ewdToAdd);
        }
        // #2349 — the matcher-fill refinance entry is an Add on any pre-#2349
        // diamond; on a current one the subset is empty and no Add is cut.
        //
        // PARTIAL-REFRESH POSTURE, stated rather than implied (#2355 r4): this
        // script does NOT refresh the callers that choose between the two
        // atomic entries — OfferAcceptFacet (chain hook) and OfferMatchFacet
        // (dust-close). On a pre-#2349 diamond those stale callers keep
        // completing a matched fill through `refinanceLoanFromAccept`, which the
        // refreshed facet no longer gates on the kill switch. The switch still
        // stops matched refinances there: the matcher's ADMISSION check
        // (`LibAutoRefinanceCheck.matchAdmissible`, inlined into the stale
        // OfferMatchFacet and unchanged by #2349) refuses every tagged pair
        // while it is off. What such a diamond lacks is the second,
        // execution-time layer in `refinanceLoanFromMatch`. The full #2349
        // rollout is a fresh `DeployDiamond` (see the scope note at the top).
        if (refiToAdd.length > 0) {
            cuts[idx++] = _add(address(refinanceFacet), refiToAdd);
        }
        // #1817 r9 — route the accumulator's surface. The Add branch is the one
        // that matters on a pre-RL-1 diamond: without it the refreshed sale
        // facets' intermediate checkpoints silently no-op (the library eats
        // FunctionDoesNotExist), so tier tenure survives a zero-balance dip.
        if (accToReplace.length > 0) {
            cuts[idx++] = _replace(address(accumulatorFacet), accToReplace);
        }
        if (accToAdd.length > 0) {
            cuts[idx++] = _add(address(accumulatorFacet), accToAdd);
        }
        // #658 PR-B2 — the already-routed ClaimFacet selectors repoint to the
        // refreshed bytecode; #954's new selector is Add'ed.
        if (claimToRemove.length > 0) {
            cuts[idx++] = _remove(claimToRemove);
        }
        if (claimToReplace.length > 0) {
            cuts[idx++] = _replace(address(claimFacet), claimToReplace);
        }
        if (claimToAdd.length > 0) {
            cuts[idx++] = _add(address(claimFacet), claimToAdd);
        }
        // #1123 — already-routed ProfileFacet selectors repoint to the refreshed
        // bytecode (Replace); the new #1123 selectors are Add'ed.
        if (profToReplace.length > 0) {
            cuts[idx++] = _replace(address(profileFacet), profToReplace);
        }
        if (profToAdd.length > 0) {
            cuts[idx++] = _add(address(profileFacet), profToAdd);
        }
        // #1221 — Remove the stale uint8 keeper selectors still routed from a
        // pre-#1221 diamond (empty, so skipped, on a fresh/already-migrated one).
        if (profToRemove.length > 0) {
            cuts[idx++] = _remove(profToRemove);
        }
        // #1123 — VaipakamNFTFacet (inline transfer gate) + VaultFactoryFacet
        // (recovery-ban register) repoint to the refreshed bytecode.
        if (nftToReplace.length > 0) {
            cuts[idx++] = _replace(address(nftFacet), nftToReplace);
        }
        if (nftToAdd.length > 0) {
            cuts[idx++] = _add(address(nftFacet), nftToAdd);
        }
        if (vfToReplace.length > 0) {
            cuts[idx++] = _replace(address(vaultFactoryFacet), vfToReplace);
        }
        if (vfToAdd.length > 0) {
            cuts[idx++] = _add(address(vaultFactoryFacet), vfToAdd);
        }
        // #1649 — route the sale classifier. The Add branch is the one that
        // matters on a pre-#1503 diamond: without it the refreshed
        // EarlyWithdrawalFacet above would be live and every sale would revert.
        if (rpToRemove.length > 0) {
            cuts[idx++] = _remove(rpToRemove);
        }
        if (rpToReplace.length > 0) {
            cuts[idx++] = _replace(address(riskPreviewFacet), rpToReplace);
        }
        if (rpToAdd.length > 0) {
            cuts[idx++] = _add(address(riskPreviewFacet), rpToAdd);
        }
        // #1503 item 28 — the writers. The Remove runs BEFORE the Add so a
        // pre-item-28 Diamond never holds both resident-payout arities at once.
        if (encToRemove.length > 0) {
            cuts[idx++] = _remove(encToRemove);
        }
        if (encToReplace.length > 0) {
            cuts[idx++] = _replace(address(encumbranceMutateFacet), encToReplace);
        }
        if (encToAdd.length > 0) {
            cuts[idx++] = _add(address(encumbranceMutateFacet), encToAdd);
        }
        if (rpsToReplace.length > 0) {
            cuts[idx++] = _replace(address(repayPeriodicFacet), rpsToReplace);
        }
        if (rpsToAdd.length > 0) {
            cuts[idx++] = _add(address(repayPeriodicFacet), rpsToAdd);
        }
        // #1566 slice 2 - the fallback-custody host rides the SAME diamondCut as
        // the Risk / Defaulted / Claim refresh above, so no block ever sees the
        // new callers without their host.
        if (fcToReplace.length > 0) {
            cuts[idx++] = _replace(address(fallbackCustodyFacet), fcToReplace);
        }
        if (fcToAdd.length > 0) {
            cuts[idx++] = _add(address(fallbackCustodyFacet), fcToAdd);
        }
        // #2472 - and the swap-attempt host, in the same cut for the same reason.
        if (saToReplace.length > 0) {
            cuts[idx++] = _replace(address(swapAttemptFacet), saToReplace);
        }
        if (saToAdd.length > 0) {
            cuts[idx++] = _add(address(swapAttemptFacet), saToAdd);
        }
        // #2440 - and the treasury fee host, in the same cut for the same reason.
        if (tfToReplace.length > 0) {
            cuts[idx++] = _replace(address(treasuryFeeFacet), tfToReplace);
        }
        if (tfToAdd.length > 0) {
            cuts[idx++] = _add(address(treasuryFeeFacet), tfToAdd);
        }
        // #2419 - and the valuation host, in the same cut for the same reason.
        if (nvToReplace.length > 0) {
            cuts[idx++] = _replace(address(numeraireValueFacet), nvToReplace);
        }
        if (nvToAdd.length > 0) {
            cuts[idx++] = _add(address(numeraireValueFacet), nvToAdd);
        }
        // #2769 - and the paid-notification fee host, in the same cut as the
        // LoanFacet and ProfileFacet it moved off.
        if (nfToReplace.length > 0) {
            cuts[idx++] = _replace(address(notificationFeeFacet), nfToReplace);
        }
        if (nfToAdd.length > 0) {
            cuts[idx++] = _add(address(notificationFeeFacet), nfToAdd);
        }
        // #2795 - and the forced-sale host, in the same cut as RepayPeriodicFacet.
        if (fsToReplace.length > 0) {
            cuts[idx++] = _replace(address(forcedSaleFacet), fsToReplace);
        }
        if (fsToAdd.length > 0) {
            cuts[idx++] = _add(address(forcedSaleFacet), fsToAdd);
        }

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();
        StorageLayoutRecord.record(diamond);

        console.log("DiamondCut applied: 9 facets replaced + partitioned Claim/HF/Cons.");
        console.log("  HF selectors added:   ", hfToAdd.length);
        console.log("  HF selectors replaced:", hfToReplace.length);
        console.log("  EarlyWithdrawal selectors added: ", ewToAdd.length);
        console.log("  EarlyWithdrawal selectors repl.: ", ewToReplace.length);
        console.log("  Cons selectors added: ", consToAdd.length);
        console.log("  Cons selectors repl.: ", consToReplace.length);
        console.log("  Accumulator selectors added: ", accToAdd.length);
        console.log("  Accumulator selectors repl.: ", accToReplace.length);
        console.log("  Claim selectors added:", claimToAdd.length);
        console.log("  Claim selectors repl.:", claimToReplace.length);
        console.log("  Legacy uint8 keeper selectors removed:", profToRemove.length);
        console.log("  RiskPreview selectors added: ", rpToAdd.length);
        console.log("  RiskPreview selectors repl.: ", rpToReplace.length);
        console.log("  Retired previewIntent removed:", rpToRemove.length);
        console.log("  Retired 4-arg updateRiskParams removed:", riskToRemove.length);
        console.log("  RepayPeriodic selectors repl.:", rpsToReplace.length);
        console.log("  EncumbranceMutate repl.:      ", encToReplace.length);
        console.log("  EncumbranceMutate added:      ", encToAdd.length);
        console.log("  Retired resident-payout removed:", encToRemove.length);
        console.log("  FallbackCustody selectors added: ", fcToAdd.length);
        console.log("  FallbackCustody selectors repl.: ", fcToReplace.length);
        console.log("  SwapAttempt selectors added:     ", saToAdd.length);
        console.log("  SwapAttempt selectors repl.:     ", saToReplace.length);
        console.log("  TreasuryFee selectors added:     ", tfToAdd.length);
        console.log("  TreasuryFee selectors repl.:     ", tfToReplace.length);
        console.log("  NumeraireValue selectors added:  ", nvToAdd.length);
        console.log("  NumeraireValue selectors repl.:  ", nvToReplace.length);
        console.log("  NotificationFee selectors added: ", nfToAdd.length);
        console.log("  NotificationFee selectors repl.: ", nfToReplace.length);
        console.log("  ForcedSale selectors added:      ", fsToAdd.length);
        console.log("  ForcedSale selectors repl.:      ", fsToReplace.length);
        console.log("  Sell-amount entry cuts (#2796):  ", sellCuts.length);
        console.log("  Sale-exit verdict cuts (#1841):  ", verdictCuts.length);
    }

    /// @dev #1566 S2b - the fallback-custody boundary. From S2b the fallback
    ///      collateral stays in the borrower's vault under the loan's lien
    ///      and every consumer moves it out of that vault; before S2b it
    ///      rested in the Diamond's own balance and every consumer paid it out
    ///      of that balance. This curated family refreshes the host, both
    ///      producers and two of the consumers (FallbackCustody; Risk and
    ///      Defaulted; Claim and RiskMatchLiquidation) but not
    ///      AddCollateralFacet or RepayFacet. Run across the boundary it
    ///      would leave those two on the old rule: a cure by top-up or by
    ///      full repayment would pay the fallback amount out of the Diamond's
    ///      shared balance - other owners' funds - while the new entry had
    ///      already left it in the borrower's vault, and would lien it a
    ///      second time. Crossing the boundary is a fresh deploy (owner
    ///      decision O1 = A, 2026-10-07), never this refresh.
    ///
    ///      The marker is the routing of the three-argument
    ///      `disposeFallbackCustody(uint256,address,uint8)`, which S2b
    ///      introduced. The routing of `getFallbackCustody` cannot serve: the
    ///      S2a host split already routes that view (with the Diamond-held
    ///      meaning), so it would admit a Diamond on the old custody rule.
    ///      The selector is read from the compiled facet, so if the entry is
    ///      ever re-signed this check refuses every older Diamond until the
    ///      marker is reconsidered: loud, never a silent pass. Called before
    ///      the broadcast starts, so a refused run sends nothing.
    function _requireVaultHeldFallbackCustody(address diamond) internal view {
        if (
            IDiamondLoupe(diamond).facetAddress(
                FallbackCustodyFacet.disposeFallbackCustody.selector
            ) == address(0)
        ) revert PredatesVaultHeldFallbackCustody(diamond);
    }

    /// @dev #1566 slice 3 - refuse a Diamond from before the fill lock. The lock is enforced in
    ///      `VaipakamDiamond`'s own fallback, which no facet cut replaces, so slice 3 reaches a chain
    ///      by fresh deploy only (owner decision O1 = A); and a commit recorded under the old custody
    ///      would be refused by name at every way out once the new intent code ran. The marker is the
    ///      routing of `getIntentCustody`, which slice 3 introduced. Called before the broadcast
    ///      starts, so a refused run sends nothing.
    function _requireSlice3Diamond(address diamond) internal view {
        if (
            IDiamondLoupe(diamond).facetAddress(SwapToRepayIntentFacet.getIntentCustody.selector)
                == address(0)
        ) revert PredatesSlice3FillLock(diamond);
    }

    /// @dev #666 - refuse a Diamond whose OracleFacet does not route
    ///      `getAssetPriceStatus(address)`. `LibFallback.tryOracleRate` now
    ///      reads that view to tell a missing price from a distrusted one, and
    ///      it is inlined into three facets this script reinstalls:
    ///      FallbackCustodyFacet (the fallback entry), RiskFacet (the
    ///      discounted liquidation) and ClaimFacet (the backstop par check).
    ///      This script does not carry OracleFacet, so against an older one
    ///      every fallback entry, discounted liquidation and backstop absorb
    ///      would revert `FunctionDoesNotExist`. Refresh the oracle first with
    ///      `UpgradeOracleFacet.s.sol`, which adds the selector. The selector
    ///      is read from the compiled facet, so a re-signed view refuses every
    ///      older Diamond until this marker is reconsidered. Called before the
    ///      broadcast starts, so a refused run sends nothing.
    function _requireOraclePriceStatus(address diamond) internal view {
        if (
            IDiamondLoupe(diamond).facetAddress(OracleFacet.getAssetPriceStatus.selector)
                == address(0)
        ) revert PredatesOraclePriceStatus(diamond);
    }

    /// @dev #902 - refuse a Diamond from before the per-rental renter rows. One
    ///      rental's renter is written by origination (OfferAcceptFacet, once
    ///      `initiateLoan` returns the loan id), each expiry refresh
    ///      (RepayPeriodicFacet, RepayFacet's partial), the obligation handover
    ///      (PrecloseFacet) and every close (RepayFacet, RepayPeriodic,
    ///      Preclose, Defaulted), all through `vaultSetRentalUser`, which writes
    ///      a row the vault IMPLEMENTATION keys by loan. This curated set
    ///      refreshes VaultFactoryFacet, which no longer routes the retired
    ///      setters, but carries neither OfferAcceptFacet, RepayFacet nor the
    ///      vault implementation, so run across the boundary every rental accept
    ///      and repayment would revert on a route that is gone, and an ERC-1155
    ///      rental would revert in a vault that has no per-rental row.
    ///      Crossing the boundary is a fresh deploy, or the all-facets refresh
    ///      with the vault-implementation upgrade, never this refresh. The
    ///      marker is the routing of `vaultSetRentalUser`, which #902
    ///      introduced. Called before the broadcast starts, so a refused run
    ///      sends nothing.
    function _requirePerRentalRenterRows(address diamond) internal view {
        if (
            IDiamondLoupe(diamond).facetAddress(VaultFactoryFacet.vaultSetRentalUser.selector)
                == address(0)
        ) revert PredatesPerRentalRenterRows(diamond);
    }

    /// @dev #2419 - refuse a Diamond from before the 1e18 numeraire value
    ///      rule. The rule is one behaviour spread over facets this curated
    ///      set does not carry: OracleFacet (the liquidity probe that
    ///      classifies a token with unreadable decimals Illiquid, which the
    ///      strict KYC valuation relies on, and the pair loan-to-value
    ///      preview), AdminFacet (the dust-floor setter and getter, now on the
    ///      1e18 scale) and the offer facets (the create-time bounds). Run
    ///      across the boundary it would leave the new valuation beside an old
    ///      classifier and an old dust-floor setter, so the sizing getter and
    ///      the risk code would disagree and a default could revert on a token
    ///      the old probe still calls liquid. Crossing the boundary is a fresh
    ///      deploy or `RefreshAllFacetsInPlace`, which carries every facet,
    ///      never this refresh. The marker is the routing of
    ///      `getLiquidNumeraireValue`, which #2419 introduced. Called before
    ///      the broadcast starts, so a refused run sends nothing.
    /// @dev #1209 / #1808 - refuse a Diamond from before the interest ledger.
    ///      The ledger is one behaviour across every facet that changes a
    ///      loan's principal or rate or pays the lender side interest, the two
    ///      sale facets, ClaimFacet and the new SellerClaimFacet host; this
    ///      curated set carries only some of them, and none of them opens the
    ///      ledgers of loans the older Diamond originated. Crossing the
    ///      boundary is a fresh deploy, or the all-facets refresh with no
    ///      ERC-20 loan open, never this refresh. The marker is the routing of
    ///      `SellerClaimFacet.getInterestLedger`. Called before the broadcast
    ///      starts, so a refused run sends nothing.
    function _requireInterestLedger(address diamond) internal view {
        if (IDiamondLoupe(diamond).facetAddress(SellerClaimFacet.getInterestLedger.selector) == address(0)) {
            revert PredatesInterestLedger(diamond);
        }
    }

    function _requireNumeraireValueRule(address diamond) internal view {
        if (
            IDiamondLoupe(diamond).facetAddress(NumeraireValueFacet.getLiquidNumeraireValue.selector)
                == address(0)
        ) revert PredatesNumeraireValueRule(diamond);
    }

    /// @dev #668 / #935 (owner decision D2) - refuse a Diamond from before
    ///      the loan clock. Every facet that reads a loan deadline moved onto
    ///      {LibLoanClock} in one change, and this curated set carries only
    ///      some of them: run across the boundary it would leave the default,
    ///      repay and late-fee paths reading different due dates, so a loan
    ///      could be defaultable on one facet while still repayable without a
    ///      late fee on another. Crossing the boundary is a fresh deploy or
    ///      `RefreshAllFacetsInPlace`, never this refresh. The marker is the
    ///      routing of `LoanFacet.getLoanDeadlines`, which D2 introduced.
    ///      Called before the broadcast starts, so a refused run sends nothing.
    function _requireLoanClock(address diamond) internal view {
        if (IDiamondLoupe(diamond).facetAddress(LoanFacet.getLoanDeadlines.selector) == address(0)) {
            revert PredatesLoanClock(diamond);
        }
    }

    /// @dev #2957 - refuse a Diamond from before the position NFT metadata
    ///      split. The split moved `tokenURI`, `contractURI` and their image /
    ///      `external_url` configuration off VaipakamNFTFacet, which this script
    ///      cuts, onto VaipakamNFTMetadataFacet, which it does not. On an older
    ///      Diamond those selectors stay routed to the old VaipakamNFTFacet,
    ///      which this cut no longer names, so they would keep running the old
    ///      code beside a refreshed facet: a split Diamond. Crossing it is a
    ///      fresh deploy or `RefreshAllFacetsInPlace`. The marker is whether
    ///      `tokenURI` is routed to a facet other than the one hosting
    ///      `mintNFT`. Called before the broadcast starts.
    function _requireNftMetadataSplit(address diamond) internal view {
        address metadataHost = IDiamondLoupe(diamond).facetAddress(VaipakamNFTMetadataFacet.tokenURI.selector);
        if (
            metadataHost == address(0)
                || metadataHost == IDiamondLoupe(diamond).facetAddress(VaipakamNFTFacet.mintNFT.selector)
        ) revert PredatesNftMetadataSplit(diamond);
    }

    /// @dev #1820 - refuse a Diamond from before the tier record seam. The
    ///      seam moved the VPFI tier refresh out of every facet that moves
    ///      VPFI and into the two writers of the tier balance, and the push
    ///      into the reentrancy guard's release, which every guarded facet
    ///      inlines. This curated set carries only some of those facets: run
    ///      across the boundary, a facet left on old code would still call the
    ///      retired rollup and restamp selectors and revert, while a refreshed
    ///      one would queue pushes nothing flushes. Crossing the boundary is a
    ///      fresh deploy or `RefreshAllFacetsInPlace`, never this refresh. The
    ///      marker is the routing of `VPFIDiscountAccumulatorFacet.syncTierRecord`,
    ///      which the seam introduced. Called before the broadcast starts.
    function _requireTierRecordSeam(address diamond) internal view {
        if (
            IDiamondLoupe(diamond).facetAddress(VPFIDiscountAccumulatorFacet.syncTierRecord.selector)
                == address(0)
        ) revert PredatesTierRecordSeam(diamond);
    }

    /// @dev #3009 / #3025 - refuse a Diamond whose OfferPreviewFacet predates
    ///      the cadence admission host. LoanFacet re-admits the cadence of
    ///      every loan it opens, and OfferMatchFacet previews the same answer,
    ///      through a self-call to `requireOriginationCadenceAdmitted`, a
    ///      selector only OfferPreviewFacet carries. This curated set refreshes
    ///      LoanFacet and OfferMatchFacet but not OfferPreviewFacet, so run on
    ///      an older Diamond it would leave every loan creation reverting
    ///      `FunctionDoesNotExist`. Crossing the boundary is a fresh deploy,
    ///      `RefreshAllFacetsInPlace` or `ReplaceStaleFacets` (both carry the
    ///      host), never this refresh. The marker is the routing of
    ///      `requireOriginationCadenceAdmitted`, the later of the two
    ///      selectors. Called before the broadcast starts.
    function _requireCadenceAdmissionHost(address diamond) internal view {
        if (
            IDiamondLoupe(diamond).facetAddress(OfferPreviewFacet.requireOriginationCadenceAdmitted.selector)
                == address(0)
        ) revert PredatesCadenceAdmissionHost(diamond);
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

    /// @dev #1221 — Remove cut for selectors that must be UN-routed (facet must
    ///      be `address(0)` per the diamond library's `removeFunctions`). Used
    ///      to retire the legacy uint8 keeper selectors after the uint16 widen.
    function _remove(bytes4[] memory selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: selectors
        });
    }

    /// @dev #1221 — the OLD (pre-widen) keeper selectors whose signatures carried
    ///      a `uint8` action arg. Widening to uint16 changed their 4-byte
    ///      selectors, so these must be Removed from a diamond that still routes
    ///      them (see the cut assembly). `getKeeperActions(address,address)` is
    ///      unchanged — its signature carries no action arg — and is not listed.
    function _legacyProfileRemovedSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](2);
        s[0] = bytes4(keccak256("approveKeeper(address,uint8)"));
        s[1] = bytes4(keccak256("setKeeperActions(address,uint8)"));
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
        // The 6 selectors a pre-#394 (post-#395) diamond already routes — safe
        // to Replace. The two #394 HF-floor selectors and the #2696 three-arg
        // `updateRiskParams` may be NEW and go through `_riskAddSelectors()`
        // (partitioned Add/Replace) instead — see the cut wiring above.
        // #2796 - `triggerLiquidation` gained the sell amount, so its selector
        // is new on an older Diamond and moved to `_riskAddSelectors()`.
        s = new bytes4[](5);
        s[0] = RiskFacet.calculateLTV.selector;
        s[1] = RiskFacet.calculateHealthFactor.selector;
        s[2] = RiskFacet.isCollateralValueCollapsed.selector;
        s[3] = RiskFacet.triggerPartialLiquidation.selector;
        s[4] = RiskFacet.triggerLiquidationDiscounted.selector;
    }

    /// @dev The RiskFacet selectors that may be unrouted on the target, so they
    ///      are partitioned by live routing (Add the unrouted, Replace the
    ///      routed): the #394 (Codex #647 round-5) runtime HF-floor knob, and
    ///      the #2696 three-argument `updateRiskParams`, whose four-argument
    ///      predecessor is Removed separately, and the #2796 sell-amount
    ///      `triggerLiquidation`, whose predecessor is Removed by
    ///      {_forcedSaleEntryCuts}.
    function _riskAddSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = RiskFacet.setMinHealthFactor.selector;
        s[1] = RiskFacet.getMinHealthFactor.selector;
        s[2] = RiskFacet.updateRiskParams.selector;
        s[3] = RiskFacet.triggerLiquidation.selector;
    }

    /// @dev #658 — RiskSplitLiquidationFacet's single selector, mirrors
    ///      `DeployDiamond._getRiskSplitLiquidationSelectors`.
    function _riskSplitSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = RiskSplitLiquidationFacet.triggerLiquidationSplit.selector;
    }

    /// @dev The DefaultedFacet selectors this script cuts through its routing
    ///      partition: `isLoanDefaultable`, routed on every Diamond it accepts,
    ///      and #2083's `defaultKycAdmission`, which may be new. #2796's
    ///      sell-amount `triggerDefault` is cut by {_forcedSaleEntryCuts}
    ///      instead.
    function _defaultedSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = DefaultedFacet.isLoanDefaultable.selector;
        s[1] = DefaultedFacet.defaultKycAdmission.selector;
    }

    /// @dev #2796 - the cuts the sell-amount entry points need beyond the
    ///      partitioned facet lists: a Remove of every retired pre-#2796 shape
    ///      still routed on `diamond` (the old `triggerLiquidation`,
    ///      `triggerDefault`, `settlePeriodicInterest` and `settlePeriodicSale`),
    ///      then `triggerDefault` as an Add where it is new or a Replace where
    ///      it is routed. The new `triggerLiquidation`, `settlePeriodicInterest`
    ///      and `sellToNeed` ride the RiskFacet, RepayPeriodicFacet and
    ///      ForcedSaleFacet partitions. Kept out of `runWith` so its locals do
    ///      not join that frame.
    function _forcedSaleEntryCuts(address diamond, address defaultedFacet)
        internal
        view
        returns (IDiamondCut.FacetCut[] memory out)
    {
        (, bytes4[] memory retiredRouted) =
            _partitionByRouting(diamond, FacetSelectors.retiredForcedSaleSelectors());
        bytes4[] memory entry = new bytes4[](1);
        entry[0] = DefaultedFacet.triggerDefault.selector;
        (bytes4[] memory toAdd, bytes4[] memory toReplace) =
            _partitionByRouting(diamond, entry);
        out = new IDiamondCut.FacetCut[](
            (retiredRouted.length > 0 ? 1 : 0) + (toAdd.length > 0 ? 1 : 0)
                + (toReplace.length > 0 ? 1 : 0)
        );
        uint256 i;
        if (retiredRouted.length > 0) out[i++] = _remove(retiredRouted);
        if (toReplace.length > 0) out[i++] = _replace(defaultedFacet, toReplace);
        if (toAdd.length > 0) out[i++] = _add(defaultedFacet, toAdd);
    }

    /// @dev #1841 - the sale-exit verdict host. `EarlyWithdrawalFacet` and
    ///      `EarlyWithdrawalDirectFacet` both run their opening checks through a
    ///      self-call to `requireSaleExitOpen`, so refreshing either entry
    ///      without the host would revert `FunctionDoesNotExist` on every sale.
    ///      Deploys the host and partitions its selectors by live routing (Add
    ///      on a pre-#1841 Diamond, Replace on a current one). Kept out of
    ///      `runWith` so its locals do not join that frame.
    function _saleExitVerdictCuts(address diamond)
        internal
        returns (IDiamondCut.FacetCut[] memory out)
    {
        address host = ArtifactDeploy.deploy(type(SaleExitVerdictFacet).name);
        console.log("SaleExitVerdictFacet: ", host);
        (bytes4[] memory toAdd, bytes4[] memory toReplace) =
            _partitionByRouting(diamond, FacetSelectors.saleExitVerdict());
        out = new IDiamondCut.FacetCut[](
            (toAdd.length > 0 ? 1 : 0) + (toReplace.length > 0 ? 1 : 0)
        );
        uint256 i;
        if (toReplace.length > 0) out[i++] = _replace(host, toReplace);
        if (toAdd.length > 0) out[i++] = _add(host, toAdd);
    }

    function _loanSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = LoanFacet.initiateLoan.selector;
        s[1] = LoanFacet.getLoanDetails.selector;
        s[2] = LoanFacet.getLoanConsents.selector;
        // #668 / #935 - routed on every Diamond this script accepts
        // ({_requireLoanClock}), so it is carried in the Replace.
        s[3] = LoanFacet.getLoanDeadlines.selector;
    }

    function _precloseSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = PrecloseFacet.precloseDirect.selector;
        s[1] = PrecloseFacet.offsetWithNewOffer.selector;
        s[2] = PrecloseFacet.completeOffset.selector;
        s[3] = PrecloseFacet.transferObligationViaOffer.selector;
    }

    function _earlyWithdrawalSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = EarlyWithdrawalFacet.createLoanSaleOffer.selector;
        s[1] = EarlyWithdrawalFacet.completeLoanSale.selector;
        // #1123 (Codex #1126 r4 P1) — `completeLoanSaleInternal` (the
        // address(this)-gated auto-complete entry OfferAcceptFacet drives) MUST be
        // carried here too. #1123 wires the fail-closed sale-move gate inside
        // `_completeLoanSaleImpl`, which the accepted-sale completion path reaches
        // ONLY via this selector — so omitting it would leave flagged sellers
        // un-blocked / flagged buyers un-registered on auto-completions even after
        // the manual-recovery entry is upgraded.
        //
        // The old omission (Codex #959 r7) was correct WHEN #951 was still a
        // pending fresh-deploy change: the selector wasn't yet routed, so a
        // `_replace` here would have failed the diamond library's `removeFunction`
        // AND left `acceptOffer` on stale bytecode. But #951 is now MERGED — on any
        // current diamond `completeLoanSaleInternal` is already routed to this
        // facet (`DeployDiamond._getEarlyWithdrawalSelectors` s[3]) and
        // `acceptOffer` already calls it, so a plain Replace simply repoints it to
        // the #1123-gated bytecode with no staleness. A Replace cut must carry the
        // facet's WHOLE routed surface (#778/#779) — which, since the #1780
        // split moved `sellLoanViaBuyOffer` to its own facet, is these 3.
        s[2] = EarlyWithdrawalFacet.completeLoanSaleInternal.selector;
        // #1810 — the quote-bound listing entry. NEW, so this list is now cut
        // via the Add/Replace-by-routing partition rather than a fixed Replace
        // (a Replace reverts on an unrouted selector on any pre-#1810 target).
        s[3] = EarlyWithdrawalFacet.createLoanSaleOfferBound.selector;
    }

    /// @dev #1780 — the direct lender-exit route's whole routed surface.
    ///      Mirrors `DeployDiamond._getEarlyWithdrawalDirectSelectors`. #1922
    ///      (#1503 item 6) added `sellLoanViaBuyOfferBound` — both must be cut
    ///      or a curated refresh strands one on stale bytecode (the split
    ///      Diamond `CLAUDE.md` documents).
    function _earlyWithdrawalDirectSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = EarlyWithdrawalDirectFacet.sellLoanViaBuyOffer.selector;
        s[1] = EarlyWithdrawalDirectFacet.sellLoanViaBuyOfferBound.selector;
    }

    /// @dev #658 PR-B2 — RefinanceFacet selectors, mirrors
    ///      `DeployDiamond._getRefinanceSelectors` (kept in lockstep).
    function _refinanceSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](8);
        s[0] = RefinanceFacet.refinanceLoan.selector;
        s[1] = RefinanceFacet.refinanceLoanFromAccept.selector;
        // #2349 — the matcher-fill route's entry. NEW, so this list is cut via
        // the Add/Replace-by-routing partition (a Replace reverts on an
        // unrouted selector on any pre-#2349 target).
        s[2] = RefinanceFacet.refinanceLoanFromMatch.selector;
        // #2407 — NEW, so cut through the same Add/Replace-by-routing
        // partition as the #2349 entry above.
        s[3] = RefinanceFacet.getRefinanceRequest.selector;
        s[4] = RefinanceFacet.checkRefinanceRequest.selector;
        // #1558 — the payoff permit a refinance request carries, and its view.
        s[5] = RefinanceFacet.setRefinancePayoffPermit.selector;
        s[6] = RefinanceFacet.clearRefinancePayoffPermit.selector;
        s[7] = RefinanceFacet.getRefinancePayoff.selector;
    }

    /// @dev #658 PR-B2 — ClaimFacet selectors, mirrors
    ///      `DeployDiamond._getClaimSelectors` (kept in lockstep).
    /// @dev #691 — RiskMatchLiquidationFacet selectors, mirrors
    ///      `DeployDiamond._getRiskMatchLiquidationSelectors` (kept in lockstep).
    ///      `attemptInternalMatchAutoDispatch` is cross-facet-only
    ///      (`onlyDiamondInternal`) but is routed through the Diamond, so it is
    ///      cut + refreshed like any other selector.
    function _riskMatchSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = RiskMatchLiquidationFacet.triggerInternalMatchLiquidation.selector;
        s[1] = RiskMatchLiquidationFacet.attemptInternalMatchAutoDispatch.selector;
    }

    function _claimSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](11);
        s[0] = ClaimFacet.claimAsLender.selector;
        s[1] = ClaimFacet.claimAsBorrower.selector;
        s[2] = ClaimFacet.getClaimableAmount.selector;
        s[3] = ClaimFacet.getClaimable.selector;
        s[4] = ClaimFacet.claimAsLenderWithRetry.selector;
        s[5] = ClaimFacet.getFallbackSnapshot.selector;
        s[6] = ClaimFacet.setLenderBackstopOptIn.selector;
        s[7] = ClaimFacet.claimAsLenderViaBackstop.selector;
        s[8] = ClaimFacet.getBorrowerSurplusClaim.selector;
        s[9] = ClaimFacet.getOwedAtDefault.selector; // #2374
        s[10] = ClaimFacet.getOwedAtInternalMatch.selector; // #2427
    }

    /// @dev #779 — the prior hand-list carried only 15 of ProfileFacet's 25
    ///      selectors, leaving the Phase-6 keeper + sanctions surface
    ///      (`setSanctionsOracle`, `isSanctionedAddress`, `setKeeperActions`,
    ///      `setLoanKeeperEnabled`, …) on stale bytecode after a Replace cut.
    ///      Sourced from the shared {FacetSelectors} single source
    ///      (parity-tested against the compiled ABI).
    function _profileSelectors() internal pure returns (bytes4[] memory) {
        return FacetSelectors.profile();
    }

    /// @dev #658 — full ConsolidationFacet selector set, mirrors
    ///      `DeployDiamond._getConsolidationFacetSelectors` (kept in lockstep).
    ///      Indices 0-1 are the #594 standalone holder entries; 2-3 are the
    ///      #658 internal-only eager entries the refreshed liquidation /
    ///      close-out hosts cross-call. `_partitionByRouting` sorts them by
    ///      live routing. The #658 / #1817 restamp entries were retired with
    ///      the tier record seam (#1820), which this script refuses to cross.
    function _consolidationSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = ConsolidationFacet.consolidateCollateralToHolder.selector;
        s[1] = ConsolidationFacet.consolidatePrincipalToHolder.selector;
        s[2] = ConsolidationFacet.eagerConsolidateToHolder.selector;
        s[3] = ConsolidationFacet.eagerConsolidateBothSides.selector;
    }

    /// @dev #1817 r9 — full VPFIDiscountAccumulatorFacet selector set, mirrors
    ///      `DeployDiamond._getVPFIDiscountAccumulatorSelectors` (kept in
    ///      lockstep). The whole surface is carried per the #778/#779 rule —
    ///      a Replace that misses an already-routed selector leaves it on the
    ///      old implementation (split Diamond).
    function _accumulatorSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = VPFIDiscountAccumulatorFacet.syncTierRecord.selector;
        s[1] = VPFIDiscountAccumulatorFacet.effectiveTierAndBps.selector;
        s[2] = VPFIDiscountAccumulatorFacet.getTierExpirySec.selector;
    }
}
