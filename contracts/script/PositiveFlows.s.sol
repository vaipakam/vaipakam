// script/PositiveFlows.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SepoliaPositiveFlows} from "./SepoliaPositiveFlows.s.sol";
import {AnvilNewPositiveFlows} from "./AnvilNewPositiveFlows.s.sol";

/**
 * @title PositiveFlows
 * @notice Full positive-flow E2E suite — chain-agnostic. Composes the
 *         original lifecycle suite (`SepoliaPositiveFlows.s.sol`,
 *         15 scenarios) and the newer-features suite
 *         (`AnvilNewPositiveFlows.s.sol`, 18 scenarios) into a single
 *         entry point that exercises every protocol surface end-to-end
 *         on whatever chain the operator points it at.
 *
 *         The two halves cover disjoint surface areas:
 *
 *         **Phase A — legacy 15 scenarios** (lifecycle backbone):
 *           - Liquid ERC-20 lending: create/accept/repay/default/claim,
 *             third-party repay, fallback collateral split.
 *           - Illiquid ERC-20 lending — full-collateral transfer on
 *             default (no DEX swap path).
 *           - ERC-721 + ERC-1155 collateral.
 *           - ERC-721 + ERC-1155 rentals (daily prepay deductions).
 *           - Illiquid lending + illiquid collateral — dual fallback
 *             consent on both legs.
 *           - Illiquid lending + liquid collateral.
 *
 *         **Phase B — new-features 18 scenarios** (recent surfaces):
 *           - Range orders (`amountMin/amountMax`,
 *             `interestRateBpsMin/Max`) + bot-driven matchOffers.
 *           - Lender-side partial fills + dust auto-close.
 *           - Lender opt-in `allowsPartialRepay` — borrower repays
 *             30% mid-loan then full close.
 *           - Refinance — cross-lender swap via borrower offer.
 *           - Preclose 2/3 — direct + offset.
 *           - Stuck-token recovery happy path + sanctioned-source ban.
 *           - Disown (escrow ownership transfer).
 *           - Sanctions Tier-1 vs Tier-2 gating semantics.
 *           - Keeper per-action authorization.
 *           - VPFI staking + discount accumulator + claim rebate +
 *             unstake.
 *           - Per-asset pause + global pause + master-flag dormancy.
 *           - Treasury accrual.
 *           - sellLoanViaBuyOffer (lender early-withdrawal via buy
 *             offer).
 *
 *         Phase A and Phase B share env vars (`PRIVATE_KEY`,
 *         `ADMIN_PRIVATE_KEY`, `LENDER_PRIVATE_KEY`,
 *         `BORROWER_PRIVATE_KEY`, `NEW_LENDER_PRIVATE_KEY`,
 *         `NEW_BORROWER_PRIVATE_KEY`, plus the `*_ADDRESS` companion
 *         vars) and resolve the diamond address from
 *         `Deployments.lib`'s consolidated registry — both halves are
 *         already chain-agnostic, so the merged entry inherits that
 *         property without further work.
 *
 *         Run order: Phase A first (lifecycle backbone establishes a
 *         working market), Phase B after (new features assume a
 *         healthy diamond). Both halves use distinct scenario
 *         participants where possible; where they overlap, Phase B
 *         re-bootstraps the participant's allowances + escrow before
 *         exercising the new surface, so prior end-state from Phase A
 *         doesn't poison Phase B's assertions.
 *
 *         Note on composition vs inline-merge: the underlying scripts'
 *         `run()` functions are declared `external`, so the merged
 *         entry composes by instantiating each child in the script's
 *         simulation memory and dispatching through the external
 *         interface. Each `new` here is local to the script-runner's
 *         own EVM simulation and is NOT broadcast as a real
 *         deployment — Foundry only broadcasts inside active
 *         `vm.startBroadcast()` windows, which the children open
 *         themselves once their `run()` executes. The visible on-chain
 *         effect is the union of the two children's broadcasts in
 *         order; no extra deploy txns are emitted by the wrapper.
 */
contract PositiveFlows is Script {
    function run() external {
        // ── Phase A: legacy 15 scenarios ─────────────────────────────
        console.log("");
        console.log("[PositiveFlows] ========================================");
        console.log("[PositiveFlows] Phase A: legacy 15 lifecycle scenarios");
        console.log("[PositiveFlows] ========================================");
        SepoliaPositiveFlows phaseA = new SepoliaPositiveFlows();
        phaseA.run();

        // ── Phase B: new-features 18 scenarios ───────────────────────
        console.log("");
        console.log("[PositiveFlows] ========================================");
        console.log("[PositiveFlows] Phase B: new-features 18 scenarios");
        console.log("[PositiveFlows] ========================================");
        AnvilNewPositiveFlows phaseB = new AnvilNewPositiveFlows();
        phaseB.run();

        console.log("");
        console.log("[PositiveFlows] ========================================");
        console.log("[PositiveFlows] All 33 positive-flow scenarios complete.");
        console.log("[PositiveFlows] ========================================");
    }
}
