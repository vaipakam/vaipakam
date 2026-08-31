/**
 * Data-rights coverage (#1960).
 *
 * The failure this file exists to prevent is not a crash — it is an
 * export that comes back empty and an erasure that removes nothing,
 * both reporting success. That is what a verbatim port of the retired
 * `apps/defi` helper would have done here, because it matched the
 * `vaipakam` namespace and this app writes almost everything under
 * `app.`. A data-rights page that lies is worse than no page, so the
 * prefix list is pinned against the keys the app really uses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  incompleteExportNote,
  isAppStorageKey,
  collectMyData,
  eraseMyData,
  inspectErasableData,
  isErasableStorageKey,
  liveLastErrorEntry,
  STORAGE_PREFIXES,
  PREFERENCE_COOKIES,
  THIRD_PARTY_STORAGE_MARKERS,
  ERASABLE_INDEXED_DB_STORES,
  ERASURE_REGISTRY,
  eraseIndexedDbData,
  INDEXED_DB_TIMEOUT_MS,
  eraseMyDataFully,
  DISCONNECT_TIMEOUT_MS,
  erasedItemCount,
  isDisconnectSentinelKey,
  inspectIndexedDbData,
  disconnectEvery,
  type FullEraseResult,
} from './dataRights';

/**
 * Every storage key literal the app writes, as of #1960.
 *
 * Parameterised keys are listed in their concrete form — the prefix is
 * what the scan matches, so a representative instance proves coverage.
 */
const KNOWN_KEYS: readonly string[] = [
  // localStorage
  'app.mode',
  'app.theme',
  'app.powerSurfaceNoteDismissed',
  'app.notif.lastseen.84532.0xabc',
  'app.alerts.84532.0xabc',
  'app.loanSaleOffer.84532.7',
  'app.offsetOffer.84532.7',
  'app.refinanceOffer.84532.7',
  'app.recoverPending.84532.7',
  'vaipakam-receipt-sync-ping-v1',
  'vaipakam:language',
  // sessionStorage
  'vaipakam.app.lastError',
  'app.chunkReloaded',
];

/**
 * Keys written by a DEPENDENCY on the app's behalf (#1862).
 *
 * The app never writes these; the connectors configured in
 * `chain/wagmi.ts` do. That is what makes them invisible to the
 * `STORAGE_WRITERS` guard below, which scans `src/` for `setItem` — the
 * write happens in `node_modules`, so no amount of hardening that guard
 * reaches them.
 */
const CONNECTOR_KEYS: readonly string[] = [
  'wagmi.store',
  'wagmi.recentConnectorId',
  'wc@2:core:0.3//keychain',
  // Round 3 P1: lower case, and an exact match on the recorded `CBWSDK`
  // marker skipped it entirely.
  'cbwsdk.store',
  'wc@2:client:0.3//session',
  '-CBWSDK:walletUsername',
  '-walletlink:https://www.walletlink.org:session:id',
];

describe('erasure reaches connector storage (#1862)', () => {
  it('erases every connector key', () => {
    // Before this, "Delete my data" reported success and a reload could
    // reconnect the same wallet — wallet-linked state surviving a
    // right-to-erasure control.
    for (const key of CONNECTOR_KEYS) {
      expect(isErasableStorageKey(key), key).toBe(true);
    }
  });

  it('does NOT put connector keys in the export', () => {
    // The two rights want different sets. A portability file the user
    // downloads and may forward should not carry WalletConnect session
    // material; leaving it on the device would defeat the erasure. So the
    // export predicate stays narrow and the erasure one is wider.
    for (const key of CONNECTOR_KEYS) {
      expect(isAppStorageKey(key), key).toBe(false);
    }
  });

  it('still erases everything the app itself writes', () => {
    for (const key of KNOWN_KEYS) {
      expect(isErasableStorageKey(key), key).toBe(true);
    }
  });

  it('leaves an unrelated key alone', () => {
    // The wider net is bounded: it matches the recorded markers, not
    // anything that merely looks foreign.
    expect(isErasableStorageKey('some-other-dapp-preference')).toBe(false);
    expect(isErasableStorageKey('')).toBe(false);
    expect(isErasableStorageKey(null)).toBe(false);
  });

  it('the ERASURE actually removes them, and the EXPORT actually omits them', () => {
    // The four cases above test the predicates in isolation, which is not
    // the same as testing the wiring — and initially they did not catch it:
    // swapping which predicate `clearStorage` and `collect` use left all of
    // them green. This one drives the real entry points against a stub
    // storage, so the two predicates cannot be transposed silently.
    const store = new Map<string, string>([
      ['app.mode', 'lend'],
      ['vaipakam-receipt-sync-ping-v1', '1'],
      ['wagmi.store', '{"state":{"connections":{}}}'],
      ['wc@2:client:0.3//session', '[]'],
      ['cbwsdk.store', '{"keys":{}}'],
      ['-walletlink:https://www.walletlink.org:session:id', 'abc'],
      ['some-other-dapp-preference', 'keep me'],
    ]);
    const fake: Storage = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    const priorWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      localStorage: fake,
      sessionStorage: fake,
      location: { origin: 'https://app.example' },
      navigator: { userAgent: 'test' },
      dispatchEvent: () => true,
    };
    try {
      const exported = collectMyData();
      const exportedKeys = Object.keys(exported.localStorage);
      // The export carries the app's own keys and no connector material.
      expect(exportedKeys).toContain('app.mode');
      expect(exportedKeys.some((k) => k.includes('wagmi.'))).toBe(false);
      expect(exportedKeys.some((k) => k.includes('walletlink'))).toBe(false);

      eraseMyData();
      // The erasure removed the connector keys...
      expect(store.has('wagmi.store')).toBe(false);
      expect(store.has('wc@2:client:0.3//session')).toBe(false);
      expect(store.has('cbwsdk.store')).toBe(false);
      expect(store.has('-walletlink:https://www.walletlink.org:session:id')).toBe(false);
      // ...and the app's own...
      expect(store.has('app.mode')).toBe(false);
      // ...and left the unrelated one where it was.
      expect(store.get('some-other-dapp-preference')).toBe('keep me');
    } finally {
      (globalThis as Record<string, unknown>).window = priorWindow;
    }
  });

  it('COUNTS a surviving connector key, so a false success is impossible', () => {
    // Round 1 P1. The post-erasure `remaining` figure came from the export
    // inventory, which cannot see connector keys — so one that refused
    // removal, or that a live connector wrote straight back, left the page
    // reporting a clean success over storage still sitting there. A
    // verification that cannot see what the erasure targets is not one.
    const store = new Map<string, string>([['wagmi.store', '{}']]);
    const fake: Storage = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: () => {
        /* a connector that refuses removal, or rewrites immediately */
      },
      clear: () => store.clear(),
    };
    const priorWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      localStorage: fake,
      sessionStorage: fake,
      location: { origin: 'https://app.example' },
      navigator: { userAgent: 'test' },
      dispatchEvent: () => true,
    };
    try {
      // Two stores share one fake, so the surviving key is counted twice —
      // what matters is that it is NOT zero.
      expect(inspectErasableData().count).toBeGreaterThan(0);
      // The export inventory still cannot see it, which is why the two
      // inventories have to be different functions.
      expect(Object.keys(collectMyData().localStorage)).toHaveLength(0);
    } finally {
      (globalThis as Record<string, unknown>).window = priorWindow;
    }
  });

  it('records how each marker was established', () => {
    // Four markers, and the module comment states the evidence for each
    // because three could not be confirmed from the code that composes
    // them. If a marker is added without that reasoning, this count
    // changes and the comment must be revisited.
    expect(THIRD_PARTY_STORAGE_MARKERS).toHaveLength(4);
    expect(THIRD_PARTY_STORAGE_MARKERS).toContain('wagmi.');
  });
});

describe('isAppStorageKey', () => {
  it('matches every key the app is known to write', () => {
    for (const key of KNOWN_KEYS) {
      expect(isAppStorageKey(key), key).toBe(true);
    }
  });

  it('matches the separators the retired helper missed', () => {
    // The ported rule accepted `vaipakam`, `vaipakam.` and `vaipakam:`
    // only. Both of these are real keys in this app and neither would
    // have been exported or erased.
    expect(isAppStorageKey('app.mode')).toBe(true);
    expect(isAppStorageKey('vaipakam-receipt-sync-ping-v1')).toBe(true);
  });

  it('leaves other origins’ and other tools’ keys alone', () => {
    // An erasure that reaches beyond what this app wrote is its own
    // kind of defect — a wallet connector's session is not ours to
    // delete, and doing so would disconnect the user as a side effect
    // of exercising a data right.
    for (const key of [
      'wagmi.store',
      'wc@2:client:0.3//session',
      'appearance',
      '',
      null,
      undefined,
    ]) {
      expect(isAppStorageKey(key), String(key)).toBe(false);
    }
  });

  it('does not match a prefix used as a bare word', () => {
    // `app` and `vaipakam` alone are not ours: the prefixes carry
    // their separator precisely so an unrelated key named `apparel` or
    // `vaipakamish` cannot be swept up.
    expect(isAppStorageKey('apparel')).toBe(false);
    expect(isAppStorageKey('vaipakamish')).toBe(false);
  });
});

describe('storage-prefix coverage', () => {
  /**
   * Every source file that WRITES browser storage, with the key
   * prefixes it writes under.
   *
   * A file allowlist rather than a literal scan, and that is the whole
   * point. The first version of this guard grepped for `NAME_KEY = '…'`
   * declarations, and `app.alerts` — a live key — evaded it, because
   * `alerts.ts` builds its key in a lowercase arrow function returning
   * a template literal. The hand-list below caught that one; the
   * automated half did not, which is the exact failure this guard is
   * supposed to make impossible.
   *
   * Written this way, a NEW file that touches storage fails the test
   * until somebody registers it and its prefixes. That converts a
   * silent miss into a loud one, and it cannot be evaded by how the key
   * happens to be spelled.
   */
  const STORAGE_WRITERS: Readonly<Record<string, readonly string[]>> = {
    'src/app/ModeContext.tsx': ['app.mode'],
    'src/app/ThemeContext.tsx': ['app.theme'],
    'src/chain/receiptSync.ts': ['vaipakam-receipt-sync-ping-v1'],
    'src/components/PowerSurfaceNote.tsx': ['app.powerSurfaceNoteDismissed'],
    'src/data/alerts.ts': ['app.alerts.'],
    'src/lib/notifSeen.ts': ['app.notif.lastseen.'],
    'src/lib/pendingMarker.ts': [
      'app.loanSaleOffer.',
      'app.offsetOffer.',
      'app.refinanceOffer.',
      'app.recoverPending.',
    ],
    'src/main.tsx': ['app.chunkReloaded'],
    // The data-rights page itself reads and clears; it writes nothing.
    'src/lib/dataRights.ts': [],
    // Signal only — no storage of its own.
    'src/lib/eraseEpoch.ts': [],
    // Cleared by the erase flow (its module-level slot as well as the
    // sessionStorage copy), never written by it.
    'src/diagnostics/lastError.ts': ['vaipakam.app.lastError'],
    // Written OUTSIDE this app, by the shared i18n package's detector,
    // so it never appears in the src/ scan below. Registered anyway —
    // the export and the erasure both have to reach it, and the
    // cross-check found it missing the moment this registry existed,
    // which is the argument for having one.
    '(packages/i18n — language detector)': ['vaipakam:language'],
  };

  it('every file that writes storage is registered, and its keys are covered', () => {
    const out = execFileSync(
      'grep',
      [
        '-rlE',
        String.raw`(localStorage|sessionStorage)\.setItem\(`,
        'src',
        '--include=*.ts',
        '--include=*.tsx',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const writers = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((f) => !f.includes('.test.'));

    // External writers are registered with a parenthesised label rather
    // than a path, so they cannot accidentally satisfy the scan below.
    const unregistered = writers.filter((f) => !(f in STORAGE_WRITERS));
    expect(
      unregistered,
      `files writing browser storage without a data-rights registration: ${unregistered.join(', ')}. ` +
        'Add the file and its key prefixes to STORAGE_WRITERS, and make sure the ' +
        'prefixes fall inside STORAGE_PREFIXES so an erasure actually reaches them.',
    ).toEqual([]);

    // ...and every registered prefix must be one the scan reaches.
    // Registering a key the erasure cannot see would be a hand-list
    // that agrees with itself and not with the code.
    for (const [file, prefixes] of Object.entries(STORAGE_WRITERS)) {
      for (const prefix of prefixes) {
        expect(isAppStorageKey(prefix), `${file} → ${prefix}`).toBe(true);
      }
    }
  });

  it('covers every LITERAL key handed to setItem', () => {
    // Review round 1 P2 closed the "new file" hole; this closes the
    // other half. A registered file can still gain a new key, and the
    // registry check passes because the FILE is already listed. So
    // every literal first-argument to setItem is checked directly:
    // `localStorage.setItem('preferences', v)` fails here even in a
    // file that is otherwise registered.
    //
    // Runtime-built keys stay out of static reach — that is what the
    // file registry is for, and the two together are why neither hole
    // is open on its own.
    // grep exits 1 when nothing matches, which `execFileSync` raises —
    // and "no literal keys anywhere" is a legitimate state, not a
    // failure. Every key being built at runtime would look exactly like
    // this, and it must not read as a broken test.
    let out = '';
    try {
      out = execFileSync(
        'grep',
        [
          '-rhoE',
          String.raw`(localStorage|sessionStorage)\.setItem\(\s*['"][^'"]+['"]`,
          'src',
          '--include=*.ts',
          '--include=*.tsx',
          // Tests included would match the illustrative call in this
          // very comment — the check reporting its own example as a
          // defect, which it did on first run.
          '--exclude=*.test.ts',
          '--exclude=*.test.tsx',
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
    } catch {
      out = '';
    }
    const literals = [...out.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const uncovered = literals.filter((literal) => !isAppStorageKey(literal));
    expect(
      uncovered,
      `literal storage keys the data-rights scan cannot reach: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('registers a writer for every known key', () => {
    // The two halves check each other: KNOWN_KEYS is what the export
    // must contain, STORAGE_WRITERS is where each comes from. A key in
    // one and not the other means one of them is stale.
    const registered = Object.values(STORAGE_WRITERS).flat();
    for (const key of KNOWN_KEYS) {
      expect(
        registered.some((prefix) => key.startsWith(prefix)),
        `${key} has no registered writer`,
      ).toBe(true);
    }
  });

  it('names the preference cookies the app shares with the marketing site', () => {
    expect(PREFERENCE_COOKIES).toContain('vaipakam_lang');
    expect(PREFERENCE_COOKIES).toContain('vaipakam_theme');
  });

  it('keeps the prefix list non-empty and separator-terminated', () => {
    // A prefix without its separator would match far more than this
    // app owns — the erasure equivalent of a wildcard.
    expect(STORAGE_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of STORAGE_PREFIXES) {
      expect(/[.:\-]$/.test(prefix), prefix).toBe(true);
    }
  });
});

describe('erase epoch', () => {
  // Review round 2 P2 found the same defect in two components: state
  // read from storage once and kept, so an erasure changed nothing on
  // screen. The epoch is the shared signal that lets each re-read
  // through the path it already has, rather than a third bespoke fix.
  it('increments so mounted readers can re-read', async () => {
    const { __resetEraseEpoch, bumpEraseEpoch, getEraseEpoch, subscribeEraseEpoch } =
      await import('./eraseEpoch');
    __resetEraseEpoch();
    expect(getEraseEpoch()).toBe(0);

    let notified = 0;
    const unsubscribe = subscribeEraseEpoch(() => {
      notified += 1;
    });
    bumpEraseEpoch();
    expect(getEraseEpoch()).toBe(1);
    expect(notified).toBe(1);

    // A reader that has unmounted must not be notified — a stale
    // listener firing setState after unmount is how this kind of store
    // becomes a warning generator.
    unsubscribe();
    bumpEraseEpoch();
    expect(getEraseEpoch()).toBe(2);
    expect(notified).toBe(1);
    __resetEraseEpoch();
  });
});

describe('decodeStored (via the export payload shape)', () => {
  // Review round 3 P2. A pending marker holds an on-chain identifier as
  // a bare decimal string, and `JSON.parse` rounds anything past
  // MAX_SAFE_INTEGER — so an export could contain a DIFFERENT id than
  // the one stored. A portability file that is quietly wrong is worse
  // than one that is harder to read.
  it('proves the hazard this guards against is real', () => {
    const exact = '9007199254740993';
    expect(String(JSON.parse(exact) as number)).not.toBe(exact);
    expect(JSON.parse(exact)).toBe(9007199254740992);
  });

  it('keeps structured values parseable and scalars exact', async () => {
    // The rule the decoder applies: parse only what starts with `{` or
    // `[`. Pinned as a predicate here because the decoder itself is
    // module-private and exercised through storage, which this
    // node-environment suite has no DOM for.
    const structured = (raw: string) => {
      const t = raw.trimStart();
      return t.startsWith('{') || t.startsWith('[');
    };
    expect(structured('{"a":1}')).toBe(true);
    expect(structured('[1,2]')).toBe(true);
    expect(structured('9007199254740993')).toBe(false);
    expect(structured('light')).toBe(false);
    expect(structured('"quoted"')).toBe(false);
    expect(structured('true')).toBe(false);
  });
});

describe('liveLastErrorEntry', () => {
  // Review round 5 P2. `recordLastError` writes its module slot FIRST
  // and the `sessionStorage.setItem` after it can fail — a larger
  // replacement over quota is enough — so the slot can hold a NEWER
  // record than the key. The old presence check exported the stale one
  // and suppressed exactly the record the Diagnostics drawer was
  // displaying.
  const record = { message: 'boom', path: '/lend', at: 1_700_000_000_000 };

  it('fills the key when storage holds nothing', () => {
    expect(liveLastErrorEntry(undefined, record)).toEqual({
      key: 'vaipakam.app.lastError',
      value: record,
    });
  });

  it('exports BOTH when the live record differs from the stored one', () => {
    const stale = { message: 'earlier crash', path: '/borrow', at: 1 };
    // The stored copy stays under its real key (the caller already has
    // it there); the live one arrives under a parenthesised label so
    // the export never claims sessionStorage contains something it
    // does not.
    expect(liveLastErrorEntry(stale, record)).toEqual({
      key: 'vaipakam.app.lastError (live)',
      value: record,
    });
  });

  it('adds nothing when they agree — a normal browser sees no duplicate', () => {
    // The stored value reaches the caller through JSON.parse of what
    // recordLastError stringified, so agreement is content equality of
    // that round-trip, not object identity.
    expect(liveLastErrorEntry(JSON.parse(JSON.stringify(record)), record)).toBeNull();
  });

  it('adds nothing when no record is held in memory', () => {
    expect(liveLastErrorEntry(undefined, null)).toBeNull();
    const stored = { message: 'stored only', path: '/', at: 2 };
    expect(liveLastErrorEntry(stored, null)).toBeNull();
  });

  it('treats an unparseable stored copy as different', () => {
    // `decodeStored` falls back to raw text when the value does not
    // parse — a corrupt slot and a live record are then genuinely two
    // different holdings, and both belong in the export.
    expect(liveLastErrorEntry('{not json', record)).toEqual({
      key: 'vaipakam.app.lastError (live)',
      value: record,
    });
  });
});

describe('incompleteExportNote', () => {
  // Review round 7 P2. A partial export separated from the page's
  // on-screen refusal warning read as a complete one — the file must
  // carry the warning itself, naming exactly the stores it is missing.
  it('names the missing store and says the data is absent', () => {
    const note = incompleteExportNote(['localStorage']);
    expect(note).toContain('INCOMPLETE');
    expect(note).toContain('localStorage');
    expect(note).toContain('NOT in this file');
  });

  it('lists every refused store when there is more than one', () => {
    const note = incompleteExportNote(['sessionStorage', 'cookies']);
    expect(note).toContain('sessionStorage and cookies');
  });
});

describe('cookie value decoding', () => {
  // Review round 4 P2. A cookie's NAME is what deletion needs, and it
  // stays legible even when the value is malformed — so one bad value
  // must not cost the user the erasure of every preference cookie.
  it('falls back to raw text rather than losing the cookie', () => {
    // The hazard: this throws, and it used to do so inside the loop
    // that collects names for deletion.
    expect(() => decodeURIComponent('%')).toThrow();

    // The rule now applied — decode per cookie, keep the raw value on
    // failure — so the name survives to be expired either way.
    const decodeOrRaw = (raw: string) => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    };
    expect(decodeOrRaw('%')).toBe('%');
    expect(decodeOrRaw('en')).toBe('en');
    expect(decodeOrRaw('zh%2DHans')).toBe('zh-Hans');
  });
});

describe('IndexedDB erasure (#1862 Part 2)', () => {
  const realIdb = (globalThis as Record<string, unknown>).indexedDB;
  afterEach(() => {
    (globalThis as Record<string, unknown>).indexedDB = realIdb;
  });

  type DbShape = { stores: string[]; failTx?: boolean } | 'missing' | 'throw';

  /** A fake `indexedDB.open` whose per-database shape the test chooses. */
  function stubIndexedDb(shape: (name: string) => DbShape): {
    opened: string[];
    cleared: string[];
    deleted: string[];
    txOpened: string[];
  } {
    const opened: string[] = [];
    const cleared: string[] = [];
    const deleted: string[] = [];
    const txOpened: string[] = [];
    (globalThis as Record<string, unknown>).indexedDB = {
      deleteDatabase(name: string) {
        deleted.push(name);
        return {};
      },
      open(name: string) {
        opened.push(name);
        const s = shape(name);
        if (s === 'throw') throw new Error('site data blocked');
        const req: Record<string, unknown> = { result: undefined };
        queueMicrotask(() => {
          if (s === 'missing') {
            // A brand-new database: the browser fires upgradeneeded first.
            (req.onupgradeneeded as (() => void) | undefined)?.();
          }
          const stores = s === 'missing' ? [] : s.stores;
          req.result = {
            objectStoreNames: { contains: (n: string) => stores.includes(n) },
            close: () => {},
            transaction: (store: string) => {
              txOpened.push(`${name}/${store}`);
              const tx: Record<string, unknown> = {
                objectStore: () => ({
                  count: () => ({ result: 3 }),
                  clear: () => {
                    if (s !== 'missing' && s.failTx) return;
                    cleared.push(`${name}/${store}`);
                  },
                }),
              };
              queueMicrotask(() => {
                const done =
                  s !== 'missing' && s.failTx ? tx.onerror : tx.oncomplete;
                (done as (() => void) | undefined)?.();
              });
              return tx;
            },
          };
          (req.onsuccess as (() => void) | undefined)?.();
        });
        return req;
      },
    };
    return { opened, cleared, deleted, txOpened };
  }

  it('names both stores, and both come from the registry', () => {
    // Wrong names are a silent no-op that still reports success, since an
    // absent store is treated as already-clean. Both pairs are quoted from
    // the installed packages in the registry's own comment.
    expect(ERASABLE_INDEXED_DB_STORES).toEqual([
      { database: 'WALLET_CONNECT_V2_INDEXED_DB', store: 'keyvaluestorage' },
      { database: 'cbwsdk', store: 'keys' },
    ]);
    expect(ERASURE_REGISTRY).toHaveLength(2);
    for (const target of ERASURE_REGISTRY) {
      expect(target.evidence.length).toBeGreaterThan(20);
      expect(target.writtenBy.length).toBeGreaterThan(0);
    }
  });

  it('EMPTIES the stores rather than deleting the databases', async () => {
    // Round 1 P1: a database deletion blocks on every open connection,
    // including this tab's own, which neither wallet library closes. So the
    // deletion could never succeed and the page advised closing other tabs.
    // Clearing runs as an ordinary transaction and is not blockable that way.
    const spy = stubIndexedDb(() => ({
      stores: ['keyvaluestorage', 'keys'],
    }));
    const result = await eraseIndexedDbData();
    expect(spy.cleared).toEqual([
      'WALLET_CONNECT_V2_INDEXED_DB/keyvaluestorage',
      'cbwsdk/keys',
    ]);
    expect(result).toEqual({ cleared: 2, records: 6, refused: [], unavailable: false });
  });

  it('treats a database that does not exist as already clean, and leaves none behind', async () => {
    // `open` CREATES a missing database, so an erasure that opened blindly
    // would invent empty databases while claiming to remove things.
    const spy = stubIndexedDb(() => 'missing');
    const result = await eraseIndexedDbData();
    expect(result.cleared).toBe(2);
    expect(result.refused).toEqual([]);
    expect(spy.deleted).toEqual(['WALLET_CONNECT_V2_INDEXED_DB', 'cbwsdk']);
  });

  it('treats a database without the expected store as already clean, WITHOUT opening a transaction', async () => {
    // The `objectStoreNames.contains` guard is the whole behaviour here, and
    // the outcome alone cannot see it: a stub that happily opens a
    // transaction on a store that does not exist reports success either way.
    // The real API throws NotFoundError, so what must be asserted is that no
    // transaction is attempted at all. (Removing the guard survived a
    // mutation run of the first version of this test.)
    const spy = stubIndexedDb(() => ({ stores: ['something-else'] }));
    const result = await eraseIndexedDbData();
    expect(result.cleared).toBe(2);
    expect(spy.txOpened).toEqual([]);
  });

  it('names a store whose transaction fails, rather than counting it cleared', async () => {
    stubIndexedDb((n) =>
      n === 'cbwsdk'
        ? { stores: ['keys'] }
        : { stores: ['keyvaluestorage'], failTx: true },
    );
    const result = await eraseIndexedDbData();
    expect(result.cleared).toBe(1);
    expect(result.refused).toEqual([
      'WALLET_CONNECT_V2_INDEXED_DB/keyvaluestorage',
    ]);
  });

  it('times out an open that never answers, and calls it refused', async () => {
    vi.useFakeTimers();
    try {
      (globalThis as Record<string, unknown>).indexedDB = {
        open: () => ({}),
        deleteDatabase: () => ({}),
      };
      const pending = eraseIndexedDbData();
      await vi.advanceTimersByTimeAsync(INDEXED_DB_TIMEOUT_MS + 1);
      const result = await pending;
      expect(result.cleared).toBe(0);
      expect(result.refused).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the browser has no IndexedDB at all', async () => {
    delete (globalThis as Record<string, unknown>).indexedDB;
    const result = await eraseIndexedDbData();
    expect(result).toEqual({ cleared: 0, records: 0, refused: [], unavailable: true });
  });

  it('survives an indexedDB accessor that throws', async () => {
    stubIndexedDb(() => 'throw');
    const result = await eraseIndexedDbData();
    expect(result.unavailable).toBe(false);
    expect(result.refused).toHaveLength(2);
  });
});

describe('eraseMyDataFully (#1862 Part 2)', () => {
  const realIdb = (globalThis as Record<string, unknown>).indexedDB;
  const realWindow = (globalThis as Record<string, unknown>).window;
  afterEach(() => {
    (globalThis as Record<string, unknown>).indexedDB = realIdb;
    (globalThis as Record<string, unknown>).window = realWindow;
  });

  function fakeWindow(store: Map<string, string>) {
    const fake: Storage = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    (globalThis as Record<string, unknown>).window = {
      localStorage: fake,
      sessionStorage: fake,
      location: { origin: 'https://app.example' },
      navigator: { userAgent: 'test' },
      dispatchEvent: () => true,
    };
  }

  function stubIdb(verdict: 'success' | 'blocked') {
    (globalThis as Record<string, unknown>).indexedDB = {
      deleteDatabase: () => ({}),
      open() {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            close: () => {},
            transaction: () => {
              const tx: Record<string, unknown> = {
                objectStore: () => ({ count: () => ({ result: 2 }), clear: () => {} }),
              };
              queueMicrotask(() => {
                const done = verdict === 'success' ? tx.oncomplete : tx.onerror;
                (done as (() => void) | undefined)?.();
              });
              return tx;
            },
          };
          (req.onsuccess as (() => void) | undefined)?.();
        });
        return req;
      },
    };
  }

  it('removes Web Storage AND the databases, and calls that complete', async () => {
    fakeWindow(new Map([['wagmi.store', '{}']]));
    stubIdb('success');
    const result = await eraseMyDataFully();
    expect(result.localStorage).toBeGreaterThan(0);
    expect(result.indexedDb.cleared).toBe(2);
    expect(result.complete).toBe(true);
  });

  it('is INCOMPLETE when a database refuses, however much storage it cleared', async () => {
    // The failure this exists to prevent: Web Storage gives up several keys,
    // the page adds them up and reports success, and the live WalletConnect
    // session is still in a database another tab is holding open.
    fakeWindow(new Map([['wagmi.store', '{}'], ['app.mode', 'basic']]));
    stubIdb('blocked');
    const result = await eraseMyDataFully();
    expect(result.total).toBeGreaterThan(0);
    expect(result.complete).toBe(false);
    expect(result.indexedDb.refused).toHaveLength(2);
  });

  it('disconnects BEFORE sweeping, so the teardown\'s own writes are caught', async () => {
    // Ordering is the mechanism here. wagmi rewrites its keys as it
    // disconnects, so a sweep that ran first would leave them behind.
    const store = new Map<string, string>();
    fakeWindow(store);
    stubIdb('success');
    const order: string[] = [];
    const result = await eraseMyDataFully({
      disconnect: async () => {
        order.push('disconnect');
        // What a connector writing on its way out looks like.
        store.set('wagmi.recentConnectorId', '"injected"');
      },
    });
    expect(order).toEqual(['disconnect']);
    expect(store.has('wagmi.recentConnectorId')).toBe(false);
    expect(result.connector).toEqual({ attempted: true, disconnected: true });
    expect(result.complete).toBe(true);
  });

  it('is INCOMPLETE when the teardown throws, and does not abort the erasure', async () => {
    // A wallet refusing to disconnect must not stop everything else being
    // removed — but the page must not call the result clean either, because
    // the app is still attached to it.
    fakeWindow(new Map([['app.mode', 'basic']]));
    stubIdb('success');
    const result = await eraseMyDataFully({
      disconnect: async () => {
        throw new Error('user rejected');
      },
    });
    expect(result.connector).toEqual({ attempted: true, disconnected: false });
    expect(result.localStorage).toBeGreaterThan(0);
    expect(result.indexedDb.cleared).toBe(2);
    expect(result.complete).toBe(false);
  });

  it('with no teardown supplied, completeness turns only on the databases', async () => {
    fakeWindow(new Map());
    stubIdb('success');
    const result = await eraseMyDataFully();
    expect(result.connector).toEqual({ attempted: false, disconnected: false });
    expect(result.complete).toBe(true);
  });

  it('is INCOMPLETE when the browser hides IndexedDB entirely', async () => {
    // Round 1 P2. Neither store was emptied nor observed absent, so a
    // browser that hid the API after a wallet wrote to it leaves that
    // material in place and unverifiable. Reporting success there is the
    // same false assurance as reporting it over a refusal.
    fakeWindow(new Map([['app.mode', 'basic']]));
    delete (globalThis as Record<string, unknown>).indexedDB;
    const result = await eraseMyDataFully();
    expect(result.indexedDb.unavailable).toBe(true);
    expect(result.localStorage).toBeGreaterThan(0);
    expect(result.complete).toBe(false);
  });

  it('bounds a disconnect that never settles, and still erases everything else', async () => {
    // Round 1 P2. Only a REJECTED promise reaches the catch; one that never
    // settles would hang the erasure forever, leaving the page on its
    // working label with nothing removed at all.
    vi.useFakeTimers();
    try {
      fakeWindow(new Map([['wagmi.store', '{}']]));
      stubIdb('success');
      const pending = eraseMyDataFully({
        disconnect: () => new Promise<void>(() => {}),
      });
      await vi.advanceTimersByTimeAsync(DISCONNECT_TIMEOUT_MS + 1);
      const result = await pending;
      expect(result.connector).toEqual({
        attempted: true,
        disconnected: false,
      });
      // The point of the bound: the rest of the erasure still ran.
      expect(result.localStorage).toBeGreaterThan(0);
      expect(result.indexedDb.cleared).toBe(2);
      expect(result.complete).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts records cleared from the wallet stores, so an IndexedDB-only erase is not "nothing"', async () => {
    // Round 2 P2: `total` counts the synchronous sweep only. A browser whose
    // Web Storage was already empty but whose wallet session was not would
    // have been told there was nothing stored — right after deleting that
    // session.
    fakeWindow(new Map());
    stubIdb('success');
    const result = await eraseMyDataFully();
    expect(result.total).toBe(0);
    expect(result.indexedDb.records).toBeGreaterThan(0);
  });

  it('an empty browser erases nothing and is still complete', async () => {
    // `complete` is not `total > 0`. Nothing stored is a clean outcome, and
    // conflating the two is how "nothing was stored" became a failure
    // message in Part 1.
    fakeWindow(new Map());
    stubIdb('success');
    const result = await eraseMyDataFully();
    expect(result.total).toBe(0);
    expect(result.complete).toBe(true);
  });
});

describe('round 3 — the reported count, the sentinel, the wedged transaction', () => {
  const realIdb = (globalThis as Record<string, unknown>).indexedDB;
  const realWindow = (globalThis as Record<string, unknown>).window;
  afterEach(() => {
    (globalThis as Record<string, unknown>).indexedDB = realIdb;
    (globalThis as Record<string, unknown>).window = realWindow;
  });

  function fakeWindow(store: Map<string, string>) {
    const fake: Storage = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    (globalThis as Record<string, unknown>).window = {
      localStorage: fake,
      sessionStorage: fake,
      location: { origin: 'https://app.example' },
      navigator: { userAgent: 'test' },
      dispatchEvent: () => true,
    };
  }

  it('counts the database records in the number it shows', () => {
    // Round 3 P2. The condition that decides WHETHER to claim a success
    // learned about `indexedDb.records` in round 2; the sentence that carries
    // the number did not, so an IndexedDB-only erasure said "Erased 0 stored
    // items" and every mixed one under-reported.
    const result = {
      total: 4,
      indexedDb: { cleared: 2, records: 7, refused: [], unavailable: false },
    } as unknown as FullEraseResult;
    expect(erasedItemCount(result)).toBe(11);
  });

  it('never shows a zero over an erasure that removed database records', () => {
    const result = {
      total: 0,
      indexedDb: { cleared: 2, records: 3, refused: [], unavailable: false },
    } as unknown as FullEraseResult;
    expect(erasedItemCount(result)).toBe(3);
  });

  it('recognises wagmi disconnect sentinels and nothing else under `wagmi.`', () => {
    expect(isDisconnectSentinelKey('wagmi.metaMask.disconnected')).toBe(true);
    expect(isDisconnectSentinelKey('wagmi.safe.disconnected')).toBe(true);
    // The keys that MUST still go: the store holding the connection map, and
    // the recent-connector hint.
    expect(isDisconnectSentinelKey('wagmi.store')).toBe(false);
    expect(isDisconnectSentinelKey('wagmi.recentConnectorId')).toBe(false);
    // Not a wagmi key at all, however it is spelled.
    expect(isDisconnectSentinelKey('app.disconnected')).toBe(false);
    expect(isDisconnectSentinelKey('wagmi.disconnected')).toBe(false);
    expect(isDisconnectSentinelKey(null)).toBe(false);
  });

  it('KEEPS the disconnect sentinel through the sweep, and removes the rest', () => {
    // Round 3 P1, and the sharpest failure in the round: the sweep runs after
    // the teardown, the teardown's last act is to write this flag, and a
    // `wagmi.` match deleted it — so the next mount found the wallet still
    // authorized and reconnected. The fix's own cleanup restored the exact
    // "delete my data, reload, still signed in" bug the fix is for.
    expect(isErasableStorageKey('wagmi.metaMask.disconnected')).toBe(false);
    expect(isErasableStorageKey('wagmi.safe.disconnected')).toBe(false);
    expect(isErasableStorageKey('wagmi.store')).toBe(true);
    expect(isErasableStorageKey('wagmi.recentConnectorId')).toBe(true);
  });

  it('leaves the sentinel behind across a full erase, and does not count it', async () => {
    // The predicate above is only half of it: the sweep and the post-erase
    // inspection both have to agree, or the page reports a leftover key it
    // deliberately kept.
    const store = new Map<string, string>();
    fakeWindow(store);
    (globalThis as Record<string, unknown>).indexedDB = undefined;
    delete (globalThis as Record<string, unknown>).indexedDB;
    const result = await eraseMyDataFully({
      disconnect: async () => {
        // What `injected({ shimDisconnect: true })` writes on the way out,
        // alongside the store rewrite.
        store.set('wagmi.store', '{}');
        store.set('wagmi.metaMask.disconnected', 'true');
      },
    });
    expect(store.has('wagmi.metaMask.disconnected')).toBe(true);
    expect(store.has('wagmi.store')).toBe(false);
    expect(inspectErasableData().count).toBe(0);
    expect(result.connector.disconnected).toBe(true);
  });

  it('disconnects EVERY live connector, not just the current one', async () => {
    // Round 3 P1. `@wagmi/core`'s no-argument disconnect resolves its
    // connector from `state.current`, then promotes the next connection
    // rather than clearing the map — so a two-wallet tab dropped one,
    // resolved, and was reported signed out.
    const asked: string[] = [];
    const teardown = disconnectEvery(['metaMask', 'walletConnect'], async ({
      connector,
    }) => {
      asked.push(connector);
    });
    await teardown();
    expect(asked).toEqual(['metaMask', 'walletConnect']);
  });

  it('refuses to report a sign-out when handed no connectors at all', async () => {
    // Self-review after round 3, and it is round 2's defect through a new
    // door. That round established that a teardown resolving over nothing
    // must not read as a sign-out. The page decides to disconnect from
    // `isConnected` and takes the list from a separate hook, so a connection
    // dropped between render and click — another tab, a wallet locking —
    // would loop zero times and resolve. `eraseMyDataFully` turns the
    // rejection into `disconnected: false`, which is the honest answer.
    const teardown = disconnectEvery([], async () => {
      throw new Error('must not be called');
    });
    await expect(teardown()).rejects.toThrow(/no connectors/);
  });

  it('reports a failure when ANY connector refuses to let go', async () => {
    const teardown = disconnectEvery(['metaMask', 'walletConnect'], async ({
      connector,
    }) => {
      if (connector === 'walletConnect') throw new Error('user rejected');
    });
    await expect(teardown()).rejects.toThrow('user rejected');
  });

  it('tears down a wedged transaction when the timeout fires', async () => {
    // Round 3 P2. The timeout exists FOR this case, and resolving as refused
    // while leaving the transaction running and the connection open makes it
    // worse: the next attempt queues behind the abandoned transaction, and
    // the leaked handle is what blocks the browser-level "delete site data"
    // the refusal message sends people to.
    vi.useFakeTimers();
    try {
      const aborted: string[] = [];
      const closed: string[] = [];
      (globalThis as Record<string, unknown>).indexedDB = {
        deleteDatabase: () => ({}),
        open(name: string) {
          const req: Record<string, unknown> = {};
          queueMicrotask(() => {
            req.result = {
              objectStoreNames: { contains: () => true },
              close: () => closed.push(name),
              // A transaction that never fires oncomplete, onerror or
              // onabort — the wedged store.
              transaction: () => ({
                objectStore: () => ({
                  count: () => ({ result: 1 }),
                  clear: () => {},
                }),
                abort: () => aborted.push(name),
              }),
            };
            (req.onsuccess as (() => void) | undefined)?.();
          });
          return req;
        },
      };
      const pending = eraseIndexedDbData();
      await vi.advanceTimersByTimeAsync(INDEXED_DB_TIMEOUT_MS + 1);
      const result = await pending;
      expect(result.refused).toHaveLength(2);
      expect(aborted).toEqual(['WALLET_CONNECT_V2_INDEXED_DB', 'cbwsdk']);
      expect(closed).toEqual(['WALLET_CONNECT_V2_INDEXED_DB', 'cbwsdk']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a connection whose open answered only after the timeout', async () => {
    // The other leak on the same path: `open` itself can outlast the wait,
    // and the connection it then hands over would live for the life of the
    // page with nobody left to close it.
    vi.useFakeTimers();
    try {
      const closed: string[] = [];
      let release: (() => void) | undefined;
      (globalThis as Record<string, unknown>).indexedDB = {
        deleteDatabase: () => ({}),
        open(name: string) {
          const req: Record<string, unknown> = {};
          release = () => {
            req.result = {
              objectStoreNames: { contains: () => true },
              close: () => closed.push(name),
              transaction: () => ({
                objectStore: () => ({
                  count: () => ({ result: 1 }),
                  clear: () => {},
                }),
                abort: () => {},
              }),
            };
            (req.onsuccess as (() => void) | undefined)?.();
          };
          return req;
        },
      };
      const pending = eraseIndexedDbData();
      await vi.advanceTimersByTimeAsync(INDEXED_DB_TIMEOUT_MS + 1);
      release?.();
      const result = await pending;
      expect(result.refused).toHaveLength(2);
      expect(closed.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the connectors are configured so a disconnect survives a reload', () => {
  // A SOURCE scan, and deliberately so. The two facts below live in
  // `chain/wagmi.ts` as connector options; neither is readable off the built
  // config object, and this vitest project has no browser environment to
  // mount a connector in. A grep is weak evidence of behaviour and strong
  // evidence of intent — which is what is at risk here, because both are
  // one-word settings whose absence is silent and whose effect is the exact
  // bug #1862 Part 2 exists to fix.

  function wagmiSource(): string {
    return execFileSync('cat', ['src/chain/wagmi.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
  }

  it('opts the Safe connector into the disconnect shim', () => {
    // Round 3 P1. `@wagmi/connectors` defaults `shimDisconnect` to FALSE for
    // `safe()`, so without this its disconnect only drops wagmi's in-memory
    // connection: `isAuthorized` goes on answering yes while the page is
    // embedded in a Safe, and the next mount reconnects. A user who erased
    // their data was told they had been signed out and was not.
    const src = wagmiSource();
    const safeCall = src.slice(src.indexOf('safe({'));
    expect(safeCall).toContain('shimDisconnect: true');
  });

  it('does not turn the injected connector\'s shim off', () => {
    // `injected()` defaults `shimDisconnect` to TRUE, and the sentinel it
    // writes is the thing `isDisconnectSentinelKey` protects from the sweep.
    // Setting it to false here would leave that protection guarding a key
    // nothing writes any more, which is a silent regression rather than a
    // visible one.
    expect(wagmiSource()).not.toContain('shimDisconnect: false');
  });
});

describe('round 4 — the pre-confirm figure and the late teardown', () => {
  const realIdb = (globalThis as Record<string, unknown>).indexedDB;
  const realWindow = (globalThis as Record<string, unknown>).window;
  afterEach(() => {
    (globalThis as Record<string, unknown>).indexedDB = realIdb;
    (globalThis as Record<string, unknown>).window = realWindow;
  });

  function fakeWindow(store: Map<string, string>) {
    const fake: Storage = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    (globalThis as Record<string, unknown>).window = {
      localStorage: fake,
      sessionStorage: fake,
      location: { origin: 'https://app.example' },
      navigator: { userAgent: 'test' },
      dispatchEvent: () => true,
    };
  }

  /** An `indexedDB` whose per-database shape the test chooses. */
  function stubIdb(
    shape: (name: string) => 'missing' | { stores: string[]; count?: number },
  ): { modes: string[]; deleted: string[] } {
    const modes: string[] = [];
    const deleted: string[] = [];
    (globalThis as Record<string, unknown>).indexedDB = {
      deleteDatabase(name: string) {
        deleted.push(name);
        return {};
      },
      open(name: string) {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => {
          const s = shape(name);
          if (s === 'missing') {
            (req.onupgradeneeded as (() => void) | undefined)?.();
          }
          const stores = s === 'missing' ? [] : s.stores;
          req.result = {
            objectStoreNames: { contains: (n: string) => stores.includes(n) },
            close: () => {},
            transaction: (_store: string, mode: string) => {
              modes.push(mode);
              const tx: Record<string, unknown> = {
                objectStore: () => ({
                  count: () => ({
                    result: s === 'missing' ? 0 : (s.count ?? 2),
                  }),
                  clear: () => {},
                }),
                abort: () => {},
              };
              queueMicrotask(
                () => (tx.oncomplete as (() => void) | undefined)?.(),
              );
              return tx;
            },
          };
          (req.onsuccess as (() => void) | undefined)?.();
        });
        return req;
      },
    };
    return { modes, deleted };
  }

  it('counts the database records WITHOUT modifying them', async () => {
    // Round 4 P2. The pre-confirm figure came from the synchronous sweep
    // only, so a browser holding a wallet session and one app key was offered
    // "1 item" and then erased four — round 2's "the page contradicts itself
    // across a single click", with the session in the gap.
    const spy = stubIdb(() => ({
      stores: ['keyvaluestorage', 'keys'],
      count: 3,
    }));
    const inventory = await inspectIndexedDbData();
    expect(inventory).toEqual({ records: 6, refused: false });
    // READONLY — an inventory that writes is not one.
    expect(spy.modes).toEqual(['readonly', 'readonly']);
  });

  it('does not invent the databases it is counting', async () => {
    // Same hazard as the erasure's: `open` with no version CREATES. An
    // inventory that left empty databases behind would be reporting on
    // something it had just made.
    const spy = stubIdb(() => 'missing');
    const inventory = await inspectIndexedDbData();
    expect(inventory).toEqual({ records: 0, refused: false });
    expect(spy.deleted).toEqual(['WALLET_CONNECT_V2_INDEXED_DB', 'cbwsdk']);
  });

  it('reports a browser with no IndexedDB as unreadable, not as empty', async () => {
    delete (globalThis as Record<string, unknown>).indexedDB;
    expect(await inspectIndexedDbData()).toEqual({ records: 0, refused: true });
  });

  it('reports a store that will not answer as unreadable', async () => {
    vi.useFakeTimers();
    try {
      (globalThis as Record<string, unknown>).indexedDB = {
        open: () => ({}),
        deleteDatabase: () => ({}),
      };
      const pending = inspectIndexedDbData();
      await vi.advanceTimersByTimeAsync(INDEXED_DB_TIMEOUT_MS + 1);
      expect(await pending).toEqual({ records: 0, refused: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-sweeps when a given-up-on teardown completes and writes anyway', async () => {
    // Round 4 P2. `withTimeout` abandons the WAIT, not the WORK: the wagmi
    // action keeps running and, on completion, rewrites `wagmi.store` through
    // zustand's `persist` — into storage this erasure swept seconds earlier.
    // The device would be left holding a key the page reported removed.
    vi.useFakeTimers();
    try {
      const store = new Map<string, string>([['app.mode', 'basic']]);
      fakeWindow(store);
      stubIdb(() => ({ stores: ['keyvaluestorage', 'keys'] }));
      let finishTeardown: (() => void) | undefined;
      const pending = eraseMyDataFully({
        disconnect: () =>
          new Promise<void>((resolve) => {
            finishTeardown = () => {
              // The late write, exactly as wagmi makes it.
              store.set('wagmi.store', '{}');
              resolve();
            };
          }),
      });
      await vi.advanceTimersByTimeAsync(DISCONNECT_TIMEOUT_MS + 1);
      const result = await pending;
      expect(result.connector).toEqual({
        attempted: true,
        disconnected: false,
      });
      expect(result.complete).toBe(false);
      // Now the teardown finally lands, after the result was frozen.
      finishTeardown?.();
      await vi.advanceTimersByTimeAsync(1);
      expect(store.has('wagmi.store')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a teardown that finishes in time needs no late sweep — and why that is not pinned', async () => {
    // HONEST NOTE, because the obvious assertion here does not bind and a
    // test that cannot fail is worse than no test. The `settledLate` guard
    // on the late re-sweep is an EFFICIENCY guard, not a correctness one:
    // removing it survives mutation, and it should. The continuation runs
    // when the teardown resolves, which on the in-time path is BEFORE
    // `eraseMyData` — so an unconditional sweep there would be a redundant
    // pass immediately followed by the real one, invisible from outside.
    // What IS worth pinning is the ordinary path's outcome, so that is what
    // this asserts; the claim "no second sweep happened" is deliberately not
    // made, because nothing here could tell.
    const store = new Map<string, string>();
    fakeWindow(store);
    stubIdb(() => ({ stores: ['keyvaluestorage', 'keys'] }));
    const result = await eraseMyDataFully({
      disconnect: async () => {
        store.set('wagmi.store', '{}');
      },
    });
    expect(result.connector).toEqual({ attempted: true, disconnected: true });
    expect(store.has('wagmi.store')).toBe(false);
    expect(result.complete).toBe(true);
  });
});
