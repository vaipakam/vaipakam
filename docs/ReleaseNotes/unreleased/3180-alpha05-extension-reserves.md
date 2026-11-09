## Thread — The next app lists extension reserves and takes them back (PR #3342)

A borrower can set aside the loan's token in their own vault for the loan's extensions. An extension, the keeper's or the borrower's own, draws on that reserve first. The reserve stays the depositor's: it is locked only for those charges, and they can take back what is unused whatever the loan's state. Until now the next app only said that reserves were not on its Claims page yet, and pointed to the current app.

Claims now has an Extension reserves section. It lists every loan where the connected wallet still has a reserve. The loans are found from the index's record of that wallet setting a reserve aside, being charged from it or taking some back. A loan can also be looked up by its number from the chain alone, so the list is never shown as empty while the index fails. Each row states the reserve and whether an extension can still draw on it. That is only on a running loan in a token with no interest cadence, and only while this wallet holds the borrower position, because an extension charges the current holder's vault. When the position's holder could not be read on a running loan, the row says so rather than calling the reserve safe.

Taking a reserve back withdraws all of it in one step, after the protocol's own dry run. The protocol pause holds it, as it holds every withdrawal, and a wallet flagged by the sanctions screen is refused in the frozen-proceeds words. The review says a running loan's next extension then has no reserve to draw on. If the wallet no longer manages the account that set the reserve aside, the review says so. The finish card measures where the money landed, including a protected account's queue, and says if more was set aside meanwhile and stays reserved.

The "not on this page yet" line is gone from Claims: every kind of payout it lists can now be collected there.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-RESERVE. Epic #3180.
