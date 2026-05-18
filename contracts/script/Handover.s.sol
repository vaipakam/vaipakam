// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";

/**
 * @title Handover
 * @notice Post-deploy ADMIN → governance handover for the Vaipakam
 *         protocol surface on a single chain.
 *
 * @dev Context. After `DeployDiamond.s.sol` completes, the ADMIN
 *      EOA (per .env's `ADMIN_ADDRESS`) holds:
 *        - DEFAULT_ADMIN_ROLE (root admin gating every other role)
 *        - ADMIN_ROLE / PAUSER_ROLE / KYC_ADMIN_ROLE /
 *          ORACLE_ADMIN_ROLE / RISK_ADMIN_ROLE / ESCROW_ADMIN_ROLE
 *        - WATCHER_ROLE + NOTIF_BILLER_ROLE + KEEPER_ROLE (kept on
 *          ADMIN; the off-chain-bot roles get rotated to per-bot EOAs
 *          separately via the keeper-authorization flow, NOT in this
 *          script)
 *        - ERC-173 ownership of the Diamond (gates `diamondCut`)
 *        - Ownable2Step ownership of every CCIP cross-chain contract
 *          deployed on this chain — `CcipMessenger`, the VPFI
 *          `TokenPool`, `VpfiPoolRateGovernor`, `VaipakamRewardMessenger`,
 *          and the chain-scoped `VPFIMirrorToken` + `VpfiBuyAdapter`
 *          (mirror) / `VpfiBuyReceiver` (canonical). `DeployCrosschain`
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
 *        1. DEFAULT_ADMIN_ROLE → DEFAULT_ADMIN_ADDRESS  (governance Safe,
 *           direct — rotates roles without Timelock delay during
 *           bringup, can re-architect roles later if needed)
 *        2. ADMIN_ROLE / KYC / ORACLE / RISK / ESCROW → Timelock
 *           (delayed-action surface; routine config edits time-locked)
 *        3. PAUSER_ROLE → PAUSER_ADDRESS  (Pauser Safe, direct —
 *           pause is a fast incident lever, Timelock delay is
 *           anti-feature on it; per memory's ratified design
 *           point #2)
 *        4. ERC-173 Diamond ownership → Timelock  (facet swaps are
 *           governance-tier risk, deserve a time-locked review
 *           window — operator can override later via the multisig
 *           if the model changes)
 *        5. ADMIN renounces every role it still holds, in the
 *           reverse order of grant (DEFAULT_ADMIN_ROLE last, so
 *           up until the very last call, ADMIN can correct any
 *           mid-flight error). WATCHER_ROLE + NOTIF_BILLER_ROLE +
 *           KEEPER_ROLE are NOT renounced here — those stay on ADMIN
 *           until the per-bot EOA setup (Phase 6 keeper authorization),
 *           after which a separate one-shot script renounces
 *           them. They have no DEFAULT_ADMIN-level authority, so
 *           a delayed renounce is safe.
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
 *      role), `DeployerZeroRolesTest.t.sol` runs as the hard exit gate
 *      — asserting the deployer + admin EOAs hold zero authority on
 *      this chain.
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
 *        DEFAULT_ADMIN_ADDRESS    — governance Safe address
 *        PAUSER_ADDRESS           — Pauser Safe address
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
 *      Reads from addresses.json:
 *        diamond, timelock, ccipMessenger, vpfiTokenPool,
 *        vpfiPoolRateGovernor, rewardMessenger,
 *        vpfiToken | vpfiMirror, vpfiBuyReceiver | vpfiBuyAdapter
 *
 *      Per CLAUDE.md "Deployments sync — Omit-keys policy", canonical
 *      and mirror keys are mutually exclusive on any single chain;
 *      missing keys are skipped silently.
 */
contract Handover is Script {
    /// @dev OZ AccessControl's root admin slot — `bytes32(0)`. Aliased
    ///      for readability since LibAccessControl doesn't re-export
    ///      it (it's the OZ implementation default).
    bytes32 internal constant DEFAULT_ADMIN_ROLE = bytes32(0);

    /// @dev Roles that get rotated to the Timelock during handover.
    ///      Order matters for the renounce loop: ADMIN renounces them
    ///      after DEFAULT_ADMIN_ROLE has been granted to the
    ///      governance Safe, before renouncing DEFAULT_ADMIN_ROLE
    ///      itself.
    ///
    ///      UNPAUSER_ROLE is in this set deliberately — the asymmetric
    ///      asymmetric pause pattern keeps PAUSER_ROLE on the
    ///      fast-key Pauser Safe (direct, no Timelock delay) AND
    ///      restricts unpause to the Timelock so a compromised
    ///      Pauser key cannot un-do its own pause without the
    ///      review-window delay.
    function _timelockRoles() internal pure returns (bytes32[] memory r) {
        r = new bytes32[](6);
        r[0] = LibAccessControl.ADMIN_ROLE;
        r[1] = LibAccessControl.UNPAUSER_ROLE;
        r[2] = LibAccessControl.KYC_ADMIN_ROLE;
        r[3] = LibAccessControl.ORACLE_ADMIN_ROLE;
        r[4] = LibAccessControl.RISK_ADMIN_ROLE;
        r[5] = LibAccessControl.ESCROW_ADMIN_ROLE;
    }

    function run() external {
        // ── 1. Resolve addresses ────────────────────────────────────
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address governanceSafe = vm.envAddress("DEFAULT_ADMIN_ADDRESS");
        address pauserSafe = vm.envAddress("PAUSER_ADDRESS");

        string memory addressesPath = _resolveAddressesPath();
        string memory addrJson = vm.readFile(addressesPath);

        address diamond = _readAddrOrRevert(addrJson, "diamond", addressesPath);
        address timelock = _readAddrOrRevert(addrJson, "timelock", addressesPath);
        // CCIP cross-chain stack — every chain. `DeployCrosschain` writes
        // these keys; all are ADMIN-owned after `ConfigureCcip`.
        address ccipMessenger = _readAddrOptional(addrJson, "ccipMessenger");
        address tokenPool = _readAddrOptional(addrJson, "vpfiTokenPool");
        address rateGovernor = _readAddrOptional(addrJson, "vpfiPoolRateGovernor");
        address rewardMessenger = _readAddrOptional(addrJson, "rewardMessenger");
        // Chain-scoped per the omit-keys policy: a mirror carries
        // `vpfiMirror` + `vpfiBuyAdapter`; canonical Base carries
        // `vpfiBuyReceiver` (its VPFI is the pre-existing `vpfiToken`).
        address mirror = _readAddrOptional(addrJson, "vpfiMirror");
        address buyAdapter = _readAddrOptional(addrJson, "vpfiBuyAdapter");
        address buyReceiver = _readAddrOptional(addrJson, "vpfiBuyReceiver");

        // The VPFI token whose CCT admin is rotated below — the
        // pre-existing `vpfiToken` on canonical Base, the `vpfiMirror`
        // ERC20 on a mirror.
        bool canonical = block.chainid == 8453 || block.chainid == 84532;
        address vpfiToken = canonical
            ? _readAddrOptional(addrJson, "vpfiToken")
            : mirror;

        // ── 2. Sanity — the three Safes must be distinct ────────────
        // The .env.example ships with three different addresses; if
        // the operator pastes the same address into two of them
        // (e.g. accidentally setting PAUSER_ADDRESS to the governance
        // Safe), the role split collapses and we lose the
        // pause-without-Timelock-delay property. Refuse in this case
        // so the misconfig surfaces here, not on incident day.
        require(governanceSafe != address(0), "DEFAULT_ADMIN_ADDRESS unset");
        require(pauserSafe != address(0), "PAUSER_ADDRESS unset");
        require(governanceSafe != admin, "DEFAULT_ADMIN_ADDRESS == ADMIN_ADDRESS (handover would no-op)");
        require(pauserSafe != admin, "PAUSER_ADDRESS == ADMIN_ADDRESS (pause role would no-op)");
        require(governanceSafe != pauserSafe, "DEFAULT_ADMIN_ADDRESS == PAUSER_ADDRESS (collapses three-Safe model)");

        console.log("Handover plan");
        console.log("  diamond:       ", diamond);
        console.log("  timelock:      ", timelock);
        console.log("  governance Safe:", governanceSafe);
        console.log("  pauser Safe:   ", pauserSafe);
        console.log("  admin (renouncing):", admin);

        // ── 3. Broadcast as ADMIN ──────────────────────────────────
        vm.startBroadcast(adminKey);

        // 3a. Grant DEFAULT_ADMIN_ROLE to the governance Safe FIRST.
        //     Until this lands, ADMIN is the sole DEFAULT_ADMIN
        //     holder; if any later step reverts, ADMIN can recover.
        IAccessControl(diamond).grantRole(DEFAULT_ADMIN_ROLE, governanceSafe);
        console.log("Granted DEFAULT_ADMIN_ROLE to governance Safe");

        // 3b. Grant the Timelock-bound roles.
        bytes32[] memory tlRoles = _timelockRoles();
        for (uint256 i = 0; i < tlRoles.length; i++) {
            IAccessControl(diamond).grantRole(tlRoles[i], timelock);
        }
        console.log("Granted ADMIN/KYC/ORACLE/RISK/ESCROW to Timelock");

        // 3c. Grant PAUSER_ROLE to the pauser Safe (direct, NO Timelock).
        IAccessControl(diamond).grantRole(LibAccessControl.PAUSER_ROLE, pauserSafe);
        console.log("Granted PAUSER_ROLE to pauser Safe");

        // 3d. Transfer ERC-173 Diamond ownership → Timelock. Future
        //     diamondCut (facet swaps) goes via the Timelock's
        //     queue+execute pattern, giving observers a delay window.
        IOwnership(diamond).transferOwnership(timelock);
        console.log("Transferred ERC-173 Diamond ownership to Timelock");

        // 3e. ADMIN renounces every multisig-bound role it holds, in
        //     reverse-grant order. WATCHER_ROLE + NOTIF_BILLER_ROLE +
        //     KEEPER_ROLE are intentionally LEFT on ADMIN — these
        //     off-chain-bot roles get rotated to per-bot EOAs in a
        //     separate script after Phase-6 keeper-authorization
        //     wiring lands.
        //     Order: PAUSER, then the five Timelock roles, then
        //     DEFAULT_ADMIN_ROLE LAST.
        IAccessControl(diamond).renounceRole(LibAccessControl.PAUSER_ROLE, admin);
        for (uint256 i = tlRoles.length; i > 0; i--) {
            IAccessControl(diamond).renounceRole(tlRoles[i - 1], admin);
        }
        IAccessControl(diamond).renounceRole(DEFAULT_ADMIN_ROLE, admin);
        console.log("Admin renounced PAUSER + Timelock-bound + DEFAULT_ADMIN");

        vm.stopBroadcast();

        // ── 3f. CCIP cross-chain ownership → Timelock ───────────────────
        // The whole CCIP stack is ADMIN-owned `Ownable2Step` —
        // `DeployCrosschain` initializes every proxy with ADMIN and
        // `ConfigureCcip` accepts the pools' ownership as ADMIN — so
        // every transfer here broadcasts as ADMIN, and the LZ-era
        // per-owner-key resolution is no longer needed.
        //
        // `transferOwnership` is the first leg of `Ownable2Step`; the
        // Timelock accepts in step 4. `_transferCrossChainOwnership`
        // skips with a notice when a contract is not deployed on this
        // chain, or not ADMIN-owned — never a confusing mid-run revert.
        _transferCrossChainOwnership(adminKey, ccipMessenger,   "ccipMessenger",        timelock);
        _transferCrossChainOwnership(adminKey, tokenPool,       "vpfiTokenPool",        timelock);
        _transferCrossChainOwnership(adminKey, rateGovernor,    "vpfiPoolRateGovernor", timelock);
        _transferCrossChainOwnership(adminKey, rewardMessenger, "rewardMessenger",      timelock);
        _transferCrossChainOwnership(adminKey, mirror,          "vpfiMirror",           timelock);
        _transferCrossChainOwnership(adminKey, buyAdapter,      "vpfiBuyAdapter",       timelock);
        _transferCrossChainOwnership(adminKey, buyReceiver,     "vpfiBuyReceiver",      timelock);

        // ── 3g. CCT admin → Timelock ────────────────────────────────────
        // The CCIP `TokenAdminRegistry` administrator for VPFI rotates to
        // the Timelock as well — `transferAdminRole` is the first leg of
        // a two-step transfer; the Timelock `acceptAdminRole`s in step 4.
        // Skipped when CCIP_TOKEN_ADMIN_REGISTRY is unset, or when ADMIN
        // is not the current administrator (CCT registration may have
        // been done by a separate token owner — see ConfigureCcip
        // `_registerCct`, which itself skips when admin != token owner).
        address cctRegistry = vm.envOr("CCIP_TOKEN_ADMIN_REGISTRY", address(0));
        bool cctRotated =
            _transferCctAdmin(adminKey, cctRegistry, vpfiToken, timelock);

        // ── 4. Print the Timelock-side accept calldata ──────────────────
        // Each pending transfer needs the Timelock to accept it (through
        // its schedule/execute queue) before it takes effect. Emit the
        // calldata + targets so the operator can queue them without
        // hand-typing. `acceptOwnership()` takes no args — calldata is
        // the bare 4-byte selector.
        console.log("");
        console.log("=========================================================");
        console.log("NEXT STEP - the Timelock must accept each pending transfer:");
        console.log("=========================================================");
        console.log(
            "  acceptOwnership() selector:",
            vm.toString(abi.encodePacked(bytes4(keccak256("acceptOwnership()"))))
        );
        if (ccipMessenger != address(0)) console.log("    target: ccipMessenger        @", ccipMessenger);
        if (tokenPool != address(0)) console.log("    target: vpfiTokenPool        @", tokenPool);
        if (rateGovernor != address(0)) console.log("    target: vpfiPoolRateGovernor @", rateGovernor);
        if (rewardMessenger != address(0)) console.log("    target: rewardMessenger      @", rewardMessenger);
        if (mirror != address(0)) console.log("    target: vpfiMirror           @", mirror);
        if (buyAdapter != address(0)) console.log("    target: vpfiBuyAdapter       @", buyAdapter);
        if (buyReceiver != address(0)) console.log("    target: vpfiBuyReceiver      @", buyReceiver);
        if (cctRotated) {
            console.log("  acceptAdminRole(address) on the CCIP TokenAdminRegistry:");
            console.log("    registry:      ", cctRegistry);
            console.log("    arg localToken:", vpfiToken);
        }
        console.log("");
        console.log("After all are accepted, run DeployerZeroRolesTest as the");
        console.log("hard exit gate to assert deployer + admin hold no authority.");
    }

    // ── Helpers ────────────────────────────────────────────────────

    function _resolveAddressesPath() internal returns (string memory) {
        try vm.envString("ADDRESSES_JSON_PATH") returns (string memory p) {
            if (bytes(p).length > 0) return p;
        } catch {}
        string memory slug = vm.envString("CHAIN_SLUG");
        require(bytes(slug).length > 0, "Set CHAIN_SLUG or ADDRESSES_JSON_PATH");
        return string.concat("deployments/", slug, "/addresses.json");
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

    function _readAddrOptional(string memory json, string memory key) internal view returns (address) {
        try vm.parseJsonAddress(json, string.concat(".", key)) returns (address a) {
            return a;
        } catch {
            return address(0);
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
