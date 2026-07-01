// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title ConfigureVPFIToken (canonical VPFI diamond registration)
 * @notice One-shot post-deploy script that REGISTERS the freshly-deployed
 *         canonical VPFI token with the canonical Diamond and flags the chain
 *         as canonical, so `TreasuryFacet.mintVPFI` (and every `s.vpfiToken`
 *         consumer) becomes live.
 *
 * @dev #853 Codex P2. `DeployVPFIToken` deploys the token and points its
 *      minter at the Diamond, but the Diamond itself only mints/uses VPFI once
 *      BOTH `s.vpfiToken` and `s.isCanonicalVpfiChain` are set — and those are
 *      ADMIN_ROLE-gated setters (`VPFITokenFacet.setVPFIToken` /
 *      `setCanonicalVPFIChain`). Because `DeployDiamond` renounces the
 *      deployer's roles at the end of the contracts phase, this wiring cannot
 *      ride the deployer key inside `DeployVPFIToken`; it must be a separate
 *      ADMIN-key broadcast. This script is that step and is folded into
 *      `DiamondConfigSpell` so it runs on every post-deploy configure.
 *
 *      CANONICAL-ONLY. Only the canonical chain (Base 8453 / Base Sepolia
 *      84532) hosts the canonical token + carries the canonical flag; on every
 *      mirror chain this is a no-op (mirrors register their Burn/Mint
 *      `VPFIMirrorToken` via the cross-chain path, and must leave
 *      `isCanonicalVpfiChain` false so they cannot mint locally). The guard
 *      matches `DeployCrosschain`/`DeployVPFIToken`'s own canonical predicate.
 *
 *      Idempotent — both setters short-circuit when the value is unchanged, so
 *      re-running the spell is safe.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY : admin-role key (signs the two setter txs)
 *      Reads `.diamond` + `.vpfiToken` from the active chain's addresses.json.
 */
contract ConfigureVPFIToken is Script {
    function run() external {
        // CANONICAL-ONLY guard — mirror chains never host the canonical token
        // nor carry the canonical flag; skip cleanly so the spell stays a
        // single run-on-every-chain step.
        if (block.chainid != 8453 && block.chainid != 84532) {
            console.log(
                "[ConfigureVPFIToken] skip - mirror chain, no canonical VPFI:",
                block.chainid
            );
            return;
        }

        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        address token = Deployments.readVpfiToken();

        require(diamond != address(0), "ConfigureVPFIToken: diamond not deployed");
        require(
            token != address(0),
            "ConfigureVPFIToken: .vpfiToken not deployed (run DeployVPFIToken first)"
        );

        console.log("=== Configure VPFI Token (canonical registration) ===");
        console.log("Chain id:   ", block.chainid);
        console.log("Diamond:    ", diamond);
        console.log("VPFI token: ", token);

        // Pre-flight role check. `setVPFIToken` / `setCanonicalVPFIChain`
        // enforce `onlyRole(ADMIN_ROLE)`; without it the broadcasts revert
        // on-chain with no useful surface. Mirror ConfigureVPFIBuy's pattern.
        address broadcaster = vm.addr(adminKey);
        require(
            AccessControlFacet(diamond).hasRole(keccak256("ADMIN_ROLE"), broadcaster),
            string.concat(
                "ConfigureVPFIToken: broadcaster ",
                vm.toString(broadcaster),
                " missing ADMIN_ROLE on Diamond"
            )
        );
        console.log("Pre-flight: broadcaster holds ADMIN_ROLE");

        vm.startBroadcast(adminKey);
        VPFITokenFacet d = VPFITokenFacet(diamond);
        d.setVPFIToken(token);
        d.setCanonicalVPFIChain(true);
        vm.stopBroadcast();

        console.log("VPFI token registered + canonical flag set.");
    }
}
