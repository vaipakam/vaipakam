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

        // #855 — CARRY-FORWARD / REUSE mode. A Diamond/CCIP redeploy that must
        // KEEP the existing canonical VPFI token (not fork a second 23M supply)
        // sets VPFI_TOKEN_REUSE_ADDRESS to that token. We record it as
        // `.vpfiToken` — so `DeployCrosschain` wraps it and `ConfigureVPFIToken`
        // registers it in the NEW diamond — and skip the mint entirely. This is
        // the third outcome alongside fresh-mint (no token yet) and force-rotate.
        // NOTE: the reused token's `minter` still points at the OLD diamond; the
        // operator MUST rotate it to the new diamond via the token owner's
        // `setMinter(newDiamond)` for `TreasuryFacet.mintVPFI` to work — this
        // script only records the address, it can't rotate the minter (owner-only,
        // and post-handover that owner is the timelock).
        address reuse = vm.envOr("VPFI_TOKEN_REUSE_ADDRESS", address(0));
        if (reuse != address(0)) {
            // #857 — CONFLICTING MODES. VPFI_TOKEN_FORCE_REDEPLOY=1 (mint a NEW
            // token) and VPFI_TOKEN_REUSE_ADDRESS (keep the EXISTING one) are
            // mutually exclusive; if both are set the reuse branch would silently
            // win and carry the old token forward while the operator asked for a
            // rotation. Fail fast instead.
            require(
                vm.envOr("VPFI_TOKEN_FORCE_REDEPLOY", uint256(0)) == 0,
                "DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS and VPFI_TOKEN_FORCE_REDEPLOY are mutually exclusive (reuse vs rotate) - unset one"
            );
            // #857 — MATCH the recorded token when present (direct-invocation
            // safety; the shell preflights do this pre-broadcast, but this covers
            // a bare `forge script DeployVPFIToken`). If `.vpfiToken` already
            // records token A and reuse points at a different token B — even one
            // that reports symbol "VPFI"/18 — refuse rather than clobber the
            // artifact + wrap the wrong asset as canonical VPFI.
            address recorded = Deployments.readVpfiTokenOptional();
            require(
                recorded == address(0) || recorded == reuse,
                "DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS != the already-recorded .vpfiToken (refusing to clobber)"
            );
            require(
                reuse.code.length > 0,
                "DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS has no bytecode (not a deployed token)"
            );
            // #857 — validate it is actually a VPFI token, not a copied
            // timelock / USDC / arbitrary proxy address: registering the wrong
            // asset as canonical VPFI would disconnect the real supply/minter
            // path. Require symbol == "VPFI" AND decimals == 18 (VPFIToken's
            // initializer sets exactly these). A non-ERC20 (e.g. the timelock)
            // reverts on symbol()/decimals() → caught → hard error.
            try VPFIToken(reuse).symbol() returns (string memory sym) {
                require(
                    keccak256(bytes(sym)) == keccak256(bytes("VPFI")),
                    "DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS symbol is not VPFI"
                );
            } catch {
                revert("DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS is not an ERC20 (symbol() reverted)");
            }
            try VPFIToken(reuse).decimals() returns (uint8 dec) {
                require(dec == 18, "DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS decimals != 18");
            } catch {
                revert("DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS decimals() reverted");
            }
            Deployments.writeVpfiToken(reuse);
            console.log("VPFI carry-forward: reusing existing canonical token:", reuse);
            console.log("  recorded as .vpfiToken (mint skipped).");
            console.log("  ACTION REQUIRED (owner/timelock, post-deploy):");
            console.log("   1. rotate the token minter -> new diamond:", diamond);
            // #857 — the CCT TokenAdminRegistry keeps pointing VPFI at the OLD
            // LockRelease pool: DeployCrosschain deploys a NEW pool for the new
            // diamond, but ConfigureCcip._registerCct SKIPS setPool when the
            // broadcaster (ADMIN) is not the token owner — which is exactly the
            // post-handover carry-forward case (owner = timelock). So the token
            // owner MUST install the new pool in the registry, else CCIP routes
            // VPFI through the stale pool. Flag it loudly here.
            console.log("   2. as the token OWNER, install the NEW LockRelease pool");
            console.log("      in the CCIP TokenAdminRegistry (setPool) - ConfigureCcip");
            console.log("      skips it when ADMIN != token owner (post-handover).");
            return reuse;
        }

        // #853 Codex P2 — NO-OVERWRITE GUARD. This is a one-time tokenomics
        // deploy: a rerun would mint a SECOND 23M supply, repoint every
        // downstream CCIP/config step at the new proxy, and orphan the first
        // token + its LockRelease pool. Refuse when `.vpfiToken` is already
        // recorded, unless the operator opts in via VPFI_TOKEN_FORCE_REDEPLOY=1
        // (the deliberate rotation/`--fresh` path; the shell sets it from the
        // --fresh flag so an intentional orphan-and-redeploy is authorized).
        // Artifact-only, non-reverting read: a clean first deploy has no
        // `.vpfiToken` yet, and `readVpfiToken()` would otherwise fall through
        // to the mandatory env reader and revert (#853 Codex P1).
        address existing = Deployments.readVpfiTokenOptional();
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
