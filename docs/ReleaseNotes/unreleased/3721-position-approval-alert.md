## Owner alerts — position-token approvals and vault outflows

A position token can be approved for transfer, either one token to one address
or every token of an owner to an operator. Whoever holds such an approval can
move the position, and the position's payouts follow it.

The indexer now files an inbox notice to the token's owner for every such
grant, naming the token and the whole address, and the connected app's bell
shows it in every translated language. The alert service also sends it on the
Telegram and Push channels the owner linked. This alert has no switch.

Owners can also choose to be told about every movement out of their vault:
what left, how much, where it went, why, and the loan or offer it belongs to.
The alerts card offers Always, Never, or the default, which is on while the
owner's protected mode is on and off otherwise. The choice is signed like
every other alert setting.

Both alerts are sent once and not retried when a channel fails. The service
starts from the newest event the first time it runs, and does not announce
an event that reaches it more than a day late. Amounts are in whole units
only when the token's decimals could be read, and nothing the token names
itself is shown. The messages are in English for now.

Part of #3721 (the alert; the contract's per-token-only rule is separate) and
part of #3434 (the EIP-7702 delegation watch follows).
