## Telegram link status — read from the alert service, not the browser

The Alerts card used to show Telegram as linked from a flag kept in the browser, which was wrong whenever the link changed somewhere else: another device, a chat removed after protected mode's wait, or the relink every testnet owner needs after the agent's state moved. The card now shows what the alert service itself holds for the network: linked, not linked, or a removal or move to a new chat that is pending, with the time it takes effect (or that the wait starts once the old chat is told).

Whether a wallet has Telegram alerts, and when a protected owner's chat is about to change, is the owner's own business, so the read is signed. The owner signs once (a free message, not a transaction) and the service answers and issues a read pass that this browser tab keeps for 12 hours, so the card refreshes without asking again. The service keeps only a digest of the pass, and the pass reads the status and nothing else. An ordinary wallet's pass reads every network; a smart account's reads the signed network only, the same scope rule as unlinking.

When the card has not read the status it says so and offers the check, and when the service cannot be reached it says the status is unknown. It never falls back to the browser flag. The one optimistic state is right after a successful test alert, which itself proved delivery, and it lasts only until the read confirms it. The answer never carries the chat id or the alert phrase; it says only whether a phrase is set, which the phrase field now shows.

The alpha05 alerts surface is not changed here; it can use the same two routes.

Part of #3573.
