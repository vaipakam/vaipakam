## Thread — The e2e harness now says when the testnet is behind (#1518)

The browser-level test tier runs against a fork of the live test
network, but with the contract interfaces from the current checkout.
That works only while the two agree. When a merged contract change
widens a value the app reads and the test network has not been
redeployed yet, every read of that value fails to decode — and because
those reads are batched, one failure empties the whole offer book. The
tests that need an offer then fail with timeouts that name the offer
book and never the actual cause.

This is not hypothetical. A change in late July appended three fields
to the offer record and correctly regenerated the interface files in
the same commit, exactly as the process requires. What that process
does not cover is the deployed test network, which has been serving the
older, narrower record ever since. The tier has been failing on the
main branch for roughly two weeks, always the same four tests, and the
cause was found only while checking an unrelated merge.

The harness now probes the shape of the records it depends on when it
starts, and prints an explicit banner naming the mismatch, the two
widths, and the deploy command that fixes it. It stays a warning rather
than a refusal to start: the tier still has value with a stale network,
since the tests that never read the affected records pass, and turning
a deploy lag into no coverage at all would trade one silent failure for
a louder one. What was missing was never the failure — it was being
told which failure it is.

The underlying mismatch itself is now gone: the contracts were
redeployed to the test network, which is what the banner was telling
anyone who read it to do. The records the app reads and the records the
network serves agree again, and the browser-level tests that had been
failing on it can run properly.

The banner stays regardless. The mismatch it caught was not a mistake by
anyone — the change that introduced it followed the documented process
exactly; that process simply says nothing about the deployed test
network, so the two drifted apart quietly and stayed that way for two
weeks. Nothing about the redeploy prevents the same drift the next time
a contract change lands ahead of a deployment. What has changed is that
the next occurrence announces itself in the first seconds of a test run
instead of hiding behind four unrelated-looking failures.

That proved its worth immediately. Clearing the first mismatch revealed
a second one hiding behind it, of the same family but a different kind —
the offer-state gap described in its own note alongside this one. Four
tests were still failing, for a reason that looked identical from the
outside.

The deeper problem was never either mismatch. It was that a single
unrecognised offer took down the entire book: the harness read every
offer at once and refused all of them if any one was unfamiliar, so a
one-offer problem presented as a total outage with no hint of its cause.
Twice now that has cost weeks. The harness still refuses to guess at a
state it does not recognise, but it now omits just that offer and says
which value it did not understand, so the failure is proportional to the
fact rather than to where it happened to sit in the list.
