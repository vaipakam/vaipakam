## Thread — protected mode: the Ready balance

Protected mode delayed every payout to a wallet, but not a protocol use of the vault's own balance: a protected account could sign a vault-backed offer, or borrow on the instant market against collateral already in its vault, at once. A stolen key could therefore move a protected vault's money into a bad position without waiting. Protected accounts now have a Ready balance, and only Ready can be spent that way at once. The rest of the vault, the Protected balance, reaches a protocol step only after it is moved into Ready, which waits the account's delay and can be cancelled by the owner or any signer.

Three spends are covered, the only places an owner's own action spends existing vault balance: a vault-backed signed offer (signed accept, signed match, signed collection fill), the instant-market borrower's collateral that is already in the vault, and an auto-extension charge beyond the loan's reserve. Every entry that takes money from the wallet in the same call is unchanged, because new money is instant. A wallet deposit straight into Ready is instant too, Ready back to Protected is instant, and Ready never pays a wallet: the depository withdraw does not reach it.

A lock, a switch-off of protected mode or an account replacement empties Ready and cancels any pending top-up for good. The issue asked for a freeze; voiding is stricter, because a lock usually means a key is suspected and Ready is exactly what such a key could spend. An optional idle period of one to thirty days makes untouched Ready count as Protected again at the deadline, read lazily with no settle step and no keeper. Turning it on or shortening it is instant; lengthening it or turning it off waits the delay. The owner may keep a token's Ready counting for up to thirty days at once.

Intent fills and instant-market slices now materialize through a separate committed-capital entry that draws neither the depository ledger nor Ready. Before this, an intent fill debited the lender's depository holding for capital that had never been credited to it, which could leave money in the vault that the depository withdraw would no longer release; the instant-market borrower's wallet part was debited the same way.

The rules, entries and views live in a new ReadyBalanceFacet, which the three spend sites reach through one self-call; it refreshes together with OfferMaterializeFacet, InstantFillFacet, AutoLifecycleFacet, VaultDepositoryFacet and the vault template (which gains a protection-epoch read). Design: `docs/DesignsAndPlans/ReadyBalanceDesign.md`. Ships by fresh deploy. The presets (Basic, Strong, Maximum) and the app screens are #3345.

Closes #3344

> Caveat: returned principal is not rolled back into Ready (minimal v1, owner decision); returns go to the Protected balance only.
> Caveat: the idle expiry emits no event at the deadline; every ReadyUntilSet event carries the deadline so an indexer can derive it.
