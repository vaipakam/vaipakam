// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {ProtectedAccountFacet} from "../src/facets/ProtectedAccountFacet.sol";
import {VaultPayoutFacet} from "../src/facets/VaultPayoutFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {ReadyBalanceFacet} from "../src/facets/ReadyBalanceFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibProtectedAccount} from "../src/libraries/LibProtectedAccount.sol";
import {LibReadyBalance} from "../src/libraries/LibReadyBalance.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {LibTestProtection as P} from "./helpers/LibTestProtection.sol";

/**
 * @title ReadyBalanceTest
 * @notice #3344 — a protected account's Ready balance: the instant
 *         wallet deposit, the delayed top-up and its cancel, the instant
 *         release, the spend host, the withdraw bound, the lock voiding it,
 *         and the optional idle expiry.
 */
contract ReadyBalanceTest is Test {
    VaipakamDiamond diamond;
    HelperTest helperTest;
    ERC20Mock token;

    address user = makeAddr("user");
    address plain = makeAddr("plain");
    address thief = makeAddr("thief");

    uint32 constant DELAY = 2 days;
    uint8 constant K20 = uint8(LibVaipakam.AssetType.ERC20);

    function setUp() public {
        helperTest = new HelperTest();
        DiamondCutFacet cutFacet = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond = new VaipakamDiamond(address(this), address(cutFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](9);
        cuts[0] = _cut(type(VaultFactoryFacet).name, helperTest.getVaultFactoryFacetSelectorsExtended());
        cuts[1] = _cut(type(AdminFacet).name, helperTest.getAdminFacetSelectors());
        cuts[2] = _cut(type(ProfileFacet).name, helperTest.getProfileFacetSelectors());
        cuts[3] = _cut(type(AccessControlFacet).name, helperTest.getAccessControlFacetSelectors());
        cuts[4] = _cut(type(VaipakamNFTFacet).name, helperTest.getVaipakamNFTFacetSelectors());
        cuts[5] = _cut(type(ProtectedAccountFacet).name, helperTest.getProtectedAccountFacetSelectors());
        cuts[6] = _cut(type(VaultPayoutFacet).name, helperTest.getVaultPayoutFacetSelectors());
        cuts[7] = _cut(type(VaultDepositoryFacet).name, helperTest.getVaultDepositoryFacetSelectors());
        cuts[8] = _cut(type(ReadyBalanceFacet).name, helperTest.getReadyBalanceFacetSelectors());
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();
        LibTestVaultBeacon.install(address(diamond), address(this));
        LibTestPositionNFT.install(address(diamond), address(this));
        ProfileFacet(address(diamond)).setSanctionsOracle(address(new MockSanctionsList()));

        token = new ERC20Mock("Token", "TKN", 18);
        address[2] memory who = [user, plain];
        for (uint256 i; i < 2; ++i) {
            token.mint(who[i], 1_000 ether);
            vm.prank(who[i]);
            token.approve(address(diamond), type(uint256).max);
        }
    }

    function _cut(string memory name, bytes4[] memory sels) internal returns (IDiamondCut.FacetCut memory) {
        return IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });
    }

    function _r() internal view returns (ReadyBalanceFacet) {
        return ReadyBalanceFacet(address(diamond));
    }

    function _depo() internal view returns (VaultDepositoryFacet) {
        return VaultDepositoryFacet(address(diamond));
    }

    /// @dev `who` deposits `amount` into its vault (Protected balance).
    function _deposit(address who, uint256 amount) internal {
        vm.prank(who);
        _depo().depositToVault(K20, address(token), 0, amount);
    }

    function _enable() internal {
        P.enable(address(diamond), user, DELAY);
    }

    /// @dev The spend host, called as the Diamond (its only caller).
    function _spend(address who, uint256 amount) internal {
        vm.prank(address(diamond));
        _r().spendReady(who, address(token), amount);
    }

    function _spendable(address who) internal view returns (uint256) {
        return _r().readySpendable(who, address(token));
    }

    // ─── Accounts not in protected mode ──────────────────────────────────

    function test_NotProtected_AllFreeIsSpendable_AndSpendIsANoOp() public {
        _deposit(plain, 100 ether);
        assertEq(_spendable(plain), 100 ether);
        _spend(plain, 100 ether); // no Ready rule applies: no revert
        vm.prank(plain);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.ProtectedModeOff.selector, plain));
        _r().depositToReady(address(token), 1 ether);
    }

    function test_SpendHost_OnlyTheDiamond() public {
        vm.prank(thief);
        vm.expectRevert(LibReadyBalance.ReadyHostInternalOnly.selector);
        _r().spendReady(user, address(token), 1);
    }

    // ─── Protected: the Protected balance is not spendable at once ───────

    function test_Protected_VaultBalanceIsNotSpendableWithoutReady() public {
        _deposit(user, 100 ether);
        _enable();
        assertEq(_spendable(user), 0);
        vm.expectRevert(
            abi.encodeWithSelector(LibReadyBalance.ReadyBalanceShort.selector, user, address(token), 0, 1 ether)
        );
        _spend(user, 1 ether);
    }

    function test_WalletToReady_IsInstant_AndSpendDrawsIt() public {
        _enable();
        vm.prank(user);
        _r().depositToReady(address(token), 40 ether);
        assertEq(_spendable(user), 40 ether);
        assertEq(token.balanceOf(address(P.vaultOf(address(diamond), user))), 40 ether);

        _spend(user, 15 ether);
        assertEq(_spendable(user), 25 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibReadyBalance.ReadyBalanceShort.selector, user, address(token), 25 ether, 26 ether
            )
        );
        _spend(user, 26 ether);
    }

    function test_ReadyNeverPaysAWallet_WithdrawExcludesIt() public {
        _deposit(user, 100 ether);
        _enable();
        vm.prank(user);
        _r().depositToReady(address(token), 30 ether);
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 100 ether);

        // Released back to Protected, it is withdrawable (through the delay).
        vm.prank(user);
        _r().releaseReady(user, address(token), 10 ether);
        assertEq(_spendable(user), 20 ether);
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 110 ether);
    }

    // ─── Protected → Ready waits the delay ───────────────────────────────

    function test_TopUp_CountsOnlyAfterTheDelay() public {
        _deposit(user, 100 ether);
        _enable();
        vm.prank(user);
        _r().requestReadyTopUp(address(token), 60 ether);
        assertEq(_spendable(user), 0);
        ReadyBalanceFacet.ReadyView memory v = _r().getReadyBalance(user, address(token));
        assertEq(v.pending, 60 ether);
        assertEq(v.pendingAt, block.timestamp + DELAY);

        vm.warp(vm.getBlockTimestamp() + DELAY);
        assertEq(_spendable(user), 60 ether);
        _spend(user, 60 ether);
        assertEq(_spendable(user), 0);
    }

    function test_TopUp_BoundedByFreeLessReady() public {
        _deposit(user, 100 ether);
        _enable();
        vm.prank(user);
        _r().depositToReady(address(token), 20 ether);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ReadyBalanceFacet.ReadyExceedsFree.selector, 101 ether, 100 ether));
        _r().requestReadyTopUp(address(token), 101 ether);
    }

    function test_TopUp_CancelledByTheOwner_NotByAStranger() public {
        _deposit(user, 100 ether);
        _enable();
        vm.prank(user);
        _r().requestReadyTopUp(address(token), 60 ether);

        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(ReadyBalanceFacet.ReadyNotOwnerOrSigner.selector, user, thief));
        _r().cancelReadyTopUp(user, address(token));

        vm.prank(user);
        _r().cancelReadyTopUp(user, address(token));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        assertEq(_spendable(user), 0);
    }

    // ─── Lock voids Ready ────────────────────────────────────────────────

    function test_Lock_VoidsReadyAndThePendingTopUp_ForGood() public {
        _deposit(user, 100 ether);
        _enable();
        vm.startPrank(user);
        _r().depositToReady(address(token), 30 ether);
        _r().requestReadyTopUp(address(token), 20 ether);
        vm.stopPrank();

        P.lock(address(diamond), user, user);
        assertEq(_spendable(user), 0);
        assertEq(uint8(_r().getReadyBalance(user, address(token)).status), uint8(LibReadyBalance.Status.Locked));

        P.requestUnlock(address(diamond), user, user);
        vm.warp(vm.getBlockTimestamp() + DELAY + 1);
        P.finalizeSettings(address(diamond), user);
        assertEq(_spendable(user), 0, "neither Ready nor the pending top-up survives the lock");
    }

    // ─── Idle expiry ─────────────────────────────────────────────────────

    function test_IdleExpiry_ReadyStopsCountingAtTheDeadline() public {
        _enable();
        vm.startPrank(user);
        _r().setReadyIdlePeriod(1 days);
        _r().depositToReady(address(token), 30 ether);
        vm.stopPrank();
        assertEq(_r().getReadyBalance(user, address(token)).readyUntil, block.timestamp + 1 days);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(_spendable(user), 30 ether);
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(_spendable(user), 0);
        assertEq(uint8(_r().getReadyBalance(user, address(token)).status), uint8(LibReadyBalance.Status.Expired));
        // Expired Ready is Protected balance again: withdrawable (delayed).
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 30 ether);
    }

    function test_IdleExpiry_ExtendKeepsItCounting() public {
        _enable();
        vm.startPrank(user);
        _r().setReadyIdlePeriod(1 days);
        _r().depositToReady(address(token), 30 ether);
        _r().extendReadyUntil(address(token), uint64(block.timestamp + 10 days));
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 10 days);
        assertEq(_spendable(user), 30 ether);
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(_spendable(user), 0);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibReadyBalance.ReadyUntilOutOfRange.selector, uint64(block.timestamp + 31 days)));
        _r().extendReadyUntil(address(token), uint64(block.timestamp + 31 days));
    }

    function test_IdlePeriod_ShorteningInstant_LengtheningWaitsTheDelay() public {
        _enable();
        vm.startPrank(user);
        _r().setReadyIdlePeriod(10 days);
        _r().setReadyIdlePeriod(3 days); // shorter: at once
        (uint32 idle,,,) = _r().getReadySettings(user);
        assertEq(idle, 3 days);

        _r().setReadyIdlePeriod(0); // off is a lengthening: waits
        vm.stopPrank();
        (uint32 idle2, uint32 pend, uint64 at, bool set) = _r().getReadySettings(user);
        assertEq(idle2, 3 days);
        assertEq(pend, 0);
        assertTrue(set);
        assertEq(at, block.timestamp + DELAY);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (uint32 idle3,,,) = _r().getReadySettings(user);
        assertEq(idle3, 0);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibReadyBalance.ReadyIdleOutOfRange.selector, uint256(31 days)));
        _r().setReadyIdlePeriod(31 days);
    }

    function test_ReleaseByAStrangerRefused() public {
        _enable();
        vm.prank(user);
        _r().depositToReady(address(token), 30 ether);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(ReadyBalanceFacet.ReadyNotOwnerOrSigner.selector, user, thief));
        _r().releaseReady(user, address(token), 1 ether);
    }
}
