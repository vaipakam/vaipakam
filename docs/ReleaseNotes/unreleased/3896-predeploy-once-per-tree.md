## Local testing — the pre-deploy check runs once per tree

The pre-deploy check reads the code, not a chain, yet a fresh deploy used to run it again on every chain, about half an hour each time, and the rehearsal driver ran it once more before that. A passing run of the check now records its verdict against the tree digest, and the next step that needs the check reuses that verdict while it still describes the code on disk. The deploy scripts for testnets, mainnet and the development loop, and the rehearsal driver, all go through this one path.

A verdict is reused only when the tree, the forge version and the Foundry settings all match. The full regression, which the mainnet deploy runs, is never reused: its live-fork suites read chains and deployment records that no verdict can pin, so it runs every time. A full pass still counts for a later ordinary check. A mainnet rehearsal now runs the full check too, as the mainnet deploy does. A run during which the tree changed, a single shard of the regression, a run against a storage-layout baseline and a run that honours acknowledged storage-layout breaks record nothing.

The tree digest now also counts untracked files that git does not ignore, and the commit and working tree of each checked-out submodule. Before, a new source file not yet added to git changed what a deploy builds without changing the digest, so the rehearsal gate could have accepted a deploy of code the rehearsal never saw. Ignored build output and the deploy records stay outside the digest.

The verdict is a local file in the ignored rehearsal folder, like the rehearsal verdict: it saves repeated work and catches mistakes, and is not a lock against someone who means to skip the check.
