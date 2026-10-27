## Thread — Activity shows what a collateral sale paid, and each party's part (PR #PRNUM)

A collateral sale now appears in Activity with the amount the buyer paid, in the loan's lending asset. Below that, each party sees their own part. The lender's part is held until they claim it. The borrower's remainder is shown as either sent to their wallet or held until they claim it, matching what the sale did. Before this, the row named the split but stated no amounts, so neither party could tell from Activity what they were owed or where it had gone.

The indexer records the paid amount when it reads the sale event. The asset type comes from the loan record, and when the event's asset is not the loan's lending asset, or the record is missing, the row says no amount was recorded rather than guessing. Each party's part comes from the amounts the sale event names for that party, and is shown only when the indexer has established the paid amount as a token amount. Refs #2876.
