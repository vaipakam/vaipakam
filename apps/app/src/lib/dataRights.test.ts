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
  it('covers every storage key literal in the source tree', () => {
    // The real guard. `KNOWN_KEYS` above is a hand-list and hand-lists
    // rot; this reads the source and fails when a new prefix appears,
    // so a future feature cannot quietly store something outside the
    // reach of the erasure control.
    const out = execFileSync(
      'grep',
      [
        '-rhoE',
        // Key CONSTANTS and template prefixes: a quoted literal that
        // looks like a storage key, at the point it is declared.
        "(KEY|PREFIX|STORAGE_KEY|DISMISS_KEY|STORAGE_PING_KEY)[A-Z_]* = '[^']+'|makePendingMarkerStore\\('[^']+'\\)",
        'src',
        '--include=*.ts',
        '--include=*.tsx',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    const literals = [...out.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(5);

    const uncovered = literals.filter((literal) => {
      // Only judge things that look like storage keys — the pattern
      // also catches unrelated constants, and a false failure here
      // would train people to delete the test.
      if (!/^(app|vaipakam)/.test(literal)) return false;
      return !isAppStorageKey(literal);
    });
    expect(uncovered, `storage keys outside the data-rights scan: ${uncovered.join(', ')}`).toEqual(
      [],
    );
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
