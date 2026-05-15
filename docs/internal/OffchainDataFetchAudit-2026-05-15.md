# Off-chain data-fetch audit — 2026-05-15

Item **C.1** from
[`PendingTasks-2026-05-14.md`](PendingTasks-2026-05-14.md), tracked
live on
[`@vaipakam-labs` Issue #1](https://github.com/vaipakam/vaipakam/issues/1).
Walks every off-chain → on-chain data flow the protocol consults
and verifies each carries (a) bounds, (b) a freshness gate, and
(c) a documented fail-mode for stale / malformed / poisoned input.

**Result: 1 documentation bug, 2 minor hardening recommendations,
0 critical findings.** The protocol's external-data surface is
layered defence-in-depth: every consumer pairs a primary source
with either a secondary cross-validation, a plausibility bound,
or a fall-back to a conservative library default. No
single-source-of-truth attack vector was found.

This doc is the audit-package addendum that completes the trio
alongside
[`ConfigKnobBoundsAudit-2026-05-14.md`](ConfigKnobBoundsAudit-2026-05-14.md)
(governance-knob ranges) and
[`WethChainSafetyAudit-2026-05-14.md`](WethChainSafetyAudit-2026-05-14.md)
(per-chain WETH semantics). Together the three docs are the
auditor's cold-read pack for the data + config + chain-semantics
surfaces.

---

## Threat model

The audit asks one question per external read:

> If an attacker can make this source return whatever they
> want — within the bounds the source itself allows —
> what's the worst on-chain effect?

Per-read columns:

| Column | What it answers |
| --- | --- |
| **Signer** | Who or what attests to the data (Chainlink committee, peer protocol, off-chain operator EOA, anyone). |
| **TTL** | Maximum age the consumer will trust. Beyond this, the read is rejected or falls back. |
| **Fail-mode** | What happens when stale / malformed: revert (fail-closed), or use prior value (fail-soft). |
| **Bound** | Plausibility / range guard applied before the value enters protocol state. |
| **Blast radius if poisoned** | What single transaction's worst on-chain effect looks like, assuming bounds + TTL pass. |

---

## Already-handled (background only — not the audit subject)

These layered defences are pre-existing and not re-audited here.
The Part-N tables below treat them as constraints inside which
each individual read operates.

- **Per-asset Chainlink primary price** with hybrid peg-aware
  staleness (2h volatile / 25h stable-with-peg-check) — see
  [`OracleFacet.sol#L1763-L1910`](../../contracts/src/facets/OracleFacet.sol#L1763-L1910).
- **L2 sequencer circuit breaker** with 1h grace post-recovery —
  see
  [`OracleFacet.sol#L1956-L1990`](../../contracts/src/facets/OracleFacet.sol#L1956-L1990).
- **Soft 2-of-N secondary quorum** (Tellor + API3 + DIA), per-
  source `Unavailable` / `Agree` / `Disagree`, fail-closed when
  every responder disagrees — see
  [`OracleFacet.sol#L774-L808`](../../contracts/src/facets/OracleFacet.sol#L774-L808).
- **3-V3-clone OR-logic depth classifier** (Uniswap + PancakeSwap
  + SushiSwap factories) with TWAP-tick guard + value-balance
  check — see
  [`OracleFacet._checkLiquidity`](../../contracts/src/facets/OracleFacet.sol).
- **LibSwap minOutputAmount guard** — every aggregator-returned
  route is bracketed by an oracle-derived `minAmountOut` enforced
  at swap settlement, so 0x / 1inch returning a malicious route
  reverts at the protocol boundary — see
  [`LibSwap.sol#L127`](../../contracts/src/libraries/LibSwap.sol#L127).
- **LibPeerLTV staticcall-decode pattern** — every peer read
  uses `staticcall` + `abi.decode` so a reverting / malformed
  peer doesn't kill the whole `refreshTierLtvCache` tx; the
  affected peer is reported as `ok = false` and dropped from
  consensus — see
  [`LibPeerLTV.sol`](../../contracts/src/libraries/LibPeerLTV.sol).
- **`effectiveTier = min(getLiquidityTier(asset), keeperTier)`**
  — a compromised `KEEPER_ROLE` key can only *lower* an asset's
  effective tier (raise its risk-aversion) — never raise it
  above the on-chain ceiling — see
  [`OracleFacet.sol#L1146-L1148`](../../contracts/src/facets/OracleFacet.sol#L1146-L1148)
  + [`ConfigFacet.setKeeperTier`](../../contracts/src/facets/ConfigFacet.sol).

---

## Part 1 — Chainlink primary price feeds

The protocol's primary asset price source. Read at every loan
init, every Health-Factor check, every liquidation trigger, every
collateral-collapse test.

| Surface | File | Signer | TTL | Fail-mode | Bound | Blast radius if poisoned |
| --- | --- | --- | --- | --- | --- | --- |
| `_validatePriceFeed` | [`OracleFacet.sol#L1763`](../../contracts/src/facets/OracleFacet.sol#L1763) | Chainlink committee per feed | 2h volatile / 25h stable-with-peg | Revert `StalePriceData` (fail-closed) | `answer > 0` + `updatedAt > 0 + ≤ now` + `roundId == answeredInRound` | None — revert before value enters state |
| `getAssetPrice` (caller) | [`OracleFacet.sol`](../../contracts/src/facets/OracleFacet.sol) | Same | Same | Same | + Soft 2-of-N quorum gate at L774 | None — `_enforceSecondaryQuorum` blocks divergent prices |
| `ethNumeraireFeed` | per-chain admin-set | Chainlink committee for ETH/PAD | Same | Same | Per-chain validated at set-time | Misprices every WETH-quoted asset on that chain; bounded by quorum |
| `sequencerUptimeFeed` | [`OracleFacet.sol#L1959`](../../contracts/src/facets/OracleFacet.sol#L1959) | Chainlink L2 sequencer feed | Liveness only — no staleness window | Revert `SequencerDown` / `SequencerInGracePeriod` | `startedAt > 0` + post-recovery grace ≥ 1h | Pauses all liquidation paths on the affected L2 — fail-closed |

**Per-feed registration** (`OracleAdminFacet.setFeedRegistry` /
`setPriceFeed`): per-chain admin-set; the feed address is
admin-rotation-protected by `ADMIN_ROLE` + timelock.

**Verdict**: clean. The hybrid staleness rule (volatile 2h /
stable-with-peg 25h) tolerates Chainlink's varying heartbeat
across asset classes without widening the trust window for
volatile assets.

---

## Part 2 — Secondary oracle quorum (Tellor + API3 + DIA)

Phase 7b.2 cross-validation layer that fires AFTER the primary
Chainlink read clears. Soft 2-of-N rule: every secondary returns
one of `Unavailable` / `Agree` / `Disagree`; the protocol accepts
if at least one Agrees or all are Unavailable; rejects if any
Disagree without an Agree.

| Source | Read site | Signer | TTL | Fail-mode | Bound | Blast radius if poisoned |
| --- | --- | --- | --- | --- | --- | --- |
| **Tellor** | [`_checkTellor`](../../contracts/src/facets/OracleFacet.sol) | Tellor reporters (staked TRB) | `effectiveSecondaryOracleMaxStaleness` (admin-tunable; default ~1h) | Return `Unavailable` (one source dropping out doesn't fail the quorum) | `reportedAt != 0` + `raw.length ≥ 32` + `decoded > 0` + symbol-key lookup ok | Drops from quorum on stale / malformed; can only force a `Disagree` if reporter price diverges beyond `secondaryOracleMaxDeviationBps` — primary still accepted iff API3 OR DIA agrees |
| **API3** | `_checkApi3` | API3 first-party data feed provider (Airnode signature) | Same | Same | `value != 0` + symbol-key lookup ok | Same |
| **DIA** | `_checkDIA` | DIA's contracted price providers | Same | Same | `value != 0` + symbol-key lookup ok | Same |

**Quorum logic** ([`OracleFacet.sol#L774-L808`](../../contracts/src/facets/OracleFacet.sol#L774-L808)):
- All three `Unavailable` → accept primary (graceful fallback for
  sparse coverage).
- Any `Agree` → accept primary (1-of-3 lower bar is intentional —
  the secondaries are corroboration, not primary).
- Any `Disagree` AND no `Agree` → revert `SecondaryQuorumFailed`
  (fail-closed).

To poison: an attacker would need to compromise (a) Chainlink's
primary price reporter, AND (b) every responsive secondary, all
within the same block. Each is a different operator set under
different cryptographic trust assumptions.

**Verdict**: clean.

---

## Part 3 — L2 sequencer health

| Surface | File | Behaviour |
| --- | --- | --- |
| `_sequencerHealthy` (revert-on-fail) | [`OracleFacet.sol#L1956`](../../contracts/src/facets/OracleFacet.sol#L1956) | `latestRoundData()` direct call → reverts on bad data; checks `startedAt > 0` AND `block.timestamp - startedAt ≥ SEQUENCER_GRACE_PERIOD (1h)` |
| `_sequencerHealthy` (try/catch) | [`OracleFacet.sol#L1971`](../../contracts/src/facets/OracleFacet.sol#L1971) | Same logic in `try / catch`; returns `false` instead of reverting — used by `LiquidityStatus` classification (avoids reverting on a non-L2 chain where the feed isn't set) |
| `setSequencerUptimeFeed` | [`OracleAdminFacet.sol`](../../contracts/src/facets/OracleAdminFacet.sol) | `ADMIN_ROLE` + per-chain config; zero address acceptable on L1s |

On L1 (Ethereum mainnet, BNB, Polygon PoS) the feed is unset
(`address(0)`); `_sequencerHealthy` returns `true` (no sequencer
to be unhealthy). On L2s (Base, Arbitrum, Optimism, Polygon
zkEVM) the feed is admin-set to the Chainlink uptime feed.

**Verdict**: clean.

---

## Part 4 — Peer-protocol LTV reads (Aave V3 + Compound V3)

Used by `refreshTierLtvCache` to derive per-tier consensus LTV
caps from external lending protocols. Permissionless invocation
(anyone can pay gas to refresh); cache is the bounded output.

| Peer | Read site | Signer | TTL | Fail-mode | Bound | Blast radius if poisoned |
| --- | --- | --- | --- | --- | --- | --- |
| **Aave V3** | [`LibPeerLTV.readAaveLtv`](../../contracts/src/libraries/LibPeerLTV.sol#L74) | Aave governance | Per-call only; cache TTL 14d hard | `ok = false` (drops from consensus) | `ltv ∈ [1, 9_900]` BPS + `isActive && !isFrozen` + ABI length check + staticcall success | None — single peer can only drop itself out of consensus; ≥ 2 peers per asset + ≥ 2 assets per tier required (`TIER_MIN_PEER_READINGS = 2`, `TIER_MIN_ASSET_READINGS = 2`) |
| **Compound V3** | [`LibPeerLTV.readCometLtv`](../../contracts/src/libraries/LibPeerLTV.sol#L141) | Compound governance | Same | Same | Same + struct's `asset` field must match queried address (defends against malicious peer returning wrong asset's struct) | Same |
| **Morpho** | (deferred to Phase 3.5) | — | — | — | — | — |

**Consensus gate** ([`LibPeerLTV._perAssetMedian`](../../contracts/src/libraries/LibPeerLTV.sol#L284)):
- ≥ `TIER_MIN_PEER_READINGS` (= 2) peers report per asset.
- Spread ≤ `PEER_DIVERGENCE_TOLERANCE_BPS` (= 3000 = 30%).
- Per-tier median taken across ≥ `TIER_MIN_ASSET_READINGS` (= 2)
  reference assets.

**Bound after consensus** ([`OracleFacet.sol#L1252`](../../contracts/src/facets/OracleFacet.sol#L1252)):
- Subtract per-tier haircut (`tierLtvHaircutBps`).
- Bound-check `[floorBps, ceilBps]` from
  `LibVaipakam.tierLtvBoundsBps(tier)` — out-of-band rejects
  emit `TierLtvCacheRefreshRejected` and leave prior cache value
  untouched.

**Stale-cache fallback** ([`LibVaipakam.effectiveTierMaxInitLtvBps`](../../contracts/src/libraries/LibVaipakam.sol#L3710)):
- If `block.timestamp - lastRefreshedAt > TIER_LTV_CACHE_HARD_TTL`
  (= 14 days), the consumer ignores the cache and uses
  `tierLtvLibraryDefaultBps(tier)` (the source-baked conservative
  default).

**Verdict**: clean — multi-layer defence per LTV consumer.
**Finding F-1 (documentation)**: the natspec on
[`OracleFacet.sol#L1201`](../../contracts/src/facets/OracleFacet.sol#L1201)
says "≥ 2 peers agree within **15 BPS**" but the actual constant
`PEER_DIVERGENCE_TOLERANCE_BPS = 3000` is **30%** (= 3000 BPS).
Functionally fine — peers can legitimately differ by ~10-25%
across protocols for the same asset — but the comment is off by
200× and disorients an auditor reading the natspec alone. Fix:
update the natspec to `3000 BPS (= 30%)` to match the constant.

---

## Part 5 — DEX-depth simulation (Uniswap V3 + clones)

`OracleFacet._checkLiquidity` and the depth-tier classifier read
on-chain pool state (`slot0` for sqrtPriceX96, `liquidity()`,
`observe` for TWAP) across three V3 factories (Uni / PancakeSwap
/ Sushi) per fee tier ≤ 0.3%. No external API involved — this is
on-chain → on-chain, but included because the pool state itself
is "external" relative to the protocol's storage.

| Surface | Source | Signer | Bound | Blast radius if poisoned |
| --- | --- | --- | --- | --- |
| `slot0.sqrtPriceX96` | V3 pool | Pool LPs | TWAP-tick guard: `\|spot - twap\| / twap ≤ twapDeviationBps` | Spot manipulation in one block fails the TWAP guard |
| `liquidity()` | V3 pool | Pool LPs | Value-balance check + min-PAD threshold | Empty/fake pool fails value-balance |
| `observe(twapWindow)` | V3 pool | Pool LPs | `twapWindow` ≥ 600s (admin-configurable, bounded) | Requires ≥ 10 min of pool history to be poisoned |
| 3-clone OR-logic | Uni + Pancake + Sushi factories | Independent factory deployers | Pool from ANY of the three clones passes ⇒ asset classified `Liquid` | Attacker would need to spin up a fake "Liquid" pool on all three OR-paths AND survive both the TWAP guard AND the value-balance check |

**Verdict**: clean.

---

## Part 6 — Keeper relay writes (`setKeeperTier`)

The only off-chain → on-chain WRITE in the read-bounded category.
Off-chain `apps/keeper` watches DEX-side slippage signals
(0x / 1inch quotes for size-stepped probes) and submits
`setKeeperTier(asset, tier)` to demote an asset's effective
liquidity tier.

| Property | Value |
| --- | --- |
| Writer | `KEEPER_ROLE` EOA (or HSM-backed signer) |
| Reader | `effectiveTier = min(getLiquidityTier(asset), keeperTier)` at every loan init / Health-Factor recompute |
| Bound on relay | `tier ∈ [1, MAX_LIQUIDITY_TIER (=3)]`; `tier == 0` rejected at setter — see [`ConfigFacet.setKeeperTier#L1310-L1311`](../../contracts/src/facets/ConfigFacet.sol#L1306) |
| Asymmetry | `min(onChain, keeper)` — keeper can only **lower** an asset's effective tier, never raise it above the on-chain ceiling |
| Per-tick cap | Off-chain enforced in [`apps/keeper/src/liquidityConfidence.ts#L85`](../../apps/keeper/src/liquidityConfidence.ts#L85) (hard cap on `setKeeperTier` submissions per tick — prevents a runaway relay) |
| Confidence policy | Promote 1 step only after `LIQ_CONFIDENCE_MIN_CHECKS` accumulated; demote immediately on degradation — see [`apps/keeper/src/liquidityConfidence.ts#L14-L30`](../../apps/keeper/src/liquidityConfidence.ts#L14) |

**Worst case**: a compromised `KEEPER_ROLE` private key, full
freedom to write. The attacker can only DDoS new loans by forcing
every asset to Tier-1 (= the most conservative LTV cap). Existing
loans are unaffected because LTV caps are snapshotted at init.
Recovery: governance rotates the role via
`DEFAULT_ADMIN_ROLE.revokeRole(KEEPER_ROLE, ...)` and
`grantRole(...)`. No fund-loss vector exists from this write.

**Verdict**: clean — the asymmetry is load-bearing and
intentional.

---

## Part 7 — Aggregator quote APIs (0x v2, 1inch v6, Balancer V2 subgraph)

Used to price liquidation swaps before submitting the tx. The
quote returns routing calldata + an expected output amount.

| Endpoint | Caller | What's trusted | What's NOT trusted |
| --- | --- | --- | --- |
| `api.0x.org/swap/allowance-holder/quote` | [`apps/keeper/src/dexDirectQuotes.ts#L118`](../../apps/keeper/src/dexDirectQuotes.ts#L118), [`apps/agent/src/quoteProxy.ts#L64`](../../apps/agent/src/quoteProxy.ts#L64) | Calldata structure (passed verbatim to the V3 router) | Expected output — bounded by `LibSwap.minOutputAmount` on-chain |
| `api.1inch.dev/swap/v6.0/{chainId}/swap` | [`apps/keeper/src/dexDirectQuotes.ts#L171`](../../apps/keeper/src/dexDirectQuotes.ts#L171), [`apps/agent/src/quoteProxy.ts#L94`](../../apps/agent/src/quoteProxy.ts#L94) | Same | Same |
| `api.thegraph.com/subgraphs/.../balancer-v2-*` | [`apps/keeper/src/serverQuotes.ts#L82-L110`](../../apps/keeper/src/serverQuotes.ts#L82) | Pool-list metadata only | Quote — same `minOutputAmount` gate at on-chain consumer |

**On-chain bound** ([`LibSwap.sol#L127`](../../contracts/src/libraries/LibSwap.sol#L127)):
the protocol passes an oracle-derived `minOutputAmount` to the
swap router. If the aggregator returns a route that yields less
than this, the swap reverts. The aggregator can therefore choose
ANY calldata — favouring a particular pool / mev-bundle — but
cannot make the protocol accept a bad output.

**Worst case**: aggregator returns a route that pays an MEV bot;
protocol's payable output still ≥ `minOutputAmount`. No protocol
loss; user pays slightly worse than ideal slippage.

**Verdict**: clean — the aggregator is an UNTRUSTED routing oracle
and the protocol treats it correctly as such.

---

## Part 8 — DeFiLlama TVL + CoinGecko market data (Tier-3 advisory)

Used by the off-chain `liquidityConfidence` relay to decide
whether to PROMOTE an asset to Tier-3. Tier-3 promotion requires
all three signals to agree:
1. DeFiLlama lists the asset on ≥ 1 Aave / Compound / Morpho
   pool with TVL ≥ threshold.
2. CoinGecko reports market cap + 24h volume above thresholds.
3. On-chain DEX-depth slippage probes are healthy.

| Endpoint | Caller | Role | Failure handling |
| --- | --- | --- | --- |
| `yields.llama.fi/pools` | [`apps/keeper/src/liquidityConfidence.ts#L470`](../../apps/keeper/src/liquidityConfidence.ts#L470) | "Battle-tested elsewhere" advisory | If DeFiLlama is down OR returns malformed data, the relay simply doesn't promote — never demotes |
| `api.coingecko.com/api/v3/coins/{platform}/contract/{addr}` | [`apps/keeper/src/liquidityConfidence.ts#L541`](../../apps/keeper/src/liquidityConfidence.ts#L541) | Market-cap + 24h volume threshold | Same — 404 / null / stale ⇒ cache and skip |

**Disable knob**: `LIQ_TIER3_DISABLE_DEFI_LISTING=1` operator-side
flag falls the Tier-3 logic back to 2-of-2 (CoinGecko + on-chain
DEX) — see [`ToDo.md` E.5](../ToDo.md) (closed 2026-05-15) and
[`liquidityConfidence.ts#L397`](../../apps/keeper/src/liquidityConfidence.ts#L397).

**Worst case**: DeFiLlama returns a fake "listed on Aave" record;
CoinGecko returns inflated market cap; relay attempts to promote
to Tier-3. The on-chain `setKeeperTier(asset, 3)` write still
passes through `effectiveTier = min(getLiquidityTier(asset),
keeperTier)`, so if the on-chain depth probe (Part 5) hasn't ALSO
classified the asset as Tier-3, the effective tier stays capped at
the on-chain value. **The two-oracle defence is load-bearing**:
poisoning the off-chain advisory alone changes nothing.

**Verdict**: clean — `min(onChain, keeper)` rule subsumes any
poisoning of the off-chain heuristic.

---

## Part 9 — Other external reads (frontend + indexer)

| Surface | Source | Trust model | On-chain effect |
| --- | --- | --- | --- |
| `apps/defi/src/lib/coingecko.ts` | CoinGecko (display only) | UNTRUSTED — used for off-chain UI hint | None — the UI never writes to chain based on this |
| `apps/defi/src/hooks/useTxSimulation.ts` | Blockaid Simulate (display only) | UNTRUSTED — advisory chip on review surfaces | None |
| `apps/defi/src/lib/swapQuoteService.ts` | 0x / 1inch quote service (display only) | UNTRUSTED | None — same `minOutputAmount` bound applies if user submits |
| `apps/defi/src/lib/indexerClient.ts` | Internal indexer Worker | UNTRUSTED at frontend layer (indexer signs nothing) | None — UI only |
| `apps/indexer/*` reads | RPC `eth_getLogs` from chain canonical events | TRUSTED — protocol-signed events | Indexer never writes to chain |
| `apps/agent/src/scanProxy.ts` | Block explorer scan APIs | UNTRUSTED | None — CORS proxy only |
| `apps/agent/src/telegram.ts` | Telegram Bot API | UNTRUSTED | None — outbound notification only |

**Verdict**: clean — every frontend / indexer / agent external
read is display- or notification-only; none has a chain-write
side effect.

---

## Gap list (ranked by blast radius)

| # | Severity | Finding | Fix scope | Owner |
| --- | --- | --- | --- | --- |
| F-1 | **Doc** | Stale natspec in `OracleFacet.sol#L1201` — says "15 BPS" but constant is `3000 BPS` (= 30%). Misleading for an auditor reading the comment alone. | 1-line natspec edit. | One small PR. |
| F-2 | **Hardening** | `refreshTierLtvCache` re-invokes `LibPeerLTV.aggregateTierLtv` twice per tier to recover the `assetsContrib` count for the event. The `(ok, median, n)` return tuple is already in the library — caller just discards `n` once. Wasted ~50% of an already-700k-1.5M-gas function. | Refactor: keep `n` from the first call; emit the event with the captured value. | One small PR. |
| F-3 | **Hardening** | `setKeeperTier` does not emit which `keeperTier` value was *previously* recorded. An auditor walking on-chain history can't reconstruct the demote / promote sequence from events alone — has to replay storage reads. | Add `oldTier` to the `KeeperTierSet` event. | One small PR. |

**No critical or high findings.** The defence-in-depth pattern
(primary + secondary + cross-check + plausibility bound + stale
fallback to library default) holds at every external-read site.

---

## What's intentionally NOT in scope

- **VPFI fee discount accumulator drift** — covered separately
  by `feedback_doc_convention.md` and the Phase-5 settlement
  tests; not an off-chain data read.
- **Cross-chain LZ message integrity** — covered by the DVN
  policy (3 required + 2 optional, threshold 1-of-2) in
  `CLAUDE.md` "Cross-Chain Security Policy". LZ payloads are
  not "off-chain" reads in the sense this audit covers — they
  arrive as authenticated inbound messages.
- **Sanctions oracle (Chainalysis)** — already audited in the
  retail-policy section of `CLAUDE.md` and covered by
  `SanctionsOracleTest.t.sol`. Setup: oracle MUST be set post-
  deploy via `ProfileFacet.setSanctionsOracle`; while unset,
  `isSanctionedAddress` fail-opens (intentional during deploy
  window). Already documented as an operator gate, not a code
  audit finding.

---

## Recommendations summary

| Action | Track on | Sizing |
| --- | --- | --- |
| Fix the F-1 natspec | `@vaipakam-labs` → new card "fix natspec PEER_DIVERGENCE_TOLERANCE_BPS comment" | XS, ~10 minutes |
| Fold F-2 `assetsContrib` reuse | `@vaipakam-labs` → new card "refactor refreshTierLtvCache to drop duplicate aggregateTierLtv call" | S, ~30 minutes; touches one function |
| Add `oldTier` to `KeeperTierSet` event | `@vaipakam-labs` → new card "include oldTier in KeeperTierSet event" | XS, ~15 minutes |

All three fit as **`chore` / `refactor`** label per
[`.github/LABELS.md`](../../.github/LABELS.md); none requires an
audit cycle. Mark each as `audit` overlay so the addendum gets
re-stamped when the auditor reviews the package.

---

## Cross-references

- [`docs/internal/ConfigKnobBoundsAudit-2026-05-14.md`](ConfigKnobBoundsAudit-2026-05-14.md)
- [`docs/internal/WethChainSafetyAudit-2026-05-14.md`](WethChainSafetyAudit-2026-05-14.md)
- [`docs/DesignsAndPlans/InternalLiquidationLedger.md`](../DesignsAndPlans/InternalLiquidationLedger.md) §0.0
- [`docs/DesignsAndPlans/AutonomousLtvAndOracleFallback.md`](../DesignsAndPlans/AutonomousLtvAndOracleFallback.md) (LibPeerLTV design)
- [`docs/ops/IncidentRunbook.md`](../ops/IncidentRunbook.md) §3
  (oracle / sequencer / aggregator response procedures)
- [`CLAUDE.md`](../../CLAUDE.md) — Cross-Chain Security Policy
  section (LZ DVN policy, out of this audit's scope)
- [`@vaipakam-labs` Issue #1](https://github.com/vaipakam/vaipakam/issues/1) — live tracker for this audit + the F-1 / F-2 / F-3 follow-up cards
