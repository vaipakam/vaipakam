## alpha05 — the dated end of a loan in fallback (#3865)

The loan page now shows, for a loan in fallback, when it can be finished in kind. The date comes only from the protocol's own read, because it moves later by any time the platform is paused and past a network outage window it falls in; the page says so, along with when the loan entered fallback and the wait recorded then. The index does not store the date for the same reason.

Before the date, the lender's screen says plainly that after it anyone can finish the loan in kind, so the lender would receive the collateral split recorded at fallback instead of principal and would lose the swap the lender's claim can try again.

Once the protocol says the loan can be finished, anyone may finish it from the page. The review states that the caller receives nothing and pays only the network fee, that the recorded split is applied as it stands with nothing sold or priced, that the loan becomes Defaulted and each side collects its part with its own claim. The finish is sent only after the protocol's dry run passes, and the finish card shows the record and the split from the transaction's own log. The borrower claim's waiting note now names the dated end as a third way the fallback ends.

Advances #3865.

> Caveat: no Anvil end-to-end spec covers it yet, because no scenario can put a loan into fallback (every swap route must fail); the rules are covered by unit tests.
