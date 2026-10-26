## Thread — One reward broadcast wire (PR #<n>)

Base now sends each finalized reward day to its mirrors on one wire only: the
per-destination broadcast that carries the day's frozen clock and the identity
of the Base deployment that finalized it (message kind 10). The two older forms
are retired and their message kinds are never reused: the flat broadcast
(kind 2) and the per-destination broadcast without a clock (kind 5). A packet
carrying either is refused as an unknown kind and applies nothing. The reward
messenger's wire generation moves from 7 to 8.

Everything that existed only to keep those older wires working is removed with
them: Base's fallback from the newer send to the older ones, the refusals that
went with it (a messenger too old for the newer wire, a day with no clock), the
mirror's clock backfill onto a day an older wire had applied, the repair flags
for days applied by older receivers, the era-rotation flag that switched the
older wires off, and the parked-message lane (with its retry and tombstone
calls) that held older-wire packets arriving after a rotation. Because the one
remaining wire names its deployment, a retired deployment's late or manually
re-executed broadcast is simply refused by name and stays a failed,
re-executable message. Base's late inclusion backfill is removed too, so
finalization is now the only writer of a day's inclusion. Two of the stated
leftovers of the per-day delivery gate (#1944) close with this: a day applied
only by the flat broadcast, and a late inclusion backfill on a day the mirror
had stamped as excluded. One remains: days before the gate's first day.

The retired storage fields are renamed in place and recorded in the storage
layout's rename list, so the layout stays append-only. Like the rest of this
build, it reaches a chain only by fresh deploy (owner decision O1 = A); no live
testnet is changed by this PR. The keeper now recognises only the one
broadcast-sent event and no longer treats the two retired refusals as a reason
to resend to every destination. Refs #1944.
