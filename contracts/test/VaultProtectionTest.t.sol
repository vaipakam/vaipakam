// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {VaultProtection} from "../src/vault/VaultProtection.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultOutflowTypes} from "../src/vault/VaultOutflowTypes.sol";
import {ProtectedAccountFacet} from "../src/facets/ProtectedAccountFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestProtection as P} from "./helpers/LibTestProtection.sol";

/// @dev A contract wallet that approves exactly the digests its acct key
///      signed (ERC-1271), as a Safe does.
contract MockContractWallet {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 digest, bytes calldata sig) external view returns (bytes4) {
        (bytes32 r, bytes32 s, uint8 v) = abi.decode(sig, (bytes32, bytes32, uint8));
        return ecrecover(digest, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/**
 * @title  VaultProtectionTest
 * @notice #3379 Stage B2 — protected mode held by the vault.
 *         - The vault is the only writer: the key's own call or its EIP-712
 *           signature (ERC-1271 for a contract wallet), bound to the chain,
 *           the vault, a per-purpose nonce and an expiry; a used, burned or
 *           expired signature is refused; the code refuses a direct call.
 *         - The allowlist waits its delay, can be cancelled by any signer,
 *           expires one delay after maturing, and carries the #3415 flag.
 *         - A lock (also signed and relayed by anyone, #3423) holds acct-class
 *           outflows at the vault and is applied on the platform.
 *         - A replacement moves the vault's acct record after the delay.
 */
contract VaultProtectionTest is SetupTest {
    uint32 internal constant DELAY = 3 days;
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant SIGNER_KEY = 0x5161;
    address internal acct;
    address internal signerA;
    address internal s2 = makeAddr("s2");
    address internal s3 = makeAddr("s3");
    address internal dest = makeAddr("dest");
    address internal relayer = makeAddr("relayer");
    address internal nominee = makeAddr("nominee");
    VaipakamVaultImplementation internal vault;
    VaultProtection internal code;

    function setUp() public {
        setupHelper();
        acct = vm.addr(OWNER_KEY);
        signerA = vm.addr(SIGNER_KEY);
        vault = P.vaultOf(address(diamond), acct);
        code = VaultProtection(vault.PROTECTION());
        P.enable(address(diamond), acct, DELAY);
    }

    // ─── Signing helpers ────────────────────────────────────────────────

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Vaipakam Vault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
    }

    function _sig(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _domain(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _signed(address key, uint64 expiry, bytes memory sig) internal pure returns (VaultProtection.Auth memory a) {
        a.key = key;
        a.expiry = expiry;
        a.sig = sig;
    }

    function _addSig(address destination, uint256 nonce, uint64 expiry) internal view returns (bytes memory) {
        return _sig(OWNER_KEY, keccak256(abi.encode(code.ALLOWLIST_ADD_TYPEHASH(), destination, nonce, expiry)));
    }

    // ─── Who may write ──────────────────────────────────────────────────

    function test_theCodeRefusesADirectCall() public {
        vm.expectRevert(VaultProtection.NotDelegateCall.selector);
        code.lock(P.direct(acct));
    }

    function test_onlyTheOwnerKeyAddsADestination() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.NotOwner.selector, relayer));
        vault.protect(abi.encodeCall(VaultProtection.addAllowlisted, (dest, P.direct(relayer))));
        // Naming the acct without being it, and without a signature, fails.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, acct));
        vault.protect(abi.encodeCall(VaultProtection.addAllowlisted, (dest, P.direct(acct))));
    }

    function test_aSignedAddIsRelayedOnce_andExpiresAndBurns() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _addSig(dest, 0, expiry);
        vm.prank(relayer);
        vault.protect(abi.encodeCall(VaultProtection.addAllowlisted, (dest, _signed(acct, expiry, sig))));
        assertEq(vault.protectionNonce(acct, code.PURPOSE_ALLOWLIST_ADD()), 1, "the nonce is spent");
        // The same signature again is refused (its nonce is used).
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, acct));
        vault.protect(abi.encodeCall(VaultProtection.addAllowlisted, (makeAddr("d2"), _signed(acct, expiry, sig))));

        // An expired one is refused.
        bytes memory late = _addSig(makeAddr("d3"), 1, expiry);
        vm.warp(expiry + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.SignatureExpired.selector, expiry));
        vault.protect(abi.encodeCall(VaultProtection.addAllowlisted, (makeAddr("d3"), _signed(acct, expiry, late))));

        // The acct burns nonce 1: a signature given with it is void.
        uint64 e2 = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes memory burned = _addSig(makeAddr("d4"), 1, e2);
        uint8 addPurpose = code.PURPOSE_ALLOWLIST_ADD();
        vm.prank(acct);
        vault.protect(abi.encodeCall(VaultProtection.burnNonce, (addPurpose)));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, acct));
        vault.protect(abi.encodeCall(VaultProtection.addAllowlisted, (makeAddr("d4"), _signed(acct, e2, burned))));
    }

    function test_aSignatureIsBoundToTheChainAndTheVault() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _addSig(dest, 0, expiry);
        vm.chainId(block.chainid + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, acct));
        vault.protect(abi.encodeCall(VaultProtection.addAllowlisted, (dest, _signed(acct, expiry, sig))));
    }

    function test_aContractWalletOwnerSignsThroughErc1271() public {
        MockContractWallet wallet = new MockContractWallet(vm.addr(OWNER_KEY));
        VaipakamVaultImplementation wv = P.vaultOf(address(diamond), address(wallet));
        P.enable(address(diamond), address(wallet), DELAY);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes32 h = keccak256(abi.encode(code.ALLOWLIST_ADD_TYPEHASH(), dest, uint256(0), expiry));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Vaipakam Vault"),
                keccak256("1"),
                block.chainid,
                address(wv)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, keccak256(abi.encodePacked("\x19\x01", domain, h)));
        vm.prank(relayer);
        wv.protect(abi.encodeCall(VaultProtection.addAllowlisted, (dest, _signed(address(wallet), expiry, abi.encode(r, s, v)))));
        assertGt(wv.allowEntry(dest).readyAt, 0, "the contract wallet's signature was accepted");
    }

    // ─── Allowlist ──────────────────────────────────────────────────────

    function test_aDestinationWaitsItsDelay_anySignerCancels_andItExpires() public {
        P.addSigner(address(diamond), acct, acct, signerA, DELAY);
        P.call(address(diamond), acct, acct, abi.encodeCall(VaultProtection.addAllowlisted, (dest, P.direct(acct))));
        vm.expectRevert();
        vault.protect(abi.encodeCall(VaultProtection.finalizeAllowlisted, (dest)));
        P.call(address(diamond), acct, signerA, abi.encodeCall(VaultProtection.cancelAllowlisted, (dest, P.direct(signerA))));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(VaultProtection.NotRequested.selector);
        vault.protect(abi.encodeCall(VaultProtection.finalizeAllowlisted, (dest)));

        // Asked again and left past its window: it expired.
        P.call(address(diamond), acct, acct, abi.encodeCall(VaultProtection.addAllowlisted, (dest, P.direct(acct))));
        vm.warp(block.timestamp + 2 * DELAY + 1);
        vm.expectRevert();
        vault.protect(abi.encodeCall(VaultProtection.finalizeAllowlisted, (dest)));
    }

    function test_theVaultPaysOnlyAFinalizedDestination() public {
        ERC20Mock t = new ERC20Mock("T", "T", 18);
        t.mint(address(vault), 10 ether);
        VaultOutflowTypes.Outflow memory o;
        o.class_ = VaultOutflowTypes.OutflowClass.OwnerAllowlisted;
        o.kind = VaultOutflowTypes.AssetKind.ERC20;
        o.asset = address(t);
        o.amount = 1 ether;
        o.to = dest;
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.OutflowDestinationRefused.selector, VaultOutflowTypes.OutflowClass.OwnerAllowlisted, dest
            )
        );
        vault.transferOut(o);
        P.allow(address(diamond), acct, acct, dest, DELAY);
        vm.prank(address(diamond));
        vault.transferOut(o);
        assertEq(t.balanceOf(dest), 1 ether, "a finalized destination is paid");
    }

    function test_3415_aDestinationVerifiesItself() public {
        P.call(address(diamond), acct, acct, abi.encodeCall(VaultProtection.addAllowlisted, (dest, P.direct(acct))));
        assertFalse(vault.allowEntry(dest).verified);
        // Someone else cannot verify for it.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, dest));
        vault.protect(abi.encodeCall(VaultProtection.verifyDestination, (acct, address(diamond), P.direct(dest))));
        P.verify(address(diamond), acct, dest);
        assertTrue(vault.allowEntry(dest).verified, "the destination's own call verifies it");
    }

    // ─── Lock (#3423) ───────────────────────────────────────────────────

    function test_aSignedLockIsRelayedByAnyone_andHoldsOwnerOutflows() public {
        P.addSigner(address(diamond), acct, acct, signerA, DELAY);
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes memory sig = _sig(SIGNER_KEY, keccak256(abi.encode(code.LOCK_TYPEHASH(), uint256(0), expiry)));
        vm.prank(relayer);
        vault.protect(abi.encodeCall(VaultProtection.lock, (_signed(signerA, expiry, sig))));
        (, bool locked,,,,,) = vault.protectionState();
        assertTrue(locked, "locked by the relayed signature");
        // A used lock signature is refused.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, signerA));
        vault.protect(abi.encodeCall(VaultProtection.lock, (_signed(signerA, expiry, sig))));

        VaultOutflowTypes.Outflow memory o;
        o.class_ = VaultOutflowTypes.OutflowClass.Owner;
        o.kind = VaultOutflowTypes.AssetKind.ERC20;
        o.asset = address(mockERC20);
        o.amount = 1;
        o.to = acct;
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.OutflowDestinationRefused.selector, VaultOutflowTypes.OutflowClass.Owner, acct
            )
        );
        vault.transferOut(o);

        // The platform applies it; the acct's unlock waits the delay.
        ProtectedAccountFacet(address(diamond)).applyProtection(acct);
        P.requestUnlock(address(diamond), acct, acct);
        vm.warp(block.timestamp + DELAY);
        P.finalizeSettings(address(diamond), acct);
        (, locked,,,,,) = vault.protectionState();
        assertFalse(locked);
    }

    function test_onlyTheDiamondLocksForThePlatform() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.NotOwnerOrSigner.selector, relayer));
        vault.protect(abi.encodeCall(VaultProtection.lockByPlatform, (relayer)));
    }

    // ─── Replacement ────────────────────────────────────────────────────

    function test_theOwnersReplacementMovesTheOwnerRecordAfterTheDelay() public {
        P.propose(address(diamond), acct, acct, nominee);
        vm.expectRevert();
        vault.protect(abi.encodeCall(VaultProtection.finalizeReplacement, ()));
        vm.warp(block.timestamp + DELAY);
        P.finalizeReplacement(address(diamond), acct);
        assertEq(vault.vaultOwner(), nominee, "the acct record follows the replacement");
        assertEq(vault.vaultCreationOwner(), acct, "the vault stays the one created for the account");
        assertEq(LibProtectedAccountProbe.manager(address(diamond), acct), nominee);
        assertEq(ProtectedAccountFacet(address(diamond)).getRetiredAccountOf(nominee), acct);
    }

    function test_aSignerMajorityReplacementWaitsTheDelayFromTheMajority() public {
        P.addSigner(address(diamond), acct, acct, signerA, DELAY);
        P.addSigner(address(diamond), acct, acct, s2, DELAY);
        P.addSigner(address(diamond), acct, acct, s3, DELAY);
        P.propose(address(diamond), acct, signerA, nominee);
        (,, uint64 readyAt,) = vault.replacementProposal();
        assertEq(readyAt, 0, "one of three is no majority");
        P.approve(address(diamond), acct, s2, nominee);
        (,, readyAt,) = vault.replacementProposal();
        assertEq(readyAt, block.timestamp + DELAY, "the delay starts at the majority");
        vm.warp(block.timestamp + DELAY);
        P.finalizeReplacement(address(diamond), acct);
        assertEq(vault.vaultOwner(), nominee);
    }

    function test_theOwnerCannotRedirectARecoveryUnderASignerLock() public {
        P.addSigner(address(diamond), acct, acct, signerA, DELAY);
        P.lock(address(diamond), acct, signerA);
        vm.prank(acct);
        vm.expectRevert(VaultProtection.OwnerBlockedBySignerLock.selector);
        vault.protect(abi.encodeCall(VaultProtection.replacement, (uint8(1), makeAddr("thief2"), P.direct(acct))));
    }

    // ─── Codex #3489 round 1 ─────────────────────────────────────────────

    /// @dev Each operation has its own typehash: a signed cancel of an unlock
    ///      (protective) can never be submitted as an unlock request.
    function test_aSignedCancelIsNeverARequest() public {
        P.lock(address(diamond), acct, acct);
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 hours);
        uint8 unlock = code.SETTINGS_UNLOCK();
        bytes memory cancelSig =
            _sig(OWNER_KEY, keccak256(abi.encode(code.SETTING_CANCEL_TYPEHASH(), unlock, uint256(0), expiry)));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, acct));
        vault.protect(abi.encodeCall(VaultProtection.requestUnlock, (_signed(acct, expiry, cancelSig))));
        // The same message signed under the settings typehash (the old shape)
        // is not a cancel either.
        bytes memory requestSig = _sig(
            OWNER_KEY, keccak256(abi.encode(code.SETTINGS_TYPEHASH(), unlock, uint256(0), uint256(0), expiry))
        );
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, acct));
        vault.protect(abi.encodeCall(VaultProtection.cancelSetting, (unlock, _signed(acct, expiry, requestSig))));
    }

    /// @dev A cancel of a pending addition is not a removal, nor the reverse.
    function test_anAllowlistCancelIsNeverARemoval() public {
        P.allow(address(diamond), acct, acct, dest, DELAY);
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes memory cancelSig =
            _sig(OWNER_KEY, keccak256(abi.encode(code.ALLOWLIST_CANCEL_TYPEHASH(), dest, uint256(0), expiry)));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, acct));
        vault.protect(abi.encodeCall(VaultProtection.removeAllowlisted, (dest, _signed(acct, expiry, cancelSig))));
    }

    /// @dev Codex #3489 r2 — a signed replacement cancel names the proposal
    ///      (nominee and round): one held for an earlier proposal never
    ///      aborts a later one, even a re-proposal of the same nominee.
    function test_aHeldCancelNeverAbortsALaterProposal() public {
        P.addSigner(address(diamond), acct, acct, signerA, DELAY);
        P.propose(address(diamond), acct, acct, nominee);
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 hours);
        uint8 purpose = code.PURPOSE_REPLACEMENT();
        uint256 n = vault.protectionNonce(signerA, purpose);
        uint8 cancel = code.REPLACE_CANCEL();
        bytes memory held = _sig(
            SIGNER_KEY, keccak256(abi.encode(code.REPLACEMENT_TYPEHASH(), cancel, nominee, uint32(1), n, expiry))
        );
        P.propose(address(diamond), acct, acct, nominee); // round 2, same nominee
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, signerA));
        vault.protect(abi.encodeCall(VaultProtection.replacement, (cancel, nominee, _signed(signerA, expiry, held))));
        // Signed for the proposal in force, it cancels.
        bytes memory current = _sig(
            SIGNER_KEY, keccak256(abi.encode(code.REPLACEMENT_TYPEHASH(), cancel, nominee, uint32(2), n, expiry))
        );
        vm.prank(relayer);
        vault.protect(abi.encodeCall(VaultProtection.replacement, (cancel, nominee, _signed(signerA, expiry, current))));
        (address pending,,,) = vault.replacementProposal();
        assertEq(pending, address(0), "cancelled");
    }

    /// @dev Codex #3489 r3 — an approval is bound to its round too: one
    ///      withheld from a cancelled proposal is refused after the same
    ///      nominee is proposed again.
    function test_aHeldApprovalNeverCountsForALaterProposal() public {
        address[3] memory more = [signerA, s2, s3];
        for (uint256 i; i < 3; ++i) P.addSigner(address(diamond), acct, acct, more[i], DELAY);
        P.propose(address(diamond), acct, s2, nominee); // round 1, by a signer
        uint8 approve = code.REPLACE_APPROVE();
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 hours);
        uint256 n = vault.protectionNonce(signerA, code.PURPOSE_REPLACEMENT());
        bytes memory held =
            _sig(SIGNER_KEY, keccak256(abi.encode(code.REPLACEMENT_TYPEHASH(), approve, nominee, uint32(1), n, expiry)));
        P.call(address(diamond), acct, s3, abi.encodeCall(VaultProtection.replacement, (code.REPLACE_CANCEL(), nominee, P.direct(s3))));
        P.propose(address(diamond), acct, s2, nominee); // round 2, same nominee
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadSignature.selector, signerA));
        vault.protect(abi.encodeCall(VaultProtection.replacement, (approve, nominee, _signed(signerA, expiry, held))));
    }

    /// @dev A cancel naming another nominee is refused on-chain too.
    function test_aCancelNamingAnotherNomineeIsRefused() public {
        P.propose(address(diamond), acct, acct, nominee);
        uint8 cancel = code.REPLACE_CANCEL();
        vm.prank(acct);
        vm.expectRevert(VaultProtection.NoProposal.selector);
        vault.protect(abi.encodeCall(VaultProtection.replacement, (cancel, relayer, P.direct(acct))));
    }

    /// @dev A verification must name this vault's account and Diamond.
    function test_aVerificationNamingAnotherAccountOrDiamondIsRefused() public {
        P.call(address(diamond), acct, acct, abi.encodeCall(VaultProtection.addAllowlisted, (dest, P.direct(acct))));
        vm.prank(dest);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadDestination.selector, dest));
        vault.protect(abi.encodeCall(VaultProtection.verifyDestination, (relayer, address(diamond), P.direct(dest))));
        vm.prank(dest);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadDestination.selector, dest));
        vault.protect(abi.encodeCall(VaultProtection.verifyDestination, (acct, relayer, P.direct(dest))));
        assertFalse(vault.allowEntry(dest).verified);
    }
}

/// @dev The Diamond's manager read, as the app makes it.
library LibProtectedAccountProbe {
    function manager(address diamond, address account) internal returns (address) {
        return P.vaultOf(diamond, account).vaultOwner();
    }
}
