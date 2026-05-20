/**
 * Telegram alert delivery — single chat (the internal ops channel).
 * Failure to deliver is logged but never thrown so a Telegram outage
 * doesn't halt the rest of the cron tick (the next tick re-evaluates;
 * persistent failures fall under the 1-hour repeat-cadence dedup).
 */

const TELEGRAM_API = 'https://api.telegram.org';

export async function sendOpsAlert(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // Plain text — robust against Markdown / HTML parser quirks
        // when the alert body contains hex addresses with underscores
        // or asterisks.
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(
        `[lz-watcher] telegram send failed status=${res.status} body=${body.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(
      `[lz-watcher] telegram send threw: ${String(err).slice(0, 200)}`,
    );
  }
}
