# Third-Party Dependency Audit — 2026-05-17

**Purpose.** Catalogue every external / third-party dependency Vaipakam
relies on, and record how *swappable* each one is — can a provider be
replaced via runtime admin config, a localized code change, or only a
major effort? Produced in response to: "are all our third parties
modular and swappable?"

**Scope.** `contracts/src/` (on-chain); `apps/{agent,keeper,indexer,defi,www}`
and `ops/` (off-chain).

**Method.** On-chain dependencies verified by direct source inspection
(`file:line` cited). Off-chain dependencies verified by Worker / app
file-structure inspection. Companion to
[`OffchainDataFetchAudit-2026-05-15.md`](OffchainDataFetchAudit-2026-05-15.md)
(external *data* surfaces) — this audit is broader: all third parties
plus a swappability verdict.

**Verdict legend.**

- 🟢 **CONFIG-SWAPPABLE** — replaceable at runtime via an admin setter
  / adapter registry; no code change, no contract upgrade.
- 🟡 **CODE-SWAPPABLE** — replacement is a localized code change (one
  isolated file / adapter / library).
- 🔴 **DEEP-INTEGRATED** — pervasive or hardcoded; replacement is a
  major effort (contract upgrade / cross-cutting rewrite).

## Assumptions caught / corrected

A from-memory synthesis written earlier the same day (pre-audit) made
two claims this verified audit **corrects**:

1. **"Pyth was removed."** — Wrong. Pyth was removed from the
   *secondary price-oracle quorum* in Phase 7b.2, but **re-added by
   T-033** as a **numeraire cross-check** (a single ETH/USD Pyth feed
   per chain that cross-checks the Chainlink numeraire). It is present
   and fully admin-configurable — `OracleAdminFacet.setPythOracle`
   (`:412`, a zero address disables it), `setPythCrossCheckFeedId`
   (`:424`), `setPythMaxStalenessSeconds` (`:436`),
   `setPythCrossCheckMaxDeviationBps` (`:447`).
2. **"The secondary oracle quorum is CODE-SWAPPABLE."** — Understated.
   Each secondary oracle has a runtime admin address setter; it is
   🟢 CONFIG-SWAPPABLE per provider (see #4).

## On-chain dependencies

| # | Dependency | Used for | Where (`file:line`) | Verdict |
|---|---|---|---|---|
| 1 | Swap aggregators — 0x, 1inch, Uniswap V3, Balancer V2 | liquidation swaps | `AdminFacet.addSwapAdapter:191` / `removeSwapAdapter:208` / `reorderSwapAdapters:232`; registry `LibVaipakam.Storage.swapAdapters[]:2305` | 🟢 |
| 2 | Chainlink price feeds + feed registry | primary price oracle | `OracleAdminFacet`: `setChainlinkRegistry:60`, `setEthUsdFeed:174`, `setStableTokenFeed:210`, `setSequencerUptimeFeed:239`, `setFeedOverride:269`, `setWethContract:130` | 🟢 |
| 3 | Pyth | numeraire cross-check (T-033) | `OracleAdminFacet.setPythOracle:412` (0 disables), `setPythCrossCheckFeedId:424`, `setPythMaxStalenessSeconds:436` | 🟢 |
| 4 | Secondary oracle quorum — Tellor, API3, DIA | price-redundancy quorum | `OracleAdminFacet.setTellorOracle:321`, `setApi3ServerV1:338`, `setDIAOracleV2:355` | 🟢 per provider \* |
| 5 | LayerZero | cross-chain OFT / messaging | `token/VPFIOFTAdapter.sol`, `token/VPFIMirror.sol`, `interfaces/IRewardOApp.sol`; facets `RewardAggregatorFacet`, `RewardReporterFacet`, `VPFITokenFacet`, `VPFIDiscountFacet`, `TreasuryFacet` | 🔴 |
| 6 | Permit2 | gasless approvals (try-fallback) | centralized in `libraries/LibPermit2.sol`; used by `OfferFacet`, `EscrowFactoryFacet`, `VPFIDiscountFacet`, `keeper/FlashLoanLiquidator` | 🟡 |
| 7 | Sanctions oracle (Chainalysis-style) | wallet sanctions screening | `ProfileFacet.setSanctionsOracle:635` → `LibVaipakam.setSanctionsOracle` (0 = fail-open) | 🟢 |
| 8 | Aave / Compound peer-LTV reads | peer-rate aggregation | `libraries/LibPeerLTV.sol`; interfaces `IAavePoolDataProvider.sol` (Aave), `IComet.sol` (Compound) | 🟡 |

\* Each secondary oracle's *address* is admin-set and disable-able via
a zero address; adding a **new provider type** (a 4th secondary)
requires code — a new interface + read path.

## Off-chain dependencies

| # | Dependency | Used for | Where | Verdict |
|---|---|---|---|---|
| 9 | RPC providers (Alchemy / Infura / …) | chain reads | `RPC_*` env / secrets in `apps/{agent,keeper,indexer}` | 🟢 |
| 10 | 0x / 1inch quote APIs | off-chain liquidation quoting | `apps/agent/src/quoteProxy.ts` | 🟡 |
| 11 | Transaction scanner — Blockaid | `SimulationPreview` pre-sign scan | `apps/agent/src/scanProxy.ts` | 🟡 — ET-001 swaps it → GoPlus |
| 12 | Push Protocol | HF / event notifications | `apps/agent/src/push.ts` | 🟡 |
| 13 | Telegram | bot handshake + notifications | `apps/agent/src/telegram.ts` | 🟡 |
| 14 | Farcaster | public Frames | `apps/agent/src/frames.ts` | 🟡 |
| 15 | Google Analytics | consent-gated frontend analytics | `apps/defi/src/lib/consent.ts` | 🟡 |
| 16 | WalletConnect / wagmi | wallet connection | `apps/defi/src/context/WalletContext.tsx` | 🟡 |
| 17 | DeFiLlama / CoinGecko | Tier-3 liquidity / price advisory | `apps/defi` — `BuyVPFI`, `CreateOffer`, `EscrowAssets`, `lib/chainPlatforms` | 🟡 |
| 18 | The Graph subgraph | drift / supplementary indexing | `ops/subgraph/` | 🟡 |
| 19 | Tenderly | alert presets | `ops/tenderly/` | 🟡 |
| 20 | Cloudflare — Workers / D1 / R2 / Pages | the entire off-chain host | `apps/*/wrangler.jsonc`; 5 Workers + Pages | 🔴 |

## Findings

**🟢 9 CONFIG-SWAPPABLE · 🟡 9 CODE-SWAPPABLE · 🔴 2 DEEP-INTEGRATED.**

- Every **safety-critical on-chain** dependency is 🟢 — swap
  aggregators, the full oracle layer (Chainlink + Pyth + Tellor +
  API3 + DIA — every provider has an admin address setter, most
  disable-able via a zero address), and the sanctions oracle. A
  provider can be repointed or disabled by admin config alone, with
  no contract upgrade.
- The **off-chain** providers are 🟡 — deliberately isolated behind
  one-file Worker proxies (`quoteProxy.ts`, `scanProxy.ts`,
  `push.ts`, …). The in-flight Blockaid → GoPlus migration (ET-001)
  is a single-file change — direct proof the isolation pattern works.
- **Only two are 🔴 DEEP-INTEGRATED, and both are already tracked:**
  - **LayerZero** — the cross-chain layer is built on it (OFT
    adapter, mirror, reward OApp, five facets). Replacement is
    tracked as **T-068** (LayerZero → Chainlink CCIP).
  - **Cloudflare** — the whole off-chain stack (5 Workers, D1, R2,
    Pages) runs on it; a single point of failure. Resilience is
    tracked as **T-077** (disaster recovery / backup).

## Verdict

**The platform is well-modularized for provider-swapping.** No
safety-critical dependency is locked to a single vendor without an
escape hatch; the two genuinely hard-to-replace dependencies
(LayerZero, Cloudflare) are inherent to their roles and are both
already on the tracker. The modular swap-adapter registry and the
Worker-proxy isolation pattern are sound and have already paid off
(0x v1→v2, 1inch v5→v6, the Blockaid → GoPlus swap).

## Recommendations

1. No structural change needed — the modularity is appropriate, not
   over-engineered.
2. Keep **T-068** (LayerZero) and **T-077** (Cloudflare) as the two
   recognised single-vendor risks — they are the only dependencies a
   vendor's pricing / legal / availability change cannot be absorbed
   for by config or a localized code change.
3. When adding any *new* third party, keep to the established
   pattern — an adapter behind an admin registry (on-chain) or an
   isolated Worker proxy (off-chain) — so this verdict stays true.
