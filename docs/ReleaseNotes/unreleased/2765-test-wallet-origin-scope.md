## Thread — Test wallet answers only the site under test (PR #TBD)

The live-review drivers inject a test wallet into the browser so a drive can
connect, sign and send transactions with the funded testnet wallets. Until now
that wallet answered any page or frame in the browser, so a redirect, a
third-party iframe or a compromised preview could have obtained signatures and
transactions from the test keys. Both drivers (the live driver under the app's
end-to-end tree and the harness-seed copy) now behave like a real wallet: they
answer only frames on the origin of the site the drive was pointed at. A frame
on any other origin is offered no wallet at all, and a direct call from one is
refused with the standard "not authorized" wallet error. The live driver also
records each refused attempt among the drive's blocked requests, so the report
shows that a foreign frame tried.

The Telegram link drive no longer prints the one-time link code. That code is a
live credential (whoever sends it to the bot first links their chat to the
wallet's alerts) and drive output is pasted into pull-request threads, so the
drive now prints only that a code rendered and its length.

The CI wallet fixture keeps its current behaviour: it serves Anvil's publicly
known development keys to a local preview server, so there is nothing to
protect there.

Closes #2765.
