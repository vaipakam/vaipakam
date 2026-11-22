/**
 * What the host remembers between runs about operator alerts (#3919).
 *
 * Two things: when each standing condition was last delivered (so it repeats
 * only every REPEAT_SECONDS while it lasts), and every alert that is due but
 * not yet delivered. The second matters for one-shot alerts, such as an audit
 * miss or a refused list: the run that raised one does not raise it again, so
 * if the operator chat was down at the time, only this record keeps it. A
 * pending alert stays until the chat accepts the message carrying it.
 */
import { alertBatches, type Finding } from './pass';

/** An alert is sent again only after this long, while its condition lasts. */
export const REPEAT_SECONDS = 6 * 3600;
/**
 * At most this many undelivered alerts are kept. Past it the oldest give way,
 * and the next message says how many were dropped, so a loss is stated.
 */
export const MAX_PENDING = 200;

export interface AlertState {
  /** `${chainId}:${key}` -> when it was last delivered. */
  sent: Record<string, number>;
  /** Due and not yet delivered, oldest first. */
  pending: Finding[];
  /** Undelivered alerts dropped past MAX_PENDING and not yet reported. */
  dropped: number;
}

const id = (a: Finding) => `${a.chainId}:${a.key}`;

/** Reads the stored state; the older shape (a bare `sent` map) is accepted. */
export function parseAlertState(raw: string | undefined): AlertState {
  const empty: AlertState = { sent: {}, pending: [], dropped: 0 };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return empty;
    const o = v as Record<string, unknown>;
    if (!('pending' in o) && !('sent' in o)) return { ...empty, sent: o as Record<string, number> };
    const pending = Array.isArray(o.pending)
      ? (o.pending as Finding[]).filter((f) => f && typeof f.key === 'string' && typeof f.text === 'string' && Number.isSafeInteger(f.chainId))
      : [];
    return {
      sent: o.sent && typeof o.sent === 'object' ? (o.sent as Record<string, number>) : {},
      pending,
      dropped: Number.isSafeInteger(o.dropped) ? (o.dropped as number) : 0,
    };
  } catch {
    return empty;
  }
}

/**
 * This run's alerts against the stored state: what to send now (stored pending
 * first, then newly due ones, one entry per condition) and the state to keep
 * if nothing is delivered. Conditions that have cleared are forgotten from
 * `sent`, so a recurrence alerts at once; a pending alert is never forgotten
 * because its condition cleared.
 */
export function dueAlerts(state: AlertState, alerts: Finding[], now: number): { due: Finding[]; state: AlertState } {
  const queued = new Map<string, Finding>();
  for (const p of state.pending) queued.set(id(p), p);
  for (const a of alerts) {
    if (queued.has(id(a))) queued.set(id(a), a); // the latest wording of a still-pending alert
    else {
      const last = state.sent[id(a)];
      if (last === undefined || now - last >= REPEAT_SECONDS) queued.set(id(a), a);
    }
  }
  let due = [...queued.values()];
  let dropped = state.dropped;
  if (due.length > MAX_PENDING) {
    dropped += due.length - MAX_PENDING;
    due = due.slice(due.length - MAX_PENDING);
  }
  const live = new Set(alerts.map(id));
  const sent: Record<string, number> = {};
  for (const [k, t] of Object.entries(state.sent)) if (live.has(k)) sent[k] = t;
  return { due, state: { sent, pending: due, dropped } };
}

/** The state after the chat accepted a message carrying `batch` (and the dropped count, if it said so). */
export function delivered(state: AlertState, batch: Finding[], now: number, reportedDropped: boolean): AlertState {
  const done = new Set(batch.map(id));
  const sent = { ...state.sent };
  for (const k of done) sent[k] = now;
  return { sent, pending: state.pending.filter((p) => !done.has(id(p))), dropped: reportedDropped ? 0 : state.dropped };
}

const HEADING = 'Failed transaction pass';

/**
 * The messages that carry `due`, in order. A dropped count, when there is one,
 * is reported in the first message's heading, and every message is sized with
 * that heading counted, so none exceeds the chat's limit.
 */
export function alertMessages(due: Finding[], dropped: number): Array<{ text: string; batch: Finding[]; reportsDropped: boolean }> {
  const droppedLine = dropped > 0 ? `• ${dropped} earlier alert(s) could not be kept while the operator chat was unreachable; read the unit journal.` : undefined;
  const heading = droppedLine ? `${HEADING}\n${droppedLine}` : HEADING;
  return alertBatches(due, heading).map((batch, i) => {
    const reportsDropped = i === 0 && droppedLine !== undefined;
    return { text: [reportsDropped ? heading : HEADING, ...batch.map((a) => `• ${a.text}`)].join('\n'), batch, reportsDropped };
  });
}
