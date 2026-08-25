/**
 * apps/keeper Worker entry — Vaipakam's first-party autonomous
 * keeper. The single Worker that holds `KEEPER_PRIVATE_KEY` (and
 * therefore the only Worker that signs on-chain transactions) per
 * the staging plan's signing-key placement
 * (`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md` §2).
 *
 * That section used to be quoted here as "A buggy agent produces stale
 * data; a buggy keeper loses funds." **That contract is withdrawn** —
 * the agent deletes records, notifies real users and publishes
 * listings, and both non-signing Workers share this Worker's
 * database-scoped D1 binding, so they can corrupt state this Worker
 * acts on (#1722). What remains true is narrower and is the reason
 * this file is special: the on-chain key lives here and nowhere else.
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
 * (`/quote/0x`, `/quote/1inch` — #1651: a `/scan/blockaid` proxy
 * was listed here too; ET-001 dropped it, see `apps/agent/src/index.ts`),
 * the Telegram
 * webhook (`/tg/webhook`), the Farcaster Frame
 * (`/frames/active-loans`) and the diagnostics record endpoint
 * (`/diag/record`) all live on `apps/{indexer,agent}`. The keeper
 * is intentionally cron-only so it has no public attack surface.
 *
 * T-078 — `scheduled()` calls `resolveEnv()` first. The secrets
 * (RPC_*, the Telegram bot token, the Push signer, the aggregator
 * API keys and `KEEPER_PRIVATE_KEY`) are Cloudflare Secrets Store
 * bindings read asynchronously; `resolveEnv` fetches them once, at
 * this boundary, and hands every scheduled pass the plain resolved `Env`. (This said "all five passes"; ten are scheduled below.)
 */

import { getChainConfigs, resolveEnv, type WorkerEnv } from './env';
import { KEEPER_PASSES, cadenceSkipReason } from './passSchedule';

/**
 * Run one pass and report what it cost.
 *
 * The card's acceptance asks for per-pass CPU **attribution** rather
 * than a guess about which pass is expensive, and asks that the numbers
 * be recorded so nobody re-derives them. One line per pass per run is
 * what makes that a read of `wrangler tail` instead of an
 * investigation.
 *
 * This measures WALL time, and the distinction matters for how the
 * numbers are read: a Worker's limit is CPU time, which excludes
 * waiting on I/O, so a pass that spends its time on RPC round-trips
 * will look expensive here and cost little against the limit. Wall time
 * is still the right thing to log — it is available without a profiler,
 * it bounds CPU from above, and a pass that is cheap here cannot be the
 * one blowing the budget. Read it to EXCLUDE suspects; use the
 * dashboard's per-invocation CPU to confirm the culprit.
 */
async function timedPass(name: string, run: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await run();
    // eslint-disable-next-line no-console
    console.log(`[keeper] ${name} done in ${Date.now() - startedAt}ms`);
  } catch (err) {
    // Still reports its cost: a pass that fails slowly is a finding,
    // and the old code logged the error without any notion of how long
    // it had been running first.
    // eslint-disable-next-line no-console
    console.error(
      `[keeper] ${name} pass failed after ${Date.now() - startedAt}ms:`,
      err,
    );
  }
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    // T-078 — resolve the Secrets Store bindings once, here at the
    // entry point; every scheduled pass gets the plain resolved env.
    const resolved = await resolveEnv(env);

    // #1896 — name the RESOLVED chain set, once per tick.
    //
    // A chain drops out silently: `readSecret` collapses an absent binding or
    // a failing Secrets Store fetch to `undefined` (deliberately — see its
    // comment), and `getChainConfigs` then skips any chain with no RPC. The
    // passes log per-chain, so a dropped chain produces NO line at all, and
    // absence is not something an operator can read off a tail.
    //
    // That matters most for the CPU validation this Worker is unscheduled
    // for: a tick can end `ok` purely because it ran against fewer chains
    // than production will once the binding recovers, and the work scales
    // with the chain set. This line turns that into a positive assertion to
    // check against the expected deployments (Codex #1924 r13).
    const chains = getChainConfigs(resolved);
    // eslint-disable-next-line no-console
    console.log(
      `[keeper] chains resolved: ${chains.length} — ${
        chains.map((c) => `${c.name}(${c.id})`).join(', ') || 'NONE'
      }`,
    );

    // ONE loop over the declared table (#1896), rather than ten
    // hand-written blocks. Each pass still gets its own `waitUntil` and
    // its own `.catch`, so a transient failure in one cannot wedge the
    // next — that property is now structural instead of being repeated
    // ten times and relied upon to stay repeated.
    //
    // `controller.scheduledTime` is the tick's SCHEDULED epoch, not the
    // moment it ran, so a late delivery cannot make a `% n` cadence
    // skip its minute. It was previously ignored entirely (`_controller`).
    const scheduledTimeMs: number | undefined = controller?.scheduledTime;

    for (const pass of KEEPER_PASSES) {
      const skip = cadenceSkipReason(pass, scheduledTimeMs);
      if (skip !== null) {
        // Legible, not silent — the contract `passIsArmed` established
        // for arming (#1475), extended to cadence. A pass that is idle
        // because it is not due and a pass that is idle because it is
        // wedged must never look the same in `wrangler tail`.
        // eslint-disable-next-line no-console
        console.log(`[keeper] ${pass.name} skipped: ${skip}`);
        continue;
      }
      ctx.waitUntil(timedPass(pass.name, () => pass.run(resolved)));
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
