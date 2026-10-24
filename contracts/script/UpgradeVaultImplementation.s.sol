// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {Deployments} from "./lib/Deployments.sol";
import {StorageLayoutRecord} from "./lib/StorageLayoutRecord.sol";

/**
 * @title  UpgradeVaultImplementation
 * @notice Deploys a fresh {VaipakamVaultImplementation} and points the LIVE
 *         diamond's shared per-user-vault template at it via
 *         {VaultFactoryFacet.upgradeVaultImplementation}. This is the UUPS
 *         counterpart to the facet-side {RefreshAllFacetsInPlace} refresh: it
 *         upgrades the per-user vault logic without touching the diamond, any
 *         facet, or any on-chain state (loans / offers / existing vaults).
 *
 * @dev    WHY A SEPARATE SCRIPT
 *         {RefreshAllFacetsInPlace} is deliberately facets-only — it never
 *         touches `s.vaipakamVaultTemplate`. The vault logic lives behind a
 *         UUPS proxy per user (see {VaultFactoryFacet}), so a change to
 *         `VaipakamVaultImplementation.sol` needs its own deploy-new-impl +
 *         retarget step. Run this only when the vault implementation bytecode
 *         actually changed since the live template was last deployed.
 *
 * @dev    NO TEMPLATE INIT (#905)
 *         The implementation's constructor calls `_disableInitializers()`, so
 *         a freshly deployed template is locked the moment it exists and
 *         nobody can front-run an `initialize` on it. This script used to
 *         initialize the template itself to close that window; that call
 *         would now revert, and is gone, as it is from
 *         {VaultFactoryFacet.initializeVaultImplementation}.
 *         `upgradeVaultImplementation` itself only checks `code.length != 0`;
 *         it does not validate storage-layout compatibility. This script
 *         does (#2092): see STORAGE SAFETY below.
 *
 * @dev    LAZY vs FORCED PROXY UPGRADE
 *         `upgradeVaultImplementation` only re-points the SHARED template and
 *         bumps `currentVaultVersion`; existing per-user proxies keep their old
 *         pointer until each user calls {upgradeUserVault} (or the admin sets
 *         {setMandatoryVaultUpgrade}). `userVaipakamVaults` is a mapping (not
 *         enumerable), so this script cannot enumerate every live vault. Pass an
 *         explicit `VAULT_UPGRADE_USERS` list (comma-separated) to eagerly
 *         upgrade a known set of testnet dev-wallet vaults in the same run;
 *         `upgradeUserVault` is permissionless, so those go out under the
 *         deployer key.
 *
 * @dev    STORAGE SAFETY (the load-bearing precondition)
 *         A UUPS upgrade REUSES each proxy's existing storage. It is safe ONLY
 *         while every `VaipakamVaultImplementation` storage-layout change since
 *         the live template was deployed is append-only. A mid-struct
 *         insert / reorder / type change would silently corrupt live vault
 *         state — do a fresh deploy in that case. Per owner policy (2026-06-19)
 *         this in-place path is TESTNET-ONLY; mainnet rollouts are always fresh.
 *         Since #2092 the script refuses such a change itself: it runs the
 *         storage-layout guard against the chain's record
 *         (`deployments/<slug>/storage-layout.json`) before broadcasting, and
 *         rewrites the record after the retarget. Run it with `--ffi`.
 *
 *         Env:
 *           - DEPLOYER_PRIVATE_KEY : deployer — deploys + initialises the impl,
 *                                    tops up admin gas, and (optionally) batch-
 *                                    upgrades the `VAULT_UPGRADE_USERS` vaults.
 *           - ADMIN_PRIVATE_KEY    : admin — must hold `VAULT_ADMIN_ROLE`; signs
 *                                    the `upgradeVaultImplementation` retarget.
 *                                    The script pre-flights the role and reverts
 *                                    up front if it isn't held (handover /
 *                                    timelock), before the impl deploy.
 *           - VAULT_UPGRADE_USERS  : OPTIONAL comma-separated address list to
 *                                    eagerly `upgradeUserVault(...)`. Unset =
 *                                    lazy per-user upgrade only.
 *
 *         Usage (from contracts/, on main) — run once per chain. Use `--slow`:
 *         the admin owner is EIP-7702-delegated on at least Base Sepolia, and a
 *         delegated account may have only one in-flight tx (no gapped nonces).
 *           forge script script/UpgradeVaultImplementation.s.sol --sig "run()" --ffi \
 *             --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow
 *           # then the same with $ARB_SEPOLIA_RPC_URL
 */
contract UpgradeVaultImplementation is Script {
    function run() external {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || // Base Sepolia
                cid == 421614 || // Arbitrum Sepolia
                cid == 97 || // BNB testnet
                cid == 11155111 || // Ethereum Sepolia
                cid == 11155420 || // OP Sepolia
                cid == 31337, // Anvil
            "UpgradeVaultImplementation: testnet only"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        address diamond = Deployments.readDiamond();

        // Pre-flight (view): the retarget is `VAULT_ADMIN_ROLE`-gated, so a
        // wrong admin key (or a role never granted / revoked at handover)
        // reverts HERE, before the impl deploy spends gas — not after.
        require(
            AccessControlFacet(diamond).hasRole(LibAccessControl.VAULT_ADMIN_ROLE, admin),
            "UpgradeVaultImplementation: ADMIN_PRIVATE_KEY lacks VAULT_ADMIN_ROLE (handover / timelock?)"
        );

        address oldImpl = VaultFactoryFacet(diamond).getVaipakamVaultImplementationAddress();
        require(
            oldImpl != address(0),
            "UpgradeVaultImplementation: vault template uninitialised (run initializeVaultImplementation first)"
        );

        // #2092 item 1 — the vault template is a UUPS root of the storage
        // guard: refuse code that drops a layout fact this chain records,
        // before anything is broadcast (needs `--ffi`). This replaces the
        // operator-only precondition the STORAGE SAFETY note above used to
        // leave to judgement.
        StorageLayoutRecord.requireAppendOnly("UpgradeVaultImplementation", diamond);

        // OPTIONAL eager per-user upgrade list. Default = none (lazy upgrade).
        address[] memory users = vm.envOr("VAULT_UPGRADE_USERS", ",", new address[](0));

        console.log("=== UUPS vault implementation upgrade ===");
        console.log("Chain id:  ", cid);
        console.log("Diamond:   ", diamond);
        console.log("Admin:     ", admin);
        console.log("Old impl:  ", oldImpl);
        console.log("Eager users:", users.length);

        // ── Deployer: fund admin gas (if low), deploy the impl ──
        vm.startBroadcast(deployerKey);
        if (admin.balance < 0.01 ether) {
            // `.call` not `.transfer` (Codex #1182): the admin is the
            // EIP-7702-delegated account this script targets, and a delegate's
            // receive/fallback can exceed the 2300-gas `.transfer` stipend.
            (bool topUpOk, ) = admin.call{value: 0.01 ether}("");
            require(topUpOk, "UpgradeVaultImplementation: admin gas top-up failed");
            console.log("Topped up admin with 0.01 ETH");
        }
        // Nothing to initialize: the constructor locks the implementation
        // (#905), and only per-user proxies are ever initialized.
        VaipakamVaultImplementation impl = new VaipakamVaultImplementation();
        vm.stopBroadcast();
        address newImpl = address(impl);
        require(newImpl != oldImpl, "UpgradeVaultImplementation: fresh impl collided with old (impossible)");
        console.log("New impl:  ", newImpl);

        // ── Admin: retarget the shared template (VAULT_ADMIN_ROLE) ──
        vm.startBroadcast(adminKey);
        VaultFactoryFacet(diamond).upgradeVaultImplementation(newImpl);
        vm.stopBroadcast();

        // Post-upgrade verification (view). Runs after the retarget; a mismatch
        // aborts the script (and the run persists nothing) rather than writing a
        // stale address back to the deployments artifact.
        address routed = VaultFactoryFacet(diamond).getVaipakamVaultImplementationAddress();
        require(routed == newImpl, "UpgradeVaultImplementation: template retarget verify failed");
        console.log("Verified: shared template now points at the fresh impl.");

        // Persist the new template NOW — immediately after the retarget is
        // verified on-chain, and BEFORE the optional eager per-user upgrades
        // (Codex #1182). The retarget has already landed; a later revert in the
        // eager loop (a bad owner in VAULT_UPGRADE_USERS) must not leave
        // addresses.json stale vs the live diamond. The eager loop is a
        // best-effort convenience, not part of recording the template bump.
        Deployments.writeVaultImpl(newImpl);
        StorageLayoutRecord.record(diamond);

        // ── Optional: eagerly upgrade the known dev-wallet vaults ──
        // `upgradeUserVault` is permissionless; the deployer signs. Each call
        // no-ops safely if the proxy already points at `newImpl`, but we only
        // call it for vaults that exist (it reverts NoVault otherwise), so the
        // caller must pass real vault owners.
        if (users.length > 0) {
            vm.startBroadcast(deployerKey);
            for (uint256 i; i < users.length; ++i) {
                VaultFactoryFacet(diamond).upgradeUserVault(users[i]);
                console.log("  upgraded user vault:", users[i]);
            }
            vm.stopBroadcast();
        }

        console.log("");
        console.log("addresses.json .vaultImpl updated. Next:");
        console.log("  bash script/exportFrontendDeployments.sh");
    }
}
