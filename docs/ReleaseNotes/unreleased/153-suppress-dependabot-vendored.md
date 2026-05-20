## Thread — Suppress Dependabot scans inside vendored `contracts/lib/*` (PR #<n>)

Closed a Dependabot policy gap that `CLAUDE.md` already documented but
the config didn't actually enforce. Within a single day five
Dependabot PRs (#138 / #139 / #140 / #141 / #142) landed against
`contracts/lib/diamond-3-hardhat/` — exactly the vendored Solidity
submodule path the existing "Dependabot — off-chain only" header
comment named as *not covered, on purpose*.

The root cause is a documented Dependabot quirk: the `directory:`
field on a `npm` updates block scopes **version-update** PRs only.
Vulnerability-driven **security-update** PRs walk every
`package-lock.json` in the repo regardless of that config. So a
root-only `directory: "/"` block silences version-update PRs against
the vendored trees, but the moment a CVE surfaces in any transitive
dep buried in those subtrees, Dependabot raises a PR against the
vendored package-lock.json anyway.

The fix this PR lands is **per-vendored-directory updates blocks**
with `ignore: [{ dependency-name: "*" }]` and
`open-pull-requests-limit: 0`. That shape disables *both* scanners for
the registered directory. Six blocks cover every Solidity submodule
that ships its own JS tooling tree: `diamond-3-hardhat`,
`openzeppelin-contracts-upgradeable`, `chainlink-ccip`,
`chainlink-evm`, and `chainlink-local`. (`forge-std` has no
`package.json` so doesn't need a block.) The header comment now
explains the security-vs-version scanner distinction inline so the
next contributor doesn't trip on the same trap.

After this lands the five offending Dependabot PRs (#138–#142) are
closed individually with a pointer to issue #153 explaining why none
will be merged. Closes #153.
