// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {ConfigureNFTImageURIs} from "./ConfigureNFTImageURIs.s.sol";
import {ConfigureOracle} from "./ConfigureOracle.s.sol";
import {ConfigureRewardReporter} from "./ConfigureRewardReporter.s.sol";
import {ConfigureVPFIBuy} from "./ConfigureVPFIBuy.s.sol";

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
 *        - ConfigureVPFIBuy          — sets the canonical-chain
 *                                       wei-per-VPFI rate + receiver
 *                                       config (no-op on mirror).
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
 *        3. ConfigureVPFIBuy — sets the buy rate AFTER oracle is
 *           wired (the rate config doesn't read oracle, but having
 *           oracle live lets `--phase verify` sanity-check the rate
 *           against current prices).
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
 *        - VPFI_BUY_WEI_PER_VPFI + the discount-eth-price-asset
 *          per-chain var (canonical chain only)
 *        - NFT_DEFAULT_IMAGE_LENDER / _BORROWER and the per-state
 *          override URIs (NFT artwork; defaults are baked into the
 *          contract so all of these are optional).
 *
 *      ConfigureLZConfig is NOT in this spell — it's signed by the
 *      OApp owner key (PRIVATE_KEY in many setups, NOT
 *      ADMIN_PRIVATE_KEY) and runs at `--phase lz-config` separately.
 */
contract DiamondConfigSpell is Script {
    /// @dev Canonical-VPFI chains (Base Sepolia 84532 and Base mainnet 8453)
    ///      are the only chains that run ConfigureVPFIBuy. The script's
    ///      `_ethPriceAsset()` helper hard-reverts on any other chainid, so
    ///      mirror-chain runs of the spell would abort at step 3 of 4
    ///      without this gate. Mirror chains skip step 3 with a
    ///      console-log marker so the operator sees the deliberate skip.
    function _isCanonicalVPFIChain() internal view returns (bool) {
        return block.chainid == 84532 || block.chainid == 8453;
    }

    function run() external {
        bool canonical = _isCanonicalVPFIChain();

        console.log("");
        console.log("[DiamondConfigSpell] ============================================");
        console.log("[DiamondConfigSpell] 1/4: ConfigureOracle");
        console.log("[DiamondConfigSpell] ============================================");
        ConfigureOracle oracle = new ConfigureOracle();
        oracle.run();

        console.log("");
        console.log("[DiamondConfigSpell] ============================================");
        console.log("[DiamondConfigSpell] 2/4: ConfigureRewardReporter");
        console.log("[DiamondConfigSpell] ============================================");
        ConfigureRewardReporter reporter = new ConfigureRewardReporter();
        reporter.run();

        console.log("");
        console.log("[DiamondConfigSpell] ============================================");
        if (canonical) {
            console.log("[DiamondConfigSpell] 3/4: ConfigureVPFIBuy");
            console.log("[DiamondConfigSpell] ============================================");
            ConfigureVPFIBuy buy = new ConfigureVPFIBuy();
            buy.run();
        } else {
            console.log("[DiamondConfigSpell] 3/4: ConfigureVPFIBuy (SKIPPED - non-canonical chain)");
            console.log("[DiamondConfigSpell] ============================================");
            console.log("[DiamondConfigSpell] chainid:", block.chainid);
            console.log("[DiamondConfigSpell] VPFI buy is canonical-only; mirror chains have no buy receiver to configure.");
        }

        console.log("");
        console.log("[DiamondConfigSpell] ============================================");
        console.log("[DiamondConfigSpell] 4/4: ConfigureNFTImageURIs");
        console.log("[DiamondConfigSpell] ============================================");
        ConfigureNFTImageURIs nft = new ConfigureNFTImageURIs();
        nft.run();

        console.log("");
        console.log("[DiamondConfigSpell] ============================================");
        if (canonical) {
            console.log("[DiamondConfigSpell] All four configures landed.");
        } else {
            console.log("[DiamondConfigSpell] Three configures landed (VPFIBuy skipped on non-canonical).");
        }
        console.log("[DiamondConfigSpell] ============================================");
    }
}
