## alpha05 — Auto-lend setup on Lend, and Auto-lend on Positions

The new app's Lend page now asks one question after the pair: post a one-time offer, or keep lending when repaid. The second choice sets up Auto-lend, the lender's standing instruction to the protocol. The lender sets the amount, the lowest rate, the loan-to-value ceiling, the longest term, an optional end date and whether pro-rata borrowers are taken; Advanced mode adds the most lent out at once and the smallest loan. Every figure is parsed exactly, and the term is checked against the network's live maximum.

The review is the protocol's own dry run from the wallet, read at one block. It states every figure the setup binds, including the smallest loan resolved from the network's floor, the first time a loan is possible after the terms-age wait, and what is not promised: no borrower takes it directly, a matching service fills requests that fit, and nothing guarantees a fill. The end-date wording follows the lend-until design: no new loan is agreed to run past it. A risk-access step the protocol would check at each fill is offered before the setup, so fills do not fail later for it.

The terms and the money are sent as one transaction through the protocol's multicall, after an approval of exactly the amount, so the terms are never recorded without the money behind them. The finish card measures the outcome from that transaction's own logs and the token's move into the wallet's vault. Positions now lists each Auto-lend with what waits to be lent, what is lent now, its limits and whether it is lending, ended or stopped.

"Auto-lend" now means the standing intent everywhere in the app. The older auto-post-on-deposit switch, which nothing acts on, is renamed in the protocol console to say so, pending its removal in #3691. Adding money, taking unlent money back, changing the limits and stopping follow in the next part of #3624.

Advances #3624 (epic #3180).

> Caveat: managing an Auto-lend (add, withdraw, change, stop) is not in this part; the Positions card says so.
