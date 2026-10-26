/**
 * apps/agent Worker entry — proactive notifications + operator
 * services + public Frames + Telegram bot + diagnostics record.
 * (#1651: "cross-chain monitoring" was listed here for the
 * buy-watchdog #687-A removed.)
 *
 * Stage 3 PR4 of the Worker split (see
 * `docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`). The agent is
 * the broadest of the three Workers — it inherits everything from
 * the ops/hf-watcher monolith that's NOT the HF watcher loop
 * (apps/keeper) or the chain-event scan + read API (apps/indexer).
 *
 * `scheduled()` (cron — one every-minute trigger, acting every
 * `AGENT_TICK_CADENCE_MINUTES`; see the note at its top, #2236):
 *   - `runPeriodicPreNotify`     — push borrowers (priority) and
 *                                  lenders (courtesy) before the
 *                                  next interest-payment checkpoint.
 *   - `pruneOldDiagErrors`       — diagnostics retention prune.
 *
 * `runDailyOracleSnapshot` USED to live here but moved to
 * `apps/keeper` in the Stage 3 architectural-rebalance commit
 * (matches the staging plan §2 least-privilege contract:
 * `KEEPER_PRIVATE_KEY` lives on exactly one Worker — the keeper).
 * Agent therefore no longer signs ANY on-chain transaction, so a
 * compromised agent can't move funds DIRECTLY. That is the whole
 * of the guarantee — it is NOT "produces stale notifications", the
 * claim this comment used to make. This Worker deletes diagnostics
 * and support records, writes `loans`, notifies real users, holds
 * `PUSH_CHANNEL_PK` (a real Ethereum key), publishes listings via
 * `/opensea/listing`, and shares a DATABASE-scoped D1 binding with
 * the signing keeper — so it can corrupt state the keeper acts on
 * (#1722). Direct fund movement is the only thing the missing
 * transaction key rules out.
 *
 * `fetch()`:
 *   POST /tg/webhook                        — Telegram bot handshake
 *   GET  /frames/active-loans               — Farcaster Frame initial
 *   POST /frames/active-loans               — Frame button click
 *   GET  /frames/active-loans/image         — Frame SVG image
 *   POST /quote/1inch                       — 1inch v6 aggregator proxy
 *   GET  /quote/readiness                   — which aggregator keys this Worker holds
 *   GET  /push/status                       — whether this Worker can send Push,
 *                                             and as which channel (#2251), and
 *                                             the chains paid Push is billed on
 *                                             (none today, #2723)
 *   POST /intent/fusion/post                — 1inch Fusion resolver-pickup
 *                                             proxy (T-090 v1.1 Sub 3)
 *   POST /opensea/listing                   — OpenSea Listings API proxy
 *                                             (T-086 step 14)
 *   ANY  /diag/record                       — diagnostics record capture
 *   POST /diag/erasure                      — frontend → erase own records
 *   POST /diag/erasure/status               — frontend → erasure status check
 *   POST /diag/legal-hold                   — protocol admin → place/lift hold
 *   PUT  /thresholds                        — frontend → upsert HF bands
 *   POST /link/telegram                     — frontend → issue handshake code
 *                                             (EIP-191 wallet signature
 *                                             required — see linkAuth.ts)
 *   POST /unlink/telegram                   — frontend → clear the stored
 *                                             wallet ↔ tg_chat_id link (#1033;
 *                                             EIP-191 signature required too)
 *   POST /telegram/test                     — frontend → send ONE test alert
 *                                             to the linked chat (UX-012;
 *                                             EIP-191 signature required too)
 *   POST /support/ticket                    — frontend → capture a support
 *                                             ticket into D1 + ops-Telegram
 *                                             notify (#1040 phase 1)
 *
 * The `/thresholds`, `/link/telegram`, `/diag/record`,
 * `/diag/erasure`, `/diag/erasure/status` and `/diag/legal-hold`
 * endpoints are CORS-locked to `FRONTEND_ORIGIN` — `/diag/legal-hold`
 * is driven from the protocol console — still on the legacy
 * `apps/defi` deployment, not ported in #1854 (see #1959) — so it is a
 * browser-facing endpoint; its authorization is the signer's
 * on-chain `ADMIN_ROLE`, checked inside the handler. The Telegram
 * webhook and Frames have their own posture (no origin gate — Telegram
 * and Farcaster post from arbitrary infrastructure). Every route that
 * spends an operator-held API key (`/quote/1inch`,
 * `/intent/fusion/post`, the `/opensea/*` proxies) sits behind the
 * Origin gate and a caller budget taken at the router, and draws one
 * slot of its key's credential budget per upstream call; every limiter
 * fails closed (`rateLimit.ts`, #2755). There is no `/quote/0x`: it had
 * no caller and was removed in #2755.
 *
 * ET-001 — there is no transaction-scan proxy. The pre-sign
 * transaction preview runs entirely in the frontend as a viem
 * `eth_call` simulation against the chain's own RPC (no API key, so
 * no server-side proxy is needed); see `apps/app`
 * `useTxSimulation`. The Blockaid → GoPlus migration was dropped:
 * GoPlus's Transaction Simulation API is mainnet-only (3 chains)
 * and Vaipakam runs on testnets — a free `eth_call` covers every
 * chain.
 */

import { getChainConfigs, resolveEnv, WORKER_NAME, type Env, type WorkerEnv } from './env';
import {
  hasD1Binding,
  maintenanceRefusal,
  maintenanceSkipNotice,
} from '@vaipakam/lib/d1Maintenance';
import { createSchemaGate, schemaDeclineNotice } from '@vaipakam/lib/d1SchemaGate';
import { runPeriodicPreNotify } from './periodicPreNotify';
import { decidePushOptIn, handlePushStatus, servicePushStatus } from './pushRail';
import { handle1inchQuote, handleQuoteReadiness } from './quoteProxy';
import { slotRefusal, takeCallerSlot } from './rateLimit';
import { parseOriginList } from '@vaipakam/lib/originAllowList';
import { handleOpenSeaListingPost } from './openseaProxy';
import { handleIntentFusionPost } from './intentFusionPost';
import { handleOpenSeaCollection } from './openseaCollectionProxy';
import { handleOpenSeaOffers } from './openseaOffersProxy';
import { handleOpenSeaSignedOffer } from './openseaSignedOfferProxy';
import { handleFeeRecipientPreflight } from './feeRecipientPreflight';
import { handleDiagRecord, pruneOldDiagErrors } from './diagRecord';
import { handleSupportTicket, pruneOldSupportTickets } from './supportTicket';
import {
  handleDiagErasure,
  handleDiagErasureStatus,
  handleDiagLegalHold,
} from './diagErasure';
import {
  handleActiveLoansFrameInitial,
  handleActiveLoansFramePost,
  handleActiveLoansFrameImage,
} from './frames';
import {
  consumeTelegramLinkCode,
  getTelegramChatId,
  issueTelegramLinkCode,
  linkTelegram,
  OptOutStorageUnavailableError,
  reserveTestAlert,
  sweepExpiredLinks,
  unlinkTelegram,
  unlinkTelegramOnChain,
  hasStoredPushOptIn,
  upsertThresholds,
} from './db';
import { extractLinkCode, isTelegramDelivery, sendMessage, type TelegramUpdate } from './telegram';
import { handshakeExpired, handshakeLinked, testAlert } from './i18n';
import {
  authoriseAlertRequest,
  parseSignedLinkRequest,
  type LinkVerifyResult,
} from './linkAuth';
import type { AlertSettingsChange } from '@vaipakam/lib/alertsMessage';
import { isTickDue } from '@vaipakam/lib/cronCadence';
import { AGENT_TICK_CADENCE_MINUTES } from './tickCadence';
import { readJsonBody } from '@vaipakam/lib/requestBody';

/** A signed alert request: a few fields plus a wallet signature. A
 *  smart-account (ERC-6492) signature can run to a few kilobytes, so the
 *  cap leaves room for one (#2756). */
const MAX_SIGNED_REQUEST_BODY_BYTES = 16 * 1024;
/** A Telegram update: a message is at most 4,096 characters, plus its
 *  entities and the sender and chat records. */
const MAX_TELEGRAM_UPDATE_BYTES = 256 * 1024;

/**
 * The shared-D1 schema gate (#2410). The agent auto-deploys on merge through
 * Workers Builds, so a build can reach this isolate before the indexer's
 * deploy has applied the migrations it was written against. Every scheduled
 * pass reads or writes the shared database, so the whole tick declines, by
 * name, until every migration in the build is recorded, and resumes by
 * itself on the first tick after they land. One gate per isolate: it caches
 * only `current`. HTTP handlers are NOT gated and must tolerate the previous
 * schema themselves (the shared module states why).
 */
const schemaGate = createSchemaGate();

export default {
  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    // #2236 — THE TICK RUNS EVERY FIVE MINUTES, on the one every-minute
    // schedule this Worker owns (the free plan's cron triggers are an account
    // budget; see `@vaipakam/lib/cronCadence`). A minute that is not due
    // returns here having done nothing.
    //
    // Why, from the evidence rather than the theory: this Worker runs on the
    // free plan's 10 ms CPU allowance, and it has been stopped for CPU in two
    // episodes (2026-09-19/20, and 2026-10-15/16 with 762 stopped invocations;
    // `cpuTimeP50` of the stopped ones pinned at 10,000 µs). Its SUCCESSFUL ticks spend a
    // median of about 25 ms on the same plan, and the kills arrive in whole
    // hours of nearly every tick, alternating with whole hours of none — a
    // pattern a fixed per-invocation ceiling would not produce, and one an
    // allowance measured over a window would. Which it is cannot be read from
    // the account's analytics. What does not depend on the answer: the work
    // is a reminder sweep whose window is DAYS wide (`DEFAULT_PRE_NOTIFY_DAYS`)
    // and two retention prunes, so running it every minute bought nothing a
    // five-minute cadence does not, at five times the CPU. What it costs is
    // stated: a reminder lap takes five times as many minutes (#2230 tracks
    // the condition under which a lap's length would matter), and an expired
    // Telegram link code is deleted up to five minutes later — consuming one
    // already checks its expiry, so a late delete is never a late accept.
    if (!isTickDue(controller.scheduledTime, AGENT_TICK_CADENCE_MINUTES)) {
      return;
    }
    // #2239 — decline the whole tick when this build has no D1 binding.
    // Every pass below reads or writes the database, so one line here beats a
    // separate failure from each `waitUntil` continuation.
    if (!hasD1Binding(env.DB)) {
      // eslint-disable-next-line no-console
      console.warn(maintenanceSkipNotice(WORKER_NAME, 'this tick'));
      return;
    }

    // T-078 — resolve the Secrets Store bindings once, here at the
    // entry point; all three passes get the plain resolved env.
    const resolved = await resolveEnv(env);
    // #2410 — then confirm the shared schema before launching any pass.
    const schema = await schemaGate.check(resolved.DB);
    if (schema.state !== 'current') {
      // eslint-disable-next-line no-console
      console.warn(schemaDeclineNotice(WORKER_NAME, 'this tick', schema));
      return;
    }
    // Each pass wrapped so a transient D1 / RPC blip on one can't
    // wedge the others. Same isolation policy the ops/hf-watcher
    // monolith used internally.
    ctx.waitUntil(
      runPeriodicPreNotify(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[agent] runPeriodicPreNotify pass failed:', err);
      }),
    );
    ctx.waitUntil(
      pruneOldDiagErrors(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[agent] pruneOldDiagErrors pass failed:', err);
      }),
    );
    ctx.waitUntil(
      pruneOldSupportTickets(resolved).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[agent] pruneOldSupportTickets pass failed:', err);
      }),
    );
    // #1896 — expired Telegram handshake codes. This sweep used to run
    // only inside the keeper's watcher, which made a keeper outage
    // silently stop the ONLY cleanup of a table this Worker fills:
    // `issueTelegramLinkCode` is an agent route, so codes kept being
    // handed out with nothing clearing them. The agent is the right
    // owner either way — it issues the codes, it already prunes its own
    // diagnostics and support tickets on this same tick, and the sweep
    // is a single bounded DELETE. `apps/keeper/src/db.ts` keeps its
    // identical copy so the watcher still sweeps once rescheduled;
    // both are idempotent, so overlapping runs are harmless.
    //
    // THIS WORKER AUTO-DEPLOYS ON MERGE, so a merge that TOUCHES this Worker
    // now carries its changes live without a hand-run deploy (#2237,
    // correcting Codex #1924 r17).
    //
    // WHAT THAT DOES NOT SAY, deliberately (#2238 r3 P2). It says nothing
    // about when THIS sweep first went live. The sweep predates this comment,
    // the evidence gathered for #2237 is about later commits, and the
    // paragraph below accepts that the old warning was true when it was
    // written — so the adding merge may well have landed before this Worker
    // was built on merge at all. Claiming "it went live with the merge that
    // added it" would swap one unsupported operational history for another,
    // which is the defect #2237 exists to correct rather than repeat. If the
    // first live deployment ever needs to be known, read it from the
    // deployment history; do not infer it from here.
    //
    // What stood here said the opposite — "`apps/agent` does NOT auto-deploy
    // on merge", citing `docs/ops/D1CutoverArchiveToWarm.md` step 2 — and
    // concluded that without a hand-run deploy in the same sitting, the
    // migration that moved this sweep off the keeper made the leak worse
    // rather than fixing it. That was true when written and is not now:
    // Cloudflare Workers Builds posts a `Workers Builds: vaipakam-agent`
    // check on the merge commits that touch this Worker, and the live
    // deployment timestamps line up with those checks to the second. The
    // runbook step it cited is corrected in the same change.
    //
    // Believing the old line is worse than the hazard it warned about: it
    // tells a reader that a merged agent change is NOT live when it is, and
    // nobody looks for the effects of a change they think never shipped.
    //
    // THE VAR HAZARD IS REAL AND IS HANDLED STRUCTURALLY, which matters more
    // now, not less — an automatic deploy passes no flags at all. `env.ts`
    // reads `RECIPIENT_VALIDATING_TOKENS` and `OPENSEA_OFFERS_MAX_PAGES`,
    // neither declared in `wrangler.jsonc`'s `vars`, and wrangler deletes
    // undeclared vars on deploy. `"keep_vars": true` in that config is what
    // stops it, on every route including Workers Builds; the package script's
    // `--keep-vars` is belt-and-braces for a hand-run deploy. See CLAUDE.md,
    // "Dashboard-managed vars survive a deploy — declared, not remembered".
    ctx.waitUntil(
      sweepExpiredLinks(resolved.DB).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[agent] sweepExpiredLinks pass failed:', err);
      }),
    );

  },

  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // #2239 — one answer for every route while this build has no D1 binding.
    //
    // Blunt ON PURPOSE. A few routes here touch no database (the aggregator
    // quote proxies, the Frames image), and refusing those too costs their
    // callers a short window. The alternative is a per-route list of which
    // routes read D1, kept correct by hand forever — which is precisely the
    // enumeration this whole mechanism exists to stop. One rule at the
    // entrance cannot fall out of step with the routes below it.
    //
    // 503 + Retry-After, and a body that says nothing was recorded: a caller
    // whose write is refused must be told it did not happen, rather than be
    // handed a 500 that could mean anything.
    if (!hasD1Binding(env.DB)) {
      // CARRY THE NORMAL CORS POLICY (#2252 r3 P1). This branch sits above the
      // preflight and Origin gate, and a 503 with no
      // `Access-Control-Allow-Origin` is invisible to a browser: the caller
      // sees an opaque network failure, never the status and never the body
      // that says the write was not recorded. That would defeat the entire
      // point of answering rather than throwing.
      //
      // The preflight must SUCCEED for the same reason. A refused `OPTIONS`
      // means the browser never issues the real request, so there is no 503
      // for anyone to read.
      if (req.method === 'OPTIONS') return preflight(req, env);
      const { body, status, headers } = maintenanceRefusal(WORKER_NAME);
      return new Response(body, {
        status,
        headers: {
          ...headers,
          'Access-Control-Allow-Origin': resolveAllowedOrigin(req, env),
          // The echoed origin varies by request, so caches must key on it —
          // even under `no-store`, intermediaries and the browser's own
          // preflight cache read this.
          Vary: 'Origin',
        },
      });
    }

    // T-078 — resolve the Secrets Store bindings once, here at the
    // entry point; every route handler below gets the plain resolved
    // env and stays synchronous.
    const resolved = await resolveEnv(env);

    // Telegram webhook — no CORS, external caller (Telegram's edge
    // posts the update with no Origin header). Handles the link-code
    // handshake and replies 200 even on no-match so Telegram doesn't
    // retry.
    if (url.pathname === '/tg/webhook' && req.method === 'POST') {
      return handleTelegramWebhook(req, resolved);
    }

    // Farcaster Frames — public read-only, embeddable from any
    // Farcaster client. No CORS gate.
    if (url.pathname === '/frames/active-loans' && req.method === 'GET') {
      return handleActiveLoansFrameInitial(req, resolved);
    }
    if (url.pathname === '/frames/active-loans' && req.method === 'POST') {
      return handleActiveLoansFramePost(req, resolved);
    }
    if (url.pathname === '/frames/active-loans/image' && req.method === 'GET') {
      return handleActiveLoansFrameImage(req);
    }

    // #2463 round 15 — which aggregator keys this Worker holds. A read
    // that spends no key; an origin outside the allow-list cannot read the
    // answer (see `handleQuoteReadiness`).
    if (url.pathname === '/quote/readiness' && req.method === 'GET') {
      return handleQuoteReadiness(resolved, resolveAllowedOrigin(req, resolved));
    }
    // #2251 — whether Push can be sent, read by the app before it offers the
    // opt-in; both senders' rails when the keeper's is known (#2667). Same
    // shape and CORS handling as the readiness probe above.
    if (url.pathname === '/push/status' && req.method === 'GET') {
      return await handlePushStatus(resolved, resolveAllowedOrigin(req, resolved));
    }

    // Diagnostics record. CORS-locked + per-IP rate-limited inside
    // `handleDiagRecord` itself, which reads `FRONTEND_ORIGIN` and
    // the `DIAG_RECORD_RATELIMIT` binding directly.
    if (url.pathname === '/diag/record') {
      return handleDiagRecord(req, resolved);
    }

    // Frontend-facing endpoints below — Origin gate.
    if (req.method === 'OPTIONS') {
      return preflight(req, resolved);
    }
    if (!isAllowedOrigin(req, resolved)) {
      return new Response('Forbidden', { status: 403 });
    }

    // One caller budget per limited route, taken here before the route
    // does any work (signature checks, chain reads, upstream calls), under
    // the one fail-closed rule in `rateLimit.ts` (#2754, #2755).
    const budget = callerBudgetFor(req.method, url.pathname);
    if (budget !== null) {
      const refused = slotRefusal(
        await takeCallerSlot(req, resolved[budget]),
        resolveAllowedOrigin(req, resolved),
      );
      if (refused) return refused;
    }
    // Aggregator proxies (#2755): behind the Origin gate like every other
    // route the app calls, since only the app calls them. The worker
    // injects the operator-held key server-side.
    if (url.pathname === '/quote/1inch' && req.method === 'POST') {
      return handle1inchQuote(req, resolved, resolveAllowedOrigin(req, resolved));
    }
    // T-090 v1.1 (#389) Sub 3 (#418) — Fusion resolver-pickup proxy.
    // The app posts the orderHash + structured Fusion order + commit tx
    // hash after the borrower's `commitSwapToRepayIntent` lands; the
    // handler binds the order to the on-chain commit before it spends the
    // 1inch key.
    if (url.pathname === '/intent/fusion/post' && req.method === 'POST') {
      return handleIntentFusionPost(req, resolved, resolveAllowedOrigin(req, resolved));
    }
    if (url.pathname === '/thresholds' && req.method === 'PUT') {
      return handlePutThresholds(req, resolved);
    }
    if (url.pathname === '/link/telegram' && req.method === 'POST') {
      return handleIssueTelegramLink(req, resolved);
    }
    if (url.pathname === '/unlink/telegram' && req.method === 'POST') {
      return handleUnlinkTelegram(req, resolved);
    }
    // UX-012 — send ONE real test alert to the linked chat so the
    // frontend can gate its "linked" state on a proven round-trip
    // instead of the user's self-attestation.
    if (url.pathname === '/telegram/test' && req.method === 'POST') {
      return handleTestTelegram(req, resolved);
    }
    // #1040 phase 1 — support-ticket capture from the connected app support
    // widget (rate limit + validation inside the handler).
    if (url.pathname === '/support/ticket' && req.method === 'POST') {
      return handleSupportTicket(req, resolved, resolveAllowedOrigin(req, resolved), ctx);
    }

    // Erasure (T-075) — user erases their own error-capture records
    // / checks erasure status. Both require an EIP-191 wallet
    // signature, verified inside the handlers. CORS-locked like the
    // other frontend endpoints.
    if (url.pathname === '/diag/erasure' && req.method === 'POST') {
      return handleDiagErasure(req, resolved, resolveAllowedOrigin(req, resolved));
    }
    if (url.pathname === '/diag/erasure/status' && req.method === 'POST') {
      return handleDiagErasureStatus(
        req,
        resolved,
        resolveAllowedOrigin(req, resolved),
      );
    }

    // Legal hold (T-075) — protocol admin places / lifts a hold from
    // the protocol console, which is still on the legacy `apps/defi`
    // deployment (not ported in #1854; see #1959). Browser-facing, so Origin-gated
    // like the endpoints above; the request itself is signed and the
    // handler verifies the signer holds the on-chain ADMIN_ROLE.
    if (url.pathname === '/diag/legal-hold' && req.method === 'POST') {
      return handleDiagLegalHold(
        req,
        resolved,
        resolveAllowedOrigin(req, resolved),
      );
    }

    // T-086 step 14 — OpenSea Listings API proxy. The frontend POSTs
    // the canonical Seaport OrderComponents the diamond just locked
    // on-chain; this proxy forwards to OpenSea with the server-side
    // API key. Placed below the Origin gate above (Codex round-1 P2
    // fix on PR #312) — only the dapp should be reaching this; a
    // non-allowed origin would otherwise be able to drain our
    // OpenSea API quota before the CORS rejection bites. CORS
    // origin is resolved + echoed so any FRONTEND_ORIGIN entry
    // works (Codex round-1 P2 on the same PR).
    if (url.pathname === '/opensea/listing' && req.method === 'POST') {
      return handleOpenSeaListingPost(
        req,
        resolved,
        resolveAllowedOrigin(req, resolved),
      );
    }
    // T-086 Round-5 Block A (#313) — Collection API proxy + fee-
    // recipient pre-flight. The collection proxy is GET (stateless,
    // cacheable); the pre-flight is POST (carries the dapp's
    // computed fee schedule + loan context, returns per-recipient
    // verdicts). Both CORS-locked via the same FRONTEND_ORIGIN
    // resolver every other dapp-facing endpoint uses.
    if (
      url.pathname.startsWith('/opensea/collection/') &&
      req.method === 'GET'
    ) {
      return handleOpenSeaCollection(
        req,
        resolved,
        resolveAllowedOrigin(req, resolved),
      );
    }
    if (
      url.pathname === '/opensea/feeRecipientPreflight' &&
      req.method === 'POST'
    ) {
      return handleFeeRecipientPreflight(
        req,
        resolved,
        resolveAllowedOrigin(req, resolved),
      );
    }
    // T-086 Round-5 Block C (#309 Mode B) — OpenSea Offers proxy.
    // The borrower's loan card polls this while open to surface
    // incoming OpenSea offers; the borrower can then "Match" an
    // acceptable offer via `updatePrepayListing`. Pure pass-
    // through: rate-limit + CORS + aggregate (item + collection)
    // offers in one round-trip; the dapp does the threshold filter.
    if (
      url.pathname.startsWith('/opensea/offers/') &&
      req.method === 'GET'
    ) {
      return handleOpenSeaOffers(
        req,
        resolved,
        resolveAllowedOrigin(req, resolved),
      );
    }
    // T-086 Round-6 / Block D (#345) — OpenSea signed-offer fetch.
    // Hit by the dapp at Match-click time to retrieve the bidder's
    // signed `OrderComponents + signature + SIP-7 extraData +
    // CriteriaResolver[]` payload for atomic match-rotation via
    // `NFTPrepayListingAtomicFacet.matchOpenSeaOffer`. Distinct
    // top-level prefix so the broader `/opensea/offers/` GET
    // branch above doesn't accidentally swallow it (design doc
    // §17.3 + §17.18 D.2).
    if (
      url.pathname.startsWith('/opensea/signed-offer/') &&
      req.method === 'GET'
    ) {
      return handleOpenSeaSignedOffer(
        req,
        resolved,
        resolveAllowedOrigin(req, resolved),
      );
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;

// ─── HTTP handlers ─────────────────────────────────────────────────

/** The caller-budget bindings a route can be metered by. */
type CallerBudget =
  | 'ALERT_WRITE_RATELIMIT'
  | 'SUPPORT_TICKET_RATELIMIT'
  | 'QUOTE_1INCH_RATELIMIT'
  | 'INTENT_FUSION_POST_RATELIMIT'
  | 'OPENSEA_LISTING_RATELIMIT'
  | 'OPENSEA_COLLECTION_RATELIMIT'
  | 'OPENSEA_OFFERS_RATELIMIT'
  | 'OPENSEA_SIGNED_OFFER_RATELIMIT';

/**
 * The caller budget that meters a route behind the Origin gate, or `null`
 * for a route with none (#2754, #2755). One table, read once by the
 * router, so no route keeps a limiter of its own.
 *
 *   - The four signed alert writes share `ALERT_WRITE_RATELIMIT`. The
 *     signature is the real gate; this bounds the cost of bodies that
 *     fail it.
 *   - Every route that spends an operator-held API key has its own
 *     budget. The Origin gate before it stops another site's page; for a
 *     scripted caller, which can forge an Origin, these budgets and the
 *     per-key credential budgets (`rateLimit.ts`) are the bound.
 *
 * `/diag/record` meters itself, because it is served ahead of the Origin
 * gate with its own CORS handling; it uses the same `rateLimit.ts` rule.
 */
export function callerBudgetFor(method: string, path: string): CallerBudget | null {
  if (method === 'PUT' && path === '/thresholds') return 'ALERT_WRITE_RATELIMIT';
  if (method === 'POST' && (path === '/link/telegram' || path === '/unlink/telegram' || path === '/telegram/test')) {
    return 'ALERT_WRITE_RATELIMIT';
  }
  if (method === 'POST' && path === '/support/ticket') return 'SUPPORT_TICKET_RATELIMIT';
  if (method === 'POST' && path === '/quote/1inch') return 'QUOTE_1INCH_RATELIMIT';
  if (method === 'POST' && path === '/intent/fusion/post') return 'INTENT_FUSION_POST_RATELIMIT';
  if (method === 'POST' && path === '/opensea/listing') return 'OPENSEA_LISTING_RATELIMIT';
  if (method === 'GET' && path.startsWith('/opensea/collection/')) return 'OPENSEA_COLLECTION_RATELIMIT';
  if (method === 'GET' && path.startsWith('/opensea/offers/')) return 'OPENSEA_OFFERS_RATELIMIT';
  if (method === 'GET' && path.startsWith('/opensea/signed-offer/')) return 'OPENSEA_SIGNED_OFFER_RATELIMIT';
  return null;
}

/** The answer to a signed alert request that was not authorised. A
 *  repeat of an accepted request and a check that could not run each
 *  have their own error name, so the app can say "sign again" or "try
 *  again shortly" rather than "the signature is wrong". */
function refusal(
  result: Extract<LinkVerifyResult, { ok: false }>,
  corsOrigin: string,
): Response {
  const error =
    result.status === 409
      ? 'request-already-used'
      : result.status === 503
        ? 'verification-unavailable'
        : 'verification_failed';
  return json(
    {
      error,
      reason: result.reason,
    },
    result.status,
    corsOrigin,
  );
}

/** What a parsed settings save changes, in the shape the signed message
 *  names (#2754). Built from the same parsed body that is written, so
 *  the signature and the stored row cannot describe different saves. */
export function settingsChangeOf(parsed: PutThresholdsBody): AlertSettingsChange {
  return {
    ...(parsed.warn_hf !== undefined
      ? {
          bands: {
            warnHf: parsed.warn_hf,
            alertHf: parsed.alert_hf as number,
            criticalHf: parsed.critical_hf as number,
          },
        }
      : {}),
    ...(parsed.notify_maturity_approaching !== undefined
      ? { dueDateReminders: parsed.notify_maturity_approaching }
      : {}),
    ...(parsed.push_channel ? { pushAlerts: true as const } : {}),
  };
}

async function handlePutThresholds(req: Request, env: Env): Promise<Response> {
  const corsOrigin = resolveAllowedOrigin(req, env);
  const read = await readJsonBody(req, MAX_SIGNED_REQUEST_BODY_BYTES);
  if (!read.ok) return json({ error: read.error }, read.status, corsOrigin);
  const body = read.value;
  const parsed = parsePutThresholds(body);
  if (!parsed) return json({ error: 'invalid-payload' }, 400, corsOrigin);

  // #2754 — the watcher only watches chains this deployment is
  // configured for, so a save for any other chain would create watcher
  // state nothing reads.
  if (!getChainConfigs(env).some((c) => c.id === parsed.chain_id)) {
    return json({ error: 'chain-not-configured' }, 400, corsOrigin);
  }
  // #2754 — EVERY settings write carries the wallet's signature over a
  // message naming exactly what it saves. The body's wallet used to be
  // trusted for everything but an opt-out, so a non-browser caller with
  // a spoofed Origin could rewrite any wallet's bands and Push opt-in.
  // The signed wallet and chain are read from the same body fields the
  // write uses, so the signature covers the row it writes.
  const signed = parseSignedLinkRequest(body);
  if (!signed.ok) {
    return json(
      { error: 'signature-required', reason: signed.reason },
      401,
      corsOrigin,
    );
  }
  const authorised = await authoriseAlertRequest(req, env, signed.req, {
    action: 'save-settings',
    settings: settingsChangeOf(parsed),
  });
  if (!authorised.ok) return refusal(authorised, corsOrigin);
  // #2251 — a NEW Push opt-in is accepted only where Push can honour it: the
  // same answer `GET /push/status` gives, so both senders' rails when the
  // keeper's is known (#2667); see `decidePushOptIn` for what is refused and
  // what is kept.
  const decision = await decidePushOptIn(
    parsed,
    await servicePushStatus(env),
    () => hasStoredPushOptIn(env.DB, parsed.wallet, parsed.chain_id),
  );
  if ('refused' in decision) {
    // Non-2xx on purpose: every client, including a bundle from before this
    // change, reads it as "not saved". Nothing in this save was stored.
    return json(
      {
        error: 'push-unavailable',
        reason: 'Push alerts cannot be sent from this deployment right now; nothing was saved',
        push: 'unavailable',
      },
      409,
      corsOrigin,
    );
  }
  const { write, push } = decision;
  try {
    await upsertThresholds(env.DB, write);
  } catch (err) {
    // Rollout window — an opt-out can't be stored until migration
    // 0027 lands. A distinct 503 lets the client say "try again
    // shortly" instead of a generic failure; every other error
    // propagates as before.
    if (err instanceof OptOutStorageUnavailableError) {
      return json(
        {
          error: 'optout-unavailable',
          reason: 'alert settings storage migration pending — try again shortly',
        },
        503,
        corsOrigin,
      );
    }
    throw err;
  }
  return json(
    {
      ok: true,
      // What happened to the Push opt-in this save carried, if any. Absent
      // from older agents, which the app reads as "stored" — the behaviour
      // those agents had. A refused NEW opt-in never reaches here (409 above).
      push,
    },
    200,
    corsOrigin,
  );
}

async function handleIssueTelegramLink(
  req: Request,
  env: Env,
): Promise<Response> {
  const corsOrigin = resolveAllowedOrigin(req, env);
  const read = await readJsonBody(req, MAX_SIGNED_REQUEST_BODY_BYTES);
  if (!read.ok) return json({ error: read.error }, read.status, corsOrigin);
  const body = read.value;
  // Unlike the other settings endpoints, issuing a link code REQUIRES
  // wallet-ownership proof: completing the handshake redirects the
  // wallet's whole alert stream to whichever chat sends the code (and
  // seeds a thresholds row for first-time wallets), so a body-trusted
  // wallet here would let any caller subscribe a victim's alerts to
  // their own Telegram. EIP-191 signature over the fixed message in
  // `linkAuth.ts`, same pattern as the erasure endpoints.
  const parsed = parseSignedLinkRequest(body);
  if (!parsed.ok) {
    return json(
      { error: 'invalid-payload', reason: parsed.reason },
      400,
      corsOrigin,
    );
  }
  const verified = await authoriseAlertRequest(req, env, parsed.req, 'link');
  if (!verified.ok) return refusal(verified, corsOrigin);

  const code = await issueTelegramLinkCode(
    env.DB,
    parsed.req.wallet,
    parsed.req.chain_id,
  );
  // Build the Telegram deep link from the operator-configured bot
  // username. Both `TG_BOT_TOKEN` AND `TG_BOT_USERNAME` must be set:
  // the token authenticates message sends, the username is the
  // user-visible handle in the `https://t.me/<handle>?start=...`
  // deep link. Without the username we deliberately return a null
  // bot_url so the frontend falls back to a copy-the-code flow
  // instead of pointing users at a placeholder bot they can't reach.
  const botUrl =
    env.TG_BOT_TOKEN && env.TG_BOT_USERNAME
      ? `https://t.me/${encodeURIComponent(env.TG_BOT_USERNAME)}?start=${code}`
      : null;
  return json({ ok: true, code, bot_url: botUrl }, 200, corsOrigin);
}

/** #1033 — clear a stored wallet ↔ Telegram link. Requires the same
 *  EIP-191 wallet-ownership proof as link issuance, over the unlink-
 *  scoped message (round 5): the Origin gate is not authentication —
 *  a non-browser caller can spoof an allowed Origin, and silently
 *  stopping a victim wallet's HF / due-date alerts right before a
 *  grace window is alert suppression, not settings churn.
 *  Idempotent: unlinking a wallet with no link is still `ok`. */
async function handleUnlinkTelegram(
  req: Request,
  env: Env,
): Promise<Response> {
  const corsOrigin = resolveAllowedOrigin(req, env);
  const read = await readJsonBody(req, MAX_SIGNED_REQUEST_BODY_BYTES);
  if (!read.ok) return json({ error: read.error }, read.status, corsOrigin);
  const body = read.value;
  const parsed = parseSignedLinkRequest(body);
  if (!parsed.ok) {
    return json(
      { error: 'invalid-payload', reason: parsed.reason },
      400,
      corsOrigin,
    );
  }
  const verified = await authoriseAlertRequest(req, env, parsed.req, 'unlink');
  if (!verified.ok) return refusal(verified, corsOrigin);
  // The clear's SCOPE follows the authority that signed (#2013 round
  // 3 P1). An ECDSA key is the wallet's universal controller, so its
  // unlink honours the privacy promise wallet-wide (see
  // unlinkTelegram). A smart account verified via its contract has
  // authority only on the chain whose contract approved — divergent
  // per-chain controllers are real (Safe owners drift apart) — so a
  // chain-verified unlink clears exactly the signed chain_id's rows,
  // and silencing the wallet's other chains needs each chain's own
  // controller to sign.
  if (verified.via === 'chain') {
    await unlinkTelegramOnChain(env.DB, parsed.req.wallet, parsed.req.chain_id);
  } else {
    await unlinkTelegram(env.DB, parsed.req.wallet);
  }
  // The response NAMES the scope that applied (#2013 round 4 P1), so
  // the app can confirm honestly instead of announcing a wallet-wide
  // disconnect a chain-scoped authority did not buy.
  return json(
    { ok: true, scope: verified.via === 'chain' ? 'chain' : 'wallet' },
    200,
    corsOrigin,
  );
}

/** UX-012 — push a single test alert to the wallet's linked Telegram
 *  chat. Signature-gated over the `test-alert`-scoped message: sending
 *  a Telegram message is an outbound side-effect, so it earns the same
 *  ownership proof as link / unlink — otherwise a spoofed-Origin caller
 *  who knows a linked wallet's public address could spam that user's
 *  chat. Returns 404 `not-linked` when no chat id is stored yet (the
 *  handshake never completed), which is exactly the fumbled-handshake
 *  case this round-trip exists to catch. */
/** Minimum seconds between test-alert sends for one wallet. A signed
 *  body is replay-valid for the full ±600s window, and each send is a
 *  real Telegram message; this per-wallet cooldown bounds a copied body
 *  or a buggy retry loop to one message per minute (Codex #1175). One
 *  legitimate test proves the link, so a 60s floor never impedes the
 *  real flow. */
const TEST_ALERT_COOLDOWN_SECONDS = 60;

async function handleTestTelegram(req: Request, env: Env): Promise<Response> {
  const corsOrigin = resolveAllowedOrigin(req, env);
  if (!env.TG_BOT_TOKEN) {
    return json({ error: 'bot-not-configured' }, 503, corsOrigin);
  }
  const read = await readJsonBody(req, MAX_SIGNED_REQUEST_BODY_BYTES);
  if (!read.ok) return json({ error: read.error }, read.status, corsOrigin);
  const body = read.value;
  const parsed = parseSignedLinkRequest(body);
  if (!parsed.ok) {
    return json(
      { error: 'invalid-payload', reason: parsed.reason },
      400,
      corsOrigin,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const verified = await authoriseAlertRequest(req, env, parsed.req, 'test-alert', now);
  if (!verified.ok) return refusal(verified, corsOrigin);
  const linked = await getTelegramChatId(
    env.DB,
    parsed.req.wallet,
    parsed.req.chain_id,
  );
  if (!linked) {
    // No chat stored — the bot handshake didn't complete. Distinct 404
    // so the frontend can say "send the code to the bot first" rather
    // than pretend the test succeeded.
    return json({ error: 'not-linked' }, 404, corsOrigin);
  }
  // Replay/loop protection: a valid signature stays usable for the whole
  // 10-minute window. Reserve the per-wallet slot with an ATOMIC
  // compare-and-set BEFORE sending, so parallel replays of one body
  // can't each read the same old timestamp and all fire — only the one
  // request that flips the stamp wins; the rest get 429. Reserving
  // before the send means a failed send still holds the slot (the user
  // waits out the cooldown), the race-free trade the guarantee needs.
  const reserved = await reserveTestAlert(
    env.DB,
    parsed.req.wallet,
    parsed.req.chain_id,
    now,
    TEST_ALERT_COOLDOWN_SECONDS,
  );
  if (!reserved) {
    return json({ error: 'rate-limited' }, 429, corsOrigin);
  }
  // `sendMessage` returns whether Telegram accepted the send. A silent
  // failure here would let the frontend mark the wallet "verified" when
  // the message never arrived, so surface a hard failure as 502 and
  // keep the round-trip honest.
  // EXPLICIT, not truthy (#2213 r24 `4015538638`). `sendMessage` now returns
  // a verdict rather than a boolean, and every non-accepted verdict is a
  // non-empty string — so a surviving `if (!ok)` would read a refusal as
  // success, which is the exact silent-misread this PR keeps finding.
  const outcome = await sendMessage(
    env.TG_BOT_TOKEN,
    linked.chatId,
    testAlert(linked.locale),
  );
  if (outcome !== 'accepted') {
    return json({ error: 'send-failed' }, 502, corsOrigin);
  }
  return json({ ok: true }, 200, corsOrigin);
}

async function handleTelegramWebhook(
  req: Request,
  env: Env,
): Promise<Response> {
  if (!env.TG_BOT_TOKEN) {
    return new Response('bot-not-configured', { status: 503 });
  }
  // Only Telegram's own deliveries (#2753): the webhook is registered
  // with a secret derived from the bot token, and Telegram returns it
  // on every update. Anything else is refused before its body is read.
  if (!(await isTelegramDelivery(req, env.TG_BOT_TOKEN))) {
    return new Response('unauthorized', { status: 401 });
  }

  const read = await readJsonBody(req, MAX_TELEGRAM_UPDATE_BYTES);
  if (!read.ok) return new Response(read.error, { status: read.status });
  const update = read.value as TelegramUpdate;

  const extracted = extractLinkCode(update);
  if (!extracted) {
    // Not a code — ignore silently. Telegram expects 200 for acked
    // updates; replying 200 stops it from retrying the push.
    return new Response('ok', { status: 200 });
  }
  const { chatId, code } = extracted;
  const match = await consumeTelegramLinkCode(env.DB, code);
  if (!match) {
    // No locale to look up (the row didn't resolve); fall back to en.
    await sendMessage(env.TG_BOT_TOKEN, chatId, handshakeExpired('en'));
    return new Response('ok', { status: 200 });
  }

  await linkTelegram(env.DB, match.wallet, match.chainId, chatId);
  const walletShort = `${match.wallet.slice(0, 8)}…${match.wallet.slice(-6)}`;
  await sendMessage(
    env.TG_BOT_TOKEN,
    chatId,
    handshakeLinked(match.locale, walletShort, match.chainId),
  );
  return new Response('ok', { status: 200 });
}

// ─── CORS helpers ──────────────────────────────────────────────────

/**
 * The CORS policy is a function of `FRONTEND_ORIGIN` ALONE, so these helpers
 * take that field rather than the resolved `Env` (#2252 r3 P1). The
 * maintenance branch answers BEFORE `resolveEnv`, and a CORS policy that
 * demanded a resolved env would have forced either a duplicate policy there
 * or a resolve the branch exists to avoid. `FRONTEND_ORIGIN` is a plain var,
 * present identically on the raw and resolved envs.
 */
type CorsEnv = { FRONTEND_ORIGIN?: string };

function preflight(req: Request, env: CorsEnv): Response {
  const origin = req.headers.get('Origin') ?? '';
  if (!isOriginMatch(origin, env)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function isAllowedOrigin(req: Request, env: CorsEnv): boolean {
  const origin = req.headers.get('Origin') ?? '';
  return isOriginMatch(origin, env);
}

function isOriginMatch(origin: string, env: CorsEnv): boolean {
  if (!origin) return false;
  return allowList(env).includes(origin);
}

/**
 * The configured origins, tolerating an ABSENT `FRONTEND_ORIGIN`.
 *
 * The type said `string` and the runtime does not guarantee it: it is a
 * wrangler var, and a deployment can simply not carry it. Both helpers used
 * to call `.split` on it directly, which threw a `TypeError` — harmless while
 * every caller sat behind route handling that would have failed anyway, and
 * NOT harmless once the maintenance branch runs before everything else
 * (#2252 r3 P1). A throw there turns the deliberate 503 into a 500, which is
 * precisely the indistinguishable failure the maintenance answer exists to
 * replace. Caught by the entry-point tests, which pass an env with no vars at
 * all — which is also what a maintenance build can look like.
 *
 * Empty entries are dropped so a trailing comma cannot put `''` in the list
 * and make an empty `Origin` header match. The parse is the shared one
 * (`@vaipakam/lib/originAllowList`), which the indexer's push channel
 * reads too (#2756).
 */
function allowList(env: CorsEnv): string[] {
  return parseOriginList(env.FRONTEND_ORIGIN);
}

/**
 * Resolve the CORS origin to echo back per request. Returns the
 * requesting Origin iff it appears in the allow-list; otherwise
 * the first allow-list entry as a safe fallback for non-browser
 * callers (curl / debug). The CORS spec requires
 * `Access-Control-Allow-Origin` to EXACTLY equal the inbound Origin
 * — returning a different allow-list entry, even one that's also
 * authorized, makes the browser reject the response.
 */
function resolveAllowedOrigin(req: Request, env: CorsEnv): string {
  const origin = req.headers.get('Origin') ?? '';
  const allow = allowList(env);
  if (origin && allow.includes(origin)) return origin;
  return allow[0] ?? '*';
}

function json(data: unknown, status: number, corsOrigin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

// ─── Body parsers ──────────────────────────────────────────────────

interface PutThresholdsBody {
  wallet: string;
  chain_id: number;
  /** #2000 — the HF bands are optional AS A SET: all three present
   *  (validated) or all three absent, meaning "no band change" — the
   *  stored values are preserved, same contract as `push_channel`
   *  and the pre-notify flag. The bands carry the risky lane's
   *  state, so a client save that did not touch that lane omits
   *  them; before this, a fresh device's default lane state rode
   *  along with every unrelated save. */
  warn_hf?: number;
  alert_hf?: number;
  critical_hf?: number;
  push_channel?: string | null;
  /** #1033 — opt-out for the periodic-interest pre-notify. Optional
   *  boolean in the body; absent means opted in (the historical
   *  behaviour, and what rows created before the column carry). */
  notify_maturity_approaching?: boolean;
}

export function parsePutThresholds(x: unknown): PutThresholdsBody | null {
  if (!x || typeof x !== 'object') return null;
  const b = x as Record<string, unknown>;
  if (typeof b.wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(b.wallet)) {
    return null;
  }
  if (typeof b.chain_id !== 'number') return null;
  // Bands: each field is a number or absent — a present-but-malformed
  // value is a bad request, never silently read as "no change" — and
  // presence is ALL-OR-NONE (#2000): a partial set has no coherent
  // meaning (the three values are one lane state), and letting one
  // band through alone would splice it into stored values no client
  // ever proposed together.
  for (const k of ['warn_hf', 'alert_hf', 'critical_hf'] as const) {
    if (b[k] !== undefined && typeof b[k] !== 'number') return null;
  }
  const bandCount = [b.warn_hf, b.alert_hf, b.critical_hf].filter(
    (v) => v !== undefined,
  ).length;
  if (bandCount !== 0 && bandCount !== 3) return null;
  if (bandCount === 3) {
    // Sanity: warn > alert > critical > 1.0 is the sensible ordering
    // (though the watcher handles arbitrary orderings safely).
    if (
      !(
        (b.warn_hf as number) > (b.alert_hf as number) &&
        (b.alert_hf as number) > (b.critical_hf as number)
      )
    ) {
      return null;
    }
    if ((b.critical_hf as number) <= 1) return null;
  }
  // #2754 — the only Push value a save can carry is the opt-in the app
  // sends; anything else is a bad request rather than a string stored
  // under a signature that only said "switch on".
  if (b.push_channel !== undefined && b.push_channel !== null && b.push_channel !== 'subscribed') {
    return null;
  }
  // Bands must be finite: the signed message writes them with String(n).
  for (const k of ['warn_hf', 'alert_hf', 'critical_hf'] as const) {
    if (b[k] !== undefined && !Number.isFinite(b[k])) return null;
  }
  if (!Number.isSafeInteger(b.chain_id) || (b.chain_id as number) <= 0) return null;
  const push = b.push_channel === 'subscribed' ? 'subscribed' : null;
  return {
    wallet: b.wallet,
    chain_id: b.chain_id,
    ...(bandCount === 3
      ? {
          warn_hf: b.warn_hf as number,
          alert_hf: b.alert_hf as number,
          critical_hf: b.critical_hf as number,
        }
      : {}),
    push_channel: push,
    // Absent/non-boolean → undefined = "no change": an older client
    // updating only its bands must not silently re-enable a stored
    // opt-out. New rows still default to opted in (column default).
    notify_maturity_approaching:
      typeof b.notify_maturity_approaching === 'boolean'
        ? b.notify_maturity_approaching
        : undefined,
  };
}

// (The unsigned link/unlink body parser lived here until round 5 of
// #1056 — both endpoints now parse via `parseSignedLinkRequest` in
// linkAuth.ts.)
