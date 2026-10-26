// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibD6Delivery} from "./helpers/LibD6Delivery.sol";

/**
 * @title RewardRemitLedgerPreActivationTest — a mirror's typed ledgers at
 *        budget arrival, before reward custody is activated.
 * @notice The rooted (d6) wire is the only budget wire. Once a chain's reward
 *         custody is activated, a budget delivery opens a transport epoch and
 *         credits no live row; only BEFORE activation does it take the
 *         typed-ledger path these cells pin: the recycled share credits the
 *         recycle bucket as relocated custody (B2-d5, with the #1446
 *         composition and derivation checks), and the fresh share is counted
 *         on the delivered-fresh ledger (#1434 P1-a, #1566 closure 2). These
 *         cells lived in {RewardRemitLedgerTest} while the retired flat-list
 *         wire still reached that path on an activated custody; that suite
 *         activates custody in its setUp, so they moved here when the flat
 *         wire was retired.
 */
contract RewardRemitLedgerPreActivationTest is SetupTest {
    RewardRemittanceLensFacet internal rlens;
    VPFIToken internal vpfiTok;
    TestMutatorFacet internal mutator;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfiTok = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiTok));
        vpfiTok.mint(address(this), 100_000_000 ether);
        vpfiTok.transfer(address(diamond), 100_000_000 ether);
        rlens = RewardRemittanceLensFacet(address(diamond));
        mutator = TestMutatorFacet(address(diamond));
        vm.chainId(CHAIN_BASE);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(true);
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    function _days(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    /// @dev Two-day batch, for the cutover-straddling case.
    function _days2(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }

    /// @dev Current interaction-schedule day (arming must be strictly future).
    function _today() internal view returns (uint256 d) {
        (d, ) = InteractionRewardsLensFacet(address(diamond)).getInteractionCurrentDay();
    }

    /// @dev The suite's precondition, asserted where a cell starts: every
    ///      delivery here lands on a chain whose custody is NOT activated.
    function _configureMirror() internal {
        assertFalse(RewardCustodyFacet(address(diamond)).rewardCustodyActivated(), "fixture: pre-activation");
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet rep = RewardReporterFacet(address(diamond));
        rep.setIsCanonicalRewardChain(false);
        rep.setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
    }

    /// @dev Install `D*` through the CANONICAL setter (which is Base-only),
    ///      then return to the mirror chain id the ingress cells run under.
    ///      Deliberately not the raw mutator: the point of these cells is the
    ///      attribution rule reading real arming state.
    function _armFrom(uint256 dayId) internal {
        vm.chainId(CHAIN_BASE);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(true);
        RewardAggregatorFacet(address(diamond)).setGovernorCommitArmedFromDay(dayId);
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
    }

    /// @dev A budget delivery on the rooted (d6) wire, filed in the live era.
    function _d6(
        address token,
        uint256 amount,
        uint256[] memory dayIds,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 recycled,
        uint256 fresh,
        bytes32 messageId
    ) internal returns (bytes32 h) {
        (h, ) = LibD6Delivery.deliver(
            address(diamond),
            LibD6Delivery.Delivery({
                token: token,
                amount: amount,
                dayIds: dayIds,
                sourceChainId: sourceChainId,
                remitId: remitId,
                remitter: remitter,
                recycled: recycled,
                fresh: fresh,
                messageId: messageId,
                era: 0
            })
        );
    }

    /// @dev The composition view and its raw slots, exactly as
    ///      `ops/mesh-watcher` reads them (the same reader as
    ///      {RewardRemitLedgerTest}'s).
    function _composition()
        internal
        view
        returns (
            uint256 raw,
            uint256 releasedStranded,
            uint256 relocated,
            uint256 bucket,
            uint256 reported,
            uint256 paidOut,
            uint256 outstanding
        )
    {
        RewardAggregatorFacet agg = RewardAggregatorFacet(address(diamond));
        (raw, releasedStranded, , ) = agg.getRecycleCompositionPosition();
        (relocated, bucket, reported) = agg.getRecycleCustodyPosition();
        (, , outstanding, paidOut) = agg.getGovernorCommitState();
    }

    /// @dev The composition bound of #1446.
    function _assertComposition(string memory ctx) internal view {
        (uint256 raw, uint256 releasedStranded, uint256 relocated, uint256 bucket, , uint256 paidOut, ) =
            _composition();
        assertLe(
            raw + relocated,
            bucket + paidOut + releasedStranded,
            string.concat("composition: raw+relocated <= bucket+paidOut+stranded @ ", ctx)
        );
    }

    /// @dev #2875 — the reported cumulative is the stored absorption
    ///      counter itself: there is no derived floor on a fresh Diamond.
    function _assertDerivation(string memory ctx) internal view {
        (uint256 raw, , , , uint256 reported, , ) = _composition();
        assertEq(
            reported,
            raw,
            string.concat("derivation: reported == the stored counter @ ", ctx)
        );
    }

    // ─── B2-d5: relocated-custody credit at remit arrival ─────────────────

    /// @dev The core d5 shape: an arriving remit's RECYCLED share credits the
    ///      mirror's bucket (so the claim path's `consume(paidRecycled)` has
    ///      real backing) while staying OUT of both Ā-feeding figures — the
    ///      day-bucket AND the cumulative this chain reports to Base.
    function test_D5_CustodyCredit_BacksBucket_ButFeedsNeitherAFigure() public {
        _configureMirror();
        ConfigFacet cfg = ConfigFacet(address(diamond));

        // Give the mirror some GENUINE local absorption first, so the test
        // distinguishes "excluded" from "trivially zero".
        mutator.setRecycleBucketRaw(40e18);
        mutator.setRecycleCreditedCumulativeRaw(40e18);
        (uint256 dayNow, ) = InteractionRewardsLensFacet(address(diamond))
            .getInteractionCurrentDay();
        uint256 dayBucketBefore = cfg.getRecycledCreditedByDay(dayNow);
        uint256 reportedBefore = cfg.getRecycleCreditedCumulative();
        assertEq(reportedBefore, 40e18, "precondition: genuine absorption");

        // Base tops up 23 recycled inside a 30-token delivery.
        _d6(address(vpfiTok), 30e18, _days(3), CHAIN_BASE, 42, address(0xBA5E), 23e18, 0, bytes32(0));

        // Bucket grew by exactly the recycled share — the claim path is backed.
        assertEq(cfg.getRecycleBucket(), 63e18, "bucket takes the top-up");
        // ...but neither Ā-feeding figure moved.
        assertEq(
            cfg.getRecycledCreditedByDay(dayNow),
            dayBucketBefore,
            "day-bucket (A-bar's per-day feed) untouched"
        );
        assertEq(
            cfg.getRecycleCreditedCumulative(),
            reportedBefore,
            "reported cumulative untouched despite the bucket growing"
        );

        (uint256 relocated, uint256 bucket, uint256 reported) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCustodyPosition();
        assertEq(relocated, 23e18, "custody counter records the relocation");
        assertEq(bucket, 63e18, "position reports the live bucket");
        assertEq(reported, 40e18, "position reports the netted cumulative");
    }

    /// @dev THE load-bearing invariant (design record §2f.2). Base derives a
    ///      mirror's committable local funding from `reported`, net of the
    ///      claim and repatriation draws ({LibVpfiRecycle.mirrorAvailRecycled}
    ///      owns the operand order). If
    ///      relocated custody reached `reported`, Base would re-offer its own
    ///      already-spent top-up as that mirror's OWN funding and commit it
    ///      twice. The exclusion must survive the tokens being CONSUMED,
    ///      because `creditedCumulative` derives a floor from
    ///      `recycleBucket + paidOutRecycled` — consuming moves the custody
    ///      value from one term of that sum into the other.
    function test_D5_ReportedCumulativeSurvivesConsume_NoPhantomAvailability()
        public
    {
        _configureMirror();
        ConfigFacet cfg = ConfigFacet(address(diamond));

        mutator.setRecycleBucketRaw(40e18);
        mutator.setRecycleCreditedCumulativeRaw(40e18);

        _d6(address(vpfiTok), 23e18, _days(3), CHAIN_BASE, 42, address(0xBA5E), 23e18, 0, bytes32(0));
        assertEq(cfg.getRecycleBucket(), 63e18, "backed");

        // The mirror's claims now consume the WHOLE recycled payout — the
        // 40 it absorbed itself plus the 23 Base delivered.
        mutator.consumeRecycleRaw(63e18);
        assertEq(cfg.getRecycleBucket(), 0, "bucket drained by claims");

        // The reported cumulative must still be 40: this chain absorbed 40,
        // full stop. Without the custody subtraction the derived floor
        // (`0 + 63`) would report 63 and hand Base 23 of phantom
        // availability on the very next day.
        assertEq(
            cfg.getRecycleCreditedCumulative(),
            40e18,
            "reports only GENUINE absorption after the custody tokens are consumed"
        );
    }

    /// @dev A payload cannot claim more recycled backing than it delivered —
    ///      the Diamond's own bound, independent of the receiver's scaling.
    function test_D5_Ingress_RejectsRecycledShareAboveDelivery() public {
        _configureMirror();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RecycledShareExceedsDelivery.selector,
                8e18,
                7e18
            )
        );
        _d6(address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 42, address(0xBA5E), 8e18, 0, bytes32(0));
    }

    /// @dev A delivery naming no recycled share relocates NO custody: the
    ///      bucket is credited only by what the wire states as recycled.
    function test_D5_ZeroRecycledShare_RelocatesNoCustody() public {
        _configureMirror();
        ConfigFacet cfg = ConfigFacet(address(diamond));
        mutator.setRecycleBucketRaw(40e18);

        _d6(address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 0, address(0xBA5E), 0, 0, bytes32(0));

        assertEq(cfg.getRecycleBucket(), 40e18, "bucket unchanged");
        (uint256 relocated, , ) = RewardAggregatorFacet(address(diamond))
            .getRecycleCustodyPosition();
        assertEq(relocated, 0, "no custody relocated");
    }

    /// @dev #1446 — the mirror half, and the case the check exists for.
    ///      Relocated custody raises the bucket without advancing the
    ///      reported cumulative; if `creditCustodyRelocated` ever ALSO
    ///      advanced `recycleCreditedCumulative`, the left side of the
    ///      composition bound would jump by twice the credit against a right
    ///      side that moved once. Comparing the reported figure against
    ///      Base's copy cannot see that — both derive from the same helper.
    function test_Composition_HoldsAcrossRelocatedCustodyAndConsume() public {
        _configureMirror();
        mutator.setRecycleBucketRaw(40e18);
        mutator.setRecycleCreditedCumulativeRaw(40e18);
        _assertComposition("mirror genesis");
        _assertDerivation("mirror genesis");

        // Base tops up 23 recycled inside a 30-token delivery.
        _d6(address(vpfiTok), 30e18, _days(3), CHAIN_BASE, 42, address(0xBA5E), 23e18, 0, bytes32(0));
        (uint256 raw, , uint256 relocated, uint256 bucket, , , ) =
            _composition();
        assertEq(relocated, 23e18, "fixture: custody relocated");
        assertEq(bucket, 63e18, "fixture: bucket took the top-up");
        // ORDER IS DELIBERATE: the composition bound is asserted BEFORE the
        // precise `raw` fixture check, because the bound is what
        // `ops/mesh-watcher` actually evaluates — it has no fixture knowledge
        // of what `raw` "should" be. Asserting the fixture first would let a
        // mutation be caught by an oracle the watcher does not have, and this
        // test would then overstate what is externally detectable.
        _assertComposition("after relocation");
        _assertDerivation("after relocation");
        assertEq(raw, 40e18, "the RAW counter must not move on relocation");

        // Consuming moves the custody value from the bucket to the payout
        // figure — the exclusion has to survive that.
        mutator.consumeRecycleRaw(63e18);
        assertEq(
            ConfigFacet(address(diamond)).getRecycleBucket(), 0, "drained"
        );
        _assertComposition("after consuming the relocated tokens");
        _assertDerivation("after consuming the relocated tokens");
    }

    // ─── #1434 P1-a — delivered-fresh accounting ──────────────────────────
    //
    // The counter exists because `poolRemaining()` is not a delivered-funding
    // bound on a mirror (it is the GLOBAL 69M cap less LOCAL payouts, so every
    // mirror believes it owns the whole pool).
    //
    // #1566 closure 2 — it counts the authenticated FRESH component of every
    // COMPOSITION-KNOWN delivery, whatever days it funds (vintage-blind), and
    // records the rest as `uncounted` rather than dropping it. The
    // armed-attributable test that used to gate counting is retired: the paid
    // side now charges legacy and armed outflows alike at the chokepoints, so
    // a receipt for a pre-`D*` day is matched by the spend it funds on the
    // SAME ledger — the double-count finding (b) guarded against cannot arise. There is
    // no subtraction here and no baseline: the first shape of this slice
    // netted a lifetime receipt cumulative against a payout snapshot taken at
    // arming, and baselining one side of a subtraction is what made it
    // unsound (Codex #1556 r1 P1 ×2). What these assert is the attribution
    // rule; the bound that will consume it lands with P1-b, which needs the
    // armed fresh PAID figure the splits do not report today.

    /// @dev The counted case, and the non-vacuity anchor for every negative
    ///      test below: an armed-day delivery whose composition arrived on
    ///      the wire is counted in full.
    function test_DeliveredFresh_CountsArmedAttributableDelivery() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);

        _d6(address(vpfiTok), 7e18, _days(dStar), CHAIN_BASE, 42, address(0xBA5E), 0, 7e18, bytes32(0));

        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 7e18, "armed-day delivery counts in full");
        assertEq(uncounted, 0, "nothing was refused");
    }

    /// @dev **Finding (c).** A wire generation that never carried the split
    ///      arrives with `freshShare == 0`, and the Diamond must NOT infer
    ///      `amount - recycledShare`. The old code did, booking a delivery of
    ///      unknown composition as entirely fresh — over-stating precisely
    ///      where least is known.
    ///
    ///      Non-vacuous by construction: the same fixture, same chain, same
    ///      armed day and same amount is counted in full by the test above.
    ///      The ONLY difference is the declared fresh share.
    function test_DeliveredFresh_UnknownCompositionCountsNothing() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);

        _d6(address(vpfiTok), 7e18, _days(dStar), CHAIN_BASE, 42, address(0xBA5E), 0, 0, bytes32(0));

        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 0, "unknown composition contributes no fresh");
        assertEq(uncounted, 7e18, "and is recorded, not discarded");
    }

    /// @dev **Finding (b), inverted by #1566 closure 2.** Funding delivered
    ///      for PRE-`D*` days now ENTERS the ledger. The withdrawn design's
    ///      defect was counting the receipt while erasing the spend (a payout
    ///      snapshot taken at arming); the vintage rule that replaced it
    ///      refused the receipt instead, which left the pre-arming SPEND
    ///      unbounded — the closure-2 defect. With both sides vintage-blind,
    ///      100 VPFI delivered and spent before arming is 100 received and
    ///      100 paid: zero reusable headroom, and every legacy claim bounded.
    ///
    ///      Both legs run in ONE test so the change cannot pass vacuously:
    ///      the armed-day delivery is counted exactly as before.
    function test_DeliveredFresh_PreArmingDeliveryIsCounted_VintageBlind() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);
        _d6(address(vpfiTok), 3e18, _days(dStar), CHAIN_BASE, 42, address(0xBA5E), 0, 3e18, bytes32(0));
        (uint256 counted, ) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 3e18, "armed-day delivery counts as before");
        _d6(address(vpfiTok), 100e18, _days(dStar - 1), CHAIN_BASE, 43, address(0xBA5E), 0, 100e18, bytes32(0));
        uint256 uncounted;
        (counted, uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 103e18, "pre-arming funding enters the same ledger");
        assertEq(uncounted, 0, "nothing is parked when the composition is stated");
    }

    /// @dev A batch straddling the cutover no longer needs apportioning:
    ///      under the vintage-blind rule (#1566 closure 2) the summed fresh
    ///      share counts whichever side of `D*` each day sits on, so there is
    ///      nothing to guess and nothing to refuse whole. The all-armed pair
    ///      runs beside it so the straddle is shown to be treated identically.
    function test_DeliveredFresh_BatchStraddlingCutoverIsCounted() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);
        _d6(address(vpfiTok), 8e18, _days2(dStar - 1, dStar), CHAIN_BASE, 42, address(0xBA5E), 0, 8e18, bytes32(0));
        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 8e18, "a straddling batch counts its fresh share");
        assertEq(uncounted, 0, "nothing refused");
        _d6(address(vpfiTok), 8e18, _days2(dStar, dStar + 1), CHAIN_BASE, 43, address(0xBA5E), 0, 8e18, bytes32(0));
        (counted, ) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 16e18, "an all-armed batch counts the same way");
    }

    /// @dev An UNARMED mirror counts too (#1566 closure 2): the ledger is live
    ///      on any mirror because its paid side charges legacy outflows, so a
    ///      delivery landing before `D*` is installed is counted by its
    ///      authenticated fresh share. Under the retired rule it was refused;
    ///      refusing it left the legacy claims it funds with a delivered bound
    ///      of zero AND a paid side that never charged, the inconsistency this
    ///      closure removes. (A delivery naming no days at all can no longer
    ///      arrive: the rooted wire refuses an empty extent at ingress.)
    function test_DeliveredFresh_UnarmedChainCounts() public {
        _configureMirror();
        (uint256 baseline, ) = rlens.getDeliveredFreshPosition();
        _d6(address(vpfiTok), 5e18, _days(9), CHAIN_BASE, 42, address(0xBA5E), 0, 5e18, bytes32(0));
        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted - baseline, 5e18, "an unarmed chain counts its fresh share");
        assertEq(uncounted, 0, "nothing refused");
    }

    /// @dev Only the FRESH component accrues. The recycled component is
    ///      bounded separately — it credits the bucket as relocated custody
    ///      (B2-d5) — so counting it here would double-count backing. The
    ///      two counters still account for the whole non-recycled remainder.
    function test_DeliveredFresh_ExcludesRecycledComponent() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);
        // Back the relocated-custody credit: {creditCustodyRelocated} asserts
        // `balance >= bucket + share`, so the tokens must really be here.
        vpfiTok.transfer(address(diamond), 10e18);

        _d6(address(vpfiTok), 10e18, _days(dStar), CHAIN_BASE, 43, address(0xBA5E), 4e18, 6e18, bytes32(0));

        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 6e18, "10 delivered, 4 recycled -> 6 fresh");
        assertEq(uncounted, 0, "the remainder was fully attributed");
    }

    /// @dev The accounting identity the pair exists to support: across an
    ///      armed-day delivery, a pre-arming one and one carrying recycled
    ///      backing, `counted + uncounted` equals the summed NON-RECYCLED
    ///      delivery. Nothing is invented and nothing is lost — which is what
    ///      makes `uncounted` usable for reconciliation rather than a hint.
    ///      #1566 closure 2 — the pre-arming delivery is COUNTED now, so the
    ///      identity holds with `uncounted` at zero; an unstated composition
    ///      is the only thing that lands there (see the finding-(c) test).
    function test_DeliveredFresh_CountedPlusUncountedIsExhaustive() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);
        vpfiTok.transfer(address(diamond), 4e18);

        _d6(address(vpfiTok), 7e18, _days(dStar), CHAIN_BASE, 42, address(0xBA5E), 0, 7e18, bytes32(0));
        _d6(address(vpfiTok), 5e18, _days(dStar - 2), CHAIN_BASE, 43, address(0xBA5E), 0, 5e18, bytes32(0));
        _d6(address(vpfiTok), 9e18, _days(dStar), CHAIN_BASE, 44, address(0xBA5E), 4e18, 5e18, bytes32(0));

        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        // 7 + 5 + 5 = 17 counted, 0 uncounted (vintage-blind); the 4e18
        // recycled leg belongs to the bucket, not to either counter.
        assertEq(counted, 17e18, "all three fresh shares counted, any vintage");
        assertEq(uncounted, 0, "nothing refused when every composition is stated");
        assertEq(
            counted + uncounted,
            (7e18) + (5e18) + (9e18 - 4e18),
            "exhaustive over the non-recycled delivery"
        );
    }

    /// @dev The two shares are bounded JOINTLY. Each is individually no
    ///      larger than the delivery here, and they still sum past it — the
    ///      case a per-share bound would wave through, letting one delivery
    ///      be booked as both relocated recycled custody and armed fresh.
    function test_DeliveredFresh_RevertsWhenSharesJointlyExceedDelivery()
        public
    {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.FreshShareExceedsDelivery.selector, 7e18, 6e18
            )
        );
        _d6(address(vpfiTok), 10e18, _days(dStar), CHAIN_BASE, 45, address(0xBA5E), 4e18, 7e18, bytes32(0));
    }
}
