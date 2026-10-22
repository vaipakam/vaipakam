/**
 * #2038 / #2035 — the erasure as one operation per tab, outside React, and a
 * report that survives the reload a wallet can force. Also the library's
 * fourth step (`disconnectLast`), which is what makes that reload harmless.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eraseMyDataFully, type FullEraseResult } from './dataRights';
import {
  KEPT_REPORT_WINDOW_MS,
  REPORT_KEY,
  dismissErasureReport,
  getErasureRun,
  parseKeptReport,
  reloadErasureRunForTests,
  resetErasureRunForTests,
  runErasure,
  subscribeErasureRun,
} from './erasureRun';
import type { WalletPort } from './walletTeardown';

const g = globalThis as Record<string, unknown>;
const saved = {
  window: g.window,
  document: g.document,
  indexedDB: g.indexedDB,
};

function fakeStorage(store: Map<string, string>): Storage {
  return {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

let local: Map<string, string>;
let session: Map<string, string>;
/** Every IndexedDB clear, so a test can see where it fell in the order. */
let events: string[];

beforeEach(() => {
  local = new Map();
  session = new Map();
  events = [];
  g.window = {
    localStorage: fakeStorage(local),
    sessionStorage: fakeStorage(session),
    location: { origin: 'https://app.example', hostname: 'app.example' },
    navigator: { userAgent: 'test' },
    dispatchEvent: () => true,
  };
  g.document = { cookie: '' };
  g.indexedDB = {
    deleteDatabase: () => ({}),
    open() {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          close: () => {},
          transaction: () => {
            const tx: Record<string, unknown> = {
              objectStore: () => ({
                count: () => ({ result: 1 }),
                clear: () => events.push('idb-clear'),
              }),
            };
            queueMicrotask(() => (tx.oncomplete as () => void)?.());
            return tx;
          },
        };
        (req.onsuccess as (() => void) | undefined)?.();
      });
      return req;
    },
  };
  resetErasureRunForTests();
});

afterEach(() => {
  resetErasureRunForTests();
  g.window = saved.window;
  g.document = saved.document;
  g.indexedDB = saved.indexedDB;
});

describe('eraseMyDataFully — the reload-prone teardown runs last (#2035)', () => {
  it('runs after the sweep AND the counted clear, and is handed the result so far', async () => {
    local.set('app.mode', 'lend');
    let interim: FullEraseResult | undefined;
    const result = await eraseMyDataFully({
      disconnect: async () => {
        events.push('first');
      },
      disconnectLast: async (soFar) => {
        events.push('last');
        interim = soFar;
        // What wagmi rewrites as the connector closes, after the sweep.
        local.set('wagmi.store', '{}');
      },
    });
    expect(events.indexOf('first')).toBeLessThan(events.indexOf('idb-clear'));
    expect(events.indexOf('idb-clear')).toBeLessThan(events.indexOf('last'));
    // The interim already counts what was erased.
    expect(interim?.total).toBe(1);
    expect(interim?.indexedDb.records).toBeGreaterThan(0);
    // ...and what the last teardown wrote on its way out was swept.
    expect(local.has('wagmi.store')).toBe(false);
    expect(result.connector).toEqual({
      attempted: true,
      disconnected: true,
      reconnectPending: false,
    });
    expect(result.complete).toBe(true);
  });

  it('folds a refusing last teardown into the outcome as incomplete', async () => {
    const result = await eraseMyDataFully({
      disconnectLast: async () => {
        throw new Error('wallet said no');
      },
    });
    expect(result.connector).toEqual({
      attempted: true,
      disconnected: false,
      reconnectPending: false,
    });
    expect(result.complete).toBe(false);
  });
});

/** A wallet port over one connected connector of the given id. */
function connectedPort(
  id: string,
  close: () => Promise<void> = async () => {},
): WalletPort<{ id: string }> & { closed: string[] } {
  let status = 'connected';
  const closed: string[] = [];
  return {
    closed,
    status: () => status,
    connectors: () => (status === 'connected' ? [{ id }] : []),
    isLive: () => true,
    reloadsOnDisconnect: (c) => c.id === 'coinbaseWalletSDK',
    disconnect: async (c) => {
      await close();
      closed.push(c.id);
      status = 'disconnected';
    },
    whenSettled: async () => true,
  };
}

describe('runErasure (#2038)', () => {
  it('keeps its state outside any component, and refuses a second run while one is going', async () => {
    let languageResets = 0;
    let release: () => void = () => {};
    const port = connectedPort(
      'metaMask',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const deps = {
      wallet: port,
      resetLanguage: () => {
        languageResets += 1;
      },
      resetPreferences: () => {},
    };
    const first = runErasure(deps);
    expect(getErasureRun().phase).toBe('running');
    // A replacement page — the old one remounted away — sees the same run
    // and cannot start another over it.
    const unsubscribe = subscribeErasureRun(() => {});
    unsubscribe();
    await runErasure(deps);
    expect(languageResets).toBe(1);
    // Let the teardown reach the wallet before the wallet answers.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await first;
    const run = getErasureRun();
    expect(run.phase).toBe('done');
    if (run.phase !== 'done') return;
    expect(run.report.connector.disconnected).toBe(true);
    expect(run.report.reloadedDuringLast).toBe(false);
    dismissErasureReport();
    expect(getErasureRun().phase).toBe('idle');
  });
});

describe('a report kept across a wallet-forced reload (#2035)', () => {
  it('stays kept for a bounded window after a teardown that did not reload, then is removed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let keptDuringClose: string | undefined;
      const port = connectedPort('coinbaseWalletSDK', async () => {
        keptDuringClose = session.get(REPORT_KEY);
      });
      await runErasure({
        wallet: port,
        resetLanguage: () => {},
        resetPreferences: () => {},
      });
      expect(keptDuringClose).toBeDefined();
      // The teardown resolving is not proof that no reload is coming
      // (WalletLink reloads after an un-awaited disconnect), so the copy
      // outlives the run...
      expect(session.has(REPORT_KEY)).toBe(true);
      const run = getErasureRun();
      expect(run.phase === 'done' && run.report.reloadedDuringLast).toBe(false);
      // ...and a reload that lands late, inside the window, still shows it.
      reloadErasureRunForTests();
      const after = getErasureRun();
      expect(after.phase === 'done' && after.report.reloadedDuringLast).toBe(true);
      expect(session.has(REPORT_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is removed at the end of the window when no reload comes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await runErasure({
        wallet: connectedPort('coinbaseWalletSDK'),
        resetLanguage: () => {},
        resetPreferences: () => {},
      });
      expect(session.has(REPORT_KEY)).toBe(true);
      vi.advanceTimersByTime(KEPT_REPORT_WINDOW_MS - 1);
      expect(session.has(REPORT_KEY)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(session.has(REPORT_KEY)).toBe(false);
      // The report on screen is unaffected: only the kept copy goes.
      expect(getErasureRun().phase).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is removed when the report is dismissed', async () => {
    await runErasure({
      wallet: connectedPort('coinbaseWalletSDK'),
      resetLanguage: () => {},
      resetPreferences: () => {},
    });
    expect(session.has(REPORT_KEY)).toBe(true);
    dismissErasureReport();
    expect(session.has(REPORT_KEY)).toBe(false);
    reloadErasureRunForTests();
    expect(getErasureRun().phase).toBe('idle');
  });

  it('is never kept for a wallet that does not reload', async () => {
    await runErasure({
      wallet: connectedPort('metaMask'),
      resetLanguage: () => {},
      resetPreferences: () => {},
    });
    expect(session.has(REPORT_KEY)).toBe(false);
  });

  it('is refused once the window has passed, or when stamped in the future', async () => {
    await runErasure({
      wallet: connectedPort('coinbaseWalletSDK'),
      resetLanguage: () => {},
      resetPreferences: () => {},
    });
    const raw = session.get(REPORT_KEY);
    expect(raw).toBeDefined();
    if (raw === undefined) return;
    const keptAt = (JSON.parse(raw) as { keptAt: number }).keptAt;
    expect(parseKeptReport(raw, keptAt)).not.toBeNull();
    expect(parseKeptReport(raw, keptAt + KEPT_REPORT_WINDOW_MS)).not.toBeNull();
    expect(parseKeptReport(raw, keptAt + KEPT_REPORT_WINDOW_MS + 1)).toBeNull();
    expect(parseKeptReport(raw, keptAt - 1)).toBeNull();
  });

  it('is shown after a reload, with the last step marked unknown, and taken out as it is read', async () => {
    local.set('app.mode', 'lend');
    let reloaded = false;
    const port = connectedPort('coinbaseWalletSDK', async () => {
      // The reload lands while the connector closes: a fresh module load
      // reads the kept copy.
      reloadErasureRunForTests();
      reloaded = true;
      await new Promise(() => {}); // a reloaded page never continues
    });
    void runErasure({
      wallet: port,
      resetLanguage: () => {},
      resetPreferences: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reloaded).toBe(true);
    const run = getErasureRun();
    expect(run.phase).toBe('done');
    if (run.phase !== 'done') return;
    expect(run.report.reloadedDuringLast).toBe(true);
    expect(run.report.total).toBe(1);
    // Read once, gone: it does not survive a second load.
    expect(session.has(REPORT_KEY)).toBe(false);
  });

  it('drops a malformed kept report rather than showing it', () => {
    expect(parseKeptReport('not json')).toBeNull();
    expect(parseKeptReport('{}')).toBeNull();
    expect(parseKeptReport(JSON.stringify({ total: 'seven' }))).toBeNull();
    // The pre-window shape (a bare report, no envelope) is refused too.
    expect(parseKeptReport(JSON.stringify({ total: 1 }))).toBeNull();
    expect(
      parseKeptReport(JSON.stringify({ keptAt: 'now', report: { total: 1 } })),
    ).toBeNull();
  });
});
