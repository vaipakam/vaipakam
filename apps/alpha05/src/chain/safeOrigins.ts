/**
 * #3770 — the one list of origins allowed to frame the app: the official
 * Safe{Wallet} web app, which opens the app as a Safe App so a team or
 * family account's multi-signature wallet can act through it.
 *
 * Three consumers read this list and nothing else: the Safe connector's
 * `allowedDomains` (exact matches, so no other site can drive the
 * connector), the `frame-ancestors` directive the build writes into
 * `_headers`, and the runtime guard that refuses to act when the app is
 * framed by anything else. An origin is an exact scheme and host; a
 * wildcard is never accepted.
 */
export const SAFE_APP_ORIGINS: readonly string[] = ['https://app.safe.global'];

const ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Throws on an entry that is not one exact https origin. */
export function checkedOrigins(list: readonly string[]): readonly string[] {
  for (const o of list) if (!ORIGIN.test(o)) throw new Error(`[safe-origins] "${o}" is not one exact https origin`);
  return list;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The connector's allowed domains: each origin matched whole. */
export function safeOriginPatterns(list: readonly string[] = SAFE_APP_ORIGINS): RegExp[] {
  return checkedOrigins(list).map((o) => new RegExp(`^${escape(o)}$`));
}

/** True when `origin` is exactly one of the listed origins. */
export function isAllowedFrameOrigin(origin: string, list: readonly string[] = SAFE_APP_ORIGINS): boolean {
  return list.includes(origin);
}

/** The placeholder `_headers` carries where the build writes the list. */
export const FRAME_ANCESTORS_PLACEHOLDER = '__SAFE_APP_ORIGINS__';
/** The placeholder for the cross-origin read grant on the manifest and icon. */
export const CORS_ORIGIN_PLACEHOLDER = '__SAFE_APP_CORS_ORIGIN__';

/** `_headers` with both placeholders replaced from the list. Throws when
 *  either is missing, so neither header can ship without it, and when the
 *  list holds more than one origin, which a single cross-origin grant
 *  cannot name. */
export function applyFrameAncestors(headers: string, list: readonly string[] = SAFE_APP_ORIGINS): string {
  const origins = checkedOrigins(list);
  if (!headers.includes(FRAME_ANCESTORS_PLACEHOLDER)) throw new Error(`[safe-origins] _headers carries no ${FRAME_ANCESTORS_PLACEHOLDER}`);
  if (!headers.includes(CORS_ORIGIN_PLACEHOLDER)) throw new Error(`[safe-origins] _headers carries no ${CORS_ORIGIN_PLACEHOLDER}`);
  if (origins.length !== 1) throw new Error('[safe-origins] the cross-origin grant names exactly one origin; the list holds ' + origins.length);
  return headers.split(FRAME_ANCESTORS_PLACEHOLDER).join(origins.join(' ')).split(CORS_ORIGIN_PLACEHOLDER).join(origins[0]!);
}

/**
 * Where the app is running. `top`: not framed. `allowed`: framed, and the
 * browser lists every ancestor, each one exactly on the list. `refused`:
 * an ancestor is not on the list. `unconfirmed`: framed by a browser that
 * gives no ancestor list (Firefox); the app stays refused until the parent
 * answers a handshake from an origin exactly on the list
 * (`confirmFrameOrigin`). A guess never mounts the app.
 */
export type FrameState = 'top' | 'allowed' | 'refused' | 'unconfirmed';

/** The parts of a window this module reads. Structural, so the build
 *  config (no DOM types) can import the module. */
export interface FrameWindow {
  self: unknown;
  top: unknown;
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  location: { ancestorOrigins?: { length: number; item(i: number): string | null } };
  addEventListener(type: 'message', fn: (e: FrameMessage) => void): void;
  removeEventListener(type: 'message', fn: (e: FrameMessage) => void): void;
}

export interface FrameMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

export function frameState(w: Pick<FrameWindow, 'self' | 'top' | 'location'>): FrameState {
  if (w.self === w.top) return 'top';
  const ancestors = w.location.ancestorOrigins;
  if (!ancestors || ancestors.length === 0) return 'unconfirmed';
  // Every ancestor must be listed, not just the parent or the top.
  for (let i = 0; i < ancestors.length; i++) if (!isAllowedFrameOrigin(ancestors.item(i) ?? '')) return 'refused';
  return 'allowed';
}

/** The Safe Apps SDK version the handshake request names (the connector's). */
const SDK_VERSION = '9.1.0';

/**
 * The handshake for a framed app whose browser hides its ancestors: asks
 * the parent for its Safe info in the Safe Apps message format and resolves
 * true only when the parent window answers that request successfully from
 * an origin exactly on the list. The request carries nothing about the
 * user. Any other message is ignored; the promise never resolves false on a
 * guess, so the refusal stays up until a listed parent answers.
 */
export function confirmFrameOrigin(w: FrameWindow, id: string): Promise<true> {
  return new Promise((resolve) => {
    const onMessage = (e: FrameMessage) => {
      if (e.source !== w.parent || !isAllowedFrameOrigin(e.origin)) return;
      const d = e.data as { id?: unknown; success?: unknown } | null;
      if (!d || d.id !== id || d.success !== true) return;
      w.removeEventListener('message', onMessage);
      resolve(true);
    };
    w.addEventListener('message', onMessage);
    w.parent.postMessage({ id, method: 'getSafeInfo', params: undefined, env: { sdkVersion: SDK_VERSION } }, '*');
  });
}
