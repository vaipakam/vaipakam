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
        // No `parse_mode` — PLAIN TEXT, deliberately.
        //
        // Alert bodies carry chain slugs and, on the failure path, raw RPC
        // error strings: text this Worker does not author and cannot
        // constrain. Under a markup mode every such string needs escaping,
        // and an escape that misses one metacharacter (backslash, say) lets
        // the input break back out — the alert then renders wrong, or
        // silently loses the figures the operator needs, exactly when
        // something is already going badly. Plain text has no
        // metacharacters to miss, so what is constructed is what is
        // delivered. Bold titles and code fences are not worth an
        // injection surface on a channel whose whole job is faithful
        // reporting.
        body: JSON.stringify({
          chat_id: target.chatId,
          text: body,
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

/**
 * Render one finding as an operator-readable message.
 *
 * Structure comes from emoji, indentation and blank lines rather than
 * markup, so the output needs no escaping and every figure survives
 * verbatim. See {@link sendOpsMessage} for why plain text.
 */
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
    args.title,
    `chain: ${args.chainLabel}`,
    '',
    args.detail,
  ];
  if (args.footer) lines.push('', args.footer);
  return lines.join('\n');
}
