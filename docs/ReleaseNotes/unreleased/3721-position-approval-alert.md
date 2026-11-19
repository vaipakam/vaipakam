## Indexer and app — the owner is told when a position token is approved

A position token can be approved for transfer, either one token to one address
or every token of an owner to an operator. Whoever holds such an approval can
move the position, and the position's payouts follow it.

The indexer already reads the position token's own events. It now files an
inbox notice to the token's owner for every grant: which token, and the whole
address it was approved to, or the operator for an approval over every token.
Clearing an approval or revoking an operator sends nothing. The connected
app's bell shows the notice in every translated language.

Part of #3721 (the alert; the contract's per-token-only rule is separate).
