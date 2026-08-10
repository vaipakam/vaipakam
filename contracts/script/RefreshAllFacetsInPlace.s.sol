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
import {FeeEntitlementFacet} from "../src/facets/FeeEntitlementFacet.sol";
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
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
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
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
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
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

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
    uint256 internal constant EXPECTED_FACETS = 72;

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
        // never wipes a deliberately-set VPFI tariff. This is the one place
        // this script Removes a selector (see the SCOPE note above); it is
        // required because the selector's storage SEMANTICS changed, not just
        // its implementation.
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
        //   1. it Replaces/Adds but never Removes (see the SCOPE note), so the
        //      retired 6-arg selector stays routed to the OLD facet bytecode;
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
        // Ordering follows the M1 lesson above: the still-routed old selector
        // is the DURABLE completion marker, so it is Removed LAST. If the
        // receiver upgrade lands but the Remove is dropped, a rerun re-enters
        // and redoes both (re-upgrading to a fresh implementation is
        // idempotent in effect). Removing first would clear the marker while
        // the upgrade could still fail, permanently skipping it.
        bytes4 oldRemitIngress6 = bytes4(
            keccak256(
                "onRewardBudgetReceived(address,uint256,uint256[],uint256,uint256,address)"
            )
        );
        bytes4 oldRemitIngress7 = bytes4(
            keccak256(
                "onRewardBudgetReceived(address,uint256,uint256[],uint256,uint256,address,uint256)"
            )
        );
        bool routed6 = loupe.facetAddress(oldRemitIngress6) != address(0);
        bool routed7 = loupe.facetAddress(oldRemitIngress7) != address(0);
        if (routed6 || routed7) {
            address remitReceiver = _readAddrOptional(".rewardRemittanceReceiver");
            (, , , bool isCanonicalReward, ) =
                RewardReporterFacet(diamond).getRewardReporterConfig();

            // Codex r2 F2 — a MIRROR must never pass this point without its
            // receiver actually upgraded. `_readAddrOptional` returns zero for
            // a missing/stale/malformed artifact as well as for a chain that
            // genuinely has no receiver; skipping on that ambiguity and then
            // Removing the selector anyway would leave the old receiver
            // calling an UNROUTED ingress — every delivery failing — while
            // destroying the migration marker, so a rerun would never retry
            // the upgrade. Only the canonical chain legitimately has no
            // receiver (nothing remits to it), so only it may skip.
            require(
                remitReceiver != address(0) || isCanonicalReward,
                "B2-d5: mirror refresh needs .rewardRemittanceReceiver in addresses.json"
            );

            if (remitReceiver != address(0)) {
                address newImpl = address(new RewardRemittanceReceiver());
                UUPSUpgradeable(remitReceiver).upgradeToAndCall(newImpl, "");
                // Codex r2 F3 — the CANONICAL key. `writeFacet` would write
                // `.facets.rewardRemittanceReceiverImpl`, while DeployCrosschain
                // and every consumer read the TOP-LEVEL
                // `.rewardRemittanceReceiverImpl`; using it would leave the
                // real record pointing at the superseded implementation while
                // inventing a spurious facet entry.
                Deployments.writeRewardRemittanceReceiverImpl(newImpl);
                console.log(
                    "B2-d5: upgraded RewardRemittanceReceiver impl ->", newImpl
                );
            } else {
                console.log(
                    "B2-d5: canonical reward chain - no receiver to upgrade"
                );
            }

            // Only the selectors actually routed are Removed — a Diamond
            // already past B2-d5 has no 6-arg selector, and asking the cut to
            // Remove an unrouted one reverts, which would abort the whole
            // refresh over a migration that had already happened.
            bytes4[] memory rmIngress =
                new bytes4[]((routed6 ? 1 : 0) + (routed7 ? 1 : 0));
            uint256 k;
            if (routed6) {
                rmIngress[k] = oldRemitIngress6;
                ++k;
            }
            if (routed7) rmIngress[k] = oldRemitIngress7;
            IDiamondCut.FacetCut[] memory rmIngressCut =
                new IDiamondCut.FacetCut[](1);
            rmIngressCut[0] = IDiamondCut.FacetCut({
                facetAddress: address(0),
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: rmIngress
            });
            IDiamondCut(diamond).diamondCut(rmIngressCut, address(0), "");
            console.log(
                "remit ingress: removed retired onRewardBudgetReceived selectors (6-arg #1222 B2-d5 / 7-arg #1434 P1-a)"
            );
        }

        // ─── #1434 P2-w2 (Codex #1634 r1) — receiver wire-generation probe ──
        //
        // The B2-d5 block above gates its receiver upgrade on the RETIRED
        // Diamond selectors still being routed — its own durable migration
        // marker. A deployment already past that migration routes neither,
        // so the block is (correctly) skipped there — but that also skipped
        // the RECEIVER upgrade for every LATER wire generation: the P2
        // compensation tag would hit a receiver that reads the keccak-sized
        // tag as a legacy array offset and reverts every delivery, while
        // Base has already closed the day and holds the reservation Pending.
        //
        // The durable gate for this and every future generation is the
        // receiver's OWN `WIRE_GENERATION` constant: a missing selector
        // (pre-P2 implementation) or a lower value means the proxy needs
        // the upgrade. Idempotent — a rerun (or a same-run pass after the
        // B2-d5 block already upgraded) reads the new implementation's
        // value and skips.
        {
            address remitReceiverP2 =
                _readAddrOptional(".rewardRemittanceReceiver");
            // #1634 r2 — the SAME fail-closed posture as the B2-d5 block:
            // `_readAddrOptional` returns zero for a missing / stale /
            // malformed artifact as well as for a chain that genuinely has
            // no receiver, and a MIRROR silently skipping here would ship
            // the P2 Diamond ingress with a receiver that cannot decode
            // the P2 tag — every manual compensation failing while Base
            // has closed the day. Only the canonical chain legitimately
            // has no receiver.
            (, , , bool isCanonicalRewardP2, ) =
                RewardReporterFacet(diamond).getRewardReporterConfig();
            require(
                remitReceiverP2 != address(0) || isCanonicalRewardP2,
                "P2-w2: mirror refresh needs .rewardRemittanceReceiver in addresses.json"
            );
            if (remitReceiverP2 != address(0)) {
                uint256 gen = 0;
                (bool ok, bytes memory ret) = remitReceiverP2.staticcall(
                    abi.encodeWithSignature("WIRE_GENERATION()")
                );
                if (ok && ret.length == 32) gen = abi.decode(ret, (uint256));
                if (gen < REMIT_RECEIVER_WIRE_GENERATION) {
                    address newImplP2 = address(new RewardRemittanceReceiver());
                    UUPSUpgradeable(remitReceiverP2).upgradeToAndCall(
                        newImplP2, ""
                    );
                    Deployments.writeRewardRemittanceReceiverImpl(newImplP2);
                    console.log(
                        "P2-w2: upgraded RewardRemittanceReceiver (wire gen",
                        gen,
                        "-> 3) impl:",
                        newImplP2
                    );
                }
            }
        }

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
            address rewardMsgr = _readAddrOptional(".rewardMessenger");
            require(
                rewardMsgr != address(0),
                "P2-w4: refresh needs .rewardMessenger in addresses.json"
            );
            uint256 mgen = 0;
            (bool mok, bytes memory mret) = rewardMsgr.staticcall(
                abi.encodeWithSignature("WIRE_GENERATION()")
            );
            if (mok && mret.length == 32) mgen = abi.decode(mret, (uint256));
            if (mgen < REWARD_MESSENGER_WIRE_GENERATION) {
                address newMsgrImpl = address(new VaipakamRewardMessenger());
                UUPSUpgradeable(rewardMsgr).upgradeToAndCall(newMsgrImpl, "");
                Deployments.writeAddress(
                    ".rewardMessengerImpl", newMsgrImpl
                );
                console.log(
                    "P2-w4: upgraded VaipakamRewardMessenger (wire gen",
                    mgen,
                    "-> 2) impl:",
                    newMsgrImpl
                );
            }
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

        // ─── #1434 P2-w2 (#1634 r2) — retire the 3-arg manual remit ─────────
        //
        // `remitManualBudget` changed from (uint32,uint256,uint256) to the
        // per-side (uint32,uint256,uint256,uint256) shape, so its SELECTOR
        // changed — and this script Replaces/Adds but never Removes (SCOPE
        // note above). The retired selector would stay routed to the OLD
        // facet bytecode: an admin on stale tooling could still close a
        // day and dispatch the legacy d5 ordinary-remit payload, which the
        // upgraded mirror books through `onRewardBudgetReceived` instead
        // of the compensation classifier — no compensated pools, no
        // recovery reservation, while Base considers the compensation
        // sent. Remove it so stale tooling FAILS CLOSED. Gated on the old
        // selector being routed (the standing idempotent-rerun pattern).
        {
            bytes4 oldManualRemit3 = bytes4(
                keccak256("remitManualBudget(uint32,uint256,uint256)")
            );
            if (loupe.facetAddress(oldManualRemit3) != address(0)) {
                bytes4[] memory rmManual = new bytes4[](1);
                rmManual[0] = oldManualRemit3;
                IDiamondCut.FacetCut[] memory rmManualCut =
                    new IDiamondCut.FacetCut[](1);
                rmManualCut[0] = IDiamondCut.FacetCut({
                    facetAddress: address(0),
                    action: IDiamondCut.FacetCutAction.Remove,
                    functionSelectors: rmManual
                });
                IDiamondCut(diamond).diamondCut(rmManualCut, address(0), "");
                console.log(
                    "P2-w2: removed retired remitManualBudget(uint32,uint256,uint256) selector"
                );
            }
        }

        // ─── #1503 PR-A — listing lifecycle: retire the 3-arg selector ──────
        //
        // PR-A changed `createLoanSaleOffer` from 3 args to 4 (the mandatory
        // `listingSeconds` window), so its SELECTOR changed. This script
        // Replaces/Adds but never Removes (SCOPE note above), which would
        // leave the retired 3-arg selector routed to the PREVIOUS facet
        // bytecode — a direct caller could keep creating expiry-free GTC
        // listings, bypassing both the mandatory window and the
        // relist-cooldown gate and preserving the indefinite borrower freeze
        // the change exists to eliminate (Codex #1505 r1 P1). Remove it
        // explicitly. No companion state migration is needed: listings
        // created through the old selector BEFORE this refresh are handled
        // structurally — `teardownStaleSaleListing` admits a linked sale
        // vehicle with the GTC sentinel (`expiresAt == 0`) to immediate
        // permissionless teardown, and the accept path refuses any sale fill
        // at/past the linked loan's live maturity. Gated on the old selector
        // still being routed, so this runs exactly once.
        bytes4 oldCreateLoanSaleOffer = bytes4(
            keccak256("createLoanSaleOffer(uint256,uint256,bool)")
        );
        if (loupe.facetAddress(oldCreateLoanSaleOffer) != address(0)) {
            bytes4[] memory rmSale = new bytes4[](1);
            rmSale[0] = oldCreateLoanSaleOffer;
            IDiamondCut.FacetCut[] memory rmSaleCut =
                new IDiamondCut.FacetCut[](1);
            rmSaleCut[0] = IDiamondCut.FacetCut({
                facetAddress: address(0),
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: rmSale
            });
            IDiamondCut(diamond).diamondCut(rmSaleCut, address(0), "");
            console.log(
                "#1503 PR-A: removed retired 3-arg createLoanSaleOffer selector"
            );
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
        // #1351 slice 2c — the CLAIM entry points moved off
        // InteractionRewardsFacet (EIP-170). This script only Replace/Adds the
        // selectors it lists and NEVER removes omitted ones, so without this
        // item an in-place refresh of a pre-split diamond would leave
        // `claimInteractionRewards*` routed at the OLD implementation while
        // every other reward facet moved forward — users silently claiming
        // through stale code that bypasses the ShareOfPool walk entirely.
        items[67] = Item(
            "rewardClaimFacet",
            address(new RewardClaimFacet()),
            _getRewardClaimFacetSelectors()
        );
        items[26] = Item("rewardReporterFacet", address(new RewardReporterFacet()), _getRewardReporterSelectors());
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
        // #1434 P2-w4 — the remittance lens: `_split` re-points the
        // RELOCATED view selectors (routed to the mutating facet on a live
        // Diamond) via Replace and adds the new w4 views.
        items[70] = Item(
            "rewardRemittanceLensFacet",
            address(new RewardRemittanceLensFacet()),
            _getRewardRemittanceLensSelectors()
        );
        // #1434 P2-w4 — the compensation dispatch pair: `_split` re-points
        // the relocated manual selector via Replace + adds the supplemental.
        items[71] = Item(
            "rewardCompensationDispatchFacet",
            address(new RewardCompensationDispatchFacet()),
            _getRewardCompensationDispatchSelectors()
        );
        items[62] = Item("offerPreviewFacet", address(new OfferPreviewFacet()), _getOfferPreviewSelectors());
        // #1104 — RiskPreviewFacet split off RiskAccessFacet (items[60]).
        items[63] = Item("riskPreviewFacet", address(new RiskPreviewFacet()), _getRiskPreviewFacetSelectors());
        // #1212 (E-10 Claim-All) — generic best-effort delegatecall batcher.
        // NEW facet: `_split` routes its selector to Add on an existing diamond
        // (unrouted), so an in-place refresh installs Claim All instead of
        // leaving multicall(Call[]) unrouted while the ABI advertises it.
        items[64] = Item("multicallFacet", address(new MulticallFacet()), _getMulticallFacetSelectors());
        // #1306 follow-up — InteractionRewardsLensFacet. NEW facet carved off
        // InteractionRewardsFacet (view/getter surface) for EIP-170 headroom.
        // `_split` re-points the view selectors (currently routed to the old
        // InteractionRewardsFacet) to the lens via Replace, so an in-place
        // refresh moves them cleanly.
        items[65] = Item(
            "interactionRewardsLensFacet",
            address(new InteractionRewardsLensFacet()),
            _getInteractionRewardsLensSelectors()
        );
        // #1347 (M2 PR-5a/5b) — Full VPFI fee-entitlement tariff facet. An
        // in-place refresh MUST re-cut this alongside OfferAcceptFacet/Config/
        // Profile, or `_fullTariffShouldRun` reaches an unrouted `chargeFullTariff`
        // selector once the master switch arms (or a user presents a Full opt-in)
        // and every ERC-20 accept reverts (Codex #1366 P2).
        items[66] = Item(
            "feeEntitlementFacet",
            address(new FeeEntitlementFacet()),
            _getFeeEntitlementFacetSelectors()
        );
        // #1222 M3 B2-c — commitment-GATE plumbing. NEW facet: an in-place
        // refresh MUST cut it alongside the aggregator + remittance facets, or
        // an armed grace/force finalize sets `remitIneligible` on the live
        // Diamond with no routed `reconcileCommitmentRemitEligibility` selector
        // to clear it, stranding that chain-day's remittance (Codex #1422 r3).
        items[68] = Item(
            "rewardCommitmentFacet",
            address(new RewardCommitmentFacet()),
            _getRewardCommitmentSelectors()
        );
        // #1568 C2 — repatriation accounting core. NEW facet: an in-place
        // refresh must cut it or the exported ABI advertises eight selectors
        // the live Diamond's fallback rejects, and endpoint configuration
        // (the arming step) reverts until a fresh deployment (Codex #1608
        // r3).
        items[69] = Item(
            "repatriationFacet",
            address(new RepatriationFacet()),
            _getRepatriationSelectors()
        );
        // #1132 (S10 central enforcement) — terminal-transition register host.
    }

    /// @notice Broadcast one bounded diamondCut for `cuts[start..end)`.
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
            address newImpl = address(new VpfiReturnSender());
            UUPSUpgradeable(proxy).upgradeToAndCall(newImpl, "");
            Deployments.writeVpfiReturnSenderImpl(newImpl);
            console.log(
                "P2-w5: upgraded VpfiReturnSender (wire gen",
                gen,
                "-> 2) impl:",
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
            address newImpl = address(new VpfiReturnReceiver());
            UUPSUpgradeable(proxy).upgradeToAndCall(newImpl, "");
            Deployments.writeVpfiReturnReceiverImpl(newImpl);
            console.log(
                "P2-w5: upgraded VpfiReturnReceiver (wire gen",
                gen,
                "-> 2) impl:",
                newImpl
            );
        }
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
        string memory path = string.concat(
            "deployments/",
            Deployments.slugForChainId(block.chainid),
            "/addresses.json"
        );
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
