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
    /// @notice The one canonical predicate: is THIS the chain that hosts the
    ///         canonical VPFI ERC-20? (Base 8453 / Base Sepolia 84532.) Matches
    ///         `DeployCrosschain`'s own `canonical` check exactly.
    function _isCanonical() internal view returns (bool) {
        return block.chainid == 8453 || block.chainid == 84532;
    }

    /// @notice SINGLE SOURCE OF TRUTH for the canonical-VPFI token mode. Reads
    ///         env + the recorded artifact + (for reuse) the on-chain token, and
    ///         resolves exactly one of three mutually-exclusive outcomes, failing
    ///         loud on any invalid/ambiguous config. NO broadcast, NO state
    ///         change, NO diamond dependency — so it is safe to call BOTH as a
    ///         pre-broadcast `preflight()` (before [2] DeployDiamond) AND inside
    ///         `run()` at [3b]. Centralising it here is what lets the deploy
    ///         wrappers stay thin (they just call `preflight()` once) instead of
    ///         re-implementing this policy in jq/cast (#855/#857).
    ///
    ///         Outcomes:
    ///           - `isReuse == true`  → carry-forward: keep `reuseToken`, no mint.
    ///           - `isReuse == false` + no recorded token → fresh mint.
    ///           - `isReuse == false` + recorded token + FORCE → rotate (new mint).
    ///
    ///         MUST be called on the canonical chain only (guarded here).
    function _resolveMode() internal view returns (bool isReuse, address reuseToken) {
        require(
            _isCanonical(),
            "DeployVPFIToken: canonical chain only (Base 8453 / Base Sepolia 84532)"
        );

        address reuse = vm.envOr("VPFI_TOKEN_REUSE_ADDRESS", address(0));
        bool force = vm.envOr("VPFI_TOKEN_FORCE_REDEPLOY", uint256(0)) != 0;
        // `fresh` = the wrapper is running a `--fresh` redeploy. The recorded
        // `.vpfiToken` is still present at this pre-broadcast guard (the archive
        // that clears it runs AFTER preflight), but it is about to be discarded,
        // so it must NOT trip the no-overwrite guard on the mint path — a
        // documented `--fresh` run mints a fresh token without demanding an
        // explicit FORCE. (Set by the wrappers from their `$FRESH` flag.)
        bool fresh = vm.envOr("VPFI_TOKEN_FRESH", uint256(0)) != 0;
        address recorded = Deployments.readVpfiTokenOptional();

        if (reuse != address(0)) {
            // CARRY-FORWARD. Keep the EXISTING canonical token (no forked supply).
            // (1) reuse vs rotate are mutually exclusive.
            require(
                !force,
                "DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS + VPFI_TOKEN_FORCE_REDEPLOY are mutually exclusive (reuse vs rotate) - unset one"
            );
            // (2) if a token is already recorded, the reuse MUST equal it — a
            //     different address (even a VPFI-look-alike) would clobber the
            //     artifact + wrap the wrong asset as canonical VPFI.
            require(
                recorded == address(0) || recorded == reuse,
                "DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS != the recorded .vpfiToken (refusing to clobber)"
            );
            // (3) it must actually be a VPFI token, not a copied timelock / USDC
            //     / proxy. symbol == "VPFI" AND decimals == 18 (what VPFIToken's
            //     initializer sets). A non-ERC20 reverts on the getters → caught.
            require(reuse.code.length > 0, "DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS has no bytecode");
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
            // (4) symbol+decimals ALONE can't tell the canonical VPFIToken apart
            //     from the Burn/Mint `VPFIMirrorToken` (same "VPFI" symbol, same
            //     ERC20 default 18 decimals) or a look-alike ERC20 — wrapping a
            //     mirror as Base's canonical asset would hand DeployCrosschain the
            //     wrong token for the LockRelease pool. Assert the VPFIToken-only
            //     `TOTAL_SUPPLY_CAP()` constant (ERC20Capped surface the mirror
            //     does NOT expose) to pin it to a genuine canonical instance.
            try VPFIToken(reuse).TOTAL_SUPPLY_CAP() returns (uint256 supplyCap) {
                require(
                    supplyCap == 230_000_000 ether,
                    "DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS TOTAL_SUPPLY_CAP != canonical VPFIToken (mirror/look-alike?)"
                );
            } catch {
                revert("DeployVPFIToken: VPFI_TOKEN_REUSE_ADDRESS is not a canonical VPFIToken (TOTAL_SUPPLY_CAP() absent - mirror/look-alike?)");
            }
            return (true, reuse);
        }

        // MINT path. Refuse to silently mint a SECOND 23M supply over an existing
        // recorded token unless the operator opted in: FORCE (deliberate rotation
        // on a live artifact) OR `--fresh` (the recorded token is about to be
        // archived away, so a fresh mint is exactly the documented intent). A
        // clean first deploy has `recorded == address(0)` and proceeds regardless.
        require(
            recorded == address(0) || force || fresh,
            "DeployVPFIToken: .vpfiToken already recorded; carry it forward with VPFI_TOKEN_REUSE_ADDRESS=<token>, rotate with VPFI_TOKEN_FORCE_REDEPLOY=1, or run a --fresh redeploy"
        );
        return (false, address(0));
    }

    /// @notice PRE-BROADCAST validator. The deploy wrappers call this ONCE,
    ///         before `[2] DeployDiamond` and before the `--fresh` archive, so an
    ///         invalid VPFI-token config fails BEFORE anything is broadcast
    ///         (rather than at [3b], after Diamond + Timelock already landed →
    ///         partial deploy). No-op on mirror chains (no canonical VPFI). No
    ///         broadcast, no state change.
    function preflight() external {
        if (!_isCanonical()) {
            console.log("[DeployVPFIToken.preflight] skip - mirror chain, no canonical VPFI:", block.chainid);
            return;
        }
        (bool isReuse, address reuseToken) = _resolveMode();
        if (isReuse) {
            console.log("[DeployVPFIToken.preflight] OK - CARRY-FORWARD reuse of:", reuseToken);
            console.log("  (mint skipped; post-deploy you MUST rotate its minter to");
            console.log("   the new diamond AND, as token owner, install the new CCIP");
            console.log("   LockRelease pool in the TokenAdminRegistry.)");
        } else if (Deployments.readVpfiTokenOptional() != address(0)) {
            console.log("[DeployVPFIToken.preflight] OK - FORCE ROTATE: a NEW 23M canonical token will be minted (old one orphaned)");
        } else {
            console.log("[DeployVPFIToken.preflight] OK - FRESH MINT of the canonical VPFI token");
        }
    }

    function run() external returns (address token) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address diamond = Deployments.readDiamond();
        require(diamond != address(0), "DeployVPFIToken: diamond not deployed yet");

        // Re-run the SAME validation as preflight() (belt-and-suspenders for a
        // bare `forge script DeployVPFIToken`; the wrapper already gated it).
        (bool isReuse, address reuseToken) = _resolveMode();

        if (isReuse) {
            Deployments.writeVpfiToken(reuseToken);
            console.log("VPFI carry-forward: reusing existing canonical token:", reuseToken);
            console.log("  recorded as .vpfiToken (mint skipped).");
            console.log("  ACTION REQUIRED (owner/timelock, post-deploy):");
            console.log("   1. rotate the token minter -> new diamond:", diamond);
            console.log("   2. as the token OWNER, install the NEW LockRelease pool");
            console.log("      in the CCIP TokenAdminRegistry (setPool) - ConfigureCcip");
            console.log("      skips it when ADMIN != token owner (post-handover).");
            return reuseToken;
        }

        address existing = Deployments.readVpfiTokenOptional();
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
