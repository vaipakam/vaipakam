// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {Signers, Signer} from "../../script/lib/Signers.sol";

/**
 * @notice A `forge script` probe for the deploy rehearsal's two seams
 *         (#3891, design §20 tests 1-4), driven against a local node by
 *         `script/rehearsal-seam.test.sh`.
 *
 * @dev    The seams read the process environment and the node, and both are
 *         deliberately unread under `forge test` (every parallel test shares one
 *         environment). So the real context is the only honest one: a script
 *         run, one process, against a node the test controls.
 */
contract SignerSeamProbe is Script {
    /// Prints the record root this run resolves (reverts where the rule refuses).
    function root() external view {
        console.log("ROOT", Deployments.artifactRoot());
    }

    /// Resolves the DEPLOYER signer and sends 1 wei from it to 0xBEEF.
    function send() external {
        Signer memory s = Signers.role("DEPLOYER");
        console.log("SENDER", s.addr);
        console.log("KEYED", s.key != 0);
        Signers.start(s);
        payable(address(0xBEEF)).transfer(1);
        vm.stopBroadcast();
    }
}
