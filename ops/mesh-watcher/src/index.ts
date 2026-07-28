/**
 * `vaipakam-mesh-watcher` — VPFI recycling mesh invariant watcher.
 *
 * #1222 M3 B4-c. Reads the per-chain recycled ledger on every reward
 * chain and alerts when an accounting identity that cannot legitimately
 * break has broken. See README.md for the full check list and the
 * critical-vs-advisory split.
 *
 * Internal ops surface: ops Telegram bot, own D1, no user-facing output.
 */

import type { Env } from './env';
import { runTick } from './runner';

export default {
  /** Cron entry point. */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runTick(env).then((summary) => {
        console.log(`mesh-watcher tick: ${JSON.stringify(summary)}`);
      }),
    );
  },

  /**
   * Manual trigger + health probe.
   *
   * `GET /` returns the last tick's shape without running one; `POST /run`
   * (or `GET /run`) executes a tick synchronously and returns its summary,
   * which is how an operator verifies configuration after a deploy without
   * waiting for the cron.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      const summary = await runTick(env);
      return Response.json(summary, { status: summary.error ? 500 : 200 });
    }

    return Response.json({
      worker: 'vaipakam-mesh-watcher',
      purpose: 'VPFI recycling mesh ledger invariants (#1222 M3 B4-c)',
      endpoints: { run: 'GET /run — execute one tick and return its summary' },
    });
  },
} satisfies ExportedHandler<Env>;
