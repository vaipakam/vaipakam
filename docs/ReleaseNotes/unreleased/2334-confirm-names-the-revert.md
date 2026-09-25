## A reverted setup step in the app's end-to-end tests now says why it reverted (PR #NNNN)

The app's end-to-end tests run against a copy of the live test network. When
a step that prepares a test sends a transaction and it fails on-chain, the
tests already stopped at that step and named it. They could not say why: the
failure reason is not kept with the transaction, and the copy of the network
is thrown away when the run ends. So when one test failed on 2026-09-25 and
passed on a rerun of the identical code, there was no way afterwards to learn
what had gone wrong, or to tell a flaky test from a real regression.

The failure message now includes the reason. The test tooling replays the
failed transaction against the network as it stood just before it and reads
the error it produces, naming the contract's own error by name where it has
one. Where the replay cannot reproduce the failure — because something else
changed the state in the same moment — the message says that instead of
guessing, and if the lookup itself fails, the original failure is still
reported in full.

This changes nothing in the app itself; it is the first step of #2334, so
that the next occurrence of that flaky test explains itself.
