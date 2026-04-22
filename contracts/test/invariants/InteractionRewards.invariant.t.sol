// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../../src/facets/InteractionRewardsFacet.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {HelperTest} from "../HelperTest.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title InteractionRewardsInvariant
 * @notice Phase-1 interaction rewards (docs/TokenomicsTechSpec.md §4) are
 *         gated by three hard accounting invariants regardless of how the
 *         fuzzer scripts the seed/warp/claim sequence:
 *
 *           1. `interactionPoolPaidOut <= VPFI_INTERACTION_POOL_CAP`.
 *           2. `interactionPoolPaidOut` is monotonically non-decreasing.
 *           3. `interactionLastClaimedDay[user] < currentDay` always
 *              (cursor never walks past the last finalized day).
 *           4. Sum of users' tracked wallet gains equals `paidOut` (all
 *              transfers came out of the pool, none from thin air).
 */
contract InteractionRewardsInvariant is Test {
    VaipakamDiamond public diamond;
    VPFIToken public vpfi;
    InteractionHandler public handler;

    uint256 public constant POOL_SEED =
        LibVaipakam.VPFI_INTERACTION_POOL_CAP + 1_000_000 ether;

    function setUp() public {
        address owner = address(this);

        DiamondCutFacet cut = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cut));

        HelperTest helper = new HelperTest();

        AccessControlFacet ac = new AccessControlFacet();
        AdminFacet admin = new AdminFacet();
        VPFITokenFacet vpfiFacet = new VPFITokenFacet();
        InteractionRewardsFacet interaction = new InteractionRewardsFacet();
        TestMutatorFacet mutator = new TestMutatorFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](5);
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
            facetAddress: address(vpfiFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getVPFITokenFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(interaction),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getInteractionRewardsFacetSelectors()
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(mutator),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getTestMutatorFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).setTreasury(address(diamond));

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
        if (POOL_SEED > have) vpfi.mint(address(this), POOL_SEED - have);
        vpfi.transfer(address(diamond), POOL_SEED);

        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );

        handler = new InteractionHandler(address(diamond), address(vpfi));
        targetContract(address(handler));
    }

    // ─── Invariants ──────────────────────────────────────────────────────────

    function invariant_PaidOutRespectsCap() public view {
        uint256 paidOut = InteractionRewardsFacet(address(diamond))
            .getInteractionPoolPaidOut();
        assertLe(
            paidOut,
            LibVaipakam.VPFI_INTERACTION_POOL_CAP,
            "interactionPoolPaidOut exceeded 69M cap"
        );
    }

    function invariant_PaidOutMonotonic() public view {
        uint256 paidOut = InteractionRewardsFacet(address(diamond))
            .getInteractionPoolPaidOut();
        assertGe(
            paidOut,
            handler.observedMaxPaidOut(),
            "interactionPoolPaidOut went backwards"
        );
    }

    function invariant_CursorStrictlyBehindToday() public view {
        (uint256 today, bool active) = InteractionRewardsFacet(address(diamond))
            .getInteractionCurrentDay();
        if (!active || today == 0) return;
        for (uint256 i = 0; i < 3; i++) {
            uint256 cursor = InteractionRewardsFacet(address(diamond))
                .getInteractionLastClaimedDay(handler.actorAt(i));
            assertLt(cursor, today, "cursor walked past today");
        }
    }

    function invariant_SumWalletGainsEqualsPaidOut() public view {
        uint256 sum;
        for (uint256 i = 0; i < 3; i++) {
            sum += vpfi.balanceOf(handler.actorAt(i));
        }
        uint256 paidOut = InteractionRewardsFacet(address(diamond))
            .getInteractionPoolPaidOut();
        assertEq(sum, paidOut, "user wallets != paidOut");
    }
}

/**
 * @dev Fuzz handler for the interaction-pool invariants. Seeds per-day USD
 *      counters, warps time, and claims. Each call either succeeds or is
 *      swallowed — the invariant suite checks post-state after every fuzz
 *      action.
 */
contract InteractionHandler is Test {
    address public diamond;
    VPFIToken public vpfi;

    address[3] internal actors;

    uint256 public seeds;
    uint256 public claims;
    uint256 public warps;
    uint256 public observedMaxPaidOut;

    constructor(address _diamond, address _vpfi) {
        diamond = _diamond;
        vpfi = VPFIToken(_vpfi);
        actors[0] = makeAddr("iactor0");
        actors[1] = makeAddr("iactor1");
        actors[2] = makeAddr("iactor2");
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i % 3];
    }

    function _tick() internal {
        uint256 p = InteractionRewardsFacet(diamond).getInteractionPoolPaidOut();
        if (p > observedMaxPaidOut) observedMaxPaidOut = p;
    }

    /// @notice Seed today-relative day counters for lender interest. Kept
    ///         bounded so the handler can't push paidOut beyond the cap in
    ///         a single tick (each day's halfPool is deterministic from the
    ///         schedule; we merely bound the USD shares).
    function seedLender(
        uint256 actorSeed,
        uint256 daySeed,
        uint256 userUSD,
        uint256 totalUSD
    ) external {
        address user = actors[actorSeed % 3];
        (uint256 today, bool active) = InteractionRewardsFacet(diamond)
            .getInteractionCurrentDay();
        if (!active) return;
        uint256 d = daySeed % (today + 1);
        userUSD = bound(userUSD, 1e18, 1_000e18);
        totalUSD = bound(totalUSD, userUSD, userUSD * 4);

        try TestMutatorFacet(diamond).setDailyLenderInterest(
            d,
            user,
            userUSD,
            totalUSD
        ) {
            seeds++;
        } catch {}
    }

    function seedBorrower(
        uint256 actorSeed,
        uint256 daySeed,
        uint256 userUSD,
        uint256 totalUSD
    ) external {
        address user = actors[actorSeed % 3];
        (uint256 today, bool active) = InteractionRewardsFacet(diamond)
            .getInteractionCurrentDay();
        if (!active) return;
        uint256 d = daySeed % (today + 1);
        userUSD = bound(userUSD, 1e18, 1_000e18);
        totalUSD = bound(totalUSD, userUSD, userUSD * 4);

        try TestMutatorFacet(diamond).setDailyBorrowerInterest(
            d,
            user,
            userUSD,
            totalUSD
        ) {
            seeds++;
        } catch {}
    }

    function claim(uint256 actorSeed) external {
        address user = actors[actorSeed % 3];
        vm.prank(user);
        try InteractionRewardsFacet(diamond).claimInteractionRewards() {
            claims++;
        } catch {}
        _tick();
    }

    /// @notice Advance time by up to 30 days so finalized-day windows grow
    ///         and cross the 8-band schedule cutoffs.
    function warp(uint256 dt) external {
        dt = bound(dt, 1 hours, 30 days);
        vm.warp(block.timestamp + dt);
        warps++;
    }
}
