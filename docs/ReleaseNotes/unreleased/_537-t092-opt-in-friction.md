## Thread — T-092-F: opt-in friction on Dashboard auto-lifecycle toggles (#537)

Closes the "users silently enable auto-refinance and don't understand it's best-effort" gap. The two-step click-to-confirm pattern at every Enable surface ensures the borrower acknowledges the "best-effort, not guaranteed" reality before opting in.

### What's new

**Two-step toggle pattern on `AutoLifecycleSettingsCard`** (Dashboard). Both opt-in toggles (auto-lend, auto-opt-in-on-new-loan) now require a two-step click to enable:

1. First click on "Enable" → button text changes to "I understand & enable" + inline warning banner renders:
   > ⚠️ Auto-refinance is best-effort. If no compatible lender offer is found before your loan's grace period ends, the loan may be liquidated. You remain responsible for monitoring and repaying manually if needed.
2. Second click on "I understand & enable" → submits `setAutoLendConsent(true)` / `setAutoOptInOnNewLoan(true)`.

**Disabling never requires confirmation** — it's the safe direction.

### Why inline (not modal)

Modal dialogs train users to dismiss-without-reading. An inline persistent block that stays visible until the user clicks "I understand & enable" forces the eye to land on the text.

### State machine

```
[Enable] (click)
  → confirming = 'lend' | 'optIn'
  → button label changes to "I understand & enable"
  → warning banner renders
[I understand & enable] (click)
  → submit setter
  → clear confirming
```

### Pairs with the earlier T-092 work

- **#532 (pre-grace notification)** — borrowers now see the warning at OPT-IN time (this PR) AND get a notification when their loan actually approaches grace without a match.
- **#533 (rename to "offer posting")** — the rename already set accurate expectations; this PR adds the friction so the expectation lands.
- **#531 (default OFF for illiquid/NFT)** — the contract-side gate already silently skips NFT-collateral loans for auto-opt-in; this PR makes the user's CONSCIOUS opt-in for liquid loans more deliberate.

### Out of scope

- **LoanDetails `AutoLifecycleLoanCapsCard`** — the per-loan caps editor is a form with multiple inputs (enable checkbox, min/max rate, expiry). The two-step pattern doesn't directly fit; a separate friction model (e.g., a header banner that stays visible) would be needed. Deferred to a follow-up.
- **CreateOffer refinance-tagged path** — the warning is already in the hint copy (set during #533). Folding the two-step pattern into the form's submit button is a larger refactor; deferred.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- Disabling path unchanged (no confirmation required for the safe direction).
- Admin kill-switch state still gates the Enable button when applicable.
