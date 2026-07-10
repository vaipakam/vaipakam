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
if (perDayCap == type(uint256).max) {
    // Cap disabled — the cap never bites, so the telescoped single division
    // is EXACT and O(1). Keep it (no per-day flooring, no window walk).
    reward = (e.perDayNumeraire18 * (cumEnd - cumStart)) / 1e18;
} else {
    // Cap enabled — walk the window applying the per-day min.
    uint256 prev = e.startDay == 0 ? 0 : cumArr[e.startDay - 1];
    for (uint256 d = e.startDay; d < e.endDay; ) {
        uint256 cur = cumArr[d];
        uint256 rawD = (e.perDayNumeraire18 * (cur - prev)) / 1e18;
        reward += rawD > perDayCap ? perDayCap : rawD;
        prev = cur;
        unchecked { ++d; }
    }
}
```

where `cumArr` is `s.cumLenderRpn18` or `s.cumBorrowerRpn18` chosen by `e.side` (the
same array the telescoped read already selected). **Keep both existing fast-path
guards** ahead of this block: `startDay >= endDay` and `cumEnd <= cumStart` (compute
`cumEnd`/`cumStart` as today, return 0 / mark `processed` when the whole window has no
RPN growth) — so the O(window) loop only runs when the cap is enabled AND there is a
non-zero reward to apportion. The `if (mutate) e.processed = true;` and the
forfeit-routing tail (`_processEntry:1009-1018`) are unchanged; only the middle
`reward = telescoped; window-cap` block is replaced.

**Decisions baked in (surface these for Codex):**

1. **Uncapped fast path preserves exactness (Codex r1 F2).** When the cap is disabled
   (`perDayCap == type(uint256).max` — ETH feed unavailable or admin `capRatio == max`)
   the code keeps the **telescoped single division**, so the result is byte-for-byte the
   pre-fix value: no per-day flooring, no window walk, O(1). The per-day loop — and its
   per-day flooring — is reached **only when the cap is enabled** (where the cap already
   makes the amount a bound, so sub-wei-per-day flooring is immaterial and
   protocol-favoring). This both removes the "≤1 wei/day" divergence on the common
   cap-disabled config and restores O(1) gas there.
2. **Gas: O(window) SLOADs only when the cap is enabled.** With the cap on, the per-day
   walk is O(`endDay − startDay`) SLOADs of `cumRpn18[d]` — the only correct shape for a
   per-day min (daily RPN varies with global activity; no per-band or global-cumulative
   shortcut exists). Bounded by the loan term and by the whole window being finalized
   (`cursor ≥ endDay−1`) before the loop runs; matches the existing per-day cost of the
   `advanceCum*` loops. Claims are user-initiated and per-entry. **The legacy
   `claimForUserWindow` is NOT a fallback for long entry windows (Codex r1 F1):** it pays
   from the pre-entry per-user daily maps (`userLenderInterestNumeraire18` /
   `userBorrowerInterestNumeraire18`) that the entry path never populates
   (`registerLoan` only writes `RewardEntry` rows + the delta/cumRPN machinery), so
   routing an entry-path loan through it would pay **zero**. If a future very-long-term
   product ever makes the loop a concern, the only valid shape is a **paginated
   entry-claim** (claim `[startDay, k)` then `[k, endDay)` across txs), NOT the legacy
   path — explicitly out of scope here; the O(window) entry loop stands.
3. **`_processEntry` and `_previewEntryReward` must stay identical** (preview parity is a
   standing invariant of this lib — a preview that over-reports vs the claim is itself a
   bug). Both get the same fast-path + loop.

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
   uncapped telescoped total **exactly** (the uncapped fast path keeps the single
   division — no per-day-floor tolerance needed here; Codex r1 F2).
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

### The re-anchor invariant — every close pays the current NFT holder (Codex r1 F4+F5)

Codex r1 surfaced that a reward close **freezes** the reward under the entry's stored
`RewardEntry.user`, but the fund side of every terminal path resolves the **live NFT
holder** (`PrepayListingFacet` pays `ownerOf`; `ClaimFacet` gates on the live position
NFT). If a position NFT was passively transferred (without consolidation) before the
terminal event, the funds go to the live holder while the reward would close to the
**stale** stored party. So the design adopts one uniform invariant:

> **Every reward close re-anchors both sides to the current position-NFT holders
> *before* closing.**

A shared self-only helper on `InteractionRewardsFacet` (which has the headroom + already
owns `repointRewardEntry`):

```solidity
function _reanchorBothSides(uint256 loanId) private {
    LibVaipakam.Loan storage l = LibVaipakam.storageSlot().loans[loanId];
    _reanchorSide(loanId, l.lenderTokenId,   /* isLenderSide */ true);
    _reanchorSide(loanId, l.borrowerTokenId, /* isLenderSide */ false);
}
function _reanchorSide(uint256 loanId, uint256 tokenId, bool isLenderSide) private {
    try IERC721(address(this)).ownerOf(tokenId) returns (address holder) {
        if (holder != address(0)) {
            LibInteractionRewards.repointRewardEntry(loanId, holder, isLenderSide);
        }
    } catch { /* token burned/absent — nothing to re-anchor */ }
}
```

`repointRewardEntry` no-ops when the side's entry is absent or already on that user and
keeps the per-loan pointer intact (so `sweepForfeitedByLoanId` still finds it). This is
cheap (two `ownerOf` reads) and safe on a burned token (try/catch). It runs inside the
best-effort hook, so any failure is swallowed by the caller's `_rewardHook`.

### New hook variants on `InteractionRewardsFacet`

Add two self-only hooks (headroom is here, per the L590-596 rationale); **both
re-anchor first**:

1. **`liquidationRewardClose(uint256 loanId)`** → `_reanchorBothSides(loanId)` then
   `closeLoan(loanId, false, false)`. Durable borrower forfeit + lender keeps + both
   windows shrunk to `today+1`. This is #1067 **item 1** — the forfeit is stamped
   `forfeited=true, closed=true` *durably*, so a later `InternalMatched → Settled`
   transition can't relive it as payable (see below). (Re-anchor still matters for the
   lender side — a transferred lender NFT's holder gets the kept reward; the forfeited
   borrower side routes to treasury regardless of holder, but re-anchoring is harmless.)
2. **`terminalRewardClose(uint256 loanId, bool borrowerClean)`** →
   `_reanchorBothSides(loanId)` then `closeLoan(loanId, borrowerClean, false)`. The
   proper-close / window-shrink family (#1067 **item 2**); lender never forfeits (the
   SALE path is the only lender-forfeit route). *Body body-shares with the existing
   `precloseRewardClose` except for the re-anchor prefix; a generic name is added so the
   prepay-sale / periodic paths don't call a "preclose"-named hook. `precloseRewardClose`
   stays for `PrecloseFacet` (its callers already consolidate/re-anchor upstream — the
   `precloseDirect` `eagerConsolidateBothSides` at `:242` and the offset path — so it
   does not need the prefix; leaving it untouched avoids churn). (Q3 for Codex: acceptable
   to keep `precloseRewardClose` distinct, or unify? Leaning: keep distinct — the preclose
   callers already re-anchor, so adding the prefix there would double-repoint harmlessly
   but needlessly.)*

For #1067 **item 3** (obligation-transfer split), the same `_reanchorBothSides` runs
inside `precloseRewardTransferObligation` before the split close (see item-3 section);
no new selector.

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
| 2 | `PrepayListingFacet.executorFinalizePrepaySale` — `:197`; `_settleLoanFromParallelSale` — `:556` | → Settled | `terminalRewardClose(loanId, true)` | **Proper close / window-shrink** (item 2). `borrowerClean = true` **unconditionally** — a LATE prepay sale is **unreachable**: the executor rejects `block.timestamp > pctx.graceEnd` with `GraceExpired` and `_settleLoanFromParallelSale` rejects it with `ParallelSaleFillPastGrace` *before* transitioning, so a settled prepay sale is always in-grace (Codex r1 F3). Add a local `_rewardHook`. |
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
single cross-facet hop), reusing the shared `_reanchorBothSides` helper. New body:

```solidity
function precloseRewardTransferObligation(uint256 loanId) external {
    if (msg.sender != address(this)) revert RewardHookCallerNotSelf();
    LibVaipakam.Loan storage l = LibVaipakam.storageSlot().loans[loanId];
    // #1067 item 3 — re-anchor the EXITING entries to the current NFT holders
    // (a buyer who took the position NFT keeps the slice they earned) BEFORE the
    // split close. Keys off ownerOf(tokenId), not the (already-reassigned) loan
    // anchor; repointRewardEntry no-ops on a burned/absent side.
    _reanchorBothSides(loanId);
    LibInteractionRewards.closeLoan(loanId, /* borrowerClean */ true, false);
    // Fresh continuing-loan entries. Codex r1 F4 — the LENDER side anchors to the
    // CURRENT lender-NFT holder, not the (possibly stale) l.lender, so post-transfer
    // lender rewards don't accrue to a prior stored lender who sold their NFT. The
    // BORROWER side is the incoming obligor l.borrower (Ben) — he pays the interest
    // going forward, and the borrower position NFT is NOT reassigned here (it stays
    // with the exiting holder), so ownerOf(borrowerTokenId) would be the WRONG party.
    address freshLender = _currentHolderOr(l.lenderTokenId, l.lender);
    LibInteractionRewards.registerLoan(
        loanId, freshLender, l.borrower, l.principalAsset,
        l.principal, l.interestRateBps, l.durationDays
    );
}

function _currentHolderOr(uint256 tokenId, address fallbackAddr) private view returns (address) {
    try IERC721(address(this)).ownerOf(tokenId) returns (address holder) {
        return holder == address(0) ? fallbackAddr : holder;
    } catch { return fallbackAddr; }
}
```

Sequence: repoint exiting lender+borrower entries to current holders → `closeLoan`
(pays those current holders their pre-transfer slice, clean) → `registerLoan` (fresh
entries: **lender = current lender-NFT holder**, borrower = incoming obligor `l.borrower`).

**Scope decisions for Codex (item 3):**
- **Fresh LENDER entry anchors to the live lender-NFT holder (Codex r1 F4)**, not the
  stale `l.lender`. **Fresh BORROWER entry anchors to `l.borrower`** (the incoming
  obligor) — the borrower position NFT is not reassigned in this flow (verified above),
  so it is decoupled from the obligation; the reward-earning going-forward party is the
  obligor who pays interest, matching the existing `registerLoan` convention. *(The
  broader "should the borrower reward follow the NFT holder or the obligor when they
  diverge?" question is a pre-existing model choice, unchanged here — out of scope.)*
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
   parallel-sale entrypoints) mid-window, in-grace; assert both entries `closed`, `endDay`
   shrunk to `today+1`, borrower **keeps** (always clean). Separately assert a **late**
   fill is **rejected** at the entrypoint (`GraceExpired` / `ParallelSaleFillPastGrace`)
   and never reaches the close — no late-close/forfeit path exists to test (Codex r1 F3).
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
8. **Terminal re-anchor (Codex r1 F5).** Passively transfer a position NFT (no
   consolidation) to a new holder, then drive a terminal close on a non-consolidating
   path (prepay sale / periodic auto-deduct); assert the reward entry closed to the
   **live** holder (matching where the funds went), not the stale stored user.

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

## Resolved after Codex round 1

- **F1 (legacy fallback)** — dropped; the legacy window claim can't pay entry-path
  rewards (pays from the pre-entry per-user daily maps). O(window) entry loop stands;
  the only valid future scaling is a paginated entry-claim.
- **F2 (uncapped exactness)** — added the uncapped telescoped fast path; cap-disabled
  config is now byte-exact and O(1), and the per-day floor is confined to the
  cap-enabled branch where it's immaterial.
- **F3 (unreachable late prepay sale)** — prepay close is unconditionally
  `borrowerClean = true`; the late path reverts at the entrypoint and is tested as a
  revert, not a close.
- **F4 (fresh lender anchor)** — fresh continuing-loan **lender** entry anchors to the
  live lender-NFT holder; borrower stays `l.borrower` (obligor; NFT not reassigned).
- **F5 (re-anchor before terminal close)** — adopted the uniform invariant: every
  reward close (`terminalRewardClose` / `liquidationRewardClose` / the obligation-transfer
  hook) re-anchors both sides to the live NFT holders first, so the reward closes to the
  same party the funds pay.

## Open questions still for reviewers

- **Q3 (#1067 hook naming):** keep `precloseRewardClose` distinct (its callers already
  re-anchor upstream) vs unify with `terminalRewardClose`? (Leaning: keep distinct.)
- **Q4 (#1067 LenderIntent):** wire the roll close defensively, or omit as
  already-covered by the prior Active→Repaid close? (Leaning: omit.)
- **Q6 (sequencing):** two PRs (proposed) or one?
