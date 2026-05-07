/**
 * @vaipakam/keeper — autonomous Cloudflare Worker.
 *
 * STUB. The actual HF watcher loop, autonomous liquidator,
 * buy-watchdog, periodic-interest pre-notify, push + telegram
 * alert delivery live in `ops/hf-watcher/src/` today and
 * migrate in here as part of Stage 3 of the source-tree
 * decomposition. Until that population happens, this Worker
 * returns 503 to every request and ships zero cron triggers
 * so any accidental deploy is visibly inert.
 */

interface KeeperEnv {
  // Real bindings (signing key, swap-aggregator API keys, RPC
  // URLs, push channel keys, telegram bot token) plumb in here
  // as the Stage 3 population PRs land. Kept blank in the stub
  // so the dependency surface is obvious as it grows.
  readonly DEPLOYMENT_STATE?: string;
}

export default {
  async fetch(_req: Request, _env: KeeperEnv): Promise<Response> {
    return new Response(
      JSON.stringify({
        worker: 'vaipakam-keeper',
        status: 'stub',
        message:
          'Stage 3 of the source-tree refactor will populate this Worker from ops/hf-watcher/src/{keeper,watcher,buyWatchdog,serverQuotes,periodicPreNotify,push,telegram}.ts. Until then this endpoint is a deliberate placeholder.',
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    );
  },
};
