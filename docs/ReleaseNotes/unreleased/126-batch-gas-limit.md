### Batch actions are sent with enough gas for every item (#126)

Repay all, Claim all, the batch sale listing and the batch refinance each
send one best-effort batch. The app used to send it at the wallet's gas
estimate. For a best-effort batch that estimate is too low: the node looks
for the smallest limit at which the batch as a whole succeeds, and a batch
succeeds even when every item inside it ran out of gas and was skipped. A
two-loan Repay all on the test chain mined that way, closing neither loan
while each repaid fine on its own.

The app now takes the estimate for the same batch with every item marked
must-succeed, where an item short of gas fails the estimate, and sends the
best-effort batch at that figure plus the standard 30% margin. When some
item would fail anyway, it sizes from the items that would run. A skipped
item now means the item was not eligible, not that it was starved of gas.

This PR also brings back the Repay all end-to-end test (spec 55), which is
what found the problem.
