## Thread — T-092 pre-grace refinements (#546 + #547)

Two small refinements to the pre-grace warning surface that landed earlier (#532 + #545). Combined PR since they touch related code paths.

### #546 — Alerts subscription CTA on LoanDetails

`AutoLifecycleLoanCapsCard` now surfaces an inline info banner suggesting borrowers set up Telegram / Push alerts whenever they have refinance caps enabled:

> ⚠️ Set up Telegram or Push alerts so you'll be warned if no compatible refinance offer is found before your grace period ends. [Go to Alerts →]

Static for v1 — doesn't query actual subscription state (would require an extra fetch to the apps/agent's subscriptions endpoint). A borrower who's already subscribed sees the same banner; future enhancement: hide when subscription exists.

The CTA bridges the `runPreGraceWatcher` (#532) infrastructure with the user's mental model: "I enabled caps; now I need a notification channel so the protocol can tell me if the auto-refinance can't find a match."

### #547 — Viable-counterparty pre-check in `runPreGraceWatcher`

`apps/keeper/src/preGraceWatcher.ts` now scans the active offer book once per cron tick + filters to lender offers. Before dispatching the pre-grace warning for a loan, the watcher checks whether ANY in-book lender offer matches the loan's refinance shape:

- Same `lendingAsset` and `collateralAsset`.
- Same `assetType` and `collateralAssetType`.
- `amountMax >= loan.principal` (capacity covers the principal).

If at least one match exists, the matcher will likely fire in the next tick — the warning is suppressed to reduce notification noise. If no match exists OR the offer book exceeded `OFFER_SCAN_CAP` (500 offers per chain per tick), the warning fires unconditionally.

**Heuristic, not exact** — doesn't simulate `previewMatch` (would cost gas-equivalent eth_calls per loan). False negatives possible: a match might fail at the deeper HF / caps / sanctions checks. The borrower still gets the warning in those cases on the next tick because the offer would be removed from the book on the failed match.

False positives are also possible: a viable offer might NOT match in time (e.g., race with another keeper). That's the safe-conservative direction — we surface the warning if uncertain.

### Why combined PR

Both cards refine the same notification surface from different angles:
- #546 ensures the user can RECEIVE warnings (subscription channel).
- #547 ensures the warnings SENT are meaningful (no false positives).

Together they make `runPreGraceWatcher` notifications actionable instead of noisy.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- `pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit` clean.

### Operator action

None — both changes are dapp-side / off-chain only. No new D1 migration; no new contract surface.
