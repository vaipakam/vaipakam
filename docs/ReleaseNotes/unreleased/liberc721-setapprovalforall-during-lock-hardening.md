## LibERC721 hardening — block `setApprovalForAll` while owner holds a locked token

Today's `LibERC721._lock` revokes per-token approval (`tokenApprovals[tokenId]`) but does NOT clear operator-wide approvals (`operatorApprovals[owner][operator]`), and `setApprovalForAll` itself has no lock check. That creates a bypass:

1. Attacker calls `setApprovalForAll(attacker, true)` while the position-NFT holder owns no locked tokens (or grants this approval as a malicious operator pre-arrangement);
2. The owner enters a flow that calls `_lock` on their position NFT (Preclose offset or EarlyWithdrawal sale today; the upcoming T-086 prepay-listing flow tomorrow);
3. `transferFrom` on the locked token is correctly blocked by `_requireNotLocked`;
4. The owner cancels the flow → `_unlock` releases the lock;
5. **Attacker immediately calls `transferFrom` and walks the position NFT** — the operator approval from step 1 is still valid.

The window between unlock and the next state-changing call from the rightful owner is the attacker's window.

### The fix

Three small changes in `contracts/src/libraries/LibERC721.sol`:

1. **New per-owner counter:** `mapping(address => uint256) lockedTokenCount` added to the `ERC721Storage` struct (append-only field, end of struct).
2. **`_lock` / `_unlock` maintain the counter** — `++` on the `None → non-None` transition; `--` on the `non-None → None` transition. Re-locking a token with a different reason does not double-count.
3. **`setApprovalForAll` gates new approvals on the counter:**
   - If `approved == true` AND `lockedTokenCount[msg.sender] > 0`, revert `ApprovalForbiddenWhileTokensLocked(owner, lockedCount)`.
   - If `approved == false` (revocation), always allowed — a user must be able to withdraw a prior approval at any time.

### Why this PR is small + ships now, not bundled with T-086

The reviewer's recommendation on the T-086 ratified design doc was to unbundle this hardening: it's a low-risk, immediately-valuable improvement to the existing **`PrecloseFacet`** (offset path) and **`EarlyWithdrawalFacet`** (sale path) flows. Both currently use `_lock`/`_unlock` and both inherit the bypass closed by this PR. Bundling it with T-086 step 2 would have inflated that PR and delayed the security benefit to the existing flows.

After this PR lands, T-086 step 2 (`LockReason.PrepayCollateralListing` enum extension) is purely additive — the counter + `setApprovalForAll` gating already exist.

### Test coverage

New `LibERC721LockApprovalTest.t.sol` exercises:
- Counter math: starts at 0; increments on `_lock`; decrements on `_unlock`; multiple tokens; partial unlocks; re-lock with different reason does not double-count.
- `setApprovalForAll(operator, true)` reverts with `ApprovalForbiddenWhileTokensLocked` while the caller owns any locked token.
- `setApprovalForAll(operator, false)` (revocation) succeeds regardless of lock state.
- Approval succeeds after unlock.
- Other users' approvals are unaffected by a lock on the test owner's token.

The test uses three new test-only helpers on `TestMutatorFacet` (`testMintNFT`, `testLockNFT`, `testUnlockNFT`, plus the `getLockedTokenCount` reader) so the focused unit test doesn't have to stand up a full offer-accept + Preclose lifecycle for what is fundamentally a library-level gate. The production-side flows (PrecloseFacet, EarlyWithdrawalFacet) still go through their facets exclusively; these helpers are NOT cut into production deployments.
