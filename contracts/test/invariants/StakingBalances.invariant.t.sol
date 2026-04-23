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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title StakingBalancesInvariant
 * @notice Phase-1 staking rewards (docs/TokenomicsTechSpec.md §7) are book-kept
 *         by a reward-per-token accrual inside `LibStakingRewards`. Two hard
 *         ledger invariants hold regardless of how the fuzzer scripts the
 *         deposit/withdraw/claim/warp sequence:
 *
 *           1. `sum(userStakedVPFI[*]) == totalStakedVPFI`  — accounting.
 *           2. `stakingPoolPaidOut <= VPFI_STAKING_POOL_CAP` — pool cap.
 *           3. `stakingPoolPaidOut` is monotonically non-decreasing — pool
 *              rewards are paid out, never clawed back.
 *
 *         The handler drives the three actors through randomised deposits,
 *         withdrawals, claims, and time warps. No assertion fires on any
 *         individual call path; the invariant functions below check the
 *         post-conditions after each fuzz action.
 *
 *         Standalone diamond (no InvariantBase): we only need the
 *         VPFI-related facets plus a test mutator for time jumps.
 */
contract StakingBalancesInvariant is Test {
    VaipakamDiamond public diamond;
    VPFIToken public vpfi;
    StakingHandler public handler;

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

        // Escrow implementation for per-user proxies.
        VaipakamEscrowImplementation escrowImpl = new VaipakamEscrowImplementation();
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        // initializeEscrowImplementation sets the impl to a self-deployed one;
        // we'll let it do so — the default path is fine for our purposes.
        escrowImpl; // silence unused

        // VPFI token + canonical chain registration.
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfi = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        // Fund the diamond with the 55.2M staking pool plus slack.
        uint256 seed = LibVaipakam.VPFI_STAKING_POOL_CAP + 1_000_000 ether;
        uint256 have = vpfi.balanceOf(address(this));
        if (seed > have) vpfi.mint(address(this), seed - have);
        vpfi.transfer(address(diamond), seed);

        handler = new StakingHandler(address(diamond), address(vpfi));
        // Fund the handler's actors with VPFI wallets.
        for (uint256 i = 0; i < 3; i++) {
            vpfi.mint(handler.actorAt(i), 500_000 ether);
        }

        targetContract(address(handler));
    }

    // ─── Invariants ──────────────────────────────────────────────────────────

    function invariant_SumOfUserStakesEqualsTotal() public view {
        uint256 total = StakingRewardsFacet(address(diamond)).getTotalStakedVPFI();
        uint256 sum;
        for (uint256 i = 0; i < 3; i++) {
            sum += StakingRewardsFacet(address(diamond)).getUserStakedVPFI(
                handler.actorAt(i)
            );
        }
        assertEq(sum, total, "sum(userStaked) != totalStaked");
    }

    function invariant_PaidOutRespectsCap() public view {
        uint256 paidOut = StakingRewardsFacet(address(diamond)).getStakingPoolPaidOut();
        assertLe(
            paidOut,
            LibVaipakam.VPFI_STAKING_POOL_CAP,
            "stakingPoolPaidOut exceeded 55.2M cap"
        );
    }

    function invariant_PaidOutMonotonic() public view {
        uint256 paidOut = StakingRewardsFacet(address(diamond)).getStakingPoolPaidOut();
        assertGe(
            paidOut,
            handler.observedMaxPaidOut(),
            "stakingPoolPaidOut went backwards"
        );
    }
}

/**
 * @dev Fuzz handler for the staking-ledger invariants. Sprays bounded
 *      deposits, withdrawals, claims, and time warps across three actors.
 *      Each call either succeeds or is caught and counted; the invariant
 *      suite checks post-state after every fuzz action.
 */
contract StakingHandler is Test {
    address public diamond;
    VPFIToken public vpfi;

    address[3] internal actors;

    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public claims;
    uint256 public warps;
    uint256 public observedMaxPaidOut;

    constructor(address _diamond, address _vpfi) {
        diamond = _diamond;
        vpfi = VPFIToken(_vpfi);
        actors[0] = makeAddr("actor0");
        actors[1] = makeAddr("actor1");
        actors[2] = makeAddr("actor2");
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i % 3];
    }

    function _tick() internal {
        uint256 p = StakingRewardsFacet(diamond).getStakingPoolPaidOut();
        if (p > observedMaxPaidOut) observedMaxPaidOut = p;
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        address user = actors[actorSeed % 3];
        amount = bound(amount, 1 ether, 100_000 ether);
        uint256 bal = vpfi.balanceOf(user);
        if (bal < amount) return;

        vm.startPrank(user);
        vpfi.approve(diamond, amount);
        try VPFIDiscountFacet(diamond).depositVPFIToEscrow(amount) {
            deposits++;
        } catch {}
        vm.stopPrank();
        _tick();
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        address user = actors[actorSeed % 3];
        uint256 staked = StakingRewardsFacet(diamond).getUserStakedVPFI(user);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);

        vm.prank(user);
        try VPFIDiscountFacet(diamond).withdrawVPFIFromEscrow(amount) {
            withdrawals++;
        } catch {}
        _tick();
    }

    function claim(uint256 actorSeed) external {
        address user = actors[actorSeed % 3];
        vm.prank(user);
        try StakingRewardsFacet(diamond).claimStakingRewards() {
            claims++;
        } catch {}
        _tick();
    }

    /// @notice Advance block.timestamp by up to 30 days so the per-token
    ///         accrual counter grows between fuzz actions.
    function warp(uint256 dt) external {
        dt = bound(dt, 1 hours, 30 days);
        vm.warp(block.timestamp + dt);
        warps++;
    }
}
