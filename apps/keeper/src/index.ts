/**
 * apps/keeper Worker entry — Vaipakam's first-party autonomous
 * keeper.
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

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Wrap in catch so a transient RPC / D1 hiccup on one chain
    // can't wedge the next tick. Each chain inside `runWatcher`
    // already has its own try/catch boundary; this outer guard is
    // a final safety net.
    ctx.waitUntil(
      runWatcher(env).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[keeper] runWatcher pass failed:', err);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
