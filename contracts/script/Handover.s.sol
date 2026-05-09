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
 *        - WATCHER_ROLE + NOTIF_BILLER_ROLE (kept on ADMIN; rotated
 *          to per-bot EOAs separately via the keeper-authorization
 *          flow, NOT in this script)
 *        - ERC-173 ownership of the Diamond (gates `diamondCut`)
 *        - Ownable2Step ownership of every LZ OApp deployed on this
 *          chain (VPFIOFTAdapter or VPFIMirror, VPFIBuyAdapter or
 *          VPFIBuyReceiver, VaipakamRewardOApp). This is held on
 *          ADMIN through the `--phase configure` window so the
 *          ~90 onlyOwner-gated `setConfig`/`setPeer`/
 *          `setEnforcedOptions` calls can be signed by a single
 *          EOA without cross-chain multisig coordination.
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
 *           mid-flight error). WATCHER_ROLE + NOTIF_BILLER_ROLE
 *           are NOT renounced here — those stay on ADMIN until
 *           the per-bot EOA setup (Phase 6 keeper authorization),
 *           after which a separate one-shot script renounces
 *           them. They have no DEFAULT_ADMIN-level authority, so
 *           a delayed renounce is safe.
 *        6. OApp ownership → DEFAULT_ADMIN_ADDRESS via Ownable2Step's
 *           first leg (transferOwnership). The DEFAULT_ADMIN
 *           multisig must call `acceptOwnership` on each OApp
 *           within Ownable2Step's pending-owner window — that's
 *           the multi-party ceremony component; this script
 *           prints the calldata + addresses for the operator to
 *           paste into the Safe UI.
 *
 *      AFTER this script lands and AFTER the multisig accepts every
 *      OApp's pending ownership, `DeployerZeroRolesTest.t.sol` runs
 *      as the hard exit gate — asserting the deployer + admin EOAs
 *      hold zero authority on this chain.
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
 *        ADDRESSES_JSON_PATH      — optional override; defaults to
 *                                   contracts/deployments/<slug>/
 *                                   addresses.json. The script reads
 *                                   the slug from CHAIN_SLUG env if
 *                                   ADDRESSES_JSON_PATH is unset.
 *
 *      Reads from addresses.json:
 *        diamond, timelock, vpfiOftAdapter | vpfiMirror,
 *        vpfiBuyAdapter | vpfiBuyReceiver, vaipakamReward
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
    function _timelockRoles() internal pure returns (bytes32[] memory r) {
        r = new bytes32[](5);
        r[0] = LibAccessControl.ADMIN_ROLE;
        r[1] = LibAccessControl.KYC_ADMIN_ROLE;
        r[2] = LibAccessControl.ORACLE_ADMIN_ROLE;
        r[3] = LibAccessControl.RISK_ADMIN_ROLE;
        r[4] = LibAccessControl.ESCROW_ADMIN_ROLE;
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
        address oft = _readAddrOptional(addrJson, "vpfiOftAdapter");
        address mirror = _readAddrOptional(addrJson, "vpfiMirror");
        address buyAdapter = _readAddrOptional(addrJson, "vpfiBuyAdapter");
        address buyReceiver = _readAddrOptional(addrJson, "vpfiBuyReceiver");
        address rewardOApp = _readAddrOptional(addrJson, "vaipakamReward");

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
        //     reverse-grant order. WATCHER_ROLE + NOTIF_BILLER_ROLE
        //     are intentionally LEFT on ADMIN — they get rotated to
        //     per-bot EOAs in a separate script after Phase-6
        //     keeper-authorization wiring lands.
        //     Order: PAUSER, then the five Timelock roles, then
        //     DEFAULT_ADMIN_ROLE LAST.
        IAccessControl(diamond).renounceRole(LibAccessControl.PAUSER_ROLE, admin);
        for (uint256 i = tlRoles.length; i > 0; i--) {
            IAccessControl(diamond).renounceRole(tlRoles[i - 1], admin);
        }
        IAccessControl(diamond).renounceRole(DEFAULT_ADMIN_ROLE, admin);
        console.log("Admin renounced PAUSER + Timelock-bound + DEFAULT_ADMIN");

        // 3f. OApp ownership → governance Safe (Ownable2Step first
        //     leg). Each call sets the Safe as the PENDING owner; the
        //     Safe must call `acceptOwnership()` on each contract
        //     before the transfer takes effect. That second leg is
        //     printed below as the post-script multi-sig calldata.
        if (oft != address(0)) {
            IOwnable2Step(oft).transferOwnership(governanceSafe);
            console.log("OApp transferOwnership pending: vpfiOftAdapter @", oft);
        }
        if (mirror != address(0)) {
            IOwnable2Step(mirror).transferOwnership(governanceSafe);
            console.log("OApp transferOwnership pending: vpfiMirror @", mirror);
        }
        if (buyAdapter != address(0)) {
            IOwnable2Step(buyAdapter).transferOwnership(governanceSafe);
            console.log("OApp transferOwnership pending: vpfiBuyAdapter @", buyAdapter);
        }
        if (buyReceiver != address(0)) {
            IOwnable2Step(buyReceiver).transferOwnership(governanceSafe);
            console.log("OApp transferOwnership pending: vpfiBuyReceiver @", buyReceiver);
        }
        if (rewardOApp != address(0)) {
            IOwnable2Step(rewardOApp).transferOwnership(governanceSafe);
            console.log("OApp transferOwnership pending: vaipakamReward @", rewardOApp);
        }

        vm.stopBroadcast();

        // ── 4. Print the multisig-side calldata for acceptOwnership ──
        // The governance Safe must accept on each OApp before the
        // pending transfer takes effect. We emit the calldata + target
        // addresses here so the operator can paste them into the Safe
        // UI without hand-typing. acceptOwnership() takes no args —
        // calldata is the bare 4-byte selector.
        bytes4 acceptSel = bytes4(keccak256("acceptOwnership()"));
        console.log("");
        console.log("=========================================================");
        console.log("NEXT STEP - governance Safe must acceptOwnership on each:");
        console.log("=========================================================");
        console.log("  acceptOwnership() selector:", vm.toString(abi.encodePacked(acceptSel)));
        if (oft != address(0)) console.log("    target: vpfiOftAdapter   @", oft);
        if (mirror != address(0)) console.log("    target: vpfiMirror       @", mirror);
        if (buyAdapter != address(0)) console.log("    target: vpfiBuyAdapter   @", buyAdapter);
        if (buyReceiver != address(0)) console.log("    target: vpfiBuyReceiver  @", buyReceiver);
        if (rewardOApp != address(0)) console.log("    target: vaipakamReward   @", rewardOApp);
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
    ) internal pure returns (address) {
        bytes memory raw = vm.parseJson(json, string.concat(".", key));
        require(raw.length >= 32, string.concat("Missing key '", key, "' in ", pathHint));
        return abi.decode(raw, (address));
    }

    function _readAddrOptional(string memory json, string memory key) internal pure returns (address) {
        bytes memory raw;
        try vm.parseJson(json, string.concat(".", key)) returns (bytes memory r) {
            raw = r;
        } catch {
            return address(0);
        }
        if (raw.length < 32) return address(0);
        return abi.decode(raw, (address));
    }
}

// ── Minimal interfaces ────────────────────────────────────────────────
// Keep these inline rather than importing from src/. The script doesn't
// need any of the surrounding facet logic, just the four selectors.

interface IAccessControl {
    function grantRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address callerConfirmation) external;
}

interface IOwnership {
    function transferOwnership(address newOwner) external;
}

interface IOwnable2Step {
    function transferOwnership(address newOwner) external;
}
