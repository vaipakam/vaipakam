// apps/keeper/src/opsAlert.ts
//
// #2450 — OPERATOR alerts from the keeper's reward passes.
//
// Delivered by the OPS bot (`TG_OPS_BOT_TOKEN` → `TG_OPS_CHAT_ID`), never the
// user-facing `TG_BOT_TOKEN`: the two bots are split by who reads the alert
// (CLAUDE.md, "Two Telegram bots"), so a user-bot compromise cannot spoof the
// detection signals an operator acts on. The user bot's `telegram.ts` is
// deliberately not reused: it swallows a failed post, and an ops alert must
// know whether it was delivered before recording it as sent.
//
// De-duplicated through `keeper_ops_alert`: a condition a pass reports
// usually persists for hours, so a key re-sends only after the caller's
// minimum interval, and a caller clears its key once the condition is gone so
// a recurrence alerts at once.
//
// Unconfigured (either variable unset) is reported in the log on every call
// rather than silently dropped — the mesh-watcher's DEGRADED convention — so
// a deploy that forgot the ops channel is visible in the Worker logs.

import type { Env } from './env';
import { clearOpsAlert, getOpsAlert, recordOpsAlertSent } from './db';

const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_MAX_CHARS = 4096;
/** Per-post deadline: one stalled endpoint costs one alert, not the tick. */
const SEND_TIMEOUT_MS = 10_000;

export type OpsAlertOutcome = 'sent' | 'suppressed' | 'unconfigured' | 'failed';

/**
 * Deliver `text` under `key` unless the same key was delivered less than
 * `minIntervalSec` ago. Never throws: a failed alert must not abort a pass
 * that still has on-chain work to do.
 */
export async function sendOpsAlert(
  env: Env,
  key: string,
  text: string,
  minIntervalSec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<OpsAlertOutcome> {
  const token = env.TG_OPS_BOT_TOKEN;
  const chatId = env.TG_OPS_CHAT_ID;
  if (!token || !chatId) {
    console.warn(
      `[keeper] ops alert NOT delivered (TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset): ${text}`,
    );
    return 'unconfigured';
  }
  try {
    const prior = await getOpsAlert(env.DB, key);
    if (prior && nowSec - prior.lastSentAt < minIntervalSec) return 'suppressed';
    const ok = await postToTelegram(token, chatId, text);
    if (!ok) return 'failed';
    await recordOpsAlertSent(env.DB, key, nowSec);
    return 'sent';
  } catch (err) {
    console.error(`[keeper] ops alert ${key} failed: ${redact(String(err), token)}`);
    return 'failed';
  }
}

/** The condition behind `key` has cleared: the next occurrence alerts at once. */
export async function resolveOpsAlert(env: Env, key: string): Promise<void> {
  try {
    await clearOpsAlert(env.DB, key);
  } catch (err) {
    console.error(`[keeper] ops alert ${key} clear failed: ${String(err)}`);
  }
}

async function postToTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  const body = text.length > TELEGRAM_MAX_CHARS ? `${text.slice(0, TELEGRAM_MAX_CHARS - 1)}…` : text;
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[keeper] ops alert post failed: status=${res.status} ${redact(detail.slice(0, 200), token)}`);
  }
  return res.ok;
}

/** Strip the bot token from anything that is about to be logged: a fetch
 *  error can echo the request URL, which carries it. */
function redact(s: string, token: string): string {
  return token ? s.split(token).join('<TG_OPS_BOT_TOKEN>') : s;
}
