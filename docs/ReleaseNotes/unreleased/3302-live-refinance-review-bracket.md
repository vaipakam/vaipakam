## Thread — the live refinance drive brackets the borrower review in time (PR #PRNUM)

The re-run of the live refinance drive on loan 3 stopped at the borrower's review, before anything was written. Two figures on the page, the payoff growth and the payoff permit maximum, were 3,805,175 wei lower than the drive expected. Closes #3302.

The page wasn't wrong. It computes the review from the chain time of its own last loan poll, which is block time refreshed about once a minute, and from a payoff view read at its own block. The page shows neither moment. The drive recomputed the figures at a later block, which put the request's last fillable moment a few seconds later, and compared the two exactly.

The drive now brackets each review figure in time. It reads one block before it opens the page and another after it has read the review rows. It evaluates the contract's payoff view at each of those blocks, using the deadline that block implies, and requires the page's figure to lie between the two results. The payoff and the wallet share never fall with time, so the page's true figure must lie between them. No tolerance is added.

The comparison that governs funds is unchanged. The payoff permit the borrower signs must still allow exactly the share the contract reports for the deadline actually signed.

> Caveat: verified by unit tests, not by a live run.
