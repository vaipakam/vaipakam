## A reverted setup step in the app's end-to-end tests now says why it reverted (PR #2335)

The app's end-to-end tests run against a copy of the live test network. When
a step that prepares a test sends a transaction and it fails on-chain, the
tests already stopped at that step and named it. They could not say why: the
failure reason is not kept with the transaction, and the copy of the network
is thrown away when the run ends. So when one test failed on 2026-09-25 and
passed on a rerun of the identical code, there was no way afterwards to learn
what had gone wrong, or to tell a flaky test from a real regression.

The failure message now includes the reason. Where the test network allows it,
the tooling re-runs the failed transaction exactly as it happened, in its own
block, and reads the error it produced, naming the contract's own error by
name where it has one. Where it cannot, it replays the transaction against the
network as it stood just before, and marks that answer as approximate, since
the replay does not run at the same moment and can differ for that reason
alone. When the replay does not fail at all, the message says the cause is
unknown rather than guessing, and if the lookup itself fails, the original
failure is still reported in full.

This changes nothing in the app itself; it is the first step of #2334, so
that the next occurrence of that flaky test explains itself.
