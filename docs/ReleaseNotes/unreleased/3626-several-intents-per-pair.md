### Several standing intents per asset pair (#3626)

A lender can now hold up to eight standing intents on the same lending and collateral pair, numbered 0 to 7. Before, one wallet had exactly one intent per pair, so a lender who wanted some capital at a low rate floor and some at a higher one, or two amounts with different end dates, had to fall back to separate offers.

Each intent is fully independent: its own funded capital, exposure cap, rate floor, loan-to-value ceiling, longest term, smallest fill, lend-until time, pro-rata choice and priority-routing opt-in. A fill draws from the one intent the filler names, and the loan remembers which it was, so the exposure it holds is released from that intent and an auto-roll sends its proceeds back to it. The protocol never chooses between a lender's intents. The reference keeper tries the lowest floor first, so a ladder fills from its cheapest rung up, and a lender with several intents gets no more turns in the keeper's walk than a lender with one.

Every intent action, read and event now names the intent it concerns. The backstop vault and the yield-aggregator adapters keep using intent 0. In the new app, Claim everything labels each standing offer's un-lent capital by its number, and the "lenders ready" figure counts a lender with several intents on a pair once.

This changes the storage layout, so it reaches a chain only through a fresh deploy. Design: `docs/DesignsAndPlans/IdleLiquidityMatchingDesign.md` §4b.

Closes #3626
