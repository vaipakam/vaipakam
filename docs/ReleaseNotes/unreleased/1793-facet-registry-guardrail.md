## Forgetting a new component in the redeployment script is now caught before it ships

Adding a new on-chain component to the platform means registering it in seven
separate places. Until now the contributor guide named two of them. The other
five are exactly where the most recent component addition went missing, and two
of those five give no warning at all when you skip them — which is why that
omission survived a full pre-deploy gate, a static guardrail suite and a
compliance scan, all reporting green, and was caught only in review.

The worse of the two silent ones is now loud. The script that refreshes every
component in place already checked its own component count, and the check was
worthless: it compared the count against a number written in the same file. Skip
the component in both spots — which is what forgetting looks like, since you
never touch either line — and the check passes. The script then refreshes
everything except the new component, leaving that one running the code from
before the change while everything around it moves on. That is the same
half-applied hazard the script's own header warns about elsewhere.

A new guardrail now compares that number against the list the rest of the
deploy-safety suite already treats as authoritative, so the mismatch fails during
an ordinary test run. The comparison lives in the test layer rather than inside
the script, and that placement is deliberate: a script that runs against real
deployments should not import test code in order to check itself, whereas a test
may freely read the script. The number it reads was made visible for exactly that
purpose.

The contributor guide now lists all seven places, says what each one drives, and
flags the two that fail silently rather than leaving a reader to discover it the
hard way. A stale note in the script itself — claiming a count that had been
wrong for ten components — is corrected too.

One gap is left open on purpose and recorded rather than quietly skipped: the
second silent failure, where a new component can be left out of the record of
deployed addresses. The pre-deploy gate checks that every address it *did* record
is of a known kind, which tells it nothing about an address never recorded at
all. That check cannot be expressed in the contract language and belongs in the
deploy gate script instead, so it is tracked as its own follow-up rather than
bolted on here.
