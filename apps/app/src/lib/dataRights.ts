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
 * covers per-origin browser storage ONLY. On-chain state is public and
 * immutable and cannot be erased by anyone, this protocol included.
 * Data held by the alerts service is deleted through its own unlink
 * control in Settings, not here — a local erase cannot reach it.
 */

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
  'device. It does NOT contain on-chain data: your wallet address and any ' +
  'transaction you have signed are public on the blockchain, and no one — ' +
  'Vaipakam included — can export or erase them. It also does not contain ' +
  'anything held by the alerts service; that is removed by unlinking in ' +
  'Settings. Data stored by vaipakam.com is a separate store on a separate ' +
  'origin, with its own controls on that site.';

/** Read one storage safely. A blocked or unavailable store yields an
 *  empty object rather than throwing — private-mode browsers and
 *  storage-disabled profiles must still get a page. */
function collect(storage: Storage | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!storage) return out;
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
      try {
        // Most values are JSON. Parsing makes the export readable by
        // the person it is about; a non-JSON value is kept verbatim
        // rather than dropped.
        out[key] = JSON.parse(raw) as unknown;
      } catch {
        out[key] = raw;
      }
    }
  } catch {
    // Storage refused entirely. An empty section is honest; the page
    // reports what it managed to read.
  }
  return out;
}

function readCookies(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const name = part.slice(0, eq).trim();
      if (!PREFERENCE_COOKIES.includes(name)) continue;
      out[name] = decodeURIComponent(part.slice(eq + 1));
    }
  } catch {
    // Cookies unavailable — same rule as storage.
  }
  return out;
}

/** Everything this origin holds, as a portable object. */
export function collectMyData(): DataRightsExport {
  return {
    exportedAt: new Date().toISOString(),
    origin: typeof window === 'undefined' ? 'unknown' : window.location.origin,
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    localStorage: collect(typeof window === 'undefined' ? undefined : window.localStorage),
    sessionStorage: collect(typeof window === 'undefined' ? undefined : window.sessionStorage),
    cookies: readCookies(),
    note: EXPORT_NOTE,
  };
}

/** How many items an erasure would remove — shown BEFORE the user
 *  confirms, so the button is not a leap in the dark, and reported
 *  after so "nothing was stored" is distinguishable from "it failed". */
export function countMyData(): number {
  const data = collectMyData();
  return (
    Object.keys(data.localStorage).length +
    Object.keys(data.sessionStorage).length +
    Object.keys(data.cookies).length
  );
}

function clearStorage(storage: Storage | undefined): number {
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
    const present = readCookies();
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
export function eraseMyData(): EraseResult {
  const cookies = clearCookies();
  const local = clearStorage(typeof window === 'undefined' ? undefined : window.localStorage);
  const session = clearStorage(
    typeof window === 'undefined' ? undefined : window.sessionStorage,
  );
  return {
    localStorage: local,
    sessionStorage: session,
    cookies,
    total: local + session + cookies,
  };
}
