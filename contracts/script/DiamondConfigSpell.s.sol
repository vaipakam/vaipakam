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
 *      Timelock + VPFI lane + reward messenger on a chain, four further
 *      `Configure*.s.sol` scripts have to run before the chain is
 *      operational:
 *
 *        - ConfigureOracle           — wires oracle adapters + risk
 *                                       params for every supported
 *                                       (lendingAsset, collateralAsset)
 *                                       pair.
 *        - ConfigureRewardReporter   — sets the cross-chain reward
 *                                       reporter's canonical base chain
 *                                       id + messenger so reward reports
 *                                       flow (EVM chain ids, not eids).
 *        - ConfigureVPFIBuy          — sets the VPFI fee-discount price
 *                                      config. #884: NOT run at launch —
 *                                      opt in with CONFIGURE_VPFI_PEG=1
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
 *        2. ConfigureRewardReporter — wires the reporter's chain ids
 *           before the reward-messenger lanes are live (no on-chain
 *           dependency on the order, but logically pairs after
 *           Oracle).
 *        3. ConfigureVPFIBuy — sets the VPFI fee-discount price config.
 *           #884: SKIPPED unless CONFIGURE_VPFI_PEG=1. The Phase-1 posture
 *           is peg-UNSET, and pricing VPFI moves the lender hold discount
 *           off direct reduction onto the VPFI-payment path
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
 *        - REWARD_MESSENGER_PROXY (optional override) / BASE_CHAIN_ID
 *          (reporter — chains are keyed by EVM chain id, never an eid)
 *        - CONFIGURE_VPFI_PEG (optional; default 0). Only when it is 1
 *          does the spell run ConfigureVPFIBuy, and only then are
 *          VPFI_BUY_WEI_PER_VPFI (global) + the chain-prefixed
 *          <CHAIN>_VPFI_DISCOUNT_ETH_PRICE_ASSET required. A launch
 *          leaves the peg unset (#884)
 *        - NFT_DEFAULT_IMAGE_LENDER / _BORROWER and the per-state
 *          override URIs (NFT artwork; defaults are baked into the
 *          contract so all of these are optional).
 *
 *      Cross-chain transport config is NOT in this spell. It is
 *      `ConfigureCcip.s.sol`, run at `--phase ccip-wire` — after the
 *      contracts phase has landed on EVERY chain in the topology, since
 *      it reads each one's addresses.json. (The old `--phase lz-config` /
 *      `ConfigureLZConfig.s.sol` step named here previously is gone with
 *      LayerZero; no wrapper dispatches that phase.)
 */
contract DiamondConfigSpell is Script {
    /// @notice #884 — the peg decision, extracted so it is TESTABLE.
    /// @dev    Codex #1920 r2 corrected me here: I claimed no Solidity test
    ///         could observe this branch because it lives in a broadcast
    ///         script behind an env var. That is false — `vm.setEnv` exists
    ///         (`forge-std/src/Vm.sol:615`) and three deploy tests in this
    ///         repo already use it. The claim was wrong and it is what let
    ///         the regression ship without a test.
    ///
    ///         Pulling the decision out of `run()` means the DEFAULT-OFF
    ///         posture and the opt-in are both pinned by
    ///         `DiamondConfigSpellPegGateTest`, without a test having to
    ///         broadcast a whole deploy.
    /// @return true only when an operator has explicitly asked for the peg.
    function pegConfigureRequested() public view returns (bool) {
        return vm.envOr("CONFIGURE_VPFI_PEG", uint256(0)) == 1;
    }

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

            // #884 — the VPFI discount PEG is OPT-IN, and off by default.
            //
            // The Phase-1 launch posture is peg-UNSET (the lender yield-fee
            // rules are `VpfiAbsorptionDistributionFormulaRedesign.md` §F2;
            // the launch posture itself is TokenomicsTechSpec's VPFI
            // fee-discount section):
            // with no peg, the lender yield-fee discount is delivered in
            // DIRECT-REDUCTION mode and carries the WHOLE discount — the
            // consent-gated hold slice plus the Full-tariff bump. Setting the
            // peg silently changes that product: `LibVPFIDiscount` keys on
            // `vpfiDiscountWeiPerVpfi != 0 && vpfiDiscountEthPriceAsset != 0`
            // and, once set, drops the hold slice from the fallback because it
            // becomes VPFI-PAYMENT-authoritative. A consenting lender then has
            // to pay VPFI to receive what the unset posture gave them outright.
            //
            // Running this step at launch also FALSIFIED the #1356 retail
            // guardrail: that test asserts the peg is unset on a fresh deploy,
            // and the very next phase pegged it. The assert was true and the
            // deployment was not.
            //
            // So the peg now moves only when an operator asks for it, the way
            // every other ceremony knob does. `SKIP_VPFI=1` is the wrong lever
            // for this — it also skips ConfigureVPFIToken and
            // ConfigureRewardReporter, and both deploy wrappers force
            // `SKIP_VPFI=0`.
            bool configurePeg = pegConfigureRequested();
            if (!configurePeg) {
                console.log("");
                console.log("[DiamondConfigSpell] ConfigureVPFIBuy SKIPPED (#884) -");
                console.log("  the VPFI discount peg stays UNSET, which is the Phase-1");
                console.log("  launch posture. Set CONFIGURE_VPFI_PEG=1 to run it.");
            } else {
                console.log("");
                console.log("[DiamondConfigSpell] ============================================");
                console.log("[DiamondConfigSpell] ConfigureVPFIBuy (discount price) - OPT-IN");
                console.log("[DiamondConfigSpell] ============================================");
                // #687-A: the discount applies on EVERY VPFI chain (not the
                // removed canonical-only sale), so when it IS requested the
                // price config runs on any chain that has the VPFI stack.
                ConfigureVPFIBuy buy = new ConfigureVPFIBuy();
                buy.run();
            }
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
