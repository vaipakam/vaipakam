## Thread — Forced close-out reconciles a replaced transaction after a reload (PR #3040)

The forced close-out card watches a submitted close-out with a wait that
notices when the wallet speeds it up or cancels it. Closing the page lost
that wait. On return the card had only the transaction's hash, and once the
original left the mempool it could never say what had happened, so the
lender had to tell the card their wallet no longer showed it.

The card's device record now also keeps the sending account and the nonce,
read back from the chain once the node has the transaction. After a reload,
when the hash has no receipt and the account has since mined past that
nonce, the card knows something else from the wallet took the close-out's
place. It cannot tell a Speed Up of the same close-out (which may have gone
through) from a cancel or another transaction (which moved nothing), so it
says that, waits until the position has been re-read, and then shows the
loan as it stands. The issue proposed calling this case "replaced", which
would have told a lender whose sped-up close-out succeeded that nothing
happened; the new "superseded" outcome avoids that.

This check runs alongside the wait rather than after it, because a wait on
a hash the node no longer knows does not give up: it keeps watching. While
the node still has the transaction, the wait's own answer (cancelled, or the
sped-up copy's outcome) is used instead, since it is the more exact one. A
second tab open on the same loan picks up the sending account and nonce
from the shared record, so it can make the same check even when its own
node no longer has the transaction.

A record written before this change still works, without the nonce check.
The check, and the restart of a wait that failed, back off from one second
to thirty, instead of asking every second for as long as the page is open.

Closes #2086.

> Caveat: a reload cannot reconcile a transaction whose nonce was never read
> (the page closed within seconds of sending, before the node had it); that
> case keeps the earlier behaviour, where the lender answers for their wallet.
