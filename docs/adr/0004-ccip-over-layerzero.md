# ADR-0004: Migrate cross-chain transport from LayerZero to Chainlink CCIP

**Status:** Accepted
**Date:** 2026-04 (T-068 migration; ADR backfilled 2026-05-20)

## Context

Vaipakam's cross-chain layer moves VPFI (fee-bearing protocol token,
sent across chains via the cross-chain-token pattern), broadcasts
reward state from the canonical reward-accounting chain (Base) to
mirror chains, and ferries the cross-chain VPFI buy flow's
BUY_REQUEST / VPFI-mint round-trip.

The original architecture used **LayerZero OFT V2** for token transport
plus LayerZero generic messaging for the reward / buy flows. That
choice predated the protocol's depth-tiered-LTV work and Phase 7's
oracle redundancy story.

In April 2026 the Kelp / LayerZero OFT-based bridge was exploited for
~$292M, riding LayerZero's default `1-required / 0-optional DVN`
verifier configuration. The exploit class was not a LayerZero
implementation bug — it was a *configuration* footgun: LayerZero's
security model requires each integrator to assemble a DVN fleet, and
the default surface lets a 1-DVN configuration through without warning.
Every integrator carries this responsibility; the same configuration
class is reachable by mistake even on a non-malicious deploy.

For a protocol that moves user collateral and protocol-fee value
across chains, configuration-burden security is the wrong shape. The
question was: continue with LayerZero (and assume the operational
discipline to configure DVNs correctly forever) or migrate.

## Decision

**Migrate the cross-chain layer to Chainlink CCIP.** T-068 deletes the
LayerZero OFT V2 + messaging surface and replaces it with:

- **`ICrossChainMessenger`** — a provider-agnostic port. Domain
  contracts depend on this interface, never on a CCIP library
  directly, so the protocol could swap providers again without
  domain-code churn.
- **`CcipMessenger`** — the single CCIP-aware adapter.
- **`VPFIMirrorToken`** + the stock CCIP `LockReleaseTokenPool` /
  `BurnMintTokenPool` — VPFI as a CCIP Cross-Chain Token (CCT). VPFI
  is the native ERC-20 on the canonical chain (Base); mirror chains
  hold the mirror proxy backed by a BurnMintPool.
- **`VpfiBuyAdapter` / `VpfiBuyReceiver`** — the cross-chain
  fixed-rate buy flow (two-step release preserved).
- **`VaipakamRewardMessenger`** — cross-chain reward accounting.
- **`VpfiPoolRateGovernor`** — the bounds-checked `rateLimitAdmin`
  for the VPFI TokenPools (ET-008-bounded). Refuses to disable a
  lane's limit and range-bounds every value.

Per-lane CCIP rate limits start at capacity 50,000 VPFI, refill
≈5.8 VPFI/s. Every cross-chain contract **with a runtime send /
receive path** carries `GuardianPausable` (guardian-or-owner
`pause()`, owner-only `unpause()`) — `CcipMessenger`,
`VaipakamRewardMessenger`, `VpfiBuyAdapter`, `VpfiBuyReceiver`, and
the mirror-chain VPFI ERC-20 `VPFIMirrorToken`. The
`VpfiPoolRateGovernor` is the rate-limit admin only (no runtime
send / receive path of its own; its setters are already owner-gated
through `Ownable2Step`), so it intentionally does NOT extend the
pause base — pausing the rate-limit admin would not be load-bearing
during a cross-chain incident, and the owner can re-set rates
directly. Mirror chains also wire the guardian on
`VPFIMirrorToken` via `ConfigureCcip._setGuardians` (post-#200);
the canonical `VPFIToken` is OFT-shaped and paused via its own
AccessControl path, not the cross-chain guardian. CCT admin = the
project's multisig → timelock at mainnet.

## Consequences

**Positive**

- CCIP's security is **operated by Chainlink**: a committing DON +
  an executing DON + an **independent Risk Management Network**
  (separate codebase and operators) that re-verifies every message.
  Uniform for every integrator. There is no DVN fleet to assemble
  per-integrator and no "1-required / 0-optional default" footgun
  reachable by configuration mistake.
- Provider-agnostic adapter layer (`ICrossChainMessenger`) makes
  any future provider swap a contained change.
- Per-lane rate limits enforced through a bounds-checked governor
  (`VpfiPoolRateGovernor`) — the operator cannot disable a limit
  or push values outside the policy range.
- The pause lever (`GuardianPausable`) on send + receive means a
  paused inbound is recorded by CCIP as a failed message and is
  manually re-executable once unpaused; nothing is lost.

**Negative / accepted costs**

- CCIP fees are paid in LINK (or wrapped native), generally higher
  than LayerZero's per-message cost at low volume. Acceptable given
  the security delta and the audit-readability story.
- CCIP supports a smaller chain set than LayerZero today. Phase 1
  scope = Ethereum, Base, Arbitrum, Optimism, BNB Chain. zk-rollup
  chains and Solana are explicitly out of scope.
- Migration cost: the LayerZero contracts (~12 of them) were
  deleted and replaced. Migration work landed in PR #46
  (merged 2026-05-18).

**Risks the decision creates**

- Vendor concentration on Chainlink — both for oracle feeds AND
  cross-chain transport. Mitigated at the oracle layer by the
  Phase 7b.2 Secondary Quorum (Tellor + API3 + DIA Soft 2-of-N).
  No equivalent at the messenger layer; CCIP's Risk Management
  Network is the architectural mitigation Chainlink itself
  provides.
- Phase 6 cutover (operator-run deploy onto live testnet then
  mainnet) is yet to land — see the T-068 Stage 2 card. The
  contracts are merged and tested; the live deploy is the
  remaining operator-gated step.

## Alternatives considered

**Alternative A — Stay on LayerZero with stricter DVN
configuration**: Rejected. Even with a well-configured DVN fleet,
the operational burden of maintaining it correctly forever is a
poor trust shape for a protocol moving user value. The April 2026
exploit demonstrated this is not a hypothetical concern.

**Alternative B — Build a custom messenger using
attestation-based + zk-proof bridges**: Rejected as over-engineered
for the protocol's needs. Custom messengers carry their own
implementation-bug risk that an audited third-party messenger
amortises across many integrators.

**Alternative C — Multi-provider redundancy (CCIP + LayerZero
both, route through the safer of the two)**: Considered. Rejected
for v1 — the marginal protection over single-provider CCIP doesn't
justify the implementation complexity, and the failure modes
(divergent message receipts between providers, replay across
providers) are non-trivial to design out. Worth revisiting if a
specific class of CCIP failure ever materialises.

**Alternative D — Native bridges only (no cross-chain messaging
layer)**: Rejected. Native bridges are chain-specific, do not
support the protocol's reward-broadcast pattern, and would balloon
the per-chain integration surface.

## References

- Spec: [`docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`](../DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md)
- Policy summary: [`CLAUDE.md`](../../CLAUDE.md) § "Cross-Chain Security Policy (CCIP)"
- Source: [`contracts/src/crosschain/`](../../contracts/src/crosschain/)
- T-068 Phase 6 (deploy + config tooling): merged PRs #61, #64, #65
- Related: ADR-0001 (Diamond pattern — orthogonal to cross-chain layer)
