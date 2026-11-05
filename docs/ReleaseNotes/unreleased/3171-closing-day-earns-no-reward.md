## The day a loan ends earns no interaction reward

Interaction rewards count whole days, each priced at a full day of the loan's notional interest. A loan's reward days started the day after it opened and ran through the day it closed, so the closing day counted in full however little of it the loan lived. A loan opened at 23:59 and repaid at 00:01 earned a full reward day for both sides, for two minutes of interest and the 0.2% initiation fee, and both sides could be wallets one person controls.

The owner chose on 2026-11-05 that the closing day earns nothing. A loan's reward days now run from the day after it opens up to, but not including, the day it is repaid, preclosed, refinanced, defaulted or liquidated. A loan opened and closed across one day boundary earns no reward day. A refinance ends the old loan like any other close; the new loan earns from the day after it starts, as every new loan does.

Where the same loan continues, nothing changes and no day is lost: an in-place extension, a preclose obligation handover, a lender position sale, and a consolidation that splits an entry between its earner and the holder still end the outgoing entry after the day of the change and start the continuing one the next day.

Funds: nothing is transferred differently. A loan closed before its term ends gives its lender and borrower one reward day less than before (the closing day); a loan closed at or after its term's end is unchanged, so the day's reward pool is shared among the loans that were open for the whole day. The per-loan and per-interest caps are unchanged.

This changes contract code only, so it reaches a chain through a fresh deploy or the all-facets refresh. Closes #3171.
