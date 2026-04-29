/**
 * Cloudflare Worker entry — single entry point. The cron in
 * `wrangler.jsonc` fires every 5 minutes; nothing else is exposed
 * (no fetch handler, no public HTTP surface). This Worker is
 * internal-only — its single job is detection + alert.
 */

import type { Env } from './env';
import { runLzWatcher } from './runner';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runLzWatcher(env));
  },
};
