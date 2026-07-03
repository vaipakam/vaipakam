// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORED IN A NO-FORGE ENVIRONMENT — NOT EXECUTED HERE.
// Run with:
//   nice -n -10 ionice -c 2 -n 0 forge test \
//     --match-path test/audit/Round3RewardsCrossChainPoC.t.sol -vvv
//
// Two Round-3 findings, each as a self-contained PoC that mirrors the existing
// passing suites' harness verbatim (SetupTest base, VPFI-token wiring copied
// from InteractionRewardsCoverageTest / CrossChainTierPropagationIntegrationTest,
// the MockCcipRouter stub pattern copied from CcipMessengerTest):
//
//   • H3 — `sweepForfeitedInteractionRewards(loanId)` is permissionless and
//     routes a CLOSED-CLEAN borrower reward entry through `_processEntry(mutate=true)`,
//     which stamps `processed = true` while DISCARDING the `toUser` payout
//     (the sweep only keeps the `toTreasury` leg). A third party can therefore
//     silently DESTROY a well-behaved borrower's interaction reward: nothing
//     goes to the borrower, nothing goes to treasury — the VPFI is simply
//     un-claimable forever. See LibInteractionRewards.sweepForfeitedByLoanId +
//     _processEntry.
//
//   • M6 — a tier-changing VPFI stake mutation (`depositVPFIToVault` /
//     `withdrawVPFIFromVault`) fires a synchronous cross-chain tier broadcast
//     through ProtocolBroadcastFacet → VaipakamRewardMessenger → CcipMessenger.
//     There is NO try/catch on that path (by design — "fail CLOSED"), so if a
//     destination lane is unconfigured/unsupported at the CCIP router, or the
//     protocol broadcast budget is empty, the revert bubbles all the way back
//     and FREEZES core staking. A single downed lane bricks stake/unstake.
// ─────────────────────────────────────────────────────────────────────────────

import {SetupTest} from "../SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../../src/facets/VPFIDiscountFacet.sol";
import {ProtocolBroadcastFacet} from "../../src/facets/ProtocolBroadcastFacet.sol";
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";
import {InteractionRewardsFacet} from "../../src/facets/InteractionRewardsFacet.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

import {CcipMessenger} from "../../src/crosschain/CcipMessenger.sol";
import {VaipakamRewardMessenger} from "../../src/crosschain/VaipakamRewardMessenger.sol";
import {MockCcipRouter} from "../mocks/MockCcipRouter.sol";

// ═════════════════════════════════════════════════════════════════════════════
// H3 — permissionless sweep destroys a clean borrower's interaction reward
// ═════════════════════════════════════════════════════════════════════════════

/// @title Round3RewardsH3PoC
/// @notice Regression PoC for finding H3. A borrower earns an interaction
///         reward entry over a loan, repays cleanly (so the entry is CLOSED
///         and NON-forfeited but its per-loan pointer `loanBorrowerEntryId`
///         is deliberately retained — see LibInteractionRewards.closeLoan),
///         then a THIRD PARTY calls the permissionless
///         `sweepForfeitedInteractionRewards(loanId)`. The sweep finds nothing
///         legitimately forfeitable (returns 0 to treasury) yet flips the
///         borrower's clean entry to `processed = true`, so the borrower's own
///         later claim reverts with nothing left. The reward is destroyed.
contract Round3RewardsH3PoC is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;

    // ≥ the 69M interaction-pool cap + slack, matching the coverage suites.
    uint256 internal constant DIAMOND_VPFI_SEED = 100_000_000 ether;

    // Loan sizing copied from VPFIDiscountFacetTest._createLenderErc20Offer.
    uint256 internal constant PRINCIPAL = 10_000 ether;

    uint256 internal loanId;
    address internal attacker;

    function setUp() public {
        setupHelper();

        // ── VPFI token deploy + canonical-chain wiring (verbatim from the
        //    InteractionRewards coverage suites) ──────────────────────────
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
        if (DIAMOND_VPFI_SEED > have) {
            vpfi.mint(address(this), DIAMOND_VPFI_SEED - have);
        }
        vpfi.transfer(address(diamond), DIAMOND_VPFI_SEED);

        // Emissions must be live BEFORE the loan is initiated so
        // LibInteractionRewards.registerLoan books the borrower entry.
        _ir().setInteractionLaunchTimestamp(block.timestamp); // day 0

        // ── Create + accept a plain ERC20 loan → registers a borrower-side
        //    reward entry (startDay 1, endDay 1 + durationDays) ────────────
        uint256 offerId = _createLenderErc20Offer(PRINCIPAL);
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // ── Clean full repayment by the borrower BEFORE maturity → the
        //    borrower reward entry closes with forfeited = false and its
        //    `loanBorrowerEntryId` pointer is retained (RepayFacet L514-516
        //    → LibInteractionRewards.closeLoan(borrowerClean = true)) ───────
        vm.warp(block.timestamp + 5 days); // today = day 5
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId); // entry endDay → 6

        // Let the reward days finalize (§4a cross-chain gate). We seed the
        // GLOBAL denominators only — NOT the per-user legacy counters — so the
        // ENTRY-path claim is the sole reward source under test. Seeding a
        // contiguous finalized prefix (days 1..12) lets the cumulative-
        // reward-per-USD cursor advance through the entry window (need = 5).
        vm.warp(block.timestamp + 5 days); // today = day 10
        for (uint256 d = 1; d <= 12; ++d) {
            // (day, lenderTotalNumeraire18, borrowerTotalNumeraire18, isSet)
            _mut().setKnownGlobalDailyInterest(d, 1_000e18, 1_000e18, true);
        }

        attacker = makeAddr("attacker");
    }

    // ── Control: with NO sweep, the borrower's clean entry pays out (> 0).
    //    Establishes that the entry genuinely carries a positive reward, so
    //    the bug test's "reward is gone" is a real loss, not a no-op. GREEN.
    function test_H3_control_CleanBorrowerIsPaidWhenNotSwept() public {
        vm.prank(borrower);
        (uint256 paid, , ) = _ir().claimInteractionRewards();
        assertGt(paid, 0, "clean borrower is owed a positive interaction reward");
    }

    // ── Bug: a third party sweeps first, silently consuming the clean
    //    borrower's entry. Treasury receives 0 (nothing was forfeitable) AND
    //    the borrower can no longer claim — the reward is destroyed. GREEN on
    //    the buggy code; the comment marks the CORRECT expectation.
    function test_H3_bug_PermissionlessSweepDestroysCleanBorrowerReward()
        public
    {
        uint256 treasuryBefore = vpfi.balanceOf(_treasury());

        // Anyone can call this — no role gate.
        vm.prank(attacker);
        uint256 swept = _ir().sweepForfeitedInteractionRewards(loanId);

        // The sweep moved nothing to treasury (a CLEAN loan has nothing to
        // forfeit) — proving this was a pure destruction, not a re-route.
        assertEq(swept, 0, "clean loan sweep routes nothing to treasury");
        assertEq(
            vpfi.balanceOf(_treasury()),
            treasuryBefore,
            "treasury balance unchanged by the sweep"
        );

        // The borrower's own entry is now `processed = true`, so their claim
        // reverts with nothing left to collect. Their VPFI reward is gone.
        //
        // CORRECT EXPECTATION (documents the bug): the sweep of a clean loan
        // MUST be a harmless no-op, and this claim MUST still pay the borrower
        // in full — i.e. it should return the same `paid > 0` the control test
        // observes, NOT revert.
        vm.prank(borrower);
        vm.expectRevert(NoInteractionRewardsToClaim.selector);
        _ir().claimInteractionRewards();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _ir() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _treasury() internal view returns (address) {
        // SetupTest points the treasury at the diamond itself
        // (`AdminFacet.setTreasury(address(diamond))`). Read it back so the
        // assertion tracks the true sink regardless of that default.
        return AdminFacetLike(address(diamond)).getTreasury();
    }

    /// @dev Verbatim copy of VPFIDiscountFacetTest._createLenderErc20Offer —
    ///      a lender ERC20 offer with mockCollateralERC20 collateral. Both
    ///      assets are liquid + $1-priced in SetupTest, so registerLoan books
    ///      a non-zero `perDayNumeraire18`.
    function _createLenderErc20Offer(uint256 amount) internal returns (uint256) {
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        return
            OfferCreateFacet(address(diamond)).createOffer(
                LibVaipakam.CreateOfferParams({
                    offerType: LibVaipakam.OfferType.Lender,
                    lendingAsset: mockERC20,
                    amount: amount,
                    interestRateBps: 500,
                    collateralAsset: mockCollateralERC20,
                    collateralAmount: amount,
                    durationDays: 30,
                    assetType: LibVaipakam.AssetType.ERC20,
                    tokenId: 0,
                    quantity: 0,
                    creatorRiskAndTermsConsent: true,
                    prepayAsset: mockERC20,
                    collateralAssetType: LibVaipakam.AssetType.ERC20,
                    collateralTokenId: 0,
                    collateralQuantity: 0,
                    allowsPartialRepay: false,
                    allowsPrepayListing: false,
                    allowsParallelSale: false,
                    amountMax: amount,
                    interestRateBpsMax: 500,
                    collateralAmountMax: amount,
                    periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                    expiresAt: 0,
                    fillMode: LibVaipakam.FillMode.Partial,
                    refinanceTargetLoanId: 0,
                    useFullTermInterest: false
                })
            );
    }
}

/// @dev Minimal local view interface for `getTreasury` so the PoC doesn't need
///      to import the whole AdminFacet just for one getter. The selector is
///      routed by SetupTest's diamond.
interface AdminFacetLike {
    function getTreasury() external view returns (address);
}

// ═════════════════════════════════════════════════════════════════════════════
// M6 — a downed cross-chain lane (or an empty broadcast budget) FREEZES staking
// ═════════════════════════════════════════════════════════════════════════════

/// @title Round3RewardsM6PoC
/// @notice Regression PoC for finding M6. Full canonical-Base CCIP scaffolding
///         is stood up exactly as CrossChainTierPropagationIntegrationTest does
///         (real CcipMessenger + VaipakamRewardMessenger over a MockCcipRouter).
///         Once a tier-changing stake resolves to a NEW effective tier it MUST
///         fan out a synchronous CCIP broadcast; there is no try/catch on that
///         path, so any lane/budget failure reverts the stake itself.
contract Round3RewardsM6PoC is SetupTest {
    VPFIToken internal vpfiToken;
    MockCcipRouter internal router;
    CcipMessenger internal messenger;
    VaipakamRewardMessenger internal rewardMsgr;
    address internal user;
    address internal mockMirrorMessenger;

    uint256 internal constant MIRROR_CHAIN = 11_155_111; // Sepolia
    uint64 internal constant SEL_BASE = 15971525489660198786;
    uint64 internal constant SEL_MIRROR = 5009297550715157269;
    bytes32 internal constant CHANNEL =
        keccak256("vaipakam.ccip.channel.vpfi-reward");

    function setUp() public {
        setupHelper();
        user = makeAddr("user");

        // ── VPFI token + canonical-chain wiring ─────────────────────────
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfiToken = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountRate(1e15);

        // ── CCIP scaffolding (mirrors CcipMessengerTest's router stub) ──
        router = new MockCcipRouter();
        router.setSupported(SEL_MIRROR, true);
        router.setSupported(SEL_BASE, true);

        CcipMessenger msgrImpl = new CcipMessenger(address(router));
        messenger = CcipMessenger(
            address(
                new ERC1967Proxy(
                    address(msgrImpl),
                    abi.encodeCall(CcipMessenger.initialize, (address(this)))
                )
            )
        );

        mockMirrorMessenger = makeAddr("mirrorMessenger");

        // ── Reward messenger on Base ────────────────────────────────────
        VaipakamRewardMessenger rmImpl = new VaipakamRewardMessenger();
        rewardMsgr = VaipakamRewardMessenger(
            payable(
                address(
                    new ERC1967Proxy(
                        address(rmImpl),
                        abi.encodeCall(
                            VaipakamRewardMessenger.initialize,
                            (address(this), address(messenger),
                             address(diamond), true /* canonical */,
                             0 /* baseChainId */, 400_000)
                        )
                    )
                )
            )
        );

        messenger.setChainSelector(MIRROR_CHAIN, SEL_MIRROR);
        messenger.setRemoteMessenger(MIRROR_CHAIN, mockMirrorMessenger);
        messenger.registerChannel(CHANNEL, address(rewardMsgr));
        messenger.setChannelPeer(CHANNEL, MIRROR_CHAIN, mockMirrorMessenger);

        uint256[] memory dests = new uint256[](1);
        dests[0] = MIRROR_CHAIN;
        rewardMsgr.setBroadcastDestinations(dests);

        RewardReporterFacet(address(diamond)).setRewardMessenger(address(rewardMsgr));

        // Fund the protocol broadcast budget so the rollup CAN pay the fan-out
        // fee on the happy path. Both M6 tests below break exactly one of the
        // two preconditions (lane up / budget funded) to trigger the freeze.
        vm.deal(address(this), 10 ether);
        ProtocolBroadcastFacet(payable(address(diamond)))
            .topUpBroadcastBudget{value: 1 ether}();
    }

    /// @dev Drives the exact two-step stake CrossChainTierPropagationIntegrationTest
    ///      uses: the FIRST deposit resolves to effective tier 0 (min-history
    ///      gate not yet elapsed) so the broadcast silent-skips; then after the
    ///      3-day gate the tier resolves to 1 and the broadcast MUST fire.
    ///      Returns with the min-history gate elapsed and consent granted, so
    ///      the caller's next tier-changing deposit is guaranteed to broadcast.
    function _primeStakerPastMinHistoryGate() internal {
        uint256 amt = 500 ether; // clears tier 1
        vpfiToken.transfer(user, amt);
        vm.startPrank(user);
        // Consent is required or ProtocolBroadcastFacet forces the tuple to
        // (0,0) and never mirrors — model a consented staker.
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        IERC20(address(vpfiToken)).approve(address(diamond), amt);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(amt);
        vm.stopPrank();
        assertEq(router.pendingCount(), 0, "pre-gate deposit silent-skips");

        // Warp past the min-history gate (default 3 days, +1s for cleanliness).
        vm.warp(block.timestamp + 3 days + 1);
    }

    // ── Bug (lane down): the mirror lane goes UNSUPPORTED at the router.
    //    The next tier-changing stake reverts because the synchronous CCIP
    //    broadcast can no longer resolve the destination. Core staking is
    //    frozen by an outage on a purely peripheral reward-mirror lane.
    function test_M6_bug_DownedLaneFreezesTierChangingStake() public {
        _primeStakerPastMinHistoryGate();

        // Simulate the mirror lane going DOWN at the CCIP router (identical
        // stub CcipMessengerTest uses via `router.setSupported(...)`).
        router.setSupported(SEL_MIRROR, false);

        // A 1-wei top-up now resolves the user's effective tier to 1 and MUST
        // fan out a broadcast — but the lane is unsupported, so
        // CcipMessenger._resolveDestination reverts UnsupportedByRouter(SEL_MIRROR),
        // which bubbles rewardMsgr → ProtocolBroadcastFacet → rollup → deposit.
        vpfiToken.transfer(user, 1);
        vm.startPrank(user);
        IERC20(address(vpfiToken)).approve(address(diamond), 1);
        // Generic expectRevert: the exact bubbled error is
        // CcipMessenger.UnsupportedByRouter(SEL_MIRROR). Kept generic so the
        // PoC is robust to intermediary re-wrapping.
        vm.expectRevert();
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(1);
        vm.stopPrank();

        // CORRECT EXPECTATION (documents the bug): a reward-mirror lane outage
        // MUST NOT be able to revert a core VPFI stake. The broadcast should be
        // best-effort (e.g. queued / try-caught), so this deposit should SUCCEED.
    }

    // ── Bug (empty budget): lane is UP but the protocol broadcast budget is
    //    drained. The fail-CLOSED budget gate reverts the stake with
    //    ProtocolBudgetExhausted — same freeze, different trigger.
    function test_M6_bug_EmptyBroadcastBudgetFreezesTierChangingStake()
        public
    {
        _primeStakerPastMinHistoryGate();

        // Drain the broadcast budget (admin-only; the test contract is owner).
        // `getProtocolBroadcastBudget` reads the live balance seeded in setUp.
        uint256 budget = ProtocolBroadcastFacet(payable(address(diamond)))
            .getProtocolBroadcastBudget();
        ProtocolBroadcastFacet(payable(address(diamond)))
            .withdrawBudget(payable(makeAddr("budgetSink")), budget);

        // Lane is still UP, so the CCIP fee quote succeeds — but the budget
        // (now 0) cannot cover it, so ProtocolBroadcastFacet reverts
        // ProtocolBudgetExhausted and the stake is frozen.
        vpfiToken.transfer(user, 1);
        vm.startPrank(user);
        IERC20(address(vpfiToken)).approve(address(diamond), 1);
        vm.expectRevert(ProtocolBroadcastFacet.ProtocolBudgetExhausted.selector);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(1);
        vm.stopPrank();

        // CORRECT EXPECTATION (documents the bug): an unfunded reward-broadcast
        // budget MUST NOT freeze core staking; the broadcast should degrade
        // gracefully rather than block the deposit.
    }
}
