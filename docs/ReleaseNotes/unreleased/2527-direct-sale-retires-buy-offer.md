## Thread — A buy offer used by a direct sale leaves the offer book (PR #2648)

When a lender sold their position straight into a standing buy offer, the
contract marked that offer accepted and retired its position record, but the
only event it published was the loan-sale event, which names no offer. The
indexer and the app's offer-book catch-up therefore kept showing the consumed
offer as fillable, and anyone who tried to take it got a revert.

The direct sale now also publishes the same offer-accepted event the ordinary
accept path publishes, naming the consumed offer, the selling lender, the
loan and the principal the buyer took over. Every consumer that already
retires an accepted offer (the indexer's offer status and the app's book
catch-up) handles a direct sale the same way, with no change on their side,
and the activity feed shows the offer as taken. The loan-sale event is
unchanged. (No inbox notification is sent for an accepted offer yet, by
either route; that is queued separately in the indexer's notification
list.)

Closes #2527.
