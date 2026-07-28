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

import { isAuthorized } from './auth';
import { statusFor } from './health';
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
   * `POST /run` executes a tick synchronously and returns its summary —
   * how an operator verifies configuration after a deploy without waiting
   * for the cron. `GET /` is an unauthenticated identity banner and
   * nothing more.
   *
   * **`/run` is authenticated and fail-closed** (Codex #1443 r1). A
   * `workers.dev` URL is public, and a tick is not a read-only probe: it
   * performs the whole RPC fan-out, advances the D1 streak counters, and
   * sends Telegram. An unauthenticated caller could drain the dedicated
   * RPC quota, or fire six rapid requests while ordinary commitments were
   * outstanding to manufacture a `stuck-settlement` advisory that is
   * supposed to represent an hour and a half of cron observations —
   * forging the very evidence the operator acts on. So a missing or
   * mismatched token is rejected, and a MISSING `WATCHER_RUN_TOKEN`
   * closes the endpoint rather than opening it.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      if (request.method !== 'POST') {
        return Response.json(
          { error: 'method not allowed — use POST /run' },
          { status: 405, headers: { allow: 'POST' } },
        );
      }
      if (!isAuthorized(request, env)) {
        return Response.json(
          { error: 'unauthorized' },
          { status: 401, headers: { 'www-authenticate': 'Bearer' } },
        );
      }
      // Probe delivery on the manual path: this is the documented
      // post-deploy verification, and certifying a pager without ever
      // exercising it is how a silent pager ships.
      const summary = await runTick(env, {
        probeDelivery: true,
        // Read the windowed state, never advance it: those windows are
        // denominated in CRON observations.
        persistState: false,
      });
      // Derived from health, never restated — see `health.ts`.
      return Response.json(summary, {
        status: statusFor(
          { ok: summary.ok, failing: summary.unhealthyBecause },
          summary.error !== undefined,
        ),
      });
    }

    return Response.json({
      worker: 'vaipakam-mesh-watcher',
      purpose: 'VPFI recycling mesh ledger invariants (#1222 M3 B4-c)',
      endpoints: {
        run: 'POST /run — execute one tick and return its summary (requires Authorization: Bearer <WATCHER_RUN_TOKEN>)',
      },
    });
  },
} satisfies ExportedHandler<Env>;
