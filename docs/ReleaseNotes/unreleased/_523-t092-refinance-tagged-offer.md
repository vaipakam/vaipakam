## Thread — T-092 #511 sub: refinance-tagged offer construction on CreateOffer (#523)

Sub-fold of #511 (dapp UI surface). Wires the final user-facing piece of the auto-refinance flow — lets a borrower construct an offer with the intent to refinance one of their existing active loans, instead of needing to manually thread `refinanceTargetLoanId` into the payload.

### What's new

- **`OfferFormState.refinanceTargetLoanId: string`** — new form field on the offer-creation form state. Empty string ⇒ standard borrower offer (no refinance intent); non-empty ⇒ refinance-tagged.
- **`toCreateOfferPayload` plumbing** — threads the form value through to `CreateOfferPayload.refinanceTargetLoanId` as a `bigint`. ALSO auto-forces `fillMode = Aon` when the field is non-empty (the contract reverts `InvalidRefinanceTarget` on Partial fillMode for refinance-tagged offers).
- **CreateOffer form field** — new optional number input visible only on Borrower offers with ERC20 principal. Placeholder shows "Loan ID"; hint explains the keeper-driven refinance flow + the AON forcing + the per-loan caps requirement.

### Wire-up summary

Once the borrower:
1. Has set per-loan refinance caps on LoanDetails (#521).
2. Fills the new loan-ID input on CreateOffer with the target loan id.
3. Submits the offer.

The contract enforces `LibAutoRefinanceCheck.validate` at create time AND at accept time (Phase 2b, PR #510). A keeper can then call `RefinanceFacet.refinanceLoan(oldLoanId, borrowerOfferId)` — the apps/keeper auto-refinance pass is the next composition step (the auto-extend pass already lives in apps/keeper as of #517; auto-refinance gets its own pass since it composes the matcher's flow).

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- The form field is invisible on Lender offers (refinance is borrower-side only).
- The form field is invisible when assetType !== 'erc20' (the contract enforces ERC20 for refinance-tagged offers).
- Standard create flow still passes `refinanceTargetLoanId: 0n` (empty form input ⇒ 0n at payload-build time).

### Closes #511 entirely

This was the last remaining sub-card under T-092 follow-up #511 in this monorepo. The sibling `vaipakam-keeper-bot` repo (#518) tracks the public reference bot's auto-extend detector update — that's a separate repo + PR cycle, not gated on this PR.

### Operator action

None — works end-to-end with the existing diamond + dapp infrastructure. Borrowers see the new field on CreateOffer once the dapp deploys.
