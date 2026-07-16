## Notification center — the in-app inbox (PR #<n>)

The user-facing half of the in-app notification center (#1213 / E-11):
a bell in the connected-app header with an unread count and a dropdown of
your newest loan updates. It reads the per-wallet feed the indexer
materialized in PR 1, so it's free and needs no setup — the same
loan-lifecycle events the paid Telegram / Push channels deliver, shown
right in the app.

Each row is written as an outcome, not an event name ("A loan was fully
repaid — see what you can claim"), with an icon per kind, and deep-links
to the position, which re-verifies the exact state on chain — the feed is
a convenience hint, never the source of truth. A row with no loan id (a
future calendar row) renders as a plain line rather than a dead link.

Read/unread is tracked entirely on the device: a per-wallet "last-seen"
cursor keyed on the same chain-order position `(block, log index)` the
feed sorts by. Opening the panel marks everything currently loaded as
read and clears the badge; the cleared state is scoped per wallet and per
chain and survives a reload. There is no server mark-read call, so
there's nothing for a stranger to clear on your behalf. The badge caps at
"9+" so a first-connect backlog reads calmly. The bell shows only for a
connected wallet, and if the indexer is briefly unreachable the panel
says so honestly rather than showing a fake-empty inbox.

Part of #1213. Closes the E-11 frontend slice.
