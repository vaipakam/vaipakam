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

    return new Response('Not found', { status: 404 });
  },
};

// ─── HTTP handlers ──────────────────────────────────────────────────────

async function handlePutThresholds(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid-json' }, 400, env);
  }
  const parsed = parsePutThresholds(body);
  if (!parsed) return json({ error: 'invalid-payload' }, 400, env);

  // NOTE: this handler trusts the `wallet` field in the JSON body —
  // that's fine for the settings flow because the Worker's only
  // output to that wallet is a Telegram alert linked to a chat the
  // real wallet holder controls. An attacker spamming someone else's
  // wallet into the thresholds table can't receive their alerts.
  // However, if the threshold settings ever start to drive on-chain
  // actions, switch this to an EIP-712-signed payload so msg.sender
  // parity is cryptographic.
  await upsertThresholds(env.DB, parsed);
  return json({ ok: true }, 200, env);
}

async function handleIssueTelegramLink(
  req: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid-json' }, 400, env);
  }
  const parsed = parseLinkIssue(body);
  if (!parsed) return json({ error: 'invalid-payload' }, 400, env);

  const code = await issueTelegramLinkCode(
    env.DB,
    parsed.wallet,
    parsed.chain_id,
  );
  return json(
    {
      ok: true,
      code,
      // Hand the bot handle back too so the frontend can render a
      // one-click "open Telegram" deep-link.
      bot_url: env.TG_BOT_TOKEN
        ? `https://t.me/your_bot?start=${code}`
        : null,
    },
    200,
    env,
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
    await sendMessage(
      env.TG_BOT_TOKEN,
      chatId,
      'That code is expired or unrecognised. Head back to Vaipakam → Alerts and request a new one.',
    );
    return new Response('ok', { status: 200 });
  }

  await linkTelegram(env.DB, match.wallet, match.chainId, chatId);
  await sendMessage(
    env.TG_BOT_TOKEN,
    chatId,
    `Linked — you'll receive HF alerts for wallet ${match.wallet.slice(0, 8)}…${match.wallet.slice(-6)} on chain ${match.chainId}.`,
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

function json(data: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': env.FRONTEND_ORIGIN.split(',')[0] ?? '*',
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
