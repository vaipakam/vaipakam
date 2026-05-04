// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";

/**
 * @title EscrowRecoveryTest
 * @notice Tests T-054 PR-3 — stuck-ERC20 recovery flow:
 *         {EscrowFactoryFacet.recoverStuckERC20} +
 *         {EscrowFactoryFacet.disown}.
 *
 *         Recovery cap = `max(0, balanceOf - protocolTrackedEscrowBalance)`.
 *         The arithmetic forbids draining beyond the truly-unsolicited
 *         delta — that's the load-bearing safety property of this
 *         flow. Other checks (EIP-712 sig, deadline, sanctions on
 *         declaredSource) reinforce but do NOT replace the cap.
 */
contract EscrowRecoveryTest is Test {
    VaipakamDiamond diamond;
    address owner;

    DiamondCutFacet cutFacet;
    EscrowFactoryFacet escrowFacet;
    AdminFacet adminFacet;
    ProfileFacet profileFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    address mockERC20;
    MockSanctionsList sanctionsList;

    // Test users — the EIP-712 signer needs a known private key.
    address user;
    uint256 userKey;
    address user2;

    // Address used in tests as a "declared source" for unsolicited
    // transfers. Either flagged as sanctioned via the mock or left
    // clean depending on the scenario.
    address declaredSource;

    function setUp() public {
        owner = address(this);

        // EIP-712 signer must have a known private key for `vm.sign`.
        userKey = 0xA11CE;
        user = vm.addr(userKey);
        user2 = makeAddr("user2");
        declaredSource = makeAddr("declaredSource");

        mockERC20 = address(new ERC20Mock("Token", "TKN", 18));
        ERC20Mock(mockERC20).mint(user, 100_000 ether);
        ERC20Mock(mockERC20).mint(user2, 100_000 ether);

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        escrowFacet = new EscrowFactoryFacet();
        adminFacet = new AdminFacet();
        profileFacet = new ProfileFacet();
        accessControlFacet = new AccessControlFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(escrowFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getEscrowFactoryFacetSelectorsExtended()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(profileFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getProfileFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();

        // Wire the sanctions oracle. Recovery requires a configured
        // oracle (fail-safe revert otherwise).
        sanctionsList = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(sanctionsList));

        // Approvals so user can deposit via the chokepoint.
        vm.prank(user);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Build the EIP-712 digest for a recovery acknowledgment.
    ///      Mirrors the on-chain `_recoveryDigest` exactly.
    function _digest(
        address u,
        address token,
        address source,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 ackTextHash = EscrowFactoryFacet(address(diamond)).recoveryAckTextHash();
        bytes32 typeHash = keccak256(
            "RecoveryAcknowledgment(address user,address token,address declaredSource,uint256 amount,uint256 nonce,uint256 deadline,bytes32 ackTextHash)"
        );
        bytes32 structHash = keccak256(
            abi.encode(typeHash, u, token, source, amount, nonce, deadline, ackTextHash)
        );
        bytes32 ds = EscrowFactoryFacet(address(diamond)).recoveryDomainSeparator();
        return keccak256(abi.encodePacked("\x19\x01", ds, structHash));
    }

    /// @dev Sign a recovery acknowledgment with `userKey`.
    function _sign(
        address token,
        address source,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 d = _digest(user, token, source, amount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, d);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Direct-send dust to a user's escrow without going through
    ///      the chokepoint. Simulates an unsolicited
    ///      `IERC20.transfer(escrow, …)` from a third party / the user
    ///      themselves bypassing the protocol.
    function _seedUnsolicited(address u, uint256 amount) internal {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(u);
        ERC20Mock(mockERC20).mint(escrow, amount);
    }

    // ─── Happy path ──────────────────────────────────────────────────────────

    function testRecoverHappyPathCleanSource() public {
        _seedUnsolicited(user, 50 ether);
        sanctionsList.setFlagged(declaredSource, false); // clean

        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 50 ether, nonce0, deadline);

        uint256 userBefore = ERC20(mockERC20).balanceOf(user);
        vm.prank(user);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 50 ether, deadline, sig
        );

        // Tokens moved to user's EOA.
        assertEq(
            ERC20(mockERC20).balanceOf(user) - userBefore,
            50 ether,
            "user EOA balance += amount"
        );

        // Escrow drained of unsolicited.
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user);
        assertEq(ERC20(mockERC20).balanceOf(escrow), 0);

        // Counter unchanged (recovery is for un-tracked balance).
        assertEq(
            EscrowFactoryFacet(address(diamond))
                .getProtocolTrackedEscrowBalance(user, mockERC20),
            0
        );

        // Nonce bumped.
        assertEq(
            EscrowFactoryFacet(address(diamond)).recoveryNonce(user),
            nonce0 + 1
        );

        // No ban recorded.
        assertEq(
            EscrowFactoryFacet(address(diamond)).escrowBannedSource(user),
            address(0)
        );
    }

    function testRecoverPartialAmount() public {
        _seedUnsolicited(user, 100 ether);
        sanctionsList.setFlagged(declaredSource, false);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 30 ether, nonce0, deadline);

        vm.prank(user);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 30 ether, deadline, sig
        );

        // Remaining 70 ether stays in escrow.
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user);
        assertEq(ERC20(mockERC20).balanceOf(escrow), 70 ether);
    }

    // ─── Cap math (load-bearing safety property) ─────────────────────────────

    function testRecoverRevertsWhenAmountExceedsUnsolicited() public {
        _seedUnsolicited(user, 50 ether);
        sanctionsList.setFlagged(declaredSource, false);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        // Try to recover MORE than the unsolicited delta.
        bytes memory sig = _sign(mockERC20, declaredSource, 51 ether, nonce0, deadline);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RecoveryAmountExceedsUnsolicited.selector);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 51 ether, deadline, sig
        );
    }

    /// @dev Counter is non-zero (legit deposit), but no extra dust.
    ///      `unsolicited = balanceOf - tracked = 0` → any recovery reverts.
    ///      Proves the cap excludes protocol-managed balance.
    function testRecoverCannotTouchProtocolTracked() public {
        // Seed counter so tracked > 0.
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC20(
            user,
            mockERC20,
            500 ether
        );
        // No unsolicited dust on top — `balanceOf == tracked == 500 ether`.
        sanctionsList.setFlagged(declaredSource, false);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 1 ether, nonce0, deadline);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RecoveryAmountExceedsUnsolicited.selector);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 1 ether, deadline, sig
        );
    }

    // ─── Sanctioned source → escrow ban ──────────────────────────────────────

    function testRecoverWithSanctionedSourceBansEscrow() public {
        _seedUnsolicited(user, 50 ether);
        // Snapshot the escrow address BEFORE the ban applies. The
        // post-ban `getOrCreateUserEscrow` is Tier-1 sanctions-gated
        // and would revert. `_seedUnsolicited` already created the
        // proxy.
        address escrow = EscrowFactoryFacet(address(diamond)).getUserEscrowAddress(user);
        sanctionsList.setFlagged(declaredSource, true); // FLAGGED

        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 50 ether, nonce0, deadline);

        // The transaction SUCCEEDS at the EVM level — but with the
        // ban-as-outcome rather than the recovery-as-outcome. A
        // revert would roll back the ban-state writes, defeating
        // the point. Frontend reads the event to surface "banned"
        // to the user.
        vm.expectEmit(true, true, true, true);
        emit EscrowFactoryFacet.EscrowBannedFromRecoveryAttempt(
            user,
            mockERC20,
            declaredSource,
            50 ether
        );
        vm.prank(user);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 50 ether, deadline, sig
        );

        // Tokens stayed in escrow (no movement).
        assertEq(ERC20(mockERC20).balanceOf(escrow), 50 ether);

        // Ban recorded with the source address.
        assertEq(
            EscrowFactoryFacet(address(diamond)).escrowBannedSource(user),
            declaredSource
        );

        // Nonce bumped so the same signature can't be replayed.
        assertEq(EscrowFactoryFacet(address(diamond)).recoveryNonce(user), nonce0 + 1);

        // User is now treated as sanctioned for Tier-1 entry points.
        assertTrue(ProfileFacet(address(diamond)).isSanctionedAddress(user));
    }

    function testBannedEscrowAutoUnlocksWhenSourceDelisted() public {
        _seedUnsolicited(user, 50 ether);

        // Step 1: declare a sanctioned source → ban applied (tx
        // succeeds with no revert).
        sanctionsList.setFlagged(declaredSource, true);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 50 ether, nonce0, deadline);
        vm.prank(user);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 50 ether, deadline, sig
        );
        assertTrue(ProfileFacet(address(diamond)).isSanctionedAddress(user), "banned post-recovery-attempt");

        // Step 2: oracle de-lists the source → user is auto-cleared.
        sanctionsList.setFlagged(declaredSource, false);
        assertFalse(ProfileFacet(address(diamond)).isSanctionedAddress(user), "auto-unlock on delisting");
    }

    function testRecoverRevertsWhenAlreadyBanned() public {
        // First: trigger ban via the no-revert ban-as-outcome path.
        _seedUnsolicited(user, 100 ether);
        sanctionsList.setFlagged(declaredSource, true);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory firstSig = _sign(
            mockERC20,
            declaredSource,
            10 ether,
            EscrowFactoryFacet(address(diamond)).recoveryNonce(user),
            deadline
        );
        vm.prank(user);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 10 ether, deadline, firstSig
        );

        // Second: with ban active, even a clean source declaration
        // reverts at the upfront sanctions check on msg.sender.
        address cleanSource = makeAddr("cleanSource");
        sanctionsList.setFlagged(cleanSource, false);
        bytes memory sig2 = _sign(
            mockERC20,
            cleanSource,
            10 ether,
            EscrowFactoryFacet(address(diamond)).recoveryNonce(user),
            deadline
        );
        vm.prank(user);
        // The exact revert is `SanctionedAddress(user)` from
        // `_assertNotSanctioned`. We just check it reverts.
        vm.expectRevert();
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, cleanSource, 10 ether, deadline, sig2
        );
    }

    // ─── Replay / signature gates ────────────────────────────────────────────

    function testRecoverRevertsOnReplay() public {
        _seedUnsolicited(user, 50 ether);
        sanctionsList.setFlagged(declaredSource, false);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 25 ether, nonce0, deadline);

        // First call succeeds.
        vm.prank(user);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 25 ether, deadline, sig
        );

        // Replay with the SAME signature (now stale nonce).
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RecoverySignatureInvalid.selector);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 25 ether, deadline, sig
        );
    }

    function testRecoverRevertsOnExpiredDeadline() public {
        _seedUnsolicited(user, 50 ether);
        sanctionsList.setFlagged(declaredSource, false);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 25 ether, nonce0, deadline);

        // Warp past deadline.
        vm.warp(deadline + 1);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RecoveryDeadlineExpired.selector);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 25 ether, deadline, sig
        );
    }

    function testRecoverRevertsOnBadSignature() public {
        _seedUnsolicited(user, 50 ether);
        sanctionsList.setFlagged(declaredSource, false);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);

        // Sign with the wrong key.
        bytes32 d = _digest(user, mockERC20, declaredSource, 25 ether, nonce0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBEEF), d);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RecoverySignatureInvalid.selector);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 25 ether, deadline, badSig
        );
    }

    function testRecoverRevertsOnZeroAmount() public {
        sanctionsList.setFlagged(declaredSource, false);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 0, nonce0, deadline);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RecoveryAmountZero.selector);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 0, deadline, sig
        );
    }

    function testRecoverRevertsWhenUserHasNoEscrow() public {
        // user2 never created an escrow, never deposited.
        sanctionsList.setFlagged(declaredSource, false);
        uint256 deadline = block.timestamp + 1 hours;
        // Sign with user's key — but call from user2 → signer mismatch.
        // We need to sign with user2's key; but user2 has no key in
        // this test. Use a fresh key + address to test the no-escrow
        // path.
        uint256 freshKey = uint256(0xCAFE);
        address fresh = vm.addr(freshKey);
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(fresh);
        bytes32 d = keccak256(
            abi.encodePacked(
                "\x19\x01",
                EscrowFactoryFacet(address(diamond)).recoveryDomainSeparator(),
                keccak256(
                    abi.encode(
                        keccak256(
                            "RecoveryAcknowledgment(address user,address token,address declaredSource,uint256 amount,uint256 nonce,uint256 deadline,bytes32 ackTextHash)"
                        ),
                        fresh,
                        mockERC20,
                        declaredSource,
                        uint256(1 ether),
                        nonce0,
                        deadline,
                        EscrowFactoryFacet(address(diamond)).recoveryAckTextHash()
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(freshKey, d);
        bytes memory sig = abi.encodePacked(r, ss, v);
        vm.prank(fresh);
        vm.expectRevert(IVaipakamErrors.RecoveryUserHasNoEscrow.selector);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 1 ether, deadline, sig
        );
    }

    function testRecoverRevertsWhenOracleUnset() public {
        _seedUnsolicited(user, 50 ether);
        // Clear the oracle.
        ProfileFacet(address(diamond)).setSanctionsOracle(address(0));

        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 25 ether, nonce0, deadline);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 25 ether, deadline, sig
        );
    }

    function testRecoverRevertsWhenOracleReverts() public {
        _seedUnsolicited(user, 50 ether);
        sanctionsList.setRevertOnRead(true); // simulate outage

        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce0 = EscrowFactoryFacet(address(diamond)).recoveryNonce(user);
        bytes memory sig = _sign(mockERC20, declaredSource, 25 ether, nonce0, deadline);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        EscrowFactoryFacet(address(diamond)).recoverStuckERC20(
            mockERC20, declaredSource, 25 ether, deadline, sig
        );
    }

    // ─── Disown ──────────────────────────────────────────────────────────────

    function testDisownEmitsEvent() public {
        _seedUnsolicited(user, 75 ether);

        vm.expectEmit(true, true, false, true);
        emit EscrowFactoryFacet.TokenDisowned(user, mockERC20, 75 ether, block.number);
        vm.prank(user);
        EscrowFactoryFacet(address(diamond)).disown(mockERC20);

        // No state change: tokens stay in escrow.
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user);
        assertEq(ERC20(mockERC20).balanceOf(escrow), 75 ether);

        // Counter untouched.
        assertEq(
            EscrowFactoryFacet(address(diamond))
                .getProtocolTrackedEscrowBalance(user, mockERC20),
            0
        );
    }

    function testDisownRevertsWhenNoEscrow() public {
        uint256 freshKey = uint256(0xDEAD);
        address fresh = vm.addr(freshKey);
        vm.prank(fresh);
        vm.expectRevert(IVaipakamErrors.RecoveryUserHasNoEscrow.selector);
        EscrowFactoryFacet(address(diamond)).disown(mockERC20);
    }

    function testDisownReportsZeroWhenNoUnsolicited() public {
        // User has tracked balance but no dust → observedAmount = 0.
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC20(
            user,
            mockERC20,
            10 ether
        );

        vm.expectEmit(true, true, false, true);
        emit EscrowFactoryFacet.TokenDisowned(user, mockERC20, 0, block.number);
        vm.prank(user);
        EscrowFactoryFacet(address(diamond)).disown(mockERC20);
    }
}
