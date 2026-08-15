## Connected app — the claim list and offer children stop showing the previous answer (PR #1755)

Two more lookups get the treatment from PR #1753 and #1754: the list of
open claims for a wallet, and the child loans that came out of a given offer.

The claim list is the one that matters most so far. It kept the previous
wallet's open claims in place while the new wallet's list was being fetched, so
for a moment a freshly connected wallet was shown someone else's claims — and,
worse in the other direction, a wallet with claims waiting could briefly be
shown the previous wallet's empty list. A stale "nothing to claim" is a reading
that costs a user money, or at least a wasted trip.

The offer children lookup was already trying to solve this and getting it half
right. Its own note says it clears the previous offer's rows "so navigating
between offers can't briefly show the previous offer's children under the new
one" — but the clearing happened just after the page had drawn, which is the
frame it was meant to prevent. Both now label the answer with the whole question
asked and decide at drawing time whether the label still matches, so there is no
frame to shorten.

Both also discard their answer when the lookup is torn down, so reconnecting the
same wallet, or coming back to an offer already visited, reads as loading rather
than as the answer from before.
