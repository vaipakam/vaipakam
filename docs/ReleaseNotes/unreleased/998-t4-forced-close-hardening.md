## Thread — #998 Tranche 4: forced-close / liquidation hardening (PR #<n>)

This tranche closes four spec-conformance findings on the forced-close
(HF-liquidation, time-based-default, and in-kind fallback) paths. They share
the same code neighbourhood, so they ship together.

**#915 (M7 / spec-review S12) — periodic-settled interest was double-counted
on every forced close.** When a periodic-cadence loan misses a payment, a
settler auto-liquidates the shortfall and credits the paid interest to
`interestSettled` while the loan stays active and its accrual clock keeps
running. The voluntary-close paths already credit that amount, but the forced-
close paths read the raw accrual and did not — so a loan later liquidated,
time-defaulted, or fallback-closed charged the borrower (and paid the lender)
that interest a second time. All four sites now credit `interestSettled`
(saturating): the single/split HF liquidations and the HF metric via the shared
`currentBorrowBalance`, the time-based default inline, the in-kind fallback
split, and the preclose Option 2 obligation-transfer. (The offset Option 3 and
refinance paths already netted it.)

Two paths that re-originate a still-active loan in place — the Option 2
obligation transfer (to a new borrower) and a routine partial liquidation (on
the reduced residual) — restart the interest-accrual clock. Crediting
`interestSettled` there without clearing it would let the same credit be
subtracted a second time on the re-originated loan's next settlement, underpaying
the lender. Both now zero `interestSettled` at the clock restart, since the
settled interest belongs to the closed pre-reset accrual window.

**#1005 (S9) — a swap try-list with no attemptable route could force a healthy
loan into the fallback.** A permissionless caller could invoke `triggerLiquidation`
or `triggerDefault` with an empty adapter list — or, more subtly, a non-empty
list whose only entries are governance-disabled venues (which the failover
helper silently skips) — and the swap helper returned "no routes", dropping the
loan straight into the full-collateral fallback (a 3%+2% premium, in-kind lender
recovery) with zero DEX routes ever attempted. The failover helper now counts
the routes it actually attempts and reverts (`NoEnabledSwapRoute`) when none
were — covering the empty and the all-disabled case in one place, for every
failover caller. The forced-close collateral withdrawal rolls back atomically.

**#1009 (L-g) — the treasury handling fee is now subordinated to full lender
recovery.** On an underwater liquidation the old waterfall took the 2% treasury
handling fee (and the liquidator bonus) off the top before paying the lender, so
the lender funded the treasury's fee on a loan that was already taking a loss.
The liquidator bonus stays first-priority (it is the necessary keeper liveness
incentive), but the treasury handling fee is now taken only from surplus above
the lender's full recovery — on an underwater close it collapses to zero, so the
treasury never profits while the lender takes a loss. Over-collateralised closes
are unaffected. Applied identically to the single-route, split-route, and
time-based-default paths.

**#1010 (L-h) — the time-based default now pays the caller the liquidator
incentive.** The HF liquidation paths pay the caller a dynamic incentive
(6% − realized slippage, capped 3%); the time-based-default swap paid nothing,
leaving permissionless default-triggering economically unmotivated. It now pays
the same incentive via a shared curve helper. The time-based default is a Tier-2
close-out that is deliberately permissionless and must not brick (the unflagged
counterparty has to be made whole), so the trigger itself is never sanctions-
gated. But the bonus is a new value payment, so — like the Tier-1 HF-liquidation
bonus — it is withheld from a sanctioned caller: a sanctioned wallet can still
trigger the default (the close-out completes), but earns no bonus (the withheld
amount stays in proceeds and flows to the lender/borrower via the waterfall).
The bonus is intentionally not KYC-gated, unlike Tier-1, since KYC is off on
retail and this Tier-2 path must not add a gating revert.

To keep the three god-facets under the EIP-170 bytecode limit while absorbing
these changes, the liquidator-incentive curve and the interest-netting credit
were factored into small shared `LibEntitlement` helpers, and the two duplicated
liquidator-KYC blocks in `RiskFacet` were folded into one private helper.

Closes #915, #1005, #1009, #1010 (umbrella #998).
