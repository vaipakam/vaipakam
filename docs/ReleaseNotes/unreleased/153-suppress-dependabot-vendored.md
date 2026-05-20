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
`package-lock.json` / `pnpm-lock.yaml` in the repo regardless of that
config. So a root-only `directory: "/"` block silences version-update
PRs against the vendored trees, but the moment a CVE surfaces in any
transitive dep buried in those subtrees, Dependabot raises a PR
against the vendored manifest anyway.

The fix this PR lands is a single `package-ecosystem: "npm"` block
with `directories: ["/contracts/lib/**"]`,
`ignore: [{ dependency-name: "*" }]`, and
`open-pull-requests-limit: 0`. The glob form catches every manifest
under the wildcard recursively — across the 13 nested
`package.json` files that exist today under `contracts/lib/`
(diamond-3-hardhat, forge-std, the openzeppelin-contracts-upgradeable
tree including its own nested `lib/openzeppelin-contracts/` and
`scripts/solhint-custom/` submodules, the chainlink-ccip
`chains/evm/` JS tooling, and the chainlink-evm
`/` + `contracts/` pair) — without us having to enumerate each
path and stay current as submodules bump. The `ignore` + zero-PR
limit pair disables BOTH the version-update and the
security-update scanners for every matched manifest. The header
comment now explains the security-vs-version scanner distinction
inline so the next contributor doesn't trip on the same trap.

After this lands the five offending Dependabot PRs (#138–#142) are
closed individually with a pointer to issue #153. Closes #153.
