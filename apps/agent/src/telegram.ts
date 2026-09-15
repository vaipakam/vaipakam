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

/** Parse the text payload in an incoming Telegram webhook update.
 *  Returns the chat id + the 6-digit handshake code, otherwise null
 *  — we ignore anything that doesn't look like a handshake attempt
 *  so regular bot chat doesn't spam the log.
 *
 *  Two accepted shapes (#1056 round 6):
 *   - a bare `123456` — the copy-the-code fallback flow;
 *   - `/start 123456` (optionally `/start@BotName 123456`) — what
 *     Telegram actually delivers when the user follows the
 *     `https://t.me/<bot>?start=<code>` deep link and presses
 *     Start. Only matching the bare shape made the advertised
 *     one-tap flow silently never link. */
export function extractLinkCode(update: TelegramUpdate): {
  chatId: string;
  code: string;
} | null {
  const chatId = update?.message?.chat?.id;
  const text = update?.message?.text?.trim() ?? '';
  if (!chatId) return null;
  const match = text.match(/^(?:\/start(?:@\w+)?\s+)?(\d{6})$/);
  if (!match) return null;
  return { chatId: String(chatId), code: match[1]! };
}

// `formatAlert` was moved to `./i18n.ts` (Phase 3b) so the message
// body can be sent in the user's preferred locale. Keep this file
// focused on raw Telegram API helpers.
