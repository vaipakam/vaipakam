// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {Deployments} from "./Deployments.sol";

/**
 * @title RehearsalChain
 * @notice The ONE rule for where a script that re-points a Diamond at its own
 *         mocks may run (#2763).
 *
 *         The flow fixtures (`PositiveFlowsBase`, `AnvilNegativeFlows`,
 *         `AnvilNewPartialFlows`, `BaseSepoliaPartialFlows`) and the Sepolia
 *         seeding scripts (`SepoliaOpenOffers`, `SepoliaActiveLoan`) deploy a
 *         fresh Chainlink registry, ETH/USD feed, WETH and (some of them) a
 *         sanctions oracle, then broadcast the admin setters that make the
 *         target Diamond read them. Pointed at a shared Diamond, that replaces
 *         the chain's live price and sanctions sources with values anyone can
 *         move. Only `PositiveFlowsBase` refused such a chain; the others ran
 *         wherever their key reached.
 *
 *         The rule:
 *           - a local Anvil (31337) is always allowed;
 *           - a production chain (anything `Deployments` does not know as a
 *             testnet) is never allowed, whatever the environment says;
 *           - a known testnet is allowed only when `REHEARSAL_ALLOW_CHAIN_ID`
 *             names it, which is meant for a Diamond deployed for the
 *             rehearsal, never the chain's shared one.
 */
library RehearsalChain {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Reverts unless the current chain may host a mock-wiring run.
    /// @param script The calling script's name, for the refusal message.
    function requireRehearsalChain(string memory script) internal view {
        if (block.chainid == 31337) return;
        if (Deployments.requiresProductionGovernance()) {
            revert(string.concat(
                script, ": chain ", VM.toString(block.chainid),
                " is a production chain. This script points the Diamond's oracle",
                " (and sanctions oracle, where it sets one) at mocks it deploys, so it",
                " never runs there"
            ));
        }
        uint256 allowed = VM.envOr("REHEARSAL_ALLOW_CHAIN_ID", uint256(0));
        if (allowed != block.chainid) {
            revert(string.concat(
                script, ": chain ", VM.toString(block.chainid),
                " is not a local Anvil. This script points the Diamond's oracle",
                " (and sanctions oracle, where it sets one) at mocks it deploys; set",
                " REHEARSAL_ALLOW_CHAIN_ID to this chain id only for a Diamond",
                " deployed for the rehearsal, never the chain's shared one"
            ));
        }
    }
}
