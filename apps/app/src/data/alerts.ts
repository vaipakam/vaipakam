/**
 * Alert rails (#1033) — typed client for the apps/agent Worker's
 * settings endpoints, framed for the naive user as OUTCOME toggles
 * rather than raw health-factor numbers.
 *
 * Backend reality this module encodes (verified 2026-07-05):
 *  - `PUT /thresholds` upserts HF bands + event opt-ins; the wallet
 *    field is body-trusted (no signature) for plain writes, EXCEPT
 *    that disabling the due-date reminder requires an EIP-191
 *    ownership proof (silencing a warning lane is the suppression
 *    tier — same rule as link/unlink). The field is also sent ONLY
 *    when the user changed that toggle on this device: a fresh
 *    device's defaults must never overwrite a stored opt-out made
 *    elsewhere (the agent preserves the flag when absent).
 *  - `POST /link/telegram` issues a one-time handshake code (+ bot
 *    deep link when the operator configured the bot username). This
 *    one REQUIRES an EIP-191 wallet signature: completing the
 *    handshake points the wallet's whole alert stream at a Telegram
 *    chat, so the agent only issues a code to the wallet's owner.
 *  - `POST /unlink/telegram` clears the stored wallet ↔ chat link
 *    (added alongside this feature — the privacy promise needs it).
 *    Also signature-gated, over a distinct unlink message: silently
 *    stopping someone else's risk alerts would be the mirror attack.
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
import { copy } from '../content/copy';

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
 *  usually crossed within one poll tick — one transition, one
 *  message. A loan drifting slowly enough to land separate ticks
 *  inside the sliver can still produce up to three closely-spaced
 *  final warnings; the user-facing copy therefore promises "you'll
 *  still be warned", not "exactly one message". */
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

/**
 * The four fields that are OPT-INS — each one a channel or a lane the
 * user has asked to receive. The HF bands are not among them: they
 * tune an opt-in already made (the advanced form only appears once
 * `risky` is on), so changing one neither enrols nor withdraws.
 */
const OPT_IN_FLAGS = ['repayDue', 'risky', 'telegramLinked', 'pushEnabled'] as const;

/**
 * Does this save ADD an opt-in — i.e. is it enrolment (#1961 review
 * round 9 P1)?
 *
 * The Terms gate holds enrolment and never holds an opt-out, so the
 * question it has to ask about an alerts save is which of the two this
 * one is. Round 8 answered it by asking whether anything was left
 * enabled AFTERWARDS, which is not the same question and got it wrong
 * in the common case: fresh preferences default `repayDue` and `risky`
 * both on, so a held user switching either one off produced a record
 * that still had the other on, was read as enrolment, and was refused.
 * Every user with two lanes enabled was locked out of disabling either
 * — the gate trapping somebody in a subscription, which is precisely
 * the shape it exists to avoid.
 *
 * So the DIRECTION decides, per field, against what is stored now: a
 * flag going false → true is enrolment; a flag going true → false, or
 * a save that flips nothing, is not.
 *
 * The baseline is REQUIRED, and that is the honest signature rather
 * than a convenience (review round 10 P1). An earlier version accepted
 * `null` and failed closed on it, which read as a guard and was not
 * one: `loadAlertPrefs` returns `DEFAULT_PREFS` when storage is empty,
 * so no caller could ever reach that branch. Dead code shaped like
 * protection is worse than no code, because it answers the question
 * "what happens when the baseline is unknown" with something that
 * never runs.
 *
 * On a device with no saved record the baseline IS the defaults, both
 * lanes on, and a held user's first opt-out is judged against them.
 * Making that case fail closed instead would re-create exactly the
 * lock-out this function was written to remove, since the untouched
 * default lane is what would trip it. What USED to remain here — the
 * whole record travelling with every save, so that first opt-out also
 * posted the untouched default lane's bands — was closed on the wire
 * by #2000: bands are sent only on a save that changed the risky lane
 * (see `SaveAlertPrefsOptions.bandsChanged`), and the agent preserves
 * stored values on absence, so a defaults-derived save no longer
 * writes anything the user did not touch.
 */
export function addsAlertOptIn(prev: AlertPrefs, next: AlertPrefs): boolean {
  return OPT_IN_FLAGS.some((flag) => next[flag] && !prev[flag]);
}

/** The agent re-validates warn > alert > critical > 1.00 and rejects
 *  otherwise — mirror it client-side so the advanced form can explain
 *  instead of surfacing a bare 400. */
export function bandsValid(b: AlertBands): boolean {
  return b.warnHf > b.alertHf && b.alertHf > b.criticalHf && b.criticalHf > 1.0;
}

const storageKey = (chainId: number, wallet: string) =>
  `app.alerts.${chainId}.${wallet.toLowerCase()}`;

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

/**
 * The mute counterpart of the link/unlink messages — MUST stay
 * byte-identical to `buildDueDateOptOutMessage` in
 * `apps/agent/src/linkAuth.ts`. Signed only when the user switches
 * the due-date reminder OFF: silencing a warning lane needs proof
 * the request comes from the wallet's owner.
 */
export function buildDueDateOptOutMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
): string {
  return [
    'Vaipakam — Mute due-date payment reminders',
    '',
    'I request that payment due-date reminders for the wallet below',
    'be switched off. Signing this message proves ownership of the',
    'wallet. It is not a transaction and costs no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

export interface SaveAlertPrefsOptions {
  /** True ONLY when this save is the user changing the due-date
   *  toggle. Otherwise the field is omitted from the body entirely —
   *  the agent preserves the stored value on absence, so a fresh
   *  device's defaults can't silently re-enable (or re-disable) an
   *  opt-out made on another device. */
  dueDateChanged?: boolean;
  /** True ONLY when this save is the user changing the RISKY lane —
   *  the toggle itself, or the advanced band numbers behind it
   *  (#2000). The bands are how that lane's state travels (real
   *  bands = on, floor bands = off), and until #2000 they were sent
   *  on EVERY save — so a fresh device's default lane state rode
   *  along with an unrelated change and overwrote an opt-out made
   *  elsewhere, exactly the failure the due-date flag's omission
   *  rule already prevented for its own field. Same rule now: absent
   *  bands mean "no change" and the agent preserves the stored
   *  values (server defaults only when no record exists at all). */
  bandsChanged?: boolean;
  /** Wallet signer — required when the save switches the due-date
   *  reminder off (the agent refuses an unsigned opt-out). */
  signMessage?: (message: string) => Promise<string>;
}

/** Persist the outcome toggles as the agent's thresholds row. The
 *  body carries EXACTLY what the agent parses — bands, the
 *  pre-notify opt-out (only when just changed), and (when enabling)
 *  the Push flag. No aspirational fields: sending flags the parser
 *  drops would let the UI imply storage that never happens. */
export async function saveAlertPrefs(
  wallet: `0x${string}`,
  chainId: number,
  prefs: AlertPrefs,
  opts: SaveAlertPrefsOptions = {},
): Promise<void> {
  // Bands travel ONLY when this save is the user changing the risky
  // lane (#2000) — mirroring the due-date field's omission rule. Sent
  // unconditionally, a fresh device's DEFAULT lane state (defaults on,
  // real bands) rode along with an unrelated first save and overwrote
  // a floor-band opt-out made on another device; the client cannot
  // tell defaults from state, but it can tell exactly which saves
  // touched the lane, which is the narrower and sufficient signal.
  const bands: AlertBands | null = opts.bandsChanged
    ? prefs.risky
      ? { warnHf: prefs.warnHf, alertHf: prefs.alertHf, criticalHf: prefs.criticalHf }
      : FLOOR_BANDS
    : null;
  let optOutProof: { issuedAt: number; signature: string } | null = null;
  if (opts.dueDateChanged && !prefs.repayDue) {
    if (!opts.signMessage) {
      throw new Error('switching the reminder off needs a wallet signature');
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    optOutProof = {
      issuedAt,
      signature: await opts.signMessage(
        buildDueDateOptOutMessage(wallet, chainId, issuedAt),
      ),
    };
  }
  const res = await post('/thresholds', {
    wallet,
    chain_id: chainId,
    ...(bands
      ? {
          warn_hf: bands.warnHf,
          alert_hf: bands.alertHf,
          critical_hf: bands.criticalHf,
        }
      : {}),
    ...(opts.dueDateChanged
      ? { notify_maturity_approaching: prefs.repayDue }
      : {}),
    ...(optOutProof ?? {}),
    // One-way by backend design (COALESCE): only sent when enabling.
    ...(prefs.pushEnabled ? { push_channel: 'subscribed' } : {}),
  });
  if (!res.ok) {
    if (res.status === 503) {
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (data?.error === 'optout-unavailable') {
        // Rollout window: the agent can't store an opt-out until its
        // storage migration lands. Honest, plain-words failure — the
        // opposite of silently pretending the switch worked.
        throw new Error(copy.alerts.optoutUnavailable);
      }
    }
    throw new Error(`saving alert settings failed (${res.status})`);
  }
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

/**
 * The unlink counterpart of {@link buildTelegramLinkMessage} — MUST
 * stay byte-identical to `buildTelegramUnlinkMessage` in
 * `apps/agent/src/linkAuth.ts`. Deliberately different wording from
 * the link message so one signature can never authorise the other.
 */
export function buildTelegramUnlinkMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
): string {
  return [
    'Vaipakam — Unlink Telegram alerts',
    '',
    'I request that Telegram alert delivery for the wallet below be',
    'disconnected everywhere. Signing this message proves ownership',
    'of the wallet. It is not a transaction and costs no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

/**
 * The test-alert counterpart (UX-012) — MUST stay byte-identical to
 * `buildTelegramTestMessage` in `apps/agent/src/linkAuth.ts`. Distinct
 * wording so one signature can never authorise another action.
 */
export function buildTelegramTestMessage(
  wallet: string,
  chainId: number,
  issuedAt: number,
): string {
  return [
    'Vaipakam — Send a test alert',
    '',
    'I request one test alert be sent to the Telegram chat linked to',
    'the wallet below, to confirm delivery works. Signing this message',
    'proves ownership of the wallet. It is not a transaction and costs',
    'no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Chain id: ${chainId}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

/** Result of a test-alert round-trip (UX-012). `sent` proves delivery
 *  (gate "linked" on it); `not-linked` means the bot handshake never
 *  completed; `error` is a transient/backend failure. */
export type TestAlertResult = 'sent' | 'not-linked' | 'error';

/** Push ONE real test alert to the wallet's linked Telegram chat. Signs
 *  a free ownership proof first, then asks the agent to send. The agent
 *  looks up the stored chat id: a `404 not-linked` means the code was
 *  never delivered to the bot — surfaced so the UI can say so instead of
 *  the old self-attested "I've done it" that hid a fumbled handshake. */
export async function sendTestTelegramAlert(
  wallet: `0x${string}`,
  chainId: number,
  signMessage: (message: string) => Promise<string>,
): Promise<TestAlertResult> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await signMessage(
    buildTelegramTestMessage(wallet, chainId, issuedAt),
  );
  const res = await post('/telegram/test', {
    wallet,
    chain_id: chainId,
    issuedAt,
    signature,
  });
  if (res.ok) return 'sent';
  // Only a body-tagged `not-linked` is the fumbled-handshake case. A
  // bare 404 (e.g. the endpoint not deployed yet) must NOT masquerade
  // as "your chat isn't linked" — fall through to the generic error.
  if (res.status === 404) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    return data?.error === 'not-linked' ? 'not-linked' : 'error';
  }
  return 'error';
}

/** Clear the stored wallet ↔ Telegram link server-side. Signs the
 *  unlink ownership proof first (free, not a transaction). */
export async function unlinkTelegram(
  wallet: `0x${string}`,
  chainId: number,
  signMessage: (message: string) => Promise<string>,
): Promise<void> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await signMessage(
    buildTelegramUnlinkMessage(wallet, chainId, issuedAt),
  );
  const res = await post('/unlink/telegram', {
    wallet,
    chain_id: chainId,
    issuedAt,
    signature,
  });
  if (!res.ok) throw new Error(`unlinking Telegram failed (${res.status})`);
}
