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
lender-proceeds deposit site across the ordinary terminal paths:

- full repayment,
- time-based default (liquid DEX-swap settlement),
- borrower preclose (direct) and the preclose offset / obligation-transfer
  "held-for-lender" accruals,
- health-factor liquidation (full, atomic-split, and discounted variants).

At each, when the principal asset is VPFI, the proceeds are reserved
against the unstake path the moment they land in the lender's vault, and
the existing claim-time release frees them exactly when the current holder
claims. Non-VPFI principal assets have no user-facing tracked-withdraw
path, so they carry no reservation and are untouched.

Deliberately **not** reserved (documented): the partial-repayment and
periodic-interest-shortfall paths pay the lender's **wallet** directly (not
a vault deposit, so no tracked balance to drain), and partial liquidation
deposits proceeds to the lender with no deferred claim (they belong to the
lender at liquidation time, not to a later holder). Closes #592.
