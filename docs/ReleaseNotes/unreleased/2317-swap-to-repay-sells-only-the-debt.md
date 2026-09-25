## Thread — swap-to-repay sells only what the debt needs (#2317)

Repaying a loan in full straight from its collateral used to sell every unit
of collateral the borrower allowed, not just the collateral the repayment
needed. The borrower's allowance was meant as a ceiling — the functional
specification and the contract's own description both say so — but it was
treated as the exact amount to sell, so a generous allowance turned pledged
collateral into the lending asset far beyond the debt and sent the excess to
the borrower's wallet. The fork walkthrough of the live Base Sepolia
deployment measured it: with a little over a thousand owed and an allowance
worth twelve hundred, all twelve hundred was sold. The owner decided the
specification is the intent and the code was the defect.

The close-out now sizes the sale to the debt. It sells the least collateral
whose worst-case proceeds, under the borrower-facing slippage cap, still
cover the whole repayment; the allowance only bounds that, and everything
above it stays pledged and is released by the borrower's normal claim. Any
principal left after the debt is paid is the fill beating that worst case,
which is the favourable-quote surplus the specification describes. A new
read-only preview reports the sale size, the floor it must clear and the debt
it covers, from the same computation the close-out runs, so an interface can
quote a route for exactly that amount. A route whose quote fixes the sell
amount in advance can go stale as interest accrues or a price updates, and
then fails over to the next venue or needs re-quoting; on-chain venues size
themselves. The partial mode is unchanged — there the borrower chooses how
much to sell, by design.

Nothing about the settlement waterfall, the sanctions freeze or the claim
path changed. The fork walkthrough's check for this behaviour, which fails
against the currently deployed bytecode, turns green once this ships. The
resolver-filled intent path still commits the whole collateral to its
auction; the specification's rule — unused collateral stays pledged and
claimable — applies to it too, so it is to be sized to the debt as well. That
is a separate change, tracked in #2322, and is not part of this one.
Closes #2317.
