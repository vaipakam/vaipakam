// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardCommitmentFacet} from "../src/facets/RewardCommitmentFacet.sol";
import {IRewardMessenger, ChainDayReport} from "../src/interfaces/IRewardMessenger.sol";
import {Deployments} from "./lib/Deployments.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @dev Minimal local interface for `VaipakamRewardMessenger.diamond()`.
///      Used by the env-only branch of `run()` to ask the messenger
///      contract whose Diamond it thinks it's bound to. The `diamond`
///      field is plain storage (set in the messenger's
///      `initialize()` and mutable via its `onlyOwner setDiamond`
///      mutator), so this is OPERATIONAL defence against honest
///      stale-env mistakes, NOT a cryptographic anchor against a
///      malicious `diamond()` impl or a compromised messenger owner —
///      see the long-form comment at the call site for the full
///      threat-model breakdown.
///
///      Local declaration avoids dragging the whole
///      `VaipakamRewardMessenger` Solidity import (with its CCIP /
///      OpenZeppelin transitive cost) into this thin configure script.
interface IPeerBoundMessenger {
    function diamond() external view returns (address);
}

/**
 * @title ConfigureRewardReporter
 * @notice One-shot post-deploy script that wires the Diamond's cross-chain
 *         reward plumbing (RewardReporterFacet + RewardAggregatorFacet) to
 *         the deployed reward messenger.
 * @dev Runs per chain. Caller must hold `ADMIN_ROLE`.
 *
 *      T-068 (LayerZero→CCIP): the reward facets key chains by EVM chain
 *      id, not by a LayerZero endpoint id. A chain's own identity is
 *      `block.chainid` — there is no `setLocalEid` any more. This script
 *      therefore configures the canonical chain id and the expected
 *      source chain ids as plain EVM chain ids.
 *
 *      Steps (all idempotent):
 *        1. setBaseChainId(canonicalBaseChainId)
 *        2. setRewardMessenger(rewardMessengerProxy)
 *        3. setRewardGraceSeconds(default 14400 unless env overrides)
 *        4. setIsCanonicalRewardChain(true on Base only)
 *        5. (Base only) setExpectedSourceChainIds(list of source chain ids)
 *        6. (Base only) setMirrorRewardDeployment per mirror chain
 *        7. (Base only, #2909) setLapseSchedule(window, cutoff gap) — only
 *           when the version in force does not already carry exactly
 *           these values. Versions are append-only, so a re-run with the
 *           same values creates no new version.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY        : ADMIN_ROLE-holding EOA. The
 *                                      RewardReporterFacet setters this
 *                                      script broadcasts (`setBaseChainId`,
 *                                      `setRewardMessenger`,
 *                                      `setIsCanonicalRewardChain`,
 *                                      `setExpectedSourceChainIds`) all
 *                                      gate on `ADMIN_ROLE`.
 *        - <CHAIN>_DIAMOND_ADDRESS  : Diamond proxy for this chain
 *        - REWARD_OAPP_PROXY        : reward messenger proxy address
 *        - BASE_CHAIN_ID            : EVM chain id of the canonical (Base)
 *                                      reward chain — e.g. 8453 mainnet,
 *                                      84532 Base Sepolia
 *        - REWARD_GRACE_SECONDS     : optional, default 14400 (4h)
 *        - REWARD_EXPECTED_SOURCE_CHAIN_IDS : comma-separated EVM chain
 *                                      ids (only needed on Base). Example
 *                                      "8453,42161,10,137".
 *        - REWARD_LAPSE_WINDOW_SECONDS : Base only, optional, default
 *                                      604800 (7 days, design §7). How
 *                                      long after finalization a zeroed
 *                                      or short-compensated day lapses.
 *                                      The facet refuses [< 3 days, > 30
 *                                      days].
 *        - REWARD_DISPATCH_CUTOFF_GAP_SECONDS : Base only, optional,
 *                                      default 86400 (24 hours, design
 *                                      §7). How long before a day's lapse
 *                                      a manual compensation must be
 *                                      dispatched. The facet refuses
 *                                      [< 6 hours, > 7 days] and any pair
 *                                      whose window is not at least this
 *                                      gap + 48 hours.
 *        - BASE_REWARD_DEPLOYMENT   : mirror chains only (#1434 P2-w1) —
 *                                      the canonical BASE DIAMOND address,
 *                                      the era ground truth every V3
 *                                      (kind-10) broadcast must name.
 *                                      Unset ⇒ loud warning and the V3
 *                                      ingress stays DARK (fail-closed)
 *                                      on this mirror until
 *                                      `setBaseRewardDeployment` is
 *                                      called.
 */
contract ConfigureRewardReporter is Script {
    /// @dev #2909 — the zeroed-day lapse schedule's deploy defaults, the
    ///      values proposed in `Vpfi1434P2ZeroedDayMechanismsDesign.md` §7.
    ///      The bounds are the facet's, not restated here: an out-of-range
    ///      override reverts the simulation before anything is broadcast.
    uint256 internal constant DEFAULT_LAPSE_WINDOW_SECONDS = 7 days;
    uint256 internal constant DEFAULT_DISPATCH_CUTOFF_GAP_SECONDS = 24 hours;

    /// @dev Base chainIds (8453 mainnet, 84532 sepolia) are canonical, by the
    ///      one rule `Launch` also declares the expected role from (#2920).
    function _isCanonicalRewardChain() internal view returns (bool) {
        return Deployments.isCanonicalRewardChainId(block.chainid);
    }

    function run() external {
        uint256 deployerKey = vm.envUint("ADMIN_PRIVATE_KEY");
        // Read prior deploy artifacts. Diamond reads from
        // deployments/<chain>/addresses.json with chain-prefixed env
        // fallback. The reward messenger (`VaipakamRewardMessenger`,
        // T-068 CCIP) is recorded under `.rewardMessenger`; an explicit
        // `REWARD_MESSENGER_PROXY` env var, when set, overrides the
        // artifact read — the multi-chain orchestrators pass it so this
        // script never has to depend on the artifact key staying in step.
        //
        // The LayerZero-era name `REWARD_OAPP_PROXY` is still accepted as
        // a deprecated fallback so an existing operator .env keeps
        // working; it is consulted only when the current name is unset.
        //
        // Defence-in-depth (PR #272): when BOTH the env var and the
        // artifact resolve, they must agree. A stale override
        // carried over from a prior chain's run in a multi-chain loop —
        // or an operator running `forge script ConfigureRewardReporter`
        // directly with an old env var — would otherwise silently wire
        // the wrong-chain messenger on this Diamond. The deploy-script
        // wrappers (`deploy-testnet.sh` / `deploy-mainnet.sh`) `unset`
        // the env at the start of phase_configure, but a direct invoke
        // bypasses that. This mismatch check makes the bug loud.
        address diamond = Deployments.readDiamond();
        address envOverride = vm.envOr("REWARD_MESSENGER_PROXY", address(0));
        if (envOverride == address(0)) {
            // Deprecated LayerZero-era name — kept so an operator .env
            // written before the CCIP rename still resolves.
            envOverride = vm.envOr("REWARD_OAPP_PROXY", address(0));
        }
        // Use the optional reader (returns address(0) on miss) so the
        // env-only path doesn't get blocked by a missing artifact.
        address artifactValue = Deployments.tryReadRewardMessenger();
        address rewardMessenger;
        if (envOverride != address(0) && artifactValue != address(0)) {
            // BOTH set: must agree, else likely stale env from a prior
            // chain's run.
            require(
                envOverride == artifactValue,
                "ConfigureRewardReporter: REWARD_MESSENGER_PROXY env disagrees with .rewardMessenger artifact "
                "(likely stale env from a prior chain's run; unset and rerun, or fix the artifact)"
            );
            rewardMessenger = envOverride;
        } else if (envOverride != address(0)) {
            // Env-only path (no artifact yet on this chain).
            rewardMessenger = envOverride;
        } else if (artifactValue != address(0)) {
            // Artifact-only path (no env override).
            rewardMessenger = artifactValue;
        } else {
            // Neither — load the reverting reader to produce the usual
            // env-fallback error path (`<PREFIX>REWARD_MESSENGER_ADDRESS` env var
            // or `.rewardMessenger` artifact missing). This FAILS LOUD by design:
            // a missing reward messenger on a normal deploy must not be silently
            // configured-around. The `--skip-vpfi` case (no cross-chain stack)
            // never reaches this script — `DiamondConfigSpell` skips the
            // VPFI-dependent children as a group when SKIP_VPFI=1 (#857).
            rewardMessenger = Deployments.readRewardMessenger();
        }
        // Defence-in-depth (PR #272 round 4): apply the messenger
        // interface + peer-binding verify to EVERY resolved address,
        // regardless of which source (env / artifact / both) supplied
        // it. Codex flagged two paths in the prior shape:
        //   (a) `BuybackRemittanceReceiver` also exposes a `diamond()` getter
        //       bound to the canonical Base Diamond. The env-only
        //       branch's narrow `.diamond()`-only check would have
        //       accepted that contract, then `setRewardMessenger(...)`
        //       would land, and subsequent
        //       `IRewardMessenger.sendChainReport` calls on it would
        //       fail downstream — silent miswire.
        //   (b) The env+artifact-match branch skipped the verify
        //       entirely: a copied stale artifact PLUS a matching
        //       stale env would have agreed on the same wrong
        //       address and gone through unchecked.
        // The helper closes both: interface presence (via
        // IRewardMessenger selector existence) distinguishes a real
        // messenger from any contract that happens to expose
        // `diamond()`; peer-binding asserts the messenger is bound
        // to THIS Diamond. Applied uniformly to every non-zero
        // resolved address.
        _assertIsMessengerBoundToThisDiamond(rewardMessenger, diamond);
        // EVM chain id of the canonical (Base) reward chain — the
        // destination for mirror-side chain reports. The reward facets
        // key by chain id (T-068), so this MUST be a real chain id
        // (8453 / 84532), never a LayerZero endpoint id.
        uint32 baseChainId = uint32(vm.envUint("BASE_CHAIN_ID"));
        uint64 grace = uint64(vm.envOr("REWARD_GRACE_SECONDS", uint256(14400)));
        bool canonical = _isCanonicalRewardChain();

        console.log("=== Configure Reward Reporter ===");
        console.log("Chain id:      ", block.chainid);
        console.log("Diamond:       ", diamond);
        console.log("RewardMessenger:    ", rewardMessenger);
        console.log("Base chain id: ", uint256(baseChainId));
        console.log("Grace secs:    ", uint256(grace));
        console.log("Canonical:     ", canonical);

        // #1434 P2-w1 (Codex #1632 r2) — the mirror's V3 era ground truth:
        // the CANONICAL BASE DIAMOND address every kind-10 broadcast must
        // name. Resolved OUTSIDE the broadcast so a missing value warns
        // before any tx lands. Without it the V3 (kind-10) ingress is
        // deliberately DARK on this mirror (fail-closed,
        // `BroadcastEraUnauthenticated`; deliveries stay re-executable).
        // Kind 10 is the only broadcast wire (#1944), so until it is set no
        // day figures or day clocks reach this mirror at all.
        // Canonical chains never receive broadcasts and need no value.
        address baseRewardDeployment =
            vm.envOr("BASE_REWARD_DEPLOYMENT", address(0));
        if (!canonical && baseRewardDeployment == address(0)) {
            console.log(
                "WARNING: BASE_REWARD_DEPLOYMENT unset - the V3 (kind-10) "
                "broadcast ingress stays DARK on this mirror until "
                "setBaseRewardDeployment is called (no broadcast day "
                "applies here until then)."
            );
        }

        // #1566 closure 3 — a MIRROR must name a real base. Since the role
        // resolver distinguishes `Detached` from `Unconfigured`, writing a zero
        // base on a non-canonical chain is a configuration act that puts this
        // Diamond into the DETACHED role: bound zero, nothing claimable. Before
        // the resolver the same misconfiguration silently granted canonical
        // (unbounded) semantics to a chain that is not canonical, which is
        // worse but quieter. Refuse it here so neither can happen — the comment
        // above already states this must be a real chain id.
        if (!canonical && baseChainId == 0) {
            revert(
                "BASE_CHAIN_ID must be the canonical reward chain's EVM chain id "
                "(e.g. 8453 / 84532) on a mirror. Zero would configure this "
                "Diamond into the DETACHED role and stop reward claims."
            );
        }

        // #2909 — the zeroed-day lapse schedule (canonical only: it is
        // authoritative on Base and rides the kind-10 broadcast to every
        // mirror). A day freezes the version in force when it finalizes and
        // keeps it for good, and version 0 means "never lapses, no dispatch
        // cutoff", so a chain left without one would hold every
        // uncompensated zeroed day open forever and enforce no R3 cutoff.
        // Resolved here so the values are logged before anything lands.
        uint64 lapseWindow;
        uint64 dispatchCutoffGap;
        if (canonical) {
            lapseWindow = SafeCast.toUint64(
                vm.envOr("REWARD_LAPSE_WINDOW_SECONDS", DEFAULT_LAPSE_WINDOW_SECONDS)
            );
            dispatchCutoffGap = SafeCast.toUint64(
                vm.envOr(
                    "REWARD_DISPATCH_CUTOFF_GAP_SECONDS",
                    DEFAULT_DISPATCH_CUTOFF_GAP_SECONDS
                )
            );
            console.log("Lapse window:  ", uint256(lapseWindow));
            console.log("Cutoff gap:    ", uint256(dispatchCutoffGap));
        }

        vm.startBroadcast(deployerKey);
        RewardReporterFacet rr = RewardReporterFacet(diamond);
        // No `setLocalEid` — a chain's identity is `block.chainid`.
        rr.setBaseChainId(baseChainId);
        rr.setRewardMessenger(rewardMessenger);
        rr.setRewardGraceSeconds(grace);
        rr.setIsCanonicalRewardChain(canonical);
        if (!canonical && baseRewardDeployment != address(0)) {
            rr.setBaseRewardDeployment(baseRewardDeployment);
            console.log("Base reward deployment:", baseRewardDeployment);
        }

        if (canonical) {
            string memory csv =
                vm.envOr("REWARD_EXPECTED_SOURCE_CHAIN_IDS", string(""));
            if (bytes(csv).length == 0) {
                console.log(
                    "WARNING: canonical chain but REWARD_EXPECTED_SOURCE_CHAIN_IDS empty; skipping aggregator wiring."
                );
            } else {
                uint32[] memory chainIds = _parseChainIdCsv(csv);
                RewardAggregatorFacet(diamond).setExpectedSourceChainIds(chainIds);
                console.log("Expected source chains set:", chainIds.length);
            }

            // #1434 P2-w3 (#1636 r3) — the Base-side reciprocal of the
            // mirror's BASE_REWARD_DEPLOYMENT: the CURRENT mirror Diamond
            // per source chain, the fail-closed era ground truth the
            // compensation-quote (kind-11) ingress authenticates EVERY
            // arrival against. While a chain is unregistered its quotes
            // revert `CompQuoteMirrorEraUnset` (failed, re-executable
            // CCIP messages) — so zeroed-day compensation on that lane is
            // unreachable until this registration lands. Format:
            // "42161:0xabc...,10:0xdef..." (chainId:diamondAddress).
            string memory mirrorCsv =
                vm.envOr("MIRROR_REWARD_DEPLOYMENTS", string(""));
            if (bytes(mirrorCsv).length == 0) {
                console.log(
                    "WARNING: canonical chain but MIRROR_REWARD_DEPLOYMENTS "
                    "empty - the compensation-quote (kind-11) ingress stays "
                    "DARK (fail-closed, CompQuoteMirrorEraUnset) until "
                    "setMirrorRewardDeployment is called per mirror chain."
                );
            } else {
                _applyMirrorDeployments(diamond, mirrorCsv);
            }

            // After setIsCanonicalRewardChain above: the setter is
            // canonical-only.
            _applyLapseSchedule(diamond, lapseWindow, dispatchCutoffGap);
        }
        vm.stopBroadcast();

        // Mirror the per-chain reward-mesh config into the artifact so
        // downstream scripts + the frontend env builder don't have to
        // re-read env vars or query the Diamond.
        Deployments.writeRewardMessenger(rewardMessenger);
        Deployments.writeRewardBaseChainId(baseChainId);
        Deployments.writeRewardGraceSeconds(grace);
        Deployments.writeIsCanonicalReward(canonical);
        if (!canonical && baseRewardDeployment != address(0)) {
            Deployments.writeAddress(
                ".baseRewardDeployment", baseRewardDeployment
            );
        }

        console.log("Reward reporter configuration applied.");
        // #1566 slice 4 PR B — a configured role is the precondition of the
        // custody activation ceremony, which is NOT run here: it needs the
        // manual pause and the operator's per-row answers.
        console.log("Next (#1566 slice 4 PR B): once the holder is bound, run the reward custody activation ceremony under the manual pause -- script/ActivateRewardCustody.s.sol (run()/stage() then record()); until it runs, a Canonical chain's reward claims and remittances are refused (delivered bound = received - paid = 0).");
    }

    /// @dev #2909 — make `(window, gap)` the schedule in force. A new
    ///      version is created only when the current one differs (or none
    ///      exists): versions are append-only and each finalized day keeps
    ///      the one it froze, so re-running configure with the same values
    ///      must not mint a duplicate version.
    function _applyLapseSchedule(
        address diamond,
        uint64 window,
        uint64 gap
    ) internal {
        RewardCommitmentFacet rc = RewardCommitmentFacet(diamond);
        uint32 current = rc.getCurrentLapseScheduleVersion();
        if (current != 0) {
            (uint64 curWindow, uint64 curGap) = rc.getLapseSchedule(current);
            if (curWindow == window && curGap == gap) {
                console.log("Lapse schedule already in force, version", uint256(current));
                return;
            }
        }
        rc.setLapseSchedule(window, gap);
        console.log("Lapse schedule set, version", uint256(current) + 1);
    }

    /// @dev #1636 r3 — parse "chainId:0xaddr,chainId:0xaddr" and register
    ///      each pair as the chain's current mirror Diamond. Same
    ///      no-whitespace ops-only posture as {_parseChainIdCsv}.
    function _applyMirrorDeployments(
        address diamond,
        string memory s
    ) internal {
        bytes memory b = bytes(s);
        uint256 start = 0;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                // One "chainId:0xaddr" segment in [start, i).
                uint256 colon = start;
                while (colon < i && b[colon] != ":") colon++;
                require(
                    colon > start && colon < i,
                    "ConfigureRewardReporter: MIRROR_REWARD_DEPLOYMENTS "
                    "segment must be chainId:address"
                );
                uint256 acc = 0;
                for (uint256 j = start; j < colon; j++) {
                    require(
                        b[j] >= 0x30 && b[j] <= 0x39,
                        "ConfigureRewardReporter: non-digit chain id in "
                        "MIRROR_REWARD_DEPLOYMENTS"
                    );
                    acc = acc * 10 + (uint8(b[j]) - 0x30);
                }
                bytes memory addrStr = new bytes(i - colon - 1);
                for (uint256 j = colon + 1; j < i; j++) {
                    addrStr[j - colon - 1] = b[j];
                }
                address dep = vm.parseAddress(string(addrStr));
                require(
                    dep != address(0),
                    "ConfigureRewardReporter: zero mirror deployment"
                );
                RewardCommitmentFacet(diamond).setMirrorRewardDeployment(
                    SafeCast.toUint32(acc), dep
                );
                console.log("Mirror reward deployment set:", acc, dep);
                start = i + 1;
            }
        }
    }

    /// @dev Parse "8453,42161" → [8453, 42161]. No whitespace tolerance
    ///      (ops-only input; the runbook shows the exact format).
    function _parseChainIdCsv(string memory s)
        internal
        pure
        returns (uint32[] memory out)
    {
        bytes memory b = bytes(s);
        uint256 count = 1;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == ",") count++;
        }
        out = new uint32[](count);
        uint256 acc = 0;
        uint256 idx = 0;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == ",") {
                out[idx++] = SafeCast.toUint32(acc);
                acc = 0;
            } else {
                require(
                    c >= 0x30 && c <= 0x39,
                    "ConfigureRewardReporter: non-digit in chain-id csv"
                );
                acc = acc * 10 + (uint8(c) - 0x30);
            }
        }
        out[idx] = SafeCast.toUint32(acc);
    }

    /// @dev Defence-in-depth assertion that `candidate` is a contract
    ///      that:
    ///        (1) has runtime bytecode (not an EOA);
    ///        (2) implements the `IRewardMessenger` interface, by
    ///            checking that BOTH messenger-specific view selectors
    ///            (`quoteSendChainReport` + `quoteBroadcastDayV3`)
    ///            are present — distinguishes a real messenger from
    ///            `BuybackRemittanceReceiver` or any other contract that
    ///            happens to expose a `diamond()` getter; AND
    ///        (3) reports its `diamond` as the local Diamond — catches
    ///            wrong-chain / wrong-Diamond stale-env mistakes.
    ///
    ///      Selector-existence is detected via low-level `staticcall`
    ///      + `success || returndata.length > 0`. This is robust to
    ///      revert-with-data outcomes (e.g. CCIP fee oracle reverting
    ///      because lanes aren't configured yet — still proves the
    ///      selector is implemented). Only a true "no selector + no
    ///      fallback" call produces `(false, empty)`, which is what
    ///      we reject.
    ///
    ///      Operational defence; NOT cryptographic — see the
    ///      threat-model breakdown in `run()`. A motivated attacker
    ///      with `ADMIN_PRIVATE_KEY` can bypass the script entirely;
    ///      a compromised messenger owner who set `setDiamond` to
    ///      spoof can satisfy (3). Both are admin-trust-boundary
    ///      compromises out of scope for the configure script.
    function _assertIsMessengerBoundToThisDiamond(
        address candidate,
        address localDiamond
    ) internal view {
        require(
            candidate.code.length > 0,
            "ConfigureRewardReporter: rewardMessenger candidate is not a contract "
            "(env or artifact resolved to an EOA / undeployed address)"
        );

        // (2a) IRewardMessenger.quoteSendChainReport selector present? One
        // report shape (#2621), so one probe. An empty report to chain 0 is
        // refused by name (`ReportRouteMismatch` / `BaseChainNotConfigured`),
        // which still proves the selector exists.
        ChainDayReport memory probe;
        (bool ok1, bytes memory ret1) = candidate.staticcall(
            abi.encodeCall(IRewardMessenger.quoteSendChainReport, (uint256(0), probe))
        );
        require(
            ok1 || ret1.length > 0,
            "ConfigureRewardReporter: rewardMessenger candidate does not implement "
            "IRewardMessenger.quoteSendChainReport (likely BuybackRemittanceReceiver "
            "or another non-messenger contract bound to the same Diamond)"
        );

        // (2b) IRewardMessenger.quoteBroadcastDayV3 selector present? The one
        // broadcast wire (#1944). An empty destination array either prices
        // to zero or is refused by name (`BroadcastDestinationSetMismatch`),
        // which still proves the selector exists.
        IRewardMessenger.BroadcastV2Shared memory shared;
        IRewardMessenger.BroadcastV3Extras memory extras;
        (bool ok2, bytes memory ret2) = candidate.staticcall(
            abi.encodeCall(
                IRewardMessenger.quoteBroadcastDayV3,
                (shared, extras, new IRewardMessenger.BroadcastV3PerDest[](0))
            )
        );
        require(
            ok2 || ret2.length > 0,
            "ConfigureRewardReporter: rewardMessenger candidate does not implement "
            "IRewardMessenger.quoteBroadcastDayV3 (likely BuybackRemittanceReceiver or another "
            "non-messenger contract bound to the same Diamond)"
        );

        // (3) Peer-binding: messenger.diamond() == localDiamond.
        address bound = IPeerBoundMessenger(candidate).diamond();
        require(
            bound == localDiamond,
            "ConfigureRewardReporter: rewardMessenger candidate's .diamond() does not "
            "match the local Diamond - bound to a different Diamond (likely stale env "
            "or wrong-chain artifact; unset / fix and rerun)"
        );
    }
}
