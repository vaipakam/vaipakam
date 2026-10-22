## Indexer and app — the Offer Book names refinance requests (PR #2661)

**A refinance request now says what it is on the Offer Book (#2528).** A borrower asks to refinance a running loan by posting a borrow request tagged with that loan. A lender who accepts it funds a new loan that replaces the old one. Until now the indexer kept no record of the tag, so on the Offer Book a refinance request looked exactly like an ordinary borrow request. The indexer now records which loan each request is for, and the Offer Book row says "refinance request: the borrower wants to move loan #N to a new lender". The label is translated in the nine translated languages.

**Unknown is kept separate from "not a refinance".** The market data now carries three states: the loan the request refinances, a recorded "not a refinance request", or not read yet. The last covers a row whose details the indexer could not read when it first saw the offer, until its repair pass reads them. The row shows the tag only when the request is known to be a refinance. An unread request is never presented as an ordinary one by a "not a refinance" claim. A schema change adds the column, and offers indexed before it are filled from each offer's own creation record in the activity ledger. Any offer without such a record stays "not read yet". The app's direct chain reads carry the tag as well.

Closes #2528.
