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
like the existing `cumRpn18`.

**Integer-`T` precision note (Codex r5 I5 + r6 J6 — P3):** the stored `T` is a floored
integer `floor(10^feedDec·capRatio·1e18/ethPrice)`, and the claim floors **once** after
summing `T·P` across the window. Versus a hypothetical *strict per-day-floored* cap, the
difference is **two-directional** and **both sides scale with the window (Codex r7 K3 + r8 L1)**: the `T`
floor loses up to `⌈P/1e18⌉` wei **per capped day** (pushes down — a `1_000e18` daily
numeraire can differ by ~1000 wei/day), while the single window-floor recovers up to
`#capped days − 1` wei (pushes up — e.g. ten days each contributing `0.9` after `P·T/1e18`
give `floor(9)=9` vs strict per-day floors summing to `0`). Neither the spec nor the cap
requires a *strict* per-day integer floor (the cap is an approximate anti-farming ceiling),
so the design **accepts** a bounded asymmetric dust and the tests assert
`−⌈P/1e18⌉·(#capped days) ≤ (Option B − strict-per-day-floored) ≤ +(#capped days) wei`,
rather than a symmetric, one-sided, or byte-exact bound. My round-1 claim that "a single global capped-cumulative
can't work because T is per-entry" was **wrong** — it retracts here. `Δ_d =
(halfPoolForDay(d)·1e18)/knownGlobal…[d]` still varies arbitrarily day-to-day, but that
variation is captured by accumulating `min(Δ_d, T)` at finalization, not by a per-entry
claim-time loop.

### CHOSEN: Option B — capped-cumulative baked at finalization (owner-ratified 2026-07-11)

Codex r2 (F6) showed a naïve per-day loop at claim time is **not viable**:
`claimInteractionRewards()` loops over *every* `userRewardEntryIds[user]` entry with no
selector (`:640-646`), so a cap-enabled O(`durationDays`) loop per entry can exceed the
block gas limit for a user with many long loans. Option B removes the gas problem at the
source by baking the per-day cap into a global cumulative at day-finalization. **The owner
ratified Option B including its finalization-time pricing + cap-ratio semantics
(2026-07-11).**

**The threshold is CANONICAL — computed once on Base, broadcast to mirrors (Codex r4 H1).**
A per-chain threshold would break the remittance identity: Base computes a mirror's
*budget* with Base's `T_d`, but the mirror computes *claims* with its own feed/config
snapshot — if they differ, the mirror under- or over-funds. So `T_d` is computed **once,
on Base, at `_finalizeAndWrite`** and travels in the **same broadcast** that finalizes the
day on mirrors:

```
// Base, at RewardAggregatorFacet._finalizeAndWrite (:353), alongside knownGlobalSet[d]=true:
s.dayCapThreshold18[d] = T_d = (10^feedDec · capRatio · 1e18) / ethPriceRaw
```

- **Cap ratio = the EFFECTIVE value, not the raw slot (Codex r4 H5).** `capRatio` MUST be
  `LibVaipakam.getInteractionCapVpfiPerEth()` (which maps a stored `0` — the normal
  *unset/default* state — to the `500` default), **NOT** the raw
  `s.interactionCapVpfiPerEth`. Reading the raw slot would make the default config
  (`0`) produce `T_d = 0` and zero out **every** finalized day's rewards. Tested with a
  default-unset snapshot case.
- **ETH price = Base's `ethNumeraireFeed` at finalize.** ETH is a global asset; using
  Base's reading as the canonical daily price for the whole protocol is consistent.
- **Broadcast:** `RewardReporterFacet.onRewardBroadcastReceived` (`:229`) gains a
  `capThreshold18` parameter; the mirror stores the **received** `T_d` at `:253` (it does
  **not** compute its own). Base's remittance budget and every mirror's claim now use the
  identical `T_d`. The idempotent-redelivery guard (`:239-248`) extends to `capThreshold18`
  (a divergent re-delivery reverts).
- **Feed unreadable / cap disabled / MALFORMED at finalize** → store sentinel
  `type(uint256).max` = "cap disabled for day d" (⇒ `min(Δ_d, T_d) = Δ_d`, that day
  uncapped). Crucially this must also cover a feed that is *readable but returns a bad
  `decimals()`* (Codex r8 L5): `10 ** feedDec` **overflows and reverts** for a large
  `feedDec` **before** the sentinel can be stored, which would brick `finalizeDay` /
  `forceFinalizeDay` entirely (`setNumeraire` only rejects a zero address). So the snapshot
  **bounds `feedDec`** (e.g. `feedDec > 36` → treat as disabled → sentinel) rather than
  letting the exponentiation revert — keeping the cap outage confined to that day. A
  **bounded, tested** fail-open, broadcast like any other `T_d` so Base and mirrors agree.

**The capped cumulative rides the EXISTING cursor — no separate cursor, no catch-up gap
(Codex r3 G2).** Because `dayCapThreshold18[d]` is written atomically with
`knownGlobalSet[d]`, it is *always present* by the time `advanceCumLenderThrough` /
`advanceCumBorrowerThrough` reach day `d` (they gate on `knownGlobalSet[d]`, `:573`). So
those loops write `cumMinRpn18[d] = cumMinRpn18[d-1] + min(Δ_d, dayCapThreshold18[d])`
in the *same* iteration that writes `cumRpn18[d]`, using the stored threshold (no live
feed read during advance). One shared cursor; the r2 "feed-gated cumMin cursor" and its
permanent-stall bug are **gone**.

The claim then stays **O(1) per entry** — `_processEntry` / `_previewEntryReward` swap
`cumRpn18` → `cumMinRpn18` and drop all claim-time cap logic (no `_capVpfiForInterestUsd`,
no ETH-price read at claim):

```
reward = (e.perDayNumeraire18 * (cumMinArr[e.endDay-1] - cumMinArr[e.startDay-1])) / 1e18
```

**Cross-chain remittance is capped with the SAME canonical threshold (Codex r3 G4 + r4 H4).**
Keeping remittance on the uncapped `cumRpn18` would ship VPFI to mirrors that per-user caps
make unclaimable, stranding surplus against the 69M pool cap (`rewardBudgetRemittedGlobal`).
The fix works because **`T_d` is entry-independent**: the capped per-chain daily budget
is `Σ_users P_u·min(Δ_d,T_d)/1e18 = min(Δ_d,T_d)·(Σ_users P_u)/1e18 =
min(Δ_d,T_d)·chainNumeraire_side/1e18` — the `min` factors straight out of the sum. So
`chainRewardBudgetForDay` (`:144`) replaces the uncapped `half·chainInterest/globalInterest`
(which equals `Δ_d·chainNumeraire/1e18`) with the capped `min(Δ_d,T_d)·chainNumeraire/1e18`
per side, using the same broadcast `dayCapThreshold18[d]`.

**The remittance must CEIL per day, or a multi-day window can underfund the mirror (Codex
r5 I1 — P1).** The claim floors **once** over the whole window
(`floor(P_u·Σ_d min(Δ_d,T_d)/1e18)`), but `chainRewardBudgetForDay` remits **per day**. If
remittance also floored per day, two days each worth `0.6 wei` would remit `0+0` while the
claim yields `floor(1.2)=1` → the mirror's `safeTransfer` reverts (bricked claim). So
remittance **ceils** each day: `budget += ceil(chainNumeraire_side · min(Δ_d,T_d) / 1e18)`.
This guarantees `Σ_d ceil(chainNumeraire·m_d/1e18) ≥ Σ_users floor(P_u·Σ_d m_d/1e18)` for
**any** window (since `Σ ceil ≥ Σ real ≥ Σ per-user real ≥ Σ per-user floor`), so the mirror
is **never underfunded**; the only residual is a bounded **over**-fund — the safe direction.
Because the ceil is applied to the lender and borrower slices **separately** (Codex r6 J5),
the ceil dust is up to `2` wei per chain per day, so the test asserts `chainBudget(window) ≥
Σ claims` and the gap is `≤ 2·(#days) + (#entries) wei`, for both single- and **multi-day**
windows.

**Scope: this guarantee holds for `chainDailyIncluded` days whose local frontier has
actually advanced through `dayId` (Codex r8 L2 + r9 M1).** Two pre-existing carve-outs, both
**unchanged** by #1008 (the uncapped pre-#1008 path had the identical gaps — remittance 0/stale,
claims still possible via `knownGlobalSet`):
1. **Excluded days.** On a grace/force-finalized day where a mirror missed its report,
   `chainRewardBudgetForDay` returns 0 (`chainDailyIncluded[day][chain] == false`) though the
   global denominator is still broadcast and local entries can claim.
2. **Included-but-not-frontier-advanced days.** `closeDay`/remittance snapshot only what
   `advance*Through(dayId)` reached, and those helpers silently cap `through` at
   `frontier + MAX_FRONTIER_ADVANCE_DAYS` (`RewardReporterFacet:135-139`,
   `LibInteractionRewards:498-499`). A mirror >730 days behind can record
   `chainDailyIncluded = true` with a **zero/stale numerator**, so the capped budget
   understates claims for that day.
#1008 does not attempt to close either pre-existing gap; the never-underfunded proof + tests
are explicitly scoped to **included days whose frontier reached `dayId`** (the test asserts /
reports the frontier ≥ `dayId` precondition before asserting `chainBudget ≥ Σ claims`).

Properties:
- **O(1) claims** — no regression, no pagination.
- **Exact** cap — `min(Δ_k, T_k)` summed as integers, one final `/1e18` floor (matches the
  uncapped telescoped floor; no per-day flooring).
- **Uncapped config** — when the cap is disabled at finalize, `dayCapThreshold18[d] = max`
  ⇒ `cumMinRpn18 == cumRpn18`, claims reproduce the uncapped telescoped total exactly.
- **Ratified semantics (Q7 + Codex r3 G6 + r7 K4):** the cap is priced — **both** ETH price
  **and** admin `interactionCapVpfiPerEth` — at each day's **finalization**, not at claim.
  Prospectivity is defined by **finalization, not activity day**: a governance cap change
  applies to every day **not yet finalized** at the moment it lands — so a change made after
  day `D`'s activity but before `finalizeDay(D)` (incl. force-finalized / grace-delayed `D`)
  **does** affect `D`; it does **not** retro-cap already-finalized days. Owner-ratified; the
  setter natspec + FunctionalSpec state exactly this (not the looser "from the day it lands").
- **Pre-live** ⇒ the new per-day mapping `dayCapThreshold18` + the two `cumMinRpn18`
  mappings are a free storage append (no migration).

**Decisions baked in:**

1. **`_processEntry` and `_previewEntryReward` stay identical** (preview parity is a
   standing invariant — a preview that over-reports vs the claim is itself a bug).
2. **No legacy-window fallback (Codex r1 F1).** `claimForUserWindow` pays from the
   pre-entry per-user daily maps the entry path never populates → would pay zero; never a
   fallback for entry-path rewards.
3. **Legacy per-day window claim** (`claimForUserWindow`, `:767`) still applies the cap at
   claim time — it is a separate, test-mutator-only path over the *old* per-user daily
   maps and is left as-is (its per-day cap is already correct); only the entry path moves
   to the finalize-baked `cumMinRpn18`.

### Blast radius / ABI — Part 1 (Option B)

**Part 1 IS an ABI change** — it changes `onRewardBroadcastReceived`'s selector (Codex r5
I3) AND the facet bytecode (Codex r3 G5). Deployment is a **full `DeployDiamond` redeploy**
(pre-live), so every facet is rebuilt against the changed library — no stale-inliner risk
(see Part-2 blast, Codex r6 J2/J3). Touched surface:
- `LibInteractionRewards`: `advanceCum*` (write `cumMinRpn18`), `_processEntry` /
  `_previewEntryReward` (read `cumMinRpn18`, drop claim-time cap), `chainRewardBudgetForDay`
  (capped remittance).
- `RewardAggregatorFacet._finalizeAndWrite`: compute + store `dayCapThreshold18[d]` (Base).
- **Cross-chain broadcast payload** gains `capThreshold18`. Adding the param to
  `RewardReporterFacet.onRewardBroadcastReceived` **changes its 4-byte selector (Codex r5
  I3)**. **AND the separate UUPS `VaipakamRewardMessenger` proxies need coordinated rollout
  work on Base AND every mirror** — a full `DeployDiamond` redeploy does NOT touch those
  proxies. Three messenger items (Codex r8 L4 + r9 M2/M3):
    - **Upgrade the implementation** so it encodes the 5-word broadcast payload + the new
      `onRewardBroadcastReceived` selector.
    - **Split the payload-size constant (M2):** the messenger shares one
      `EXPECTED_PAYLOAD_SIZE` for the mirror→Base **report** (4 words) AND the Base→mirror
      **broadcast** (now 5). Bumping the shared constant breaks reports (`PayloadSizeMismatch`);
      leaving it rejects broadcasts. Use **separate report/broadcast size constants**, with a
      regression that `sendChainReport` payloads still decode after the broadcast grows.
    - **Rebind to the new diamond (M3):** each proxy stores its own `diamond` (gates
      `onlyDiamond`, and inbound CCIP forwards to that stored address). A redeploy changes the
      diamond address, so the checklist must `setDiamond(newDiamond)` per chain (or
      redeploy/reinitialize the proxies) — else the new diamond can't call
      `broadcastGlobal`/`sendChainReport` and inbound reports/broadcasts go to the retired diamond.
  So Part 1 IS selector work: remove the old `onRewardBroadcastReceived` selector +
  add the new one in `DeployDiamond` / `HelperTest` / `FacetSelectors.sol` +
  `SelectorCoverageTest`, re-export the ABI, and update the Base-side send + the
  `CcipMessenger`/messenger encode-decode + the idempotent-redelivery guard **together**
  (else Base encodes a broadcast mirrors don't route). So Part 1 is **not** ABI-free after
  all — it has this one selector replace on top of the facet-bytecode replace.
- `LibVaipakam.Storage`: append `dayCapThreshold18`, `cumMinLenderRpn18`,
  `cumMinBorrowerRpn18` (pre-live, no migration; no new cursor — rides the existing one).
- Setter natspec for `interactionCapVpfiPerEth` + FunctionalSpec: state the prospective
  (finalize-time) pricing semantic (Q7/G6).

`claimInteractionRewards` / `previewInteractionRewards` signatures unchanged; the returned
value is generally **lower** where the daily cap was netting away farming, but it is **NOT
a monotonic decrease** (Codex r7 K5 + r8 L6) for two reasons: (a) the window-level floor
recovers a few wei of dust across small-cap days; and (b) — materially — the pricing point
moved from **claim time** to **finalization time**, so if a day finalizes while the cap is
disabled or loose (feed down, or a high ETH price making `T_d` loose) and governance later
**tightens** the cap before the user claims, the finalize-baked result can be **materially
higher** than the old claim-time-cap result (not dust). Downstream checks must not assume
`new ≤ old`; the release notes + FunctionalSpec call out the finalize-loose-then-tighten
scenario explicitly. (This is the ratified finalize-time semantic, not a regression.)

### Test plan — Part 1 (`InteractionRewardsFacet` reward-cap suite; Option B)

1. **Netting is closed** — an entry with one over-cap day and several under-cap days pays
   `(P/1e18)·Σ min(Δ_d, T)`, strictly less than the old `min(Σ raw, Σ cap)`. Seed per-day
   globals so `Δ_d` varies (high-share quiet day + normal days); assert the exact total
   and that it is `<` the old window-cap total.
2. **All days under cap** — `cumMinRpn18 == cumRpn18` over the window → result equals the
   uncapped telescoped total exactly.
3. **All days over cap** — every `min(Δ_d,T)=T` → result equals `(P/1e18)·(T·daysInWindow)`,
   within `[−⌈P/1e18⌉·daysInWindow, +daysInWindow]` wei of a strict per-day-floored
   `perDayCap·daysInWindow` (integer-`T` down scaled by `⌈P/1e18⌉` + window-floor up scaled
   by days — Codex r5 I5 / r6 J6 / r7 K3 / r8 L1); assert the asymmetric two-sided bound.
4. **Cap disabled at finalization** (`ethPriceRaw == 0` or `capRatio == max`) —
   `dayCapThreshold18[d] == max` ⇒ `cumMinRpn18` tracks `cumRpn18` → uncapped total exactly.
5. **Feed-outage at finalize is a bounded, tested fail-open** — feed down for day `d` at
   finalize ⇒ `dayCapThreshold18[d] == max` (that day uncapped); adjacent finalized days
   with a live feed stay capped. Assert the fail-open is confined to the outage day only.
6. **Finalize-time pricing (Q7/G6)** — a day finalized at ETH price `p1` + cap-ratio `r1`
   caps at `T(p1,r1)` even if the claim (or a governance cap change) happens later at
   `p2`/`r2`; assert the stored `dayCapThreshold18[d]` is used, not the claim-time value.
7. **Capped remittance CEILs per side, covers multi-day (G4 + r4 H4 + r5 I1 + r6 J5 + r8
   L7)** — `chainRewardBudgetForDay` sums **`ceil(min(Δ_d,T_d)·chainNumeraire_side/1e18)` per
   side per day**. On a **heavily-capped** day it is materially below the uncapped budget,
   but because capped **ceils** while uncapped **floors**, do **not** assert strict `<` — a
   tiny capped share can ceil to 1 while the uncapped floors to 0/1 (Codex r8 L7); assert
   `capped ≤ ceil(uncapped)`. Over a **multi-day, included** window (incl. tiny fractional
   days that per-day floor to 0 but sum to ≥1), assert `chainBudget ≥ Σ per-user cumMin
   claims` (never underfunded → no bricked claim) and `chainBudget − Σ claims ≤ 2·(#days) +
   (#entries) wei` (per-side ceil + per-entry floor dust).
8. **Canonical broadcast threshold (r4 H1)** — set Base's ETH feed / cap-ratio to differ
   from a mirror's, finalize + broadcast; assert the mirror claims with **Base's** broadcast
   `T_d` (not its local feed), so the mirror's `Σ claims` matches Base's remitted budget.
8b. **Divergent-threshold replay reverts (Codex r7 K6)** — a duplicate broadcast delivery
   for an already-finalized day with the **same** global denominators but a **different**
   `capThreshold18` must revert (like the divergent-denominator replay guard), not silently
   accept a changed cap; an identical re-delivery is idempotent (no-op).
9. **Default-unset cap ratio (r4 H5)** — with `interactionCapVpfiPerEth == 0` (default),
   the snapshot uses the effective `500` (not `0`), so rewards are capped at the default
   ratio, **not zeroed**.
10. **Preview == claim, with the cursor advanced (Codex r8 L3)** — `previewInteractionRewards`
    equals the subsequently-claimed amount for cases 1–9 **once the cum cursor has reached
    `endDay−1`**. Preview is a `view` and cannot advance the cursor, so on a freshly-broadcast
    day where the cursor is still behind, preview returns 0 while a claim advances-then-pays
    (pre-existing `_previewEntryReward` behavior — it under-reports, never over-reports, so
    it's not an over-payment risk). The parity test **pre-advances** the cursor (e.g. via a
    prior claim/advance) before asserting equality; the spec documents this as
    "preview ≤ claim; equal once finalized-and-advanced".
11. **Single-day window** — `endDay − startDay == 1` reduces to `(P/1e18)·min(Δ_0, T)`.

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
- **Near-uniform** — the invariant holds for every close path **where the position NFT
  still exists at close** (repay / HF-liquidation / preclose / offset / the 3 new terminals),
  closing the pre-existing stale-user gap those shared. The **one exception** is a path that
  burns the NFT *before* `closeLoan` — `ClaimFacet`'s fallback/default branch — which gets a
  targeted pre-burn re-anchor instead (Codex r4 H2, below). Flagged as a deliberate,
  correct behavior alignment.
- **Idempotent + safe** — `repointRewardEntry` no-ops when the entry is already on the
  live holder (so callers that already consolidated, e.g. `precloseDirect`'s
  `eagerConsolidateBothSides`, double-repoint harmlessly). The `closed` guard (F8) means
  a re-close (e.g. the LenderIntent roll) never moves a frozen entry.
- **Bounded — `repointRewardEntry` must be made O(1) first (Codex r3 G3).** As written,
  `repointRewardEntry` → `_removeUserEntry` **linearly scans** `userRewardEntryIds[oldUser]`
  (`:457-474`). Centralizing re-anchor into every `closeLoan` would put that unbounded
  per-user scan on the fund-critical close path — a prolific original holder could make a
  transferred loan's close run out of gas (a DoS). **Prerequisite fix:** give the removal
  O(1) cost by tracking each entry's position in its user's array —
  `mapping(uint256 id => uint256 idxPlus1) rewardEntryUserIdx` (1-based; 0 = absent). It
  must be written at **every** membership mutation (Codex r4 H3): on `_allocEntry`'s push,
  on `_removeUserEntry`'s swap-pop (rewriting the moved tail entry's index), **and on
  `repointRewardEntry`'s own `userRewardEntryIds[newUser].push(id)`** — else a *second*
  passive transfer can fail to remove `id` from the intermediate holder, leaving duplicate
  membership, and because `claimForUserEntries` iterates arrays without re-checking
  `e.user`, a stale holder could process/preview someone else's entry. Tested with
  **successive** repoints (A→B→C) asserting single, correct membership at each step. This
  also speeds the existing consolidation repoint. (Pre-live ⇒ the index mapping is a free
  append.)
- **`ClaimFacet` burn-before-close branches need a pre-burn re-anchor to the RESOLVED
  HOLDER (Codex r4 H2 + r5 I4).** The `closeLoan` centralization only covers paths where
  the position NFT still exists at close. `ClaimFacet` has burn-before-`closeLoan`
  branches where the `ownerOf` re-anchor would catch the burn and skip. Each gets a
  **pre-burn repoint** — but to the **resolved lender-NFT owner / cash recipient**
  (`nftOwner = ownerOf(loan.lenderTokenId)`, snapshotted before the burn), **NOT
  `msg.sender`**: the backstop absorb (`claimAsLenderViaBackstop`, `:660-698`) is
  `onlyRole(KEEPER_ROLE)`, so `msg.sender` is the *keeper* while the cash is paid to the
  resolved `nftOwner` (`:627`) — repointing to `msg.sender` would hand the lender reward to
  the keeper. Snapshot `nftOwner` before the burn and repoint the lender entry to it.
  Enumerate + test every ClaimFacet terminalize+burn branch (grep audit at implementation):
  the backstop absorb (`:660-698`, already `closeLoan`s but after the burn) and the
  fallback-resolution force (I2, below).
- **`ClaimFacet` FallbackPending→Defaulted lender-claim resolution has NO reward close
  (Codex r5 I2).** `_claimAsLenderImpl` forces `FallbackPending → Defaulted` at `:868-882`
  when no internal match fired, with **no `LibInteractionRewards.closeLoan`** — so those
  defaulted loans over-accrue to the original `endDay` and misattribute to the stale
  `RewardEntry.user`. Add a **default-forfeit close** `closeLoan(loanId, false, false)` on
  that branch, placed with the same pre-burn re-anchor-to-`nftOwner` ordering as the
  backstop branch.
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

**Count:** 5 terminal transitions across 3 wired facets via new hooks (RiskMatch ×3
branches = one logical close per loan; PrepayListing ×2; RepayPeriodic ×1). LenderIntent is
**omitted** (already closed at the prior repay). `ConsolidationFacet` is **not** terminal —
it's the repoint helper (below). **Plus `ClaimFacet`** (Codex r5 I2): its
`FallbackPending → Defaulted` lender-claim-resolution branch (`:868-882`) gains a
default-forfeit `closeLoan(id,false,false)` it currently lacks, and both that branch and the
existing backstop-absorb branch (`:660-698`) get the pre-burn re-anchor-to-`nftOwner`
treatment (re-anchor section, I4) — these are direct `closeLoan` sites, not new hooks.

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
  obligor): the reward-earning going-forward party is the obligor who pays interest, and
  `migrateBorrowerPosition` (`:1033`) re-mints the borrower NFT to `l.borrower` **right
  after** this hook — so post-tx `l.borrower` holds the borrower NFT and there is **no
  lasting NFT/obligor divergence** (Codex r2 F7 / r3 G7). *(The broader "should the
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
  ones), aligning their reward attribution to the live NFT holder. Behavior-affecting but
  strictly a correctness alignment (funds already go to the live holder).
- **`repointRewardEntry` made O(1) (Codex r3 G3 + r4 H3):** append `rewardEntryUserIdx`
  mapping to `LibVaipakam.Storage` (pre-live, free) so `_removeUserEntry` is O(1), removing
  the close-path DoS. Maintained at **every** membership write: `_allocEntry` push,
  `_removeUserEntry` swap-pop, **and** `repointRewardEntry`'s `newUser` push.
- **Deploy is a FULL `DeployDiamond` redeploy — no stale-inliner risk (Codex r5 I6 + r6
  J2/J3).** `closeLoan`, `_allocEntry`, and `repointRewardEntry` are `internal` library
  functions inlined into a **wide** set of facets — `closeLoan` alone into 11+
  (`RepayFacet`, `DefaultedFacet`, `RiskFacet`, `RiskSplitLiquidationFacet`,
  `SwapToRepayFacet`, `AutoLifecycleFacet`, `RefinanceFacet`, `ClaimFacet`,
  `InteractionRewardsFacet`, + via `LibSwapToRepayIntentSettlement`), and
  `repointRewardEntry` reached by every host inlining `LibConsolidation.consolidateToHolder`
  (`AddCollateralFacet`, `RepayFacet`, `SwapToRepayFacet`, `DefaultedFacet`,
  `PartialWithdrawalFacet`, `SwapToRepayIntentFacet`, `EarlyWithdrawalFacet`, …). A
  hand-maintained cut-replace list is therefore fragile: **any** omitted facet keeps the
  old inlined body (no re-anchor / no `rewardEntryUserIdx`), reviving the stale-holder bug.
  **Because the platform is pre-live** ([[project_platform_prelive]]), deployment is a full
  `DeployDiamond` redeploy of *every* facet against the changed library — so there is no
  stale-inliner risk at all; no incremental cut set to enumerate. *(Were this ever a LIVE
  incremental upgrade, the correct guard would be a deploy-sanity assertion that
  mechanically enumerates every facet inlining `closeLoan` / `_allocEntry` /
  `repointRewardEntry` — directly or transitively via `LibConsolidation` /
  `LibSwapToRepayIntentSettlement` — and asserts all are in the replace set. Not needed on
  the pre-live full-redeploy path.)*
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
9. **Burn-before-close pre-burn re-anchor (Codex r4 H2).** Drive `ClaimFacet`'s
   ordinary fallback/default branch (which burns the lender NFT before `closeLoan`) after a
   passive lender-NFT transfer; assert the reward entry was repointed to the resolved holder
   **before** the burn, so the reward and the principal claim both land on the live holder.
9b. **Backstop absorb repoints to `nftOwner`, not the keeper (Codex r6 J4).** Drive
   `claimAsLenderViaBackstop` (a **keeper**-role caller) after a passive lender-NFT transfer;
   assert the lender reward entry is repointed to the resolved `nftOwner` (the cash
   recipient), **not** `msg.sender` (the keeper) — this case would pass a naive
   repoint-to-`msg.sender` regression that test 9 alone would not catch.
10. **Successive repoints keep O(1) index consistent (Codex r4 H3).** Passive-transfer a
    position A→B→C with a re-anchor at each; assert `userRewardEntryIds` membership is
    exactly `{C}` (no duplicate, no stale B/A membership) and no other user can
    preview/claim the entry.

---

## Sequencing & process

1. **Part 1 (#1008) and Part 2 (#1067) ship as SEPARATE PRs** — but **neither is
   ABI-free** (Codex r6 J1): Part 1 (Option B) changes the `onRewardBroadcastReceived`
   **selector** (adds `capThreshold18`) + the messenger encode/decode + `RewardRemittanceFacet`
   + finalize snapshot + `cumMinRpn18` storage; Part 2 adds the `liquidationRewardClose` /
   `terminalRewardClose` selectors + the `closeLoan` re-anchor + O(1) index. Each is a full
   `DeployDiamond` redeploy (pre-live). Landing #1008 first de-risks the cap accounting +
   the broadcast-shape change before the close-out lands on top. (Q6 for Codex: separate vs
   one — leaning separate; the Part-1 broadcast selector change must ship Base↔mirror atomically.)
2. Each PR: targeted `--match-path` tests + deploy-sanity suite (**both** parts touch
   selectors — Part 1 replaces `onRewardBroadcastReceived`, Part 2 adds
   `liquidationRewardClose` / `terminalRewardClose` — so `SelectorCoverageTest` +
   `FacetSelectors.sol` + ABI re-export are in **both**; Codex r7 K2) + release-note fragment
   + FunctionalSpec update in the same diff.
3. High-risk (fund-adjacent forfeit logic) → independent adversarial self-review before
   Codex round 1; then the Codex convergence loop to merge.

## Resolved after Codex rounds 1–9

**Round 9 — cross-chain deploy/payload mechanics + proof scope (3×P2, no P1 — the design is
converged; these are rollout-mechanics details flagged for the implementation PR):**
- **M1** — the never-underfunded proof is scoped to included days whose **local frontier
  reached `dayId`** (a >730-day-behind mirror can mark a day included with a stale numerator);
  the frontier precondition is asserted/reported before the funding assertion.
- **M2** — the `VaipakamRewardMessenger` must use **separate report vs broadcast payload-size
  constants** (report stays 4 words, broadcast grows to 5), with a report-still-decodes regression.
- **M3** — the rollout must **rebind each messenger proxy to the new diamond**
  (`setDiamond` / reinit) since a full redeploy changes the diamond address the proxies store.

## Resolved after Codex rounds 1–8

**Round 8 — scope qualifications, deploy completeness, fail-open edge (7×P2, no P1):**
- **L1** — window-floor dust up-side scales with `#capped days` (not `+1`).
- **L2** — the never-underfunded remittance proof is scoped to `chainDailyIncluded` days;
  the excluded-day (missed-report) gap is pre-existing and unchanged by #1008.
- **L3** — preview-parity holds only once the cursor reaches `endDay−1` (preview is a view,
  under-reports never over-reports); tests pre-advance the cursor.
- **L4** — the separate UUPS `VaipakamRewardMessenger` proxies must be upgraded on Base +
  mirrors (a diamond redeploy doesn't touch them); added to the rollout checklist.
- **L5** — the finalize snapshot bounds `feedDec` so a malformed `decimals()` yields the
  disabled sentinel instead of an overflow that bricks `finalizeDay`.
- **L6** — the blast note describes the *material* (not just dust) increase possible when a
  day finalizes cap-loose and governance later tightens (the ratified finalize-time semantic).
- **L7** — capped-ceil vs uncapped-floor is not strictly `<`; test 7 asserts
  `capped ≤ ceil(uncapped)`.

## Resolved after Codex rounds 1–7

**Round 7 — doc-internal consistency + bound precision (all refinements, no P1, no approach
change):** K1 test 7 now asserts the per-side ceil + multi-day bound; K2 sequencing lists
selector work in **both** parts; K3 the T-floor dust bound scales by `⌈P/1e18⌉`; K4
prospectivity is defined by *finalization* (days not yet finalized), not activity day; K5
the blast note no longer promises `new ≤ old` (window-floor can recover dust); K6 adds a
divergent-`capThreshold18` replay-revert test.

## Resolved after Codex rounds 1–6

**Round 6 — cut-set completeness, test specificity, dust bounds (all refinements, no new
approach flaws — the design has converged at the approach level):**
- **J3 (P1) + J2 (P2 — cut-set)** — a hand-list of facets to replace is fragile (`closeLoan`
  inlines into 11+ facets; `LibConsolidation`→`repointRewardEntry` into ~7 more). Resolved
  by the **pre-live full `DeployDiamond` redeploy** framing: every facet is rebuilt against
  the changed library, so no stale-inliner can survive; no incremental cut set to enumerate.
- **J1 (sequencing)** — the sequencing note now states Part 1 is NOT ABI-free (broadcast
  selector + messenger).
- **J4 (backstop test)** — added a keeper-caller backstop-absorb test asserting repoint to
  `nftOwner`, distinct from the ordinary-claimant burn-before-close test.
- **J5 (P3 — per-side ceil dust)** — remittance dust bound widened to `≤ 2·(#days) + (#entries)`
  (lender + borrower slices ceil separately).
- **J6 (P3 — T rounding direction)** — the integer-`T` vs strict-per-day-floor difference is
  two-directional; tests assert a `±` bound, not one-sided.

## Resolved after Codex rounds 1–5

**Round 5 — remittance dust, ClaimFacet branches, deploy set:**
- **I1 (P1 — cross-day underfund)** — remittance **ceils** per day
  (`ceil(chainNumeraire·min(Δ_d,T_d)/1e18)`) so `Σ ceil ≥` the once-floored claim over any
  multi-day window; the mirror is never underfunded (bounded over-fund instead).
- **I4 (P1 — backstop repoint target)** — the pre-burn re-anchor targets the resolved
  `nftOwner` (cash recipient), **not** `msg.sender` (the keeper on `claimAsLenderViaBackstop`).
- **I2 (ClaimFacet fallback close)** — the `FallbackPending→Defaulted` lender-claim
  resolution (`:868-882`) gains a default-forfeit `closeLoan` + pre-burn re-anchor.
- **I3 (broadcast selector)** — adding `capThreshold18` changes `onRewardBroadcastReceived`'s
  selector; Part 1 does the selector replace + ABI + messenger encode/decode together.
- **I6 (deploy set)** — every facet inlining `_allocEntry`/`repointRewardEntry`
  (`LoanFacet`, `EarlyWithdrawalFacet`, `ConsolidationFacet`, reward facets) is in the
  cut-replace set, with a deploy-sanity assertion.
- **I5 (P3 — integer-`T` precision)** — accepted the bounded ≤`⌈P/1e18⌉`-wei-per-capped-day
  under-payment vs the direct cap formula; tests assert bounded-under, not exact.

## Resolved after Codex rounds 1–4

**Round 4 — cross-chain + call-site ordering hardening:**
- **H1 (P1 — canonical threshold)** — `T_d` is computed **once on Base** at finalize and
  **broadcast** to mirrors (`onRewardBroadcastReceived` gains `capThreshold18`); mirrors
  use the received value, never a local snapshot, so per-chain claims and Base's remitted
  budget use one identical threshold.
- **H5 (effective cap ratio)** — the snapshot uses `getInteractionCapVpfiPerEth()` (stored
  `0` → `500` default), NOT the raw slot; a raw read would zero all rewards under default.
- **H2 (burn-before-close)** — `ClaimFacet`'s fallback/default branch burns the lender NFT
  before `closeLoan`, so it gets a targeted pre-burn repoint to the verified claimant; the
  centralized `closeLoan` re-anchor covers all other paths.
- **H3 (index on repoint push)** — `rewardEntryUserIdx` is maintained at `repointRewardEntry`'s
  push too (not just alloc/remove); successive repoints tested.
- **H4 (P3 — flooring dust)** — remittance-vs-claims relaxed from "exact" to a bounded
  ≤1-wei/entry over-fund (the safe direction).

## Resolved after Codex rounds 1–3

**Round 3 — Option B hardened + owner-ratified (2026-07-11):**
- **G1 (pricing point)** — `dayCapThreshold18[d]` is snapshotted at the finalize choke
  points (`_finalizeAndWrite:353` + `RewardReporterFacet:253`), not lazily at first claim.
- **G2 (stalled cursor)** — dissolved: the threshold is pre-stored at finalize, so cumMin
  rides the existing cursor with no separate cursor / catch-up gap.
- **G4 (mirror over-remit)** — capped remittance is **exact** because `T` is
  entry-independent: `chainRewardBudgetForDay` uses `min(Δ_d,T_d)·chainNumeraire/1e18`.
- **G6 (cap-ratio timing)** — the admin cap-ratio is snapshotted at finalize too; the
  cap change is prospective. **Owner ratified** the full finalize-time pricing semantic.
- **G3 (re-anchor DoS)** — `repointRewardEntry` made O(1) via a `rewardEntryUserIdx` index
  before centralizing re-anchor into `closeLoan`.
- **G5 (facet replace)** — Part 1 requires a diamond-cut REPLACE + redeploy of every facet
  inlining the changed lib (not just "no selector bump").
- **G7 (borrower-NFT contradiction)** — the stale "not reassigned" clause removed.

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

- **Q7 — RESOLVED (owner-ratified 2026-07-11):** Option B with finalization-time pricing
  (ETH price + cap-ratio snapshotted at day-finalize; cap changes are prospective).
- **Q3 (#1067 hook naming):** keep `precloseRewardClose` distinct vs unify with
  `terminalRewardClose`? (Leaning: keep distinct.)
- **Q6 (sequencing):** two PRs (proposed) or one? (Leaning: two.)
