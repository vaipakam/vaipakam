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

### Latent adjacent issue (OUT OF SCOPE — flag only)

`RepayFacet.sol:431` derives `alreadyDeductedDays = (lastDeductTime − startTime)/
ONE_DAY`, but `repayPartial` decrements `durationDays` **without advancing
`lastDeductTime`** (`RepayFacet.sol:924-927`), while `autoDeductDaily` advances
both (`RepayPeriodicFacet.sol:215-219`). So after a partial repay,
`undeductedDays = elapsedDays − alreadyDeductedDays` **over-counts** the still-owed
days. This is a pre-existing bug in the *elapsed-interest* path, independent of
the late fee. **The chosen S8 design side-steps it entirely** (see below), so we
do NOT fix it here; it is filed as a separate follow-up.

### Design — base the fee on the remaining rental, capped at 5% of it

Per the ratified plan (§6): the late-fee cap is **5% of the total remaining
rental**, i.e. `loan.principal × loan.durationDays`, not 5% of one day.
`durationDays` is the **remaining unpaid term** and is reliably decremented by
**both** `autoDeductDaily` and `repayPartial` — so it is drift-free and needs no
new counter. This is why the design avoids the latent `lastDeductTime` issue: it
never reads `undeductedDays`/`lastDeductTime`.

**Chosen approach — a rental-aware late-fee helper.** Add
`LibVaipakam.calculateRentalLateFee(loanId, endTime)` that mirrors
`calculateLateFee` but multiplies by the remaining-rental base:

```solidity
// base = total remaining rent (per-day fee × remaining days)
uint256 base = loan.principal * loan.durationDays;
return (base * feePercent) / 10000;   // same feePercent slope + 5% cap
```

Only the **NFT-rental branch** of `RepayFacet.repayLoan` switches to the new
helper; the ERC-20 branch and every other `calculateLateFee` caller
(`DefaultedFacet`, `RiskFacet`, `SwapToRepay*`, `AutoLifecycleFacet`,
`RiskSplitLiquidationFacet`, `LibSwapToRepayIntentSettlement`) stay on the
existing helper unchanged — they are all ERC-20/collateral paths where
`loan.principal` is already the correct base.

**Why a new helper, not a branch inside `calculateLateFee`:** the shared helper
has ~10 callers; widening its contract to "sometimes multiply by durationDays"
risks a wrong base on a collateral-liquidation path. A named rental helper keeps
the rental semantics local to the one rental caller and is self-documenting.

**Sub-decision (for Codex): which base — remaining or original term?**
- **Remaining term (`durationDays`)** — *recommended.* Late fees only accrue
  once past `endTime`, at which point remaining un-auto-deducted days ARE the
  overdue obligation. Drift-free. Matches the plan's `principal × durationDays`.
- Original term — would over-penalize (charges on already-paid days) and there is
  **no stored original-term field** to read it from anyway (confirmed: no field
  survives both mutation paths). Rejected.

### Edge cases

- `block.timestamp <= endTime` → fee 0 (unchanged guard, first line of helper).
- `durationDays == 0` at the time of a late repay → base 0 → fee 0. Can this
  happen? `autoDeductDaily` closes the rental (`Repaid`) when `durationDays`
  hits 0 (`RepayPeriodicFacet.sol:238`), so a still-open late rental has
  `durationDays > 0`. Confirm in tests.
- `useFullTermInterest` vs elapsed: the base is `principal × durationDays`
  **regardless** of the interest model, so both branches get a consistent cap.
  Note `interest` itself still differs by branch — that's unchanged.
- EIP-170: `RepayFacet` is a god-facet near the ceiling. The new helper lives in
  `LibVaipakam` (a library — inlined into callers). Adding a *second* inlined
  formula to the one rental caller costs a few bytes; verify `RepayFacet` stays
  under 24,576 after the change (measure; if tight, dedupe the shared `feePercent`
  slope into a private `_lateFeePercent(endTime)` both helpers call).

### Test plan (`RepayFacetTest.t.sol`)

- Late rental fee scales with remaining term (40-day-remaining rental late-fee ≫
  1-day-remaining, same daily fee).
- Cap binds at **5% of `principal × durationDays`** (very-late rental).
- ERC-20 late fee unchanged (regression).
- `durationDays`-drift independence: a rental that had a `repayPartial` then goes
  late still bases the fee on `principal × durationDays` (no `lastDeductTime`
  read).

### Blast radius / ABI

New internal library function; no facet selector, no struct-shape change → **no
ABI re-export, no diamond cut**. Single facet touched (`RepayFacet`) +
`LibVaipakam`.

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

**Set the marker** exactly where `LibSanctionedLock` today decides to emit
`SanctionedProceedsLocked` — i.e. inside `end`/`getOrCreateVaultLocked`/
`depositLocked` when `isSanctionedAddress(owner) == true` (`LibSanctionedLock.sol:
132/165/198`). The library already computes that boolean; we additionally
persist it. Pass the side (lender/borrower) so the correct bit is set. Because
the set is **conditioned on an affirmative flag**, a park that happened during an
oracle outage (predicate fails open → false) does **not** set the marker — those
funds are treated as ordinary (correct: we never confirmed the party was
sanctioned, and the close-out itself is Tier-2 permissionless).

**(2) The fail-closed screen.** Add
`LibVaipakam.assertNotSanctionedFailClosed(who)` mirroring the
`VaultFactoryFacet:753` pattern: oracle unset ⇒ `revert SanctionsOracleUnavailable`;
oracle reverts ⇒ `revert SanctionsOracleUnavailable`; flagged ⇒ `revert
SanctionedAddress(who)`; clean ⇒ proceed.

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
wherever a range shape is allowed** (keyed on the offer actually being a **range
shape + liquid-both-legs ERC-20**), at **both create and mutate**, extracting the
create-time block into **one shared internal** so the two paths share a single
definition.

**Options considered:**

- **Option 1 — activate, un-gated, keyed on range-shape + liquid-both-legs
  ERC-20** *(recommended, matches the plan).* Floor/ceiling runs at create AND
  mutate for any liquid-both-legs ERC-20 offer whose `amount ≠ amountMax` (a range
  shape). Closes the finding for the live config. Cost: a create-time behavior
  change for range offers (fail-fast admission) + the create-time test
  reconciliation.
- **Option 2 — parity, keep the flag on both.** Add a mutate check gated on the
  same dead flag. No behavior change, but the finding stays *inert-open* in
  production (neither path enforces while the flag is off). Rejected by the plan.
- **Option 3 — un-gate mutate only, leave create gated.** Incoherent asymmetry
  (an offer creatable but not mutatable). Rejected.

**Chosen: Option 1.**

**The `range-shape` key** (`amount != amountMax`) is the plan's scoping lever and
**bounds the blast radius**: single-value / AON offers (`amount == amountMax`)
keep today's behavior (loan-init HF gate only). Since #183 makes most canonical
offers ranges, this still covers the common case, but it cleanly exempts AON and
degenerate single-value offers from a create-time admission reject.

**Shared internal.** Extract `OfferCreateFacet`'s block into a library/internal
`_assertRangeBounds(...)` (in `LibRiskMath` or a small `LibOfferBounds`) taking
the amount/amountMax/collateral + asset legs, callable from both
`OfferCreateFacet` and `OfferMutateFacet`. One definition ⇒ create and mutate can
never drift.

### Sub-decisions (for Codex)

1. **HF-basis alignment.** `minCollateralForLending`/`maxLendingForCollateral` use
   `hfFloor = HF_LIQUIDATION_THRESHOLD` (depth-tiered) or `minHealthFactor()`,
   while loan-init uses `MIN_HEALTH_FACTOR = 1.5e18`. In the depth-tiered regime
   the create-time floor is **looser** than the init gate, so activating it is a
   *pre-filter*, not a substitute for the init HF check. The doc must state this:
   S15 makes egregious shapes fail fast; it does **not** guarantee acceptability.
   Decide whether that's acceptable (recommend yes — it's strictly more checking
   than today, and the init gate remains authoritative).
2. **Create-time behavior change / test reconciliation.** Activating create-time
   bounds breaks ~15 existing tests that post thin/over-sized liquid range offers
   relying on the flag being off. Each must be re-baselined: either the test's
   offer is genuinely out-of-bounds (fix the test's amounts) or it exposes a real
   exemption we must preserve. Enumerate them during implementation; the
   `AcceptRangedOfferTest`/`LenderIntentMatch`/`LenderIntentCapital`/
   `BorrowerPartialFillTest`/`MatchOffersScaffoldTest` suites flip the flag on
   today and are the likely surface.
3. **`rangeAmountEnabled` disposition.** After Option 1 the flag gates only the
   `LibOfferMatch` slice floor. Options: (a) also un-gate that slice check (keyed
   on range-shape/liquid) and leave the flag as inert dead-config for the #183
   follow-up sweep to remove; (b) remove the flag now (ConfigFacet setter/getter/
   event + views + frontend ABI). **Recommend (a)** — keep this PR bounded to the
   S15 correctness fix; the flag removal is a separate dead-config sweep card.
4. **Internal-match slice floor (`LibOfferMatch.sol:819`).** For consistency, the
   slice floor should key on the same range-shape/liquid predicate rather than the
   dead flag. Include it in this fix so create/mutate/match all agree.

### Edge cases

- Sale/offset/refinance vehicles: already immutable at mutate ⇒ never reach the
  mutate bounds ⇒ no exemption needed on the mutate side. At **create**, keep the
  existing `saleVehicleCreate` ceiling exemption (the shared internal must accept a
  "skip-ceiling" flag or the create caller passes the exemption in).
- Illiquid / tier-0 legs: `minCollateralForLending` returns 0 (no floor) and
  `maxLendingForCollateral` returns `type(uint256).max` (no ceiling) — the shared
  internal must treat those sentinels as "no bound" exactly as create does today.
- Non-ERC-20 legs (NFT collateral/rental): excluded by the `both-legs-ERC-20`
  condition — unchanged.

### Test plan

- Mutate rejects an out-of-bounds range shape create would reject
  (`setOfferAmount` up past ceiling → `MaxLendingAboveCeiling`;
  `setOfferCollateral` down below floor → `MinCollateralBelowFloor`).
- Create rejects the same shapes (activation regression).
- Single-value / AON offer is **exempt** at both create and mutate (range-shape
  key).
- Sale-vehicle create still exempt from the ceiling; sale-vehicle mutate still
  `SaleVehicleImmutable` (never reaches bounds).
- Illiquid/tier-0 legs: no bound applied (regression).
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

## Open questions for reviewers

1. **S8:** confirm `principal × durationDays` (remaining term) is the intended
   base vs any notion of original term. (Recommend remaining — drift-free, and no
   original-term field exists.)
2. **S10:** Option B mapping+bitfield vs Option A `ClaimInfo.sanctionsLocked`?
   (Recommend B — no ABI-exposed struct change.) And: does the fail-closed screen
   also apply to the backstop nftOwner screen?
3. **S15:** accept that create-time activation is a **pre-filter** below the
   1.5 init HF (does not guarantee acceptability)? And keep `rangeAmountEnabled`
   as inert dead-config (recommend) vs remove it now?
