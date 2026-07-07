# Spec-Conformance Tranche 5 — Deferred Trio Design

**Status:** Draft for review (design-doc-first per user directive 2026-07-07).
**Scope:** the three #998 findings deferred out of the straight-to-code
Tranche-5A attempt (PR #1089, closed unmerged) because each revealed hidden
scope a formula/one-line patch could not carry:

| # | Finding | Issue |
| --- | --- | --- |
| S8 | NFT-rental late fee is computed on the daily fee, not the overdue rental amount | #1004 |
| S10 | Sanctioned-proceeds release must fail-closed on oracle revert (normal claims stay fail-open) | #1006 |
| S15 | Offer-mutate floor/ceiling not enforced; create-time check gated on the now-dead `rangeAmountEnabled` | #900 |

This doc **refines the already-ratified guidance** in
[`SpecConformanceCodeFixPlan.md`](SpecConformanceCodeFixPlan.md) §6 (lines
300–335, merged PR #1052, 2 Codex rounds) into an implementable spec, anchored
to freshly-scouted current `main` code (HEAD `cf91c125`). It is itself gated on
**two Codex review rounds before any Solidity is written**, then each item ships
as its own PR.

The three items are **independent** (rental accounting, sanctions state model,
offer validation) and share no code surface, so they can implement in any order
/ in parallel PRs. They are grouped here only because they are the same
"deferred Tranche-5" set.

---

## S8 (#1004) — NFT-rental late fee base

### Finding

The late fee for an overdue NFT rental is a percentage of **one day's fee**, not
of the **rent still owed**. A renter who is 40 days late on a 0.1-ETH/day rental
pays the same late fee as one who is 1 day late on the same rental — the penalty
does not scale with the size of the overdue obligation.

### Current behavior (anchored)

`LibVaipakam.calculateLateFee(loanId, endTime)` is a **single shared helper** for
every loan type (`LibVaipakam.sol:6065-6079`):

```solidity
uint256 daysLate = (block.timestamp - endTime) / 1 days;
uint256 feePercent = 100 + (daysLate * 50); // 1% + 0.5%/day, in BPS
if (feePercent > 500) feePercent = 500;      // cap 5%
return (loan.principal * feePercent) / 10000;
```

For a rental, `loan.principal` is the **per-day fee** (`LibVaipakam.sol:1773`,
`// Lent amount or rental value`; used as `dayFee` at `RepayPeriodicFacet.sol:160`).
So the late fee is `dailyFee × feePercent/10000` — capped at 5% of **one day**.
It is added to `interest` in the rental branch (`RepayFacet.sol:446`,
`totalDue = interest + lateFee`), where `interest` is the actual overdue rent
(`loan.principal × durationDays` full-term, or `loan.principal × undeductedDays`
elapsed — `RepayFacet.sol:436/443`).

For an **ERC-20** loan `loan.principal` is the whole principal, so the shared
helper is already correct there — only the rental base is wrong.

### Root cause

The base `loan.principal` carries **dual semantics** (whole principal for ERC-20;
per-day fee for rentals) and the shared helper was written for the ERC-20
meaning.

### The counter-divergence sub-bug — NOW IN SCOPE (Codex r1)

`RepayFacet.sol:431` derives `alreadyDeductedDays = (lastDeductTime − startTime)/
ONE_DAY`, but `repayPartial` decrements `durationDays` **without advancing
`lastDeductTime`** (`RepayFacet.sol:924-927`), while `autoDeductDaily` advances
both (`RepayPeriodicFacet.sol:215-219`). So after a partial repay,
`undeductedDays = elapsedDays − alreadyDeductedDays` **over-counts** the still-owed
days — a pre-existing bug in the *elapsed-interest* path.

The draft side-stepped this by basing the late fee on `durationDays`. **Codex r1
(P2) correctly refuted that:** a fee based on `durationDays` stops tracking the
*same debt the rental branch charges as overdue rent* — after auto-deduct/partial
paths move the remaining-term counter away from elapsed-unpaid days, the fee
under/over-penalizes relative to the real late obligation. The spec (#1004) is
explicit that the fee must scale with the **overdue rental amount**. So the
correct design **bases the fee on the overdue rent AND fixes the counter
divergence** so that quantity is reliable. The divergence fix is therefore folded
into S8, not deferred.

### Design — fee base = overdue rent; fix the days-paid counter

**(1) Fix the counter divergence.** Make `repayPartial`'s rental branch advance
`lastDeductTime` by `partialAmount × ONE_DAY` alongside the existing
`durationDays -= partialAmount` (`RepayFacet.sol:924-927`), mirroring
`autoDeductDaily`. Then `alreadyDeductedDays = (lastDeductTime − startTime)/
ONE_DAY` counts **all** paid days (auto + partial), and `undeductedDays =
elapsedDays − alreadyDeductedDays` is the true count of still-owed elapsed days.

*Semantic assumption to confirm (Codex r2):* a rental `repayPartial` **pre-pays /
settles `partialAmount` days**, so advancing the deduct clock forward is correct —
it pushes the next `autoDeductDaily` out by exactly the pre-paid days (auto-deduct
gates on `block.timestamp − lastDeductTime >= ONE_DAY`, so a forward clock simply
waits until real time catches up). This composes coherently with `autoDeductDaily`
and does not double-charge. If instead `repayPartial` is meant to *retire term
without pre-paying calendar time*, we would need a dedicated `rentalDaysPaid`
counter rather than reusing `lastDeductTime` — flagged as the one open semantic
question for r2.

**(2) Base the late fee on overdue rent.** Add
`LibVaipakam.calculateRentalLateFee(loanId, endTime)`:

```solidity
// overdueDays = still-owed elapsed days (elapsed − all-paid), full-term ⇒ all remaining
uint256 overdueDays = loan.useFullTermInterest
    ? loan.durationDays                              // full-term: every remaining day is owed
    : _overdueRentalDays(loan);                      // elapsed: elapsedDays − alreadyDeductedDays
uint256 base = loan.principal * overdueDays;         // the overdue rent (matches the branch's `interest`)
return (base * feePercent) / 10000;                  // same slope; cap = 5% of overdue rent
```

The base is exactly the `interest` the rental branch already computes as the
overdue obligation (`RepayFacet.sol:436/443`), so the fee tracks the real debt.
`_overdueRentalDays` reuses the (now-correct) `undeductedDays` computation.

Only the **NFT-rental branch** of `RepayFacet.repayLoan` switches to the new
helper; the ERC-20 branch and every other `calculateLateFee` caller
(`DefaultedFacet`, `RiskFacet`, `SwapToRepay*`, `AutoLifecycleFacet`,
`RiskSplitLiquidationFacet`, `LibSwapToRepayIntentSettlement`) stay on the
existing helper unchanged — they are ERC-20/collateral paths where
`loan.principal` is already the correct base.

**(3) The quote path too (Codex r1 P2).** `RepayFacet`'s public quote/preview
(`repaymentAmount` / `calculateRepaymentAmount`, the `calculateLateFee` caller at
`RepayFacet.sol:1032`) must switch to `calculateRentalLateFee` on the rental
branch as well, or a late-rental repayment preview would quote a lower fee than
settlement charges. Both the execution and the quote path move together.

**Why a new helper, not a branch inside `calculateLateFee`:** the shared helper
has ~10 callers; widening its contract to "sometimes multiply by overdue days"
risks a wrong base on a collateral-liquidation path. A named rental helper keeps
the rental semantics local to the two rental callers (execute + quote) and is
self-documenting.

### Edge cases

- `block.timestamp <= endTime` → fee 0 (unchanged guard, first line of helper).
- `overdueDays == 0` (nothing elapsed-unpaid, e.g. auto-deduct kept pace) → fee 0.
- `useFullTermInterest`: every remaining day is owed on a late full-term rental →
  base `principal × durationDays`. Elapsed model: base `principal × overdueDays`.
  Each branch's cap now matches that branch's charged debt.
- `repayPartial`-then-late: with the counter fix, `alreadyDeductedDays` includes
  the partial-paid days, so `overdueDays` excludes them (no over-penalty).
- EIP-170: `RepayFacet` is a god-facet near the ceiling. The helper lives in
  `LibVaipakam` (inlined into callers). Verify `RepayFacet` stays under 24,576
  after the change (measure; if tight, dedupe the shared `feePercent` slope into a
  private `_lateFeePercent(endTime)` both helpers call, and share
  `_overdueRentalDays` with the existing branch computation).

### Test plan (`RepayFacetTest.t.sol`)

- Late rental fee scales with the overdue amount (more overdue days ⇒ higher fee).
- Cap binds at **5% of the overdue rent** (very-late rental).
- ERC-20 late fee unchanged (regression).
- **Counter-fix regression:** a rental with a `repayPartial` then going late
  computes `overdueDays` excluding the partial-paid days, and a subsequent
  `autoDeductDaily` waits the pre-paid days before deducting again (the clock
  advanced) — proving the fix composes.
- Quote/preview (`repaymentAmount`) equals settlement for a late rental (no
  quote/settle divergence).

### Blast radius / ABI

New internal library function + a `lastDeductTime` write in `repayPartial`; no
facet selector, no struct-shape change → **no ABI re-export, no diamond cut**.
Facets touched: `RepayFacet` (execute + quote + repayPartial) + `LibVaipakam`.
The `repayPartial` clock write is a fund-adjacent behavior change — exercised by
the counter-fix regression above and the existing `repayPartial` suite.

---

## S10 (#1006) — fail-closed release of sanctioned-locked proceeds

### Finding

When a permissionless close-out parks a **confirmed-flagged** party's proceeds in
that party's own vault (the "frozen, not seized" model, #821), those proceeds are
later released through the normal claim path
(`ClaimFacet.claimAsLender`/`claimAsBorrower`). That release screen routes through
the **fail-open** `isSanctionedAddress`, so during a sanctions-oracle **outage**
a still-sanctioned party can withdraw their locked proceeds — the freeze silently
lifts on infra failure. Normal (never-flagged) claims must **stay** fail-open (an
oracle blip must not brick honest users), so the fix must target only the locked
funds.

### Current behavior (anchored)

- `isSanctionedAddress` (`LibVaipakam.sol:6969-6996`) fails **open** twice:
  oracle unset (`address(0)`) → `return false`; oracle call reverts → `catch {
  return false; }`. Doc-comment (`:6901-6908`) states this is intentional
  (avoid bricking the chain on a Chainalysis outage).
- The release gate is the Tier-1 screen at the top of each claim:
  `_assertNotSanctioned(msg.sender)` at `ClaimFacet.sol:663` (lender) and `:1068`
  (borrower) — a single fail-open call ahead of payout.
- The lock is **event-only**: `LibSanctionedLock` parks funds and emits
  `SanctionedProceedsLocked` (`LibSanctionedLock.sol:55-60`) *if*
  `isSanctionedAddress(owner)` returns true at park time (`:132/:165/:198`).
  **There is no storage marker** distinguishing a locked deposit from an ordinary
  claim at release time.
- A fail-closed pattern already exists to mirror:
  `VaultFactoryFacet.recoverStuckERC20` (`:753-760`) — `oracle == address(0)` ⇒
  `revert SanctionsOracleUnavailable()`; oracle reverts ⇒ same. **Reuse this
  existing error.**

### Root cause

Two things are missing: (1) a persisted marker that a given claim's proceeds were
locked because the recipient was **affirmatively** flagged, and (2) a fail-closed
screen applied **only** when that marker is set.

### Design — persisted `lockedProceeds` marker + targeted fail-closed screen

**(1) The marker.** Add a per-(loan, side) boolean recording "these proceeds were
parked due to a confirmed sanctions flag." Two placement options:

- **Option A — on the claim record.** Add `bool sanctionsLocked` to `ClaimInfo`
  (the `lenderClaims`/`borrowerClaims` value struct). Set at park time; read at
  release. *Con:* changes a struct that is ABI-exposed via claim view functions →
  ABI re-export + a struct-shape change on read paths.
- **Option B — a dedicated mapping** *(recommended)*:
  `mapping(uint256 => uint8) sanctionsLockedProceeds;` in Storage, keyed by
  `loanId`, with bit 0 = lender-side locked, bit 1 = borrower-side locked (a
  single loan can lock both sides in a two-sided close-out). *Pro:* no existing
  struct changes, no claim-view ABI churn; the marker is a self-contained new
  storage slot. *Con:* one new mapping.

Recommend **Option B** — it isolates the new state, avoids touching the
ABI-exposed `ClaimInfo`, and the two-sided bitfield handles the lender+borrower
lock case cleanly.

**Set the marker — key it to the FROZEN CLAIMANT, not the credited vault owner
(Codex r1 P1).** The naive placement (set where `LibSanctionedLock` sees the
deposited-into vault `owner` flagged, `LibSanctionedLock.sol:132/165/198`) is
**wrong for transferred positions.** When a close-out would pay a *sanctioned
current holder*, the funds are intentionally parked in the **stored** party's
vault (e.g. borrower surplus deposited into `loan.borrower` when the current
holder is flagged). If `loan.borrower` (the credited vault owner) is *clean*, an
`isSanctionedAddress(owner)`-driven marker never fires — yet the economic claimant
(the sanctioned current NFT holder) is exactly who must be frozen. An oracle
outage would then route that holder through the ordinary fail-open screen. So the
marker MUST be driven by **the flagged status of the party whose claim is being
frozen** — the intended economic recipient (the current position-NFT holder at
close-out), regardless of which vault physically holds the parked funds.

Concretely: at each close-out park site, evaluate `isSanctionedAddress(intended
Recipient)` where `intendedRecipient` is the current holder the payout is *for*
(the party that would otherwise have received it), and set the loanId+side bit
when that is true. This is the same party the existing "deposit to stored party
when current holder is flagged" fallback already keys on — the marker piggybacks
on that decision rather than on the credited-vault owner. Pass the side
(lender/borrower) so the correct bit is set.

Because the set is **conditioned on an affirmative flag**, a park during an oracle
outage (predicate fails open → false) does **not** set the marker — those funds
are treated as ordinary (correct: we never confirmed the party was sanctioned, and
the close-out itself is Tier-2 permissionless). A party flagged *after* a clean
park is caught by the ordinary fail-open screen at claim time (which reverts
correctly while the oracle is up); the fail-closed marker exists only to keep
*confirmed-at-park* freezes from lifting during an outage.

**(2) The fail-closed screen — a fail-closed twin of `isSanctionedAddress`, not a
bare oracle call (Codex r1 P2).** Add
`LibVaipakam.assertNotSanctionedFailClosed(who)`. It must replicate **both** legs
of `isSanctionedAddress` (`LibVaipakam.sol:6969-6996`), each failing **closed**:

1. `oracle == address(0)` ⇒ `revert SanctionsOracleUnavailable` (no fail-open
   short-circuit).
2. If `vaultBannedSource[who] != address(0)`: `isSanctioned(bannedSource)` — on
   revert ⇒ `SanctionsOracleUnavailable`; if flagged ⇒ `SanctionedAddress(who)`.
   (The recovery-ban leg: `isSanctionedAddress` treats a `who` whose declared
   recovery source is still flagged as sanctioned. A fail-closed screen that
   checked only `who`'s own EOA would let a recovery-banned owner withdraw
   confirmed-locked funds whenever their EOA reads clean — this leg closes that.)
3. `isSanctioned(who)` — on revert ⇒ `SanctionsOracleUnavailable`; if flagged ⇒
   `SanctionedAddress(who)`; clean ⇒ proceed.

I.e. it is the existing predicate with every fail-open `return false` / `catch {
return false }` replaced by a `revert SanctionsOracleUnavailable`. Reuses the
existing `SanctionsOracleUnavailable` (`VaultFactoryFacet:754`) + `SanctionedAddress`
errors.

**Wire it at the release gate only.** In `_claimAsLenderImpl` / `claimAsBorrower`,
after resolving the claim, branch on the marker:

```solidity
if (sanctionsLockedForSide(loanId, side)) {
    LibVaipakam.assertNotSanctionedFailClosed(msg.sender); // parked funds: must prove clean
} else {
    LibVaipakam._assertNotSanctioned(msg.sender);          // ordinary claim: fail-open
}
```

**Clear the marker** on a successful clean release (the fail-closed screen passed
⇒ oracle is up and returned clean ⇒ the party is de-listed), so a later re-lock
is possible and the bit doesn't leak. Clear only the side being claimed.

### Edge cases / decisions (for Codex)

- **Position NFT transferred before de-listing.** The marker is keyed by loanId +
  side, not by address. If a flagged lender's position NFT was transferred to a
  clean party, that clean `msg.sender` calls `claimAsLender`; the fail-closed
  screen checks **`msg.sender`** (the current holder), passes (clean), releases.
  Correct — we freeze the *funds' releasability* to a clean claimant, we don't
  seize. But note the funds were parked in the **stored (flagged) lender's
  vault**; the payout withdraws from that vault to `msg.sender` (existing
  behavior). Confirm the `beginMoveOut` exemption still lets that withdrawal
  proceed when the stored owner is flagged but `msg.sender` is clean. **This is
  the subtlest case — call it out explicitly in tests.**
- **Marker set but oracle now unset (operator un-set it).** Fail-closed ⇒
  `SanctionsOracleUnavailable` ⇒ release blocked. Correct: we will not release
  confirmed-locked funds without a working oracle.
- **Backstop / retry claim paths** (`_claimViaBackstopImpl`, `:381`): they screen
  both keeper and nftOwner. Decide whether the fail-closed variant also applies to
  the nftOwner screen when the marker is set (recommend: yes — same locked funds).
- **In-kind / NFT locked proceeds** (`getOrCreateVaultLocked`, no amount gate):
  the marker must cover these too (they're the illiquid-collateral lock). The
  bitfield handles it; the release path for in-kind claims must consult the same
  marker.

### Test plan (`ClaimFacetTest` / a sanctions-focused suite)

- Locked-release **reverts** `SanctionsOracleUnavailable` on oracle revert while
  a **normal** never-flagged claim on a different loan **succeeds** during the
  same outage (the load-bearing S10 assertion).
- Locked-release reverts on oracle **unset**.
- Locked party de-listed (oracle up, returns clean) → release succeeds → marker
  cleared.
- Transferred-position clean claimant releases during normal operation.
- Marker NOT set when the park happened during an oracle outage (fail-open at
  park) → that release stays fail-open (regression guard against over-freezing).

### Blast radius / ABI

New internal helper + new Storage mapping + new set/clear calls in
`LibSanctionedLock` and the two claim entry points. Reuses the existing
`SanctionsOracleUnavailable` error (already on `VaultFactoryFacet`) — **verify it
is on `ClaimFacet`'s ABI surface**; if not, adding it triggers a ClaimFacet ABI
re-export. No struct-shape change (Option B). Storage-layout: appending a new
mapping is append-only (pre-live, no migration).

---

## S15 (#900) — offer-mutate floor/ceiling enforcement

### Finding

A lender can **mutate** an offer (`setOfferAmount` to raise `amountMax`,
`setOfferCollateral` to lower collateral) into a shape that `createOffer` would
reject — the create-time floor/ceiling checks have **no counterpart on the mutate
path**. Separately, the create-time check is gated on `rangeAmountEnabled`, which
is now **dead-config**, so in the live (flag-off) config the check runs nowhere.

### Current behavior (anchored)

- `rangeAmountEnabled` is **fully dead-config.** Since #183 (Canonical Limit-Order
  Phase 2, comment at `OfferCreateFacet.sol:1545-1564`), range **shape** (amount ≠
  amountMax) is no longer gated on it — "every Phase 2 offer is canonically a
  range." The flag now gates **only** two things: the create-time floor/ceiling
  block (`OfferCreateFacet.sol:909`) and the internal-match slice floor
  (`LibOfferMatch.sol:819`). Default false ⇒ both are off in production.
- Create-time floor/ceiling (`OfferCreateFacet.sol:897-966`): lender branch
  reverts `MinCollateralBelowFloor` if `collateralAmount < minCollateralForLending
  (amountMax,…)`; borrower branch reverts `MaxLendingAboveCeiling` if `amountMax >
  maxLendingForCollateral(collMax,…)`. Conditions: `rangeAmountEnabled` **and**
  both legs ERC-20 **and** both legs Liquid.
- Sale-vehicle exemption at create: the **ceiling** check skips when
  `s.saleVehicleCreate` (a transient set only around
  `EarlyWithdrawalFacet.createLoanSaleOffer`, `OfferCreateFacet.sol:958-964`) —
  the lender-sale vehicle has `collateral == 0` (real collateral is on the linked
  live loan), so its ceiling is 0 and any amount would revert.
- Mutate path (`OfferMutateFacet.sol`): `setOfferAmount` (`:152`),
  `setOfferCollateral` (`:233`), `modifyOffer` (`:275`) run positivity / range /
  `MAX_INTEREST_BPS` / `ModifyBelowFilledFloor` checks only — **no** floor/ceiling
  at all (grep: zero hits for `minCollateralForLending`/`maxLendingForCollateral`/
  the two errors). Vault delta settles right after the storage write.
- Vehicles are already **frozen from mutation**: `_assertMutableBy` reverts
  `SaleVehicleImmutable` when `saleOfferToLoanId[offerId] != 0`
  (`OfferMutateFacet.sol:447-450`), `OffsetVehicleImmutable` for a linked offset,
  and amount/collateral mutation is frozen for a `refinanceTargetLoanId` offer.
  **So the mutate floor/ceiling check needs no sale-vehicle exemption** — those
  offers can't reach the mutate math.

### Root cause

The floor/ceiling admission check exists only at create, is gated on a dead flag,
and has no mutate twin — so mutate is an unconditional bypass and, in the live
config, create doesn't enforce it either.

### Design decision — activate, don't just parity

Per the ratified plan (§6, lines 321–332): **do NOT gate on `rangeAmountEnabled`**
(mirroring the dead flag on mutate would leave an off-flag deployment able to
create AND mutate out-of-bounds shapes — the card stays open). **Apply the bounds
at both create and mutate**, extracting the create-time block into **one shared
internal** so the two paths share a single definition.

**Options considered:**

- **Option 1 — activate, un-gated, keyed on liquid-both-legs ERC-20**
  *(recommended).* Floor/ceiling runs at create AND mutate for every
  liquid-both-legs ERC-20 offer. Closes the finding for the live config. Cost: a
  create-time behavior change (fail-fast admission) + the create-time test
  reconciliation.
- **Option 2 — parity, keep the flag on both.** Add a mutate check gated on the
  same dead flag. No behavior change, but the finding stays *inert-open* in
  production (neither path enforces while the flag is off). Rejected by the plan.
- **Option 3 — un-gate mutate only, leave create gated.** Incoherent asymmetry
  (an offer creatable but not mutatable). Rejected.

**Chosen: Option 1, keyed on `liquid-both-legs ERC-20` — NOT on range-shape
(Codex r1 P2).** The draft scoped the check to range-shape offers
(`amount != amountMax`). Codex refuted that: it is both **unnecessary** (the
existing create-time block already applies to all liquid-both-legs ERC-20 offers,
single-value included — there is no range-shape sub-condition today, per the
scout) and **unsound** — lender-**intent** slices materialize as `amount ==
amountMax == fillAmount` (single-value) yet their `reqColl` can sit below
`minCollateralForLending`. A range-shape key would skip the floor for exactly
those slices, re-opening the very bypass we're closing. So the predicate is
**liquid-both-legs ERC-20**, applied uniformly at create, mutate, AND the
internal-match slice — every liquid-both-legs shape (single-value or range) is
bounded.

**Shared internal.** Extract `OfferCreateFacet`'s block into a library/internal
`_assertOfferBounds(...)` (in `LibRiskMath` or a small `LibOfferBounds`) taking
the amount/amountMax/collateral + asset legs + a `skipCeiling` flag (for the
sale-vehicle create exemption), callable from `OfferCreateFacet`,
`OfferMutateFacet`, and `LibOfferMatch`. One definition ⇒ create/mutate/match can
never drift.

### Sub-decisions (for Codex)

1. **HF-basis — split by regime (Codex r1 P2).** The create-time bound is NOT
   simply "looser than a 1.5 init gate": that framing is stale for the
   depth-tiered regime.
   - **Non-tiered** (`depthTieredLtvEnabled` off): loan init enforces
     `MIN_HEALTH_FACTOR = 1.5e18`; the create-time helpers use `minHealthFactor()`
     (also 1.5 by default), so the create bound ≈ the init gate.
   - **Tiered** (`depthTieredLtvEnabled` on): loan init uses
     `HF_LIQUIDATION_THRESHOLD` (1.0) **plus** the tier / per-asset **init-LTV
     cap**; `minCollateralForLending`/`maxLendingForCollateral` already **clamp to
     that same init-LTV cap** (scout: floor clamps UP to the cap floor, ceiling
     clamps DOWN to the cap ceiling). So the create bound aligns with the init-LTV
     cap, not a looser-than-1.5 pre-filter.
   In both regimes the create-time check is at worst equal to and at best exactly
   the init admission bound — it is a **fail-fast of the same admission math**, not
   a weaker heuristic. Implementation/tests must expect the tiered-mode reject set
   to match the init-LTV-cap clamp, not a 1.5 gate.
2. **Create-time behavior change / test reconciliation.** Activating create-time
   bounds breaks ~15 existing tests that post thin/over-sized liquid offers relying
   on the flag being off. Each must be re-baselined: either the test's offer is
   genuinely out-of-bounds (fix the amounts) or it exposes a real exemption to
   preserve. The `AcceptRangedOfferTest`/`LenderIntentMatch`/`LenderIntentCapital`/
   `BorrowerPartialFillTest`/`MatchOffersScaffoldTest` suites flip the flag on today
   and are the likely surface.
3. **`rangeAmountEnabled` disposition.** After Option 1 the flag gates nothing
   (the slice floor moves to the liquid-both-legs predicate too — see #4). Options:
   (a) leave it as inert dead-config for the #183 follow-up sweep to remove;
   (b) remove it now (ConfigFacet setter/getter/event + views + frontend ABI).
   **Recommend (a)** — keep this PR bounded to the S15 correctness fix; the flag
   removal is a separate dead-config sweep card.
4. **Internal-match slice floor (`LibOfferMatch.sol:819`).** Re-key it on the same
   **liquid-both-legs** predicate (NOT range-shape — intent slices are
   single-value, per the P2 above) so create/mutate/match all agree. Include it in
   this fix.

### Edge cases

- Sale/offset/refinance vehicles: already immutable at mutate ⇒ never reach the
  mutate bounds ⇒ no exemption needed on the mutate side. At **create**, keep the
  existing `saleVehicleCreate` ceiling exemption via the shared internal's
  `skipCeiling` flag (the create caller passes it in).
- **Liquid tier-0 legs MUST stay bounded (Codex r1 P2).** `LibRiskMath` returns
  the no-bound sentinels (`floor 0` / `ceiling type(uint256).max`) **only when a
  tier-0 leg is also NOT Liquid**; a **liquid tier-0** leg gets a *finite*
  floor/ceiling (priced at the conservative threshold, per the Tranche-1
  liquid-vs-illiquid tier-0 distinction). The shared internal must therefore **not**
  add any tier-0 exemption of its own — it faithfully passes `LibRiskMath`'s return
  values through, treating a sentinel as "no bound" but a finite liquid-tier-0
  bound as binding. Add a **liquid tier-0 regression test** proving a thin-but-liquid
  ERC-20 offer is rejected at create and mutate.
- Genuinely illiquid legs: `LibRiskMath` returns the no-bound sentinels → the
  shared internal applies no bound (mutual-consent illiquid path stays open,
  matching create today).
- Non-ERC-20 legs (NFT collateral/rental): excluded by the `both-legs-ERC-20`
  condition — unchanged.

### Test plan

- Mutate rejects an out-of-bounds shape create would reject
  (`setOfferAmount` up past ceiling → `MaxLendingAboveCeiling`;
  `setOfferCollateral` down below floor → `MinCollateralBelowFloor`).
- Create rejects the same shapes (activation regression).
- **Single-value** liquid-both-legs offer IS bounded (not exempt) at create and
  mutate — a thin single-value offer is rejected.
- **Intent-slice floor:** a lender-intent slice materialized single-value with
  `reqColl` below the floor is rejected by the re-keyed `LibOfferMatch` check.
- **Liquid tier-0** thin ERC-20 offer is rejected at create and mutate (guards the
  liquid-vs-illiquid tier-0 distinction).
- Sale-vehicle create still exempt from the ceiling (`skipCeiling`); sale-vehicle
  mutate still `SaleVehicleImmutable` (never reaches bounds).
- Genuinely illiquid legs: no bound applied (regression — mutual-consent path open).
- Re-baselined ~15 flag-on suites pass with the un-gated logic.

### Blast radius / ABI

`MinCollateralBelowFloor` / `MaxLendingAboveCeiling` already on
`OfferCreateFacet`'s surface; if the shared internal moves them or
`OfferMutateFacet` newly surfaces them, re-export both facets' ABIs. Shared
internal extraction is EIP-170-relevant for `OfferCreateFacet` (chronic ceiling,
#980) — extracting to a library *reduces* create-facet size if done well; measure
both facets.

---

## Sequencing & process

- **This doc → 2 Codex review rounds → converge**, then implement.
- Each item ships as **its own PR** (independent surfaces): S8 (RepayFacet +
  LibVaipakam), S10 (ClaimFacet + LibSanctionedLock + LibVaipakam + Storage),
  S15 (OfferCreateFacet + OfferMutateFacet + LibOfferMatch + shared internal).
- Per-PR: targeted tests only, `forge build --skip test` for ABI export where
  triggered, Codex trigger-only loop to convergence, per-PR release-note fragment
  + functional-spec + `_CodeVsDocsAudit` update, merge `--squash --admin` on green
  + clean + threads resolved.
- ABI re-export triggers: S10 (if `SanctionsOracleUnavailable` is new to
  ClaimFacet), S15 (if the two range errors newly surface on OfferMutateFacet).
  S8 needs none.

## Open questions for reviewers (post-r1)

1. **S8 semantics (the one genuinely open question):** does a rental
   `repayPartial` **pre-pay/settle calendar days** (so advancing `lastDeductTime`
   by `partialAmount × ONE_DAY` is the correct counter fix, §S8(1)), or does it
   **retire term without pre-paying calendar time** (needing a dedicated
   `rentalDaysPaid` counter instead)? The former is assumed; confirm.
2. **S10:** Option B mapping+bitfield vs Option A `ClaimInfo.sanctionsLocked`?
   (Recommend B — no ABI-exposed struct change.) And: the fail-closed screen also
   applies to the backstop `nftOwner` screen (`_claimViaBackstopImpl`) when the
   marker is set — confirm that's desired.
3. **S15:** keep `rangeAmountEnabled` as inert dead-config (recommend) vs remove
   it now? (r1 resolved the HF-basis and range-shape-key questions — see
   sub-decisions #1 and #4.)
