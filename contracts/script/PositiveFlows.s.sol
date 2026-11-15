// script/PositiveFlows.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {PositiveFlowsBase} from "./positive-flows/PositiveFlowsBase.sol";
import {PositiveFlowsBasicLifecycle} from "./positive-flows/PositiveFlowsBasicLifecycle.s.sol";
import {PositiveFlowsAdvancedCredit} from "./positive-flows/PositiveFlowsAdvancedCredit.s.sol";
import {PositiveFlowsVaultAndVpfi} from "./positive-flows/PositiveFlowsVaultAndVpfi.s.sol";
import {PositiveFlowsKeeperAutomation} from "./positive-flows/PositiveFlowsKeeperAutomation.s.sol";
import {PositiveFlowsOperatorAdmin} from "./positive-flows/PositiveFlowsOperatorAdmin.s.sol";
import {PositiveFlowsPositionHolder} from "./positive-flows/PositiveFlowsPositionHolder.s.sol";
import {PositiveFlowsLenderIntent} from "./positive-flows/PositiveFlowsLenderIntent.s.sol";
import {PositiveFlowsSwapToRepay} from "./positive-flows/PositiveFlowsSwapToRepay.s.sol";
import {PositiveFlowsTimed} from "./positive-flows/PositiveFlowsTimed.s.sol";

/**
 * @title PositiveFlows
 * @notice Thin runner over the positive-flow modules in
 *         `script/positive-flows/` (#848 Phase 1). It runs each module in turn
 *         and adds nothing of its own: every module builds its own fixture and
 *         can be run alone. It is a SMOKE suite over the scriptable rows of
 *         `docs/TestScopes/PositiveFlowCoverage.md`, not the whole catalog;
 *         the catalog's "Script module map" says which rows each module walks,
 *         and its gap list says what no module covers yet.
 *
 *         Modules, in run order:
 *           - PositiveFlowsBasicLifecycle: ERC-20, NFT-collateral, rental and
 *             illiquid loans opened, closed and claimed; preclose.
 *           - PositiveFlowsAdvancedCredit: partial repay, refinance, range
 *             match and partial fill, preclose options 2 and 3, lender sale
 *             and the sale solvency floor on both sale routes.
 *           - PositiveFlowsVaultAndVpfi: stuck-token recovery, the
 *             sanctioned-source ban, disown, VPFI deposit and withdraw.
 *           - PositiveFlowsKeeperAutomation: keeper approval and execution.
 *           - PositiveFlowsOperatorAdmin: sanctions Tier-1 vs Tier-2, pauses,
 *             treasury accrual and withdrawal, an admin fee knob inside its bounds.
 *           - PositiveFlowsPositionHolder: a transferred position NFT moves
 *             its side's authority and proceeds to the new holder (#848
 *             Phase 2).
 *           - PositiveFlowsLenderIntent: a standing lender intent registered,
 *             funded, filled by a solver, paused, withdrawn and rolled.
 *           - PositiveFlowsSwapToRepay: full and partial swap-to-repay
 *             through a fixed-rate adapter, every share of the proceeds
 *             accounted for.
 *           - PositiveFlowsTimed: offer cancel after the cancel cooldown and a
 *             due periodic-interest checkpoint. These need the chain clock to
 *             move between two steps, so here they SKIP wherever the wait
 *             applies and name their staged run,
 *             `script/positive-flows/run-timed.sh`.
 *         The catalog's cross-chain module is not written here: a forge
 *         script runs on one chain. The cross-chain flows are driven on two
 *         local Anvil chains by `packages/protocol-e2e` instead, and this
 *         runner does not claim them.
 *
 *         Selection: `ONLY_SCENARIO=<id>` (a flow id such as `PF-230-floor`)
 *         runs that one scenario in the module that carries it; an id no
 *         module carries is refused.
 *
 *         Where it may run: a local Anvil, or a chain named in
 *         `REHEARSAL_ALLOW_CHAIN_ID` (see {PositiveFlowsBase}: the fixture
 *         re-points the Diamond's oracle and sanctions oracle at its mocks).
 *
 *         How to run it. This runner is a SIMULATION: it runs every
 *         scenario against the chain's real state and deployed bytecode, and
 *         sends nothing.
 *
 *             forge script script/PositiveFlows.s.sol \
 *               --rpc-url <rpc> --disable-block-gas-limit --skip-simulation
 *
 *         `--skip-simulation`: without it forge replays the recorded
 *         transactions against the chain after the run, at the chain's own
 *         clock, without the clock steps the scenarios took between posting
 *         and filling, and reports "Simulated execution failed" although
 *         every scenario passed.
 *
 *         It cannot be broadcast. Its scenarios post terms and then fill them,
 *         and a fill waits until the terms have stood the minimum age (#3412),
 *         which one `forge script --broadcast` cannot do between its own
 *         transactions; under `--broadcast` the first such fill stops the run
 *         with `TermsAgeNeedsStagedRun` before anything is sent. The modules
 *         that are staged ({PositiveFlowsStaged}: BasicLifecycle,
 *         AdvancedCredit, LenderIntent, PositionHolder) broadcast one at a
 *         time through `script/positive-flows/run-staged.sh <module>`.
 *         {PositiveFlowsTimed} has its own stages (`run-timed.sh`), whose open
 *         stage also fills a fresh offer and so stops the same way until it
 *         moves onto the staged runner (#3574); the others run as this
 *         simulation only until they are staged.
 *
 *         `--disable-block-gas-limit` is REQUIRED, and is not a workaround for
 *         a contract fault: a forge script runs inside ONE simulated call
 *         frame, `run()`, so the frame's gas is the SUM of every scenario it
 *         runs (about 215M for the full set; tens of millions for one module).
 *         Forge caps a simulated call at the chain's block gas limit (30M on a
 *         default Anvil), so without the flag the frame runs dry part-way and
 *         the next heavy call fails out-of-gas inside a nested read, reported
 *         as whatever error that call's caller maps an out-of-gas to
 *         (measured: `LoanInitiationFailed()`). The flag lifts the cap for the
 *         SIMULATION only. The same holds for a single module run on its own,
 *         and `run-staged.sh` passes it to every stage.
 *
 *         Composition: each `new` below is local to the script runner's own
 *         simulation and is not broadcast; Foundry broadcasts only inside the
 *         `vm.startBroadcast()` windows the modules open themselves.
 */
contract PositiveFlows is Script {
    function run() external {
        string memory only = vm.envOr("ONLY_SCENARIO", string(""));

        PositiveFlowsBase[] memory modules = new PositiveFlowsBase[](9);
        modules[0] = new PositiveFlowsBasicLifecycle();
        modules[1] = new PositiveFlowsAdvancedCredit();
        modules[2] = new PositiveFlowsVaultAndVpfi();
        modules[3] = new PositiveFlowsKeeperAutomation();
        modules[4] = new PositiveFlowsOperatorAdmin();
        modules[5] = new PositiveFlowsPositionHolder();
        modules[6] = new PositiveFlowsLenderIntent();
        modules[7] = new PositiveFlowsSwapToRepay();
        modules[8] = new PositiveFlowsTimed();

        if (bytes(only).length != 0) {
            bool known;
            for (uint256 i = 0; i < modules.length; i++) {
                if (modules[i].hasScenario(only)) known = true;
            }
            require(known, string.concat("PositiveFlows: no module carries ONLY_SCENARIO ", only));
        }

        uint256 passed;
        uint256 skipped;
        for (uint256 i = 0; i < modules.length; i++) {
            (uint256 p, uint256 s) = modules[i].runSelected(only);
            passed += p;
            skipped += s;
        }

        console.log("");
        console.log("[PositiveFlows] ========================================");
        console.log(string.concat("[PositiveFlows] ", vm.toString(passed), " passed, ",
            vm.toString(skipped), " skipped (a skip is not a pass; each says why)"));
        console.log("[PositiveFlows] ========================================");
    }
}
