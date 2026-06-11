## Thread — T-092 #511 sub: per-loan auto-refinance + auto-extend caps editor on LoanDetails (#521)

Sub-fold of #511 (dapp UI surface). Lets borrowers + lenders pre-approve keeper-driven actions on individual loans without needing to call the contract directly.

### What's new

**New `AutoLifecycleLoanCapsCard` mounted on LoanDetails.** The card renders only when the connected wallet holds the borrower or lender position NFT for the current loan; sections render conditionally:

| Section | Visible to | Setter |
|---|---|---|
| Refinance caps | borrower-NFT owner | `AutoLifecycleFacet.setAutoRefinanceCaps(loanId, enabled, maxRateBps, maxNewExpiry)` |
| Extend caps (borrower side) | borrower-NFT owner | `setAutoExtendBorrowerCaps(loanId, enabled, minRateBps, maxRateBps, maxNewExpiry)` |
| Extend caps (lender side) | lender-NFT owner | `setAutoExtendLenderCaps(loanId, enabled, minRateBps, maxRateBps, maxNewExpiry)` |

Each section reads the current on-chain state via the matching getter (which applies the staleness fence internally — a stale entry from a previous NFT holder shows up as `enabled: false`, which the form mirrors). Rate inputs accept percentages and convert to BPS at submit time. Expiry uses a native `<input type="date">` that converts to / from unix-seconds at the boundary.

### Reuse

- `autoLifecycleErrorOrRaw` from `apps/defi/src/lib/autoLifecycleErrors.ts` (#522) decodes any revert into a friendly localised message.
- Component hides itself entirely when the AutoLifecycle facet isn't readable on the current chain — old testnet deploys + pre-T-092 chains stay clean.

### Out of scope

- **Per-user default refinance caps editor on Dashboard** — the per-user storage primitive (`setDefaultAutoRefinanceCaps`) is already on-chain; the rate + expiry form for setting per-user defaults is deferred to a future PR since it's redundant with the per-loan editor for most users. The `setAutoOptInOnNewLoan` toggle that copies user defaults into every new loan already exists on Dashboard.
- **Refinance-tagged offer construction** (sub-card #523) — lives on CreateOffer, separate PR.
- **Sibling keeper-bot repo** (#518) — separate repo.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- New `autoLifecycleLoanCaps.*` i18n namespace.
