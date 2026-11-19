## App — the loan page says when a failed sale can lead to settlement in kind

Since #3743 a liquidation or default sale whose listed swap routes all fail is
undone and recorded instead of moving the loan straight into settlement in
kind. Only a failed sale made once an earlier failure is old enough opens it,
so one bad attempt by any caller cannot push a loan there.

The loan page now reads that record from the contract for every viewer of an
open loan. While a failure is recorded it says a sale did not complete and
when settlement in kind can open, using the contract's own time. Once that
time has passed it says the next failed sale can move the loan there. A
deployment without the record shows nothing.

The lender's forced-close card checks the same thing before it asks the
wallet. When every route would fail and the protocol would defer the
close-out, it sends nothing and says so: sending now would only record the
failed sale, settlement in kind can open ten minutes after the first recorded
failure, and the close-out can be tried again after that wait.

Part of #3538. The keeper's retry at the opening time belongs to the keeper's
own work, and the design thread adds the spec lines.
