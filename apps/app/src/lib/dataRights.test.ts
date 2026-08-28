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
import { isAppStorageKey, STORAGE_PREFIXES, PREFERENCE_COOKIES } from './dataRights';

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
    'src/diagnostics/lastError.ts': ['vaipakam.app.lastError'],
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
