### The automated sanctions adder's reach is bounded (#3239)

The platform's own sanctions list lets an automated adder key apply updates that only list addresses. A stolen adder key was meant to be limited to nuisance. In practice it could do more: listing a wallet also blocks its claims, its partial and early withdrawals and its vault creation until the Safe delists it, and nothing limited how many wallets one key could list. It could also record a publication dated far in the future. That made every genuine later OFAC publication look older, so updates stalled until the owner authorized a rollback.

The list now limits an adder to a number of listings per UTC day across all its updates. The limit is 100 by default, and the owner can set it between 10 and 1,000; at mainnet, a change waits out the governance delay. The Safe, as remover, is not limited. A publication with more additions than the day allows lands in batches on later days and is stated as outstanding meanwhile, or the Safe applies it at once.

No update from any account may now record a publication dated after the chain's own UTC date. OFAC's dates are never ahead of UTC, so a genuine file always passes.

The adder service reads how many listings the day still allows and plans within it. It reports the rest of the publication as waiting for the next UTC day, not as an error or an overstated count. Against a list deployed before this change, which has no cap, it plans without one. The manual diff tool, which plans calls for both signers, gives the adder only what the day allows and puts the rest of the additions in calls for the Safe, which has no cap.

The functional spec and the sanctions runbook now say what a listing blocks, what stays open and how to recover.

Advances #3239. The remaining item, an operator alert on every listing, needs a watcher that runs apart from the adder's own host.

> Caveat: An adder can still record a false file under today's date. A genuine file with the same date then waits until the owner authorizes it or the next publication arrives.
> Caveat: The rehearsal lists already on Base Sepolia and Arbitrum Sepolia keep the old behaviour until they are redeployed.
