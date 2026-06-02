## T-086 — Advanced User Guide: OpenSea prepay listing entry + same-block-race note

Closes the documentation gap left behind by T-086 steps 13 (frontend UI) and 14 (OpenSea publish). The Advanced mode user guide's "Loan Details > Actions > If you're the borrower" section listed every other terminal-flow action (Repay, Preclose direct, Preclose offset, Refinance, Claim as borrower) but never mentioned the new OpenSea collateral-listing flow, even though it has shipped and is reachable from the loan-details page.

This change adds:

1. A new borrower-side action bullet describing the OpenSea prepay listing flow in two sentences — what it does, when it's available, what happens at fill, and the cancel-anytime escape. Same terse style as the surrounding bullets.

2. A blockquote note immediately after the borrower action list explaining the **same-block-race outcome** when a borrower's `repayLoan` lands in the same block as a buyer's `Seaport.fulfillOrder` and the buyer's tx wins EVM ordering. Specifically:

   - The loan is **already settled** by the time the borrower's repay runs (sale waterfall already paid lender + treasury + borrower vault remainder)
   - The borrower's repay reverts harmlessly — no funds left their wallet
   - The Vaipakam dapp detects this case and shows a tailored message (PR #318); if for some reason the user sees a generic revert, the note tells them to check loan status on the Dashboard first

The note explicitly calls out that this is **the only case** a borrower-initiated repay can "fail harmlessly" without something actually being wrong, so borrowers don't spiral into "did I lose funds?" panic if they ever see a revert while a listing was live.

### What's NOT in this PR

- Translations of the new content into the existing Basic/Advanced locales (de, ta, etc.) — those follow the normal translation rotation pace.
- Equivalent additions to the Basic user guide — the OpenSea listing flow is an Advanced-mode feature and is documented there.
- Frontend / contract changes — the friendly-error UX referenced in the doc note lives in PR #318.
