## Indexer, agent and app — a Closed network

A network being wound down ends in the Closed state: no loan is open or in the fallback state, and only its owners' own balances remain (design: `docs/DesignsAndPlans/NetworkWindDownDesign.md`). The deployment record can now say so, as `networkState: 'closed'`, written in a reviewed commit once the chain passes the Closed test. A network that is Closed stays in the deployment bundle, so the app and the services still know it.

The indexer stops reading a Closed network: its scheduled scan, the per-chain ingest pings, the backing snapshot and the listing sweep all skip it. Its rows are kept and the read routes keep serving them, so past statements can still be produced. The ingest health answer leaves it out of the set a prober watches and lists it under its own `closed` field, so a cursor that stopped on purpose is not read as a stall.

The agent sends no alerts for a Closed network: the periodic-interest pass skips it, and an alert-settings save, a swap order post or a marketplace listing post for it is refused as `network-closed`.

In the app, every screen that opens a position on a Closed network (the guided start, borrow, lend, rent, the offer book, the marketplace and the faucet) is replaced by the closed view. It reads the wallet's open offers and the capital left in its Auto-lend slots straight from the network, offers Cancel and Take capital out, and links to the vault and Claims pages, which already read the chain directly when the indexer is not answering. Every screen on such a network says that nothing new opens there and that the ways out stay available with no end date. Taking capital out of a slot joins the exits the Terms check never refuses.

The keeper's part (running nothing for a Closed network) belongs to the keeper thread.

> Caveat: the closed view is covered by unit tests only; no network is Closed yet, and a fork drive needs the test fixture to write a closed record.
