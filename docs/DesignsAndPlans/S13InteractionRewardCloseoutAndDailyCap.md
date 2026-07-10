# S13 — Interaction-reward daily cap (#1008) + terminal-path close-out precision (#1067)

**Umbrella:** #998 · **Spec-review tranche:** S13 · **Owner decision (2026-07-05):** FIX CODE (#1008)
**Design-doc-first** per the deferred-#998 workflow (scout → design → ≥2 Codex rounds → implement).

Two related interaction-reward correctness items, designed together because they
touch the same subsystem (`LibInteractionRewards` + `InteractionRewardsFacet`) and
share the same close/forfeit primitives:

- **#1008** (bug, S13) — the §4 per-user reward cap is a **daily** property, but the
  entry-path claim applies it once over the whole entry window. Fix: cap per day.
- **#1067** (enhancement) — ~6 terminal transitions don't yet notify the reward
  system, so their entries pay via the status-derived fallback instead of an
  explicit, durable close. Wire them with correct forfeit / window-shrink /
  holder-re-anchor semantics.

Neither changes any external signature that already-shipped consumers depend on for
correctness (see Blast radius per part). The platform is pre-live — no reward state
to migrate.

---

## Part 1 — #1008: per-day cap in the entry claim path

### Finding (spec-anchored)

`docs/FunctionalSpecs/TokenomicsTechSpec.md:197`:

> on each reward side, each user's **daily** interaction reward is capped at
> `0.5 VPFI` for every `0.001 ETH` equivalent of eligible interest

and the test-oracle line `:321`:

> test that a user's reward is capped at `0.5 VPFI` per `0.001 ETH` equivalent of
> eligible interest even when the proportional formula would otherwise pay more

The cap is a **per-day** ceiling on each `(user, side)` branch.

### Current behavior (anchored)

`LibInteractionRewards._processEntry` (`src/libraries/LibInteractionRewards.sol:993-1007`)
and its view twin `_previewEntryReward` (`:1046-1058`) compute the whole-window reward
with the telescoping cumulative-RPN trick, then apply the cap **once** to the window
total:

```solidity
uint256 reward = (e.perDayNumeraire18 * (cumEnd - cumStart)) / 1e18;   // Σ_d raw_d
...
uint256 daysInWindow = e.endDay - e.startDay;
uint256 perDayCap    = _capVpfiForInterestUsd(e.perDayNumeraire18, ethPriceRaw, ethPriceDec, capRatio);
if (perDayCap != type(uint256).max) {
    uint256 windowCap = perDayCap * daysInWindow;      // Σ_d perDayCap
    if (reward > windowCap) reward = windowCap;
}
```

Let `raw_d = e.perDayNumeraire18 · dailyRpn18[d] / 1e18` be the uncapped reward on day
`d`, where `dailyRpn18[d] = cumRpn18[d] − cumRpn18[d−1]`. The code yields

```
min( Σ_d raw_d , Σ_d perDayCap )
```

but §4 requires

```
Σ_d min( raw_d , perDayCap )
```

Since `Σ min(raw_d, cap) ≤ min(Σ raw_d, Σ cap)`, the current code is a strictly looser
(never tighter) upper bound: a day whose `raw_d` exceeds the cap can be netted against
under-cap days. That is exactly the anti-wash-farming leak the cap exists to close
(cf. the cap fail-open finding #919). **Divergence confirmed.**

### Why the telescoping trick can't be salvaged

`perDayCap` is constant across an entry's window (it depends only on
`e.perDayNumeraire18`, the ETH spot, and `capRatio` — all fixed per entry). The cap
bites on day `d` iff `dailyRpn18[d] > T` where the per-entry RPN threshold is
`T = perDayCap · 1e18 / e.perDayNumeraire18`. So the correct value is

```
e.perDayNumeraire18 / 1e18 · Σ_d min( dailyRpn18[d] , T )
```

`dailyRpn18[d] = (halfPoolForDay(d) · 1e18) / knownGlobalInterestNumeraire18[d]`
(`advanceCumLenderThrough`, `:571-584`). `halfPoolForDay` is piecewise-constant across
the 8 bands, but `knownGlobal…[d]` — the protocol-wide interest that day — varies
**arbitrarily day-to-day** with activity. So `dailyRpn18[d]` is not piecewise-constant,
and there is no per-band shortcut. A single global "capped-cumulative" array can't work
either, because `T` is per-entry. **A per-day walk over `[startDay, endDay)` is the only
correct implementation.** (This is already the shape of the sibling `advanceCum*` loops
and the legacy `claimForUserWindow` loop, which caps per-day correctly — `:788`, `:800`.)

### Design — per-day min in `_processEntry` / `_previewEntryReward`

Replace the `reward = telescoped; window-cap` block in **both** functions with a
per-day loop that carries the running cumulative to avoid a second SLOAD per day:

```solidity
// Per-day §4 cap: Σ_d min(raw_d, perDayCap). Telescoping can't apply the
// cap per day, so walk the window. cumRpn18[startDay-1..endDay-1] are all
// finalized (the cursor>=endDay-1 gate above guarantees it).
uint256 perDayCap = _capVpfiForInterestUsd(
    e.perDayNumeraire18, ethPriceRaw, ethPriceDec, capRatio
);
uint256 reward;
uint256 prev = e.startDay == 0 ? 0 : cumArr[e.startDay - 1];
for (uint256 d = e.startDay; d < e.endDay; ) {
    uint256 cur = cumArr[d];
    uint256 rawD = (e.perDayNumeraire18 * (cur - prev)) / 1e18;
    reward += (perDayCap != type(uint256).max && rawD > perDayCap) ? perDayCap : rawD;
    prev = cur;
    unchecked { ++d; }
}
```

where `cumArr` is `s.cumLenderRpn18` or `s.cumBorrowerRpn18` chosen by `e.side` (the
same array the telescoped read already selected). **Keep both existing fast-path
guards** ahead of the loop: `startDay >= endDay` and `cumEnd <= cumStart` (compute
`cumEnd`/`cumStart` as today, return 0 / mark `processed` when the whole window has no
RPN growth) — so the O(window) loop only runs when there is a non-zero reward to
apportion. The `if (mutate) e.processed = true;` and the forfeit-routing tail
(`_processEntry:1009-1018`) are unchanged; only the middle `reward = telescoped;
window-cap` block is replaced.

**Decisions baked in (surface these for Codex):**

1. **Per-day flooring.** The telescoped form floored once (`… / 1e18` over the window
   sum); the per-day form floors each day, losing ≤1 wei/day of a `1e18`-scaled VPFI
   amount. This is a conservative, protocol-favoring rounding change, negligible in
   magnitude, and only reached when the cap is *disabled* (`type(uint256).max`) would
   otherwise be identical. Acceptable — but stated explicitly so it isn't mistaken for
   a bug in review.
2. **Gas: O(window) SLOADs.** The telescoped read was O(1) (2 SLOADs); the per-day walk
   is O(`endDay − startDay`) SLOADs of `cumRpn18[d]`. Bounded by the loan term and by
   the fact the whole window must already be finalized (`cursor ≥ endDay−1`) before the
   loop runs. This matches the existing per-day cost of `advanceCum*ThroughEntries` and
   `claimForUserWindow`; claims are user-initiated and per-entry. No new unbounded loop
   is introduced. (If a future very-long-term product makes this a concern, a windowed
   claim already exists as the legacy path — out of scope here.)
3. **Cap-disabled fast path unchanged.** When `perDayCap == type(uint256).max` the loop
   sums `rawD` verbatim, reproducing the uncapped telescoped total exactly (modulo the
   per-day floor in (1)). We keep the branch inside the loop rather than duplicating the
   loop; the compare is cheap next to the SLOAD.
4. **`_processEntry` and `_previewEntryReward` must stay identical** (preview parity is a
   standing invariant of this lib — a preview that over-reports vs the claim is itself a
   bug). Both get the same loop.

### Blast radius / ABI — Part 1

Internal-library-only change. No struct/selector/event change → **no ABI re-export, no
diamond cut, no consumer typecheck.** The legacy window path (`claimForUserWindow`,
already per-day-correct) is untouched. Read sites of `previewInteractionRewards` /
`claimInteractionRewards` see a value that is **≤** the pre-fix value (the cap only ever
tightens), so no downstream over-payment risk.

### Test plan — Part 1 (`InteractionRewardsFacet` reward-cap suite)

1. **Netting is closed** — an entry with one over-cap day and several under-cap days
   pays `Σ min(raw_d, cap)`, strictly less than the old `min(Σ raw, Σ cap)`. Construct
   via seeded per-day globals so `dailyRpn18` varies (high-share quiet day + normal
   days). Assert the exact per-day-capped total and that it is `<` the window-cap total.
2. **All days under cap** — result equals the uncapped telescoped total (per-day floor
   tolerance ≤ window length wei).
3. **All days over cap** — result equals `perDayCap · daysInWindow` (the loop saturates
   every day; matches the old window cap in this degenerate case).
4. **Cap disabled** (`ethPriceRaw == 0` or `capRatio == max`) — result equals the
   uncapped telescoped total.
5. **Preview == claim** — `previewInteractionRewards` equals the amount a subsequent
   `claimInteractionRewards` routes, for cases 1–4.
6. **Single-day window** — `endDay − startDay == 1` reduces to `min(raw_0, cap)`.

---

## Part 2 — #1067: explicit terminal close-out for the remaining paths

> *(completed after the terminal-path call-site map — the reward-close primitives are
> all present; this part is call-site wiring + best-effort hook variants.)*

### Primitives already in place (anchored)

- `LibInteractionRewards.closeLoan(loanId, borrowerClean, lenderForfeit)`
  (`:317-351`) — **the window-shrink + forfeit-flag primitive.** Shrinks both sides to
  `min(originalEnd, today+1)` via `_closeEntry` and stamps `forfeited` durably
  (`lenderForfeit` on the lender entry; `!borrowerClean` on the borrower entry). Setting
  `closed = true` is the S4 claim gate and — critically for #1067 item 1 — makes the
  forfeit **durable** rather than status-derived (`_entryTerminalForfeit` only fires for
  an *unclosed* entry, `:929`).
- `LibInteractionRewards.repointRewardEntry(loanId, newUser, isLenderSide)`
  (`:433-453`) — **the reward-only holder re-anchor** (#1067 item 3). Moves `e.user`
  intact, keeps the per-loan pointer and day-window; no collateral movement (this is the
  correct primitive that #1061 reverted `eagerConsolidateBothSides` in favor of).
- `LibInteractionRewards.transferLenderEntry(loanId, newLender)` (`:363-410`) — lender
  *sale* path (forfeit old + reopen for buyer); referenced for contrast, not reused here.

### Best-effort hook mechanism (anchored)

Tight facets don't inline the reward call-graph; they cross-call thin **self-only**
hooks on `InteractionRewardsFacet` (which has headroom) through a **swallowing**
wrapper. The proven pattern (`PrecloseFacet.sol:536`):

```solidity
function _rewardHook(bytes memory data) private {
    (bool ok, ) = address(this).call(data);
    if (!ok) { /* best-effort — the close proceeds regardless. */ }
}
```

Reward bookkeeping is **subordinate** to the fund-critical close, so the low-level
call's failure is deliberately **not** bubbled (a test harness omitting
`InteractionRewardsFacet` simply skips reward bookkeeping; production always cuts it).
`LibFacet.crossFacetCall` is NOT suitable here — it *bubbles* on failure — so each tight
facet that lacks one gets its own private `_rewardHook` (≈5 lines of bytecode, trivially
affordable even at the EIP-170 ceiling). Existing self-only hooks:
`InteractionRewardsFacet.precloseRewardClose(loanId, borrowerClean)` (`:608`) and
`precloseRewardTransferObligation(loanId)` (`:624`), each guarded by
`if (msg.sender != address(this)) revert RewardHookCallerNotSelf();`.

### New hook variants on `InteractionRewardsFacet`

Add two self-only hooks (headroom is here, per the L590-596 rationale):

1. **`liquidationRewardClose(uint256 loanId)`** → `closeLoan(loanId, false, false)`.
   Durable borrower forfeit + lender keeps + both windows shrunk to `today+1`. This is
   #1067 **item 1** — the forfeit is stamped `forfeited=true, closed=true` *durably*, so a
   later `InternalMatched → Settled` transition can't relive it as payable (see below).
2. **`terminalRewardClose(uint256 loanId, bool borrowerClean)`** → `closeLoan(loanId,
   borrowerClean, false)`. The proper-close / window-shrink family (#1067 **item 2**);
   lender never forfeits (the SALE path is the only lender-forfeit route). *Body is
   identical to the existing `precloseRewardClose`; a generic name is added so the
   prepay-sale / periodic paths don't call a "preclose"-named hook. `precloseRewardClose`
   stays for `PrecloseFacet`. (Decision for Codex: add the generic name, or reuse
   `precloseRewardClose` verbatim and accept the cosmetic mismatch? Leaning: add the
   generic — one extra ~small selector, clearer call sites, no behavior change.)*

For #1067 **item 3** (holder re-anchor), fold the reanchor into the existing
`precloseRewardTransferObligation` hook (see item-3 section) rather than a new selector.

### Why item 1 is genuinely unfixable by the status fallback

`_entryTerminalForfeit` (`:925-934`) derives a forfeit from live status **only for an
unclosed entry** (`if (e.closed) return false;`, `:929`). So today an internal-match
borrower entry, left unclosed, is caught as a forfeit *while* the loan reads
`InternalMatched`. But `ClaimFacet` later transitions `InternalMatched → Settled`
(lender claim). At that point the unclosed borrower entry is `_entryClaimable` (terminal
status) **and** `_entryTerminalForfeit` returns false (status is now `Settled`, not
`Defaulted/InternalMatched`) → it routes to the **liquidated borrower** as a payout. The
only fix is to stamp the forfeit **durably at liquidation time** via
`closeLoan(loanId, false, false)`, so `e.forfeited` (checked ahead of the status
fallback at `:1014`) carries the decision regardless of later status. This is Codex
#1061 P1, and it's why #1067 calls this item out as the one item no status-based
fallback can cover.

### The unwired terminal paths — wiring plan (5 facets, ~6 transitions)

Placement convention (mirrors `precloseDirect`): **consolidate/repoint → `terminalize`
cross-call → best-effort reward hook**, i.e. the reward hook goes immediately after the
existing `EncumbranceMutateFacet.terminalize` cross-call that flips the status.

| # | Facet · fn · terminal line | Transition | Hook | Semantics |
|---|---|---|---|---|
| 1 | `RiskMatchLiquidationFacet._settleFallbackOrTransitionPostMatch` — `:833` (Active), `:1038` + `:1126` (FallbackPending) | → InternalMatched | `liquidationRewardClose(loanId)` | **Forfeit** (item 1). Place beside the existing `LibVPFIDiscount.forfeitBorrowerLif(loan)` at `:851`. Add a local `_rewardHook`. |
| 2 | `PrepayListingFacet.executorFinalizePrepaySale` — `:197`; `_settleLoanFromParallelSale` — `:556` | → Settled | `terminalRewardClose(loanId, block.timestamp <= graceEnd)` | **Proper close / window-shrink** (item 2). Grace-aware borrowerClean (same `graceEnd` formula as preclose). Add a local `_rewardHook`. |
| 3 | `RepayPeriodicFacet.autoDeductDaily` — `:317` | → Repaid | `terminalRewardClose(loanId, true)` | **Proper close**, natural full repayment → `borrowerClean = true`. Add a local `_rewardHook`. (`_autoLiquidatePeriodShortfall` at `:480` is **non-terminal** — loan stays Active; it already repoints via `eagerConsolidateBothSides` at `:507`; **no reward close there**.) |
| 4 | `LenderIntentFacet.rollIntentLoan` — `:690` | Repaid → Settled | `terminalRewardClose(loanId, true)` (idempotent) | **Defensive no-op.** `rollIntentLoan` requires `status == Repaid` (`:529`) — entries were already closed at the earlier Active→Repaid by `RepayFacet.closeLoan`. The `_closeEntry` idempotency guard (`:1101`) makes the re-close a safe no-op. *Decision for Codex: wire defensively for completeness, or omit and document as already-covered? Leaning: omit the close (it can only no-op) and instead confirm the rolled-forward capital, if re-registered as fresh accrual, opens its own entry — verify at implementation.* |

**Count:** 6 terminal transitions across 4 wired facets (RiskMatch ×3 branches counted as
one logical close per loan; PrepayListing ×2; RepayPeriodic ×1; LenderIntent ×1
defensive). `ConsolidationFacet` is **not** terminal — it's the repoint helper (below).

### Item 3 — reward-only holder re-anchor before obligation-transfer / offset

**`completeOffset` is already safe.** Its `eagerConsolidateBothSides` runs at
`PrecloseFacet.sol:1638`, *before* `_settleOldLenderAtCompletion` at `:1652` (re-added
post-#1061 in PR #1070 with the correct ordering), so the current holder is already
re-anchored before settlement. **No change needed on the offset path.**

**`transferObligationViaOffer` is the real remaining gap.** It has **no** reanchor
before its split hook (`:896`). Verified NFT-lifecycle facts that make the fix safe:
- The borrower position NFT is **not** burned/reassigned in this flow; only the
  `loan.borrower` anchor is repointed to the incoming borrower at `:860`. At the reward-
  hook point (`:896`), `ownerOf(loan.borrowerTokenId)` **still resolves to the exiting
  holder** (the same value bound to `exitingBorrowerHolder` at `:820` and used for the
  collateral return at `:850`).
- Therefore the reanchor must key off **`ownerOf(tokenId)`**, NOT `loan.borrower`
  (already stale by `:896`).

**Fix — fold the reanchor into `precloseRewardTransferObligation`** (no new selector,
single cross-facet hop). New body:

```solidity
function precloseRewardTransferObligation(uint256 loanId) external {
    if (msg.sender != address(this)) revert RewardHookCallerNotSelf();
    LibVaipakam.Loan storage l = LibVaipakam.storageSlot().loans[loanId];
    // #1067 item 3 — re-anchor the EXITING entries to the current NFT holders
    // (a buyer who took the position NFT keeps the slice they earned) BEFORE
    // the split close. Keys off ownerOf(tokenId), not the (already-reassigned)
    // loan anchor. try/guard: repointRewardEntry no-ops on a burned/absent side.
    _reanchorSide(loanId, l.lenderTokenId,   /* isLenderSide */ true);
    _reanchorSide(loanId, l.borrowerTokenId, /* isLenderSide */ false);
    LibInteractionRewards.closeLoan(loanId, /* borrowerClean */ true, false);
    LibInteractionRewards.registerLoan(
        loanId, l.lender, l.borrower, l.principalAsset,
        l.principal, l.interestRateBps, l.durationDays
    );
}

function _reanchorSide(uint256 loanId, uint256 tokenId, bool isLenderSide) private {
    try IERC721(address(this)).ownerOf(tokenId) returns (address holder) {
        if (holder != address(0)) {
            LibInteractionRewards.repointRewardEntry(loanId, holder, isLenderSide);
        }
    } catch { /* token burned/absent — nothing to re-anchor */ }
}
```

Sequence: repoint exiting lender+borrower entries to current holders → `closeLoan`
(pays those current holders their pre-transfer slice, clean) → `registerLoan` (fresh
entries for the *continuing* loan; borrower side = incoming `l.borrower`; lender side =
`l.lender` anchor, matching the `registerLoan` convention used everywhere else).

**Scope decisions for Codex (item 3):**
- **Fresh entries anchor to `l.lender`/`l.borrower`, not `ownerOf`.** Only the *exiting*
  (already-earned) entries are reanchored. The continuing loan's fresh entries follow
  the standard `registerLoan` anchor convention; if the lender NFT was passively
  transferred, that stale-anchor case is pre-existing and handled by normal
  consolidation — out of scope for this fix.
- **Reuse `repointRewardEntry`** — the exact #1061-approved reward-only primitive; do
  **NOT** re-add `eagerConsolidateBothSides` to `transferObligationViaOffer` (that moved
  vaulted collateral AFTER the old collateral was released → double-withdraw / bricked
  flow; reverted in #1061 commit `5814345b`). This fix moves **no** collateral.

### Blast radius / ABI — Part 2

- **New external selectors:** `liquidationRewardClose(uint256)`,
  `terminalRewardClose(uint256,bool)` on `InteractionRewardsFacet` (both self-only). No
  existing selector changes. → **ABI re-export for `InteractionRewardsFacet`** +
  DeployDiamond / HelperTest / `FacetSelectors.sol` selector-list bumps (the three lists
  per the facet-checklist "adding a selector to an existing facet"), and the
  `_populateRoutedSet` / `SelectorCoverageTest` entries.
- `precloseRewardTransferObligation` body change is internal-only (no signature change).
- Tight facets each gain a private `_rewardHook` (no ABI surface).
- **Events:** no new state-change events (the reward hooks are silent; the existing
  terminal events on each facet already carry the loan-close signal the indexer reads).
  Confirm the indexer `check-event-coverage` allowlist needs no change (no new
  `@custom:event-category` events introduced).

### Test plan — Part 2 (`RewardLifecycleCloseTest` + per-facet suites, full diamond)

1. **Durable liquidation forfeit (item 1).** Internal-match a loan to `InternalMatched`;
   assert borrower entry `closed && forfeited`. Then drive `ClaimFacet`
   `InternalMatched → Settled`; assert the borrower reward still routes to **treasury**
   (not the liquidated borrower) via `sweepForfeitedInteractionRewards` /
   `claimInteractionRewards`. **This is the regression that the status fallback alone
   fails** — assert it explicitly against a pre-fix baseline.
2. **Prepay-sale window-shrink (item 2).** Finalize a prepay sale (both the executor and
   parallel-sale entrypoints) mid-window; assert both entries `closed`, `endDay`
   shrunk to `today+1`, in-grace → borrower keeps / late → borrower forfeits.
3. **Periodic auto-deduct close.** `autoDeductDaily` to full repayment; assert clean
   close + window shrink; assert `_autoLiquidatePeriodShortfall` (non-terminal) does
   **not** close.
4. **Holder re-anchor (item 3).** Borrower sells position NFT to Carol (NFT transfer, no
   consolidation) → Carol `transferObligationViaOffer` to Ben; assert the exiting
   borrower entry was repointed to **Carol** (she gets the pre-transfer slice), fresh
   entry opened for **Ben**, and lender side re-anchored to the current lender holder.
   Guard: no double-withdraw / no collateral movement (assert vault balances unchanged
   by the reward path).
5. **Offset unchanged.** `completeOffset` still re-anchors correctly (regression guard
   that item 3 didn't disturb the already-safe offset path).
6. **Best-effort isolation.** A harness diamond without `InteractionRewardsFacet` still
   completes every terminal close (hook swallow proven).
7. **LenderIntent roll (if wired).** `rollIntentLoan` close is a safe no-op (entries
   already closed) — assert no double-forfeit / no reward change.

---

## Sequencing & process

1. **Part 1 (#1008) and Part 2 (#1067) ship as SEPARATE PRs** — #1008 is a
   library-only, no-ABI, self-contained cap fix; #1067 is a multi-facet, ABI-affecting
   wiring change. Landing #1008 first de-risks the cap semantics before the larger
   close-out lands on top. (Decision for Codex: separate PRs vs one — leaning separate.)
2. Each PR: targeted `--match-path` tests + deploy-sanity suite (selectors change in
   Part 2 only) + release-note fragment + FunctionalSpec update in the same diff.
3. High-risk (fund-adjacent forfeit logic) → independent adversarial self-review before
   Codex round 1; then the Codex convergence loop to merge.

## Open questions for reviewers (Codex design rounds)

- **Q1 (#1008 gas):** is the O(window) per-day walk acceptable for the longest supported
  loan term, or should very-long windows fall back to the legacy windowed claim? (Design
  position: acceptable — bounded by term, matches sibling loops, claims are user-paid.)
- **Q2 (#1008 rounding):** confirm per-day flooring (≤1 wei/day, protocol-favoring) is
  the intended trade vs a single window-level floor.
- **Q3 (#1067 hook naming):** add generic `terminalRewardClose` or reuse
  `precloseRewardClose`?
- **Q4 (#1067 LenderIntent):** wire the roll close defensively, or omit as
  already-covered?
- **Q5 (#1067 item 3 fresh-entry anchor):** fresh continuing-loan entries on
  `l.lender`/`l.borrower` (proposed) vs current NFT holders?
- **Q6 (sequencing):** two PRs (proposed) or one?
