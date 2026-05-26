// test/LibERC721LockApprovalTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibERC721} from "../src/libraries/LibERC721.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";

/// @title LibERC721LockApprovalTest
/// @notice Focused unit test for the `setApprovalForAll` lock-aware gate
///         added to `LibERC721` (PR following the merged T-086 design
///         doc). Closes the pre-approved-operator bypass: before this
///         change, `_lock` revoked per-token approval but left operator
///         approvals untouched, so an attacker could call
///         `setApprovalForAll` BEFORE the lock and then `transferFrom`
///         on lock release — even though `transferFrom` itself was
///         `_requireNotLocked`-guarded.
///
/// @dev Exercises the new behavior via `TestMutatorFacet` helpers that
///      wrap `LibERC721._lock` / `_unlock` / `_mint` directly, so the
///      test doesn't have to stand up a full Preclose / EarlyWithdrawal
///      lifecycle for what is fundamentally a library-level gate.
contract LibERC721LockApprovalTest is SetupTest {
    address internal nftOwner;
    address internal stranger;
    address internal operator;

    uint256 internal constant TEST_TOKEN_A = 9_999_001;
    uint256 internal constant TEST_TOKEN_B = 9_999_002;

    function setUp() public override {
        super.setUp();
        nftOwner = makeAddr("nftOwner");
        stranger = makeAddr("stranger");
        operator = makeAddr("operator");

        // Mint two test tokens to nftOwner so we can exercise multi-token
        // counter math too (single-token locks, multi-token locks, partial
        // unlocks).
        TestMutatorFacet(address(diamond)).testMintNFT(nftOwner, TEST_TOKEN_A);
        TestMutatorFacet(address(diamond)).testMintNFT(nftOwner, TEST_TOKEN_B);
    }

    // ─── Counter math sanity ─────────────────────────────────────────────

    function test_lockedTokenCount_startsAtZero() public view {
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter should start at zero"
        );
    }

    function test_lockedTokenCount_incrementsOnLock() public {
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            1,
            "counter should be 1 after one lock"
        );
    }

    function test_lockedTokenCount_decrementsOnUnlock() public {
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        TestMutatorFacet(address(diamond)).testUnlockNFT(TEST_TOKEN_A);
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter should return to 0 after unlock"
        );
    }

    function test_lockedTokenCount_handlesMultipleTokens() public {
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_B, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            2,
            "counter should be 2 with two locked tokens"
        );

        // Unlock one — counter goes to 1.
        TestMutatorFacet(address(diamond)).testUnlockNFT(TEST_TOKEN_A);
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            1,
            "counter should be 1 after partial unlock"
        );

        // Unlock the other — back to 0.
        TestMutatorFacet(address(diamond)).testUnlockNFT(TEST_TOKEN_B);
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter should be 0 after full unlock"
        );
    }

    function test_lockedTokenCount_reLockSameTokenNoDoubleCount() public {
        // Lock with reason A.
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        // Re-lock with a different reason (defensive — today's facet
        // design doesn't trigger this, but the storage invariant must
        // hold). Counter must NOT double-count.
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            1,
            "counter must not double-count on re-lock"
        );
    }

    // ─── setApprovalForAll gating ────────────────────────────────────────

    function test_setApprovalForAll_blockedWhileOwnerHasLockedToken() public {
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );

        vm.prank(nftOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibERC721.ApprovalForbiddenWhileTokensLocked.selector,
                nftOwner,
                1 // lockedCount
            )
        );
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
    }

    function test_setApprovalForAll_revocationAllowedWhileLocked() public {
        // First grant an approval (unlocked) — sets up the state to revoke.
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        // Lock a token.
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );

        // Revocation MUST be allowed even while locked — a user must be
        // able to withdraw a prior approval at any time.
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, false);

        assertFalse(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "revocation should clear the approval"
        );
    }

    function test_setApprovalForAll_allowedAfterUnlock() public {
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );

        // Confirm it's blocked while locked.
        vm.prank(nftOwner);
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        // Unlock — approval should now succeed.
        TestMutatorFacet(address(diamond)).testUnlockNFT(TEST_TOKEN_A);

        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "approval should land after unlock"
        );
    }

    function test_setApprovalForAll_otherUsersUnaffected() public {
        // Lock nftOwner's token — counter[nftOwner] = 1, but counter[stranger] = 0.
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );

        // stranger never owned a locked token; their setApprovalForAll
        // must remain unrestricted.
        vm.prank(stranger);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(stranger, operator),
            "stranger should be unaffected by nftOwner's lock"
        );
    }

    function test_setApprovalForAll_partialUnlockKeepsBlock() public {
        // Lock two tokens.
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        TestMutatorFacet(address(diamond)).testLockNFT(
            TEST_TOKEN_B, LibERC721.LockReason.EarlyWithdrawalSale
        );

        // Unlock just one — counter goes from 2 to 1, but is still > 0,
        // so setApprovalForAll(approved=true) must STILL revert.
        TestMutatorFacet(address(diamond)).testUnlockNFT(TEST_TOKEN_A);

        vm.prank(nftOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibERC721.ApprovalForbiddenWhileTokensLocked.selector,
                nftOwner,
                1 // counter is 1 (TEST_TOKEN_B still locked)
            )
        );
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        // Unlock the other — now approval should work.
        TestMutatorFacet(address(diamond)).testUnlockNFT(TEST_TOKEN_B);

        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
    }
}
