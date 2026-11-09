## Thread — The next app takes collateral back from a loan (PR #3322)

A running loan's page in the next app now offers its borrower a way to take back collateral above what the loan needs. Only the holder of the borrower position may do this, so the action is shown to that holder alone. It is held, with the reason, while the protocol is paused, while a swap-to-repay order on the borrower position is pending, while a refinance request for the loan stands, when the protocol does not price the collateral token now, and when nothing can be taken back because all the collateral is needed to keep the loan within the protocol's limits. A loan in fallback is not running, so nothing is taken back from it.

The borrower types the amount, checked as it is typed against the protocol's own most that can be taken back now. The form says that this limit moves with prices and as interest accrues, and it offers no shortcut to the exact limit, since an amount at the limit would be refused once a moment of interest accrues.

No approval is needed: the collateral goes from the borrower's vault to the wallet that asks, in one wallet prompt. A wallet with protected account mode on gets it queued for the account's delay instead, and the review says so (or says the mode could not be read). That holds for a bought position too, because the protocol first moves its collateral into the holder's own vault. Where the account also requires a secondary signer to approve each release, the review and the finish card say that too. The review shows the collateral now and after, where it goes, the limit, and the loan's health factor and loan-to-value now. It says that taking collateral back moves the loan closer to liquidation, that the protocol checks its limits again when the withdrawal confirms (so a price move or a pause before then refuses it with nothing moved), and that the finish card shows the protocol's own figures after.

A lender's sale listing also holds a withdrawal, and no protocol view exposes that link (issue #3308), so the review asks the protocol to try this very withdrawal first and names that refusal; the send tries it again.

After the withdrawal the app reads the outcome from the transaction's own record: the collateral it left, the protocol's health factor and loan-to-value after it, and what arrived in the wallet, was queued for it, or was paid into the vault.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-TAKE-BACK. Epic #3180.
