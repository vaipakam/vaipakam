## Thread — dapp surface for collateral lien (PR #564)

The web app now surfaces the on-chain encumbrance (lien) records that the
`MetricsFacet` views already expose, so both sides of a loan can see —
and the lender can independently prove — that collateral and principal are
provably locked while a loan or offer is live. This is a read-only
frontend change: it consumes existing on-chain views and adds no contract
behaviour.

Three surfaces gained lien awareness. The Loan Details page now renders a
"Collateral backing this loan" card to either party of a loan, reading
`getLoanCollateralLien(loanId)`. It shows the encumbered asset, amount,
lien status (Active vs Released) and the vault the collateral is locked in.
The copy adapts to the viewer: a lender sees a provability message plus a
block-explorer deep-link to the locked-balance owner as the on-chain proof
anchor, while a borrower sees a warning that the collateral stays locked
until they repay, refinance, or default — and that direct withdrawals of
the locked amount revert until then. The card renders nothing when there
is no live lien.

The Vault page now breaks each token balance into Total / Locked / Free,
reading `getEncumbered(user, asset, 0)` alongside the existing balance
reads and computing the withdrawable free balance as the total minus the
locked portion (floored at zero). When a balance is fully locked the row
shows a "fully locked" status; this page has no per-row withdraw control
of its own (withdrawals run through the staking flow), so the gate
surfaces as a read-only indicator rather than a disabled button. The
Offer Details page reads `getOfferPrincipalLien(offerId)` and, for an
accepted offer viewed by its creator (the lender), adds a "Locked
principal" row showing the still-locked principal amount.

Closes #564. The D.3 NFT-metadata work in the issue is contract/worker-
side and intentionally out of this frontend scope. Note: the apps/defi
vitest page suite remains affected by the pre-existing Issue #85 harness
breakage (CI gates these on `tsc` only); the new isolated
`CollateralLienCard` component test passes against a working test
environment, and the added LoanDetails page-test assertions follow the
existing mock pattern so they go green once #85's harness fix lands.
