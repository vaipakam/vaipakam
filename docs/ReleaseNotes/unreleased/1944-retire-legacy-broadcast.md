## Thread — One reward broadcast wire (PR #2879)

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
finalization is now the only writer of a day's inclusion. All three stated
leftovers of the per-day delivery gate (#1944) close with this: a day applied
only by the flat broadcast, a late inclusion backfill on a day the mirror had
stamped as excluded, and days before the gate's first day.

The gate also loses its arming step (owner decision 2026-10-26). It used to be
a one-shot switch an administrator set on each mirror, naming the first day it
held. It now applies on every mirror by its reward role, from the mirror's
first day, and never on the canonical chain or on a chain with no reward role.
There is nothing to arm and nothing that can leave a mirror ungated. The one
thing a mirror needs is the keeper's delivery-proof pass running there, which
proves each delivery's days so a delivered day is paid without a manual step;
without it, a funded day waits for someone to prove its delivery. The delivery
state readback now reports whether the gate binds on the chain rather than
whether it was armed.

The arming switch had one more job, which moves to the point where a broadcast
arrives. It stopped a chain from taking broadcasts and settling days while it
had no reward role, then becoming a mirror and holding those days again. A
broadcast is now applied only where the gate binds or where nothing can be
paid from it: a mirror, or a chain detached from rewards. A chain with no
reward role, or the canonical chain, refuses it by name, and the refusal stays
a failed, re-executable message.

Only a day whose funding arrived by a broadcast can be held. A chain that was
canonical and is later made a mirror funded its own days while canonical;
nothing was ever sent to it for them, so those days are never held, and a
broadcast that later arrives for one of them is refused by name instead of
overwriting the chain's own record of the day.

The retired storage fields are renamed in place and recorded in the storage
layout's rename list, so the layout stays append-only. Like the rest of this
build, it reaches a chain only by fresh deploy (owner decision O1 = A); no live
testnet is changed by this PR. The keeper now recognises only the one
broadcast-sent event and no longer treats the two retired refusals as a reason
to resend to every destination. Refs #1944.
