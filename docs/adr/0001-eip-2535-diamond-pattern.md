# ADR-0001: Adopt EIP-2535 Diamond Pattern for the core protocol

**Status:** Accepted
**Date:** 2025 (original choice; ADR backfilled 2026-05-20)

## Context

Vaipakam's core protocol surface is broad: lending offers, borrowing
offers, accept / match flows, loan lifecycle (init, repay, preclose,
refinance, default, claim, liquidate, early-withdraw, partial-fill),
NFT rental, oracle reads, depth probes, risk math, treasury, admin
governance, sanctions screening, escrow factory, position NFTs, range
matching, VPFI fee discount, VPFI buy adapter / receiver, cross-chain
reward messenger. Every one of these surfaces shares state with at
least one other (loan state, escrow assignments, protocol config,
asset registries, risk parameters).

Three constraints framed the architecture choice:

1. **The EIP-170 limit** — 24,576 bytes of runtime bytecode per
   contract. The combined surface above significantly exceeds this in
   any "one big contract" implementation.
2. **Storage cohesion** — every subsystem reads (and most write) a
   shared core: open loans, user escrows, oracle prices, admin
   policy. Splitting into independent contracts that each carry
   private storage would force cross-contract calls just to read
   state, with every read incurring an external CALL.
3. **Upgrade granularity** — the protocol expects to evolve. Some
   subsystems (oracle stack, swap aggregator routing, risk math)
   change more often than others (Diamond core, NFT escrow). A
   single monolithic upgrade path forces every change to redeploy
   the whole protocol.

## Decision

Adopt **EIP-2535 (Diamond Standard)** as the core protocol's
architectural pattern. `VaipakamDiamond.sol` is the single entry
point; all calls hit its `fallback()`, which routes to the correct
facet by 4-byte function selector. All facets share storage through
`LibVaipakam.sol` at the deterministic position
`keccak256("vaipakam.storage")`.

Cross-facet calls use `address(this).call(abi.encodeWithSelector(...))`
— this routes back through the Diamond's `fallback()` and reaches the
target facet without leaving the Diamond's address space.

Per-user escrow uses a separate (non-Diamond) UUPS pattern (see
ADR-0008) — the per-user isolation requirement is orthogonal to the
core surface's shared-storage requirement.

## Consequences

**Positive**

- The combined protocol surface fits, with each facet under the
  EIP-170 limit (enforced by `FacetSizeLimitTest`).
- Subsystem upgrades are surgical: change a single facet's
  selectors via `diamondCut(...)`, no broad redeploy.
- Storage cohesion preserved: every facet reads the same shared
  `LibVaipakam` struct without an external CALL.
- Function-selector routing is the only call-path concern at the
  Diamond entry — keeps the fallback hot path small.

**Negative / accepted costs**

- Selector collision becomes a deploy-time risk. Mitigated by
  `SelectorCoverageTest` (every external/public function in every
  cut facet is asserted to be routed, with no 4-byte collision).
- Facet boundaries are conventional, not enforced by the EVM —
  one facet can technically write to another facet's "logical"
  state. Mitigated by code-review discipline + storage being
  centralised in `LibVaipakam` rather than per-facet.
- Diamond cuts are admin-gated and (at mainnet) timelock-routed
  — adding a facet is not a zero-effort operation. This is
  intentional friction against governance abuse, not a side
  effect.

**Risks the decision creates**

- A malicious or buggy facet cut could write to arbitrary storage
  via the shared layout. Defence: every cut goes through the same
  PR / review / audit / timelock pipeline as Solidity-source
  changes; `DiamondFacetNames` + `SelectorCoverageTest` make the
  routed surface explicit.
- The fallback dispatch is a critical path. Defence: it is the
  Diamond-3-hardhat reference implementation, audited upstream;
  no Vaipakam-specific logic inside the `fallback()`.

## Alternatives considered

**Alternative A — Monolithic single contract**: Rejected because of
EIP-170. Even with aggressive optimisation (`viaIR = true`, 200
optimizer runs), the combined surface exceeded the 24 KB limit by
a wide margin once the full feature set (offers + risk + oracle +
escrow + VPFI + cross-chain + sanctions) was in place.

**Alternative B — Subsystem contracts with private storage, calling
each other**: Rejected because every read of shared state would
become an external CALL with the associated gas cost and
re-entrancy surface. The per-loan, per-offer, per-escrow read
patterns make this prohibitive.

**Alternative C — Transparent / UUPS proxy with a single
implementation**: Solves upgrade granularity but not size. The
implementation itself still has to fit under EIP-170.

**Alternative D — Beacon proxy with multiple implementations**:
Improves upgrade granularity over Alt C but still doesn't address
storage cohesion (each implementation would carry its own slot
layout). Diamond's shared-storage pattern is strictly better here.

## References

- Source: [`contracts/src/VaipakamDiamond.sol`](../../contracts/src/VaipakamDiamond.sol),
  [`contracts/src/libraries/LibVaipakam.sol`](../../contracts/src/libraries/LibVaipakam.sol),
  [`contracts/lib/diamond-3-hardhat/`](../../contracts/lib/)
- Deploy-sanity: [`contracts/test/deploy/FacetSizeLimitTest.t.sol`](../../contracts/test/deploy/FacetSizeLimitTest.t.sol),
  [`contracts/test/deploy/SelectorCoverageTest.t.sol`](../../contracts/test/deploy/SelectorCoverageTest.t.sol)
- Spec: [`apps/www/src/content/whitepaper/Whitepaper.en.md`](../../apps/www/src/content/whitepaper/Whitepaper.en.md) §3.1 (Diamond Pattern)
- Related: ADR-0008 (per-user escrow factory)
