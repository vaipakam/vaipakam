/**
 * Minimal Telegram Bot API helpers — just enough to send a message and
 * handle webhook-pushed updates for the handshake flow.
 */

const TELEGRAM_API = 'https://api.telegram.org';

/** Send a plain-text message to a chat. No formatting — keeps the
 *  alert body robust against Telegram Markdown / HTML parser quirks. */
export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    // Don't throw — swallow failures so one bad chat id doesn't halt
    // the whole cron tick. The next tick retries on the next band
    // change (most band changes persist >1 tick).
    const body = await res.text().catch(() => '');
    console.error(
      `Telegram sendMessage failed: chat=${chatId} status=${res.status} body=${body.slice(0, 200)}`,
    );
  }
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
 *  Returns the chat id + the message body if it's a 6-digit code,
 *  otherwise null — we ignore anything that doesn't look like a
 *  handshake attempt so regular bot chat doesn't spam the log. */
export function extractLinkCode(update: TelegramUpdate): {
  chatId: string;
  code: string;
} | null {
  const chatId = update?.message?.chat?.id;
  const text = update?.message?.text?.trim() ?? '';
  if (!chatId) return null;
  const match = text.match(/^\d{6}$/);
  if (!match) return null;
  return { chatId: String(chatId), code: match[0] };
}

export function formatAlert(
  band: 'warn' | 'alert' | 'critical',
  opts: {
    chainName: string;
    loanId: number;
    hf: number;
    frontendOrigin: string;
  },
): string {
  const tag =
    band === 'critical'
      ? '🚨 CRITICAL'
      : band === 'alert'
        ? '⚠ ALERT'
        : 'Heads up';
  const hfStr = opts.hf.toFixed(3);
  const link = `${opts.frontendOrigin}/app/loans/${opts.loanId}`;
  return `${tag}: your Vaipakam loan on ${opts.chainName} (loan #${opts.loanId}) has HF ${hfStr}. Liquidation triggers at HF < 1.00. Review your position: ${link}`;
}
