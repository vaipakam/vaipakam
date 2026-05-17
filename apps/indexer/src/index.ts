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
 * The indexer is intentionally read-only and operator-key-free.
 */

import { resolveEnv, type WorkerEnv } from './env';
import { runChainIndexer } from './chainIndexer';
import { pruneOldCancelledOffers } from './cancelledOfferRetention';
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
    // Each pass is wrapped so a transient D1 / RPC blip on one pass
    // can't wedge the next — indexer ticks fail one-at-a-time rather
    // than tick-wide.
    ctx.waitUntil(
      runChainIndexer(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[indexer] runChainIndexer pass failed:', err);
      }),
    );
    ctx.waitUntil(
      pruneOldCancelledOffers(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[indexer] pruneOldCancelledOffers pass failed:', err);
      }),
    );
  },

  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);
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
