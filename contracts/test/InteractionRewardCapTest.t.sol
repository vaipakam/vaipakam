// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title InteractionRewardCapTest
/// @notice Coverage for the §4 per-user daily VPFI cap
///         (docs/TokenomicsTechSpec.md): 0.5 VPFI per 0.001 ETH of
///         eligible interest, applied independently on the lender and
///         borrower sides each day. The cap is admin-configurable via
///         {InteractionRewardsFacet.setInteractionCapVpfiPerEth}.
///
///         These tests DIRECTLY seed the ETH/USD Chainlink feed slot
///         via the test mutator so the cap branch engages — the broader
///         {InteractionRewardsCoverageTest} suite leaves `ethNumeraireFeed`
///         unset so it exercises the proportional (uncapped) path. The
///         cap helper fails open when the feed is unset, which keeps
///         the uncapped coverage valid without changes.
contract InteractionRewardCapTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    InteractionRewardsFacet internal interactionFacet;
    MockChainlinkAggregator internal ethNumeraireFeed;

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;
    // ETH/USD = $4,000 with 8-decimal feed.
    int256  internal constant ETH_USD_RAW = 4_000 * 1e8;
    uint8   internal constant ETH_USD_DEC = 8;

    address internal alice;

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfi = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);

        interactionFacet = new InteractionRewardsFacet();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(interactionFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getInteractionRewardsFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        ethNumeraireFeed = new MockChainlinkAggregator(
            ETH_USD_RAW,
            block.timestamp,
            ETH_USD_DEC
        );
        _mut().setEthUsdFeedRaw(address(ethNumeraireFeed));

        alice = makeAddr("alice");
        _facet().setInteractionLaunchTimestamp(block.timestamp);
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _halfPool(uint256 day) internal view returns (uint256) {
        return _facet().getInteractionHalfPoolForDay(day);
    }

    /// @dev Expected per-side cap for a user holding `interestUSD18` on
    ///      the branch under test, at the test harness's ETH/USD price.
    function _expectedCap(uint256 interestUSD18, uint256 capRatio)
        internal
        pure
        returns (uint256)
    {
        return
            (interestUSD18 * (10 ** uint256(ETH_USD_DEC)) * capRatio) /
            uint256(ETH_USD_RAW);
    }

    // ─── Default cap engages when the proportional payout would exceed it ────

    /// @notice Alice is the only lender on day 1 with a TINY USD share,
    ///         so the proportional formula would hand her the full
    ///         half-pool (~10k VPFI on day 1). The §4 cap at $1 of
    ///         interest is ~0.125 VPFI — that is what she must receive.
    function testDefaultCapTruncatesSingleLenderPayout() public {
        uint256 interestUSD18 = 1e18; // $1
        _mut().setDailyLenderInterest(1, alice, interestUSD18, interestUSD18);

        vm.warp(block.timestamp + 2 days + 1);

        uint256 cap = _expectedCap(
            interestUSD18,
            LibVaipakam.INTERACTION_CAP_DEFAULT_VPFI_PER_ETH
        );
        uint256 rawShare = _halfPool(1);
        assertGt(rawShare, cap, "sanity: raw share > cap for this fixture");

        uint256 preview = _previewAmount(alice);
        assertEq(preview, cap, "preview reflects the cap");

        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, cap, "paid == cap, not the unbounded share");
    }

    /// @notice At $0.001 of interest the cap formula resolves to
    ///         0.000125 VPFI — matches the spec's "0.5 VPFI per 0.001 ETH"
    ///         ratio at an ETH price of $4,000. Uses the concrete
    ///         arithmetic path so a future rearrangement of the formula
    ///         can't silently change the cap value.
    function testCapMatchesSpecRatioAtKnownEthPrice() public {
        // $0.001 of interest → 0.00000025 ETH → 0.000125 VPFI cap.
        uint256 interestUSD18 = 1e15;
        _mut().setDailyLenderInterest(1, alice, interestUSD18, interestUSD18);

        vm.warp(block.timestamp + 2 days + 1);

        // Derived manually: 1e15 * 1e8 * 500 / (4000 * 1e8)
        //                 = 1e15 * 500 / 4000
        //                 = 1.25e14
        uint256 expectedCap = 1.25e14;
        uint256 formula = _expectedCap(
            interestUSD18,
            LibVaipakam.INTERACTION_CAP_DEFAULT_VPFI_PER_ETH
        );
        assertEq(formula, expectedCap, "formula matches hand-computed cap");

        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, expectedCap, "claim pays the spec-defined cap");
    }

    // ─── Cap applies independently on lender + borrower sides ──────────────

    /// @notice Alice holds BOTH sides on day 1 with tiny USD totals, so
    ///         both branches hit the cap. Paid must equal 2 × single-side
    ///         cap — NOT double-dip one side's numerator into the other.
    function testCapAppliesPerSideIndependently() public {
        uint256 interestUSD18 = 1e18;
        _mut().setDailyLenderInterest(1, alice, interestUSD18, interestUSD18);
        _mut().setDailyBorrowerInterest(1, alice, interestUSD18, interestUSD18);

        vm.warp(block.timestamp + 2 days + 1);

        uint256 sideCap = _expectedCap(
            interestUSD18,
            LibVaipakam.INTERACTION_CAP_DEFAULT_VPFI_PER_ETH
        );

        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, sideCap * 2, "2x cap across lender + borrower branches");
    }

    // ─── Cap is inert when proportional share is already below it ──────────

    /// @notice Two lenders split the day's half-pool. When each lender's
    ///         ETH-denominated interest × 500 VPFI/ETH comfortably exceeds
    ///         their proportional share, the min() resolves to the share
    ///         and the behaviour matches the uncapped path bit-for-bit.
    function testCapNoOpsWhenShareBelowCeiling() public {
        // $50,000 at $4,000/ETH → 12.5 ETH → cap = 6,250 VPFI.
        // Day-1 half-pool ≈ 10,082 VPFI; two lenders split it 50/50 so
        // each gets ~5,041 VPFI — well under cap.
        uint256 userUSD18 = 50_000 * 1e18;
        uint256 totalUSD18 = userUSD18 * 2;
        _mut().setDailyLenderInterest(1, alice, userUSD18, totalUSD18);

        vm.warp(block.timestamp + 2 days + 1);

        uint256 cap = _expectedCap(
            userUSD18,
            LibVaipakam.INTERACTION_CAP_DEFAULT_VPFI_PER_ETH
        );
        uint256 expectedShare = (_halfPool(1) * userUSD18) / totalUSD18;
        assertLt(expectedShare, cap, "sanity: share < cap for this fixture");

        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, expectedShare, "uncapped proportional share paid");
    }

    // ─── Admin configurability ─────────────────────────────────────────────

    /// @notice Admin doubles the VPFI-per-ETH ratio; the effective cap
    ///         doubles and a previously-capped claim pays 2× as much
    ///         (still clamped by the raw proportional share in case the
    ///         new cap exceeds it).
    function testAdminCanRaiseCap() public {
        uint256 interestUSD18 = 1e18;
        _mut().setDailyLenderInterest(1, alice, interestUSD18, interestUSD18);

        uint256 newRatio = LibVaipakam.INTERACTION_CAP_DEFAULT_VPFI_PER_ETH * 2;
        _facet().setInteractionCapVpfiPerEth(newRatio);
        assertEq(
            _facet().getInteractionCapVpfiPerEth(),
            newRatio,
            "effective cap reflects override"
        );

        vm.warp(block.timestamp + 2 days + 1);

        uint256 raw = _halfPool(1);
        uint256 cap = _expectedCap(interestUSD18, newRatio);
        uint256 expected = raw < cap ? raw : cap;

        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, expected, "new cap applied at claim time");
    }

    /// @notice Admin lowers the ratio to 100 VPFI/ETH; the cap falls to
    ///         1/5 of the default, and a tiny-USD claim shrinks
    ///         proportionally.
    function testAdminCanLowerCap() public {
        uint256 interestUSD18 = 1e18;
        _mut().setDailyLenderInterest(1, alice, interestUSD18, interestUSD18);

        uint256 lowerRatio = 100; // 0.1 VPFI per 0.001 ETH (1/5 of default).
        _facet().setInteractionCapVpfiPerEth(lowerRatio);

        vm.warp(block.timestamp + 2 days + 1);

        uint256 cap = _expectedCap(interestUSD18, lowerRatio);
        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, cap, "lower cap enforced");
    }

    /// @notice Passing the uint256-max sentinel disables the cap
    ///         entirely (emergency knob). The user then receives the
    ///         full proportional share regardless of how small their
    ///         USD interest was.
    function testCapCanBeDisabledBySentinel() public {
        uint256 interestUSD18 = 1e18;
        _mut().setDailyLenderInterest(1, alice, interestUSD18, interestUSD18);

        _facet().setInteractionCapVpfiPerEth(type(uint256).max);

        vm.warp(block.timestamp + 2 days + 1);

        uint256 expected = _halfPool(1); // sole lender → full half-pool.
        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, expected, "uncapped payout once cap disabled");
    }

    /// @notice Setting the override back to zero restores the default
    ///         ratio — transparency view reflects both the raw and the
    ///         resolved value.
    function testOverrideZeroFallsBackToDefault() public {
        _facet().setInteractionCapVpfiPerEth(777); // arbitrary nonzero
        assertEq(_facet().getInteractionCapVpfiPerEthRaw(), 777);
        _facet().setInteractionCapVpfiPerEth(0);
        assertEq(_facet().getInteractionCapVpfiPerEthRaw(), 0, "raw cleared");
        assertEq(
            _facet().getInteractionCapVpfiPerEth(),
            LibVaipakam.INTERACTION_CAP_DEFAULT_VPFI_PER_ETH,
            "effective value uses default"
        );
    }

    // ─── Fail-open: oracle failure disables the cap ─────────────────────────

    /// @notice When the ETH/USD feed returns a zero/negative answer,
    ///         {_capVPFIForInterestUSD} returns the uint256-max sentinel
    ///         so the cap branch short-circuits. Matches the graceful-
    ///         degradation pattern in {_interestToUSD18} — keeps claim
    ///         flows live during a transient oracle hiccup. The 69M
    ///         pool hard cap still bounds total emissions.
    function testOracleFailureDisablesCap() public {
        uint256 interestUSD18 = 1e18;
        _mut().setDailyLenderInterest(1, alice, interestUSD18, interestUSD18);

        // Force the mock to report a zero answer so the helper falls
        // through the `answer <= 0` guard.
        ethNumeraireFeed.setAnswer(0);

        vm.warp(block.timestamp + 2 days + 1);

        uint256 expected = _halfPool(1);
        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, expected, "cap skipped when oracle read fails");
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    function _previewAmount(address user) internal view returns (uint256 amount) {
        (amount,,) = _facet().previewInteractionRewards(user);
    }
}
