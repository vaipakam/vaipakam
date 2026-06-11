## Thread — T-092 follow-up: admin kill-switch knobs on the Protocol Console (#511)

Partial fold of #511 (dapp UI surface). Surfaces the three auto-lifecycle kill switches on the `/admin` (Protocol Console) page so an admin / governance wallet can read their current state and propose flips alongside every other protocol knob.

### What's new

**New `autoLifecycle` knob category** in `apps/defi/src/lib/protocolConsoleKnobs.ts`:

| Knob | Getter | Setter |
|---|---|---|
| `cfgAutoLendEnabled` | `AdminFacet.getAutoLendEnabled()` | `AdminFacet.setAutoLendEnabled(bool)` |
| `cfgAutoRefinanceEnabled` | `AdminFacet.getAutoRefinanceEnabled()` | `AdminFacet.setAutoRefinanceEnabled(bool)` |
| `cfgAutoExtendEnabled` | `AdminFacet.getAutoExtendEnabled()` | `AdminFacet.setAutoExtendEnabled(bool)` |

All three default `false` on a fresh deploy. The Protocol Console reads the live value via `useAdminKnobValues` (existing hook) and renders a card per knob with the short description, current value, and a deep-link to `docs/ops/AdminConfigurableKnobsAndSwitches.md#t-092-auto-lifecycle-kill-switches` (anchor added in a sibling doc PR).

Category order places `autoLifecycle` near the bottom of the dashboard alongside `kyc` — both are break-glass categories rather than routinely-tuned tables, so they shouldn't crowd the everyday-tuning sections.

### What's NOT in this PR

The remaining #511 scope:
- Per-user opt-in toggles on the Settings page (`setAutoLendConsent`, `setAutoOptInOnNewLoan`, `setDefaultAutoRefinanceCaps`).
- Per-loan cap editors on the Loan Details page (`setAutoRefinanceCaps`, `setAutoExtendBorrowerCaps`, `setAutoExtendLenderCaps`).
- Refinance-tagged offer construction flow (sets `params.refinanceTargetLoanId` for the keeper-driven flow).
- i18n strings for the new error messages (`RefinanceCapsRequired`, `RefinanceRateExceedsCap`, etc.) so the dapp surfaces a friendly copy rather than the raw revert.

Each piece is bounded enough to land in its own PR. This PR is the lowest-friction starting point — the kill switches are READ-ONLY values until governance flips them, so getting them visible on the admin surface is the foundation for everything else.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- KNOB_CATEGORY_ORDER + KNOB_CATEGORY_LABELS expanded to include the new category.
- The three knob entries follow the same KnobMeta shape the existing `rangeAmountEnabled` / `partialFillEnabled` boolean kill switches use (so the Protocol Console's existing render path works unchanged).

### Operator action

None for this PR — the knobs become visible on the Protocol Console as soon as the dapp deploys. Actual flipping happens via the existing Safe deep-link composer (Phase 4 of the Protocol Console, in progress separately) once an admin / governance wallet is connected.
