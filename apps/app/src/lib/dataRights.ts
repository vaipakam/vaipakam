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
export function isErasableStorageKey(key: string | null | undefined): boolean {
  if (!key) return false;
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
   * `indexedDB.deleteDatabase`. Asynchronous, and genuinely refusable: the
   * request BLOCKS while any other tab on this origin holds the database
   * open, and a blocked deletion must be reported as a refusal rather than
   * waited on forever.
   */
  | { readonly kind: 'indexedDbDatabase'; readonly database: string };

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
 * The whole database is deleted rather than individual keys. On an origin
 * this app has to itself the database belongs to the wallet integration and
 * nothing else, so a scoped key deletion would be more code for a strictly
 * smaller guarantee. That reasoning is origin-specific and would not hold on
 * a shared origin, which is why it is written here rather than assumed.
 */
export const ERASURE_REGISTRY: readonly ErasureTarget[] = [
  {
    store: 'indexedDB',
    writtenBy: '@walletconnect/keyvaluestorage (via idb-keyval)',
    holds: 'the live WalletConnect v2 session — pairing topics, keys, expiry',
    evidence:
      'dist/index.es.js constants D/E passed to createStore(dbName, storeName)',
    method: {
      kind: 'indexedDbDatabase',
      database: 'WALLET_CONNECT_V2_INDEXED_DB',
    },
  },
  {
    store: 'indexedDB',
    writtenBy: '@coinbase/wallet-sdk kms/crypto-key',
    holds: "the Coinbase smart wallet's signing keypairs and active key id",
    evidence:
      "dist/kms/crypto-key/index.js STORAGE_SCOPE 'cbwsdk' / STORAGE_NAME 'keys'",
    method: { kind: 'indexedDbDatabase', database: 'cbwsdk' },
  },
];

/** Databases the erasure deletes, in registry order. */
export const ERASABLE_INDEXED_DB_NAMES: readonly string[] =
  ERASURE_REGISTRY.flatMap((t) =>
    t.method.kind === 'indexedDbDatabase' ? [t.method.database] : [],
  );

/**
 * How long to wait for a `deleteDatabase` that another tab is blocking.
 *
 * A blocked deletion never completes on its own — it waits for every other
 * connection to close, which may be never. The page cannot hang on that, and
 * it must not report success either, so the wait is bounded and a timeout is
 * reported as a refusal.
 */
export const INDEXED_DB_DELETE_TIMEOUT_MS = 3_000;

export interface IndexedDbEraseResult {
  /** Databases deleted, or already absent. */
  readonly deleted: number;
  /**
   * Databases that could NOT be deleted — blocked by another tab, timed
   * out, or rejected. Named so the page can say which, rather than
   * reporting a count the user cannot act on.
   */
  readonly refused: readonly string[];
  /** True when this browser exposes no IndexedDB at all. */
  readonly unavailable: boolean;
}

/**
 * Delete one IndexedDB database, resolving to whether it is now gone.
 *
 * Three outcomes, deliberately not collapsed:
 *  - `success` — deleted, or it never existed (`deleteDatabase` succeeds
 *    either way, and "absent" is the state the erasure wanted).
 *  - `blocked` — another tab holds it open. Reported, never waited out.
 *  - `error` — the request failed.
 */
function deleteDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch {
      // Some privacy modes throw on access rather than returning a request.
      finish(false);
      return;
    }
    // A blocked request stays pending indefinitely, so the timeout is the
    // only thing that ends it. It resolves FALSE: the database is still
    // there, and saying otherwise is the false-assurance failure this page
    // exists to avoid.
    const timer = setTimeout(() => finish(false), INDEXED_DB_DELETE_TIMEOUT_MS);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      finish(ok);
    };
    request.onsuccess = () => done(true);
    request.onerror = () => done(false);
    request.onblocked = () => done(false);
  });
}

/**
 * Delete every database in the registry.
 *
 * Runs them concurrently: they are independent, and a wallet holding one
 * open should not delay the verdict on the other.
 */
export async function eraseIndexedDbData(): Promise<IndexedDbEraseResult> {
  if (typeof indexedDB === 'undefined') {
    return { deleted: 0, refused: [], unavailable: true };
  }
  const names = ERASABLE_INDEXED_DB_NAMES;
  const outcomes = await Promise.all(names.map((n) => deleteDatabase(n)));
  const refused = names.filter((_, i) => !outcomes[i]);
  return {
    deleted: outcomes.filter(Boolean).length,
    refused,
    unavailable: false,
  };
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
  announceErase();
  return {
    localStorage: local,
    sessionStorage: session,
    cookies,
    total: local + session + cookies,
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
 * Erase everything this origin holds, including the wallet databases.
 *
 * Web Storage and cookies go first and synchronously, so the per-tab
 * broadcast and the preference resets keep the ordering Part 1 established.
 * The database deletions then run and are awaited — they are the slow,
 * refusable part, and the caller must not report an outcome until they have
 * settled or timed out.
 */
export interface FullEraseOptions {
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
 * 1. Disconnect first. A connector that is still running is the thing most
 *    likely to hold a database open, and an open connection is exactly what
 *    makes `deleteDatabase` block. Giving the client the chance to close is
 *    the difference between a deletion that succeeds and one that has to be
 *    reported as refused. This is a REASON for the ordering, not a promise
 *    that it works — whether a given connector closes its database on
 *    teardown is not something this app can guarantee, which is why the
 *    refusal path in step 3 exists and is reported.
 * 2. Then the synchronous sweep, which also catches anything the teardown
 *    itself wrote on the way out (wagmi rewrites its own keys as it
 *    disconnects), and which keeps the per-tab broadcast and preference
 *    ordering Part 1 established.
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
  if (disconnect) {
    try {
      await disconnect();
      connector = { attempted: true, disconnected: true };
    } catch {
      connector = { attempted: true, disconnected: false };
    }
  }
  const base = eraseMyData();
  const indexedDb = await eraseIndexedDbData();
  return {
    ...base,
    indexedDb,
    connector,
    // A teardown that was asked for and failed leaves the app connected, so
    // it is as incomplete as a refused database — the page must not report
    // a clean erasure over a wallet that is still attached.
    complete:
      indexedDb.refused.length === 0 &&
      (!connector.attempted || connector.disconnected),
  };
}
