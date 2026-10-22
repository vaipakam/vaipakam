// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {Deployments} from "./lib/Deployments.sol";
import {HandoverPlan} from "./lib/HandoverPlan.sol";

/**
 * @title Handover
 * @notice Post-deploy ADMIN → governance handover for the Vaipakam
 *         protocol surface on a single chain.
 *
 * @dev Context. After `DeployDiamond.s.sol` completes, the ADMIN
 *      EOA (per .env's `ADMIN_ADDRESS`) holds:
 *        - DEFAULT_ADMIN_ROLE (root admin gating every other role)
 *        - ADMIN_ROLE / PAUSER_ROLE / KYC_ADMIN_ROLE /
 *          ORACLE_ADMIN_ROLE / RISK_ADMIN_ROLE / VAULT_ADMIN_ROLE
 *        - WATCHER_ROLE + NOTIF_BILLER_ROLE + KEEPER_ROLE (the
 *          off-chain bot roles)
 *        - ERC-173 ownership of the Diamond (gates `diamondCut`)
 *        - Ownable2Step ownership of every CCIP cross-chain contract
 *          deployed on this chain — `CcipMessenger`, the VPFI
 *          `TokenPool`, `VpfiPoolRateGovernor`, `VaipakamRewardMessenger`,
 *          and the chain-scoped `VPFIMirrorToken` (mirror). `DeployCrosschain`
 *          initializes every one with ADMIN as owner — and `ConfigureCcip`
 *          accepts the pool's `Ownable2Step` handover as ADMIN — so the
 *          whole CCIP stack is ADMIN-owned through the `ccip-wire`
 *          window; the lane / channel / rate-limit config calls are all
 *          signed by the single ADMIN EOA.
 *        - The CCT admin — the CCIP `TokenAdminRegistry` administrator
 *          for VPFI — also held on ADMIN (set by `ConfigureCcip`).
 *
 *      This script (run as ADMIN against a single chain at
 *      `--phase handover`) hands every long-lived authority off to
 *      the governance topology defined in the project's three-Safe
 *      model and renounces ADMIN's authority before exit:
 *
 *        1. DEFAULT_ADMIN_ROLE → Timelock  (owner decision D1,
 *           2026-10-16, #934). Every grant, every rotation of the role
 *           root and `transferAdmin` itself wait out the Timelock delay.
 *           Before D1 this went to the governance Safe directly, which
 *           let the Safe re-grant any Timelock-held role to a hot key —
 *           or `transferAdmin` the whole Diamond — in one zero-delay
 *           transaction, so the "48h review window" was not a boundary.
 *        1b. EMERGENCY_REVOKER_ROLE → EMERGENCY_REVOKER_ADDRESS (the
 *           governance Safe, direct). The ONE zero-delay lever the Safe
 *           keeps: `emergencyRevokeRole`, which can only strip a role
 *           from a hot key — never DEFAULT_ADMIN_ROLE, never anything the
 *           Diamond owner (the Timelock) holds.
 *        2. ADMIN_ROLE / KYC / ORACLE / RISK / VAULT → Timelock
 *           (delayed-action surface; routine config edits time-locked)
 *        3. PAUSER_ROLE → PAUSER_ADDRESS  (Pauser Safe, direct —
 *           pause is a fast incident lever, Timelock delay is
 *           anti-feature on it; per memory's ratified design
 *           point #2)
 *        4. ERC-173 Diamond ownership → Timelock  (facet swaps are
 *           governance-tier risk, deserve a time-locked review
 *           window — operator can override later via the multisig
 *           if the model changes)
 *        4b. KEEPER_ROLE / WATCHER_ROLE / NOTIF_BILLER_ROLE → the
 *           bot keys named by KEEPER_ADDRESS / WATCHER_ADDRESS /
 *           NOTIF_BILLER_ADDRESS (#669). Granted here, while ADMIN is
 *           still the role root; afterwards only a Timelock proposal
 *           can grant them. A zero address leaves that role unheld,
 *           on purpose and said so in the output.
 *        5. ADMIN renounces EVERY Diamond role it holds, in the
 *           reverse order of grant (DEFAULT_ADMIN_ROLE last, so
 *           up until the very last call, ADMIN can correct any
 *           mid-flight error). Before #669 the three bot roles stayed
 *           on ADMIN "until the per-bot setup", which no script ever
 *           did, so the admin key stayed live after every handover.
 *        6. CCIP cross-chain ownership + the CCT admin → the Timelock,
 *           via the first leg of each two-step transfer
 *           (`transferOwnership` / `transferAdminRole`). The Timelock
 *           gates UUPS upgrades and lane / rate-limit config, so it
 *           gets the same review-window delay as the Diamond's ERC-173
 *           ownership (step 4) — operator decision, T-068 follow-up.
 *           The Timelock must then `acceptOwnership` on each contract
 *           and `acceptAdminRole` on the registry, executed through its
 *           schedule/execute queue — the multi-party ceremony
 *           component; this script prints the calldata + targets.
 *
 *      AFTER this script lands and AFTER the Timelock accepts every
 *      CCIP contract's pending ownership (and the pending CCT admin
 *      role), `HandoverGate.s.sol` runs as the hard exit gate
 *      (`--phase handover-gate`). It reads the LIVE chain: every
 *      Diamond and Timelock role holder rebuilt from the role events,
 *      the owners and pending owners, the delay. Until #944 the "gate"
 *      was `DeployerZeroRolesTest`, which built its own throwaway
 *      Diamond and passed whatever the chain held.
 *
 *      This script does NOT use Multicall3. AccessControl's
 *      `grantRole`/`renounceRole` and OZ's `transferOwnership` all
 *      key on `msg.sender`; routing through Multicall3.aggregate3
 *      would set `msg.sender = Multicall3` and revert every onlyRole
 *      / onlyOwner check. So each call broadcasts as its own tx
 *      under one `vm.startBroadcast` — Foundry sequences them
 *      automatically.
 *
 * @dev Env-var contract:
 *        ADMIN_PRIVATE_KEY        — signer for every broadcast here
 *        ADMIN_ADDRESS            — corresponding EOA, used for renounce
 *        EMERGENCY_REVOKER_ADDRESS — governance Safe address; receives
 *                                   EMERGENCY_REVOKER_ROLE only. (Was
 *                                   DEFAULT_ADMIN_ADDRESS before D1 — the
 *                                   script refuses the old name so a
 *                                   stale .env cannot pass silently.)
 *                                   It must be the Timelock's proposer
 *                                   (TIMELOCK_PROPOSER at DeployTimelock);
 *                                   the script refuses a Timelock that
 *                                   does not grant it PROPOSER_ROLE.
 *        PAUSER_ADDRESS           — Pauser Safe address. The Timelock
 *                                   must already grant it CANCELLER_ROLE
 *                                   (`DeployTimelock` does, from the same
 *                                   variable); the script refuses a
 *                                   Timelock that does not.
 *        KEEPER_ADDRESS /
 *        WATCHER_ADDRESS /
 *        NOTIF_BILLER_ADDRESS     — REQUIRED: the bot key that receives
 *                                   each bot role. Set one to the zero
 *                                   address to leave that role unheld.
 *                                   None may be ADMIN_ADDRESS, a Safe,
 *                                   the Timelock or the Diamond.
 *        CCIP_TOKEN_ADMIN_REGISTRY — optional; the chain's CCIP
 *                                   `TokenAdminRegistry`. When set, the
 *                                   CCT admin for VPFI is rotated to the
 *                                   Timelock; when unset, that leg is
 *                                   skipped with a notice.
 *        ADDRESSES_JSON_PATH      — optional override; defaults to
 *                                   contracts/deployments/<slug>/
 *                                   addresses.json. The script reads
 *                                   the slug from CHAIN_SLUG env if
 *                                   ADDRESSES_JSON_PATH is unset.
 *
 *      Reads `diamond` and `timelock` from addresses.json, and the
 *      two-step-owned targets through `HandoverPlan.read` — the same
 *      list `HandoverGate` verifies, so the two cannot drift.
 */
contract Handover is Script {
    /// @notice Everything one handover acts on, resolved before the first
    ///         broadcast. `run()` builds it from the environment and the
    ///         chain's `addresses.json`; a test builds it directly.
    struct Config {
        uint256 adminKey;
        address admin;
        address governanceSafe;
        address pauserSafe;
        address diamond;
        address timelock;
        /// @dev Parallel to `HandoverPlan.botRoles()`. A zero entry leaves
        ///      that role unheld once the admin renounces it.
        address[] botHolders;
        HandoverPlan.Target[] targets;
        /// @dev The chain's VPFI ERC-20, whose CCT administrator rotates.
        address vpfiToken;
        /// @dev The CCIP `TokenAdminRegistry`; zero skips the CCT leg.
        address cctRegistry;
    }

    function run() external {
        _execute(_loadConfig());
    }

    /// @dev Reads the handover's inputs. Every bot-role holder is REQUIRED:
    ///      an unset variable reverts here rather than leaving that role on
    ///      the admin key or silently unheld. Set it to the zero address to
    ///      leave the role unheld on purpose.
    function _loadConfig() internal returns (Config memory c) {
        c.adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        c.admin = vm.envAddress("ADMIN_ADDRESS");
        // D1 renamed the Safe's variable: it no longer receives
        // DEFAULT_ADMIN_ROLE. Refuse the old name outright — a stale .env
        // that still says DEFAULT_ADMIN_ADDRESS describes the retired
        // topology, and reading it under the new meaning would hide that.
        require(
            vm.envOr("DEFAULT_ADMIN_ADDRESS", address(0)) == address(0),
            "DEFAULT_ADMIN_ADDRESS is retired (D1): set EMERGENCY_REVOKER_ADDRESS to the governance Safe and unset DEFAULT_ADMIN_ADDRESS"
        );
        c.governanceSafe = vm.envAddress("EMERGENCY_REVOKER_ADDRESS");
        c.pauserSafe = vm.envAddress("PAUSER_ADDRESS");

        string[] memory botEnv = HandoverPlan.botRoleEnvNames();
        c.botHolders = new address[](botEnv.length);
        for (uint256 i; i < botEnv.length; ++i) {
            c.botHolders[i] = vm.envAddress(botEnv[i]);
        }

        string memory addressesPath = _resolveAddressesPath();
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory addrJson = vm.readFile(addressesPath);
        c.diamond = _readAddrOrRevert(addrJson, "diamond", addressesPath);
        c.timelock = _readAddrOrRevert(addrJson, "timelock", addressesPath);
        c.targets = HandoverPlan.read(addrJson);
        c.vpfiToken = HandoverPlan.vpfiToken(addrJson);
        c.cctRegistry = vm.envOr("CCIP_TOKEN_ADMIN_REGISTRY", address(0));
    }

    /// @dev The whole handover for one resolved `Config`.
    function _execute(Config memory c) internal {
        _preflight(c);
        _rotateDiamond(c);

        // ── CCIP cross-chain ownership → Timelock ───────────────────────
        // The whole CCIP stack is ADMIN-owned two-step: `DeployCrosschain`
        // initializes every proxy with ADMIN and `ConfigureCcip` accepts the
        // pool's ownership as ADMIN, so every transfer broadcasts as ADMIN.
        // On canonical Base the VPFI token (#853) is in the list too; on a
        // mirror the local ERC-20 is `vpfiMirror`. `transferOwnership` is the
        // first leg; the Timelock accepts later. A target not owned by ADMIN
        // is skipped with a notice — the gate then refuses until it is moved.
        for (uint256 i; i < c.targets.length; ++i) {
            if (c.targets[i].addr == address(0)) continue; // warned in _preflight
            _transferCrossChainOwnership(c.adminKey, c.targets[i].addr, c.targets[i].label, c.timelock);
        }

        // ── CCT admin → Timelock ────────────────────────────────────────
        // The CCIP `TokenAdminRegistry` administrator for VPFI rotates to the
        // Timelock as well — `transferAdminRole` is the first leg of a
        // two-step transfer; the Timelock `acceptAdminRole`s later. Skipped
        // when CCIP_TOKEN_ADMIN_REGISTRY is unset, or when ADMIN is not the
        // current administrator (CCT registration may have been done by a
        // separate token owner — see ConfigureCcip `_registerCct`).
        bool cctRotated = _transferCctAdmin(c.adminKey, c.cctRegistry, c.vpfiToken, c.timelock);

        _printAcceptSteps(c, cctRotated);
    }

    /// @dev Every refusal happens here, before the admin gives anything up.
    function _preflight(Config memory c) internal view {
        // ── The three Safes must be distinct ────────────────────────────
        // The .env.example ships with three different addresses; if the
        // operator pastes the same address into two of them (e.g.
        // accidentally setting PAUSER_ADDRESS to the governance Safe), the
        // role split collapses and we lose the pause-without-Timelock-delay
        // property. Refuse so the misconfig surfaces here, not on incident
        // day.
        require(c.governanceSafe != address(0), "EMERGENCY_REVOKER_ADDRESS unset");
        require(c.pauserSafe != address(0), "PAUSER_ADDRESS unset");
        require(c.governanceSafe != c.admin, "EMERGENCY_REVOKER_ADDRESS == ADMIN_ADDRESS (handover would no-op)");
        require(c.pauserSafe != c.admin, "PAUSER_ADDRESS == ADMIN_ADDRESS (pause role would no-op)");
        require(c.governanceSafe != c.pauserSafe, "EMERGENCY_REVOKER_ADDRESS == PAUSER_ADDRESS (collapses three-Safe model)");
        require(c.timelock != c.admin, "timelock == ADMIN_ADDRESS (handover would no-op)");
        require(
            c.timelock != c.governanceSafe && c.timelock != c.pauserSafe,
            "timelock must be distinct from both Safes"
        );
        // Both Safes must be contracts on THIS chain, on every chain and
        // whichever way the script is invoked (Codex #2642 r9). A role
        // granted to an address with no Safe behind it is either held by
        // an ordinary key (the topology this rehearsal exists to validate,
        // silently replaced) or held by nobody, and the admin renounces
        // right after. `deploy-*.sh --phase handover` checks the same with
        // `cast code`; this is the check that cannot be skipped by running
        // the script directly. The proposer is the governance Safe (bound
        // by the PROPOSER_ROLE check below), so two checks cover all three
        // Safe roles.
        require(c.governanceSafe.code.length > 0, "EMERGENCY_REVOKER_ADDRESS has no code on this chain (not a Safe)");
        require(c.pauserSafe.code.length > 0, "PAUSER_ADDRESS has no code on this chain (not a Safe)");

        // ── Bot keys are bot keys ───────────────────────────────────────
        // A bot role handed to the admin key would leave it holding
        // authority the live gate then refuses; handed to a Safe or the
        // Timelock it would put a hot-path role behind a multisig or a 48h
        // delay. Several bot roles may share one key.
        string[] memory botEnv = HandoverPlan.botRoleEnvNames();
        require(c.botHolders.length == botEnv.length, "bot holder count != HandoverPlan.botRoles()");
        for (uint256 i; i < c.botHolders.length; ++i) {
            address b = c.botHolders[i];
            if (b == address(0)) continue;
            require(b != c.admin, string.concat(botEnv[i], " == ADMIN_ADDRESS (the admin key must end with no role)"));
            require(
                b != c.governanceSafe && b != c.pauserSafe && b != c.timelock && b != c.diamond,
                string.concat(botEnv[i], " must be a bot key, not a Safe, the Timelock or the Diamond")
            );
        }

        // ── The artifact names every contract this chain must hand over ─
        // A required contract missing from addresses.json would otherwise
        // drop out of the handover and stay on the admin key (#944 r1). On a
        // production chain that is a refusal; a testnet rehearsal may lack
        // part of the stack, so there it is printed and the gate reports it.
        for (uint256 i; i < c.targets.length; ++i) {
            if (c.targets[i].addr != address(0)) continue;
            if (Deployments.requiresProductionGovernance()) {
                revert(string.concat("addresses.json has no ", c.targets[i].label, " - every production chain must hand it over"));
            }
            console.log(string.concat("WARNING: addresses.json has no ", c.targets[i].label, "; nothing to hand over for it"));
        }

        // The Timelock's independent veto (#938) must be the Pauser Safe
        // this script hands PAUSER_ROLE to. `DeployTimelock` reads its
        // canceller from the same PAUSER_ADDRESS, so a mismatch here means
        // the Timelock was deployed under a different .env, and handing the
        // Diamond to it would leave no veto anyone has verified (Codex #2642
        // r1).
        require(
            ITimelockRoles(c.timelock).hasRole(HandoverPlan.CANCELLER_ROLE, c.pauserSafe),
            "timelock does not grant CANCELLER_ROLE to PAUSER_ADDRESS - redeploy it with DeployTimelock"
        );
        // The Governance Safe is ONE Safe: it queues every delayed action
        // (the Timelock's proposer) and holds the emergency revoker. If the
        // Timelock was deployed with a different TIMELOCK_PROPOSER, the Safe
        // named here could revoke but never queue a repair, while an
        // unverified multisig controlled every delayed action (Codex #2642
        // r3). Refuse before the admin gives anything up.
        require(
            ITimelockRoles(c.timelock).hasRole(HandoverPlan.PROPOSER_ROLE, c.governanceSafe),
            "timelock does not grant PROPOSER_ROLE to EMERGENCY_REVOKER_ADDRESS - the Governance Safe must be TIMELOCK_PROPOSER"
        );

        // The Diamond is about to be handed to this Timelock irreversibly,
        // so check its delay here rather than in the post-handover readback
        // (Codex #2642 r4). On any production chain (every chain that is not
        // a known testnet, r5) both the current delay and the permanent
        // floor must be at least 48h; elsewhere the floor must at least be
        // non-zero (a zero floor is a pass-through).
        uint256 tlDelay = ITimelockRoles(c.timelock).getMinDelay();
        uint256 tlFloor = ITimelockRoles(c.timelock).MIN_DELAY_FLOOR();
        require(tlFloor > 0, "timelock has a zero MIN_DELAY_FLOOR - redeploy it with DeployTimelock");
        if (Deployments.requiresProductionGovernance()) {
            require(tlDelay >= 48 hours, "timelock delay < 48h on a production chain");
            require(tlFloor >= 48 hours, "timelock MIN_DELAY_FLOOR < 48h on a production chain");
        }
    }

    /// @dev The Diamond half: roles and ERC-173 ownership, broadcast as ADMIN.
    function _rotateDiamond(Config memory c) internal {
        console.log("Handover plan");
        console.log("  diamond:       ", c.diamond);
        console.log("  timelock:      ", c.timelock);
        console.log("  governance Safe:", c.governanceSafe);
        console.log("  pauser Safe:   ", c.pauserSafe);
        console.log("  admin (renouncing):", c.admin);

        IAccessControl ac = IAccessControl(c.diamond);
        bytes32[] memory tlRoles = HandoverPlan.timelockRoles();
        bytes32[] memory bots = HandoverPlan.botRoles();
        string[] memory botEnv = HandoverPlan.botRoleEnvNames();

        vm.startBroadcast(c.adminKey);

        // a. Grant DEFAULT_ADMIN_ROLE to the Timelock FIRST (D1, #934).
        //    ADMIN keeps it too until the very last call, so if any later
        //    step reverts ADMIN can recover.
        ac.grantRole(HandoverPlan.DEFAULT_ADMIN_ROLE, c.timelock);
        console.log("Granted DEFAULT_ADMIN_ROLE to Timelock");

        // b. The governance Safe's only Diamond authority: the emergency
        //    revoker (D1).
        ac.grantRole(LibAccessControl.EMERGENCY_REVOKER_ROLE, c.governanceSafe);
        console.log("Granted EMERGENCY_REVOKER_ROLE to governance Safe");

        // c. The Timelock-bound roles.
        for (uint256 i; i < tlRoles.length; ++i) {
            ac.grantRole(tlRoles[i], c.timelock);
        }
        console.log("Granted ADMIN/UNPAUSER/KYC/ORACLE/RISK/VAULT to Timelock");

        // d. PAUSER_ROLE to the Pauser Safe (direct, NO Timelock).
        ac.grantRole(LibAccessControl.PAUSER_ROLE, c.pauserSafe);
        console.log("Granted PAUSER_ROLE to pauser Safe");

        // e. Each bot role to its own key (#669). Done HERE, while ADMIN is
        //    still the role root: once it renounces, the only way to grant a
        //    bot role is a Timelock proposal, so a role left on ADMIN "for
        //    later" kept the admin key live and failed the zero-roles gate.
        for (uint256 i; i < bots.length; ++i) {
            if (c.botHolders[i] == address(0)) {
                console.log(string.concat("  ", botEnv[i], " = 0: role left UNHELD (grant it later via the Timelock)"));
                continue;
            }
            ac.grantRole(bots[i], c.botHolders[i]);
            console.log(string.concat("Granted bot role from ", botEnv[i], " to"), c.botHolders[i]);
        }

        // f. Transfer ERC-173 Diamond ownership → Timelock. Future
        //    diamondCut (facet swaps) goes via the Timelock's queue+execute
        //    pattern. `transferOwnership` only accepts a DEFAULT_ADMIN_ROLE
        //    holder (#906), which step a made the Timelock.
        IOwnership(c.diamond).transferOwnership(c.timelock);
        console.log("Transferred ERC-173 Diamond ownership to Timelock");

        // g. ADMIN renounces EVERY role it holds — the bot roles, PAUSER,
        //    the six Timelock roles, then DEFAULT_ADMIN_ROLE LAST (allowed
        //    now that the Timelock, not ADMIN, is the Diamond owner). ADMIN
        //    never held EMERGENCY_REVOKER_ROLE: it is not granted at init,
        //    only in step b (#934).
        for (uint256 i = bots.length; i > 0; --i) {
            ac.renounceRole(bots[i - 1], c.admin);
        }
        ac.renounceRole(LibAccessControl.PAUSER_ROLE, c.admin);
        for (uint256 i = tlRoles.length; i > 0; --i) {
            ac.renounceRole(tlRoles[i - 1], c.admin);
        }
        ac.renounceRole(HandoverPlan.DEFAULT_ADMIN_ROLE, c.admin);
        console.log("Admin renounced every Diamond role (bots, PAUSER, Timelock-bound, DEFAULT_ADMIN)");

        vm.stopBroadcast();
    }

    /// @dev Prints the Timelock-side accept calldata. Each pending transfer
    ///      needs the Timelock to accept it (through its schedule/execute
    ///      queue) before it takes effect. `acceptOwnership()` takes no
    ///      args — the calldata is the bare 4-byte selector.
    function _printAcceptSteps(Config memory c, bool cctRotated) internal view {
        console.log("");
        console.log("=========================================================");
        console.log("NEXT STEP - the Timelock must accept each pending transfer:");
        console.log("=========================================================");
        console.log(
            "  acceptOwnership() selector:",
            vm.toString(abi.encodePacked(bytes4(keccak256("acceptOwnership()"))))
        );
        for (uint256 i; i < c.targets.length; ++i) {
            if (c.targets[i].addr == address(0)) continue;
            console.log(string.concat("    target: ", c.targets[i].label, " @"), c.targets[i].addr);
        }
        if (cctRotated) {
            console.log("  acceptAdminRole(address) on the CCIP TokenAdminRegistry:");
            console.log("    registry:      ", c.cctRegistry);
            console.log("    arg localToken:", c.vpfiToken);
        }
        console.log("");
        console.log("After all are accepted, run the live exit gate:");
        console.log("  deploy-<mainnet|testnet>.sh <slug> --phase handover-gate");
        console.log("(script/HandoverGate.s.sol). The chain is not handed off until it passes.");
    }

    // ── Helpers ────────────────────────────────────────────────────

    function _resolveAddressesPath() internal returns (string memory) {
        try vm.envString("ADDRESSES_JSON_PATH") returns (string memory p) {
            if (bytes(p).length > 0) return p;
        } catch {}
        string memory slug = vm.envString("CHAIN_SLUG");
        require(bytes(slug).length > 0, "Set CHAIN_SLUG or ADDRESSES_JSON_PATH");
        return Deployments.pathForSlug(slug);
    }

    function _readAddrOrRevert(
        string memory json,
        string memory key,
        string memory pathHint
    ) internal view returns (address) {
        // Mirrors Deployments.sol's _readAddr pattern. parseJsonAddress
        // reverts on a missing key; we catch and surface a friendlier
        // diagnostic that names the addresses.json path the operator
        // is missing.
        try vm.parseJsonAddress(json, string.concat(".", key)) returns (address a) {
            return a;
        } catch {
            revert(string.concat("Missing key '", key, "' in ", pathHint));
        }
    }

    /// @dev Transfer a CCIP cross-chain contract's `Ownable2Step`
    ///      ownership to `newOwner` if (and only if) the EOA matching
    ///      `signingKey` is currently the on-chain owner. On mismatch,
    ///      log a clear skip + the operator's recovery path. Each
    ///      successful transfer broadcasts in its own single-tx window —
    ///      Foundry sequences the broadcasts as separate transactions,
    ///      which is the only correct way to hit `onlyOwner`-gated
    ///      `transferOwnership` (Multicall3 batching would set
    ///      msg.sender = Multicall3 and revert).
    function _transferCrossChainOwnership(
        uint256 signingKey,
        address target,
        string memory label,
        address newOwner
    ) internal {
        if (target == address(0)) {
            // Not deployed on this chain (e.g. a canonical-only contract
            // on a mirror chain, or vice-versa) — silently skip.
            return;
        }
        address signer = vm.addr(signingKey);
        address currentOwner = IOwnable2Step(target).owner();
        if (currentOwner != signer) {
            console.log("  SKIP ownership transfer:", label);
            console.log("    address:        ", target);
            console.log("    on-chain owner: ", currentOwner);
            console.log("    signing key EOA:", signer);
            console.log("    transferOwnership must be run from the current owner.");
            return;
        }
        vm.broadcast(signingKey);
        IOwnable2Step(target).transferOwnership(newOwner);
        console.log("  transferOwnership pending:", label);
        console.log("    address:    ", target);
        console.log("    pending to: ", newOwner);
    }

    /// @dev Rotate the CCIP `TokenAdminRegistry` administrator for
    ///      `token` to `newAdmin`, first leg of a two-step transfer.
    ///      Returns true iff the transfer was broadcast. Skips — never
    ///      reverts — when the registry / token is unknown or when the
    ///      `signingKey` EOA is not the current administrator.
    function _transferCctAdmin(
        uint256 signingKey,
        address registry,
        address token,
        address newAdmin
    ) internal returns (bool) {
        if (registry == address(0)) {
            console.log("  SKIP CCT admin transfer: CCIP_TOKEN_ADMIN_REGISTRY unset.");
            return false;
        }
        if (token == address(0)) {
            console.log("  SKIP CCT admin transfer: no VPFI token in addresses.json.");
            return false;
        }
        address signer = vm.addr(signingKey);
        address currentAdmin =
            ITokenAdminRegistry(registry).getTokenConfig(token).administrator;
        if (currentAdmin != signer) {
            console.log("  SKIP CCT admin transfer:", token);
            console.log("    current administrator:", currentAdmin);
            console.log("    signing key EOA:      ", signer);
            console.log("    transferAdminRole must be run from the current admin.");
            return false;
        }
        vm.broadcast(signingKey);
        ITokenAdminRegistry(registry).transferAdminRole(token, newAdmin);
        console.log("  CCT transferAdminRole pending:", token);
        console.log("    pending to:", newAdmin);
        return true;
    }
}

// ── Minimal interfaces ────────────────────────────────────────────────
// Keep these inline rather than importing from src/ (or the CCIP libs).
// The script needs only these selectors, not the surrounding logic.

interface IAccessControl {
    function grantRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address callerConfirmation) external;
}

/// @dev OpenZeppelin `TimelockController`'s role read, for the canceller
///      check before handover.
interface ITimelockRoles {
    function getMinDelay() external view returns (uint256);
    function MIN_DELAY_FLOOR() external view returns (uint256);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

interface IOwnership {
    function transferOwnership(address newOwner) external;
}

interface IOwnable2Step {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

/// @dev The slice of the CCIP `TokenAdminRegistry` the CCT-admin
///      handover needs. `TokenConfig` mirrors the registry's struct
///      (administrator, pendingAdministrator, tokenPool).
interface ITokenAdminRegistry {
    struct TokenConfig {
        address administrator;
        address pendingAdministrator;
        address tokenPool;
    }

    function getTokenConfig(address token)
        external
        view
        returns (TokenConfig memory);

    function transferAdminRole(address localToken, address newAdmin)
        external;
}
