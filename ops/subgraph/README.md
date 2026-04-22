# Vaipakam Drift Subgraph

Minimal subgraph with one purpose: detect invalid `LoanStatus` transitions and surface each loan's full transition history. The Tenderly alerts under [`../tenderly/`](../tenderly/) reference this subgraph for cross-event context ("was this loan previously repaid before the Defaulted event fired?") that a single event log cannot provide.

## What's indexed

Only five events from the Diamond:

- `LoanInitiated` (LoanFacet)
- `LoanRepaid` (RepayFacet)
- `LoanDefaulted` (DefaultedFacet)
- `LoanLiquidated` (DefaultedFacet)
- `LiquidationFallback` (DefaultedFacet + RiskFacet)

Everything else — offers, TVL, NFTs, metrics — is served by the frontend's direct on-chain reads. We intentionally keep this subgraph narrow so the schema is small, the reindex is cheap, and the alert-critical invariant (state-machine validity) has a very small failure surface.

## State machine enforced by the indexer

```
  Unknown ──▶ Active ──┬─▶ Repaid     (terminal)
                       ├─▶ Defaulted  (terminal)
                       ├─▶ Liquidated (terminal)
                       └─▶ FallbackPending ──┬─▶ Repaid
                                             ├─▶ Defaulted
                                             └─▶ Liquidated
```

Any transition outside this diagram is recorded with a non-null `invalidReason` on the `LoanTransition` entity and increments the global `DriftStats.invalidTransitions` counter. The drift alert polls that counter.

## Deploy (per chain)

Each chain gets its own subgraph deployment because the data sources are per-address. The `subgraph.yaml` committed here has placeholders — copy it, fill in the chain's Diamond address + deploy block + network, and deploy.

```bash
cd ops/subgraph
npm install

# Pull the Diamond ABI from the contracts workspace.
mkdir -p abis
forge inspect VaipakamDiamond abi --json --root ../../contracts > abis/Diamond.json

# Per-chain configuration
export NETWORK=base-sepolia
export DIAMOND_ADDRESS=0x...
export DEPLOY_BLOCK=12345678

# Replace placeholders (manual or envsubst) and deploy
npm run codegen
npm run build
npm run deploy:base-sepolia
```

## Useful queries

### Any invalid transitions in the last 24h?

```graphql
{
  driftStats(id: "global") {
    invalidTransitions
    lastInvalidTxHash
    lastInvalidTimestamp
  }
}
```

### Full history of a specific loan

```graphql
query LoanHistory($id: ID!) {
  loan(id: $id) {
    loanId
    currentStatus
    defaultedCount
    repaidCount
    liquidatedCount
    fallbackCount
    transitions(orderBy: timestamp, orderDirection: asc) {
      fromStatus
      toStatus
      invalidReason
      timestamp
      txHash
    }
  }
}
```

### All loans with at least one invalid transition

```graphql
{
  loanTransitions(where: { invalidReason_not: null }, orderBy: timestamp, orderDirection: desc) {
    loan { loanId }
    fromStatus
    toStatus
    invalidReason
    txHash
  }
}
```
