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
 *    deep link when the operator configured the bot username). This
 *    one REQUIRES an EIP-191 wallet signature: completing the
 *    handshake points the wallet's whole alert stream at a Telegram
 *    chat, so the agent only issues a code to the wallet's owner.
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
/** OFF ≠ silence: floor bands keep a final pre-liquidation warning
 *  while muting the earlier, chattier ones. The three values are
 *  PACKED into a 0.002-wide sliver just above 1.0 (the agent
 *  requires strictly decreasing bands, so they cannot be equal): the
 *  watcher alerts per band transition, and a band this narrow is
 *  crossed in one poll tick in practice — one transition, one
 *  message — instead of three spread-out warnings the user opted
 *  out of. */
export const FLOOR_BANDS = { warnHf: 1.012, alertHf: 1.011, criticalHf: 1.01 };

export interface AlertBands {
  warnHf: number;
  alertHf: number;
  criticalHf: number;
}

export interface AlertPrefs extends AlertBands {
  /** "Message me before an interest payment comes due" — the
   *  periodic-interest pre-notify opt-out (honored server-side via
   *  notify_maturity_approaching). */
  repayDue: boolean;
  /** "Message me if my loan gets risky" — HF-band alerts. */
  risky: boolean;
  /** Optimistic local record that the Telegram handshake was done —
   *  the agent has no read-back endpoint, so this mirrors what the
   *  user completed on this device. Unlink stays reachable even when
   *  this is false (linked elsewhere / storage cleared). */
  telegramLinked: boolean;
  /** Push rail opt-in. One-way on the backend: `push_channel` is
   *  COALESCE-preserved on later saves, so enabling sticks and there
   *  is no unset path through /thresholds today. */
  pushEnabled: boolean;
}

export const DEFAULT_PREFS: AlertPrefs = {
  repayDue: true,
  risky: true,
  telegramLinked: false,
  pushEnabled: false,
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
 *  body carries EXACTLY what the agent parses — bands, the
 *  pre-notify opt-out, and (when enabling) the Push flag. No
 *  aspirational fields: sending flags the parser drops would let the
 *  UI imply storage that never happens. */
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
    notify_maturity_approaching: prefs.repayDue,
    // One-way by backend design (COALESCE): only sent when enabling.
    ...(prefs.pushEnabled ? { push_channel: 'subscribed' } : {}),
  });
  if (!res.ok) throw new Error(`saving alert settings failed (${res.status})`);
}

export interface TelegramLink {
  code: string;
  botUrl: string | null;
}

/**
 * The exact message signed to authorise a Telegram link. MUST stay
 * byte-identical to `buildTelegramLinkMessage` in
 * `apps/agent/src/linkAuth.ts` — the agent reconstructs it verbatim
 * and recovers the signer; any drift rejects every link request.
 */
export function buildTelegramLinkMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
): string {
  return [
    'Vaipakam — Link Telegram alerts',
    '',
    'I authorise Telegram alert delivery for the wallet below to the',
    'chat that completes this link code. Signing this message proves',
    'ownership of the wallet. It is not a transaction and costs no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

/** Start the Telegram handshake: the wallet signs a free ownership
 *  proof (no gas, no transaction), then the agent issues a one-time
 *  code the user sends to the bot (deep link when configured). */
export async function issueTelegramLink(
  wallet: `0x${string}`,
  chainId: number,
  signMessage: (message: string) => Promise<string>,
): Promise<TelegramLink> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await signMessage(
    buildTelegramLinkMessage(wallet, chainId, issuedAt),
  );
  const res = await post('/link/telegram', {
    wallet,
    chain_id: chainId,
    issuedAt,
    signature,
  });
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
