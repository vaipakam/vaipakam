## Thread — Workspace transitive-dependency security pins (PR #<n>)

Closed 17 open Dependabot HIGH/MEDIUM CVE alerts on the root
`pnpm-lock.yaml` by adding three `pnpm.overrides` entries to the
workspace root `package.json`. Each pin is the minimum patched
version the upstream advisories require; the override route was
needed because every flagged package is a *transitive* dependency
that no direct upgrade in `apps/*` or `packages/*` would reach.

The three pins. **`axios ^1.15.2`** closes 15 of the 17 alerts —
the package is pulled in three different ways (the Push Protocol
SDK in `apps/agent` + `apps/keeper`, and the Coinbase CDP SDK via
the wagmi → connectkit chain in `apps/defi`) and the same set of
nine CVE advisories (CRLF injection, prototype-pollution gadgets,
NO_PROXY bypasses, etc.) applies in all paths. **`ws@^8.0.0 →
^8.20.1`** closes a single uninitialized-memory-disclosure
advisory (GHSA-58qx-3vcg-4xpx) in the ethers → `ws` path; the
selector form keeps the legacy `ws@7.x` paths used by other code
untouched. **`brace-expansion@^5.0.0 → ^5.0.6`** closes a
ReDoS-style range-DoS advisory in the v5 line; the v1 path
(`brace-expansion@1.1.14` pulled by `eslint → minimatch`) is
outside the vulnerable range and stays put — again by selector
scoping.

The fix is structural, not bytecode-affecting: nothing in
`contracts/` was touched, and all six TypeScript workspaces
(`@vaipakam/defi`, `agent`, `keeper`, `indexer`, `ui`, `www`)
typecheck clean against the resolved lockfile. The remaining 349
Dependabot alerts on the repo split into two non-fixable
populations that Phase 3 of issue #135 handles separately:
343 alerts in vendored Solidity submodules under
`contracts/lib/*` (the JS/Go tooling embedded in those repos is
never compiled or run as part of the Vaipakam build, so the
advisories don't reach Vaipakam-deployed code) and 6 alerts in
the deprecated `alpha/frontend/` (its sunset is tracked
separately).

Closes part of #135 (Phase 2 — root workspace).
