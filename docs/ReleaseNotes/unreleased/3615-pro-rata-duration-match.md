## Thread — Pro-rata matches admit a shorter borrower term (PR #3617)

Two resting offers used to match only when they named exactly the same term. That is still the rule when both chose full-term interest, because there the term is part of the price: the borrower owes interest for all of it.

When both chose pro-rata interest, the borrower now matches any lender whose term is the same as or longer than its own, and the loan runs for exactly the term the borrower asked for. Under pro-rata, interest is owed only for the time the loan is held and the borrower can repay at any moment, so the lender's term already meant "the longest I will lend for". A borrower never gets a shorter term than it asked for, and a lender never lends longer than it offered. A ranged pro-rata lender offer can now be filled by several borrowers with different shorter terms, each as its own loan.

Nothing new is stored and no setting was added. The loan already took its term from the borrower offer; only the match check changed, in the one shared match core, so the match, the signed-offer match and every match preview agree. No funds move differently: amount, rate and collateral rules are unchanged, and the loan's term is stated in its creation event as before.

This came from an outside design proposal that suggested tolerance windows around each term with a midpoint, per-offer tolerance fields and an opt-in "accept any shorter" flag. Those were not adopted: under pro-rata the windows protect nothing the interest mode has not already given away, and the flag would repeat what choosing pro-rata already says. The same proposal's on-chain price-time priority (refuse a match when a better offer exists) was also not adopted; it would need an unbounded scan of the book and anyone could revert a match by posting a slightly better offer. The spec now says so.

Follow-ups: the keeper matcher groups offers by term, so it does not yet propose cross-term pairs; and the app should tell a lender choosing pro-rata that its term is the longest it lends for.

Closes #3615
