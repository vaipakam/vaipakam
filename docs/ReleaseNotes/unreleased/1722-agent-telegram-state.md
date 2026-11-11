## Agent — Telegram links and LOCK requests move into the agent's own storage (PR #<n>)

Which chat receives a wallet's alerts, the handshake codes that link a chat,
the pending removals of a chat under protected mode and the Telegram LOCK
requests used to sit in the shared database, which the indexer's and the
keeper's bindings can also write. A compromised sibling could have pointed an
owner's alerts at its own chat, cancelled a pending removal, or recorded a
LOCK the owner never sent. They now live in a Durable Object only the agent's
code reaches. Every chat change the agent decides is written in one guarded
step that applies only while the rows it read are unchanged.

The keeper reaches this state only through four new agent routes, behind a
token of its own (`KEEPER_AGENT_TOKEN`; without it the routes answer 503). It
collects a network's open LOCK requests, asks which wallets have one open,
reports how each ended, and asks for owner alerts to be sent. An alert travels
as typed data, never as text: the agent checks every value, writes the message
from the platform's own wording in the owner's language, and sends it to the
chat linked now. So the token cannot send arbitrary text to the chats owners
trust for alerts, and no value filled into a message can form a link. Each
request names the keeper's Diamond, and the agent refuses one that is not its
own, which keeps the guard the keeper's database writes had against a retired
deployment. A repeated outcome report records and sends nothing.

A LOCK that no keeper answers within an hour now gets one message telling the
owner the vault may not be locked and to lock it from the app. The periodic
due-date reminder reads the linked chats once per batch, so it stays inside
the free plan's request budget.

The shared copies are emptied by a migration rather than copied across, so a
chat its owner removes can never keep receiving alerts from the old rows.
Testnet owners link Telegram again. The new state is not in the nightly
backup; it has the platform's own point-in-time recovery, and if it were ever
lost owners would link again.

Advances #1722. The keeper's move onto these routes is the next change, in the
keeper's own work; until it lands the keeper's Telegram messages are dark.

> Caveat: until the keeper uses the new routes, its Telegram messages (health-factor bands, pre-grace warnings, LOCK answers, protected-vault alerts) are not sent; Push is unaffected, and a LOCK is answered with "lock from the app".
> Caveat: the emptied shared tables and the `tg_chat_id` column stay until a follow-up drop.
> Caveat: owners on testnets must link Telegram again.
