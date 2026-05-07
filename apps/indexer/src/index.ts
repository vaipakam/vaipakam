/**
 * @vaipakam/indexer — chain → archive D1 ingester Worker.
 *
 * STUB. The actual chainIndexer + db access + daily oracle
 * snapshot live in `ops/hf-watcher/src/` today and migrate in
 * here as part of Stage 3 of the source-tree decomposition.
 * Until that population happens, this Worker returns 503 to
 * every request and ships zero cron triggers so any accidental
 * deploy is visibly inert.
 */

interface IndexerEnv {
  // Real bindings (D1 write, per-chain RPC URLs, last-cursor
  // state) plumb in here as the Stage 3 population PRs land.
  readonly DEPLOYMENT_STATE?: string;
}

export default {
  async fetch(_req: Request, _env: IndexerEnv): Promise<Response> {
    return new Response(
      JSON.stringify({
        worker: 'vaipakam-indexer',
        status: 'stub',
        message:
          'Stage 3 of the source-tree refactor will populate this Worker from ops/hf-watcher/src/chainIndexer.ts + db.ts + dailyOracleSnapshot.ts. Until then this endpoint is a deliberate placeholder.',
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    );
  },
};
