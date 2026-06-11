## Thread — T-092 dapp friction + pre-grace banner (#543 / #544 / #545)

Combined dapp PR closing three sibling cards that extend #537's opt-in friction pattern to the remaining dapp surfaces + mirror the keeper's #532 pre-grace notification on LoanDetails.

### #543 — LoanDetails caps editor inline best-effort warning

`AutoLifecycleLoanCapsCard` now renders a persistent inline warning whenever the user is transitioning the `enabled` checkbox from false → true on either editor (refinance caps or extend caps). The warning stays visible until the form submits (refreshes `current.enabled`) or the user un-checks the box.

> ⚠️ Auto-refinance and auto-extend are best-effort. If no compatible counterparty consent is found before this loan's grace period ends, the loan may be liquidated. You remain responsible for monitoring and repaying manually if needed.

Different shape from #537's Dashboard two-step button because the LoanDetails form has multiple inputs (rate, expiry, etc.); a persistent banner is the right friction model for that context.

### #544 — CreateOffer refinance-tagged best-effort warning

When the user fills the refinance-target loan id input on CreateOffer, an inline alert renders immediately below the field. Surfaces the reality that tagging an offer for refinance doesn't guarantee a match in time.

> ⚠️ Tagging this offer for refinance doesn't guarantee a match. If no compatible lender accepts before your existing loan's grace period ends, your loan will default. Auto-refinance is best-effort — review your caps on the LoanDetails page.

### #545 — LoanDetails pre-grace warning banner

`AutoLifecycleLoanCapsCard` now also renders a stark danger banner near the top when:

- The borrower has `refinanceCaps.enabled` (opted into the keeper-driven refinance path).
- The loan's `endTime` is within 24h.

> ⚠️ This loan enters its grace period in ~{{hours}}h. Auto-refinance is best-effort — if no compatible lender offer is matched before grace expires, your loan will default. Repay manually or tighten your refinance caps if the market has moved.

Mirrors the keeper-side `runPreGraceWatcher` (#532) but in the dapp — anyone who opens LoanDetails sees the warning regardless of TG / push subscription state. Hours-to-end is computed live.

The `loanEndTime` prop on `AutoLifecycleLoanCapsCard` is the new wire; `LoanDetails` passes the existing computed `endTime` (or 0 for non-active loans).

### Reuse

- `autoLifecycleLoanCaps.bestEffortWarning` + `autoLifecycleLoanCaps.preGraceWarning` i18n keys (new).
- `createOffer.refinanceTargetBestEffortWarning` (new).
- Existing `AlertTriangle` + `alert alert-warning/danger` styling.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.

### Out of scope

- Auto-subscribe on cap-set (#546).
- Offer-book scan in pre-grace watcher (#547).
- Atomic accept-and-refinance design doc + implementation (#549 / #539).
