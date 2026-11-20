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
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestProtection as P} from "./helpers/LibTestProtection.sol";

/**
 * @title  RecoveryClaimTest
 * @notice #3756 — the recovery claim (`docs/DesignsAndPlans/RecoveryClaimDesign.md`
 *         section 6): where the owner allowed it, the recovery address asks
 *         for the account and, once the owner's wait has passed with nobody
 *         cancelling, runs the clawback itself. Numbered as in section 6.
 */
contract RecoveryClaimTest is SetupTest {
    uint32 internal constant DELAY = 3 days;
    uint32 internal constant WAIT = 90 days;
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant REC_KEY = 0xBEEF;
    uint256 internal constant REC2_KEY = 0xCAFE;
    uint256 internal constant SIGNER_KEY = 0x5161;
    uint8 internal constant K20 = uint8(LibVaipakam.AssetType.ERC20);

    address internal acct;
    address internal rec;
    address internal signerA;
    address internal stranger = makeAddr("stranger");
    ERC20Mock internal tok;
    VaipakamVaultImplementation internal vault;
    VaultProtection internal code;
    VaultRecovery internal recCode;

    event RecoveryClaimRequested(
        address indexed account, address indexed recovery, uint64 requestedAt, uint64 runnableAt, uint64 lapsesAt
    );
    event RecoveryClaimEnded(address indexed account, uint64 requestedAt, address by, uint8 reason, uint64 newRequestAt);
    event AccountRecovered(address indexed account, address indexed recovery, address indexed by, uint8 role);

    function setUp() public {
        setupHelper();
        acct = vm.addr(OWNER_KEY);
        rec = vm.addr(REC_KEY);
        signerA = vm.addr(SIGNER_KEY);
        tok = ERC20Mock(mockERC20);
        tok.mint(acct, 1_000 ether);
        vm.prank(acct);
        tok.approve(address(diamond), type(uint256).max);
        vault = P.vaultOf(address(diamond), acct);
        code = VaultProtection(vault.PROTECTION());
        recCode = VaultRecovery(code.RECOVERY());
        // `rec` in force, protected mode on, one signer.
        P.requestRecovery(address(diamond), acct, acct, REC_KEY);
        vm.warp(vm.getBlockTimestamp() + 2 * 2 days);
        P.enable(address(diamond), acct, DELAY);
        P.addSigner(address(diamond), acct, acct, signerA, DELAY);
        vm.prank(acct);
        VaultDepositoryFacet(address(diamond)).depositToVault(K20, address(tok), 0, 100 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _protect(address key, bytes memory data) internal returns (bytes memory) {
        vm.prank(key);
        return vault.protect(data);
    }

    function _expectRevert(address key, bytes memory data, bytes memory err) internal {
        vm.prank(key);
        vm.expectRevert(err);
        vault.protect(data);
    }

    function _err(bytes4 sel) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(sel);
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (VaultProtectionBase.Auth memory a) {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 400 days);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Vaipakam Vault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        a = VaultProtectionBase.Auth({key: vm.addr(pk), expiry: expiry, sig: abi.encodePacked(r, s, v)});
    }

    function _assets() internal view returns (VaultOutflowTypes.ClawbackAsset[] memory a) {
        a = new VaultOutflowTypes.ClawbackAsset[](1);
        a[0] = VaultOutflowTypes.ClawbackAsset({
            kind: VaultOutflowTypes.AssetKind.ERC20, asset: address(tok), tokenId: 0
        });
    }

    function _setData(address key, bool allowed, uint32 wait) internal pure returns (bytes memory) {
        return abi.encodeCall(VaultRecovery.setRecoveryClaim, (allowed, wait, P.direct(key)));
    }

    /// @dev The owner switches the claim on with `wait`, then the delay passes.
    function _allow(uint32 wait) internal {
        _protect(acct, _setData(acct, true, wait));
        vm.warp(vm.getBlockTimestamp() + DELAY);
    }

    function _askData(address key) internal pure returns (bytes memory) {
        return abi.encodeCall(VaultRecovery.requestRecoveryClaim, (P.direct(key)));
    }

    function _ask() internal {
        _protect(rec, _askData(rec));
    }

    function _cancelData(address key) internal pure returns (bytes memory) {
        return abi.encodeCall(VaultRecovery.cancelRecoveryClaim, (P.direct(key)));
    }

    function _runData(address key) internal view returns (bytes memory) {
        return abi.encodeCall(VaultRecovery.runRecoveryClaim, (_assets(), P.direct(key)));
    }

    function _claim()
        internal
        view
        returns (bool allowed, uint32 wait, uint64 requestedAt, uint64 runnableAt, uint64 lapsesAt, uint64 pauseUntil)
    {
        (allowed, wait,,,, requestedAt, runnableAt, lapsesAt, pauseUntil) = vault.protectionRecoveryClaim();
    }

    function _open() internal view returns (uint64 requestedAt) {
        (,, requestedAt,,,) = _claim();
    }

    /// @dev Claim allowed with {WAIT}, asked, and the wait passed.
    function _matured() internal {
        _allow(WAIT);
        _ask();
        vm.warp(vm.getBlockTimestamp() + WAIT);
    }

    // ─── 1. Off by default ─────────────────────────────────────────────

    function test_01_offByDefault() public {
        (bool allowed, uint32 wait,,,,) = _claim();
        assertFalse(allowed);
        assertEq(wait, 0);
        _expectRevert(rec, _askData(rec), _err(VaultProtectionBase.ClaimNotAllowed.selector));
    }

    // ─── 2. Switching on waits; off and lengthening are immediate ──────

    function test_02_switchOnWaits_aSignerCancels_aLockDrops() public {
        _protect(acct, _setData(acct, true, WAIT));
        _expectRevert(rec, _askData(rec), _err(VaultProtectionBase.ClaimNotAllowed.selector));
        // A signer cancels it.
        _protect(signerA, abi.encodeCall(VaultRecovery.cancelRecoveryClaimSetting, (P.direct(signerA))));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (bool allowed,,,,,) = _claim();
        assertFalse(allowed, "cancelled");
        // A lock drops it.
        _protect(acct, _setData(acct, true, WAIT));
        P.lock(address(diamond), acct, signerA);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (allowed,,,,,) = _claim();
        assertFalse(allowed, "dropped by the lock");
    }

    function test_02_offAndLengthenAreImmediate_shortenWaits() public {
        _allow(WAIT);
        (bool allowed, uint32 wait,,,,) = _claim();
        assertTrue(allowed);
        assertEq(wait, WAIT);
        // Lengthening applies at once, also while locked.
        P.lock(address(diamond), acct, signerA);
        _protect(acct, _setData(acct, true, 120 days));
        (, wait,,,,) = _claim();
        assertEq(wait, 120 days, "lengthened at once");
        // Shortening is a loosening change: refused while locked.
        _expectRevert(acct, _setData(acct, true, 60 days), _err(VaultProtectionBase.Locked.selector));
        // Switching off applies at once while locked.
        _protect(acct, _setData(acct, false, 0));
        (allowed, wait,,,,) = _claim();
        assertFalse(allowed);
        assertEq(wait, 0);
    }

    function test_02_shorteningWaitsTheDelay_theOldWaitAppliesUntilThen() public {
        _allow(WAIT);
        _protect(acct, _setData(acct, true, 30 days));
        (, uint32 wait,,,,) = _claim();
        assertEq(wait, WAIT, "the old wait applies");
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (, wait,,,,) = _claim();
        assertEq(wait, 30 days);
    }

    function test_02_waitBounds() public {
        _expectRevert(
            acct,
            _setData(acct, true, 29 days),
            abi.encodeWithSelector(VaultProtectionBase.BadClaimWait.selector, uint32(29 days))
        );
        _expectRevert(
            acct,
            _setData(acct, true, 366 days),
            abi.encodeWithSelector(VaultProtectionBase.BadClaimWait.selector, uint32(366 days))
        );
        _expectRevert(
            signerA, _setData(signerA, true, WAIT), abi.encodeWithSelector(VaultProtectionBase.NotOwner.selector, signerA)
        );
    }

    // ─── 3. Only the recovery address in force may ask ─────────────────

    function test_03_onlyTheRecoveryAddressInForceAsks() public {
        _allow(WAIT);
        address[3] memory bad = [acct, signerA, stranger];
        for (uint256 i; i < bad.length; ++i) {
            _expectRevert(
                bad[i], _askData(bad[i]), abi.encodeWithSelector(VaultProtectionBase.NotRecovery.selector, bad[i])
            );
        }
        // A pending change of address: refused (the owner's direct request
        // drops nothing here, no claim is open).
        P.requestRecovery(address(diamond), acct, acct, REC2_KEY);
        _expectRevert(rec, _askData(rec), _err(VaultProtectionBase.RecoveryChangePending.selector));
        address rec2 = vm.addr(REC2_KEY);
        _expectRevert(rec2, _askData(rec2), _err(VaultProtectionBase.RecoveryChangePending.selector));
    }

    function test_03_aPendingFirstSettingCannotAsk() public {
        address other = makeAddr("other");
        VaipakamVaultImplementation v = P.vaultOf(address(diamond), other);
        P.requestRecovery(address(diamond), other, other, REC2_KEY); // waits 4 days
        P.enable(address(diamond), other, 2 days);
        vm.prank(other);
        v.protect(abi.encodeCall(VaultRecovery.setRecoveryClaim, (true, WAIT, P.direct(other))));
        vm.warp(vm.getBlockTimestamp() + 2 days); // the claim on; the address still pending
        address rec2 = vm.addr(REC2_KEY);
        vm.prank(rec2);
        vm.expectRevert(VaultProtectionBase.RecoveryChangePending.selector);
        v.protect(abi.encodeCall(VaultRecovery.requestRecoveryClaim, (P.direct(rec2))));
    }

    // ─── 4. The run window; the event's dates ──────────────────────────

    function test_04_runOnlyInsideTheWindow_datesMatchTheEvent() public {
        _allow(WAIT);
        uint64 t = uint64(vm.getBlockTimestamp());
        vm.expectEmit(address(vault));
        emit RecoveryClaimRequested(acct, rec, t, t + WAIT, t + WAIT + 30 days);
        _ask();
        (,, uint64 requestedAt, uint64 runnableAt, uint64 lapsesAt,) = _claim();
        assertEq(requestedAt, t);
        assertEq(runnableAt, t + WAIT);
        assertEq(lapsesAt, t + WAIT + 30 days);
        vm.warp(runnableAt - 1);
        _expectRevert(rec, _runData(rec), abi.encodeWithSelector(VaultProtectionBase.NotReady.selector, runnableAt));
        vm.warp(lapsesAt + 1);
        _expectRevert(rec, _runData(rec), _err(VaultProtectionBase.NoClaim.selector));
        assertEq(_open(), 0, "lapsed");
    }

    // ─── 5. Cancelling ─────────────────────────────────────────────────

    function test_05_theOwnerCancels_onALockedAccount_afterTheWait() public {
        _matured();
        P.lock(address(diamond), acct, signerA); // drops it; ask again after the pause
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _ask();
        vm.warp(vm.getBlockTimestamp() + WAIT);
        uint64 at = _open();
        vm.expectEmit(address(vault));
        emit RecoveryClaimEnded(acct, at, acct, 0, uint64(vm.getBlockTimestamp() + 30 days));
        _protect(acct, _cancelData(acct));
        assertEq(_open(), 0);
        _expectRevert(rec, _runData(rec), _err(VaultProtectionBase.NoClaim.selector));
    }

    function test_05_aSignerCancels_strangerAndRecoveryCannot() public {
        _matured();
        _expectRevert(
            stranger, _cancelData(stranger), abi.encodeWithSelector(VaultProtectionBase.NotOwnerOrSigner.selector, stranger)
        );
        _expectRevert(rec, _cancelData(rec), abi.encodeWithSelector(VaultProtectionBase.NotOwnerOrSigner.selector, rec));
        _protect(signerA, _cancelData(signerA));
        assertEq(_open(), 0);
        _expectRevert(signerA, _cancelData(signerA), _err(VaultProtectionBase.NoClaim.selector));
    }

    // ─── 6. A lock, a replacement and a clawback drop a claim ──────────

    function test_06_aSignersLockDrops_andStartsThePause() public {
        _allow(WAIT);
        _ask();
        uint64 at = _open();
        vm.expectEmit(address(vault));
        emit RecoveryClaimEnded(acct, at, signerA, 3, uint64(vm.getBlockTimestamp() + 30 days));
        P.lock(address(diamond), acct, signerA);
        assertEq(_open(), 0);
        (,,,,, uint64 pauseUntil) = _claim();
        assertEq(pauseUntil, vm.getBlockTimestamp() + 30 days);
    }

    function test_06_aReplacementDrops() public {
        _allow(WAIT);
        address nominee = makeAddr("nominee");
        // The owner's proposal, signed and submitted by someone else, so it
        // drops nothing itself; the claim is asked after it.
        uint8 purpose = code.PURPOSE_REPLACEMENT();
        bytes32 h = keccak256(
            abi.encode(
                code.REPLACEMENT_TYPEHASH(), uint8(1), nominee, uint32(0), vault.protectionNonce(acct, purpose), uint64(vm.getBlockTimestamp() + 400 days)
            )
        );
        _protect(stranger, abi.encodeCall(VaultProtection.replacement, (uint8(1), nominee, _sign(OWNER_KEY, h))));
        _ask();
        uint64 at = _open();
        assertTrue(at != 0, "a signed write dropped nothing");
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectEmit(address(vault));
        emit RecoveryClaimEnded(acct, at, address(0), 4, uint64(vm.getBlockTimestamp() + 30 days));
        P.finalizeReplacement(address(diamond), acct);
        assertEq(_open(), 0);
    }

    function test_06_aClawbackDrops() public {
        _allow(WAIT);
        _ask();
        uint64 at = _open();
        vm.expectEmit(address(vault));
        emit RecoveryClaimEnded(acct, at, signerA, 5, uint64(vm.getBlockTimestamp() + 30 days));
        _protect(signerA, abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(signerA))));
        assertEq(_open(), 0);
    }

    // ─── 7. The owner's direct calls drop; signed writes do not ────────

    function test_07_eachKindOfOwnerDirectCallDrops() public {
        _allow(WAIT);
        bytes[4] memory calls = [
            abi.encodeCall(VaultProtection.setDelay, (uint32(4 days), P.direct(acct))),
            abi.encodeCall(VaultProtection.addAllowlisted, (makeAddr("dest"), P.direct(acct))),
            abi.encodeCall(VaultProtection.signerChange, (uint8(1), makeAddr("s2"), P.direct(acct))),
            abi.encodeCall(VaultProtection.lock, (P.direct(acct)))
        ];
        for (uint256 i; i < calls.length; ++i) {
            (,,,,, uint64 pauseUntil) = _claim();
            if (vm.getBlockTimestamp() < pauseUntil) vm.warp(pauseUntil);
            _ask();
            uint64 at = _open();
            vm.expectEmit(address(vault));
            emit RecoveryClaimEnded(acct, at, acct, 1, uint64(vm.getBlockTimestamp() + 30 days));
            _protect(acct, calls[i]);
            assertEq(_open(), 0, "dropped");
        }
    }

    function test_07_anOwnerNonceBurnDrops_aSignerBurnDoesNot() public {
        _allow(WAIT);
        _ask();
        uint8 purpose = code.PURPOSE_ALLOWLIST_ADD();
        _protect(signerA, abi.encodeCall(VaultProtection.burnNonce, (purpose)));
        assertTrue(_open() != 0, "a signer's burn drops nothing");
        uint64 at = _open();
        vm.expectEmit(address(vault));
        emit RecoveryClaimEnded(acct, at, acct, 1, uint64(vm.getBlockTimestamp() + 30 days));
        _protect(acct, abi.encodeCall(VaultProtection.burnNonce, (purpose)));
        assertEq(_open(), 0, "the owner's burn dropped it");
    }

    function test_07_aChangeOfAddressByDirectCallDrops() public {
        _allow(WAIT);
        _ask();
        P.requestRecovery(address(diamond), acct, acct, REC2_KEY);
        assertEq(_open(), 0);
    }

    function test_07_aSignedWriteSubmittedLaterDropsNothing_aSignedSwitchOffEnds() public {
        _allow(WAIT);
        address dest = makeAddr("dest");
        uint8 purpose = code.PURPOSE_ALLOWLIST_ADD();
        VaultProtectionBase.Auth memory a = _sign(
            OWNER_KEY,
            keccak256(
                abi.encode(
                    code.ALLOWLIST_ADD_TYPEHASH(), dest, vault.protectionNonce(acct, purpose), uint64(vm.getBlockTimestamp() + 400 days)
                )
            )
        );
        // Signed before the claim, submitted after: takes effect, drops nothing.
        _ask();
        _protect(stranger, abi.encodeCall(VaultProtection.addAllowlisted, (dest, a)));
        assertTrue(_open() != 0, "a signed write drops nothing");
        // A spent signature is refused and drops nothing.
        _expectRevert(
            stranger,
            abi.encodeCall(VaultProtection.addAllowlisted, (dest, a)),
            abi.encodeWithSelector(VaultProtectionBase.BadSignature.selector, acct)
        );
        assertTrue(_open() != 0);
        // A signed switch-off ends the claim.
        uint8 sp = recCode.PURPOSE_RECOVERY_CLAIM_SETTING();
        VaultProtectionBase.Auth memory off = _sign(
            OWNER_KEY,
            keccak256(
                abi.encode(
                    recCode.RECOVERY_CLAIM_SETTING_TYPEHASH(), false, uint32(0), vault.protectionNonce(acct, sp), uint64(vm.getBlockTimestamp() + 400 days)
                )
            )
        );
        _protect(stranger, abi.encodeCall(VaultRecovery.setRecoveryClaim, (false, uint32(0), off)));
        assertEq(_open(), 0, "the signed switch-off ended it");
    }

    function test_07_aCancelSignedForAnotherClaimIsRefused() public {
        _allow(WAIT);
        uint8 lane = code.PURPOSE_ALLOWLIST_CANCEL();
        // Signed before any claim (requestedAt 0).
        VaultProtectionBase.Auth memory early = _sign(
            OWNER_KEY,
            keccak256(
                abi.encode(
                    recCode.RECOVERY_CLAIM_CANCEL_TYPEHASH(), uint64(0), vault.protectionNonce(acct, lane), uint64(vm.getBlockTimestamp() + 400 days)
                )
            )
        );
        vm.warp(vm.getBlockTimestamp() + 1);
        _ask();
        _expectRevert(
            stranger,
            abi.encodeCall(VaultRecovery.cancelRecoveryClaim, (early)),
            abi.encodeWithSelector(VaultProtectionBase.BadSignature.selector, acct)
        );
        // Signed for this claim: accepted.
        VaultProtectionBase.Auth memory right = _sign(
            OWNER_KEY,
            keccak256(
                abi.encode(
                    recCode.RECOVERY_CLAIM_CANCEL_TYPEHASH(), _open(), vault.protectionNonce(acct, lane), uint64(vm.getBlockTimestamp() + 400 days)
                )
            )
        );
        _protect(stranger, abi.encodeCall(VaultRecovery.cancelRecoveryClaim, (right)));
        assertEq(_open(), 0);
    }

    // ─── 8. The pause after a cancellation; none after a lapse ─────────

    function test_08_aCancelStartsThePause_aLapseDoesNot() public {
        _allow(WAIT);
        _ask();
        _protect(signerA, _cancelData(signerA));
        uint64 until = uint64(vm.getBlockTimestamp() + 30 days);
        _expectRevert(rec, _askData(rec), abi.encodeWithSelector(VaultProtectionBase.ClaimPaused.selector, until));
        vm.warp(until);
        _ask();
        (,,,, uint64 lapsesAt,) = _claim();
        vm.warp(lapsesAt + 1);
        _ask(); // at once after a lapse
        assertEq(_open(), uint64(vm.getBlockTimestamp()));
    }

    // ─── 9. Switching the claim off stops the old key ──────────────────

    function test_09_switchingOffStopsEveryone_untilTheOwnerSwitchesOnAgain() public {
        _allow(WAIT);
        _ask();
        _protect(acct, _setData(acct, false, 0));
        assertEq(_open(), 0);
        vm.warp(vm.getBlockTimestamp() + 31 days);
        _expectRevert(rec, _askData(rec), _err(VaultProtectionBase.ClaimNotAllowed.selector));
        _expectRevert(rec, _runData(rec), _err(VaultProtectionBase.NoClaim.selector));
        _allow(WAIT);
        _ask();
        assertTrue(_open() != 0);
    }

    function test_09_aChangeOfAddressStopsTheOldKey_unlessASignerCancelsIt() public {
        _allow(WAIT);
        _ask();
        P.requestRecovery(address(diamond), acct, acct, REC2_KEY); // drops the claim
        assertEq(_open(), 0);
        vm.warp(vm.getBlockTimestamp() + 29 days);
        _expectRevert(rec, _askData(rec), _err(VaultProtectionBase.RecoveryChangePending.selector));
        // A signer cancels the change: the old address may ask again once
        // the pause has passed.
        _protect(signerA, abi.encodeCall(VaultRecovery.cancelRecoveryAddress, (P.direct(signerA))));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _ask();
        assertTrue(_open() != 0, "the old key asks again after the pause");
    }

    function test_09_onceTheChangeIsInForce_onlyTheNewAddressAsks() public {
        _allow(WAIT);
        P.requestRecovery(address(diamond), acct, acct, REC2_KEY);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _expectRevert(rec, _askData(rec), abi.encodeWithSelector(VaultProtectionBase.NotRecovery.selector, rec));
        address rec2 = vm.addr(REC2_KEY);
        _protect(rec2, _askData(rec2));
        assertTrue(_open() != 0);
    }

    // ─── 10. Only the recovery address runs ────────────────────────────

    function test_10_onlyTheRecoveryAddressRuns() public {
        _matured();
        address[3] memory bad = [acct, signerA, stranger];
        for (uint256 i; i < bad.length; ++i) {
            _expectRevert(
                bad[i], _runData(bad[i]), abi.encodeWithSelector(VaultProtectionBase.NotRecovery.selector, bad[i])
            );
        }
    }

    // ─── 11. A run is the clawback, with its own trigger ───────────────

    function test_11_aRunIsTheClawback_recordedAsARecoveryClaim() public {
        _matured();
        uint256 before = tok.balanceOf(rec);
        vm.expectEmit(address(vault));
        emit AccountRecovered(acct, rec, rec, 3);
        _protect(rec, _runData(rec));
        assertEq(tok.balanceOf(rec) - before, 100 ether, "the free balance moved");
        (bool enabled, bool locked,,,) = vault.protectionCore();
        assertTrue(enabled && locked);
        (,,, bool recovered,) = vault.protectionRecovery();
        assertTrue(recovered);
        assertEq(_open(), 0);
    }

    function test_11_aSignedRunNamesTheClaimAndTheAssets() public {
        _matured();
        uint8 purpose = recCode.PURPOSE_RECOVERY_CLAIM();
        VaultProtectionBase.Auth memory a = _sign(
            REC_KEY,
            keccak256(
                abi.encode(
                    recCode.RECOVERY_CLAIM_RUN_TYPEHASH(),
                    keccak256(abi.encode(_assets())),
                    _open(),
                    vault.protectionNonce(rec, purpose),
                    uint64(vm.getBlockTimestamp() + 400 days)
                )
            )
        );
        _protect(stranger, abi.encodeCall(VaultRecovery.runRecoveryClaim, (_assets(), a)));
        assertEq(tok.balanceOf(rec), 100 ether);
    }

    // ─── 12. A locked account with nobody answering ────────────────────

    function test_12_aClaimOnALockedAccountRunsAfterTheWait() public {
        _allow(WAIT);
        P.lock(address(diamond), acct, acct);
        _ask();
        vm.warp(vm.getBlockTimestamp() + WAIT);
        _protect(rec, _runData(rec));
        assertEq(tok.balanceOf(rec), 100 ether);
    }

    // ─── 13. Nothing is restricted while a claim is open ───────────────

    function test_13_aWithdrawalWhileOpenBehavesAsUsual_andDropsNothing() public {
        _allow(WAIT);
        _ask();
        vm.prank(acct);
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(acct, K20, address(tok), 0, 10 ether, acct);
        assertTrue(_open() != 0, "a withdrawal drops nothing");
    }

    // ─── 14. Switching protected mode off switches the claim off ───────

    function test_14_switchingProtectionOffSwitchesTheClaimOff() public {
        _allow(WAIT);
        _ask();
        P.requestDisable(address(diamond), acct, acct); // a direct call: drops the claim
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeSettings(address(diamond), acct);
        (bool allowed, uint32 wait,,,,) = _claim();
        assertFalse(allowed);
        assertEq(wait, 0);
        P.enable(address(diamond), acct, DELAY);
        (allowed,,,,,) = _claim();
        assertFalse(allowed, "stays off when protected mode is on again");
    }

    // ─── 15. A recovered account ───────────────────────────────────────

    function test_15_aRecoveredAccountNeitherChangesNorAsks() public {
        _allow(WAIT);
        _protect(signerA, abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(signerA))));
        _expectRevert(acct, _setData(acct, false, 0), _err(VaultProtectionBase.RecoveredAccount.selector));
        _expectRevert(rec, _askData(rec), _err(VaultProtectionBase.RecoveredAccount.selector));
    }

    // ─── 16. A pending change of address refuses the run too ───────────

    function test_16_aPendingChangeRefusesTheRun() public {
        _matured();
        // The owner's SIGNED change, submitted by someone else, leaves the
        // claim open, so the run's own check is what refuses.
        address rec2 = vm.addr(REC2_KEY);
        uint8 purpose = code.PURPOSE_RECOVERY();
        uint64 exp = uint64(vm.getBlockTimestamp() + 400 days);
        VaultProtectionBase.Auth memory a = _sign(
            OWNER_KEY,
            keccak256(abi.encode(code.RECOVERY_SET_TYPEHASH(), rec2, vault.protectionNonce(acct, purpose), exp))
        );
        VaultProtectionBase.Auth memory proof = _sign(
            REC2_KEY,
            keccak256(
                abi.encode(
                    code.RECOVERY_PROOF_TYPEHASH(), acct, address(diamond), vault.protectionNonce(rec2, code.PURPOSE_RECOVERY_PROOF()), exp
                )
            )
        );
        _protect(stranger, abi.encodeCall(VaultRecovery.requestRecoveryAddress, (rec2, a, proof)));
        assertTrue(_open() != 0, "still open");
        _expectRevert(rec, _runData(rec), _err(VaultProtectionBase.RecoveryChangePending.selector));
    }

    /// @dev A claim is its asker's own: once a signed change submitted by
    ///      someone else comes into force, the old address's claim is void.
    ///      The new address cannot run it, and may ask for itself at once.
    function test_16_aMaturedChangeVoidsTheOldClaim_theNewAddressAsksAfresh() public {
        _allow(WAIT);
        _ask();
        address rec2 = vm.addr(REC2_KEY);
        uint8 purpose = code.PURPOSE_RECOVERY();
        uint64 exp = uint64(vm.getBlockTimestamp() + 400 days);
        VaultProtectionBase.Auth memory a = _sign(
            OWNER_KEY,
            keccak256(abi.encode(code.RECOVERY_SET_TYPEHASH(), rec2, vault.protectionNonce(acct, purpose), exp))
        );
        VaultProtectionBase.Auth memory proof = _sign(
            REC2_KEY,
            keccak256(
                abi.encode(
                    code.RECOVERY_PROOF_TYPEHASH(), acct, address(diamond), vault.protectionNonce(rec2, code.PURPOSE_RECOVERY_PROOF()), exp
                )
            )
        );
        _protect(stranger, abi.encodeCall(VaultRecovery.requestRecoveryAddress, (rec2, a, proof)));
        assertTrue(_open() != 0, "open while the change waits");
        // The old claim's run date passes after the change is in force.
        vm.warp(vm.getBlockTimestamp() + WAIT);
        assertEq(_open(), 0, "void once the change is in force");
        _expectRevert(rec2, _runData(rec2), _err(VaultProtectionBase.NoClaim.selector));
        // The new address asks at once, with no pause, and waits its own wait.
        _protect(rec2, _askData(rec2));
        (,, uint64 requestedAt, uint64 runnableAt,,) = _claim();
        assertEq(requestedAt, uint64(vm.getBlockTimestamp()));
        assertEq(runnableAt, uint64(vm.getBlockTimestamp()) + WAIT);
        _expectRevert(rec2, _runData(rec2), abi.encodeWithSelector(VaultProtectionBase.NotReady.selector, runnableAt));
    }

    // ─── 17. Pause and escape window ───────────────────────────────────

    function test_17_whilePaused_everyCancelWorks_aRunIsRefused() public {
        _matured();
        AdminFacet(address(diamond)).pause();
        vm.warp(vm.getBlockTimestamp() + LibPausable.ESCAPE_GRACE_DEFAULT); // the escape window open
        _expectRevert(rec, _runData(rec), _err(LibPausable.EnforcedPause.selector));
        _protect(acct, _cancelData(acct));
        assertEq(_open(), 0, "the owner's cancel");
    }

    function test_17_whilePaused_aSignersCancelAndAnOwnersCallEndIt() public {
        _allow(WAIT);
        _ask();
        AdminFacet(address(diamond)).pause();
        _protect(signerA, _cancelData(signerA));
        assertEq(_open(), 0, "the signer's cancel");
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _ask();
        _protect(acct, abi.encodeCall(VaultProtection.addAllowlisted, (makeAddr("dest"), P.direct(acct))));
        assertEq(_open(), 0, "the owner's direct call");
    }

    // ─── 18. A sequencer outage ────────────────────────────────────────

    function test_18_aRunWaits24HoursAfterAnOutage() public {
        _matured();
        address guard = LibTestPriceGuard.guardOf(address(diamond));
        uint256 windowEnd = vm.getBlockTimestamp() - 1 hours;
        vm.mockCall(
            guard,
            abi.encodeWithSelector(IPriceGuard.sequencerOutageWindow.selector),
            abi.encode(windowEnd - 2 hours, windowEnd)
        );
        _expectRevert(
            rec,
            _runData(rec),
            abi.encodeWithSelector(RecoveryClawbackFacet.ClaimRunAfterOutage.selector, windowEnd + 24 hours)
        );
        vm.warp(windowEnd + 24 hours);
        _protect(rec, _runData(rec));
        assertEq(tok.balanceOf(rec), 100 ether);
    }

    function test_18_anUnreadableGuardRefusesTheRun_noSequencerPasses() public {
        _matured();
        address guard = LibTestPriceGuard.guardOf(address(diamond));
        vm.mockCallRevert(guard, abi.encodeWithSelector(IPriceGuard.sequencerOutageWindow.selector), "");
        _expectRevert(rec, _runData(rec), _err(RecoveryClawbackFacet.ClaimOutageUnreadable.selector));
        vm.clearMockedCalls();
        // The suite's guard has no sequencer feed (an L1): (0, 0), no wait.
        (uint256 d, uint256 e) = IPriceGuard(guard).sequencerOutageWindow();
        assertEq(d + e, 0);
        _protect(rec, _runData(rec));
        assertEq(tok.balanceOf(rec), 100 ether);
    }

    function test_18_theOwnersOwnClawbackIgnoresTheOutage() public {
        address guard = LibTestPriceGuard.guardOf(address(diamond));
        vm.mockCallRevert(guard, abi.encodeWithSelector(IPriceGuard.sequencerOutageWindow.selector), "");
        _protect(acct, abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(acct))));
        assertEq(tok.balanceOf(rec), 100 ether);
    }

    // ─── 19. A permissionless finalization drops nothing ───────────────

    function test_19_aStrangersFinalizationDropsNothing() public {
        _allow(WAIT);
        address s2 = makeAddr("s2");
        // The owner asks for a signer by SIGNATURE before the claim...
        uint8 purpose = code.PURPOSE_SIGNER_CHANGE();
        VaultProtectionBase.Auth memory a = _sign(
            OWNER_KEY,
            keccak256(
                abi.encode(
                    code.SIGNER_CHANGE_TYPEHASH(), uint8(1), s2, vault.protectionNonce(acct, purpose), uint64(vm.getBlockTimestamp() + 400 days)
                )
            )
        );
        _protect(stranger, abi.encodeCall(VaultProtection.signerChange, (uint8(1), s2, a)));
        _protect(s2, abi.encodeCall(VaultProtection.signerChange, (uint8(2), s2, P.direct(s2))));
        _ask();
        vm.warp(vm.getBlockTimestamp() + DELAY);
        // ...and a stranger finalizes it and settles the address.
        _protect(stranger, abi.encodeCall(VaultProtection.finalizeSigner, (s2)));
        _protect(stranger, abi.encodeCall(VaultRecovery.settleRecoveryAddress, ()));
        assertTrue(_open() != 0, "nothing dropped");
    }

    // ─── 20. A replaced account ────────────────────────────────────────

    function test_20_aReplacedAccountsClaimRunsUnderItsManager() public {
        _allow(WAIT);
        address nominee = makeAddr("nominee");
        P.propose(address(diamond), acct, acct, nominee);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeReplacement(address(diamond), acct);
        (bool allowed,,,,,) = _claim();
        assertTrue(allowed, "the setting survives a replacement");
        _ask();
        // The retired wallet can neither cancel nor change the setting.
        _expectRevert(acct, _cancelData(acct), abi.encodeWithSelector(VaultProtectionBase.NotOwnerOrSigner.selector, acct));
        _expectRevert(acct, _setData(acct, false, 0), abi.encodeWithSelector(VaultProtectionBase.NotOwner.selector, acct));
        // The manager cancels.
        _protect(nominee, _cancelData(nominee));
        assertEq(_open(), 0);
    }
}
