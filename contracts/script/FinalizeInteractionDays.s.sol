// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title FinalizeInteractionDays
 * @notice TESTNET one-shot: puts a single testnet Diamond into
 *         "single-chain reward mesh" mode and closes + finalizes every
 *         elapsed interaction-reward day, so `claimInteractionRewards`
 *         and the reward previews stop reading zero.
 *
 *         Why this exists: day finalization normally waits for a
 *         cross-chain report from EVERY chain in
 *         `expectedSourceChainIds` (the CCIP reward mesh). On a testnet
 *         where the mesh isn't wired yet, days never finalize and
 *         rewards stay unclaimable. The canonical-chain path needs NO
 *         messenger — `closeDay` records the local report directly and
 *         `finalizeDay` reaches full coverage when the chain expects
 *         only itself. This script wires exactly that:
 *
 *           1. (idempotent) declares this chain canonical for rewards
 *              and its own base chain:
 *              `setIsCanonicalRewardChain(true)` +
 *              `setBaseChainId(block.chainid)`.
 *           2. (idempotent) `setExpectedSourceChainIds([block.chainid])`
 *              — the aggregator expects only this chain, so one local
 *              report = full coverage, no grace wait.
 *           3. For every ELAPSED day (0 .. currentDay-1, bounded by
 *              FINALIZE_MAX_DAYS): `closeDay(day)` if not yet reported,
 *              then `finalizeDay(day)` if ready.
 *
 *         When the real multi-chain mesh comes online later, re-run
 *         `setExpectedSourceChainIds` with the full chain list — this
 *         script's single-chain setting is a testnet convenience, not
 *         a permanent config.
 *
 * @dev   TESTNET ONLY (guarded). Required env:
 *          - ADMIN_PRIVATE_KEY : holds ADMIN_ROLE on the Diamond.
 *        Optional env:
 *          - FINALIZE_FROM_DAY : first day index to process (default 0).
 *          - FINALIZE_MAX_DAYS : max days to close per run (default 30;
 *            re-run to continue — keeps a single run's gas bounded).
 *
 *        Run (per chain):
 *          source .env && forge script script/FinalizeInteractionDays.s.sol \
 *            --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow
 *
 *        Idempotent: already-reported days are skipped, already-
 *        finalized days are skipped, and the identity setters re-assign
 *        the same values harmlessly on re-runs.
 */
contract FinalizeInteractionDays is Script {
    function run() external {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || cid == 11155111 || cid == 97 || cid == 421614 || cid == 11155420 || cid == 31337,
            "FinalizeInteractionDays: testnets only"
        );

        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        uint256 fromDay = vm.envOr("FINALIZE_FROM_DAY", uint256(0));
        uint256 maxDays = vm.envOr("FINALIZE_MAX_DAYS", uint256(30));
        // Bound the SCAN too, not just finalizations: with the default
        // FROM_DAY=0 a long-running testnet would re-inspect every
        // already-finalized day (an RPC view call each) before reaching
        // the backlog. When the cap trips, the log tells the operator
        // what FINALIZE_FROM_DAY to pass next.
        uint256 scanCap = vm.envOr("FINALIZE_SCAN_CAP", uint256(500));

        InteractionRewardsFacet ir = InteractionRewardsFacet(diamond);
        RewardReporterFacet rr = RewardReporterFacet(diamond);
        RewardAggregatorFacet ra = RewardAggregatorFacet(diamond);

        (uint256 today, bool active) = ir.getInteractionCurrentDay();
        require(
            active,
            "FinalizeInteractionDays: interaction rewards not launched (run SetInteractionLaunch first)"
        );
        if (today == 0) {
            console.log("Day 0 is still accruing - nothing elapsed to finalize yet.");
            return;
        }

        console.log("=== Finalize Interaction-Reward Days ===");
        console.log("Chain id:   ", cid);
        console.log("Diamond:    ", diamond);
        console.log("Current day:", today);
        console.log("(days 0 ..", today - 1, "are elapsed and finalizable)");

        vm.startBroadcast(adminKey);

        // ── Step 1+2: single-chain reward-mesh identity (idempotent) ──
        rr.setIsCanonicalRewardChain(true);
        rr.setBaseChainId(uint32(cid));
        uint32[] memory expected = ra.getExpectedSourceChainIds();
        bool expectedOk = expected.length == 1 && expected[0] == uint32(cid);
        if (!expectedOk) {
            uint32[] memory one = new uint32[](1);
            one[0] = uint32(cid);
            ra.setExpectedSourceChainIds(one);
            console.log("expectedSourceChainIds set to [this chain]");
        } else {
            console.log("expectedSourceChainIds already [this chain]");
        }

        // ── Step 3: close + finalize every elapsed, unfinalized day ──
        uint256 processed;
        uint256 scanned;
        uint256 d = fromDay;
        for (; d < today && processed < maxDays && scanned < scanCap; ++d) {
            ++scanned;
            (bool finalized, , ) = ra.getDailyGlobalInterest(d);
            if (finalized) continue;

            if (rr.getChainReportSentAt(d) == 0) {
                rr.closeDay(d);
            }
            (bool ready, uint8 reason) = ra.isDayReadyToFinalize(d);
            if (ready) {
                ra.finalizeDay(d);
                console.log("  day finalized:", d);
                ++processed;
            } else {
                // reason: 1 = already finalized, 2 = no reports yet,
                // 3 = waiting for more reports / grace window.
                console.log("  day NOT ready:", d, "reason:", reason);
            }
        }

        vm.stopBroadcast();

        if (scanned >= scanCap && d < today) {
            console.log("");
            console.log("Scan cap reached at day", d - 1, "- re-run with:");
            console.log("  FINALIZE_FROM_DAY =", d);
        }

        console.log("");
        console.log("Done. Verify a day, then claim from a rewarded wallet:");
        console.log("  cast call <diamond> 'getDailyGlobalInterest(uint256)(bool,uint256,uint256)' <day>");
        console.log("  cast call <diamond> 'previewInteractionRewards(address)' <wallet>");
        console.log("  claimInteractionRewards() -- from the wallet (or the website once surfaced)");
        console.log("Re-run this script daily (or after FINALIZE_MAX_DAYS chunks) to keep days closing.");
    }
}
