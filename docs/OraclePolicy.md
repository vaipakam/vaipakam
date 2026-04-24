# Oracle policy

Operational playbook for Vaipakam's price-oracle surface. Covers what's
configured, what governance can change, what happens under each failure
mode, and how to verify the configured state matches the policy below.
Companion to `GovernanceRunbook.md`; both are pre-mainnet CI gates.

## Goal

Every price read the protocol consumes must satisfy ALL of:

1. A live Chainlink aggregator returned it.
2. Its age is under a bound — two-tier by default, per-feed overrideable.
3. Its value is above a configured floor — zero by default, per-feed overrideable.
4. A second, independent source (Pyth) agrees within a configured
   tolerance — or no Pyth is installed on this chain (then this
   requirement is not active).

If any of the four fails, `getAssetPrice` reverts. No silent fall-through
to a single source, no stale-data-as-fresh masking. The facets downstream
(RiskFacet, LoanFacet, DefaultedFacet, RefinanceFacet) all expect a
reverting read and treat its absence as "cannot price this position
right now".

## Primary source — Chainlink

Every supported asset must resolve to a Chainlink aggregator, either
directly via Feed Registry `(asset, USD)` or via the `(asset, ETH)` ×
`(ETH, USD)` fallback route. Assets without either route are classified
Illiquid and cannot back a loan.

**Two-tier staleness defaults (global):**

| Tier | Cap | Applies to |
|---|---|---|
| Volatile | 2 hours | Any feed whose answer does not sit near a peg ($1 USD, registered fiat/commodity references) |
| Stable (peg-aware) | 25 hours | 8-decimal feeds whose answer is within 3% of $1 USD OR any registered `stableFeedBySymbol` reference (EUR, JPY, XAU, etc.) |

The 25h ceiling exists because stablecoin aggregators and fiat/commodity
reference feeds publish on 24-hour heartbeats by design — forcing a
2-hour window on them would fail-closed under normal operation.

**L2 sequencer circuit breaker.** On L2 chains, `getAssetPrice` reads
the Chainlink sequencer-uptime feed first and reverts if the sequencer
is down OR is inside its 1-hour post-recovery grace window. Prevents
stale-price execution on an L2 resumption edge.

## Per-feed overrides (Phase 3.1)

Governance can tighten or relax either bound on a specific feed via
`OracleAdminFacet.setFeedOverride(feed, maxStaleness, minValidAnswer)`:

- `maxStaleness` in seconds. Zero clears the override (both fields
  reset) and the global two-tier ceiling resumes.
- `minValidAnswer` in the aggregator's own decimals. When set, any
  reading below the floor reverts — protects against compromised
  aggregators returning ~zero values during incidents.

When an override is active, the stable-peg relaxation (25h ceiling
when the answer is near $1) is bypassed. Operators who set an
override are taking explicit responsibility for the freshness budget
on that feed.

## Secondary source — Pyth (Phase 3.2)

For chains with a Pyth deployment, governance installs:

1. The chain's Pyth contract address via
   `OracleAdminFacet.setPythEndpoint(endpoint)`. Canonical per-chain
   addresses are published at
   https://docs.pyth.network/price-feeds/contract-addresses/evm.
   `address(0)` disables the Pyth check globally on the chain.
2. A per-asset Pyth config via
   `OracleAdminFacet.setPythFeedConfig(asset, priceId, maxDeviationBps, maxStaleness)`:
   - `priceId` — Pyth's 32-byte feed identifier.
   - `maxDeviationBps` — allowed divergence between Chainlink and
     Pyth, in basis points. **Typical values: 100 (1%) for stables,
     500 (5%) for volatile majors.**
   - `maxStaleness` — max acceptable age of the Pyth publishTime,
     in seconds. **Typical value: 60 seconds.**

**Fail-closed on Pyth-configured assets.** When a per-asset Pyth
config is live, `getAssetPrice` reverts if:

- Chainlink and Pyth disagree beyond `maxDeviationBps` → revert
  `OraclePriceDivergence`.
- The Pyth read is stale beyond `maxStaleness`, missing, or returns
  a non-positive value → revert `PythPriceUnavailable`.

This is deliberate — the whole point of adding Pyth is to refuse
prices that only ONE source can vouch for.

**Two-transaction user flow.** Pyth is a pull oracle, so any price-
reading Vaipakam action (`initiateLoan`, `triggerLiquidation`,
`addCollateral`, `refinance`, `preclose`) requires two sequential
transactions from the same EOA when Pyth is configured for the
relevant assets:

1. `IPyth(endpoint).updatePriceFeeds{value: fee}(updateData)` to
   prime Pyth's on-chain storage with a fresh signed update fetched
   from Hermes.
2. The Diamond action itself.

Nonce-ordered delivery guarantees Pyth stays fresh between the two
txs. The frontend's `useWriteWithPythUpdate` hook handles the
Hermes fetch and submits both txs automatically when the user
clicks a single action button.

## Chain matrix — recommended defaults

| Chain | Chainlink | Pyth | Typical per-asset config |
|---|---|---|---|
| Ethereum L1 | All major assets | Available | Stables: 1% deviation / 60s · Majors: 5% / 60s |
| Base | Major assets | Available | Same |
| Arbitrum | Major assets | Available | Same |
| Optimism | Major assets | Available | Same |
| Polygon zkEVM | Limited | Available | Use Pyth as primary where Chainlink missing |
| BNB Chain | Major assets | Available | Same |

Testnet chains: the recommended posture is "Chainlink only, Pyth
endpoint set but no per-asset configs" — exercises the primary path
without gating every testnet action on a Hermes fetch.

## Verification

Pre-mainnet, every `(chain, asset)` pair in use must satisfy the
following via an on-chain readback:

- `OracleFacet.getAssetPrice(asset)` returns a non-zero price (smoke).
- `OracleAdminFacet.getFeedOverride(feed)` matches the target override
  for feeds the policy tightens (high-value collateral).
- `OracleAdminFacet.getPythEndpoint()` is non-zero on every chain where
  Pyth is intended.
- `OracleAdminFacet.getPythFeedConfig(asset)` matches the chain-matrix
  target for every asset that will back a loan.

A Foundry test at `test/OraclePolicyReadback.t.sol` (to be written as a
follow-up alongside `GovernanceHandover.t.sol`) should drive these
readbacks against a forked target chain as a CI gate.

## What this policy does NOT cover

- **Pyth on-chain infra outage.** If Pyth's endpoint contract itself
  reverts, the deviation check reverts — fail-closed. Users see a
  price-unavailable error and can retry once Pyth recovers.
  Governance can choose to temporarily clear the per-asset Pyth config
  to unblock critical paths, but that's a deliberate, timelock-gated
  decision.
- **Multi-sig compromise of the Safe or Timelock.** Oracle-layer
  defences do not protect against governance-signer compromise. That
  risk is addressed by the Safe + Timelock + Guardian model
  documented in `GovernanceRunbook.md`.
- **A long-tail asset without either Chainlink or Pyth coverage.**
  Such assets are classified Illiquid and cannot back a loan. The
  Liquid / Illiquid split is the oracle layer's escape hatch for
  coverage gaps.
