/**
 * Alert channels and preferences (#3180 Alerts slice 2, ACC-50 / ACC-52;
 * RB-ALERT-CHANNELS): what the app asks the alert service, what it signs,
 * and how it reads each answer. Pure, so every outcome is tested.
 *
 * Every change is signed by the wallet with a plain message that names what
 * it does: link Telegram, unlink it, send a test alert, or save settings.
 * The messages come from the one shared source the service rebuilds them
 * from (`@vaipakam/lib/alertsMessage`), so the prompt the wallet shows and
 * the text the service checks cannot differ. A save carries only what it
 * changes; an absent setting keeps its stored value. The service accepts a
 * signed request once, inside a ten-minute window.
 *
 * The service does not tell the app what it has stored. So the app states
 * what THIS browser has done ({@link KnownAlerts}, kept in `known.ts`) and
 * says a link or setting made elsewhere may exist.
 */
import { buildAlertSettingsMessage, buildTelegramLinkMessage, buildTelegramTestMessage, buildTelegramUnlinkMessage, type AlertSettingsChange } from '@vaipakam/lib/alertsMessage';

type Hex = `0x${string}`;

/** The service's default health bands: a warning at 1.5, an alert at 1.2
 *  and a critical warning at 1.05, before liquidation at 1.0. */
export const DEFAULT_BANDS: Bands = { warnHf: 1.5, alertHf: 1.2, criticalHf: 1.05 };

export interface Bands {
  warnHf: number;
  alertHf: number;
  criticalHf: number;
}

/** Why three bands cannot be saved, or `null` when they can: each a finite
 *  number, the warning above the alert above the critical line, and the
 *  critical line above 1.0 (the service refuses anything else). */
export function bandsProblem(b: Bands): 'not-numbers' | 'order' | 'floor' | null {
  if (![b.warnHf, b.alertHf, b.criticalHf].every((n) => Number.isFinite(n))) return 'not-numbers';
  if (!(b.warnHf > b.alertHf && b.alertHf > b.criticalHf)) return 'order';
  if (b.criticalHf <= 1) return 'floor';
  return null;
}

/** Read a band the user typed: a plain decimal number, or `NaN`. */
export function parseBand(raw: string): number {
  const t = raw.trim();
  return /^\d{1,3}(\.\d{1,4})?$/.test(t) ? Number(t) : Number.NaN;
}

// ─── Push status ────────────────────────────────────────────────────

/** Whose senders the service's answer covers: `service` is both (payment
 *  reminders and health warnings); `agent` is the reminder sender only,
 *  because nothing current is known about the warning sender. */
export type PushScope = 'agent' | 'service';

export type PushStatus =
  | { kind: 'available'; channel: Hex; scope: PushScope; billedChainIds: number[] }
  | { kind: 'unavailable'; reason: string; rail: 'agent' | 'keeper' | null; scope: PushScope; billedChainIds: number[] };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The service's `GET /push/status` answer, read strictly: anything that is
 *  not exactly one of its two shapes is `null`, and the page says it could
 *  not tell, never that push is on. */
export function parsePushStatus(raw: unknown): PushStatus | null {
  if (raw === null || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const scope = b.scope === 'agent' || b.scope === 'service' ? b.scope : null;
  if (scope === null) return null;
  const billed = Array.isArray(b.billedChainIds) && b.billedChainIds.every((n) => Number.isSafeInteger(n) && (n as number) > 0) ? (b.billedChainIds as number[]) : null;
  if (billed === null) return null;
  if (b.available === true) {
    if (typeof b.channel !== 'string' || !ADDRESS_RE.test(b.channel)) return null;
    return { kind: 'available', channel: b.channel as Hex, scope, billedChainIds: billed };
  }
  if (b.available === false) {
    if (typeof b.reason !== 'string' || b.reason.length === 0 || b.reason.length > 64) return null;
    const rail = b.rail === 'agent' || b.rail === 'keeper' ? b.rail : b.rail === undefined ? null : undefined;
    if (rail === undefined) return null;
    return { kind: 'unavailable', reason: b.reason, rail, scope, billedChainIds: billed };
  }
  return null;
}

/** Where the wallet subscribes to the service's push channel. */
export function pushChannelUrl(channel: Hex): string {
  return `https://app.push.org/channels/${channel}`;
}

// ─── Signed requests ────────────────────────────────────────────────

/** One signed action: one of the three fixed ones, or a settings save. */
export type AlertAction = 'link' | 'unlink' | 'test-alert' | { save: AlertSettingsChange };

/** The exact message the wallet signs for `action`. */
export function alertMessage(action: AlertAction, wallet: Hex, chainId: number, issuedAt: number): string {
  if (action === 'link') return buildTelegramLinkMessage(wallet, chainId, issuedAt);
  if (action === 'unlink') return buildTelegramUnlinkMessage(wallet, chainId, issuedAt);
  if (action === 'test-alert') return buildTelegramTestMessage(wallet, chainId, issuedAt);
  return buildAlertSettingsMessage(wallet, chainId, action.save, issuedAt);
}

/** Where each action is sent, and how. */
export function alertRoute(action: AlertAction): { method: 'POST' | 'PUT'; path: string } {
  if (action === 'link') return { method: 'POST', path: '/link/telegram' };
  if (action === 'unlink') return { method: 'POST', path: '/unlink/telegram' };
  if (action === 'test-alert') return { method: 'POST', path: '/telegram/test' };
  return { method: 'PUT', path: '/thresholds' };
}

/** The request body for `action`: the signed fields, and for a save the
 *  values the message names (and nothing it does not). */
export function alertBody(action: AlertAction, wallet: Hex, chainId: number, issuedAt: number, signature: Hex): Record<string, unknown> {
  const signed = { wallet, chain_id: chainId, issuedAt, signature };
  if (typeof action === 'string') return signed;
  const { bands, dueDateReminders, pushAlerts } = action.save;
  return {
    ...signed,
    ...(bands ? { warn_hf: bands.warnHf, alert_hf: bands.alertHf, critical_hf: bands.criticalHf } : {}),
    ...(dueDateReminders !== undefined ? { notify_maturity_approaching: dueDateReminders } : {}),
    ...(pushAlerts ? { push_channel: 'subscribed' } : {}),
  };
}

// ─── Answers ────────────────────────────────────────────────────────

/** Why the service did not do what was asked. Each has its own words and,
 *  where there is one, its own remedy. */
export type AlertProblem =
  /** The signed request was already accepted once: sign again. */
  | 'used'
  /** The signature did not prove the wallet, or the request was too old. */
  | 'refused'
  /** The service could not check a smart account's signature right now. */
  | 'verify-down'
  /** Too many requests from here: wait and try again. */
  | 'busy'
  /** A test alert: the bot has not received the link code yet. */
  | 'not-linked'
  /** A test alert: one was sent less than a minute ago. */
  | 'cooldown'
  /** A test alert: the service has no Telegram bot set up. */
  | 'bot-off'
  /** A test alert: Telegram did not accept the message. */
  | 'send-failed'
  /** A save that switched push on: the service cannot send push now, so
   *  nothing in the save was stored. */
  | 'push-unavailable'
  /** A save: the service's storage is being updated; try again shortly. */
  | 'storage-pending'
  /** A save: the service does not watch this network. */
  | 'chain-not-watched'
  /** An unlink: the service could not check protected mode, so nothing changed. */
  | 'protection-unknown'
  /** Anything else: the status is stated. */
  | 'other';

export type AlertAnswer =
  | { ok: true; action: 'link'; code: string; botUrl: string | null }
  | { ok: true; action: 'unlink'; scope: 'wallet' | 'chain'; pending: number[] }
  | { ok: true; action: 'test-alert' }
  | { ok: true; action: 'save'; push: 'stored' | 'kept' | 'not-requested' }
  | { ok: false; problem: AlertProblem; status: number };

const BOT_URL_RE = /^https:\/\/t\.me\/[A-Za-z0-9_]{1,64}\?start=[A-Za-z0-9_-]{1,64}$/;

/** Read the service's answer to `action`. A 2xx whose body is not the shape
 *  the action returns is `other`: the page never reports a link, a test or
 *  a save it cannot substantiate. */
export function readAlertAnswer(action: AlertAction, status: number, data: Record<string, unknown> | null): AlertAnswer {
  const error = typeof data?.error === 'string' ? data.error : null;
  const kind = typeof action === 'string' ? action : 'save';
  if (status >= 200 && status < 300) {
    if (data?.ok !== true) return { ok: false, problem: 'other', status };
    if (kind === 'link') {
      const code = data.code;
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(code)) return { ok: false, problem: 'other', status };
      const botUrl = typeof data.bot_url === 'string' && BOT_URL_RE.test(data.bot_url) ? data.bot_url : null;
      return { ok: true, action: 'link', code, botUrl };
    }
    if (kind === 'unlink') {
      const scope = data.scope === 'wallet' || data.scope === 'chain' ? data.scope : null;
      if (scope === null) return { ok: false, problem: 'other', status };
      const pending = Array.isArray(data.pending) ? data.pending.filter((n): n is number => Number.isSafeInteger(n) && (n as number) > 0) : [];
      return { ok: true, action: 'unlink', scope, pending };
    }
    if (kind === 'test-alert') return { ok: true, action: 'test-alert' };
    // An answer from before the service reported Push says nothing: read
    // it as stored, which is what that service did.
    const push =
      data.push === 'stored' || data.push === 'kept' || data.push === 'not-requested'
        ? data.push
        : typeof action !== 'string' && action.save.pushAlerts
          ? 'stored'
          : 'not-requested';
    return { ok: true, action: 'save', push };
  }
  if (status === 409 && error === 'request-already-used') return { ok: false, problem: 'used', status };
  if (status === 409 && error === 'push-unavailable') return { ok: false, problem: 'push-unavailable', status };
  if (status === 503 && error === 'verification-unavailable') return { ok: false, problem: 'verify-down', status };
  if (status === 503 && error === 'optout-unavailable') return { ok: false, problem: 'storage-pending', status };
  if (status === 503 && error === 'protection-unknown') return { ok: false, problem: 'protection-unknown', status };
  if (status === 503 && error === 'bot-not-configured') return { ok: false, problem: 'bot-off', status };
  if (status === 404 && error === 'not-linked') return { ok: false, problem: 'not-linked', status };
  if (status === 429 && error === 'rate-limited' && kind === 'test-alert') return { ok: false, problem: 'cooldown', status };
  if (status === 429) return { ok: false, problem: 'busy', status };
  if (status === 502 && error === 'send-failed') return { ok: false, problem: 'send-failed', status };
  if (status === 400 && error === 'chain-not-configured') return { ok: false, problem: 'chain-not-watched', status };
  if (status === 401 || (status === 400 && (error === 'invalid-payload' || error === 'verification_failed'))) return { ok: false, problem: 'refused', status };
  return { ok: false, problem: 'other', status };
}
