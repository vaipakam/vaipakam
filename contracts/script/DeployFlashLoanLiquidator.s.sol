// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {FlashLoanLiquidator} from "../src/keeper/FlashLoanLiquidator.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title  DeployFlashLoanLiquidator
 * @notice Per-chain deploy script for the Phase-3
 *         `FlashLoanLiquidator` reference receiver from
 *         `docs/DesignsAndPlans/FlashLoanLiquidationPath.md`.
 *
 * @dev    Runs ONCE per chain (testnet first, then mainnet after
 *         audit sign-off). Reads:
 *           - `DEPLOYER_PRIVATE_KEY`     — broadcast key.
 *           - `KEEPER_BOT_OWNER`         — the EOA that will be
 *                                          allowed to initiate
 *                                          flash-loan-funded
 *                                          liquidations via this
 *                                          contract. CRITICAL: this
 *                                          MUST be the same address
 *                                          as `KEEPER_PRIVATE_KEY`'s
 *                                          derived address in
 *                                          `apps/keeper`'s
 *                                          Cloudflare-Worker
 *                                          secrets — otherwise the
 *                                          keeper bot can't call
 *                                          its own receiver. The
 *                                          deploy script reverts
 *                                          on a zero address.
 *           - `<CHAIN>_AAVE_V3_POOL`     — Aave V3 Pool address on
 *                                          this chain. `address(0)`
 *                                          ⇒ chain has no Aave V3
 *                                          (the receiver still
 *                                          deploys, but
 *                                          `liquidateViaAaveV3` is
 *                                          locked).
 *           - `<CHAIN>_BALANCER_V2_VAULT`— Balancer V2 Vault. Same
 *                                          shape — `address(0)`
 *                                          locks `liquidateViaBalancerV2`.
 *           - Diamond address — read from
 *                               `contracts/deployments/<chain-slug>/addresses.json`
 *                               via `Deployments.readDiamond()`.
 *
 *         The constructor enforces at-least-one-provider, so the
 *         script reverts up-front if both Aave V3 + Balancer V2
 *         env vars are unset / zero for the chain. That avoids
 *         shipping a contract that's operationally inert.
 *
 *         Address provenance:
 *           - Aave V3 Pool per chain — see
 *             [Aave docs](https://aave.com/docs/resources/addresses)
 *             (and DRY against the canonical addresses we already
 *             use in `apps/keeper/src/flashLoanProviders.ts`).
 *           - Balancer V2 Vault — canonical CREATE2 address
 *             `0xBA12222222228d8Ba445958a75a0704d566BF2C8` on every
 *             chain Balancer V2 is deployed on.
 *
 *         The deployed address is written into the chain's
 *         `addresses.json` via `Deployments.writeFlashLoanLiquidator`,
 *         which the consolidated `deployments.json` merge step
 *         picks up automatically — no extra wiring needed in the
 *         apps. Once the address lands in
 *         `packages/contracts/src/deployments.json`, the operator
 *         also updates `apps/keeper/src/flashLoanProviders.ts`'s
 *         per-chain `liquidator` slot so the keeper bot picks it
 *         up; that update is manual (a separate keeper-side commit)
 *         because the keeper consumes a TS-typed config, not the
 *         deployment JSON.
 */
contract DeployFlashLoanLiquidator is Script {
    // ─── Per-chain env-var resolution ────────────────────────────────

    /// @dev Aave V3 Pool address for this chain. Per-chain env var
    ///      override (e.g. `BASE_AAVE_V3_POOL`); falls back to a
    ///      bare `AAVE_V3_POOL` for ad-hoc deploys. Zero address ⇒
    ///      chain has no Aave V3 (or we deliberately don't want
    ///      to wire it on this deploy).
    function _aaveV3Pool() internal view returns (address) {
        uint256 chainId = block.chainid;
        string memory key =
            chainId == 1        ? "ETH_AAVE_V3_POOL"
            : chainId == 8453   ? "BASE_AAVE_V3_POOL"
            : chainId == 42161  ? "ARB_AAVE_V3_POOL"
            : chainId == 10     ? "OP_AAVE_V3_POOL"
            : chainId == 56     ? "BNB_AAVE_V3_POOL"
            : chainId == 137    ? "POLYGON_AAVE_V3_POOL"
            : chainId == 84532  ? "BASE_SEPOLIA_AAVE_V3_POOL"
            : chainId == 11155111 ? "SEPOLIA_AAVE_V3_POOL"
            : chainId == 421614 ? "ARB_SEPOLIA_AAVE_V3_POOL"
            : chainId == 11155420 ? "OP_SEPOLIA_AAVE_V3_POOL"
            : chainId == 97     ? "BNB_TESTNET_AAVE_V3_POOL"
            : "AAVE_V3_POOL";
        return vm.envOr(key, address(0));
    }

    /// @dev Balancer V2 Vault address. Per-chain override or a
    ///      bare `BALANCER_V2_VAULT`. Note that Balancer V2 uses
    ///      the same canonical CREATE2 address
    ///      (`0xBA12222222228d8Ba445958a75a0704d566BF2C8`) on every
    ///      chain it's deployed on — so the env-var-per-chain
    ///      pattern is for the rare case where governance wants
    ///      to deploy against a different address (a fork, a
    ///      shadow deployment, etc.).
    function _balancerV2Vault() internal view returns (address) {
        uint256 chainId = block.chainid;
        string memory key =
            chainId == 1        ? "ETH_BALANCER_V2_VAULT"
            : chainId == 8453   ? "BASE_BALANCER_V2_VAULT"
            : chainId == 42161  ? "ARB_BALANCER_V2_VAULT"
            : chainId == 10     ? "OP_BALANCER_V2_VAULT"
            : chainId == 137    ? "POLYGON_BALANCER_V2_VAULT"
            : chainId == 84532  ? "BASE_SEPOLIA_BALANCER_V2_VAULT"
            : chainId == 11155111 ? "SEPOLIA_BALANCER_V2_VAULT"
            : chainId == 421614 ? "ARB_SEPOLIA_BALANCER_V2_VAULT"
            : chainId == 11155420 ? "OP_SEPOLIA_BALANCER_V2_VAULT"
            // chainId 56 (BNB Chain) intentionally omitted —
            // Balancer V2 isn't deployed on BNB per docs.balancer.fi
            // as of training data; reading any other env-var name
            // for this chain falls through to the bare key.
            : "BALANCER_V2_VAULT";
        return vm.envOr(key, address(0));
    }

    function run() external {
        // ── Resolve constructor args ────────────────────────────
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address ownerEoa = vm.envAddress("KEEPER_BOT_OWNER");
        require(ownerEoa != address(0), "KEEPER_BOT_OWNER unset");

        address diamond = Deployments.readDiamond();
        require(diamond != address(0), "diamond not deployed on this chain");

        address aaveV3Pool      = _aaveV3Pool();
        address balancerV2Vault = _balancerV2Vault();
        require(
            aaveV3Pool != address(0) || balancerV2Vault != address(0),
            "no flash-loan provider configured for this chain"
        );

        console.log("DeployFlashLoanLiquidator");
        console.log("  chainId         :", block.chainid);
        console.log("  diamond         :", diamond);
        console.log("  keeperBotOwner  :", ownerEoa);
        console.log("  aaveV3Pool      :", aaveV3Pool);
        console.log("  balancerV2Vault :", balancerV2Vault);

        // ── Deploy ─────────────────────────────────────────────
        vm.startBroadcast(deployerKey);
        FlashLoanLiquidator liq = new FlashLoanLiquidator(
            ownerEoa,
            diamond,
            aaveV3Pool,
            balancerV2Vault
        );
        vm.stopBroadcast();

        console.log("  deployed at     :", address(liq));

        // ── Record the address in this chain's addresses.json ──
        // The consolidated `deployments.json` merge step
        // (`exportFrontendDeployments.sh`) picks this up
        // automatically; no separate wiring needed.
        Deployments.writeFlashLoanLiquidator(address(liq));
    }
}
