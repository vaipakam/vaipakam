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
import { clearOpsAlert, clearOpsAlerts, getOpsAlert, getOpsAlertsSentAt, recordOpsAlertSent, recordOpsAlertsSent } from './db';
import { settleBy } from './batchRead';
import { assertEpochsHold, EpochFenceRefusal } from './epochFence';
import { redactedError } from '@vaipakam/lib/errorDescription';

const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_MAX_CHARS = 4096;
/** Per-post deadline: one stalled endpoint costs one alert, not the tick.
 *  Exported so a pass can size the tail its posts need (#2565). */
export const OPS_POST_TIMEOUT_MS = 10_000;

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
      console.warn(`[keeper] ops alert ${key} refused: ${redactedError(err, { stack: false })}`);
      return 'refused';
    }
    console.error(`[keeper] ops alert ${key} failed: ${redact(redactedError(err, { stack: false }), token)}`);
    return 'failed';
  }
}

/** One condition a digest reports: its own de-duplication key, what it is
 *  about (always shown in full), and what to say about it (cut to fit). */
export interface OpsAlertEntry {
  key: string;
  id: string;
  detail: string;
  /** The kind of condition, when a digest carries several kinds: the lines a
   *  post cannot fit are then counted per kind, not only in total (#2565). */
  group?: string;
}

/**
 * Deliver several conditions in ONE post (#2599 r4): each keeps its own key —
 * so each re-sends after `minIntervalSec` and clears on its own — but however
 * many are due, the run spends one bounded post on them, not one per
 * condition. The post names as many as fit and counts the rest, per
 * {@link OpsAlertEntry.group} where the entries carry one. Every due entry is
 * written to the keeper journal here, whether or not the post carried it, so
 * the post's "each named in the keeper journal" holds by construction for
 * every caller (#2565). The entries that went out are recorded together;
 * nothing is recorded when the post fails. Never throws.
 *
 * `deadline` (absolute ms) bounds the digest's D1 work and its start
 * (#2565 r1): each read or write still in flight then is abandoned, and a post
 * not yet started is not made, so the next run sends it. Its pieces keep the
 * same fail-safe as a failed read or write: an unread sent-state sends every
 * entry, an unrecorded delivery may repeat.
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
  deadline: number = Number.POSITIVE_INFINITY,
): Promise<OpsAlertOutcome> {
  if (entries.length === 0) return 'suppressed';
  const token = env.TG_OPS_BOT_TOKEN;
  const chatId = env.TG_OPS_CHAT_ID;
  if (!token || !chatId) {
    journal(`ops alert NOT delivered (TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset): ${header(entries.length)}`, entries.map(entryLine), footer);
    return 'unconfigured';
  }
  try {
    // De-duplication only ever SUPPRESSES a repeat, so when its state cannot
    // be read every entry is due, and when the delivery cannot be recorded it
    // was still delivered (Codex #2599 r6): a repeat is the cost, never a
    // dropped alert.
    let prior = new Map<string, number>();
    try {
      prior = await byDeadline(getOpsAlertsSentAt(env.KEEPER_DB, entries.map((e) => e.key)), deadline, 'sent-state read');
    } catch (err) {
      console.error(`[keeper] ops alert digest: sent-state unread, sending every entry: ${redactedError(err, { stack: false })}`);
    }
    const due = entries.filter((e) => {
      const at = prior.get(e.key);
      return at === undefined || nowSec - at >= minIntervalSec;
    });
    if (due.length === 0) return 'suppressed';
    if (chainId !== null) await assertEpochsHold();
    const heading = header(due.length);
    journal(heading, due.map(entryLine));
    if (Date.now() >= deadline) {
      console.warn(`[keeper] ops alert digest not posted: the alert window closed; the next run sends it`);
      return 'failed';
    }
    const ok = await postToTelegram(token, chatId, digestText(heading, due.map(entryLine), footer, due.map((e) => e.group)));
    if (!ok) return 'failed';
    try {
      await byDeadline(recordOpsAlertsSent(env.KEEPER_DB, due.map((e) => e.key), nowSec, chainId), deadline, 'delivery record');
    } catch (err) {
      console.error(`[keeper] ops alert digest delivered but not recorded; it may repeat: ${redactedError(err, { stack: false })}`);
    }
    return 'sent';
  } catch (err) {
    if (err instanceof EpochFenceRefusal) {
      console.warn(`[keeper] ops alert digest refused: ${redactedError(err, { stack: false })}`);
      return 'refused';
    }
    console.error(`[keeper] ops alert digest failed: ${redact(redactedError(err, { stack: false }), token)}`);
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
 *  `groups`, aligned with `lines`, names each line's kind: the rest are then
 *  counted per kind (#2565). The count is part of what must fit, and it
 *  depends on which lines are shown, so the shown set is cut until the whole
 *  text fits (#2565 r1: a fixed reserve for it was overrun by a per-kind
 *  count, and Telegram's cap then cut the footer). Pure; exported for tests. */
export function digestText(header: string, lines: readonly string[], footer: string, groups?: readonly (string | undefined)[]): string {
  const capped = lines.map(capLine);
  const text = (shown: number): string => {
    const rest = capped.length - shown;
    const more = rest > 0 ? `\n…and ${rest} more${restByGroup(groups, shown)}, each named in the keeper journal.` : '';
    return `${header}\n${capped.slice(0, shown).join('\n')}${more}\n${footer}`;
  };
  // The most lines the header and footer leave room for, then fewer until the
  // count of the rest fits too. The count is a few dozen characters per kind,
  // so this steps back a handful of lines at most.
  let shown = 0;
  let used = header.length + footer.length + 2;
  while (shown < capped.length && used + capped[shown]!.length + 1 <= TELEGRAM_MAX_CHARS) {
    used += capped[shown]!.length + 1;
    shown += 1;
  }
  while (shown > 0 && text(shown).length > TELEGRAM_MAX_CHARS) shown -= 1;
  return text(shown);
}

/** Longest single journal line a digest writes (#2565 r1). The journal is
 *  where every line a post could not carry is named, so it must not be cut:
 *  Workers Logs truncates an event over 256 KB and journald splits a line
 *  over its LineMax (48 KB by default). A digest is written as parts of at
 *  most this many characters, every entry whole in one part. */
const JOURNAL_LINE_CHARS = 16_000;

/** Write `heading` and every line to the keeper journal, in parts no longer
 *  than {@link JOURNAL_LINE_CHARS} (a single longer entry is its own part,
 *  whole), with `tail` after the last. Exported for tests. */
export function journal(heading: string, lines: readonly string[], tail = '', write: (line: string) => void = (l) => console.warn(l)): void {
  const parts: string[][] = [[]];
  let size = 0;
  for (const line of lines) {
    const cur = parts[parts.length - 1]!;
    if (cur.length > 0 && size + line.length + 2 > JOURNAL_LINE_CHARS) {
      parts.push([line]);
      size = line.length;
    } else {
      cur.push(line);
      size += line.length + 2;
    }
  }
  const n = parts.length;
  parts.forEach((part, i) =>
    write(`[keeper] ${heading}${n > 1 ? ` (part ${i + 1}/${n})` : ''} ${part.join('; ')}${i === n - 1 && tail ? ` ${tail}` : ''}`),
  );
}

/** `work`, abandoned with an error naming `what` if still in flight at
 *  `deadline`; an infinite deadline waits as before. */
function byDeadline<T>(work: Promise<T>, deadline: number, what: string): Promise<T> {
  return settleBy(work, deadline, () => {
    throw new Error(`ops alert ${what} still in flight at the alert deadline`);
  });
}

/**
 * One-off NOTICES (#2515 — a settlement that moved value, an evidence chain
 * that lapsed): things that HAPPENED, as opposed to conditions that hold, so
 * there is nothing to de-duplicate and nothing is recorded. However many a run
 * has, they go out as ONE bounded post (Codex #2602 r1), the same shape as
 * {@link sendOpsAlertDigest}: as many lines as fit, then a count of the rest.
 * The caller journals every line, so the journal names each one the post
 * could not carry. Best-effort like every ops alert — the chain's own events
 * are the record. Never throws.
 */
export async function sendOpsNoticeDigest(
  env: Env,
  header: string,
  lines: readonly string[],
  footer: string,
  /** The chain the notices are about: they pass the epoch fence. */
  chainId: number | null = null,
): Promise<OpsAlertOutcome> {
  if (lines.length === 0) return 'suppressed';
  const token = env.TG_OPS_BOT_TOKEN;
  const chatId = env.TG_OPS_CHAT_ID;
  if (!token || !chatId) {
    console.warn(`[keeper] ops notice NOT delivered (TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset): ${header} (${lines.length} lines, journaled above)`);
    return 'unconfigured';
  }
  try {
    if (chainId !== null) await assertEpochsHold();
    return (await postToTelegram(token, chatId, digestText(header, lines, footer))) ? 'sent' : 'failed';
  } catch (err) {
    if (err instanceof EpochFenceRefusal) {
      console.warn(`[keeper] ops notice digest refused: ${redactedError(err, { stack: false })}`);
      return 'refused';
    }
    console.error(`[keeper] ops notice digest failed: ${redact(redactedError(err, { stack: false }), token)}`);
    return 'failed';
  }
}

/** How the lines a digest could not show split by kind: ` (12 observe deadline at
 *  risk, 3 held overdue)`, or nothing when the lines carry no kind. */
function restByGroup(groups: readonly (string | undefined)[] | undefined, shown: number): string {
  if (!groups) return '';
  const counts = new Map<string, number>();
  for (const g of groups.slice(shown)) {
    if (g === undefined) return '';
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts.size === 0 ? '' : ` (${[...counts].map(([g, n]) => `${n} ${g}`).join(', ')})`;
}

/** The conditions behind `keys` have cleared, in one statement (#2565),
 *  abandoned at `deadline` (the next run clears them). Never throws. */
export async function resolveOpsAlerts(env: Env, keys: readonly string[], deadline: number = Number.POSITIVE_INFINITY): Promise<void> {
  if (keys.length === 0) return;
  try {
    await byDeadline(clearOpsAlerts(env.KEEPER_DB, keys), deadline, 'clear');
  } catch (err) {
    console.error(`[keeper] ops alert clear of ${keys.length} key(s) failed: ${redactedError(err, { stack: false })}`);
  }
}

/** The condition behind `key` has cleared: the next occurrence alerts at once. */
export async function resolveOpsAlert(env: Env, key: string): Promise<void> {
  try {
    await clearOpsAlert(env.KEEPER_DB, key);
  } catch (err) {
    console.error(`[keeper] ops alert ${key} clear failed: ${redactedError(err, { stack: false })}`);
  }
}

async function postToTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  const body = text.length > TELEGRAM_MAX_CHARS ? `${text.slice(0, TELEGRAM_MAX_CHARS - 1)}…` : text;
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(OPS_POST_TIMEOUT_MS),
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
