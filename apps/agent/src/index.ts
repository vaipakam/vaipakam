/**
 * @vaipakam/agent — read/index Cloudflare Worker.
 *
 * STUB. The actual route surface (offer reads, loan reads,
 * frames, scan/quote proxies) lives in `ops/hf-watcher/src/`
 * today and migrates in here as part of Stage 3 of the
 * source-tree decomposition. Until that population happens,
 * this Worker returns 503 to every request so any accidental
 * deploy is visibly inert rather than silently empty.
 */

interface AgentEnv {
  // Real bindings (D1, RPC URLs, frontend origin) plumb in here as
  // the population PRs land. Kept blank in the stub to make the
  // intent obvious — a Stage 3 PR is what populates this surface.
  readonly DEPLOYMENT_STATE?: string;
}

export default {
  async fetch(_req: Request, _env: AgentEnv): Promise<Response> {
    return new Response(
      JSON.stringify({
        worker: 'vaipakam-agent',
        status: 'stub',
        message:
          'Stage 3 of the source-tree refactor will populate this Worker from ops/hf-watcher/. Until then this endpoint is a deliberate placeholder. See docs/DesignsAndPlans/CloudflareStagingDeployPlan.md for the full layout.',
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    );
  },
};
