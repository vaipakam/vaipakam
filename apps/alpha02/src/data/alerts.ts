/**
 * Alert rails (#1033) — typed client for the apps/agent Worker's
 * settings endpoints, framed for the naive user as OUTCOME toggles
 * rather than raw health-factor numbers.
 *
 * Backend reality this module encodes (verified 2026-07-05):
 *  - `PUT /thresholds` upserts HF bands + event opt-ins; the wallet
 *    field is body-trusted (no signature) because the only output is
 *    an alert to a Telegram chat the real wallet holder linked.
 *  - `POST /link/telegram` issues a one-time handshake code (+ bot
 *    deep link when the operator configured the bot username).
 *  - `POST /unlink/telegram` clears the stored wallet ↔ chat link
 *    (added alongside this feature — the privacy promise needs it).
 *  - The HF-band watcher lives in apps/keeper; the agent runs the
 *    periodic-interest pre-notify. There is NO claim-ready detector
 *    yet, so this UI deliberately does not promise one.
 *
 * Fail-closed: when `VITE_AGENT_ORIGIN` is unset the feature is
 * hidden behind an honest "not set up in this build" message and no
 * request is ever fired — a null origin must never silently point a
 * staging build at production (the bug apps/defi's Alerts page
 * documents).
 *
 * The "risky loan" toggle maps to the keeper's HF bands: ON sends
 * the sensible defaults (1.5 / 1.2 / 1.05 — the same bands apps/defi
 * exposes as raw numbers); OFF sends floor bands just above 1.0, so
 * the user still gets one last-moment warning right before
 * liquidation instead of total silence. Raw bands are editable only
 * under the advanced-mode reveal.
 */

const TIMEOUT_MS = 6_000;

function agentOrigin(): string | null {
  const url = import.meta.env.VITE_AGENT_ORIGIN as string | undefined;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

export function alertsConfigured(): boolean {
  return agentOrigin() !== null;
}

/** Push Protocol channel — deep-link only (subscription happens on
 *  app.push.org, signed by the user's wallet there). Null when unset
 *  or not address-shaped. */
export function pushChannelUrl(): string | null {
  const addr = import.meta.env.VITE_PUSH_CHANNEL_ADDRESS as string | undefined;
  if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;
  return `https://app.push.org/channels/${addr}`;
}

/** The bands behind the plain-words "risky loan" toggle. */
export const DEFAULT_BANDS = { warnHf: 1.5, alertHf: 1.2, criticalHf: 1.05 };
/** OFF ≠ silence: floor bands keep one final pre-liquidation warning
 *  while muting the earlier, chattier ones. */
export const FLOOR_BANDS = { warnHf: 1.03, alertHf: 1.02, criticalHf: 1.01 };

export interface AlertBands {
  warnHf: number;
  alertHf: number;
  criticalHf: number;
}

export interface AlertPrefs extends AlertBands {
  /** "Message me before a repayment or interest payment is due." */
  repayDue: boolean;
  /** "Message me if my loan gets risky" — HF-band alerts. */
  risky: boolean;
  /** Optimistic local record that the Telegram handshake was done —
   *  the agent has no read-back endpoint, so this mirrors what the
   *  user completed on this device. */
  telegramLinked: boolean;
}

export const DEFAULT_PREFS: AlertPrefs = {
  repayDue: true,
  risky: true,
  telegramLinked: false,
  ...DEFAULT_BANDS,
};

/** The agent re-validates warn > alert > critical > 1.00 and rejects
 *  otherwise — mirror it client-side so the advanced form can explain
 *  instead of surfacing a bare 400. */
export function bandsValid(b: AlertBands): boolean {
  return b.warnHf > b.alertHf && b.alertHf > b.criticalHf && b.criticalHf > 1.0;
}

const storageKey = (chainId: number, wallet: string) =>
  `alpha02.alerts.${chainId}.${wallet.toLowerCase()}`;

export function loadAlertPrefs(chainId: number, wallet: string): AlertPrefs {
  try {
    const raw = localStorage.getItem(storageKey(chainId, wallet));
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<AlertPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function storeAlertPrefs(
  chainId: number,
  wallet: string,
  prefs: AlertPrefs,
): void {
  try {
    localStorage.setItem(storageKey(chainId, wallet), JSON.stringify(prefs));
  } catch {
    // storage full/blocked — the server-side copy is authoritative
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  const origin = agentOrigin();
  if (!origin) throw new Error('alerts backend not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${origin}${path}`, {
      method: path === '/thresholds' ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/** Persist the outcome toggles as the agent's thresholds row. The
 *  event opt-ins the UI doesn't surface stay `true` — they are
 *  stored-but-dormant until each backend detector lands, and a user
 *  who linked Telegram asked to hear about their positions. */
export async function saveAlertPrefs(
  wallet: `0x${string}`,
  chainId: number,
  prefs: AlertPrefs,
): Promise<void> {
  const bands: AlertBands = prefs.risky
    ? { warnHf: prefs.warnHf, alertHf: prefs.alertHf, criticalHf: prefs.criticalHf }
    : FLOOR_BANDS;
  const res = await post('/thresholds', {
    wallet,
    chain_id: chainId,
    warn_hf: bands.warnHf,
    alert_hf: bands.alertHf,
    critical_hf: bands.criticalHf,
    locale: 'en',
    notify_claim_available: true,
    notify_loan_terminal: true,
    notify_loan_initiated_creator: true,
    notify_maturity_approaching: prefs.repayDue,
    notify_partial_repay_received: true,
  });
  if (!res.ok) throw new Error(`saving alert settings failed (${res.status})`);
}

export interface TelegramLink {
  code: string;
  botUrl: string | null;
}

/** Start the Telegram handshake: the agent issues a one-time code the
 *  user sends to the bot (deep link when configured). */
export async function issueTelegramLink(
  wallet: `0x${string}`,
  chainId: number,
): Promise<TelegramLink> {
  const res = await post('/link/telegram', { wallet, chain_id: chainId });
  if (!res.ok) throw new Error(`starting the Telegram link failed (${res.status})`);
  const data = (await res.json()) as {
    ok?: boolean;
    code?: string;
    bot_url?: string | null;
  };
  if (!data.code) throw new Error('the alerts backend returned no link code');
  return { code: data.code, botUrl: data.bot_url ?? null };
}

/** Clear the stored wallet ↔ Telegram link server-side. */
export async function unlinkTelegram(
  wallet: `0x${string}`,
  chainId: number,
): Promise<void> {
  const res = await post('/unlink/telegram', { wallet, chain_id: chainId });
  if (!res.ok) throw new Error(`unlinking Telegram failed (${res.status})`);
}
