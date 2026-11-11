// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {VaultProtection} from "../src/vault/VaultProtection.sol";
import {LibTestProtection} from "./helpers/LibTestProtection.sol";
import {Test, console} from "forge-std/Test.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";
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
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultBeacon} from "../src/VaultBeacon.sol";
import {LibProtectedAccount} from "../src/libraries/LibProtectedAccount.sol";
import {HelperTest} from "./HelperTest.sol";
import {LibTestVaultEndpoints} from "./helpers/LibTestVaultEndpoints.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

/// @dev A second vault version: the same code and layout, plus a marker.
contract VaultImplV2Marker is VaipakamVaultImplementation {
    constructor() VaipakamVaultImplementation(address(0), LibTestVaultEndpoints.none()) {}

    function versionMarker() external pure returns (uint256) {
        return 2;
    }
}

/// @dev A third version, so a pin can differ from the current one.
contract VaultImplV3Marker is VaipakamVaultImplementation {
    constructor() VaipakamVaultImplementation(address(0), LibTestVaultEndpoints.none()) {}

    function versionMarker() external pure returns (uint256) {
        return 3;
    }
}

/// @dev A contract that does not report the vault layout identity.
contract NotAVault {
    function vaultLayoutId() external pure returns (bytes32) {
        return keccak256("something else");
    }
}

/// @dev A test facet that writes any slot of the Diamond's storage, standing
///      for a faulty or malicious facet.
contract ArbitraryStorageFacet {
    function pokeSlot(bytes32 slot, bytes32 value) external {
        assembly {
            sstore(slot, value)
        }
    }
}

/**
 * @title VaultBeaconTest
 * @notice #3204 — the acceptance list of VaultCentralImplementationDesign §6:
 *         one central version every unpinned vault runs, the beacon's own
 *         code-change delay and the guardian's limits, pins held at the beacon
 *         under the owner's signature and the vault's pin delay, and the
 *         per-proxy resolution no facet can change.
 */
contract VaultBeaconTest is Test {
    VaipakamDiamond diamond;
    HelperTest helperTest;
    VaultBeacon beacon;
    ERC20Mock token;

    uint256 constant ALICE_KEY = 0xA11CE;
    uint256 constant BOB_KEY = 0xB0B;
    address alice;
    address bob;
    address guardian = makeAddr("guardian");
    address stranger = makeAddr("stranger");

    address v2;
    address v3;
    address vaultA;
    address vaultB;

    function setUp() public {
        alice = vm.addr(ALICE_KEY);
        bob = vm.addr(BOB_KEY);
        helperTest = new HelperTest();
        DiamondCutFacet cutFacet = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond = new VaipakamDiamond(address(this), address(cutFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](8);
        cuts[0] = _cut(type(VaultFactoryFacet).name, helperTest.getVaultFactoryFacetSelectorsExtended());
        cuts[1] = _cut(type(AdminFacet).name, helperTest.getAdminFacetSelectors());
        cuts[2] = _cut(type(ProfileFacet).name, helperTest.getProfileFacetSelectors());
        cuts[3] = _cut(type(AccessControlFacet).name, helperTest.getAccessControlFacetSelectors());
        cuts[4] = _cut(type(VaipakamNFTFacet).name, helperTest.getVaipakamNFTFacetSelectors());
        cuts[5] = _cut(type(ProtectedAccountFacet).name, helperTest.getProtectedAccountFacetSelectors());
        cuts[6] = _cut(type(VaultPayoutFacet).name, helperTest.getVaultPayoutFacetSelectors());
        cuts[7] = _cut(type(VaultDepositoryFacet).name, helperTest.getVaultDepositoryFacetSelectors());
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();
        beacon = LibTestVaultBeacon.install(address(diamond), address(this));
        LibTestPositionNFT.install(address(diamond), address(this));
        beacon.setGuardian(guardian);

        v2 = address(new VaultImplV2Marker());
        v3 = address(new VaultImplV3Marker());
        beacon.registerVersion(v2); // id 2
        beacon.registerVersion(v3); // id 3

        vaultA = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(alice);
        vaultB = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(bob);

        token = new ERC20Mock("Token", "TKN", 18);
        token.mint(alice, 1_000 ether);
        vm.prank(alice);
        token.approve(address(diamond), type(uint256).max);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _cut(string memory name, bytes4[] memory sels) internal returns (IDiamondCut.FacetCut memory) {
        return IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _marker(address vault) internal view returns (uint256) {
        (bool ok, bytes memory ret) = vault.staticcall(abi.encodeWithSignature("versionMarker()"));
        return ok ? abi.decode(ret, (uint256)) : 1;
    }

    function _setCurrent(uint256 id) internal {
        beacon.proposeCurrentVersion(id);
        vm.warp(block.timestamp + beacon.MIN_CODE_DELAY());
        beacon.executeCurrentVersion();
    }

    function _pinAlice(uint256 id) internal {
        bytes memory sig = _sign(ALICE_KEY, beacon.pinChangeDigest(vaultA, id));
        vm.prank(alice);
        VaultDepositoryFacet(address(diamond)).pinVaultVersion(id, sig);
    }

    function _unpinAlice() internal {
        bytes memory sig = _sign(ALICE_KEY, beacon.pinChangeDigest(vaultA, 0));
        vm.prank(alice);
        VaultDepositoryFacet(address(diamond)).unpinVaultVersion(alice, sig);
    }

    // ─── One central version ─────────────────────────────────────────────

    /// One executed current-version proposal changes the code every unpinned vault runs.
    function test_executedProposalMovesEveryUnpinnedVault() public {
        assertEq(_marker(vaultA), 1);
        assertEq(_marker(vaultB), 1);
        _setCurrent(2);
        assertEq(_marker(vaultA), 2, "vault A runs version 2");
        assertEq(_marker(vaultB), 2, "vault B runs version 2");
        assertEq(beacon.resolvedVersionOf(vaultA), 2);
    }

    /// A proposal cannot execute before MIN_CODE_DELAY, nor after a cancel.
    function test_proposalWaitsTheBeaconsOwnDelay_andCancelEndsIt() public {
        beacon.proposeCurrentVersion(2);
        (, , , uint64 at) = beacon.pendingProposal();
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.TooEarly.selector, uint256(at)));
        beacon.executeCurrentVersion();

        vm.prank(guardian);
        beacon.cancelProposal();
        vm.warp(at + 1);
        vm.expectRevert(VaultBeacon.NoProposal.selector);
        beacon.executeCurrentVersion();
        assertEq(beacon.currentVersionId(), 1);
    }

    /// The guardian can cancel but never propose, register or execute early.
    function test_guardianCannotProposeOrRegister() public {
        address v4 = address(new VaultImplV2Marker());
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", guardian));
        beacon.proposeCurrentVersion(2);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", guardian));
        beacon.registerVersion(v4);
        vm.stopPrank();

        beacon.proposeCurrentVersion(2);
        vm.prank(guardian);
        vm.expectRevert();
        beacon.executeCurrentVersion(); // still early, whoever calls
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NotOwnerOrGuardian.selector, stranger));
        beacon.cancelProposal();
    }

    /// The beacon has no upgrade path: no UUPS or proxy entry answers.
    function test_beaconHasNoUpgradePath() public {
        (bool ok, ) = address(beacon).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", v2, ""));
        assertFalse(ok, "upgradeToAndCall");
        (ok, ) = address(beacon).call(abi.encodeWithSignature("upgradeTo(address)", v2));
        assertFalse(ok, "upgradeTo");
        (ok, ) = address(beacon).call(abi.encodeWithSignature("proxiableUUID()"));
        assertFalse(ok, "proxiableUUID");
    }

    /// The registry can never be frozen by renouncing its ownership.
    function test_ownershipCannotBeRenounced() public {
        vm.expectRevert(VaultBeacon.RenounceDisabled.selector);
        beacon.renounceOwnership();
        assertEq(beacon.owner(), address(this));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        beacon.renounceOwnership();
    }

    // ─── Pins and revocation ─────────────────────────────────────────────

    /// A pinned vault keeps its version across a current-version change, and
    /// moves to the current one when its version is revoked.
    function test_pinHoldsAcrossAChange_andRevokeMovesIt() public {
        _pinAlice(3);
        assertEq(_marker(vaultA), 3, "pinned to 3");
        _setCurrent(2);
        assertEq(_marker(vaultA), 3, "still 3 after the change");
        assertEq(_marker(vaultB), 2, "unpinned vault moved");

        beacon.proposeRevoke(3, 0);
        vm.warp(block.timestamp + beacon.MIN_CODE_DELAY());
        beacon.executeRevoke();
        assertEq(_marker(vaultA), 2, "revoked pin falls back to current");
        assertEq(beacon.pinnedVersion(vaultA), 3, "the pin record stays; it no longer resolves");
    }

    /// Revoking the current version needs a live successor, which becomes current.
    function test_revokingCurrentNeedsALiveSuccessor() public {
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.VersionNotLive.selector, uint256(0)));
        beacon.proposeRevoke(1, 0);
        beacon.proposeRevoke(1, 2);
        vm.warp(block.timestamp + beacon.MIN_CODE_DELAY());
        beacon.executeRevoke();
        assertEq(beacon.currentVersionId(), 2);
        assertEq(_marker(vaultB), 2);
        // Revocation is final: version 1 can never be made current again.
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.VersionNotLive.selector, uint256(1)));
        beacon.proposeCurrentVersion(1);
    }

    /// The guardian's revoke works only while the Diamond is paused, and
    /// only onto a registered, live successor.
    function test_guardianRevokeOnlyWhilePaused_andOnlyToRegisteredCode() public {
        vm.prank(guardian);
        vm.expectRevert(VaultBeacon.NotPaused.selector);
        beacon.guardianRevokeVersion(1, 2);

        AdminFacet(address(diamond)).pause();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.VersionNotLive.selector, uint256(9)));
        beacon.guardianRevokeVersion(1, 9);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NotGuardian.selector, stranger));
        beacon.guardianRevokeVersion(1, 2);

        vm.prank(guardian);
        beacon.guardianRevokeVersion(1, 2);
        assertEq(beacon.currentVersionId(), 2);
        assertEq(_marker(vaultA), 2);
    }

    // ─── Registration ────────────────────────────────────────────────────

    function test_registerRefusesANonVaultAndANonOwner() public {
        address notVault = address(new NotAVault());
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NotAVaultImplementation.selector, notVault));
        beacon.registerVersion(notVault);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NoCode.selector, stranger));
        beacon.registerVersion(stranger);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.AlreadyRegistered.selector, v2));
        beacon.registerVersion(v2);

        address v4 = address(new VaultImplV2Marker());
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        beacon.registerVersion(v4);
    }

    // ─── Per-proxy resolution ────────────────────────────────────────────

    /// A pin by Alice never affects Bob.
    function test_resolutionIsPerProxy() public {
        _pinAlice(3);
        assertEq(_marker(vaultA), 3);
        assertEq(_marker(vaultB), 1, "Bob's vault is untouched");
        assertEq(beacon.resolvedVersionOf(vaultB), 1);
    }

    /// No Diamond storage write changes which code a vault runs, and a pin
    /// request without the owner's signature is refused by the beacon.
    function test_arbitraryDiamondStorageWriteCannotChangeVaultCode() public {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = ArbitraryStorageFacet.pokeSlot.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(new ArbitraryStorageFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Write a large span of the Diamond's main storage namespace, the
        // place a facet-held pointer would have lived.
        bytes32 base = keccak256("vaipakam.storage");
        for (uint256 i = 0; i < 64; ++i) {
            ArbitraryStorageFacet(address(diamond)).pokeSlot(bytes32(uint256(base) + i), bytes32(uint256(uint160(v3))));
        }
        assertEq(_marker(vaultA), 1, "vault A still runs version 1");
        assertEq(_marker(vaultB), 1, "vault B still runs version 1");

        // A pin carrying someone else's signature is refused at the beacon.
        bytes memory wrong = _sign(BOB_KEY, beacon.pinChangeDigest(vaultA, 3));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.InvalidSignature.selector, vaultA, alice));
        VaultDepositoryFacet(address(diamond)).pinVaultVersion(3, wrong);
    }

    /// The Diamond itself cannot pin without the owner's signature, and a
    /// signature is single-use.
    function test_diamondCannotPinWithoutTheOwner_andSignaturesAreSingleUse() public {
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.InvalidSignature.selector, vaultA, alice));
        beacon.requestPin(vaultA, 3, "");

        bytes memory sig = _sign(ALICE_KEY, beacon.pinChangeDigest(vaultA, 3));
        vm.prank(address(diamond));
        beacon.requestPin(vaultA, 3, sig);
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.InvalidSignature.selector, vaultA, alice));
        beacon.requestPin(vaultA, 3, sig); // the nonce moved

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NotDiamond.selector, stranger));
        beacon.requestPin(vaultA, 2, sig);
    }

    // ─── Protected mode: the pin delay ───────────────────────────────────

    function _protectAlice() internal {
        LibTestProtection.enable(address(diamond), alice, LibProtectedAccount.MIN_DELAY);
    }

    /// Under protected mode a first pin, a re-pin and an unpin each wait the
    /// delay, can be cancelled, and are refused while the account is locked.
    function test_protectedPinChangesWaitTheDelay_canBeCancelled_refusedWhileLocked() public {
        _protectAlice();
        uint256 d = beacon.pinDelay(vaultA);
        assertEq(d, beacon.MAX_DIAMOND_PIN_DELAY(), "protected mode raised the pin delay (capped)");

        // First pin waits.
        _pinAlice(3);
        assertEq(beacon.pinnedVersion(vaultA), 0, "not pinned yet");
        vm.expectRevert();
        beacon.executePin(vaultA);
        vm.warp(block.timestamp + d);
        beacon.executePin(vaultA);
        assertEq(beacon.pinnedVersion(vaultA), 3);

        // Re-pin waits, and the Diamond's protected-mode cancel ends it.
        _pinAlice(2);
        vm.prank(alice);
        ProtectedAccountFacet(address(diamond)).cancelSettingChange(alice, 6);
        vm.warp(block.timestamp + d);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NoPinChange.selector, vaultA));
        beacon.executePin(vaultA);
        assertEq(beacon.pinnedVersion(vaultA), 3, "the cancelled re-pin never applied");

        // Unpin waits too.
        _unpinAlice();
        assertEq(beacon.pinnedVersion(vaultA), 3);
        vm.warp(block.timestamp + d);
        beacon.executePin(vaultA);
        assertEq(beacon.pinnedVersion(vaultA), 0);

        // Locked: no pin request at all, and a lock cancels a pending one.
        _pinAlice(3);
        LibTestProtection.lock(address(diamond), alice, alice);
        (, uint256 at) = beacon.pendingPinOf(vaultA);
        assertEq(at, 0, "the lock cancelled the pending pin");
        bytes memory sig = _sign(ALICE_KEY, beacon.pinChangeDigest(vaultA, 2));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.ProtectedVaultLocked.selector, alice));
        VaultDepositoryFacet(address(diamond)).pinVaultVersion(2, sig);
    }

    /// #3522 seam 4 (in #3489): pin authority follows the vault's owner
    /// record. After a replacement the controller can unpin; the retired
    /// owner cannot unpin or change the pin delay, and a signature it gave
    /// before the recovery cannot be replayed.
    function test_pinAuthorityMovesToTheControllerOnReplacement() public {
        _protectAlice();
        // Pinned to the real vault code (version 1): the test markers carry no
        // protection code, and the replacement runs through the vault.
        _pinAlice(1);
        vm.warp(block.timestamp + beacon.pinDelay(vaultA));
        beacon.executePin(vaultA);
        assertEq(beacon.pinnedVersion(vaultA), 1, "fixture: pinned");
        bytes memory preRecovery = _sign(ALICE_KEY, beacon.pinChangeDigest(vaultA, 0));

        LibTestProtection.propose(address(diamond), alice, alice, bob);
        vm.warp(vm.getBlockTimestamp() + LibProtectedAccount.MIN_DELAY);
        LibTestProtection.finalizeReplacement(address(diamond), alice);
        vm.warp(vm.getBlockTimestamp() + LibProtectedAccount.MIN_DELAY + 1); // past the cool-down

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.InvalidSignature.selector, vaultA, bob));
        VaultDepositoryFacet(address(diamond)).unpinVaultVersion(alice, preRecovery);
        bytes memory retired = _sign(ALICE_KEY, beacon.pinChangeDigest(vaultA, 0));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.InvalidSignature.selector, vaultA, bob));
        VaultDepositoryFacet(address(diamond)).unpinVaultVersion(alice, retired);
        uint256 d = beacon.pinDelay(vaultA);
        bytes memory retiredDelay = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, d + 1));
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.InvalidSignature.selector, vaultA, bob));
        beacon.setPinDelay(vaultA, d + 1, retiredDelay);

        bytes memory controller = _sign(BOB_KEY, beacon.pinChangeDigest(vaultA, 0));
        vm.prank(bob);
        VaultDepositoryFacet(address(diamond)).unpinVaultVersion(alice, controller);
        vm.warp(vm.getBlockTimestamp() + beacon.pinDelay(vaultA));
        beacon.executePin(vaultA);
        assertEq(beacon.pinnedVersion(vaultA), 0, "the controller unpinned");
    }

    /// A facet calling the beacon directly with a valid owner signature can
    /// neither execute a pin before its time nor after a cancel, nor lower
    /// the pin delay before the current delay has passed.
    function test_validSignatureCannotSkipTheBeaconsDelay() public {
        _protectAlice();
        uint256 d = beacon.pinDelay(vaultA);
        bytes memory sig = _sign(ALICE_KEY, beacon.pinChangeDigest(vaultA, 3));
        vm.prank(address(diamond));
        beacon.requestPin(vaultA, 3, sig);
        (, uint256 at) = beacon.pendingPinOf(vaultA);
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.TooEarly.selector, at));
        beacon.executePin(vaultA);

        // The owner's own cancel at the beacon.
        bytes memory cancelSig = _sign(ALICE_KEY, beacon.cancelPinDigest(vaultA));
        beacon.cancelPin(vaultA, cancelSig);
        vm.warp(at + 1);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NoPinChange.selector, vaultA));
        beacon.executePin(vaultA);

        // Lowering the pin delay waits the current delay.
        bytes memory lowerSig = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, 0));
        beacon.setPinDelay(vaultA, 0, lowerSig);
        assertEq(beacon.pinDelay(vaultA), d, "not lowered yet");
        vm.expectRevert();
        beacon.executePinDelay(vaultA);
        vm.warp(block.timestamp + d);
        beacon.executePinDelay(vaultA);
        assertEq(beacon.pinDelay(vaultA), 0);
    }

    /// A Diamond-driven raise is capped below the code delay, so a pin
    /// requested right after a code proposal executes before the change.
    function test_diamondRaiseIsCapped_soAPinBeatsAQueuedCodeChange() public {
        uint256 cap = beacon.MAX_DIAMOND_PIN_DELAY();
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.DelayAboveDiamondCap.selector, uint256(30 days), cap));
        beacon.raisePinDelay(vaultA, 30 days);
        vm.prank(address(diamond));
        beacon.raisePinDelay(vaultA, cap);

        // A code change is proposed; the owner pins at once.
        beacon.proposeCurrentVersion(2);
        (, , , uint64 codeAt) = beacon.pendingProposal();
        _pinAlice(1);
        (, uint256 pinAt) = beacon.pendingPinOf(vaultA);
        assertLt(pinAt, codeAt, "the pin matures first");
        vm.warp(pinAt);
        beacon.executePin(vaultA);
        vm.warp(codeAt);
        beacon.executeCurrentVersion();
        assertEq(_marker(vaultA), 1, "Alice stayed on the version she pinned");
        assertEq(_marker(vaultB), 2);

        // Only the owner's own signature may go above the cap.
        bytes memory sig = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, 30 days));
        beacon.setPinDelay(vaultA, 30 days, sig);
        assertEq(beacon.pinDelay(vaultA), 30 days);
    }

    /// Every pin-delay path is bounded by MAX_PIN_DELAY: a delay of 2**64
    /// can never be set, so no later lowering can wrap its waiting time to
    /// zero; the boundary itself is accepted.
    function test_pinDelayIsBounded_noOverflowToZero() public {
        uint256 huge = uint256(1) << 64;
        uint256 max = beacon.MAX_PIN_DELAY();
        bytes memory sig = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, huge));
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.DelayTooLong.selector, huge, max));
        beacon.setPinDelay(vaultA, huge, sig);

        bytes memory over = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, max + 1));
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.DelayTooLong.selector, max + 1, max));
        beacon.setPinDelay(vaultA, max + 1, over);

        bytes memory atMax = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, max));
        beacon.setPinDelay(vaultA, max, atMax);
        assertEq(beacon.pinDelay(vaultA), max, "the boundary is accepted");

        // A lowering from the maximum still waits the full current delay.
        bytes memory lower = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, 0));
        beacon.setPinDelay(vaultA, 0, lower);
        (, uint256 at) = beacon.pendingPinDelayOf(vaultA);
        assertEq(at, block.timestamp + max, "the lowering waits the 30-day delay, not zero");
    }

    /// Switching protection off cancels a pin change waiting at the beacon,
    /// so switching it on again does not revive the old request.
    function test_switchingProtectionOffCancelsAPendingPin() public {
        _protectAlice();
        uint256 t0 = block.timestamp;
        LibTestProtection.requestDisable(address(diamond), alice, alice);
        vm.warp(t0 + 1 days);
        _pinAlice(3);
        (, uint256 pinAt) = beacon.pendingPinOf(vaultA);
        assertGt(pinAt, 0, "a pin change is pending");
        vm.warp(t0 + LibProtectedAccount.MIN_DELAY);
        LibTestProtection.finalizeSettings(address(diamond), alice);
        (, uint256 after_) = beacon.pendingPinOf(vaultA);
        assertEq(after_, 0, "the switch-off cancelled it at the beacon");

        _protectAlice();
        vm.warp(pinAt);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NoPinChange.selector, vaultA));
        beacon.executePin(vaultA);
        assertEq(beacon.pinnedVersion(vaultA), 0, "the old request never applied");
    }

    /// A pin-delay lowering requested while a switch-off waits is voided by
    /// the switch-off, so re-enabling protection cannot let it mature.
    function test_switchOffVoidsAPendingDelayLowering() public {
        _protectAlice();
        uint256 d = beacon.pinDelay(vaultA);
        uint256 t0 = block.timestamp;
        LibTestProtection.requestDisable(address(diamond), alice, alice);
        bytes memory lower = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, 0));
        beacon.setPinDelay(vaultA, 0, lower);
        (, uint256 lowerAt) = beacon.pendingPinDelayOf(vaultA);
        assertGt(lowerAt, 0, "a lowering is pending");

        vm.warp(t0 + LibProtectedAccount.MIN_DELAY);
        LibTestProtection.finalizeSettings(address(diamond), alice);
        (, uint256 after_) = beacon.pendingPinDelayOf(vaultA);
        assertEq(after_, 0, "the switch-off voided the lowering");

        _protectAlice();
        vm.warp(lowerAt);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NoDelayChange.selector, vaultA));
        beacon.executePinDelay(vaultA);
        assertEq(beacon.pinDelay(vaultA), d, "the delay stays where protection set it");
    }

    /// Switching protection on voids a pending lowering even when the delay
    /// already equals the protection delay, so no raise was needed.
    function test_equalDelayReEnableStillVoidsAPendingLowering() public {
        uint256 cap = beacon.MAX_DIAMOND_PIN_DELAY();
        bytes memory set = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, cap));
        beacon.setPinDelay(vaultA, cap, set);
        bytes memory lower = _sign(ALICE_KEY, beacon.pinDelayDigest(vaultA, 0));
        beacon.setPinDelay(vaultA, 0, lower);
        (, uint256 lowerAt) = beacon.pendingPinDelayOf(vaultA);
        assertGt(lowerAt, 0, "a lowering is pending");

        _protectAlice(); // MIN_DELAY == cap: no raise is needed
        assertEq(beacon.pinDelay(vaultA), cap, "no numerical raise happened");
        (, uint256 after_) = beacon.pendingPinDelayOf(vaultA);
        assertEq(after_, 0, "switching on voided the lowering anyway");
        vm.warp(lowerAt);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NoDelayChange.selector, vaultA));
        beacon.executePinDelay(vaultA);
    }

    /// Only the Diamond may void pending changes.
    function test_voidPendingIsDiamondOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VaultBeacon.NotDiamond.selector, stranger));
        beacon.voidPending(vaultA);
    }

    /// A pending pin to a version revoked meanwhile lapses instead of
    /// holding the vault's pin slot.
    function test_pendingPinToARevokedVersionLapses() public {
        _protectAlice();
        _pinAlice(3);
        beacon.proposeRevoke(3, 0);
        vm.warp(block.timestamp + beacon.MIN_CODE_DELAY());
        beacon.executeRevoke();
        beacon.executePin(vaultA);
        assertEq(beacon.pinnedVersion(vaultA), 0, "not pinned to revoked code");
        (, uint256 at) = beacon.pendingPinOf(vaultA);
        assertEq(at, 0, "the slot is free again");
    }

    // ─── The vault itself ────────────────────────────────────────────────

    /// Every vault still refuses a non-Diamond caller, on every version.
    function test_vaultRefusesNonDiamondOnEveryVersion() public {
        for (uint256 id = 1; id <= 3; ++id) {
            if (id != 1) _setCurrent(id);
            vm.prank(alice);
            vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
            VaipakamVaultImplementation(vaultA).closeListingEscrow(bytes32(uint256(1)), address(token), 0);
        }
        assertEq(VaipakamVaultImplementation(vaultA).vaultOwner(), alice);
    }

    /// Gas: the beacon lookup each vault call pays, reported for the PR.
    function test_gas_vaultCallThroughBeacon() public {
        vm.startPrank(address(diamond));
        uint256 g = gasleft();
        VaipakamVaultImplementation(vaultA).vaultOwner();
        uint256 viaBeacon = g - gasleft();
        vm.stopPrank();
        (address impl, ) = beacon.versionOf(1);
        g = gasleft();
        VaipakamVaultImplementation(impl).vaultOwner();
        uint256 direct = g - gasleft();
        console.log("vault view call through the beacon (gas):", viaBeacon);
        console.log("same call on the implementation directly (gas):", direct);
        console.log("beacon lookup overhead (gas):", viaBeacon - direct);
    }
}
