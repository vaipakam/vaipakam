// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

// Inheriting DeployDiamond gives us its canonical `_get<Facet>Selectors()`
// methods (CI-guarded by SelectorCoverageTest), so the routing here cannot
// drift. Facet types are imported explicitly (paths mirror DeployDiamond).
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {Deployments} from "./lib/Deployments.sol";
import {StorageLayoutRecord} from "./lib/StorageLayoutRecord.sol";
import {DeployDiamond} from "./DeployDiamond.s.sol";
import {DiamondLoupeFacet} from "../src/facets/DiamondLoupeFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {FeeEntitlementFacet} from "../src/facets/FeeEntitlementFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {PerkFacet} from "../src/facets/PerkFacet.sol";
import {RewardBroadcastFacet} from "../src/facets/RewardBroadcastFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
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
import {OfferAcceptFeeFacet} from "../src/facets/OfferAcceptFeeFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {NFTPrepayListingFacet} from "../src/facets/NFTPrepayListingFacet.sol";
import {NFTPrepayDutchListingFacet} from "../src/facets/NFTPrepayDutchListingFacet.sol";
import {NFTPrepayListingAtomicFacet} from "../src/facets/NFTPrepayListingAtomicFacet.sol";
import {NFTPrepayAutoListFacet} from "../src/facets/NFTPrepayAutoListFacet.sol";
import {OfferParallelSaleFacet} from "../src/facets/OfferParallelSaleFacet.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayPartialFacet} from "../src/facets/SwapToRepayPartialFacet.sol";
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
import {RiskDiscountedLiquidationFacet} from "../src/facets/RiskDiscountedLiquidationFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {ReceiverFacet} from "../src/facets/ReceiverFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {MulticallFacet} from "../src/facets/MulticallFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardRemitDestinationFacet} from "../src/facets/RewardRemitDestinationFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardReconciliationFacet} from "../src/facets/RewardReconciliationFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardEpochViewFacet} from "../src/facets/RewardEpochViewFacet.sol";
import {RewardStagingFacet} from "../src/facets/RewardStagingFacet.sol";
import {RewardClaimWalkFacet} from "../src/facets/RewardClaimWalkFacet.sol";
import {RewardStagingSettleFacet} from "../src/facets/RewardStagingSettleFacet.sol";
import {RewardStagingDomainFacet} from "../src/facets/RewardStagingDomainFacet.sol";
import {RewardClosureFacet} from "../src/facets/RewardClosureFacet.sol";
import {RewardEraFacet} from "../src/facets/RewardEraFacet.sol";
import {ServiceCapacityFacet} from "../src/facets/ServiceCapacityFacet.sol";
import {OfferMatchIntentFacet} from "../src/facets/OfferMatchIntentFacet.sol";
import {FallbackCustodyFacet} from "../src/facets/FallbackCustodyFacet.sol";
import {SwapAttemptFacet} from "../src/facets/SwapAttemptFacet.sol";
import {TreasuryFeeFacet} from "../src/facets/TreasuryFeeFacet.sol";
import {NumeraireValueFacet} from "../src/facets/NumeraireValueFacet.sol";
import {NotificationFeeFacet} from "../src/facets/NotificationFeeFacet.sol";
import {SaleExitVerdictFacet} from "../src/facets/SaleExitVerdictFacet.sol";
import {SellerClaimFacet} from "../src/facets/SellerClaimFacet.sol";
import {RefinancePayoffFacet} from "../src/facets/RefinancePayoffFacet.sol";
import {ForcedSaleFacet} from "../src/facets/ForcedSaleFacet.sol";
import {RateModelFacet} from "../src/facets/RateModelFacet.sol";
import {VaipakamNFTMetadataFacet} from "../src/facets/VaipakamNFTMetadataFacet.sol";
import {RewardSweepWalkFacet} from "../src/facets/RewardSweepWalkFacet.sol";
import {RewardForfeitWalkFacet} from "../src/facets/RewardForfeitWalkFacet.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {VaipakamRewardMessenger, REWARD_MESSENGER_WIRE_GENERATION} from "../src/crosschain/VaipakamRewardMessenger.sol";
import {VpfiReturnSender, VPFI_RETURN_SENDER_WIRE_GENERATION} from "../src/crosschain/VpfiReturnSender.sol";
import {VpfiReturnReceiver, VPFI_RETURN_RECEIVER_WIRE_GENERATION} from "../src/crosschain/VpfiReturnReceiver.sol";
import {RewardCompensationDispatchFacet} from "../src/facets/RewardCompensationDispatchFacet.sol";
import {RewardCommitmentFacet} from "../src/facets/RewardCommitmentFacet.sol";
import {RepatriationFacet} from "../src/facets/RepatriationFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
// #1222 M3 B2-d5 — the mirror-side remit receiver is a standalone UUPS
// proxy, not a Diamond facet; the B2-d5 block below upgrades it in step
// with the widened ingress so an un-upgraded receiver cannot silently
// decode the new payload as the legacy shape.
import {
    RewardRemittanceReceiver,
    REMIT_RECEIVER_WIRE_GENERATION
} from "../src/crosschain/RewardRemittanceReceiver.sol";
// #1566 closure 2 cutover PR 1 — the recipient port gained
// `transportMessageId`, one interface version across the adapter and every
// recipient; the adapter and the buyback receiver are upgraded here in the
// same run as the reward recipients above, by the same generation probe.
import {CcipMessenger, CCIP_MESSENGER_WIRE_GENERATION} from "../src/crosschain/CcipMessenger.sol";
import {
    BuybackRemittanceReceiver,
    BUYBACK_RECEIVER_WIRE_GENERATION
} from "../src/crosschain/BuybackRemittanceReceiver.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ArtifactDeploy} from "./lib/ArtifactDeploy.sol";

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
 * @dev SCOPE: a complete refresh leaves the Diamond routing EXACTLY the deploy's
 *         selector set. Current selectors are Replaced or Added; every other
 *         routed selector — a signature retired from the code, still pointed at
 *         the bytecode it was last cut with — is Removed by {_sweepStaleRoutes},
 *         derived from the loupe rather than from a list (#2313). Until #2313
 *         this note read "never Removed", with retirements handled one
 *         hand-listed block at a time; Base Sepolia carried eleven unlisted ones
 *         through the 2026-10-03 refresh. The sweep is only as safe as `items[]`
 *         is complete: a facet missing from it would have its live selectors
 *         classified stale. `refresh()`'s count require and
 *         `RefreshScriptFacetParityTest` (selector-set equality with the
 *         deployed Diamond) are what hold that.
 *
 *         Env: ADMIN_PRIVATE_KEY (must be the Diamond's current ERC-173 owner
 *         — the admin account after the deployer->admin handover). The script
 *         reverts up front if it isn't.
 *
 *         Usage (from contracts/, on main) — run once per chain. Use `--slow`:
 *         the admin owner is EIP-7702-delegated on at least Base Sepolia, and a
 *         delegated account may have only one in-flight tx (no gapped nonces).
 *           forge script script/RefreshAllFacetsInPlace.s.sol --sig "refresh()" --ffi \
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

    // Must equal DeployDiamond's `cuts` array length. A mismatch means a facet
    // was added to DeployDiamond but not mirrored into `_deployItems()` here.
    //
    // `public` so an EXTERNAL guardrail can assert it —
    // `test/deploy/RefreshScriptFacetParityTest` compares this against
    // `DiamondFacetNames.cutFacetNames().length`. That cross-check has to live
    // outside this file, because the `require` in `refresh()` below compares
    // `items.length` against THIS constant: omit a facet from both (the natural
    // way to omit one, since you touch neither line) and the require passes
    // while the refresh silently leaves that facet on stale bytecode. #1791's
    // Codex F1 was exactly that, and this script's own guard could not see it.
    //
    // The parity test deliberately lives in `test/`, not here: a production
    // refresh script must not import test code to check itself.
    // 73 -> 74: EarlyWithdrawalDirectFacet (#1780) + RewardHorizonSweepFacet
    // (#1434) landed on either side of one merge.
    // 74 -> 75: OfferAcceptFeeFacet (#1835) — the borrower-LIF charge split
    // off OfferAcceptFacet, which was 164 bytes under EIP-170.
    // 87 -> 88: SwapToRepayPartialFacet (#2416) — the partial swap-to-repay
    // route split off SwapToRepayFacet, which was 73 bytes under EIP-170.
    // 92 -> 93: the merge of main brings SwapToRepayPartialFacet (#2416) to the
    // #1566 build stack's 92 (87 + the stack's five).
    // 93 -> 94: FallbackCustodyFacet (#1566 slice 2) - the fallback entry, retry
    // swap and disposal hosted once, self-called by Risk / Defaulted / Claim.
    // 94 -> 95: SwapAttemptFacet (#2472) - each failover swap attempt runs in
    // its frame, self-called by every facet that sells through LibSwap.
    // 95 -> 96: TreasuryFeeFacet (#2440) - every fee drawn from a payer's
    // wallet or a user's vault into the treasury, self-called by the
    // fee-charging facets.
    // 96 -> 97: NumeraireValueFacet (#2419) - the one 1e18 valuation rule,
    // self-called by RiskFacet, every facet that inlines LibRiskMath and
    // every KYC comparison.
    // 97 -> 98: NotificationFeeFacet (#2769) - the paid-notification charge and
    // the wallet's consent to it, moved off LoanFacet and ProfileFacet. Both
    // already-routed moves are cut as Replaces pointing here.
    // 98 -> 99: ForcedSaleFacet (#2795) - the one forced-sale rule (sized to
    // the debt, lender first), self-called by RepayPeriodicFacet.
    // 99 -> 100: RateModelFacet (#2748) - the reference-rate model, its band
    // and the offer-rate clamp, moved off AdminFacet and OfferCreateFacet.
    // The already-routed moves are cut as Replaces pointing here.
    // 100 -> 101: VaipakamNFTMetadataFacet (#2957) - the position NFT's
    // tokenURI, contractURI and their image / external_url configuration,
    // moved off VaipakamNFTFacet. The already-routed moves are cut as
    // Replaces pointing here.
    // 101 -> 102: RewardRemitDestinationFacet (#2963) - what Base does when a
    // remit destination leaves its expected-source list; both selectors are
    // new, so they are cut as Adds.
    // 102 -> 103: SaleExitVerdictFacet (#1841) - the one classifier of a
    // lender sale exit, self-called by both sale facets; its selectors are
    // new, so they are cut as Adds.
    // 103 -> 104: SellerClaimFacet (#1209 / #1808) - the seller-claim host:
    // the seller-first interest payout, the terminal split, claimAsSeller
    // and the interest ledger view; its selectors are new, so they are cut
    // as Adds.
    // 104 -> 105: RefinancePayoffFacet (#1558) - the borrower's payoff permit
    // on a refinance request, its removal and the view that sizes it; its
    // selectors are new, so they are cut as Adds.
    // 105 -> 106: RiskDiscountedLiquidationFacet - the discounted liquidation
    // route, moved whole off RiskFacet for EIP-170 headroom. Its one selector
    // is already routed (to RiskFacet), so it is cut as a Replace pointing
    // here. Until that batch lands the selector stays on the previous
    // RiskFacet build, which still carries the route unchanged.
    uint256 public constant EXPECTED_FACETS = 106;

    /// @notice #1566 slice 3 - the target Diamond predates the fill lock; see
    ///         {_requireSlice3Diamond}.
    error PredatesSlice3FillLock(address diamond);

    /// @dev #1566 slices 2-3 (owner decision O1 = A, 2026-10-07): a chain crosses the custody
    ///      boundary by FRESH deploy only, and this refresh cannot do it at all -- the fill lock is
    ///      enforced in `VaipakamDiamond`'s own fallback, which no facet cut replaces, so a refreshed
    ///      pre-slice-3 Diamond would run the slice-3 pre-hook (which pulls the lot) with no entry-point
    ///      lock around the LOP's mid-fill calls, and every commit recorded under the old custody would
    ///      be refused by name at every way out, freezing its loan. The marker is the routing of
    ///      `getIntentCustody`, which slice 3 (S3b) introduced. Called before any facet is deployed, so
    ///      a refused run sends nothing.
    function _requireSlice3Diamond(address diamond) internal view {
        if (IDiamondLoupe(diamond).facetAddress(SwapToRepayIntentFacet.getIntentCustody.selector) == address(0)) {
            revert PredatesSlice3FillLock(diamond);
        }
    }

    /// @notice #902 - the target Diamond predates the per-rental renter rows and
    ///         has an ERC-1155 rental open; see {_requireNoOpenErc1155RentalAcross902}.
    error OpenErc1155RentalAcrossPerRentalRows(address diamond, uint256 loanId);

    /// @notice #902 - the target Diamond predates the per-rental renter rows and
    ///         is not under the manual pause, so a scan for open ERC-1155
    ///         rentals would not stay true until the cuts land.
    error PerRentalRowsCrossingNeedsManualPause(address diamond);

    /// @dev #902 - a pre-#902 vault records an ERC-1155 rental under its renter,
    ///      not its loan (`rentalId` 0). Once this refresh routes the per-rental
    ///      writes, such a row is never found by its loan: the rental's next
    ///      expiry refresh adds a second row, and its handover's revoke leaves the
    ///      old renter reported until the old row expires. A chain with no open
    ///      ERC-1155 rental has no such row to carry, so crossing the boundary
    ///      in place is refused only while one is open: close those rentals, or
    ///      cross by fresh deploy. A Diamond that already routes
    ///      `vaultSetRentalUser` is past the boundary and is not walked. Called
    ///      before any facet is deployed, so a refused run sends nothing.
    ///
    ///      The walk reads EVERY loan id up to the id high-water mark
    ///      (`getGlobalCounts`), not the metrics active list: the lifecycle
    ///      library documents active loans absent from that list (loans that
    ///      predate the counter layer or its backfill), and a rental among them
    ///      would carry a renter-keyed row across unseen. Each loan record is
    ///      read directly, so the answer rests on the loans themselves rather
    ///      than on an index of them. A loan whose rental is still open is one
    ///      not yet closed: `Active`, or `FallbackPending`, which has not reached
    ///      a terminal path either.
    ///
    ///      The walk is a read taken before the run's own pause, so on its own
    ///      it would not hold: an accept landing between the walk and that
    ///      pause opens the very rental it looked for. A crossing therefore
    ///      runs only under the operator's MANUAL pause, already in force when
    ///      the walk is taken (an auto-pause window lapses by itself, so it
    ///      does not count). Every accept entry point is `whenNotPaused`, so no
    ///      rental can open between the walk and the cuts, and both refreshes
    ///      leave a Diamond they found paused paused. What the walk cannot
    ///      exclude is an Unpauser lifting that pause mid-run, which is an
    ///      operator action rather than a race any borrower can win.
    function _requireNoOpenErc1155RentalAcross902(address diamond) internal view {
        if (IDiamondLoupe(diamond).facetAddress(VaultFactoryFacet.vaultSetRentalUser.selector) != address(0)) {
            return;
        }
        (bool manual,,,) = LibPausable.decodePausableSlot(vm.load(diamond, LibPausable.PAUSABLE_STORAGE_POSITION));
        if (!manual) revert PerRentalRowsCrossingNeedsManualPause(diamond);
        (uint256 highestLoanId,) = MetricsFacet(diamond).getGlobalCounts();
        for (uint256 loanId = 1; loanId <= highestLoanId; ++loanId) {
            if (_isOpenErc1155Rental(diamond, loanId)) {
                revert OpenErc1155RentalAcrossPerRentalRows(diamond, loanId);
            }
        }
    }

    /// @notice #1209 / #1808 - the target Diamond predates the interest ledger
    ///         and has an ERC-20 loan open; see {_requireNoOpenLoanAcrossInterestLedger}.
    error OpenLoanAcrossInterestLedger(address diamond, uint256 loanId);

    /// @notice #1209 / #1808 - the target Diamond predates the interest ledger
    ///         and is not under the manual pause.
    error InterestLedgerCrossingNeedsManualPause(address diamond);

    /// @dev #1209 / #1808 - the interest ledger is opened when a loan is
    ///      originated, and a ledger never opened opens at the loan's start
    ///      time, on the assumption that principal and rate have not moved
    ///      and no interest has been paid since. That holds for every loan a
    ///      ledger-era Diamond originated and for none an older one did: a
    ///      pre-ledger loan that was partly repaid, settled a period or
    ///      changed rate would open with an earned figure it never earned, and
    ///      a sale would turn that figure into a seller claim paid from the
    ///      buyer's interest. So crossing the boundary in place is refused
    ///      while any ERC-20 loan is open (`Active` or `FallbackPending`):
    ///      close those loans, or cross by fresh deploy. A Diamond that
    ///      already routes `getInterestLedger` is past the boundary and is not
    ///      walked. The walk and the manual-pause requirement follow
    ///      {_requireNoOpenErc1155RentalAcross902}, for the same reasons.
    function _requireNoOpenLoanAcrossInterestLedger(address diamond) internal view {
        if (IDiamondLoupe(diamond).facetAddress(SellerClaimFacet.getInterestLedger.selector) != address(0)) {
            return;
        }
        (bool manual,,,) = LibPausable.decodePausableSlot(vm.load(diamond, LibPausable.PAUSABLE_STORAGE_POSITION));
        if (!manual) revert InterestLedgerCrossingNeedsManualPause(diamond);
        (uint256 highestLoanId,) = MetricsFacet(diamond).getGlobalCounts();
        for (uint256 loanId = 1; loanId <= highestLoanId; ++loanId) {
            if (_isOpenErc20Loan(diamond, loanId)) {
                revert OpenLoanAcrossInterestLedger(diamond, loanId);
            }
        }
    }

    /// @dev Kept in its own frame, like {_isOpenErc1155Rental}.
    function _isOpenErc20Loan(address diamond, uint256 loanId) private view returns (bool) {
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        return loan.assetType == LibVaipakam.AssetType.ERC20
            && (loan.status == LibVaipakam.LoanStatus.Active || loan.status == LibVaipakam.LoanStatus.FallbackPending);
    }

    /// @notice #934 (Codex #2642 r8) - the target Diamond's role root is not
    ///         where D1 requires it; see {_requireD1RootTopology}.
    error RootAdminNotOnOwner(address diamond, address owner);
    /// @notice #934 (Codex #2642 r8) - a governance Safe holds the role root
    ///         directly, the pre-D1 bypass; see {_requireD1RootTopology}.
    error RootAdminOnGovernanceSafe(address diamond, address safe);

    /// @dev #934 (D1): this refresh installs facets whose guards keep the role
    ///      root on the owner from now on (`CannotRemoveOwnerRootAdmin`,
    ///      `NewOwnerNotRootAdmin`), but it migrates no role state. So it must
    ///      only run on a Diamond that already has the D1 root topology: the
    ///      owner holds `DEFAULT_ADMIN_ROLE`, and neither governance Safe the
    ///      deploy env names (`EMERGENCY_REVOKER_ADDRESS`, `TIMELOCK_PROPOSER`)
    ///      holds it directly. A Diamond that ran the retired pre-D1 handover
    ///      fails one of these, because that handover moved ownership to the
    ///      Timelock and the root to the Safe. Bringing such a chain to D1 is a
    ///      fresh deploy, never an in-place refresh. Role members are not
    ///      enumerable on-chain, so a root holder the env does not name is
    ///      outside this check; the post-handover readback is what covers it.
    ///      Called before any facet is deployed, so a refused run sends nothing.
    function _requireD1RootTopology(address diamond, address owner_) internal view {
        AccessControlFacet ac = AccessControlFacet(diamond);
        bytes32 root = ac.DEFAULT_ADMIN_ROLE();
        if (!ac.hasRole(root, owner_)) revert RootAdminNotOnOwner(diamond, owner_);
        address[2] memory safes =
            [vm.envOr("EMERGENCY_REVOKER_ADDRESS", address(0)), vm.envOr("TIMELOCK_PROPOSER", address(0))];
        for (uint256 i; i < safes.length; ++i) {
            if (safes[i] != address(0) && safes[i] != owner_ && ac.hasRole(root, safes[i])) {
                revert RootAdminOnGovernanceSafe(diamond, safes[i]);
            }
        }
    }

    /// @dev Kept in its own frame: the full loan record is decoded here only.
    ///      A never-written id reads as a zeroed record (ERC-20), so it passes.
    function _isOpenErc1155Rental(address diamond, uint256 loanId) private view returns (bool) {
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        return loan.assetType == LibVaipakam.AssetType.ERC1155
            && (loan.status == LibVaipakam.LoanStatus.Active || loan.status == LibVaipakam.LoanStatus.FallbackPending);
    }

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
        _requireSlice3Diamond(diamond);
        _requireNoOpenErc1155RentalAcross902(diamond);
        _requireNoOpenLoanAcrossInterestLedger(diamond);
        _requireD1RootTopology(diamond, currentOwner);
        // #2092 item 1 — the code this run cuts must keep every storage-layout
        // fact recorded for this chain. Before the first transaction, so a
        // refused run sends nothing; needs `--ffi`.
        StorageLayoutRecord.requireAppendOnly("RefreshAllFacetsInPlace", diamond);

        console.log("=== Full-facet in-place refresh ===");
        console.log("Chain id:", cid);
        console.log("Diamond: ", diamond);
        console.log("Owner:   ", currentOwner);

        // #1566 slice 4 PR A (Codex #2158 r16 P2, r19 P1) — resolved BEFORE
        // the first transaction, like the deploy scripts: a dry run (no
        // `--broadcast`) writes nothing, so the orchestrator can simulate this
        // refresh on every selected chain before broadcasting on any of them,
        // and a live broadcast that asked to skip the artifact is refused
        // here rather than after the cuts. The writes the upgrade probes make
        // mid-run are covered too: every artifact write goes through ONE
        // dry-run gate inside `Deployments` itself, so this flag only shapes
        // the messages below.
        bool writesArtifact = Deployments.artifactWritesEnabled();

        vm.startBroadcast(ownerKey);

        // The pause is the FIRST transaction of the run (Codex #2158 r25 P1),
        // before the implementation deploys, not after them: under `--slow`
        // those deploys are minutes of separate transactions, during which an
        // ordinary payout or absorption through the OLD facets would run
        // beside facets already deployed for the new set. Pausing first closes
        // that window inside the run.
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
        // The run holds the MANUAL pause (Codex #2158 r18 P2): an auto-pause
        // window reads as paused here but lapses on its own, resuming service
        // by no one's decision mid-refresh. `paused() && pausedUntil() == 0`
        // proves the manual flag; any other paused state gets the flag set as
        // well (idempotent) and is then LEFT paused for a fresh Unpauser
        // decision — this script restores service only where it found the
        // Diamond live.
        // ALWAYS sent, as the first transaction (Codex #2158 r29 P1): a run
        // that had to start under the manual pause used to skip it, so an
        // Unpauser acting after forge's pre-send simulation would have let
        // the cuts execute live. `pause()` is idempotent on the flag and
        // counts one transition. It protects the cuts by transaction ORDER
        // only — an unpause between two of the sequential transactions can
        // still expose a mixed facet set for the rest of the run.
        // The transition count BEFORE this run's own pause: the run restores
        // service at the end only if the count then reads exactly one more —
        // its own pause and nothing else (Codex #2158 post-cap P2). A watcher
        // auto-pause or a Pauser's incident pause raised while the deploys
        // and cuts broadcast moves the count further, and an unpause here
        // would clear an incident it knows nothing about.
        (,,, uint64 epochBeforeOurPause) =
            LibPausable.decodePausableSlot(vm.load(diamond, LibPausable.PAUSABLE_STORAGE_POSITION));
        AdminFacet(diamond).pause();

        Item[] memory items = _deployItems();
        require(items.length == EXPECTED_FACETS, "RefreshAllFacetsInPlace: facet count drift vs DeployDiamond");

        // #1566 transport epochs PR 3a/3b — the ATOMIC CUT GROUP goes out
        // FIRST, and goes out WHOLE, in one diamondCut transaction.
        //
        // Cuts are built in items[] order and sent in SELECTOR_BUDGET-sized
        // transactions, so an item near the end of the array lands several
        // transactions after the first. That is ordinarily harmless, because
        // facets are ordinarily independent: each selector's old and new
        // bytecode agree about storage, so which side of a batch boundary it
        // falls on does not matter.
        //
        // It is NOT harmless for a set of facets that share one accounting
        // rule. Between the batch that replaces one of them and the batch that
        // replaces the next, the Diamond routes a MIXED VERSION of that rule —
        // and the value-bearing receive entries deliberately skip
        // `whenNotPaused` so in-flight deliveries can still land while the
        // Diamond is paused for migration, which means the pause this script
        // takes as its first transaction does not hold arrivals back and the
        // window is reachable.
        //
        // THE INVARIANT, stated once here rather than rediscovered per facet:
        // the transport-epoch lifecycle's participants must switch version
        // TOGETHER. No cut transaction may leave one of them new while another
        // is old. Three review rounds each found a different instance of that
        // one defect (Codex #2232 r1/r2/r3) and each was answered by hoisting
        // one more name to the front, which is a patch per path:
        //
        //   - the OLD ingress records a packet with no day-list commitment for
        //     the epochs to materialize against — permanently, since the
        //     commitment is written once, with the record;
        //   - the NEW ingress opens a transport batch while the OLD
        //     `classifyLegacyPacket` is still routed, and that implementation
        //     reduces the packet's `unclassified` figure without checking or
        //     debiting the batch — two claims on one amount, which is exactly
        //     what §5c's one-accounting-path rule forbids;
        //   - and the epoch facet's own lifecycle entries must not be
        //     reachable against an ingress that has not yet been replaced.
        //
        // Cutting the group as ONE transaction removes the window rather than
        // narrowing it: before that transaction every participant is old and
        // consistent, after it every participant is new and consistent, and
        // there is no state in between for an arrival or an operator to land
        // in. `_hoistGroupFirst` puts the group at the head of `items[]` and
        // `_groupCutEnd` forces the batch boundary immediately after it.
        //
        // Pausing the standalone receiver instead was considered and
        // rejected: `unpause()` there is owner-only while `pause()` is
        // guardian-or-owner, so a run whose broadcaster is not the owner
        // could halt the lane and be unable to restart it — trading a
        // bounded, self-closing window for an unbounded one.
        uint256 groupLen = _hoistGroupFirst(items, _atomicCutGroup());

        // Split each facet's canonical selector list against the live loupe:
        // routed -> Replace, unrouted -> Add.
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](items.length * 2);
        uint256 nCuts;
        // Where the group's cut entries end, and how many selectors they carry.
        // Both are counted here rather than re-derived below: `_split` decides
        // how many entries an item produces (one, two, or none), so the only
        // reliable boundary is the one recorded while building.
        uint256 groupCutEnd;
        uint256 groupSelectors;
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
            if (i + 1 == groupLen) {
                groupCutEnd = nCuts;
                groupSelectors = _selectorsIn(cuts, 0, nCuts);
            }
        }

        // The group is one transaction or the run does not start. If it ever
        // outgrows the budget the honest outcome is a loud refusal here, in
        // simulation, rather than a silent split in production that reopens
        // the window the group exists to close — which is the failure mode
        // this whole construct is a fix for, and it must not come back as a
        // capacity accident.
        require(
            groupSelectors <= SELECTOR_BUDGET,
            "RefreshAllFacetsInPlace: atomic cut group exceeds SELECTOR_BUDGET"
        );

        // ─── the RECEIVER is upgraded BEFORE the first cut ────────────────
        //
        // Codex #2232 r3 — ordering, and it is the whole of the fix. The
        // widened ingress is installed by the FIRST cut batch (it is hoisted
        // above), while the receiver upgrade used to sit after every batch,
        // after the retired-selector removal, and after the M1 migration. Between those
        // transactions an old-wire delivery finds a generation-4 receiver
        // still calling the routed 9-argument selector — which SUCCEEDS
        // against the previous ingress bytecode and opens no transport epoch.
        // A packet with no batch is deliberately ungated, so that delivery
        // bypasses the classification gate permanently, silently, and with no
        // later step able to notice.
        //
        // Upgrading first inverts the window into the fail-closed one this
        // script already relies on everywhere else: the new receiver calls the
        // 10-argument selector, which is not routed until the first cut lands,
        // so an early delivery REVERTS, CCIP records a failed message, and it
        // re-executes against the finished Diamond. A bounded retry costs
        // nothing; a silent bypass cannot be undone.
        //
        // It runs here rather than at the top of the script so the window in
        // which arrivals revert is as short as the run allows — after the 78
        // implementation deploys, which under `--slow` are minutes of separate
        // transactions, and immediately before the cuts.
        //
        // The retired ingress selectors are Removed immediately BELOW, before
        // the first cut (Codex #2232 r4), and swept again after the cuts as
        // the interrupted-run pass - NOT last. An earlier revision of this
        // comment kept the "remove last, it is the completion marker"
        // rationale after the code had moved the removal forward; a future
        // edit reading it could have restored the unsafe order. The marker
        // argument no longer applies, and {_removeRetiredIngress} says why.
        // This probe is generation-gated and therefore idempotent on a rerun.
        _upgradeRemitReceiverAhead(diamond, signer);

        // ─── the RETIRED ingress selectors go BEFORE the first cut too ────
        //
        // Codex #2232 r4, and it is the half of the window the upgrade above
        // cannot reach. That upgrade closes the window for a receiver this
        // script can FIND; the retired selector is what an un-upgraded one
        // still calls, and until it is unrouted that call SUCCEEDS against the
        // previous ingress bytecode and opens no transport epoch. Pre-cut, on
        // an older mirror that does not route the receiver lens and whose
        // artifact is missing or stale, there is no receiver to find — so the
        // window stayed open in exactly the case the resolution fallback
        // exists for.
        //
        // Removing here makes it fail-closed WITHOUT having to resolve
        // anything: from this transaction on, a delivery through any
        // un-upgraded receiver reverts, CCIP records a failed message, and it
        // re-executes against the finished Diamond. That is the posture the
        // rest of this run already relies on, and it holds for a receiver
        // this script never saw.
        //
        // The same call runs again after the cuts as the interrupted-run
        // sweep; see {_removeRetiredIngress} and the block there for why the
        // completion-marker argument for removing LAST no longer applies.
        _removeRetiredIngress(diamond, loupe);

        // Dispatch the cut in selector-budgeted batches so no single diamondCut
        // tx exceeds the RPC/block gas cap.
        //
        // The atomic group is sent first and ALONE. Letting it merely lead the
        // ordinary batching would not do: the budget loop packs following
        // items into the same transaction until the budget is reached, which
        // is harmless, but it would also SPLIT the group across two
        // transactions the moment the group grew past the budget — the exact
        // mixed-version window this is here to remove, reappearing silently
        // as the group grows. A forced boundary makes the group's atomicity a
        // property of the dispatch rather than of its current size.
        uint256 batchStart = groupCutEnd;
        uint256 batchSelectors;
        if (groupCutEnd > 0) {
            _sendBatch(diamond, cuts, 0, groupCutEnd);
            console.log("  ^ atomic cut group: entries", groupCutEnd, "selectors", groupSelectors);
        }
        for (uint256 i = groupCutEnd; i < nCuts; ++i) {
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

        // Retired selectors are NOT removed here. {_sweepStaleRoutes} removes
        // every route this deploy no longer installs, after the migrations
        // below that read a retired selector as their completion marker
        // (#2313).

        // Recycling M1 (#1346) — one-time notification-tariff migration.
        // M1 changed the notification fee from a numeraire-denominated value
        // to a flat native-VPFI quantity, and dropped `setNumeraire`'s 8th
        // (notification-fee) argument — an 8→7-arg SELECTOR change. On the
        // FIRST in-place refresh carrying M1 the old 8-arg selector is still
        // routed to stale bytecode that writes `c.notificationFee`, so a
        // queued numeraire rotation could clobber the flat tariff, and any
        // pre-existing numeraire-denominated `notificationFee` override would
        // now be reinterpreted as VPFI wei. Both are cleared here: Remove the
        // retired selector and reset the slot to 0 (→ the new 0.5-VPFI
        // default). Gated on the old selector still being routed so this runs
        // EXACTLY ONCE — a later refresh (selector already gone) skips it and
        // never wipes a deliberately-set VPFI tariff. This block removes its
        // own selector rather than leaving it to {_sweepStaleRoutes}, because
        // the selector's storage SEMANTICS changed, not just its
        // implementation: the routed selector is the migration's completion
        // marker, and the reset must land before it goes.
        bytes4 oldSetNumeraire = bytes4(
            keccak256(
                "setNumeraire(address,address,bytes32,bytes32,uint256,uint256,uint256,uint256)"
            )
        );
        if (loupe.facetAddress(oldSetNumeraire) != address(0)) {
            // Order matters (Codex r2): reset the slot FIRST, Remove the
            // selector LAST. The still-routed old selector is the DURABLE
            // completion marker for the whole migration — the gate above
            // stays true until the Remove mines, so if the reset lands but
            // the Remove is dropped/reverted, a rerun re-enters this block
            // and re-does both (the reset is idempotent — 0 → the same
            // 0.5-VPFI default). Removing first would clear the marker while
            // the reset could still fail, permanently skipping it and
            // leaving a stale numeraire value reinterpreted as VPFI wei.
            ConfigFacet(diamond).setNotificationFee(0);
            bytes4[] memory rm = new bytes4[](1);
            rm[0] = oldSetNumeraire;
            IDiamondCut.FacetCut[] memory rmCut = new IDiamondCut.FacetCut[](1);
            rmCut[0] = IDiamondCut.FacetCut({
                facetAddress: address(0),
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: rm
            });
            IDiamondCut(diamond).diamondCut(rmCut, address(0), "");
            console.log(
                "M1 (#1346): reset notification tariff to VPFI default + removed stale 8-arg setNumeraire selector"
            );
        }

        // ─── the receiver requirement, decided ONCE, after the cuts ───────
        //
        // Codex #2232 r3 (F1 + F4). The UPGRADE happened before the cuts; this
        // is where it is PROVEN, and it is deliberately ungated: a deployment
        // already past the B2-d5 migration routes no retired selector, so a
        // requirement living inside that block would never run there — which
        // is exactly why a second receiver probe grew further down the script
        // in the first place. There is now one of each. The probe ahead of the
        // cuts is the only upgrade; this is the only requirement.
        //
        // TWO ADDRESSES, TWO JOBS, AND THEY DO NOT SUBSTITUTE FOR EACH OTHER.
        // Both are PROBED for the upgrade when they differ, so a rotation
        // leaves neither behind (the probe is generation-gated, so after the
        // pre-cut pass these calls are no-ops). But only the LIVE address —
        // the Diamond's registered receiver, the sender the refreshed ingress
        // accepts — is REQUIRED, because it is the only one whose presence
        // says anything about whether remittances will land. The artifact is
        // never a fallback for it; see the requirement below.
        {
            address liveRecv =
                RewardRemittanceLensFacet(diamond).getRewardRemittanceReceiver();
            address artifactRecv = _readAddrOptional(".rewardRemittanceReceiver");
            // THE ROLE, NOT "NOT CANONICAL" (Codex #2232 r12). A receiver is
            // required by the chains that RECEIVE deliveries, and that is
            // exactly `Mirror` — not the complement of `Canonical`, which also
            // sweeps in the two roles that receive nothing:
            //
            //   * `Unconfigured` — a supported single-chain deploy with no
            //     delivery, no residual and no counterparty, which therefore
            //     registers no receiver and never will. Keying on
            //     `!isCanonical` made its refresh IMPOSSIBLE.
            //   * `Detached` — was in a role and no longer has one; it fails
            //     closed on backing it cannot re-earn, so no further delivery
            //     arrives for a receiver to accept.
            //
            // Safe to read here although the role BACKFILL is still ahead of
            // us: a genuine mirror resolves `Mirror` from its configured base
            // chain, with or without the backfill. The backfill exists only to
            // separate `Detached` from `Unconfigured`, which are byte-identical
            // in state and neither of which requires a receiver either way — so
            // there is no ordering in which this read mistakes a mirror for a
            // role that skips the requirement.
            uint8 rewardRoleRecv = RewardReporterFacet(diamond).getRewardRole();
            bool mirrorNeedsReceiver = rewardRoleRecv == _roleFromLabel("mirror");

            // Same fatality rule as the pre-cut pass, and it is the rule this
            // block's own comment above has asserted since it was written
            // without the code ever enforcing it (Codex #2232 r3): the live
            // receiver is mandatory, the artifact is best-effort. Normally
            // both are no-ops here — the pre-cut pass is generation-gated and
            // has already done the work — so this runs for real only where the
            // live address could not be resolved before the cuts.
            if (liveRecv != address(0)) _probeUpgradeRemitReceiver(liveRecv, true, signer);
            if (artifactRecv != address(0) && artifactRecv != liveRecv) {
                _probeUpgradeRemitReceiver(artifactRecv, false, signer);
            }

            // THE REQUIREMENT READS THE LIVE ADDRESS AND NOTHING ELSE (Codex
            // #2232 r11). The artifact is evidence about which proxy to TRY to
            // upgrade; it is not evidence about which sender the refreshed
            // ingress will accept. That is `s.rewardRemittanceReceiver`, which
            // `RewardIngressFacet` compares `msg.sender` against directly and
            // which `getRewardRemittanceReceiver()` returns — so an artifact
            // address satisfying this requirement proves nothing about the
            // Diamond, and promoting it into `recv` broke the rule in BOTH
            // directions:
            //
            //   * a mirror with a zero live receiver and a populated artifact
            //     passed the requirement and the generation assertion, then
            //     unpaused with every remittance reverting at the ingress
            //     sender check — permanently, because the retired selectors
            //     that would make a rerun retry are Removed below;
            //   * a CANONICAL chain, which legitimately registers no receiver,
            //     was aborted by a stale artifact naming a proxy it does not
            //     need and this signer may no longer be able to upgrade.
            //
            // Both disappear by deleting the fallback: there is now exactly
            // one address that can satisfy this block, and it is the one the
            // ingress actually enforces. The artifact keeps its only honest
            // job — the best-effort upgrade probe above.
            //
            // A MIRROR must never pass this point without that live receiver:
            // the retired selectors are Removed below, and a mirror left
            // calling an unrouted ingress fails every delivery while the
            // marker that would make a rerun retry the upgrade is gone. Every
            // other role legitimately has none - nothing remits to it.
            require(
                liveRecv != address(0) || !mirrorNeedsReceiver,
                "remit receiver: mirror refresh needs a live .rewardRemittanceReceiver registered on the Diamond"
            );
            if (liveRecv != address(0)) {
                // Assert the GENERATION rather than assuming the probe worked.
                // This is the fact the Remove below is safe against, so it is
                // read back from the proxy instead of inferred from having
                // called an upgrade.
                (bool okGen, bytes memory genRet) =
                    liveRecv.staticcall(abi.encodeWithSignature("WIRE_GENERATION()"));
                require(
                    okGen && genRet.length == 32
                        && abi.decode(genRet, (uint256)) >= REMIT_RECEIVER_WIRE_GENERATION,
                    "remit receiver: still below REMIT_RECEIVER_WIRE_GENERATION after the upgrade pass"
                );
            }
        }

        // ─── remit ingress widened 6 → 7 (#1222 B2-d5) → 8 (#1434 P1-a) ────
        //
        // B2-d5 added `recycledShare` to `onRewardBudgetReceived`, so its
        // SELECTOR changed, and the remit payload grew a fifth head slot
        // (0x80 → 0xA0). #1434 P1-a then added `freshShare`, changing the
        // selector again — the WIRE is untouched this time (the receiver
        // derives the fresh component from the generation it already
        // decodes), so only the Diamond-side ingress moved. Both retired
        // selectors are handled by this one block: the receiver upgrade is
        // the same upgrade either way, and doing it once keeps a single
        // completion marker instead of two that can half-complete.
        //
        // Two facts about this script make the un-migrated state SILENTLY
        // WRONG rather than merely stale:
        //
        //   1. a signature change leaves the retired 6-arg selector routed to
        //      the OLD facet bytecode until something Removes it;
        //   2. it refreshes DIAMOND FACETS only — the mirror-side
        //      `RewardRemittanceReceiver` is a standalone UUPS proxy and was
        //      never upgraded here.
        //
        // An un-upgraded receiver reads the 0xA0 payload as the LEGACY 2-tuple
        // (its `== 0x80` test fails, and the array offset still decodes), drops
        // `remitId` / `remitter` / `recycledShare`, and calls the retired 6-arg
        // ingress — which still routes, to stale code. The delivery SUCCEEDS:
        // tokens land, no receipt is written, so no ack ever flows and Base's
        // reservation is stranded Pending; and no custody credit is applied, so
        // the exact accounting hole B2-d5 exists to close stays open. Silently.
        //
        // The 7-arg selector fails the same way for P1-a's hole. A receiver
        // that predates it decodes d5 fine but calls the 7-arg ingress, whose
        // stale code infers the fresh component as `amount − recycledShare` —
        // the inference P1-a exists to remove, because on a legacy/d2 wire it
        // books an unknown composition as entirely fresh. Again the delivery
        // succeeds and the counter is quietly wrong.
        //
        // Fixed in two layers, deliberately not one:
        //
        //   (a) STRUCTURAL, fail-closed — Remove the retired selector. An
        //       un-upgraded receiver then REVERTS instead of half-succeeding;
        //       CCIP records a failed message, re-executable once the receiver
        //       is upgraded, so nothing is lost. This is the same posture the
        //       pause lever relies on, and it holds even if an operator runs a
        //       partial deploy.
        //   (b) OPERATIONAL — upgrade the receiver proxy, so the happy path
        //       works immediately rather than needing a manual re-execution.
        //
        // ORDERING — the Remove runs BEFORE the first cut, and this call is
        // the sweep behind it (Codex #2232 r4).
        //
        // It used to run only here, last, on the M1 reasoning that a
        // still-routed retired selector is the DURABLE COMPLETION MARKER: if
        // the receiver upgrade landed but the Remove was dropped, a rerun
        // re-entered this block and redid both. That reasoning retired with
        // r3. The receiver upgrade no longer lives in this block — it runs
        // ahead of the cuts and is gated on the proxy's own
        // `WIRE_GENERATION`, so a rerun redoes it whenever the proxy is still
        // behind, whether or not the Remove ever mined. The marker was
        // protecting something that has moved.
        //
        // What removing LAST cost, meanwhile, was the whole cut window. Layer
        // (a) above is only fail-closed while the retired selector is
        // unrouted; until the Remove mines it stays pointed at the PREVIOUS
        // ingress bytecode, so an un-upgraded receiver's delivery in that
        // window SUCCEEDS and opens no transport epoch — the r3 hazard again,
        // in the one case r3's fix cannot reach: a Diamond on which no
        // receiver could be resolved pre-cut at all (an older mirror that does
        // not route the lens, with a missing or stale artifact). Resolving a
        // receiver more cleverly cannot close that; making the window
        // fail-closed regardless of what was resolved does.
        //
        // So {_removeRetiredIngress} runs ahead of the cut dispatch and again
        // here. It removes only what the loupe still routes, so the second
        // call is a no-op on a normal run and the sweep for an interrupted
        // one — and a rerun re-enters it exactly as before.
        _removeRetiredIngress(diamond, loupe);
        // ─── #1434 P2-w2 — the receiver wire-generation probe: RETIRED ────
        //
        // Codex #2232 r3 — this block did exactly what the pre-cut probe now
        // does (live address first, artifact as a distinct fallback,
        // generation-gated upgrade), only later in the run and as a second
        // copy of the resolution rule. Two copies is how the two diverged:
        // this one read the live receiver while the B2-d5 block above read
        // the artifact alone, and neither ran before the cut that installs
        // the widened ingress. There is now ONE upgrade, ahead of the cuts,
        // and ONE requirement, asserted after them.

        // ─── #1434 P2-w4 (#1656 r10) — reward MESSENGER generation probe ──
        //
        // The refreshed facets call the messenger's GENERATION-2 surface
        // (5-word consumption ACK, kind-11 quotes, 23-word V3); a proxy
        // still on generation 1 reverts every one of those sends — acks
        // never reach Base, compensation gates stay held, ordinary
        // reservations sit Pending. Same durable-constant posture as the
        // receiver probe above; idempotent on rerun. EVERY chain has a
        // messenger, so a missing artifact is always a hard stop.
        {
            // #1660 r9 - LIVE address first (the Diamond's registered
            // messenger is the one the refreshed facets will call); a
            // DISTINCT artifact address is upgraded as well - the same
            // live-config-over-artifact rule the return-channel probes
            // follow. Every chain registers a messenger, so both being
            // zero is a hard stop.
            (address liveMsgr, , , , ) =
                RewardReporterFacet(diamond).getRewardReporterConfig();
            address msgrArt = _readAddrOptional(".rewardMessenger");
            require(
                liveMsgr != address(0) || msgrArt != address(0),
                "P2-w4: refresh needs a reward messenger (live or artifact)"
            );
            _probeUpgradeRewardMessenger(liveMsgr);
            if (msgrArt != liveMsgr) _probeUpgradeRewardMessenger(msgrArt);
        }

        // ─── #1434 P2-w5 (#1660 r1) — return-channel satellite probes ──
        //
        // The refreshed facets speak GENERATION-2 surfaces on BOTH
        // return-channel satellites: the mirror facet calls the sender's
        // `sendStrandedReturn`, and Base's ingress expects the receiver
        // to decode the B1 kind (an old receiver rejects it as an
        // unknown wire kind — re-executable, but stuck until upgraded).
        // Same durable-constant posture as the probes above; idempotent.
        // The satellites are OPTIONAL deployments (the C2 transport is
        // operator-armed) — but the artifact file is NOT the authority on
        // whether one is armed (#1660 r2): the DIAMOND's live endpoint
        // config is. Read both; a LIVE-configured endpoint whose artifact
        // is missing or stale still gets probed and upgraded (a silent
        // skip there would ship generation-2 facets against a
        // generation-1 satellite), and a dark-but-deployed artifact is
        // upgraded too so a later arming meets current code. Only a chain
        // with NEITHER a live endpoint NOR an artifact skips — it has no
        // return path to brick.
        {
            address liveSender;
            address liveReceiver;
            (, liveSender, liveReceiver, ) =
                RepatriationFacet(diamond).getRepatriationPosition();
            // #1660 r3 - LIVE endpoint first (the Diamond is the
            // authority on which proxy is armed); the artifact covers a
            // dark-but-deployed satellite, and BOTH are upgraded when
            // they name distinct proxies (a stale artifact must never
            // shadow the active sender).
            address rsendArt = _readAddrOptional(".vpfiReturnSender");
            _probeUpgradeReturnSender(liveSender);
            if (rsendArt != liveSender) _probeUpgradeReturnSender(rsendArt);
            address rrecvArt = _readAddrOptional(".vpfiReturnReceiver");
            _probeUpgradeReturnReceiver(liveReceiver);
            if (rrecvArt != liveReceiver) {
                _probeUpgradeReturnReceiver(rrecvArt);
            }
        }
        {
            // #1566 closure 2 cutover PR 1 — the adapter and every recipient
            // are ONE interface version (`transportMessageId` on the
            // recipient port): the CCIP adapter and the buyback receiver are
            // upgraded here, in the same run as the reward recipients above,
            // so no adapter ever calls a recipient with the other shape.
            // Codex #2198 r1 — LIVE config first, the artifact second, the
            // same rule as every probe above (see the helper).
            _probeUpgradeTransportSatellites(diamond);
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

        // ─── #2313 — no stale route survives a complete refresh ───────────
        //
        // Every selector this deploy installs now routes to this run's
        // implementations (verified just above). Anything else the loupe
        // still routes is a retired signature pointed at older bytecode.
        // {_sweepStaleRoutes} removes all of it, derived from the loupe and
        // not from a list, before the custody cutover stamp records the
        // routing.
        _sweepStaleRoutes(diamond, loupe, items);

        // ─── #1566 closure 3 (Codex #2070 r6 P1) — reward ROLE backfill ──
        //
        // `rewardRoleConfigured` did not exist before this upgrade. A Diamond
        // that was configured and then DETACHED under the old setters carries
        // the field zero-initialized, and the four-state resolver reads that
        // as `Unconfigured` — `max` delivered bound, fail-OPEN — where it must
        // be `Detached`. State cannot tell the two apart (a demoted canonical
        // chain and a never-configured one are byte-identical; base-sepolia
        // is canonical with no messenger), so the record is backfilled from
        // the OPERATOR'S declaration, refusing to default it, while the
        // Diamond is still paused.
        //
        //   REWARD_ROLE_EXPECTED=canonical|mirror|unconfigured|detached
        //
        // Only the detached case is APPLIED here (`setBaseChainId(0)` stamps
        // the flag); a declared canonical/mirror role that the Diamond does
        // not record is refused rather than guessed — `ConfigureRewardReporter`
        // is the idempotent path that stamps those, with the real chain ids.
        {
            string memory expected = vm.envOr("REWARD_ROLE_EXPECTED", string(""));
            require(
                bytes(expected).length != 0,
                "role-backfill: set REWARD_ROLE_EXPECTED=canonical|mirror|unconfigured|detached "
                "(this Diamond's reward-mesh role per the recorded topology). Refusing to "
                "default an irreversible role record."
            );
            uint8 want = _roleFromLabel(expected);
            uint8 live = RewardReporterFacet(diamond).getRewardRole();
            if (live != want) {
                // The one transition this script may make: a pre-field detached
                // chain reads Unconfigured (2) and must be recorded Detached (3).
                require(
                    want == 3 && live == 2,
                    string.concat(
                        "role-backfill: live role does not match REWARD_ROLE_EXPECTED and is not the "
                        "detached backfill case - run ConfigureRewardReporter for canonical/mirror, or "
                        "correct the declaration. expected=", expected
                    )
                );
                RewardReporterFacet(diamond).setBaseChainId(0);
                live = RewardReporterFacet(diamond).getRewardRole();
                require(live == 3, "role-backfill: setBaseChainId(0) did not resolve to Detached");
                console.log("role-backfill: recorded Detached (was pre-field Unconfigured)");
            } else {
                console.log("role-backfill: live role matches declaration:", expected);
            }
        }

        // #1566 slice 4 PR B (Codex #2186 r4) — record the COMPLETE cut on
        // chain: the custody protocol version and the routed facet set as
        // they stand after every cut, removal and migration above, still
        // under this run's pause. `activateRewardCustody` and the bootstrap
        // writers refuse on any other set, so a chain refreshed by a curated
        // partial script — or cut again after this run — cannot switch
        // custody onto the holder until this complete refresh runs again.
        // The record is this run's completion attestation bound to the set
        // it installed; `RefreshScriptFacetParityTest` is what pins that set
        // to the deploy's.
        RewardCustodyFacet(diamond).stampRewardCustodyCutover();
        console.log("slice-4: complete-cut record stamped (custody protocol version + routed facet set)");

        if (!wasPaused) {
            // The check is ON CHAIN (Codex #2158 post-cap P1): a branch here
            // runs only while Forge builds the broadcast list, so the
            // unpause itself carries the count expected after this run's
            // own pause and REVERTS if anyone moved it in between — the
            // Diamond then stays paused for a fresh decision, and the run
            // ends with that revert named rather than an incident cleared.
            AdminFacet(diamond).unpauseIfPauseEpoch(epochBeforeOurPause + 1);
        }
        vm.stopBroadcast();

        if (!writesArtifact) {
            console.log("");
            console.log("dry run: addresses.json NOT written (no transaction was sent)");
            return;
        }
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
        // #2092 item 1 — the chain now runs this checkout's layout.
        StorageLayoutRecord.record(diamond);
        console.log("");
        console.log("addresses.json and storage-layout.json updated. Next:");
        console.log("  bash script/exportFrontendDeployments.sh");
        console.log("  forge build --skip test && bash script/exportFrontendAbis.sh");
    }

    /// @notice Deploy every cut facet fresh, paired with its canonical
    ///         `addresses.json` key and inherited selector list. The facet set,
    ///         order, types, and getters mirror `DeployDiamond`'s `cuts[0..62]`
    ///         exactly — keep this in lockstep when a facet is added there.
    /// @dev `internal` rather than `private` so `RefreshScriptFacetParityTest`
    ///      can drive it through a probe subclass and assert every slot is
    ///      POPULATED — not merely allocated. Codex #1795 P1: the array is sized
    ///      `new Item[](EXPECTED_FACETS)`, so a forgotten `items[N] = Item(...)`
    ///      leaves a zero-valued slot while every length check — the `require` in
    ///      `refresh()` and a count-only test alike — still passes, and the live
    ///      refresh then skips that facet. Only reading the contents catches it.
    function _deployItems() internal returns (Item[] memory items) {
        items = new Item[](EXPECTED_FACETS);
        items[0] = Item("diamondLoupeFacet", ArtifactDeploy.deploy(type(DiamondLoupeFacet).name), _getLoupeSelectors());
        items[1] = Item("ownershipFacet", ArtifactDeploy.deploy(type(OwnershipFacet).name), _getOwnershipSelectors());
        items[2] = Item("accessControlFacet", ArtifactDeploy.deploy(type(AccessControlFacet).name), _getAccessControlSelectors());
        items[3] = Item("adminFacet", ArtifactDeploy.deploy(type(AdminFacet).name), _getAdminSelectors());
        items[4] = Item("profileFacet", ArtifactDeploy.deploy(type(ProfileFacet).name), _getProfileSelectors());
        items[5] = Item("oracleFacet", ArtifactDeploy.deploy(type(OracleFacet).name), _getOracleSelectors());
        items[6] = Item("oracleAdminFacet", ArtifactDeploy.deploy(type(OracleAdminFacet).name), _getOracleAdminSelectors());
        items[7] = Item("vaipakamNFTFacet", ArtifactDeploy.deploy(type(VaipakamNFTFacet).name), _getNftSelectors());
        items[8] = Item("vaultFactoryFacet", ArtifactDeploy.deploy(type(VaultFactoryFacet).name), _getVaultFactorySelectors());
        items[9] = Item("offerCreateFacet", ArtifactDeploy.deploy(type(OfferCreateFacet).name), _getOfferCreateSelectors());
        items[10] = Item("loanFacet", ArtifactDeploy.deploy(type(LoanFacet).name), _getLoanSelectors());
        items[11] = Item("repayFacet", ArtifactDeploy.deploy(type(RepayFacet).name), _getRepaySelectors());
        items[12] = Item("defaultedFacet", ArtifactDeploy.deploy(type(DefaultedFacet).name), _getDefaultedSelectors());
        items[13] = Item("riskFacet", ArtifactDeploy.deploy(type(RiskFacet).name), _getRiskSelectors());
        items[14] = Item("claimFacet", ArtifactDeploy.deploy(type(ClaimFacet).name), _getClaimSelectors());
        items[15] = Item("addCollateralFacet", ArtifactDeploy.deploy(type(AddCollateralFacet).name), _getAddCollateralSelectors());
        items[16] = Item("treasuryFacet", ArtifactDeploy.deploy(type(TreasuryFacet).name), _getTreasurySelectors());
        items[17] = Item("earlyWithdrawalFacet", ArtifactDeploy.deploy(type(EarlyWithdrawalFacet).name), _getEarlyWithdrawalSelectors());
        // #1780 — the direct lender-exit route. Must be refreshed WITH the listed
        // route: they were one facet, so refreshing only the listed one leaves
        // `sellLoanViaBuyOffer` on pre-refresh bytecode while everything around
        // it moves, which is exactly the full-refresh invariant this script
        // exists to hold.
        items[72] = Item("earlyWithdrawalDirectFacet", ArtifactDeploy.deploy(type(EarlyWithdrawalDirectFacet).name), _getEarlyWithdrawalDirectSelectors());
        items[18] = Item(
            "partialWithdrawalFacet",
            ArtifactDeploy.deploy(type(PartialWithdrawalFacet).name),
            _getPartialWithdrawalSelectors()
        );
        items[19] = Item("precloseFacet", ArtifactDeploy.deploy(type(PrecloseFacet).name), _getPrecloseSelectors());
        items[20] = Item("refinanceFacet", ArtifactDeploy.deploy(type(RefinanceFacet).name), _getRefinanceSelectors());
        items[21] = Item("metricsFacet", ArtifactDeploy.deploy(type(MetricsFacet).name), _getMetricsSelectors());
        items[22] = Item("vpfiTokenFacet", ArtifactDeploy.deploy(type(VPFITokenFacet).name), _getVpfiTokenSelectors());
        items[23] = Item("vpfiDiscountFacet", ArtifactDeploy.deploy(type(VPFIDiscountFacet).name), _getVpfiDiscountSelectors());
        items[24] = Item("consolidationFacet", ArtifactDeploy.deploy(type(ConsolidationFacet).name), _getConsolidationFacetSelectors());
        items[25] = Item(
            "interactionRewardsFacet",
            ArtifactDeploy.deploy(type(InteractionRewardsFacet).name),
            _getInteractionRewardsSelectors()
        );
        // #1351 slice 2c — the CLAIM entry points moved off
        // InteractionRewardsFacet (EIP-170). This script routes only the
        // selectors it lists. Without this item an in-place refresh of a
        // pre-split diamond would have left `claimInteractionRewards*` routed
        // at the OLD implementation while every other reward facet moved
        // forward — users silently claiming through stale code that bypasses
        // the ShareOfPool walk entirely. Since #2313 the omission would be
        // worse and louder: {_sweepStaleRoutes} would classify those live
        // selectors as stale and remove them, which is why the parity test
        // pins `items[]` to the deployed Diamond's selector set.
        items[67] = Item(
            "rewardClaimFacet",
            ArtifactDeploy.deploy(type(RewardClaimFacet).name),
            _getRewardClaimFacetSelectors()
        );
        // #1434 — the claim-horizon sweep moved onto its OWN facet when expiry
        // was unified onto the ShareOfPool engine. Listed here for exactly the
        // reason the slice-2c note above records: this script only
        // Replace/Adds the selectors it lists, so omitting the destination
        // facet would leave `sweepExpiredInteractionRewards` routed at the old
        // implementation — the pre-unification expiry, with its hand-derived
        // D1 obligation — while every other reward facet moved forward.
        // Slot 73: #1780's earlyWithdrawalDirectFacet took 72 on main and
        // this facet landed on the same index on the branch; the merge keeps
        // both, hole-free (the #1795 parity test asserts every slot).
        items[73] = Item(
            "rewardHorizonSweepFacet",
            ArtifactDeploy.deploy(type(RewardHorizonSweepFacet).name),
            _getRewardHorizonSweepSelectors()
        );
        // Slot 75: #1204's spend-gated perk channel (74 is taken by the
        // preceding facet on this array; the parity test asserts every slot
        // is populated, so a hole here fails loudly rather than silently
        // refreshing 75 of 76).
        items[75] = Item(
            "perkFacet",
            ArtifactDeploy.deploy(type(PerkFacet).name),
            _getPerkSelectors()
        );
        // Slot 76: #1569's broadcast split.
        items[76] = Item(
            "rewardBroadcastFacet",
            ArtifactDeploy.deploy(type(RewardBroadcastFacet).name),
            _getRewardBroadcastSelectors()
        );
        // Slot 77: #1566 slice 4 PR A — the custody facet. The refresh cuts
        // the FACET only; it never deploys or binds a `RewardCustodyHolder`
        // (design §5d) — that is `DeployRewardCustodyHolder.s.sol`, run once
        // per live chain, or the paused replacement ceremony.
        items[77] = Item(
            "rewardCustodyFacet",
            ArtifactDeploy.deploy(type(RewardCustodyFacet).name),
            _getRewardCustodySelectors()
        );
        // Slot 78: #1566 closure 2 cutover PR 2 — the reconciliation facet.
        // A NEW facet changes the routing hash, so this refresh's complete
        // cut re-stamps the cutover record below; an activated chain must
        // take this full refresh, never a curated one.
        items[78] = Item(
            "rewardReconciliationFacet",
            ArtifactDeploy.deploy(type(RewardReconciliationFacet).name),
            _getRewardReconciliationSelectors()
        );
        // Slot 79: #1566 transport epochs PR 3a — the mirror-side ingress facet,
        // split out of the remittance facet. Its three selectors are ROUTED
        // already (to the old remittance bytecode), so the partition cuts them
        // as Replace toward this facet and the remittance item no longer lists
        // them: one refresh moves both halves.
        items[79] = Item("rewardIngressFacet", ArtifactDeploy.deploy(type(RewardIngressFacet).name), _getRewardIngressSelectors());
        items[80] = Item("rewardEpochFacet", ArtifactDeploy.deploy(type(RewardEpochFacet).name), _getRewardEpochSelectors());
        // 3b-ii-A (Codex #2276 r2) — the epochs' engine-inlining reads, read-only.
        items[81] = Item("rewardEpochViewFacet", ArtifactDeploy.deploy(type(RewardEpochViewFacet).name), _getRewardEpochViewSelectors());
        // 3b-ii-A2 (#2305) — the claim's entry walk, hosted; refreshed with the claim facet.
        items[82] = Item("rewardStagingFacet", ArtifactDeploy.deploy(type(RewardStagingFacet).name), _getRewardStagingSelectors());
        items[83] = Item("rewardClaimWalkFacet", ArtifactDeploy.deploy(type(RewardClaimWalkFacet).name), _getRewardClaimWalkSelectors());
        items[84] = Item("rewardSweepWalkFacet", ArtifactDeploy.deploy(type(RewardSweepWalkFacet).name), _getRewardSweepWalkSelectors());
        items[85] = Item("rewardStagingSettleFacet", ArtifactDeploy.deploy(type(RewardStagingSettleFacet).name), _getRewardStagingSettleSelectors());
        items[86] = Item("rewardForfeitWalkFacet", ArtifactDeploy.deploy(type(RewardForfeitWalkFacet).name), _getRewardForfeitWalkSelectors());
        items[87] = Item("rewardStagingDomainFacet", ArtifactDeploy.deploy(type(RewardStagingDomainFacet).name), _getRewardStagingDomainSelectors());
        items[88] = Item("rewardClosureFacet", ArtifactDeploy.deploy(type(RewardClosureFacet).name), _getRewardClosureSelectors());
        items[89] = Item("rewardEraFacet", ArtifactDeploy.deploy(type(RewardEraFacet).name), _getRewardEraSelectors());
        items[90] = Item("serviceCapacityFacet", ArtifactDeploy.deploy(type(ServiceCapacityFacet).name), _getServiceCapacitySelectors());
        items[91] = Item("offerMatchIntentFacet", ArtifactDeploy.deploy(type(OfferMatchIntentFacet).name), _getOfferMatchIntentSelectors());
        // #2416 — refreshed WITH swapToRepayFacet (items[43]): one surface
        // across the two, so refreshing either alone splits the routes.
        items[92] = Item("swapToRepayPartialFacet", ArtifactDeploy.deploy(type(SwapToRepayPartialFacet).name), _getSwapToRepayPartialFacetSelectors());
        // #1566 slice 2 - the fallback-custody host its three callers self-call.
        items[93] = Item("fallbackCustodyFacet", ArtifactDeploy.deploy(type(FallbackCustodyFacet).name), _getFallbackCustodySelectors());
        // #2472 - the swap-attempt host every failover seller self-calls.
        items[94] = Item("swapAttemptFacet", ArtifactDeploy.deploy(type(SwapAttemptFacet).name), _getSwapAttemptSelectors());
        // #2440 - the treasury fee host every fee-charging facet self-calls.
        items[95] = Item("treasuryFeeFacet", ArtifactDeploy.deploy(type(TreasuryFeeFacet).name), _getTreasuryFeeSelectors());
        // #2419 - the valuation host RiskFacet and the LibRiskMath inliners self-call.
        items[96] = Item("numeraireValueFacet", ArtifactDeploy.deploy(type(NumeraireValueFacet).name), _getNumeraireValueSelectors());
        // #2769 - the paid-notification fee host (charge + consent).
        items[97] = Item("notificationFeeFacet", ArtifactDeploy.deploy(type(NotificationFeeFacet).name), _getNotificationFeeSelectors());
        // #2795 - the forced-sale host RepayPeriodicFacet self-calls.
        items[98] = Item("forcedSaleFacet", ArtifactDeploy.deploy(type(ForcedSaleFacet).name), _getForcedSaleSelectors());
        items[99] = Item("rateModelFacet", ArtifactDeploy.deploy(type(RateModelFacet).name), _getRateModelSelectors());
        items[100] = Item("vaipakamNFTMetadataFacet", ArtifactDeploy.deploy(type(VaipakamNFTMetadataFacet).name), _getNftMetadataSelectors());
        items[101] = Item("rewardRemitDestinationFacet", ArtifactDeploy.deploy(type(RewardRemitDestinationFacet).name), _getRewardRemitDestinationSelectors());
        items[102] = Item("saleExitVerdictFacet", ArtifactDeploy.deploy(type(SaleExitVerdictFacet).name), _getSaleExitVerdictSelectors());
        items[103] = Item("sellerClaimFacet", ArtifactDeploy.deploy(type(SellerClaimFacet).name), _getSellerClaimSelectors());
        items[104] = Item("refinancePayoffFacet", ArtifactDeploy.deploy(type(RefinancePayoffFacet).name), _getRefinancePayoffSelectors());
        // The discounted liquidation route, moved off RiskFacet (EIP-170).
        items[105] = Item(
            "riskDiscountedLiquidationFacet",
            ArtifactDeploy.deploy(type(RiskDiscountedLiquidationFacet).name),
            _getRiskDiscountedLiquidationSelectors()
        );
        items[26] = Item("rewardReporterFacet", ArtifactDeploy.deploy(type(RewardReporterFacet).name), _getRewardReporterSelectors());
        // #1222 M3 B3 — `getChainRecycledLedger` /
        // `getChainDailyRecycledCredit` moved here from ConfigFacet (EIP-170).
        // No special handling is needed: both facets are listed, the moved
        // selectors appear in THIS item's list, and a selector that is already
        // routed is cut as a Replace pointing at the new facet address — which
        // is the diamond-standard way to move one. (Contrast the #1351 slice-2c
        // note above, where the DESTINATION facet was missing from this script
        // entirely and the move silently did not happen.)
        items[27] = Item(
            "rewardAggregatorFacet",
            ArtifactDeploy.deploy(type(RewardAggregatorFacet).name),
            _getRewardAggregatorSelectors()
        );
        items[28] = Item("configFacet", ArtifactDeploy.deploy(type(ConfigFacet).name), _getConfigSelectors());
        items[29] = Item("legalFacet", ArtifactDeploy.deploy(type(LegalFacet).name), _getLegalSelectors());
        items[30] = Item("offerMatchFacet", ArtifactDeploy.deploy(type(OfferMatchFacet).name), _getOfferMatchSelectors());
        items[31] = Item("offerCancelFacet", ArtifactDeploy.deploy(type(OfferCancelFacet).name), _getOfferCancelSelectors());
        items[32] = Item(
            "metricsDashboardFacet",
            ArtifactDeploy.deploy(type(MetricsDashboardFacet).name),
            _getMetricsDashboardSelectors()
        );
        items[33] = Item("payrollFacet", ArtifactDeploy.deploy(type(PayrollFacet).name), _getPayrollSelectors());
        items[34] = Item(
            "riskMatchLiquidationFacet",
            ArtifactDeploy.deploy(type(RiskMatchLiquidationFacet).name),
            _getRiskMatchLiquidationSelectors()
        );
        items[35] = Item("offerAcceptFacet", ArtifactDeploy.deploy(type(OfferAcceptFacet).name), _getOfferAcceptSelectors());
        // #1835 — the accept path's borrower-LIF charge on its own host. It
        // must refresh IN THE SAME RUN as `offerAcceptFacet`: the two halves
        // are one behaviour split across a `crossFacetCall`, so refreshing
        // either alone leaves the other on pre-split code (the hazard #1780's
        // EarlyWithdrawal split records for its own pair).
        items[74] = Item(
            "offerAcceptFeeFacet",
            ArtifactDeploy.deploy(type(OfferAcceptFeeFacet).name),
            _getOfferAcceptFeeSelectors()
        );
        items[36] = Item("offerMutateFacet", ArtifactDeploy.deploy(type(OfferMutateFacet).name), _getOfferMutateSelectors());
        items[37] = Item("prepayListingFacet", ArtifactDeploy.deploy(type(PrepayListingFacet).name), _getPrepayListingSelectors());
        items[38] = Item(
            "nftPrepayListingFacet",
            ArtifactDeploy.deploy(type(NFTPrepayListingFacet).name),
            _getNFTPrepayListingSelectors()
        );
        items[39] = Item(
            "nftPrepayDutchListingFacet",
            ArtifactDeploy.deploy(type(NFTPrepayDutchListingFacet).name),
            _getNFTPrepayDutchListingSelectors()
        );
        items[40] = Item(
            "nftPrepayListingAtomicFacet",
            ArtifactDeploy.deploy(type(NFTPrepayListingAtomicFacet).name),
            _getNFTPrepayListingAtomicSelectors()
        );
        items[41] = Item(
            "nftPrepayAutoListFacet",
            ArtifactDeploy.deploy(type(NFTPrepayAutoListFacet).name),
            _getNFTPrepayAutoListSelectors()
        );
        items[42] = Item(
            "offerParallelSaleFacet",
            ArtifactDeploy.deploy(type(OfferParallelSaleFacet).name),
            _getOfferParallelSaleSelectors()
        );
        items[43] = Item("swapToRepayFacet", ArtifactDeploy.deploy(type(SwapToRepayFacet).name), _getSwapToRepayFacetSelectors());
        items[44] = Item(
            "swapToRepayIntentFacet",
            ArtifactDeploy.deploy(type(SwapToRepayIntentFacet).name),
            _getSwapToRepayIntentFacetSelectors()
        );
        items[45] = Item("intentConfigFacet", ArtifactDeploy.deploy(type(IntentConfigFacet).name), _getIntentConfigSelectors());
        items[46] = Item(
            "vpfiDiscountAccumulatorFacet",
            ArtifactDeploy.deploy(type(VPFIDiscountAccumulatorFacet).name),
            _getVpfiDiscountAccumulatorSelectors()
        );
        items[47] = Item(
            "mirrorTierReceiverFacet",
            ArtifactDeploy.deploy(type(MirrorTierReceiverFacet).name),
            _getMirrorTierReceiverSelectors()
        );
        items[48] = Item(
            "protocolBroadcastFacet",
            ArtifactDeploy.deploy(type(ProtocolBroadcastFacet).name),
            _getProtocolBroadcastSelectors()
        );
        items[49] = Item("intentDispatchFacet", ArtifactDeploy.deploy(type(IntentDispatchFacet).name), _getIntentDispatchFacetSelectors());
        items[50] = Item("autoLifecycleFacet", ArtifactDeploy.deploy(type(AutoLifecycleFacet).name), _getAutoLifecycleFacetSelectors());
        items[51] = Item(
            "encumbranceMutateFacet",
            ArtifactDeploy.deploy(type(EncumbranceMutateFacet).name),
            _getEncumbranceMutateFacetSelectors()
        );
        items[52] = Item("repayPeriodicFacet", ArtifactDeploy.deploy(type(RepayPeriodicFacet).name), _getRepayPeriodicFacetSelectors());
        items[53] = Item("signedOfferFacet", ArtifactDeploy.deploy(type(SignedOfferFacet).name), _getSignedOfferFacetSelectors());
        items[54] = Item("lenderIntentFacet", ArtifactDeploy.deploy(type(LenderIntentFacet).name), _getLenderIntentFacetSelectors());
        items[55] = Item(
            "aggregatorAdapterFactoryFacet",
            ArtifactDeploy.deploy(type(AggregatorAdapterFactoryFacet).name),
            _getAggregatorAdapterFactorySelectors()
        );
        items[56] = Item("backstopFacet", ArtifactDeploy.deploy(type(BackstopFacet).name), _getBackstopFacetSelectors());
        items[57] = Item(
            "riskSplitLiquidationFacet",
            ArtifactDeploy.deploy(type(RiskSplitLiquidationFacet).name),
            _getRiskSplitLiquidationSelectors()
        );
        items[58] = Item("numeraireConfigFacet", ArtifactDeploy.deploy(type(NumeraireConfigFacet).name), _getNumeraireConfigSelectors());
        items[59] = Item("receiverFacet", ArtifactDeploy.deploy(type(ReceiverFacet).name), _getReceiverFacetSelectors());
        items[60] = Item("riskAccessFacet", ArtifactDeploy.deploy(type(RiskAccessFacet).name), _getRiskAccessFacetSelectors());
        items[61] = Item(
            "rewardRemittanceFacet",
            ArtifactDeploy.deploy(type(RewardRemittanceFacet).name),
            _getRewardRemittanceSelectors()
        );
        // #1434 P2-w4 — the remittance lens: `_split` re-points the
        // RELOCATED view selectors (routed to the mutating facet on a live
        // Diamond) via Replace and adds the new w4 views.
        items[70] = Item(
            "rewardRemittanceLensFacet",
            ArtifactDeploy.deploy(type(RewardRemittanceLensFacet).name),
            _getRewardRemittanceLensSelectors()
        );
        // #1434 P2-w4 — the compensation dispatch pair: `_split` re-points
        // the relocated manual selector via Replace + adds the supplemental.
        items[71] = Item(
            "rewardCompensationDispatchFacet",
            ArtifactDeploy.deploy(type(RewardCompensationDispatchFacet).name),
            _getRewardCompensationDispatchSelectors()
        );
        items[62] = Item("offerPreviewFacet", ArtifactDeploy.deploy(type(OfferPreviewFacet).name), _getOfferPreviewSelectors());
        // #1104 — RiskPreviewFacet split off RiskAccessFacet (items[60]).
        items[63] = Item("riskPreviewFacet", ArtifactDeploy.deploy(type(RiskPreviewFacet).name), _getRiskPreviewFacetSelectors());
        // #1212 (E-10 Claim-All) — generic best-effort delegatecall batcher.
        // NEW facet: `_split` routes its selector to Add on an existing diamond
        // (unrouted), so an in-place refresh installs Claim All instead of
        // leaving multicall(Call[]) unrouted while the ABI advertises it.
        items[64] = Item("multicallFacet", ArtifactDeploy.deploy(type(MulticallFacet).name), _getMulticallFacetSelectors());
        // #1306 follow-up — InteractionRewardsLensFacet. NEW facet carved off
        // InteractionRewardsFacet (view/getter surface) for EIP-170 headroom.
        // `_split` re-points the view selectors (currently routed to the old
        // InteractionRewardsFacet) to the lens via Replace, so an in-place
        // refresh moves them cleanly.
        items[65] = Item(
            "interactionRewardsLensFacet",
            ArtifactDeploy.deploy(type(InteractionRewardsLensFacet).name),
            _getInteractionRewardsLensSelectors()
        );
        // #1347 (M2 PR-5a/5b) — Full VPFI fee-entitlement tariff facet. An
        // in-place refresh MUST re-cut this alongside OfferAcceptFacet/Config/
        // Profile, or `_fullTariffShouldRun` reaches an unrouted `chargeFullTariff`
        // selector once the master switch arms (or a user presents a Full opt-in)
        // and every ERC-20 accept reverts (Codex #1366 P2).
        items[66] = Item(
            "feeEntitlementFacet",
            ArtifactDeploy.deploy(type(FeeEntitlementFacet).name),
            _getFeeEntitlementFacetSelectors()
        );
        // #1222 M3 B2-c — commitment-GATE plumbing. NEW facet: an in-place
        // refresh MUST cut it alongside the aggregator + remittance facets, or
        // an armed grace/force finalize sets `remitIneligible` on the live
        // Diamond with no routed `reconcileCommitmentRemitEligibility` selector
        // to clear it, stranding that chain-day's remittance (Codex #1422 r3).
        items[68] = Item(
            "rewardCommitmentFacet",
            ArtifactDeploy.deploy(type(RewardCommitmentFacet).name),
            _getRewardCommitmentSelectors()
        );
        // #1568 C2 — repatriation accounting core. NEW facet: an in-place
        // refresh must cut it or the exported ABI advertises eight selectors
        // the live Diamond's fallback rejects, and endpoint configuration
        // (the arming step) reverts until a fresh deployment (Codex #1608
        // r3).
        items[69] = Item(
            "repatriationFacet",
            ArtifactDeploy.deploy(type(RepatriationFacet).name),
            _getRepatriationSelectors()
        );
        // #1132 (S10 central enforcement) — terminal-transition register host.
    }

    /// @notice Broadcast one bounded diamondCut for `cuts[start..end)`.
    /// @dev #1660 r9 — generation-probe + UUPS-upgrade one remittance
    ///      receiver proxy (no-op for zero or already-current).
    /// @notice Every RETIRED mirror-ingress signature this script Removes, in
    ///         the order they were retired.
    /// @dev    #1566 transport epochs PR 3b (Codex #2232 r1). These were four
    ///         inline locals until this PR, extended once per widening and
    ///         covered by no test — which is how the FOURTH widening managed to
    ///         omit itself. Leaving a retired selector routed is silent and
    ///         severe: it still points at the previous facet bytecode, so an
    ///         un-upgraded receiver keeps calling it and its deliveries SUCCEED
    ///         against stale code, skipping whatever the new ingress added.
    ///
    ///         `RetiredIngressSelectorsTest` pins the CURRENT ingress selectors
    ///         against this list, so a future signature change fails a test
    ///         that names the predecessor it has to add here, rather than
    ///         shipping a Diamond that half-migrated in the operator's favour.
    ///
    ///         `public` so a test can read it without broadcasting anything.
    function retiredIngressSignatures() public pure returns (string[] memory sigs) {
        sigs = new string[](7);
        // #1222 B2-d5 — `recycledShare` (6 → 7 args).
        sigs[0] = "onRewardBudgetReceived(address,uint256,uint256[],uint256,uint256,address)";
        // #1434 P1-a — `freshShare` (7 → 8).
        sigs[1] = "onRewardBudgetReceived(address,uint256,uint256[],uint256,uint256,address,uint256)";
        // #1566 closure 2 cutover PR 1 — `transportMessageId` (8 → 9).
        sigs[2] = "onRewardBudgetReceived(address,uint256,uint256[],uint256,uint256,address,uint256,uint256)";
        // #1566 transport epochs PR 3b — `splitTyped` (9 → 10).
        sigs[3] = "onRewardBudgetReceived(address,uint256,uint256[],uint256,uint256,address,uint256,uint256,bytes32)";
        // #1566 closure 2 cutover PR 1 — the compensation ingress's own stamp.
        sigs[4] = "onCompensationBudgetReceived(address,uint256,uint256,uint256,uint256,address,uint256,uint256,uint64,uint32,uint64,uint64)";
        // Pre-d6 budget wire retired — the whole flat-list ingress (10 args).
        // The d6 ingress then became the only budget ingress, and the receiver
        // (generation 7) refused every earlier shape.
        sigs[5] = "onRewardBudgetReceived(address,uint256,uint256[],uint256,uint256,address,uint256,uint256,bytes32,bool)";
        // #918 — the d6 rooted ingress (12 args). The d7 ingress
        // `onRewardBudgetReceivedD7` (16 args: the part as declared and the
        // funded day's whole) replaces it, and the receiver (generation 8)
        // refuses the d6 wire.
        sigs[6] = "onRewardBudgetReceivedD6(address,uint256,bytes32,uint256,uint256,uint256,uint256,address,uint256,uint256,bytes32,uint64)";
    }

    /// @dev Codex #2232 r3 — the LIVE receiver the refreshed ingress will
    ///      trust, read tolerantly. Every other live-config read in this
    ///      script runs after the cuts, where the lens selector is certainly
    ///      routed; this one runs BEFORE them, so a Diamond old enough not to
    ///      route it must degrade to the artifact rather than abort the run.
    ///      Zero means "could not be determined here", never "there is none" —
    ///      the mirror requirement is asserted after the cuts, where the read
    ///      is reliable, and that is the only place it is decided.
    function _liveRemitReceiverOptional(address diamond) private view returns (address) {
        (bool ok, bytes memory ret) = diamond.staticcall(
            abi.encodeWithSignature("getRewardRemittanceReceiver()")
        );
        if (!ok || ret.length != 32) return address(0);
        return abi.decode(ret, (address));
    }

    /// @dev Codex #2232 r3 — upgrade the remittance receiver AHEAD of the
    ///      facet cuts, probing the LIVE address and the artifact as two
    ///      SEPARATE targets rather than one with a fallback (Codex #2232 r3
    ///      F4: a stale or superseded artifact entry must never decide whether
    ///      the live receiver gets upgraded, and both are probed when they
    ///      differ so a rotation in progress leaves neither behind; #2232 r11:
    ///      nor may it stand IN PLACE of the live address anywhere, which is
    ///      why the post-cut requirement reads only the live one).
    ///      Generation-gated in
    ///      {_probeUpgradeRemitReceiver}, so it is a no-op on a rerun and on
    ///      every already-current proxy.
    function _upgradeRemitReceiverAhead(address diamond, address broadcaster) private {
        address live = _liveRemitReceiverOptional(diamond);
        address artifact = _readAddrOptional(".rewardRemittanceReceiver");
        // AUTHORITY DECIDES FATALITY (Codex #2232 r3 F3). The LIVE receiver is
        // the one the refreshed ingress will trust, so failing to upgrade it
        // must stop the run — proceeding would install the widened ingress
        // for a receiver that cannot call it. The ARTIFACT is a RECORD of a
        // receiver, and a record can be stale: a superseded proxy whose
        // upgrade authority has rotated away reverts on `upgradeToAndCall`,
        // and an earlier revision let that revert abort a refresh whose live
        // receiver had already been resolved and upgraded successfully — a
        // stale bookkeeping entry deciding the fate of a correct deployment.
        //
        // Removing the artifact probe was the other option and is worse: a
        // rotation IN PROGRESS is exactly when the two differ, and that is
        // when leaving the outgoing receiver un-upgraded matters. So it stays,
        // demoted to best-effort — attempted where this signer has the
        // authority, and reported loudly where it does not, never fatal. The
        // skip is safe in the direction that matters: an un-upgraded receiver
        // calls the retired selector, which this run removes, so its
        // deliveries REVERT and are MANUALLY RE-EXECUTED after the refresh
        // (CCIP does not redeliver a failed message on its own —
        // {CcipMessenger} and the cutover runbook both define the recovery as
        // manual re-execution). Recoverable, against a run aborted midway.
        //
        // The demotion is enforced by PREFLIGHTING the upgrade authority, not
        // by catching the revert — see {_probeUpgradeRemitReceiver}, where a
        // caught revert under `startBroadcast` was still a queued transaction
        // and so was never best-effort at all (Codex #2232 r14).
        if (live != address(0)) _probeUpgradeRemitReceiver(live, true, broadcaster);
        if (artifact != address(0) && artifact != live) {
            _probeUpgradeRemitReceiver(artifact, false, broadcaster);
        }
        if (live == address(0) && artifact == address(0)) {
            // Not a failure here: the canonical chain legitimately has no
            // receiver, and a mirror without a LIVE one is STOPPED after the
            // cuts, where `getRewardReporterConfig` can say which this is.
            // Note the post-cut stop is keyed on the live address alone
            // (#2232 r11), so a mirror that resolves ONLY the artifact is
            // stopped there too and simply does not reach this line.
            console.log("remit receiver: none resolvable pre-cut - decided after the cuts");
        }
    }

    /// @dev #1566 transport epochs PR 3b (Codex #2232 r4) — Remove every
    ///      RETIRED ingress selector the loupe still routes, in one cut.
    ///
    ///      ONE implementation, called TWICE: ahead of the cut dispatch, where
    ///      it makes the whole refresh window fail-closed for a receiver that
    ///      was never upgraded, and again after the cuts, where it is the
    ///      sweep for a run that was interrupted between the two. Idempotent
    ///      by construction — it removes only what is routed and asking a cut
    ///      to Remove an unrouted selector reverts, which would abort a
    ///      refresh over a migration that had already happened.
    ///
    ///      The retired signatures live in {retiredIngressSignatures} so the
    ///      list is a surface a test can pin (Codex #2232 r1); this only asks
    ///      the loupe which of them are still routed here.
    /// @return removed How many were Removed by this call.
    function _removeRetiredIngress(address diamond, IDiamondLoupe loupe)
        private
        returns (uint256 removed)
    {
        string[] memory retiredSigs = retiredIngressSignatures();
        bytes4[] memory retired = new bytes4[](retiredSigs.length);
        for (uint256 r; r < retiredSigs.length; ++r) {
            retired[r] = bytes4(keccak256(bytes(retiredSigs[r])));
            if (loupe.facetAddress(retired[r]) != address(0)) ++removed;
        }
        if (removed == 0) {
            console.log("remit ingress: no retired selector routed - nothing to remove");
            return 0;
        }
        bytes4[] memory rmIngress = new bytes4[](removed);
        uint256 k;
        for (uint256 r; r < retired.length; ++r) {
            if (loupe.facetAddress(retired[r]) != address(0)) rmIngress[k++] = retired[r];
        }
        IDiamondCut.FacetCut[] memory rmIngressCut = new IDiamondCut.FacetCut[](1);
        rmIngressCut[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: rmIngress
        });
        IDiamondCut(diamond).diamondCut(rmIngressCut, address(0), "");
        // Read back rather than assumed: an un-Removed selector is the whole
        // defect this call exists to prevent, so it is verified, not hoped for.
        for (uint256 r; r < rmIngress.length; ++r) {
            require(
                loupe.facetAddress(rmIngress[r]) == address(0),
                "RefreshAllFacetsInPlace: a retired ingress selector is still routed after the Remove"
            );
        }
        console.log(
            "remit ingress: removed retired onRewardBudgetReceived selectors (6-arg #1222 B2-d5 / 7-arg #1434 P1-a / 8-arg #1566 cutover / 9-arg #1566 transport epochs 3b / 10-arg pre-d6 flat-list / 12-arg d6 rooted, #918) and the 12-arg onCompensationBudgetReceived"
        );
    }

    /// @dev `mandatory` says whether a failed upgrade stops the run. True for
    ///      the LIVE receiver the ingress will trust; false for an artifact
    ///      entry, which is corroborating and may be stale (see
    ///      {_upgradeRemitReceiverAhead}). A non-mandatory skip is logged
    ///      rather than swallowed: the operator must be told which proxy was
    ///      left behind, because a receiver still on the old generation is a
    ///      lane whose deliveries will revert until it is upgraded by hand.
    ///
    ///      NO try/catch — THE AUTHORITY IS PREFLIGHTED INSTEAD (Codex #2232
    ///      r14). This runs under `startBroadcast`, and Forge records every external
    ///      call made in broadcast mode as a transaction whether or not
    ///      Solidity caught its simulated revert, so a call EXPECTED to revert
    ///      must not be made at all. Catching the revert therefore never made
    ///      the artifact probe best-effort — the reverting `upgradeToAndCall`
    ///      stayed in the broadcast list and failed the run at send time,
    ///      AFTER the cuts had mined. That is the mid-run abort the r3 demotion
    ///      was introduced to prevent, reintroduced by the mechanism chosen to
    ///      prevent it.
    ///
    ///      `_authorizeUpgrade` on {RewardRemittanceReceiver} is `onlyOwner`,
    ///      so the one EXPECTED failure — a superseded proxy whose ownership
    ///      has rotated away from this signer — is answerable by a
    ///      `staticcall`, which broadcasts nothing. A proxy this signer cannot
    ///      upgrade is skipped before any transaction exists. Anything that
    ///      reverts AFTER that check is unexpected, and an unexpected revert
    ///      must abort rather than be swallowed, which a plain call does.
    function _probeUpgradeRemitReceiver(
        address proxy,
        bool mandatory,
        address broadcaster
    ) private {
        if (proxy == address(0)) return;
        uint256 gen = 0;
        (bool ok, bytes memory ret) = proxy.staticcall(
            abi.encodeWithSignature("WIRE_GENERATION()")
        );
        if (ok && ret.length == 32) gen = abi.decode(ret, (uint256));
        if (gen < REMIT_RECEIVER_WIRE_GENERATION) {
            // Read the upgrade authority before creating any transaction. A
            // proxy that does not answer `owner()` is treated as un-upgradable
            // by this signer rather than optimistically called: it is either
            // not this contract or not a proxy, and either way the upgrade
            // would revert.
            (bool okOwner, bytes memory ownerRet) = proxy.staticcall(
                abi.encodeWithSignature("owner()")
            );
            address proxyOwner =
                (okOwner && ownerRet.length == 32) ? abi.decode(ownerRet, (address)) : address(0);
            if (proxyOwner != broadcaster) {
                if (mandatory) {
                    revert(
                        "RefreshAllFacetsInPlace: live remit receiver is not owned by ADMIN_PRIVATE_KEY - it cannot be upgraded by this run"
                    );
                }
                console.log(
                    "P2-w2: WARNING - artifact remit receiver NOT upgraded, not owned by this signer (stale entry?), proxy:",
                    proxy
                );
                console.log(
                    "       its deliveries will revert on the retired selector until upgraded by hand"
                );
                return;
            }
            address newImpl = ArtifactDeploy.deploy(type(RewardRemittanceReceiver).name);
            UUPSUpgradeable(proxy).upgradeToAndCall(newImpl, "");
            Deployments.writeRewardRemittanceReceiverImpl(newImpl);
            // #1566 transport epochs PR 3a (Codex #2224 r3) — the TARGET is
            // derived from the constant the gate above reads, never written
            // out again: a hardcoded figure here reports the wrong installed
            // wire state to the operator the first time a generation moves,
            // and it moved for the messenger in this very PR.
            console.log(
                string.concat(
                    "P2-w2: upgraded RewardRemittanceReceiv (wire gen ",
                    vm.toString(gen),
                    " -> ",
                    vm.toString(REMIT_RECEIVER_WIRE_GENERATION),
                    ") impl:"
                ),
                newImpl
            );
        }
    }

    /// @dev #1660 r9 — generation-probe + UUPS-upgrade one reward
    ///      messenger proxy (no-op for zero or already-current).
    function _probeUpgradeRewardMessenger(address proxy) private {
        if (proxy == address(0)) return;
        uint256 gen = 0;
        (bool ok, bytes memory ret) = proxy.staticcall(
            abi.encodeWithSignature("WIRE_GENERATION()")
        );
        if (ok && ret.length == 32) gen = abi.decode(ret, (uint256));
        if (gen < REWARD_MESSENGER_WIRE_GENERATION) {
            address newImpl = ArtifactDeploy.deploy(type(VaipakamRewardMessenger).name);
            UUPSUpgradeable(proxy).upgradeToAndCall(newImpl, "");
            Deployments.writeAddress(".rewardMessengerImpl", newImpl);
            // #1566 transport epochs PR 3a (Codex #2224 r3) — the TARGET is
            // derived from the constant the gate above reads, never written
            // out again: a hardcoded figure here reports the wrong installed
            // wire state to the operator the first time a generation moves,
            // and it moved for the messenger in this very PR.
            console.log(
                string.concat(
                    "P2-w4/w5: upgraded VaipakamRewardMess (wire gen ",
                    vm.toString(gen),
                    " -> ",
                    vm.toString(REWARD_MESSENGER_WIRE_GENERATION),
                    ") impl:"
                ),
                newImpl
            );
        }
    }

    /// @dev #1660 r3 — generation-probe + UUPS-upgrade one return-channel
    ///      SENDER proxy (no-op for zero or already-current). ONE
    ///      implementation, called for the live endpoint AND a distinct
    ///      artifact address.
    function _probeUpgradeReturnSender(address proxy) private {
        if (proxy == address(0)) return;
        uint256 gen = 0;
        (bool ok, bytes memory ret) = proxy.staticcall(
            abi.encodeWithSignature("WIRE_GENERATION()")
        );
        if (ok && ret.length == 32) gen = abi.decode(ret, (uint256));
        if (gen < VPFI_RETURN_SENDER_WIRE_GENERATION) {
            address newImpl = ArtifactDeploy.deploy(type(VpfiReturnSender).name);
            UUPSUpgradeable(proxy).upgradeToAndCall(newImpl, "");
            Deployments.writeVpfiReturnSenderImpl(newImpl);
            // #1566 transport epochs PR 3a (Codex #2224 r3) — the TARGET is
            // derived from the constant the gate above reads, never written
            // out again: a hardcoded figure here reports the wrong installed
            // wire state to the operator the first time a generation moves,
            // and it moved for the messenger in this very PR.
            console.log(
                string.concat(
                    "P2-w5: upgraded VpfiReturnSend (wire gen ",
                    vm.toString(gen),
                    " -> ",
                    vm.toString(VPFI_RETURN_SENDER_WIRE_GENERATION),
                    ") impl:"
                ),
                newImpl
            );
        }
    }

    /// @dev #1660 r3 — the RECEIVER twin of the probe above.
    function _probeUpgradeReturnReceiver(address proxy) private {
        if (proxy == address(0)) return;
        uint256 gen = 0;
        (bool ok, bytes memory ret) = proxy.staticcall(
            abi.encodeWithSignature("WIRE_GENERATION()")
        );
        if (ok && ret.length == 32) gen = abi.decode(ret, (uint256));
        if (gen < VPFI_RETURN_RECEIVER_WIRE_GENERATION) {
            address newImpl = ArtifactDeploy.deploy(type(VpfiReturnReceiver).name);
            UUPSUpgradeable(proxy).upgradeToAndCall(newImpl, "");
            Deployments.writeVpfiReturnReceiverImpl(newImpl);
            // #1566 transport epochs PR 3a (Codex #2224 r3) — the TARGET is
            // derived from the constant the gate above reads, never written
            // out again: a hardcoded figure here reports the wrong installed
            // wire state to the operator the first time a generation moves,
            // and it moved for the messenger in this very PR.
            console.log(
                string.concat(
                    "P2-w5: upgraded VpfiReturnReceiv (wire gen ",
                    vm.toString(gen),
                    " -> ",
                    vm.toString(VPFI_RETURN_RECEIVER_WIRE_GENERATION),
                    ") impl:"
                ),
                newImpl
            );
        }
    }

    /// @dev #1566 closure 2 cutover PR 1 — the adapter's generation probe. The
    ///      CCIP router is a constructor immutable of the implementation, so
    ///      the new implementation is built with the router the live proxy
    ///      reports (`getRouter`), never with an operator-typed one.
    function _probeUpgradeCcipMessenger(address proxy) private {
        if (proxy == address(0)) return;
        uint256 gen = 0;
        (bool ok, bytes memory ret) = proxy.staticcall(
            abi.encodeWithSignature("WIRE_GENERATION()")
        );
        if (ok && ret.length == 32) gen = abi.decode(ret, (uint256));
        if (gen < CCIP_MESSENGER_WIRE_GENERATION) {
            address router = CcipMessenger(proxy).getRouter();
            address newImpl = ArtifactDeploy.deploy(type(CcipMessenger).name, abi.encode(router));
            UUPSUpgradeable(proxy).upgradeToAndCall(newImpl, "");
            Deployments.writeAddress(".ccipMessengerImpl", newImpl);
            // #1566 transport epochs PR 3a (Codex #2224 r3) — the TARGET is
            // derived from the constant the gate above reads, never written
            // out again: a hardcoded figure here reports the wrong installed
            // wire state to the operator the first time a generation moves,
            // and it moved for the messenger in this very PR.
            console.log(
                string.concat(
                    "cutover PR 1: upgraded CcipMess (wire gen ",
                    vm.toString(gen),
                    " -> ",
                    vm.toString(CCIP_MESSENGER_WIRE_GENERATION),
                    ") impl:"
                ),
                newImpl
            );
        }
    }

    /// @dev #1566 closure 2 cutover PR 1 — the buyback receiver's generation probe.
    function _probeUpgradeBuybackReceiver(address proxy) private {
        if (proxy == address(0)) return;
        uint256 gen = 0;
        (bool ok, bytes memory ret) = proxy.staticcall(
            abi.encodeWithSignature("WIRE_GENERATION()")
        );
        if (ok && ret.length == 32) gen = abi.decode(ret, (uint256));
        if (gen < BUYBACK_RECEIVER_WIRE_GENERATION) {
            address newImpl = ArtifactDeploy.deploy(type(BuybackRemittanceReceiver).name);
            UUPSUpgradeable(proxy).upgradeToAndCall(newImpl, "");
            Deployments.writeBuybackRemittanceReceiverImpl(newImpl);
            // #1566 transport epochs PR 3a (Codex #2224 r3) — the TARGET is
            // derived from the constant the gate above reads, never written
            // out again: a hardcoded figure here reports the wrong installed
            // wire state to the operator the first time a generation moves,
            // and it moved for the messenger in this very PR.
            console.log(
                string.concat(
                    "cutover PR 1: upgraded BuybackRemittanceReceiv (wire gen ",
                    vm.toString(gen),
                    " -> ",
                    vm.toString(BUYBACK_RECEIVER_WIRE_GENERATION),
                    ") impl:"
                ),
                newImpl
            );
        }
    }

    /// @dev #1566 closure 2 cutover PR 1 (Codex #2198 r1) — the buyback
    ///      receiver and the CCIP adapter, LIVE-config-over-artifact like
    ///      every probe above (#1660 r9). An artifact-only read skipped a
    ///      live receiver whose artifact key was missing or stale, and the
    ///      adapter upgraded just before would then have called it with the
    ///      five-argument shape — every buyback delivery failing until the
    ///      artifact was repaired and the refresh rerun.
    ///
    ///      The buyback receiver: the Diamond's registered one first, then
    ///      a distinct artifact address (a dark-but-deployed proxy meets
    ///      current code). The adapter has no register of its own on the
    ///      Diamond — the Diamond names its satellites and each satellite
    ///      names the adapter it trusts (`messenger()`) — so the adapter
    ///      every LIVE satellite calls through is probed, then the
    ///      artifact's. Each probe is idempotent on the generation constant,
    ///      so one adapter named by five satellites is upgraded once and
    ///      read four times. No adapter anywhere (no live satellite names
    ///      one, no artifact) is a hard stop: every chain has one, and a
    ///      refresh that upgraded the recipients without it would leave the
    ///      adapter calling them with the old shape.
    function _probeUpgradeTransportSatellites(address diamond) private {
        address liveBuyback = TreasuryFacet(diamond).getBuybackRemittanceReceiver();
        address buybackArt = _readAddrOptional(".buybackRemittanceReceiver");
        _probeUpgradeBuybackReceiver(liveBuyback);
        if (buybackArt != liveBuyback) _probeUpgradeBuybackReceiver(buybackArt);

        (address liveMsgr, , , , ) =
            RewardReporterFacet(diamond).getRewardReporterConfig();
        (, address liveSender, address liveReceiver, ) =
            RepatriationFacet(diamond).getRepatriationPosition();
        address[6] memory adapters = [
            _satelliteMessenger(liveMsgr),
            _satelliteMessenger(
                RewardRemittanceLensFacet(diamond).getRewardRemittanceReceiver()
            ),
            _satelliteMessenger(liveSender),
            _satelliteMessenger(liveReceiver),
            _satelliteMessenger(liveBuyback),
            _readAddrOptional(".ccipMessenger")
        ];
        bool any;
        for (uint256 i = 0; i < adapters.length; ++i) {
            if (adapters[i] == address(0)) continue;
            any = true;
            _probeUpgradeCcipMessenger(adapters[i]);
        }
        require(
            any,
            "cutover PR 1: refresh needs the CCIP adapter (a live satellite's messenger() or .ccipMessenger)"
        );
    }

    /// @dev The adapter a satellite trusts — `messenger()` on every
    ///      recipient and on the return sender; zero when the satellite is
    ///      unset or does not answer the selector.
    function _satelliteMessenger(address satellite) private view returns (address) {
        if (satellite == address(0)) return address(0);
        (bool ok, bytes memory ret) =
            satellite.staticcall(abi.encodeWithSignature("messenger()"));
        if (!ok || ret.length != 32) return address(0);
        return abi.decode(ret, (address));
    }

    /// @notice #1566 transport epochs PR 3b (Codex #2232 r3) — the facets that
    ///         must be cut in ONE diamondCut transaction, because they share
    ///         one accounting rule and a mixed version of it is unsound.
    /// @dev    The MEMBERSHIP TEST, so a future facet is not left out by
    ///         judgement: a facet belongs here when its replacement changes
    ///         how the TRANSPORT EPOCH ledger is written or read, such that
    ///         running it against another member's previous bytecode would
    ///         make two surfaces disagree about one amount.
    ///
    ///         - `rewardIngressFacet` OPENS an epoch (and stamps the day-list
    ///           commitment every later step proves against);
    ///         - `rewardReconciliationFacet` hosts `classifyLegacyPacket`,
    ///           which SPENDS from it and is the surface that, on its previous
    ///           bytecode, reduces a packet's `unclassified` figure without
    ///           debiting the batch;
    ///         - `rewardEpochFacet` carries the lifecycle BETWEEN those two —
    ///           the paged indexing, the park, the acknowledgment — so its
    ///           entries must not be reachable against an ingress that has not
    ///           yet been replaced.
    ///
    ///         `RefreshScriptAtomicGroupTest` pins this list, so adding a
    ///         fourth participant to the lifecycle without adding it here
    ///         fails a test that names the rule rather than shipping a refresh
    ///         with the window quietly reopened.
    ///
    ///         This is deliberately a SMALL set. Hoisting is not free — every
    ///         member is also a facet whose new bytecode runs against the rest
    ///         of the Diamond's OLD bytecode for the remainder of the run — so
    ///         membership is for facets that would otherwise disagree about
    ///         value, not for facets that are merely related.
    function _atomicCutGroup() internal pure returns (string[] memory keys) {
        keys = new string[](3);
        keys[0] = "rewardIngressFacet";
        keys[1] = "rewardReconciliationFacet";
        keys[2] = "rewardEpochFacet";
    }

    /// @dev #1566 transport epochs PR 3b — move every key of the atomic group
    ///      to the front of the refresh, in the order given, so their cuts are
    ///      built contiguously and can be dispatched as one transaction.
    ///      Order is otherwise irrelevant here (every other consumer of
    ///      `items` is a set operation: the write-back, the verification
    ///      sweep, the parity test), which is why swaps are enough and no
    ///      ordering machinery is needed.
    ///
    ///      Reverts on an unknown key rather than silently leaving the order
    ///      unchanged — a rename must not quietly reopen the window this
    ///      exists to close — and on a DUPLICATE key, which would otherwise
    ///      swap a member back out of the group it had just been placed in
    ///      and leave the count reporting a group larger than the one built.
    /// @return groupLen How many leading items the group occupies.
    function _hoistGroupFirst(Item[] memory items, string[] memory keys)
        internal
        pure
        returns (uint256 groupLen)
    {
        for (uint256 k; k < keys.length; ++k) {
            bytes32 want = keccak256(bytes(keys[k]));
            for (uint256 j; j < k; ++j) {
                require(
                    keccak256(bytes(keys[j])) != want,
                    "RefreshAllFacetsInPlace: duplicate atomic cut group key"
                );
            }
            bool found;
            for (uint256 i = groupLen; i < items.length; ++i) {
                if (keccak256(bytes(items[i].key)) == want) {
                    Item memory head = items[groupLen];
                    items[groupLen] = items[i];
                    items[i] = head;
                    ++groupLen;
                    found = true;
                    break;
                }
            }
            require(found, "RefreshAllFacetsInPlace: atomic cut group key not found");
        }
    }

    /// @dev Total selectors carried by `cuts[start:end]`.
    function _selectorsIn(IDiamondCut.FacetCut[] memory cuts, uint256 start, uint256 end)
        internal
        pure
        returns (uint256 total)
    {
        for (uint256 i = start; i < end; ++i) total += cuts[i].functionSelectors.length;
    }

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

    /// @notice The routes a COMPLETE refresh must not leave behind: every
    ///         selector the loupe routes that this run did not install, with
    ///         the implementation it still points at.
    /// @dev    #2313. Derived from the loupe, not from a list. A signature
    ///         change ADDS a new selector and leaves the old one routed to the
    ///         previous bytecode: the split Diamond by the opposite door. This
    ///         script used to remove such selectors from hand-kept lists, one
    ///         block per incident, and a retirement nobody listed stayed
    ///         routed. Base Sepolia carried eleven of them through a complete
    ///         refresh on 2026-10-03, among them older shapes of the accept
    ///         entry points and four reward ingress hooks.
    ///
    ///         The rule needs no list because a complete refresh has just
    ///         installed the deploy's whole selector set
    ///         (`RefreshScriptFacetParityTest` pins `items[]` to it): every
    ///         selector routed to one of this run's implementations is
    ///         current, and every other selector is stale. Two exceptions:
    ///         - `diamondCut` is installed by the Diamond's constructor,
    ///           outside every `cuts[]` list, and is never stale. On THIS
    ///           Diamond the exception is unreachable: the constructor maps
    ///           the selector without registering a facet address, so
    ///           `facets()` never lists it (a mutation removing the exception
    ///           leaves every test green for that reason). It stays because
    ///           removing `diamondCut` would end the Diamond's upgradability
    ///           for good, and a loupe that did enumerate it must not make
    ///           that one step away;
    ///         - a CURRENT selector found off this run's implementations
    ///           means the cut did not land as built. That is a refusal, not
    ///           a removal, because removing it would unroute a live function.
    ///
    ///         `internal view` so a probe can assert the classification
    ///         without broadcasting.
    function _staleRoutes(IDiamondLoupe loupe, Item[] memory items)
        internal
        view
        returns (bytes4[] memory stale, address[] memory staleFrom)
    {
        IDiamondLoupe.Facet[] memory live = loupe.facets();
        uint256 total;
        for (uint256 i; i < live.length; ++i) total += live[i].functionSelectors.length;
        bytes4[] memory sels = new bytes4[](total);
        address[] memory from = new address[](total);
        uint256 n;
        for (uint256 i; i < live.length; ++i) {
            if (_isItemImpl(items, live[i].facetAddress)) continue;
            for (uint256 j; j < live[i].functionSelectors.length; ++j) {
                bytes4 sel = live[i].functionSelectors[j];
                if (sel == IDiamondCut.diamondCut.selector) continue;
                require(
                    !_isItemSelector(items, sel),
                    "RefreshAllFacetsInPlace: a current selector is routed off this run's implementations"
                );
                sels[n] = sel;
                from[n] = live[i].facetAddress;
                ++n;
            }
        }
        stale = new bytes4[](n);
        staleFrom = new address[](n);
        for (uint256 i; i < n; ++i) {
            stale[i] = sels[i];
            staleFrom[i] = from[i];
        }
    }

    /// @dev Remove every route {_staleRoutes} finds, in selector-budgeted
    ///      batches, naming each one before it goes. Then ask the loupe again,
    ///      so a removal that did not take is loud.
    ///
    ///      Runs after every selector-gated migration above. M1's tariff
    ///      reset uses its still-routed retired selector as the completion
    ///      marker, so sweeping earlier would skip that migration for good. It also runs before the custody
    ///      cutover stamp, which records the routing as it stands. A stamp
    ///      taken with a retired reward hook still routed would attest exactly
    ///      the routing the stamp exists to exclude.
    function _sweepStaleRoutes(address diamond, IDiamondLoupe loupe, Item[] memory items) internal {
        (bytes4[] memory stale, address[] memory staleFrom) = _staleRoutes(loupe, items);
        if (stale.length == 0) {
            console.log("stale routes: none - the Diamond routes exactly the deploy's selector set");
            return;
        }
        console.log("stale routes: removing", stale.length, "selector(s) this deploy no longer installs:");
        for (uint256 i; i < stale.length; ++i) {
            console.log("  ", vm.toString(abi.encodePacked(stale[i])), "was routed to", staleFrom[i]);
        }
        for (uint256 start; start < stale.length; start += SELECTOR_BUDGET) {
            uint256 end = start + SELECTOR_BUDGET < stale.length ? start + SELECTOR_BUDGET : stale.length;
            bytes4[] memory batch = new bytes4[](end - start);
            for (uint256 i = start; i < end; ++i) batch[i - start] = stale[i];
            IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
            cut[0] = IDiamondCut.FacetCut({
                facetAddress: address(0),
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: batch
            });
            IDiamondCut(diamond).diamondCut(cut, address(0), "");
        }
        for (uint256 i; i < stale.length; ++i) {
            require(
                loupe.facetAddress(stale[i]) == address(0),
                "RefreshAllFacetsInPlace: a stale route is still routed after the Remove cut"
            );
        }
        console.log("stale routes removed (verified unrouted):", stale.length);
    }

    function _isItemImpl(Item[] memory items, address impl) private pure returns (bool) {
        for (uint256 i; i < items.length; ++i) {
            if (items[i].impl == impl) return true;
        }
        return false;
    }

    function _isItemSelector(Item[] memory items, bytes4 sel) private pure returns (bool) {
        for (uint256 i; i < items.length; ++i) {
            for (uint256 j; j < items[i].selectors.length; ++j) {
                if (items[i].selectors[j] == sel) return true;
            }
        }
        return false;
    }

    /// @dev `REWARD_ROLE_EXPECTED` label -> `LibVaipakam.RewardRole` ordinal.
    ///      Pinned by `RewardRoleResolverTest.test_RoleEnumWireValuesArePinned`.
    function _roleFromLabel(string memory label) internal pure returns (uint8) {
        bytes32 h = keccak256(bytes(label));
        if (h == keccak256("canonical")) return 0;
        if (h == keccak256("mirror")) return 1;
        if (h == keccak256("unconfigured")) return 2;
        if (h == keccak256("detached")) return 3;
        revert("role-backfill: REWARD_ROLE_EXPECTED must be canonical|mirror|unconfigured|detached");
    }

    /// @dev Read an optional address key from this chain's `addresses.json`.
    ///      Chain-scoped keys are ABSENT on chains they do not apply to (the
    ///      omit-keys policy — no `0x0…0` sentinels), so a missing key must
    ///      mean "not on this chain", never a hard failure of the whole
    ///      refresh. Mirrors the helper `Handover.s.sol` uses for the same
    ///      reason.
    function _readAddrOptional(string memory key)
        internal
        view
        returns (address)
    {
        string memory path = Deployments.path();
        try vm.readFile(path) returns (string memory json) {
            try vm.parseJsonAddress(json, key) returns (address a) {
                return a;
            } catch {
                return address(0);
            }
        } catch {
            return address(0);
        }
    }

}
