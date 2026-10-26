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
import {
  buildAlertSettingsMessage,
  buildTelegramLinkMessage,
  buildTelegramTestMessage,
  buildTelegramUnlinkMessage,
} from '@vaipakam/lib/alertsMessage';
import type { AlertSettingsChange } from '@vaipakam/lib/alertsMessage';
import { copy } from '../content/copy';
import { agentOrigin as configuredAgentOrigin } from '../lib/endpoints';

/* The four signed messages (link, unlink, save settings, test alert) come from `@vaipakam/lib/alertsMessage`
 * (#2014) — ONE builder per action, imported by both this client and
 * the agent Worker, because the Worker reconstructs the exact bytes
 * to recover the signer and a drifted character rejects every
 * request. They used to be hand-copied here alongside the agent's,
 * held identical only by comments saying they must be; the erasure
 * family (`@vaipakam/lib/erasureMessage`) had already established
 * the fix. Deliberately NOT re-exported from here — nothing in the
 * app imports a builder directly, and a pass-through export is one
 * more place a future consumer could bind to instead of the lib. */

const TIMEOUT_MS = 6_000;

function agentOrigin(): string | null {
  return configuredAgentOrigin(import.meta.env);
}

export function alertsConfigured(): boolean {
  return agentOrigin() !== null;
}

/**
 * What this deployment can do on the Push rail, as the agent reports it
 * (#2251).
 *
 * The app used to offer Push on its own build-time channel address alone, so a
 * deployment whose signer was unset or malformed said "Push delivery is on"
 * and sent nothing. The agent answers from the same rail it sends with, and
 * names the channel it posts as, which is also the channel the subscribe link
 * must open — so the link can no longer point at a channel the platform does
 * not post to.
 *
 * - `available` — the rail can issue a request, as `channel`. It does not
 *   promise Push accepts every send; that is only known per send.
 * - `unavailable` — this deployment cannot send Push at all.
 * - `unknown` — the agent could not be asked (unreachable, or an agent that
 *   predates the endpoint). Never read as either of the others.
 *
 * `scope` is WHOSE rail the answer covers, kept rather than dropped (Codex
 * #2665 r1). Today it is always `agent`: the agent sends the payment
 * reminders, while the keeper sends the risky-loan warnings from its own key
 * on its own machine, and the agent cannot see that configuration. So an
 * `available` answer is not a promise for every alert, and the card says
 * which alerts it covers. `service` is reserved for a combined answer that
 * covers both senders; the card drops the caveat only for that.
 */
export type PushStatusScope = 'agent' | 'service';

export type PushRailState =
  | { kind: 'available'; channel: `0x${string}`; channelUrl: string; scope: PushStatusScope }
  | { kind: 'unavailable'; scope: PushStatusScope }
  | { kind: 'unknown' };

/**
 * #2723 — on which chains the alert service charges the paid-Push fee, as the
 * service itself states it (`billedChainIds` on `GET /push/status`). Whether
 * Push is billed is the biller's answer, exactly as whether Push can be sent
 * is the sender's: the app never infers it from the fee configured on chain,
 * which is set whether or not anything charges it.
 *
 * - `known` — the list as stated; empty means no chain is billed.
 * - `unknown` — the service could not be asked, or predates the field. Never
 *   read as "not billed": the card says it could not confirm.
 */
export type PushBillingState =
  | { kind: 'known'; chainIds: readonly number[] }
  | { kind: 'unknown' };

/** What one `GET /push/status` answers: the rail, and the billing posture. */
export interface PushStatus {
  rail: PushRailState;
  billing: PushBillingState;
}

const UNKNOWN_PUSH_STATUS: PushStatus = {
  rail: { kind: 'unknown' },
  billing: { kind: 'unknown' },
};

export async function fetchPushStatus(): Promise<PushStatus> {
  const origin = agentOrigin();
  if (!origin) return UNKNOWN_PUSH_STATUS;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/push/status`, { signal: ctrl.signal });
    if (!res.ok) return UNKNOWN_PUSH_STATUS;
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { rail: parsePushStatus(data), billing: parsePushBilling(data) };
  } catch {
    return UNKNOWN_PUSH_STATUS;
  } finally {
    clearTimeout(t);
  }
}

/** The `billedChainIds` field, read strictly: a list of positive integer
 *  chain ids, or `unknown`. A malformed entry spoils the whole list, since a
 *  partly readable answer cannot say which chains it left out. */
export function parsePushBilling(data: Record<string, unknown> | null): PushBillingState {
  const ids = data?.billedChainIds;
  if (!Array.isArray(ids)) return { kind: 'unknown' };
  if (!ids.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
    return { kind: 'unknown' };
  }
  return { kind: 'known', chainIds: ids as number[] };
}

/** The agent's `GET /push/status` body, read strictly: anything that is not
 *  one of the two documented shapes is `unknown`, never a guess. */
export function parsePushStatus(data: Record<string, unknown> | null): PushRailState {
  if (!data) return { kind: 'unknown' };
  // An answer that does not say whose rail it covers cannot be scoped, so
  // it is not used at all.
  const scope = data.scope;
  if (scope !== 'agent' && scope !== 'service') return { kind: 'unknown' };
  if (data.available === false) return { kind: 'unavailable', scope };
  if (
    data.available === true &&
    typeof data.channel === 'string' &&
    /^0x[a-fA-F0-9]{40}$/.test(data.channel)
  ) {
    const channel = data.channel as `0x${string}`;
    return {
      kind: 'available',
      channel,
      channelUrl: `https://app.push.org/channels/${channel}`,
      scope,
    };
  }
  return { kind: 'unknown' };
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

interface PostResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body, or null when absent/malformed — parsed HERE,
   *  under the same abort deadline as the request itself (#2013 r5
   *  P2, the same hazard #2008 fixed in diagErasure): headers can
   *  arrive within the timeout while the body stalls forever, and a
   *  `res.json()` back in a caller would then hang with no timer
   *  left to cut it — the card stuck busy with its controls
   *  disabled. An abort during the read rejects `json()`, which is
   *  caught and reads as a malformed body. */
  data: Record<string, unknown> | null;
}

async function post(path: string, body: unknown): Promise<PostResult> {
  const origin = agentOrigin();
  if (!origin) throw new Error('alerts backend not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}${path}`, {
      method: path === '/thresholds' ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
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
  /** Wallet signer — required on EVERY save (#2754): the agent stores
   *  nothing that is not signed over a message naming exactly what the
   *  save changes. */
  signMessage: (message: string) => Promise<string>;
}

/** Persist the outcome toggles as the agent's thresholds row. The
 *  body carries EXACTLY what the agent parses — bands, the
 *  pre-notify opt-out (only when just changed), and (when enabling)
 *  the Push flag. No aspirational fields: sending flags the parser
 *  drops would let the UI imply storage that never happens. */
/** What the agent did with a Push opt-in the save carried (#2251).
 *  `stored` — written, or already stored and kept (`kept` on the wire), and
 *  for an agent that predates the answer, since storing it was what those
 *  agents did; `unavailable` — refused: Push is NOT stored for this wallet,
 *  and the save was repeated without it so the rest of it landed. */
export type PushSaveOutcome = 'not-requested' | 'stored' | 'unavailable';

export async function saveAlertPrefs(
  wallet: `0x${string}`,
  chainId: number,
  prefs: AlertPrefs,
  opts: SaveAlertPrefsOptions,
): Promise<PushSaveOutcome> {
  // Bands travel ONLY when this save is the user changing the risky
  // lane (#2000) — mirroring the due-date field's omission rule. Sent
  // unconditionally, a fresh device's DEFAULT lane state (defaults on,
  // real bands) rode along with an unrelated first save and overwrote
  // a floor-band opt-out made on another device; the client cannot
  // tell defaults from state, but it can tell exactly which saves
  // touched the lane, which is the narrower and sufficient signal.
  const bands: AlertBands | undefined = opts.bandsChanged
    ? prefs.risky
      ? { warnHf: prefs.warnHf, alertHf: prefs.alertHf, criticalHf: prefs.criticalHf }
      : FLOOR_BANDS
    : undefined;
  // One signed request per attempt (#2754, #2753): the wallet signs a
  // message naming exactly what this save changes, built from the same
  // values the body carries, and the agent accepts each signed request
  // once. So a repeat without the Push opt-in is a different change and
  // is signed again.
  const attempt = async (withPush: boolean) => {
    const change: AlertSettingsChange = {
      ...(bands ? { bands } : {}),
      ...(opts.dueDateChanged ? { dueDateReminders: prefs.repayDue } : {}),
      // One-way by backend design (COALESCE): only sent when enabling.
      ...(withPush && prefs.pushEnabled ? { pushAlerts: true as const } : {}),
    };
    const issuedAt = Math.floor(Date.now() / 1000);
    const signature = await opts.signMessage(
      buildAlertSettingsMessage(wallet, chainId, change, issuedAt),
    );
    return post('/thresholds', {
      wallet,
      chain_id: chainId,
      ...(change.bands
        ? {
            warn_hf: change.bands.warnHf,
            alert_hf: change.bands.alertHf,
            critical_hf: change.bands.criticalHf,
          }
        : {}),
      ...(change.dueDateReminders !== undefined
        ? { notify_maturity_approaching: change.dueDateReminders }
        : {}),
      ...(change.pushAlerts ? { push_channel: 'subscribed' } : {}),
      issuedAt,
      signature,
    });
  };
  let res = await attempt(true);
  // #2251 (Codex #2665 r1) — the agent refuses a NEW Push opt-in it cannot
  // honour by refusing the WHOLE save with a 409, so that an app bundle
  // from before this change reads it as a failure rather than as "Push is
  // on". This client knows the answer: Push is not stored, and the same
  // save is sent again without the opt-in so everything else in it lands.
  let pushRefused = false;
  if (res.status === 409 && res.data?.error === 'push-unavailable') {
    pushRefused = true;
    res = await attempt(false);
  }
  if (!res.ok) {
    if (res.status === 503 && res.data?.error === 'optout-unavailable') {
      // Rollout window: the agent can't store an opt-out until its
      // storage migration lands. Honest, plain-words failure — the
      // opposite of silently pretending the switch worked.
      throw new Error(copy.alerts.optoutUnavailable);
    }
    if (res.status === 503 && res.data?.error === 'verification-unavailable') {
      throw new Error(copy.alerts.signatureCheckUnavailable);
    }
    if (res.status === 409 && res.data?.error === 'request-already-used') {
      throw new Error(copy.alerts.requestAlreadyUsed);
    }
    throw new Error(`saving alert settings failed (${res.status})`);
  }
  if (pushRefused) return 'unavailable';
  if (!prefs.pushEnabled) return 'not-requested';
  return 'stored';
}

export interface TelegramLink {
  code: string;
  botUrl: string | null;
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
  const code = res.data?.code;
  if (typeof code !== 'string' || !code) {
    throw new Error('the alerts backend returned no link code');
  }
  const botUrl = res.data?.bot_url;
  return { code, botUrl: typeof botUrl === 'string' ? botUrl : null };
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
    return res.data?.error === 'not-linked' ? 'not-linked' : 'error';
  }
  return 'error';
}

/** Clear the stored wallet ↔ Telegram link server-side. Signs the
 *  unlink ownership proof first (free, not a transaction). */
export async function unlinkTelegram(
  wallet: `0x${string}`,
  chainId: number,
  signMessage: (message: string) => Promise<string>,
): Promise<'wallet' | 'chain'> {
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
  // The service reports which SCOPE the clear applied to (#2013 r4):
  // 'wallet' for an ordinary key (the universal controller), 'chain'
  // for a smart account whose contract approved on the signed chain
  // only — the confirmation the card shows must match what actually
  // happened. A missing field (an agent from before the scoped
  // response) means the old wallet-wide behaviour.
  return res.data?.scope === 'chain' ? 'chain' : 'wallet';
}
