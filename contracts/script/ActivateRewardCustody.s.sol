// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {Deployments} from "./lib/Deployments.sol";
import {RewardCustodyCeremonyBase} from "./lib/RewardCustodyCeremonyBase.sol";

/**
 * @title  ActivateRewardCustody — the per-chain custody cutover ceremony
 *         (#1566 slice 4 PR B, design §5d "the migration ceremony per
 *         deployment")
 * @notice Runs ONCE per chain whose reward role is ACTIVE (`Canonical` or
 *         `Mirror` — a `Detached` chain waits for slice 4 PR C's era
 *         registry, whose ingress gates the activation needs), after the
 *         facet refresh that cut PR B and
 *         after the holder is bound, under the MANUAL pause. It reconciles
 *         every ledger figure the holder must back into the holder's rows —
 *         each by an EXPLICIT operator answer, never a default — and then
 *         switches this chain's reward reads and debits onto the holder.
 *         An `Unconfigured` deployment (a single-chain deploy) never runs
 *         it: its column stays at Diamond custody by design.
 *
 *  Figures and their answers (per row; a ZERO figure needs no answer, a
 *  non-zero one refuses without exactly one that makes the row EQUAL it):
 *    recycled  `recycleBucket`                     — REWARD_CUSTODY_RELOCATE_RECYCLED (historical inventory,
 *                                                     out of the Diamond's balance, with REWARD_CUSTODY_PROVENANCE)
 *                                                     and/or REWARD_CUSTODY_FUND_RECYCLED (replacement funding
 *                                                     from the signer's own VPFI)
 *    recovery  `recovered − redispatched`          — REWARD_CUSTODY_RELOCATE_RECOVERY / REWARD_CUSTODY_FUND_RECOVERY
 *    overage   `strandedReturnOverage`             — REWARD_CUSTODY_RELOCATE_OVERAGE / REWARD_CUSTODY_FUND_OVERAGE
 *    live      Mirror only: `received − paid`      — REWARD_CUSTODY_FUND_LIVE_FRESH (never a relocation: an imported
 *                                                     gap is history, not money), OR
 *                                                     REWARD_CUSTODY_WRITE_DOWN_MIRROR_GAP=true to write `received`
 *                                                     down to `paid + liveRow` (the design's other executable form)
 *  plus REWARD_CUSTODY_PAUSE_EPOCH — the pause library's transition count at
 *  which the answers were established under the manual pause (the contract
 *  refuses a stale one; this script pauses once more and states `+ 1`).
 *
 *  - `run()`    — DIRECT: `ADMIN_PRIVATE_KEY` holds `ADMIN_ROLE` and
 *                 `PAUSER_ROLE`. Pauses (always, immediately before), applies
 *                 the answers, activates, leaves a ceremony record. Leaves
 *                 the Diamond PAUSED; funding forward (`fundRewardPool`) is
 *                 for after the unpause.
 *  - `stage()`  — STAGED, after governance handover: broadcasts nothing;
 *                 writes the calldata the Pauser Safe and the Timelock
 *                 execute (pause; VPFI approvals + row credits; activate).
 *  - `check()`  — validate a pending record and write nothing.
 *  - `record()` — after the transactions confirmed: verifies the chain
 *                 reports the custody ACTIVATED, keeps the record as
 *                 `reward-custody-activated.json` beside the artifact (the
 *                 figures and answers, durable), removes the pending one.
 *                 The artifact itself is not written: activation is chain
 *                 state (`rewardCustodyActivated()`), and a refresh never
 *                 re-runs this.
 */
contract ActivateRewardCustody is RewardCustodyCeremonyBase {
    string internal constant KIND = "activation";

    struct Figures {
        uint8 role;
        uint256 received;
        uint256 paid;
        uint256 bucket;
        uint256 position;
        uint256 overage;
        uint256 rowLive;
        uint256 rowRecycled;
        uint256 rowRecovery;
        uint256 rowOverage;
    }

    struct Answers {
        uint64 pauseEpoch;
        bool writeDown;
        uint256 fundLive;
        uint256 fundRecycled;
        uint256 relocRecycled;
        uint256 fundRecovery;
        uint256 relocRecovery;
        uint256 fundOverage;
        uint256 relocOverage;
        string provenance;
    }

    // ─── Reads ──────────────────────────────────────────────────────────────

    function _boundNotActivated() internal view returns (address diamond, address holder) {
        (diamond, holder) = _diamondAndBound();
        require(holder != address(0), "ActivateRewardCustody: no holder is bound -- run DeployRewardCustodyHolder first");
        require(
            !RewardCustodyFacet(diamond).rewardCustodyActivated(),
            "ActivateRewardCustody: reward custody is already activated on this chain -- nothing to do"
        );
    }

    function _figures(address diamond) internal view returns (Figures memory f) {
        RewardCustodyFacet c = RewardCustodyFacet(diamond);
        f.role = RewardReporterFacet(diamond).getRewardRole();
        (f.received, f.paid) = c.armedFreshLedger();
        f.bucket = ConfigFacet(diamond).getRecycleBucket();
        (uint256 recovered, uint256 redispatched, uint256 overage) =
            RewardRemittanceLensFacet(diamond).getRecoveryPosition();
        f.position = recovered - redispatched;
        f.overage = overage;
        f.rowLive = c.rewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh);
        f.rowRecycled = c.rewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled);
        f.rowRecovery = c.rewardCustodyRow(LibVaipakam.RewardCustodyRow.Recovery);
        f.rowOverage = c.rewardCustodyRow(LibVaipakam.RewardCustodyRow.Overage);
    }

    function _answers() internal view returns (Answers memory a) {
        a.pauseEpoch = uint64(vm.envUint("REWARD_CUSTODY_PAUSE_EPOCH"));
        a.writeDown = vm.envOr("REWARD_CUSTODY_WRITE_DOWN_MIRROR_GAP", false);
        a.fundLive = vm.envOr("REWARD_CUSTODY_FUND_LIVE_FRESH", uint256(0));
        a.fundRecycled = vm.envOr("REWARD_CUSTODY_FUND_RECYCLED", uint256(0));
        a.relocRecycled = vm.envOr("REWARD_CUSTODY_RELOCATE_RECYCLED", uint256(0));
        a.fundRecovery = vm.envOr("REWARD_CUSTODY_FUND_RECOVERY", uint256(0));
        a.relocRecovery = vm.envOr("REWARD_CUSTODY_RELOCATE_RECOVERY", uint256(0));
        a.fundOverage = vm.envOr("REWARD_CUSTODY_FUND_OVERAGE", uint256(0));
        a.relocOverage = vm.envOr("REWARD_CUSTODY_RELOCATE_OVERAGE", uint256(0));
        a.provenance = vm.envOr("REWARD_CUSTODY_PROVENANCE", string(""));
    }

    // ─── Pre-flight: every refusal the chain would raise, before anything is sent ─

    function _preflight(address diamond, Figures memory f, Answers memory a) internal view {
        (bool manual, , , uint64 live) =
            LibPausable.decodePausableSlot(vm.load(diamond, LibPausable.PAUSABLE_STORAGE_POSITION));
        require(manual, "ActivateRewardCustody: the Diamond is not under the MANUAL pause -- establish the figures under AdminFacet.pause() and state REWARD_CUSTODY_PAUSE_EPOCH");
        require(
            a.pauseEpoch == live,
            "ActivateRewardCustody: REWARD_CUSTODY_PAUSE_EPOCH is not the live pause epoch -- the pause moved since the figures were established; re-establish them under the current pause"
        );
        require(
            f.role != uint8(LibVaipakam.RewardRole.Unconfigured),
            "ActivateRewardCustody: this deployment's reward role is Unconfigured -- it keeps Diamond custody by design and never activates; configure the role first if it is meant to have one"
        );
        require(
            f.role != uint8(LibVaipakam.RewardRole.Detached),
            "ActivateRewardCustody: this deployment is Detached -- activation waits for slice 4 PR C (the receive ingresses do not yet refuse by role, and the freeze would block re-attachment); re-attach first, or wait"
        );
        require(
            RewardCustodyFacet(diamond).armedFreshPaidRebased(),
            "ActivateRewardCustody: the paid-side rebase has not run on this chain -- run the facet refresh's migrations first"
        );
        // Mirrors the contract's complete-cut gate BEFORE anything is sent
        // (Codex #2186 r4 P1): activation and the bootstrap writers refuse
        // unless the routing — every facet with its selectors — is the one a
        // complete refresh recorded under this tree's custody protocol
        // version.
        {
            (uint32 stampedV, uint32 requiredV, bytes32 stampedRouting, bytes32 currentRouting) =
                RewardCustodyFacet(diamond).rewardCustodyCutoverStatus();
            require(
                stampedV == requiredV && stampedRouting == currentRouting,
                "ActivateRewardCustody: the routing is not the one a COMPLETE refresh recorded (RefreshAllFacetsInPlace / DeployDiamond) -- the custody facet was cut alone, a partial cut of a facet or a selector ran since, or the record is from an older tree; run the complete refresh, then activate"
            );
        }
        // Mirrors the contract's canonical prerequisite BEFORE anything is
        // sent (Codex #2186 r2 P2): a canonical chain whose recovery
        // attribution was never armed (a partial refresh) would otherwise
        // refuse only at the activation call, after the pause, the approval
        // and the row credits had already mined.
        if (f.role == uint8(LibVaipakam.RewardRole.Canonical)) {
            require(
                RewardRemittanceLensFacet(diamond).recoveryAttributionArmed(),
                "ActivateRewardCustody: this canonical chain has not armed per-receipt recovery attribution (the refresh's armRecoveryAttribution migration) -- activation would refuse after the row credits had mined; run that migration first"
            );
        }
        // Mirrors the activation's HOLDER-WIDE check BEFORE anything is sent
        // (Codex #2193 r6): the holder's balance in the configured token
        // must be readable and must cover the total of every attribution —
        // the row equalities below can all hold while this refuses.
        {
            (, , bool balanceKnown, uint256 held, uint256 attributed) =
                RewardCustodyFacet(diamond).rewardCustodySnapshot();
            require(
                balanceKnown,
                "ActivateRewardCustody: the holder's balance in the configured VPFI token cannot be read (unbound holder, unset or non-conforming token) -- activation would refuse after the row credits had mined"
            );
            require(
                held >= attributed,
                "ActivateRewardCustody: the holder holds less than its attributed rows -- custody left the holder; reconcile (sweep or fund) before activating"
            );
        }
        _requireRowAnswer("recycled", f.bucket, f.rowRecycled, a.fundRecycled, a.relocRecycled, "REWARD_CUSTODY_FUND_RECYCLED", "REWARD_CUSTODY_RELOCATE_RECYCLED");
        _requireRowAnswer("recovery", f.position, f.rowRecovery, a.fundRecovery, a.relocRecovery, "REWARD_CUSTODY_FUND_RECOVERY", "REWARD_CUSTODY_RELOCATE_RECOVERY");
        _requireRowAnswer("overage", f.overage, f.rowOverage, a.fundOverage, a.relocOverage, "REWARD_CUSTODY_FUND_OVERAGE", "REWARD_CUSTODY_RELOCATE_OVERAGE");
        if (a.relocRecycled + a.relocRecovery + a.relocOverage != 0) {
            require(
                bytes(a.provenance).length != 0,
                "ActivateRewardCustody: a relocation out of the Diamond's balance needs REWARD_CUSTODY_PROVENANCE (the census / ceremony reference proving the inventory is this ledger's) -- slice 0's provenance bar"
            );
        }
        if (f.role == uint8(LibVaipakam.RewardRole.Canonical)) {
            require(
                f.received == f.paid,
                "ActivateRewardCustody: canonical baseline not verified (received != paid) -- the rebase installs received = paid; examine the ledger before activating"
            );
            require(f.rowLive == 0 && a.fundLive == 0, "ActivateRewardCustody: a canonical chain activates with an EMPTY live-fresh row -- fund forward through fundRewardPool after the unpause, never here");
            require(!a.writeDown, "ActivateRewardCustody: REWARD_CUSTODY_WRITE_DOWN_MIRROR_GAP applies to a Mirror only");
        } else if (f.role == uint8(LibVaipakam.RewardRole.Mirror)) {
            uint256 gap = f.received > f.paid ? f.received - f.paid : 0;
            uint256 liveAfter = f.rowLive + a.fundLive;
            if (a.writeDown) {
                require(liveAfter < gap, "ActivateRewardCustody: REWARD_CUSTODY_WRITE_DOWN_MIRROR_GAP=true but the live-fresh row would not be below the imported gap -- nothing to write down; drop the flag");
            } else {
                require(
                    liveAfter == gap,
                    "ActivateRewardCustody: the mirror's imported received - paid gap is not backed by the live-fresh row -- state REWARD_CUSTODY_FUND_LIVE_FRESH (custody-only replacement funding, up to the gap) or REWARD_CUSTODY_WRITE_DOWN_MIRROR_GAP=true to write received down to what the holder backs"
                );
            }
        }
    }

    function _requireRowAnswer(
        string memory name,
        uint256 figure,
        uint256 row,
        uint256 fund,
        uint256 reloc,
        string memory fundVar,
        string memory relocVar
    ) internal pure {
        uint256 required = figure > row ? figure - row : 0;
        require(
            row <= figure,
            string.concat("ActivateRewardCustody: the ", name, " row already exceeds its ledger figure -- custody no ledger describes; examine before activating")
        );
        require(
            fund + reloc == required,
            string.concat(
                "ActivateRewardCustody: the ", name, " figure is not backed by its row and the stated answers do not close the gap exactly -- set ",
                fundVar, " (replacement funding) and/or ", relocVar, " (historical relocation) so they sum to the shortfall; a zero shortfall takes no answer"
            )
        );
    }

    /// @dev The VPFI token the ceremony approves and funds in: the artifact's,
    ///      REQUIRED to be the Diamond's configured one (Codex #2186 r4 P2).
    ///      A pre-activation rotation is permitted and leaves `addresses.json`
    ///      stale; an approval serialised against the stale token would let
    ///      the pause and the relocations mine before a funded row failed
    ///      for lack of allowance — a partially applied ceremony. Refused
    ///      here, before anything is sent or staged, exactly as the holder is.
    function _vpfiToken(address diamond) internal view returns (address vpfi) {
        vpfi = Deployments.readVpfiToken();
        address live = VPFITokenFacet(diamond).getVPFIToken();
        require(
            vpfi == live,
            "ActivateRewardCustody: the artifact's vpfiToken is not the Diamond's configured VPFI token -- a rotation ran since the artifact was written; re-export the artifact (or correct VPFI_TOKEN_ADDRESS) before approving or staging against it"
        );
    }

    function _totalFunding(Answers memory a) internal pure returns (uint256) {
        return a.fundLive + a.fundRecycled + a.fundRecovery + a.fundOverage;
    }

    // ─── Direct ─────────────────────────────────────────────────────────────

    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        (address diamond, address holder) = _boundNotActivated();
        _requireNoPendingRecord(KIND);
        AccessControlFacet acl = AccessControlFacet(diamond);
        require(
            acl.hasRole(LibAccessControl.ADMIN_ROLE, admin),
            "ActivateRewardCustody: ADMIN_PRIVATE_KEY does not hold ADMIN_ROLE -- after governance handover use stage() / record()"
        );
        require(
            acl.hasRole(LibAccessControl.PAUSER_ROLE, admin),
            "ActivateRewardCustody: ADMIN_PRIVATE_KEY does not hold PAUSER_ROLE -- the ceremony pauses immediately before it activates; after governance handover use stage() / record()"
        );
        Figures memory f = _figures(diamond);
        Answers memory a = _answers();
        _preflight(diamond, f, a);
        address vpfi = _vpfiToken(diamond);
        uint256 funding = _totalFunding(a);
        if (funding != 0) {
            require(
                IERC20(vpfi).balanceOf(admin) >= funding,
                "ActivateRewardCustody: the signer does not hold the VPFI the stated replacement funding needs"
            );
        }

        console.log("=== Reward custody activation (direct) ===");
        console.log("Diamond:", diamond);
        console.log("Holder: ", holder);
        console.log("Role:   ", f.role);
        _logFigures(f, a);

        vm.startBroadcast(adminKey);
        AdminFacet(diamond).pause(); // always, immediately before: counted, so the activation states epoch + 1
        if (funding != 0) IERC20(vpfi).approve(diamond, funding);
        _applyAnswers(diamond, a);
        RewardCustodyFacet(diamond).activateRewardCustody(a.pauseEpoch + 1, a.writeDown);
        vm.stopBroadcast();

        string memory json = _serialize(diamond, holder, f, a, "direct");
        _writeRecord(KIND, json, true);
        console.log("The Diamond is left PAUSED. Once record() has confirmed the activation, resume service by a fresh Unpauser decision, then fund forward through fundRewardPool.");
    }

    function _applyAnswers(address diamond, Answers memory a) internal {
        RewardCustodyFacet c = RewardCustodyFacet(diamond);
        if (a.fundLive != 0) c.fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, a.fundLive);
        if (a.fundRecycled != 0) c.fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, a.fundRecycled);
        if (a.relocRecycled != 0) c.relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, a.relocRecycled);
        if (a.fundRecovery != 0) c.fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recovery, a.fundRecovery);
        if (a.relocRecovery != 0) c.relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recovery, a.relocRecovery);
        if (a.fundOverage != 0) c.fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.Overage, a.fundOverage);
        if (a.relocOverage != 0) c.relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Overage, a.relocOverage);
    }

    // ─── Check / stage / record ─────────────────────────────────────────────

    function check() external view {
        _checkRecord(KIND);
    }

    function stage() external {
        (address diamond, address holder) = _boundNotActivated();
        _requireNoPendingRecord(KIND);
        Figures memory f = _figures(diamond);
        Answers memory a = _answers();
        _preflight(diamond, f, a);
        address vpfi = _vpfiToken(diamond);
        uint256 funding = _totalFunding(a);

        console.log("=== Reward custody activation (staged) ===");
        console.log("Diamond:", diamond);
        console.log("Holder: ", holder);
        _logFigures(f, a);
        console.log("Execute, in this order:");
        console.log("  1. Pauser Safe  AdminFacet.pause()  -- immediately before the rest; counted, so the activation below states epoch + 1");
        bytes memory pauseCall = abi.encodeCall(AdminFacet.pause, ());
        console.logBytes(pauseCall);
        string memory obj = "ceremony";
        vm.serializeBytes(obj, "step1_pauserSafe_pause", pauseCall);
        if (funding != 0) {
            bytes memory approveCall = abi.encodeCall(IERC20.approve, (diamond, funding));
            console.log("  2. Timelock  VPFI.approve(diamond, funding)  against the VPFI token", vpfi);
            console.logBytes(approveCall);
            vm.serializeBytes(obj, "step2_timelock_vpfiApprove", approveCall);
        }
        // Every non-zero answer is serialised as the EXACT calldata the
        // Timelock executes against the Diamond, one entry per call, in the
        // order to execute them (Codex #2186 r1 P2): an operator executes
        // the record, never reconstructs a fund-moving call from amounts.
        console.log("  3. Timelock  one call per non-zero answer, against the Diamond, in this order:");
        vm.serializeAddress(obj, "target_diamond", diamond);
        vm.serializeAddress(obj, "target_vpfi", vpfi);
        _stageRowCall(obj, "step3a_timelock_fundRewardCustodyRow_liveFresh", LibVaipakam.RewardCustodyRow.LiveFresh, a.fundLive, false);
        _stageRowCall(obj, "step3b_timelock_fundRewardCustodyRow_recycled", LibVaipakam.RewardCustodyRow.Recycled, a.fundRecycled, false);
        _stageRowCall(obj, "step3c_timelock_relocateRewardCustodyRow_recycled", LibVaipakam.RewardCustodyRow.Recycled, a.relocRecycled, true);
        _stageRowCall(obj, "step3d_timelock_fundRewardCustodyRow_recovery", LibVaipakam.RewardCustodyRow.Recovery, a.fundRecovery, false);
        _stageRowCall(obj, "step3e_timelock_relocateRewardCustodyRow_recovery", LibVaipakam.RewardCustodyRow.Recovery, a.relocRecovery, true);
        _stageRowCall(obj, "step3f_timelock_fundRewardCustodyRow_overage", LibVaipakam.RewardCustodyRow.Overage, a.fundOverage, false);
        _stageRowCall(obj, "step3g_timelock_relocateRewardCustodyRow_overage", LibVaipakam.RewardCustodyRow.Overage, a.relocOverage, true);
        bytes memory activateCall = abi.encodeCall(RewardCustodyFacet.activateRewardCustody, (a.pauseEpoch + 1, a.writeDown));
        console.log("  4. Timelock  activateRewardCustody(epoch + 1, writeDown)");
        console.logBytes(activateCall);
        vm.serializeBytes(obj, "step4_timelock_activateRewardCustody", activateCall);
        vm.serializeAddress(obj, "diamond", diamond);
        vm.serializeAddress(obj, "holder", holder);
        vm.serializeString(obj, "mode", "staged");
        vm.serializeUint(obj, "stagedAtBlock", block.number);
        vm.serializeUint(obj, "role", f.role);
        vm.serializeUint(obj, "pauseEpochStated", a.pauseEpoch);
        vm.serializeBool(obj, "writeDownMirrorGap", a.writeDown);
        string memory json = vm.serializeString(obj, "provenance", a.provenance);
        _writeRecord(KIND, json, false);
    }

    /// @dev One executable row call in the staged record: the calldata for
    ///      `fundRewardCustodyRow` or `relocateRewardCustodyRow` against the
    ///      Diamond, logged and serialised under `key`; nothing for a zero
    ///      answer.
    function _stageRowCall(
        string memory obj,
        string memory key,
        LibVaipakam.RewardCustodyRow row,
        uint256 amount,
        bool relocate
    ) internal {
        if (amount == 0) return;
        bytes memory data = relocate
            ? abi.encodeCall(RewardCustodyFacet.relocateRewardCustodyRow, (row, amount))
            : abi.encodeCall(RewardCustodyFacet.fundRewardCustodyRow, (row, amount));
        console.log("    ", key, amount);
        console.logBytes(data);
        vm.serializeBytes(obj, key, data);
    }

    /// @notice After the transactions confirmed: verify the chain against
    ///         the pending record BEFORE anything is promoted, and keep a
    ///         durable record that separates what was STAGED from what the
    ///         chain CONFIRMED (Codex #2186 r1 P2): the pending record's
    ///         figures and answers are intent; the live holder, role,
    ///         activation, ledger and rows are read now and written beside
    ///         them under their own names, so a superseded or partially
    ///         executed bundle can never be filed as fact.
    function record() external {
        string memory json = _readRecord(KIND);
        address diamond = vm.parseJsonAddress(json, ".diamond");
        address stagedHolder = vm.parseJsonAddress(json, ".holder");
        uint256 stagedRole = vm.parseJsonUint(json, ".role");
        bool stagedWriteDown = vm.parseJsonBool(json, ".writeDownMirrorGap");
        console.log("=== Reward custody activation (record) ===");
        console.log("Diamond:", diamond);
        RewardCustodyFacet c = RewardCustodyFacet(diamond);
        require(
            c.rewardCustodyActivated(),
            "ActivateRewardCustody: the Diamond does not report the custody activated -- the bundle has not executed"
        );
        address liveHolder = c.rewardCustodyHolder();
        require(
            liveHolder == stagedHolder,
            "ActivateRewardCustody: the bound holder is not the one the ceremony record names -- a replacement ran meanwhile; the record does not describe this activation"
        );
        uint8 liveRole = RewardReporterFacet(diamond).getRewardRole();
        require(
            uint256(liveRole) == stagedRole,
            "ActivateRewardCustody: the reward role is not the one the ceremony record names -- the record does not describe this activation"
        );
        (uint256 received, uint256 paid) = c.armedFreshLedger();
        (bool activated, bool frozen, uint256 live, uint256 recycled, uint256 recovery, uint256 overage, , , , ) =
            c.rewardCustodyLedger();
        // The one ledger fact a write-down leaves behind: `received` equals
        // `paid + live row` at the moment of activation. Checked for a
        // write-down record only while nothing has moved the ledger since
        // (received still at or below paid + live); a record that claims a
        // write-down over a chain whose ledger shows none refuses.
        if (stagedWriteDown) {
            require(
                received <= paid + live,
                "ActivateRewardCustody: the record claims a mirror-gap write-down but the live ledger still carries received above paid + live row -- the write-down did not execute as staged"
            );
        }
        console.log("Confirmed -- activated:", activated, "frozen:", frozen);
        console.log("Confirmed -- received / paid:", received, paid);
        console.log("Confirmed rows -- live / recycled:", live, recycled);
        console.log("Confirmed rows -- recovery / overage:", recovery, overage);
        string memory durable = string.concat("deployments/", Deployments.chainSlug(), "/reward-custody-activated.json");
        if (_nonBroadcastWritesEnabled()) {
            string memory obj = "confirmed";
            vm.serializeAddress(obj, "confirmedHolder", liveHolder);
            vm.serializeUint(obj, "confirmedRole", liveRole);
            vm.serializeBool(obj, "confirmedActivated", activated);
            vm.serializeBool(obj, "confirmedRoleChangesFrozen", frozen);
            vm.serializeUint(obj, "confirmedReceived", received);
            vm.serializeUint(obj, "confirmedPaid", paid);
            vm.serializeUint(obj, "confirmedRowLiveFresh", live);
            vm.serializeUint(obj, "confirmedRowRecycled", recycled);
            vm.serializeUint(obj, "confirmedRowRecovery", recovery);
            vm.serializeUint(obj, "confirmedRowOverage", overage);
            vm.serializeUint(obj, "confirmedAtBlock", block.number);
            string memory confirmed = vm.serializeString(obj, "stagedRecord", json);
            vm.writeFile(durable, confirmed);
            console.log("Durable activation record (staged intent + confirmed chain state):", durable);
        } else {
            console.log("writes are off for this run -- durable activation record NOT written:", durable);
        }
        _removeRecord(KIND);
    }

    // ─── Serialisation / logging ────────────────────────────────────────────

    function _serialize(
        address diamond,
        address holder,
        Figures memory f,
        Answers memory a,
        string memory mode
    ) internal returns (string memory json) {
        string memory obj = "ceremony";
        vm.serializeAddress(obj, "diamond", diamond);
        vm.serializeAddress(obj, "holder", holder);
        vm.serializeString(obj, "mode", mode);
        vm.serializeUint(obj, "preparedAtBlock", block.number);
        vm.serializeUint(obj, "role", f.role);
        vm.serializeUint(obj, "rowLiveFresh", f.rowLive);
        vm.serializeUint(obj, "rowRecycled", f.rowRecycled);
        vm.serializeUint(obj, "rowRecovery", f.rowRecovery);
        vm.serializeUint(obj, "rowOverage", f.rowOverage);
        vm.serializeUint(obj, "received", f.received);
        vm.serializeUint(obj, "paid", f.paid);
        vm.serializeUint(obj, "bucket", f.bucket);
        vm.serializeUint(obj, "recoveryPosition", f.position);
        vm.serializeUint(obj, "overage", f.overage);
        vm.serializeUint(obj, "pauseEpochStated", a.pauseEpoch);
        vm.serializeBool(obj, "writeDownMirrorGap", a.writeDown);
        vm.serializeUint(obj, "fundLiveFresh", a.fundLive);
        vm.serializeUint(obj, "fundRecycled", a.fundRecycled);
        vm.serializeUint(obj, "relocateRecycled", a.relocRecycled);
        vm.serializeUint(obj, "fundRecovery", a.fundRecovery);
        vm.serializeUint(obj, "relocateRecovery", a.relocRecovery);
        vm.serializeUint(obj, "fundOverage", a.fundOverage);
        vm.serializeUint(obj, "relocateOverage", a.relocOverage);
        json = vm.serializeString(obj, "provenance", a.provenance);
    }

    function _logFigures(Figures memory f, Answers memory a) internal pure {
        console.log("received / paid:", f.received, f.paid);
        console.log("bucket / recovery position / overage:", f.bucket, f.position, f.overage);
        console.log("rows live / recycled / recovery / overage:", f.rowLive, f.rowRecycled, f.rowRecovery);
        console.log("                                 overage:", f.rowOverage);
        console.log("answers: pause epoch", a.pauseEpoch, "write-down", a.writeDown);
        console.log("  fund live / recycled / recovery / overage:", a.fundLive, a.fundRecycled, a.fundRecovery);
        console.log("                                    overage:", a.fundOverage);
        console.log("  relocate recycled / recovery / overage:", a.relocRecycled, a.relocRecovery, a.relocOverage);
    }
}
