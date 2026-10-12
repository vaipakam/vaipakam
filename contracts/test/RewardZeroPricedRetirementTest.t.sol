// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {RewardClosureFacet} from "../src/facets/RewardClosureFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title RewardZeroPricedRetirementTest
/// @notice 3b-ii-B (B-6) — a closed entry whose remaining window prices to nothing
///         payable is retired by anyone, so the per-day closure proof can accept
///         its days: an EMPTY window is marked processed moving nothing; a
///         remainder the loan-side cap trims to a zero user split runs the expiry
///         sweep's own terminal accounting, a day per call. Anything priceable-not-
///         yet, payable, open or forfeited is left alone.
contract RewardZeroPricedRetirementTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    MockRewardMessenger internal messenger;
    address internal alice;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint64 internal constant LOAN = 77;
    uint256 internal constant SEED = 1_000_000 ether;
    uint256 internal launch;

    event RewardEntryRetiredEmpty(uint256 indexed entryId);
    event RewardEntryCapRetired(uint256 indexed entryId, uint256 indexed dayId, uint256 armedFresh, uint256 recycled);

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl), abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
        uint256 have = vpfi.balanceOf(address(this));
        if (SEED > have) vpfi.mint(address(this), SEED - have);
        vpfi.transfer(address(diamond), SEED);
        alice = makeAddr("retire-alice");
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);
        launch = block.timestamp;
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(launch);
        vm.warp(launch + 10 days);
    }

    function _rep() internal view returns (RewardReporterFacet) { return RewardReporterFacet(address(diamond)); }
    function _agg() internal view returns (RewardAggregatorFacet) { return RewardAggregatorFacet(address(diamond)); }
    function _sweeper() internal view returns (RewardHorizonSweepFacet) { return RewardHorizonSweepFacet(address(diamond)); }
    function _clo() internal view returns (RewardClosureFacet) { return RewardClosureFacet(address(diamond)); }
    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }

    /// @dev One armed (ShareOfPool) day where alice is the whole lender side.
    function _armedDay(uint256 d) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
        _mut().setDayCapModeRaw(d, 1);
        _mut().setDayUserSideCapRaw(d, type(uint256).max);
    }

    /// @dev The loan's reward ceiling: `cap` (0 = a stamped dust loan whose ceiling
    ///      rounds to nothing — every armed payout trims to zero).
    function _loanSideCap(uint32 openDays, uint128 cap) internal {
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
                loanSideRewardCapOpen: cap
            })
        );
    }

    function _closedEntry(uint32 start, uint32 end) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, start);
        _mut().closeRewardEntryRaw(id, end);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) { r = new uint256[](1); r[0] = a; }

    /// @dev Shape (i): a window closed before it began owes nothing and never will.
    function test_AnEmptyClosedWindow_IsRetired_MovingNothing() public {
        uint256 id = _closedEntry(3, 3);
        vm.expectEmit(true, true, true, true);
        emit RewardEntryRetiredEmpty(id);
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        (uint256 n, uint256 total) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 1); assertEq(total, 0, "nothing moved");
        assertTrue(_clo().isEntryTerminatedOn(id, 3), "processed: the proof accepts it");
        (n, ) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 0, "retired once");
    }

    /// @dev Shape (i), the pricing core's mark: a priced window whose value is zero.
    function test_AZeroValueClosedWindow_IsRetired() public {
        // ARMED days stamped with a ZERO pool: the window prices to nothing. (A
        // pre-arming day would not do — the legacy regime prices by the emission
        // schedule, never by the pool stamp.)
        for (uint256 d = 1; d <= 2; ++d) {
            _mut().setDayPoolStampRaw(d, 0, 0);
            _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
            _mut().setDayCapThreshold18(d, type(uint256).max);
            _mut().setDayCapModeRaw(d, 1);
            _mut().setDayUserSideCapRaw(d, type(uint256).max);
        }
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideCap(2, type(uint128).max);
        uint256 id = _closedEntry(1, 3);
        (uint256 n, ) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 1, "an empty-valued window retires");
        assertTrue(_clo().isEntryTerminatedOn(id, 1));
    }

    /// @dev Shape (ii): a stamped dust loan whose ceiling rounds to nothing trims every
    ///      armed payout to zero while the raw split stands. Retirement runs the expiry
    ///      sweep's terminal accounting a day per call; the entry ends processed and
    ///      the proof accepts every day of it.
    function test_ACapTrimmedRemainder_IsRetired_ADayPerCall() public {
        for (uint256 d = 1; d <= 3; ++d) _armedDay(d);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideCap(3, 0);
        _mut().setArmedFreshLedgerRaw(10e18, 0);
        uint256 id = _closedEntry(1, 4);
        assertFalse(_clo().isEntryTerminatedOn(id, 1), "fixture: open for the proof");
        // Nothing payable: the expiry sweep's clock never starts for it.
        assertEq(_sweeper().sweepExpiredInteractionRewards(_ids(id)), 0);
        // #1566 PR 1 review (P1) — the retirement MOVES NOTHING: the cap refused this
        // value, so it is retired as a claim retires a capped day — the pool is not
        // drawn, nothing is credited to the recycle bucket, the delivered ledger is
        // not charged. (Through the expiry settlement it drew all three.)
        uint256 poolBefore = InteractionRewardsLensFacet(address(diamond)).getInteractionPoolPaidOut();
        uint256 bucketBefore = ConfigFacet(address(diamond)).getRecycleBucket();
        (, uint256 ledgerPaidBefore) = RewardCustodyFacet(address(diamond)).armedFreshLedger();
        vm.expectEmit(true, true, false, false, address(diamond));
        emit RewardEntryCapRetired(id, 1, 0, 0);
        (uint256 n, ) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 1, "day 1 retired");
        assertEq(InteractionRewardsLensFacet(address(diamond)).getInteractionPoolPaidOut(), poolBefore, "the pool is not drawn");
        assertEq(ConfigFacet(address(diamond)).getRecycleBucket(), bucketBefore, "nothing credited to the bucket");
        (, uint256 ledgerPaidAfter) = RewardCustodyFacet(address(diamond)).armedFreshLedger();
        assertEq(ledgerPaidAfter, ledgerPaidBefore, "the delivered ledger is not charged");
        assertTrue(_clo().isEntryTerminatedOn(id, 1), "the cursor passed day 1");
        assertFalse(_clo().isEntryTerminatedOn(id, 2));
        (n, ) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 1, "day 2");
        (n, ) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 1, "day 3: the window is done");
        assertTrue(_clo().isEntryTerminatedOn(id, 3), "processed");
        (n, ) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 0, "nothing left");
    }

    /// @dev #1566 PR 1 re-review (B-N1) — an entry whose expiry has BEGUN is the expiry
    ///      sweep's: the retirement leaves it alone, so one day is never settled two
    ///      ways by who came first. Straddle: the same entry, expiry not begun, retires.
    function test_ARemainderWhoseExpiryBegan_IsTheSweeps() public {
        for (uint256 d = 1; d <= 3; ++d) _armedDay(d);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideCap(3, 0);
        _mut().setArmedFreshLedgerRaw(10e18, 0);
        uint256 id = _closedEntry(1, 4);
        _mut().setRewardEntryExpiryBegunRaw(id, true);
        (uint256 n, ) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 0, "the sweep's, not the retirement's");
        assertFalse(_clo().isEntryTerminatedOn(id, 1), "nothing moved");
        _mut().setRewardEntryExpiryBegunRaw(id, false);
        (n, ) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 1, "straddle: not begun, it retires");
    }

    /// @dev A closed window NOT yet priceable (its last day is beyond the known
    ///      globals) is not empty: it is left alone. (A retirement keyed on
    ///      "unpriced" alone would retire it — the mutation this cell kills.)
    function test_AnUnpricedClosedWindow_IsLeftAlone() public {
        _armedDay(1);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideCap(3, 0);
        uint256 id = _closedEntry(1, 4); // days 2 and 3 have no globals yet
        (uint256 n, ) = _sweeper().retireZeroPricedRemainders(_ids(id));
        assertEq(n, 0, "not priceable: not retired");
        assertFalse(_clo().isEntryTerminatedOn(id, 1));
    }

    /// @dev Payable, open or forfeited remainders are the claimant's or the sweeps': left alone.
    function test_PayableOpenOrForfeited_AreLeftAlone() public {
        for (uint256 d = 1; d <= 2; ++d) _armedDay(d);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideCap(2, type(uint128).max);
        uint256 payable_ = _closedEntry(1, 3);
        uint256 open = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, 1); // never closed
        uint256 forfeited = _closedEntry(1, 3);
        _mut().setRewardEntryForfeitedRaw(forfeited);
        uint256[] memory ids = new uint256[](3);
        ids[0] = payable_; ids[1] = open; ids[2] = forfeited;
        (uint256 n, uint256 total) = _sweeper().retireZeroPricedRemainders(ids);
        assertEq(n, 0); assertEq(total, 0);
        assertFalse(_clo().isEntryTerminatedOn(payable_, 1));
    }
}
