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

### The key algebraic fact — the cap threshold is entry-INDEPENDENT

`perDayCap = _capVpfiForInterestUsd(P, …) = (P · 10^feedDec · capRatio) / ethPriceRaw`
(`:1270`) is **linear in `P = e.perDayNumeraire18`**. The cap bites on day `d` iff
`raw_d = P · Δ_d / 1e18 > perDayCap`, i.e. iff `Δ_d > T` where

```
T = perDayCap · 1e18 / P = (10^feedDec · capRatio · 1e18) / ethPriceRaw
```

**`T` has no `P` term — it is the SAME threshold for every entry** (it depends only on
`ethPriceRaw`, `feedDec`, `capRatio`, all read once). And the capped daily reward factors
cleanly:

```
capped_d = min(P·Δ_d/1e18, perDayCap) = (P/1e18) · min(Δ_d, T)
```

So the spec-correct window reward is `(P/1e18) · Σ_d min(Δ_d, T)`, and **`Σ_d min(Δ_d, T)`
is a GLOBAL per-day quantity** (entry-independent) that can be accumulated once, exactly
like the existing `cumRpn18`. My round-1 claim that "a single global capped-cumulative
can't work because T is per-entry" was **wrong** — it retracts here. `Δ_d =
(halfPoolForDay(d)·1e18)/knownGlobal…[d]` still varies arbitrarily day-to-day, but that
variation is captured by accumulating `min(Δ_d, T)` at finalization, not by a per-entry
claim-time loop.

### Design options (F6 forced this reconsideration — Codex r2 flagged the claim-loop gas)

Codex r2 correctly showed a naïve per-day loop at claim time is **not viable**:
`claimInteractionRewards()` loops over *every* `userRewardEntryIds[user]` entry with no
selector (`:640-646`), so a cap-enabled O(`durationDays`) loop per entry can exceed the
block gas limit for a user with many long loans, with no subset-claim escape.

**Option B — global capped-cumulative at finalization (RECOMMENDED).** Add a second
global cumulative per side, `cumMinLenderRpn18[d] = Σ_{k≤d} min(Δ_k, T_k)` (and the
borrower mirror), maintained inside the existing per-day `advanceCumLenderThrough` /
`advanceCumBorrowerThrough` finalization loop (`:561-620`) — those loops already iterate
day-by-day and compute `Δ_d`, so this is O(1) extra work per already-finalized day, **no
new loop anywhere**. The claim then stays **O(1) per entry**:

```
reward = (e.perDayNumeraire18 * (cumMinArr[e.endDay-1] - cumMinArr[e.startDay-1])) / 1e18
```

`_processEntry` / `_previewEntryReward` swap `cumRpn18` → `cumMinRpn18` and **drop the
claim-time cap logic entirely** (no `_capVpfiForInterestUsd` read, no ETH-price read at
claim). Properties:

- **O(1) claims** — no regression vs today; no pagination needed; the F6 gas problem
  disappears at the source.
- **Exact** per-day cap (`min(Δ_k, T_k)` summed as integers; one final `/1e18` floor,
  matching how the uncapped telescoped path already floors — no per-day flooring).
- **Cap integrity preserved via a feed-gated cursor.** `T_k` needs the ETH price at
  finalization. To avoid *baking a permanent cap-off* when the feed is down at
  finalization (a fail-open regression — cf. #919), `cumMinRpn18` gets its **own cursor**
  that advances a day only when the ETH feed is readable AND `capRatio` is set at that
  moment; if the feed is unavailable the cumMin cursor stalls (retried later) while the
  uncapped `cumRpn18` (needed for the pool/budget math) advances unconditionally as today.
  A claim requires `cumMinCursor ≥ endDay-1` (same shape as the existing cumRpn gate), so
  during a feed outage claims wait for cumMin to catch up rather than paying fail-open.
- **Semantic shift (needs human sign-off):** the cap is priced at **each day's
  finalization-time ETH price**, not the claim-time price the current (buggy) code uses.
  This is arguably *more* faithful ("value the day's interest at that day's ETH price"),
  but it is a deliberate change — flagged as **Q7** below.
- **Cross-chain unaffected:** the pool/per-chain budget math uses the *uncapped* `cumRpn18`
  (unchanged); `cumMinRpn18` is a pure per-user claim-side ceiling and never enters the
  budget/remittance accounting.
- Pre-live ⇒ the new storage mappings + cursors are a free append (no migration).

**Option A — per-day loop at claim + pagination (fallback).** Keep the cap at claim time
(claim-time ETH price, matching current semantics), replace the window-cap with a per-day
`Σ min(raw_d, perDayCap)` loop in `_processEntry`/`_previewEntryReward`, and add
**entry-pagination** so a heavy user can always make progress: a persistent
`userRewardClaimCursor[user]` advancing past the processed prefix + a per-call bound
(`MAX_ENTRIES_PER_CLAIM`), and/or an explicit `claimInteractionRewardsRange(from,to)`
escape hatch. Downsides vs B: O(`days`) per entry, a new claim selector + cursor state,
per-day flooring, and pagination edge cases (out-of-order claimability stalling the
cursor). Only chosen if the Q7 finalization-time-pricing shift is rejected.

**Recommendation: Option B.** It removes the gas problem structurally, keeps claims O(1),
is exact, and the only cost is the (defensible, more-correct) finalization-time pricing —
which is a conscious decision to ratify, not a bug.

**Decisions baked in (both options):**

1. **`_processEntry` and `_previewEntryReward` stay identical** (preview parity is a
   standing invariant — a preview that over-reports vs the claim is itself a bug).
2. **No legacy-window fallback (Codex r1 F1).** `claimForUserWindow` pays from the
   pre-entry per-user daily maps the entry path never populates → would pay zero; it is
   never a fallback for entry-path rewards under either option.
3. **Uncapped config (Codex r1 F2).** Under Option B, when the feed/capRatio disable the
   cap at finalization, `min(Δ_k, T_k) = Δ_k` so `cumMinRpn18 == cumRpn18` and the claim
   reproduces the uncapped telescoped total exactly. (Under Option A, an explicit uncapped
   telescoped fast path does the same.)

### Blast radius / ABI — Part 1 (Option B)

Internal-library + storage change; **no external selector / struct / event change** →
no ABI re-export, no diamond cut, no consumer typecheck. Adds two per-day mappings
(`cumMinLenderRpn18`, `cumMinBorrowerRpn18`) + two cursors to `LibVaipakam.Storage`
(append-only — pre-live, no migration), and O(1)-per-day writes inside the two
`advanceCum*` finalization loops. `claimInteractionRewards` / `previewInteractionRewards`
signatures unchanged; their returned value is **≤** the pre-fix value (the cap only ever
tightens) plus the Q7 pricing shift, so no downstream over-payment risk. The legacy
window path (`claimForUserWindow`, already per-day-correct) is untouched.

*(Option A instead would add a claim selector + `userRewardClaimCursor` state — a real
ABI surface change — which is one more reason to prefer B.)*

### Test plan — Part 1 (`InteractionRewardsFacet` reward-cap suite; Option B)

1. **Netting is closed** — an entry with one over-cap day and several under-cap days pays
   `(P/1e18)·Σ min(Δ_d, T)`, strictly less than the old `min(Σ raw, Σ cap)`. Seed per-day
   globals so `Δ_d` varies (high-share quiet day + normal days); assert the exact total
   and that it is `<` the old window-cap total.
2. **All days under cap** — `cumMinRpn18 == cumRpn18` over the window → result equals the
   uncapped telescoped total exactly.
3. **All days over cap** — every `min(Δ_d,T)=T` → result equals `(P/1e18)·(T·daysInWindow)
   = perDayCap·daysInWindow` (matches the old window cap in this degenerate case).
4. **Cap disabled at finalization** (`ethPriceRaw == 0` or `capRatio == max`) —
   `cumMinRpn18` tracks `cumRpn18` → result equals the uncapped telescoped total exactly.
5. **Feed-gated cursor** — with the feed down during finalization of some days, the cumMin
   cursor stalls and a claim over those days pays nothing yet (waits), then pays correctly
   once the feed recovers and cumMin catches up. Asserts **no fail-open** cap-off is baked.
6. **Finalization-time pricing (Q7)** — a day finalized at ETH price `p1` caps at `T(p1)`
   even if the claim later happens at a different price `p2`; assert the cap used `p1`.
7. **Preview == claim** — `previewInteractionRewards` equals the subsequently-claimed
   amount for cases 1–6.
8. **Single-day window** — `endDay − startDay == 1` reduces to `(P/1e18)·min(Δ_0, T)`.

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

### The re-anchor invariant — centralized in `closeLoan` (Codex r1 F4/F5 + r2 F6/F8)

Codex r1 surfaced that a reward close **freezes** the reward under the entry's stored
`RewardEntry.user`, but the fund side of every terminal path resolves the **live NFT
holder** (`PrepayListingFacet` pays `ownerOf`; `ClaimFacet` gates on the live position
NFT). So a passively-transferred position (NFT moved, not consolidated) pays funds to the
live holder while the reward closes to the **stale** stored party.

Codex r2 (F6) then showed my first fix — re-anchoring only inside the *new* hooks — does
**not** achieve the invariant, because the many *existing* direct callers of `closeLoan`
(`RepayFacet.repayLoan:440`, `RiskFacet` HF-liquidation `:906`, `DefaultedFacet:769`,
`SwapToRepayFacet:534`, `AutoLifecycleFacet:737`, and the preclose hooks) bypass any
hook-level re-anchor. **Fix: put the re-anchor inside `closeLoan` itself** — the single
choke point every terminal close already routes through — so every caller (existing and
new) gets it uniformly:

```solidity
// inside LibInteractionRewards.closeLoan, before each side's _closeEntry:
function _reanchorOpenSide(
    LibVaipakam.Storage storage s, uint256 loanId, uint256 entryId,
    uint256 tokenId, bool isLenderSide
) private {
    if (entryId == 0) return;
    // Codex r2 F8 — NEVER re-anchor an already-closed entry: its reward was
    // earned+frozen at the earlier close, and repointRewardEntry would hand
    // that frozen slice to a later NFT holder. Only OPEN entries re-anchor.
    if (s.rewardEntries[entryId].closed) return;
    try IERC721(address(this)).ownerOf(tokenId) returns (address holder) {
        if (holder != address(0)) {
            LibInteractionRewards.repointRewardEntry(loanId, holder, isLenderSide);
        }
    } catch { /* token burned/absent — nothing to re-anchor */ }
}
```

`closeLoan` calls `_reanchorOpenSide` for the lender and borrower entries (reading their
tokenIds from `s.loans[loanId]`) immediately before the existing `_closeEntry` calls.
Properties:
- **Uniform** — the invariant now holds for *every* close path, not just the 6 new ones,
  closing the pre-existing stale-user gap on repay / default / HF-liquidation too (a
  latent bug those paths shared). Flagged as a deliberate, correct behavior alignment.
- **Idempotent + safe** — `repointRewardEntry` no-ops when the entry is already on the
  live holder (so callers that already consolidated, e.g. `precloseDirect`'s
  `eagerConsolidateBothSides`, double-repoint harmlessly). The `closed` guard (F8) means
  a re-close (e.g. the LenderIntent roll) never moves a frozen entry.
- **Cheap** — two `ownerOf` reads on the close path; try/catch tolerates a burned token.
- Because it lives in the library `internal` `closeLoan`, it inlines into each facet and
  runs in the diamond context (`address(this)` = diamond → routes to `VaipakamNFTFacet`),
  exactly like the existing `OracleFacet(address(this))` call in `_perDayInterestNumeraire18`.

The per-hook `_reanchorBothSides` from round 1 is **removed** — the new hooks just call
`closeLoan` (which now re-anchors). The only place that still needs a hook-level `ownerOf`
resolution is the **fresh** lender registration in the obligation-transfer split (F4,
below), because that opens a *new* entry rather than closing an existing one.

### New hook variants on `InteractionRewardsFacet`

With the re-anchor now inside `closeLoan`, the hooks are thin (headroom is here, per the
L590-596 rationale):

1. **`liquidationRewardClose(uint256 loanId)`** → `closeLoan(loanId, false, false)`.
   Durable borrower forfeit + lender keeps + both windows shrunk to `today+1`. This is
   #1067 **item 1** — the forfeit is stamped `forfeited=true, closed=true` *durably*, so a
   later `InternalMatched → Settled` transition can't relive it as payable (see below).
   The `closeLoan` re-anchor still benefits the lender side (a transferred lender NFT's
   holder gets the kept reward; the forfeited borrower routes to treasury either way).
2. **`terminalRewardClose(uint256 loanId, bool borrowerClean)`** →
   `closeLoan(loanId, borrowerClean, false)`. The proper-close / window-shrink family
   (#1067 **item 2**); lender never forfeits (the SALE path is the only lender-forfeit
   route). *Semantically identical to the existing `precloseRewardClose`; the generic name
   just keeps the prepay-sale / periodic call sites from invoking a "preclose"-named hook.
   `precloseRewardClose` stays for `PrecloseFacet`. (Q3 for Codex: keep distinct vs unify —
   leaning keep distinct.)*

Since `closeLoan` now centralizes the re-anchor, the existing `precloseRewardClose` and
the direct-caller facets **inherit** the invariant with **no call-site change** — only the
6 new terminal paths need the new hooks + a local `_rewardHook`.

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
| 4 | `LenderIntentFacet.rollIntentLoan` — `:690` | Repaid → Settled | **OMIT** (Codex r2 F8) | `rollIntentLoan` requires `status == Repaid` (`:529`), so the entries were **already closed** at the prior Active→Repaid by `RepayFacet.closeLoan`. Wiring `terminalRewardClose` here would be worse than a no-op: with re-anchor now in `closeLoan`, the `!closed` guard **skips** re-anchoring (correct), and `_closeEntry` returns on `e.closed`, so nothing happens — but adding the hook is dead weight and risks future confusion. **Omit it** (Q4 resolved: omit). Verify at implementation that any rolled-forward capital re-registered as a fresh loan opens its own entry via the normal `registerLoan` path. |

**Count:** 5 terminal transitions across 3 wired facets (RiskMatch ×3 branches = one
logical close per loan; PrepayListing ×2; RepayPeriodic ×1). LenderIntent is **omitted**
(already closed at the prior repay). `ConsolidationFacet` is **not** terminal — it's the
repoint helper (below).

### Item 3 — reward-only holder re-anchor before obligation-transfer / offset

**`completeOffset` is already safe.** Its `eagerConsolidateBothSides` runs at
`PrecloseFacet.sol:1638`, *before* `_settleOldLenderAtCompletion` at `:1652` (re-added
post-#1061 in PR #1070 with the correct ordering), so the current holder is already
re-anchored before settlement. **No change needed on the offset path.**

**`transferObligationViaOffer` — the fresh-registration anchor is the remaining gap.**
The **exiting** entries are now re-anchored automatically by the centralized `closeLoan`
re-anchor (above), so the buyer of a transferred position keeps their pre-transfer slice
without a hook-level call. What `closeLoan` can't do is the **fresh** registration for the
continuing loan — that opens *new* entries. NFT-lifecycle facts (corrected per Codex r2
F7):
- At the reward-hook point (`:896`), `ownerOf(loan.borrowerTokenId)` resolves to the
  **exiting** holder (bound as `exitingBorrowerHolder` at `:820`). The borrower NFT **is**
  later burned + re-minted to `newBorrower` by `LibLoan.migrateBorrowerPosition`
  (`:1033`), but that runs **after** the reward hook — so *at the hook* the token still
  belongs to the exiting holder, and *after the tx* `newBorrower == l.borrower` holds the
  new borrower NFT (no lasting NFT/obligor divergence). The correct fresh-borrower anchor
  is therefore `l.borrower` because the hook precedes the migration, **not** because the
  NFT is never reassigned (my r1 rationale was wrong).
- The lender NFT is untouched here, so the fresh **lender** entry must anchor to the live
  lender-NFT holder (F4), which may differ from the stale `l.lender`.

**Fix — `precloseRewardTransferObligation` closes (re-anchor now automatic) then registers
fresh with the F4 lender anchor:**

```solidity
function precloseRewardTransferObligation(uint256 loanId) external {
    if (msg.sender != address(this)) revert RewardHookCallerNotSelf();
    LibVaipakam.Loan storage l = LibVaipakam.storageSlot().loans[loanId];
    // closeLoan now re-anchors the EXITING open entries to their live NFT holders
    // (centralized), then shrinks+closes them clean — the buyer of a transferred
    // position keeps the slice they earned.
    LibInteractionRewards.closeLoan(loanId, /* borrowerClean */ true, false);
    // Fresh continuing-loan entries. Codex r1 F4 — LENDER anchors to the CURRENT
    // lender-NFT holder, not the (possibly stale) l.lender. BORROWER = incoming
    // obligor l.borrower: the borrower NFT is re-minted to l.borrower AFTER this
    // hook (migrateBorrowerPosition), and the going-forward interest-payer is the
    // obligor, so l.borrower is correct.
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

Sequence: `closeLoan` (re-anchors + shrinks + closes the exiting entries clean, paying
current holders their pre-transfer slice) → `registerLoan` (fresh entries: **lender =
current lender-NFT holder**, borrower = incoming obligor `l.borrower`).

**Scope decisions for Codex (item 3):**
- **Fresh LENDER entry anchors to the live lender-NFT holder (Codex r1 F4)**, not the
  stale `l.lender`. **Fresh BORROWER entry anchors to `l.borrower`** (the incoming
  obligor) — the borrower position NFT is not reassigned in this flow (verified above),
  the reward-earning going-forward party is the obligor who pays interest, and the
  borrower NFT is re-minted to `l.borrower` right after the hook — so `l.borrower` matches
  both the obligor and the post-tx NFT holder (Codex r2 F7). *(The broader "should the
  borrower reward follow the NFT holder or the obligor when they diverge?" question is a
  pre-existing model choice, unchanged here — out of scope.)*
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
- **`LibInteractionRewards.closeLoan` gains the centralized re-anchor** — this touches
  **every** close path (repay / default / HF-liquidation / preclose / offset + the 3 new
  ones), adding two `ownerOf` reads per close and aligning their reward attribution to the
  live NFT holder. Behavior-affecting but strictly a correctness alignment (funds already
  go to the live holder). Needs the touched facets' existing suites re-run, not just the
  new ones.
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
7. **Closed-entry re-anchor guard (Codex r2 F8).** Repay a loan (closes both entries),
   transfer the position NFT to a new holder, then drive a re-close path (e.g. the
   LenderIntent roll, or any second `closeLoan`); assert the **already-closed** entry is
   **not** moved to the new holder — the earlier-earned frozen reward stays with the party
   that held it at close.
8. **Centralized terminal re-anchor (Codex r1 F5 + r2 F6).** Passively transfer a position
   NFT (no consolidation), then drive a close on **each** path — a new terminal (prepay /
   periodic) **and** an existing direct one (repay / default) — and assert the still-open
   entry closes to the **live** holder (matching where the funds went), proving the
   `closeLoan`-centralized re-anchor covers every path, not just the new hooks.

---

## Sequencing & process

1. **Part 1 (#1008) and Part 2 (#1067) ship as SEPARATE PRs** — #1008 (Option B) is a
   library + storage change with no external ABI; #1067 is a multi-facet, selector-adding
   wiring change plus the `closeLoan` re-anchor. Landing #1008 first de-risks the cap
   accounting before the close-out lands on top. (Q6 for Codex: separate vs one — leaning
   separate.)
2. Each PR: targeted `--match-path` tests + deploy-sanity suite (selectors change in
   Part 2 only) + release-note fragment + FunctionalSpec update in the same diff.
3. High-risk (fund-adjacent forfeit logic) → independent adversarial self-review before
   Codex round 1; then the Codex convergence loop to merge.

## Resolved after Codex rounds 1–2

Round 1:
- **F1 (legacy fallback)** — dropped; the legacy window claim can't pay entry-path rewards.
- **F2 (uncapped exactness)** — subsumed by Option B (cap baked at finalization; uncapped
  config makes `cumMinRpn18 == cumRpn18`, exact).
- **F3 (unreachable late prepay sale)** — prepay close is unconditionally `borrowerClean =
  true`; the late path reverts at the entrypoint (tested as a revert).
- **F4 (fresh lender anchor)** — fresh continuing-loan **lender** entry anchors to the live
  lender-NFT holder; borrower stays `l.borrower`.
- **F5 (re-anchor before close)** — adopted; superseded by the r2 centralization.

Round 2:
- **F6 (claim-loop gas)** — the decisive one: it drove the switch to **Option B**
  (global `cumMinRpn18` at finalization, O(1) claims, no pagination), using the newly
  proven fact that the cap threshold `T` is entry-independent.
- **F6 (re-anchor coverage)** — centralized the re-anchor into `closeLoan` so **every**
  close path (existing direct callers included) gets it, not just the new hooks.
- **F7 (borrower-NFT rationale)** — corrected: the NFT **is** re-minted to `l.borrower`
  by `migrateBorrowerPosition`, but after the hook; `l.borrower` is right for that reason.
- **F8 (skip closed entries)** — the centralized re-anchor skips `e.closed` entries so a
  frozen slice is never moved to a later holder; LenderIntent hook **omitted** (Q4 resolved).

## Open questions still for reviewers

- **Q7 (#1008 pricing — NEEDS HUMAN SIGN-OFF):** Option B prices the daily cap at each
  day's **finalization-time** ETH price rather than the current code's **claim-time**
  price. This is arguably more faithful (value the day's interest at that day's ETH price)
  and is what enables O(1) claims — but it is a deliberate semantic change to a
  security-relevant cap. Ratify Option B (recommended) vs fall back to Option A
  (claim-time price + per-day loop + pagination)?
- **Q3 (#1067 hook naming):** keep `precloseRewardClose` distinct vs unify with
  `terminalRewardClose`? (Leaning: keep distinct.)
- **Q6 (sequencing):** two PRs (proposed) or one?
