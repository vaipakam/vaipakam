# Pass-2 D1 — Decouple rental maturity/grace from the shrinking `durationDays`

**Card:** #1188 (High) · **Umbrella:** #1196 · **Pairs with:** #893 (ERC-4907 expiry manifestation)
**Owner-ratified approach (2026-07-13):** derive rental maturity from
`lastDeductTime + durationDays`; feed `gracePeriod()` the original term.

## The bug

Rental loans amortise by decrementing `loan.durationDays` as prepaid rent is
consumed, while `loan.startTime` never moves:

- `RepayPeriodicFacet.autoDeductDaily` (≈213-216): per day, `durationDays -= 1`,
  `lastDeductTime += ONE_DAY`, `prepayAmount -= dayFee`.
- Rental `RepayFacet.repayPartial` (≈983): `durationDays -= partialAmount`,
  `prepayAmount -= accrued` — **but does NOT advance `lastDeductTime`**.

Every maturity/grace consumer computes the loan end as
`startTime + durationDays × 1 day` and the grace bucket as
`gracePeriod(durationDays)` — both off the **shrunk** counter:

- `LibVaipakam.isGraceWindow` (6013-6016)
- `DefaultedFacet` (≈243, ≈787)
- `RepayFacet` late-fee / past-grace gates (≈267-280, ≈1049)
- `PrecloseFacet` Option-2 / offset maturity gates
- ERC-4907 `userExpires` re-stamp: `newExpires = startTime + durationDays × 1day`
  (RepayPeriodicFacet renter-expires update; RepayFacet ≈988) — the #893 surface.

**Impact (real bug):** on the designed daily cadence a 7-day rental's computed
maturity marches *earlier* each day, so it is permissionlessly
`triggerDefault`-able around day 4 (borrower forfeits remaining prepay + the full
5% buffer to treasury), and an in-term `repayLoan` is first late-fee'd, then
reverts `RepaymentPastGracePeriod` — the borrower **cannot close a fully-funded,
fully-serviced rental**. Spec: maturity + grace are "fixed at origination / never
moved" (README consolidation header + §1362); rental default only "by the end of
the grace period" after the agreed term (§1333).

## Design — option (b): keep `durationDays` IMMUTABLE (chosen after scouting)

**The owner-ratified recommendation offered two arms** — (a) derive maturity from
`lastDeductTime + durationDays`, or (b) *"keep `durationDays` immutable and track
a separate paid/remaining counter, the #641 pattern."* A scout of the actual
surface picked **(b)**, because:

- **~20+ sites across 15 facets** compute maturity as `startTime + durationDays × 1 day`,
  and many carry comments asserting the term tuple is *"LEFT UNTOUCHED"* /
  *"preserved exactly"* — the post-#641 convention is that
  `startTime + durationDays` IS the fixed maturity. Rental amortisation
  (`autoDeductDaily`, rental `repayPartial`) is the *sole violator* that
  decrements `durationDays`. Option (a) would touch all 20+ consumers; option (b)
  fixes the two violators and leaves every consumer correct **with zero changes.**
- `durationDays` is **not** a load-bearing counter in `autoDeductDaily` — the stop
  condition is prepay depletion (`dayFee > prepayAmount`), and days consumed are
  already tracked by `lastDeductTime` (advances +1/day). So keeping `durationDays`
  immutable is safe; remaining days are *derived*.

This is the exact #641 interest-clock decouple applied to the maturity clock:
keep the term tuple immutable, track progress on a separate clock
(`lastDeductTime`), derive remaining rather than shrinking the term. **No new
storage field** — remaining is derived from existing `lastDeductTime`.

### 1. One derived accessor in `LibVaipakam`

```solidity
/// Rental REMAINING prepaid days = term − consumed. durationDays is immutable
/// (fixed maturity); consumed days tracked by lastDeductTime. Non-rental loans
/// never advance lastDeductTime, so this returns full durationDays.
function remainingRentalDays(Loan storage loan) internal view returns (uint256) {
    uint256 consumed = (uint256(loan.lastDeductTime) - uint256(loan.startTime)) / 1 days;
    return consumed >= loan.durationDays ? 0 : uint256(loan.durationDays) - consumed;
}
```

### 2. Stop shrinking `durationDays`; advance `lastDeductTime` uniformly

- `RepayPeriodicFacet.autoDeductDaily`: drop `durationDays -= 1` (keep the
  `lastDeductTime += ONE_DAY` advance).
- rental `RepayFacet.repayPartial`: drop `durationDays -= partialAmount`; **add**
  `lastDeductTime += partialAmount × ONE_DAY` so `lastDeductTime` tracks consumed
  days across BOTH paths.

### 3. Reroute the `durationDays`-as-remaining READS to `remainingRentalDays`

`durationDays` was overloaded as "remaining owed days" in the rental fee/close
math. Each becomes `remainingRentalDays(loan)`:
- `RepayFacet` partial bound (`partialAmount > durationDays` → `> remainingRentalDays`),
- `RepayFacet` `useFullTermInterest` interest (settle **and** preview paths),
- `LibVaipakam.calculateRentalLateFee` (`principal × durationDays`),
- `PrecloseFacet` NFT-rental `fullRental` (`principal × durationDays`),
- `RepayPeriodicFacet` auto-finalise guard (`durationDays == 0` →
  `remainingRentalDays == 0`).

### 4. What needs NO change (the payoff of option b)

- All ~20+ `startTime + durationDays × 1 day` maturity / `gracePeriod(durationDays)`
  consumers — correct once `durationDays` is immutable.
- ERC-4907 `userExpires = startTime + durationDays × 1day` — now the FIXED
  origination maturity, so the renter holds the NFT for the full term (**#893
  join**, for free).
- `DefaultedFacet` rental forfeit — already uses `prepayAmount` (tracked
  remaining), not a `durationDays` product.
- Non-rental (ERC-20) loans — `durationDays` was never decremented for them; #641
  already keeps their term immutable. Byte-for-byte unchanged.

## Non-goals / preserved behaviour

- No change to the amortisation economics (`prepayAmount`/`dayFee` untouched).
- Non-rental loans: byte-for-byte identical behaviour (accessors collapse).
- No new storage field, no migration (pre-live; derived from existing fields).

## Test plan

- **Rental full-cadence close:** 7-day rental, auto-deduct to ~day 4, then
  `repayLoan` in-term → succeeds, no late fee, not `triggerDefault`-able before
  the original endTime+grace. (Regression for the exact reported impact.)
- **repayPartial invariant:** after a multi-day `repayPartial`, assert
  `loanMaturity(loan) == origination endTime` and `originalTermDays == D`.
- **Grace-bucket stability:** `gracePeriod` bucket unchanged across amortisation
  (uses original term, not shrunk `durationDays`).
- **userExpires (#893):** renter `userExpires == original endTime` after
  auto-deductions.
- **Non-rental unchanged:** existing DefaultedFacet/RepayFacet grace tests stay green.
- Deploy-sanity + targeted `RepayPeriodicFacet`/`RepayFacet`/`DefaultedFacet`/
  `PrecloseFacet` suites.

## Rollout

Design → 2 Codex rounds on this doc → implement (one PR, `contracts/src` +
targeted tests) → Codex convergence → merge. Spec already describes the intended
"maturity fixed at origination" behaviour, so this is a code-conforms-to-spec fix
(release-note fragment + `_CodeVsDocsAudit` D1 Open→Resolved on merge).
