## Payouts into a vault show on the vault owner's Activity page (#3388)

When the platform pays a position holder, it pays into the holder's vault, and the payment record names the vault contract as the recipient rather than the holder's wallet. The Activity page matches rows to wallets, so such a payout reached the holder only when the indexer could tie it to one of their loans.

The indexer now keeps a record of which wallet owns each vault, taken from the vault's creation and from every payment out of a vault. When a payment goes into a known vault, the record names the owner as well, and the payout appears on that owner's Activity page. Payments already recorded are updated the same way when the change is deployed.

If the indexer does not know a vault's owner, the payout is shown as it was before, through the owner's loans only. The page never guesses an owner.

Closes #3388.
