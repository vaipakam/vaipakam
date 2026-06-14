## Thread — Reserve VPFI lender-proceeds against the unstake path on all terminal paths (#592)

When a loan whose principal asset is VPFI reaches a terminal close, the
lender's proceeds are deposited into the **stored** lender's vault and owed
to the **current** lender-position NFT holder via a claim. VPFI is the one
principal asset with a user-facing tracked-balance exit (the VPFI unstake
/ withdraw path), so — if the lender position had been transferred away —
the stored lender could **front-run the current holder's claim and unstake
the proceeds**, leaving the rightful claim unfundable. (No funds are at
risk today: the platform is pre-live. This closes the class before
mainnet.)

The internal-match path already closed this (the #585 work added the
reserve/release mechanism: the proceeds are reserved in the locked-balance
ledger at deposit and released, path-agnostically, the instant the holder
claims). This change extends the **reserve** call to every remaining VPFI
lender-proceeds deposit site across the **terminal** close paths — the ones
where the loan closes immediately, so the lender of record is fixed between
the deposit and the eventual claim:

- full repayment,
- swap-to-repay (collateral swapped to clear the debt),
- time-based default (liquid DEX-swap settlement),
- borrower preclose (direct),
- refinance (the old loan's lender is paid off and exits),
- health-factor liquidation (full, atomic-split, and discounted variants).

At each, when the asset that lands in the lender's vault is VPFI, the
proceeds are reserved against the unstake path the moment they land, and
the claim-time release frees them exactly when the current holder claims.
The reservation now keys on the **asset actually deposited** rather than the
loan's principal asset: that is the principal asset for cash-settled closes,
but the **collateral** asset for an in-kind / illiquid default — and VPFI is
collateral-eligible, so a non-VPFI-principal loan whose VPFI collateral is
handed to the lender in kind is now reserved too. The claim-time release was
corrected to free the same asset the claim is recorded under (previously it
always used the principal asset, which would have freed the wrong balance —
or none — for a VPFI-collateral claim). Assets with no user-facing
tracked-withdraw path carry no reservation and are untouched.

Deliberately **not** reserved (documented): the partial-repayment and
periodic-interest-shortfall paths pay the lender's **wallet** directly (not
a vault deposit, so no tracked balance to drain), and partial liquidation
deposits proceeds to the lender with no deferred claim (they belong to the
lender at liquidation time, not to a later holder).

The **held-for-lender** accruals (preclose offset and obligation transfer)
are also deliberately left for a follow-up (#597): unlike the terminal
paths, they land on a loan that stays **active**, whose lender of record
can change before the claim (the offset path rewrites it in the same
transaction; a later lender sale rewrites it and migrates the held funds),
so reserving them correctly needs a re-key across every lender-change path
plus a decision on exiting-lender ownership. Closes #592.
