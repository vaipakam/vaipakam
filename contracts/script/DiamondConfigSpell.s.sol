// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {ConfigureNFTImageURIs} from "./ConfigureNFTImageURIs.s.sol";
import {ConfigureOracle} from "./ConfigureOracle.s.sol";
import {ConfigureRewardReporter} from "./ConfigureRewardReporter.s.sol";
import {ConfigureVPFIBuy} from "./ConfigureVPFIBuy.s.sol";
import {ConfigureVPFIToken} from "./ConfigureVPFIToken.s.sol";

/**
 * @title DiamondConfigSpell
 * @notice spell-style atomic configure for the four
 *         post-deploy Diamond-side configure scripts.
 *
 * @dev Background. After `--phase contracts` lands the Diamond +
 *      Timelock + VPFI lane + Reward OApp on a chain, four further
 *      `Configure*.s.sol` scripts have to run before the chain is
 *      operational:
 *
 *        - ConfigureOracle           — wires oracle adapters + risk
 *                                       params for every supported
 *                                       (lendingAsset, collateralAsset)
 *                                       pair.
 *        - ConfigureRewardReporter   — sets the cross-chain reward
 *                                       reporter's localEid + baseEid
 *                                       so reward reports flow.
 *        - ConfigureVPFIBuy          — sets the VPFI fee-discount price
 *                                       config; runs on every chain (the
 *                                       discount applies chain-wide).
 *        - ConfigureNFTImageURIs     — sets the position-NFT artwork
 *                                       URIs (rotates without code).
 *
 *      Pre-spell, the operator ran each `forge script` separately. That
 *      meant: four operator-actions per chain × N chains, four chances
 *      to forget a step, four separate broadcasts in the chain's tx
 *      history with no atomicity (a mid-flight failure leaves the
 *      Diamond in a half-configured state).
 *
 *      This spell composes all four into a single external `run()` that
 *      opens one operator-action window and dispatches each child via
 *      `new ConfigureFoo(); child.run();`. The pattern mirrors
 *      `PositiveFlows.s.sol` / `PartialFlows.s.sol`: each child opens
 *      its own `vm.startBroadcast(adminKey)` window inside its own
 *      `run()`; the wrapper itself emits no extra broadcast txns.
 *
 *      Atomicity caveat. Solidity scripts can't issue a literal "all
 *      or nothing" transaction across multiple admin function calls
 *      because the four configures span MULTIPLE distinct on-chain
 *      txs (each child's broadcasts are sequenced separately by Foundry).
 *      What the spell DOES guarantee:
 *        - One operator-action invocation = all four configures
 *          attempted in a known, deterministic order.
 *        - If a child reverts, every later child is short-circuited
 *          (Foundry stops the script on the first revert), so the
 *          operator can't accidentally forget to re-run the failed
 *          subset.
 *        - Each child broadcasts as ADMIN_PRIVATE_KEY (or ADMIN's
 *          equivalent) so role-gating is consistent across the spell.
 *
 *      For true on-chain atomicity (single tx covering all four), a
 *      future iteration could compose the four into a single
 *      contract that the Diamond delegate-calls or the Timelock
 *      executes. That's the proper single-tx spell shape but requires
 *      a Diamond-side `executeSpell(bytes calldata)` entry point we
 *      don't have today. The compositional approach here is the
 *      pragmatic step-1.
 *
 * @dev Order rationale.
 *
 *        1. ConfigureOracle FIRST — every other configure (and every
 *           runtime path) needs oracle prices to be live.
 *        2. ConfigureRewardReporter — wires the reporter's localEid
 *           before the reward OApp peers are live (no on-chain
 *           dependency on the order, but logically pairs after
 *           Oracle).
 *        3. ConfigureVPFIBuy — sets the VPFI fee-discount price config
 *           AFTER oracle is wired (the config doesn't read oracle, but
 *           having oracle live lets `--phase verify` sanity-check the
 *           discount price against current prices).
 *        4. ConfigureNFTImageURIs LAST — pure metadata; no on-chain
 *           dependencies on the others.
 *
 * @dev Env-var contract is the union of every child's env-var
 *      requirements — see each `Configure*.s.sol` header for the
 *      authoritative list. The most common ones:
 *        - ADMIN_PRIVATE_KEY (signs every Diamond-side broadcast)
 *        - per-chain oracle / risk params (ConfigureOracle reads
 *          chain-prefixed vars so the same .env works across testnets)
 *        - REWARD_OAPP_PROXY / LOCAL_EID / BASE_EID (reporter)
 *        - VPFI_BUY_WEI_PER_VPFI (global) + the chain-prefixed
 *          <CHAIN>_VPFI_DISCOUNT_ETH_PRICE_ASSET (every chain)
 *        - NFT_DEFAULT_IMAGE_LENDER / _BORROWER and the per-state
 *          override URIs (NFT artwork; defaults are baked into the
 *          contract so all of these are optional).
 *
 *      ConfigureLZConfig is NOT in this spell — it's signed by the
 *      OApp owner key (DEPLOYER_PRIVATE_KEY in many setups, NOT
 *      ADMIN_PRIVATE_KEY) and runs at `--phase lz-config` separately.
 */
contract DiamondConfigSpell is Script {
    function run() external {
        // #857 — SINGLE skip-vpfi decision point. On a `--skip-vpfi` deploy
        // (SKIP_VPFI=1) the chain has NO VPFI / cross-chain stack, so the three
        // VPFI-dependent children (ConfigureVPFIToken / ConfigureRewardReporter /
        // ConfigureVPFIBuy) have nothing to configure and would revert on their
        // missing artifacts. Deciding it HERE — invoke them only when VPFI is
        // present — keeps each child a simple, fail-loud "the artifact must
        // exist" step (no per-child skip logic to drift). The VPFI-INDEPENDENT
        // children (Oracle, NFT URIs) always run: a chain still needs oracle
        // pricing for lending even without VPFI.
        bool skipVpfi = vm.envOr("SKIP_VPFI", uint256(0)) == 1;
        if (skipVpfi) {
            console.log("[DiamondConfigSpell] SKIP_VPFI=1 - skipping ConfigureVPFIToken /");
            console.log("  ConfigureRewardReporter / ConfigureVPFIBuy (no VPFI stack on this chain).");
        }

        if (!skipVpfi) {
            console.log("");
            console.log("[DiamondConfigSpell] ============================================");
            console.log("[DiamondConfigSpell] ConfigureVPFIToken (VPFI registration)");
            console.log("[DiamondConfigSpell] ============================================");
            // Register the VPFI token (canonical `.vpfiToken` + canonical flag, or
            // the mirror `.vpfiMirror`) so the Diamond can mint/use VPFI.
            ConfigureVPFIToken vpfiToken = new ConfigureVPFIToken();
            vpfiToken.run();
        }

        console.log("");
        console.log("[DiamondConfigSpell] ============================================");
        console.log("[DiamondConfigSpell] ConfigureOracle");
        console.log("[DiamondConfigSpell] ============================================");
        ConfigureOracle oracle = new ConfigureOracle();
        oracle.run();

        if (!skipVpfi) {
            console.log("");
            console.log("[DiamondConfigSpell] ============================================");
            console.log("[DiamondConfigSpell] ConfigureRewardReporter");
            console.log("[DiamondConfigSpell] ============================================");
            ConfigureRewardReporter reporter = new ConfigureRewardReporter();
            reporter.run();

            console.log("");
            console.log("[DiamondConfigSpell] ============================================");
            console.log("[DiamondConfigSpell] ConfigureVPFIBuy (discount price)");
            console.log("[DiamondConfigSpell] ============================================");
            // #687-A: the discount applies on EVERY VPFI chain (not the removed
            // canonical-only sale), so the discount price config runs on any chain
            // that has the VPFI stack.
            ConfigureVPFIBuy buy = new ConfigureVPFIBuy();
            buy.run();
        }

        console.log("");
        console.log("[DiamondConfigSpell] ============================================");
        console.log("[DiamondConfigSpell] ConfigureNFTImageURIs");
        console.log("[DiamondConfigSpell] ============================================");
        ConfigureNFTImageURIs nft = new ConfigureNFTImageURIs();
        nft.run();

        console.log("");
        console.log("[DiamondConfigSpell] ============================================");
        console.log("[DiamondConfigSpell] All configures landed.");
        console.log("[DiamondConfigSpell] ============================================");
    }
}
