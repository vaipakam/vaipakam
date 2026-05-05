// script/NegativeFlows.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AnvilNegativeFlows} from "./AnvilNegativeFlows.s.sol";

/**
 * @title NegativeFlows
 * @notice Full negative-flow suite — chain-agnostic. There is only
 *         one negative-flow source script today
 *         (`AnvilNegativeFlows.s.sol`, 9 scenarios), so this entry
 *         is a thin chain-agnostic name + dispatch over it. Kept
 *         alongside `PositiveFlows.s.sol` and `PartialFlows.s.sol`
 *         for naming uniformity — operators run any of the three
 *         under `forge script script/<Flow>Flows.s.sol --rpc-url
 *         <RPC> --broadcast --slow` regardless of which chain they
 *         point at.
 *
 *         Scenarios covered (each must revert / be rejected by the
 *         protocol — every one is a NEG-prefixed expectation):
 *           NEG-1  Range bounds — amountMin > amountMax rejected at
 *                  createOffer.
 *           NEG-2  Range bounds — interestRateBpsMin >
 *                  interestRateBpsMax rejected at createOffer.
 *           NEG-3  Fallback consent — accept of an illiquid-asset
 *                  offer without explicit dual-consent reverts.
 *           NEG-4  Self-collateralized offer — create with
 *                  lendingAsset == collateralAsset reverts.
 *           NEG-5  Zero duration — durationDays == 0 rejected.
 *           NEG-6  Collateral floor — lender offer with
 *                  collateralAmount below the system-derived
 *                  minimum (LTV / liquidation threshold) reverts.
 *           NEG-7  Claim before terminal — claimAsLender /
 *                  claimAsBorrower on a loan still in Active state
 *                  reverts.
 *           NEG-8  Partial repay opt-out — partialRepay on a loan
 *                  whose offer never set `allowsPartialRepay`
 *                  reverts.
 *           NEG-9  Sanctions Tier-1 — sanctioned address attempting
 *                  any state-creating call (createOffer, acceptOffer,
 *                  getOrCreateUserEscrow, VPFI deposit/buy/withdraw)
 *                  reverts; Tier-2 close-out paths (repayLoan,
 *                  markDefaulted) stay open so the unflagged
 *                  counterparty can be made whole.
 *
 *         Composition note: identical pattern to
 *         `PositiveFlows.s.sol` and `PartialFlows.s.sol` — the
 *         child's `external run()` dispatches in-memory; no extra
 *         broadcast txns are emitted by the wrapper itself.
 */
contract NegativeFlows is Script {
    function run() external {
        console.log("");
        console.log("[NegativeFlows] ==========================================");
        console.log("[NegativeFlows] Full 9-scenario negative-flow suite");
        console.log("[NegativeFlows] ==========================================");
        AnvilNegativeFlows phase = new AnvilNegativeFlows();
        phase.run();
        console.log("");
        console.log("[NegativeFlows] ==========================================");
        console.log("[NegativeFlows] All 9 negative-flow scenarios complete.");
        console.log("[NegativeFlows] ==========================================");
    }
}
