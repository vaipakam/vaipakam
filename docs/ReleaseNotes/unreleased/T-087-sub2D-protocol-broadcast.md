## Thread — T-087 Sub 2.D: protocol-funded mirror broadcast orchestrator (PR #<n>)

Fourth slice of Sub 2. Wires the auto-broadcast trigger that ties Sub 2.A (projection seam) + Sub 2.B (messenger outbound) + Sub 2.C (mirror inbound receiver) together. Every nonce-bumping rollup on Base now fans out a CCIP push to every configured mirror, charged against a dedicated protocol budget; insufficient budget fails CLOSED so operators can't ship downgrade-bearing mutations without honouring the cross-chain promise.

### New facet: `ProtocolBroadcastFacet`

Seven public selectors:

- `protocolBroadcastTierUpdate(user)` — `msg.sender == address(this)` gated. Called from the accumulator's rollup path via the diamond fallback. Resolves the user's current `effectiveTierAndBps` via the existing internal accumulator surface, bumps `s.userTierPushNonce[user]`, quotes the per-fan-out fee from the messenger, debits the budget (or reverts), and forwards a single `sendTierUpdate` call that fans to every configured destination atomically.
- `topUpBroadcastBudget()` payable — anyone can top up.
- `withdrawBudget(to, amount)` — ADMIN_ROLE gated; useful if the broadcast set shrinks and surplus accumulates.
- `setBroadcastDestinationCount(uint8)` — ADMIN_ROLE gated; the Diamond does NOT duplicate the messenger's destination list (the messenger is the source of truth), it only needs to know whether `> 0` so the rollup-time auto-broadcast SHOULD fire. Operators sync this number with the messenger's `broadcastDestinationChainIds.length`.
- `getProtocolBroadcastBudget()`, `getBroadcastDestinationCount()`, `getUserTierPushNonce(user)` — public reads.

### Gate matrix

The trigger has three skip conditions before it ever talks to the messenger:

1. `!isCanonicalVpfiChain` → silent skip (mirrors don't originate; they only consume).
2. `s.rewardMessenger == address(0)` → silent skip (CCIP wiring deferred, common in fresh deploys + every local fixture).
3. `s.broadcastDestinationCount == 0` → silent skip (no mirrors configured yet).

Only ONCE all three pass does the budget check fire — and there it FAILS CLOSED with `ProtocolBudgetExhausted(required, available)`. This matches the design's round-5 P1 #3 + round-6 P1 #2 ratification.

### Rollup hook

`VPFIDiscountAccumulatorFacet.rollupUserDiscount` gains a tail call to `protocolBroadcastTierUpdate(user)` via `address(this).call(...)`. Failure-mode discrimination is hand-rolled:

- If the broadcast facet is not cut (a minimal-fixture test diamond), the diamond returns `FunctionDoesNotExist()` and the rollup swallows it + continues — the same silent-fallback discipline Sub 1.B uses for the accumulator wrapper.
- ANY other revert (e.g., `ProtocolBudgetExhausted`) bubbles to the caller, so a budget exhaustion surfaces correctly at every settlement facet's entry point.

### Storage append

`LibVaipakam.Storage.broadcastDestinationCount` (uint8) appended at the end of the struct per the append-only discipline ([[project_platform_prelive]] notwithstanding — discipline is policy). The other six Sub 2.D slots (`protocolBroadcastBudget`, `userTierPushNonce`, `userTierLastPushedNonce`, `tierTableSweepDone`, `activeStakerRegistry`) were already in place from Sub 1's design landings.

### Producer artifacts

- Cuts array 48 → 49 (DeployDiamond), 49 → 50 (SetupTest).
- `DiamondFacetNames` 48 → 49; `_getProtocolBroadcastSelectors()` added + wired into `SelectorCoverageTest`; `FacetSizeLimitTest` + `DeployDiamondIntegrationTest` size bumped.
- Frontend ABI + barrel + `DIAMOND_ABI` spread.

### Test coverage

10 new tests in `ProtocolBroadcastFacetTest.t.sol`:

- Defaults for the read surface (zeros across the board).
- Budget top-up additive across multiple calls.
- Withdraw happy path + revert on over-withdraw + revert on non-admin.
- `setBroadcastDestinationCount` happy path + revert on zero + revert on non-admin.
- Internal-only gate: a direct external call reverts `OnlyInternal(caller)`.
- Canonical-flag default confirmation (SetupTest's `isCanonicalVpfiChain` is `false`, which is the implicit gate that lets every existing test stay green now that the rollup tail-calls the broadcast).

End-to-end CCIP fork tests (real messenger, mock router → mock-router-on-an-anvil) ship in Sub 2.E.

### Scope deferrals

The original Sub 2.D card included two additional surfaces; both deferred to a follow-up card so this slice stays small + reviewable:

- `forceResendTierUpdate(user, dests[])` — caller-funded recovery for missed pushes. The messenger's `sendTierUpdate` already exists; the follow-up just needs the admin-callable Diamond-side wrapper that bypasses budget + nonce bookkeeping.
- `sweepTierTableUpdate(startIdx, count)` — permissionless catchup walker over `s.activeStakerRegistry` with per-(user, version, dest) one-shot via `s.tierTableSweepDone`. Needs the active-staker registry's write hook to be wired first (also a follow-up).
- ConfigFacet eager VersionBumped broadcast on threshold / BPS change — small addition; deferred to keep the scope sharp.

These three are tracked on the umbrella; nothing in Sub 2.E depends on them being live first.
