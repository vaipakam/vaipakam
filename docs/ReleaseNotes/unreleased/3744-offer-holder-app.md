## Thread — The app and indexer follow the offer's position token (#3744)

An open offer now belongs to whoever holds its position token, not to the
wallet that posted it. The app follows that rule everywhere it offers a step
on an existing offer. Editing, cancelling, the keeper and Full-tariff
settings are offered to the token's holder. Raising an offer's amount is
offered only to the creator while it still holds the token, and anyone else
is told why Save is off. When neither the indexer nor a live read knows the
holder, the row is shown read-only and says so; it is never treated as the
creator's. Taking an offer the wallet created or now holds is refused before
anything is signed, because both sides of the loan would be one wallet's.

The indexer adds a `holder` field to every offer it serves, from its record
of the token's transfers (the zero address once the token is retired). It
also serves `GET /offers/held-refunds/:address`, the offer amounts its event
log shows as still held for a wallet's offer tokens. Those figures are only
candidates: the app reads the amount and the token's holder of record from
the contract before it shows a line, and offers Collect only for a line the
chain confirms. A line whose live read failed is shown as unconfirmed with no
step. Collect moves the amount into the holder's vault as free balance;
Withdraw takes it to a wallet from there.

The new contract refusals read in plain words: a flagged offer holder, an
amount raise by anyone other than the creator, a collect with nothing held,
and the reworded holder-only cancel. The activity feed names the holder on
the escrow-returned and refund-collected events and labels the Full-tariff
consent event.

Copy that still said money lands in a wallet now says the vault, where the
contract now pays it: the offer cancel (including the offset offer), the
direct loan sale's proceeds and the extra-collateral release.

Part of #3744.

> Caveat: the indexer cannot see a held line for a token that moved after
> its offer's token was retired, unless the return itself named the wallet.
