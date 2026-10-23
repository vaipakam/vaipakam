/**
 * #2038 / #2035 — the erasure as one operation per tab, outside React, and a
 * report that survives the reload a wallet can force. Also the library's
 * fourth step (`disconnectLast`), which is what makes that reload harmless.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  eraseMyDataFully,
  inspectErasableData,
  type FullEraseResult,
} from './dataRights';
import {
  RELOAD_WINDOW_MS,
  REPORT_KEY,
  dismissErasureReport,
  followPeerErasure,
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
        return true;
      },
      disconnectLast: async (soFar) => {
        events.push('last');
        interim = soFar;
        // What wagmi rewrites as the connector closes, after the sweep.
        local.set('wagmi.store', '{}');
        return true;
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
  // One object for the life of the port, as wagmi's connectors are.
  const connector = { id };
  return {
    closed,
    status: () => status,
    connectors: () => (status === 'connected' ? [connector] : []),
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
    // Let the teardown reach the wallet before the wallet answers.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(languageResets).toBe(1);
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
      vi.advanceTimersByTime(RELOAD_WINDOW_MS - 1);
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

  it('is not counted as something the erasure left behind (Codex #2670 r2 P1)', async () => {
    local.set('app.mode', 'lend');
    await runErasure({
      wallet: connectedPort('coinbaseWalletSDK'),
      resetLanguage: () => {},
      resetPreferences: () => {},
    });
    expect(session.has(REPORT_KEY)).toBe(true);
    const run = getErasureRun();
    expect(run.phase).toBe('done');
    if (run.phase !== 'done') return;
    expect(run.report.remaining).toBe(0);
    expect(inspectErasableData().count).toBe(0);
  });

  it("is removed by the next erasure, and not by another tab's", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await runErasure({
        wallet: connectedPort('coinbaseWalletSDK'),
        resetLanguage: () => {},
        resetPreferences: () => {},
      });
      expect(session.has(REPORT_KEY)).toBe(true);
      // A peer's per-tab sweep leaves it to its owner...
      followPeerErasure({
        wallet: connectedPort('metaMask'),
        followPreferences: () => {},
        followLanguage: () => {},
      });
      expect(session.has(REPORT_KEY)).toBe(true);
      // ...and this tab's next erasure keeps it while it waits out the
      // reload this tab may still owe (Codex #2670 r4), then drops it.
      const kept = session.get(REPORT_KEY);
      // Dismissing would drop it; the page's own state is reset instead.
      dismissErasureReport();
      session.set(REPORT_KEY, kept ?? '');
      const next = runErasure({
        wallet: connectedPort('metaMask'),
        resetLanguage: () => {},
        resetPreferences: () => {},
      });
      await vi.advanceTimersByTimeAsync(RELOAD_WINDOW_MS - 1);
      expect(session.get(REPORT_KEY)).toBe(kept);
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(session.has(REPORT_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    expect(parseKeptReport(raw, keptAt + RELOAD_WINDOW_MS)).not.toBeNull();
    expect(parseKeptReport(raw, keptAt + RELOAD_WINDOW_MS + 1)).toBeNull();
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

  it('is discarded unread by a load that is not a reload (Codex #2670 r4)', async () => {
    // A tab opened from this one inherits its sessionStorage, kept report
    // included; it neither ran the erasure nor reloaded during it.
    await runErasure({
      wallet: connectedPort('coinbaseWalletSDK'),
      resetLanguage: () => {},
      resetPreferences: () => {},
    });
    expect(session.has(REPORT_KEY)).toBe(true);
    reloadErasureRunForTests('navigate');
    expect(getErasureRun().phase).toBe('idle');
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

describe("one lock for this tab's run and its follow-up of another tab (Codex #2670 r2 P1)", () => {
  it("leaves a broadcast heard during this tab's own run to that run", async () => {
    let release: () => void = () => {};
    const own = connectedPort(
      'metaMask',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const running = runErasure({
      wallet: own,
      resetLanguage: () => {},
      resetPreferences: () => {},
    });
    expect(getErasureRun().phase).toBe('running');
    let followed = 0;
    const peerWallet = connectedPort('coinbaseWalletSDK');
    followPeerErasure({
      wallet: peerWallet,
      followPreferences: () => {
        followed += 1;
      },
      followLanguage: () => {
        followed += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // No second teardown — in particular no reload-prone close racing the run.
    expect(peerWallet.closed).toEqual([]);
    expect(followed).toBe(0);
    release();
    await running;
    expect(getErasureRun().phase).toBe('done');
  });

  it("waits for a follow-up until its reload can no longer come, before starting (Codex #2670 r3)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let release: () => void = () => {};
      const port = connectedPort(
        'coinbaseWalletSDK',
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      followPeerErasure({
        wallet: port,
        followPreferences: () => {},
        followLanguage: () => {},
      });
      await vi.advanceTimersByTimeAsync(10);
      let languageResets = 0;
      const run = runErasure({
        wallet: port,
        resetLanguage: () => {
          languageResets += 1;
        },
        resetPreferences: () => {},
      });
      // The run holds the lock (a second request is refused) but has done
      // nothing yet: a reload landing now would interrupt nothing.
      expect(getErasureRun().phase).toBe('running');
      await vi.advanceTimersByTimeAsync(10);
      expect(languageResets).toBe(0);
      // The close resolves — but the SDK's reload can still be on its way,
      // so the follow-up keeps the lock for the reload window.
      release();
      await vi.advanceTimersByTimeAsync(RELOAD_WINDOW_MS - 1);
      expect(languageResets).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(languageResets).toBe(1);
      expect(port.closed).toEqual(['coinbaseWalletSDK']);
      expect(getErasureRun().phase).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hold the lock after a follow-up that closed no reload-prone wallet', async () => {
    const port = connectedPort('metaMask');
    followPeerErasure({
      wallet: port,
      followPreferences: () => {},
      followLanguage: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    let languageResets = 0;
    await runErasure({
      wallet: port,
      resetLanguage: () => {
        languageResets += 1;
      },
      resetPreferences: () => {},
    });
    expect(languageResets).toBe(1);
    expect(port.closed).toEqual(['metaMask']);
  });

  it('closes only what this tab held when the request arrived, even when it waits its turn (Codex #2670 r4)', async () => {
    // An earlier follow-up is still closing a wallet.
    let release: () => void = () => {};
    followPeerErasure({
      wallet: connectedPort(
        'walletConnect',
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
      followPreferences: () => {},
      followLanguage: () => {},
    });
    // A second request arrives; this tab holds MetaMask.
    let status = 'connected';
    const metaMask = { id: 'metaMask' };
    const coinbase = { id: 'coinbaseWalletSDK' };
    let held: { id: string }[] = [metaMask];
    const closed: string[] = [];
    followPeerErasure({
      wallet: {
        status: () => status,
        connectors: () => held,
        isLive: () => true,
        reloadsOnDisconnect: (c) => c.id === 'coinbaseWalletSDK',
        disconnect: async (c) => {
          closed.push(c.id);
          held = held.filter((x) => x !== c);
          if (held.length === 0) status = 'disconnected';
        },
        whenSettled: async () => true,
      },
      followPreferences: () => {},
      followLanguage: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // While it waits its turn, the user connects Coinbase.
    held = [...held, coinbase];
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toEqual(['metaMask']);
  });
});
