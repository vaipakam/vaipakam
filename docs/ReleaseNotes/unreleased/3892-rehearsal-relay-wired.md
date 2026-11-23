## Deploy rehearsal — the driver runs the cross-chain relay itself

A rehearsal plan's relay steps used to stop the run as "not covered",
because the relay between forks existed but the driver did not call it. The
driver now does. When a plan relays, the driver installs the relay once,
before the first step, across every fork of the run: it finds each lane
between them, refuses any ramp version the stand-in was not built for, and
puts the stand-in off-ramp in place on each receiving fork. If that install
fails, the run stops there and the verdict says so.

Each fork's facts come from the same places the deploy itself uses. Its
chain id is read from the fork and must match the chain the plan names; its
cross-chain selector comes from the deploy scripts' chain list; its router is
the address the deploy's env file wires. The relay's signing key is made for
that run only and kept in the run's own scratch folder.

Each relay step then delivers every message the sending fork has sent toward
the receiving fork since the fork began and not yet delivered, in the order
sent. A delivery that fails fails the step. Every delivered message is
recorded, and the rehearsal report now carries a cross-chain section listing
the lanes, each message with its fee, gas limit and gas used, and what the
relay does not rehearse. A plan with no relay step installs nothing, and the
report says no cross-chain message was delivered.
