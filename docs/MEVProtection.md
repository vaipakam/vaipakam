# MEV protection

Summary of what Vaipakam does to protect users and the protocol against
MEV (Maximal Extractable Value) extraction by sandwichers, front-
runners, and liquidation-racing bots. Written as an operator / user
reference — pairs with `OraclePolicy.md` and `GovernanceRunbook.md`.

## TL;DR

| Vector | Protection |
|---|---|
| Sandwich attack on liquidation swap | On-chain minOutput guard in RiskFacet + DefaultedFacet. **Enforced, not bypassable.** |
| Oracle manipulation to trigger liquidation | Chainlink + Soft 2-of-N quorum across Tellor + API3 + DIA + L2 sequencer circuit breaker. **Enforced.** |
| Liquidator race during HF < 1 | Natural: first liquidator wins the bonus. Permissionless by design. |
| Defensive borrower / lender txs getting front-run (repay, addCollateral) | User-level mitigation only — no protocol enforcement. |

## What's enforced on-chain

### Liquidation slippage guard

Both liquidation paths (HF-based via `RiskFacet.triggerLiquidation` and
time-based via `DefaultedFacet`) compute an oracle-derived
`minOutputAmount` equal to 94% of expected proceeds and pass it to
the Phase 7a swap-failover library (`LibSwap.swapWithFailover`). Each
adapter in the failover chain (0x / 1inch / UniV3 / Balancer V2)
enforces the same min-out floor on its own side — UniV3 and Balancer
via the underlying DEX's `amountOutMinimum`; the aggregator adapters
via a balance-delta check around the call.

Phase 7a changed the trigger signature to take a caller-supplied
ranked try-list (`AdapterCall[]`) so a keeper / frontend can submit
multiple route attempts ranked by expected output. **The
`minOutputAmount` floor itself remains oracle-derived and
caller-insulated** — the keeper picks routes, but cannot weaken the
slippage cap. A sandwich that pushes any single adapter's output
below the floor causes that adapter to revert; the failover library
moves to the next-best entry. Only when **every** adapter reverts
(no path can clear the floor) does the loan fall to the existing
claim-time full-collateral fallback.

Invariant locked in by `test/LiquidationMinOutputInvariant.t.sol`:
`vm.expectCall` with exact calldata, across a 1,000-address fuzz of
liquidator identities — any regression that accidentally lets a
caller influence the min-output floor fails the test.

### Oracle defences feeding liquidation

Phase 3.1 tightens per-feed staleness bounds. Phase 7b.2 replaces
the prior Pyth-secondary integration with a **Soft 2-of-N quorum**
across **Tellor + API3 + DIA**. All three secondaries derive their
lookup keys from `IERC20.symbol()` on-chain, so adding new collateral
assets never requires a per-asset governance write. Phase 7b.1 adds
parallel multi-venue depth classification at
`OracleFacet.checkLiquidity`, OR-combining UniswapV3 + PancakeSwap V3
+ SushiSwap V3 factory probes.

Together, these close the class of attacks where manipulating one
price source — or paus­ing one DEX — lets an attacker artificially
trigger a liquidation at an advantageous rate. To push a fake price
through the gate, an attacker now has to compromise **Chainlink
plus every secondary that has data for the asset** in the same
block.

See `OraclePolicy.md` for the full config.

### L2 sequencer circuit breaker

On L2 chains (Base, Arbitrum, Optimism, Polygon zkEVM), HF-based
liquidation reverts if the Chainlink sequencer-uptime feed reports
the sequencer is down OR is still inside its 1-hour post-recovery
grace window. Prevents attackers from exploiting the small stale-
price window at L2 resumption to trigger unfair liquidations.

## What's NOT enforced on-chain (user-level vectors)

### Defensive borrower / lender txs

A borrower whose HF is approaching 1.0 wants to `addCollateral` or
`repayPartial` before a bot liquidates them. A lender on an at-risk
loan may want to refinance out. These defensive txs are visible in
the public mempool and can be front-run by a liquidation bot racing
to grab the bonus before the user's save lands.

**No protocol enforcement** protects against this — and deliberately
so. Hard-gating user txs against mempool visibility would require
either a private mempool integration at the protocol layer (complex
and chain-specific) or a UX that most users can't navigate.

**User-level mitigations available:**

- **Whitelist a trusted keeper.** The existing `KeeperSettings`
  system lets a user pre-authorize an address to execute defensive
  actions on their behalf. A keeper operating its own tx flow
  (monitoring + submitting via private mempools) sidesteps the
  public-mempool front-running window. This is the pattern we
  direct users to on the loan-detail page's Keeper-delegation card.
- **Use a private-mempool RPC.** Users on Ethereum mainnet can
  route their wallet through Flashbots Protect or MEV Blocker;
  users on BNB Chain through bloXroute / MEV-Blocker. L2 chains
  (Base, Arbitrum, Optimism, Polygon zkEVM) have sequencer-ordered
  inclusion and are naturally much less exposed — MEV protection
  there is usually unnecessary.

**Deliberately NOT shipped:** a frontend CoinGecko / CoinMarketCap
sanity banner. Evaluated and rejected in the Phase 3.2 scoping —
any frontend check is bypassable via DevTools / a custom frontend /
a direct `cast send`, so it doesn't raise the actual security floor.
The in-protocol Chainlink + Soft 2-of-N (Tellor + API3 + DIA)
deviation check is what actually enforces price sanity.

### Liquidator race

When a loan's HF drops below 1.0, the protocol is permissionlessly
liquidatable. Multiple bots race to be first; whoever lands the tx
first gets the bonus. This is **natural MEV**, not an attack — it's
how every serious lending protocol handles liquidator selection,
and the race pressure is what makes liquidations timely.

Protocol-operated bots are NOT deployed by Vaipakam. Anyone can run
a liquidator against the public HF view. Documentation of the
liquidator-bot pattern is a Phase 2+ follow-up.

## Keeper system as defensive lever

The keeper system doubles as the user's main MEV-mitigation tool.
Roles (per `README.md` §3):

- A borrower whitelists a keeper; that keeper can add collateral,
  repay partial, or refinance on the borrower's behalf.
- A lender whitelists a keeper; that keeper can accept offers /
  refinance on the lender's behalf.
- Keepers **cannot** claim funds or transfer position NFTs — claim
  rights stay with the NFT owner.

A keeper running its own MEV-protected submission flow (Flashbots
bundles, private mempool RPC, or just wallet-level protection on L1)
can execute defensive actions without the front-running window the
user would face from the public UI. This is the supported pattern.

## Phase 5 note — protocol auto-defender bot

Phase 5 of the security-sprint queue proposes a protocol-operated
auto-defender bot that would be whitelisted as a default keeper for
opted-in users, executing HF-rescue actions without user interaction
when a loan approaches distress. Design scope is in
`memory/project_phase5_borrower_lif_discount.md` in the operator's
private memory — not yet committed as a deliverable because the
operational cost (gas, uptime SLA) and legal surface (acting on
users' behalf by default) need a separate product discussion.

## Verification

- `test/LiquidationMinOutputInvariant.t.sol` — the caller-insulation
  invariant on `minOutputAmount` (still load-bearing under Phase 7a's
  caller-ranked failover chain).
- `test/SwapAdapterTest.t.sol` — Phase 7a 4-adapter failover unit
  coverage (slippage-gated reverts, residual return on partial
  fills, allowance scope).
- `test/OracleLiquidityORTest.t.sol` — Phase 7b.1 3-V3-clone OR-logic.
- `test/SecondaryQuorumTest.t.sol` (queued, Phase 7b.2.e) — Soft
  2-of-N quorum semantics across Tellor + API3 + DIA.
- `test/FeedOverride.t.sol` — per-feed staleness + min-answer bounds.

All five suites are part of the gate before every mainnet deploy,
alongside `LZConfig.t.sol` and `GovernanceHandover.t.sol`. The
removed `test/PythDeviation.t.sol` was replaced by the symbol-
derived secondary path; Pyth was retired in Phase 7b.2 because its
per-asset `priceId` mapping conflicted with the no-per-asset-config
policy.
