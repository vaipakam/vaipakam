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
