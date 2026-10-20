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
// De-duplicated through `keeper_ops_alert`, which lives in the keeper's
// PRIVATE database (`env.KEEPER_DB`, #2450) — ops alert state is kept out of
// the shared, user-facing D1 (CLAUDE.md, "Cloudflare D1 schema discipline").
// A condition a pass reports usually persists for hours, so a key re-sends
// only after the caller's minimum interval, and a caller clears its key once
// the condition is gone so a recurrence alerts at once.
//
// Unconfigured (either variable unset) is reported in the log on every call
// rather than silently dropped — the mesh-watcher's DEGRADED convention — so
// a deploy that forgot the ops channel is visible in the Worker logs.

import type { Env } from './env';
import { clearOpsAlert, getOpsAlert, getOpsAlertsSentAt, recordOpsAlertSent, recordOpsAlertsSent } from './db';
import { assertEpochsHold, EpochFenceRefusal } from './epochFence';

const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_MAX_CHARS = 4096;
/** Per-post deadline: one stalled endpoint costs one alert, not the tick. */
const SEND_TIMEOUT_MS = 10_000;

export type OpsAlertOutcome = 'sent' | 'suppressed' | 'unconfigured' | 'failed' | 'refused';

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
  /** The chain the alert is about, when it is chain-scoped (#2497 r10). */
  chainId: number | null = null,
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
    const prior = await getOpsAlert(env.KEEPER_DB, key);
    if (prior && nowSec - prior.lastSentAt < minIntervalSec) return 'suppressed';
    // A CHAIN-SCOPED alert is an effect computed from that chain's state, so
    // it passes the epoch fence like a send or a subscriber alert
    // (`epochFence.ts`): an alert about the old Diamond is not posted once
    // the indexer has moved on. A global alert names no chain and is not fenced.
    if (chainId !== null) await assertEpochsHold();
    const ok = await postToTelegram(token, chatId, text);
    if (!ok) return 'failed';
    await recordOpsAlertSent(env.KEEPER_DB, key, nowSec, chainId);
    return 'sent';
  } catch (err) {
    if (err instanceof EpochFenceRefusal) {
      console.warn(`[keeper] ops alert ${key} refused: ${err.message}`);
      return 'refused';
    }
    console.error(`[keeper] ops alert ${key} failed: ${redact(String(err), token)}`);
    return 'failed';
  }
}

/** One condition a digest reports: its own de-duplication key, what it is
 *  about (always shown in full), and what to say about it (cut to fit). */
export interface OpsAlertEntry {
  key: string;
  id: string;
  detail: string;
}

/**
 * Deliver several conditions in ONE post (#2599 r4): each keeps its own key —
 * so each re-sends after `minIntervalSec` and clears on its own — but however
 * many are due, the run spends one bounded post on them, not one per
 * condition. The post names as many as fit and counts the rest; the caller
 * logs every one, so the journal names each. The entries that went out are
 * recorded together; nothing is recorded when the post fails. Never throws.
 */
export async function sendOpsAlertDigest(
  env: Env,
  /** The heading, given how many entries the post actually carries — the
   *  due ones, not every entry passed (Codex #2599 r5). */
  header: (count: number) => string,
  entries: readonly OpsAlertEntry[],
  footer: string,
  minIntervalSec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
  chainId: number | null = null,
): Promise<OpsAlertOutcome> {
  if (entries.length === 0) return 'suppressed';
  const token = env.TG_OPS_BOT_TOKEN;
  const chatId = env.TG_OPS_CHAT_ID;
  if (!token || !chatId) {
    console.warn(
      `[keeper] ops alert NOT delivered (TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset): ${header(entries.length)} ` +
        entries.map(entryLine).join('; ') +
        ` ${footer}`,
    );
    return 'unconfigured';
  }
  try {
    // De-duplication only ever SUPPRESSES a repeat, so when its state cannot
    // be read every entry is due, and when the delivery cannot be recorded it
    // was still delivered (Codex #2599 r6): a repeat is the cost, never a
    // dropped alert.
    let prior = new Map<string, number>();
    try {
      prior = await getOpsAlertsSentAt(env.KEEPER_DB, entries.map((e) => e.key));
    } catch (err) {
      console.error(`[keeper] ops alert digest: sent-state unread, sending every entry: ${String(err)}`);
    }
    const due = entries.filter((e) => {
      const at = prior.get(e.key);
      return at === undefined || nowSec - at >= minIntervalSec;
    });
    if (due.length === 0) return 'suppressed';
    if (chainId !== null) await assertEpochsHold();
    const ok = await postToTelegram(token, chatId, digestText(header(due.length), due.map(entryLine), footer));
    if (!ok) return 'failed';
    try {
      await recordOpsAlertsSent(env.KEEPER_DB, due.map((e) => e.key), nowSec, chainId);
    } catch (err) {
      console.error(`[keeper] ops alert digest delivered but not recorded; it may repeat: ${String(err)}`);
    }
    return 'sent';
  } catch (err) {
    if (err instanceof EpochFenceRefusal) {
      console.warn(`[keeper] ops alert digest refused: ${err.message}`);
      return 'refused';
    }
    console.error(`[keeper] ops alert digest failed: ${redact(String(err), token)}`);
    return 'failed';
  }
}

/** Longest a digest line may run, so even the first one always fits and
 *  names what it is about (Codex #2599 r5). */
const MAX_LINE_CHARS = 600;

function entryLine(e: OpsAlertEntry): string {
  return `${e.id} — ${e.detail}`;
}

/** One line, cut to {@link MAX_LINE_CHARS} at its end so its start — what the
 *  line is about — is always kept. */
function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

/** A digest's text: the header, then as many lines as fit in one Telegram
 *  message — each cut at its end to {@link MAX_LINE_CHARS}, so every line
 *  shown names what it is about — a count of the rest, then the footer.
 *  Pure; exported for tests. */
export function digestText(header: string, lines: readonly string[], footer: string): string {
  const budget = TELEGRAM_MAX_CHARS - header.length - footer.length - 80;
  const shown: string[] = [];
  let used = 0;
  for (const raw of lines) {
    const line = capLine(raw);
    if (used + line.length + 1 > budget) break;
    shown.push(line);
    used += line.length + 1;
  }
  const rest = lines.length - shown.length;
  const more = rest > 0 ? `\n…and ${rest} more, each named in the keeper journal.` : '';
  return `${header}\n${shown.join('\n')}${more}\n${footer}`;
}

/**
 * A one-off NOTICE: something happened, rather than a condition that holds
 * (#2515 — a settlement that moved value, an evidence chain that lapsed).
 * Sent once under `key`, then its record is cleared at once, so the next such
 * event is told too and no row lingers for a condition that has no "cleared".
 * Best-effort like every ops alert: the chain's own events are the record.
 */
export async function sendOpsNotice(
  env: Env,
  key: string,
  text: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  chainId: number | null = null,
): Promise<OpsAlertOutcome> {
  const out = await sendOpsAlert(env, key, text, 0, nowSec, chainId);
  if (out === 'sent') await resolveOpsAlert(env, key);
  return out;
}

/** The condition behind `key` has cleared: the next occurrence alerts at once. */
export async function resolveOpsAlert(env: Env, key: string): Promise<void> {
  try {
    await clearOpsAlert(env.KEEPER_DB, key);
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
