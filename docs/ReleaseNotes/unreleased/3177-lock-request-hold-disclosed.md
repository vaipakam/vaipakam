# A pending Telegram LOCK request holds only the keeper's releases (#3177)

The protected-vault spec said a pending Telegram LOCK request holds the account's payouts and NFT transfers. In practice the hold binds only the keeper: release stays permissionless, so anyone can release a payout or transfer that is already past its delay, in the short window before the keeper's lock lands on chain.

The owner chose to disclose this rather than add an on-chain "lock pending" marker. A marker would be a keeper transaction just like the lock itself (which needs no co-signature), sent in the same run, so it would close no window. The vault operations and keeper operations specs now say that protection starts when the lock lands. They also say that every payout past its delay was queued on chain and could have been cancelled throughout its delay, that the owner's alert of a queued payout is best effort rather than a guarantee, and that the owner's own lock from the app has no keeper delay.

No contract or keeper behaviour changes.

Closes #3177
