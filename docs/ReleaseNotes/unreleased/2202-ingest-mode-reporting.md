## Thread — Two published figures named the wrong ingest arrangement (PR #2204, issue #2202)

The platform can take in chain data two ways, and it publishes how fast it
expects to do so — a figure an operator uses to judge how long a wrong record
can survive before the platform notices. Which arrangement is running is
decided by two things together: a switch the operator flips, and whether the
machinery that arrangement needs has actually been provisioned. Both, on
purpose: provisioning the machinery must not silently re-route live work, and
flipping the switch without the machinery must not either.

Three published surfaces were deciding it on the switch alone, because the
switch was the only half they could see. On a deployment where the switch is
on and the machinery is absent — a configuration the platform supports —
those surfaces reported the faster arrangement while the slower one was
actually running.

A wrong figure here is worse than no figure. The whole reason for publishing
it is that somebody sizes a judgement on it, and the surface that would have
contradicted it is not one they were looking at. The intended behaviour was
already written down — the platform states which arrangement is in use rather
than implying a single pace — so this is the code catching up with it rather
than a change of intent.

### What changed

The answer is now worked out once, in the one place that can see both halves,
and passed on already decided. The surfaces receive a yes-or-no rather than a
switch position, so none of them can consult half the question.

That is deliberately not the same as correcting three call sites. Each of the
three was written by somebody looking at what the platform handed them and
using it reasonably; one of them even said in passing that it could only see
the switch, and treated its answer as a floor rather than a fact. The fault
was in what was handed over, so that is what changed — and the next surface to
ask gets the whole answer by default instead of the visible fragment.

### What this does not change

Nothing about how data is actually taken in, and no figure on a correctly
provisioned deployment: where both halves agree, every surface reports exactly
what it reported before. The only deployments whose published figures move are
the ones that were being told something untrue.

Closes #2202.
