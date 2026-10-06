// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardEpochViewFacet} from "../src/facets/RewardEpochViewFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardStagingFacet} from "../src/facets/RewardStagingFacet.sol";
import {RewardStagingSettleFacet} from "../src/facets/RewardStagingSettleFacet.sol";
import {RewardStagingDomainFacet} from "../src/facets/RewardStagingDomainFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";
import {LibRewardSanctions} from "../src/libraries/LibRewardSanctions.sol";
import {LibKeeperReward} from "../src/libraries/LibKeeperReward.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardSanctionsForfeitTest (and its two siblings in this file)
 * @notice #1566 sanctions reward-forfeit slice - the test oracle for the rule:
 *         interaction-reward value not yet delivered to a wallet whose sanctions
 *         flag is CONFIRMED is forfeited into the recycle bucket as
 *         `ForfeitedReward`, permanently; "confirmed" means a chain of
 *         authoritative Flagged observations, under one oracle, with no gap over
 *         `MAX_OBS_GAP_SECS` (G), spanning `CONFIRM_SECS` (W). An unset oracle,
 *         an outage, a first flag or a broken chain never forfeits.
 *
 *         Three contracts, three fixtures, because no one fixture can host every
 *         cell honestly:
 *           - {RewardSanctionsClassifierTest}: the classifier and the keeper
 *             screen against a bare harness (no Diamond) - the table itself,
 *             fuzzed row for row against `LibVaipakam.isRecipientBarred`.
 *           - {RewardSanctionsForfeitTest}: an unconfigured single-chain
 *             Diamond with legacy (pre-arming) entries - the facade, the stamp,
 *             the chain rule, the views, the expiry seam.
 *           - {RewardSanctionsForfeitStagedTest}: a mirror with reward custody
 *             active and armed days - the armed forfeit, the staged payout's
 *             hold, records and domains around a stamp, the headroom floor.
 *
 *         Every cell first asserts its fixture is LIVE (the value it guards is
 *         really there), then straddles its threshold (W - 1 against W, a gap of
 *         G against G + 1, a marked owner against an unmarked one), and asserts
 *         STORED state and emitted events rather than return values alone. Each
 *         cell's natspec names the mutation it kills (the M-numbers of the
 *         design brief) and, where relevant, the one it does not.
 */

/// @dev Calls the permissionless flag refresh and the owner sweep in ONE
///      transaction - the "refresh then sweep" attack shape (T3, T3b): a marker
///      written one call earlier must never count as a confirmation.
contract SanctionsRefreshThenSweep {
    function run(address target, address who) external returns (uint8 d, uint256 stamped) {
        ProfileFacet(target).refreshSanctionsFlag(who);
        (d, stamped, , , ) = RewardHorizonSweepFacet(target).forfeitFlaggedOwnerRewards(who, 0, 32, 30);
    }
}

/// @dev A bare host for the classifier and the keeper screen: the libraries'
///      internal functions run against THIS contract's own Diamond-layout
///      storage, so every input of the table (oracle, oracle reads, marker,
///      evidence, recovery-ban source) is set directly and every write is read
///      back directly - no facet, no Diamond, nothing between the test and the
///      rule.
contract RewardSanctionsHarness {
    function setOracle(address o) external {
        LibVaipakam.storageSlot().sanctionsOracle = o;
    }

    function setMarker(address who, bool v) external {
        LibVaipakam.storageSlot().sanctionsConfirmedFlagged[who] = v;
    }

    function setBannedSource(address who, address src) external {
        LibVaipakam.storageSlot().vaultBannedSource[who] = src;
    }

    function setEvidence(address who, address o, uint64 flaggedAt, uint64 lastSeenAt) external {
        LibVaipakam.storageSlot().rewardSanctionsEvidence[who] =
            LibRewardSanctions.packEvidence(o, flaggedAt, lastSeenAt);
    }

    function evidence(address who) external view returns (address o, uint64 flaggedAt, uint64 lastSeenAt) {
        return LibRewardSanctions.unpackEvidence(LibVaipakam.storageSlot().rewardSanctionsEvidence[who]);
    }

    function evidenceWord(address who) external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardSanctionsEvidence[who];
    }

    function marker(address who) external view returns (bool) {
        return LibVaipakam.storageSlot().sanctionsConfirmedFlagged[who];
    }

    function status(address who) external view returns (uint8) {
        return uint8(LibVaipakam.sanctionsStatus(who));
    }

    function barred(address who) external view returns (bool) {
        return LibVaipakam.isRecipientBarred(who);
    }

    function decide(address who) external view returns (uint8 d) {
        (LibRewardSanctions.Decision x, , ) = LibRewardSanctions.decide(LibVaipakam.storageSlot(), who);
        d = uint8(x);
    }

    function observe(address who) external returns (uint8) {
        return uint8(LibRewardSanctions.observe(LibVaipakam.storageSlot(), who));
    }

    function setKeeperRewardEnabled(bool v) external {
        LibVaipakam.storageSlot().cfgKeeperRewardEnabled = v;
    }

    function payKeeper(address k, bytes32 kind, uint256 gasUsed) external returns (uint256) {
        return LibKeeperReward.payVpfiReward(k, kind, gasUsed);
    }
}

/// @title RewardSanctionsClassifierTest
/// @notice T0 and T24 - the classifier's table and the keeper screen, on the
///         bare harness.
contract RewardSanctionsClassifierTest is Test {
    RewardSanctionsHarness internal h;
    MockSanctionsList internal m;

    address internal constant WHO = address(0xA11CE);
    address internal constant SRC = address(0x5AC5);
    address internal constant OTHER_ORACLE = address(0x0BAD);
    address internal constant KEEPER = address(0xBEEF);
    bytes32 internal constant KIND = keccak256("sanc-test-kind");
    uint256 internal constant BASE = 400 days;

    uint8 internal constant DELIVER = 0;
    uint8 internal constant HOLD = 1;
    uint8 internal constant FORFEIT = 2;
    uint256 internal constant W = LibRewardSanctions.CONFIRM_SECS;
    uint256 internal constant G = LibRewardSanctions.MAX_OBS_GAP_SECS;

    /// @dev Mirror of the library signal, for `vm.expectEmit`.
    event KeeperRewardSkipped(address indexed keeper, bytes32 indexed actionKind, string reason);

    function setUp() public {
        h = new RewardSanctionsHarness();
        m = new MockSanctionsList();
        vm.warp(BASE);
    }

    /// @notice T0a - the decision codes the facade and the lens return, and the
    ///         two constants the chain rule needs: a non-zero gap strictly below
    ///         the window, or no chain could ever form (G = 0) or every gap would
    ///         be fatal (G >= W).
    function test_sanc_T0a_decisionCodesAndConstants() public view {
        assertEq(uint8(LibRewardSanctions.Decision.Deliver), DELIVER, "Deliver is 0");
        assertEq(uint8(LibRewardSanctions.Decision.Hold), HOLD, "Hold is 1");
        assertEq(uint8(LibRewardSanctions.Decision.Forfeit), FORFEIT, "Forfeit is 2");
        assertGt(G, 0, "a gap bound of zero would make every chain break");
        assertLt(G, W, "the gap bound sits strictly inside the window");
        (address o, uint64 f, uint64 l) = LibRewardSanctions.unpackEvidence(
            LibRewardSanctions.packEvidence(address(m), uint64(BASE - 5), uint64(BASE))
        );
        assertEq(o, address(m), "pack/unpack round-trips the oracle");
        assertEq(uint256(f), BASE - 5, "and the flag's start");
        assertEq(uint256(l), BASE, "and the last sighting");
    }

    /// @notice T0 - THE TABLE, row for row. For every combination of oracle
    ///         set or unset, owner zero or not, flagged or clean, outage or not,
    ///         marker or none, evidence absent / under this oracle / under
    ///         another / with no start, any age and any gap, with or without a
    ///         flagged recovery-ban source: (1) Deliver holds exactly when the
    ///         existing barred screen says not barred - the classifier only
    ///         SPLITS barred into Hold and Forfeit, it never moves the barred
    ///         line; (2) `observe` decides exactly as the `decide` view did on the
    ///         same state; (3) the writes are exactly the table's: none on rows
    ///         1, 3 and 4; marker and evidence cleared on a Clean read (row 2); a
    ///         Flagged read commits the marker, evidences the current oracle and
    ///         extends the chain to now, restarting the window when the chain is
    ///         broken (row 5) and keeping its start otherwise (rows 6-7), with
    ///         Forfeit only once the window has elapsed.
    /// @dev   Kills: M1 (forfeit on the first read - row 5 would read
    ///        Forfeit), M5 (marker alone confirms - row 5 with a marker),
    ///        M6 (Unavailable + marker forfeits - rows 3-4), M8 (no clear on
    ///        Clean - row 2's writes), M9 (no oracle match - shape 2), M17 (no
    ///        marker restart - row 5 with `marker == false` and an intact chain),
    ///        M18 (no gap restart - any gap above G). The reference model reads
    ///        the oracle through `LibVaipakam.sanctionsStatus`, the existing
    ///        tri-state read, so the recovery-ban leg is the library's own.
    function test_sanc_T0_theClassifierSplitsTheBarredScreen_rowForRow(
        bool oracleSet,
        bool zeroWho,
        bool flagged,
        bool outage,
        bool marker,
        uint8 evShape,
        uint32 ageRaw,
        uint32 gapRaw,
        bool banned,
        bool srcFlagged
    ) public {
        address who = zeroWho ? address(0) : WHO;
        h.setOracle(oracleSet ? address(m) : address(0));
        m.setFlagged(WHO, flagged);
        if (banned) {
            h.setBannedSource(WHO, SRC);
            m.setFlagged(SRC, srcFlagged);
        }
        m.setRevertOnRead(outage);
        h.setMarker(who, marker);
        uint256 age = bound(uint256(ageRaw), 0, 10 days);
        uint256 gap = bound(uint256(gapRaw), 0, age);
        _shapeEvidence(who, evShape % 4, uint64(BASE - age), uint64(BASE - gap));
        _checkRow(who, oracleSet);
    }

    /// @dev Evidence shapes: 0 none; 1 under the current oracle; 2 under another
    ///      oracle; 3 under the current oracle but with no recorded start.
    function _shapeEvidence(address who, uint8 shape, uint64 f, uint64 l) internal {
        if (shape == 1) h.setEvidence(who, address(m), f, l);
        else if (shape == 2) h.setEvidence(who, OTHER_ORACLE, f, l);
        else if (shape == 3) h.setEvidence(who, address(m), 0, l);
    }

    function _checkRow(address who, bool oracleSet) internal {
        (address eo0, uint64 ef0, uint64 el0) = h.evidence(who);
        uint256 word0 = h.evidenceWord(who);
        bool marker0 = h.marker(who);
        uint8 st = h.status(who);
        uint8 d = h.decide(who);
        assertEq(d == DELIVER, !h.barred(who), "Deliver exactly when the barred screen says not barred");
        assertEq(h.observe(who), d, "observe decides exactly as the view did");
        if (!oracleSet || who == address(0)) {
            assertEq(d, DELIVER, "row 1: no regime or no owner delivers");
            _assertUnchanged(who, word0, marker0);
        } else if (st == uint8(LibVaipakam.SanctionsRead.Clean)) {
            assertEq(d, DELIVER, "row 2: a Clean read delivers");
            assertFalse(h.marker(who), "row 2 heals the marker");
            assertEq(h.evidenceWord(who), 0, "row 2 deletes the evidence");
        } else if (st == uint8(LibVaipakam.SanctionsRead.Unavailable)) {
            assertEq(d, marker0 ? HOLD : DELIVER, "rows 3-4: an outage holds a marked owner, delivers an unmarked one");
            _assertUnchanged(who, word0, marker0);
        } else {
            bool intact = marker0 && eo0 == address(m) && ef0 != 0 && BASE - uint256(el0) <= G;
            (address eo, uint64 ef, uint64 el) = h.evidence(who);
            assertTrue(h.marker(who), "rows 5-7 commit the marker");
            assertEq(eo, address(m), "rows 5-7 evidence the current oracle");
            assertEq(uint256(el), BASE, "rows 5-7 extend the chain to now");
            if (!intact) {
                assertEq(d, HOLD, "row 5: a broken chain holds");
                assertEq(uint256(ef), BASE, "row 5 restarts the window now");
            } else {
                assertEq(uint256(ef), uint256(ef0), "rows 6-7 keep the window's start");
                assertEq(d, BASE - uint256(ef0) >= W ? FORFEIT : HOLD, "rows 6-7: forfeit once the window has elapsed");
            }
        }
    }

    function _assertUnchanged(address who, uint256 word0, bool marker0) internal view {
        assertEq(h.evidenceWord(who), word0, "no evidence write");
        assertEq(h.marker(who), marker0, "no marker write");
    }

    /// @notice T24 - a keeper carrying a CONFIRMED flag is not paid during an
    ///         oracle outage: the keeper screen reads the barred view, which
    ///         falls back to the committed marker when the oracle cannot answer.
    ///         Straddles: the same outage without a marker is not screened
    ///         (fail-open stays fail-open), a clean keeper with the oracle up is
    ///         not screened, and an authoritative flag is screened as before.
    /// @dev   Kills M23 (the screen back to the fail-open
    ///        `isSanctionedAddress`): the marked keeper would pass the screen
    ///        and stop at the next gate with a different reason. Each payment
    ///        stops at the token gate when it is NOT screened (no VPFI token is
    ///        configured on the harness), so the reason string alone tells the
    ///        two outcomes apart and no budget or transfer is involved.
    function test_sanc_T24_aMarkedKeeperIsSkippedDuringAnOutage() public {
        h.setOracle(address(m));
        h.setKeeperRewardEnabled(true);
        vm.txGasPrice(1 gwei);

        vm.expectEmit(true, true, false, true, address(h));
        emit KeeperRewardSkipped(KEEPER, KIND, "no-vpfi-token");
        h.payKeeper(KEEPER, KIND, 100_000);

        h.setMarker(KEEPER, true);
        m.setRevertOnRead(true);
        vm.expectEmit(true, true, false, true, address(h));
        emit KeeperRewardSkipped(KEEPER, KIND, "sanctioned-keeper");
        assertEq(h.payKeeper(KEEPER, KIND, 100_000), 0, "a marked keeper is not paid during an outage");

        h.setMarker(KEEPER, false);
        vm.expectEmit(true, true, false, true, address(h));
        emit KeeperRewardSkipped(KEEPER, KIND, "no-vpfi-token");
        h.payKeeper(KEEPER, KIND, 100_000);

        m.setRevertOnRead(false);
        m.setFlagged(KEEPER, true);
        vm.expectEmit(true, true, false, true, address(h));
        emit KeeperRewardSkipped(KEEPER, KIND, "sanctioned-keeper");
        h.payKeeper(KEEPER, KIND, 100_000);
    }
}

/// @title RewardSanctionsTestBase
/// @notice The shared vocabulary of the two Diamond fixtures: the oracle, the
///         observation cadence, the facade and lens accessors, and log readers
///         that assert on STORED events rather than on return values.
abstract contract RewardSanctionsTestBase is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    MockSanctionsList internal oracle;
    address internal alice;
    address internal bob;
    address internal carol;
    address internal keeper;

    uint8 internal constant DELIVER = 0;
    uint8 internal constant HOLD = 1;
    uint8 internal constant FORFEIT = 2;
    uint256 internal constant W = LibRewardSanctions.CONFIRM_SECS;
    uint256 internal constant G = LibRewardSanctions.MAX_OBS_GAP_SECS;
    /// @dev The facade's per-call clamps: entries scanned, and chunk steps.
    uint256 internal constant PAGE_ENTRIES = 32;
    uint256 internal constant PAGE_STEPS = LibVaipakam.MAX_INTERACTION_CLAIM_DAYS;

    bytes32 internal constant T_RECORDED = keccak256("RewardSanctionsEvidenceRecorded(address,address,uint64,uint64)");
    bytes32 internal constant T_CLEARED = keccak256("RewardSanctionsEvidenceCleared(address)");
    bytes32 internal constant T_STAMPED = keccak256("RewardEntrySanctionsForfeited(uint256,address,uint256,uint8,uint64)");
    bytes32 internal constant T_SETTLED = keccak256("RewardEntryForfeitSettled(uint256,address,uint256,uint256,uint256)");
    bytes32 internal constant T_RECYCLED = keccak256("VpfiRecycled(uint8,uint256,uint256,uint256)");
    bytes32 internal constant T_EXPIRED = keccak256("RewardEntryExpired(uint256,address,uint256,uint256)");
    bytes32 internal constant T_CLAIMANT_FORFEITED = keccak256("StagingClaimantForfeited(bytes32,address,uint256,uint256)");
    bytes32 internal constant T_DELIVERED = keccak256("StagingDelivered(bytes32,address,uint256,uint8)");
    bytes32 internal constant T_STALE = keccak256("StagingRecordStale(bytes32,uint256)");

    // ----------------------------- accessors -----------------------------

    function _sweeper() internal view returns (RewardHorizonSweepFacet) {
        return RewardHorizonSweepFacet(address(diamond));
    }

    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    function _profile() internal view returns (ProfileFacet) {
        return ProfileFacet(address(diamond));
    }

    /// @dev The live block time. Read through the cheatcode on purpose: viaIR
    ///      may fold two reads of `block.timestamp` across a warp into one.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _entry(uint256 id) internal view returns (LibVaipakam.RewardEntry memory e) {
        LibVaipakam.RewardEntry[] memory es = _lens().getRewardEntriesRange(id, 1);
        e = es[0];
    }

    function _bucket() internal view returns (uint256) {
        return _cfg().getRecycleBucket();
    }

    function _paidOut() internal view returns (uint256) {
        return _lens().getInteractionPoolPaidOut();
    }

    function _addrTopic(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    // ----------------------------- the rule's surface -----------------------------

    /// @dev One permissionless observation, by a stranger.
    function _observe(address who) internal returns (uint8) {
        vm.prank(keeper);
        return _sweeper().recordRewardSanctionsEvidence(who);
    }

    function _forfeit(address who)
        internal
        returns (uint8 d, uint256 stamped, uint256 settled, uint256 next, uint256 unfinished)
    {
        (d, stamped, settled, next, unfinished) = _forfeitPage(who, 0, PAGE_ENTRIES, PAGE_STEPS);
    }

    function _forfeitPage(address who, uint256 from, uint256 maxEntries, uint256 maxSteps)
        internal
        returns (uint8 d, uint256 stamped, uint256 settled, uint256 next, uint256 unfinished)
    {
        vm.prank(keeper);
        (d, stamped, settled, next, unfinished) =
            _sweeper().forfeitFlaggedOwnerRewards(who, from, maxEntries, maxSteps);
    }

    /// @dev The facade through a low-level call, for the cells that read a revert.
    function _tryForfeit(address who) internal returns (bool ok, bytes memory ret) {
        vm.prank(keeper);
        (ok, ret) = address(diamond).call(
            abi.encodeWithSelector(
                RewardHorizonSweepFacet.forfeitFlaggedOwnerRewards.selector, who, uint256(0), PAGE_ENTRIES, PAGE_STEPS
            )
        );
    }

    function _status(address who)
        internal
        view
        returns (
            uint8 d,
            uint64 flaggedAt,
            uint64 lastSeenAt,
            uint64 forfeitableAt,
            uint64 observeBy,
            address evOracle,
            bool marker
        )
    {
        (d, flaggedAt, lastSeenAt, forfeitableAt, observeBy, evOracle, marker) =
            _lens().getRewardSanctionsStatus(who);
    }

    function _decision(address who) internal view returns (uint8 d) {
        (d, , , , , , ) = _status(who);
    }

    function _flaggedAt(address who) internal view returns (uint64 f) {
        (, f, , , , , ) = _status(who);
    }

    function _lastSeen(address who) internal view returns (uint64 l) {
        (, , l, , , , ) = _status(who);
    }

    /// @dev The lens's whole status for `who`, against the expected evidence.
    ///      When evidence stands, the two derived instants are pinned too: the
    ///      earliest forfeit one window after the flag's start, and the
    ///      deadline for the next observation one gap after the last one.
    function _assertEvidence(
        address who,
        uint8 d,
        uint256 flaggedAt,
        uint256 lastSeenAt,
        address evOracle,
        bool marker
    ) internal view {
        (uint8 sd, uint64 sf, uint64 sl, uint64 sfa, uint64 sob, address so, bool sm) = _status(who);
        assertEq(sd, d, "status: decision");
        assertEq(uint256(sf), flaggedAt, "status: flaggedAt");
        assertEq(uint256(sl), lastSeenAt, "status: lastSeenAt");
        assertEq(so, evOracle, "status: evidence oracle");
        assertEq(sm, marker, "status: marker");
        if (sf != 0) {
            assertEq(uint256(sfa), uint256(sf) + W, "status: forfeitable one window after the flag");
            assertEq(uint256(sob), uint256(sl) + G, "status: the chain breaks one gap after the last sighting");
        }
    }

    /// @dev The cadence from no evidence: a first observation now, one every G
    ///      while that stays inside the window, and the one AT the window's end,
    ///      which must confirm. Returns the flag's start.
    function _confirm(address who) internal returns (uint256 t0) {
        t0 = _now();
        assertEq(_observe(who), HOLD, "cadence: a first flag holds");
        uint256 t = t0;
        while (t + G < t0 + W) {
            t += G;
            vm.warp(t);
            assertEq(_observe(who), HOLD, "cadence: held inside the window");
        }
        vm.warp(t0 + W);
        assertEq(_observe(who), FORFEIT, "cadence: confirmed at the window's end");
    }

    // ----------------------------- log readers -----------------------------

    function _count(Vm.Log[] memory logs, bytes32 topic0) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(diamond) && logs[i].topics.length != 0 && logs[i].topics[0] == topic0) ++n;
        }
    }

    function _nth(Vm.Log[] memory logs, bytes32 topic0, uint256 k) internal view returns (Vm.Log memory) {
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(diamond) && logs[i].topics.length != 0 && logs[i].topics[0] == topic0) {
                if (seen == k) return logs[i];
                ++seen;
            }
        }
        revert("log not found");
    }

    /// @dev Sum and count of the `VpfiRecycled` credits of `source` under
    ///      `refId`.
    function _recycled(Vm.Log[] memory logs, uint8 source, uint256 refId)
        internal
        view
        returns (uint256 total, uint256 n)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(diamond) || l.topics.length < 3 || l.topics[0] != T_RECYCLED) continue;
            if (l.topics[1] != bytes32(uint256(source)) || l.topics[2] != bytes32(refId)) continue;
            (uint256 amt, ) = abi.decode(l.data, (uint256, uint256));
            total += amt;
            ++n;
        }
    }

    /// @dev How many `VpfiRecycled` credits of `source` were emitted, any refId.
    function _recycledCount(Vm.Log[] memory logs, uint8 source) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(diamond) || l.topics.length < 2 || l.topics[0] != T_RECYCLED) continue;
            if (l.topics[1] == bytes32(uint256(source))) ++n;
        }
    }

    function _stampedIds(Vm.Log[] memory logs) internal view returns (uint256[] memory ids) {
        uint256 n = _count(logs, T_STAMPED);
        ids = new uint256[](n);
        for (uint256 k; k < n; ++k) ids[k] = uint256(_nth(logs, T_STAMPED, k).topics[1]);
    }

    function _assertStampLog(Vm.Log[] memory logs, uint256 id, address user, uint256 loanId, uint256 flaggedAt)
        internal
        view
    {
        assertEq(_count(logs, T_STAMPED), 1, "one stamp announced");
        Vm.Log memory l = _nth(logs, T_STAMPED, 0);
        assertEq(uint256(l.topics[1]), id, "stamp: the entry");
        assertEq(l.topics[2], _addrTopic(user), "stamp: its owner");
        assertEq(uint256(l.topics[3]), loanId, "stamp: its loan");
        (uint8 side, uint64 f) = abi.decode(l.data, (uint8, uint64));
        assertEq(side, uint8(LibVaipakam.RewardSide.Lender), "stamp: the side");
        assertEq(uint256(f), flaggedAt, "stamp: the confirmed flag's start");
    }

    function _assertSettledLog(Vm.Log[] memory logs, uint256 id, address user, uint256 loanId, uint256 fresh)
        internal
        view
    {
        assertEq(_count(logs, T_SETTLED), 1, "one settled chunk announced");
        Vm.Log memory l = _nth(logs, T_SETTLED, 0);
        assertEq(uint256(l.topics[1]), id, "settled: the entry");
        assertEq(l.topics[2], _addrTopic(user), "settled: its owner");
        assertEq(uint256(l.topics[3]), loanId, "settled: its loan");
        (uint256 f, uint256 r) = abi.decode(l.data, (uint256, uint256));
        assertEq(f, fresh, "settled: the chunk's fresh, at the forfeit route's untrimmed pricing");
        assertEq(r, 0, "settled: no recycled in this fixture");
    }

    // ----------------------------- array helpers -----------------------------

    /// @dev Drops zero slots, so a view that sizes its page to `max` and one
    ///      that trims it compare the same.
    function _compact(uint256[] memory a) internal pure returns (uint256[] memory out) {
        uint256 n;
        for (uint256 i; i < a.length; ++i) {
            if (a[i] != 0) ++n;
        }
        out = new uint256[](n);
        uint256 j;
        for (uint256 i; i < a.length; ++i) {
            if (a[i] != 0) out[j++] = a[i];
        }
    }

    function _sameSet(uint256[] memory a, uint256[] memory b) internal pure returns (bool) {
        if (a.length != b.length) return false;
        for (uint256 i; i < a.length; ++i) {
            bool found;
            for (uint256 j; j < b.length; ++j) {
                if (a[i] == b[j]) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }
}

/// @title RewardSanctionsForfeitTest
/// @notice The unconfigured single-chain fixture: legacy (pre-arming) entries
///         over finalized days 1-4, a 100M VPFI Diamond, the oracle configured
///         and nobody flagged. A legacy entry settles in one chunk, so the
///         facade's stamp, chain rule, paging and views are visible without the
///         armed engine.
contract RewardSanctionsForfeitTest is RewardSanctionsTestBase {
    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;
    uint64 internal constant LOAN_A = 42;
    uint64 internal constant LOAN_B = 43;
    uint64 internal constant LOAN_D = 91; // a Defaulted loan, its lender entry never closed
    uint64 internal constant LOAN_O = 92; // an open (Active) loan
    uint64 internal constant LOAN_V = 93; // a terminal loan carrying loan value
    uint64 internal constant LOAN_S = 94; // the loan sweep's loan
    uint64 internal constant LOAN_P = 95; // a loan whose borrower obligation transferred (preclose)
    uint256 internal constant REQUIRED = 180 days + 90 days; // H + notice at the 180-day horizon
    bytes4 internal constant SEL_EXPIRY_WALK = bytes4(
        keccak256("epochSweepExpiredEntry(uint256,uint256,uint256,(uint256,uint256,uint256,uint256,uint256,uint256))")
    );

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);

        alice = makeAddr("sanc-alice");
        bob = makeAddr("sanc-bob");
        carol = makeAddr("sanc-carol");
        keeper = makeAddr("sanc-keeper");

        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 6 days);
        for (uint256 d = 1; d <= 4; ++d) {
            _mut().setKnownGlobalDailyInterest(d, 1e18, 1e18, true);
            _mut().setDayCapThreshold18(d, type(uint256).max);
        }
        oracle = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
    }

    // ----------------------------- fixtures -----------------------------

    /// @dev A closed, claimable lender entry over day 1.
    function _seed(address user, uint64 loanId) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(user, loanId, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(id, 2);
    }

    /// @dev A lender entry over day 1 with its window set and NEVER closed:
    ///      claimable only once its loan is terminal.
    function _seedOpen(address user, uint64 loanId) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(user, loanId, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().setRewardEntryEndDayRaw(id, 2);
    }

    function _setLoanStatus(uint256 loanId, LibVaipakam.LoanStatus st) internal {
        LibVaipakam.Loan memory l;
        l.id = loanId;
        l.status = st;
        _mut().setLoan(loanId, l);
    }

    /// @dev What a claim by `user` would pay right now (the claim itself, in a
    ///      reverting frame) - the LIVE check of every cell.
    function _livePreview(address user) internal returns (uint256 amount) {
        (amount, , ) = previewByExecution(user);
    }

    // ----------------------------- the trigger -----------------------------

    /// @notice T1 - a FIRST flag holds: the facade observes, commits the marker
    ///         and the evidence, announces when the owner becomes forfeitable,
    ///         and stamps and moves nothing. A second call in the same block
    ///         extends the chain rather than restarting it.
    /// @dev   Kills M1 (forfeit on the first read): the decision would read
    ///        Forfeit and the entry would be stamped and settled. The second
    ///        call kills a classifier that restarts on every Flagged read.
    function test_sanc_T1_aFirstFlagHolds_recordsTheEvidence_andMovesNothing() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE: a clean owner's entry pays");
        oracle.setFlagged(alice, true);
        assertFalse(_profile().isSanctionsConfirmedFlagged(alice), "fixture: no marker before any observation");
        uint256 bucket0 = _bucket();
        uint256 paid0 = _paidOut();
        uint256 t0 = _now();
        vm.recordLogs();
        (uint8 d, uint256 stamped, uint256 settled, uint256 next, uint256 unfinished) = _forfeit(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(d, HOLD, "a first flag holds");
        assertEq(stamped, 0, "nothing stamped");
        assertEq(settled, 0, "nothing settled");
        assertEq(next, 0, "a hold does not advance the page");
        assertEq(unfinished, 0, "and counts nothing");
        assertEq(_count(logs, T_RECORDED), 1, "the evidence is announced once");
        Vm.Log memory l = _nth(logs, T_RECORDED, 0);
        assertEq(l.topics[1], _addrTopic(alice), "recorded: the owner");
        assertEq(l.topics[2], _addrTopic(address(oracle)), "recorded: under the configured oracle");
        (uint64 flaggedAt, uint64 forfeitableAt) = abi.decode(l.data, (uint64, uint64));
        assertEq(uint256(flaggedAt), t0, "recorded: flagged now");
        assertEq(uint256(forfeitableAt), t0 + W, "recorded: forfeitable one window later at the earliest");
        assertTrue(_profile().isSanctionsConfirmedFlagged(alice), "the authoritative Flagged read commits the marker");
        _assertEvidence(alice, HOLD, t0, t0, address(oracle), true);
        assertEq(_count(logs, T_STAMPED), 0, "no stamp announced");
        assertFalse(_entry(id).forfeited, "the entry is not stamped");
        assertFalse(_entry(id).processed, "nor settled");
        assertEq(_bucket(), bucket0, "the bucket is untouched");
        assertEq(_paidOut(), paid0, "the pool is untouched");

        vm.recordLogs();
        (d, stamped, , , ) = _forfeit(alice);
        logs = vm.getRecordedLogs();
        assertEq(d, HOLD, "still held in the same block");
        assertEq(stamped, 0);
        assertEq(_count(logs, T_RECORDED), 0, "an intact chain is extended, not restarted");
        assertEq(uint256(_flaggedAt(alice)), t0, "the window's start stands");
    }

    /// @notice T3 - a marker written one call earlier, in the same transaction,
    ///         is not a confirmation: refresh-then-sweep with no prior evidence
    ///         holds.
    /// @dev   Kills M5 (confirm on the marker alone).
    function test_sanc_T3_refreshThenSweepInOneTransaction_holds() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        SanctionsRefreshThenSweep helper = new SanctionsRefreshThenSweep();
        (uint8 d, uint256 stamped) = helper.run(address(diamond), alice);
        assertEq(d, HOLD, "a fresh marker is not a confirmation");
        assertEq(stamped, 0, "nothing stamped");
        assertTrue(_profile().isSanctionsConfirmedFlagged(alice), "fixture: the refresh did write the marker");
        assertFalse(_entry(id).forfeited);
        assertEq(uint256(_flaggedAt(alice)), _now(), "the window starts at this observation");
    }

    /// @notice T3b - stale evidence plus a refresh in the sweep's own
    ///         transaction: evidence at t0, a delisting healed by a Clean
    ///         refresh, then - more than a window later - a relisting refreshed
    ///         and swept in one transaction. Holds.
    /// @dev   Kills M18 (no gap restart): the old evidence plus the fresh marker
    ///        would otherwise confirm at once. Does NOT isolate M17 - the
    ///        refresh restores the marker before the sweep reads it, so the gap
    ///        rule alone carries this cell; T3d isolates M17.
    function test_sanc_T3b_staleEvidenceAndARefreshInOneTransaction_hold() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        uint256 t0 = _now();
        assertEq(_observe(alice), HOLD, "fixture: evidence at t0");
        oracle.setFlagged(alice, false);
        _profile().refreshSanctionsFlag(alice);
        assertFalse(_profile().isSanctionsConfirmedFlagged(alice), "fixture: the Clean refresh cleared the marker");
        vm.warp(t0 + W + 1);
        oracle.setFlagged(alice, true);
        SanctionsRefreshThenSweep helper = new SanctionsRefreshThenSweep();
        (uint8 d, uint256 stamped) = helper.run(address(diamond), alice);
        assertEq(d, HOLD, "stale evidence never confirms");
        assertEq(stamped, 0);
        assertFalse(_entry(id).forfeited);
        assertEq(uint256(_flaggedAt(alice)), t0 + W + 1, "the window restarts at this observation");
    }

    /// @notice T3c - a gap longer than G breaks the chain. Boundary straddle: a
    ///         gap of exactly G keeps the window's start, one second more
    ///         restarts it. Then the stale-evidence case: one observation, an
    ///         unobserved delisting (no mutating read, so the marker stands), a
    ///         relisting more than a window later - the sweep holds.
    /// @dev   Kills M18 (no gap restart): alice's chain would read intact and
    ///        older than W, and forfeit; carol's flag start would stay t0.
    function test_sanc_T3c_aGapOverG_restartsTheWindow_atTheExactBoundary() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        oracle.setFlagged(bob, true);
        oracle.setFlagged(carol, true);
        uint256 t0 = _now();
        _observe(alice);
        _observe(bob);
        _observe(carol);
        vm.warp(t0 + G);
        _observe(bob);
        assertEq(uint256(_flaggedAt(bob)), t0, "a gap of exactly G keeps the chain");
        vm.warp(t0 + G + 1);
        _observe(carol);
        assertEq(uint256(_flaggedAt(carol)), t0 + G + 1, "a gap of G + 1 restarts it");

        oracle.setFlagged(alice, false);
        vm.warp(t0 + W + 1);
        oracle.setFlagged(alice, true);
        assertTrue(_profile().isSanctionsConfirmedFlagged(alice), "fixture: nothing healed the marker");
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, HOLD, "an unobserved stretch breaks the chain");
        assertEq(stamped, 0);
        assertFalse(_entry(id).forfeited);
        assertEq(uint256(_flaggedAt(alice)), t0 + W + 1, "the window restarts at this observation");
    }

    /// @notice T3d - a Clean heal ANYWHERE (here the permissionless refresh)
    ///         restarts the window even though the chain of Flagged sightings
    ///         was never broken by a gap. Straddle: bob's identical chain, never
    ///         healed, confirms at the same instant.
    /// @dev   Kills M17 (no marker restart): alice would forfeit with bob.
    function test_sanc_T3d_aClearedMarkerRestartsTheWindow_evenWithNoGap() public {
        uint256 idA = _seed(alice, LOAN_A);
        uint256 idB = _seed(bob, LOAN_B);
        oracle.setFlagged(alice, true);
        oracle.setFlagged(bob, true);
        uint256 t0 = _now();
        _observe(alice);
        _observe(bob);
        uint256 t = t0;
        while (t + G < t0 + W) {
            t += G;
            vm.warp(t);
            _observe(alice);
            _observe(bob);
        }
        oracle.setFlagged(alice, false);
        _profile().refreshSanctionsFlag(alice);
        assertFalse(_profile().isSanctionsConfirmedFlagged(alice), "fixture: the heal cleared the marker only");
        oracle.setFlagged(alice, true);
        vm.warp(t0 + W);
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, HOLD, "a healed marker restarts the window");
        assertEq(stamped, 0);
        assertFalse(_entry(idA).forfeited);
        assertEq(uint256(_flaggedAt(alice)), t0 + W);
        (d, stamped, , , ) = _forfeit(bob);
        assertEq(d, FORFEIT, "the twin chain, never healed, confirms at the same instant");
        assertEq(stamped, 1);
        assertTrue(_entry(idB).forfeited);
    }

    /// @notice T4 - an outage. A marked owner with a COMPLETE chain holds, with
    ///         no evidence write and no revert; an unmarked owner is delivered;
    ///         the marked owner's claim is refused while the unmarked owner's
    ///         goes through. Straddle: one second earlier, with the oracle up,
    ///         the same chain read Forfeit.
    /// @dev   Kills M6 (Unavailable + marker forfeits) and M7 (the claim gate
    ///        back to the fail-open `_assertNotSanctioned`: the marked claim
    ///        would pay).
    function test_sanc_T4_anOutageHoldsTheMarked_deliversTheUnmarked_andBarsTheMarkedClaim() public {
        uint256 idA = _seed(alice, LOAN_A);
        uint256 idB = _seed(bob, LOAN_B);
        assertGt(_livePreview(alice), 0, "fixture LIVE: alice");
        assertGt(_livePreview(bob), 0, "fixture LIVE: bob");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        assertEq(_decision(alice), FORFEIT, "fixture: the chain is complete");
        uint64 f0 = _flaggedAt(alice);
        uint64 l0 = _lastSeen(alice);

        oracle.setRevertOnRead(true);
        vm.warp(_now() + 1);
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, HOLD, "an outage never forfeits, even a complete chain");
        assertEq(stamped, 0);
        assertFalse(_entry(idA).forfeited);
        assertEq(_flaggedAt(alice), f0, "no evidence write on an unavailable read");
        assertEq(_lastSeen(alice), l0, "the gap grows instead");
        assertTrue(_profile().isSanctionsConfirmedFlagged(alice), "the marker stands");

        (d, stamped, , , ) = _forfeit(bob);
        assertEq(d, DELIVER, "an unmarked owner is delivered during an outage");
        assertEq(stamped, 0);
        assertFalse(_entry(idB).forfeited);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, alice));
        RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);
        vm.prank(bob);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);
        assertGt(paid, 0, "the unmarked owner still claims during the outage");
    }

    /// @notice T5 - a Clean read heals: it delivers, deletes the evidence,
    ///         clears the marker and announces the clear; a re-flag then starts
    ///         a fresh window and holds.
    /// @dev   Kills M8 (skip the clear): the re-flag would find the old chain
    ///        intact and forfeit, and the lens would still show evidence.
    function test_sanc_T5_aCleanReadHealsTheEvidence_andAReflagStartsOver() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        assertEq(_decision(alice), FORFEIT, "fixture: confirmed");
        oracle.setFlagged(alice, false);
        vm.recordLogs();
        assertEq(_observe(alice), DELIVER, "a Clean read delivers");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLEARED), 1, "the clear is announced");
        assertEq(_nth(logs, T_CLEARED, 0).topics[1], _addrTopic(alice));
        _assertEvidence(alice, DELIVER, 0, 0, address(0), false);

        oracle.setFlagged(alice, true);
        uint256 t1 = _now();
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, HOLD, "a re-flag starts the window over");
        assertEq(stamped, 0);
        assertFalse(_entry(id).forfeited);
        _assertEvidence(alice, HOLD, t1, t1, address(oracle), true);
    }

    /// @notice T6 - evidence is keyed to the oracle that produced it: a complete
    ///         chain under oracle A is not evidence under oracle B, even when B
    ///         flags the owner too. Straddle: under A the same instant reads
    ///         Forfeit.
    /// @dev   Kills M9 (no oracle match).
    function test_sanc_T6_anOracleChangeRestartsTheWindow() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        assertEq(_decision(alice), FORFEIT, "fixture: confirmed under A");
        MockSanctionsList b = new MockSanctionsList();
        b.setFlagged(alice, true);
        _profile().setSanctionsOracle(address(b));
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, HOLD, "evidence under A is not evidence under B");
        assertEq(stamped, 0);
        assertFalse(_entry(id).forfeited);
        _assertEvidence(alice, HOLD, _now(), _now(), address(b), true);
    }

    /// @notice T6b - an oracle unset for longer than G, then set back to the
    ///         same oracle, restarts the window: an unset oracle delivers and
    ///         writes nothing, so the gap grows. Straddle on one timeline: bob,
    ///         read back exactly G after his last sighting, still confirms;
    ///         alice, read one second later, restarts.
    /// @dev   Covered by M18 (no gap restart); also pins row 1's no-write rule.
    function test_sanc_T6b_anOracleUnsetForLongerThanG_restartsTheWindow() public {
        uint256 idA = _seed(alice, LOAN_A);
        _seed(bob, LOAN_B);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        oracle.setFlagged(bob, true);
        uint256 t0 = _now();
        _observe(alice);
        _observe(bob);
        uint256 t = t0;
        while (t + G < t0 + W) {
            t += G;
            vm.warp(t);
            _observe(alice);
            _observe(bob);
        }
        vm.warp(t0 + W);
        assertEq(_observe(alice), FORFEIT, "fixture: alice confirmed");
        assertEq(_observe(bob), FORFEIT, "fixture: bob confirmed");
        uint256 t1 = t0 + W;
        _profile().setSanctionsOracle(address(0));
        assertEq(_observe(alice), DELIVER, "no oracle: delivered, nothing written");
        vm.warp(t1 + G);
        _profile().setSanctionsOracle(address(oracle));
        assertEq(_observe(bob), FORFEIT, "back after exactly G: the chain holds");
        vm.warp(t1 + G + 1);
        assertEq(_observe(alice), HOLD, "back after more than G: the window restarts");
        assertEq(uint256(_flaggedAt(alice)), t1 + G + 1);
        assertFalse(_entry(idA).forfeited);
    }

    // ----------------------------- the stamp's reach -----------------------------

    /// @notice T7 - a closed lender entry whose loan pointer is zero is out of
    ///         the loan sweep's reach while it is unstamped (the loan sweep
    ///         reads the loan's pointers and its forfeited list, and the entry
    ///         is on neither), and is reached by the owner sweep through the
    ///         owner's own list: stamped, then settled. Zero backing room holds
    ///         the first settlement back so the stamp and the settle are seen
    ///         apart. That the stamp ALSO lists the entry for the loan sweep is
    ///         T7b's (and T7c's, for a borrower entry off a moved pointer).
    function test_sanc_T7_anEntryTheLoanSweepCannotReach_isForfeitedByTheOwnerSweep() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        vm.prank(keeper);
        assertEq(
            InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN_A),
            0,
            "the loan sweep cannot reach it: no pointer names it and nothing is listed"
        );
        assertFalse(_entry(id).processed, "it stays owed");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        uint256 bucket0 = _bucket();
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));
        (uint8 d, uint256 stamped, uint256 settled, , uint256 unfinished) = _forfeit(alice);
        assertEq(d, FORFEIT, "fixture: confirmed");
        assertEq(stamped, 1, "stamped");
        assertEq(settled, 0, "no backing room: the settlement defers");
        assertEq(unfinished, 1, "and the entry is reported unfinished");
        assertTrue(_entry(id).forfeited);
        assertFalse(_entry(id).processed);
        _mut().setRecycleBucketRaw(bucket0);
        (, stamped, settled, , unfinished) = _forfeit(alice);
        assertEq(stamped, 0, "already stamped");
        assertGt(settled, 0, "the owner sweep settles it");
        assertEq(unfinished, 0);
        assertTrue(_entry(id).processed);
        assertEq(_bucket() - bucket0, settled, "into the bucket");
    }

    /// @notice T7b - a stamped entry its stamping call left unsettled (zero
    ///         backing room) settles through the PERMISSIONLESS loan sweep
    ///         after its owner is delisted: the stamp listed it on its loan, so
    ///         a stranger's sweep of that loan reaches it although no pointer
    ///         names it and the owner sweep no longer runs for the owner (she
    ///         reads Deliver). The settlement is the forfeit route's, once: the
    ///         bucket grows by the settled fresh under a `ForfeitedReward`
    ///         credit keyed to the loan, and a re-confirmed owner sweep then
    ///         finds nothing to stamp or settle. Straddle: before the stamp the
    ///         same loan sweep settles nothing and the loan lists nothing; after
    ///         the delisting, with backing restored, the owner sweep settles
    ///         nothing while the loan sweep settles the entry.
    /// @dev   Mutation: drop the push in `stampSanctionsForfeit` -> the loan
    ///        sweep never reaches the entry (the list stays empty, the sweep
    ///        returns 0) and it stays owed for good behind the delisting - its
    ///        stamp permanent, its owner's claim paying her nothing, and no
    ///        sweep that runs for a Deliver owner. Does NOT kill dropping the
    ///        sweep's skip of an id a current pointer names: no pointer names
    ///        this entry.
    function test_sanc_T7b_aStampedEntry_settlesThroughTheLoanSweep_afterTheOwnerIsDelisted() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        address stranger = makeAddr("sanc-stranger");
        assertEq(_mut().getForfeitedLenderEntryIds(LOAN_A).length, 0, "before the stamp: the loan lists nothing");
        vm.prank(stranger);
        assertEq(
            InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN_A),
            0,
            "before the stamp: the loan sweep settles nothing"
        );
        assertFalse(_entry(id).processed);

        oracle.setFlagged(alice, true);
        _confirm(alice);
        uint256 bucket0 = _bucket();
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));
        (uint8 d, uint256 stamped, uint256 settled, , uint256 unfinished) = _forfeit(alice);
        assertEq(d, FORFEIT, "fixture: confirmed");
        assertEq(stamped, 1, "stamped");
        assertEq(settled, 0, "no backing room: the stamping call settles nothing");
        assertEq(unfinished, 1, "and reports the entry unfinished");
        assertTrue(_entry(id).forfeited);
        assertFalse(_entry(id).processed);
        {
            uint256[] memory listed = _mut().getForfeitedLenderEntryIds(LOAN_A);
            assertEq(listed.length, 1, "the stamp listed the entry on its loan");
            assertEq(listed[0], id, "and it is this entry");
        }

        oracle.setFlagged(alice, false);
        _mut().setRecycleBucketRaw(bucket0);
        (d, stamped, settled, , unfinished) = _forfeit(alice);
        assertEq(d, DELIVER, "delisted: the owner sweep stands down");
        assertEq(stamped + settled + unfinished, 0, "and touches nothing, backing or not");
        assertFalse(_entry(id).processed, "still owed: the delisting settles nothing");
        assertTrue(_entry(id).forfeited, "and restores nothing: the stamp is permanent");
        assertEq(_livePreview(alice), 0, "her claim pays her nothing for a stamped entry");

        vm.recordLogs();
        vm.prank(stranger);
        uint256 swept = InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN_A);
        {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertGt(swept, 0, "a stranger's loan sweep reaches the listed entry and settles it");
            assertTrue(_entry(id).processed, "STORED: settled, nothing owed");
            assertEq(_bucket() - bucket0, swept, "STORED: the bucket grew by the settled fresh");
            _assertSettledLog(logs, id, alice, LOAN_A, swept);
            (uint256 credited, uint256 n) =
                _recycled(logs, uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward), LOAN_A);
            assertEq(n, 1, "one ForfeitedReward credit, keyed to the loan");
            assertEq(credited, swept, "of exactly the settled fresh");
        }

        oracle.setFlagged(alice, true);
        _confirm(alice);
        uint256 bucket1 = _bucket();
        vm.recordLogs();
        (d, stamped, settled, , unfinished) = _forfeit(alice);
        {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(d, FORFEIT, "re-confirmed");
            assertEq(stamped, 0, "the owner sweep finds nothing to stamp");
            assertEq(settled, 0, "nor to settle");
            assertEq(unfinished, 0);
            assertEq(_count(logs, T_STAMPED) + _count(logs, T_SETTLED), 0, "and announces nothing");
            assertEq(_recycledCount(logs, uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward)), 0, "no second credit");
        }
        assertEq(_bucket(), bucket1, "the bucket is unchanged");
        assertEq(_mut().getForfeitedLenderEntryIds(LOAN_A).length, 1, "nothing re-listed");
    }

    /// @notice T7c - the borrower side, off a pointer that MOVED: a preclose
    ///         obligation transfer closes the exiting borrower's entry clean
    ///         and re-registers the loan, overwriting its borrower pointer with
    ///         the incoming borrower's fresh entry. The exiting borrower's
    ///         entry, stamped afterwards and left unsettled (zero backing
    ///         room), is named by no pointer; it settles through the
    ///         permissionless loan sweep after its owner is delisted, because
    ///         the stamp listed it. Straddle: after the transfer and before the
    ///         stamp, the same loan sweep settles nothing and the loan lists
    ///         nothing.
    /// @dev   Drives the REAL hook (`precloseRewardTransferObligation`, the
    ///        Diamond self-call `PrecloseFacet` makes) on a scaffolded loan
    ///        whose principal asset the setup prices at $1, so production code
    ///        overwrites the pointer rather than a raw mutator. LIVE: the
    ///        incoming borrower holds the fresh entry the re-registration
    ///        installed - had it returned early, the pointer would still name
    ///        the old entry and the sweep would reach it with or without the
    ///        list, which would make this cell vacuous.
    ///        Mutation: drop the push in `stampSanctionsForfeit` -> the loan
    ///        sweep never reaches the entry and it stays owed. Also kills a
    ///        push confined to the lender side.
    function test_sanc_T7c_aStampedBorrowerEntry_offAMovedPointer_settlesThroughTheLoanSweep() public {
        uint256 id = _mut().pushRewardEntry(alice, LOAN_P, LibVaipakam.RewardSide.Borrower, 1e18, 1);
        _mut().setRewardEntryEndDayRaw(id, 2);
        _mut().setLoanBorrowerEntryId(LOAN_P, id);
        {
            LibVaipakam.Loan memory l;
            l.id = LOAN_P;
            l.status = LibVaipakam.LoanStatus.Active;
            l.lender = carol;
            l.borrower = bob; // the incoming obligor, set before the hook as PrecloseFacet sets it
            l.lenderTokenId = 7_000_001; // never minted: the hook's holder reads fall back to the stored parties
            l.borrowerTokenId = 7_000_002;
            l.principalAsset = mockERC20;
            l.principal = 1_000 ether;
            l.interestRateBps = 1_000;
            l.durationDays = 30;
            _mut().setLoan(LOAN_P, l);
        }
        vm.prank(address(diamond));
        InteractionRewardsFacet(address(diamond)).precloseRewardTransferObligation(LOAN_P);
        {
            LibVaipakam.RewardEntry[] memory inc = _lens().getUserRewardEntries(bob);
            assertEq(inc.length, 1, "fixture LIVE: the re-registration installed the incoming borrower's entry");
            assertEq(uint256(inc[0].loanId), uint256(LOAN_P), "on this loan");
            assertEq(
                uint8(inc[0].side),
                uint8(LibVaipakam.RewardSide.Borrower),
                "on the borrower side: the pointer moved off the exiting entry"
            );
        }
        assertTrue(_entry(id).closed, "fixture: the hook closed the exiting borrower's entry");
        assertFalse(_entry(id).forfeited, "clean");
        assertGt(_livePreview(alice), 0, "fixture LIVE: still payable to its owner");

        address stranger = makeAddr("sanc-stranger");
        assertEq(_mut().getForfeitedLenderEntryIds(LOAN_P).length, 0, "before the stamp: the loan lists nothing");
        vm.prank(stranger);
        assertEq(
            InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN_P),
            0,
            "before the stamp: the loan sweep settles nothing"
        );
        assertFalse(_entry(id).processed);

        oracle.setFlagged(alice, true);
        _confirm(alice);
        uint256 bucket0 = _bucket();
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));
        vm.recordLogs();
        (uint8 d, uint256 stamped, uint256 settled, , uint256 unfinished) = _forfeit(alice);
        {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(_count(logs, T_STAMPED), 1, "one stamp announced");
            (uint8 side, ) = abi.decode(_nth(logs, T_STAMPED, 0).data, (uint8, uint64));
            assertEq(side, uint8(LibVaipakam.RewardSide.Borrower), "a borrower entry stamped");
        }
        assertEq(d, FORFEIT, "fixture: confirmed");
        assertEq(stamped, 1, "stamped");
        assertEq(settled, 0, "no backing room: the stamping call settles nothing");
        assertEq(unfinished, 1);
        {
            uint256[] memory listed = _mut().getForfeitedLenderEntryIds(LOAN_P);
            assertEq(listed.length, 1, "the stamp listed the borrower entry on its loan");
            assertEq(listed[0], id, "and it is this entry");
        }

        oracle.setFlagged(alice, false);
        _mut().setRecycleBucketRaw(bucket0);
        (d, , settled, , ) = _forfeit(alice);
        assertEq(d, DELIVER, "delisted: the owner sweep stands down");
        assertEq(settled, 0);
        assertFalse(_entry(id).processed, "still owed after the delisting");

        vm.recordLogs();
        vm.prank(stranger);
        uint256 swept = InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN_P);
        {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertGt(swept, 0, "the loan sweep reaches the listed entry past the moved pointer");
            assertTrue(_entry(id).processed, "STORED: settled");
            assertEq(_bucket() - bucket0, swept, "STORED: the bucket grew by the settled fresh");
            _assertSettledLog(logs, id, alice, LOAN_P, swept);
            (uint256 credited, uint256 n) =
                _recycled(logs, uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward), LOAN_P);
            assertEq(n, 1, "one ForfeitedReward credit, keyed to the loan");
            assertEq(credited, swept);
        }
        vm.prank(stranger);
        assertEq(
            InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN_P),
            0,
            "a second loan sweep settles nothing: once"
        );
    }

    /// @notice T8 - a terminal-but-unclosed entry (the loan Defaulted, the
    ///         lender's entry never closed, claimable by the terminal fallback)
    ///         is stamped and forfeited.
    /// @dev   Kills M10 (gate the stamp on `closed` instead of claimability).
    function test_sanc_T8_aTerminalButUnclosedEntry_isStampedAndForfeited() public {
        _setLoanStatus(LOAN_D, LibVaipakam.LoanStatus.Defaulted);
        uint256 id = _seedOpen(alice, LOAN_D);
        assertFalse(_entry(id).closed, "fixture: never closed");
        assertGt(_livePreview(alice), 0, "fixture LIVE: the terminal fallback makes it claimable");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        uint256 bucket0 = _bucket();
        (uint8 d, uint256 stamped, uint256 settled, , ) = _forfeit(alice);
        assertEq(d, FORFEIT);
        assertEq(stamped, 1, "a claimable entry is stampable whether or not it was closed");
        assertGt(settled, 0);
        assertTrue(_entry(id).forfeited);
        assertTrue(_entry(id).processed);
        assertEq(_bucket() - bucket0, settled);
    }

    /// @notice T8b - an open loan's entry is not stamped (code 4) while the loan
    ///         is Active, and the lens agrees; the SAME entry is stamped once its
    ///         loan is terminal. That is the straddle.
    /// @dev   Kills M10b (drop the claimable term).
    function test_sanc_T8b_anOpenLoansEntry_isNotStamped_untilItsLoanEnds() public {
        uint256 id = _seedOpen(alice, LOAN_O);
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, FORFEIT, "fixture: the owner is confirmed");
        assertEq(stamped, 0, "an open loan's entry is not stampable");
        assertFalse(_entry(id).forfeited);
        (uint256[] memory ids, ) = _lens().getSanctionsForfeitableRewardEntries(alice, 0, 10);
        assertEq(_compact(ids).length, 0, "the lens agrees");
        _setLoanStatus(LOAN_O, LibVaipakam.LoanStatus.Repaid);
        (d, stamped, , , ) = _forfeit(alice);
        assertEq(stamped, 1, "once the loan ends the same entry is stamped");
        assertTrue(_entry(id).forfeited);
    }

    /// @notice T9 - an entry past its removal point belongs to the expiry
    ///         route: not stamped (code 3) while its twin is, and the expiry
    ///         sweep finishes it as EXPIRED reward even though the owner is
    ///         barred (the seam does not fire past the removal point).
    /// @dev   Kills M11 (drop the `expiryBegun` term): X would be stamped and
    ///        settle as a forfeit, and the expiry walk would then skip it.
    function test_sanc_T9_anEntryPastItsRemovalPoint_isLeftToTheExpiryRoute() public {
        uint256 idX = _seed(alice, LOAN_A);
        uint256 idY = _seed(alice, LOAN_B);
        _mut().setRewardEntryExpiryBegunRaw(idX, true);
        assertTrue(_mut().getRewardEntryExpiryBegunRaw(idX), "fixture: X is past its removal point");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        vm.recordLogs();
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(d, FORFEIT);
        assertEq(stamped, 1, "only the twin without a removal point is stamped");
        assertEq(uint256(_nth(logs, T_STAMPED, 0).topics[1]), idY, "and it is Y");
        assertFalse(_entry(idX).forfeited, "X is not stamped");
        assertFalse(_entry(idX).processed);

        assertEq(_sweeper().sweepExpiredInteractionRewards(_ids(idX)), 0, "the first touch starts X's clock");
        vm.warp(_now() + 1 days);
        vm.recordLogs();
        uint256 expired = _sweeper().sweepExpiredInteractionRewards(_ids(idX));
        logs = vm.getRecordedLogs();
        assertGt(expired, 0, "the removed entry settles");
        (uint256 asExpired, ) = _recycled(logs, uint8(LibVpfiRecycle.RecycleSource.ExpiredReward), 0);
        assertEq(asExpired, expired, "as expired reward");
        assertEq(_recycledCount(logs, uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward)), 0, "never as a forfeit");
        assertEq(_count(logs, T_EXPIRED), 1, "its expiry is announced");
        assertTrue(_entry(idX).processed);
        assertFalse(_entry(idX).forfeited);
    }

    // ----------------------------- the expiry seam -----------------------------

    /// @notice T13a - a barred owner's expiry sweep makes no walk self-call: the
    ///         seam answers in the facade. LIVE: the same entry's clock started
    ///         while the owner was clean, which is the walk running.
    /// @dev   Kills M15 (remove the seam): the walk would be called. Kept apart
    ///        from T13b because a zero-count `expectCall` covers the rest of the
    ///        test.
    function test_sanc_T13a_aBarredOwnersSweep_makesNoWalkSelfCall() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seed(alice, LOAN_A);
        _sweeper().sweepExpiredInteractionRewards(_ids(id));
        (uint64 stamp, ) = _lens().getRewardEntryExpiry(id);
        assertGt(stamp, 0, "fixture LIVE: the clean owner's clock started");
        vm.warp(_now() + 3 days);
        oracle.setFlagged(alice, true);
        vm.expectCall(address(diamond), abi.encodeWithSelector(SEL_EXPIRY_WALK), 0);
        assertEq(_sweeper().sweepExpiredInteractionRewards(_ids(id)), 0, "nothing expires for a barred owner");
    }

    /// @notice T13b - the seam NOTES the barred observation, so neither the
    ///         barred interval nor the one spanning it is ever credited, while a
    ///         clean interval after it is. Straddle: 3 barred-spanning days earn
    ///         nothing, 3 clean days earn 3.
    /// @dev   Kills M15 (no seam, with the walk's own sanctions term deleted):
    ///        6 days would be credited. Also kills a seam that returns without
    ///        noting: the 6-day interval from the stamp would be credited.
    function test_sanc_T13b_aBarredObservationIsNoted_soTheBlockedIntervalIsNeverCredited() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seed(alice, LOAN_A);
        uint256 t0 = _now();
        _sweeper().sweepExpiredInteractionRewards(_ids(id));
        (uint64 stamp, uint64 expiry) = _lens().getRewardEntryExpiry(id);
        assertGt(stamp, 0, "fixture LIVE: stamped at t0");
        assertEq(uint256(expiry), t0 + REQUIRED, "fixture: nothing accrued yet");
        vm.warp(t0 + 3 days);
        oracle.setFlagged(alice, true);
        _sweeper().sweepExpiredInteractionRewards(_ids(id));
        oracle.setFlagged(alice, false);
        vm.warp(t0 + 6 days);
        _sweeper().sweepExpiredInteractionRewards(_ids(id));
        (, expiry) = _lens().getRewardEntryExpiry(id);
        assertEq(uint256(expiry), t0 + 6 days + REQUIRED, "neither the barred interval nor the one spanning it was credited");
        vm.warp(t0 + 9 days);
        _sweeper().sweepExpiredInteractionRewards(_ids(id));
        (, expiry) = _lens().getRewardEntryExpiry(id);
        assertEq(uint256(expiry), t0 + 9 days + REQUIRED - 3 days, "a clean interval is credited");
    }

    // ----------------------------- what is not touched -----------------------------

    /// @notice T14 - reward already delivered stays where it is: the forfeit
    ///         reaches only the undelivered entry, and the vault's VPFI, the
    ///         wallet's VPFI and the vault's tracked balance are unchanged.
    function test_sanc_T14_rewardAlreadyDelivered_staysFrozen_untouchedByTheForfeit() public {
        uint256 idA = _seed(alice, LOAN_A);
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(alice);
        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Vault);
        assertGt(paid, 0, "fixture LIVE: the clean claim delivered");
        assertTrue(_entry(idA).processed);
        uint256 vaultBal = vpfi.balanceOf(vault);
        uint256 walletBal = vpfi.balanceOf(alice);
        uint256 tracked = VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(alice, address(vpfi));
        assertEq(vaultBal + walletBal, paid, "fixture: the reward was delivered");

        uint256 idB = _seed(alice, LOAN_B);
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (, uint256 stamped, uint256 settled, , ) = _forfeit(alice);
        assertEq(stamped, 1, "only the undelivered entry is stamped");
        assertGt(settled, 0);
        assertTrue(_entry(idB).forfeited);
        assertEq(vpfi.balanceOf(vault), vaultBal, "the vault's VPFI is untouched");
        assertEq(vpfi.balanceOf(alice), walletBal, "the wallet's VPFI is untouched");
        assertEq(
            VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(alice, address(vpfi)),
            tracked,
            "the tracked balance is untouched"
        );
    }

    /// @notice T15 - loan value is untouched: the loan record, the lender's
    ///         claimable and the frozen-claimant marker read the same after the
    ///         owner's reward entry on that loan is forfeited.
    function test_sanc_T15_loanValueIsUntouched() public {
        LibVaipakam.Loan memory l;
        l.id = LOAN_V;
        l.lender = alice;
        l.borrower = bob;
        l.principal = 1_000 ether;
        l.status = LibVaipakam.LoanStatus.Repaid;
        _mut().setLoan(LOAN_V, l);
        _mut().setLenderClaimAmountRaw(LOAN_V, 7 ether);
        _mut().setSanctionsFrozenClaimant(LOAN_V, true, alice);
        uint256 id = _seed(alice, LOAN_V);
        bytes32 loanHash = keccak256(abi.encode(LoanFacet(address(diamond)).getLoanDetails(LOAN_V)));
        (, uint256 claimAmt, , , , , uint256 held, ) = ClaimFacet(address(diamond)).getClaimable(LOAN_V, true);
        assertEq(claimAmt, 7 ether, "fixture LIVE: a lender claimable stands");

        oracle.setFlagged(alice, true);
        _confirm(alice);
        (, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(stamped, 1, "the reward entry on the loan is forfeited");
        assertTrue(_entry(id).processed);
        assertEq(
            keccak256(abi.encode(LoanFacet(address(diamond)).getLoanDetails(LOAN_V))),
            loanHash,
            "the loan record is untouched"
        );
        (, uint256 claimAmt2, , , , , uint256 held2, ) = ClaimFacet(address(diamond)).getClaimable(LOAN_V, true);
        assertEq(claimAmt2, claimAmt, "the claimable is untouched");
        assertEq(held2, held, "and the held lender value");
        assertEq(_mut().getSanctionsFrozenClaimant(LOAN_V, true), alice, "the frozen-claimant marker stands");
    }

    // ----------------------------- paging and repeat -----------------------------

    /// @notice T16 - paging: a call scans at most 32 entries and runs at most 30
    ///         chunk steps whatever it is asked; every scanned entry is stamped;
    ///         `nextIndex` advances past an unfinished entry and `unfinished`
    ///         counts it; smaller budgets are honoured; and a 200-entry owner is
    ///         drained by walking the pages and re-running from 0 while anything
    ///         is unfinished.
    function test_sanc_T16_pagingClampsAndAlwaysAdvances_andA200EntryOwnerDrains() public {
        uint256 n = 200;
        uint256 firstId = _seed(alice, LOAN_A);
        for (uint256 i = 1; i < n; ++i) _seed(alice, LOAN_A);
        oracle.setFlagged(alice, true);
        _confirm(alice);

        (uint8 d, uint256 stamped, uint256 settled, uint256 next, uint256 unfinished) =
            _forfeitPage(alice, 0, 1000, 1000);
        assertEq(d, FORFEIT);
        assertEq(next, PAGE_ENTRIES, "a page holds at most 32 entries, whatever was asked");
        assertEq(stamped, PAGE_ENTRIES, "every scanned entry is stamped");
        assertEq(unfinished, PAGE_ENTRIES - PAGE_STEPS, "the step clamp leaves the page's tail unfinished");
        assertGt(settled, 0);
        assertTrue(_entry(firstId + PAGE_STEPS - 1).processed, "the last stepped entry settled");
        assertFalse(_entry(firstId + PAGE_STEPS).processed, "the next is stamped and unfinished");
        assertTrue(_entry(firstId + PAGE_STEPS).forfeited);

        (, stamped, , next, unfinished) = _forfeitPage(alice, PAGE_STEPS, 1, 1);
        assertEq(next, PAGE_STEPS + 1, "one entry asked, one scanned");
        assertEq(stamped, 0, "already stamped");
        assertEq(unfinished, 0, "one step settles a one-day entry");
        assertTrue(_entry(firstId + PAGE_STEPS).processed);

        uint256 calls;
        uint256 from = next;
        bool clean;
        while (!clean) {
            uint256 passUnfinished;
            while (from < n) {
                (, , , next, unfinished) = _forfeitPage(alice, from, PAGE_ENTRIES, PAGE_STEPS);
                assertGt(next, from, "a page always advances");
                passUnfinished += unfinished;
                from = next;
                assertLt(++calls, 40, "the drain is bounded");
            }
            clean = passUnfinished == 0;
            from = 0;
        }
        for (uint256 i; i < n; ++i) {
            LibVaipakam.RewardEntry memory e = _entry(firstId + i);
            assertTrue(e.forfeited && e.processed, "every entry forfeited and settled");
        }
    }

    /// @notice T17 - a second sweep over a settled owner stamps nothing,
    ///         settles nothing and announces nothing.
    function test_sanc_T17_aSecondSweepIsIdempotent() public {
        uint256 id = _seed(alice, LOAN_A);
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (, uint256 stamped, uint256 settled, , ) = _forfeit(alice);
        assertEq(stamped, 1, "fixture LIVE: the first sweep stamped");
        assertGt(settled, 0, "and settled");
        assertTrue(_entry(id).processed);
        uint256 bucket1 = _bucket();
        uint256 paid1 = _paidOut();
        vm.recordLogs();
        (uint8 d, uint256 stamped2, uint256 settled2, , uint256 unfinished2) = _forfeit(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(d, FORFEIT);
        assertEq(stamped2, 0, "nothing re-stamped");
        assertEq(settled2, 0, "nothing re-settled");
        assertEq(unfinished2, 0);
        assertEq(_count(logs, T_STAMPED), 0, "no stamp announced");
        assertEq(_count(logs, T_SETTLED), 0, "no chunk announced");
        assertEq(_count(logs, T_RECYCLED), 0, "no credit");
        assertEq(_bucket(), bucket1);
        assertEq(_paidOut(), paid1);
    }

    // ----------------------------- views -----------------------------

    /// @notice T18 - the lens lists exactly what the stamp takes (one blocker
    ///         for both), an ineligible entry in neither; a stamped entry has no
    ///         countdown; and once stamped nothing is left to list. The horizon
    ///         clock was started while the owner was clean, so the countdown is
    ///         live before the stamp; zero backing room keeps the stamped
    ///         entries unsettled so the countdown is read on a stamped,
    ///         unprocessed entry.
    /// @dev   Kills M16 (drop the forfeited term from the countdown): the
    ///        barred owner's paused countdown would still read non-zero.
    function test_sanc_T18_theLensListsExactlyWhatTheStampTakes_andAStampedEntryHasNoCountdown() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 idA = _seed(alice, LOAN_A);
        uint256 idB = _seed(alice, LOAN_B);
        uint256 idC = _seedOpen(alice, LOAN_O);
        uint256[] memory all3 = new uint256[](3);
        all3[0] = idA;
        all3[1] = idB;
        all3[2] = idC;
        _sweeper().sweepExpiredInteractionRewards(all3);
        (uint64 stampA, uint64 expA) = _lens().getRewardEntryExpiry(idA);
        assertGt(stampA, 0, "fixture LIVE: A's clock started while clean");
        assertGt(expA, 0, "and A carries a countdown");

        oracle.setFlagged(alice, true);
        _confirm(alice);
        (uint256[] memory listed, ) = _lens().getSanctionsForfeitableRewardEntries(alice, 0, 10);
        listed = _compact(listed);
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));
        vm.recordLogs();
        (, uint256 stamped, , , ) = _forfeit(alice);
        uint256[] memory taken = _stampedIds(vm.getRecordedLogs());
        assertEq(stamped, 2, "A and B");
        assertEq(listed.length, 2, "the lens listed A and B, not the open-loan C");
        assertTrue(_sameSet(listed, taken), "the lens lists exactly the entries the stamp takes");
        assertFalse(_entry(idA).processed, "fixture: stamped, not yet settled");
        (, uint64 expAfter) = _lens().getRewardEntryExpiry(idA);
        assertEq(expAfter, 0, "a stamped entry has no countdown");
        (, uint64 expB) = _lens().getRewardEntryExpiry(idB);
        assertEq(expB, 0, "nor B");
        (listed, ) = _lens().getSanctionsForfeitableRewardEntries(alice, 0, 10);
        assertEq(_compact(listed).length, 0, "nothing is left to stamp");
    }

    // ----------------------------- the loan sweep and the wrapper -----------------------------

    /// @notice T19 - the per-loan sweep, which now settles through the evented
    ///         wrapper, announces each chunk it settles (entry, owner, loan and
    ///         the fresh it moved) and announces nothing when nothing moves.
    function test_sanc_T19_theLoanSweepAnnouncesEachSettledChunk() public {
        uint256 id = _mut().pushRewardEntry(alice, LOAN_S, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(id, 3);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(LOAN_S, id);
        vm.recordLogs();
        vm.prank(keeper);
        uint256 swept = InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN_S);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(swept, 0, "fixture LIVE: the sweep settled");
        _assertSettledLog(logs, id, alice, LOAN_S, swept);
        vm.recordLogs();
        vm.prank(keeper);
        assertEq(InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN_S), 0);
        assertEq(_count(vm.getRecordedLogs(), T_SETTLED), 0, "nothing moved: nothing announced");
    }

    /// @notice T22 - the chunk wrapper refuses an entry the forfeit route does
    ///         not own: on a payable (unforfeited) entry it returns zeros and
    ///         moves nothing. Straddle: the same entry, forfeited, settles
    ///         through the same wrapper.
    /// @dev   Kills M22 (drop the wrapper's guard): the payable entry would be
    ///        settled whole and marked processed.
    function test_sanc_T22_theChunkWrapperRefusesAnUnforfeitedEntry() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE: the entry is payable");
        (bool ok, uint256 f, uint256 r, uint256 o, uint256 dl) = _chunkDirect(id);
        assertTrue(ok, "the wrapper answers");
        assertEq(f + r + o + dl, 0, "a payable entry is not the forfeit route's: zeros");
        assertFalse(_entry(id).processed, "and nothing moved");
        _mut().setRewardEntryForfeitedRaw(id);
        (ok, f, , , ) = _chunkDirect(id);
        assertTrue(ok);
        assertGt(f, 0, "the same entry forfeited settles through the same wrapper");
        assertTrue(_entry(id).processed);
    }

    /// @dev The walk host's chunk entry, called as the Diamond itself (its gate
    ///      admits only that caller). The first four words of the return are
    ///      the chunk's tuple; the folded legs after them are not read.
    function _chunkDirect(uint256 id) internal returns (bool ok, uint256 f, uint256 r, uint256 o, uint256 dl) {
        LibInteractionRewards.TransportLegs memory legs;
        bytes memory ret;
        vm.prank(address(diamond));
        (ok, ret) = address(diamond).call(
            abi.encodeWithSignature(
                "epochForfeitEntryChunk(uint256,uint256,uint256,(uint256,uint256,uint256,uint256,uint256,uint256))",
                id,
                LibVaipakam.VPFI_INTERACTION_POOL_CAP,
                type(uint256).max,
                legs
            )
        );
        if (ok) (f, r, o, dl) = abi.decode(ret, (uint256, uint256, uint256, uint256));
    }

    /// @notice T23 - a recovery-banned owner (the declared source flagged, the
    ///         owner's own address clean) follows the same rows: held one second
    ///         short of the window, forfeited at it (O-3 default).
    function test_sanc_T23_aRecoveryBannedOwner_isForfeitedAfterTheCadence() public {
        address src = makeAddr("sanc-banned-source");
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        _mut().setVaultBannedSourceRaw(alice, src);
        oracle.setFlagged(src, true);
        assertFalse(oracle.flagged(alice), "fixture: the owner's own address reads clean");
        uint256 t0 = _now();
        assertEq(_observe(alice), HOLD, "the ban leg reads Flagged: a first flag holds");
        uint256 t = t0;
        while (t + G < t0 + W) {
            t += G;
            vm.warp(t);
            _observe(alice);
        }
        vm.warp(t0 + W - 1);
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, HOLD, "one second short of the window");
        assertEq(stamped, 0);
        vm.warp(t0 + W);
        (d, stamped, , , ) = _forfeit(alice);
        assertEq(d, FORFEIT, "confirmed at the window");
        assertEq(stamped, 1);
        assertTrue(_entry(id).forfeited);
        assertTrue(_entry(id).processed);
    }
}

/// @title RewardSanctionsForfeitStagedTest
/// @notice The mirror fixture: reward custody active, armed ShareOfPool days,
///         live fresh delivered through the typed ingress, wide days staged by
///         the transport machinery. The armed forfeit, the staged payout's hold,
///         records and domains around a stamp, and the headroom floor.
contract RewardSanctionsForfeitStagedTest is RewardSanctionsTestBase {
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    /// @dev The armed day's per-user cap in the staging scenes.
    uint256 internal constant NEED = 0.4e18;
    /// @dev 65 epochs of this each list day 1: one window (64) and one past it.
    uint256 internal constant TINY = 0.005e18;
    uint256 internal constant WIDE = 65;
    /// @dev A domain's extent: more than one 30-day chunk.
    uint32 internal constant DAYS = 40;
    /// @dev The legacy slice's epoch coverage (T21).
    uint256 internal constant EPOCH = 0.1e18;
    uint256 internal liveNonce;

    struct PaySnap {
        uint256 encumbered;
        uint256 poolReserved;
        uint256 liveReserved;
        uint256 armedReserved;
        uint256 paidOut;
        uint256 commitFresh;
        uint256 sideReserved;
        /// @dev The figures `_pay` writes FIRST, before any reserved counter:
        ///      the staged earmark's release and the record's two hold moves
        ///      out of the Resolving custody row (T12 places the mutant hold
        ///      right after them, M14).
        uint256 stagedEarmark;
        uint256 resolvingRow;
        uint256 unclassifiedRow;
        uint256 recycledRow;
        uint256 heldEpoch;
        uint256 heldRecycled;
    }

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 60 days);
        uint256 have = vpfi.balanceOf(address(this));
        if (SEED > have) vpfi.mint(address(this), SEED - have);
        vpfi.transfer(address(diamond), SEED);
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(this));
        activateRewardCustodyForTest(address(vpfi), 0);
        alice = makeAddr("sanc-staged-alice");
        keeper = makeAddr("sanc-staged-keeper");
        oracle = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
    }

    // ----------------------------- fixtures -----------------------------

    function _epoch() internal view returns (RewardEpochFacet) {
        return RewardEpochFacet(address(diamond));
    }

    function _view() internal view returns (RewardEpochViewFacet) {
        return RewardEpochViewFacet(address(diamond));
    }

    function _staging() internal view returns (RewardStagingFacet) {
        return RewardStagingFacet(address(diamond));
    }

    function _settle() internal view returns (RewardStagingSettleFacet) {
        return RewardStagingSettleFacet(address(diamond));
    }

    function _domain() internal view returns (RewardStagingDomainFacet) {
        return RewardStagingDomainFacet(address(diamond));
    }

    function _ingress() internal view returns (RewardIngressFacet) {
        return RewardIngressFacet(address(diamond));
    }

    function _one(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    function _armedDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
        _mut().setDayCapModeRaw(d, 1);
        _mut().setDayUserSideCapRaw(d, cap);
    }

    function _loanSideOpen(uint32 openDays) internal {
        _mut().setFeeEntitlementRaw(
            LOAN,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: openDays,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: type(uint128).max
            })
        );
    }

    function _entryOn(uint32 startDay, uint32 endDay) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, startDay);
        _mut().closeRewardEntryRaw(id, endDay);
    }

    /// @dev One armed day (1) at `cap` with alice's one-day entry on it, the
    ///      delivered ledger at zero.
    function _sceneAt(uint256 cap) internal returns (uint256 id) {
        _armedDay(1, cap);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        id = _entryOn(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
    }

    /// @dev Live fresh in custody plus a delivered ledger that can pay it. One
    ///      receipt per call: the ingress refuses a repeated receipt id.
    function _liveFresh(uint256 amount) internal {
        ++liveNonce;
        _ingress().onRewardBudgetReceived(
            address(vpfi),
            amount,
            _one(1),
            CHAIN_BASE,
            5000 + liveNonce,
            REMITTER,
            0,
            amount,
            keccak256(abi.encode("sanc-live", liveNonce)),
            true
        );
        _mut().setArmedFreshLedgerRaw(amount, 0);
    }

    function _epochOf(uint256 amount, uint256 remitId, bytes32 bid) internal returns (bytes32 h) {
        _ingress().onRewardBudgetReceived(address(vpfi), amount, _one(1), CHAIN_BASE, remitId, REMITTER, 0, 0, bid, false);
        h = keccak256(abi.encode(uint256(CHAIN_BASE), bid));
        _epoch().materializeTransportBatchPage(h, _one(1));
    }

    /// @dev 65 attested fresh epochs listing day 1, ten seconds apart.
    function _wideDay() internal {
        uint256 t0 = _now();
        for (uint256 i; i < WIDE; ++i) {
            vm.warp(t0 + 10 * (i + 1));
            _epochOf(TINY, 100 + i, keccak256(abi.encode("sanc-tiny", i)));
            _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 100 + i, TINY, 0);
        }
    }

    function _epochOnDay(uint256 amount, uint256 d, uint256 remitId, bytes32 bid) internal {
        _ingress().onRewardBudgetReceived(address(vpfi), amount, _one(d), CHAIN_BASE, remitId, REMITTER, 0, 0, bid, false);
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), bid));
        _epoch().materializeTransportBatchPage(h, _one(d));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, remitId, amount, 0);
    }

    function _wideDayOn(uint256 d, uint256 salt) internal {
        uint256 t0 = _now();
        for (uint256 i; i < WIDE; ++i) {
            vm.warp(t0 + 10 * (i + 1));
            _epochOnDay(TINY, d, salt + i, keccak256(abi.encode("sanc-wide", d, salt, i)));
        }
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    function _preview() internal returns (uint256 amount) {
        (amount, , ) = previewByExecution(alice);
    }

    function _dayKey(uint256 d) internal view returns (bytes32) {
        return keccak256(abi.encode(alice, LibVaipakam.RewardSide.Lender, d));
    }

    function _key() internal view returns (bytes32) {
        return _dayKey(1);
    }

    function _rec() internal view returns (RewardStagingDomainFacet.StagingRecordView memory) {
        return RewardStagingDomainFacet(address(diamond)).getStagingRecord(_key());
    }

    function _userShare(RewardStagingDomainFacet.StagingRecordView memory r) internal pure returns (uint256) {
        return r.reservedLiveUserFresh + r.epochUserFresh + r.reservedLiveUserRecycled + r.epochUserRecycled;
    }

    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) {
        return RewardCustodyFacet(address(diamond)).rewardCustodyRow(r);
    }

    function _rowsSum() internal view returns (uint256 s) {
        for (uint8 i; i <= uint8(LibVaipakam.RewardCustodyRow.Resolving); ++i) {
            s += _row(LibVaipakam.RewardCustodyRow(i));
        }
    }

    /// @dev The scene, the wide day, and the clean claim that stages its window
    ///      into a record (op Claim) at the entry's cursor day.
    function _stagedScene() internal returns (uint256 id) {
        id = _sceneAt(NEED);
        _wideDay();
        assertEq(_claim(), 0, "fixture: the wide day is staged, not settled");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Staging), "fixture: a record stands");
    }

    /// @dev The staged scene with the record's scan run to the list's end.
    function _stagedAndScanned() internal returns (uint256 id) {
        id = _stagedScene();
        _staging().prepareStagedDay(_key());
        _staging().prepareStagedDay(_key());
        assertTrue(_rec().scanComplete, "fixture: the scan reached the list's end");
    }

    function _resolveAll(bytes32 key) internal {
        uint256 pages;
        while (!_settle().resolveStagedDayPage(key)) {
            assertLt(++pages, 16, "the record resolves");
        }
    }

    function _paySnap() internal view returns (PaySnap memory p) {
        p.encumbered = _mut().stagingEncumberedCountRaw();
        p.poolReserved = _mut().interactionPoolReservedRaw();
        p.liveReserved = _mut().liveFreshReservedRaw();
        p.armedReserved = _mut().rewardBudgetArmedFreshReservedRaw();
        p.paidOut = _paidOut();
        (, p.commitFresh, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        p.sideReserved = _mut().loanSideRewardReservedRaw(LOAN, uint8(LibVaipakam.RewardSide.Lender));
        p.stagedEarmark = _mut().stagedEpochTotalRaw();
        p.resolvingRow = _row(LibVaipakam.RewardCustodyRow.Resolving);
        p.unclassifiedRow = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        p.recycledRow = _row(LibVaipakam.RewardCustodyRow.Recycled);
        RewardStagingDomainFacet.StagingRecordView memory r = _rec();
        p.heldEpoch = r.heldEpoch;
        p.heldRecycled = r.heldRecycled;
    }

    /// @dev A page that only re-holds (every batch already resolved) writes
    ///      nothing `_pay` owns: every figure reads exactly as before it.
    function _assertSamePaySnap(PaySnap memory a, PaySnap memory b, string memory tag) internal pure {
        assertEq(b.encumbered, a.encumbered, tag);
        assertEq(b.poolReserved, a.poolReserved, tag);
        assertEq(b.liveReserved, a.liveReserved, tag);
        assertEq(b.armedReserved, a.armedReserved, tag);
        assertEq(b.paidOut, a.paidOut, tag);
        assertEq(b.commitFresh, a.commitFresh, tag);
        assertEq(b.sideReserved, a.sideReserved, tag);
        assertEq(b.stagedEarmark, a.stagedEarmark, tag);
        assertEq(b.resolvingRow, a.resolvingRow, tag);
        assertEq(b.unclassifiedRow, a.unclassifiedRow, tag);
        assertEq(b.recycledRow, a.recycledRow, tag);
        assertEq(b.heldEpoch, a.heldEpoch, tag);
        assertEq(b.heldRecycled, a.heldRecycled, tag);
    }

    /// @dev Drives the record's pages until its payout first observes the flag
    ///      (the evidence's first sighting), and returns the `_pay`-owned
    ///      figures as they stood right before that page.
    function _pageUntilHold() internal returns (PaySnap memory before) {
        uint256 pages;
        while (_lastSeen(alice) == 0) {
            before = _paySnap();
            assertFalse(_settle().resolveStagedDayPage(_key()), "no page completes for an unconfirmed flag");
            assertLt(++pages, 8, "the last page is reached");
        }
    }

    // domain fixtures

    /// @dev `days_` armed days from day 1, one lender entry over all of them.
    function _longScene(uint32 days_) internal returns (uint256 id) {
        for (uint256 d = 1; d <= days_; ++d) _armedDay(d, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(days_);
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(id, days_ + 1);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _dk() internal view returns (bytes32) {
        return keccak256(abi.encode(alice, LibVaipakam.RewardSide.Lender));
    }

    function _domPhase() internal view returns (uint8 phase) {
        (, phase, , , , , , , , , , , ) = _domain().getStagingDomain(alice, LibVaipakam.RewardSide.Lender);
    }

    function _reserveAllDomain() internal {
        uint256 calls;
        while (!_domain().reserveDomainPage(_dk())) {
            assertLt(++calls, 64, "the domain reserves");
        }
    }

    function _resolveAllDomain() internal {
        uint256 calls;
        while (!_domain().resolveDomainPage(_dk())) {
            assertLt(++calls, 128, "the domain resolves");
        }
    }

    // legacy-slice fixtures

    function _legacyDay(uint256 d) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
    }

    /// @dev Days 1-2 accrue, arming is day 5: the entry [1, 3) is one wholly
    ///      pre-arming legacy slice, priced whole-window.
    function _legacyScene() internal returns (uint256 id) {
        _legacyDay(1);
        _legacyDay(2);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _loanSideOpen(2);
        id = _entryOn(1, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _legacyTotal() internal view returns (uint256 total) {
        (, , , total, , , , ) = _view().getUserArmedFreshNeedWithLegs(alice);
    }

    // ----------------------------- the armed forfeit -----------------------------

    /// @notice T2 - the window straddle on an ARMED entry. One second short of
    ///         the window the facade holds and moves nothing; at the window it
    ///         stamps, settles the day through the engine, and the value lands
    ///         in the bucket as `ForfeitedReward` under refId 0: the stamp event
    ///         names the entry, owner, loan, side and the flag's start; the
    ///         chunk event names the fresh it moved; the bucket and the pool's
    ///         paid-out grow by it; the armed commitment retires by exactly the
    ///         day's obligation; the entry is processed in one call; and the
    ///         custody rows only move between themselves.
    /// @dev   Kills M2 (drop the age check - W - 1 would forfeit), M3 (settle as
    ///        `ExpiredReward` - the source filter), M4 (drop the commitment
    ///        retirement - the outstanding commitment would not fall). The D1
    ///        cap is lifted so the day's whole fresh half is the obligation and
    ///        nothing is capped off: then the retirement equals the settlement
    ///        exactly.
    function test_sanc_T2_theWindowStraddle_forfeitsAnArmedEntryIntoTheBucket() public {
        uint256 id = _sceneAt(type(uint256).max);
        _liveFresh(2e18);
        uint256 owed = _preview();
        assertGt(owed, 0, "fixture LIVE: the armed day pays a clean owner");
        _mut().setOutstandingCommitRaw(5e18, 0);
        oracle.setFlagged(alice, true);
        uint256 t0 = _now();
        assertEq(_observe(alice), HOLD, "a first flag holds");
        uint256 t = t0;
        while (t + G < t0 + W) {
            t += G;
            vm.warp(t);
            assertEq(_observe(alice), HOLD);
        }
        uint256 bucket0 = _bucket();
        uint256 paid0 = _paidOut();
        uint256 rows0 = _rowsSum();
        (, uint256 commit0, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();

        vm.warp(t0 + W - 1);
        (uint8 d, uint256 stamped, uint256 settled, , ) = _forfeit(alice);
        assertEq(d, HOLD, "one second short of the window: held");
        assertEq(stamped, 0);
        assertEq(settled, 0);
        assertFalse(_entry(id).forfeited);
        assertEq(_bucket(), bucket0, "nothing moved");

        vm.warp(t0 + W);
        vm.recordLogs();
        uint256 next;
        uint256 unfinished;
        (d, stamped, settled, next, unfinished) = _forfeit(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(d, FORFEIT, "confirmed at the window");
        assertEq(stamped, 1);
        assertEq(settled, owed, "the forfeit settles what the claim would have paid (untrimmed pricing)");
        assertEq(next, 1);
        assertEq(unfinished, 0, "processed in one call");
        _assertStampLog(logs, id, alice, LOAN, t0);
        _assertSettledLog(logs, id, alice, LOAN, owed);
        (uint256 asForfeit, uint256 nForfeit) =
            _recycled(logs, uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward), 0);
        assertGt(nForfeit, 0, "credited as forfeited reward, refId 0");
        assertEq(asForfeit, owed, "for the whole settlement");
        assertEq(_recycledCount(logs, uint8(LibVpfiRecycle.RecycleSource.ExpiredReward)), 0, "never as expired reward");
        assertEq(_bucket() - bucket0, owed, "the bucket grows by it");
        assertEq(_paidOut() - paid0, owed, "the pool's paid-out grows by it");
        (, uint256 commit1, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(commit0 - commit1, owed, "the armed commitment retires by exactly the day's obligation");
        assertTrue(_entry(id).forfeited);
        assertTrue(_entry(id).processed);
        assertEq(_rowsSum(), rows0, "a row move: nothing minted, nothing burned");
        assertEq(vpfi.balanceOf(alice), 0, "nothing reaches the flagged wallet");
    }

    // ----------------------------- records and domains around a stamp -----------------------------

    /// @notice T10 - a RESOLVING record at the entry's cursor day blocks the
    ///         stamp (code 6), and its own last page forfeits the user share
    ///         once the chain completes; the entry is never stamped.
    /// @dev   Kills M12 (drop the Resolving terms): the entry would be stamped
    ///        under an irrevocable record.
    function test_sanc_T10_aResolvingRecordAtTheCursor_isNotStamped_andItsLastPageForfeits() public {
        uint256 id = _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        assertFalse(_settle().resolveStagedDayPage(_key()), "fixture: one page in");
        RewardStagingDomainFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Resolving), "fixture: Resolving at the cursor day");
        assertGt(_userShare(r), 0, "fixture LIVE: a user share stands");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, FORFEIT, "fixture: the owner is confirmed");
        assertEq(stamped, 0, "a Resolving record's entry is not stamped");
        assertFalse(_entry(id).forfeited);
        (uint256[] memory listed, ) = _lens().getSanctionsForfeitableRewardEntries(alice, 0, 10);
        assertEq(_compact(listed).length, 0, "the lens agrees");
        uint256 bucket0 = _bucket();
        vm.recordLogs();
        assertTrue(_settle().resolveStagedDayPage(_key()), "the last page completes");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 1, "the record's own payout forfeits the share");
        assertEq(_count(logs, T_DELIVERED), 0, "nothing delivered");
        assertEq(_bucket() - bucket0, r.reservedLiveUserFresh + r.epochUserFresh, "the user's fresh absorbed");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
        assertTrue(_entry(id).processed, "settled by the record");
        assertFalse(_entry(id).forfeited, "never stamped");
    }

    /// @notice T10b - the same Resolving record, the owner delisted before its
    ///         last page: the page delivers the share, the Clean read heals the
    ///         evidence, and the entry is never stamped.
    function test_sanc_T10b_aDelistingBeforeTheLastPage_delivers_neverStamps() public {
        uint256 id = _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        assertFalse(_settle().resolveStagedDayPage(_key()), "fixture: one page in");
        RewardStagingDomainFacet.StagingRecordView memory r = _rec();
        uint256 share = _userShare(r);
        assertGt(share, 0, "fixture LIVE: a user share stands");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(stamped, 0, "fixture: the record blocks the stamp");
        oracle.setFlagged(alice, false);
        vm.recordLogs();
        assertTrue(_settle().resolveStagedDayPage(_key()), "the last page completes");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 0, "a delisted owner is not forfeited");
        assertEq(_count(logs, T_DELIVERED), 1, "the share is delivered");
        (uint256 amount, ) = abi.decode(_nth(logs, T_DELIVERED, 0).data, (uint256, uint8));
        assertEq(amount, share, "in full");
        _assertEvidence(alice, DELIVER, 0, 0, address(0), false);
        assertFalse(_entry(id).forfeited, "never stamped");
    }

    /// @dev The stamp over a STAGING claim record: staged while the owner was
    ///      clean, then confirmed and swept. Returns the stamped entry.
    function _stampOverAStagingRecord() internal returns (uint256 id) {
        id = _stagedAndScanned();
        oracle.setFlagged(alice, true);
        _confirm(alice);
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Staging), "fixture: a Staging record at the cursor");
        (uint8 d, uint256 stamped, uint256 settled, , ) = _forfeit(alice);
        assertEq(d, FORFEIT);
        assertEq(stamped, 1, "a Staging record does not block the stamp");
        assertEq(settled, 0, "the day is the record's: the sweep defers");
        assertTrue(_entry(id).forfeited);
        assertFalse(_entry(id).processed);
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Staging), "and the record is not made stale");
    }

    /// @notice T11 - a Staging record outlives the stamp: its reservation then
    ///         prices the stamped entry's day to the treasury (user share 0),
    ///         and its resolution absorbs that leg as `ForfeitedReward` under
    ///         refId 0, delivering nothing.
    function test_sanc_T11_aStagingRecordOutlivesTheStamp_andSettlesAsAForfeit() public {
        uint256 id = _stampOverAStagingRecord();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        RewardStagingDomainFacet.StagingRecordView memory r = _rec();
        assertEq(_userShare(r), 0, "the reservation prices the stamped entry's share to the treasury");
        uint256 treasuryFresh = r.reservedLiveTreasuryFresh + r.epochTreasuryFresh;
        assertGt(treasuryFresh, 0, "fixture LIVE: the day's forfeit leg");
        uint256 bucket0 = _bucket();
        vm.recordLogs();
        _resolveAll(_key());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None), "resolved and closed");
        assertEq(_bucket() - bucket0, treasuryFresh, "absorbed into the bucket");
        (, uint256 nForfeit) = _recycled(logs, uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward), 0);
        assertGt(nForfeit, 0, "as forfeited reward, refId 0");
        assertEq(_recycledCount(logs, uint8(LibVpfiRecycle.RecycleSource.ExpiredReward)), 0);
        assertEq(_count(logs, T_DELIVERED), 0, "nothing delivered");
        assertEq(vpfi.balanceOf(alice), 0);
        assertTrue(_entry(id).processed);
    }

    /// @notice T11c - a RESERVED claim record does not block the stamp, and the
    ///         stamp makes it stale: the first irreversible page, run by anyone,
    ///         announces it stale and unwinds instead of resolving, and the
    ///         reservation it took is released.
    function test_sanc_T11c_aReservedRecordGoesStaleOnTheStamp_andAnyoneUnwindsIt() public {
        uint256 id = _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint8 sideKey = uint8(LibVaipakam.RewardSide.Lender);
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Reserved), "fixture: Reserved");
        assertGt(_mut().loanSideRewardReservedRaw(LOAN, sideKey), 0, "fixture LIVE: the reservation holds the loan side");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(stamped, 1, "a Reserved claim record does not block the stamp");
        address anyone = makeAddr("sanc-anyone");
        vm.recordLogs();
        vm.prank(anyone);
        bool done = _settle().resolveStagedDayPage(_key());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_STALE), 1, "the first irreversible page finds the stamp and refuses to resolve");
        uint256 pages;
        while (!done) {
            assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Unwinding), "stale: unwinding");
            vm.prank(anyone);
            done = _settle().unwindStagedDayPage(_key());
            assertLt(++pages, 16);
        }
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None), "closed");
        assertEq(_mut().loanSideRewardReservedRaw(LOAN, sideKey), 0, "the reservation is released");
        assertEq(vpfi.balanceOf(alice), 0, "nothing paid");
        assertTrue(_entry(id).forfeited);
        assertFalse(_entry(id).processed, "still owed to the bucket, by the sweep");
    }

    /// @notice T11b - an EXPIRY-op record at the cursor blocks the stamp (code
    ///         7) and the expiry completes, announced as expired, never as a
    ///         forfeit. To isolate code 7 from code 3 the entry's removal point
    ///         is lifted raw while the stamp is tried (the brief's S2-R7 shape:
    ///         an Expiry record whose payout has not begun the removal yet),
    ///         then restored before the record resolves.
    /// @dev   Kills M19 (drop the Expiry-op term).
    function test_sanc_T11b_anExpiryOpRecordAtTheCursor_isNotStamped_andTheExpiryCompletes() public {
        _armedDay(1, NEED);
        _armedDay(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        uint256 id = _entryOn(1, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        _cfg().setRewardClaimHorizonDays(180);
        _liveFresh(1e18);
        assertEq(_sweeper().sweepExpiredInteractionRewards(_ids(id)), 0, "stamps only");
        uint256 swept;
        for (uint256 k; k < 60 && swept == 0; ++k) {
            vm.warp(_now() + 7 days);
            swept = _sweeper().sweepExpiredInteractionRewards(_ids(id));
        }
        assertGt(swept, 0, "fixture: day 1 expired");
        _wideDayOn(2, 300);
        assertEq(_sweeper().sweepExpiredInteractionRewards(_ids(id)), 0, "day 2 is wide: staged");
        bytes32 key2 = _dayKey(2);
        RewardStagingDomainFacet.StagingRecordView memory r = RewardStagingDomainFacet(address(diamond)).getStagingRecord(key2);
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Staging), "fixture: a record stands at the cursor day");
        assertEq(r.op, uint8(LibVaipakam.StagingOp.Expiry), "under the expiry's commitment");

        oracle.setFlagged(alice, true);
        _confirm(alice);
        _mut().setRewardEntryExpiryBegunRaw(id, false);
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, FORFEIT, "fixture: the owner is confirmed");
        assertEq(stamped, 0, "an Expiry record at the cursor blocks the stamp");
        assertFalse(_entry(id).forfeited);
        (uint256[] memory listed, ) = _lens().getSanctionsForfeitableRewardEntries(alice, 0, 10);
        assertEq(_compact(listed).length, 0, "the lens agrees");
        _mut().setRewardEntryExpiryBegunRaw(id, true);

        _staging().prepareStagedDay(key2);
        _staging().prepareStagedDay(key2);
        _staging().reserveStagedDay(key2);
        vm.recordLogs();
        _resolveAll(key2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_EXPIRED), 1, "the expiry completes and is announced");
        assertEq(_recycledCount(logs, uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward)), 0, "never as a forfeit");
        assertTrue(_entry(id).processed);
        assertFalse(_entry(id).forfeited);
    }

    // ----------------------------- the staged payout's hold -----------------------------

    /// @notice T12 - a FIRST-flagged claimant's last page holds BEFORE any
    ///         write: it returns false, the record stays Resolving with every
    ///         batch resolved, and the figures only the payout moves (the
    ///         encumbrance count, the pool and live-fresh reservations, the
    ///         armed reservation, the pool's paid-out, the armed commitment, the
    ///         loan side's reservation, the staged earmark, the record's holds
    ///         and the Resolving / Unclassified / Recycled rows net of the
    ///         page's own batch hold) read exactly as before the page, and
    ///         every later held page moves none of them at all. The
    ///         record's own pages then carry the chain - held one second short
    ///         of the window, forfeited at it - and the encumbrance ends with the
    ///         record.
    /// @dev   Kills M13 (Hold treated as Deliver - the first last page would
    ///        pay and complete) and M14 (the hold placed after a write - the
    ///        figures would move; placed just after the earmark release, the
    ///        earmark drops on the held page and again on each re-held one;
    ///        just after the hold moves, the record's holds and the Resolving
    ///        row empty). The hold page is necessarily the page that resolves
    ///        the last batch, so its rows are compared NET of that batch's own
    ///        Unclassified -> Resolving hold; the earmark is compared whole,
    ///        because this scene consumes every staged epoch (the round-14
    ///        cell of {RewardStagingTest} on the same fixture) and so no batch
    ///        returns anything out of it.
    function test_sanc_T12_aFirstFlagHoldsTheLastPage_beforeAnyWrite_thenForfeitsAtTheWindow() public {
        uint256 id = _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        assertGt(_userShare(_rec()), 0, "fixture LIVE: a user share stands");
        oracle.setFlagged(alice, true);
        PaySnap memory before = _pageUntilHold();
        PaySnap memory held = _paySnap();
        assertEq(held.encumbered, before.encumbered, "hold: the encumbrance count");
        assertEq(held.poolReserved, before.poolReserved, "hold: the pool reservation");
        assertEq(held.liveReserved, before.liveReserved, "hold: the live-fresh reservation");
        assertEq(held.armedReserved, before.armedReserved, "hold: the armed reservation");
        assertEq(held.paidOut, before.paidOut, "hold: the pool's paid-out");
        assertEq(held.commitFresh, before.commitFresh, "hold: the armed commitment");
        assertEq(held.sideReserved, before.sideReserved, "hold: the loan side's reservation");
        assertGt(before.stagedEarmark, 0, "fixture LIVE: consumed epochs are earmarked");
        assertGt(before.heldEpoch, 0, "fixture LIVE: an earlier page put epochs on hold");
        assertEq(held.stagedEarmark, before.stagedEarmark, "hold: the staged earmark");
        assertGe(held.heldEpoch, before.heldEpoch, "hold: the record keeps its epoch hold");
        assertEq(held.heldRecycled, before.heldRecycled, "hold: the record keeps its recycled hold");
        uint256 batchHold = held.heldEpoch - before.heldEpoch;
        assertEq(held.resolvingRow, before.resolvingRow + batchHold, "hold: the Resolving row, net of the batch hold");
        assertEq(held.unclassifiedRow + batchHold, before.unclassifiedRow, "hold: the Unclassified row, net of the batch hold");
        assertEq(held.recycledRow, before.recycledRow, "hold: the Recycled row");
        RewardStagingDomainFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Resolving), "held, not closed");
        assertEq(r.resolveCursor, r.batchCount, "every batch resolved: only the payout waits");
        uint256 t0 = _now();
        _assertEvidence(alice, HOLD, t0, t0, address(oracle), true);
        assertEq(vpfi.balanceOf(alice), 0);

        uint256 t = t0;
        while (t + G < t0 + W) {
            t += G;
            vm.warp(t);
            PaySnap memory p0 = _paySnap();
            assertFalse(_settle().resolveStagedDayPage(_key()), "held inside the window");
            _assertSamePaySnap(p0, _paySnap(), "a re-held page writes nothing the payout owns");
        }
        vm.warp(t0 + W - 1);
        assertFalse(_settle().resolveStagedDayPage(_key()), "held one second short of the window");
        vm.warp(t0 + W);
        vm.recordLogs();
        assertTrue(_settle().resolveStagedDayPage(_key()), "the page at the window forfeits");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 1, "the share is forfeited");
        assertEq(_count(logs, T_DELIVERED), 0);
        assertEq(_mut().stagingEncumberedCountRaw(), before.encumbered - 1, "the encumbrance ends with the record");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
        assertFalse(_entry(id).forfeited, "a staged share forfeits at the record; the entry is not stamped");
    }

    /// @notice T12c - a delisting during the window delivers the held page:
    ///         the Clean read heals, the share is delivered in full, nothing is
    ///         forfeited, and the entry is never stamped.
    function test_sanc_T12c_aDelistingDuringTheWindow_deliversTheHeldPage() public {
        uint256 id = _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 share = _userShare(_rec());
        assertGt(share, 0, "fixture LIVE: a user share stands");
        oracle.setFlagged(alice, true);
        _pageUntilHold();
        vm.warp(_now() + G);
        oracle.setFlagged(alice, false);
        vm.recordLogs();
        assertTrue(_settle().resolveStagedDayPage(_key()), "a Clean read lets the page complete");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 0, "nothing forfeited");
        assertEq(_count(logs, T_DELIVERED), 1, "the share is delivered");
        (uint256 amount, ) = abi.decode(_nth(logs, T_DELIVERED, 0).data, (uint256, uint8));
        assertEq(amount, share, "in full");
        _assertEvidence(alice, DELIVER, 0, 0, address(0), false);
        assertFalse(_entry(id).forfeited);
    }

    /// @notice T12b - a Claim record whose user share is ZERO never holds, even
    ///         for a marked owner during an outage (the screen runs only for a
    ///         user share): the stamped entry's record resolves to completion.
    ///         Straddle: the same owner IS barred right then.
    /// @dev   Kills M20 (screen unconditionally): the page would hold on row 4
    ///        for as long as the outage lasts and the bounded loop would fail.
    function test_sanc_T12b_aZeroUserShareNeverHolds_evenForAMarkedOwnerDuringAnOutage() public {
        uint256 id = _stampOverAStagingRecord();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        assertEq(_userShare(_rec()), 0, "fixture: a Claim record with no user share");
        oracle.setRevertOnRead(true);
        assertTrue(_profile().isRecipientBarred(alice), "fixture: the marked owner is barred during the outage");
        _resolveAll(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None), "resolved: no hold without a user share");
        assertTrue(_entry(id).processed);
    }

    /// @notice T20 - a DOMAIN claimant: the irrevocable domain's first payout
    ///         holds on a first flag with nothing moved; the domain's own pages
    ///         carry the chain; at the window the owner sweep is confirmed but
    ///         stamps nothing (the domain is Resolving at the cursor - the
    ///         domain half of T10's code 8, with code 6 on the held record); and
    ///         the domain then forfeits every day's share into the bucket and
    ///         clears, delivering nothing.
    /// @dev   Kills M12 for domains (the entry would be stamped) and, with T12,
    ///        M13 (the first page would pay).
    function test_sanc_T20_aDomainClaimantHoldsThenForfeits_andTheResolvingDomainBlocksTheStamp() public {
        uint256 id = _longScene(DAYS);
        _liveFresh(20e18);
        _claim();
        _claim();
        _reserveAllDomain();
        assertEq(_domPhase(), uint8(LibVaipakam.DomainPhase.Resolving), "fixture LIVE: an irrevocable domain");
        oracle.setFlagged(alice, true);
        uint256 bucket0 = _bucket();
        uint256 t0 = _now();
        assertFalse(_domain().resolveDomainPage(_dk()), "a first flag holds the domain's first payout");
        _assertEvidence(alice, HOLD, t0, t0, address(oracle), true);
        assertEq(_bucket(), bucket0, "nothing moved");
        assertEq(_domPhase(), uint8(LibVaipakam.DomainPhase.Resolving));
        uint256 t = t0;
        while (t + G < t0 + W) {
            t += G;
            vm.warp(t);
            assertFalse(_domain().resolveDomainPage(_dk()), "held inside the window");
        }
        vm.warp(t0 + W);
        (uint8 d, uint256 stamped, , , ) = _forfeit(alice);
        assertEq(d, FORFEIT, "confirmed at the window");
        assertEq(stamped, 0, "a Resolving domain's entry is not stamped");
        assertFalse(_entry(id).forfeited);
        vm.recordLogs();
        _resolveAllDomain();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), DAYS, "every day's share forfeits");
        assertEq(_count(logs, T_DELIVERED), 0, "nothing delivered");
        assertEq(_bucket() - bucket0, uint256(DAYS) * NEED, "the user's shares absorbed");
        assertEq(_domPhase(), uint8(LibVaipakam.DomainPhase.None), "cleared");
        assertFalse(_entry(id).forfeited);
    }

    // ----------------------------- the headroom floor -----------------------------

    /// @notice T21 - a legacy slice with epoch coverage, settled against a
    ///         pool headroom smaller than the chunk it returns (live clamped to
    ///         the headroom, plus the epoch-funded part): the facade's headroom
    ///         decrement is FLOORED, so the call fails at the settle's own named
    ///         refusal and never as an arithmetic panic. Straddle: with the
    ///         headroom back, the same entry settles whole into the bucket.
    /// @dev   Kills M21 (the unfloored subtraction): the revert would be
    ///        Panic(0x11). Whether the over-headroom chunk lands in the stamping
    ///        call or the next depends on whether the slice's preparation is its
    ///        own step; the cell tries both and reads the first refusal.
    function test_sanc_T21_aChunkPastTheHeadroom_isFlooredNotPanicked() public {
        uint256 id = _legacyScene();
        uint256 total = _legacyTotal();
        assertGt(total, EPOCH, "fixture: a legacy slice wider than its epoch");
        _epochOnDay(EPOCH, 1, 7, keccak256(abi.encode("sanc-legacy-epoch", uint256(1), uint256(7))));
        _liveFresh(total + 1e18);
        oracle.setFlagged(alice, true);
        _confirm(alice);
        uint256 h = EPOCH / 2;
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP - h);
        (bool ok, bytes memory ret) = _tryForfeit(alice);
        if (ok) (ok, ret) = _tryForfeit(alice);
        assertFalse(ok, "a chunk past the headroom is refused");
        assertEq(
            bytes4(ret),
            IVaipakamErrors.InteractionPoolReservedShortfall.selector,
            "by the settle's own refusal, not an arithmetic panic"
        );

        _mut().setInteractionPoolPaidOut(0);
        uint256 bucket0 = _bucket();
        uint256 calls;
        while (!_entry(id).processed) {
            (ok, ) = _tryForfeit(alice);
            assertTrue(ok, "with the headroom back the sweep proceeds");
            assertLt(++calls, 4, "and settles within a few calls");
        }
        assertTrue(_entry(id).forfeited);
        assertEq(_bucket() - bucket0, total, "the whole slice recycled");
    }
}
