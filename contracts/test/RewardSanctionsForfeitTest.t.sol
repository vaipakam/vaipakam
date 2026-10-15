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
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {LibRewardSanctions} from "../src/libraries/LibRewardSanctions.sol";
import {LibKeeperReward} from "../src/libraries/LibKeeperReward.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

/**
 * @title  RewardSanctionsForfeitTest (and its siblings in this file)
 * @notice #1566 sanctions REWARD rule (owner 2026-10-14) - the test oracle:
 *         after a wallet is flagged, NO interaction reward is paid to it until
 *         the flag is revoked. Reward it earned WHILE flagged is FORFEITED into
 *         the recycle bucket (never delivered); reward it earned BEFORE the
 *         flag is SET APART for it and paid once the flag is revoked.
 *
 *         "While flagged" is a CONFIRMED chain's WINDOW: a chain of
 *         authoritative Flagged observations, under one oracle, with no gap
 *         over `MAX_OBS_GAP_SECS` (G), spanning `CONFIRM_SECS` (W). Its window
 *         is the reward days from the day of its first observation through the
 *         day of its last; when the chain ends (a Clean read clears it, or a
 *         new chain restarts over it) the window is RECORDED, so a day settled
 *         later still forfeits. An unconfirmed chain forfeits nothing.
 *
 *         Five contracts, because no one fixture can host every cell honestly:
 *           - {RewardSanctionsClassifierTest}: the classifier, the window
 *             predicate and the keeper screen against a bare harness (no
 *             Diamond) - the table itself, fuzzed row for row against
 *             `LibVaipakam.isRecipientBarred`, and the window boundary.
 *           - {RewardSanctionsForfeitTest}: an unconfigured single-chain
 *             Diamond, custody inactive, legacy (pre-arming) entries - the
 *             settlement entry, the chain rule, the windows, the legacy
 *             per-day window, the whole-window slice split, the release and
 *             the backing room.
 *           - {RewardSanctionsForfeitStagedTest}: a mirror with reward custody
 *             ACTIVE and armed days - the armed window straddle, the staged
 *             payout (hold, set apart, forfeit), the held-apart venue, the
 *             spanning slice split, the custody rows, the expiry headroom floor.
 *           - {RewardSanctionsHeldActivationTest}: the same mirror with custody
 *             NOT yet active - the activation ceremony must back the held row.
 *
 *         Every cell first asserts its fixture is LIVE (the value it guards is
 *         really there), then straddles its threshold where one exists (W - 1
 *         against W, the day before the window against its first day, its last
 *         day against the next), and asserts STORED state and emitted events
 *         rather than return values alone. Each cell's natspec names the
 *         mutation it kills and, where relevant, the one it does not.
 *
 *         EXECUTED against the src of the 2026-10-14 rule (each arm one src
 *         edit, the named cell failing, the file restored byte-identical):
 *         `_walkSideDays`' `sanctionedDay` write and `_priceEntriesForDay`'s
 *         `|| dry.sanctionedDay` (S1), `_pay`'s `dayForfeited` branch (S6), the
 *         Clear branch's `_recordWindow` (S2, L2), `chainWindow`'s `<` as `<=`
 *         (T0c, W1, S1), `_claimFor`'s release (S2, L2, S3, B1),
 *         `freshBackingRoom`'s held term (B1, A1), the activation's
 *         `SanctionsHeld` row check (A1), `_requireSelectableVenue` (V1) and
 *         `_processEntry`'s slice split (P1). Every other mutation note is
 *         reasoned from the code path, not run.
 */

/// @dev Calls the permissionless flag refresh and the owner settlement in ONE
///      transaction - the "refresh then settle" attack shape (T3, T3b): a
///      marker written one call earlier must never count as a confirmation.
contract SanctionsRefreshThenSettle {
    function run(address target, address who) external returns (uint8 d, uint256 heldApart) {
        ProfileFacet(target).refreshSanctionsFlag(who);
        (d, heldApart, , ) = RewardClaimFacet(target).settleSanctionedInteractionRewards(who);
    }
}

/// @dev A bare host for the classifier, the window predicate and the keeper
///      screen: the libraries' internal functions run against THIS contract's
///      own Diamond-layout storage, so every input of the table (oracle, oracle
///      reads, marker, evidence, recovery-ban source, launch) is set directly
///      and every write is read back directly - no facet, no Diamond, nothing
///      between the test and the rule. It also answers the window predicate's
///      self-staticcall (`rewardSanctionsDayForfeited`), as the Diamond's
///      evidence host does, so the library's fast path and its host loop run
///      here unchanged.
contract RewardSanctionsHarness {
    function setOracle(address o) external {
        LibVaipakam.storageSlot().sanctionsOracle = o;
    }

    function setLaunch(uint256 ts) external {
        LibVaipakam.storageSlot().interactionLaunchTimestamp = ts;
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

    /// @dev How many windows `who` has RECORDED (ended confirmed chains).
    function windowCount(address who) external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardSanctionsWindows[who].length;
    }

    function recordedWindow(address who, uint256 i) external view returns (uint256 fromDay, uint256 toDay) {
        return LibRewardSanctions.unpackWindow(LibVaipakam.storageSlot().rewardSanctionsWindows[who][i]);
    }

    /// @dev The window the STORED chain defines, if it is confirmed.
    function storedChainWindow(address who) external view returns (bool ok, uint256 fromDay, uint256 toDay) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (, uint64 f, uint64 l) = LibRewardSanctions.unpackEvidence(s.rewardSanctionsEvidence[who]);
        return LibRewardSanctions.chainWindow(s, f, l);
    }

    /// @dev THE predicate, as every settlement path reads it (fast path, then
    ///      the self-staticcall below).
    function dayForfeited(address who, uint256 d) external view returns (bool) {
        return LibRewardSanctions.dayForfeited(LibVaipakam.storageSlot(), who, d);
    }

    /// @dev The window loop's host - the harness twin of
    ///      `RewardHorizonSweepFacet.rewardSanctionsDayForfeited`.
    function rewardSanctionsDayForfeited(address who, uint256 d) external view returns (bool) {
        return LibRewardSanctions.dayForfeitedFull(LibVaipakam.storageSlot(), who, d);
    }

    function setKeeperRewardEnabled(bool v) external {
        LibVaipakam.storageSlot().cfgKeeperRewardEnabled = v;
    }

    function payKeeper(address k, bytes32 kind, uint256 gasUsed) external returns (uint256) {
        return LibKeeperReward.payVpfiReward(k, kind, gasUsed);
    }
}

/// @title RewardSanctionsClassifierTest
/// @notice T0 and T24 - the classifier's table, the window predicate and the
///         keeper screen, on the bare harness.
contract RewardSanctionsClassifierTest is Test {
    RewardSanctionsHarness internal h;
    MockSanctionsList internal m;

    address internal constant WHO = address(0xA11CE);
    address internal constant TWIN = address(0xB0B);
    address internal constant SRC = address(0x5AC5);
    address internal constant OTHER_ORACLE = address(0x0BAD);
    address internal constant KEEPER = address(0xBEEF);
    bytes32 internal constant KIND = keccak256("sanc-test-kind");
    uint256 internal constant BASE = 400 days;
    /// @dev The harness's interaction launch: every evidence instant the fuzz
    ///      draws falls after it, so window days are real day indices.
    uint256 internal constant LAUNCH = BASE - 30 days;

    uint8 internal constant DELIVER = 0;
    uint8 internal constant HOLD = 1;
    uint8 internal constant CONFIRMED = 2;
    uint256 internal constant W = LibRewardSanctions.CONFIRM_SECS;
    uint256 internal constant G = LibRewardSanctions.MAX_OBS_GAP_SECS;

    /// @dev Mirror of the library signal, for `vm.expectEmit`.
    event KeeperRewardSkipped(address indexed keeper, bytes32 indexed actionKind, string reason);

    function setUp() public {
        h = new RewardSanctionsHarness();
        m = new MockSanctionsList();
        vm.warp(BASE);
        h.setLaunch(LAUNCH);
    }

    function _dayOf(uint256 t) internal pure returns (uint256) {
        return t < LAUNCH ? 0 : (t - LAUNCH) / 1 days;
    }

    /// @notice T0a - the decision codes the settlement and the lens return, the
    ///         two constants the chain rule needs (a non-zero gap strictly below
    ///         the window, or no chain could ever form (G = 0) or every gap
    ///         would be fatal (G >= W)), and the two codecs round-tripping.
    function test_sanc_T0a_decisionCodesConstantsAndCodecs() public view {
        assertEq(uint8(LibRewardSanctions.Decision.Deliver), DELIVER, "Deliver is 0");
        assertEq(uint8(LibRewardSanctions.Decision.Hold), HOLD, "Hold is 1");
        assertEq(uint8(LibRewardSanctions.Decision.Confirmed), CONFIRMED, "Confirmed is 2 (the old Forfeit's value)");
        assertGt(G, 0, "a gap bound of zero would make every chain break");
        assertLt(G, W, "the gap bound sits strictly inside the window");
        (address o, uint64 f, uint64 l) = LibRewardSanctions.unpackEvidence(
            LibRewardSanctions.packEvidence(address(m), uint64(BASE - 5), uint64(BASE))
        );
        assertEq(o, address(m), "evidence pack/unpack round-trips the oracle");
        assertEq(uint256(f), BASE - 5, "and the flag's start");
        assertEq(uint256(l), BASE, "and the last sighting");
        (uint256 a, uint256 b) = LibRewardSanctions.unpackWindow(LibRewardSanctions.packWindow(17, 23));
        assertEq(a, 17, "window pack/unpack round-trips the first day");
        assertEq(b, 23, "and the last");
    }

    /// @notice T0 - THE TABLE, row for row. For every combination of oracle
    ///         set or unset, owner zero or not, flagged or clean, outage or not,
    ///         marker or none, evidence absent / under this oracle / under
    ///         another / with no start, any age and any gap, with or without a
    ///         flagged recovery-ban source: (1) Deliver holds exactly when the
    ///         existing barred screen says not barred - the classifier only
    ///         SPLITS barred into Hold and Confirmed, it never moves the barred
    ///         line; (2) `observe` decides exactly as the `decide` view did on
    ///         the same state; (3) the writes are exactly the table's: none on
    ///         rows 1, 3 and 4; marker and evidence cleared on a Clean read (row
    ///         2); a Flagged read commits the marker, evidences the current
    ///         oracle and extends the chain to now, restarting the window when
    ///         the chain is broken (row 5) and keeping its start otherwise (rows
    ///         6-7), with Confirmed only once the window has elapsed; and (4) a
    ///         WINDOW is recorded exactly when a chain ENDS confirmed - a Clean
    ///         read over it (row 2) or a restart over it (row 5) - covering the
    ///         stored chain's first through last observation day, and never
    ///         otherwise (an unconfirmed chain, or a chain that continues).
    /// @dev   Kills: M1 (confirm on the first read - row 5 would read
    ///        Confirmed), M5 (marker alone confirms - row 5 with a marker),
    ///        M6 (Unavailable + marker confirms - rows 3-4), M8 (no clear on
    ///        Clean - row 2's writes), M9 (no oracle match - shape 2), M17 (no
    ///        marker restart - row 5 with `marker == false` and an intact
    ///        chain), M18 (no gap restart - any gap above G), and either
    ///        `_recordWindow` call dropped (a confirmed chain cleared or
    ///        restarted over would record nothing). Does NOT kill the
    ///        confirmation test's `<` turned `<=`: a fuzzed chain spanning
    ///        EXACTLY W is a measure-zero draw - T0c straddles that boundary.
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

    /// @dev The state a row is read against, captured before the observation.
    struct PreRow {
        address eo;
        uint64 ef;
        uint64 el;
        uint256 word;
        bool marker;
        uint256 nWin;
    }

    function _checkRow(address who, bool oracleSet) internal {
        PreRow memory p;
        (p.eo, p.ef, p.el) = h.evidence(who);
        p.word = h.evidenceWord(who);
        p.marker = h.marker(who);
        p.nWin = h.windowCount(who);
        uint8 st = h.status(who);
        uint8 d = h.decide(who);
        assertEq(d == DELIVER, !h.barred(who), "Deliver exactly when the barred screen says not barred");
        assertEq(h.observe(who), d, "observe decides exactly as the view did");
        _checkWindow(who, p, _checkWrites(who, oracleSet, st, d, p));
    }

    /// @dev The row's writes; returns whether THIS observation ends the stored
    ///      chain while it is confirmed (a property of the evidence alone,
    ///      liveness not required) - the one case a window is recorded.
    function _checkWrites(address who, bool oracleSet, uint8 st, uint8 d, PreRow memory p)
        internal
        view
        returns (bool recorded)
    {
        bool storedConfirmed = p.ef != 0 && uint256(p.el) >= uint256(p.ef) + W;
        if (!oracleSet || who == address(0)) {
            assertEq(d, DELIVER, "row 1: no regime or no owner delivers");
            _assertUnchanged(who, p.word, p.marker);
        } else if (st == uint8(LibVaipakam.SanctionsRead.Clean)) {
            assertEq(d, DELIVER, "row 2: a Clean read delivers");
            assertFalse(h.marker(who), "row 2 heals the marker");
            assertEq(h.evidenceWord(who), 0, "row 2 deletes the evidence");
            recorded = p.word != 0 && storedConfirmed;
        } else if (st == uint8(LibVaipakam.SanctionsRead.Unavailable)) {
            assertEq(d, p.marker ? HOLD : DELIVER, "rows 3-4: an outage holds a marked owner, delivers an unmarked one");
            _assertUnchanged(who, p.word, p.marker);
        } else {
            bool intact = p.marker && p.eo == address(m) && p.ef != 0 && BASE - uint256(p.el) <= G;
            (address eo, uint64 ef, uint64 el) = h.evidence(who);
            assertTrue(h.marker(who), "rows 5-7 commit the marker");
            assertEq(eo, address(m), "rows 5-7 evidence the current oracle");
            assertEq(uint256(el), BASE, "rows 5-7 extend the chain to now");
            if (!intact) {
                assertEq(d, HOLD, "row 5: a broken chain holds");
                assertEq(uint256(ef), BASE, "row 5 restarts the window now");
                recorded = storedConfirmed;
            } else {
                assertEq(uint256(ef), uint256(p.ef), "rows 6-7 keep the window's start");
                assertEq(d, BASE - uint256(p.ef) >= W ? CONFIRMED : HOLD, "rows 6-7: confirmed once the window has elapsed");
            }
        }
    }

    function _checkWindow(address who, PreRow memory p, bool recorded) internal view {
        assertEq(h.windowCount(who), p.nWin + (recorded ? 1 : 0), "a window is recorded exactly when a confirmed chain ends");
        if (recorded) {
            (uint256 a, uint256 b) = h.recordedWindow(who, p.nWin);
            assertEq(a, _dayOf(p.ef), "the window opens on the chain's first observation day");
            assertEq(b, _dayOf(p.el), "and closes on its last");
        }
    }

    function _assertUnchanged(address who, uint256 word0, bool marker0) internal view {
        assertEq(h.evidenceWord(who), word0, "no evidence write");
        assertEq(h.marker(who), marker0, "no marker write");
    }

    /// @notice T0c - THE WINDOW BOUNDARY. A chain whose last observation is
    ///         exactly W after its first is confirmed; one second short of W it
    ///         is not. Straddled on two owners with otherwise identical chains:
    ///         the confirmed one forfeits every day from its first observation's
    ///         through its last's - and not the day before nor the day after -
    ///         and keeps doing so after a Clean read ends it (the window is
    ///         recorded); the unconfirmed one forfeits nothing and records
    ///         nothing when it ends.
    /// @dev   Mutation: `chainWindow`'s `<` turned `<=` -> the exactly-W chain
    ///        reads unconfirmed: no day forfeits and its Clean read records no
    ///        window. Also kills a predicate that drops either end of the
    ///        window (`>` / `<` for `>=` / `<=` in `dayForfeitedFull`).
    function test_sanc_T0c_aChainConfirmsAtExactlyW_andItsWindowRunsFromItsFirstDayThroughItsLast() public {
        h.setOracle(address(m));
        // First observation 6 hours into day 20; the confirming one exactly W
        // later, 6 hours into day 23.
        uint64 f = uint64(LAUNCH + 20 days + 6 hours);
        h.setMarker(WHO, true);
        h.setMarker(TWIN, true);
        h.setEvidence(TWIN, address(m), f, f + uint64(W) - 1);
        h.setEvidence(WHO, address(m), f, f + uint64(W));
        (bool okTwin, , ) = h.storedChainWindow(TWIN);
        assertFalse(okTwin, "W - 1: unconfirmed");
        assertFalse(h.dayForfeited(TWIN, 20), "and none of its days forfeits");
        assertFalse(h.dayForfeited(TWIN, 22), "not even inside its span");
        (bool ok, uint256 a, uint256 b) = h.storedChainWindow(WHO);
        assertTrue(ok, "exactly W: confirmed");
        assertEq(a, 20, "the window opens on the first observation's day");
        assertEq(b, 23, "and closes on the confirming observation's day");
        assertFalse(h.dayForfeited(WHO, 19), "the day before the window is not forfeited");
        assertTrue(h.dayForfeited(WHO, 20), "its first day is");
        assertTrue(h.dayForfeited(WHO, 23), "its last day is");
        assertFalse(h.dayForfeited(WHO, 24), "the day after is not");

        // Both chains END with a Clean read: only the confirmed one is recorded,
        // and its days stay forfeited with no evidence left.
        m.setFlagged(WHO, false);
        m.setFlagged(TWIN, false);
        assertEq(h.observe(WHO), DELIVER, "a Clean read delivers");
        assertEq(h.observe(TWIN), DELIVER);
        assertEq(h.evidenceWord(WHO), 0, "fixture: the evidence is gone");
        assertEq(h.windowCount(WHO), 1, "the confirmed chain's window is recorded");
        (a, b) = h.recordedWindow(WHO, 0);
        assertEq(a, 20, "recorded: its first day");
        assertEq(b, 23, "recorded: its last day");
        assertTrue(h.dayForfeited(WHO, 20), "a recorded window still forfeits its first day");
        assertTrue(h.dayForfeited(WHO, 23), "and its last");
        assertFalse(h.dayForfeited(WHO, 24), "and nothing after");
        assertEq(h.windowCount(TWIN), 0, "the unconfirmed chain records nothing");
        assertFalse(h.dayForfeited(TWIN, 21), "and forfeits nothing");
    }

    /// @notice T0d - a chain that ENDED before the interaction launch names no
    ///         reward day (Codex #2489 r5): {dayOf} maps every pre-launch instant
    ///         to day 0, so such a chain used to read as the window `[0, 0]` and
    ///         forfeit the real day 0 of a wallet that was clean by then.
    ///         Straddles: a chain that crosses the launch is clamped to BEGIN at
    ///         day 0 and does forfeit it; with no launch set no chain names a day.
    /// @dev   Mutation: drop the launch check in `chainWindow` → the pre-launch
    ///        chain reads `[0, 0]`, day 0 forfeits, and a window is recorded.
    function test_sanc_T0d_aChainWhollyBeforeLaunch_namesNoDay_aStraddlingOneBeginsAtDayZero() public {
        h.setOracle(address(m));
        h.setMarker(WHO, true);
        h.setMarker(TWIN, true);
        // WHO: confirmed (exactly W long), over a week before the launch.
        uint64 f = uint64(LAUNCH - 10 days);
        h.setEvidence(WHO, address(m), f, f + uint64(W));
        // TWIN: first seen 2 days before the launch, last seen 2 days after it
        // (4 days > W: confirmed).
        h.setEvidence(TWIN, address(m), uint64(LAUNCH - 2 days), uint64(LAUNCH + 2 days));
        (bool ok, , ) = h.storedChainWindow(WHO);
        assertFalse(ok, "wholly before the launch: no window, though the chain is confirmed");
        assertFalse(h.dayForfeited(WHO, 0), "and day 0 is not forfeited");
        (bool okTwin, uint256 a, uint256 b) = h.storedChainWindow(TWIN);
        assertTrue(okTwin, "straddling the launch: a window");
        assertEq(a, 0, "clamped to begin at day 0");
        assertEq(b, 2, "through the day of its last observation");
        assertTrue(h.dayForfeited(TWIN, 0), "day 0 forfeits for the straddling chain");
        assertTrue(h.dayForfeited(TWIN, 2), "and its last day");
        assertFalse(h.dayForfeited(TWIN, 3), "not the day after");

        // Both end with a Clean read: only the straddling chain records a window.
        m.setFlagged(WHO, false);
        m.setFlagged(TWIN, false);
        assertEq(h.observe(WHO), DELIVER, "a Clean read delivers");
        assertEq(h.observe(TWIN), DELIVER);
        assertEq(h.windowCount(WHO), 0, "nothing recorded for the pre-launch chain");
        assertFalse(h.dayForfeited(WHO, 0), "and day 0 stays clean with the evidence gone");
        assertEq(h.windowCount(TWIN), 1, "the straddling chain's window is recorded");
        (a, b) = h.recordedWindow(TWIN, 0);
        assertEq(a, 0, "recorded: from day 0");
        assertEq(b, 2, "recorded: through day 2");

        // No launch set: a confirmed chain names no day at all.
        h.setLaunch(0);
        f = uint64(BASE - 10 days);
        h.setEvidence(WHO, address(m), f, f + uint64(W));
        (ok, , ) = h.storedChainWindow(WHO);
        assertFalse(ok, "no launch: no window");
        assertFalse(h.dayForfeited(WHO, 0), "no launch: day 0 is not forfeited");
    }

    /// @notice T0e - recorded windows MERGE when they touch or overlap and stay
    ///         apart across a gap day, and the day lookup is bounded: 64
    ///         recorded windows price a day in a fraction of the linear scan's
    ///         cost (Codex #2489 r5 — the scan grew as windows × claimed days).
    /// @dev   Mutations: no merge in `_recordWindow` → three windows here and
    ///        W3 fails; the linear loop back in `dayForfeitedFull` → the gas
    ///        bound fails (measured 54k with the slots still warm from this
    ///        fixture; a real claim reads them cold, at 2,100 each).
    function test_sanc_T0e_touchingWindowsMerge_gappedOnesDoNot_andTheLookupIsBounded() public {
        h.setOracle(address(m));
        // [10,13] then [14,17] (touching) then [16,19] (overlapping): one window
        // [10,19]; then [21,24] across the clean day 20: a second.
        _endChain(WHO, 10, 13);
        _endChain(WHO, 14, 17);
        assertEq(h.windowCount(WHO), 1, "touching windows merge");
        (uint256 a, uint256 b) = h.recordedWindow(WHO, 0);
        assertEq(a, 10, "merged: the first chain's first day");
        assertEq(b, 17, "merged: the second chain's last day");
        _endChain(WHO, 16, 19);
        assertEq(h.windowCount(WHO), 1, "overlapping windows merge");
        (a, b) = h.recordedWindow(WHO, 0);
        assertEq(a, 10, "merged: still from day 10");
        assertEq(b, 19, "merged: extended to day 19");
        _endChain(WHO, 21, 24);
        assertEq(h.windowCount(WHO), 2, "a gap day keeps the next window apart");
        for (uint256 d = 10; d <= 19; ++d) assertTrue(h.dayForfeited(WHO, d), "every merged day forfeits");
        assertFalse(h.dayForfeited(WHO, 20), "the gap day is clean");
        assertTrue(h.dayForfeited(WHO, 21), "the second window's first day");
        assertTrue(h.dayForfeited(WHO, 24), "and its last");
        assertFalse(h.dayForfeited(WHO, 9), "before every window");
        assertFalse(h.dayForfeited(WHO, 25), "after every window");

        // 64 separate windows [10 + 5i, 13 + 5i] for TWIN.
        for (uint256 i; i < 64; ++i) _endChain(TWIN, 10 + 5 * i, 13 + 5 * i);
        assertEq(h.windowCount(TWIN), 64, "fixture: 64 recorded windows");
        uint256 g0 = gasleft();
        bool hit = h.rewardSanctionsDayForfeited(TWIN, 10 + 5 * 63);
        uint256 used = g0 - gasleft();
        assertTrue(hit, "the last window's first day forfeits");
        assertLt(used, 40_000, "bounded: log(64) reads, not 64");
        g0 = gasleft();
        hit = h.rewardSanctionsDayForfeited(TWIN, 14);
        used = g0 - gasleft();
        assertFalse(hit, "the first gap day is clean");
        assertLt(used, 40_000, "a miss is bounded too");
        assertTrue(h.rewardSanctionsDayForfeited(TWIN, 10), "the first window's first day");
        assertTrue(h.rewardSanctionsDayForfeited(TWIN, 13 + 5 * 31), "a middle window's last day");
        assertFalse(h.rewardSanctionsDayForfeited(TWIN, 9), "before every window");
        assertFalse(h.rewardSanctionsDayForfeited(TWIN, 14 + 5 * 63), "after every window");
    }

    /// @dev Ends a confirmed chain for `who` whose window is `[fromDay, toDay]`:
    ///      first seen an hour into `fromDay`, last seen an hour into `toDay`
    ///      (so `toDay - fromDay` days apart, which must reach `W`), then read
    ///      Clean so the window is recorded. Warps past the chain's last day.
    function _endChain(address who, uint256 fromDay, uint256 toDay) internal {
        uint256 f = LAUNCH + fromDay * 1 days + 1 hours;
        uint256 l = LAUNCH + toDay * 1 days + 1 hours;
        require(l >= f + W, "fixture: a chain shorter than W cannot confirm");
        if (block.timestamp < l + 1 days) vm.warp(l + 1 days);
        h.setMarker(who, true);
        h.setEvidence(who, address(m), uint64(f), uint64(l));
        m.setFlagged(who, false);
        assertEq(h.observe(who), DELIVER, "fixture: the Clean read ends the chain");
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
/// @notice The shared vocabulary of the Diamond fixtures: the oracle, the
///         observation cadence, the settlement and lens accessors, and log
///         readers that assert on STORED events rather than on return values.
abstract contract RewardSanctionsTestBase is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    MockSanctionsList internal oracle;
    address internal alice;
    address internal bob;
    address internal carol;
    address internal keeper;

    uint8 internal constant DELIVER = 0;
    uint8 internal constant HOLD = 1;
    uint8 internal constant CONFIRMED = 2;
    /// @dev `RewardDelivery.SanctionsHeld` - pinned against the enum in V1.
    uint8 internal constant VENUE_HELD = 3;
    uint8 internal constant LENDER = 0;
    uint256 internal constant W = LibRewardSanctions.CONFIRM_SECS;
    uint256 internal constant G = LibRewardSanctions.MAX_OBS_GAP_SECS;

    bytes32 internal constant T_RECORDED = keccak256("RewardSanctionsEvidenceRecorded(address,address,uint64,uint64)");
    bytes32 internal constant T_CLEARED = keccak256("RewardSanctionsEvidenceCleared(address)");
    bytes32 internal constant T_WINDOW = keccak256("RewardSanctionsWindowRecorded(address,uint256,uint256)");
    bytes32 internal constant T_HELD_APART = keccak256("RewardSanctionsHeldApart(address,uint256,uint256)");
    bytes32 internal constant T_HELD_RELEASED = keccak256("RewardSanctionsHeldReleased(address,uint256)");
    bytes32 internal constant T_CLAIMED = keccak256("InteractionRewardsClaimed(address,uint256,uint256,uint256)");
    bytes32 internal constant T_SETTLED = keccak256("RewardEntryForfeitSettled(uint256,address,uint256,uint256,uint256)");
    bytes32 internal constant T_RECYCLED = keccak256("VpfiRecycled(uint8,uint256,uint256,uint256)");
    bytes32 internal constant T_EXPIRED = keccak256("RewardEntryExpired(uint256,address,uint256,uint256)");
    bytes32 internal constant T_CLAIMANT_FORFEITED = keccak256("StagingClaimantForfeited(bytes32,address,uint256,uint256)");
    bytes32 internal constant T_DELIVERED = keccak256("StagingDelivered(bytes32,address,uint256,uint8)");

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

    /// @dev The reward day of `t` (the classifier's `dayOf`).
    function _dayOf(uint256 t) internal view returns (uint256) {
        uint256 launch = _lens().getInteractionLaunchTimestamp();
        return launch == 0 || t < launch ? 0 : (t - launch) / 1 days;
    }

    /// @dev The instant reward day `d` begins.
    function _dayStart(uint256 d) internal view returns (uint256) {
        return _lens().getInteractionLaunchTimestamp() + d * 1 days;
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

    /// @dev The capped cumulative (`cumMin`) the legacy pricing steps, lender
    ///      side, at day `d`.
    function _minRpn(uint256 d) internal view returns (uint256 m) {
        (, , m, , ) = _mut().getCumStateRaw(LENDER, d);
    }

    // ----------------------------- the rule's surface -----------------------------

    /// @dev One permissionless observation, by a stranger.
    function _observe(address who) internal returns (uint8) {
        vm.prank(keeper);
        return _sweeper().recordRewardSanctionsEvidence(who);
    }

    /// @dev The owner settlement, by a stranger (it is permissionless).
    function _settleOwner(address who) internal returns (uint8 d, uint256 heldApart) {
        vm.prank(keeper);
        (d, heldApart, , ) = RewardClaimFacet(address(diamond)).settleSanctionedInteractionRewards(who);
    }

    /// @dev The settlement through a low-level call, for the cells that read a
    ///      revert.
    function _trySettle(address who) internal returns (bool ok, bytes memory ret) {
        vm.prank(keeper);
        (ok, ret) = address(diamond).call(
            abi.encodeWithSelector(RewardClaimFacet.settleSanctionedInteractionRewards.selector, who)
        );
    }

    /// @dev `user`'s own claim, to the wallet, so the venue is never in doubt.
    function _claimTo(address user, LibVaipakam.RewardDelivery venue) internal returns (uint256 paid) {
        vm.prank(user);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(venue);
    }

    function _claimWallet(address user) internal returns (uint256 paid) {
        return _claimTo(user, LibVaipakam.RewardDelivery.Wallet);
    }

    function _held(address who) internal view returns (uint256 held) {
        (held, ) = _lens().getSanctionsHeldReward(who);
    }

    function _heldTotal() internal view returns (uint256 total) {
        (, total) = _lens().getSanctionsHeldReward(address(0));
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
    ///      earliest confirmation one window after the flag's start, and the
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
            assertEq(uint256(sfa), uint256(sf) + W, "status: confirmable one window after the flag");
            assertEq(uint256(sob), uint256(sl) + G, "status: the chain breaks one gap after the last sighting");
        }
    }

    /// @dev The lens's window list for `who`: exactly one window, `[a, b]`.
    function _assertOneWindow(address who, uint256 a, uint256 b) internal view {
        (uint256[] memory fromDays, uint256[] memory toDays) = _lens().getRewardSanctionsWindows(who);
        assertEq(fromDays.length, 1, "lens: one window");
        assertEq(toDays.length, 1, "lens: one window (both arrays)");
        assertEq(fromDays[0], a, "lens: the window's first day");
        assertEq(toDays[0], b, "lens: the window's last day");
    }

    function _assertNoWindow(address who) internal view {
        (uint256[] memory fromDays, ) = _lens().getRewardSanctionsWindows(who);
        assertEq(fromDays.length, 0, "lens: no window");
    }

    /// @dev The cadence from no evidence: a first observation now, one every G
    ///      while that stays inside the window, and the one AT the window's end,
    ///      which must confirm. Returns the flag's start. The confirming
    ///      observation lands EXACTLY W after the first, so a chain built here
    ///      sits on the confirmation boundary (T0c's straddle, in vivo).
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
        assertEq(_observe(who), CONFIRMED, "cadence: confirmed at the window's end");
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

    /// @dev The forfeited reward credited to the bucket by a claim or a
    ///      settlement (`ForfeitedReward`, refId 0).
    function _forfeitedCredit(Vm.Log[] memory logs) internal view returns (uint256 total) {
        (total, ) = _recycled(logs, uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward), 0);
    }

    function _assertWindowLog(Vm.Log[] memory logs, address who, uint256 fromDay, uint256 toDay) internal view {
        assertEq(_count(logs, T_WINDOW), 1, "one window recorded");
        Vm.Log memory l = _nth(logs, T_WINDOW, 0);
        assertEq(l.topics[1], _addrTopic(who), "window: the wallet");
        (uint256 a, uint256 b) = abi.decode(l.data, (uint256, uint256));
        assertEq(a, fromDay, "window: its first day");
        assertEq(b, toDay, "window: its last day");
    }

    function _assertHeldApartLog(Vm.Log[] memory logs, address who, uint256 amount, uint256 balance) internal view {
        assertEq(_count(logs, T_HELD_APART), 1, "one set-apart announced");
        Vm.Log memory l = _nth(logs, T_HELD_APART, 0);
        assertEq(l.topics[1], _addrTopic(who), "set apart: the wallet");
        (uint256 a, uint256 b) = abi.decode(l.data, (uint256, uint256));
        assertEq(a, amount, "set apart: the amount");
        assertEq(b, balance, "set apart: the wallet's held balance after it");
    }

    function _assertReleasedLog(Vm.Log[] memory logs, address who, uint256 amount) internal view {
        assertEq(_count(logs, T_HELD_RELEASED), 1, "one release announced");
        Vm.Log memory l = _nth(logs, T_HELD_RELEASED, 0);
        assertEq(l.topics[1], _addrTopic(who), "released: the wallet");
        assertEq(abi.decode(l.data, (uint256)), amount, "released: the whole held balance");
    }

    /// @dev Exactly one `InteractionRewardsClaimed` for `who`, of `amount`.
    function _assertClaimedLog(Vm.Log[] memory logs, address who, uint256 amount) internal view {
        assertEq(_count(logs, T_CLAIMED), 1, "one claim announced");
        Vm.Log memory l = _nth(logs, T_CLAIMED, 0);
        assertEq(l.topics[1], _addrTopic(who), "claimed: the wallet");
        (, , uint256 amt) = abi.decode(l.data, (uint256, uint256, uint256));
        assertEq(amt, amount, "claimed: the amount");
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
}

/// @title RewardSanctionsForfeitTest
/// @notice The unconfigured single-chain fixture: legacy (pre-arming) entries,
///         a 100M VPFI Diamond, reward custody NOT active, the oracle configured
///         and nobody flagged. Launch at setUp; the clock starts on day 6, so a
///         flag first observed in setUp's instant is on day F = 6 and the
///         {_confirm} cadence's confirming observation on day L = 9. A legacy
///         one-day entry on day `d` is worth exactly the capped curve's step at
///         `d` ({_value}), so every figure below is read off the curve.
contract RewardSanctionsForfeitTest is RewardSanctionsTestBase {
    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;
    uint64 internal constant LOAN_A = 42;
    uint64 internal constant LOAN_B = 43;
    uint64 internal constant LOAN_D = 91; // a Defaulted loan, its lender entry never closed
    uint64 internal constant LOAN_O = 92; // an open (Active) loan
    uint64 internal constant LOAN_V = 93; // a terminal loan carrying loan value
    uint64 internal constant LOAN_S = 94; // the loan sweep's loan
    uint64 internal constant LOAN_PRE = 51; // day F - 1
    uint64 internal constant LOAN_F = 52; // day F
    uint64 internal constant LOAN_L = 53; // day L
    uint64 internal constant LOAN_POST = 54; // day L + 1
    /// @dev The window {_confirm} builds from setUp's instant: its first
    ///      observation's day and its confirming observation's day.
    uint256 internal constant F = 6;
    uint256 internal constant L = 9;
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
        _finalize(1, 4);
        oracle = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
    }

    // ----------------------------- fixtures -----------------------------

    /// @dev Days `from..to` finalized: the global denominator known (1e18 a
    ///      side, so a 1e18 entry takes the whole day) and no §4 cap.
    function _finalize(uint256 from, uint256 to) internal {
        for (uint256 d = from; d <= to; ++d) {
            _mut().setKnownGlobalDailyInterest(d, 1e18, 1e18, true);
            _mut().setDayCapThreshold18(d, type(uint256).max);
        }
    }

    /// @dev A closed, claimable lender entry over day 1.
    function _seed(address user, uint64 loanId) internal returns (uint256 id) {
        id = _seedOn(user, loanId, 1);
    }

    /// @dev A closed, claimable one-day lender entry of 1e18 on `day`.
    function _seedOn(address user, uint64 loanId, uint256 day) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(user, loanId, LibVaipakam.RewardSide.Lender, 1e18, uint32(day));
        _mut().closeRewardEntryRaw(id, uint32(day + 1));
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

    /// @dev What a one-day 1e18 entry on (finalized) day `d` is worth: the
    ///      capped curve's step there. Advances the curve through `d` first -
    ///      the same idempotent write every claim makes before it prices.
    function _value(uint256 d) internal returns (uint256) {
        _mut().advanceCumThroughRaw(LENDER, d);
        return _minRpn(d) - _minRpn(d - 1);
    }

    /// @dev What a claim by `user` would pay right now (the claim itself, in a
    ///      reverting frame) - the LIVE check of every cell.
    function _livePreview(address user) internal returns (uint256 amount) {
        (amount, , ) = previewByExecution(user);
    }

    // ----------------------------- the trigger -----------------------------

    /// @notice T1 - a FIRST flag holds: the settlement observes, commits the
    ///         marker and the evidence, announces when the owner becomes
    ///         confirmable, RETURNS (no revert, so the observation stands), and
    ///         settles nothing. A second call in the same block extends the
    ///         chain rather than restarting it.
    /// @dev   Kills M1 (confirm on the first read): the decision would read
    ///        Confirmed and the entry would be settled and set apart; and a
    ///        Hold that reverts instead of returning (no evidence would stand).
    ///        The second call kills a classifier that restarts on every
    ///        Flagged read.
    function test_sanc_T1_aFirstFlagHolds_theSettlementReturnsAndCommitsTheEvidence_andMovesNothing() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE: a clean owner's entry pays");
        oracle.setFlagged(alice, true);
        assertFalse(_profile().isSanctionsConfirmedFlagged(alice), "fixture: no marker before any observation");
        uint256 bucket0 = _bucket();
        uint256 paid0 = _paidOut();
        uint256 t0 = _now();
        vm.recordLogs();
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(d, HOLD, "a first flag holds");
        assertEq(heldApart, 0, "nothing set apart");
        assertEq(_count(logs, T_RECORDED), 1, "the evidence is announced once");
        Vm.Log memory l = _nth(logs, T_RECORDED, 0);
        assertEq(l.topics[1], _addrTopic(alice), "recorded: the owner");
        assertEq(l.topics[2], _addrTopic(address(oracle)), "recorded: under the configured oracle");
        (uint64 flaggedAt, uint64 forfeitableAt) = abi.decode(l.data, (uint64, uint64));
        assertEq(uint256(flaggedAt), t0, "recorded: flagged now");
        assertEq(uint256(forfeitableAt), t0 + W, "recorded: confirmable one window later at the earliest");
        assertTrue(_profile().isSanctionsConfirmedFlagged(alice), "the authoritative Flagged read commits the marker");
        _assertEvidence(alice, HOLD, t0, t0, address(oracle), true);
        assertEq(_count(logs, T_HELD_APART) + _count(logs, T_CLAIMED) + _count(logs, T_WINDOW), 0, "nothing else announced");
        assertFalse(_entry(id).processed, "the entry is not settled");
        assertEq(_held(alice), 0, "no held balance");
        assertEq(_bucket(), bucket0, "the bucket is untouched");
        assertEq(_paidOut(), paid0, "the pool is untouched");

        vm.recordLogs();
        (d, heldApart) = _settleOwner(alice);
        logs = vm.getRecordedLogs();
        assertEq(d, HOLD, "still held in the same block");
        assertEq(heldApart, 0);
        assertEq(_count(logs, T_RECORDED), 0, "an intact chain is extended, not restarted");
        assertEq(uint256(_flaggedAt(alice)), t0, "the window's start stands");
    }

    /// @notice T3 - a marker written one call earlier, in the same transaction,
    ///         is not a confirmation: refresh-then-settle with no prior evidence
    ///         holds.
    /// @dev   Kills M5 (confirm on the marker alone).
    function test_sanc_T3_refreshThenSettleInOneTransaction_holds() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        SanctionsRefreshThenSettle helper = new SanctionsRefreshThenSettle();
        (uint8 d, uint256 heldApart) = helper.run(address(diamond), alice);
        assertEq(d, HOLD, "a fresh marker is not a confirmation");
        assertEq(heldApart, 0, "nothing set apart");
        assertTrue(_profile().isSanctionsConfirmedFlagged(alice), "fixture: the refresh did write the marker");
        assertFalse(_entry(id).processed);
        assertEq(uint256(_flaggedAt(alice)), _now(), "the window starts at this observation");
    }

    /// @notice T3b - stale evidence plus a refresh in the settlement's own
    ///         transaction: evidence at t0, a delisting healed by a Clean
    ///         refresh, then - more than a window later - a relisting refreshed
    ///         and settled in one transaction. Holds.
    /// @dev   Kills M18 (no gap restart): the old evidence plus the fresh marker
    ///        would otherwise confirm at once. Does NOT isolate M17 - the
    ///        refresh restores the marker before the settlement reads it, so the
    ///        gap rule alone carries this cell; T3d isolates M17.
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
        SanctionsRefreshThenSettle helper = new SanctionsRefreshThenSettle();
        (uint8 d, uint256 heldApart) = helper.run(address(diamond), alice);
        assertEq(d, HOLD, "stale evidence never confirms");
        assertEq(heldApart, 0);
        assertFalse(_entry(id).processed);
        assertEq(uint256(_flaggedAt(alice)), t0 + W + 1, "the window restarts at this observation");
    }

    /// @notice T3c - a gap longer than G breaks the chain. Boundary straddle: a
    ///         gap of exactly G keeps the window's start, one second more
    ///         restarts it. Then the stale-evidence case: one observation, an
    ///         unobserved delisting (no mutating read, so the marker stands), a
    ///         relisting more than a window later - the settlement holds.
    /// @dev   Kills M18 (no gap restart): alice's chain would read intact and
    ///        older than W, and settle; carol's flag start would stay t0.
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
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, HOLD, "an unobserved stretch breaks the chain");
        assertEq(heldApart, 0);
        assertFalse(_entry(id).processed);
        assertEq(uint256(_flaggedAt(alice)), t0 + W + 1, "the window restarts at this observation");
    }

    /// @notice T3d - a Clean heal ANYWHERE (here the permissionless refresh)
    ///         restarts the window even though the chain of Flagged sightings
    ///         was never broken by a gap. Straddle: bob's identical chain, never
    ///         healed, confirms at the same instant, and his settlement sets his
    ///         pre-flag entry apart.
    /// @dev   Kills M17 (no marker restart): alice would be settled with bob.
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
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, HOLD, "a healed marker restarts the window");
        assertEq(heldApart, 0);
        assertFalse(_entry(idA).processed);
        assertEq(uint256(_flaggedAt(alice)), t0 + W);
        (d, heldApart) = _settleOwner(bob);
        assertEq(d, CONFIRMED, "the twin chain, never healed, confirms at the same instant");
        assertGt(heldApart, 0, "and its pre-flag entry is set apart");
        assertTrue(_entry(idB).processed);
        assertEq(_held(bob), heldApart, "into bob's held balance");
    }

    /// @notice T4 - an outage. A marked owner with a COMPLETE chain holds, with
    ///         no evidence write and no revert; an unmarked owner is delivered;
    ///         the marked owner's claim is refused while the unmarked owner's
    ///         goes through. Straddle: one second earlier, with the oracle up,
    ///         the same chain read Confirmed.
    /// @dev   Kills M6 (Unavailable + marker confirms) and M7 (the claim gate
    ///        back to the fail-open `_assertNotSanctioned`: the marked claim
    ///        would pay).
    function test_sanc_T4_anOutageHoldsTheMarked_deliversTheUnmarked_andBarsTheMarkedClaim() public {
        uint256 idA = _seed(alice, LOAN_A);
        uint256 idB = _seed(bob, LOAN_B);
        assertGt(_livePreview(alice), 0, "fixture LIVE: alice");
        assertGt(_livePreview(bob), 0, "fixture LIVE: bob");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        assertEq(_decision(alice), CONFIRMED, "fixture: the chain is complete");
        uint64 f0 = _flaggedAt(alice);
        uint64 l0 = _lastSeen(alice);

        oracle.setRevertOnRead(true);
        vm.warp(_now() + 1);
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, HOLD, "an outage never settles, even a complete chain");
        assertEq(heldApart, 0);
        assertFalse(_entry(idA).processed);
        assertEq(_flaggedAt(alice), f0, "no evidence write on an unavailable read");
        assertEq(_lastSeen(alice), l0, "the gap grows instead");
        assertTrue(_profile().isSanctionsConfirmedFlagged(alice), "the marker stands");

        (d, heldApart) = _settleOwner(bob);
        assertEq(d, DELIVER, "an unmarked owner is delivered during an outage");
        assertEq(heldApart, 0);
        assertFalse(_entry(idB).processed);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, alice));
        RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);
        assertGt(_claimWallet(bob), 0, "the unmarked owner still claims during the outage");
    }

    /// @notice T5 - a Clean read heals: it delivers, deletes the evidence,
    ///         clears the marker and announces the clear - and, the chain being
    ///         confirmed, RECORDS its window first; a re-flag then starts a
    ///         fresh window and holds.
    /// @dev   Kills M8 (skip the clear): the re-flag would find the old chain
    ///        intact and confirm, and the lens would still show evidence. Kills
    ///        dropping the Clear branch's `_recordWindow`: no window event, an
    ///        empty lens list.
    function test_sanc_T5_aCleanReadHealsTheEvidence_recordsTheWindow_andAReflagStartsOver() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        assertEq(_decision(alice), CONFIRMED, "fixture: confirmed");
        oracle.setFlagged(alice, false);
        vm.recordLogs();
        assertEq(_observe(alice), DELIVER, "a Clean read delivers");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLEARED), 1, "the clear is announced");
        assertEq(_nth(logs, T_CLEARED, 0).topics[1], _addrTopic(alice));
        _assertWindowLog(logs, alice, F, L);
        _assertOneWindow(alice, F, L);
        _assertEvidence(alice, DELIVER, 0, 0, address(0), false);

        oracle.setFlagged(alice, true);
        uint256 t1 = _now();
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, HOLD, "a re-flag starts the window over");
        assertEq(heldApart, 0);
        assertFalse(_entry(id).processed);
        _assertEvidence(alice, HOLD, t1, t1, address(oracle), true);
        _assertOneWindow(alice, F, L);
    }

    /// @notice T6 - evidence is keyed to the oracle that produced it: a complete
    ///         chain under oracle A is not evidence under oracle B, even when B
    ///         flags the owner too. Straddle: under A the same instant reads
    ///         Confirmed. The chain B restarts over was confirmed, so ITS window
    ///         is recorded by the restart: re-pointing the oracle never erases
    ///         the days a confirmed flag already covered.
    /// @dev   Kills M9 (no oracle match), and dropping the Restart branch's
    ///        `_recordWindow` (no window event, an empty lens list).
    function test_sanc_T6_anOracleChangeRestartsTheWindow_andKeepsTheConfirmedWindow() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        assertEq(_decision(alice), CONFIRMED, "fixture: confirmed under A");
        MockSanctionsList b = new MockSanctionsList();
        b.setFlagged(alice, true);
        _profile().setSanctionsOracle(address(b));
        vm.recordLogs();
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(d, HOLD, "evidence under A is not evidence under B");
        assertEq(heldApart, 0);
        assertFalse(_entry(id).processed);
        _assertEvidence(alice, HOLD, _now(), _now(), address(b), true);
        _assertWindowLog(logs, alice, F, L);
        _assertOneWindow(alice, F, L);
    }

    /// @notice T6b - an oracle unset for longer than G, then set back to the
    ///         same oracle, restarts the window: an unset oracle delivers and
    ///         writes nothing, so the gap grows. Straddle on one timeline: bob,
    ///         read back exactly G after his last sighting, still confirms;
    ///         alice, read one second later, restarts - and her confirmed chain's
    ///         window is recorded by that restart.
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
        assertEq(_observe(alice), CONFIRMED, "fixture: alice confirmed");
        assertEq(_observe(bob), CONFIRMED, "fixture: bob confirmed");
        uint256 t1 = t0 + W;
        _profile().setSanctionsOracle(address(0));
        assertEq(_observe(alice), DELIVER, "no oracle: delivered, nothing written");
        vm.warp(t1 + G);
        _profile().setSanctionsOracle(address(oracle));
        assertEq(_observe(bob), CONFIRMED, "back after exactly G: the chain holds");
        vm.warp(t1 + G + 1);
        assertEq(_observe(alice), HOLD, "back after more than G: the window restarts");
        assertEq(uint256(_flaggedAt(alice)), t1 + G + 1);
        assertFalse(_entry(idA).processed);
        _assertOneWindow(alice, F, L);
        (uint256[] memory bobFrom, ) = _lens().getRewardSanctionsWindows(bob);
        assertEq(bobFrom.length, 1, "bob's live confirmed chain reads as its window");
    }

    // ----------------------------- the windows -----------------------------

    /// @notice W1 - THE CONFIRMATION BOUNDARY, in vivo. Two owners, one entry
    ///         each on day F, identical chains except the last sighting: alice's
    ///         one second short of W, bob's exactly at W. Both are delisted. The
    ///         unconfirmed chain ends with no window and forfeits nothing - her
    ///         claim pays her day F in full; the confirmed one records its window
    ///         and his claim forfeits his day F into the bucket.
    /// @dev   Mutation: `chainWindow`'s `<` turned `<=` -> bob's chain (last
    ///        sighting exactly W after the first) reads unconfirmed, records
    ///        no window, and his claim pays his day F. Also kills a window
    ///        recorded for an UNconfirmed chain (alice's claim would forfeit).
    function test_sanc_W1_anUnconfirmedFlagForfeitsNothing_aConfirmedOneForfeitsItsWindow() public {
        uint256 idA = _seedOn(alice, LOAN_A, F);
        uint256 idB = _seedOn(bob, LOAN_B, F);
        oracle.setFlagged(alice, true);
        oracle.setFlagged(bob, true);
        uint256 t0 = _now();
        _observe(alice);
        _observe(bob);
        for (uint256 k = 1; k * G < W; ++k) {
            vm.warp(t0 + k * G);
            _observe(alice);
            _observe(bob);
        }
        vm.warp(t0 + W - 1);
        assertEq(_observe(alice), HOLD, "alice's last sighting: one second short of W");
        vm.warp(t0 + W);
        assertEq(_observe(bob), CONFIRMED, "bob's: exactly W");
        vm.warp(t0 + W + 1);
        oracle.setFlagged(alice, false);
        oracle.setFlagged(bob, false);
        vm.recordLogs();
        assertEq(_observe(alice), DELIVER);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLEARED), 1, "fixture: alice's chain is cleared");
        assertEq(_count(logs, T_WINDOW), 0, "an unconfirmed chain records no window");
        _assertNoWindow(alice);
        vm.recordLogs();
        assertEq(_observe(bob), DELIVER);
        _assertWindowLog(vm.getRecordedLogs(), bob, F, L);
        _assertOneWindow(bob, F, L);

        _finalize(5, L);
        vm.warp(_dayStart(L + 1));
        uint256 v = _value(F);
        assertGt(v, 0, "fixture LIVE: day F carries reward");
        assertEq(_claimWallet(alice), v, "alice's day F pays in full: an unconfirmed flag forfeits nothing");
        assertTrue(_entry(idA).processed);
        uint256 bucket0 = _bucket();
        assertEq(_claimWallet(bob), 0, "bob's day F pays nothing");
        assertTrue(_entry(idB).processed, "it is settled all the same");
        assertEq(_bucket() - bucket0, v, "into the bucket, as forfeited reward");
        assertEq(vpfi.balanceOf(bob), 0);
    }

    /// @notice W2 - a chain that LAPSES (no observation for longer than G) is
    ///         restarted by the next Flagged read; a confirmed one keeps its
    ///         window through that restart, an unconfirmed one records nothing.
    ///         Straddle: alice confirmed then lapsed, bob lapsed one observation
    ///         short of confirming, both restarted at the same instant.
    /// @dev   Kills dropping the Restart branch's `_recordWindow` (alice's
    ///        window would vanish with the overwritten word) and a restart that
    ///        records an unconfirmed chain (bob would show a window).
    function test_sanc_W2_aRestartOverALapsedConfirmedChain_recordsItsWindow_anUnconfirmedOneNothing() public {
        oracle.setFlagged(alice, true);
        oracle.setFlagged(bob, true);
        uint256 t0 = _now();
        _observe(alice);
        _observe(bob);
        for (uint256 k = 1; k * G < W; ++k) {
            vm.warp(t0 + k * G);
            _observe(alice);
            _observe(bob);
        }
        vm.warp(t0 + W);
        assertEq(_observe(alice), CONFIRMED, "fixture: alice's chain confirms; bob is not observed again");
        _assertOneWindow(alice, F, L);
        _assertNoWindow(bob);
        uint256 t1 = t0 + W + G + 1;
        vm.warp(t1);
        vm.recordLogs();
        assertEq(_observe(alice), HOLD, "a lapsed chain restarts");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertWindowLog(logs, alice, F, L);
        assertEq(_count(logs, T_RECORDED), 1, "and a new chain starts now");
        _assertEvidence(alice, HOLD, t1, t1, address(oracle), true);
        _assertOneWindow(alice, F, L);
        vm.recordLogs();
        assertEq(_observe(bob), HOLD);
        logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_RECORDED), 1, "bob's chain restarts too");
        assertEq(_count(logs, T_WINDOW), 0, "but records nothing: it never confirmed");
        _assertNoWindow(bob);
    }

    /// @notice W3 - two windows SHARING a boundary day: a Clean read ends the
    ///         first chain on day L and the flag returns the same day, so the
    ///         second chain's window opens on L. The legacy slice's window share
    ///         walks the windows in time order and counts L ONCE: the whole
    ///         ten-day slice [5, 15) splits into the user's days 5, 13 and 14
    ///         and the treasury's days 6 through 12, figures read off the curve.
    /// @dev   Mutation: drop the running first-uncounted day
    ///        (`next = b + 1`, or the `a < next` clamp) in
    ///        `legacyWindowShareFull` -> day L's step counted twice: the user
    ///        is short by it and the bucket over by it.
    /// @dev Codex #2489 r5 — two chains sharing a boundary day are RECORDED as
    ///      one merged window (the same set of days in one slot; each chain's
    ///      end is still announced), and the slice share counts the shared day
    ///      once. Mutation: no merge → two windows recorded.
    function test_sanc_W3_twoWindowsSharingABoundaryDay_countThatDayOnce_inTheSliceShare() public {
        uint256 id = _mut().pushRewardEntry(alice, LOAN_A, LibVaipakam.RewardSide.Lender, 1e18, 5);
        _mut().closeRewardEntryRaw(id, 15);
        oracle.setFlagged(alice, true);
        uint256 t0 = _confirm(alice);
        vm.warp(t0 + W + 1 hours);
        oracle.setFlagged(alice, false);
        assertEq(_observe(alice), DELIVER, "chain one ends on day L");
        vm.warp(t0 + W + 2 hours);
        oracle.setFlagged(alice, true);
        uint256 t1 = _confirm(alice);
        assertEq(_dayOf(t1), L, "fixture: chain two starts on day L");
        vm.warp(t1 + W + 1 hours);
        oracle.setFlagged(alice, false);
        assertEq(_observe(alice), DELIVER, "chain two ends on day L + 3");
        {
            (uint256[] memory a, uint256[] memory b) = _lens().getRewardSanctionsWindows(alice);
            assertEq(a.length, 1, "the two chains merged into one recorded window");
            assertEq(a[0], F, "from day F");
            assertEq(b[0], L + 3, "through day L + 3 - the shared boundary day once");
        }
        _finalize(5, 14);
        vm.warp(_dayStart(16));
        _mut().advanceCumThroughRaw(LENDER, 14);
        uint256 slice = _minRpn(14) - _minRpn(4);
        uint256 share = _minRpn(L + 3) - _minRpn(F - 1);
        assertGt(slice, share, "fixture LIVE: the slice reaches past the windows");
        uint256 bucket0 = _bucket();
        assertEq(_claimWallet(alice), slice - share, "the slice less the windows' days, day L once");
        assertEq(
            slice - share,
            (_minRpn(5) - _minRpn(4)) + (_minRpn(14) - _minRpn(12)),
            "which is exactly days 5, 13 and 14"
        );
        assertEq(_bucket() - bucket0, share, "the windows' share forfeited into the bucket");
        assertTrue(_entry(id).processed);
    }

    // ----------------------------- the settlement -----------------------------

    /// @notice L1 - THE WINDOW STRADDLE on legacy entries, settled while the
    ///         owner is confirmed: one-day entries on day F - 1, F, L and L + 1.
    ///         The settlement settles the finalized days: day F - 1 is SET APART
    ///         (its value into the held balance - lens, event, ledger total) and
    ///         day F is FORFEITED (its value credited to the bucket as forfeited
    ///         reward); nothing reaches the wallet, no `InteractionRewardsClaimed`
    ///         is emitted, both draw on the pool, and the Diamond's balance does
    ///         not move (custody is not active: the held reward rests here). Days
    ///         L and L + 1 are not finalized yet and stay owed.
    /// @dev   Kills the `_processEntryWhole` split dropped (day F would be set
    ///        apart), a settlement that delivers (the wallet would hold value)
    ///        or that announces a claim.
    function test_sanc_L1_theWindowStraddle_theSettlementSetsApartDayFMinus1_andForfeitsDayF() public {
        (uint256[4] memory ids, uint256 vPre, uint256 vF) = _legacyWindowScene();
        uint256 bucket0 = _bucket();
        uint256 paid0 = _paidOut();
        uint256 bal0 = vpfi.balanceOf(address(diamond));
        vm.recordLogs();
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(d, CONFIRMED, "confirmed");
        assertEq(heldApart, vPre, "only day F - 1 is set apart");
        assertEq(_held(alice), vPre, "lens: the held balance");
        assertEq(_heldTotal(), vPre, "lens: the ledger total");
        _assertHeldApartLog(logs, alice, vPre, vPre);
        assertEq(_count(logs, T_CLAIMED), 0, "a settlement is not a claim: no claim event");
        assertEq(_forfeitedCredit(logs), vF, "day F credited as forfeited reward");
        assertEq(_bucket() - bucket0, vF, "into the recycle bucket");
        assertEq(_paidOut() - paid0, vPre + vF, "both leave the pool");
        assertEq(vpfi.balanceOf(alice), 0, "nothing reaches the wallet");
        assertEq(vpfi.balanceOf(address(diamond)), bal0, "and nothing leaves the Diamond");
        assertTrue(_entry(ids[0]).processed && _entry(ids[1]).processed, "days F - 1 and F settled");
        assertFalse(_entry(ids[2]).processed || _entry(ids[3]).processed, "days L and L + 1 still owed");
    }

    /// @notice L2 - REVOCATION: a Clean read on day L + 1 records the window
    ///         [F, L] (event + lens); the wallet's own claim, once L and L + 1
    ///         finalize, pays the held balance AND day L + 1, and forfeits day
    ///         L - a window day that settles only now, after the flag is gone.
    ///         The held balance and the total return to zero, the release is
    ///         announced, and the claim event carries both payouts.
    /// @dev   Mutations: the Clear branch's `_recordWindow` dropped -> day L
    ///        pays; the release line in `_claimFor` dropped -> the held balance
    ///        is not paid and stays held.
    function test_sanc_L2_revocation_recordsTheWindow_andTheClaimReleasesTheHeld_forfeitsDayL_paysDayLPlus1() public {
        (uint256[4] memory ids, uint256 vPre, ) = _legacyWindowScene();
        (, uint256 heldApart) = _settleOwner(alice);
        assertEq(heldApart, vPre, "fixture: day F - 1 set apart");
        vm.warp(_dayStart(L + 1) + 1);
        oracle.setFlagged(alice, false);
        vm.recordLogs();
        assertEq(_observe(alice), DELIVER, "revoked");
        // Read back AFTER the claim: the economic consequence is asserted first.
        Vm.Log[] memory revocation = vm.getRecordedLogs();
        assertEq(_held(alice), vPre, "revocation alone moves nothing");

        _finalize(L, L + 1);
        vm.warp(_dayStart(L + 2));
        uint256 vL = _value(L);
        uint256 vPost = _value(L + 1);
        uint256 bucket0 = _bucket();
        vm.recordLogs();
        uint256 paid = _claimWallet(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(paid, vPre + vPost, "the held balance and day L + 1");
        assertEq(vpfi.balanceOf(alice), vPre + vPost, "delivered to the wallet");
        _assertReleasedLog(logs, alice, vPre);
        _assertClaimedLog(logs, alice, vPre + vPost);
        assertEq(_forfeitedCredit(logs), vL, "day L forfeited although it settles after the revocation");
        assertEq(_bucket() - bucket0, vL);
        assertEq(_held(alice), 0, "the held balance is spent");
        assertEq(_heldTotal(), 0, "and the total with it");
        assertTrue(_entry(ids[2]).processed && _entry(ids[3]).processed);
        _assertWindowLog(revocation, alice, F, L);
        _assertOneWindow(alice, F, L);
    }

    /// @notice R1a (Codex #2489 r1 P1) - a claim that reads CLEAN commits the
    ///         clear. A wallet first flagged (a chain starts, the #1123 marker
    ///         set) and then delisted claims while clean: its claim's gate is an
    ///         OBSERVATION, so the stored chain and the marker go (straddle:
    ///         both stand before the claim). A re-flag minutes later therefore
    ///         starts a NEW chain, and observations every gap up to the instant
    ///         the OLD chain would have confirmed still read Hold - the old
    ///         chain is never continued across the revocation into a window
    ///         that spans it.
    /// @dev   Mutation: the claim gate back to the view check
    ///        (`assertRecipientNotBarred`) -> the claim clears nothing, the
    ///        re-flag's observation continues the chain from the first flag,
    ///        and the observation at that chain's window end confirms.
    function test_sanc_R1a_aClaimThatReadsClean_commitsTheClear_soAReflagStartsANewChain() public {
        _seed(alice, LOAN_A);
        oracle.setFlagged(alice, true);
        uint256 t0 = _now();
        assertEq(_observe(alice), HOLD, "fixture: a first flag holds and starts a chain");
        oracle.setFlagged(alice, false);
        vm.warp(t0 + 1 hours);
        (, , , , , address ev0, bool marker0) = _status(alice);
        assertEq(ev0, address(oracle), "fixture LIVE: the chain's evidence stands before the claim");
        assertTrue(marker0, "fixture LIVE: and so does the marker");

        assertGt(_claimWallet(alice), 0, "the delisted wallet claims");
        (, , , , , address ev1, bool marker1) = _status(alice);
        assertEq(ev1, address(0), "the claim's Clean read deleted the chain");
        assertFalse(marker1, "and cleared the marker");

        oracle.setFlagged(alice, true);
        vm.warp(t0 + 2 hours);
        assertEq(_observe(alice), HOLD, "a re-flag holds");
        uint256 t1 = _now();
        assertEq(uint256(_flaggedAt(alice)), t1, "and starts a NEW chain");
        uint256 t = t1;
        while (t + G < t0 + W) {
            t += G;
            vm.warp(t);
            assertEq(_observe(alice), HOLD, "held inside the new window");
        }
        vm.warp(t0 + W);
        assertEq(_observe(alice), HOLD, "the old chain's window end confirms nothing");
        _assertNoWindow(alice);
    }

    /// @notice R1b (Codex #2489 r1 P1) - the HELD balance is claimable ALONE.
    ///         With the pool exhausted, the ordinary claim of a delisted wallet
    ///         that is also owed new fresh reward reverts - and takes its
    ///         release with it (straddle: the balance is still held after it).
    ///         The release-only entry then pays the held balance by itself,
    ///         settling nothing else. A still-flagged wallet is refused it.
    /// @dev   Kills a release that can only ride the ordinary claim: the held
    ///        balance would be stranded for as long as the new legs revert.
    /// @notice Codex #2489 r4 — a wallet with NOTHING set apart never reaches
    ///         the custody facet's release entry: the ordinary claim makes no
    ///         self-call for a zero held balance. Pinned by cutting the release
    ///         selector out of the Diamond (what a partially refreshed cut looks
    ///         like): bob, who holds nothing, still claims; alice, who holds a
    ///         balance, reverts with the Diamond's unrouted-selector error.
    /// @dev   Kills dropping the zero early-return in `callReleaseSanctionsHeld`
    ///        (bob's claim would revert too).
    function test_sanc_R4a_aWalletWithNothingHeld_NeverReachesTheReleaseEntry() public {
        (, uint256 vPre, ) = _legacyWindowScene();
        (, uint256 heldApart) = _settleOwner(alice);
        assertEq(heldApart, vPre, "fixture: alice holds a set-apart balance");
        vm.warp(_dayStart(L + 1) + 1);
        oracle.setFlagged(alice, false);
        _mut().setDailyLenderInterest(L + 1, bob, 1e18, 1e18);
        _finalize(L, L + 1);
        vm.warp(_dayStart(L + 2));
        assertEq(_held(bob), 0, "fixture: bob holds nothing");

        bytes4[] memory sel = new bytes4[](1);
        sel[0] = RewardCustodyFacet.custodyReleaseSanctionsHeld.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({facetAddress: address(0), action: IDiamondCut.FacetCutAction.Remove, functionSelectors: sel});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        assertGt(_claimWallet(bob), 0, "nothing held: the claim never calls the release entry, and pays");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("FunctionDoesNotExist()"));
        RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);
    }

    function test_sanc_R1b_theHeldBalanceIsClaimableAlone_whenTheClaimsOwnLegsRevert() public {
        (uint256[4] memory ids, uint256 vPre, ) = _legacyWindowScene();
        (, uint256 heldApart) = _settleOwner(alice);
        assertEq(heldApart, vPre, "fixture: day F - 1 set apart");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, alice));
        RewardClaimFacet(address(diamond)).claimHeldInteractionRewards(LibVaipakam.RewardDelivery.Wallet);

        vm.warp(_dayStart(L + 1) + 1);
        oracle.setFlagged(alice, false);
        _finalize(L, L + 1);
        vm.warp(_dayStart(L + 2));
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        vm.prank(alice);
        vm.expectRevert(InteractionPoolExhausted.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);
        assertEq(_held(alice), vPre, "fixture LIVE: the claim's revert took its release with it");

        vm.prank(alice);
        uint256 paid =
            RewardClaimFacet(address(diamond)).claimHeldInteractionRewards(LibVaipakam.RewardDelivery.Wallet);
        assertEq(paid, vPre, "the held balance, alone");
        assertEq(vpfi.balanceOf(alice), vPre, "to the wallet");
        assertEq(_held(alice), 0, "released");
        assertEq(_heldTotal(), 0, "the total with it");
        assertFalse(_entry(ids[3]).processed, "nothing else was settled");
    }

    /// @dev L1/L2's scene: one-day entries of alice on days F - 1, F, L, L + 1
    ///      (each on its own loan), day F - 1 finalized and shown payable to a
    ///      clean owner, then the flag confirmed by {_confirm} (window [F, L])
    ///      and days F..L - 1 finalized. Returns the ids and the two settled
    ///      days' values.
    function _legacyWindowScene() internal returns (uint256[4] memory ids, uint256 vPre, uint256 vF) {
        ids[0] = _seedOn(alice, LOAN_PRE, F - 1);
        ids[1] = _seedOn(alice, LOAN_F, F);
        ids[2] = _seedOn(alice, LOAN_L, L);
        ids[3] = _seedOn(alice, LOAN_POST, L + 1);
        _finalize(F - 1, F - 1);
        vPre = _value(F - 1);
        assertGt(vPre, 0, "fixture: day F - 1 carries reward");
        assertEq(_livePreview(alice), vPre, "fixture LIVE: a clean owner's day F - 1 pays");
        oracle.setFlagged(alice, true);
        uint256 t0 = _confirm(alice);
        assertEq(_dayOf(t0), F, "fixture: the flag is first observed on day F");
        assertEq(_dayOf(_now()), L, "fixture: and confirmed on day L");
        _finalize(F, L - 1);
        vF = _value(F);
    }

    /// @notice D1 - a DELIVER verdict returns without reverting and COMMITS its
    ///         observation: a confirmed owner who has been delisted is settled
    ///         nothing - the Clean read it makes clears the evidence and the
    ///         marker and records the window - and her own claim then pays her
    ///         pre-flag entry.
    /// @dev   Kills a settlement that reverts on Deliver (the clear and the
    ///        window would roll back) or that settles on Deliver (the entry
    ///        would be set apart).
    function test_sanc_D1_aDeliverVerdictReturns_committingTheCleanReadAndTheWindow() public {
        uint256 id = _seed(alice, LOAN_A);
        assertGt(_livePreview(alice), 0, "fixture LIVE");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        oracle.setFlagged(alice, false);
        vm.recordLogs();
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(d, DELIVER, "a delisted owner reads Deliver");
        assertEq(heldApart, 0, "nothing set apart");
        assertEq(_count(logs, T_CLEARED), 1, "the Clean read committed");
        _assertWindowLog(logs, alice, F, L);
        _assertEvidence(alice, DELIVER, 0, 0, address(0), false);
        assertFalse(_profile().isSanctionsConfirmedFlagged(alice), "the marker healed");
        assertFalse(_entry(id).processed, "nothing settled");
        assertGt(_claimWallet(alice), 0, "her own claim pays the pre-flag entry");
    }

    /// @notice L5 - the LEGACY PER-DAY WINDOW (the pre-entry counters). A
    ///         confirmed owner's settlement pays day F - 1 into the held balance
    ///         and FORFEITS day F: its counters clear, nothing is paid for it,
    ///         its share is charged to the pool and credited to the recycle
    ///         bucket as forfeited reward (Codex #2489 r4 — the spec routes
    ///         every reward earned in a confirmed window into the bucket; the
    ///         earlier cell pinned the day as "stays in the pool", which read as
    ///         never emitted). After revocation the claim forfeits day L (a
    ///         window day) the same way and pays day L + 1 with the held
    ///         balance; the static preview skips day L as the claim does.
    /// @dev   Kills dropping `dayForfeited` from `claimForUserWindow` (day F
    ///        would be set apart, day L paid), from `previewForUserWindow` (the
    ///        static preview would count day L), and clearing a window day
    ///        WITHOUT pricing it (no pool charge, no bucket credit).
    function test_sanc_L5_theLegacyPerDayWindow_clearsAWindowDay_andPaysTheDaysAround() public {
        _mut().setDailyLenderInterest(F - 1, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(F, alice, 1e18, 1e18);
        uint256 pPre = _lens().getInteractionHalfPoolForDay(F - 1);
        assertGt(pPre, 0, "fixture: day F - 1 carries reward");
        uint256 pF = _lens().getInteractionHalfPoolForDay(F);
        assertGt(pF, 0, "fixture: day F carries reward too");
        assertEq(_livePreview(alice), pPre, "fixture LIVE: the per-day window pays a clean owner's day F - 1");
        oracle.setFlagged(alice, true);
        uint256 t0 = _confirm(alice);
        _finalize(F + 1, L - 1);
        uint256 paid0 = _paidOut();
        uint256 bucket0 = _bucket();
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, CONFIRMED);
        assertEq(heldApart, pPre, "day F - 1 set apart; day F pays nothing");
        (uint256 cF, , , ) = _lens().getInteractionDayEntry(F, alice);
        assertEq(cF, 0, "day F's counter is cleared");
        assertEq(_paidOut() - paid0, pPre + pF, "day F's share is charged to the pool with day F - 1's");
        assertEq(_bucket() - bucket0, pF, "and credited to the bucket as forfeited reward");

        vm.warp(t0 + 4 days + 1);
        oracle.setFlagged(alice, false);
        assertEq(_observe(alice), DELIVER, "revoked");
        _mut().setDailyLenderInterest(L, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(L + 1, alice, 1e18, 1e18);
        vm.warp(_dayStart(L + 2));
        uint256 pPost = _lens().getInteractionHalfPoolForDay(L + 1);
        uint256 pL = _lens().getInteractionHalfPoolForDay(L);
        (uint256 previewed, , ) = _lens().previewInteractionRewards(alice);
        assertEq(previewed, pPost, "the static preview skips day L");
        uint256 bucket1 = _bucket();
        assertEq(_claimWallet(alice), pPre + pPost, "the held balance and day L + 1");
        (uint256 cL, , , ) = _lens().getInteractionDayEntry(L, alice);
        assertEq(cL, 0, "day L's counter is cleared, unpaid");
        assertEq(_bucket() - bucket1, pL, "day L forfeits to the bucket on the owner's own claim after revocation");
        assertEq(_held(alice), 0);
    }

    /// @notice B1 - custody NOT active: the set-apart reward rests at the
    ///         Diamond, so the fresh BACKING ROOM nets it out - the settlement
    ///         lowers the room by exactly the held amount while the un-earmarked
    ///         balance does not move. A claim that ONLY releases the held balance
    ///         succeeds (announced as a claim) and leaves the room where it was:
    ///         the tokens and their earmark leave together. The release is not
    ///         charged to the pool again.
    /// @dev   Mutation: drop `+ s.rewardSanctionsHeldTotal` from
    ///        `freshBackingRoom` -> the room does not fall at the settlement.
    ///        Also kills the release-only claim reverting as an empty claim.
    function test_sanc_B1_theHeldRewardIsNettedFromTheBackingRoom_andAReleaseOnlyClaimSucceeds() public {
        uint256 id = _seedOn(alice, LOAN_PRE, F - 1);
        _finalize(F - 1, F - 1);
        uint256 v = _value(F - 1);
        assertEq(_livePreview(alice), v, "fixture LIVE");
        oracle.setFlagged(alice, true);
        uint256 t0 = _confirm(alice);
        uint256 room0 = _mut().freshBackingRoomRaw();
        (, , uint256 unear0, , , , , ) = _lens().getRecycleBackingSnapshot();
        (, uint256 heldApart) = _settleOwner(alice);
        assertEq(heldApart, v, "fixture: set apart");
        assertTrue(_entry(id).processed);
        (, , uint256 unear1, , , , , ) = _lens().getRecycleBackingSnapshot();
        assertEq(unear1, unear0, "the held tokens never left the Diamond");
        assertEq(_mut().freshBackingRoomRaw(), room0 - v, "the room nets the held total out");

        vm.warp(t0 + 4 days + 1);
        oracle.setFlagged(alice, false);
        assertEq(_observe(alice), DELIVER);
        uint256 room1 = _mut().freshBackingRoomRaw();
        uint256 paid0 = _paidOut();
        vm.recordLogs();
        uint256 paid = _claimWallet(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(paid, v, "a claim that only releases pays the held balance");
        _assertClaimedLog(logs, alice, v);
        _assertReleasedLog(logs, alice, v);
        assertEq(vpfi.balanceOf(alice), v);
        assertEq(_heldTotal(), 0);
        assertEq(_paidOut(), paid0, "not charged to the pool a second time");
        assertEq(_mut().freshBackingRoomRaw(), room1, "tokens and earmark leave together: the room is unchanged");
    }

    /// @notice T17 - a second settlement with nothing left reverts as a claim
    ///         does (`NoInteractionRewardsToClaim`), and takes its observation
    ///         with it: the evidence, the held balance, the bucket and the pool
    ///         read exactly as before it.
    function test_sanc_T17_aSettlementWithNothingToDo_revertsAndCommitsNothing() public {
        _seed(alice, LOAN_A);
        oracle.setFlagged(alice, true);
        _confirm(alice);
        // Every day up to the settlement's last finalized one known, so the
        // first settlement's legacy window walks them all and the second has
        // NOTHING left (not a day still waiting on its global, which the claim
        // names by `InteractionDayGlobalNotFinalized` instead).
        _finalize(5, L - 1);
        (, uint256 heldApart) = _settleOwner(alice);
        assertGt(heldApart, 0, "fixture LIVE: the first settlement set the entry apart");
        uint64 last0 = _lastSeen(alice);
        uint256 held1 = _heldTotal();
        uint256 bucket1 = _bucket();
        uint256 paid1 = _paidOut();
        vm.warp(_now() + 1 hours);
        (bool ok, bytes memory ret) = _trySettle(alice);
        assertFalse(ok, "nothing to settle");
        assertEq(bytes4(ret), NoInteractionRewardsToClaim.selector, "the claim's own refusal");
        assertEq(_lastSeen(alice), last0, "the reverted settlement's observation is not committed");
        assertEq(_heldTotal(), held1);
        assertEq(_bucket(), bucket1);
        assertEq(_paidOut(), paid1);
    }

    // ----------------------------- the settlement's reach -----------------------------

    /// @notice T8 - a terminal-but-unclosed entry (the loan Defaulted, the
    ///         lender's entry never closed, claimable by the terminal fallback)
    ///         is reached by the settlement: earned before the flag, it is set
    ///         apart.
    /// @dev   Kills a settlement gated on `closed` rather than claimability.
    function test_sanc_T8_aTerminalButUnclosedEntry_isSetApart() public {
        _setLoanStatus(LOAN_D, LibVaipakam.LoanStatus.Defaulted);
        uint256 id = _seedOpen(alice, LOAN_D);
        assertFalse(_entry(id).closed, "fixture: never closed");
        assertGt(_livePreview(alice), 0, "fixture LIVE: the terminal fallback makes it claimable");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, CONFIRMED);
        assertGt(heldApart, 0, "a claimable entry is settled whether or not it was closed");
        assertTrue(_entry(id).processed);
        assertEq(_held(alice), heldApart);
    }

    /// @notice T8b - an open loan's entry is not the settlement's while the loan
    ///         is Active (nothing to settle: the claim's own refusal); the SAME
    ///         entry is set apart once its loan is terminal. That is the
    ///         straddle.
    function test_sanc_T8b_anOpenLoansEntry_isNotSettled_untilItsLoanEnds() public {
        uint256 id = _seedOpen(alice, LOAN_O);
        oracle.setFlagged(alice, true);
        _confirm(alice);
        assertEq(_decision(alice), CONFIRMED, "fixture: the owner is confirmed");
        (bool ok, bytes memory ret) = _trySettle(alice);
        assertFalse(ok, "an open loan's entry is not claimable: nothing to settle");
        assertEq(bytes4(ret), NoInteractionRewardsToClaim.selector);
        assertFalse(_entry(id).processed);
        _setLoanStatus(LOAN_O, LibVaipakam.LoanStatus.Repaid);
        (, uint256 heldApart) = _settleOwner(alice);
        assertGt(heldApart, 0, "once the loan ends the same entry is set apart");
        assertTrue(_entry(id).processed);
    }

    /// @notice T9 - an entry past its removal point belongs to the expiry
    ///         route: the settlement passes it over while its twin is set apart,
    ///         and the expiry sweep finishes it as EXPIRED reward even though the
    ///         owner is barred (the seam does not fire past the removal point).
    /// @dev   Kills a claim body that pays past the removal point (X would be
    ///        set apart and the expiry walk would then skip it).
    function test_sanc_T9_anEntryPastItsRemovalPoint_isLeftToTheExpiryRoute() public {
        uint256 idX = _seed(alice, LOAN_A);
        uint256 idY = _seed(alice, LOAN_B);
        _mut().setRewardEntryExpiryBegunRaw(idX, true);
        assertTrue(_mut().getRewardEntryExpiryBegunRaw(idX), "fixture: X is past its removal point");
        uint256 vY = _value(1);
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, CONFIRMED);
        assertEq(heldApart, vY, "only the twin without a removal point is set apart");
        assertTrue(_entry(idY).processed);
        assertFalse(_entry(idX).processed, "X is left alone");

        assertEq(_sweeper().sweepExpiredInteractionRewards(_ids(idX)), 0, "the first touch starts X's clock");
        vm.warp(_now() + 1 days);
        vm.recordLogs();
        uint256 expired = _sweeper().sweepExpiredInteractionRewards(_ids(idX));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(expired, 0, "the removed entry settles");
        (uint256 asExpired, ) = _recycled(logs, uint8(LibVpfiRecycle.RecycleSource.ExpiredReward), 0);
        assertEq(asExpired, expired, "as expired reward");
        assertEq(_recycledCount(logs, uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward)), 0, "never as a forfeit");
        assertEq(_count(logs, T_EXPIRED), 1, "its expiry is announced");
        assertTrue(_entry(idX).processed);
        assertEq(_held(alice), vY, "the held balance is untouched by the expiry");
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

    /// @notice T14 - reward already delivered stays where it is: the settlement
    ///         reaches only the undelivered entry, and the vault's VPFI, the
    ///         wallet's VPFI and the vault's tracked balance are unchanged.
    function test_sanc_T14_rewardAlreadyDelivered_staysFrozen_untouchedByTheSettlement() public {
        uint256 idA = _seed(alice, LOAN_A);
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(alice);
        uint256 paid = _claimTo(alice, LibVaipakam.RewardDelivery.Vault);
        assertGt(paid, 0, "fixture LIVE: the clean claim delivered");
        assertTrue(_entry(idA).processed);
        uint256 vaultBal = vpfi.balanceOf(vault);
        uint256 walletBal = vpfi.balanceOf(alice);
        uint256 tracked = VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(alice, address(vpfi));
        assertEq(vaultBal + walletBal, paid, "fixture: the reward was delivered");

        uint256 idB = _seed(alice, LOAN_B);
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (, uint256 heldApart) = _settleOwner(alice);
        assertGt(heldApart, 0, "the undelivered entry is set apart");
        assertTrue(_entry(idB).processed);
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
    ///         owner's reward entry on that loan is settled.
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
        (, uint256 heldApart) = _settleOwner(alice);
        assertGt(heldApart, 0, "the reward entry on the loan is settled");
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

    // ----------------------------- the loan sweep -----------------------------

    /// @notice T19 - the per-loan forfeit sweep (which REMAINS for loan
    ///         forfeits) settles through the evented wrapper and announces each
    ///         chunk it settles (entry, owner, loan and the fresh it moved), and
    ///         announces nothing when nothing moves.
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

    /// @notice T23 - a recovery-banned owner (the declared source flagged, the
    ///         owner's own address clean) follows the same rows: held one second
    ///         short of the window, confirmed at it (O-3 default), and her
    ///         pre-flag entry set apart.
    function test_sanc_T23_aRecoveryBannedOwner_isConfirmedAfterTheCadence() public {
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
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, HOLD, "one second short of the window");
        assertEq(heldApart, 0);
        vm.warp(t0 + W);
        (d, heldApart) = _settleOwner(alice);
        assertEq(d, CONFIRMED, "confirmed at the window");
        assertGt(heldApart, 0, "the pre-flag entry is set apart");
        assertTrue(_entry(id).processed);
    }
}

/// @title RewardSanctionsMirrorBase
/// @notice The mirror fixture both armed suites share: launch, then the clock
///         at day 60; a mirror role (Arbitrum reporting to Base); live fresh
///         delivered through the typed ingress; wide days staged by the
///         transport machinery. Whether reward custody is ACTIVE is the
///         subclass's choice.
abstract contract RewardSanctionsMirrorBase is RewardSanctionsTestBase {
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    /// @dev The armed day's per-user cap in the staging scenes.
    uint256 internal constant NEED = 0.4e18;
    /// @dev 65 epochs of this each list a day: one window (64) and one past it.
    uint256 internal constant TINY = 0.005e18;
    uint256 internal constant WIDE = 65;
    /// @dev A domain's extent: more than one 30-day chunk.
    uint32 internal constant DAYS = 40;
    /// @dev The legacy slice's epoch coverage (T21).
    uint256 internal constant EPOCH = 0.1e18;
    /// @dev The window {_confirm} builds from setUp's instant (launch + 60
    ///      days): its first observation's day and its confirming one's.
    uint256 internal constant SF = 60;
    uint256 internal constant SL = 63;
    uint64 internal constant LOAN_PRE = 159; // day SF - 1
    uint64 internal constant LOAN_F = 160; // day SF
    uint64 internal constant LOAN_L = 163; // day SL
    uint64 internal constant LOAN_POST = 164; // day SL + 1
    uint256 internal liveNonce;

    function _setUpMirror(bool activate) internal {
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
        if (activate) activateRewardCustodyForTest(address(vpfi), 0);
        alice = makeAddr("sanc-staged-alice");
        bob = makeAddr("sanc-staged-bob");
        keeper = makeAddr("sanc-staged-keeper");
        oracle = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
    }

    // ----------------------------- accessors -----------------------------

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

    function _custody() internal view returns (RewardCustodyFacet) {
        return RewardCustodyFacet(address(diamond));
    }

    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) {
        return _custody().rewardCustodyRow(r);
    }

    function _heldRow() internal view returns (uint256) {
        return _row(LibVaipakam.RewardCustodyRow.SanctionsHeld);
    }

    // ----------------------------- fixtures -----------------------------

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

    function _legacyDay(uint256 d) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
    }

    function _loanSideOpenFor(uint64 loanId, uint32 openDays) internal {
        _mut().setFeeEntitlementRaw(
            loanId,
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

    function _loanSideOpen(uint32 openDays) internal {
        _loanSideOpenFor(LOAN, openDays);
    }

    function _entryOn(uint32 startDay, uint32 endDay) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, startDay);
        _mut().closeRewardEntryRaw(id, endDay);
    }

    /// @dev A one-day 1e18 entry of alice on `day`, on its OWN loan: the
    ///      loan side's paid figure then says, per day, whether the day was the
    ///      owner's (a user share charges its loan side) or forfeited (a
    ///      forfeit charges none).
    function _oneDayOn(uint64 loanId, uint256 day) internal returns (uint256 id) {
        _loanSideOpenFor(loanId, 1);
        id = _mut().pushRewardEntry(alice, loanId, LibVaipakam.RewardSide.Lender, 1e18, uint32(day));
        _mut().closeRewardEntryRaw(id, uint32(day + 1));
    }

    function _sidePaid(uint64 loanId) internal view returns (uint256) {
        return _mut().loanSideRewardPaidRaw(loanId, LENDER);
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

    function _recAt(bytes32 key) internal view returns (RewardStagingDomainFacet.StagingRecordView memory) {
        return RewardStagingDomainFacet(address(diamond)).getStagingRecord(key);
    }

    function _rec() internal view returns (RewardStagingDomainFacet.StagingRecordView memory) {
        return _recAt(_key());
    }

    function _userShare(RewardStagingDomainFacet.StagingRecordView memory r) internal pure returns (uint256) {
        return r.reservedLiveUserFresh + r.epochUserFresh + r.reservedLiveUserRecycled + r.epochUserRecycled;
    }

    /// @dev The scene, the wide day, and the clean claim that stages its window
    ///      into a record (op Claim) at the entry's cursor day.
    function _stagedScene() internal returns (uint256 id) {
        id = _sceneAt(NEED);
        _wideDay();
        assertEq(_claim(), 0, "fixture: the wide day is staged, not settled");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Staging), "fixture: a record stands");
    }

    /// @dev The record at `key` with its scan run to the list's end: the walk
    ///      records no scan position, so the first preparation rescans the
    ///      window and the second reaches the 65th epoch.
    function _scan(bytes32 key) internal {
        _staging().prepareStagedDay(key);
        _staging().prepareStagedDay(key);
        assertTrue(_recAt(key).scanComplete, "fixture: the scan reached the list's end");
    }

    /// @dev The staged scene with the record's scan run to the list's end.
    function _stagedAndScanned() internal returns (uint256 id) {
        id = _stagedScene();
        _scan(_key());
    }

    function _resolveAll(bytes32 key) internal {
        uint256 pages;
        while (!_settle().resolveStagedDayPage(key)) {
            assertLt(++pages, 16, "the record resolves");
        }
    }

    /// @dev Exactly one `StagingDelivered` for `key`, of `amount`, at `venue`.
    function _assertDelivered(Vm.Log[] memory logs, bytes32 key, uint256 amount, uint8 venue) internal view {
        assertEq(_count(logs, T_DELIVERED), 1, "one delivery announced");
        Vm.Log memory l = _nth(logs, T_DELIVERED, 0);
        assertEq(l.topics[1], key, "delivered: the record");
        assertEq(l.topics[2], _addrTopic(alice), "delivered: the claimant");
        (uint256 a, uint8 v) = abi.decode(l.data, (uint256, uint8));
        assertEq(a, amount, "delivered: the whole user share");
        assertEq(v, venue, "delivered: the venue");
    }
}

/// @title RewardSanctionsForfeitStagedTest
/// @notice The mirror with reward custody ACTIVE: the armed window straddle and
///         its custody rows, the staged payout's hold / set-apart / forfeit,
///         records and domains, the held-apart venue, the spanning slice split
///         and the expiry headroom floor.
contract RewardSanctionsForfeitStagedTest is RewardSanctionsMirrorBase {
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

    /// @dev The custody rows a settlement moves, and the totals it must not.
    struct RowSnap {
        uint256 live;
        uint256 recycled;
        uint256 held;
        uint256 attributed;
        uint256 holderBal;
    }

    /// @dev S1-S3's scene: alice's four one-day entries on days SF - 1, SF, SL
    ///      and SL + 1, and the flag's first observation instant.
    struct WindowScene {
        uint256 idPre;
        uint256 idF;
        uint256 idL;
        uint256 idPost;
        uint256 t0;
    }

    function setUp() public {
        _setUpMirror(true);
    }

    // ----------------------------- fixtures -----------------------------

    function _rowSnap() internal view returns (RowSnap memory r) {
        r.live = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        r.recycled = _row(LibVaipakam.RewardCustodyRow.Recycled);
        r.held = _heldRow();
        r.attributed = _mut().attributedTotalRaw();
        r.holderBal = vpfi.balanceOf(_custody().rewardCustodyHolder());
    }

    function _paySnap() internal view returns (PaySnap memory p) {
        p.encumbered = _mut().stagingEncumberedCountRaw();
        p.poolReserved = _mut().interactionPoolReservedRaw();
        p.liveReserved = _mut().liveFreshReservedRaw();
        p.armedReserved = _mut().rewardBudgetArmedFreshReservedRaw();
        p.paidOut = _paidOut();
        (, p.commitFresh, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        p.sideReserved = _mut().loanSideRewardReservedRaw(LOAN, LENDER);
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

    /// @dev Revokes alice's flag with a Clean read: the confirmed chain's
    ///      window is recorded.
    function _revoke() internal {
        oracle.setFlagged(alice, false);
        assertEq(_observe(alice), DELIVER, "revoked: a Clean read");
    }

    // ----------------------------- the armed window straddle -----------------------------

    /// @dev S1-S3's scene up to the confirmation: four one-day entries on days
    ///      SF - 1, SF, SL and SL + 1 (each on its own loan), arming from SF - 1,
    ///      live fresh, day SF - 1 finalized and shown payable to a clean owner,
    ///      then the flag confirmed by {_confirm} (window [SF, SL]). Days arm as
    ///      they finalize: a day not yet known is not priced.
    function _windowScene() internal returns (WindowScene memory w) {
        _mut().setGovernorCommitArmedFromDayRaw(SF - 1);
        _mut().seedCumLenderDayRaw(SF - 2, 0, 0);
        w.idPre = _oneDayOn(LOAN_PRE, SF - 1);
        w.idF = _oneDayOn(LOAN_F, SF);
        w.idL = _oneDayOn(LOAN_L, SL);
        w.idPost = _oneDayOn(LOAN_POST, SL + 1);
        _armedDay(SF - 1, NEED);
        _liveFresh(20e18);
        _mut().userClaimFundingNeedRaw(alice);
        assertEq(_preview(), NEED, "fixture LIVE: day SF - 1 pays a clean owner");
        oracle.setFlagged(alice, true);
        w.t0 = _confirm(alice);
        assertEq(_dayOf(w.t0), SF, "fixture: the flag is first observed on day SF");
        assertEq(_dayOf(_now()), SL, "fixture: and confirmed on day SL");
        for (uint256 d = SF; d < SL; ++d) _armedDay(d, NEED);
    }

    /// @notice S1 - THE WINDOW STRADDLE on ARMED days, settled while the owner
    ///         is confirmed (custody active). The settlement prices the
    ///         finalized days: day SF - 1, earned before the flag, is SET APART
    ///         (held balance, ledger total, `SanctionsHeld` row, one event) and
    ///         charged to its loan side as the owner's share; day SF, the flag's
    ///         first day, is FORFEITED - credited to the bucket as forfeited
    ///         reward, its loan side never charged. Nothing reaches the wallet,
    ///         no claim is announced, and custody only moves between rows: the
    ///         attributed total and the holder's balance are unchanged. Days SL
    ///         and SL + 1 are not finalized and stay owed.
    /// @dev   Mutations (each fails at "only day SF - 1 is set apart"): drop
    ///        `dc.sanctionedDay = dayForfeited(...)` in `_walkSideDays`, or
    ///        `|| dry.sanctionedDay` in `_priceEntriesForDay` -> day SF is set
    ///        apart too; `chainWindow`'s `<` turned `<=` -> the chain, last
    ///        observed exactly W after its first, reads unconfirmed and day SF
    ///        is set apart.
    function test_sanc_S1_theWindowStraddle_onArmedDays_setsApartTheDayBefore_andForfeitsTheFirstDay() public {
        WindowScene memory w = _windowScene();
        RowSnap memory r0 = _rowSnap();
        uint256 bucket0 = _bucket();
        vm.recordLogs();
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(d, CONFIRMED, "confirmed");
        assertEq(heldApart, NEED, "only day SF - 1 is set apart");
        assertEq(_sidePaid(LOAN_PRE), NEED, "day SF - 1 was the owner's: its loan side charged");
        assertEq(_sidePaid(LOAN_F), 0, "day SF was forfeited: no user share charged");
        _assertHeldApartLog(logs, alice, NEED, NEED);
        assertEq(_count(logs, T_CLAIMED), 0, "a settlement is not a claim");
        assertEq(_forfeitedCredit(logs), NEED, "day SF credited as forfeited reward");
        assertEq(_bucket() - bucket0, NEED, "into the bucket");
        assertEq(_held(alice), NEED, "lens: the held balance");
        assertEq(_heldTotal(), NEED, "lens: the ledger total");
        assertEq(vpfi.balanceOf(alice), 0, "nothing reaches the wallet");
        assertTrue(_entry(w.idPre).processed && _entry(w.idF).processed, "days SF - 1 and SF settled");
        assertFalse(_entry(w.idL).processed || _entry(w.idPost).processed, "days SL and SL + 1 still owed");
        _assertRowsMovedOnly(r0, NEED);
    }

    /// @dev The settlement moved custody between rows only: the held row grew
    ///      by `held`, the live row fell by exactly what the held and recycled
    ///      rows gained, and the attributed total and holder balance stand.
    function _assertRowsMovedOnly(RowSnap memory r0, uint256 held) internal view {
        RowSnap memory r1 = _rowSnap();
        assertEq(r1.held - r0.held, held, "rows: the set-apart reward moved into SanctionsHeld");
        assertEq(r0.live - r1.live, (r1.held - r0.held) + (r1.recycled - r0.recycled), "rows: out of the live row, nowhere else");
        assertEq(r1.attributed, r0.attributed, "rows: the attributed total is unchanged");
        assertEq(r1.holderBal, r0.holderBal, "rows: no token left the holder");
        assertEq(r1.held, _heldTotal(), "rows: the SanctionsHeld row backs the ledger total");
    }

    /// @dev S1's flow through the settlement, for the cells that continue it.
    function _settledWindowScene() internal returns (WindowScene memory w) {
        w = _windowScene();
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, CONFIRMED, "fixture: settled");
        assertEq(heldApart, NEED, "fixture: day SF - 1 set apart");
    }

    /// @notice S2 - REVOCATION and the wallet's claim (custody active). A Clean
    ///         read on day SL + 1 records the window [SF, SL] (event + lens) and
    ///         moves nothing. Once SL and SL + 1 finalize, the claim releases the
    ///         held balance (announced; the `SanctionsHeld` row emptied), pays
    ///         day SL + 1, and FORFEITS day SL - a window day that settles only
    ///         now - so it pays the held balance plus one day, and the claim
    ///         event says so.
    /// @dev   Mutations: the Clear branch's `_recordWindow` dropped -> day SL
    ///        pays (three NEED, its loan side charged); the release line in
    ///        `_claimFor` dropped -> the held balance stays held and is not
    ///        paid; `chainWindow`'s `<` turned `<=` -> no window is recorded.
    function test_sanc_S2_revocation_recordsTheWindow_andTheClaimReleasesTheHeld_forfeitsDaySL_paysDaySLPlus1() public {
        WindowScene memory w = _settledWindowScene();
        vm.warp(w.t0 + 4 days + 1);
        vm.recordLogs();
        _revoke();
        // Read back AFTER the claim: the economic consequence is asserted first.
        Vm.Log[] memory revocation = vm.getRecordedLogs();
        assertEq(_held(alice), NEED, "revocation alone moves nothing");

        vm.warp(w.t0 + 5 days);
        _armedDay(SL, NEED);
        _armedDay(SL + 1, NEED);
        uint256 bucket0 = _bucket();
        vm.recordLogs();
        uint256 paid = _claimWallet(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(paid, 2 * NEED, "the held balance and day SL + 1");
        assertEq(vpfi.balanceOf(alice), 2 * NEED, "delivered to the wallet");
        _assertReleasedLog(logs, alice, NEED);
        _assertClaimedLog(logs, alice, 2 * NEED);
        assertEq(_sidePaid(LOAN_L), 0, "day SL forfeited after the revocation: no user share");
        assertEq(_sidePaid(LOAN_POST), NEED, "day SL + 1 paid to her");
        assertEq(_forfeitedCredit(logs), NEED, "day SL credited as forfeited reward");
        assertEq(_bucket() - bucket0, NEED);
        assertEq(_held(alice), 0, "the held balance is spent");
        assertEq(_heldTotal(), 0);
        assertEq(_heldRow(), 0, "and the SanctionsHeld row emptied");
        assertTrue(_entry(w.idL).processed && _entry(w.idPost).processed);
        _assertWindowLog(revocation, alice, SF, SL);
        _assertOneWindow(alice, SF, SL);
    }

    /// @notice S3 - a claim that ONLY releases (custody active): revoked before
    ///         days SL and SL + 1 finalize, the claim has nothing else to pay and
    ///         still succeeds - announced as a claim - releasing the whole held
    ///         balance out of the `SanctionsHeld` row to the wallet, without
    ///         charging the pool or the delivered ledger a second time.
    /// @dev   Kills the release dropped from `_claimFor` (the claim reverts as
    ///        empty), the release-only early return dropped (same), and a
    ///        release that re-charges the delivered ledger or the pool.
    function test_sanc_S3_aClaimThatOnlyReleases_succeeds_andDebitsTheHeldRow() public {
        WindowScene memory w = _settledWindowScene();
        vm.warp(w.t0 + 4 days + 1);
        _revoke();
        RowSnap memory r0 = _rowSnap();
        uint256 paid0 = _paidOut();
        uint256 ledger0 = _mut().getArmedFreshPaidRaw();
        vm.recordLogs();
        uint256 paid = _claimWallet(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(paid, NEED, "the release alone");
        _assertClaimedLog(logs, alice, NEED);
        _assertReleasedLog(logs, alice, NEED);
        assertEq(vpfi.balanceOf(alice), NEED);
        RowSnap memory r1 = _rowSnap();
        assertEq(r0.held - r1.held, NEED, "debited from the SanctionsHeld row");
        assertEq(r1.held, 0);
        assertEq(r0.holderBal - r1.holderBal, NEED, "the tokens left custody for the wallet");
        assertEq(r1.live, r0.live, "the live row is not touched");
        assertEq(_paidOut(), paid0, "not charged to the pool again");
        assertEq(_mut().getArmedFreshPaidRaw(), ledger0, "nor to the delivered ledger");
        assertFalse(_entry(w.idL).processed || _entry(w.idPost).processed, "nothing else was settled");
    }

    // ----------------------------- the spanning slice -----------------------------

    /// @notice P1 - THE LEGACY SLICE SPLIT of a SPANNING entry (`_processEntry`):
    ///         an entry over [SF - 1, SL + 1) whose days SF - 1..SL - 1 are
    ///         pre-arming (one legacy slice) and day SL armed. With the window
    ///         [SF, SL] recorded, the wallet's claim pays the slice's day SF - 1
    ///         alone - exactly its step on the capped curve - and forfeits the
    ///         slice's window share (the curve differenced over SF..SL - 1) plus
    ///         the armed day SL, all credited as forfeited reward.
    /// @dev   Mutation: drop `toUser.total -= w; toTreasury.total += w;` in
    ///        `_processEntry` -> the claim pays the whole slice.
    function test_sanc_P1_aSpanningEntrysLegacySlice_isSplitByTheWindow_exactlyOnTheCurve() public {
        oracle.setFlagged(alice, true);
        uint256 t0 = _confirm(alice);
        vm.warp(t0 + W + 1 hours);
        _revoke();
        _assertOneWindow(alice, SF, SL);
        _mut().setGovernorCommitArmedFromDayRaw(SL);
        _mut().seedCumLenderDayRaw(SF - 2, 0, 0);
        for (uint256 d = SF - 1; d < SL; ++d) _legacyDay(d);
        _armedDay(SL, NEED);
        _loanSideOpen(5);
        uint256 id = _entryOn(uint32(SF - 1), uint32(SL + 1));
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        vm.warp(t0 + 4 days);
        _mut().advanceCumThroughRaw(LENDER, SL);
        uint256 slice = _minRpn(SL - 1) - _minRpn(SF - 2);
        uint256 share = _minRpn(SL - 1) - _minRpn(SF - 1);
        assertGt(share, 0, "fixture LIVE: the window covers part of the slice");
        _liveFresh(slice + 1e18); // the slice prices by the SCHEDULE: the live sources must bear it whole
        uint256 bucket0 = _bucket();
        vm.recordLogs();
        uint256 paid = _claimWallet(alice);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(paid, slice - share, "the slice less its window share");
        assertEq(slice - share, _minRpn(SF - 1) - _minRpn(SF - 2), "which is exactly day SF - 1's step");
        assertEq(_forfeitedCredit(logs), share + NEED, "the window share and the armed day SL, forfeited");
        assertEq(_bucket() - bucket0, share + NEED);
        assertTrue(_entry(id).processed, "the slice and the armed tail settled");
    }

    // ----------------------------- the staged payout -----------------------------

    /// @notice T10 - a RESOLVING record on a PRE-FLAG day, its claimant confirmed
    ///         while it resolves: the settlement leaves the record's day to the
    ///         record (it settles nothing there), and the record's own last page
    ///         SETS the share APART - announced as delivered to the
    ///         `SanctionsHeld` venue, into the held balance and the
    ///         `SanctionsHeld` row - never to the wallet, never forfeited.
    /// @dev   Kills a payout that forfeits on Confirmed whatever the day (the
    ///        old rule): `StagingClaimantForfeited` would be emitted.
    function test_sanc_T10_aResolvingPreFlagRecord_ofAConfirmedClaimant_isSetApart() public {
        uint256 id = _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        assertFalse(_settle().resolveStagedDayPage(_key()), "fixture: one page in");
        RewardStagingDomainFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Resolving), "fixture: Resolving at the cursor day");
        uint256 share = _userShare(r);
        assertGt(share, 0, "fixture LIVE: a user share stands");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, CONFIRMED, "fixture: the owner is confirmed");
        assertEq(heldApart, 0, "the settlement leaves a record's day to the record");
        uint256 row0 = _heldRow();
        uint256 bucket0 = _bucket();
        vm.recordLogs();
        assertTrue(_settle().resolveStagedDayPage(_key()), "the last page completes");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 0, "a pre-flag day is never forfeited");
        _assertDelivered(logs, _key(), share, VENUE_HELD);
        _assertHeldApartLog(logs, alice, share, share);
        assertEq(_held(alice), share, "into the held balance");
        assertEq(_heldRow() - row0, share, "and the SanctionsHeld row");
        assertEq(_bucket(), bucket0, "nothing forfeited");
        assertEq(vpfi.balanceOf(alice), 0, "nothing reaches the wallet");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
        assertTrue(_entry(id).processed, "settled by the record");
    }

    /// @notice T10b - the same Resolving record, its claimant confirmed and then
    ///         delisted before the last page: the page's Clean read records the
    ///         window - which does not reach the record's day 1 - and the share
    ///         is delivered to the wallet in full.
    function test_sanc_T10b_aDelistingBeforeTheLastPage_delivers_andRecordsTheWindow() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        assertFalse(_settle().resolveStagedDayPage(_key()), "fixture: one page in");
        uint256 share = _userShare(_rec());
        assertGt(share, 0, "fixture LIVE: a user share stands");
        oracle.setFlagged(alice, true);
        _confirm(alice);
        oracle.setFlagged(alice, false);
        vm.recordLogs();
        assertTrue(_settle().resolveStagedDayPage(_key()), "the last page completes");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 0, "a delisted owner's pre-flag day is not forfeited");
        _assertDelivered(logs, _key(), share, uint8(LibVaipakam.RewardDelivery.Wallet));
        _assertWindowLog(logs, alice, SF, SL);
        assertEq(vpfi.balanceOf(alice), share, "in full, to the wallet");
        assertEq(_held(alice), 0, "nothing held");
        _assertEvidence(alice, DELIVER, 0, 0, address(0), false);
    }

    /// @notice T12 - a FIRST-flagged claimant's last page holds BEFORE any
    ///         write: it returns false, the record stays Resolving with every
    ///         batch resolved, and the figures only the payout moves (the
    ///         encumbrance count, the pool and live-fresh reservations, the
    ///         armed reservation, the pool's paid-out, the armed commitment, the
    ///         loan side's reservation, the staged earmark, the record's holds
    ///         and the Resolving / Unclassified / Recycled rows net of the
    ///         page's own batch hold) read exactly as before the page, and
    ///         every later held page moves none of them at all. The record's
    ///         own pages then carry the chain - held one second short of the
    ///         window, and at it, the day being a PRE-flag day, the share SET
    ///         APART - and the encumbrance ends with the record.
    /// @dev   Kills M13 (Hold treated as Deliver - the first last page would
    ///        pay and complete) and M14 (the hold placed after a write - the
    ///        figures would move; placed just after the earmark release, the
    ///        earmark drops on the held page and again on each re-held one;
    ///        just after the hold moves, the record's holds and the Resolving
    ///        row empty). The hold page is necessarily the page that resolves
    ///        the last batch, so its rows are compared NET of that batch's own
    ///        Unclassified -> Resolving hold; the earmark is compared whole,
    ///        because this scene consumes every staged epoch and so no batch
    ///        returns anything out of it.
    function test_sanc_T12_aFirstFlagHoldsTheLastPage_beforeAnyWrite_thenSetsApartAtTheWindow() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 share = _userShare(_rec());
        assertGt(share, 0, "fixture LIVE: a user share stands");
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
        assertEq(_held(alice), 0, "nothing set apart on a hold");

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
        assertTrue(_settle().resolveStagedDayPage(_key()), "the page at the window completes");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 0, "a pre-flag day is not forfeited");
        _assertDelivered(logs, _key(), share, VENUE_HELD);
        assertEq(_held(alice), share, "the share is set apart");
        assertEq(_mut().stagingEncumberedCountRaw(), before.encumbered - 1, "the encumbrance ends with the record");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
    }

    /// @notice T12c - a delisting during the window delivers the held page:
    ///         the Clean read heals, the share is delivered in full, nothing is
    ///         forfeited or held, and - the chain never having confirmed - no
    ///         window is recorded.
    function test_sanc_T12c_aDelistingDuringTheWindow_deliversTheHeldPage_andRecordsNoWindow() public {
        _stagedAndScanned();
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
        assertEq(_count(logs, T_WINDOW), 0, "an unconfirmed chain records no window");
        _assertDelivered(logs, _key(), share, uint8(LibVaipakam.RewardDelivery.Wallet));
        _assertEvidence(alice, DELIVER, 0, 0, address(0), false);
        _assertNoWindow(alice);
        assertEq(_held(alice), 0);
    }

    /// @notice T12b - a Claim record whose user share is ZERO never holds, even
    ///         for a marked owner during an outage (the screen runs only for a
    ///         user share): its entry forfeited (as a default would) while the
    ///         record stood in Staging, the reservation priced the day to the
    ///         treasury, and the record resolves to completion. Straddle: the
    ///         same owner IS barred right then.
    /// @dev   Kills M20 (screen unconditionally): the page would hold on row 4
    ///        for as long as the outage lasts and the bounded loop would fail.
    function test_sanc_T12b_aZeroUserShareNeverHolds_evenForAMarkedOwnerDuringAnOutage() public {
        uint256 id = _stagedAndScanned();
        _mut().setRewardEntryForfeitedRaw(id);
        oracle.setFlagged(alice, true);
        assertEq(_observe(alice), HOLD, "fixture: the marker is committed");
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        assertEq(_userShare(_rec()), 0, "fixture: a Claim record with no user share");
        oracle.setRevertOnRead(true);
        assertTrue(_profile().isRecipientBarred(alice), "fixture: the marked owner is barred during the outage");
        _resolveAll(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None), "resolved: no hold without a user share");
        assertTrue(_entry(id).processed);
    }

    /// @notice S6 - a WINDOW DAY staged after the revocation: the window [SF,
    ///         SL] recorded, the delisted owner's own claim stages a wide window
    ///         day (SF + 1) into a record; its reservation prices a USER share
    ///         (the entry is not forfeited - the day is); and the record's last
    ///         page, though the owner now reads Deliver, FORFEITS that share
    ///         (`StagingClaimantForfeited`, absorbed into the bucket) - never
    ///         delivered, never held.
    /// @dev   Mutation: drop the `dayForfeited` branch in `_pay` -> the share is
    ///        delivered to the wallet (`StagingDelivered`, no forfeit event).
    function test_sanc_S6_aWindowDayStagedAfterRevocation_isForfeitedAtThePayout() public {
        oracle.setFlagged(alice, true);
        uint256 t0 = _confirm(alice);
        vm.warp(t0 + W + 1 hours);
        _revoke();
        _assertOneWindow(alice, SF, SL);
        uint256 day = SF + 1;
        _mut().setGovernorCommitArmedFromDayRaw(day);
        _mut().seedCumLenderDayRaw(day - 1, 0, 0);
        _armedDay(day, NEED);
        _loanSideOpen(1);
        uint256 id = _entryOn(uint32(day), uint32(day + 1));
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        _wideDayOn(day, 500);
        bytes32 key = _dayKey(day);
        assertEq(_claim(), 0, "the clean claim stages the wide window day");
        assertEq(_recAt(key).phase, uint8(LibVaipakam.StagingPhase.Staging), "fixture: a record stands");
        assertEq(_recAt(key).op, uint8(LibVaipakam.StagingOp.Claim), "a claim's record");
        _scan(key);
        _liveFresh(1e18);
        _staging().reserveStagedDay(key);
        RewardStagingDomainFacet.StagingRecordView memory r = _recAt(key);
        uint256 userFresh = r.reservedLiveUserFresh + r.epochUserFresh;
        assertGt(_userShare(r), 0, "fixture LIVE: the reservation priced a user share");
        uint256 bucket0 = _bucket();
        vm.recordLogs();
        _resolveAll(key);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 1, "the window day's share is forfeited");
        Vm.Log memory l = _nth(logs, T_CLAIMANT_FORFEITED, 0);
        assertEq(l.topics[1], key, "forfeited: the record");
        (uint256 ff, uint256 fr) = abi.decode(l.data, (uint256, uint256));
        assertEq(ff, userFresh, "forfeited: its fresh");
        assertEq(fr, r.reservedLiveUserRecycled + r.epochUserRecycled, "forfeited: its recycled");
        assertEq(_count(logs, T_DELIVERED), 0, "nothing delivered");
        assertEq(_bucket() - bucket0, userFresh, "absorbed into the bucket");
        assertEq(vpfi.balanceOf(alice), 0);
        assertEq(_held(alice), 0, "nothing held");
        assertEq(_recAt(key).phase, uint8(LibVaipakam.StagingPhase.None), "closed");
        assertTrue(_entry(id).processed);
    }

    /// @notice S7 - a record OPENED BY THE SETTLEMENT carries the held-apart
    ///         venue, so its payout sets the share apart even after the owner is
    ///         delisted: a confirmed owner's settlement stages a wide pre-flag
    ///         day (venue `SanctionsHeld` bound on the record); the flag is
    ///         revoked; the record's last page reads Deliver, yet the share goes
    ///         to the held balance (announced at the `SanctionsHeld` venue), and
    ///         the owner's next claim pays it. Straddle: T10b, the same record
    ///         opened by the owner's own claim, delivers to the wallet.
    /// @dev   Kills dropping `|| venue == SanctionsHeld` from `_pay`'s
    ///        set-apart test (the share would be delivered straight to the
    ///        wallet, bypassing the held ledger the settlement charged).
    function test_sanc_S7_aRecordTheSettlementOpened_isSetApart_evenForADelistedOwner() public {
        _sceneAt(NEED);
        _wideDay();
        oracle.setFlagged(alice, true);
        _confirm(alice);
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, CONFIRMED, "fixture: confirmed");
        assertEq(heldApart, 0, "the wide day is staged, not settled");
        RewardStagingDomainFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Staging), "fixture: the settlement opened a record");
        assertTrue(r.venueSet, "the settlement's venue rides into the record");
        assertEq(r.venue, VENUE_HELD, "the held-apart venue");
        _revoke();
        _scan(_key());
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 share = _userShare(_rec());
        assertGt(share, 0, "fixture LIVE: a user share stands");
        vm.recordLogs();
        _resolveAll(_key());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertDelivered(logs, _key(), share, VENUE_HELD);
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 0);
        assertEq(_held(alice), share, "set apart although the owner reads Deliver");
        assertEq(vpfi.balanceOf(alice), 0, "not delivered by the record");
        assertEq(_claimWallet(alice), share, "her next claim releases it");
        assertEq(vpfi.balanceOf(alice), share);
        assertEq(_held(alice), 0);
    }

    /// @notice T20 - a DOMAIN claimant: the irrevocable domain's first payout
    ///         holds on a first flag with nothing moved; the domain's own pages
    ///         carry the chain; at the window every day - all earned before the
    ///         flag - is SET APART (one `StagingDelivered` per day at the
    ///         `SanctionsHeld` venue), the held balance takes the whole domain,
    ///         nothing is forfeited or delivered, and the domain clears.
    /// @dev   Kills M13 for domains (the first page would pay) and a domain
    ///        payout that forfeits a pre-flag day on Confirmed.
    function test_sanc_T20_aDomainClaimantHolds_thenSetsApartEveryPreFlagDay() public {
        _longScene(DAYS);
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
        assertEq(_held(alice), 0);
        assertEq(_domPhase(), uint8(LibVaipakam.DomainPhase.Resolving));
        uint256 t = t0;
        while (t + G < t0 + W) {
            t += G;
            vm.warp(t);
            assertFalse(_domain().resolveDomainPage(_dk()), "held inside the window");
        }
        vm.warp(t0 + W);
        vm.recordLogs();
        _resolveAllDomain();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, T_DELIVERED), DAYS, "every day's share is set apart");
        assertEq(_count(logs, T_CLAIMANT_FORFEITED), 0, "none forfeited");
        (, uint8 venue) = abi.decode(_nth(logs, T_DELIVERED, 0).data, (uint256, uint8));
        assertEq(venue, VENUE_HELD, "at the held-apart venue");
        assertEq(_held(alice), uint256(DAYS) * NEED, "the whole domain held for her");
        assertEq(_bucket(), bucket0, "nothing forfeited");
        assertEq(vpfi.balanceOf(alice), 0, "nothing delivered");
        assertEq(_domPhase(), uint8(LibVaipakam.DomainPhase.None), "cleared");
    }

    // ----------------------------- the held-apart venue -----------------------------

    /// @notice V1 - the held-apart venue is the settlement's alone: a claim to
    ///         it and a simulation of one both revert
    ///         `RewardDeliveryNotSelectable(3)` before anything runs. Straddle:
    ///         the same entries, the wallet named, simulate and pay.
    /// @dev   Mutation: empty `_requireSelectableVenue` -> the claim to
    ///        `SanctionsHeld` runs the settlement body for a CLEAN owner,
    ///        setting her reward apart instead of reverting.
    function test_sanc_V1_theHeldApartVenue_isRefusedByTheClaimAndTheSimulation() public {
        _sceneAt(NEED);
        _liveFresh(1e18);
        assertEq(uint8(LibVaipakam.RewardDelivery.SanctionsHeld), VENUE_HELD, "the held-apart venue's code");
        vm.expectRevert(abi.encodeWithSelector(RewardDeliveryNotSelectable.selector, VENUE_HELD));
        vm.prank(alice);
        RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.SanctionsHeld);
        vm.expectRevert(abi.encodeWithSelector(RewardDeliveryNotSelectable.selector, VENUE_HELD));
        RewardClaimFacet(address(diamond)).simulateClaimInteractionRewards(alice, LibVaipakam.RewardDelivery.SanctionsHeld);
        assertEq(_held(alice), 0, "nothing set apart");
        (bool completed, uint256 amount, , ) = previewByExecutionStatus(alice, LibVaipakam.RewardDelivery.Wallet);
        assertTrue(completed, "a selectable venue simulates");
        assertEq(amount, NEED);
        assertEq(_claimWallet(alice), NEED, "and pays");
    }

    /// @notice V2 - a staging record's claimant cannot bind the held-apart
    ///         venue; the same claimant binds the wallet on the same record.
    function test_sanc_V2_theHeldApartVenue_isRefusedByTheRecordVenueSetter() public {
        _stagedScene();
        vm.expectRevert(abi.encodeWithSelector(RewardDeliveryNotSelectable.selector, VENUE_HELD));
        vm.prank(alice);
        _settle().setStagingVenue(_key(), LibVaipakam.RewardDelivery.SanctionsHeld);
        assertFalse(_rec().venueSet, "nothing bound");
        vm.prank(alice);
        _settle().setStagingVenue(_key(), LibVaipakam.RewardDelivery.Wallet);
        assertTrue(_rec().venueSet, "a selectable venue binds");
        assertEq(_rec().venue, uint8(LibVaipakam.RewardDelivery.Wallet));
    }

    /// @notice V3 - a staging domain's claimant cannot bind the held-apart
    ///         venue; the same claimant binds the wallet on the same domain.
    function test_sanc_V3_theHeldApartVenue_isRefusedByTheDomainVenueSetter() public {
        _longScene(DAYS);
        _liveFresh(20e18);
        _claim();
        assertEq(_domPhase(), uint8(LibVaipakam.DomainPhase.Staging), "fixture: a domain in staging");
        vm.expectRevert(abi.encodeWithSelector(RewardDeliveryNotSelectable.selector, VENUE_HELD));
        vm.prank(alice);
        _domain().setDomainVenue(_dk(), LibVaipakam.RewardDelivery.SanctionsHeld);
        vm.prank(alice);
        _domain().setDomainVenue(_dk(), LibVaipakam.RewardDelivery.Wallet);
    }

    // ----------------------------- the headroom floor -----------------------------

    /// @notice T21 - the EXPIRY sweep's running headroom is FLOORED: a legacy
    ///         slice with epoch coverage, expired against a pool headroom that
    ///         covers its live part but not the epoch part riding on it, reports
    ///         a credit above the headroom it was handed; the sweep fails at the
    ///         settle's own named refusal and never as an arithmetic panic.
    ///         Straddle: with the headroom back the same sweep expires the whole
    ///         slice into the bucket. Each step tries the short headroom in a
    ///         reverted frame first, so the expiring sweep is the one caught.
    /// @dev   Kills M21 (the unfloored `headroom - freshCredited`): the revert
    ///        would be Panic(0x11).
    function test_sanc_T21_anExpiryChunkPastTheHeadroom_isFlooredNotPanicked() public {
        uint256 id = _legacyScene();
        uint256 total = _legacyTotal();
        assertGt(total, EPOCH, "fixture: a legacy slice wider than its epoch");
        _epochOnDay(EPOCH, 1, 7, keccak256(abi.encode("sanc-legacy-epoch", uint256(1), uint256(7))));
        _liveFresh(total + 1e18);
        _cfg().setRewardClaimHorizonDays(180);
        uint256 h = total - EPOCH;
        bool refused;
        uint256 t = _now();
        for (uint256 k; k < 64; ++k) {
            uint256 snap = vm.snapshotState();
            _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP - h);
            (bool ok, bytes memory ret) = address(diamond).call(
                abi.encodeWithSelector(RewardHorizonSweepFacet.sweepExpiredInteractionRewards.selector, _ids(id))
            );
            if (!ok) {
                assertEq(
                    bytes4(ret),
                    IVaipakamErrors.InteractionPoolReservedShortfall.selector,
                    "by the settle's own refusal, not an arithmetic panic"
                );
                refused = true;
            }
            vm.revertToState(snap);
            vm.warp(t);
            if (refused) break;
            _sweeper().sweepExpiredInteractionRewards(_ids(id));
            assertFalse(_entry(id).processed, "fixture: the short and the full sweep agree on when it expires");
            t += 7 days;
            vm.warp(t);
        }
        assertTrue(refused, "the expiring chunk past the headroom was reached");
        uint256 bucket0 = _bucket();
        _sweeper().sweepExpiredInteractionRewards(_ids(id));
        assertTrue(_entry(id).processed, "with the headroom back the sweep expires it");
        assertEq(_bucket() - bucket0, total, "the whole slice recycled");
    }
}

/// @title RewardSanctionsHeldActivationTest
/// @notice The same mirror with reward custody NOT yet active: reward set apart
///         before activation rests at the Diamond under the held ledger, and the
///         activation ceremony must back the `SanctionsHeld` row with the total
///         before it can switch custody on.
contract RewardSanctionsHeldActivationTest is RewardSanctionsMirrorBase {
    function setUp() public {
        _setUpMirror(false);
    }

    function _pauseEpoch() internal view returns (uint64 epoch) {
        (, , , epoch) = LibPausable.decodePausableSlot(vm.load(address(diamond), LibPausable.PAUSABLE_STORAGE_POSITION));
    }

    /// @notice A1 - a pre-flag armed day set apart while custody is inactive
    ///         moves the ledger only (the row stays empty; the backing room nets
    ///         the total out while the un-earmarked balance stands). The
    ///         activation then REFUSES with the `SanctionsHeld` row unbacked;
    ///         once the ceremony relocates the held total into it (form b) the
    ///         same activation succeeds, and the owner's claim after revocation
    ///         releases her balance out of that row.
    /// @dev   Mutations: drop the `SanctionsHeld` `_requireRowBacked` in
    ///        `activateRewardCustody` -> the first activation succeeds over an
    ///        empty row; drop `+ rewardSanctionsHeldTotal` from
    ///        `freshBackingRoom` -> the room does not fall.
    function test_sanc_A1_activationRefusesUntilTheHeldRowBacksTheTotal_thenTheReleaseDebitsIt() public {
        _mut().setGovernorCommitArmedFromDayRaw(SF - 1);
        _mut().seedCumLenderDayRaw(SF - 2, 0, 0);
        uint256 id = _oneDayOn(LOAN_PRE, SF - 1);
        _armedDay(SF - 1, NEED);
        _mut().setArmedFreshLedgerRaw(10e18, 0);
        _mut().userClaimFundingNeedRaw(alice);
        assertEq(_preview(), NEED, "fixture LIVE: day SF - 1 pays a clean owner");
        oracle.setFlagged(alice, true);
        uint256 t0 = _confirm(alice);
        uint256 room0 = _mut().freshBackingRoomRaw();
        (, , uint256 unear0, , , , , ) = _lens().getRecycleBackingSnapshot();
        (uint8 d, uint256 heldApart) = _settleOwner(alice);
        assertEq(d, CONFIRMED);
        assertEq(heldApart, NEED, "set apart");
        assertTrue(_entry(id).processed);
        assertEq(_heldTotal(), NEED);
        assertEq(_heldRow(), 0, "inactive: the ledger moves, no row");
        (, , uint256 unear1, , , , , ) = _lens().getRecycleBackingSnapshot();
        assertEq(unear1, unear0, "the held tokens stay at the Diamond");
        assertEq(_mut().freshBackingRoomRaw(), room0 - NEED, "the backing room nets the held total out");

        AdminFacet(address(diamond)).pause();
        if (_custody().rewardCustodyHolder() == address(0)) _custody().bindRewardCustodyHolder();
        uint64 epoch = _pauseEpoch();
        if (!_custody().armedFreshPaidRebased()) _custody().rebaseArmedFreshPaid(0, epoch);
        _custody().stampRewardCustodyCutover();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyRowUnbacked.selector, uint8(LibVaipakam.RewardCustodyRow.SanctionsHeld), NEED, uint256(0)
            )
        );
        _custody().activateRewardCustody(epoch, true);
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.SanctionsHeld, NEED);
        assertEq(_heldRow(), NEED, "relocated: the row backs the total");
        _custody().activateRewardCustody(epoch, true);
        assertTrue(_custody().rewardCustodyActivated(), "activated once the held row is backed");
        AdminFacet(address(diamond)).unpause();

        vm.warp(t0 + 4 days + 1);
        oracle.setFlagged(alice, false);
        assertEq(_observe(alice), DELIVER, "revoked");
        assertEq(_claimWallet(alice), NEED, "the claim releases the held balance");
        assertEq(vpfi.balanceOf(alice), NEED);
        assertEq(_heldRow(), 0, "out of the SanctionsHeld row");
        assertEq(_heldTotal(), 0);
    }
}
