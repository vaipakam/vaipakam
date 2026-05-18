# Release Notes — 2026-05-18

One large thread spanning the last two days: **T-068 — migrating
Vaipakam's entire cross-chain layer off LayerZero and onto Chainlink
CCIP.** This note covers the migration build-out, the pull request that
collects it, the automated-review hardening that followed, and a
follow-on gap the review surfaced.

## Thread — T-068: cross-chain layer moved from LayerZero to Chainlink CCIP (PR #46)

### Why

Vaipakam's cross-chain features — sending VPFI between chains, the
fixed-rate "buy VPFI from any chain" flow, and the cross-chain reward
accounting — previously rode on LayerZero. LayerZero leaves each
integrator to assemble its own security configuration (its "DVN" set),
and a misconfiguration there was the shape of a roughly $292M bridge
exploit in April 2026. Chainlink CCIP, by contrast, operates one
uniform security model for every integrator — a committing network, an
executing network, and an independent Risk Management Network that
re-verifies every message — with no per-integrator security knob to get
wrong. Moving to CCIP removes that whole class of footgun.

The migration was deliberately built behind a provider-agnostic seam:
the domain contracts talk to a single cross-chain "messenger" interface
and never to a CCIP library directly, so a future provider change stays
contained to one adapter.

### What landed

The migration was built in phases, each self-contained and tested:

- **The messaging seam + CCIP adapter.** A provider-neutral cross-chain
  messaging interface, plus the one CCIP-aware adapter that implements
  it. The adapter keeps a registry of which chains, remote messengers,
  and channel peers it will talk to, and refuses anything outside that
  allowlist.
- **VPFI as a Cross-Chain Token.** VPFI now moves between chains as a
  standard Chainlink Cross-Chain Token: a mirror token on non-canonical
  chains, plus a bounds-checked rate governor so per-lane transfer rate
  limits can be tuned within safe ranges and never disabled outright.
- **The cross-chain buy flow on CCIP.** The "buy VPFI priced in ETH from
  a mirror chain" flow was rebuilt on CCIP, keeping its two-step release
  design — delivered VPFI is only released to a buyer that matches a
  genuine local pending-buy record, so a forged or replayed delivery can
  never route tokens to an attacker.
- **The cross-chain reward flow on CCIP.** Daily per-chain interest
  reports and the global-denominator broadcast were moved onto CCIP.
- **Removal of the LayerZero apparatus.** Every LayerZero contract,
  test, script, and dependency was deleted; deploy scripts and
  remappings were rewritten for the CCIP stack.

All of this was collected into pull request **#46** against `main`, with
the full test suite green at the point the PR opened.

### Automated-review hardening

An automated adversarial review of the PR raised six findings, all
confirmed against the code and all fixed:

- **Fee-surplus refund (highest severity).** A buyer who slightly
  overpaid the cross-chain fee — easy to do, since fee quotes drift —
  had the surplus stranded in the adapter rather than returned. The buy
  entry point now re-quotes the exact fee, forwards only that, and
  refunds the remainder to the buyer.
- **Configuration-integrity guards.** The messenger's chain-selector and
  channel-handler maps could be put into a one-to-many state by an
  operator misconfiguration; both now reject a conflicting assignment
  outright, keeping the maps strictly one-to-one as documented.
- **Duplicate-token guard.** An outbound message naming the same token
  twice would have failed mid-send; it is now rejected up front with a
  clear error.
- **Checked chain-id conversions.** Two inbound paths narrowed a
  chain identifier without a bounds check; both now reject an
  out-of-range value rather than silently mis-attributing a message to
  the wrong chain.

Seven targeted tests were added alongside these fixes.

### Follow-on: completing the chain-identity migration into the Diamond

The review also surfaced that the migration had stopped at the
cross-chain contracts and not reached the main protocol facets they
talk to. The new CCIP contracts identify chains by their real EVM chain
id, but two Diamond facets — the VPFI fee-discount/buy facet and the
reward reporter/aggregator facets — were still written around
LayerZero's "endpoint id" concept. Left unaddressed, the per-wallet VPFI
buy cap and the cross-chain reward accounting would have been keyed by
two different numbering schemes, desyncing the figures users and
operators see.

That gap was closed in the same PR: the facets, their stored data,
events, getters, errors, and the deploy/config scripts were all moved to
key by EVM chain id. A chain's own identity is now read directly from
the chain itself rather than configured by an operator, removing a
misconfiguration vector. The frontend and the cross-chain reconciliation
watchdog were updated to match, and the shared contract-ABI bundle was
re-pointed at the renamed CCIP contracts.

### Status

PR #46 is open and under review. The CCIP deploy and lane/pool
configuration scripts, a local end-to-end rehearsal, and the testnet
cutover are tracked as the next phase of T-068. A small amount of
deploy-layer cleanup (operator environment variables and deployment-
artifact fields still carrying LayerZero-era names) is folded into that
same upcoming phase.

The full test suite is green throughout: 1993 passed / 0 failed / 5
skipped — the CCIP-stack tests built across the phases, seven targeted
tests for the automated-review fixes, and the reward-plumbing tests
reworked to exercise the chain-id model.

## Thread — release-notes automation: per-PR fragments + CI drift backstop (PR #48)

Release notes were appended to a per-day file from memory after each
merge, and that lagged — 2026-05-17 had five threads merge to `main`
with no release-notes coverage, and the 2026-05-16 file was committed
mid-day so it missed that day's later merges.

Release notes now use a fragment model. Every behaviour-changing PR
carries its own note as a small file under
`docs/ReleaseNotes/unreleased/`, committed in the PR's own diff — so the
note merges atomically with the work and two PRs landing the same day
never append-conflict. After the day's PRs merge,
`docs/ReleaseNotes/assemble.sh` folds the pending fragments into the
dated `ReleaseNotes-<date>.md` file and clears them. A non-blocking CI
check warns in the Actions tab when a merge to `main` changed contract
or app code but added no release-notes entry. The convention is
documented in `docs/ReleaseNotes/unreleased/README.md` and `CLAUDE.md`.

This release note is itself the first fragment authored under the new
convention. Closes #47.

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

## Thread — T-068 Phase 6: CCIP deploy & configuration tooling

Phases 1–5 of the LayerZero → Chainlink CCIP migration built the
cross-chain contracts and deleted the old LayerZero deploy scripts, but
did not replace them — there was no script to stand the cross-chain
stack up on a chain, nor to wire its lanes. Phase 6 closes that gap.

`DeployCrosschain.s.sol` deploys the whole CCIP stack for one chain in a
single run — the CCIP messenger, the VPFI token pool (lock/release on
canonical Base, burn/mint on a mirror), the rate-limit governor, the
reward messenger, and the buy receiver or mirror-token + buy adapter —
picking canonical-vs-mirror from the chain id. `ConfigureCcip.s.sol`
then wires the cross-chain topology — chain selectors, remote messengers,
the buy and reward channel peers, the per-lane token-pool rate limits
(through the bounds-checked governor), and the registration of VPFI as a
Cross-Chain Token. Because the wiring step reads every chain's
deployment record, it runs as a deliberate second pass once every chain
has been deployed.

The three shell orchestrators (`deploy-chain.sh`,
`deploy-testnet.sh`, `deploy-mainnet.sh`) were carrying calls to the
deleted LayerZero scripts; they now invoke the two new scripts, resolve
CCIP infrastructure addresses per chain, and — having no per-chain DVN
policy to curate any more — replace the old `lz-config` step with a
`ccip-wire` pass. The deploy-verify gate now confirms the token pool's
rate-limit admin is the governor rather than checking a now-absent
buy-adapter cap.

A rehearsal test stands the full two-chain stack up exactly as the
scripts deploy and wire it, and exercises all three cross-chain flows
(the buy round-trip, the reward report/broadcast, and the cross-chain
token mint/burn authority) plus a full wiring-consistency check. A new
operator runbook documents the testnet-rehearsal and mainnet-cutover
procedure, the mainnet-deploy gates, and the post-deploy steps.

One follow-up is deliberately left open: `Handover.s.sol` still rotates
the LayerZero-era contract set to governance and does not yet hand the
CCIP stack over — the cutover runbook flags this as a manual multisig
step until that script is updated.

Closes #60.

## Thread — T-068: Handover.s.sol brought onto the CCIP stack

The post-deploy ADMIN → governance handover script
(`script/Handover.s.sol`, the `--phase handover` step) was left
LayerZero-shaped after the cross-chain migration. Its Diamond-side work
— rotating the access-control roles and the Diamond's ownership to the
governance Safe and the Timelock, then renouncing the admin EOA's
authority — was always provider-agnostic and correct. Its cross-chain
half was not: it rotated the deleted LayerZero contract set and never
touched the new CCIP contracts, so a mainnet handover would have left
the CCIP messenger, the VPFI token pool, and the rate governor still
owned by the hot admin key — a violation of the project's cross-chain
security policy.

The script now hands the full CCIP contract set — the messenger, the
VPFI token pool, the rate governor, the reward messenger, and the
per-chain mirror token and buy adapter / receiver — to the governance
Timelock, and rotates the Cross-Chain Token administrator (the Chainlink
token-admin registry entry for VPFI) to the Timelock as well. The
Timelock was chosen as the destination for consistency with the
Diamond's own ownership: these contracts are upgradeable, so their owner
gates upgrades and lane configuration, which fits a review-window delay
— and fast incident response is still covered by the guardian pause
lever every cross-chain contract carries.

A simplification fell out of the migration: because the deploy and
configuration scripts leave every cross-chain contract owned by the one
admin address, the old per-contract owner-key juggling is gone — every
ownership transfer is signed by the single admin key.

Closes #63.

## Thread — T-068: deploy-script broadcasting phases gated behind preflight

The tiered mainnet and testnet deploy scripts run as a sequence of named
phases (`preflight`, `contracts`, `ccip-wire`, `configure`, `handover`,
…), each invoked as a deliberate operator action. The `preflight` phase
held the two checks that must hold before any on-chain broadcast — that
the configured RPC actually serves the expected chain, and (on mainnet)
that the operator has attested to signing from a hardware wallet — but
nothing forced `preflight` to run first. An operator could invoke a
broadcasting phase directly and skip both checks, so a mispointed RPC
URL could send a deploy to the wrong network unnoticed.

Those critical checks are now factored into a gate that runs at the top
of every broadcasting phase — `contracts`, `ccip-wire`, `swap-adapters`,
`configure`, and `handover` — not only in the optional `preflight`
phase. The RPC-serves-the-right-chain check is re-run every time, so it
reflects the current `.env` rather than whatever was true whenever
`preflight` last ran; the mainnet hardware-signer attestation is
enforced on every mainnet broadcast. The check was implemented as a
re-run rather than a "preflight already ran" marker precisely so it
cannot go stale. `preflight` itself still runs the gate plus its fuller
informational checks. The testnet script gets the same gate minus the
hardware-signer leg, which has no testnet analogue.

Closes #62.
