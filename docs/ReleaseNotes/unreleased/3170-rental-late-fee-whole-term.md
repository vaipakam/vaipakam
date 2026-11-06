## A late rental's fee is sized on its whole agreed rent, and a fully prepaid rental can always settle (#3170) (PR #3193)

A borrower could prepay every remaining day of an NFT rental through a partial repayment. Two things then went wrong. Full repayment reverted, because it refused any rental with nothing left in its prepayment. And the late fee, which was sized on the rent still owed, read zero for the whole grace window, while the lender's NFT stayed locked.

The owner chose to size a rental's late fee on its whole agreed rent: the daily fee times the agreed number of days, whatever part of it has been paid and however. It still starts at 1% the day after maturity, rises 0.5% a day, is capped at 5%, and is clamped to the buffer the rental funded. So every late rental now pays the same rate on the same base, and prepaying the rent no longer avoids it. Full repayment of a fully prepaid rental now settles inside grace: it pays the late fee from the buffer and returns the rest of the buffer. The buffer still funds the late fee alone. Rent that the prepayment cannot cover is refused, never drawn from the buffer.

The repayment quote, the direct early close of a late rental, and the repayment itself all read the same fee rule.

Closes #3170
