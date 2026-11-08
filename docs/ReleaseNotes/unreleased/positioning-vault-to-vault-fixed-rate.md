## Thread — Vault-to-vault, fixed-rate positioning (PR #<n>)

The website, the new app (alpha05), the whitepaper and the functional spec now
describe Vaipakam as non-custodial, vault-to-vault lending and borrowing at a
fixed rate and term that the lender and borrower agree, with no pool and no
middleman. The owner chose this on 2026-11-08 after a check of the contracts
confirmed the claim: a loan's rate is set when it opens and no pool,
utilization curve or oracle moves it.

The copy says "vault-to-vault" instead of "peer-to-peer (P2P)", because "P2P
lending platform" is a regulated category in several jurisdictions and
"vault-to-vault" names what actually happens: funds move directly between the
two parties' own vaults. "Vault" is always paired with "non-custodial" or "your
own vault" so it never suggests that Vaipakam holds people's assets. The
website's call to action no longer says "start earning", and its Spanish,
Chinese and Arabic versions no longer speak of yield.

Where the rate can change, the longer texts say so: only when both sides agree,
through an extension near maturity within limits both position holders set, or
a handover to a replacement borrower whose rate applies while the exiting
borrower tops up any interest the lender would lose. A refinance replaces the
loan rather than changing its rate. These rules are recorded as a copy rule in
the website spec.

alpha05's Home adds a fourth getting-started card, "A fixed rate you agree",
and its Borrow and Lend explanations state that the rate and term are fixed
when the loan opens. The frozen Terms of Service version is unchanged; a future
Terms version adopts the wording.
