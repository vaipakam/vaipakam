# ADR-0003: Time-weighted accumulator for VPFI fee discounts

**Status:** Accepted — **borrower half superseded by #1352** (2026-07-20);
**loan-window averaging superseded by T-087 Sub 1.B** (recorded #1981,
2026-08-31)
**Date:** 2026-04-23 (Phase 5 implementation date; ADR backfilled 2026-05-20)

> **Supersession note (T-087 Sub 1.B, recorded in #1981).** The core
> decision this ADR records — that a discount must not be sampled from a
> spot balance — still stands. What no longer holds is the **mechanism**:
> the per-loan averaging described below, anchored at origination and
> averaged across each loan's own lifetime, was removed. Fee application
> now resolves the party's effective tier at the moment the fee is
> charged, and the anti-gaming property lives in how that tier is
> derived — a minimum staked duration, a recency-weighted average over a
> trailing window (governance-bounded 14–30 days, default 30, floored at
> the day the current stake began), and a clamp to the lowest tier
> reached in that history. The per-loan anchors (`lenderDiscountAccAtInit`,
> `borrowerDiscountAccAtInit`) survive only as storage slots — nothing
> writes them and nothing reads them, so every loan opened since carries
> zero there.
>
> Against the vector this ADR was written for — a top-up shortly before
> settlement — the replacement is **stricter**, not a relaxation: an
> average over a loan can be pulled up by a late top-up, whereas a
> minimum over the history cannot, and the daily minimum is recorded so a
> same-day dip counts.
>
> It is **not** stricter in every respect, and this note asserted that it
> was until #1981 r2. The lowest-tier history is capped at the ring
> buffer's 30 days, so a long loan's early low-tier period rolls out of
> it, where the loan-lifetime average this ADR chose retained it for the
> whole term: on a 100-day loan with 70 low-tier days followed by 30
> high-tier days, today's rule can resolve the high tier and the recorded
> one could not. Stronger defence, shorter memory — the trade is stated
> here rather than elided, since this ADR is where someone would come to
> weigh restoring the original design.
>
> This ADR is left otherwise unedited: it is the record of a decision as
> it was taken. The current behaviour is described in the whitepaper
> §12.4 and in `CLAUDE.md`'s VPFI fee-discount section.

> **Supersession note (#1352, rev-8 fee freeze).** The decision recorded
> here — that a discount must be time-weighted rather than sampled at a
> point in time — still stands, and the **lender** yield-fee half is
> unchanged and current. The **borrower** half described below is not how
> new loans work: #1352 retired the peg-custody path, so a new loan takes
> no VPFI into custody and earns no settlement rebate. The borrower's
> hold-tier discount is now applied directly to the lending-asset LIF at
> acceptance, resolved from the live tier at that moment. Loans opened
> before the freeze still settle through the flow described here.
>
> The fee rates quoted below (0.1% LIF, 1% yield fee) are the rates in
> force when this ADR was written. The live rates are **0.2%** and
> **2%**, and any discount is clamped at a uniform 50% of the gross fee.

## Context

The VPFI protocol token grants the holder a tiered discount on the
two protocol fees:

- **Lender yield-fee discount** — reduces the treasury haircut on
  interest at settlement.
- **Borrower Loan Initiation Fee (LIF) discount** — delivered as a
  VPFI rebate at `claimAsBorrower`.

A naive implementation would look up the borrower's VPFI tier
**at one point in time** (e.g. at loan init) and apply that tier's
discount to the whole loan. That implementation has a clear gaming
vector: a user stakes a large VPFI balance immediately before
accepting (or being accepted into) a loan, qualifies for the top
discount tier, then unstakes the next block — keeping the top-tier
discount for the full loan duration while no longer carrying any
VPFI stake.

The pre-Phase-5 stamping logic was vulnerable to a related gaming
shape: it re-stamped the user's BPS at the **pre-mutation** balance
when an event occurred. That let a user drop to tier 0 (unstake)
and still carry the pre-drop tier stamp until the next balance
event. Effectively the same exploit class — keep a high-tier stamp
without holding the stake.

A second concern: at loan termination via default or HF-based
liquidation, granting the borrower a fee rebate is wrong — they
defaulted. Forfeiture to treasury is the right behaviour, but it
needs to be enforced rather than relied on through "we'll fix it
manually".

## Decision

Adopt a **time-weighted accumulator** for the VPFI tier discount,
re-stamped on every balance mutation at the **post-mutation
balance**, and a **claim-based rebate** for the borrower LIF that is
forwarded to treasury on default / liquidation.

Specifically:

1. **`LibVPFIDiscount.rollupUserDiscount`** re-stamps the discount
   BPS at the *post-mutation* vault VPFI balance on every change
   (deposit, withdraw, buy, terminal flows). This makes an unstake
   take effect immediately for every open loan's running average —
   the high-tier window only lasts as long as the high-tier balance
   actually exists.

2. **Borrower LIF — Phase 5 four-stage flow:**
   - **At `OfferFacet.acceptOffer` on the VPFI path**: borrower
     pays the FULL 0.1% LIF equivalent in VPFI (not tier-discounted)
     from their vault into **Diamond custody** (not treasury).
     Amount recorded in `s.borrowerLifRebate[loanId].vpfiHeld`.
   - **At proper settlement** (`RepayFacet` terminal,
     `PrecloseFacet` direct + offset, `RefinanceFacet`):
     `LibVPFIDiscount.settleBorrowerLifProper(loan)` splits
     `vpfiHeld` into a rebate (`vpfiHeld × avgBps / BPS`) and a
     treasury share. Rebate stored in `s.borrowerLifRebate[loanId]
     .rebateAmount`.
   - **At default / HF-liquidation** (`DefaultedFacet.markDefaulted`,
     `RiskFacet` HF-terminal): `LibVPFIDiscount.forfeitBorrowerLif
     (loan)` forwards the full held amount to treasury. No rebate.
   - **At claim**: `ClaimFacet.claimAsBorrower` pays out the rebate
     in VPFI atomically with the normal collateral claim.

3. **Mainnet invariants** to preserve:
   - Every proper-close terminal path MUST call
     `LibVPFIDiscount.settleBorrowerLifProper(loan)`.
   - Every default / liquidation terminal path MUST call
     `LibVPFIDiscount.forfeitBorrowerLif(loan)`.
   - Loan struct `borrowerDiscountAccAtInit` is snapshotted in
     `LoanFacet._snapshotBorrowerDiscount` at loan-init; do not
     bypass.
   - Diamond holds the custody VPFI until terminal; no
     intermediate transfer. A leaked `vpfiHeld` (non-zero on a
     Settled loan) is a bug.

## Consequences

**Positive**

- The time-average correctly reflects what the user actually held,
  not a point-in-time snapshot at a convenient moment.
- The gaming vector closes — unstaking immediately reduces the
  running average for every open loan, so brief-stake / unstake
  exploits have no payoff.
- Default / liquidation correctness is enforced at the contract
  level (forfeiture), not a manual recovery process.

**Negative / accepted costs**

- Every balance-mutating action carries an additional storage
  write (the accumulator rollup) and a small gas cost. Acceptable
  given the protection it provides.
- Custody-held LIF means the Diamond accumulates VPFI per-active-
  loan. Storage cost is bounded (one mapping entry per active
  loan). The held amount is auditable per-loan via
  `s.borrowerLifRebate[loanId]`.
- The borrower must claim to receive the rebate (it doesn't auto-
  flow at settlement). This is consistent with the rest of the
  borrower settlement story but auditors should note the claim
  step is a required completion path.

**Risks the decision creates**

- A new terminal path added in the future could be missed by the
  "every proper-close calls `settleBorrowerLifProper`" invariant,
  leaving `vpfiHeld` stranded. Mitigation: documented in
  `CLAUDE.md`; auditor checklist; test coverage in
  `VPFIDiscountFacetTest` + `VPFIDiscountBoundariesTest`.
- The accumulator math (running BPS × seconds) requires careful
  handling of edge cases (zero balance, no time elapsed,
  overflow). Mitigation: 44 unit tests across
  `contracts/test/VPFIDiscountFacetTest.t.sol` (29 cases) +
  `contracts/test/VPFIDiscountBoundariesTest.t.sol` (15 cases).

## Alternatives considered

**Alternative A — Point-in-time tier snapshot at loan init**: The
naive approach. Rejected because of the unstake-immediately-after
gaming vector.

**Alternative B — Continuous on-demand recomputation (no
accumulator)**: At terminal, walk every balance change in the
loan's lifetime and compute the time-weighted average. Rejected
because the gas cost grows linearly with the user's activity over
the loan duration — pathologically bad for active users.

**Alternative C — Discrete-period rebalancing (e.g. snapshot every
epoch)**: A middle ground. Rejected because picking an epoch
length introduces a new parameter the protocol has to govern, and
the gaming vector still exists within an epoch (just shorter).

**Alternative D — Treasury-pays-rebate model (treasury gets the
LIF up-front; rebates the discounted portion at terminal)**:
Rejected because the rebate would have to be funded by treasury
liquidity, introducing a treasury-solvency dependency. The
custody-held model keeps the borrower's own funds segregated and
returnable.

## References

- Source:
  [`contracts/src/libraries/LibVPFIDiscount.sol`](../../contracts/src/libraries/LibVPFIDiscount.sol),
  [`contracts/src/facets/ClaimFacet.sol`](../../contracts/src/facets/ClaimFacet.sol)
- Tests: `contracts/test/VPFIDiscountFacetTest.t.sol` (29 cases) +
  `contracts/test/VPFIDiscountBoundariesTest.t.sol` (15 cases)
- Spec: [`docs/FunctionalSpecs/TokenomicsTechSpec.md`](../FunctionalSpecs/TokenomicsTechSpec.md) §5.2b
- Release narrative: [`docs/ReleaseNotes/ReleaseNotes-2026-04-23-to-24.md`](../ReleaseNotes/ReleaseNotes-2026-04-23-to-24.md)
- Policy summary: [`CLAUDE.md`](../../CLAUDE.md) § "VPFI Fee Discounts"
