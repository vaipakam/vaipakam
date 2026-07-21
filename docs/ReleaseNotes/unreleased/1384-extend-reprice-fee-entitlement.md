## Thread — Reprice the fee entitlement when a loan is extended in place (M2 Full-tariff follow-up) (PR #<n>)

Closes one of the two `feeEntitlementEnabled` cut-over blockers the M2 settlement
sweep (#1354) left open. When a loan is **extended in place**
(`AutoLifecycleFacet.extendLoanInPlace`), the executor settles the current term's
interest and rolls the loan onto a **new term** — but its fee-entitlement record
is stamped once at origination and was never revisited.

For a loan whose **lender** paid the Full `C*` tariff, that gap let the lender
keep the promised **+10% yield-fee discount** (#1354) on the later extended-term
interest **without paying any new tariff for the added term**. The extension
carries no fresh per-party Full authorization (it is a keeper-driven / borrower-
driven lifecycle action, not a new signed opt-in), so there is nothing to charge
the added term against.

The single repricing action on extension is therefore to **downgrade a lender
Full stamp to None** (and clear the recorded paid tariff). Because the +10% is
delivered **per term** — the original term's bump is already settled, with the
Full stamp intact, at the extension boundary — the downgrade only stops the bump
on the term no `C*` was paid for. The lender's ordinary consent-gated hold
discount is unaffected (it flows from the platform VPFI-discount consent,
independent of the Full stamp).

Everything else is deliberately left untouched:

- **The loan-side reward-cap budget (#1353) is preserved.** That budget is a
  per-loan **lifetime** ceiling, consumed lazily as rewards are counted, and the
  single `C*` funds the whole loan's rewards across all terms. Resetting it on
  extension would retroactively cap an **unclaimed original-term** reward budget
  to zero. The per-day proration already clamps at the origination term, so an
  extension can never over-credit; refining the proration base across the
  extension boundary is a separate precision item (#1372).
- **The borrower stamp is left as-is.** No settlement path reads the borrower
  mode — it is an informational record — so there is no per-term borrower
  benefit to reprice. (A new Full borrower's `C*` is routed to the recycle
  bucket at origination, not held per-loan; the legacy peg-custody borrower-LIF
  rebate is a separate, pre-existing mechanism and is untouched regardless.)

The reprice is a **no-op on a plain (unstamped) or non-Full-lender loan**. Ships
**dark** with the rest of the M2 fee package: while no loan carries a Full stamp
(the master switch is off on every deploy), this only ever reads zero-default
fields and returns.

This closes **only this blocker**. The other M2 cut-over blocker — honoring the
lender Full/hold stamp on the **secondary** settlement paths (#1383) — remains
open; the PR-9 (#1356) deploy-asserts gate the master switch on both.

Closes #1384. Umbrella: #1349.
