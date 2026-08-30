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
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  incompleteExportNote,
  isAppStorageKey,
  liveLastErrorEntry,
  STORAGE_PREFIXES,
  PREFERENCE_COOKIES,
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
