/**
 * apps/keeper Worker entry — Vaipakam's first-party autonomous
 * keeper. The single Worker that holds `KEEPER_PRIVATE_KEY` (and
 * therefore the only Worker that signs on-chain transactions) per
 * the staging plan's least-privilege contract
 * (`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md` §2):
 * "A buggy agent produces stale data; a buggy keeper loses funds."
 *
 * Cron-driven only (`scheduled()` handler — NO `fetch()`). Each
 * tick:
 *
 *   1. `runWatcher(env)` walks every chain with an RPC + Diamond
 *      configured, iterates each subscribed user's active loans,
 *      compares the on-chain HF to the user's per-loan thresholds
 *      (D1 `thresholds` table), and dispatches Telegram + Push alerts
 *      on band downgrades (watcher.ts). Notification surface only —
 *      autonomous liquidation moved to `runLiquidator` (item 5)
 *      so the keeper catches loans whose owners haven't subscribed
 *      to notifications too.
 *
 *   2. `runDailyOracleSnapshot(env)` (moved from agent in the
 *      Stage 3 architectural-rebalance commit) — once per UTC
 *      day per chain calls `OracleFacet.captureDailyPriceSnapshot`
 *      so the historical-TVL chart can be reconstructed from
 *      current-state reads alone. The pass internally pre-checks
 *      the 00:00–00:09 UTC window + a D1 last-day guard, so most
 *      ticks exit immediately. Co-located here because it's the
 *      second `KEEPER_PRIVATE_KEY` consumer — putting it on the
 *      keeper means the signing key lives on exactly one Worker.
 *
 *   3. `runMatcher(env)` — Range Orders Phase 1 offer matcher
 *      (matcher.ts). Per chain: scan the order book, evaluate
 *      (lender × borrower) pairs via the on-chain `previewMatch`
 *      view, and submit `matchOffers(lenderId, borrowerId)` for
 *      every pair the preview accepts — earning the 1% LIF matcher
 *      kickback. Gated by the same `KEEPER_ENABLED == 'true'` +
 *      `KEEPER_PRIVATE_KEY` set as the liquidator (it's the third
 *      consumer of the signing key — keeping it here means the key
 *      lives on exactly one Worker). Reverts when the
 *      `partialFillEnabled` master flag is off are no-ops; the
 *      matcher keeps polling until governance flips it. Discovery is
 *      on-chain for now (count + paginate + `getOffer`); a future
 *      optimisation could read candidate pairs from the indexer's
 *      `offers` table via the shared D1 binding.
 *
 *   4. `runLiquidityConfidence(env)` — depth-tiered-LTV liquidity-
 *      confidence relay (liquidityConfidence.ts; §4.4 step 5 of
 *      docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md). Per
 *      chain: for each ERC-20 collateral asset in an active loan, ask
 *      the 0x / 1inch aggregators what a liquidator would net for a sell
 *      of each tier size, derive the aggregator-confirmed tier (best
 *      route over the on-chain PAA list, ≤ `liquiditySlippageBps`), and
 *      walk a D1-backed confidence counter — promote the on-chain
 *      `keeperTier(asset)` one step only after `LIQ_CONFIDENCE_MIN_CHECKS`
 *      consecutive eligible ticks spanning ≥ `LIQ_CONFIDENCE_MIN_WINDOW_DAYS`
 *      days; demote immediately on degradation; never above the on-chain
 *      ceiling. Tier-3 promotion additionally needs the "battle-tested
 *      elsewhere" (Aave/Compound/Morpho) advisory — stubbed for v1, so
 *      the relay caps at Tier 2 until it's wired. Fourth consumer of the
 *      signing key (`isKeeperEnabled`); also gated on `depthTieredLtvEnabled`
 *      for the *submit* — the counter is tracked in D1 regardless so the
 *      catch-up after the switch flips is fast.
 *
 *   5. `runLiquidator(env)` — autonomous-liquidation pass
 *      (liquidator.ts). Per chain: enumerate **every** active loan via
 *      `getActiveLoansPaginated`, batch-read
 *      `RiskFacet.calculateHealthFactor` via Multicall3 (one RPC
 *      roundtrip per ~100 loans instead of N sequential eth_calls —
 *      the speed half of the higher-LTV liquidator hardening), filter
 *      to `hf < 1e18`, sort ascending so the most-at-risk loans go
 *      first when the per-tick submit cap is hit, and submit
 *      `triggerLiquidation` via `maybeAutonomousLiquidate`. Same
 *      `isKeeperEnabled` gate as the matcher / liquidity-confidence
 *      relay. Pre-split this lived inside `runWatcher`, scoped to
 *      subscribed-user loans only — many loans never got an
 *      autonomous attempt and relied on third-party MEV bots; the
 *      split closes that coverage gap (the *coverage* half of the
 *      higher-LTV hardening).
 *
 * NO HTTP routes. The connected app's read-API surface
 * (`/loans/*`, `/offers/*`), the operator services
 * (`/quote/0x`, `/quote/1inch`, `/scan/blockaid`), the Telegram
 * webhook (`/tg/webhook`), the Farcaster Frame
 * (`/frames/active-loans`) and the diagnostics record endpoint
 * (`/diag/record`) all live on `apps/{indexer,agent}`. The keeper
 * is intentionally cron-only so it has no public attack surface.
 *
 * T-078 — `scheduled()` calls `resolveEnv()` first. The secrets
 * (RPC_*, the Telegram bot token, the Push signer, the aggregator
 * API keys and `KEEPER_PRIVATE_KEY`) are Cloudflare Secrets Store
 * bindings read asynchronously; `resolveEnv` fetches them once, at
 * this boundary, and hands all five passes the plain resolved `Env`.
 */

import { resolveEnv, type WorkerEnv } from './env';
import { runWatcher } from './watcher';
import { runDailyOracleSnapshot } from './dailyOracleSnapshot';
import { runMatcher } from './matcher';
import { runLiquidityConfidence } from './liquidityConfidence';
import { runLiquidator } from './liquidator';
import { runAutoLifecycle } from './autoLifecycle';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    // T-078 — resolve the Secrets Store bindings once, here at the
    // entry point; all five passes get the plain resolved env.
    const resolved = await resolveEnv(env);
    // Each pass wrapped so a transient RPC / D1 hiccup on one
    // can't wedge the next. Each pass also has its own per-chain
    // try/catch boundary inside; these outer guards are a final
    // safety net.
    ctx.waitUntil(
      runWatcher(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[keeper] runWatcher pass failed:', err);
      }),
    );
    ctx.waitUntil(
      runDailyOracleSnapshot(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[keeper] runDailyOracleSnapshot pass failed:', err);
      }),
    );
    ctx.waitUntil(
      runMatcher(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[keeper] runMatcher pass failed:', err);
      }),
    );
    ctx.waitUntil(
      runLiquidityConfidence(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[keeper] runLiquidityConfidence pass failed:', err);
      }),
    );
    ctx.waitUntil(
      runLiquidator(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[keeper] runLiquidator pass failed:', err);
      }),
    );
    // T-092 #512 — auto-extend pass. Discovers loans with both-
    // side `autoExtendCaps.enabled` and submits `extendLoanInPlace`
    // within the consent intersection. Skipped chain-by-chain when
    // `AdminFacet.getAutoExtendEnabled()` is false. Auto-refinance
    // composition with the matcher is a follow-up.
    ctx.waitUntil(
      runAutoLifecycle(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[keeper] runAutoLifecycle pass failed:', err);
      }),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
