## Thread — a mined transaction is not a successful one, and the test suite had been treating it as one (PR #NNNN)

A scenario test had been failing intermittently for weeks in a way nobody
could reproduce on demand: the same commit would fail one day and pass the
next, with no change to the tree in between. The failure always arrived as a
piece of the page being absent sixty seconds after the page loaded, which reads
like a rendering problem and is the reason several investigations looked at the
wrong half of the system.

It was not a rendering problem. The test sets itself up by sending a real
transaction to the chain and then waiting for that transaction to be mined —
and **being mined is not the same as succeeding**. A transaction that fails
on-chain is still mined, still returns normally to whatever was waiting for it,
and reports its failure only in a field the suite was not reading. So when the
setup transaction failed — which depended on live chain state and therefore
varied day to day — the test carried on as though it had worked, and the page
it then inspected had nothing to show, because the thing it was inspecting had
never been created.

The suite had nineteen of these waits and exactly one of them read the result.
That one was written by hand, in a single test, by someone who had been bitten
by this before.

**Fixing only the failing test would have left eighteen of the same hole.** So
the wait is now a shared step that every test uses, and it fails loudly and
immediately when a transaction failed, naming which transaction it was. The
failure now appears at the setup step that caused it, rather than three steps
later in a message about the user interface — which is the difference between a
report that points at the cause and one that has sent people looking in the
wrong place repeatedly.

The affected test also gained a second, stronger check. Rather than inferring
that its setup worked from whether the page displays something, it now reads
the chain directly and confirms the position really is in the state the setup
was meant to put it in. A test whose only evidence of its own setup is the
screen it is testing cannot tell a broken product from a broken setup, and this
one could not.

Two live operational drivers had the same gap and are fixed alongside. One
could have let a wallet stay in a state the run had reported as cleared; the
other printed "restored" for a restore that had not happened, although a later
check would still have failed the run. That second one changed no outcome, only
what the operator reading the transcript was told — which is worth fixing on
its own, because a log that contradicts the failure beneath it costs more time
than no log at all.

Closes #2183.
