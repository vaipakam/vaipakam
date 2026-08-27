## Thread — one bad moment upstream no longer fails the whole end-to-end job (#1973)

The browser end-to-end suite starts by forking the test network at its
current head. That is inherently racy: the upstream node can advertise a
block whose state a load-balanced peer cannot serve yet, and the fork
tool then exits during setup rather than starting. It happened once
today, on a documentation-only change that could not possibly have
caused it.

What made it worth fixing is not the frequency — the same job passed
twice on equivalent code either side of the failure — but who pays. The
failure surfaces as a red required check on whatever change happens to
be in flight, with a stack trace pointing into the test harness, so the
natural reading is that the change broke the tests. Establishing
otherwise took real time.

Startup now retries a small number of times before giving up, and says
so in the log each time. Two deliberate limits: it retries only when the
fork tool exits quickly, which is what an upstream hiccup looks like, and
never when startup simply times out, because that indicates something
structurally wrong and retrying would only triple the wait before
reporting it. The final failure message now names the likely cause and
points at the issue, so the next person reading it does not start by
suspecting their own diff.

Two limits keep the retry from becoming its own problem. It only applies
when the fork tool dies within the first half-minute, which is what a
genesis failure looks like; something that runs almost to the readiness
deadline and then exits is a different fault, and retrying it would
multiply the wait rather than recover from anything, so that fails
immediately with a message saying which case it was. And the attempt
count, which is overridable, is validated on the way in: an empty or
mistyped value would otherwise skip startup silently, a fractional one
would never reach the give-up branch, and an unbounded one would retry
forever. A configuration typo now fails with a message naming the
accepted range.

The retry is loud on purpose. A silent one turns a degrading upstream
into an unexplained slowdown, and hides exactly the signal that would
tell an operator the endpoint needs attention.
