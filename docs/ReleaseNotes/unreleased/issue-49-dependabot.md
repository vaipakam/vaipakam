## Thread — Dependabot for off-chain deps + SHA-pinned CI actions (PR #50)

The platform had no automated dependency-vulnerability hygiene, and CI
workflow actions referenced floating tags (`@v4`) rather than pinned
commit SHAs — a moved tag could silently change CI behaviour.

Dependabot is now enabled, scoped to the off-chain surface only:
`github-actions` (CI action versions) and `npm` (the pnpm workspace —
`apps/*` + `packages/*`, the real CVE surface: viem, wagmi, React,
wrangler and their transitive dependencies). Updates run weekly, are
grouped to limit PR noise, and are `infra`-labelled. The on-chain
Solidity dependencies under `contracts/lib/` are deliberately excluded
— they are git submodules pinned to an audited commit set, and bumping
one changes audited bytecode, so a contract-dependency bump stays a
deliberate, reviewed, re-audited decision rather than an automated PR.

Separately, every `uses:` in `.github/workflows/` is now pinned to a
full commit SHA (with a trailing `# vX` comment Dependabot reads to keep
offering version bumps). Dependabot PRs are never auto-merged — each
goes through the same review + CI + Codex review as any change. Closes
#49.
