/**
 * Telegram delivery via the OPS-internal bot.
 *
 * `TG_OPS_BOT_TOKEN`, never `TG_BOT_TOKEN`. The two bots are split by
 * audience (CLAUDE.md, "Two Telegram bots"): the user-facing bot posts to
 * user-supplied chat ids from apps/keeper and apps/agent; this one posts
 * to a single operator chat. Splitting them bounds the blast radius of a
 * token leak in either direction — a user-bot compromise cannot spoof the
 * detection signals the operator acts on, and an ops-bot compromise
 * cannot reach user alert channels.
 */

const TELEGRAM_MAX_CHARS = 4096;

export interface TelegramTarget {
  token: string;
  chatId: string;
}

/** Escape for Telegram's legacy `Markdown` parse mode. */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[\]])/g, '\\$1');
}

/**
 * Post one message, truncating to Telegram's limit.
 *
 * @returns `true` when Telegram accepted the message. Delivery failure is
 *          reported, never thrown: one failed post must not abort a tick
 *          that still has other alerts to deliver and streak state to
 *          persist.
 */
export async function sendOpsMessage(
  target: TelegramTarget,
  text: string,
): Promise<boolean> {
  const body =
    text.length > TELEGRAM_MAX_CHARS
      ? `${text.slice(0, TELEGRAM_MAX_CHARS - 24)}\n… (truncated)`
      : text;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${target.token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: target.chatId,
          text: body,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      console.error(
        `telegram sendMessage failed: ${res.status} ${await res.text()}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `telegram sendMessage threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Render one finding as an operator-readable message. */
export function formatAlert(args: {
  severity: 'critical' | 'advisory';
  title: string;
  chainLabel: string;
  detail: string;
  footer?: string;
}): string {
  const badge = args.severity === 'critical' ? '🔴 CRITICAL' : '🟡 ADVISORY';
  const lines = [
    `${badge} — VPFI recycling mesh`,
    `*${escapeMarkdown(args.title)}*`,
    `chain: ${escapeMarkdown(args.chainLabel)}`,
    '',
    '```',
    args.detail,
    '```',
  ];
  if (args.footer) lines.push('', escapeMarkdown(args.footer));
  return lines.join('\n');
}
