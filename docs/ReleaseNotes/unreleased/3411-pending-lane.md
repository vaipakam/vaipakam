## Indexer and app — pending actions shown at once, marked not final (#3411 part 2)

The indexer records an event only once the chain reports its block as safe, which keeps anything the platform acts on away from a block that can still be replaced. The cost was a delay of several minutes before a fresh action showed up in the app.

Each indexer pass that has caught up to the safe block now also reads the blocks above it, up to the chain's newest block, and keeps what it finds as a separate pending list for that chain, replacing the previous one. Once the safe block passes a pending event, the normal scan records it and it leaves the pending list. If the chain replaces a pending block, its events are simply missing from the next read, so nothing has to be rolled back. The read is bounded, and the list records how far it reached, whether it kept every event, and when it was made.

The Activity feed can ask for the pending list alongside its first page. Pending events come back apart from the settled ones, marked as not final, with the block's hash and no time. A list that is missing, more than five minutes old or unreadable comes back as "not known", never as an empty list. An event the settled feed already holds is never repeated in the pending list. A change in the pending list also sends the "activity updated" push, so an open Activity page refreshes at once.

In the app, the Activity page shows the wallet's pending actions under "Not final yet", each marked "Pending, not final yet" in place of a time, with a note that the chain can still replace them. When the pending list is incomplete or not known, the page says that very recent actions may not be listed yet. Inbox notifications and alerts are still sent only for settled events.
