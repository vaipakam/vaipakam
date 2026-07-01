// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title ConfigureVPFIToken (VPFI diamond registration — canonical + mirror)
 * @notice One-shot post-deploy script that REGISTERS this chain's VPFI token in
 *         the Diamond's `s.vpfiToken` slot so every token-aware path becomes
 *         live: on the canonical chain it also flips `isCanonicalVpfiChain` true
 *         (enabling `TreasuryFacet.mintVPFI`); on mirror chains it registers the
 *         Burn/Mint `vpfiMirror` and leaves the canonical flag FALSE.
 *
 * @dev #853 Codex P1/P2. `DeployVPFIToken` (canonical) and `DeployCrosschain`
 *      (mirror) deploy the token, but the Diamond only mints/uses VPFI once
 *      `s.vpfiToken` is set — and both setters are ADMIN_ROLE-gated
 *      (`VPFITokenFacet.setVPFIToken` / `setCanonicalVPFIChain`). Because
 *      `DeployDiamond` renounces the deployer's roles at the end of the
 *      contracts phase, this wiring must be a separate ADMIN-key broadcast; it
 *      is folded into `DiamondConfigSpell` so it runs on every configure.
 *
 *      REGISTERS ON EVERY CHAIN — earlier this skipped mirrors, which left
 *      `s.vpfiToken` zero on Arb/OP/BNB even though `DeployCrosschain` had
 *      deployed `vpfiMirror`. Mirror runtime paths key off that slot
 *      (`InteractionRewardsFacet.claimInteractionRewards` reverts when it is
 *      zero; VPFI-lending/collateral guards compare against it), so the local
 *      mirror VPFI was unusable. Now: resolve the token per chain (canonical →
 *      `.vpfiToken`, mirror → `.vpfiMirror`) and `setVPFIToken(token)`
 *      everywhere; only the canonical chain also `setCanonicalVPFIChain(true)`
 *      (mirrors must stay false so they can't mint locally — the LockRelease vs
 *      Burn/Mint split). Matches `DeployCrosschain`'s canonical predicate.
 *
 *      Idempotent — both setters short-circuit when the value is unchanged.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY : admin-role key (signs the setter tx(s))
 *      Reads `.diamond` + `.vpfiToken`/`.vpfiMirror` from this chain's
 *      addresses.json.
 */
contract ConfigureVPFIToken is Script {
    function run() external {
        bool canonical = block.chainid == 8453 || block.chainid == 84532;

        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        require(diamond != address(0), "ConfigureVPFIToken: diamond not deployed");

        // Resolve THIS chain's VPFI token: canonical hosts the real
        // `.vpfiToken`; a mirror holds the Burn/Mint `.vpfiMirror`. Both use the
        // json-only optional readers so an absent token is a clean skip below
        // (not a revert) — a `--skip-vpfi` deploy omits [3b]/[4], so there is no
        // token to register, yet `DiamondConfigSpell` must still run the oracle
        // / reward / NFT configures (#855).
        address token = canonical
            ? Deployments.readVpfiTokenOptional()
            : Deployments.readVpfiMirrorOptional();
        if (token == address(0)) {
            console.log(
                canonical
                    ? "[ConfigureVPFIToken] skip - no .vpfiToken recorded (VPFI deploy skipped?) chain:"
                    : "[ConfigureVPFIToken] skip - no .vpfiMirror recorded (VPFI deploy skipped?) chain:",
                block.chainid
            );
            return;
        }

        console.log("=== Configure VPFI Token (diamond registration) ===");
        console.log("Chain id:   ", block.chainid);
        console.log("Canonical:  ", canonical);
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
        // Canonical flag ONLY on the canonical chain — mirrors must stay false
        // so they cannot mint VPFI locally (they receive bridged supply).
        if (canonical) {
            d.setCanonicalVPFIChain(true);
        }
        vm.stopBroadcast();

        console.log(
            canonical
                ? "VPFI token registered + canonical flag set."
                : "Mirror VPFI token registered (canonical flag left false)."
        );
    }
}
