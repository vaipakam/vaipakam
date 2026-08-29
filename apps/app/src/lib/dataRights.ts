/**
 * Data-subject rights over the state this app keeps in the browser
 * (#1960) — the export ("right to access / portability") and the local
 * erasure ("right to erasure") deliverables.
 *
 * WHY THIS EXISTS AT ALL. `apps/www` has a Data Rights page with
 * working controls, and it does not cover this app: those functions run
 * on the marketing origin, and same-origin isolation means they can
 * neither read nor clear storage belonging to this one. Two origins,
 * two stores. The retired `apps/defi` served its own page; the
 * successor shipped without one, so the #1854 cutover removed the
 * capability rather than moving it.
 *
 * WHY IT IS NOT A PORT OF THE RETIRED HELPER. That one scanned for keys
 * under the `vaipakam` namespace — `vaipakam`, `vaipakam.…`,
 * `vaipakam:…`. This app stores almost everything under `app.…`
 * instead, and its cross-tab receipt ping under `vaipakam-…`, which
 * that rule also misses. Ported verbatim it would have exported an
 * empty object and erased nothing, while reporting success both times.
 * On a page whose entire purpose is telling somebody what is held about
 * them and letting them remove it, a false "done" is worse than no page
 * at all — so the prefixes below are derived from what the app actually
 * writes, and pinned by a test that fails when a new one appears.
 *
 * SCOPE, stated plainly because the page repeats it to the user: this
 * covers per-origin browser storage ONLY. On-chain state is public —
 * the user can read it from any explorer — and immutable, so nobody can
 * erase it, this protocol included. The alerts service holds its own
 * data, and unlinking clears only the Telegram connection: the
 * preferences row survives for a relink, so the copy points at support
 * for the rest rather than implying one button covers it (round 1 P1).
 *
 * `sessionStorage` and the in-memory error slot are per TAB rather than
 * per origin. The erasure crosses that boundary by broadcast; the
 * export does not, and says so (round 2 P2). The page may not claim
 * "this browser" and deliver "this tab".
 */

import { clearLastError, readLastError } from '../diagnostics/lastError';
import { announceErase } from './eraseBroadcast';

/**
 * Every prefix this app writes browser storage under.
 *
 * `app.` covers the app's own keys. The `vaipakam` family covers what
 * is shared with the other surfaces on the domain: the language choice
 * and the cross-tab receipt ping. All three separators are listed
 * because all three are in use — the retired helper's omission of `-`
 * is exactly the kind of gap that makes an erasure silently partial.
 */
export const STORAGE_PREFIXES: readonly string[] = [
  'app.',
  'vaipakam.',
  'vaipakam:',
  'vaipakam-',
];

/**
 * Parent-domain cookies (`.vaipakam.com`) carrying user preferences.
 *
 * Listed separately because they are not per-origin: they are how the
 * marketing site and this app agree on language and theme. Clearing
 * them here clears them for both, which is the user's intent when they
 * ask for their data to be removed — and is said in the page copy
 * rather than left as a surprise.
 */
/** Where `diagnostics/lastError.ts` stores its record. Named here so
 *  the export can tell "already included" from "held only in memory". */
const LAST_ERROR_KEY = 'vaipakam.app.lastError';

export const PREFERENCE_COOKIES: readonly string[] = [
  'vaipakam_lang',
  'vaipakam_theme',
];

/** True when `key` is one this app is responsible for. */
export function isAppStorageKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export interface DataRightsExport {
  /** ISO timestamp the export was produced. */
  exportedAt: string;
  /** Which surface produced it — an export from this app and one from
   *  the marketing site cover different stores, and a user comparing
   *  two files later needs to know which is which. */
  origin: string;
  /** Browser identification, so a user holding exports from several
   *  devices can tell them apart. */
  userAgent: string;
  localStorage: Record<string, unknown>;
  sessionStorage: Record<string, unknown>;
  cookies: Record<string, string>;
  /** Carried inside the file so it stays true away from this page. */
  note: string;
}

export const EXPORT_NOTE =
  'This file contains the data the Vaipakam app stores in this browser, on this ' +
  'device. It does NOT contain on-chain data: your wallet address and the ' +
  'transactions you have signed are public on the blockchain, so they are not ' +
  'held here — you can look them up yourself on any block explorer. What no ' +
  'one, Vaipakam included, can do is erase them. It also does not contain ' +
  'anything held by the alerts service: unlinking in Settings removes the ' +
  'Telegram connection, while your alert preferences remain on that service ' +
  'for a future relink — email support@vaipakam.com to have those removed. ' +
  'A small amount of data belongs to each browser tab on its own, so this ' +
  'file covers the tab it was downloaded from — erasing reaches the others. ' +
  'Data stored by vaipakam.com is a separate store on a separate origin, ' +
  'with its own controls on that site.';

/**
 * Obtain a Storage object without throwing (review round 1 P1).
 *
 * `window.localStorage` is a GETTER, and under some browser policies
 * reading the property itself throws `SecurityError`. Passing
 * `window.localStorage` as an argument evaluates it before the callee's
 * `try` can help, so the throw escaped every guard below and took the
 * whole page down during render — in exactly the locked-down browser
 * this page exists to serve.
 */
function safeStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window[kind];
  } catch {
    return null;
  }
}

/**
 * What a read of one store found, and whether it was allowed to look.
 *
 * `refused` is separate from an empty `data` on purpose (review round 1
 * P1). Collapsing them told a user with unreadable storage that nothing
 * was stored, disabled both buttons, and made the refusal message this
 * module carefully distinguishes unreachable. "I cannot see" and "there
 * is nothing" are different answers, and on this page the difference is
 * the whole point.
 */
export interface StoreRead {
  data: Record<string, unknown>;
  refused: boolean;
}

/**
 * Turn a stored string into something readable WITHOUT changing it.
 *
 * Only structured values — objects and arrays — are parsed. A bare
 * scalar is kept as the exact string that was written (review round 3
 * P2): `JSON.parse` on a long decimal silently rounds it, so a pending
 * marker holding an on-chain identifier of `9007199254740993` would be
 * exported as `9007199254740992`. A portability file that quietly
 * contains a DIFFERENT identifier is worse than one that is harder to
 * read, and those markers are stored as bare decimal strings.
 *
 * Objects and arrays are still parsed, because that is what makes the
 * file readable by the person it is about, and a structured value that
 * fails to parse falls back to its raw text rather than being dropped.
 */
function decodeStored(raw: string): unknown {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Read one storage safely, preserving WHY it came back empty. */
function collect(storage: Storage | null): StoreRead {
  const out: Record<string, unknown> = {};
  if (!storage) return { data: out, refused: true };
  try {
    // Keys are read up front: removing while iterating by index skips
    // entries, and reading while another tab writes can shift them.
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (isAppStorageKey(key)) keys.push(key as string);
    }
    for (const key of keys) {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      out[key] = decodeStored(raw);
    }
  } catch {
    // Obtainable but unreadable — a real state under restrictive
    // privacy settings, and NOT the same as empty.
    return { data: out, refused: true };
  }
  return { data: out, refused: false };
}

function readCookies(): { data: Record<string, string>; refused: boolean } {
  const out: Record<string, string> = {};
  try {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const name = part.slice(0, eq).trim();
      if (!PREFERENCE_COOKIES.includes(name)) continue;
      const raw = part.slice(eq + 1);
      // Decoding is per-cookie and falls back to the raw text (review
      // round 4 P2). `decodeURIComponent` throws on malformed percent
      // encoding — `vaipakam_lang=%` is enough — and a single throw
      // used to abort the whole scan through the outer catch. The
      // export then lost every preference cookie AND `clearCookies`
      // received no names to expire, so a cookie survived an erasure
      // because its VALUE was unreadable. The name is what deletion
      // needs, and it was legible throughout.
      try {
        out[name] = decodeURIComponent(raw);
      } catch {
        out[name] = raw;
      }
    }
  } catch {
    // Only reachable if `document.cookie` itself is unavailable, which
    // is a genuine refusal rather than one bad value.
    return { data: out, refused: true };
  }
  return { data: out, refused: false };
}

/**
 * Everything this origin holds, plus whether any store refused to be
 * read.
 *
 * One function rather than a `collectMyData` and a separate
 * `countMyData` that each re-read: the page needs the count, the
 * refusal state and the payload to describe the SAME moment. Two reads
 * are two moments, and a page that says "3 items" beside a file
 * containing 2 is the sort of small dishonesty this one cannot afford.
 */
export interface DataRightsSnapshot {
  payload: DataRightsExport;
  /** How many items the export actually contains. */
  count: number;
  /** True when at least one store could not be read. NOT the same as
   *  an empty store — see `StoreRead`. */
  refused: boolean;
}

export function inspectMyData(): DataRightsSnapshot {
  const local = collect(safeStorage('localStorage'));
  const session = collect(safeStorage('sessionStorage'));
  const cookies = readCookies();
  // Review round 3 P2: when `sessionStorage.setItem` fails — quota, or
  // a locked-down profile — `recordLastError` keeps the record in a
  // module-level slot instead. The Diagnostics drawer reads it and the
  // erasure clears it, so the app demonstrably HOLDS it; leaving it out
  // of the export made this file claim completeness it did not have,
  // and left the one asymmetry that matters: erased but never
  // disclosed. Added only when the stored copy is absent, so a normal
  // browser sees no duplicate.
  if (!(LAST_ERROR_KEY in session.data)) {
    const inMemory = readLastError();
    if (inMemory) session.data[LAST_ERROR_KEY] = inMemory;
  }
  const payload: DataRightsExport = {
    exportedAt: new Date().toISOString(),
    origin: typeof window === 'undefined' ? 'unknown' : window.location.origin,
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    localStorage: local.data,
    sessionStorage: session.data,
    cookies: cookies.data,
    note: EXPORT_NOTE,
  };
  return {
    payload,
    count:
      Object.keys(local.data).length +
      Object.keys(session.data).length +
      Object.keys(cookies.data).length,
    refused: local.refused || session.refused || cookies.refused,
  };
}

/** Everything this origin holds, as a portable object. */
export function collectMyData(): DataRightsExport {
  return inspectMyData().payload;
}

/** How many items an erasure would remove — shown BEFORE the user
 *  confirms, so the button is not a leap in the dark, and reported
 *  after so "nothing was stored" is distinguishable from "it failed". */
export function countMyData(): number {
  return inspectMyData().count;
}

function clearStorage(storage: Storage | null): number {
  if (!storage) return 0;
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (isAppStorageKey(key)) keys.push(key as string);
    }
    for (const key of keys) {
      try {
        storage.removeItem(key);
        removed += 1;
      } catch {
        // One key refusing must not abandon the rest.
      }
    }
  } catch {
    // Storage refused entirely.
  }
  return removed;
}

function clearCookies(): number {
  let removed = 0;
  try {
    const present = readCookies().data;
    for (const name of Object.keys(present)) {
      // Expired on the parent domain AND on this host: the cookie was
      // written with `domain=.vaipakam.com`, but a local or preview
      // build sets it hostless, and a delete that names only one of the
      // two leaves the other standing — a preference that "would not
      // delete" for reasons invisible to the user.
      const expiry = 'expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      document.cookie = `${name}=; ${expiry}`;
      document.cookie = `${name}=; ${expiry}; domain=.vaipakam.com`;
      document.cookie = `${name}=; ${expiry}; domain=${window.location.hostname}`;
      removed += 1;
    }
    // Counted only if they are actually GONE (review round 1 P1).
    // Setting an expiry is a request, not a result: a cookie written
    // with a path or domain none of the three attempts above match
    // survives, and reporting it as removed is the false success this
    // module exists to avoid.
    const left = Object.keys(readCookies().data).length;
    removed = Math.max(0, removed - left);
  } catch {
    // Cookies unavailable.
  }
  return removed;
}

export interface EraseResult {
  localStorage: number;
  sessionStorage: number;
  cookies: number;
  total: number;
}

/**
 * Remove everything this origin holds.
 *
 * Returns what was actually removed rather than a boolean, because the
 * page has to tell the truth about three different outcomes: data
 * erased, nothing was stored to begin with, and storage refused. A
 * blanket "done" would collapse all three, and on this page the third
 * one is a false assurance.
 */
/**
 * Clear only what belongs to THIS browsing context.
 *
 * Split out so a tab receiving another tab's erasure can run exactly
 * this much: session storage and the in-memory error slot. The shared
 * stores were already cleared by the originating tab, and re-clearing
 * them from every listener would be pointless work on a signal that
 * can arrive many times.
 */
export function erasePerTabData(): number {
  const removed = clearStorage(safeStorage('sessionStorage'));
  clearLastError();
  return removed;
}

export function eraseMyData(): EraseResult {
  const cookies = clearCookies();
  const local = clearStorage(safeStorage('localStorage'));
  const session = clearStorage(safeStorage('sessionStorage'));
  // Review round 1 P1: the last-error record lives in sessionStorage
  // AND in a module-level slot, so clearing storage alone left
  // `readLastError()` still returning it — the Diagnostics drawer would
  // go on displaying an "erased" error and attaching it to a support
  // report until the page happened to reload. An erasure that leaves a
  // copy in memory has not erased anything.
  clearLastError();
  // `sessionStorage` and the memory slot are per browsing context, so
  // the tabs this one cannot touch are told to clear their own (review
  // round 2 P2). Announced AFTER the local erase so a listener never
  // races ahead of the tab that started it.
  announceErase();
  return {
    localStorage: local,
    sessionStorage: session,
    cookies,
    total: local + session + cookies,
  };
}
