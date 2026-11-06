## The day a loan ends earns no interaction reward

Interaction rewards count whole days, each priced at a full day of the loan's notional interest. A loan's reward days started the day after it opened and ran through the day it closed, so the closing day counted in full however little of it the loan lived. A loan opened at 23:59 and repaid at 00:01 earned a full reward day for both sides, for two minutes of interest and the 0.2% initiation fee, and both sides could be wallets one person controls.

The owner chose on 2026-11-05 that the closing day earns nothing. A loan's reward days now run from the day after it opens up to, but not including, the day it is repaid, preclosed, refinanced, defaulted or liquidated. A loan opened and closed across one day boundary earns no reward day. A refinance ends the old loan like any other close; the new loan earns from the day after it starts, as every new loan does.

Where the same loan continues, no day is lost: an in-place extension, a preclose obligation handover, a lender position sale, and a consolidation that splits an entry between its earner and the holder all split at the start of the day they happen on. That day belongs to the continuing entry, the holder the day ends with; before, the outgoing entry kept it. A continuation followed by a close on the same day therefore earns nothing for that day on either slice, so no sequence of steps can carry a closing day out of the rule. On a loan's opening day the continuing entry still starts the next day.

Funds: nothing is transferred differently. A loan closed on or before the reward day its term ends gives its lender and borrower one reward day less than before (the closing day), so a loan repaid at maturity earns all its contracted days but the last; only a loan closed on a later reward day keeps the whole window, so the day's reward pool is shared among the loans that were open for the whole day. The per-loan and per-interest caps are unchanged.

This changes contract code only, so it reaches a chain through a fresh deploy or the all-facets refresh. Closes #3171.
