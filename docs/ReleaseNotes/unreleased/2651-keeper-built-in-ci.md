## Keeper — the keeper machine no longer builds; CI builds and attests each bundle (PR #2722)

The always-on keeper machine used to build every change to the keeper
itself. On that small machine (about 1 GB of memory, two shared CPUs on a
burstable shape), the late remittance check missed its read deadline in
about a third of the ticks that ran during a build, against 0.3% outside
one. Earlier fixes (building only when the build's source changed, lower
priority for the build, memory protection for the keeper) cut the number of
builds and the keeper's swapping, but not the misses. A measurement during a
build showed why: the build used little CPU itself, but the hypervisor took
about half of the machine's CPU time and the machine swapped hard enough to
stall disk access a third of the time. Priorities inside the machine cannot
win back time the host does not give it.

Now a GitHub Actions workflow builds the keeper bundle once for each change
of its build source, from `main` only, and publishes it with a signed build
provenance attestation to a `keeper-host` prerelease. The machine downloads
the bundle named by its commit's build-source digest. It installs the bundle
only after the GitHub CLI has verified the attestation. The attestation must
be signed for this repository's workflow, run on `main`, on a GitHub-hosted
runner, over exactly those bytes. The commit it names as the source must be
on `main` and give the build the same source. The machine then runs the
bundle's load check on its own Node. Uploading a release asset therefore
cannot change what the keeper runs; merging to `main` still does, as before.
The build job runs third-party install scripts with no credential in reach,
and a separate job that runs no repository code does the signing.

Operator-visible changes: the machine now follows `main` only (the
`KEEPER_DEPLOY_BRANCH` choice is gone, because CI builds `main` only, and an
unmerged recovery branch must be merged before the machine can run it). The
install script now also installs the GitHub CLI from GitHub's apt
repository, with its keyring checked against a pinned SHA-256, so it must be
re-run once on the existing machine after this change deploys. Until then
the machine keeps the keeper it is running and says the verifier is missing.
After a merge that changes the keeper, the machine waits a few minutes for
CI to publish the bundle and logs once that it is waiting.

The build-source digest now ignores permission bits beyond git's own
executable bit. Before, it read the modes of the extracted export, which
differ between root (the keeper machine) and any other account (the CI
runner), so the two sides named the same source differently and the machine
would never have found CI's bundle. The first CI run showed it; a test now
digests under several umasks and archive modes and requires one answer.

Refs #2651.
