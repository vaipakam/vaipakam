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

import { stripUrlPaths } from './redact';

const TELEGRAM_MAX_CHARS = 4096;

/** Per-message deadline. Well under the Worker's own tick budget, so a
 *  stalled endpoint costs one message rather than the whole tick. */
const SEND_TIMEOUT_MS = 10_000;

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
  /**
   * Deliver without a notification.
   *
   * The critical/advisory split is only meaningful if the channel treats
   * them differently — badging the text while buzzing the operator's
   * phone identically is exactly how a deliberately non-sufficient signal
   * trains someone to mute the channel (Codex #1443 r5). Advisories land
   * silently; criticals notify.
   */
  silent = false,
): Promise<boolean> {
  const body =
    text.length > TELEGRAM_MAX_CHARS
      ? `${text.slice(0, TELEGRAM_MAX_CHARS - 24)}\n… (truncated)`
      : text;

  // BOUNDED. Telegram can accept the connection and never complete the
  // response; with no deadline the sequential delivery loop stalls there,
  // so one hung ADVISORY blocks every later CRITICAL and the state batch
  // is never written (Codex #1443 r7). An expiry is treated like any
  // other per-message delivery failure.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
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
        signal: controller.signal,
        body: JSON.stringify({
          chat_id: target.chatId,
          text: body,
          disable_web_page_preview: true,
          disable_notification: silent,
        }),
      },
    );
    if (!res.ok) {
      console.error(
        `telegram sendMessage failed: ${res.status} ${redactDeliveryError(await res.text(), target.token)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `no response within ${SEND_TIMEOUT_MS}ms`
        : redactDeliveryError(
            err instanceof Error ? err.message : String(err),
            target.token,
          );
    console.error(`telegram sendMessage threw: ${reason}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrub a delivery-failure string before it is logged.
 *
 * The Telegram endpoint embeds the bot token IN THE PATH
 * (`/bot<token>/sendMessage`), so a `fetch` rejection or an error body
 * that echoes the request would write `TG_OPS_BOT_TOKEN` into the Worker
 * logs — and precisely during a delivery failure, when the operator is
 * most likely to be reading them. The general redactor never reached here
 * because this module has no `Env` (Codex #1443 r5): the token is right
 * at hand instead, and the structural URL pass catches the rest.
 */
export function redactDeliveryError(text: string, token: string): string {
  const withoutToken = token
    ? text.split(token).join('<TG_OPS_BOT_TOKEN>')
    : text;
  return stripUrlPaths(withoutToken);
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
