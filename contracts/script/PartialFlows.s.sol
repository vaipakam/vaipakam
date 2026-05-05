// script/PartialFlows.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseSepoliaPartialFlows} from "./BaseSepoliaPartialFlows.s.sol";
import {AnvilNewPartialFlows} from "./AnvilNewPartialFlows.s.sol";

/**
 * @title PartialFlows
 * @notice Full UI-midpoint suite — chain-agnostic. Composes the
 *         original midpoint suite (`BaseSepoliaPartialFlows.s.sol`,
 *         6 scenarios) and the newer-features midpoint suite
 *         (`AnvilNewPartialFlows.s.sol`, 7 scenarios) into a single
 *         entry point. Each scenario walks the diamond to a specific
 *         mid-cycle state and stops there, leaving the chain ready
 *         for manual frontend / hf-watcher / keeper-bot inspection.
 *
 *         **Phase A — legacy 6 midpoint states**:
 *           A. Open lender offer  — accept from the borrower UI.
 *           B. Open borrower offer — accept from the lender UI.
 *           C. Active liquid loan — repay / add collateral / preclose
 *              from the borrower UI; observe HF/LTV from either side.
 *           D. Repaid-but-unclaimed loan — Claim Center on both sides.
 *           E. Active ERC721-collateral loan — NFT collateral surfaces.
 *           F. Active rental loan — rental position UI.
 *
 *         **Phase B — new-features 7 midpoint states**:
 *           P-G  3 offer states: fully-filled, partial-filled (open).
 *           P-N  Loan with one partial-repay applied, principal
 *                reduced, status still Active.
 *           P-O  Loan with collateral doubled mid-flight.
 *           P-P  Keeper enabled with INIT_PRECLOSE on an active loan.
 *           P-Q  Borrower-side refinance offer posted, no acceptance.
 *           P-R  Stray ERC-20 token sitting in user escrow (recovery
 *                preview state).
 *           P-S  Dual claimable — same wallet has both lender + borrower
 *                claims pending side-by-side.
 *
 *         Phase B explicitly uses fresh participants/allowances per
 *         its own design (see header in `AnvilNewPartialFlows.s.sol`),
 *         so it doesn't conflict with Phase A's end-state on the same
 *         chain.
 *
 *         Both halves resolve the diamond address from `Deployments`
 *         and read the standard env-var topology — chain-agnostic.
 *
 *         Composition note: identical pattern to `PositiveFlows.s.sol`
 *         — each child's `external run()` is dispatched via an
 *         in-memory script instance; the wrapper itself emits no
 *         broadcast txns of its own.
 */
contract PartialFlows is Script {
    function run() external {
        // ── Phase A: legacy 6 midpoint states ────────────────────────
        console.log("");
        console.log("[PartialFlows] =========================================");
        console.log("[PartialFlows] Phase A: legacy 6 UI-midpoint scenarios");
        console.log("[PartialFlows] =========================================");
        BaseSepoliaPartialFlows phaseA = new BaseSepoliaPartialFlows();
        phaseA.run();

        // ── Phase B: new-features 7 midpoint states ──────────────────
        console.log("");
        console.log("[PartialFlows] =========================================");
        console.log("[PartialFlows] Phase B: new-features 7 midpoint scenarios");
        console.log("[PartialFlows] =========================================");
        AnvilNewPartialFlows phaseB = new AnvilNewPartialFlows();
        phaseB.run();

        console.log("");
        console.log("[PartialFlows] =========================================");
        console.log("[PartialFlows] All 13 partial-flow midpoints populated.");
        console.log("[PartialFlows] =========================================");
    }
}
