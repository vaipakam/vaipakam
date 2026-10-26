/**
 * Minimal Telegram Bot API helpers — just enough to send a message and
 * handle webhook-pushed updates for the handshake flow.
 */

const TELEGRAM_API = 'https://api.telegram.org';

/** Send a plain-text message to a chat. No formatting — keeps the
 *  alert body robust against Telegram Markdown / HTML parser quirks.
 *
 *  Never throws — swallows failures (logs them) so one bad chat id
 *  doesn't halt the whole cron tick; the next tick retries on the next
 *  band change. Returns whether Telegram accepted the send, so the
 *  UX-012 test-alert round-trip can distinguish a real delivery from a
 *  silent failure (the cron callers simply ignore the boolean). */
/**
 * What became of one Telegram send.
 *
 * FOUR ANSWERS, because four different things should happen next (#2213 r24
 * `4015538638`, extended r26 `4015927527`).
 *
 * A boolean first flattened a definitive refusal into a transport failure.
 * Fixing that left `refused` covering a second pair that is just as
 * different: an HTTP 429 or a 5xx is the service saying "not now", where a
 * 400 or a 401 is the service saying "not ever, as configured". Filing a
 * passing rate-limit under the bucket whose stated meaning is "will keep
 * failing until someone repairs it" sends an operator to rotate a credential
 * during an incident that would have cleared itself.
 *
 * - `accepted`  — it went.
 * - `refused`   — answered NO about the request or the caller. Needs a person.
 * - `transient` — answered "not now" (429, 5xx). Needs nobody; it retries.
 * - `unknown`   — nothing answered. May or may not have arrived.
 *
 * All four are distinguishable structurally, from the status or from whether
 * a response came back at all. None requires parsing a message.
 */
export type TelegramOutcome = 'accepted' | 'refused' | 'transient' | 'unknown';

export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<TelegramOutcome> {
  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    // Network-level failure (DNS, timeout) — same swallow policy. NOTHING
    // came back, so whether the message arrived is genuinely unknown.
    console.error(`Telegram sendMessage threw: chat=${chatId} err=${err}`);
    return 'unknown';
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(
      `Telegram sendMessage failed: chat=${chatId} status=${res.status} body=${body.slice(0, 200)}`,
    );
    // WHICH KIND OF NO (#2213 r26 `4015927527`). 429 is rate limiting and 5xx
    // is the service being unwell — both clear on their own. 4xx otherwise is
    // the request or the credential, which does not.
    if (res.status === 429 || res.status >= 500) return 'transient';
    return 'refused';
  }
  return 'accepted';
}

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number; username?: string };
    from?: { id?: number; username?: string };
    text?: string;
  };
}

/**
 * The link code a user sends the bot (#2753). It was a 6-digit
 * `Math.random()` number with a 10-minute life: a million values, from a
 * generator that is not built to be unpredictable, presented to a webhook
 * that anyone could post to. A caller who guessed a live code linked the
 * victim wallet's alerts to their own chat.
 *
 * Now 24 characters from a 32-symbol alphabet, drawn from the Web Crypto
 * generator: 120 bits, which no number of guesses inside ten minutes
 * comes near. The alphabet leaves out 0, 1, I and O so a code read off
 * the screen cannot be mistyped into another, and it fits Telegram's
 * `?start=` deep-link parameter as it is. Each byte maps to a symbol by
 * its low five bits, and 256 is a multiple of 32, so every symbol is
 * equally likely.
 */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LINK_CODE_LENGTH = 24;

export function newLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LINK_CODE_LENGTH));
  return [...bytes].map((b) => LINK_CODE_ALPHABET[b & 31]).join('');
}

const LINK_CODE_RE = new RegExp(
  `^(?:/start(?:@\\w+)?\\s+)?([${LINK_CODE_ALPHABET}]{${LINK_CODE_LENGTH}})$`,
  'i',
);

/** Parse the text payload in an incoming Telegram webhook update.
 *  Returns the chat id + the handshake code, otherwise null — we
 *  ignore anything that doesn't look like a handshake attempt so
 *  regular bot chat doesn't spam the log.
 *
 *  Two accepted shapes (#1056 round 6):
 *   - a bare code — the copy-the-code fallback flow;
 *   - `/start <code>` (optionally `/start@BotName <code>`) — what
 *     Telegram actually delivers when the user follows the
 *     `https://t.me/<bot>?start=<code>` deep link and presses
 *     Start. Only matching the bare shape made the advertised
 *     one-tap flow silently never link.
 *
 *  A typed code is read case-blind and stored upper-case. */
export function extractLinkCode(update: TelegramUpdate): {
  chatId: string;
  code: string;
} | null {
  const chatId = update?.message?.chat?.id;
  const text = update?.message?.text?.trim() ?? '';
  if (!chatId) return null;
  const match = text.match(LINK_CODE_RE);
  if (!match) return null;
  return { chatId: String(chatId), code: match[1]!.toUpperCase() };
}

/**
 * The secret Telegram sends back on every webhook delivery (#2753).
 *
 * `setWebhook` takes a `secret_token`, and Telegram echoes it in the
 * `X-Telegram-Bot-Api-Secret-Token` header of every update it posts. The
 * webhook used to check nothing, so any caller could post updates as if
 * from Telegram.
 *
 * The secret is DERIVED from the bot token rather than stored beside it:
 * HMAC-SHA256 keyed by the token over a fixed label, in hex. So there is no
 * second secret to provision or to fall out of step with the token, a token
 * rotation changes the secret in the same step (the rotation runbook
 * re-registers the webhook anyway), and the header reveals nothing about
 * the token. `scripts/register-telegram-webhook.mjs` registers the webhook
 * with the same value.
 */
export const WEBHOOK_SECRET_LABEL = 'vaipakam-telegram-webhook-v1';

export async function webhookSecret(botToken: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(botToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(WEBHOOK_SECRET_LABEL));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True only when the request carries the webhook secret. Compared over
 *  every character, so the time taken says nothing about how much of a
 *  guess was right. */
export async function isTelegramDelivery(req: Request, botToken: string): Promise<boolean> {
  const presented = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  const expected = await webhookSecret(botToken);
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// `formatAlert` was moved to `./i18n.ts` (Phase 3b) so the message
// body can be sent in the user's preferred locale. Keep this file
// focused on raw Telegram API helpers.
