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

    function setUp() public {
        setupHelper();
        nftOwner = makeAddr("nftOwner");
        stranger = makeAddr("stranger");
        operator = makeAddr("operator");

        // Mint two test tokens to nftOwner so we can exercise multi-token
        // counter math too (single-token locks, multi-token locks, partial
        // unlocks).
        TestMutatorFacet(address(diamond)).mintNFTRaw(nftOwner, TEST_TOKEN_A);
        TestMutatorFacet(address(diamond)).mintNFTRaw(nftOwner, TEST_TOKEN_B);
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
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            1,
            "counter should be 1 after one lock"
        );
    }

    function test_lockedTokenCount_decrementsOnUnlock() public {
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter should return to 0 after unlock"
        );
    }

    function test_lockedTokenCount_handlesMultipleTokens() public {
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_B, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            2,
            "counter should be 2 with two locked tokens"
        );

        // Unlock one — counter goes to 1.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            1,
            "counter should be 1 after partial unlock"
        );

        // Unlock the other — back to 0.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_B);
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter should be 0 after full unlock"
        );
    }

    function test_lockedTokenCount_reLockSameTokenNoDoubleCount() public {
        // Lock with reason A.
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        // Re-lock with a different reason (defensive — today's facet
        // design doesn't trigger this, but the storage invariant must
        // hold). Counter must NOT double-count.
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            1,
            "counter must not double-count on re-lock"
        );
    }

    // ─── T-086 step 2 — LockReason.PrepayCollateralListing smoke tests ───

    /// @notice Sanity: the storage value of `PrepayCollateralListing` is 3,
    ///         appended at the tail of the enum after `None` (0),
    ///         `PrecloseOffset` (1), and `EarlyWithdrawalSale` (2). Locks
    ///         in-flight from pre-T-086 storage MUST keep their semantic
    ///         meaning after this PR — the append-only rule on the enum
    ///         is load-bearing for diamond upgrades.
    function test_lockReasonEnum_prepayCollateralListingValueIs3() public pure {
        assertEq(uint8(LibERC721.LockReason.None), 0, "None == 0");
        assertEq(uint8(LibERC721.LockReason.PrecloseOffset), 1, "PrecloseOffset == 1");
        assertEq(uint8(LibERC721.LockReason.EarlyWithdrawalSale), 2, "EarlyWithdrawalSale == 2");
        assertEq(
            uint8(LibERC721.LockReason.PrepayCollateralListing),
            3,
            "PrepayCollateralListing must append as value 3 (storage append-only)"
        );
    }

    /// @notice Lock/unlock round-trip on the new reason: the counter math
    ///         (++ on `None → PrepayCollateralListing`, -- on
    ///         `PrepayCollateralListing → None`), the epoch bumps (on both
    ///         lock and unlock per the round-3 invariant), and the
    ///         `positionLock` view all behave identically to the existing
    ///         reasons. This is the smoke check that the new enum value is
    ///         a first-class citizen, not a special case.
    function test_lockReason_prepayCollateralListing_fullLifecycle() public {
        // Before lock: counter 0, epoch 0, position unlocked.
        assertEq(TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner), 0);
        assertEq(TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner), 0);
        assertEq(
            uint256(VaipakamNFTFacet(address(diamond)).positionLock(TEST_TOKEN_A)),
            uint256(LibERC721.LockReason.None)
        );

        // Lock with PrepayCollateralListing.
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrepayCollateralListing
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            1,
            "counter increments on PrepayCollateralListing lock"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            1,
            "epoch bumps on PrepayCollateralListing lock"
        );
        assertEq(
            uint256(VaipakamNFTFacet(address(diamond)).positionLock(TEST_TOKEN_A)),
            uint256(LibERC721.LockReason.PrepayCollateralListing),
            "positionLock view reports the new reason"
        );

        // Mid-lock: setApprovalForAll(.., true) is blocked because counter > 0.
        vm.prank(nftOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibERC721.ApprovalForbiddenWhileTokensLocked.selector, nftOwner, 1
            )
        );
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        // Unlock — counter back to 0, epoch bumps to 2 (round-3 invariant).
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);
        assertEq(TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner), 0);
        assertEq(TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner), 2);
        assertEq(
            uint256(VaipakamNFTFacet(address(diamond)).positionLock(TEST_TOKEN_A)),
            uint256(LibERC721.LockReason.None)
        );

        // Post-unlock: fresh setApprovalForAll(.., true) succeeds, stamped
        // at epoch=2.
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator)
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalGrantEpoch(nftOwner, operator),
            2
        );
    }

    /// @notice Mixing reasons: a PrecloseOffset lock on TOKEN_A and a
    ///         PrepayCollateralListing lock on TOKEN_B count toward the
    ///         same per-owner counter. Each lock independently bumps the
    ///         epoch (each `None → non-None` transition is a fresh bump).
    function test_lockReason_prepayMixesWithPrecloseInCounter() public {
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_B, LibERC721.LockReason.PrepayCollateralListing
        );

        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            2,
            "counter sums across reasons"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            2,
            "two distinct locks bump the epoch twice"
        );
        // Both locks self-identify correctly through the view.
        assertEq(
            uint256(VaipakamNFTFacet(address(diamond)).positionLock(TEST_TOKEN_A)),
            uint256(LibERC721.LockReason.PrecloseOffset)
        );
        assertEq(
            uint256(VaipakamNFTFacet(address(diamond)).positionLock(TEST_TOKEN_B)),
            uint256(LibERC721.LockReason.PrepayCollateralListing)
        );
    }

    // ─── setApprovalForAll gating ────────────────────────────────────────

    function test_setApprovalForAll_blockedWhileOwnerHasLockedToken() public {
        TestMutatorFacet(address(diamond)).lockNFTRaw(
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
        TestMutatorFacet(address(diamond)).lockNFTRaw(
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
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );

        // Confirm it's blocked while locked.
        vm.prank(nftOwner);
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        // Unlock — approval should now succeed.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);

        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "approval should land after unlock"
        );
    }

    function test_setApprovalForAll_otherUsersUnaffected() public {
        // Lock nftOwner's token — counter[nftOwner] = 1, but counter[stranger] = 0.
        TestMutatorFacet(address(diamond)).lockNFTRaw(
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
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_B, LibERC721.LockReason.EarlyWithdrawalSale
        );

        // Unlock just one — counter goes from 2 to 1, but is still > 0,
        // so setApprovalForAll(approved=true) must STILL revert.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);

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
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_B);

        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
    }

    // ─── L145 — burn-while-locked counter drift (Codex P1) ────────────────

    /// @notice Burning a token that is still locked at burn time must
    ///         decrement `lockedTokenCount` so the owner is not stranded
    ///         with a permanently positive counter. Reachable in
    ///         production via `EarlyWithdrawalFacet.completeLoanSale` →
    ///         `LibLoan.migrateLenderPosition`, which burns
    ///         `loan.lenderTokenId` without `_unlock`-ing it first.
    function test_burnWhileLocked_decrementsLockedTokenCount() public {
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            1,
            "counter is 1 after lock"
        );

        // Burn the still-locked token (mirrors LibLoan.migrateLenderPosition).
        TestMutatorFacet(address(diamond)).burnNFTRaw(TEST_TOKEN_A);

        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter must return to 0 after burn"
        );

        // And `setApprovalForAll(.., true)` must succeed — proves the
        // owner isn't permanently locked out of granting future approvals.
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "approval should land after burn-of-locked unwinds the counter"
        );
    }

    /// @notice Burning an UNlocked token must NOT underflow / touch the
    ///         counter. Default branch coverage for the L145 fix.
    function test_burnUnlocked_doesNotTouchCounter() public {
        // Pre-condition: counter is 0 (no locks).
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0
        );

        TestMutatorFacet(address(diamond)).burnNFTRaw(TEST_TOKEN_A);

        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter must stay 0 when burning an unlocked token"
        );
    }

    // ─── L151 — pre-lock operator approval survives the cycle (Codex P1) ──

    /// @notice Operator approvals granted BEFORE a lock must not survive
    ///         the lock/unlock cycle — otherwise the attacker bypass
    ///         described in the release note is still partially open.
    ///         The epoch bump in `_lock` plus the grant-epoch check in
    ///         `isApprovedForAll` close this path.
    function test_preLockOperatorApproval_invalidatedAfterUnlock() public {
        // T=0: grant operator approval (no locks yet).
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "approval valid before any lock"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            0,
            "epoch starts at 0"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalGrantEpoch(nftOwner, operator),
            0,
            "grant stamped at epoch 0"
        );

        // T=1: owner enters a lock (Preclose offset, EarlyWithdrawal,
        // or the future T-086 prepay path).
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            1,
            "epoch bumps on lock"
        );
        // The pre-existing operator approval is now stale.
        assertFalse(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "approval must be invalidated mid-lock"
        );

        // T=2: owner cancels / completes — token unlocked. The unlock
        // ALSO bumps the epoch (round-3 invariant: every transition
        // out of locked invalidates approvals, legacy or counted). So
        // by the end of step 2 epoch=2; the stale grant (stamped at
        // epoch=0) remains invalidated.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            2,
            "epoch bumps on unlock too (round-3 invariant)"
        );
        assertFalse(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "BYPASS CLOSED: pre-lock approval must NOT spring back to life on unlock"
        );

        // T=3: owner explicitly re-grants. Now approval works again,
        // stamped at the current (post-unlock) epoch — 2, because the
        // unlock bumped from 1 to 2.
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "fresh post-unlock grant works"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalGrantEpoch(nftOwner, operator),
            2,
            "re-grant stamped at current (post-unlock) epoch (2)"
        );
    }

    /// @notice Each fresh `_lock` (None→non-None) bumps the epoch.
    ///         Re-locking a token that is ALREADY locked (defensive — not
    ///         today's facet design but the storage invariant must hold)
    ///         must NOT bump again.
    function test_lockEpoch_doesNotBumpOnRelock() public {
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            1
        );

        // Re-lock same token with a different reason — must not double-bump.
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            1,
            "epoch must not double-bump on re-lock"
        );

        // A second DISTINCT token entering a lock DOES bump again — every
        // fresh lock event is a fresh signal to revoke prior approvals.
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_B, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            2,
            "epoch bumps on second distinct token's lock"
        );
    }

    // ─── L186 — pre-upgrade lock underflow guard (Codex P1 round 2) ───────

    /// @notice On a diamond upgrade where tokens were already locked
    ///         BEFORE this PR introduced `lockedTokenCount`, the owner's
    ///         counter is 0 even though `locks[tokenId] != None`. The
    ///         first post-upgrade `_unlock` on such a legacy lock must
    ///         NOT underflow — otherwise the cancel call from
    ///         `PrecloseFacet.cancelPreclose` /
    ///         `EarlyWithdrawalFacet.cancelLoanSale` would revert and
    ///         strand every in-flight position. Simulated by writing
    ///         `locks[tokenId]` directly via `forceSetLockWithoutCounter`
    ///         (which bypasses the counter increment that `_lock`
    ///         normally performs).
    function test_unlockLegacyLock_doesNotUnderflowCounter() public {
        // Simulate a pre-upgrade lock — `locks[tokenId]` set, counter is 0.
        TestMutatorFacet(address(diamond)).forceSetLockWithoutCounter(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "pre-condition: legacy-lock has counter at 0"
        );
        assertEq(
            uint256(VaipakamNFTFacet(address(diamond)).positionLock(TEST_TOKEN_A)),
            uint256(LibERC721.LockReason.PrecloseOffset),
            "pre-condition: token is legacy-locked"
        );

        // First post-upgrade `_unlock` must NOT revert on underflow.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);

        assertEq(
            uint256(VaipakamNFTFacet(address(diamond)).positionLock(TEST_TOKEN_A)),
            uint256(LibERC721.LockReason.None),
            "legacy lock should clear cleanly"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter must stay at 0; guard absorbs the no-op decrement"
        );
    }

    /// @notice Symmetric guard for `_burn` — burning a legacy-locked
    ///         (pre-upgrade) token must NOT underflow.
    function test_burnLegacyLock_doesNotUnderflowCounter() public {
        TestMutatorFacet(address(diamond)).forceSetLockWithoutCounter(
            TEST_TOKEN_A, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "pre-condition: legacy-lock has counter at 0"
        );

        // First post-upgrade `_burn` on the legacy-locked token must
        // not revert (mirrors EarlyWithdrawalFacet.completeLoanSale →
        // LibLoan.migrateLenderPosition burning the locked
        // `lenderTokenId`).
        TestMutatorFacet(address(diamond)).burnNFTRaw(TEST_TOKEN_A);

        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter must stay at 0; guard absorbs the no-op decrement"
        );
    }

    // ─── Codex round-3 P1s — legacy-lock security invariants ─────────────
    //
    // These tests prove that the security property survives mixed
    // legacy/counted lock state. The counter can drift below truth in
    // mixed state (because legacy locks don't decrement to a negative
    // number — they're absorbed by the `count > 0` guard), but the
    // epoch bump on every `_unlock` / `_burn` invalidates operator
    // approvals regardless, so post-unlock transfers always require a
    // fresh re-grant.

    /// @notice Pre-existing operator approval (granted long before any
    ///         lock) must be invalidated when a LEGACY lock unwinds —
    ///         even though `_lock` never ran for the legacy token. The
    ///         epoch bump on `_unlock` is the chokepoint.
    function test_preExistingApproval_invalidatedAfterLegacyUnlock() public {
        // T=0: grant operator approval (no locks, counter=0, epoch=0).
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "pre-grant valid"
        );

        // Simulate a pre-upgrade lock (no epoch bump from `_lock`).
        TestMutatorFacet(address(diamond)).forceSetLockWithoutCounter(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        // Mid-legacy-lock, `_lock` was never called so the epoch is
        // still 0. The approval IS still technically valid by epoch
        // check at this point — but transferFrom is blocked by the
        // lock itself. The security property activates on `_unlock`.

        // Unlock — epoch bumps even for the legacy lock.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);

        assertFalse(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "BYPASS CLOSED: pre-existing approval invalidated after legacy unlock"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            1,
            "epoch bumped on legacy unlock"
        );
    }

    /// @notice An approval GRANTED during a legacy lock (the gate sees
    ///         the counter as 0 and allows it) must still be
    ///         invalidated when the legacy lock unwinds — the L293
    ///         attack window Codex flagged.
    function test_approvalGrantedDuringLegacyLock_invalidatedAtUnlock() public {
        // Legacy lock — counter stays at 0 (the gate is a no-op).
        TestMutatorFacet(address(diamond)).forceSetLockWithoutCounter(
            TEST_TOKEN_A, LibERC721.LockReason.EarlyWithdrawalSale
        );

        // Owner grants operator approval — gate passes because counter
        // is 0 (legacy lock didn't increment). grant_epoch stamped at
        // current epoch (still 0).
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "grant during legacy lock initially valid (transfer still blocked by lock)"
        );

        // Unlock — epoch bumps. The mid-lock grant is now stale.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);

        assertFalse(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "BYPASS CLOSED: grant-during-legacy-lock approval invalidated at unlock"
        );
    }

    /// @notice Mixed legacy + counted locks — even though the counter
    ///         drifts (legacy-unlock decrements toward 0 while a
    ///         counted lock is still active), the epoch chain keeps
    ///         operator-approval invalidation correct. The drift is
    ///         cosmetic; the security property holds.
    function test_mixedLegacyAndCountedLocks_securityHoldsDespiteCounterDrift() public {
        // Legacy lock on TOKEN_A (counter stays 0).
        TestMutatorFacet(address(diamond)).forceSetLockWithoutCounter(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );
        // Counted lock on TOKEN_B (counter goes to 1, epoch to 1).
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_B, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner), 1);
        assertEq(TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner), 1);

        // setApprovalForAll(.., true) blocked because counter > 0.
        vm.prank(nftOwner);
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        // Unlock the LEGACY token. Counter drifts from 1 to 0
        // (incorrect — TOKEN_B is still locked) but the epoch bumps
        // to 2, which is what matters.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            0,
            "counter drifts (cosmetic)"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            2,
            "epoch is the real source of truth - bumped on every unlock"
        );

        // Owner can now grant a fresh approval (counter says 0).
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator));

        // Eventually TOKEN_B unlocks — epoch bumps to 3, fresh grant
        // (stamped at epoch=2) becomes stale.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_B);
        assertFalse(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "BYPASS CLOSED: every unlock invalidates approvals - counter drift doesn't open a window"
        );
    }

    /// @notice Symmetric — `_burn` on a legacy-locked token must also
    ///         bump the epoch (matching `_unlock`). Without this, the
    ///         migrateLenderPosition path on a legacy lock would
    ///         re-open the bypass.
    function test_burnLegacyLock_bumpsEpoch() public {
        // Pre-grant.
        vm.prank(nftOwner);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator)
        );

        // Legacy lock + burn.
        TestMutatorFacet(address(diamond)).forceSetLockWithoutCounter(
            TEST_TOKEN_A, LibERC721.LockReason.EarlyWithdrawalSale
        );
        TestMutatorFacet(address(diamond)).burnNFTRaw(TEST_TOKEN_A);

        assertEq(
            TestMutatorFacet(address(diamond)).getOperatorApprovalEpoch(nftOwner),
            1,
            "epoch bumps on legacy-locked burn"
        );
        assertFalse(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(nftOwner, operator),
            "BYPASS CLOSED: pre-grant invalidated by legacy-lock burn"
        );
    }

    /// @notice Mixed legacy + new lock state must still self-balance
    ///         once the legacy lock has flowed through `_unlock`. A
    ///         later fresh `_lock` (post-upgrade) increments cleanly to 1.
    function test_legacyAndNewLocks_counterEventuallyConsistent() public {
        // Legacy lock — counter stays at 0.
        TestMutatorFacet(address(diamond)).forceSetLockWithoutCounter(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );

        // Cancel the legacy flow — `_unlock` is the guarded no-op.
        TestMutatorFacet(address(diamond)).unlockNFTRaw(TEST_TOKEN_A);
        assertEq(TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner), 0);

        // Fresh post-upgrade `_lock` on a different token — counter
        // increments cleanly to 1 (no legacy state poisoning).
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_B, LibERC721.LockReason.EarlyWithdrawalSale
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLockedTokenCount(nftOwner),
            1,
            "fresh post-upgrade lock increments from a clean 0 -> 1"
        );
    }

    /// @notice Another owner's lock cycle must not invalidate the
    ///         current user's pre-existing operator approval —
    ///         epochs are per-owner.
    function test_otherOwnerLock_doesNotInvalidateMyApproval() public {
        // stranger grants an approval; nftOwner has a separate lock cycle.
        vm.prank(stranger);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);

        TestMutatorFacet(address(diamond)).lockNFTRaw(
            TEST_TOKEN_A, LibERC721.LockReason.PrecloseOffset
        );

        // stranger's approval is unaffected by nftOwner's epoch bump.
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isApprovedForAll(stranger, operator),
            "epochs are per-owner; stranger's approval must survive nftOwner's lock"
        );
    }
}
