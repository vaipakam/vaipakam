## Thread — Live-drive page-head tracker extracted and run under test (PR #TBD)

The live position-observe drive judges the forced close-out card against
the protocol at a bracket of blocks, and that bracket is built from what the
deployed page's own RPC traffic discloses: which endpoints serve the
deployment, the highest and lowest block each one announced, whether a head
was announced before the first contract read was asked, and two direct
probes of the page's provider for the floor and the ceiling. That whole
tracker — some nine hundred lines of state, listeners, resolvers and probes,
with the review-round reasoning that shaped each rule — sat inside the drive
itself. The drive runs on import, so none of it could be executed from a
unit test; every rule about it was pinned by reading the drive's source,
which can say where a stamp is taken but never whether the rule holds when
the events actually arrive.

The tracker is now its own module, built once by the drive with the
deployment being observed, the drive's endpoint-to-chain map, its uncached
fetch and probe timeout, and its ordering clock. Behaviour is unchanged and
every explanatory note moved with the code it explains. A new suite drives
the tracker through a fake page and covers the rules the bracket rests on:
heads count only on endpoints proven for the deployment in either order of
proof and announcement, an endpoint that answered for another chain stays
out for the whole run and across pages, two chain answers record as a
contradiction, the drain waits for parses in flight and admits when it
never reached quiet, the floor is proven per endpoint by an answer that
preceded the ask, and the direct probes take the lowest for the floor and
the highest for the ceiling while naming which endpoints answered. The
source guards that remain are the drive's own wiring — settle before sample
before scrape at both call sites — and the one seam the extraction created:
the tracker stamps with the clock it is handed and reads none of its own,
and the drive hands it the same monotonic clock its ledger uses, so the
floor's ordering proof and the ledger's comparison cannot drift onto two
clock origins. The fake page stand-in the RPC-watch suite carried inline is
shared between the two suites now rather than copied.

Closes #2120. No product surface changes; the connected app and the
contracts are untouched.
