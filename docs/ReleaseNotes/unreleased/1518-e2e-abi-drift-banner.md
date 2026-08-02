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

The underlying mismatch is cleared by the pending test-network deploy,
which the release review has been waiting on for other reasons too.
