## Keeper — position upkeep: daily rental deductions and backstop fills (#3097)

Two permissionless steps on a single position had nothing calling them. The daily NFT-rental deduction moves one elapsed day's fee from the renter's prepayment to the lender and the treasury, and its last day closes a fully used rental as repaid. The backstop fill lends from the treasury-seeded backstop vault to a borrower offer that opted in, once its eligibility time has passed. Without a caller, a lender was paid rent only when the renter repaid, a used-up rental stayed open, and an opted-in offer could expire unfilled. The owner has decided that every such step gets a keeper backstop.

A new hourly keeper duty, position upkeep, takes both. For rentals it reads one window of the active-loan list a run and deducts a day only where the loan's own record shows one due. It never charges past the agreed term, and it never touches a loan whose deduction clock is behind its start. That is a legacy-record case where the protocol would charge a day without counting it. For the backstop it finds opted-in offers from the indexer's record of opt-ins and decides each from the offer's own on-chain record. The protocol decides the rest: its switches, the collateral's liquidity and oracle coverage, the borrower's sanctions screen, and the backstop's caps.

Every call is simulated first and sent only if the simulation succeeds. Each step has its own share of the run's sends. The run's report names every deduction with the fee the chain recorded and, from the loan's status afterwards, whether it closed the rental, and every fill with the loan it opened and the amount lent. The keeper pays only gas and receives nothing in either step.

Both steps ship switched off. The rental deduction arms with the pass's own flag. The backstop fill needs a second flag of its own, because each fill commits treasury capital to a new loan and counts against the keeper's free-tier service capacity. Whether the keeper key should do that is a separate owner decision.

The two holder consolidations on #3097 are not covered, by owner decision. The protocol accepts them only from the current position holder, so a keeper call could never succeed, and the owner chose to keep them the holder's own step rather than change the contract. They are now recorded as user-driven, not as gaps. The connected app does not offer either call today, so a holder who wants one makes it directly.

Advances #3097.

> Caveat: the holder consolidations (`consolidateCollateralToHolder`, `consolidatePrincipalToHolder`) are user-driven by owner decision (2026-11-04) and have no app button yet.
> Caveat: the deduction itself checks neither the agreed term nor that the loan's deduction clock is at or after its start; the keeper declines both cases, but nothing stops another caller.
