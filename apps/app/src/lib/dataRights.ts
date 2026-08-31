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
 * Listed separately because they are not per-origin. Their
 * relationships differ (review round 9 P2): `vaipakam_lang` is
 * genuinely shared — the i18n package mirrors every language change to
 * it and both sites read it — while `vaipakam_theme` belongs to the
 * marketing site alone; this app never consults it and keeps its own
 * theme under `app.theme`. Both belong HERE because this browser holds
 * them: the export must disclose them and the erasure must clear them.
 * What clearing them does NOT do is reset the marketing site (review
 * round 10 P2): that site keeps origin-local copies of both
 * preferences and recreates the cookies from them on its next visit,
 * so the page copy promises only the cookie removal and points at the
 * main site's own controls for the rest.
 */
/** Where `diagnostics/lastError.ts` stores its record. Named here so
 *  the export can tell "already included" from "held only in memory". */
const LAST_ERROR_KEY = 'vaipakam.app.lastError';

export const PREFERENCE_COOKIES: readonly string[] = [
  'vaipakam_lang',
  'vaipakam_theme',
];

/**
 * Namespaces a DEPENDENCY writes on this app's behalf (#1862).
 *
 * `eraseMyData` used to clear only the prefixes above, so "Delete my data"
 * reported success while wallet-connection state stayed behind and a reload
 * could reconnect the same wallet. That is wallet-linked data surviving a
 * right-to-erasure control, which is the failure this page exists to prevent.
 *
 * None of these is discoverable by scanning `src/` — the app never writes
 * them; the connectors configured in `chain/wagmi.ts` do. Each entry records
 * how it was established, because "found in a dependency's bundle" and
 * "verified from the code that composes the key" are different strengths of
 * evidence and the next person should not have to guess which they inherited:
 *
 *  - `wagmi.`        VERIFIED. `@wagmi/core`'s `createStorage` defaults to
 *                    `key: prefix = 'wagmi'` and composes every key as
 *                    `${prefix}.${key}`; `createConfig` is called with no
 *                    `storage` override, so the default applies.
 *  - `wc@2:`         From the built `@walletconnect/core` bundle. Its full
 *                    keys are assembled at runtime, so only this stem is
 *                    observable statically.
 *  - `CBWSDK`        From the built `@coinbase/wallet-sdk` bundle. The same
 *                    package also persists `cbwsdk.store` in LOWER case, which
 *                    an exact match missed entirely (round 3 P1) — hence the
 *                    case-folded comparison below rather than two entries.
 *  - `-walletlink:`  Same package, WalletLink transport.
 *
 * Matching is by SUBSTRING rather than prefix, deliberately. Three of the four
 * key shapes could not be confirmed statically, and on an origin this app has
 * to itself an erasure that removes slightly too much is a far better failure
 * than one that leaves an account connected. It is still a wider net than the
 * evidence strictly supports, which is the honest reason the registry work in
 * #1862 wants a runtime check — connect each wallet type, diff `localStorage`
 * before and after — rather than more reading of `node_modules`.
 */
export const THIRD_PARTY_STORAGE_MARKERS: readonly string[] = [
  'wagmi.',
  'wc@2:',
  'CBWSDK',
  '-walletlink:',
];

/** True when `key` is one this app itself writes. */
export function isAppStorageKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * True when an erasure must remove `key` — this app's own, plus the
 * connector namespaces it causes to exist.
 *
 * DELIBERATELY WIDER THAN THE EXPORT. `collectMyData` still uses
 * `isAppStorageKey`, so a portability file contains what this app stored and
 * not a connector's session material: exporting WalletConnect session state
 * into a file the user downloads and may forward is a hazard the right of
 * access does not require, while leaving it in place defeats the right to
 * erasure. The two rights want different sets, so they get different
 * predicates rather than one shared list bent to serve both.
 */
/**
 * wagmi's "this connector was deliberately disconnected" flag.
 *
 * `@wagmi/core`'s `injected` (`shimDisconnect` defaults to TRUE) and, since
 * this app opts in, `@wagmi/connectors`' `safe` both write
 * `<connectorId>.disconnected` through the config's storage — so
 * `wagmi.metaMask.disconnected`, `wagmi.safe.disconnected` — and both consult
 * it from `isAuthorized`, which is the check that decides whether the next
 * mount reconnects silently.
 */
const WAGMI_DISCONNECT_SENTINEL = /^wagmi\..+\.disconnected$/;

/**
 * True when a key is wagmi's disconnect sentinel, which an erasure must LEAVE
 * BEHIND.
 *
 * The one exception to "remove everything the connectors wrote", and it exists
 * because removing this key undoes the erasure (round 3 P1). The sweep runs
 * after the teardown, and the teardown's last act is to write this flag; a
 * `wagmi.` match then deleted it, so the next mount found the wallet still
 * authorized and reconnected — the exact "delete my data, reload, still signed
 * in" failure this whole change exists to fix, restored by the fix's own
 * cleanup.
 *
 * Keeping it costs the user nothing: the value is the boolean `true`. It holds
 * no address, no session, no key material and nothing that could identify
 * anyone — it is a note to the app saying "do not reconnect on your own",
 * which is what the person who pressed erase asked for. An erasure that
 * removed it would be more thorough and less faithful.
 */
export function isDisconnectSentinelKey(
  key: string | null | undefined,
): boolean {
  return !!key && WAGMI_DISCONNECT_SENTINEL.test(key);
}

export function isErasableStorageKey(key: string | null | undefined): boolean {
  if (!key) return false;
  if (isDisconnectSentinelKey(key)) return false;
  if (isAppStorageKey(key)) return true;
  // CASE-INSENSITIVE (round 3 P1). The markers were matched exactly, and
  // `@coinbase/wallet-sdk@4.3.6` persists `cbwsdk.store` in lower case while
  // the marker recorded here was `CBWSDK` — so the store holding that
  // connector's keys, account state and spend permissions was skipped by both
  // the deletion and the count, and the page reported a clean success over it.
  // Casing is not a property worth being strict about when the cost of a miss
  // is an account surviving an erasure, so the comparison folds case rather
  // than the list gaining a second spelling of the same name.
  const lower = key.toLowerCase();
  return THIRD_PARTY_STORAGE_MARKERS.some((marker) =>
    lower.includes(marker.toLowerCase()),
  );
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
  /** Present ONLY when a store refused to be read (review round 7
   *  P2): the file is then missing whatever that store holds, and a
   *  file separated from the page's on-screen warning must carry the
   *  warning itself — the note below claims to contain the app's
   *  browser data, and without this marker a partial export reads as
   *  a complete one. Placed before the data so a person opening the
   *  file meets it first. */
  incomplete?: {
    unreadableStores: string[];
    note: string;
  };
  localStorage: Record<string, unknown>;
  sessionStorage: Record<string, unknown>;
  cookies: Record<string, string>;
  /** Carried inside the file so it stays true away from this page. */
  note: string;
}

/** The warning a partial export carries inside itself. Pure so the
 *  node-environment suite can pin it without a DOM. */
export function incompleteExportNote(stores: readonly string[]): string {
  return (
    'INCOMPLETE: this browser refused to let the app read ' +
    stores.join(' and ') +
    ', so whatever ' +
    (stores.length > 1 ? 'those stores hold' : 'that store holds') +
    ' is NOT in this file. Clearing site data through your browser’s own ' +
    'settings still reaches it.'
  );
}

/* Review round 5 P2 — this used to say the wallet address is "not held
   here" alongside the transactions. The transactions genuinely are not;
   the ADDRESS is in the stored key names wherever the user saved
   per-wallet settings (`app.alerts.<chain>.<wallet>`,
   `app.notif.lastseen.<chain>.<wallet>`), and therefore in this very
   file. Someone sharing the export on the strength of that sentence
   would be handing over an address-to-preferences linkage they were
   told was absent — public-on-the-chain and present-in-this-file are
   different facts, and the note now states each on its own. */
export const EXPORT_NOTE =
  'This file contains the data the Vaipakam app stores in this browser, on this ' +
  'device. Where you have saved per-wallet settings — alert preferences, or ' +
  'which notifications you have seen — your wallet address appears in the ' +
  'stored key names, so this file does link that address to those settings; ' +
  'treat it as personal before sharing it. It does NOT contain on-chain data: ' +
  'the transactions you have signed are public on the blockchain, not stored ' +
  'here, and you can look them up yourself on any block explorer. What no one, ' +
  'Vaipakam included, can do is erase them — erasing this browser removes ' +
  'only its local copies, never anything on the chain. It also does not ' +
  'contain anything held by the alerts service: unlinking in Settings ' +
  'removes the Telegram connection, while your alert preferences remain on ' +
  'that service for a future relink — email support@vaipakam.com to have ' +
  'those removed. A small amount of data belongs to each browser tab on its ' +
  'own, so this file covers the tab it was downloaded from — erasing reaches ' +
  'the others. Data stored by vaipakam.com is a separate store on a separate ' +
  'origin, with its own controls on that site.';

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

/**
 * How the in-memory last-error record enters the export, given what the
 * sessionStorage scan already found under its key.
 *
 * Review round 3 P2 established that the record must be exported at all
 * — when `sessionStorage.setItem` fails, `recordLastError` keeps the
 * record only in a module-level slot, and the drawer displays it while
 * the erasure clears it, so the app demonstrably HOLDS it. Review round
 * 5 P2 found the presence check alone was not enough: the memory slot
 * is written FIRST and the `setItem` after it can fail — a larger
 * replacement over quota is all it takes — leaving an OLDER record in
 * storage. "Key present, so nothing to add" then exported the stale
 * diagnostic while the drawer showed the newer one. So: absent → the
 * memory record fills the key; present but different → BOTH are
 * exported, the live one under a parenthesised label (the registry's
 * convention for a non-storage location) rather than overwriting the
 * evidence of what storage actually contains; identical → nothing, so
 * a normal browser sees no duplicate.
 */
export function liveLastErrorEntry(
  stored: unknown,
  inMemory: unknown,
): { key: string; value: unknown } | null {
  if (!inMemory) return null;
  if (stored === undefined) return { key: LAST_ERROR_KEY, value: inMemory };
  if (JSON.stringify(stored) !== JSON.stringify(inMemory)) {
    return { key: `${LAST_ERROR_KEY} (live)`, value: inMemory };
  }
  return null;
}

export function inspectMyData(): DataRightsSnapshot {
  const local = collect(safeStorage('localStorage'));
  const session = collect(safeStorage('sessionStorage'));
  const cookies = readCookies();
  const live = liveLastErrorEntry(session.data[LAST_ERROR_KEY], readLastError());
  if (live) session.data[live.key] = live.value;
  // Which stores refused, by the name a user would recognise. Feeds
  // both the page's `refused` flag and the in-file incomplete marker,
  // so the two cannot disagree about which stores are missing.
  const unreadable = [
    ...(local.refused ? ['localStorage'] : []),
    ...(session.refused ? ['sessionStorage'] : []),
    ...(cookies.refused ? ['cookies'] : []),
  ];
  const payload: DataRightsExport = {
    exportedAt: new Date().toISOString(),
    origin: typeof window === 'undefined' ? 'unknown' : window.location.origin,
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    ...(unreadable.length > 0
      ? {
          incomplete: {
            unreadableStores: unreadable,
            note: incompleteExportNote(unreadable),
          },
        }
      : {}),
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
    // Derived from the same list as the in-file marker, so the page's
    // warning and the file's can never name different states.
    refused: unreadable.length > 0,
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

/** Count what an erasure would remove from one store, preserving WHY it
 *  came back empty — the same distinction `collect` makes. */
function countErasable(storage: Storage | null): { count: number; refused: boolean } {
  if (!storage) return { count: 0, refused: true };
  let count = 0;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      if (isErasableStorageKey(storage.key(i))) count += 1;
    }
  } catch {
    return { count, refused: true };
  }
  return { count, refused: false };
}

/**
 * What an erasure would remove, counted over the ERASURE set (#1862).
 *
 * Separate from `inspectMyData().count`, which counts the EXPORT set, and the
 * separation is the point. Reusing the export count here meant connector keys
 * were invisible to both the "N items will be removed" figure the user sees
 * before confirming and the `remaining` figure checked afterwards — so a
 * connector key that refused removal, or that a live connector wrote straight
 * back, left the page reporting a clean success or "nothing was stored". A
 * verification that cannot see what the erasure targets is not a verification,
 * and on this page a false success is the failure mode that matters.
 */
export function inspectErasableData(): { count: number; refused: boolean } {
  const sessionStore = safeStorage('sessionStorage');
  const local = countErasable(safeStorage('localStorage'));
  const session = countErasable(sessionStore);
  const cookies = readCookies();
  // The in-memory last-error slot counts exactly as it does in
  // `eraseMyData` (round 5 P2). That function already documents the
  // invariant — the count shown before confirming and the count reported
  // after must agree in every state — and it was established by an earlier
  // round for the export path. I added this inventory without carrying the
  // rule across, so a record held only in memory, or one differing from the
  // stored copy, made the page offer "0 items" and then report one removed.
  let storedLastError: unknown;
  try {
    const raw = sessionStore?.getItem(LAST_ERROR_KEY);
    if (raw != null) storedLastError = decodeStored(raw);
  } catch {
    // Unreadable reads as absent — the same answer the other two paths give
    // in this state, which is what keeps the three counts equal.
  }
  const liveHolding = liveLastErrorEntry(storedLastError, readLastError());
  return {
    count:
      local.count +
      session.count +
      Object.keys(cookies.data).length +
      (liveHolding ? 1 : 0),
    refused: local.refused || session.refused || cookies.refused,
  };
}

function clearStorage(storage: Storage | null): number {
  if (!storage) return 0;
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      // The ERASURE predicate, not the export one (#1862): connector
      // namespaces must go, without their contents entering a portability
      // file.
      if (isErasableStorageKey(key)) keys.push(key as string);
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
  /**
   * Whether the cross-tab request actually left this tab (round 11 P2).
   *
   * The page tells the user other tabs were ASKED to clear and sign out, and
   * where `BroadcastChannel` is missing, blocked, or throws on `postMessage`,
   * none of them was — so a peer stays connected and keeps its per-tab data
   * while the page says the opposite. Best effort has to be reported as best
   * effort ATTEMPTED, not as best effort DELIVERED.
   *
   * `true` still promises nothing about what peers DID: nobody acknowledges,
   * by design. It means only that the request was sent.
   */
  peersNotified: boolean;
}

/**
 * #1862 Part 2 — the erasure registry.
 *
 * Part 1 could be a list of `localStorage` prefixes because everything it
 * reached lived in one store and came out with one synchronous sweep. That
 * stops being true here: the material that matters most — a live wallet
 * session — is in IndexedDB, which the Part 1 erasure never opened, and
 * removing it is asynchronous and can be REFUSED by another tab holding the
 * database open.
 *
 * So an entry has to say four things, and they are not interchangeable:
 * which store, which namespace within it, who writes it, and how it is
 * cleared. Only the first method below is synchronous, and only the first
 * can report its result immediately.
 *
 * The `evidence` field is not decoration. Part 1 shipped four markers of
 * which exactly one was confirmed from the code that composes the key; the
 * rest were literals spotted in shipped bundles. Recording how each entry
 * was established is what lets the next person tell a verified entry from a
 * guess, and it is why the IndexedDB entries below cite file and constant.
 */
export type ErasureMethod =
  /** A key sweep over a Web Storage area. Synchronous; result is exact. */
  | { readonly kind: 'webStorageMarker'; readonly marker: string }
  /**
   * Empty an IndexedDB object store, in place.
   *
   * NOT `deleteDatabase`, which is what this was until #1862 Part 2 round 1
   * and which does not work here. A database deletion blocks while ANY
   * connection is open — including this tab's own. `idb-keyval@6.2.2`, which
   * both wallet libraries use, caches its `IDBDatabase` in a module-level
   * promise, installs only an `onclose` handler and exposes no teardown, and
   * neither library closes it on disconnect. So the deletion blocked on US,
   * and the page then advised closing OTHER tabs — advice that could not
   * work, for a deletion that was never going to succeed.
   *
   * Clearing the store is not blockable in that way: it is an ordinary
   * readwrite transaction, which runs on a connection rather than requiring
   * every connection to close. It also removes exactly what the erasure is
   * for — the stored session material — and leaves an empty database behind,
   * which holds nothing about anyone.
   */
  | {
      readonly kind: 'indexedDbStore';
      readonly database: string;
      readonly store: string;
    };

export interface ErasureTarget {
  readonly store: 'localStorage' | 'sessionStorage' | 'indexedDB';
  readonly writtenBy: string;
  readonly holds: string;
  readonly evidence: string;
  readonly method: ErasureMethod;
}

/**
 * The two IndexedDB databases a connected wallet leaves on this origin.
 *
 * Both names are read out of the installed packages, not inferred from
 * documentation or from a running browser:
 *
 *  - `@walletconnect/keyvaluestorage@1.1.1`, `dist/index.es.js`:
 *    `const D = "WALLET_CONNECT_V2_INDEXED_DB", E = "keyvaluestorage"`,
 *    passed straight to `createStore(dbName, storeName)`. The same file
 *    migrates any pre-existing `localStorage` copies into this database and
 *    then DELETES them, which is why Part 1's `wc@2:` marker reaches at most
 *    a pre-migration remnant on a browser that has not run the migration.
 *  - `@coinbase/wallet-sdk@4.3.6`, `dist/kms/crypto-key/index.js`:
 *    `STORAGE_SCOPE = 'cbwsdk'`, `STORAGE_NAME = 'keys'`. This is the
 *    smart-wallet keypair store — `activeId` plus a record per public key.
 *
 * Each store is EMPTIED rather than its database deleted. The first revision
 * deleted the database, on the reasoning that on an origin this app has to
 * itself the database belongs to the wallet integration and nothing else —
 * true, and beside the point: a deletion blocks on every open connection
 * including this tab's own, and neither library closes the handle
 * `idb-keyval` caches. Clearing runs as an ordinary transaction, removes the
 * same material, and cannot be blocked by a connection that will never
 * close.
 */
export const ERASURE_REGISTRY: readonly ErasureTarget[] = [
  {
    store: 'indexedDB',
    writtenBy: '@walletconnect/keyvaluestorage (via idb-keyval)',
    holds: 'the live WalletConnect v2 session — pairing topics, keys, expiry',
    evidence:
      'dist/index.es.js constants D/E passed to createStore(dbName, storeName)',
    method: {
      kind: 'indexedDbStore',
      database: 'WALLET_CONNECT_V2_INDEXED_DB',
      store: 'keyvaluestorage',
    },
  },
  {
    store: 'indexedDB',
    writtenBy: '@coinbase/wallet-sdk kms/crypto-key',
    holds: "the Coinbase smart wallet's signing keypairs and active key id",
    evidence:
      "dist/kms/crypto-key/index.js STORAGE_SCOPE 'cbwsdk' / STORAGE_NAME 'keys'",
    method: { kind: 'indexedDbStore', database: 'cbwsdk', store: 'keys' },
  },
];

/** The `(database, store)` pairs the erasure empties, in registry order. */
export const ERASABLE_INDEXED_DB_STORES: readonly {
  readonly database: string;
  readonly store: string;
}[] = ERASURE_REGISTRY.flatMap((t) =>
  t.method.kind === 'indexedDbStore'
    ? [{ database: t.method.database, store: t.method.store }]
    : [],
);

/**
 * How long to wait for an IndexedDB request that never answers.
 *
 * Clearing a store is not blockable the way a database deletion is, but a
 * request can still hang — a browser mid-eviction, a storage layer wedged by
 * a privacy extension. The page cannot wait on that and must not report
 * success either, so the wait is bounded and a timeout is a refusal.
 */
export const INDEXED_DB_TIMEOUT_MS = 3_000;

export interface IndexedDbEraseResult {
  /** Stores emptied, or already absent. */
  readonly cleared: number;
  /**
   * How many records were actually removed.
   *
   * Separate from `cleared` because a store that was already empty and a
   * store that held a live session both "clear" successfully. Round 2 P2:
   * without this the page reported "there was nothing stored to erase" after
   * deleting a wallet session, since the only count it had came from the
   * synchronous Web Storage sweep.
   */
  readonly records: number;
  /**
   * Stores that could NOT be emptied, named `database/store` so the page can
   * say which rather than report a count nobody can act on.
   */
  readonly refused: readonly string[];
  /** True when this browser exposes no IndexedDB at all. */
  readonly unavailable: boolean;
}

/**
 * Empty one object store, resolving to whether it is now empty.
 *
 * A database or store that does not exist counts as success: absent is the
 * state the erasure wanted, and an origin that never connected a wallet has
 * neither.
 *
 * Deliberately does NOT create anything. `indexedDB.open(name)` with no
 * version creates the database when it is missing, so an erasure would leave
 * behind empty databases it invented — which is a strange thing for a
 * deletion to do. `onupgradeneeded` firing tells us the database did not
 * exist, so the transaction is abandoned and the creation undone.
 */
function clearObjectStore(
  database: string,
  store: string,
): Promise<{ ok: boolean; records: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, records = 0) => {
      if (settled) return;
      settled = true;
      resolve({ ok, records });
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(database);
    } catch {
      finish(false);
      return;
    }
    // Held so the timeout can tear them down (round 3 P2). The timeout exists
    // FOR the wedged-storage case, and resolving the wrapper as refused while
    // leaving the transaction running and this page's connection open makes
    // that case worse rather than bounded: the next attempt queues behind the
    // abandoned transaction and times out too, and the leaked connection is
    // exactly what blocks the browser-level "delete site data" the refusal
    // message sends people to.
    let openDb: IDBDatabase | undefined;
    let openTx: IDBTransaction | undefined;
    const timer = setTimeout(() => {
      try {
        // `abort()` on a transaction that has already finished throws; it is
        // also what fires `onabort`, so the guard below keeps that from
        // re-entering as a second resolution.
        openTx?.abort();
      } catch {
        // Nothing to abort, or already ending. Either way the close below is
        // the part that matters.
      }
      try {
        openDb?.close();
      } catch {
        // Best effort — a connection we cannot close is not a reason to hang.
      }
      finish(false);
    }, INDEXED_DB_TIMEOUT_MS);
    const done = (ok: boolean, records = 0) => {
      clearTimeout(timer);
      finish(ok, records);
    };
    let created = false;
    request.onupgradeneeded = () => {
      // The database was absent and this call is creating it. Nothing to
      // erase, and nothing should be left behind.
      //
      // ABORT THE UPGRADE rather than let it commit and delete afterwards
      // (round 6 P2). Create-then-delete leaves a window in which an empty
      // version-1 database exists WITHOUT the wallet library's object store:
      // if that library opens and caches it in the interval, our deletion is
      // blocked by its connection and `idb-keyval` is left holding a database
      // whose store does not exist, so its next transaction fails with
      // NotFoundError. An erasure must not be able to break the thing it is
      // erasing from. Aborting the version-change transaction means the
      // database is never created at all, and the abort is the SIGNAL for
      // absent rather than an error.
      created = true;
      try {
        request.transaction?.abort();
      } catch {
        // Older engines may refuse; the delete below is then the fallback.
      }
    };
    // AN ABORTED UPGRADE ARRIVES HERE, NOT AT `onsuccess` (round 7 P1). Real
    // IndexedDB does not deliver success after a version-change transaction is
    // aborted: the open request fires `error` with `AbortError`. So the abort
    // above — deliberate, and meaning "this database does not exist" — reached
    // this handler and was reported as a REFUSAL, which on any browser where a
    // registered database has never existed (the ordinary case for a wallet
    // the user never connected) would have made the inventory unreadable and
    // every erasure report both stores as held out.
    //
    // The round-6 test did not catch it because the STUB was written from the
    // same wrong model — it fired `onsuccess` after the abort. A stub that
    // encodes the author's assumption tests the assumption, not the code.
    request.onerror = () => done(created);
    request.onsuccess = () => {
      const db = request.result;
      // The open itself can outlast the timeout. Nothing further should be
      // attempted on a store already reported as refused, but the connection
      // it just handed us is real and would leak for the life of the page.
      if (settled) {
        try {
          db.close();
        } catch {
          // Best effort, as above.
        }
        return;
      }
      openDb = db;
      if (created) {
        db.close();
        try {
          indexedDB.deleteDatabase(database);
        } catch {
          // Best effort: an empty database we made is harmless, and failing
          // to remove it must not turn an erasure that had nothing to do
          // into a reported refusal.
        }
        done(true);
        return;
      }
      if (!db.objectStoreNames.contains(store)) {
        // Database exists but this library never wrote its store. Absent is
        // the wanted state.
        db.close();
        done(true);
        return;
      }
      try {
        const tx = db.transaction(store, 'readwrite');
        openTx = tx;
        const objectStore = tx.objectStore(store);
        // Counted BEFORE clearing, in the same transaction, so the figure is
        // what this erasure actually removed rather than a racy re-read.
        const counted = objectStore.count();
        objectStore.clear();
        tx.oncomplete = () => {
          db.close();
          done(true, typeof counted.result === 'number' ? counted.result : 0);
        };
        tx.onerror = () => {
          db.close();
          done(false);
        };
        tx.onabort = () => {
          db.close();
          done(false);
        };
      } catch {
        db.close();
        done(false);
      }
    };
  });
}

/**
 * The IndexedDB factory, or `undefined` where it cannot even be looked at.
 *
 * Round 11 P2. `typeof indexedDB === 'undefined'` reads a GLOBAL PROPERTY, and
 * a locked-down browser can expose it through a getter that throws
 * `SecurityError` — so the guard meant to detect "no IndexedDB here" was
 * itself the thing that threw, before either per-store `try` could run.
 * `eraseMyDataFully` then rejected after its synchronous sweep with no result
 * at all, and the page's inventory request was left unanswered: a browser
 * strict enough to hide the API got the worst outcome instead of the honest
 * one this module already has a state for.
 */
function indexedDbFactory(): IDBFactory | undefined {
  try {
    return typeof indexedDB === 'undefined' ? undefined : indexedDB;
  } catch {
    return undefined;
  }
}

/** What the registered databases are holding, without touching them. */
export interface IndexedDbInventory {
  /** Records across every registered store. */
  readonly records: number;
  /** True when any store could not be read, or the API is absent. */
  readonly refused: boolean;
}

/**
 * Count one object store without modifying it.
 *
 * The read-only twin of `clearObjectStore`, and it keeps every one of that
 * function's hard-won properties: it does not create a database that is
 * missing (`open` with no version would, so an inventory would invent the
 * thing it claims to be counting), it treats absent as zero rather than as a
 * failure, and it bounds the wait and tears the transaction down on the way
 * out.
 */
function countObjectStore(
  database: string,
  store: string,
): Promise<{ ok: boolean; records: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, records = 0) => {
      if (settled) return;
      settled = true;
      resolve({ ok, records });
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(database);
    } catch {
      finish(false);
      return;
    }
    let openDb: IDBDatabase | undefined;
    let openTx: IDBTransaction | undefined;
    const timer = setTimeout(() => {
      try {
        openTx?.abort();
      } catch {
        /* already ending */
      }
      try {
        openDb?.close();
      } catch {
        /* best effort */
      }
      finish(false);
    }, INDEXED_DB_TIMEOUT_MS);
    const done = (ok: boolean, records = 0) => {
      clearTimeout(timer);
      finish(ok, records);
    };
    let created = false;
    request.onupgradeneeded = () => {
      // Aborted, not created-then-deleted — see `clearObjectStore` for why:
      // an empty version-1 database without the wallet library's store is a
      // state that can break that library if it opens in the interval.
      created = true;
      try {
        request.transaction?.abort();
      } catch {
        // Older engines may refuse; the delete below is then the fallback.
      }
    };
    // An aborted upgrade lands here with `AbortError`, not at `onsuccess` —
    // see `clearObjectStore` for the full note. `created` means the abort was
    // ours and the database is absent, which counts as zero records read.
    request.onerror = () => done(created);
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        try {
          db.close();
        } catch {
          /* best effort */
        }
        return;
      }
      openDb = db;
      if (created) {
        db.close();
        try {
          indexedDB.deleteDatabase(database);
        } catch {
          /* an empty database we made is harmless */
        }
        done(true);
        return;
      }
      if (!db.objectStoreNames.contains(store)) {
        db.close();
        done(true);
        return;
      }
      try {
        const tx = db.transaction(store, 'readonly');
        openTx = tx;
        const counted = tx.objectStore(store).count();
        tx.oncomplete = () => {
          db.close();
          done(true, typeof counted.result === 'number' ? counted.result : 0);
        };
        tx.onerror = () => {
          db.close();
          done(false);
        };
        tx.onabort = () => {
          db.close();
          done(false);
        };
      } catch {
        db.close();
        done(false);
      }
    };
  });
}

/**
 * What the registered databases hold right now.
 *
 * Round 4 P2, and it is the round-2 defect one layer along. That round moved
 * the pre-confirm figure off the EXPORT inventory and onto the erasure one,
 * because a browser holding only connector keys was told nothing was stored
 * and then had those keys erased on confirm — the page contradicting itself
 * across a single click. Part 2 then added two databases to what the erasure
 * removes and left the pre-confirm figure synchronous, so the same
 * contradiction came back with the wallet SESSION in the gap: "Nothing is
 * stored", confirm, "erased 3 items".
 *
 * A browser that hides IndexedDB, or a store that will not answer, reports
 * `refused` — the page already has a "could not look" state, and it is the
 * honest one here for the same reason it is honest elsewhere: not knowing is
 * not nothing.
 */
export async function inspectIndexedDbData(): Promise<IndexedDbInventory> {
  if (!indexedDbFactory()) return { records: 0, refused: true };
  const targets = ERASABLE_INDEXED_DB_STORES;
  const outcomes = await Promise.all(
    targets.map((t) => countObjectStore(t.database, t.store)),
  );
  return {
    records: outcomes.reduce((n, o) => n + o.records, 0),
    refused: outcomes.some((o) => !o.ok),
  };
}

/**
 * Empty every store in the registry.
 *
 * Runs them concurrently: they are independent, and one wallet's storage
 * misbehaving should not delay the verdict on the other.
 */
export async function eraseIndexedDbData(): Promise<IndexedDbEraseResult> {
  if (!indexedDbFactory()) {
    return { cleared: 0, records: 0, refused: [], unavailable: true };
  }
  const targets = ERASABLE_INDEXED_DB_STORES;
  const outcomes = await Promise.all(
    targets.map((t) => clearObjectStore(t.database, t.store)),
  );
  const refused = targets
    .filter((_, i) => !outcomes[i]!.ok)
    .map((t) => `${t.database}/${t.store}`);
  return {
    cleared: outcomes.filter((o) => o.ok).length,
    records: outcomes.reduce((n, o) => n + o.records, 0),
    refused,
    unavailable: false,
  };
}

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

/**
 * Re-sweep Web Storage, announcing nothing and reporting nothing.
 *
 * For the one caller that needs to clean up after a write which arrived
 * AFTER an erasure had already been reported (round 4 P2 — a connector
 * teardown that was given up on and then completed anyway, rewriting
 * `wagmi.store` into storage that had been swept seconds earlier).
 *
 * Quiet on both counts, and deliberately. It does not `announceErase`,
 * because the broadcast is what drives every other tab's listener and a
 * cleanup firing it would restart a cross-tab cascade for a single key. It
 * returns nothing, because the figure the user was shown is frozen at the
 * moment it happened and a report that revises itself later is its own kind
 * of untruth. This is about what remains on the device.
 */
export function eraseConnectorStorageQuietly(): void {
  // NARROW BY DESIGN (round 7 P2). The blanket sweep is right when it runs
  // synchronously alongside the erasure and wrong when it runs SECONDS LATER,
  // which a slow multi-connector teardown makes routine: the tab stays usable
  // in the meantime, so the user can set a preference, take a receipt, or
  // trigger a notification — and a delayed blanket sweep then deletes records
  // created AFTER they asked to be erased, which nobody requested and nothing
  // reports. A late cleanup exists to undo what the TEARDOWN wrote, so it
  // removes only what a connector writes.
  //
  // The disconnect sentinel is excluded here as everywhere else, by
  // `isErasableStorageKey` — a cleanup that removed it would re-enable the
  // silent reconnect this PR exists to stop.
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    const store = safeStorage(kind);
    if (!store) continue;
    try {
      const doomed: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && isConnectorStorageKey(key)) doomed.push(key);
      }
      for (const key of doomed) {
        try {
          store.removeItem(key);
        } catch {
          // One stubborn key must not stop the others.
        }
      }
    } catch {
      // Storage unavailable — nothing to undo.
    }
  }
}

/** True when `key` is connector-written, and therefore something a late
 *  teardown could have re-created. Deliberately NOT the app's own keys. */
function isConnectorStorageKey(key: string): boolean {
  if (isDisconnectSentinelKey(key)) return false;
  const lower = key.toLowerCase();
  return THIRD_PARTY_STORAGE_MARKERS.some((marker) =>
    lower.includes(marker.toLowerCase()),
  );
}

export function eraseWebStorageQuietly(): void {
  clearStorage(safeStorage('localStorage'));
  clearStorage(safeStorage('sessionStorage'));
  // Cookies too (round 6 P2). A peer tab's language reset writes the
  // `vaipakam_lang` cookie as well as the storage key — `createI18n`'s
  // `languageChanged` listener emits both — so a cleanup that swept only Web
  // Storage restored an erased preference by half and left the cookie
  // standing. Anything called "quietly erase what a late write put back" has
  // to cover every store the erasure itself covers.
  clearCookies();
}

export function eraseMyData(): EraseResult {
  const cookies = clearCookies();
  const local = clearStorage(safeStorage('localStorage'));
  // Whether the in-memory last-error slot is a holding of its OWN,
  // decided before anything session-scoped is cleared and by the same
  // rule the export applies (review round 6 P2). Round 5 taught the
  // export to count a live record that differs from the stored one as
  // a second item; an erase that still counted only removed keys then
  // under-reported itself — "2 items held" before the confirm, "erased
  // 1" after, over the same two records, when `clearLastError` below
  // demonstrably removes both. The two paths must agree in every
  // state: key absent + memory held → the export filled the key with
  // it (one item), removal count is 0, the slot is the 1; different →
  // export showed two, removal count is 1, the slot is the second;
  // identical → the slot is a copy, counted by neither.
  const sessionStore = safeStorage('sessionStorage');
  let storedLastError: unknown;
  try {
    const raw = sessionStore?.getItem(LAST_ERROR_KEY);
    if (raw != null) storedLastError = decodeStored(raw);
  } catch {
    // Unreadable reads as absent — the same answer `collect` gives the
    // export in this state, which is what keeps the two counts equal.
  }
  const liveHolding = liveLastErrorEntry(storedLastError, readLastError());
  const session = clearStorage(sessionStore) + (liveHolding ? 1 : 0);
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
  // Whether the cross-tab request actually left this tab (round 11 P2). The
  // page claims other tabs were ASKED, and in a browser without a working
  // BroadcastChannel none of them was.
  const peersNotified = announceErase();
  return {
    localStorage: local,
    sessionStorage: session,
    cookies,
    total: local + session + cookies,
    peersNotified,
  };
}

/**
 * What a complete erasure removed, across every store in the registry.
 *
 * `EraseResult` is left exactly as it was and this wraps it, rather than
 * `eraseMyData` growing an async step. That is a deliberate response to how
 * the round-1 verification gap happened in Part 1: a function whose contract
 * is "returns what it removed" acquired a second job, and the counting stayed
 * behind. Here the synchronous contract keeps its meaning and the asynchronous
 * work is a separate, separately-reportable field.
 */
export interface ConnectorEraseResult {
  /** Whether a teardown was supplied at all. */
  readonly attempted: boolean;
  /** Whether it completed without throwing. */
  readonly disconnected: boolean;
}

export interface FullEraseResult extends EraseResult {
  readonly indexedDb: IndexedDbEraseResult;
  readonly connector: ConnectorEraseResult;
  /**
   * True when every store the registry names came away clean. NOT the same
   * as `total > 0`: a browser holding nothing erases nothing and is complete,
   * while one refusing a database deletion is incomplete however much Web
   * Storage it gave up. The page needs the second distinction to avoid
   * reporting a success over a live session.
   */
  readonly complete: boolean;
}

/**
 * How many stored items an erasure actually removed, across every store it
 * touched.
 *
 * `total` counts the SYNCHRONOUS sweep only — Web Storage and cookies — which
 * is the right contract for `eraseMyData` and the wrong number to show a
 * person (round 3 P2). Round 2 taught the page to stop saying "there was
 * nothing stored" after clearing a wallet session, but the sentence it
 * switched to still carried `total`, so the same erasure then announced
 * "Erased 0 stored items"; every mixed erasure under-reported by whatever the
 * databases held. The count on screen has to span the same set the sentence
 * claims to cover, so it is derived here once rather than composed at each
 * call site — there are two success messages and they must never disagree.
 */
export function erasedItemCount(result: FullEraseResult): number {
  return result.total + result.indexedDb.records;
}

/**
 * Build a teardown that disconnects EVERY live connection, not just the
 * current one.
 *
 * Structurally typed on purpose: it takes the connector list and the
 * disconnect action as plain values, so this module still knows nothing about
 * wagmi (the same reason `eraseMyDataFully` takes an injected `disconnect`),
 * while the loop that has to be right lives somewhere a test can reach it.
 *
 * Round 3 P1. `disconnectAsync()` with no argument reads as "disconnect" but
 * resolves its connector from `state.current` alone; with other connections
 * still in the map it removes one and promotes the next to current. So a tab
 * holding two wallets dropped one, resolved, and was reported signed out —
 * with the survivor's client free to write its session back into stores this
 * erasure had just emptied.
 *
 * Sequential, and over a list captured before the first teardown: that list is
 * the set that was connected when the user asked, and each disconnect mutates
 * the live one. A rejection propagates so the caller reports "did not
 * disconnect" rather than a clean sign-out over a wallet that held on.
 *
 * AN EMPTY LIST IS A FAILURE, not a vacuous success — found by self-review
 * after round 3, and it is round 2's defect returning through a new door. That
 * round established that a teardown resolving over nothing must not be
 * reported as a sign-out, and the page answered it by supplying a teardown
 * only when connected. This function would have undone that: the caller
 * decides to disconnect from the account status and takes the list from a
 * separate hook, so a list that is empty when the loop runs — the connection dropped
 * between render and click, by another tab or a wallet locking — would loop
 * zero times, resolve, and report a sign-out that never happened. The two
 * values come from one store and normally agree; "normally agree" is not the
 * standard for a claim made to a user about a legal right.
 */
export interface DisconnectEveryOptions<C = unknown> {
  /** Per-target bound. See `PER_CONNECTOR_TIMEOUT_MS`. */
  readonly perConnectorTimeoutMs?: number;
  /**
   * Called when a teardown the per-target bound GAVE UP ON eventually
   * settles — once per straggler, and never if none was given up on.
   *
   * Round 7 P2. The bound advances the LOOP; it does not stop the wagmi
   * action underneath, which on a late completion calls `config.setState` and
   * rewrites `wagmi.store`. The aggregate promise had already rejected by
   * then, so every cleanup hung off it ran at the bound and nothing ran after
   * the write.
   *
   * PER STRAGGLER, and named for that (round 8 P2). The first version waited
   * on `Promise.all` of every retained promise and was called `onAllSettled`
   * — a barrier one permanently pending connector holds open forever, so a
   * DIFFERENT connector completing late never triggered any cleanup at all. A
   * wedged wallet must not suppress the cleanup owed to the others. Must
   * therefore be IDEMPOTENT: several stragglers each call it.
   */
  readonly onStragglerSettled?: () => void;
  /**
   * Re-read the target list at CALL time instead of using the captured one.
   *
   * Round 8 P1. The captured list is a render-time snapshot, and during
   * wagmi's `reconnecting` state it is still filling — so a connection that
   * did not exist when the page rendered, but does by the time the user
   * confirms, would never be torn down and would survive the erasure. When
   * this returns a NON-EMPTY list it wins; an empty one falls back to the
   * captured targets, so a momentary gap cannot turn into the empty-list
   * refusal.
   */
  readonly connectorsAtRunTime?: () => readonly C[];
}

export function disconnectEvery<C>(
  connectors: readonly C[],
  disconnect: (args: { connector: C }) => Promise<unknown>,
  options: DisconnectEveryOptions<C> | number = {},
): () => Promise<void> {
  const opts: DisconnectEveryOptions<C> =
    typeof options === 'number' ? { perConnectorTimeoutMs: options } : options;
  const perConnectorTimeoutMs =
    opts.perConnectorTimeoutMs ?? PER_CONNECTOR_TIMEOUT_MS;
  const captured = [...connectors];
  return async () => {
    const live = opts.connectorsAtRunTime?.() ?? [];
    const targets = live.length > 0 ? [...live] : captured;
    if (targets.length === 0) {
      throw new Error(
        'disconnectEvery: asked to disconnect with no connectors — refusing ' +
          'to report a sign-out that did not happen',
      );
    }
    // EVERY connector is ATTEMPTED, even after one refuses (round 5 P2). A
    // bare `await` in the loop exits on the first rejection, so a wallet that
    // declines would leave every connector after it in the list still
    // connected and never even asked — and those are live clients, free to
    // write their session back into the storage the sweep is about to clear.
    // "One wallet held on" and "one wallet held on and the rest were never
    // tried" are very different states to leave a user in, and only the first
    // is what the report describes.
    // EACH ONE IS BOUNDED SEPARATELY (round 6 P2). Catching a rejection is
    // enough to move past a wallet that REFUSES; it does nothing for one that
    // simply never answers. A permanently pending promise parks this loop
    // forever, and the outer timeout does not help — it lets
    // `eraseMyDataFully` stop waiting, it does not advance the loop — so every
    // later wallet stayed connected without even being attempted, which is the
    // exact defect the aggregation fix was for, reachable by the one failure
    // mode that fix did not cover.
    const failures: unknown[] = [];
    for (const connector of targets) {
      // The ORIGINAL is kept so a straggler can still be acted on after the
      // loop has moved past it (round 7 P2): discarding it meant a connector
      // completing at five seconds wrote `wagmi.store` with nothing left to
      // notice, the aggregate having rejected at four.
      const original = Promise.resolve(disconnect({ connector }));
      // A SEPARATE swallowed copy, so holding a reference cannot raise an
      // unhandled rejection while `original` itself keeps rejecting for the
      // await below. Attaching the catch to the AWAITED promise — the first
      // attempt at this — turned every refusal into a silent success and
      // undid the aggregation two rounds of review had built.
      void original.catch(() => undefined);
      try {
        await withTimeout(original, perConnectorTimeoutMs);
      } catch (error) {
        failures.push(error);
        // This straggler cleans up after ITSELF when it settles — see
        // `onStragglerSettled` for why a barrier over all of them was wrong.
        //
        // ONLY ON A REAL TIMEOUT (round 11 P2). A connector that REFUSES has
        // finished: it will write nothing more, so there is nothing to clean
        // up after, and registering the callback anyway attached it to an
        // already-rejected promise — which fired the cleanup immediately,
        // ahead of the counted clear it was meant to follow.
        const cleanup =
          error instanceof TimeoutError ? opts.onStragglerSettled : undefined;
        if (cleanup) {
          void original.then(
            () => cleanup(),
            () => cleanup(),
          );
        }
      }
    }

    if (failures.length > 0) {
      // Still a rejection, so the caller reports "did not disconnect" — the
      // app IS still attached to something. What changes is that everything
      // detachable has been detached first.
      throw new AggregateError(
        failures,
        `disconnectEvery: ${failures.length} of ${targets.length} connectors ` +
          'did not disconnect',
      );
    }
  };
}

/**
 * Erase everything this origin holds, including the wallet databases.
 *
 * Web Storage and cookies go first and synchronously, so the per-tab
 * broadcast and the preference resets keep the ordering Part 1 established.
 * The database deletions then run and are awaited — they are the slow,
 * refusable part, and the caller must not report an outcome until they have
 * settled or timed out.
 */
/**
 * How long to wait for a connector teardown before giving up on it.
 *
 * Generous, because a wallet may legitimately prompt the user, and short
 * enough that a wedged transport cannot strand the erasure indefinitely.
 */
export const DISCONNECT_TIMEOUT_MS = 10_000;

/**
 * How long to wait for ONE connector before moving on to the next.
 *
 * Shorter than the whole-teardown bound, so several unresponsive wallets can
 * each be given up on inside it and the ones behind them still get asked. It
 * is not a subdivision of that bound and does not need to be: the outer one
 * caps what the USER waits, this one caps what one wallet can cost the
 * others.
 */
export const PER_CONNECTOR_TIMEOUT_MS = 4_000;

/**
 * Thrown by `withTimeout` when the WAIT expired, as opposed to the awaited
 * work rejecting on its own.
 *
 * The distinction is load-bearing (round 11 P2). Late cleanup exists for work
 * that is STILL RUNNING after we stopped waiting for it; a promise that
 * rejected promptly has finished, will write nothing more, and needs no
 * cleanup. Treating the two alike scheduled that cleanup immediately — and
 * since it now clears IndexedDB, it raced `eraseMyDataFully`'s own counted
 * clear and could empty the stores first, so the erasure reported zero
 * database records over records it had removed.
 */
class TimeoutError extends Error {}

/** Reject after `ms` if `promise` has not settled. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError('timeout')),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * Counts how many connections have been ESTABLISHED, in a way no later write
 * can revise downwards.
 *
 * Round 15 P2, and it is the fence's foundation rather than an optimisation.
 * Both late-cleanup fences asked wagmi whether anything was connected *now*,
 * and `@wagmi/core@2.22.1` makes that question unanswerable from status alone:
 * `disconnect` reads `config.state.connections` into a local BEFORE awaiting
 * the connector, while `connect` publishes `new Map(x.connections).set(...)`.
 * So once a teardown is slow enough for the user to connect again, the two
 * hold different Map objects — and when the teardown finally settles it
 * deletes from its orphaned one, sees `size === 0`, and writes
 * `status: 'disconnected'` with an empty map. wagmi loses the newer connection
 * and the fence is told nothing is live, seconds before it clears the stores
 * holding that connection's session. The fence was asking the one witness the
 * failure had already tampered with.
 *
 * A COUNT OF EVENTS, not a reading of state, is what survives that: the
 * connection happened, and a later write cannot make it not have happened.
 * The generation moves on every uid that appears without having been present
 * in the immediately preceding snapshot, so it also catches a RECONNECT OF THE
 * SAME WALLET — connector uids are stable for the life of the config, so a
 * set of uids ever seen would have counted MetaMask → disconnect → MetaMask as
 * one connection and missed the second entirely.
 *
 * The caller captures `current()` when the erase is requested and compares at
 * cleanup time; any increase means a session postdates the request. It counts
 * a `reconnect()` that completes after the request as well, which is
 * deliberately conservative: the cost is a stale connector key, and the
 * alternative is deleting a session the user is holding.
 *
 * Structural rather than wagmi-typed, so it can be driven from plain Maps in a
 * test — the page has no rendering harness, and this fence's whole value is
 * that it does not trust the store it observes.
 */
export interface ConnectionGeneration {
  /** The generation as of now. Monotonic; never decreases. */
  readonly current: () => number;
  /**
   * Feed one store notification: the connections now, and the ones
   * immediately before. Safe to call with identical maps.
   */
  readonly observe: (
    connections: ReadonlyMap<string, unknown>,
    previous: ReadonlyMap<string, unknown>,
  ) => void;
}

export function createConnectionGeneration(): ConnectionGeneration {
  let generation = 0;
  return {
    current: () => generation,
    observe: (connections, previous) => {
      for (const uid of connections.keys()) {
        if (!previous.has(uid)) generation += 1;
      }
    },
  };
}

/**
 * The one generation the app counts against, and it is a MODULE SINGLETON on
 * purpose (round 16 P2).
 *
 * The first version belonged to the Data Rights page, which is exactly the
 * lifetime it must not have. Erasing in a non-English locale calls
 * `changeLanguage('en')` FIRST, and `LanguageRemount` remounts the whole page
 * tree on that event — so the page unmounts, React runs its effect cleanup,
 * and the only subscription feeding the generation is torn down while the
 * erasure it was fencing is still running. The counter then freezes: a
 * connector that settles late finds a generation that has not moved since the
 * request, agrees with wagmi's stale `disconnected`, and clears the stores of
 * a session made in the REPLACEMENT tree. The remount also builds a second,
 * unrelated generation for the new page, which the in-flight erasure cannot
 * see.
 *
 * A fence whose lifetime is shorter than the operation it fences is not a
 * fence. This one is subscribed once where the wagmi config is created — above
 * `LanguageRemount`, above the router, outside React — so it observes for as
 * long as the tab lives.
 *
 * `createConnectionGeneration` stays exported for tests, which need instances
 * they can drive and reset.
 */
export const connectionGeneration = createConnectionGeneration();

export interface FullEraseOptions {
  /**
   * Whether a session exists that the erase request must not destroy, asked
   * at cleanup time.
   *
   * Round 14 P2. The late cleanup below can run arbitrarily long after the
   * erasure, and clearing whole wallet stores then destroys a session the
   * user created AFTER their request. The page's per-straggler callback
   * already declines in that case; this path is reached instead when the
   * AGGREGATE bound expires while every individual connector stayed inside
   * its own, so it needs the same fence and had none.
   *
   * NOT `isConnected`, and the rename is the round 15 P2 fix rather than
   * tidying. Both fences asked wagmi for its CURRENT STATUS, and that status
   * is the one thing a stale teardown is guaranteed to have overwritten:
   * `@wagmi/core@2.22.1`'s `disconnect` captures the connections map before
   * awaiting the connector, and `connect` replaces that map rather than
   * mutating it — so a teardown that settles late deletes from an orphaned
   * map, finds it empty, and writes `status: 'disconnected'` over a NEWER
   * connection. The fence then read `disconnected`, concluded nothing was
   * live, and cleared the very session it exists to protect. A predicate
   * named for the status invites exactly that implementation; one named for
   * the question makes it obvious that the answer has to come from something
   * the stale write cannot reach — see `createConnectionGeneration`.
   *
   * Injected rather than imported, like `disconnect`, so this module stays
   * free of the wagmi config. Absent means "cannot tell", which is treated
   * as no live session — the pre-existing behaviour.
   */
  readonly hasLiveSession?: () => boolean;
  /**
   * Tear down the live wallet connection. Injected rather than imported so
   * this module stays free of the wagmi config — it is a pure storage
   * library, and a page that has no wallet (or a test) supplies nothing.
   */
  readonly disconnect?: () => Promise<unknown>;
}

/**
 * Erase everything this origin holds: the live connection, Web Storage and
 * cookies, and the wallet databases.
 *
 * **The order is the mechanism, not statement order.**
 *
 * 1. Disconnect first, so a live client cannot write its session back into
 *    a store that has just been emptied. This was originally justified by
 *    `deleteDatabase` blocking on open connections; that justification went
 *    with the deletion (round 1 P1), but the ordering survives it on the
 *    simpler ground — erasing under a running client is a race, and the
 *    teardown is what ends it.
 * 2. Then the synchronous sweep, which also catches what the teardown itself
 *    writes on the way out, and which keeps the per-tab broadcast and
 *    preference ordering Part 1 established.
 *
 *    That the teardown writes is verified, and the mechanism is worth naming
 *    because the obvious candidate is the wrong one. `@wagmi/core`'s
 *    `createConfig` wraps its store in zustand's `persist` middleware under
 *    `name: 'store'` — so `wagmi.store` — and `disconnect` mutates
 *    `connections`, `current` and `status`, which rewrites that key every
 *    time. Its `setItem('recentConnectorId', …)` is the eye-catching write
 *    but the CONDITIONAL one: `disconnect.js` returns early unless a
 *    connection remains after the teardown, so a user disconnecting their
 *    only wallet never reaches it. An earlier revision of this comment cited
 *    the conditional write as the reason and would have been wrong in the
 *    ordinary single-wallet case.
 * 3. Then the database deletions, awaited, because no outcome may be
 *    reported until they have settled or timed out.
 *
 * A teardown that throws is caught and reported, never rethrown: a wallet
 * refusing to disconnect must not abort the erasure of everything else.
 */
export async function eraseMyDataFully(
  options: FullEraseOptions = {},
): Promise<FullEraseResult> {
  const { disconnect } = options;
  let connector: ConnectorEraseResult = {
    attempted: false,
    disconnected: false,
  };
  // Set only when the teardown was given up on, so a teardown that finishes
  // in time never triggers the late re-sweep below — its writes are already
  // caught by the ordinary sweep, which is the whole point of the ordering.
  //
  // EFFICIENCY, NOT CORRECTNESS, and recorded as such because a mutation run
  // says so: removing this guard survives every test, and should. On the
  // in-time path the continuation runs when the teardown resolves, which is
  // before `eraseMyData` — so an unconditional sweep there would be a
  // redundant pass immediately followed by the real one, invisible from
  // outside. The guard is worth keeping (a full Web Storage pass on every
  // successful erasure is waste) and is not worth claiming a test for.
  let settledLate = false;
  // Opened once the COUNTED clear below has finished. Every late cleanup —
  // this function's own, and the caller's per-straggler one, which is handed
  // the same gate — waits on it, so a teardown settling early cannot empty
  // the stores ahead of the call that counts them (round 12 P2).
  let openGate: () => void = () => {};
  const countedClearDone = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  if (disconnect) {
    try {
      // BOUNDED (round 1 P2). Only a REJECTED promise reaches the catch; one
      // that never settles — an unresponsive WalletConnect transport, a
      // wallet that never answers — would hang here forever, leaving the
      // page stuck on its working label with nothing erased at all. A
      // timeout is treated as "did not disconnect" so the rest of the
      // erasure still runs, which is the outcome that matters: failing to
      // close a connection must not cost the user the deletion of
      // everything else.
      const teardown = disconnect();
      // A TIMEOUT ABANDONS THE WAIT, NOT THE WORK (round 4 P2). `withTimeout`
      // rejects the wrapper; the wagmi action underneath keeps running, and
      // when it finally completes it calls `config.setState`, which rewrites
      // `wagmi.store` through zustand's `persist` — into storage this erasure
      // swept several seconds earlier. The device would then be left holding a
      // connector key the page had reported removed.
      //
      // So a late teardown re-sweeps. Web Storage only: that is where the late
      // write lands, and it is synchronous, so the re-sweep cannot itself
      // straddle anything. The ON-SCREEN result is deliberately NOT revised —
      // it is frozen at the moment it happened by an older decision, and a
      // report that rewrites itself minutes later is its own untruth. The
      // report already says the wallet held out and the erasure is incomplete,
      // which remains true; this is about what is left on the device, not
      // about what the page claims.
      //
      // ON BOTH OUTCOMES (round 6 P2). An earlier revision swept only on
      // fulfilment, reasoning that a failed teardown wrote nothing — true when
      // one refusal ended the whole attempt, and false since the aggregation
      // fix: `disconnectEvery` now keeps going, so one connector can let go
      // (persisting `wagmi.store`) before a later one refuses and makes the
      // aggregate reject. A rejection no longer means no connector completed.
      teardown
        .catch(() => {
          // Swallowed rather than left unhandled: this promise is no longer
          // awaited, and an unhandled rejection from a data-rights control
          // must not surface as a page error.
        })
        .finally(() => {
          // AFTER THE COUNTED CLEAR, never before it (round 12 P2). A late
          // teardown can settle at any moment, including one BEFORE this
          // function's own `eraseIndexedDbData()` has run — and this cleanup
          // empties the same stores, so it would leave that counted call
          // looking at an empty store and the erasure reporting zero database
          // records over records it removed. Queuing behind the gate makes the
          // ordering a property of the code rather than of the timing.
          void countedClearDone.then(() => {
          // CONNECTOR KEYS ONLY, for the reason round 7 gave about the peer
          // listener's equivalent: this fires seconds after the result was
          // reported, the page stays usable in between, and a blanket sweep
          // would delete records the user created AFTER the erasure. What a
          // late teardown can recreate is connector state, so that is all a
          // late cleanup has any business removing.
            // NOT IF THE USER HAS RECONNECTED SINCE (round 14 P2) — the same
            // fence the page's straggler callback got in round 13, on the
            // path that bypasses it. A stale connector key is a far better
            // outcome than deleting a live session.
            if (settledLate && !options.hasLiveSession?.()) {
              // BOTH stores (round 10 P2). The per-connector straggler
              // callback clears the databases, and this whole-teardown path
              // did not — but they catch different timeouts. Several
              // connectors can each finish INSIDE the per-target bound while
              // their sequential total exceeds the outer one (three at 3.5s
              // does it), so no `onStragglerSettled` is registered and this
              // continuation is the only cleanup that runs.
              eraseConnectorStorageQuietly();
              void eraseIndexedDbData();
            }
          });
        });
      await withTimeout(teardown, DISCONNECT_TIMEOUT_MS);
      connector = { attempted: true, disconnected: true };
    } catch (error) {
      connector = { attempted: true, disconnected: false };
      // Same distinction as inside `disconnectEvery`, and the same reason
      // (round 11 P2, second site — the finding named the per-connector one).
      // A teardown that REJECTED has finished; only one we stopped waiting for
      // can still write, so only that one earns a late cleanup. Setting this
      // on an ordinary rejection ran the cleanup before the counted clear
      // below and could zero the reported record count.
      settledLate = error instanceof TimeoutError;
    }
  }
  const base = eraseMyData();
  const indexedDb = await eraseIndexedDbData();
  // The counted clear is done; anything queued behind the gate may run now.
  openGate();
  return {
    ...base,
    indexedDb,
    connector,
    // A teardown that was asked for and failed leaves the app connected, so
    // it is as incomplete as a refused database — the page must not report
    // a clean erasure over a wallet that is still attached.
    // #1862 Part 2 round 1 P2 — `unavailable` is NOT clean. A browser that
    // hides IndexedDB after a wallet wrote to it leaves that material in
    // place and unverifiable; neither store was emptied nor observed absent,
    // so the honest answer is incomplete rather than success.
    complete:
      indexedDb.refused.length === 0 &&
      !indexedDb.unavailable &&
      (!connector.attempted || connector.disconnected),
  };
}
