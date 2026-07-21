## Thread — Reprice the fee entitlement when a loan is extended in place (M2 Full-tariff follow-up) (PR #<n>)

Closes the second of the two `feeEntitlementEnabled` cut-over blockers the M2
settlement sweep (#1354) left open. When a loan is **extended in place**
(`AutoLifecycleFacet.extendLoanInPlace`), the executor settles the current
term's interest and then rolls the loan onto a **new term** — a fresh start
time, rate, and duration — and re-opens a fresh reward accrual. What it did
**not** do before was revisit the loan's fee-entitlement record, which is
stamped once at origination.

For a loan whose **lender** paid the Full `C*` tariff, that gap let the lender
keep the promised **+10% yield-fee discount** (#1354) on the later
extended-term interest — and keep an oversized loan-side reward budget
(#1353) — **without paying any new tariff for the added term**. The extension
carries no fresh per-party Full authorization (it is a keeper-driven / borrower-
driven lifecycle action, not a new signed opt-in), so there is nothing to
charge the added term against.

This change reprices the entitlement for the new term on every extension:

- **The lender Full stamp is downgraded.** The added term earns no `+10%`. The
  lender's ordinary consent-gated hold discount is unaffected — that flows from
  the platform VPFI-discount consent, independent of the Full stamp; only the
  paid tariff bump stops. This is the fair outcome because the yield-fee
  discount is delivered **per term**: the original term's `+10%` was already
  settled, with the Full stamp intact, at the extension boundary — the lender
  keeps everything they paid for and loses only the bump on term they did not.

- **The loan-side reward-cap base is reset for the new term.** No fresh `C*`
  funds the extended term, so its reward budget is zero (conservative; precise
  remaining-budget carry-over across the extension boundary is tracked
  separately as #1372). The proration base and the reward-haircut snapshot are
  refreshed to the new term.

- **The borrower's Full custody is deliberately left untouched.** A borrower's
  `C*` is held up front and rebated **once at terminal over the whole loan
  lifetime** — a whole-loan mechanism that legitimately spans an extension, not
  a per-term benefit. Its terminal settlement keys on the held amount, not the
  stamped mode, so the borrower rebate is correct either way.

The reprice is a **no-op on a plain (unstamped) loan** — a loan that never
touched the tariff/discount path stays unstamped; no entitlement record is
fabricated on extension.

Ships **dark** with the rest of the M2 fee package: while no loan carries a Full
stamp (the `feeEntitlementEnabled` master switch is off on every deploy), this
only ever rewrites zero-default fields to themselves. Both remaining M2
cut-over blockers (this and #1383, the secondary settlement paths) are now
addressed; the PR-9 (#1356) deploy-asserts gate the master switch on them.

Closes #1384. Umbrella: #1349.
