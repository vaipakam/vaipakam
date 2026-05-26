## LibERC721 hardening — block `setApprovalForAll` while owner holds a locked token

Today's `LibERC721._lock` revokes per-token approval (`tokenApprovals[tokenId]`) but does NOT clear operator-wide approvals (`operatorApprovals[owner][operator]`), and `setApprovalForAll` itself has no lock check. That creates a bypass:

1. Attacker calls `setApprovalForAll(attacker, true)` while the position-NFT holder owns no locked tokens (or grants this approval as a malicious operator pre-arrangement);
2. The owner enters a flow that calls `_lock` on their position NFT (Preclose offset or EarlyWithdrawal sale today; the upcoming T-086 prepay-listing flow tomorrow);
3. `transferFrom` on the locked token is correctly blocked by `_requireNotLocked`;
4. The owner cancels the flow → `_unlock` releases the lock;
5. **Attacker immediately calls `transferFrom` and walks the position NFT** — the operator approval from step 1 is still valid.

The window between unlock and the next state-changing call from the rightful owner is the attacker's window.

### The fix

Five small changes in `contracts/src/libraries/LibERC721.sol`:

1. **New per-owner counter:** `mapping(address => uint256) lockedTokenCount` added to the `ERC721Storage` struct (append-only field, end of struct).
2. **`_lock` / `_unlock` / `_burn` maintain the counter** — `++` on the `None → non-None` transition; `--` on the `non-None → None` transition; `--` when a still-locked token is burned. Re-locking a token with a different reason does not double-count. Burning the locked lender-side position NFT during `EarlyWithdrawalFacet.completeLoanSale` (which goes through `LibLoan.migrateLenderPosition` without an `_unlock` first) used to strand the counter permanently positive — now it cleanly decrements.
3. **`setApprovalForAll` gates new approvals on the counter:**
   - If `approved == true` AND `lockedTokenCount[msg.sender] > 0`, revert `ApprovalForbiddenWhileTokensLocked(owner, lockedCount)`.
   - If `approved == false` (revocation), always allowed — a user must be able to withdraw a prior approval at any time.
4. **Per-owner operator-approval epoch closes the pre-lock-grant path.** The counter gate alone only blocks NEW approvals while locked — operator approvals granted BEFORE the owner's first lock would survive the lock/unlock cycle and let an attacker `transferFrom` immediately on release. To close that, `_lock` now bumps a per-owner `operatorApprovalEpoch` on every fresh `None → non-None` transition, `setApprovalForAll` stamps each new grant with the then-current epoch in `operatorApprovalGrantEpoch`, and `isApprovedForAll(owner, operator)` returns `true` only when the stamped grant epoch matches the owner's current epoch. Any approval granted before the most recent lock is silently treated as stale — the user must explicitly re-grant after the lock cycle ends.
5. **Storage layout is append-only.** Three new fields go at the end of the `ERC721Storage` struct: `lockedTokenCount`, `operatorApprovalEpoch`, `operatorApprovalGrantEpoch`. No existing field is reordered, renamed, or retyped.
6. **Upgrade-safety belt on `_unlock` and `_burn`.** Both call sites guard the decrement on `lockedTokenCount[owner] > 0`. The counter is brand new — on a live diamond upgrade where Preclose or EarlyWithdrawal positions are mid-flight at the moment of the upgrade, the legacy `_lock` call that started those flows never incremented the counter (it didn't exist yet), so the owner's counter is 0 even though `locks[tokenId] != None`. Without this guard the first post-upgrade `cancelPreclose` / `cancelLoanSale` / `completeLoanSale` would underflow and revert, stranding every legacy in-flight position. With the guard, legacy locks unwind as no-ops on the counter; new locks self-balance normally.
7. **The epoch chain — not the counter — is the security source of truth.** The locked-count guard prevents reverts but the counter can DRIFT below the true number of locked tokens when legacy and counted locks coexist (e.g., unlock a legacy token while a counted token is still locked — the counter decrements past truth). To keep the security property intact regardless of drift, `_unlock` and `_burn` also bump `operatorApprovalEpoch[owner]` on every transition out of locked state (legacy or counted). Combined with the `_lock`-side bump, every transition INTO or OUT OF locked state invalidates every existing operator approval — so even an attacker who managed to grant an approval during a legacy lock (when the counter-gate read 0 and let it through) cannot transfer post-unlock, because the unlock bumps the epoch and stales the grant. Counter accuracy is best-effort cosmetics; the epoch chain is the load-bearing primitive.

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
- **Burn-while-locked path (L145):** burning a still-locked token decrements the counter so the owner is not stranded with a permanently positive `lockedTokenCount`; the owner can subsequently grant a fresh approval. Burning an unlocked token does not touch the counter.
- **Pre-lock operator approval path (L151):** an approval granted before the owner's first lock is invalidated mid-lock AND stays invalidated after `_unlock` — the user must explicitly re-grant. Epoch bumps only on the `None → non-None` transition (re-locking with a different reason doesn't double-bump). Epochs are per-owner, so a stranger's separate lock cycle doesn't invalidate the test owner's approval.
- **Upgrade-safety underflow guard (L186):** a legacy-locked token (simulated via a test-only `forceSetLockWithoutCounter` helper that writes `locks[tokenId]` directly without touching the counter) unwinds cleanly through both `_unlock` and `_burn` — the counter stays at 0 and no transaction reverts. A subsequent fresh `_lock` increments from a clean 0 → 1, demonstrating eventual consistency once legacy state has drained.

The test uses six new test-only helpers on `TestMutatorFacet` (`testMintNFT`, `testLockNFT`, `testUnlockNFT`, `testBurnNFT`, `forceSetLockWithoutCounter`, plus the `getLockedTokenCount` / `getOperatorApprovalEpoch` / `getOperatorApprovalGrantEpoch` readers) so the focused unit test doesn't have to stand up a full offer-accept + Preclose lifecycle for what is fundamentally a library-level gate. The production-side flows (PrecloseFacet, EarlyWithdrawalFacet) still go through their facets exclusively; these helpers are NOT cut into production deployments.
