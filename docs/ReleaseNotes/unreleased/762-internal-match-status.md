## Fix — indexer no longer mis-labels a partially-matched-then-repaid loan (#762)

The indexer projects each loan's lifecycle status into its read database. One
rare ordering produced a wrong label: if a loan was *partially* settled by an
internal match and then *fully repaid* (or swap-repaid) later in the **same
block**, the indexer could record the loan as "internally matched" when it was
actually repaid.

The cause was an inference: the internal-match handler decided a loan was fully
matched by checking whether its principal had reached zero at the end of the
block. But a same-block repay also drives the principal to zero — so the handler
mistook the repay's effect for the match's, stamped the loan "internally
matched," and the later repay update (which only corrects loans still marked
active) couldn't fix it.

The handler now reads the loan's **actual on-chain status** at that block (the
same lookup it already performs returns it) instead of guessing from the
principal. It records "internally matched" only when the chain itself reports
that state; when a later same-block event is the real closer, the loan is left
for that event's handler, which sets the correct terminal status. Loan labels
now match the chain in this ordering.

User-visible effect: in the (uncommon) case above, a loan that was repaid now
shows as repaid rather than internally matched. No balances were ever affected —
this was a status-label fix only. Closes the last of the re-scan-determinism
follow-ups raised during the #760 review.
