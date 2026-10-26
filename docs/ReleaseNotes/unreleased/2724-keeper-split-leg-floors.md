# Keeper: split liquidations pick legs that each clear their own floor (#2724)

Since #2871 the protocol holds every leg of a split liquidation to its own
share of the sale's floor, not only the two legs together: a leg that would
deliver less than the floor rate on what it sells now reverts the whole split.

The keeper's split picker used to take the two best quotes from different
aggregators and check only their sum. A pair whose total cleared but whose
weaker leg fell short would now be sent and refused, costing a transaction
before the keeper fell back to a full liquidation.

The picker now works out each leg's share of the floor from the split's own
sizing preview, rounded up as the protocol rounds it, and only considers pairs
where each leg's quote clears its share. Among those it takes the best combined
output, then applies the existing "is splitting worth it" check unchanged. When
no pair qualifies it goes straight to the single-route liquidation. The check
runs before sending and is not the final word: prices move between the quote and
the transaction, the protocol measures what each leg actually delivers, and a
refused split still falls back to the full liquidation as before.
