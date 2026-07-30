## Thread — Build docs CI job un-broken (quick-profile doc compile) (PR #TBD)

The contracts documentation CI job had been failing on every push to
main since mid-afternoon on 2026-07-30: the documentation generator
runs its own full compiler pass over whatever the active profile's
file globs include, and the CI profile's test-exclusion list is an
explicit per-file enumeration that newer test suites were never added
to. When the rewards milestone's large test suites entered that scope,
the single-unit compile grew past the CI runner's memory ceiling and
the out-of-memory killer took down the runner itself — surfacing as a
cryptic "runner received a shutdown signal" after ~29 silent minutes,
on every subsequent run.

The documentation step now runs under the lean inner-loop profile,
whose test and script exclusions are directory-wide globs that future
test files can never drift out of, and whose source-only scope is
exactly what the docs site documents. Measured locally on
CI-equivalent hardware: the doc build completes in about two minutes
at ~1.5 GB peak memory, versus exceeding ten minutes and 5.7 GB and
still climbing before the fix.
