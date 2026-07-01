// script/DeployVPFIToken.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployVPFIToken
 * @notice Deploys the CANONICAL VPFI ERC-20 (UUPS behind an ERC1967Proxy)
 *         and records `.vpfiToken` / `.vpfiTokenImpl` in the active chain's
 *         addresses.json.
 *
 *         The main protocol deploy (`DeployDiamond` → `DeployCrosschain`)
 *         does NOT mint this token — on the canonical chain
 *         `DeployCrosschain` only WRAPS an existing VPFI in the CCIP
 *         LockRelease pool (`Deployments.readVpfiToken()`), and mirror
 *         chains deploy their own `VPFIMirrorToken`. So the canonical token
 *         is a one-time tokenomics deploy that must land BEFORE
 *         `DeployCrosschain` on the canonical chain.
 *
 *         Run this against the canonical chain (e.g. Base Sepolia) after
 *         `DeployDiamond` has recorded the diamond, then run
 *         `DeployCrosschain` (it will now resolve `.vpfiToken`).
 *
 *         Wiring (testnet-admin-owned rehearsal posture — no handover):
 *           - owner            = ADMIN_ADDRESS  (authorizes UUPS upgrades +
 *                                 minter rotation)
 *           - initialMint (23M) = TREASURY_ADDRESS
 *           - minter           = the deployed diamond, so
 *                                 `TreasuryFacet.mintVPFI` can mint through it.
 *
 *         Env: DEPLOYER_PRIVATE_KEY, ADMIN_ADDRESS, TREASURY_ADDRESS.
 */
contract DeployVPFIToken is Script {
    function run() external returns (address token) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address diamond = Deployments.readDiamond();
        require(diamond != address(0), "DeployVPFIToken: diamond not deployed yet");

        // #853 Codex P2 — CANONICAL-CHAIN GUARD. This mints the 23M canonical
        // supply and is only correct on the one chain that hosts canonical VPFI
        // (Base 8453 / Base Sepolia 84532). On a mirror chain the canonical
        // token must NOT exist — mirrors carry a Burn/Mint `VPFIMirrorToken`
        // deployed by `DeployCrosschain`. Running here on a mirror would mint a
        // rogue 23M "canonical" proxy and clobber that chain's `.vpfiToken`
        // artifact, corrupting the state `DeployCrosschain`/`ConfigureCcip`
        // read. Match `DeployCrosschain`'s own `canonical` predicate exactly.
        require(
            block.chainid == 8453 || block.chainid == 84532,
            "DeployVPFIToken: canonical chain only (Base 8453 / Base Sepolia 84532)"
        );

        // #853 Codex P2 — NO-OVERWRITE GUARD. This is a one-time tokenomics
        // deploy: a rerun would mint a SECOND 23M supply, repoint every
        // downstream CCIP/config step at the new proxy, and orphan the first
        // token + its LockRelease pool. Refuse when `.vpfiToken` is already
        // recorded, unless the operator opts in via VPFI_TOKEN_FORCE_REDEPLOY=1
        // (the deliberate rotation/`--fresh` path; the shell sets it from the
        // --fresh flag so an intentional orphan-and-redeploy is authorized).
        address existing = Deployments.readVpfiToken();
        bool forceRedeploy = vm.envOr("VPFI_TOKEN_FORCE_REDEPLOY", uint256(0)) != 0;
        require(
            existing == address(0) || forceRedeploy,
            "DeployVPFIToken: .vpfiToken already set; set VPFI_TOKEN_FORCE_REDEPLOY=1 to redeploy"
        );
        if (existing != address(0)) {
            console.log("VPFI_TOKEN_FORCE_REDEPLOY set - orphaning prior token:", existing);
        }

        vm.startBroadcast(deployerKey);
        VPFIToken impl = new VPFIToken();
        bytes memory initData =
            abi.encodeCall(VPFIToken.initialize, (admin, treasury, diamond));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        token = address(proxy);
        vm.stopBroadcast();

        Deployments.writeVpfiTokenImpl(address(impl));
        Deployments.writeVpfiToken(token);

        console.log("VPFIToken impl:  ", address(impl));
        console.log("VPFIToken proxy: ", token);
        console.log("  owner:         ", admin);
        console.log("  initialMint -> ", treasury);
        console.log("  minter:        ", diamond);
    }
}
