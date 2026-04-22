// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {EscrowFactoryFacet} from "../../src/facets/EscrowFactoryFacet.sol";
import {VaipakamEscrowImplementation} from "../../src/VaipakamEscrowImplementation.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../../src/facets/VPFIDiscountFacet.sol";
import {StakingRewardsFacet} from "../../src/facets/StakingRewardsFacet.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {HelperTest} from "../HelperTest.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title VPFIStakingRewardMonotonicityInvariant
 * @notice Two monotonicity properties of the Synthetix-style staking
 *         rewards accumulator that hold regardless of how deposits,
 *         withdrawals, claims and time warps are interleaved:
 *
 *           1. `rewardPerTokenStored` is non-decreasing over the lifetime
 *              of the protocol. Every checkpoint advances the counter to
 *              `currentRewardPerToken(now)`, which folds in `dt * APR` and
 *              is therefore monotone in `block.timestamp`. Any decrement
 *              would mean accrued yield was silently clawed back.
 *
 *           2. For each staker, `previewStakingRewards(u)` is non-decreasing
 *              BETWEEN claims — i.e. between two consecutive claims for
 *              that user, the pending counter only grows (new accrual
 *              folds into the previous pending without subtraction).
 *              Claims are the only reset path; the handler tags each
 *              successful claim so the invariant knows when a drop is
 *              legitimate.
 *
 *         Catches regressions in `LibStakingRewards.updateUser`,
 *         `currentRewardPerToken`, and `debitClaim` — any of which
 *         could introduce rounding that non-monotonically jiggles the
 *         pending bucket, or a checkpoint order bug that double-counts
 *         and later corrects itself.
 */
contract StakingRewardMonotonicityInvariant is Test {
    VaipakamDiamond public diamond;
    VPFIToken public vpfi;
    StakingMonotonicityHandler public handler;

    function setUp() public {
        address owner = address(this);

        DiamondCutFacet cut = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cut));

        HelperTest helper = new HelperTest();

        AccessControlFacet ac = new AccessControlFacet();
        AdminFacet admin = new AdminFacet();
        EscrowFactoryFacet escrowFacet = new EscrowFactoryFacet();
        ProfileFacet profile = new ProfileFacet();
        VPFITokenFacet vpfiFacet = new VPFITokenFacet();
        VPFIDiscountFacet discount = new VPFIDiscountFacet();
        StakingRewardsFacet staking = new StakingRewardsFacet();
        TestMutatorFacet mutator = new TestMutatorFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](8);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(ac),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAccessControlFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(admin),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(escrowFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getEscrowFactoryFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(profile),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getProfileFacetSelectors()
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(vpfiFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getVPFITokenFacetSelectors()
        });
        cuts[5] = IDiamondCut.FacetCut({
            facetAddress: address(discount),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getVPFIDiscountFacetSelectors()
        });
        cuts[6] = IDiamondCut.FacetCut({
            facetAddress: address(staking),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getStakingRewardsFacetSelectors()
        });
        cuts[7] = IDiamondCut.FacetCut({
            facetAddress: address(mutator),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getTestMutatorFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).setTreasury(address(diamond));

        VaipakamEscrowImplementation escrowImpl = new VaipakamEscrowImplementation();
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        escrowImpl;

        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfi = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        // Fund the diamond with the full staking pool so the pool-cap
        // truncation code path only fires when we deliberately drain it.
        uint256 seed = LibVaipakam.VPFI_STAKING_POOL_CAP + 1_000_000 ether;
        uint256 have = vpfi.balanceOf(address(this));
        if (seed > have) vpfi.mint(address(this), seed - have);
        vpfi.transfer(address(diamond), seed);

        handler = new StakingMonotonicityHandler(address(diamond), address(vpfi));
        for (uint256 i = 0; i < 3; i++) {
            vpfi.mint(handler.actorAt(i), 500_000 ether);
        }

        targetContract(address(handler));
    }

    /// @notice `rewardPerTokenStored` never decreases — any decrement is a
    ///         clawback bug. Compared against the maximum observed during
    ///         the fuzz campaign (the handler updates this ghost after
    ///         every state-mutating action).
    function invariant_RewardPerTokenStoredMonotone() public view {
        uint256 current =
            StakingRewardsFacet(address(diamond)).getStakingRewardPerTokenStored();
        assertGe(
            current,
            handler.maxObservedRpt(),
            "rewardPerTokenStored went backwards"
        );
    }

    /// @notice Between two successive claims by the same user, the user's
    ///         pending bucket is non-decreasing. Drops are allowed only on
    ///         the call that actually executed a claim — the handler sets a
    ///         per-actor flag when that happens and the invariant skips
    ///         the check for that actor on the flagged tick.
    function invariant_PerUserPendingGrowsBetweenClaims() public view {
        for (uint256 i = 0; i < 3; i++) {
            if (handler.lastActionClaimed(i)) continue;
            address user = handler.actorAt(i);
            uint256 pending =
                StakingRewardsFacet(address(diamond)).previewStakingRewards(user);
            assertGe(
                pending,
                handler.maxObservedPending(i),
                "pending reward decreased without a claim"
            );
        }
    }
}

/**
 * @dev Fuzz handler — deposit / withdraw / claim / warp across 3 actors,
 *      plus per-action ghost updates so the invariants above have a
 *      handler-maintained baseline to compare against. `lastActionClaimed`
 *      exists so the invariant can skip the "pending must grow" check on
 *      the single tick when the claim actually ran.
 */
contract StakingMonotonicityHandler is Test {
    address public immutable diamond;
    VPFIToken public immutable vpfi;

    address[3] internal actors;

    uint256 public maxObservedRpt;
    uint256[3] public maxObservedPending;
    // Set to true on the tick that a claim succeeded for this actor;
    // cleared at the start of every other action so the next invariant
    // evaluation resumes monotonicity enforcement.
    bool[3] public lastActionClaimed;

    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public claims;
    uint256 public warps;

    constructor(address _diamond, address _vpfi) {
        diamond = _diamond;
        vpfi = VPFIToken(_vpfi);
        actors[0] = makeAddr("stake-monotone-0");
        actors[1] = makeAddr("stake-monotone-1");
        actors[2] = makeAddr("stake-monotone-2");
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i % 3];
    }

    function _clearClaimFlags() internal {
        lastActionClaimed[0] = false;
        lastActionClaimed[1] = false;
        lastActionClaimed[2] = false;
    }

    function _captureRptAndPending() internal {
        uint256 rpt =
            StakingRewardsFacet(diamond).getStakingRewardPerTokenStored();
        if (rpt > maxObservedRpt) maxObservedRpt = rpt;
        for (uint256 i = 0; i < 3; i++) {
            uint256 p = StakingRewardsFacet(diamond).previewStakingRewards(actors[i]);
            if (p > maxObservedPending[i]) maxObservedPending[i] = p;
        }
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        _clearClaimFlags();
        address user = actors[actorSeed % 3];
        amount = bound(amount, 1 ether, 100_000 ether);
        if (vpfi.balanceOf(user) < amount) {
            _captureRptAndPending();
            return;
        }
        vm.startPrank(user);
        vpfi.approve(diamond, amount);
        try VPFIDiscountFacet(diamond).depositVPFIToEscrow(amount) {
            deposits++;
        } catch {}
        vm.stopPrank();
        _captureRptAndPending();
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        _clearClaimFlags();
        address user = actors[actorSeed % 3];
        uint256 staked = StakingRewardsFacet(diamond).getUserStakedVPFI(user);
        if (staked == 0) {
            _captureRptAndPending();
            return;
        }
        amount = bound(amount, 1, staked);
        vm.prank(user);
        try VPFIDiscountFacet(diamond).withdrawVPFIFromEscrow(amount) {
            withdrawals++;
        } catch {}
        _captureRptAndPending();
    }

    function claim(uint256 actorSeed) external {
        _clearClaimFlags();
        uint256 idx = actorSeed % 3;
        address user = actors[idx];
        vm.prank(user);
        try StakingRewardsFacet(diamond).claimStakingRewards() {
            claims++;
            // A successful claim is the only path that can legitimately
            // reduce pending below the prior maximum. Reset the ghost for
            // that actor and flag the tick so the invariant skips once.
            maxObservedPending[idx] = 0;
            lastActionClaimed[idx] = true;
        } catch {}
        // RPT itself only moves forward; still update max.
        uint256 rpt =
            StakingRewardsFacet(diamond).getStakingRewardPerTokenStored();
        if (rpt > maxObservedRpt) maxObservedRpt = rpt;
    }

    function warp(uint256 dt) external {
        _clearClaimFlags();
        dt = bound(dt, 1 hours, 30 days);
        vm.warp(block.timestamp + dt);
        warps++;
        _captureRptAndPending();
    }
}
