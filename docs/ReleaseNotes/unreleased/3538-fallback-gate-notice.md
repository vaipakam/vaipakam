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

Part of #3538. The keeper's retry at the opening time belongs to the keeper's
own work, and the design thread adds the spec lines.
