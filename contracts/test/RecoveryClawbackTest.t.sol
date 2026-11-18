// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {VaultProtection} from "../src/vault/VaultProtection.sol";
import {VaultProtectionBase} from "../src/vault/VaultProtectionBase.sol";
import {VaultRecovery} from "../src/vault/VaultRecovery.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultOutflowTypes} from "../src/vault/VaultOutflowTypes.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {RecoveryClawbackFacet} from "../src/facets/RecoveryClawbackFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestProtection as P} from "./helpers/LibTestProtection.sol";

/**
 * @title  RecoveryClawbackTest
 * @notice #3246 part 2 — the recovery address and the clawback
 *         (`docs/DesignsAndPlans/RecoveryAddressClawbackDesign.md`):
 *         - the address proves control, waits twice the delay the first time
 *           and 30 days on a change, and a lock drops a pending change;
 *         - protected mode needs one; it is cleared only while protected mode
 *           is off;
 *         - the owner or a signer claws the account back; the free balance
 *           moves to the address in force, nobody names the recipient;
 *         - the recovered state never clears (no unlock, no switch-off, the
 *           positions stay put);
 *         - a later payout is swept on by anyone, and a protected recovery
 *           address is paid into its own vault (and swept on again if it is
 *           recovered too).
 */
contract RecoveryClawbackTest is SetupTest {
    uint32 internal constant DELAY = 3 days;
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant REC_KEY = 0xBEEF;
    uint256 internal constant REC2_KEY = 0xCAFE;
    uint8 internal constant K20 = uint8(LibVaipakam.AssetType.ERC20);

    address internal acct;
    address internal rec;
    address internal signerA = makeAddr("signerA");
    address internal stranger = makeAddr("stranger");
    ERC20Mock internal tok;
    VaipakamVaultImplementation internal vault;

    function setUp() public {
        setupHelper();
        acct = vm.addr(OWNER_KEY);
        rec = vm.addr(REC_KEY);
        tok = ERC20Mock(mockERC20);
        tok.mint(acct, 1_000 ether);
        tok.mint(stranger, 1_000 ether);
        vm.prank(acct);
        tok.approve(address(diamond), type(uint256).max);
        vm.prank(stranger);
        tok.approve(address(diamond), type(uint256).max);
        vault = P.vaultOf(address(diamond), acct);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _depo() internal view returns (VaultDepositoryFacet) {
        return VaultDepositoryFacet(address(diamond));
    }

    function _claw() internal view returns (RecoveryClawbackFacet) {
        return RecoveryClawbackFacet(address(diamond));
    }

    function _assets() internal view returns (VaultOutflowTypes.ClawbackAsset[] memory a) {
        a = new VaultOutflowTypes.ClawbackAsset[](1);
        a[0] = VaultOutflowTypes.ClawbackAsset({
            kind: VaultOutflowTypes.AssetKind.ERC20, asset: address(tok), tokenId: 0
        });
    }

    function _deposit(address who, uint256 amount) internal {
        vm.prank(who);
        _depo().depositToVault(K20, address(tok), 0, amount);
    }

    /// @dev `rec` set and in force, then protected mode on.
    function _protectWithRec() internal {
        P.requestRecovery(address(diamond), acct, acct, REC_KEY);
        vm.warp(block.timestamp + 2 * 2 days);
        P.enable(address(diamond), acct, DELAY);
    }

    function _clawback(address key) internal {
        vm.prank(key);
        vault.protect(abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(key))));
    }

    function _recovery() internal view returns (address inForce, address pending, bool recovered) {
        (inForce, pending,, recovered,) = vault.protectionRecovery();
    }

    function _expectProtectRevert(address key, bytes memory data, bytes memory err) internal {
        vm.prank(key);
        vm.expectRevert(err);
        vault.protect(data);
    }

    // ─── 1. The address: proof, identity, the first wait ───────────────

    function test_protectedModeNeedsARecoveryAddress() public {
        _expectProtectRevert(
            acct,
            abi.encodeCall(VaultProtection.enable, (DELAY, P.direct(acct))),
            abi.encodeWithSelector(VaultProtectionBase.RecoveryRequired.selector)
        );
    }

    function test_theAddressMustProveControl() public {
        // A proof from another key is refused.
        VaultProtectionBase.Auth memory proof = P.direct(stranger);
        _expectProtectRevert(
            acct,
            abi.encodeCall(VaultRecovery.requestRecoveryAddress, (rec, P.direct(acct), proof)),
            abi.encodeWithSelector(VaultProtectionBase.BadRecovery.selector, rec)
        );
        // Naming the address without its signature or call is refused.
        _expectProtectRevert(
            acct,
            abi.encodeCall(VaultRecovery.requestRecoveryAddress, (rec, P.direct(acct), P.direct(rec))),
            abi.encodeWithSelector(VaultProtectionBase.BadSignature.selector, rec)
        );
    }

    function test_theAccountItsVaultAndTheDiamondAreNeverTheAddress() public {
        address[3] memory bad = [acct, address(vault), address(diamond)];
        for (uint256 i; i < bad.length; ++i) {
            _expectProtectRevert(
                acct,
                abi.encodeCall(VaultRecovery.requestRecoveryAddress, (bad[i], P.direct(acct), P.direct(bad[i]))),
                abi.encodeWithSelector(VaultProtectionBase.BadRecovery.selector, bad[i])
            );
        }
    }

    function test_aFirstSettingWaitsTwiceTheMinimumDelay() public {
        P.requestRecovery(address(diamond), acct, acct, REC_KEY);
        (address inForce, address pending,) = _recovery();
        assertEq(inForce, address(0), "not yet in force");
        assertEq(pending, rec, "pending");
        vm.warp(block.timestamp + 2 * 2 days);
        (inForce, pending,) = _recovery();
        assertEq(inForce, rec, "in force after twice the minimum delay");
        assertEq(pending, address(0));
    }

    // ─── 2. A change waits 30 days; the current one stays in force ─────

    function test_aChangeWaitsThirtyDays_theCurrentStaysInForce() public {
        _protectWithRec();
        address rec2 = vm.addr(REC2_KEY);
        P.requestRecovery(address(diamond), acct, acct, REC2_KEY);
        vm.warp(block.timestamp + 29 days);
        (address inForce, address pending,) = _recovery();
        assertEq(inForce, rec, "the current address stays in force");
        assertEq(pending, rec2);
        vm.warp(block.timestamp + 1 days);
        (inForce,,) = _recovery();
        assertEq(inForce, rec2, "the change after 30 days");
    }

    // ─── 3. A lock drops a pending change; a signer cancels one ────────

    function test_aLockDropsAPendingChange() public {
        _protectWithRec();
        P.requestRecovery(address(diamond), acct, acct, REC2_KEY);
        P.lock(address(diamond), acct, acct);
        vm.warp(block.timestamp + 31 days);
        (address inForce, address pending,) = _recovery();
        assertEq(inForce, rec, "the lock dropped the change");
        assertEq(pending, address(0));
    }

    function test_aSignerCancelsAPendingChange() public {
        _protectWithRec();
        P.addSigner(address(diamond), acct, acct, signerA, DELAY);
        P.requestRecovery(address(diamond), acct, acct, REC2_KEY);
        vm.prank(signerA);
        vault.protect(abi.encodeCall(VaultRecovery.cancelRecoveryAddress, (P.direct(signerA))));
        vm.warp(block.timestamp + 31 days);
        (address inForce,,) = _recovery();
        assertEq(inForce, rec, "cancelled");
    }

    function test_aSignerNeedsTheAddressInForce_andIsNeverIt() public {
        P.requestRecovery(address(diamond), acct, acct, REC_KEY);
        P.enable(address(diamond), acct, DELAY); // the address is pending only
        // The recovery address is never a signer.
        _expectProtectRevert(
            acct,
            abi.encodeCall(VaultProtection.signerChange, (uint8(1), rec, P.direct(acct))),
            abi.encodeWithSelector(VaultProtectionBase.BadNominee.selector, rec)
        );
        // A signer may be requested and accepted, but not finalized while the
        // address is still waiting.
        vm.prank(acct);
        vault.protect(abi.encodeCall(VaultProtection.signerChange, (uint8(1), signerA, P.direct(acct))));
        vm.prank(signerA);
        vault.protect(abi.encodeCall(VaultProtection.signerChange, (uint8(2), signerA, P.direct(signerA))));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(VaultProtectionBase.RecoveryRequired.selector));
        vault.protect(abi.encodeCall(VaultProtection.finalizeSigner, (signerA)));
        // Once it is in force, the same signer finalizes.
        vm.warp(block.timestamp + 1 days);
        vault.protect(abi.encodeCall(VaultProtection.finalizeSigner, (signerA)));
    }

    // ─── 4. Clearing it: only while protected mode is off ───────────────

    function test_clearingIsRefusedWhileProtected() public {
        _protectWithRec();
        _expectProtectRevert(
            acct,
            abi.encodeCall(VaultRecovery.clearRecoveryAddress, (P.direct(acct))),
            abi.encodeWithSelector(VaultProtectionBase.RecoveryInUse.selector)
        );
    }

    function test_clearingWhileOffWorks() public {
        P.requestRecovery(address(diamond), acct, acct, REC_KEY);
        vm.prank(acct);
        vault.protect(abi.encodeCall(VaultRecovery.clearRecoveryAddress, (P.direct(acct))));
        (address inForce, address pending,) = _recovery();
        assertEq(inForce, address(0));
        assertEq(pending, address(0));
    }

    // ─── 5. The clawback ────────────────────────────────────────────────

    function test_theOwnerClawsBack_theFreeBalanceMovesToTheAddress() public {
        _protectWithRec();
        _deposit(acct, 100 ether);
        _clawback(acct);
        assertEq(tok.balanceOf(rec), 100 ether, "all of it at the recovery address");
        assertEq(tok.balanceOf(address(vault)), 0);
        (, bool locked,,,) = vault.protectionCore();
        (,, bool recovered) = _recovery();
        assertTrue(locked, "locked");
        assertTrue(recovered, "recovered");
    }

    function test_aSignerClawsBackUnderAThiefsLock() public {
        _protectWithRec();
        P.addSigner(address(diamond), acct, acct, signerA, DELAY);
        _deposit(acct, 50 ether);
        P.lock(address(diamond), acct, acct); // the thief, holding the owner key
        _clawback(signerA);
        assertEq(tok.balanceOf(rec), 50 ether);
    }

    function test_aClawbackNeedsTheAddressInForce() public {
        P.requestRecovery(address(diamond), acct, acct, REC_KEY);
        P.enable(address(diamond), acct, DELAY);
        _expectProtectRevert(
            acct,
            abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(acct))),
            abi.encodeWithSelector(VaultProtectionBase.RecoveryRequired.selector)
        );
    }

    function test_onlyTheOwnerOrASignerTriggers() public {
        _protectWithRec();
        _expectProtectRevert(
            stranger,
            abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(stranger))),
            abi.encodeWithSelector(VaultProtectionBase.NotOwnerOrSigner.selector, stranger)
        );
        _expectProtectRevert(
            rec,
            abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(rec))),
            abi.encodeWithSelector(VaultProtectionBase.NotOwnerOrSigner.selector, rec)
        );
    }

    function test_onlyTheVaultAppliesAClawback() public {
        _protectWithRec();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RecoveryClawbackFacet.NotAccountVault.selector, acct, stranger));
        _claw().applyClawback(acct, acct, 0, _assets());
    }

    // ─── 6. The recovered state never clears ───────────────────────────

    function test_aRecoveredAccountNeverUnlocksOrSwitchesOff() public {
        _protectWithRec();
        _clawback(acct);
        _expectProtectRevert(
            acct,
            abi.encodeCall(VaultProtection.requestUnlock, (P.direct(acct))),
            abi.encodeWithSelector(VaultProtectionBase.RecoveredAccount.selector)
        );
        _expectProtectRevert(
            acct,
            abi.encodeCall(VaultProtection.requestDisable, (P.direct(acct))),
            abi.encodeWithSelector(VaultProtectionBase.RecoveredAccount.selector)
        );
    }

    function test_aRecoveredAccountsPositionsCannotLeave() public {
        _protectWithRec();
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).mintNFT(acct, 901, 901, 0, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        _clawback(acct);
        PositionNFT core = LibTestPositionNFT.core(address(diamond));
        // Test 11: the holder lifts the token contract's own holder lock
        // after its delay; the platform's recovered rule still refuses.
        if (core.isLocked(acct)) {
            vm.prank(acct);
            core.requestUnlock();
            vm.warp(block.timestamp + 31 days);
            try core.executeUnlock(acct) {} catch {}
        }
        vm.prank(acct);
        vm.expectRevert(abi.encodeWithSelector(VaipakamNFTFacet.TransferFromRecoveredAccount.selector, acct, stranger));
        core.transferFrom(acct, stranger, 901);
    }

    // ─── 7. The sweep ───────────────────────────────────────────────────

    function test_aLaterPayoutIsSweptOnByAnyone() public {
        _protectWithRec();
        _clawback(acct);
        // Something reaches the account after its clawback.
        _deposit(acct, 30 ether);
        vm.prank(stranger);
        _claw().sweepRecovered(acct, _assets());
        assertEq(tok.balanceOf(rec), 30 ether, "swept to the recovery address");
        // Nothing left: a second sweep is refused.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RecoveryClawbackFacet.NothingToSweep.selector, acct));
        _claw().sweepRecovered(acct, _assets());
    }

    function test_aSweepOfAnAccountNotRecoveredIsRefused() public {
        _protectWithRec();
        _deposit(acct, 30 ether);
        vm.expectRevert(abi.encodeWithSelector(RecoveryClawbackFacet.AccountNotRecovered.selector, acct));
        _claw().sweepRecovered(acct, _assets());
    }

    // ─── 8. A protected recovery address (ruling 6) ─────────────────────

    function test_aProtectedRecoveryAddressIsPaidIntoItsVault_andSweptOnIfRecovered() public {
        _protectWithRec();
        // The recovery address is itself a protected account, with its own
        // recovery address.
        VaipakamVaultImplementation recVault = P.vaultOf(address(diamond), rec);
        P.enable(address(diamond), rec, DELAY);
        vm.warp(block.timestamp + 2 * 2 days); // its own address comes into force
        _deposit(acct, 40 ether);
        _clawback(acct);
        assertEq(tok.balanceOf(rec), 0, "never to its wallet");
        assertEq(tok.balanceOf(address(recVault)), 40 ether, "into its own vault");
        assertEq(_depo().withdrawableNow(rec, K20, address(tok), 0), 40 ether, "its own to take");

        // The receiving account is clawed back too: the amount moves on.
        address rec2 = P.recoveryOf(rec);
        vm.prank(rec);
        recVault.protect(abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(rec))));
        assertEq(tok.balanceOf(rec2), 40 ether, "on to its recovery address");
    }
}
