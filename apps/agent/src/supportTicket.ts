/**
 * #1040 phase 1 — `POST /support/ticket`: capture a support request
 * from the alpha02 support widget into the shared D1 and notify the
 * operator over the ops-internal Telegram bot.
 *
 * Design notes:
 *  - The D1 row is the durable record. The Telegram notify is
 *    best-effort (warn-and-skip while the ops-bot secrets are unset,
 *    log-and-continue on send failure) — a notify outage must never
 *    lose a ticket, and a ticket write failure is surfaced honestly
 *    as 503 so the widget can point the user at the mailto path
 *    instead of pretending the report landed.
 *  - Two-bot policy: this alert is operator-read, so it rides
 *    TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID — never the user-facing
 *    TG_BOT_TOKEN.
 *  - No wallet identity is accepted or stored: a ticket needs a
 *    reply channel (optional email) and context, not an address. The
 *    diagnostics block arrives pre-redacted from the widget (the
 *    same redaction the report-issue path uses) and is size-capped
 *    again here — the Worker never trusts client-side caps.
 */
import type { Env } from './env';
import { insertSupportTicket } from './db';

const MAX_MESSAGE_CHARS = 2_000;
const MAX_DIAGNOSTICS_CHARS = 4_000;
const MAX_EMAIL_CHARS = 254;
const MAX_PAGE_CHARS = 200;

export interface SupportTicketBody {
  message: string;
  email: string | null;
  diagnostics: string | null;
  page: string | null;
  chainId: number | null;
}

/** Strict body validation — returns null on any shape violation.
 *  Exported for the vitest unit suite. */
export function parseSupportTicket(raw: unknown): SupportTicketBody | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.message !== 'string') return null;
  const message = o.message.trim();
  if (message.length === 0 || message.length > MAX_MESSAGE_CHARS) return null;

  let email: string | null = null;
  if (o.email !== undefined && o.email !== null) {
    if (typeof o.email !== 'string') return null;
    const trimmed = o.email.trim();
    if (trimmed !== '') {
      // Shape check only — a typo'd address costs the user their
      // reply channel, not the ticket; the widget says so.
      if (trimmed.length > MAX_EMAIL_CHARS || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return null;
      }
      email = trimmed;
    }
  }

  let diagnostics: string | null = null;
  if (o.diagnostics !== undefined && o.diagnostics !== null) {
    if (typeof o.diagnostics !== 'string') return null;
    // Cap server-side (never trust the client's cap); truncation is
    // marked so the operator knows the block is partial.
    diagnostics =
      o.diagnostics.length > MAX_DIAGNOSTICS_CHARS
        ? `${o.diagnostics.slice(0, MAX_DIAGNOSTICS_CHARS)}\n[truncated]`
        : o.diagnostics;
    if (diagnostics.trim() === '') diagnostics = null;
  }

  let page: string | null = null;
  if (o.page !== undefined && o.page !== null) {
    if (typeof o.page !== 'string') return null;
    page = o.page.trim().slice(0, MAX_PAGE_CHARS) || null;
  }

  let chainId: number | null = null;
  if (o.chainId !== undefined && o.chainId !== null) {
    if (
      typeof o.chainId !== 'number' ||
      !Number.isInteger(o.chainId) ||
      o.chainId <= 0
    ) {
      return null;
    }
    chainId = o.chainId;
  }

  return { message, email, diagnostics, page, chainId };
}

/** Short public ticket id. Crypto-random (no Math.random for
 *  anything user-visible), unambiguous alphabet, prefixed so it
 *  reads as a reference number in a mail subject. */
export function newTicketId(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `VPK-${out}`;
}

function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}

const json = (data: unknown, status: number, corsOrigin: string) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });

export async function handleSupportTicket(
  req: Request,
  env: Env,
  corsOrigin: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  // Per-IP rate limit — skipped silently when the binding isn't
  // configured (local dev), same posture as the other agent gates.
  const limiter = env.SUPPORT_TICKET_RATELIMIT;
  if (limiter) {
    try {
      const result = await limiter.limit({ key: clientIp(req) });
      if (!result.success) {
        return json({ error: 'rate_limited' }, 429, corsOrigin);
      }
    } catch {
      /* fail open — the limiter is an abuse net, not a gate */
    }
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: 'invalid-json' }, 400, corsOrigin);
  }
  const body = parseSupportTicket(raw);
  if (body === null) {
    return json({ error: 'invalid-ticket' }, 400, corsOrigin);
  }

  const ticketId = newTicketId();
  try {
    await insertSupportTicket(env.DB, {
      ticketId,
      message: body.message,
      email: body.email,
      diagnostics: body.diagnostics,
      page: body.page,
      chainId: body.chainId,
    });
  } catch (e) {
    // Includes the migration-not-applied case on a fresh env — an
    // honest 503 lets the widget steer the user to the mailto path.
    console.error('[support] ticket insert failed', e);
    return json({ error: 'unavailable' }, 503, corsOrigin);
  }

  // Best-effort ops notify — the ticket is already durable, and the
  // RESPONSE must not wait on Telegram: the widget aborts after 8s,
  // and a stalled notify would show "didn't go through" for a ticket
  // that landed, inviting duplicate resends (Codex round-1 P2). The
  // send runs after the response via waitUntil (falling back to
  // fire-and-forget where no ExecutionContext exists, e.g. tests).
  const notify = notifyOpsNewTicket(env, ticketId, body);
  if (ctx) ctx.waitUntil(notify);

  return json({ ticketId }, 200, corsOrigin);
}

/** Post the new-ticket alert to the ops bot. Never throws — a notify
 *  outage must never surface as a ticket failure. Exported for the
 *  vitest suite. */
export async function notifyOpsNewTicket(
  env: Env,
  ticketId: string,
  body: SupportTicketBody,
): Promise<void> {
  const token = env.TG_OPS_BOT_TOKEN;
  const chatId = env.TG_OPS_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[support] TG_OPS_* unset — skipping new-ticket notify');
    return;
  }
  try {
    // METADATA ONLY — deliberately no message text. Telegram is a
    // third-party processor, and the pre-send disclosure promises
    // the user's words are stored on Vaipakam's support service
    // under the ticket number, not forwarded elsewhere (Codex
    // round-2 P2). The operator reads the full ticket in D1.
    const text = [
      `🧾 New support ticket ${ticketId}`,
      body.page ? `page: ${body.page}` : null,
      body.chainId !== null ? `chain: ${body.chainId}` : null,
      body.email ? 'reply address: provided' : 'reply address: none',
      body.diagnostics ? 'diagnostics: attached' : 'diagnostics: not attached',
    ]
      .filter((l): l is string => l !== null)
      .join('\n');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error('[support] ops notify failed', res.status);
    }
  } catch (e) {
    console.error('[support] ops notify failed', e);
  }
}
