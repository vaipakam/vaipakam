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

### The counter-divergence sub-bug — OUT OF SCOPE (resolved by r2)

`RepayFacet.sol:431` derives `alreadyDeductedDays = (lastDeductTime − startTime)/
ONE_DAY`, but `repayPartial` decrements `durationDays` **without advancing
`lastDeductTime`** (`RepayFacet.sol:924-927`), while `autoDeductDaily` advances
both (`RepayPeriodicFacet.sol:215-219`). So after a partial repay,
`undeductedDays = elapsedDays − alreadyDeductedDays` **over-counts** the still-owed
days — a pre-existing bug in the *elapsed-interest* path. Because the ratified S8
fee base is `principal × durationDays` (not `undeductedDays`), **S8 does not
depend on this counter** and the fix is deferred to an independent follow-up. See
the design reversal below.

The draft (r1) flipped the base to "overdue elapsed days" and folded in a
`lastDeductTime` advance to fix the counter. **Codex r2 (P1) inspected the code
and refuted that flip:** the NFT `repayPartial` path recomputes the ERC-4907
renter expiry from `startTime + durationDays × ONE_DAY` after decrementing
`durationDays` — so it **retires rental term**, it does NOT pre-pay future
calendar days. Advancing `lastDeductTime` on top of that would give the borrower
both a shortened expiry AND delayed auto-deductions, mixing two accounting models.
So the r1 flip is **reverted**: the design returns to the `durationDays` base and
does **not** touch `lastDeductTime` or add a paid-days counter.

Under term-retirement semantics, `durationDays` **is** the remaining-owed rental
term (both `autoDeductDaily` and `repayPartial` retire it), so `principal ×
durationDays` is the correct overdue-obligation base — reliably maintained by both
paths, no new counter. This also matches the merged plan §6 ("5% of total rental,
`principal × durationDays`") and, critically, aligns with the **buffer** (below).
The separate `undeductedDays`/`lastDeductTime` divergence affects only the
elapsed-*interest* computation (`RepayFacet.sol:443`) and is filed as an
**independent follow-up** — S8 no longer depends on it.

### Design — fee base = remaining rental term, funded from the buffer

**(1) The base.** Add `LibVaipakam.calculateRentalLateFee(loanId, endTime)`:

```solidity
uint256 base = loan.principal * loan.durationDays;   // remaining owed rental (term-retirement model)
return (base * feePercent) / 10000;                  // same slope; cap = 5% of remaining rental
```

Only the **NFT-rental branch** of `RepayFacet.repayLoan` switches to the new
helper; the ERC-20 branch and every other `calculateLateFee` caller
(`DefaultedFacet`, `RiskFacet`, `SwapToRepay*`, `AutoLifecycleFacet`,
`RiskSplitLiquidationFacet`, `LibSwapToRepayIntentSettlement`) stay on the
existing helper unchanged — ERC-20/collateral paths where `loan.principal` is
already the correct base.

**(2) Fund the late fee from `bufferAmount`, not `prepayAmount` (Codex r2 P1).**
The rental repay branch currently checks `interest + lateFee <= loan.prepayAmount`
(`RepayFacet.sol:446-447`), but the 5% rental buffer is stored **separately** in
`loan.bufferAmount` (`LibVaipakam.sol:1810`). With the larger fee base, a
full-term late rental has `interest == prepayAmount`, so **any** positive
`lateFee` would revert `InsufficientPrepay` before the buffer could cover it —
S8 would *brick* late full-term rental repayment. The buffer exists for exactly
this: `bufferAmount = RENTAL_BUFFER_BPS(5%) × principal × originalDurationDays`
(set at accept). So:

- Draw `interest` from `prepayAmount`, `lateFee` from `bufferAmount`.
- Check `interest <= prepayAmount` **and** `lateFee <= bufferAmount` (equivalently
  `interest + lateFee <= prepayAmount + bufferAmount` with the split enforced).
- Refund the borrower any unused `prepayAmount` **and** unused `bufferAmount`.

**The cap and the buffer are exactly matched:** the fee cap is `5% × principal ×
durationDays` and `bufferAmount ≥ 5% × principal × durationDays` (buffer sized on
the original term ≥ remaining term), so the buffer always covers the capped fee —
this is *why* the `durationDays` base is the right one, not a coincidence.

**(3) The quote path too (Codex r1 P2).** `RepayFacet`'s public quote/preview
(`repaymentAmount` / `calculateRepaymentAmount`, the `calculateLateFee` caller at
`RepayFacet.sol:1032`) must switch to `calculateRentalLateFee` on the rental
branch as well, or a late-rental preview would quote a lower fee than settlement.
Execution and quote move together.

**Why a new helper, not a branch inside `calculateLateFee`:** the shared helper
has ~10 callers; widening its contract to "sometimes multiply by durationDays"
risks a wrong base on a collateral-liquidation path. A named rental helper keeps
the rental semantics local to the two rental callers (execute + quote) and is
self-documenting.

### Edge cases

- `block.timestamp <= endTime` → fee 0 (unchanged guard, first line of helper).
- `durationDays == 0` → base 0 → fee 0. `autoDeductDaily` closes the rental
  (`Repaid`) at `durationDays == 0` (`RepayPeriodicFacet.sol:238`), so a still-open
  late rental has `durationDays > 0`.
- Full-term late rental with `interest == prepayAmount`: the fee is fully covered
  by `bufferAmount` (the core P1-buffer case) — must NOT revert `InsufficientPrepay`.
- `repayPartial`-then-late: `durationDays` already reflects the retired term, so
  the fee bases on the correct remaining rental with **no** counter needed.
- EIP-170: `RepayFacet` is a god-facet near the ceiling. The helper lives in
  `LibVaipakam` (inlined into callers). Verify `RepayFacet` stays under 24,576
  after the change (measure; if tight, dedupe the shared `feePercent` slope into a
  private `_lateFeePercent(endTime)` both helpers call).

### Test plan (`RepayFacetTest.t.sol`)

- Late rental fee scales with the remaining rental (`principal × durationDays`).
- **Buffer funding:** a full-term late rental (`interest == prepayAmount`, positive
  `lateFee`) settles by drawing the fee from `bufferAmount` and does NOT revert
  `InsufficientPrepay`; unused buffer refunded.
- Cap binds at 5% of `principal × durationDays`, and the buffer covers it exactly.
- ERC-20 late fee unchanged (regression).
- `repayPartial`-then-late bases the fee on the reduced `durationDays` (no
  `lastDeductTime` touched; auto-deduct cadence + ERC-4907 expiry unchanged).
- Quote/preview (`repaymentAmount`) equals settlement for a late rental.

### Blast radius / ABI

New internal library function + a buffer-funded late-fee split in the
`RepayFacet` rental branch (execute + quote). **No `lastDeductTime` change, no new
struct field**, no facet selector change → **no ABI re-export, no diamond cut**.
Facets touched: `RepayFacet` + `LibVaipakam`. The buffer-funding change is
fund-affecting on the rental repay path — covered by the buffer-funding test above
and the existing rental repay suite.

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
- **Option B — a dedicated mapping storing the FROZEN CLAIMANT ADDRESS**
  *(recommended; upgraded from a bitfield per Codex r2 P1)*:
  `mapping(uint256 => address) sanctionsLockedLenderClaimant;` and
  `mapping(uint256 => address) sanctionsLockedBorrowerClaimant;` in Storage
  (`address(0)` = not locked; a single loan can lock both sides). Storing the
  **address** (not just a bit) is load-bearing — see the transfer-during-outage
  hole below. *Pro:* no existing struct changes, no claim-view ABI churn. *Con:*
  two new mappings.

Recommend **Option B** — it isolates the new state, avoids touching the
ABI-exposed `ClaimInfo`, and stores the frozen claimant per side.

**Why the address, not a bit (Codex r2 P1 — the laundering hole).** A bit-only
marker + "current `msg.sender` is clean" release check is bypassable: the position
NFT transfer gate (`VaipakamNFTFacet.transferFrom`/`safeTransferFrom`) uses the
**fail-open** `_assertNotSanctioned`. So a confirmed-flagged holder with locked
proceeds can, *during an oracle outage*, transfer the position to a clean wallet;
when the oracle recovers (with the original holder still flagged), the clean
current holder claims and the bit-only check releases the funds **without ever
proving the frozen claimant was delisted**. Storing the frozen claimant address
and re-checking **that** address fail-closed at release closes it: marked proceeds
release only once the *recorded frozen claimant* is proven clean, regardless of
who now holds the NFT. (Alternative — make marked-position transfers fail-closed —
is heavier: it touches the hot NFT-transfer path. The address-check is local to
the claim.)

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
(the party that would otherwise have received it), and when true **record that
address** in `sanctionsLockedLenderClaimant[loanId]` / `...Borrower...[loanId]`.
This is the same party the existing "deposit to stored party when current holder
is flagged" fallback already keys on — the marker piggybacks on that decision
rather than on the credited-vault owner. The side (lender/borrower) selects which
mapping.

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
after resolving the claim, branch on the stored frozen claimant for that side:

```solidity
address frozen = sanctionsLockedClaimant(loanId, side);   // address(0) if not locked
if (frozen != address(0)) {
    // Confirmed-locked proceeds: release only once the RECORDED frozen claimant
    // is proven clean (fail-closed) — not merely the current msg.sender.
    LibVaipakam.assertNotSanctionedFailClosed(frozen);
} 
LibVaipakam._assertNotSanctioned(msg.sender);             // always: ordinary fail-open screen on the caller
```

The ordinary fail-open screen on `msg.sender` stays (a caller flagged after a
clean park is still caught while the oracle is up); the **additional** fail-closed
screen on the recorded `frozen` claimant is what a marked release must also pass.

**Clear the marker** on a successful clean release (the fail-closed screen passed
⇒ oracle up and the frozen claimant de-listed), so a later re-lock is possible and
the slot doesn't leak. Clear only the side being claimed.

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

**Every locked-park caller must set the marker (Codex r2 P2).** The marker is
keyed by side + intended claimant, so `LibSanctionedLock`'s park helpers
(`depositLocked`, `getOrCreateVaultLocked`, `end`) — whose current inputs are
`(owner, loanId, asset, amount)` — must gain a **`side` + `intendedClaimant`**
parameter (or a variant), and **all** current call sites must pass it, else those
deposits stay unmarked and release fail-open during an outage. The park callers to
update (from the scout's call-site census):

- `RepayFacet` (repay close-out), `DefaultedFacet` (default close-out),
  `RiskFacet` (HF liquidation), `RiskSplitLiquidationFacet` (split liquidation),
  `RiskMatchLiquidationFacet` (internal-match), `EarlyWithdrawalFacet`,
  `PrecloseFacet`, and the fallback-distribution paths in `ClaimFacet`
  (`_distributeFallbackCollateral` / retry proceeds) + `LibCloseoutFreeze` +
  `LibSwapToRepayIntentSettlement`.

For each: determine the **intended claimant** for the parked side (the current
position-NFT holder the payout is for) and pass it so the marker records the right
frozen address. Sites that park a party's OWN move-out (not a sanctioned-recipient
freeze) don't set a marker — only the affirmative-flag deposits do.

New Storage mappings + new set/clear + the helper signature change across
`LibSanctionedLock` and its callers + the two claim release gates. Reuses the
existing `SanctionsOracleUnavailable` error (on `VaultFactoryFacet`) — **verify it
is on `ClaimFacet`'s ABI surface**; if not, adding it triggers a ClaimFacet ABI
re-export. No struct-shape change (Option B — mappings). Storage-layout: appending
mappings is append-only (pre-live, no migration). **This is the widest-blast-radius
item of the three** — the helper-signature change ripples to ~10 facets; it may
warrant splitting the mechanical caller-threading from the release-gate logic
within the S10 PR.

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

**Shared internal — a non-reverting check core + a reverting assert wrapper
(Codex r2 P2).** `LibOfferMatch.previewIntent` is a **structured, non-reverting**
preview API returning `IntentError` codes (e.g. `SliceCollateralBelowFloor`), and
its ordering must mirror `matchIntent`; a shared helper that *reverts* with
`MinCollateralBelowFloor` would break the preview-vs-execute agreement and every
solver/preflight caller. So the extraction is two-layer:

- `LibOfferBounds.checkOfferBounds(...) → (bool ok, BoundsFail reason)` — the pure,
  **non-reverting** math (floor/ceiling via `LibRiskMath`), taking amount/amountMax/
  collateral + asset legs + a `skipCeiling` flag (sale-vehicle create exemption).
- `_assertOfferBounds(...)` — a thin **reverting** wrapper over the core, used by
  `OfferCreateFacet` and `OfferMutateFacet` (reverts `MinCollateralBelowFloor` /
  `MaxLendingAboveCeiling`).
- `LibOfferMatch` (both `matchIntent` execution and `previewIntent`) calls the
  **non-reverting core** and maps `BoundsFail` → the existing `IntentError`
  (`SliceCollateralBelowFloor` / the ceiling equivalent), preserving the structured
  preview contract. One math definition ⇒ create/mutate/match/preview can never
  drift, and the preview stays non-reverting.

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
- **Liquid tier-0 in TIERED mode = no-borrow, not a finite bound (Codex r2 P2).**
  Passing `LibRiskMath`'s finite tier-0 floor/ceiling through is **not** equivalent
  to the tiered init gate: when `depthTieredLtvEnabled` is on,
  `effectiveTierMaxInitLtvBps(0) == 0` and `LoanFacet._checkInitialLtvAndHf`
  **rejects any positive LTV** for tier-0 collateral. If the shared bound treats
  `LibRiskMath`'s finite HF-derived tier-0 ceiling as binding, a *thick-enough*
  liquid tier-0 ERC-20 offer passes create/mutate but still fails at acceptance —
  breaking the fail-fast parity S15 promises. **In tiered mode the offer bound must
  treat effective tier-0 collateral as no-borrow (ceiling 0 → reject any positive
  borrow).** Implementation must confirm whether `maxLendingForCollateral`'s
  init-LTV-cap clamp already yields 0 for tier-0 in tiered mode (scout: it clamps
  DOWN to the init-LTV-cap ceiling — if the cap is 0 the ceiling is 0) or whether an
  explicit tier-0 guard is needed; the bound must match `effectiveTierMaxInitLtvBps
  (0)==0`. In **non-tiered** mode, liquid tier-0 keeps its finite HF-derived bound.
  Tests: (a) tiered — a liquid tier-0 borrow offer is rejected at create AND mutate
  regardless of thickness; (b) non-tiered — a thin liquid tier-0 offer is rejected
  by the finite bound, a well-collateralized one passes.
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
  `reqColl` below the floor is rejected by the re-keyed `LibOfferMatch` check —
  AND `previewIntent` still returns the `SliceCollateralBelowFloor` code (does NOT
  revert), preserving preview-vs-execute agreement.
- **Tiered liquid tier-0:** a liquid tier-0 borrow offer is rejected at create and
  mutate regardless of collateral thickness (matches `effectiveTierMaxInitLtvBps(0)
  ==0`). **Non-tiered liquid tier-0:** thin rejected by finite bound, thick passes.
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

## Open questions for reviewers (post-r2)

1. **S8 semantics — RESOLVED (Codex r2).** Rental `repayPartial` is
   **term-retirement** (recomputes ERC-4907 expiry), not calendar-prepay → S8
   bases the fee on `principal × durationDays`, funds it from `bufferAmount`, and
   touches neither `lastDeductTime` nor a new counter. The elapsed-interest
   counter divergence is an independent follow-up.
2. **S10:** the marker now stores the **frozen claimant address** per side (Option
   B, address-valued) and the release re-checks that address fail-closed. Confirm
   the address-check (vs making marked-position transfers fail-closed) is the
   preferred boundary. And: the fail-closed screen also applies to the backstop
   `nftOwner` screen (`_claimViaBackstopImpl`) when the marker is set.
3. **S15:** keep `rangeAmountEnabled` as inert dead-config (recommend) vs remove
   it now? (r1/r2 resolved the HF-basis, range-shape-key, preview, and tier-0
   questions.)
