# Research findings — #392: Oracle / multi-source pricing discipline

**Card:** #392 (master sweep #401, Cluster C). **Status:** findings + verdict.
**Verdict:** **ALREADY SATISFIED — close as implemented.** The card's core ask (a deviation-
bounded multi-source price guard + robust staleness/sequencer discipline in front of liquidation
reads) is **already shipped** (Phase 7b). One optional, low-priority refinement noted in §4.

> External comparison systems referenced by generic descriptor per the sweep rule; our own
> integrated oracle dependencies are named because they describe shipped code.

---

## 1. The card's concern

HF math + liquidations depend on a price source being live, fresh, and manipulation-resistant.
The card asks: should we add a deviation-bounded multi-source guard + better staleness/fallback
before a liquidation fires, instead of trusting a single feed?

## 2. What we ALREADY have (verified 2026-06-16 — the card predates this hardening)

The pricing path is far more defended than the card's "single feed + AMM depth" framing:

- **Secondary multi-source quorum (Soft 2-of-N).** `OracleFacet._enforceSecondaryQuorum`
  (≈:437, logic ≈:807) cross-validates the primary (Chainlink) against **three** independent
  secondaries — Tellor (≈:842), API3 (≈:887), DIA (≈:937) — classifying each Unavailable /
  Agree / Disagree via `_classifyDeviation` against `secondaryOracleMaxDeviationBps`. Soft
  fallback: primary-only when all secondaries are unavailable; accept on ≥1 agreement; revert
  `OraclePriceDivergence` only when all responding secondaries disagree. (Phase 7b.2.)
- **Deviation-bounded cross-check.** Exactly the "compare primary against a second source with a
  max-deviation cap" guard the card asks for — implemented as the quorum's
  `secondaryOracleMaxDeviationBps` classification (and a `pythCrossCheckMaxDeviationBps` path).
- **L2 sequencer-uptime circuit breaker + grace period.** `OracleFacet._sequencerHealthy` /
  `_requireSequencerHealthy` (errors `SequencerDown` ≈:90, `SequencerGracePeriod` ≈:93;
  `SEQUENCER_GRACE_PERIOD` constant). **Liquidation paths consult it and fail closed**:
  `RiskFacet` blocks HF-liquidation when the sequencer is unhealthy (≈:516) and `DefaultedFacet`
  reverts `SequencerUnhealthy` (≈:254). This is the mandatory L2 guard the external research
  flags — **we have it.**
- **Tiered staleness gates** (2h / 25h) on the primary feed + a configurable secondary-oracle
  staleness ceiling.
- **Liquidity classification** via slippage-at-floor routing over every configured V3-clone
  factory (`_passesFloorSlippage` ≈:166) with the ~$1M `MIN_LIQUIDITY_PAD` floor; **fail-closed
  to Illiquid** on any registry/feed/pool failure (`checkLiquidity` ≈:132). (Phase 7b.1.)

## 3. External patterns researched (generic) — and why we already align

- A **high-throughput on-chain order-book venue** prices liquidations from a **stake-weighted
  median of validator-signed prices** (a quorum oracle). **AVOID building this** — it needs our
  own validator set; our 3-secondary quorum achieves the manipulation-resistance goal without
  one. (External research's own conclusion: use a second source as a *guard*, not build a
  validator oracle.)
- The **deviation circuit-breaker** pattern (primary vs. a TWAP/secondary, block liquidation on
  divergence past a cap) — **we already implement** via the secondary quorum + deviation
  classification. The mandatory staleness + L2-sequencer + grace guards — **all present.**

## 4. Verdict + the one optional refinement

**Verdict: ALREADY SATISFIED.** The card's adopt-target (deviation-bounded multi-source guard +
staleness + L2-sequencer discipline + fail-closed fallback) is shipped and wired into both
liquidation paths. Recommend **closing #392 as implemented**, with a pointer to Phase 7b.

**Optional, low-priority refinement (NOT required):** the current cross-check compares Chainlink
against *price-feed* secondaries (Tellor/API3/DIA). It does **not** add a distinct
**concentrated-liquidity-AMM-implied TWAP** as a fourth deviation source. Given the existing
3-source quorum already cross-validates, the marginal manipulation-resistance of adding an
AMM-TWAP deviation source is small and brings its own manipulation surface (short-window TWAP
front-running). Recommend **skip unless** a future incident shows the price-feed secondaries
correlate (shared upstream). If pursued, it slots in as another `_classifyDeviation` source, not
a new mechanism.

## 5. Spin-off implementation issues

**None required** (card already satisfied). If the optional AMM-TWAP deviation source is ever
wanted, it is one additional secondary in `_enforceSecondaryQuorum` — a small, contained add.

## 6. Sources

Our shipped `OracleFacet` (Phase 7b.1/7b.2) + the external validator-quorum venue and the
deviation-circuit-breaker lending precedents (generic; URLs in working notes).
