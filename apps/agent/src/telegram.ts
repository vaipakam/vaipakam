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
export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<boolean> {
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
    // Network-level failure (DNS, timeout) — same swallow policy.
    console.error(`Telegram sendMessage threw: chat=${chatId} err=${err}`);
    return false;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(
      `Telegram sendMessage failed: chat=${chatId} status=${res.status} body=${body.slice(0, 200)}`,
    );
    return false;
  }
  return true;
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
