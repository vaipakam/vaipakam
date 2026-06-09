## Thread — T-087 Sub 2.D: protocol-funded mirror broadcast orchestrator (PR #<n>)

Fourth slice of Sub 2. Wires the auto-broadcast trigger that ties Sub 2.A (projection seam) + Sub 2.B (messenger outbound) + Sub 2.C (mirror inbound receiver) together. Every nonce-bumping rollup on Base now fans out a CCIP push to every configured mirror, charged against a dedicated protocol budget; insufficient budget fails CLOSED so operators can't ship downgrade-bearing mutations without honouring the cross-chain promise.

### New facet: `ProtocolBroadcastFacet`

Five public selectors:

- `protocolBroadcastTierUpdate(user)` — `msg.sender == address(this)` gated. Called from the accumulator's rollup path via the diamond fallback. Resolves the user's current `effectiveTierAndBps` via the existing internal accumulator surface, bumps `s.userTierPushNonce[user]`, quotes the per-fan-out fee from the messenger, debits the budget (or reverts), and forwards a single `sendTierUpdate` call that fans to every configured destination atomically.
- `topUpBroadcastBudget()` payable — anyone can top up.
- `withdrawBudget(to, amount)` — ADMIN_ROLE gated; rejects zero recipient AND `address(this)` (the Diamond/proxy itself; would burn budget into un-budgeted balance).
- `getProtocolBroadcastBudget()`, `getUserTierPushNonce(user)` — public reads.

### Gate matrix (post-round-3 simplification)

The trigger has two skip conditions before it ever talks to the messenger:

1. `!isCanonicalVpfiChain` → silent skip (mirrors don't originate; they only consume).
2. `s.rewardMessenger == address(0)` → silent skip (CCIP wiring deferred, common in fresh deploys + every local fixture).

The earlier diamond-side `broadcastDestinationCount` skip was a duplicate of the messenger's destination set that could drift fail-OPEN (operator syncs the messenger's list but forgets the Diamond knob → every rollup silently returns). Dropped in round-3 P1 #2 — the messenger's own `NoBroadcastDestinations` revert now bubbles through the accumulator naturally failing CLOSED on half-finished configurations.

Once the two gates pass + the de-dup gate passes (see below), the budget check fires — and FAILS CLOSED with `ProtocolBudgetExhausted(required, available)`.

### De-dup gate (full-tuple)

The broadcast is skipped when the resolved push tuple `(effTier, effBps, expiry, version)` is identical to the last pushed for the user. Same-tier mutations that change projected expiry (e.g., partial withdrawal accelerates decay) OR change version (governance table bump) still propagate. A brand-new address whose rollup resolves to `(0, 0)` AND whose last-pushed pair is also `(0, 0)` silent-skips (round-2 P1 #3 dust-deposit drain vector).

### Rollup hook

`VPFIDiscountAccumulatorFacet.rollupUserDiscount` gains a tail call to `protocolBroadcastTierUpdate(user)` gated on `s.rewardMessenger != address(0)`. When the messenger is unwired (default deploy state, every minimal-fixture test), the broadcast call is skipped entirely; when wired, the call goes through and ANY revert (`ProtocolBudgetExhausted`, `NoBroadcastDestinations`, anything from inside the messenger) bubbles to the caller.

The outer `LibVPFIDiscount.rollupUserDiscount` wrapper uses a conditional silent-fallback: when `s.rewardMessenger == 0`, swallow `FunctionDoesNotExist()` (the only safe selector at the LibVPFIDiscount → accumulator boundary in an unwired state — keeps minimal-fixture tests green); when set, bubble everything (no downstream-aliasing risk allowed; production reverts MUST surface).

### Storage append

`LibVaipakam.Storage.__reservedSub2D1` (uint8, originally `broadcastDestinationCount`; round-3 P1 #2 dropped the field's role but the slot stays for layout stability) plus `lastTierExpirySec` + `lastTierTableVersion` (round-2 P1 #1 full-tuple de-dup). The earlier Sub 2.D slots (`protocolBroadcastBudget`, `userTierPushNonce`, `userTierLastPushedNonce`, `tierTableSweepDone`, `activeStakerRegistry`) were already in place from Sub 1's design landings.

### Producer artifacts

- Cuts array 48 → 49 (DeployDiamond), 49 → 50 (SetupTest).
- `DiamondFacetNames` 48 → 49; `_getProtocolBroadcastSelectors()` added + wired into `SelectorCoverageTest`; `FacetSizeLimitTest` + `DeployDiamondIntegrationTest` size bumped.
- Frontend ABI + barrel + `DIAMOND_ABI` spread.

### Test coverage

8 tests in `ProtocolBroadcastFacetTest.t.sol`:

- Defaults for the read surface.
- Budget top-up additive across multiple calls.
- Withdraw happy path + revert on over-withdraw + revert on non-admin + revert on zero recipient + revert on withdraw-to-self.
- Internal-only gate: a direct external call reverts `OnlyInternal(caller)`.
- Canonical-flag default confirmation (SetupTest's `isCanonicalVpfiChain` is `false`, the implicit gate that lets every existing test stay green now that the rollup tail-calls the broadcast).

End-to-end CCIP fork tests (real messenger, mock router → mock-router-on-an-anvil) ship in Sub 2.E.

### Scope deferrals

The original Sub 2.D card included three additional surfaces; all deferred to a follow-up card so this slice stays small + reviewable:

- `forceResendTierUpdate(user, dests[])` — caller-funded recovery for missed pushes. The messenger's `sendTierUpdate` already exists; the follow-up just needs the admin-callable Diamond-side wrapper that bypasses budget + nonce bookkeeping.
- `sweepTierTableUpdate(startIdx, count)` — permissionless catchup walker over `s.activeStakerRegistry` with per-(user, version, dest) one-shot via `s.tierTableSweepDone`. Needs the active-staker registry's write hook to be wired first (also a follow-up).
- ConfigFacet eager VersionBumped broadcast on threshold / BPS change — small addition; deferred to keep the scope sharp.

These three are tracked on the umbrella; nothing in Sub 2.E depends on them being live first.
