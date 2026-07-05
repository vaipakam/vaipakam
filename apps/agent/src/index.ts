/**
 * apps/agent Worker entry — proactive notifications + cross-chain
 * monitoring + operator services + public Frames + Telegram bot +
 * diagnostics record.
 *
 * Stage 3 PR4 of the Worker split (see
 * `docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`). The agent is
 * the broadest of the three Workers — it inherits everything from
 * the ops/hf-watcher monolith that's NOT the HF watcher loop
 * (apps/keeper) or the chain-event scan + read API (apps/indexer).
 *
 * `scheduled()` (cron — every minute):
 *   - `runPeriodicPreNotify`     — push borrowers (priority) and
 *                                  lenders (courtesy) before the
 *                                  next interest-payment checkpoint.
 *   - `pruneOldDiagErrors`       — diagnostics retention prune.
 *
 * `runDailyOracleSnapshot` USED to live here but moved to
 * `apps/keeper` in the Stage 3 architectural-rebalance commit
 * (matches the staging plan §2 least-privilege contract:
 * `KEEPER_PRIVATE_KEY` lives on exactly one Worker — the keeper).
 * Agent therefore no longer signs ANY on-chain transaction; a
 * compromised agent can produce stale notifications but can't
 * move funds.
 *
 * `fetch()`:
 *   POST /tg/webhook                        — Telegram bot handshake
 *   GET  /frames/active-loans               — Farcaster Frame initial
 *   POST /frames/active-loans               — Frame button click
 *   GET  /frames/active-loans/image         — Frame SVG image
 *   POST /quote/0x                          — 0x v2 aggregator proxy
 *   POST /quote/1inch                       — 1inch v6 aggregator proxy
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
 *
 * The `/thresholds`, `/link/telegram`, `/diag/record`,
 * `/diag/erasure`, `/diag/erasure/status` and `/diag/legal-hold`
 * endpoints are CORS-locked to `FRONTEND_ORIGIN` — `/diag/legal-hold`
 * is driven from the `apps/defi` protocol console, so it is a
 * browser-facing endpoint; its authorization is the signer's
 * on-chain `ADMIN_ROLE`, checked inside the handler. The Telegram
 * webhook + Frames + quote proxies have their own CORS posture (no
 * origin gate — Telegram and Farcaster post from arbitrary
 * infrastructure, and the proxies are paired to the aggregator
 * origins they wrap).
 *
 * ET-001 — there is no transaction-scan proxy. The pre-sign
 * transaction preview runs entirely in the frontend as a viem
 * `eth_call` simulation against the chain's own RPC (no API key, so
 * no server-side proxy is needed); see `apps/defi`
 * `useTxSimulation`. The Blockaid → GoPlus migration was dropped:
 * GoPlus's Transaction Simulation API is mainnet-only (3 chains)
 * and Vaipakam runs on testnets — a free `eth_call` covers every
 * chain.
 */

import { resolveEnv, type Env, type WorkerEnv } from './env';
import { runPeriodicPreNotify } from './periodicPreNotify';
import { handle0xQuote, handle1inchQuote } from './quoteProxy';
import { handleOpenSeaListingPost } from './openseaProxy';
import { handleIntentFusionPost } from './intentFusionPost';
import { handleOpenSeaCollection } from './openseaCollectionProxy';
import { handleOpenSeaOffers } from './openseaOffersProxy';
import { handleOpenSeaSignedOffer } from './openseaSignedOfferProxy';
import { handleFeeRecipientPreflight } from './feeRecipientPreflight';
import { handleDiagRecord, pruneOldDiagErrors } from './diagRecord';
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
  issueTelegramLinkCode,
  linkTelegram,
  unlinkTelegram,
  upsertThresholds,
} from './db';
import { extractLinkCode, sendMessage, type TelegramUpdate } from './telegram';
import { handshakeExpired, handshakeLinked } from './i18n';
import {
  parseSignedLinkRequest,
  verifySignedLinkRequest,
} from './linkAuth';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    // T-078 — resolve the Secrets Store bindings once, here at the
    // entry point; all three passes get the plain resolved env.
    const resolved = await resolveEnv(env);
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
  },

  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);

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

    // Aggregator quote proxies — CORS handled inside the route
    // handlers (paired to the aggregator origin policy). Frontend
    // posts the (chain, tokens, amount, taker) tuple; worker
    // injects the operator-held API key server-side and returns the
    // aggregator JSON pass-through.
    if (url.pathname === '/quote/0x' && req.method === 'POST') {
      return handle0xQuote(req, resolved);
    }
    if (url.pathname === '/quote/1inch' && req.method === 'POST') {
      return handle1inchQuote(req, resolved);
    }
    // T-090 v1.1 (#389) Sub 3 (#418) — Fusion resolver-pickup proxy.
    // Dapp posts the orderHash + structured Fusion order + commit
    // tx hash after the borrower's `commitSwapToRepayIntent` lands.
    // Worker forwards to 1inch Fusion's resolver-pickup endpoint
    // server-side (key stays Vaipakam-side) and returns the
    // upstream JSON pass-through. v1.1 launch: handler validates +
    // queues; real upstream `fetch` lands in the v1.1 GA card.
    if (url.pathname === '/intent/fusion/post' && req.method === 'POST') {
      return handleIntentFusionPost(
        req,
        resolved,
        resolveAllowedOrigin(req, resolved),
      );
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

    if (url.pathname === '/thresholds' && req.method === 'PUT') {
      return handlePutThresholds(req, resolved);
    }
    if (url.pathname === '/link/telegram' && req.method === 'POST') {
      return handleIssueTelegramLink(req, resolved);
    }
    if (url.pathname === '/unlink/telegram' && req.method === 'POST') {
      return handleUnlinkTelegram(req, resolved);
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
    // the apps/defi protocol console. Browser-facing, so Origin-gated
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

async function handlePutThresholds(req: Request, env: Env): Promise<Response> {
  const corsOrigin = resolveAllowedOrigin(req, env);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid-json' }, 400, corsOrigin);
  }
  const parsed = parsePutThresholds(body);
  if (!parsed) return json({ error: 'invalid-payload' }, 400, corsOrigin);

  // NOTE: this handler trusts the `wallet` field in the JSON body for
  // plain settings writes — fine, because the Worker's only output to
  // that wallet is a Telegram alert linked to a chat the real wallet
  // holder controls, and band tampering stays bounded (the strictly-
  // decreasing >1.0 rule keeps a final pre-liquidation warning).
  //
  // The ONE write that needs more is DISABLING the due-date reminder
  // (#1056 round 6): notify_maturity_approaching=false silences both
  // due-date lanes (agent reminder + keeper pre-grace warning), which
  // is the same alert-suppression threat that got /unlink/telegram
  // signed. So an opt-out write must carry the EIP-191 ownership
  // proof over the mute-scoped message; opted-in / field-absent
  // writes stay signature-free.
  if (parsed.notify_maturity_approaching === false) {
    const signed = parseSignedLinkRequest(body);
    if (!signed.ok) {
      return json(
        { error: 'signature-required', reason: signed.reason },
        401,
        corsOrigin,
      );
    }
    const verified = await verifySignedLinkRequest(
      signed.req,
      Math.floor(Date.now() / 1000),
      'mute-duedate',
    );
    if (!verified.ok) {
      return json(
        { error: 'verification_failed', reason: verified.reason },
        verified.status,
        corsOrigin,
      );
    }
  }
  // If the threshold settings ever start to drive on-chain actions,
  // extend the signed-payload requirement to every write so
  // msg.sender parity is cryptographic.
  await upsertThresholds(env.DB, parsed);
  return json({ ok: true }, 200, corsOrigin);
}

async function handleIssueTelegramLink(
  req: Request,
  env: Env,
): Promise<Response> {
  const corsOrigin = resolveAllowedOrigin(req, env);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid-json' }, 400, corsOrigin);
  }
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
  const verified = await verifySignedLinkRequest(
    parsed.req,
    Math.floor(Date.now() / 1000),
  );
  if (!verified.ok) {
    return json(
      { error: 'verification_failed', reason: verified.reason },
      verified.status,
      corsOrigin,
    );
  }

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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid-json' }, 400, corsOrigin);
  }
  const parsed = parseSignedLinkRequest(body);
  if (!parsed.ok) {
    return json(
      { error: 'invalid-payload', reason: parsed.reason },
      400,
      corsOrigin,
    );
  }
  const verified = await verifySignedLinkRequest(
    parsed.req,
    Math.floor(Date.now() / 1000),
    'unlink',
  );
  if (!verified.ok) {
    return json(
      { error: 'verification_failed', reason: verified.reason },
      verified.status,
      corsOrigin,
    );
  }
  // chain_id is bound into the signed message (same body shape as the
  // link issue) but the clear is wallet-wide — see unlinkTelegram for
  // why.
  await unlinkTelegram(env.DB, parsed.req.wallet);
  return json({ ok: true }, 200, corsOrigin);
}

async function handleTelegramWebhook(
  req: Request,
  env: Env,
): Promise<Response> {
  if (!env.TG_BOT_TOKEN) {
    return new Response('bot-not-configured', { status: 503 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return new Response('bad-json', { status: 400 });
  }

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

function preflight(req: Request, env: Env): Response {
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

function isAllowedOrigin(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin') ?? '';
  return isOriginMatch(origin, env);
}

function isOriginMatch(origin: string, env: Env): boolean {
  if (!origin) return false;
  const allow = env.FRONTEND_ORIGIN.split(',').map((s) => s.trim());
  return allow.includes(origin);
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
function resolveAllowedOrigin(req: Request, env: Env): string {
  const origin = req.headers.get('Origin') ?? '';
  const allow = env.FRONTEND_ORIGIN.split(',').map((s) => s.trim());
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
  warn_hf: number;
  alert_hf: number;
  critical_hf: number;
  push_channel?: string | null;
  /** #1033 — opt-out for the periodic-interest pre-notify. Optional
   *  boolean in the body; absent means opted in (the historical
   *  behaviour, and what rows created before the column carry). */
  notify_maturity_approaching?: boolean;
}

function parsePutThresholds(x: unknown): PutThresholdsBody | null {
  if (!x || typeof x !== 'object') return null;
  const b = x as Record<string, unknown>;
  if (typeof b.wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(b.wallet)) {
    return null;
  }
  if (typeof b.chain_id !== 'number') return null;
  if (
    typeof b.warn_hf !== 'number' ||
    typeof b.alert_hf !== 'number' ||
    typeof b.critical_hf !== 'number'
  ) {
    return null;
  }
  // Sanity: warn > alert > critical > 1.0 is the sensible ordering
  // (though the watcher handles arbitrary orderings safely).
  if (!(b.warn_hf > b.alert_hf && b.alert_hf > b.critical_hf)) return null;
  if (b.critical_hf <= 1) return null;
  const push = typeof b.push_channel === 'string' ? b.push_channel : null;
  return {
    wallet: b.wallet,
    chain_id: b.chain_id,
    warn_hf: b.warn_hf,
    alert_hf: b.alert_hf,
    critical_hf: b.critical_hf,
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
