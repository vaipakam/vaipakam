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
 *       GET  /offers/stats
 *       GET  /offers/active
 *       GET  /offers/recent
 *       GET  /offers/:offerId
 *       GET  /offers/by-creator/:address
 *       GET  /loans/active
 *       GET  /loans/recent
 *       GET  /loans/stats
 *       GET  /loans/timeseries
 *       GET  /loans/:loanId
 *       GET  /loans/by-lender/:address
 *       GET  /loans/by-borrower/:address
 *       GET  /activity
 *       GET  /claimables/:address
 *
 * The OPTIONS preflight handlers live with the route modules so the
 * CORS-allowed-method list stays paired with the actual handlers.
 *
 * NO Telegram webhook, NO Frames, NO quote / scan proxies — those
 * live on apps/agent. NO HF watcher / liquidation — that's apps/keeper.
 * The indexer is intentionally read-only and operator-key-free.
 */

import type { Env } from './env';
import { runChainIndexer } from './chainIndexer';
import { pruneOldCancelledOffers } from './cancelledOfferRetention';
import {
  handleOffersStats,
  handleOffersActive,
  handleOffersRecent,
  handleOfferById,
  handleOffersByCreator,
  handleOffersPreflight,
} from './offerRoutes';
import {
  handleLoansActive,
  handleLoansRecent,
  handleLoansStats,
  handleLoansTimeseries,
  handleLoanById,
  handleLoansByParticipant,
  handleActivity,
  handleClaimables,
  handleLoansPreflight,
} from './loanRoutes';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Each pass is wrapped so a transient D1 / RPC blip on one
    // pass can't wedge the next. Same isolation policy the
    // ops/hf-watcher monolith used internally; preserved here so
    // indexer ticks fail one-at-a-time rather than tick-wide.
    ctx.waitUntil(
      runChainIndexer(env).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[indexer] runChainIndexer pass failed:', err);
      }),
    );
    ctx.waitUntil(
      pruneOldCancelledOffers(env).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[indexer] pruneOldCancelledOffers pass failed:', err);
      }),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ─── /offers/* ──────────────────────────────────────────────
    if (url.pathname.startsWith('/offers')) {
      if (req.method === 'OPTIONS') return handleOffersPreflight();
      if (req.method === 'GET') {
        if (url.pathname === '/offers/stats') {
          return handleOffersStats(req, env);
        }
        if (url.pathname === '/offers/active') {
          return handleOffersActive(req, env);
        }
        if (url.pathname === '/offers/recent') {
          return handleOffersRecent(req, env);
        }
        const byCreator = url.pathname.match(
          /^\/offers\/by-creator\/(0x[0-9a-fA-F]{40})$/,
        );
        if (byCreator) return handleOffersByCreator(req, env, byCreator[1]);
        const byId = url.pathname.match(/^\/offers\/(\d+)$/);
        if (byId) return handleOfferById(req, env, byId[1]);
      }
      return new Response('Not found', { status: 404 });
    }

    // ─── /loans/* ───────────────────────────────────────────────
    if (url.pathname.startsWith('/loans')) {
      if (req.method === 'OPTIONS') return handleLoansPreflight();
      if (req.method === 'GET') {
        if (url.pathname === '/loans/active') return handleLoansActive(req, env);
        if (url.pathname === '/loans/recent') return handleLoansRecent(req, env);
        if (url.pathname === '/loans/stats') return handleLoansStats(req, env);
        if (url.pathname === '/loans/timeseries') {
          return handleLoansTimeseries(req, env);
        }
        const byLender = url.pathname.match(
          /^\/loans\/by-lender\/(0x[0-9a-fA-F]{40})$/,
        );
        if (byLender) {
          return handleLoansByParticipant(req, env, byLender[1], 'lender');
        }
        const byBorrower = url.pathname.match(
          /^\/loans\/by-borrower\/(0x[0-9a-fA-F]{40})$/,
        );
        if (byBorrower) {
          return handleLoansByParticipant(req, env, byBorrower[1], 'borrower');
        }
        const byId = url.pathname.match(/^\/loans\/(\d+)$/);
        if (byId) return handleLoanById(req, env, byId[1]);
      }
      return new Response('Not found', { status: 404 });
    }

    // ─── /activity ──────────────────────────────────────────────
    if (url.pathname === '/activity') {
      if (req.method === 'OPTIONS') return handleLoansPreflight();
      if (req.method === 'GET') return handleActivity(req, env);
      return new Response('Not found', { status: 404 });
    }

    // ─── /claimables/:address ───────────────────────────────────
    if (url.pathname.startsWith('/claimables/')) {
      if (req.method === 'OPTIONS') return handleLoansPreflight();
      if (req.method === 'GET') {
        const m = url.pathname.match(/^\/claimables\/(0x[0-9a-fA-F]{40})$/);
        if (m) return handleClaimables(req, env, m[1]);
      }
      return new Response('Not found', { status: 404 });
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
