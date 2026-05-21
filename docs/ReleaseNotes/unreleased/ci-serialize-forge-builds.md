## Thread — Serialize CI forge builds: one cold build per PR (PR #<n>)

Folded the standalone `gas-snapshot.yml` and `slither.yml` workflows
into `ci.yml` as new jobs gated on `needs: contracts-fast`. Pre-change,
a contracts-touching PR could cold-build forge up to THREE times in
parallel — once in `ci.yml`'s `contracts-fast`, once in
`gas-snapshot.yml` (when it lost the cache race), and once inside the
`crytic/slither-action` Docker container (which has its own Foundry
install completely isolated from the host runner's foundry cache).
Post-change there is exactly **one cold forge build per PR**, and all
four contract-touching jobs (`contracts-fast`, `contracts-full`,
`gas-snapshot`, `slither`) restore the same content-keyed foundry
cache that `contracts-fast` warms.

The trade-off is acknowledged: the informational jobs (`gas-snapshot`
and `slither`) now arrive ~5-10 minutes later on cold-cache PRs
because they wait for `contracts-fast` to finish first instead of
racing it in parallel. **Wall-clock time to merge-ready is
UNCHANGED** — `contracts-fast` is the required gate either way; the
slower informational jobs just don't burn duplicate forge minutes on
top of it. This deliberate compute-over-latency trade-off is captured
as a feedback memory (`feedback_ci_compute_over_wall_clock`) so the
agent picks the same default next time.

Implementation notes. The gas-snapshot job is a literal lift-and-
shift of the standalone workflow's `gas-snapshot` job, with the
working-directory + cache-restore wired to match the rest of ci.yml.
The slither job replaces the `crytic/slither-action` Docker action
with a host-runner shape: `actions/setup-python@v5`, then
`pip install slither-analyzer==0.11.4` (same pin the docker action
carried for output stability), then `slither . --config-file
slither.config.json --sarif slither-results.sarif`, then
`github/codeql-action/upload-sarif` to populate the Security tab.
The `|| true` after the slither invocation matches the old
`fail-on: none` semantics — Slither is informational; the SARIF
upload is the load-bearing product, not the exit code.

`.github/allowed-actions.txt` updated to reflect the doc-side audit
trail: `actions/setup-python@*` added; `crytic/slither-action@*`
removed with an inline note about why and when. The maintainer will
need to update GitHub's runtime Settings → Actions → General policy
to match (the doc is the source of truth for what SHOULD be allowed;
the Settings UI is the runtime gate).

After this PR merges the two retired workflows are gone from the
Actions tab and the `Slither (informational)` / `Gas snapshot` runs
appear as jobs inside `ci` rather than as separate workflow runs.
