## Thread — alpha05 states and measures vault-credited payouts (with PR #3387)

With the vault outflow policy, a loan claim no longer pays the claimer's wallet: the protocol credits it to the current position holder's own vault, as that holder's free funds, whatever its protected mode. A new loan's net principal lands in the borrower's vault the same way. alpha05 described and measured the old behaviour, so its loan claim, Claim everything and borrow flows would have reported a correct claim or loan as only partly done.

Each of those flows now names the vault as the destination before signing, says that protected mode delays only the later withdrawal, and measures the credit from the protocol's own record of the movement into the reader's vault: one that stayed in the reader's own vault counts, one into another vault, for another loan, or of a class the protocol does not credit never does. When the vault cannot be read after the transaction, the credit is stated as unmeasured rather than as missing. The finish card offers the withdrawal from the vault page.

A borrower's acceptance now shows two figures where it showed one: the amount less the fee credited to the vault, and the small fee share the protocol pays back to the sender's wallet. Both, plus the rest of the fee, must add up to the principal the loan recorded, or the outcome says it is not substantiated. The borrow request's receipt and the borrow, lend and lending-offer explanations say the amount goes into the borrower's own vault.

Seller claims, extension reserves, standing-offer capital, free vault VPFI, payroll, cancellations and taking back collateral are unchanged: the protocol still pays those to the wallet, or where protected mode routes them. The withdrawal description now says the protocol pays an account without protected mode only to its own wallet.

Advances #3386 alongside #3205 part 2. The public guide's wording for claims and borrowing follows when these contracts reach the testnets.
