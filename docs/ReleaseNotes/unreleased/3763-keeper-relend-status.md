## The app can tell whether repayments are re-lent on each network (#3763)

The keeper's matcher lends a repaid auto-lend loan again for owners who gave it permission. The app's Lend form pre-selects "Re-lend repayments for me" only where that actually happens, so the keeper now says, per network, whether it does.

Every few minutes, whether the matcher is switched on or not, the keeper records its `roll` step in the same keeper status table the standing instructions and the owner alerts use, and the indexer serves it on the existing keeper steps route. The step reads as running only when the matcher is switched on and the keeper can price that network's transaction fees, because without that it re-lends nothing there. A record that stops being refreshed reads as not running.

Nothing new is switched on and no new setting is needed.
