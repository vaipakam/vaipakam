/**
 * Cloudflare Worker entry — three entry points:
 *   1. scheduled(): cron-trigger HF watcher loop.
 *   2. fetch():     HTTP handlers for the frontend Settings page
 *                   (GET/PUT thresholds, POST link-code request) +
 *                   the Telegram webhook (POST /tg/webhook).
 */

import type { Env } from './env';
import { runWatcher } from './watcher';
import {
  consumeTelegramLinkCode,
  issueTelegramLinkCode,
  linkTelegram,
  upsertThresholds,
} from './db';
import { extractLinkCode, sendMessage, type TelegramUpdate } from './telegram';
import { handshakeExpired, handshakeLinked } from './i18n';
import { handle0xQuote, handle1inchQuote } from './quoteProxy';
import { handleBlockaidScan } from './scanProxy';
import {
  handleActiveLoansFrameInitial,
  handleActiveLoansFramePost,
  handleActiveLoansFrameImage,
} from './frames';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runWatcher(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Preflight: allow the frontend origin with credentials.
    if (req.method === 'OPTIONS') {
      return preflight(req, env);
    }

    // Telegram webhook — no CORS, external caller. BotFather set this
    // via `setWebhook`, see README. Handles the handshake by matching
    // a 6-digit code in the incoming message.
    if (url.pathname === '/tg/webhook' && req.method === 'POST') {
      return handleTelegramWebhook(req, env);
    }

    // Phase 9.B — Farcaster Frame: active-loan check. No CORS, no
    // origin gate. The Frame is intentionally embeddable from any
    // Farcaster client; the GET path returns the Frame metadata HTML,
    // the POST path handles button clicks, and the image path serves
    // an SVG card. Public read-only — no signing, no chain writes.
    if (url.pathname === '/frames/active-loans' && req.method === 'GET') {
      return handleActiveLoansFrameInitial(req, env);
    }
    if (url.pathname === '/frames/active-loans' && req.method === 'POST') {
      return handleActiveLoansFramePost(req, env);
    }
    if (
      url.pathname === '/frames/active-loans/image' &&
      req.method === 'GET'
    ) {
      return handleActiveLoansFrameImage(req);
    }

    // Frontend-facing endpoints — all require the origin header to
    // match FRONTEND_ORIGIN.
    if (!isAllowedOrigin(req, env)) {
      return new Response('Forbidden', { status: 403 });
    }

    if (url.pathname === '/thresholds' && req.method === 'PUT') {
      return handlePutThresholds(req, env);
    }

    if (url.pathname === '/link/telegram' && req.method === 'POST') {
      return handleIssueTelegramLink(req, env);
    }

    // Phase 7a — aggregator quote proxies. Frontend posts the (chain,
    // tokens, amount, taker) tuple; worker proxies to 0x or 1inch with
    // server-side API key injected, returns the aggregator's JSON
    // pass-through. Used by the LiquidateButton's quote orchestrator.
    if (url.pathname === '/quote/0x' && req.method === 'POST') {
      return handle0xQuote(req, env);
    }
    if (url.pathname === '/quote/1inch' && req.method === 'POST') {
      return handle1inchQuote(req, env);
    }

    // Phase 8b.2 — Blockaid Transaction Scanner proxy. Frontend posts
    // the pending tx (chainId, from, to, data, value); the worker
    // injects the operator-held Blockaid key server-side and returns
    // the scanner JSON pass-through. Used by the `useTxSimulation`
    // preview hook on review modals.
    if (url.pathname === '/scan/blockaid' && req.method === 'POST') {
      return handleBlockaidScan(req, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ─── HTTP handlers ──────────────────────────────────────────────────────

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

  // NOTE: this handler trusts the `wallet` field in the JSON body —
  // that's fine for the settings flow because the Worker's only
  // output to that wallet is a Telegram alert linked to a chat the
  // real wallet holder controls. An attacker spamming someone else's
  // wallet into the thresholds table can't receive their alerts.
  // However, if the threshold settings ever start to drive on-chain
  // actions, switch this to an EIP-712-signed payload so msg.sender
  // parity is cryptographic.
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
  const parsed = parseLinkIssue(body);
  if (!parsed) return json({ error: 'invalid-payload' }, 400, corsOrigin);

  const code = await issueTelegramLinkCode(
    env.DB,
    parsed.wallet,
    parsed.chain_id,
  );
  // Build the Telegram deep link from the operator-configured bot
  // username (#00014). Both `TG_BOT_TOKEN` AND `TG_BOT_USERNAME` must
  // be set: the token authenticates message sends, the username is
  // the user-visible handle in the `https://t.me/<handle>?start=...`
  // deep link. Without the username we deliberately return a null
  // bot_url so the frontend falls back to a copy-the-code flow
  // instead of pointing users at a placeholder bot they can't reach.
  const botUrl =
    env.TG_BOT_TOKEN && env.TG_BOT_USERNAME
      ? `https://t.me/${encodeURIComponent(env.TG_BOT_USERNAME)}?start=${code}`
      : null;
  return json(
    {
      ok: true,
      code,
      bot_url: botUrl,
    },
    200,
    corsOrigin,
  );
}

async function handleTelegramWebhook(
  req: Request,
  env: Env,
): Promise<Response> {
  if (!env.TG_BOT_TOKEN) return new Response('bot-not-configured', { status: 503 });

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

// ─── Helpers ─────────────────────────────────────────────────────────────

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
 * Resolve the CORS origin to echo back per request. Mirrors the
 * matching helper in `scanProxy.ts`. Returns the requesting Origin
 * iff it appears in the allow-list; otherwise returns the first
 * allow-list entry as a safe fallback for non-browser callers
 * (curl / debug). The CORS spec requires
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

interface PutThresholdsBody {
  wallet: string;
  chain_id: number;
  warn_hf: number;
  alert_hf: number;
  critical_hf: number;
  push_channel?: string | null;
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
  const push =
    typeof b.push_channel === 'string' ? b.push_channel : null;
  return {
    wallet: b.wallet,
    chain_id: b.chain_id,
    warn_hf: b.warn_hf,
    alert_hf: b.alert_hf,
    critical_hf: b.critical_hf,
    push_channel: push,
  };
}

interface LinkIssueBody {
  wallet: string;
  chain_id: number;
}

function parseLinkIssue(x: unknown): LinkIssueBody | null {
  if (!x || typeof x !== 'object') return null;
  const b = x as Record<string, unknown>;
  if (typeof b.wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(b.wallet)) {
    return null;
  }
  if (typeof b.chain_id !== 'number') return null;
  return { wallet: b.wallet, chain_id: b.chain_id };
}
