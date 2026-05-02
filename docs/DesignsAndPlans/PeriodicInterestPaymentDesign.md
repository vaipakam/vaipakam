# Periodic Interest Payment — Design Doc

Status: **draft, design phase**. Companion ticket: T-034.
Companion release notes: [`ReleaseNotes-2026-05-02.md`](../ReleaseNotes/ReleaseNotes-2026-05-02.md)
under "T-034 — periodic interest payment (planning + design phase)".

This document locks the on-chain + off-chain shape of the
periodic-interest-payment mechanic before any contract code lands.
Structure mirrors [`RangeOffersDesign.md`](./RangeOffersDesign.md)
so the two designs can be cross-referenced cleanly during the
parallel review window.

## 1. Goals & non-goals

### 1.1 Goals

- **Cap lender exposure on long-duration loans.** A loan that runs
  for two or three years today only settles interest at terminal —
  the lender carries the full unsettled accrual for the entire
  loan. Forcing periodic settlement caps the lender's at-risk
  interest to one cadence-interval's worth.
- **Mandatory annual floor for multi-year loans.** Every loan
  whose `durationDays > 365` settles interest at least once per
  year, regardless of principal size. Lender exposure on a 3-year
  loan must not exceed 1 year of unsettled interest.
- **Lender-chosen finer cadence as an opt-in for large loans.**
  Above an admin/governance-configurable threshold, the lender can
  tighten the cadence to monthly / quarterly / semi-annual at
  offer creation. Small loans don't carry the operational overhead.
- **Permissionless enforcement.** Anyone can call the settler. If
  the borrower paid the period's interest in time, the settler
  just stamps the next checkpoint. If they didn't, the settler
  sells just enough collateral to cover the shortfall and earns a
  small bonus from the swap so gas economics work.
- **Clear UX.** Offer creation surfaces the cadence under Advanced
  mode; offer acceptance shows the cadence prominently with the
  consequence of missed payments spelled out; loan detail page
  carries a per-period countdown with a one-tap "pay now" button.
- **Reuse existing grace + watcher infrastructure.** No new grace
  schedule, no new pre-notify lane — the T-044 6-slot grace
  schedule and the existing maturity pre-notify Worker lane both
  extend to cover periodic checkpoints.
- **Numeraire-agnostic.** The principal threshold for finer
  cadences is denominated in a configurable numeraire (USD by
  default; future swap to EUR / JPY / XAU possible without a
  contract upgrade).

### 1.2 Non-goals

- **Per-asset thresholds.** One global threshold in numeraire
  units; principal converts via the existing primary-price oracle.
- **Per-loan custom cadence intervals.** Cadence is a 5-value
  enum, not an arbitrary `intervalDays` field. Bucket buckets
  simplify UX, validation, watcher SQL, and grace-tier mapping.
- **Sweeping every existing USD-denominated knob onto the
  numeraire abstraction.** `KYC_THRESHOLD_USD`, HF/LTV USD
  internals, fallback-split BPS — these all stay USD-direct in
  T-034. A future ticket sweeps them onto the same atomic-setter
  pattern when there's a real swap on the table.
- **Borrower-side cadence choice.** The lender owns the cadence
  decision at offer-creation time. Borrower's only choice is
  accept-or-decline.
- **Mandatory annual cadence for ≤ 365d loans.** Sub-1-year
  loans default to `None` cadence (today's behavior). Lender can
  opt into finer cadences if principal qualifies.
- **Loans where either side is illiquid.** The entire mechanic —
  including the >1y mandatory annual floor — applies ONLY when
  BOTH the lending asset AND the collateral asset are liquid
  (Chainlink-priced, AMM-swappable per the existing
  `LiquidityStatus.Liquid` classification). If either side is
  illiquid, cadence is forced to `None` and the loan continues
  on today's terminal-only mechanic. See §3.0 for the precondition.

## 2. Data model

### 2.1 `Loan` struct changes

Pre-launch, so slot reordering is permitted (per the codebase
comment at LibVaipakam.sol:690-696 that authorizes pre-launch
storage reorder). Three new fields plus one downsize:

```
// Slot 3 (currently 21 bytes packed: address borrower + bool
// allowsPartialRepay). Adds 9 bytes:
+   uint8   periodicInterestCadence;       // enum, see §2.4
+   uint64  lastPeriodicInterestSettledAt; // unix seconds; init = startTime

// Slot 9 (currently uint256 startTime, alone): downsize +
// pair with the new uint128.
-   uint256 startTime;
+   uint64  startTime;
+   uint128 interestPaidSinceLastPeriod;  // 1e18-scaled, in principalAsset units
```

Slot 3 ends 30 bytes packed (2 free). Slot 9 ends 24 bytes
packed (8 free for future expansion).

`startTime` downsize from uint256 → uint64 is safe: timestamps
fit uint64 until year 2554 (well past any plausible loan
horizon). Every existing reader is `view` or downcasts to
`uint256` implicitly via Solidity widening — no signature impact.

### 2.2 `Offer` struct changes

Single new field:

```
+   uint8 periodicInterestCadence;  // enum, see §2.4
```

Packs into the existing partly-empty slot alongside other small
fields (locations chosen at implementation time per `forge inspect
--storage-layout` output).

### 2.3 `CreateOfferParams` changes

```
+   PeriodicInterestCadence periodicInterestCadence;
```

Default value `None` is meaningful — short-duration small-principal
offers explicitly opt out. Multi-year offers MUST send at least
`Annual`; createOffer reverts otherwise.

### 2.4 `PeriodicInterestCadence` enum

```solidity
enum PeriodicInterestCadence {
    None,         // 0 — terminal-only repayment
    Monthly,      // 1 — 30 days
    Quarterly,    // 2 — 90 days
    SemiAnnual,   // 3 — 180 days
    Annual        // 4 — 365 days
}
```

Interval lookup as a `pure` library helper:

```
function intervalDays(PeriodicInterestCadence c) → uint256:
  None        → 0
  Monthly     → 30
  Quarterly   → 90
  SemiAnnual  → 180
  Annual      → 365
```

### 2.5 `ProtocolConfig` additions

```
+   address numeraireOracle;             // §6
+   uint256 minPrincipalForFinerCadence; // §3, in numeraire-units 1e18
+   uint8   preNotifyDays;               // §7, range-bounded [1, 14], default 3
```

Each surfaces in the Protocol Console (existing UI from T-044
+ T-033) under appropriate categories — `numeraireOracle` under
Oracles, `minPrincipalForFinerCadence` under Risk, `preNotifyDays`
under Watcher / Notifications.

## 3. Cadence selection — validation matrix

Three filters apply at `createOffer`, in order:

### 3.0 Filter 0 — both assets must be liquid (precondition)

The entire periodic-interest mechanic depends on the auto-
liquidate path being able to sell collateral and credit the
lender in the lending asset. That assumption requires:

- `principalLiquidityStatus == Liquid` — lender can be paid
  in fungible, oracle-priced, AMM-swappable principal.
- `collateralLiquidityStatus == Liquid` — collateral can be
  sold via the existing 4-DEX failover at known prices.

If EITHER is illiquid, the only allowed cadence is `None`. This
applies regardless of duration or principal size — even a
3-year illiquid loan does NOT get the mandatory annual floor,
because the protocol cannot enforce it. The lender accepts this
trade-off implicitly when accepting an illiquid offer (same
trade-off as the existing "no LTV-based protection on default"
rule for illiquid loans, per the
`Abnormal-market & illiquid asset terms` consent flow).

NFT-rental loans (lender lends an NFT, borrower pays rental
fees over time via the existing `prepayAmount` + `bufferAmount`
+ daily-deduction mechanic) are illiquid by definition and
unaffected — they already have their own time-based payment
flow that periodic-interest does not touch.

If Filter 0 fails:
- **Frontend:** the cadence dropdown is NOT rendered at all. No
  disabled options, no tooltip explaining why — the entire
  control is absent from the form. Lender cannot pick anything
  other than `None` because no UI surface exists to do so.
- **Contract:** `createOffer` reverts with
  `CadenceNotAllowedForIlliquid(principalLiquidity,
   collateralLiquidity, cadence)` if the request carries any
  cadence other than `None` while either side is illiquid.
  Defense-in-depth — even a directly-crafted tx that bypasses
  the frontend cannot create a non-`None` cadence on an
  illiquid loan.

Filters 1 and 2 are not evaluated when Filter 0 fails.

### 3.1 The two filters that apply when Filter 0 passes

**Filter 1 — interval must be strictly less than duration.**
A cadence whose interval ≥ duration would land its first
checkpoint at or after maturity; redundant with terminal repay.

| Duration | Cadences that pass Filter 1 |
|---|---|
| < 30d | None only |
| < 60d, ≥ 30d | None, Monthly |
| < 90d, ≥ 60d | None, Monthly *(Quarterly excluded: 90 ≥ duration)* |
| < 180d, ≥ 90d | None, Monthly, Quarterly |
| < 365d, ≥ 180d | None, Monthly, Quarterly, SemiAnnual |
| ≥ 365d | None, Monthly, Quarterly, SemiAnnual, Annual |

**Filter 2 — duration + threshold gate.**

| Duration | Principal vs threshold | Allowed cadences (∩ Filter 1) |
|---|---|---|
| ≤ 365d | < threshold | `None` only |
| ≤ 365d | ≥ threshold | `None` + finer cadences passing Filter 1 |
| > 365d | < threshold | `Annual` only *(mandatory floor)* |
| > 365d | ≥ threshold | `Annual` (floor) + finer cadences passing Filter 1 |

Worked examples:

- 30-day $500 loan → Filter 1 allows `None`, `Monthly` (30d not < 30d → Monthly excluded too); `None` only.
- 90-day $50k loan above threshold → row 2 ∩ Filter 1 = `None`, `Monthly`.
- 6-month $50k loan above threshold → `None`, `Monthly`, `Quarterly`. SemiAnnual excluded (180 ≥ 180).
- 1-year exactly $50k loan above threshold → `None`, `Monthly`, `Quarterly`, `SemiAnnual`. Annual excluded (365 ≥ 365).
- 18-month $1k loan → `Annual` forced (row 3).
- 18-month $50k loan → `Annual` (floor) + `Monthly` + `Quarterly` + `SemiAnnual` (row 4).
- 3-year $1M loan → any cadence.

`createOffer` reverts with `CadenceNotAllowed(cadence, duration, principalNumeraire, threshold)` when the chosen cadence falls outside the matrix.

## 4. Settlement mechanics

### 4.1 Anatomy of one period

A period is the interval `[lastPeriodicInterestSettledAt,
lastPeriodicInterestSettledAt + intervalDays(cadence)]`. At each
period close, the borrower owes:

```
expectedThisPeriod = principalOutstanding × interestRateBps / 10_000
                     × intervalDays / 365
```

(or the closed-form continuous accrual the existing protocol
already uses — implementation reuses `LibInterest` or whatever
helper is already in tree).

The borrower's voluntary partial repayments throughout the period
land in the existing repayment path AND increment
`interestPaidSinceLastPeriod` for the interest portion. At
period close:

- `shortfall = expectedThisPeriod - interestPaidSinceLastPeriod`
- If `shortfall == 0` (or ≤ 0): borrower paid in full → just stamp.
- If `shortfall > 0`: grace window starts.

### 4.2 Grace window

Reuses T-044's `LibVaipakam.gracePeriod()` with the cadence-to-slot
mapping locked in §1.1:

| Cadence | Grace slot | Default grace |
|---|---|---|
| Monthly | 1 (`< 30d`) | 1 day |
| Quarterly | 2 (`< 90d`) | 3 days |
| SemiAnnual | 3 (`< 180d`) | 1 week |
| Annual | 4 (`< 365d`) | 2 weeks |

No new grace knob, no new admin surface. Operators tuning the
grace schedule for default-after-maturity automatically tune the
periodic-checkpoint grace too.

### 4.3 Settlement entry point — `settlePeriodicInterest`

Lives on `RepayFacet`. If `forge build --sizes` shows RepayFacet
crossing 24KB after this addition, extract to a new
`PeriodicInterestFacet` in the same PR.

```solidity
function settlePeriodicInterest(uint256 loanId) external whenNotPaused;
```

Permissionless. Validation:

1. Loan exists and is `Active`.
2. `loan.periodicInterestCadence != None`.
3. `now >= lastPeriodicInterestSettledAt + intervalDays + grace`.

After validation, two paths:

**Just-stamp path (`shortfall == 0`)** — no settler fee. Anyone
can call; in practice the borrower self-calls (or it can fold
into the next `repayPartial` automatically — see §4.5).

```
loan.lastPeriodicInterestSettledAt += intervalDays;
loan.interestPaidSinceLastPeriod = 0;
emit PeriodicInterestSettled(loanId, periodIndex, /*shortfall*/ 0, settler);
```

**Auto-liquidate path (`shortfall > 0`)** — settler earns bonus
from collateral swap. **Reuses the existing liquidation split**
defined in `docs/FunctionalSpecs/ProjectDetailsREADME.md`
§"Equivalent Collateral Transfer for Liquid Asset during Abnormal
Periods" — no new BPS knobs in T-034.

```
slippageCapBps = ProtocolConfig.maxLiquidationSlippageBps  // existing knob
                                                           // (default 600, governance-tunable)

// Quote target: principal-asset value equal to the shortfall, sold
// from collateral. Existing 4-DEX failover infrastructure (§7a).
amountInQuote, expectedOutQuote = swapQuote(
    collateralAsset, principalAsset,
    targetOutput = shortfall,
    slippageCap = slippageCapBps
)

// Execute swap. If realized slippage ≥ slippageCapBps, swap reverts;
// fall through to the abnormal-period fallback path (already wired
// into the existing liquidation infrastructure — no new code).
realizedOut       = swap.execute(amountInQuote)
realizedSlippage  = (expectedOutQuote - realizedOut) × 10_000 / expectedOutQuote

// Split per existing §"Equivalent Collateral Transfer..." policy:
// — Settler:  max(0, slippageCap - realizedSlippage), capped at 3%.
//             Better execution → bigger bonus.
// — Treasury: flat 2% of proceeds.
// — Lender:   the rest.
settlerBonusBps   = min(
                      max(0, slippageCapBps - realizedSlippage),
                      LIQUIDATOR_BONUS_CAP_BPS  // 300 (3%)
                  )
treasuryShareBps  = LIQUIDATION_TREASURY_BPS    // 200 (2%)

settlerBonus   = realizedOut × settlerBonusBps  / 10_000
treasuryShare  = realizedOut × treasuryShareBps / 10_000
lenderProceeds = realizedOut - settlerBonus - treasuryShare

pay lenderProceeds → lender's escrow (treated identically to repayPartial interest)
pay settlerBonus   → settler
pay treasuryShare  → treasury

loan.collateralAmount             -= amountInQuote
loan.lastPeriodicInterestSettledAt += intervalDays
loan.interestPaidSinceLastPeriod   = 0
loan.cumulativeInterestPaid       += lenderProceeds  // parity with repayPartial accounting

emit PeriodicInterestAutoLiquidated(
    loanId, periodIndex, shortfall, lenderProceeds,
    amountInQuote, settlerBonus, treasuryShare, settler
);
```

Post-sale HF check is intentionally NOT performed here — the
existing HF-monitoring lane (`hf-watcher` Worker + permissionless
`triggerLiquidation`) naturally fires `RiskFacet.triggerLiquidation`
in a separate tx if the post-sale HF drops below 1.0e18. Adding a
buffer threshold inside `settlePeriodicInterest` would just delay
the inevitable AND introduce a tunable that can drift from the
canonical 1.0e18.

**Why no new BPS knobs:** the existing `maxLiquidationSlippageBps`
(default 6%, governance-tunable in [1%, 20%]) is the single lever
governing both this path AND the existing HF / time-based
liquidation paths. Consistent semantics; one knob to tune.

### 4.4 Multi-period catch-up

If a loan has missed multiple periods (e.g. cron downtime, watcher
silence), `settlePeriodicInterest` should advance one period per
call. Caller submits N calls to catch up N periods. Rationale:
each period's interest computation depends on the
`principalOutstanding` AT THAT period close, which itself can
shift as earlier periods auto-liquidate. Single-call multi-period
settlement is easy to get wrong; per-call simplicity wins.

Watcher (§7) detects N > 1 and submits N sequential txs.

### 4.5 Folding into voluntary repayment — interest-first allocation

`RepayFacet.repayPartial(loanId, amount)` allocates the borrower's
payment **interest-first**: the accrued interest for the current
period gets covered before any of the payment reduces principal.

```
accruedThisPeriod = expectedThisPeriod - interestPaidSinceLastPeriod
interestPortion   = min(amount, accruedThisPeriod)
principalPortion  = amount - interestPortion

interestPaidSinceLastPeriod  += interestPortion
loan.principal               -= principalPortion
loan.cumulativeInterestPaid  += interestPortion

// Period checkpoint auto-advances inline if both:
//  1. the interest portion of this payment closed the period's expected total
//  2. block.timestamp is at or past the period's end
if interestPaidSinceLastPeriod >= expectedThisPeriod
   AND block.timestamp >= lastPeriodicInterestSettledAt + intervalDays:
    lastPeriodicInterestSettledAt += intervalDays
    interestPaidSinceLastPeriod    = 0   // reset for next period
    emit PeriodicInterestSettled(loanId, periodIndex, /*shortfall*/ 0, msg.sender)

emit RepayPartialApplied(loanId, amount, interestPortion, principalPortion,
                         /*checkpointAdvanced*/ ...)
```

Two effects of interest-first:
1. Borrower paying $100 on a loan with $40 outstanding interest →
   $40 covers interest, $60 reduces principal. Borrower's $100
   doesn't accidentally reduce principal while interest piles up.
2. Periodic checkpoint advances naturally when borrower repays
   enough — they don't need a separate `settlePeriodicInterest`
   tx for the just-stamp case.

**Communicating the breakdown to the user** — three layers, NOT
events alone:

1. **Preview view (pre-tx clarity, the most important one):**
   `previewRepayPartial(loanId, amount)` returns
   `(interestApplied, principalApplied, principalRemaining,
    willAdvanceCheckpoint)`. Frontend re-runs it on every
   keystroke as the user types the repay amount; confirmation
   screen shows the breakdown BEFORE signing:

   ```
   You are paying:        100 USDC
   ├─ Accrued interest:    40 USDC  (covers this quarter)
   └─ Principal reduction: 60 USDC

   New principal: 940 USDC
   ✓ Quarter checkpoint will advance after this payment
   ```

2. **Detailed event (post-tx record):**
   `RepayPartialApplied(loanId indexed, totalAmount,
   interestApplied, principalApplied, checkpointAdvanced)`.
   Activity feed renders the breakdown in transaction history.
   Watcher uses it for lender push notifications ("Year 1 interest
   of N tokens received on loan #123").

3. **State reads (post-tx truth):** `loan.principal`,
   `loan.interestPaidSinceLastPeriod`,
   `loan.lastPeriodicInterestSettledAt` reflect the split. Anyone
   reading the loan state sees the canonical truth.

The auto-liquidate path is NOT folded into repayment — keeps the
two flows separable for audit. The interest-first allocation IS
a behavior change to existing `repayPartial` semantics (today
some loans may apply payments principal-first); needs a release-
notes callout for borrowers used to the old behavior.

### 4.6 Refinance crossing a period boundary

`RefinanceFacet.refinanceLoan` MUST call `settlePeriodicInterest`
on the old loan first if a period is overdue past grace. This is
the user's call: original lender gets covered before the
refinance overwrites the loan state. If the period isn't
overdue (still inside cadence interval or grace window),
refinance proceeds normally and the new loan inherits a fresh
period (`lastPeriodicInterestSettledAt = block.timestamp`).

The cadence itself is re-set per the refinance offer's cadence
field — i.e. refinance can change the cadence (lender → lender
hand-off; new lender's cadence wins).

### 4.7 Preclose mid-cycle

`PrecloseFacet.transferObligationViaOffer` (full preclose) ends
the loan terminally; existing terminal interest settlement
covers everything. No periodic action needed.

Partial preclose (§ if and when it lands) follows the same
"borrower repayment crossed a period boundary" logic in §4.5.

### 4.8 HF-liquidation crossing a period boundary

If `RiskFacet.triggerLiquidation` fires while a period is overdue
past grace, the HF path takes precedence — the loan terminates.
Periodic settlement is moot. No special-case code; the HF path
naturally short-circuits the periodic path because the loan
isn't `Active` anymore by the time someone calls
`settlePeriodicInterest`.

## 5. Contract surface

### 5.1 New / changed entry points

- `OfferFacet.createOffer` — validation tightened per §3 matrix.
- `OfferFacet.acceptOffer` — snapshots `cadence` from offer onto
  loan; sets `lastPeriodicInterestSettledAt = block.timestamp`.
- `RepayFacet.settlePeriodicInterest(loanId)` — new entry point,
  permissionless, per §4.3.
- `RepayFacet.repayPartial`, `RepayFacet.repayLoan` — internal
  call to `_maybeAdvancePeriodCheckpoint` per §4.5.
- `RefinanceFacet.refinanceLoan` — settle outstanding period
  first if overdue, per §4.6.
- `ConfigFacet.setNumeraire(address oracle, uint256 newThreshold)`
  — atomic batched setter, per §6.
- `ConfigFacet.setMinPrincipalForFinerCadence(uint256)` —
  threshold-only setter (numeraire unchanged).
- `ConfigFacet.setPreNotifyDays(uint8)` — range-bounded [1, 14].
  Used by both the maturity-pre-notify lane and the new
  periodic-checkpoint pre-notify lane.

### 5.2 New views

- `RepayFacet.previewPeriodicSettle(loanId)` — returns
  `(periodIndex, expected, paid, shortfall, graceEndsAt,
   estimatedCollateralToSell, estimatedSettlerBonus)`. Powers
  the loan-detail "Next checkpoint" countdown.
- `RepayFacet.nextPeriodCheckpoint(loanId)` — returns the
  upcoming checkpoint timestamp (zero if cadence is None).

### 5.3 New events

- `PeriodicInterestSettled(loanId indexed, periodIndex, shortfall,
   settler indexed)` — fires on just-stamp path with shortfall = 0.
- `PeriodicInterestAutoLiquidated(loanId indexed, periodIndex,
   shortfall, lenderProceeds, collateralSold, settler indexed)`
  — fires on auto-liquidate path.
- `PeriodicSlippageOverBuffer(loanId indexed, expectedShortfall,
   actualLenderProceeds)` — informational; lender got less than
  expected because slippage exceeded the buffer.
- `NumeraireUpdated(oldOracle, newOracle, newThreshold)` —
  fires on `setNumeraire` only.

### 5.4 New errors

- `PeriodicInterestDisabled()` — `periodicInterestEnabled` flag
  is off. Blocks `createOffer` (with non-`None` cadence) AND
  `settlePeriodicInterest`. Master kill-switch revert per §10.1.
- `CadenceNotAllowed(cadence, duration, principalNumeraire, threshold)`
  — Filter 1 / 2 violation.
- `CadenceNotAllowedForIlliquid(principalLiquidity, collateralLiquidity, cadence)`
  — Filter 0 violation. Either side illiquid and lender tried to
  set a cadence other than `None`.
- `PeriodicSettleNotDue(loanId, dueAt, graceEndsAt)`
- `NumeraireOracleInvalid(oracle)` — sanity check at setter time.
- `NumeraireSwapDisabled()` — `numeraireSwapEnabled` flag is
  off. Blocks `setNumeraire` (the batched setter). Threshold-
  only updates via `setMinPrincipalForFinerCadence` are NOT
  gated by this error.

## 6. Numeraire abstraction

Decoupling the principal-threshold from any specific currency. The
`numeraireOracle` config slot holds the address of an
`INumeraireOracle` impl whose only job is to report "how many USD
is 1 unit of the numeraire" (1e18-scaled).

### 6.1 Interface

```solidity
interface INumeraireOracle {
    /// @notice How many USD (1e18-scaled) is 1 unit of the numeraire?
    /// @dev USD-as-numeraire impl returns 1e18.
    ///      XAU-as-numeraire impl returns spot XAU/USD price.
    function numeraireToUsdRate1e18() external view returns (uint256);
}
```

### 6.2 Default behavior

`numeraireOracle == address(0)` → USD is the numeraire. Threshold
value is interpreted directly as USD-units (1e18-scaled). No
oracle call, no conversion. Identical to USD-direct behavior.

### 6.3 Conversion at offer creation

```
principalUsd1e18 = primaryOracle.priceInUsd(asset, amount)

if numeraireOracle == address(0):
    thresholdUsd1e18 = minPrincipalForFinerCadence
else:
    rate = INumeraireOracle(numeraireOracle).numeraireToUsdRate1e18()
    thresholdUsd1e18 = minPrincipalForFinerCadence × rate / 1e18

aboveThreshold = principalUsd1e18 >= thresholdUsd1e18
```

### 6.4 Atomic numeraire swap

The ONLY path to change the numeraire address is the batched
setter:

```solidity
function setNumeraire(
    address newOracle,
    uint256 newThresholdInNewNumeraire
) external onlyAdmin {
    // sanity checks: newOracle == 0 OR newOracle has bytecode AND
    // numeraireToUsdRate1e18() returns non-zero. Range-check
    // newThresholdInNewNumeraire.
    numeraireOracle = newOracle;
    minPrincipalForFinerCadence = newThresholdInNewNumeraire;
    emit NumeraireUpdated(oldOracle, newOracle, newThresholdInNewNumeraire);
}
```

No standalone `setNumeraireOracle(address)` — by construction
the numeraire only changes alongside a fresh threshold value in
the same tx. Inconsistent intermediate state is unreachable.

For threshold-only updates within the same numeraire, governance
calls `setMinPrincipalForFinerCadence(uint256)` separately.

### 6.5 Future USD-sweep (out of scope for T-034)

When KYC thresholds, fallback splits, etc. migrate onto the
numeraire abstraction, they extend `setNumeraire`'s arg list:

```
setNumeraire(newOracle, threshold, kycTier0, kycTier1, fallbackBonusBps, ...)
```

so every numeraire-denominated value flips atomically. Captured
in §11 #4.

## 7. Off-chain integration

### 7.1 Watcher pre-notify lane

`hf-watcher` already runs a maturity-pre-notify lane that pushes
3 days before loan `endTime`. Extend it to also fire 3 days
before each periodic checkpoint:

```sql
-- pseudo-SQL; actual D1 query lives in the watcher
SELECT loanId, lender, borrower, nextCheckpointAt, expectedAmount
FROM loans
WHERE status = 'Active'
  AND periodicInterestCadence != 'None'
  AND nextCheckpointAt BETWEEN now() AND now() + (preNotifyDays * 1 day)
  AND notNotifiedYet(loanId, periodIndex);
```

Push targets: borrower (priority — they need to act), lender
(courtesy). Single push channel, two recipients.

`preNotifyDays` is read from `getProtocolConfigBundle` once per
cron tick and applied to BOTH the maturity lane and the periodic
lane. Single source of truth.

### 7.2 Settlement notification lane

When `PeriodicInterestSettled` or `PeriodicInterestAutoLiquidated`
fires, the watcher's existing event-allow-list pipeline picks it
up and pushes:

- Just-stamp: lender push "Year 1 interest of N tokens received
  on loan #123."
- Auto-liquidate: lender push "Year 1 interest of N tokens
  received on loan #123 (collateral M sold to cover shortfall —
  HF now X)." Borrower push "Loan #123 — collateral was partially
  sold to cover this period's interest. HF is now X. You may want
  to top up collateral to avoid further sales."

### 7.3 Indexer schema additions

`activity_events` table (T-041 / T-041 Phase C-alt) adds new
event kinds: `PeriodicInterestSettled`,
`PeriodicInterestAutoLiquidated`, `PeriodicSlippageOverBuffer`.
Per-loan history page renders them inline with existing
LoanInitiated / RepayPartial / RepayFull events.

Loan summary endpoints (`/loans/by-lender/:addr`,
`/loans/by-borrower/:addr`, `/loans/:id`) gain three derived
fields:

- `cadenceLabel` — e.g. "Quarterly" / "Annual"
- `nextCheckpointAt` — unix seconds, computed from
  `lastPeriodicInterestSettledAt + intervalDays`
- `currentPeriodShortfall` — live `expected - paid` for the
  in-flight period

### 7.4 Keeper-bot (optional, follow-up)

The reference keeper bot in `vaipakam-keeper-bot` can add an
optional `PeriodicSettler` strategy that watches for
overdue-past-grace loans and submits `settlePeriodicInterest`
with a min-bonus filter. Out of scope for T-034 — bot ABI sync
captures the new selectors regardless (per CLAUDE.md's keeper-
bot ABI-sync workflow).

## 8. Frontend surface

### 8.1 Offer creation — Advanced mode

The cadence section is rendered ONLY when both the selected
lending asset AND the selected collateral asset classify as
liquid (per the existing `LiquidityStatus` derivation in
`OracleFacet`). When either side is illiquid, the entire
"Payment cadence" section is removed from the form — no
disabled control, no greyed-out dropdown, no tooltip — to avoid
suggesting that the option exists for illiquid loans.

When both sides are liquid, under the existing Advanced toggle
on `CreateOffer`:

```
Payment cadence:  [None ▼]
                  [None | Monthly | Quarterly | Semi-annual | Annual]

  ⓘ Multi-year loans (over 365 days) require at least Annual
    cadence by protocol policy. Larger loans (over $50,000 or
    equivalent) can opt into finer cadences.
```

Dropdown options dynamically filtered per the §3 matrix. Disabled
options carry tooltips explaining why ("Quarterly requires loan
to be longer than 90 days" / "Monthly requires principal of at
least $50k" / etc.).

If the lender selects a cadence, an explainer card surfaces
below:

```
[Cadence: Quarterly]
The borrower must pay at least the quarter's accrued interest
by each quarter-end. If they don't, after a 3-day grace period,
anyone can call a settlement function that sells just enough
collateral to cover the shortfall. The settler earns a small
bonus paid from the swap.

Read more in the [Periodic Interest Payment runbook ↗].
```

### 8.2 Offer acceptance — borrower-facing callout

`AcceptOffer` review screen surfaces the cadence with a
mandatory acknowledgement before the accept button is enabled:

```
☐ This offer requires Quarterly interest settlement. I
   understand that if I miss a payment for more than 3 days,
   my collateral can be partially sold to cover the shortfall.
```

Multi-year loans with Annual cadence show the same
acknowledgement text adjusted for "Annual / 2-week grace."

### 8.3 Loan detail — countdown + pay-now

`LoanDetails` page gains a "Next interest checkpoint" card:

```
┌──────────────────────────────────────────────────┐
│ Next interest checkpoint: in 12 days             │
│ Expected interest:        18.43 USDC             │
│ Paid this period:         5.00 USDC              │
│ Shortfall:                13.43 USDC             │
│                                                  │
│  [ Pay 13.43 USDC now ]                          │
│                                                  │
│ If unpaid by [date + grace], anyone can          │
│ trigger collateral sale to cover the shortfall.  │
└──────────────────────────────────────────────────┘
```

Powered by `previewPeriodicSettle(loanId)`. Card hidden when
cadence is `None`.

### 8.4 Protocol Console additions

Three new knob cards in the existing Protocol Console
(`/protocol-console`):

- `numeraireOracle` (Oracles category) — current oracle
  address + decoded `numeraireToUsdRate1e18()` for sanity check.
  Edit composes the `setNumeraire` calldata via Safe.
- `minPrincipalForFinerCadence` (Risk category) — current
  threshold value + the equivalent USD value (auto-computed via
  the configured numeraire oracle).
- `preNotifyDays` (Watcher category) — current value with range
  hint `[1, 14]`.

`settlerBonusBps` and `treasuryBonusBpsForPeriodicSettle` join
the existing Risk-category knobs for fallback splits etc.

### 8.5 Public docs

`docs/ops/AdminConfigurableKnobsAndSwitches.md` (mirrored at
`frontend/src/content/admin/`) gains a new Periodic Interest
Payment section covering: cadence enum, validation matrix,
grace mapping to T-044 slots, settler-fee mechanics, the
numeraire abstraction. Auditor-facing — describes policy intent
and operational ranges.

## 9. Backward compatibility & pre-launch

The protocol is pre-launch on mainnet; testnet has live offers
and loans that need clean handling at the cutover.

### 9.1 Storage migration

Pre-launch reorder is sanctioned (LibVaipakam.sol:690-696). The
new fields land in the new struct layout via diamondCut; testnet
offers/loans get cancelled-and-redone same as the Range Orders
Phase 1 cutover (per RangeOffersDesign §"Storage migration /
cutover").

For active testnet loans at cutover: cancel-all is unsafe (no
mechanic to preserve borrower funds mid-loan). Two options:
- (a) Run testnet to its natural terminal events (let loans
  repay or default) before the cutover. Requires a quiet
  testnet window.
- (b) Do a more involved migration that snapshots active loans
  off-chain, redeploys with cleared storage, and re-initiates
  loans with their original parameters. More work, more risk.

Recommend (a) — schedule the cutover for a window when active
loans have terminated.

### 9.2 Default values for existing loans (if (b) chosen)

If an active-loan migration is in scope, bootstrap rules:

- `periodicInterestCadence = None` for every existing loan.
  Borrower's terms don't change — they still pay terminal-only.
- `lastPeriodicInterestSettledAt = startTime` (cosmetic; never
  read because cadence is None).
- `interestPaidSinceLastPeriod = 0`.

This makes the migration backward-compatible: existing loans
behave exactly as today; only new loans created after the
cutover can carry a non-`None` cadence.

### 9.3 Frontend deploy lockstep

`CreateOfferParams` shape changes → frontend ABI must sync
(`bash contracts/script/exportFrontendAbis.sh`) and deploy
alongside the contract redeploy. Failure mode: an old frontend
calling a new contract sends a calldata-too-short tx that
reverts opaquely as "exceeds max transaction gas limit" on
public RPCs (per CLAUDE.md "Frontend ABI sync"). Sync-and-deploy
is mandatory.

Keeper bot ABI sync (`bash contracts/script/exportAbis.sh`)
also runs — the new event signatures need to land in
`vaipakam-keeper-bot`'s `src/abis/RepayFacet.json` so
existing detector code parses them cleanly even if no new
detector logic uses them yet.

## 10. Master kill-switches

### 10.1 `periodicInterestEnabled` — the feature master switch

Single boolean flag in `LibVaipakam.Storage`, default `false`,
flipped on by `ADMIN_ROLE` (later by governance). Gates the
ENTIRE Periodic Interest Payment mechanic:

- **Blocks `createOffer`** from accepting any cadence other
  than `None` (reverts `PeriodicInterestDisabled`). Lenders can
  still create offers — they just can't pick a cadence.
- **Blocks `settlePeriodicInterest`** entirely (reverts
  `PeriodicInterestDisabled`). No settler calls succeed.
- **Blocks the `repayPartial` interest-first fold and inline
  checkpoint advance.** While the flag is `false`, `repayPartial`
  reverts to today's allocation behaviour — no breakage of the
  status-quo path.
- **Frontend reads the flag from `getProtocolConfigBundle`** and
  hides the entire cadence section on `CreateOffer`, the
  acknowledgement on `AcceptOffer`, and the checkpoint card on
  `LoanDetails`. UI surfaces drop completely when the flag is
  off — no "feature coming soon" placeholder.

While `false`, the protocol behaves exactly as today: every
loan terminal-only, T-044 grace handles multi-year defaults,
no auto-liquidate path on interest. The feature ships dormant
and can be activated independently of any other rollout.

Setter: `ConfigFacet.setPeriodicInterestEnabled(bool)`. View:
exposed via `getProtocolConfigBundle` (existing aggregator).
Surfaces in Protocol Console under a new "Feature flags"
category alongside the RangeOffers `range*Enabled` /
`partialFillEnabled` flags.

### 10.2 `numeraireSwapEnabled` — guards the cross-numeraire batched setter

Separate flag, default `false`. Gates ONLY the
`setNumeraire(address, uint256)` batched setter — i.e. the
operation that swaps the numeraire address AND the threshold
value atomically. Threshold-only updates via
`setMinPrincipalForFinerCadence(uint256)` are NOT gated by this
flag — governance can tune the threshold within the same
numeraire without unlocking swap.

Rationale: the numeraire abstraction can ship inert (USD =
default), with the threshold tunable for the lifetime of the
deploy. The swap surface is a separate governance decision,
unlocked only when there is a real swap on the table (e.g. a
specific XAU oracle deployed and audited).

Setter: `ConfigFacet.setNumeraireSwapEnabled(bool)`. Surfaces
in Protocol Console under "Feature flags" alongside the master
switch.

### 10.3 Both flags follow the established T-044 / RangeOffers pattern

`onlyRole(ADMIN_ROLE)` setters; matching `view` getters in
`getProtocolConfigBundle` so the frontend `useProtocolConfig`
hook picks them up; consistent emit-on-toggle event for
observability. Same pattern as RangeOffers' three flags (§15 of
that doc) and T-044's grace-bucket admin surface.

## 11. Decisions locked + remaining unknowns

### 11.1 Locked

1. **Settler / treasury split — reuse the existing liquidation
   policy.** Settler bonus = `max(0, slippageCapBps -
   realizedSlippageBps)`, capped at 3% (`LIQUIDATOR_BONUS_CAP_BPS
   = 300`). Treasury share = flat 2% (`LIQUIDATION_TREASURY_BPS
   = 200`). Lender gets the rest. No new BPS knobs in T-034. Per
   `docs/FunctionalSpecs/ProjectDetailsREADME.md` §"Equivalent
   Collateral Transfer for Liquid Asset during Abnormal Periods".
2. **Slippage cap.** Reuses the existing
   `maxLiquidationSlippageBps` knob — currently 6%, governance-
   tunable, range `[100, 2000]` (1%-20%). No T-034-specific
   slippage knob.
3. **`minPrincipalForFinerCadence` default.** $100,000 in
   numeraire-units (`100_000e18`). Range `[1_000e18,
   10_000_000e18]`. Admin-tunable now → governance-tunable
   later.
4. **`preNotifyDays` default.** 3. Range `[1, 14]`. Single knob
   shared between maturity pre-notify and periodic-checkpoint
   pre-notify.
5. **Post-liquidation HF threshold.** Dropped. The auto-
   liquidate path emits its event and advances the checkpoint;
   the existing hf-watcher + permissionless `triggerLiquidation`
   lane handles any post-sale HF degradation in a separate tx
   if needed. No new threshold tunable.
6. **Repay-fold + interest-first.** `repayPartial` allocates
   payments interest-first: accrued interest covered before any
   principal reduction. Period checkpoint auto-advances inline
   when interest portion closes the period's expected total AND
   block.timestamp has crossed the period boundary. Three-layer
   user communication — preview view, detailed event,
   post-tx state reads — per §4.5.
7. **Refinance — new lender's cadence wins.** Cadence is a
   property of the new lender's offer; new loan adopts it.
   Consistent with how interest-rate / duration / principal
   already work on refinance.
8. **Frontend cadence dropdown for >365d.** `None` is NOT
   shown as an option. First option `Annual`, auto-selected.
   Lender can change to finer cadences if qualified, but
   cannot pick None. Eliminates any path to an invalid offer
   reaching the contract.
9. **Liquid-both precondition (Filter 0).** Periodic interest
   applies ONLY when both lending and collateral assets are
   liquid. Frontend hides the cadence section entirely when
   either side is illiquid (no disabled control). Contract
   reverts `CadenceNotAllowedForIlliquid` if a directly-crafted
   tx tries to set a non-`None` cadence on an illiquid offer.
   Defense-in-depth on both surfaces. Multi-year illiquid loans
   do NOT get the mandatory annual floor — lender accepts that
   trade-off when accepting an illiquid offer.
10. **Master kill-switch flag.** New
    `periodicInterestEnabled` flag in storage, default `false`,
    `ADMIN_ROLE` setter (later governance). Gates the entire
    feature: blocks `createOffer` from accepting non-`None`
    cadence, blocks `settlePeriodicInterest`, blocks the
    `repayPartial` interest-first fold + inline advance, AND
    causes the frontend to hide every cadence-related UI surface.
    Feature ships dormant; activated by a single governance flip
    when ready. Surfaces in Protocol Console under a new
    "Feature flags" category alongside the RangeOffers flags.
    Companion flag `numeraireSwapEnabled` (default `false`)
    independently gates the cross-numeraire batched setter so
    USD-as-numeraire stays the only reachable behaviour until a
    real numeraire swap is on the table. See §10 for the full
    behavior matrix.

### 11.2 Remaining unknowns (non-blocking — resolved at impl time)

1. **Existing maturity-pre-notify Worker lane.** Need to find
   the hard-coded 3-day value in `hf-watcher` during
   implementation and replace with the new `preNotifyDays`
   config read.
2. **`LIQUIDATOR_BONUS_CAP_BPS` and `LIQUIDATION_TREASURY_BPS`
   constant locations.** Need to verify the exact names in the
   codebase (or introduce them if today's liquidation path
   inlines the literals 300 / 200). Either way, T-034 reads
   from these constants — does not introduce its own.
3. **`maxLiquidationSlippageBps` storage location.** Need to
   verify where the 6% slippage cap lives in storage vs. as a
   compile-time constant; if compile-time-only today, T-044's
   precedent says we promote it to a bounded admin-tunable knob
   in the same PR.

## 12. Phasing

Three sequential PRs, target ~3-4 weeks bundled. Lands AFTER
Range Orders Phase 1 completes (per the parallel-design
agreement).

### PR1 — Storage + numeraire abstraction + cadence enum

- `Loan` struct + `Offer` struct + `CreateOfferParams` field
  additions per §2.
- `PeriodicInterestCadence` enum + `intervalDays` library
  helper.
- `INumeraireOracle` interface + `IdentityNumeraireOracle`
  default impl (returns 1e18, USD-as-numeraire).
- `ConfigFacet.setNumeraire` (atomic batched setter) +
  `setMinPrincipalForFinerCadence` + `setPreNotifyDays` +
  `setSettlerBonusBps` + `setTreasuryBonusBpsForPeriodicSettle`.
  All bounded.
- Two kill-switch flags + getters in
  `getProtocolConfigBundle`.
- `OfferFacet.createOffer` validation per §3 matrix (active
  only when `periodicInterestEnabled == true`; otherwise
  reverts on any non-`None` cadence).
- `OfferFacet.acceptOffer` snapshots cadence onto loan +
  stamps `lastPeriodicInterestSettledAt`.

PR1 ships clean: no settle entry point yet; offers can be
created with cadences but no settlement is ever required (the
borrower repays terminal-only same as today). Lets the
governance + UI lanes ramp without exposing the settle path.

### PR2 — Settlement entry point + repay-fold + refinance settle-first

- `RepayFacet.settlePeriodicInterest(loanId)` per §4.3.
- `RepayFacet.previewPeriodicSettle` + `nextPeriodCheckpoint`
  views.
- `_maybeAdvancePeriodCheckpoint` helper folded into
  `repayPartial` and `repayLoan` per §4.5.
- `RefinanceFacet.refinanceLoan` settle-first guard per §4.6.
- New events + errors per §5.3 / §5.4.
- Comprehensive test plan per §13.

### PR3 — Watcher + frontend + protocol console

- `hf-watcher` D1 schema additions (cadence, nextCheckpointAt,
  currentPeriodShortfall on the loans table).
- Watcher pre-notify lane extension (read `preNotifyDays` from
  bundle; query loans table for upcoming checkpoints).
- Watcher settlement-notification lane (subscribe to new
  events).
- Frontend offer creation + acceptance + loan detail UI per §8.
- Protocol Console knob cards.
- Public docs section in
  `docs/ops/AdminConfigurableKnobsAndSwitches.md` + locale
  mirrors.

## 13. Test plan

### 13.1 Contract tests

New test files in `contracts/test/`:

- `PeriodicInterestCadenceValidation.t.sol` — every cell of the
  §3 validation matrix, including Filter 1 edge cases at
  duration boundaries (29d / 30d / 31d / 89d / 90d / 91d / etc.).
- `PeriodicInterestSettleStamp.t.sol` — just-stamp path. Borrower
  pays in time → stamp advances → no settler fee.
- `PeriodicInterestSettleAutoLiquidate.t.sol` — auto-liquidate
  path. Various shortfall sizes; HF post-liquidation; treasury
  + settler accounting; slippage-over-buffer event emission.
- `PeriodicInterestRepayFold.t.sol` — borrower's `repayPartial`
  crosses a period boundary → checkpoint auto-advances inline.
- `PeriodicInterestRefinance.t.sol` — refinance settle-first
  guard; cadence change on refinance.
- `PeriodicInterestMultiPeriodCatchup.t.sol` — multiple
  consecutive `settlePeriodicInterest` calls advance one
  period each.
- `PeriodicInterestKillSwitch.t.sol` — flag-off blocks
  `createOffer` cadence != None AND
  `settlePeriodicInterest` reverts.
- `NumeraireOracleSetters.t.sol` — atomic `setNumeraire`;
  threshold-only setter; sanity checks
  (`numeraireOracleInvalid`); kill-switch gating.
- `NumeraireConversion.t.sol` — USD-as-numeraire (zero address)
  vs XAU-mock numeraire — threshold gating works correctly under
  both.

Existing tests (RepayFacet, RefinanceFacet, OfferFacet
acceptance + creation paths) get cadence-aware test cases
added per the "mechanical rename" pattern from RangeOffers PR1.

### 13.2 Frontend tests

- Cadence dropdown filtering — Vitest unit test against the
  matrix-derived helper.
- Offer-creation validation — RTL test that the disabled
  cadence options carry the right tooltips.
- Loan-detail countdown rendering — RTL with mocked
  `previewPeriodicSettle`.
- Protocol Console knob cards — existing `KnobCard` test
  pattern extended for the three new knobs.

### 13.3 Watcher tests

- Pre-notify lane query test (in-memory D1) — stub a loan
  3 days before checkpoint, confirm push fires.
- De-dup test — same checkpoint doesn't push twice within a
  single cron window.
- Settlement-notification test — fixture `PeriodicInterestSettled`
  event triggers the right push payload.

### 13.4 E2E (testnet)

Smoke run on Sepolia after the cutover:
1. Create lender offer with Quarterly cadence + accept.
2. Wait through one quarter (or fast-forward block.timestamp).
3. Borrower pays partial < expected → settler call →
   auto-liquidate → confirm collateral sale + lender
   credited + settler bonus paid.
4. Borrower pays full expected before next quarter → settler
   call → just-stamp.
5. Refinance the loan crossing a period boundary → confirm
   settle-first triggers.

## 14. Critical files

**New:**
- `contracts/src/libraries/LibPeriodicInterest.sol` — interval
  lookup, period-arithmetic helpers, settle-fee computation.
- `contracts/src/interfaces/INumeraireOracle.sol` — single-method
  interface.
- `contracts/src/oracles/IdentityNumeraireOracle.sol` — default
  impl returning 1e18; USD-as-numeraire.
- Test files per §13.1.

**Edits:**
- `contracts/src/libraries/LibVaipakam.sol` — `Loan`,
  `Offer`, `CreateOfferParams` field additions; cadence enum
  + intervalDays helper; `ProtocolConfig` storage additions;
  kill-switch flags.
- `contracts/src/facets/OfferFacet.sol` — `createOffer`
  validation per §3.
- `contracts/src/facets/RepayFacet.sol` — new entry point +
  views + repay-fold helper.
- `contracts/src/facets/RefinanceFacet.sol` — settle-first
  guard.
- `contracts/src/facets/ConfigFacet.sol` — atomic
  `setNumeraire` + companion setters; kill-switch setters.
- `frontend/src/pages/CreateOffer.tsx` — cadence dropdown.
- `frontend/src/pages/OfferDetails.tsx` (and accept flow) —
  acknowledgement checkbox.
- `frontend/src/pages/LoanDetails.tsx` — countdown card.
- `frontend/src/lib/protocolConsoleKnobs.ts` — new knob
  catalogue entries.
- `ops/hf-watcher/src/index.ts` (or wherever the maturity
  pre-notify lane lives) — extend to periodic checkpoints.
- `docs/ops/AdminConfigurableKnobsAndSwitches.md` + locale
  mirrors — new section.
- `docs/ReleaseNotes/ReleaseNotes-2026-05-02.md` — extend the
  existing T-034 entry with PR-by-PR functional summaries as
  each PR lands.

## Sources & prior art

- T-044 admin-configurable grace schedule:
  [`ReleaseNotes-2026-05-02.md` § "T-044"](../ReleaseNotes/ReleaseNotes-2026-05-02.md#t-044--admin-configurable-loan-default-grace-schedule).
- T-041 chain indexer + activity events:
  [`ReleaseNotes-2026-05-02.md` § "T-041"](../ReleaseNotes/ReleaseNotes-2026-05-02.md#t-041--shared-chain-indexer-worker-offers-loans-activity-claimables).
- T-033 Pyth-as-numeraire-redundancy:
  [`ReleaseNotes-2026-05-02.md` § "T-033"](../ReleaseNotes/ReleaseNotes-2026-05-02.md#t-033-pyth-as-numeraire-redundancy--project-wide-setter-range-audit).
  Sets the precedent for `INumeraireOracle` shape — same
  single-feed-per-chain pattern, same range-bound discipline on
  the setter.
- Phase 7a 4-DEX swap failover infrastructure: the auto-
  liquidate collateral-sale path reuses `LibSwap` directly.
- Bond-finance "coupon" terminology was considered and rejected
  in favor of "Periodic Interest Payment" for explicitness.
