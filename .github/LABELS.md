# Issue Labels

Use these labels consistently when triaging issues, creating project items, or linking work into `@vaipakam-labs`.

## Default Labels

| Label | Use for |
| --- | --- |
| `bug` | Bug reports and behavior that does not match the documented or expected system behavior. |
| `enhancement` | Feature requests and improvements. GitHub's default name is fine; no need to rename to `feature`. |
| `documentation` | Doc-only changes, runbook updates, specs, guides, and wording fixes. |
| `good first issue` | Small, well-scoped work suitable for a new contributor. |
| `help wanted` | Work where community contribution is welcome. |
| `question` | Discussion items, clarification requests, and open product or implementation questions. |
| `duplicate` | Triage outcome for an issue already tracked elsewhere. |
| `invalid` | Triage outcome for an issue that is not actionable or does not apply. |
| `wontfix` | Triage outcome for work we intentionally will not pursue. |

## Vaipakam-Specific Labels

| Label | Use for |
| --- | --- |
| `security` | Security-adjacent work, audit prep, hardening, threat-modeling, and sensitive bug follow-up. Do not use public issues for active private disclosures. |
| `audit` | Items requiring, blocking, or relating to an external audit pass. |
| `chore` | Non-functional repo upkeep: dependency bumps, CI tweaks, formatting, housekeeping. |
| `refactor` | Internal restructuring with no intended behavior change. |
| `infra` | Cloudflare Workers, deployments, RPC configuration, environments, and operational plumbing. |
| `perf` | Gas optimizations, RPC budget reductions, latency improvements, and throughput work. |
| `testnet-rehearsal` | Items that block or support per-chain testnet rehearsals. |
| `mainnet-rollout` | Items that gate per-chain mainnet enablement. |

## Triage Notes

- Prefer one primary type label: `bug`, `enhancement`, `documentation`, `chore`, `refactor`, `infra`, or `perf`.
- Add `security`, `audit`, `testnet-rehearsal`, or `mainnet-rollout` as cross-cutting labels when relevant.
- Use outcome labels (`duplicate`, `invalid`, `wontfix`) when closing or de-scoping an issue.
- Mirror label intent into the `@vaipakam-labs` project fields where useful: `Module`, `Priority`, `Size`, `Estimate`, and `Iteration`.
