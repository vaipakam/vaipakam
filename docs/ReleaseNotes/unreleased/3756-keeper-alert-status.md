## The app can tell whether owner alerts are being sent on a network

An owner who turns on a claim by their recovery address relies on hearing
about a claim in time to cancel it. The alerts that tell them are an
operator's service, and a network's keeper may not send them. The keeper now
says, every few minutes and whether it is sending them or not, if owner alerts
are being sent on each network it serves, and on which channels: Telegram
(through the alert service) and Push. The app reads this from the indexer's
keeper status and can say "alerts are being sent", "alerts are not being sent
on this network" or "the status could not be read", instead of assuming.

A statement older than fifteen minutes is read as not running, so a stopped
keeper never reads as sending. The publishing rule is now shared with the
standing-instruction runners, which already stated their status the same way.
Nothing is sent on chain, and no arming flag changes.

Design: `RecoveryClaimDesign.md` section 4.6 (#3756).
