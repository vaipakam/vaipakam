## Thread — Auto-lend Phase 2b: gas-free preview of a standing-intent fill (PR #<n>)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). Phase 2a
gave a keeper the **discovery** surface — a paginated feed of the funded, active
lender intents. This step gives it the **decision** surface: a read-only way to
ask, for one prospective fill, "would this succeed, and if not, exactly why?" —
before spending any gas on a transaction that might revert.

What's new:

- **`previewIntent(solver, lender, lendingAsset, collateralAsset, borrowerOfferId,
  fillAmount)`** — a non-mutating view that runs the SAME checks the live
  `matchIntent` fill runs, in the same order, and reports the first thing that
  would stop the fill. It returns a structured result:
  - a single `ok` flag — true only when every layer passes;
  - the precise failure reason, split into an intent-level code (the lender's
    standing-intent guards: the two kill-switches, an inactive or VPFI-lending
    intent, a solver that isn't authorised for a keeper-gated intent, a fill
    below the dust floor or above the exposure cap, a borrower term longer than
    the lender allows, a borrower offer that disables full-term interest or opts
    into partial repay, an unresolvable collateral requirement, or insufficient
    funded capital), the shared match-admission code (asset/amount/rate/
    collateral/health-factor overlap), and the progressive risk-access gate code;
  - the numbers a solver needs to size the fill — the principal it would draw,
    the midpoint rate the resulting loan would carry, the collateral the borrower
    must post, and the un-lent funded capital the intent can still deploy.
- The **prospective filler is a parameter** (`solver`), not the caller of the
  view, so a keeper can preview on behalf of the account that would actually
  submit — the keeper-authorisation check is evaluated against that account.

Why this is safe to rely on: the preview reuses the live predicates rather than
re-deriving them. The shared match core was refactored so the very same
admission logic serves both a stored-offer match and a not-yet-stored intent
slice (the slice the fill would materialise is synthesised in memory and run
through the identical core); the progressive risk-access gate's actor resolver
was generalised the same way; and the keeper-authorisation check is the exact
predicate the enforcing path consumes. The binding guarantee is a paired
agreement test: for identical inputs, `previewIntent` reports success if and only
if `matchIntent` would succeed, and each failure code lines up with the precise
revert the live fill raises.

This is a read-only surface plus two internal refactors that leave every existing
behaviour byte-identical — no change to how intents are funded, filled, or
priced. The keeper that consumes the preview (the fill and auto-roll passes)
lands in the next Phase-2 step.
