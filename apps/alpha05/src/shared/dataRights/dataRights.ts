/**
 * Data rights (#3180 Settings slice 2, ACC-55; RB-DATA-RIGHTS): what this
 * browser holds for the app, a download of the app's own records, and an
 * erasure of everything this site keeps.
 *
 * The app runs on its own address, so every item in this origin's storage is
 * this app's: its own records (named below), the wallet connection's records
 * (written by the wallet libraries), and per-tab session items. Erasure
 * removes all of them, plus the language cookie this app shares with the
 * other Vaipakam sites. The download carries the app's own records only; the
 * wallet connection's records are session material for the wallet link, not
 * a record about the reader, and are counted but not copied out.
 *
 * Every step reports what it did and what it could not do; nothing is
 * claimed that was not measured.
 */

/** Keys the app itself writes, by prefix. Anything else in this origin's
 *  storage was written by the wallet libraries. */
export const APP_KEY_PREFIXES = ['app.', 'alpha05.', 'vaipakam:language'] as const;

/** The language cookie shared with the other Vaipakam sites. The theme
 *  cookie, where one exists, is the marketing site's own and this app never
 *  reads it, so it is not touched. */
export const LANG_COOKIE = 'vaipakam_lang';

/** Where the last erasure's report is kept for this tab, so it survives the
 *  reload that resets every preference. */
export const REPORT_KEY = 'alpha05.dataRights.report';

export type StorageLike = Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem' | 'setItem'>;

export interface Inventory {
  /** The app's own records in this browser, by key. */
  app: { key: string; value: string }[];
  /** Items the wallet libraries keep in this site's storage. */
  connector: number;
  /** Per-tab items (cleared when the tab closes). */
  session: number;
  /** Named databases this site holds (wallet libraries use them). */
  databases: string[] | 'unknown';
  /** Whether the shared language cookie is set. */
  langCookie: boolean;
  /** Storage this browser refused to let the app read. */
  unreadable: ('local' | 'session')[];
}

export function isAppKey(key: string): boolean {
  return APP_KEY_PREFIXES.some((p) => key === p || key.startsWith(p));
}

function keysOf(store: StorageLike): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k !== null) out.push(k);
  }
  return out;
}

export function readCookie(name: string, cookie: string): string | null {
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export interface Sources {
  local: () => StorageLike;
  session: () => StorageLike;
  databases: () => Promise<string[] | 'unknown'>;
  cookie: () => string;
}

export function browserSources(): Sources {
  return {
    local: () => window.localStorage,
    session: () => window.sessionStorage,
    databases: async () => {
      // Not every browser can list databases; then the count is unknown,
      // said as such, and erasure still removes the ones it knows by name.
      if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return 'unknown';
      try {
        const list = await indexedDB.databases();
        return list.map((d) => d.name).filter((n): n is string => typeof n === 'string');
      } catch {
        return 'unknown';
      }
    },
    cookie: () => document.cookie,
  };
}

export async function takeInventory(src: Sources = browserSources()): Promise<Inventory> {
  const inv: Inventory = { app: [], connector: 0, session: 0, databases: await src.databases(), langCookie: false, unreadable: [] };
  try {
    const local = src.local();
    for (const key of keysOf(local)) {
      if (isAppKey(key)) inv.app.push({ key, value: local.getItem(key) ?? '' });
      else inv.connector++;
    }
    inv.app.sort((a, b) => a.key.localeCompare(b.key));
  } catch {
    inv.unreadable.push('local');
  }
  try {
    inv.session = keysOf(src.session()).filter((k) => k !== REPORT_KEY).length;
  } catch {
    inv.unreadable.push('session');
  }
  try {
    inv.langCookie = readCookie(LANG_COOKIE, src.cookie()) !== null;
  } catch {
    inv.langCookie = false;
  }
  return inv;
}

/** How many items an erasure would remove, as the page states before the
 *  reader confirms. Unknown databases are not counted, and the page says so. */
export function itemCount(inv: Inventory): number {
  return inv.app.length + inv.connector + inv.session + (inv.databases === 'unknown' ? 0 : inv.databases.length) + (inv.langCookie ? 1 : 0);
}

/** The download: the app's own records, with what the file contains and what
 *  it leaves out said inside it, so the file explains itself. */
export function downloadBody(inv: Inventory, at: Date, wallets: readonly string[]): string {
  return JSON.stringify(
    {
      about:
        'What the Vaipakam app (alpha05) keeps in this browser for this site, as of the time below. Your positions and history on chain are public and are not in this file.',
      at: at.toISOString(),
      walletAddresses: wallets,
      walletAddressesNote: 'Records are kept per wallet address, so the addresses above appear in this file.',
      records: Object.fromEntries(inv.app.map((r) => [r.key, parseMaybe(r.value)])),
      notIncluded: {
        walletConnectionItems: inv.connector,
        perTabItems: inv.session,
        databases: inv.databases,
        why: 'These are the wallet connection’s own session records and per-tab items. Erasing removes them; they are not copied into this file.',
      },
      ...(inv.unreadable.length > 0 ? { incomplete: `This browser refused to let the app read: ${inv.unreadable.join(', ')}. This file may be missing records.` } : {}),
    },
    null,
    2,
  );
}

function parseMaybe(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export interface EraseReport {
  at: number;
  /** Whether a wallet was connected when erasure started, and whether every
   *  connection ended. Null when none was connected. */
  disconnected: boolean | null;
  removed: { app: number; connector: number; session: number; databases: number; langCookie: boolean };
  /** What could not be removed, each with its own reason. */
  refused: { what: 'local' | 'session' | 'database' | 'cookie'; name?: string; reason: string }[];
  databasesUnknown: boolean;
}

export interface EraseSteps extends Sources {
  disconnect: () => Promise<boolean | null>;
  deleteDatabase: (name: string) => Promise<void>;
  clearCookie: (name: string) => void;
}

/** Ordered teardown: end the wallet connection first (so the libraries do not
 *  write their records back), then sweep this site's storage, databases and
 *  the shared language cookie. Each step's failure is reported, never
 *  hidden, and the next step still runs. */
export async function eraseAll(steps: EraseSteps, now: number = Date.now()): Promise<EraseReport> {
  const report: EraseReport = {
    at: now,
    disconnected: null,
    removed: { app: 0, connector: 0, session: 0, databases: 0, langCookie: false },
    refused: [],
    databasesUnknown: false,
  };
  try {
    report.disconnected = await steps.disconnect();
  } catch {
    report.disconnected = false;
  }
  try {
    const local = steps.local();
    for (const key of keysOf(local)) {
      local.removeItem(key);
      if (isAppKey(key)) report.removed.app++;
      else report.removed.connector++;
    }
    if (local.length > 0) report.refused.push({ what: 'local', reason: `${local.length} item(s) were written back or would not go` });
  } catch (e) {
    report.refused.push({ what: 'local', reason: (e as Error).message || 'storage refused' });
  }
  try {
    const session = steps.session();
    for (const key of keysOf(session)) {
      if (key === REPORT_KEY) continue;
      session.removeItem(key);
      report.removed.session++;
    }
  } catch (e) {
    report.refused.push({ what: 'session', reason: (e as Error).message || 'storage refused' });
  }
  const dbs = await steps.databases();
  if (dbs === 'unknown') report.databasesUnknown = true;
  else {
    for (const name of dbs) {
      try {
        await steps.deleteDatabase(name);
        report.removed.databases++;
      } catch (e) {
        report.refused.push({ what: 'database', name, reason: (e as Error).message || 'the browser kept it open' });
      }
    }
  }
  try {
    const had = readCookie(LANG_COOKIE, steps.cookie()) !== null;
    if (had) {
      steps.clearCookie(LANG_COOKIE);
      if (readCookie(LANG_COOKIE, steps.cookie()) === null) report.removed.langCookie = true;
      else report.refused.push({ what: 'cookie', name: LANG_COOKIE, reason: 'the browser kept it' });
    }
  } catch (e) {
    report.refused.push({ what: 'cookie', name: LANG_COOKIE, reason: (e as Error).message || 'cookies refused' });
  }
  return report;
}

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('could not be deleted'));
    // Blocked: another tab holds it open; it is deleted once that tab lets go.
    req.onblocked = () => reject(new Error('another tab of this site holds it open'));
  });
}

/** Expire the shared cookie at every scope it may have been set at. */
export function clearCookie(name: string, host: string = window.location.hostname): void {
  const past = 'Thu, 01 Jan 1970 00:00:00 GMT';
  const parts = host.split('.');
  const domains = [''];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`; domain=.${parts.slice(i).join('.')}`);
  for (const d of domains) document.cookie = `${name}=; expires=${past}; path=/${d}`;
}

export function parseReport(raw: string | null): EraseReport | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as EraseReport;
    return typeof r.at === 'number' && r.removed && Array.isArray(r.refused) ? r : null;
  } catch {
    return null;
  }
}
