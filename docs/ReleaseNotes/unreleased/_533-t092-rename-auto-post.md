## Thread — T-092-D rename: "auto-lend / auto-refinance" → "auto-post lender / refinance offers" (#533)

i18n + label-only rename on the dapp surface to set accurate expectations. The current "auto-lend" / "auto-refinance" copy implied the protocol AUTONOMOUSLY picked counterparties + terms — but the reality is the dapp POSTS offers under the user's caps; a separate matcher / new lender must accept for anything to fire.

### What's new

- **Dashboard `AutoLifecycleSettingsCard`** copy:
  - "Auto-lend my vaulted assets" → "Auto-post lender offers when I deposit"
  - "Auto-set refinance caps on every new loan" → "Auto-set refinance offer terms on every new loan"
  - Body + hints reworded to clarify "posts offers + matcher matches" (not magic auto-execution).

- **LoanDetails `AutoLifecycleLoanCapsCard`** section title:
  - "Auto-refinance (borrower side)" → "Refinance offer posting (borrower side)"
  - Hint extended with a pointer to the pre-grace warning that's coming with #532.

- **Protocol Console knob labels**:
  - "Auto-lend kill switch" → "Auto-lend offer posting kill switch"
  - "Auto-refinance kill switch" → "Auto-refinance offer posting kill switch"
  - **"Auto-extend kill switch" unchanged** — auto-extend genuinely auto-executes once both sides pre-consent + a keeper calls. The other two are offer-posting flows that need a separate party to accept.

- **Revert error messages**:
  - `AutoLendDisabled` → "Auto-lend offer posting is disabled..."
  - `AutoRefinanceDisabled` → "Auto-refinance offer posting is disabled..."

### Why the asymmetric treatment

- `setAutoLendConsent` / `setAutoOptInOnNewLoan` are offer-posting consent — the dapp / protocol posts offers; the matcher matches them; the user retains effective control via caps.
- `extendLoanInPlace` is the only T-092 mechanism that truly auto-executes — both sides consent up front, the executor fires when the keeper calls it, no third-party offer / accept round. Renaming THAT to "auto-extend offer posting" would be inaccurate.

### On-chain ABIs unchanged

All on-chain function selectors (`setAutoLendConsent`, `setAutoRefinanceCaps`, etc.) and the contract storage layout stay byte-identical. This is purely an i18n + label change.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
