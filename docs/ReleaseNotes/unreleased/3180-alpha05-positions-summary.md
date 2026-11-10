## Thread — alpha05: Positions adds up a wallet's live loans in one card (PR #3488)

In the new app (`apps/alpha05`), Positions now opens with one card that adds up the wallet's live loans whenever it holds two or more, so a borrower or lender with several loans sees the whole picture before the list. With one loan the card is not shown, since that loan's row already says all of it, and the side choice (all, lent, borrowed) narrows the card with the lists.

For each side the card states the principal still owed or still out, per token. Amounts in different tokens are never added together; comparing them at today's prices stays with the exposure line, which says what it cannot price. NFT rentals have no token amount, so they are counted rather than totalled.

It then names the next date a payment falls due, a final repayment or an interest checkpoint, with a link to that loan. Below it, as warnings, it lists the loans that need the reader now, each linked: grace period over, past due in the grace period, and in fallback. A loan in more than one stage is named once, under the more severe one. Loans whose dates could not be read are counted, because the next date may be one of theirs.

Interest is not in the totals, and the card says so: each loan's page states what repaying it costs now. The card reads only what the list reads, shows nothing until that read answers, and says when the walk was partial. It manages no loan; every loan stays its own position and its own row.

Closes #3320.
