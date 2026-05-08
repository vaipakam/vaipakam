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
 *      configured, iterates each user's active loans, and:
 *        a. Compares the on-chain HF to the user's per-loan
 *           thresholds (D1 `thresholds` table) and dispatches
 *           Telegram + Push alerts on band downgrades (watcher.ts).
 *        b. Submits `triggerLiquidation(loanId, calls)` on-chain
 *           when HF crosses 1.0 — gated by `KEEPER_ENABLED == 'true'`
 *           AND `KEEPER_PRIVATE_KEY` set (keeper.ts +
 *           serverQuotes.ts).
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
 * Future scope (see Stage 3 plan §7): the off-chain offer matcher
 * for the Phase 1 Range Orders + Lender Partial Fills + Bot
 * Matching system lands here as a sibling cron pass. The matcher
 * will share the keeper's D1 binding (cross-Worker read of the
 * indexer's `offers` table) and submit `matchOffers(lenderId,
 * borrowerId)` to earn the 1% LIF matcher fee.
 *
 * NO HTTP routes. The connected app's read-API surface
 * (`/loans/*`, `/offers/*`), the operator services
 * (`/quote/0x`, `/quote/1inch`, `/scan/blockaid`), the Telegram
 * webhook (`/tg/webhook`), the Farcaster Frame
 * (`/frames/active-loans`) and the diagnostics record endpoint
 * (`/diag/record`) all live on `apps/{indexer,agent}`. The keeper
 * is intentionally cron-only so it has no public attack surface.
 */

import type { Env } from './env';
import { runWatcher } from './watcher';
import { runDailyOracleSnapshot } from './dailyOracleSnapshot';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Each pass wrapped so a transient RPC / D1 hiccup on one
    // can't wedge the next. Each pass also has its own per-chain
    // try/catch boundary inside; these outer guards are a final
    // safety net.
    ctx.waitUntil(
      runWatcher(env).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[keeper] runWatcher pass failed:', err);
      }),
    );
    ctx.waitUntil(
      runDailyOracleSnapshot(env).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[keeper] runDailyOracleSnapshot pass failed:', err);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
