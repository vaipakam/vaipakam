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
principal, and records exactly that status: internally matched, repaid, settled,
or defaulted. So whatever truly closed the loan in that block is what the label
reflects — including the case where a claim-time match is **settled in the same
block** (previously that too could be mislabelled, and would have been left
stuck "active" by a naive fix).

User-visible effect: in the (uncommon) same-block cases above, a loan now shows
its true terminal state (repaid / settled) rather than "internally matched" or a
stuck "active". No balances were ever affected — this was a status-label fix
only. Closes the last of the re-scan-determinism follow-ups raised during the
#760 review.
