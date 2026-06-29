/**
 * apps/indexer Worker entry — chain → D1 sync + read-API for the
 * connected app's "indexer-first, chain-fallback" data path.
 *
 * Two entry points:
 *
 *   `scheduled()` — cron tick. Runs:
 *     - `runChainIndexer(env)`        — pulls the latest events for
 *                                       Offer / Loan / VPFI / NFT
 *                                       lifecycle into D1 round-robin
 *                                       per chain.
 *     - `pruneOldCancelledOffers(env)` — drops rows past the
 *                                       `CANCELLED_OFFER_RETENTION_DAYS`
 *                                       window (cheap DELETE gated by
 *                                       the partial index over
 *                                       cancelled rows).
 *
 *   `fetch()` — public read-API (T-041). All routes are open-CORS;
 *     the connected app reads them indexer-first and falls back to
 *     direct chain reads on stale / failure. No FRONTEND_ORIGIN gate
 *     — the data is public on-chain anyway.
 *
 *       GET  /offers/stats        GET  /loans/active
 *       GET  /offers/active       GET  /loans/recent
 *       GET  /offers/recent       GET  /loans/stats
 *       GET  /offers/:offerId     GET  /loans/timeseries
 *       GET  /offers/by-creator/:address     GET /loans/:loanId
 *       GET  /loans/by-lender/:address   GET /loans/by-borrower/:address
 *       GET  /activity            GET  /claimables/:address
 *
 * T-078 — both entry points call `resolveEnv()` first. `RPC_*` are
 * now Cloudflare Secrets Store bindings (read asynchronously);
 * `resolveEnv` fetches them once, at this boundary, and hands every
 * downstream function the plain resolved `Env` — so the rest of the
 * Worker stays synchronous. See `env.ts` + `SecretsStoreMigration.md`.
 *
 * NO Telegram webhook, NO Frames, NO quote / scan proxies — those
 * live on apps/agent. NO HF watcher / liquidation — that's apps/keeper.
 * The indexer is operator-key-free.
 *
 * **Almost read-only.** As of #335 the Worker accepts ONE write
 * surface — `POST /loans/:loanId/prepay-listing/match-source` —
 * for best-effort analytics breadcrumbs from the dapp. That
 * single endpoint is rate-limited per-IP via the
 * `OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT` binding (matching the
 * defensive posture apps/agent's POST proxies use) and stores
 * non-financial metadata only (no signing keys, no on-chain
 * state writes). The rest of the surface stays public-read.
 */

import {
  resolveEnv,
  readSecret,
  getChainConfigs,
  type WorkerEnv,
} from './env';
import { runChainIndexer, sweepUnpublishedListings } from './chainIndexer';
import {
  pruneOldCancelledOffers,
  pruneOldWebhookDeliveries,
} from './cancelledOfferRetention';
import {
  readCappedBody,
  verifyAlchemySignature,
  parseChainEventPayload,
  sha256Hex,
  WebhookBodyTooLargeError,
} from './webhookAuth';

// #757 — the per-chain ingest Durable Object. Re-exported from the Worker
// entry so `wrangler.jsonc`'s `durable_objects` binding can resolve the class.
export { ChainIngestDO } from './chainIngestDO';

/**
 * #757 — is the DO ingest path active? Gated on BOTH the DO binding being
 * present AND the `CHAIN_INGEST_VIA_DO` rollout flag, so deploying the new DO
 * doesn't re-route ingest until the operator flips it. The cron and the webhook
 * route consult the SAME gate so they're always consistent (a half-enabled
 * state — webhook→DO while the cron still scans inline — would mean two writers).
 */
function doIngestEnabled(env: WorkerEnv): boolean {
  return env.CHAIN_INGEST_VIA_DO === 'true' && !!env.CHAIN_INGEST_DO;
}
import {
  handleOffersStats,
  handleOffersActive,
  handleOffersRecent,
  handleOfferById,
  handleOffersByCreator,
  handleOffersByCurrentHolder,
  handleOffersPreflight,
} from './offerRoutes';
import {
  handleLoansActive,
  handleLoansRecent,
  handleLoansStats,
  handleLoansTimeseries,
  handleLoanById,
  handleLoansByParticipant,
  handleLoansByCurrentHolder,
  handleActivity,
  handleClaimables,
  handleLoansPreflight,
  handleLoanPrepayMatchSource,
} from './loanRoutes';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    // T-078 — resolve the Secrets Store RPC bindings once, here at
    // the entry point; both passes get the plain resolved env.
    const resolved = await resolveEnv(env);
    // #757 — chain ingest. When the per-chain ingest Durable Object is bound,
    // the cron PINGS each chain's DO (target 0 ⇒ "scan to safe head"): every
    // chain is serviced each minute (not one per round-robin tick), and the DO
    // is the single serialized writer that the webhook also routes through.
    // Without the DO binding, fall back to the legacy inline round-robin scan.
    if (doIngestEnabled(env) && env.CHAIN_INGEST_DO) {
      const ns = env.CHAIN_INGEST_DO;
      for (const chain of getChainConfigs(resolved)) {
        const stub = ns.get(ns.idFromName(String(chain.id)));
        ctx.waitUntil(
          stub
            .fetch('https://chain-ingest-do/trigger', {
              method: 'POST',
              body: JSON.stringify({ chainId: chain.id, targetBlock: '0' }),
            })
            .catch((err) => {
              // eslint-disable-next-line no-console
              console.error(`[indexer] DO ping failed for chain ${chain.id}:`, err);
            }),
        );
      }
    } else {
      // Each pass is wrapped so a transient D1 / RPC blip on one pass can't
      // wedge the next — ticks fail one-at-a-time rather than tick-wide.
      ctx.waitUntil(
        runChainIndexer(resolved).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[indexer] runChainIndexer pass failed:', err);
        }),
      );
    }
    ctx.waitUntil(
      pruneOldCancelledOffers(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[indexer] pruneOldCancelledOffers pass failed:', err);
      }),
    );
    // #757 — prune the webhook delivery dedupe table (short retention window).
    ctx.waitUntil(
      pruneOldWebhookDeliveries(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[indexer] pruneOldWebhookDeliveries pass failed:', err);
      }),
    );
    // T-086 step 14 round 2 — retry the OpenSea publish for rows whose inline
    // publish at event-ingest time failed (e.g. transient OpenSea outage).
    // Codex round-1 P2 fix on PR #312. Capped at a small batch per tick.
    //
    // #757 (Codex #764 round 3): this runs on BOTH paths. It writes
    // `prepay_listings`, which the scan also writes — but the sweep has ALWAYS
    // raced the scan here (both are concurrent `ctx.waitUntil`), so the DO path
    // is no different in kind. The genuine read-modify-write hazard (marking a
    // concurrently re-priced row as published) is closed at the source: the
    // sweep's published-marker UPDATE is order_hash-guarded (see
    // `sweepUnpublishedListings`). Gating it off on the DO path would instead
    // DROP the OpenSea retry safety net the moment an operator enables DO
    // ingest — so it stays on. (Routing the global sweep per-chain THROUGH the
    // DO remains a nice-to-have follow-up, no longer a correctness gate.)
    ctx.waitUntil(
      sweepUnpublishedListings(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[indexer] sweepUnpublishedListings pass failed:', err);
      }),
    );
  },

  async fetch(
    req: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);

    // #757 — inbound chain webhook. Dispatched BEFORE the global `resolveEnv`
    // so an unauthenticated POST never triggers the other Secrets-Store
    // fetches: the handler reads ONLY the signing key from the raw env, caps
    // the body, and HMAC-verifies before any further work.
    if (url.pathname === '/hooks/chain-event' && req.method === 'POST') {
      return handleChainEventWebhook(req, env);
    }

    // #757 Phase B — browser WebSocket subscribe: `GET /ws/chain/:chainId` with
    // an `Upgrade: websocket` header. Dispatched BEFORE `resolveEnv` (the DO
    // resolves its own env; no Secrets-Store fetch needed just to route the
    // upgrade) and forwarded to that chain's ingest DO, which holds the
    // Hibernatable sockets. Degradable by construction: with no DO binding (or
    // DO ingest disabled) the socket is silent and the dapp keeps polling.
    const wsMatch = url.pathname.match(/^\/ws\/chain\/(\d+)$/);
    if (wsMatch) {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket upgrade', { status: 426 });
      }
      if (!env.CHAIN_INGEST_DO) {
        // No realtime channel on this deployment — client falls back to polling.
        return new Response('realtime push unavailable', { status: 503 });
      }
      const chainId = Number(wsMatch[1]);
      const ns = env.CHAIN_INGEST_DO;
      const stub = ns.get(ns.idFromName(String(chainId)));
      // Reconstruct the request against the DO-internal URL so the DO can read
      // `?chain=` for its `hello` frame; `new Request(url, req)` preserves the
      // upgrade headers that signal the WebSocket handshake.
      return stub.fetch(
        new Request(`https://chain-ingest-do/ws?chain=${chainId}`, req),
      );
    }

    // T-078 — resolve the Secrets Store RPC bindings once, at the
    // boundary; every route handler receives the plain resolved env.
    const resolved = await resolveEnv(env);

    // ─── /offers/* ──────────────────────────────────────────────
    if (url.pathname.startsWith('/offers')) {
      if (req.method === 'OPTIONS') return handleOffersPreflight();
      if (req.method === 'GET') {
        if (url.pathname === '/offers/stats') {
          return handleOffersStats(req, resolved);
        }
        if (url.pathname === '/offers/active') {
          return handleOffersActive(req, resolved);
        }
        if (url.pathname === '/offers/recent') {
          return handleOffersRecent(req, resolved);
        }
        const byCreator = url.pathname.match(
          /^\/offers\/by-creator\/(0x[0-9a-fA-F]{40})$/,
        );
        if (byCreator) return handleOffersByCreator(req, resolved, byCreator[1]);
        const byHolder = url.pathname.match(
          /^\/offers\/by-current-holder\/(0x[0-9a-fA-F]{40})$/,
        );
        if (byHolder) {
          return handleOffersByCurrentHolder(req, resolved, byHolder[1]);
        }
        const byId = url.pathname.match(/^\/offers\/(\d+)$/);
        if (byId) return handleOfferById(req, resolved, byId[1]);
      }
      return new Response('Not found', { status: 404 });
    }

    // ─── /loans/* ───────────────────────────────────────────────
    if (url.pathname.startsWith('/loans')) {
      if (req.method === 'OPTIONS') return handleLoansPreflight();
      // #335 — POST /loans/:loanId/prepay-listing/match-source.
      // Dapp records the OpenSea offer that triggered a Match-
      // rotation so analytics can distinguish offer-driven
      // rotations from manual repricings. Match the regex BEFORE
      // the GET tree below.
      if (req.method === 'POST') {
        const matchSource = url.pathname.match(
          /^\/loans\/(\d+)\/prepay-listing\/match-source$/,
        );
        if (matchSource) {
          return handleLoanPrepayMatchSource(req, resolved, matchSource[1]);
        }
        return new Response('Not found', { status: 404 });
      }
      if (req.method === 'GET') {
        if (url.pathname === '/loans/active') {
          return handleLoansActive(req, resolved);
        }
        if (url.pathname === '/loans/recent') {
          return handleLoansRecent(req, resolved);
        }
        if (url.pathname === '/loans/stats') {
          return handleLoansStats(req, resolved);
        }
        if (url.pathname === '/loans/timeseries') {
          return handleLoansTimeseries(req, resolved);
        }
        const byLender = url.pathname.match(
          /^\/loans\/by-lender\/(0x[0-9a-fA-F]{40})$/,
        );
        if (byLender) {
          return handleLoansByParticipant(req, resolved, byLender[1], 'lender');
        }
        const byBorrower = url.pathname.match(
          /^\/loans\/by-borrower\/(0x[0-9a-fA-F]{40})$/,
        );
        if (byBorrower) {
          return handleLoansByParticipant(
            req,
            resolved,
            byBorrower[1],
            'borrower',
          );
        }
        const byHolder = url.pathname.match(
          /^\/loans\/by-current-holder\/(0x[0-9a-fA-F]{40})$/,
        );
        if (byHolder) {
          return handleLoansByCurrentHolder(req, resolved, byHolder[1]);
        }
        const byId = url.pathname.match(/^\/loans\/(\d+)$/);
        if (byId) return handleLoanById(req, resolved, byId[1]);
      }
      return new Response('Not found', { status: 404 });
    }

    // ─── /activity ──────────────────────────────────────────────
    if (url.pathname === '/activity') {
      if (req.method === 'OPTIONS') return handleLoansPreflight();
      if (req.method === 'GET') return handleActivity(req, resolved);
      return new Response('Not found', { status: 404 });
    }

    // ─── /claimables/:address ───────────────────────────────────
    if (url.pathname.startsWith('/claimables/')) {
      if (req.method === 'OPTIONS') return handleLoansPreflight();
      if (req.method === 'GET') {
        const m = url.pathname.match(/^\/claimables\/(0x[0-9a-fA-F]{40})$/);
        if (m) return handleClaimables(req, resolved, m[1]);
      }
      return new Response('Not found', { status: 404 });
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;

/**
 * #757 — `POST /hooks/chain-event`. Authenticate the Alchemy delivery, then
 * forward a (chainId, target-block) hint to that chain's ingest DO. Reads ONLY
 * the signing key from the raw env (no `resolveEnv`), so an unauthenticated
 * POST never triggers the other Secrets-Store fetches. No CORS (caller is
 * Alchemy's edge, not a browser). Fails closed at every step; the cron + DO
 * backstop means a dropped/failed webhook only loses latency, never data.
 */
async function handleChainEventWebhook(
  req: Request,
  env: WorkerEnv,
): Promise<Response> {
  // 1. Cap the body before any hashing.
  let rawBody: string;
  try {
    rawBody = await readCappedBody(req);
  } catch (err) {
    if (err instanceof WebhookBodyTooLargeError) {
      return new Response('payload too large', { status: 413 });
    }
    return new Response('bad request', { status: 400 });
  }

  // 2. HMAC-verify (fail-closed). Reads only the signing key from the raw env,
  // via `readSecret` so a Secrets-Store fetch that REJECTS (transient outage,
  // deleted/deactivated secret, permission issue) resolves to `undefined` →
  // 401, never a Worker 500 before verification (Codex #764 round 4). This
  // public route stays fail-closed at every step.
  const signingKey = await readSecret(env.ALCHEMY_WEBHOOK_SIGNING_KEY);
  const ok = await verifyAlchemySignature(
    rawBody,
    req.headers.get('x-alchemy-signature'),
    signingKey,
  );
  if (!ok) return new Response('unauthorized', { status: 401 });

  // 3. Parse the hint (max delivered block, delivery id, network if present).
  const parsed = parseChainEventPayload(rawBody);
  if (!parsed) return new Response('bad payload', { status: 400 });
  // Resolve the chain. PREFER an explicit `?chain=<chainId>` URL param (Codex
  // #764 P1): Alchemy's *Custom Webhook* payload — the preferred rollout for
  // full Diamond-log coverage — carries no `network` field, so the operator
  // configures one webhook per chain whose target URL pins the chainId. Fall
  // back to the payload network (Address Activity) when the param is absent.
  const urlChain = Number(new URL(req.url).searchParams.get('chain'));
  const chainId =
    Number.isInteger(urlChain) && urlChain > 0 ? urlChain : parsed.chainId;
  // Unmapped/absent chain / DO ingest not enabled ⇒ accept + no-op (cron
  // covers it). The SAME gate as the cron keeps the two consistent — never
  // webhook→DO while the cron still scans inline (which would be two writers).
  if (chainId === null || !doIngestEnabled(env) || !env.CHAIN_INGEST_DO) {
    return new Response('ok (no-op)', { status: 200 });
  }

  // Dedupe key: prefer the provider's delivery id; otherwise a hash of the RAW
  // body, namespaced by the resolved chain (Codex #764 round 4). The old
  // `<network>:<maxBlock>` fallback collapsed every block-less Custom Webhook to
  // `unknown:0`, so the first delivery in the retention window dup-dropped all
  // later ones. A body hash collides only on a byte-identical payload — exactly
  // a provider retry of the same delivery, which is the dedupe we want.
  const deliveryId =
    parsed.providerId ?? `${chainId}:sha256:${await sha256Hex(rawBody)}`;

  // 4. Early dedupe — drop a delivery already recorded (no DO work).
  const seen = await env.DB.prepare(
    `SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?`,
  )
    .bind(deliveryId)
    .first();
  if (seen) return new Response('ok (dup)', { status: 200 });

  // 5. Durable forward to the chain's ingest DO (enqueue-only ack).
  const ns = env.CHAIN_INGEST_DO;
  const stub = ns.get(ns.idFromName(String(chainId)));
  let forwarded: Response;
  try {
    forwarded = await stub.fetch('https://chain-ingest-do/trigger', {
      method: 'POST',
      body: JSON.stringify({
        chainId,
        targetBlock: parsed.maxBlock.toString(),
      }),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[indexer] webhook DO forward threw:', err);
    // Don't record the dedupe row → Alchemy's retry re-forwards (5xx).
    return new Response('forward failed', { status: 502 });
  }
  if (!forwarded.ok) {
    return new Response('forward rejected', { status: 502 });
  }

  // 6. Record the dedupe row ONLY after a durable accept, then ack.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_deliveries (delivery_id, seen_at) VALUES (?, ?)`,
  )
    .bind(deliveryId, Math.floor(Date.now() / 1000))
    .run();
  return new Response('queued', { status: 200 });
}
