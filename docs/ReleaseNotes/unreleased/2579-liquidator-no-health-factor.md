## Keeper — the liquidator stops re-reading illiquid loans (PR #<n>)

On Base Sepolia, while the only active loan had illiquid collateral, every
liquidator run logged "aggregate3 rejected … retrying serially" and then read
that loan a second time. Nothing was wrong with the RPC. An illiquid loan has
no health factor, so its read reverts by design. In a batch of one, that
loan's own revert matched the rule the keeper used to spot a rejected batch,
which was "every entry failed with the same error". So one loan's expected
answer was logged as an RPC fault and retried.

The shared batch reader now tells the two cases apart from what the error is,
not from how many entries share it. A rejected batch carries the error of the
batch call itself. A loan's own revert carries the name of that loan's read.
So a failure in a batch of one is that loan's own result, and a real rejection
of a batch of one is still retried loan by loan. The liquidator used to carry
its own copy of the batching and retry rules. It now uses the shared reader,
so there is one set of rules for every keeper pass that batches reads.

The liquidator also stops asking for a health factor that cannot exist.
Whether a loan is illiquid is fixed when the loan opens and never changes
afterwards. So once the chain has answered "illiquid" for a loan, the keeper
leaves that loan out of later scans for as long as it keeps running. The
keeper forgets a remembered loan once the loan leaves the active list. After a
restart, it learns the list again with one read per illiquid loan. Rentals
secured only by their prepayment also have no health factor, but they are
still read each run, because in their case the reason is the loan's
collateral amount rather than a fact fixed when the loan opened.

Each complete scan's line now ends with a count of the loans that have no
health factor (`noHealthFactor=N`), so the scanned count and that count add up
to the whole active book. Nothing on-chain changed. Closes #2579.
