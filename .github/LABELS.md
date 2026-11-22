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
| `iteration-kickoff` | Applied only by `iteration-kickoff-sync.yml` to its weekly card. It is how that workflow finds the previous card to close, so do not put it on any other issue. |
| `breaking-change` | Changes that break API / ABI / on-chain compatibility. Drives the MAJOR semver bump per `.github/release-drafter.yml`. Apply to contract-surface changes that shift function selectors or storage layout, frontend API shape changes consumers pin against, and CCIP message-format changes. Most pre-mainnet work doesn't need this label — it's reserved for genuinely incompatible changes. |

## Owner Labels (`thread:*`)

Each open issue carries one `thread:<name>` label naming the project thread that owns it, so the owner is visible on the board instead of living in session notes (owner decision 2026-11-19). Move the label when ownership moves; an issue with no `thread:*` label is unowned and goes to the coordinator's weekly sweep.

**Labels are the source of truth; the board mirrors them** (owner decision 2026-11-22). The board's fields have no API the project agents can write, and labels do, so the `thread:*`, `priority:*` and `stage:*` labels are what records owner, priority and stage. [`board-label-sync.yml`](workflows/board-label-sync.yml) copies them onto the board's `Thread`, `Priority` and `Stage` fields hourly, and within seconds when one of those labels is added or removed. Change the label, never the field: a field edited by hand is overwritten by the next run. An issue carries **at most one label of each family**; with two, the sync writes neither and lists the issue in its run summary. Removing a family's label clears the field only when the field holds a value the sync itself writes. A field or option missing from the board is listed in the run summary as one to add, and its writes are skipped until it exists.

| Label | Use for |
| --- | --- |
| `thread:desktop` | Contract builds and signing run from the desktop computer session, and the fresh deploy. |
| `thread:security` | The security threats thread. |
| `thread:secured-vault` | The secured vault and protected account thread. |
| `thread:auto-lend` | The Auto-lend and standing-intent contract build thread. |
| `thread:cash-out` | The lender cash-out build thread. |
| `thread:rate-reference` | The rate reference and market-linked limits build thread. |
| `thread:app-fixes` | Indexer, agent, www and connected-app fixes. |
| `thread:alpha05` | The new user-friendly app (`apps/alpha05`). |
| `thread:keeper` | Keeper passes and the public keeper bot. |
| `thread:design` | Designs awaiting a decision on the design thread. |
| `thread:governance` | Mainnet governance gates, deploy scripts, ops and backups. |
| `thread:issues-plan` | The open-issues plan thread, including VPFI rewards and recycling items. |
| `thread:owner` | Waiting on an owner or operator step, not on a thread. |

## Priority Labels (`priority:*`)

At most one per issue. Mirrored onto the board's `Priority` field (`P1`…`P5`).

| Label | Use for |
| --- | --- |
| `priority:p1` | Security fixes and mainnet gates. |
| `priority:p2` | Loan-path features. |
| `priority:p3` | Apps, indexer and keeper work. |
| `priority:p4` | Docs and ops. |
| `priority:p5` | Later, parked or research items. |

## Stage Labels (`stage:*`)

At most one per issue. Mirrored onto the board's `Stage` field, a field of its own so the board's `Status` automations (closed → Done) are left alone.

| Label | Use for |
| --- | --- |
| `stage:building` | Work in progress on a branch or PR now. |
| `stage:held-for-batch` | Built or ready, held to ship with a batch (for example the next contract fresh deploy). |
| `stage:queued` | Next up for its thread, not started. |
| `stage:waiting-on-owner` | Blocked on an owner or operator decision or step. |
| `stage:built-not-closed` | Delivered, but the issue is still open (awaiting a live check, a deploy or a closing link). |

## Triage Notes

- Prefer one primary type label: `bug`, `enhancement`, `documentation`, `chore`, `refactor`, `infra`, or `perf`.
- Add `security`, `audit`, `breaking-change`, `testnet-rehearsal`, or `mainnet-rollout` as cross-cutting labels when relevant. `breaking-change` is the one that drives the release-drafter MAJOR semver bump — don't forget to apply it to genuinely incompatible PRs.
- `dependencies` is applied automatically by Dependabot (alongside `infra`) — no manual action needed there.
- Use outcome labels (`duplicate`, `invalid`, `wontfix`) when closing or de-scoping an issue.
- `Priority`, `Stage` and `Thread` on the `@vaipakam-labs` board follow the labels automatically (see Owner Labels above); do not set them by hand. Mirror other label intent into `Module`, `Size`, `Estimate` and `Iteration` where useful.
