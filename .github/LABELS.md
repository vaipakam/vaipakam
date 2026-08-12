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
| `breaking-change` | Changes that break API / ABI / on-chain compatibility. Drives the MAJOR semver bump per `.github/release-drafter.yml`. Apply to contract-surface changes that shift function selectors or storage layout, frontend API shape changes consumers pin against, and CCIP message-format changes. Most pre-mainnet work doesn't need this label — it's reserved for genuinely incompatible changes. |
| `sweep-merge` | **PR-only, and it authorises an irreversible action.** Consent for the scheduled `Claude PR sweep` workflow to squash-merge this PR once its required checks are green and every review conversation is resolved. The sweep drives PRs forward regardless — resolving conflicts, pushing review fixes, re-triggering review — but it will not merge one without this label. Apply it when you have decided a PR should land; remove it to park a PR the sweep would otherwise be ready to merge. |

## Triage Notes

- Prefer one primary type label: `bug`, `enhancement`, `documentation`, `chore`, `refactor`, `infra`, or `perf`.
- Add `security`, `audit`, `breaking-change`, `testnet-rehearsal`, or `mainnet-rollout` as cross-cutting labels when relevant. `breaking-change` is the one that drives the release-drafter MAJOR semver bump — don't forget to apply it to genuinely incompatible PRs.
- `dependencies` is applied automatically by Dependabot (alongside `infra`) — no manual action needed there.
- `sweep-merge` is not a triage label and carries no meaning on an issue. It is a consent flag read by one workflow, and it is the only thing standing between an unattended agent and a merge — so apply it per-PR, never as a default.
- Use outcome labels (`duplicate`, `invalid`, `wontfix`) when closing or de-scoping an issue.
- Mirror label intent into the `@vaipakam-labs` project fields where useful: `Module`, `Priority`, `Size`, `Estimate`, and `Iteration`.
