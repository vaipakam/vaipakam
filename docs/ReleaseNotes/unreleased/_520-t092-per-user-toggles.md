## Thread — T-092 #511 sub: per-user auto-lifecycle toggles on Dashboard (#520)

Sub-fold of #511 (dapp UI surface). Adds the two foundational per-user opt-in toggles users need to enroll in the auto-lifecycle features.

### What's new

**New `AutoLifecycleSettingsCard` on Dashboard** — sits next to `VPFIDiscountConsentCard` and `StakeVPFICTA`. Two toggles:

1. **Auto-lend opt-in** → `AutoLifecycleFacet.setAutoLendConsent(bool)`. Shows the kill-switch state (`AdminFacet.getAutoLendEnabled()`) — when off, an info banner tells the user "admin has temporarily disabled auto-lend" and the "Enable" button is disabled. Users with existing consent can still revoke (matches the contract's anti-trap-in-consent semantic).
2. **Auto-opt-in on every new loan** → `setAutoOptInOnNewLoan(bool)`. Borrower convenience toggle — when on, every new loan auto-populates its `autoRefinanceCaps` from the user's defaults (set via the LoanDetails per-loan editor that lands in sub-card #521).

### Reuse

- `autoLifecycleErrorOrRaw` from `apps/defi/src/lib/autoLifecycleErrors.ts` (#522) decodes any contract revert into a friendly localised message.
- Component mirrors the existing `VPFIDiscountConsentCard` pattern: useDiamond / useWallet / Diamond reads on mount + write on click + error display.

### Out of scope

- **Per-loan refinance + extend cap editors** — separate sub-card #521; lives on the LoanDetails page.
- **Default per-loan refinance caps editor** — the per-user storage primitive (`setDefaultAutoRefinanceCaps(enabled, maxRateBps, maxNewExpiry)`) is already on-chain; the rate + expiry form lives in the LoanDetails follow-up alongside the per-loan editor.
- **Refinance-tagged offer construction flow** — separate sub-card #523; lives on the CreateOffer page.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- The card hides itself when the auto-lifecycle facet isn't readable on the current chain — old deploys and pre-T-092 chains won't show a broken card.

### Operator action

None — the card uses existing diamond + wallet infrastructure. Once governance flips `setAutoLendEnabled(true)` on a chain, the toggle becomes enabled there.
