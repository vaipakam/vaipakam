// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @dev RL-1 forced-failure harness: Replace-cut over the accumulator's
///      broadcast-free rollup selector so the vault credit's LAST step
///      reverts AFTER the Diamond→vault transfer and the tracked-balance
///      record already executed in the same frame — proving the whole
///      vault-side unit rolls back atomically before the wallet fallback.
contract RevertingRollupLocalMock {
    error ForcedRollupFailure();

    function rollupUserDiscountLocal(address, uint256) external pure {
        revert ForcedRollupFailure();
    }
}

/// @dev RL-1 contract-caller harness. Claims from a CONTRACT address so the
///      `Default` venue resolves to the raw wallet transfer (the pre-RL-1
///      behaviour every live integration observed), and separately opts in
///      to vault delivery explicitly (the Safe/AA-wallet path).
contract ClaimingContractWallet {
    function claimDefault(address diamond)
        external
        returns (uint256 paid)
    {
        (paid, , ) =
            InteractionRewardsFacet(diamond).claimInteractionRewards();
    }

    function claimToVault(address diamond)
        external
        returns (uint256 paid)
    {
        (paid, , ) = InteractionRewardsFacet(diamond)
            .claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Vault);
    }
}

/**
 * @title  InteractionRewardVaultDeliveryTest
 * @notice RL-1 (VpfiRecyclingLoopClosureDesign §6) — claim-to-vault reward
 *         delivery. Covers the design's stated test matrix:
 *
 *           - EOA default claim credits the vault: tracked balance +
 *             actual vault balance both rise by `paid`, the tier rollup is
 *             stamped at the post-mutation balance (not clamped out as
 *             dust), and {RewardDeliveredToVault} is emitted with the
 *             CLAIM day.
 *           - Diamond-funded credit works with ZERO wallet balance and
 *             ZERO allowance (the P1 failure case of reusing the
 *             user-funded deposit chokepoint).
 *           - Explicit wallet opt-out pays the wallet and leaves the vault
 *             untouched.
 *           - Fallback triggers — no vault yet, mandatory-vault-upgrade
 *             gate — pay the wallet instead of blocking the claim.
 *           - Contract callers default to the raw wallet transfer; an
 *             explicit `Vault` opt-in gets the same credit as an EOA.
 *           - Forced rollup failure: transfer + record + rollup roll back
 *             as ONE unit; wallet paid exactly once; no vault-side residue.
 */
contract InteractionRewardVaultDeliveryTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;

    address internal alice;

    event RewardDeliveredToVault(
        address indexed user,
        uint256 amount,
        uint256 claimDayId
    );

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

        alice = makeAddr("alice");

        _facet().setInteractionLaunchTimestamp(block.timestamp);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    ///  #1306 follow-up — read-only lens accessor (getters moved off
    ///      InteractionRewardsFacet into InteractionRewardsLensFacet).
    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _vaultFacet() internal view returns (VaultFactoryFacet) {
        return VaultFactoryFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev Seed `user` as the only lender on day 1 and warp so day 1 is
    ///      finalized. The claim will pay exactly `halfPool(1)`.
    function _seedClaimable(address user) internal returns (uint256 expected) {
        _mut().setDailyLenderInterest(1, user, 100e18, 100e18);
        vm.warp(block.timestamp + 2 days + 1);
        expected = _lens().getInteractionHalfPoolForDay(1);
    }

    function _tracked(address user) internal view returns (uint256) {
        return _vaultFacet().getProtocolTrackedVaultBalance(user, address(vpfi));
    }

    // ─── EOA default → vault credit ──────────────────────────────────────────

    function testEoaDefaultClaimCreditsVaultAndStampsTier() public {
        address vault = _vaultFacet().getOrCreateUserVault(alice);
        uint256 expected = _seedClaimable(alice);

        // The P1 case the Diamond-funded primitive exists for: the claimant
        // has NO wallet VPFI and has given NO allowance — the user-funded
        // deposit chokepoint would revert or move the wrong funds.
        assertEq(vpfi.balanceOf(alice), 0, "no wallet VPFI");
        assertEq(vpfi.allowance(alice, address(diamond)), 0, "no allowance");

        (uint256 today, ) = _lens().getInteractionCurrentDay();
        vm.expectEmit(true, false, false, true, address(diamond));
        emit RewardDeliveredToVault(alice, expected, today);

        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewards();

        assertEq(paid, expected, "full half-pool paid");
        assertEq(vpfi.balanceOf(alice), 0, "wallet NOT paid on vault delivery");
        assertEq(vpfi.balanceOf(vault), expected, "vault holds the reward");
        assertEq(_tracked(alice), expected, "tracked counter recorded");

        // Tier rollup stamped at the POST-mutation balance — the credit
        // counts toward standing instead of being clamped out as dust.
        (uint40 startSec, , uint120 dayClose, ) =
            _mut().getStakeRollupStateRaw(alice);
        assertGt(startSec, 0, "staker lifecycle opened");
        assertEq(uint256(dayClose), expected, "ring buffer stamped at paid");
    }

    // ─── Explicit venues ─────────────────────────────────────────────────────

    function testEoaExplicitWalletOptOut() public {
        address vault = _vaultFacet().getOrCreateUserVault(alice);
        uint256 expected = _seedClaimable(alice);

        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewardsTo(
            LibVaipakam.RewardDelivery.Wallet
        );

        assertEq(paid, expected, "full amount paid");
        assertEq(vpfi.balanceOf(alice), expected, "wallet paid on opt-out");
        assertEq(vpfi.balanceOf(vault), 0, "vault untouched");
        assertEq(_tracked(alice), 0, "no tracked credit");
        (uint40 startSec, , , ) = _mut().getStakeRollupStateRaw(alice);
        assertEq(startSec, 0, "no tier stamp on wallet delivery");
    }

    function testEoaExplicitVaultMatchesDefault() public {
        address vault = _vaultFacet().getOrCreateUserVault(alice);
        uint256 expected = _seedClaimable(alice);

        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewardsTo(
            LibVaipakam.RewardDelivery.Vault
        );

        assertEq(paid, expected, "full amount paid");
        assertEq(vpfi.balanceOf(vault), expected, "vault credited");
        assertEq(_tracked(alice), expected, "tracked counter recorded");
    }

    // ─── Fallback triggers — delivery never reduces availability ────────────

    function testNoVaultFallsBackToWallet() public {
        // alice never created a vault; the read-only resolution must NOT
        // mint one as a payout side effect.
        uint256 expected = _seedClaimable(alice);

        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewards();

        assertEq(paid, expected, "claim availability unchanged");
        assertEq(vpfi.balanceOf(alice), expected, "wallet fallback paid");
        assertEq(
            _vaultFacet().getUserVaultAddress(alice),
            address(0),
            "no vault minted as a payout side effect"
        );
    }

    function testMandatoryUpgradeGateFallsBackToWallet() public {
        address vault = _vaultFacet().getOrCreateUserVault(alice);
        uint256 expected = _seedClaimable(alice);

        // Put alice's vault below the mandatory floor — the design's
        // below-mandatory-version claimant case.
        _mut().setMandatoryVaultVersionRaw(type(uint256).max);

        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewards();

        assertEq(paid, expected, "claim availability unchanged");
        assertEq(vpfi.balanceOf(alice), expected, "wallet fallback paid");
        assertEq(vpfi.balanceOf(vault), 0, "gated vault untouched");
        assertEq(_tracked(alice), 0, "no tracked credit");
    }

    // ─── Contract callers ────────────────────────────────────────────────────

    function testContractCallerDefaultsToRawWalletTransfer() public {
        ClaimingContractWallet w = new ClaimingContractWallet();
        uint256 expected = _seedClaimable(address(w));

        uint256 paid = w.claimDefault(address(diamond));

        assertEq(paid, expected, "full amount paid");
        assertEq(
            vpfi.balanceOf(address(w)),
            expected,
            "raw balance lands on the calling contract (pre-RL-1 behaviour)"
        );
    }

    function testContractWalletExplicitVaultOptIn() public {
        ClaimingContractWallet w = new ClaimingContractWallet();
        address vault = _vaultFacet().getOrCreateUserVault(address(w));
        uint256 expected = _seedClaimable(address(w));

        uint256 paid = w.claimToVault(address(diamond));

        assertEq(paid, expected, "full amount paid");
        assertEq(vpfi.balanceOf(address(w)), 0, "no raw transfer");
        assertEq(vpfi.balanceOf(vault), expected, "contract wallet joins the loop");
        assertEq(_tracked(address(w)), expected, "tracked counter recorded");
    }

    // ─── Atomicity of the fallback ───────────────────────────────────────────

    function testForcedRollupFailureRollsBackVaultSideAndPaysWalletOnce() public {
        address vault = _vaultFacet().getOrCreateUserVault(alice);
        uint256 expected = _seedClaimable(alice);

        // Replace the broadcast-free rollup with a reverting mock: the
        // credit primitive's transfer + record succeed in-frame, then the
        // rollup reverts — the WHOLE vault-side unit must roll back.
        RevertingRollupLocalMock mock = new RevertingRollupLocalMock();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = VPFIDiscountAccumulatorFacet.rollupUserDiscountLocal.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(mock),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: sel
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewards();

        assertEq(paid, expected, "claim availability unchanged");
        assertEq(vpfi.balanceOf(alice), expected, "wallet paid exactly once");
        assertEq(vpfi.balanceOf(vault), 0, "vault transfer rolled back");
        assertEq(_tracked(alice), 0, "tracked record rolled back");
        (uint40 startSec, , uint120 dayClose, ) =
            _mut().getStakeRollupStateRaw(alice);
        assertEq(startSec, 0, "no lifecycle residue");
        assertEq(uint256(dayClose), 0, "no ring-buffer residue");
    }

    // ─── Guard rails ─────────────────────────────────────────────────────────

    function testVaultCreditPrimitiveIsDiamondInternalOnly() public {
        vm.expectRevert(VaultFactoryFacet.OnlyDiamondInternal.selector);
        vm.prank(alice);
        _vaultFacet().vaultCreditFromDiamondERC20(alice, address(vpfi), 1);
    }
}
