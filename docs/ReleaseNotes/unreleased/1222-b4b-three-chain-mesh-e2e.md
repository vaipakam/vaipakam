# Recycled reward funding — the three-chain mesh, proved end to end

The cross-chain recycled-funding mesh has been built in stages, and each
stage was checked against a test that stood in for the other chains.
Until now every one of those tests ran a single deployment playing the
canonical chain, with the other chains' numbers supplied by the test
itself. That is enough to check that the canonical chain does the right
arithmetic on the numbers it is given. It cannot check the thing the
mesh is actually for: that what one chain believes about another
matches what that other chain believes about itself.

This change adds a suite that runs three real deployments at once — one
canonical chain and two receiving chains — connected by a transport that
holds messages in a queue until the test chooses to deliver them. Every
figure the canonical chain takes in was produced by a real receiving
chain doing real work, and every figure a receiving chain applies came
out of a real finalization. Holding the messages in a queue also lets the
suite do what a live network does at its worst: deliver messages out of
order, deliver the same message twice, and never deliver some at all.

What the suite establishes:

- **What the canonical chain instructs a chain to fund is exactly what
  that chain sets aside** — checked separately on each of the two
  receiving chains, whose figures are deliberately made unequal so that a
  fan-out which mixed the two up would be caught rather than pass.
- **A duplicated instruction changes nothing.** Re-delivering the very
  same message to a receiving chain does not make it set aside the amount
  twice. Networks of this kind can legitimately re-run a delivery, so
  this is a real hazard rather than a theoretical one.
- **An instruction delivered to the wrong chain is refused outright.**
- **A lost day-close report heals itself.** When one chain's report never
  arrives, the next one carries the whole backlog and the canonical
  chain's picture catches up without anyone replaying the lost message.
- **Unspent commitments come back.** A receiving chain that releases a
  commitment without paying anyone reports it on its next day-close, and
  the canonical chain both closes the outstanding record and gives the
  funding capacity back — one for one.
- **Chains stay separate.** Activity on one receiving chain moves that
  chain's record and leaves the other's alone.

One test was found during review to be asserting more than it showed, and
is worth naming rather than quietly fixing: a check that a dropped report
stayed dropped was undone by a later delivery sweep picking the "lost"
message back up, so it would have passed even for an implementation that
required every missed report to be replayed. Dropped messages are now
dropped permanently and the test asserts that at the end.

The suite also surfaced an **activation ordering requirement that had not
been written down anywhere**. Turning on the coupling is a single,
irreversible switch, and it is what starts creating commitments on
receiving chains. But a receiving chain cannot yet settle those
commitments — paying, forfeiting and lapsing all run through a pricing
path that is deliberately still blocked there. So it can set commitments
aside and settle none of them: its settlement totals stay at zero and the
canonical chain's view of its spare capacity is left permanently lower,
by the growing stock of unsettled instructions, than it would otherwise
be — while that chain's balance sits untouched. The defect is a
shortfall rather than a falling number: a chain that keeps absorbing can
raise its reported total faster than the instructions subtract from it,
so what always holds is unsettled instructions piling up while nothing
settles. The result recovers once
the block lifts (the totals are cumulative, so the backlog closes), but
for the whole window the platform would fund from the canonical chain
what the receiving chain could have funded itself — exactly the waste the
mesh exists to remove. The requirement is now recorded in both the
activation runbook and the specification, and the decay itself is pinned
by a test — two coupled days, a steadily growing commitment, steadily
falling capacity, and nothing settled on either side.

What that test deliberately does not claim is that the block is the
*sole* cause, because that cannot be demonstrated today: the receiving
chain's coupled-day payment path has never been reachable, and the very
prerequisites tracked under the block are what would make it pay. The
reasoning for the cause is recorded alongside the requirement so the
distinction survives.

No production behaviour changes: this is test coverage plus two
documentation corrections.
