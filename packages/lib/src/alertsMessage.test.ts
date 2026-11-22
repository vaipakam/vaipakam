/**
 * The four alert-family message formats are FROZEN (#2014, following
 * the erasure family's #2002 discipline): every signature ever
 * collected was made over these exact bytes, and the agent Worker
 * reconstructs each message verbatim to recover the signer — a
 * drifted character rejects every affected request. Pinned verbatim
 * so any edit to a builder fails here first, and pinned as MUTUALLY
 * DISTINCT so no signature can ever cross actions.
 */
import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import {
  alertRequestUnused,
  ALERT_PHRASE_MAX,
  alertPhraseFingerprint,
  alertPhraseProblem,
  buildAlertPhraseClearMessage,
  buildAlertPhraseMessage,
  buildAlertSettingsMessage,
  buildTelegramLinkMessage,
  buildTelegramTestMessage,
  buildTelegramUnlinkMessage,
  isRequestKey,
  newRequestKey,
  normaliseAlertPhrase,
  requestKeyHash,
} from './alertsMessage';

const WALLET = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const LOWER = '0x1daefa360ed370285f003fa2d92db75628088282';
// #3836 — keccak-256 of a fixed request key, upper-cased in the call to
// show the message writes it lower-case.
const KEY = `0x${'11'.repeat(32)}` as const;
const KEY_HASH = requestKeyHash(KEY);
const KEY_LINE =
  'Request key hash (only the requesting browser holds the key): ' +
  '0xb569321de72d0af89c2fb48a484de3fc9343f31600ae1f3e13d633cb48cbf816';

describe('buildTelegramLinkMessage', () => {
  it('produces the frozen byte sequence, verbatim', () => {
    expect(buildTelegramLinkMessage(WALLET, 84532, 1747000000, KEY_HASH.toUpperCase())).toBe(
      'Vaipakam — Link Telegram alerts\n' +
        '\n' +
        'I authorise Telegram alert delivery for the wallet below to the\n' +
        'chat that completes this link code. Signing this message proves\n' +
        'ownership of the wallet. It is not a transaction and costs no gas.\n' +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000\n' +
        KEY_LINE,
    );
  });
});

describe('buildTelegramUnlinkMessage', () => {
  it('produces the frozen byte sequence, verbatim', () => {
    expect(buildTelegramUnlinkMessage(WALLET, 84532, 1747000000, KEY_HASH.toUpperCase())).toBe(
      'Vaipakam — Unlink Telegram alerts\n' +
        '\n' +
        'I request that Telegram alert delivery for the wallet below be\n' +
        'disconnected. Signing this message proves ownership of the\n' +
        'wallet. It is not a transaction and costs no gas.\n' +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000\n' +
        KEY_LINE,
    );
  });

  it('claims no scope beyond the chain it names (#2013 round 4 P1)', () => {
    // The effect's scope follows the signer's authority — an ECDSA
    // key clears the wallet everywhere, a smart account's
    // chain-verified approval clears only this chain — so the signed
    // text must promise neither. A reintroduced "everywhere" would
    // make the chain-scoped outcome a false confirmation.
    expect(buildTelegramUnlinkMessage(WALLET, 84532, 1, KEY_HASH)).not.toContain('everywhere');
  });
});

describe('buildAlertSettingsMessage (#2754)', () => {
  const BANDS = { warnHf: 1.5, alertHf: 1.2, criticalHf: 1.05 };

  it('produces the frozen byte sequence, verbatim', () => {
    expect(
      buildAlertSettingsMessage(
        WALLET,
        84532,
        { bands: BANDS, dueDateReminders: false, pushAlerts: true },
        1747000000,
        KEY_HASH,
      ),
    ).toBe(
      'Vaipakam — Save alert settings\n' +
        '\n' +
        'I request that the alert settings below be saved for the wallet\n' +
        'below. A setting marked unchanged keeps its saved value. Signing\n' +
        'this message proves ownership of the wallet. It is not a\n' +
        'transaction and costs no gas.\n' +
        '\n' +
        'Health-factor alerts: warn at 1.5, alert at 1.2, critical at 1.05\n' +
        'Due-date payment reminders: off\n' +
        'Push alerts: switch on\n' +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000\n' +
        KEY_LINE,
    );
  });

  it('says unchanged for every field the save leaves alone', () => {
    const msg = buildAlertSettingsMessage(WALLET, 84532, {}, 1, KEY_HASH);
    expect(msg).toContain('Health-factor alerts: unchanged');
    expect(msg).toContain('Due-date payment reminders: unchanged');
    expect(msg).toContain('Push alerts: unchanged');
  });

  it('names each value, so a signature for one save is not one for another', () => {
    const msgs = [
      {},
      { bands: BANDS },
      { bands: { ...BANDS, criticalHf: 1.01 } },
      { dueDateReminders: true },
      { dueDateReminders: false },
      { pushAlerts: true as const },
      { vaultOutflowAlerts: 'on' as const },
      { vaultOutflowAlerts: 'off' as const },
      { vaultOutflowAlerts: 'default' as const },
    ].map((change) => buildAlertSettingsMessage(WALLET, 84532, change, 1, KEY_HASH));
    expect(new Set(msgs).size).toBe(msgs.length);
  });

  it('adds the vault outflow line only when the save sets it (#3434)', () => {
    expect(buildAlertSettingsMessage(WALLET, 84532, {}, 1, KEY_HASH)).not.toContain('Vault outflow');
    expect(buildAlertSettingsMessage(WALLET, 84532, { vaultOutflowAlerts: 'default' }, 1, KEY_HASH)).toContain(
      'Push alerts: unchanged\nVault outflow alerts: on while protected mode is on (default)\n\nWallet:',
    );
  });
});

describe('buildTelegramTestMessage', () => {
  it('produces the frozen byte sequence, verbatim', () => {
    expect(buildTelegramTestMessage(WALLET, 84532, 1747000000, KEY_HASH.toUpperCase())).toBe(
      'Vaipakam — Send a test alert\n' +
        '\n' +
        'I request one test alert be sent to the Telegram chat linked to\n' +
        'the wallet below, to confirm delivery works. Signing this message\n' +
        'proves ownership of the wallet. It is not a transaction and costs\n' +
        'no gas.\n' +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000\n' +
        KEY_LINE,
    );
  });
});

describe('the four messages as a family', () => {
  const builders = [
    buildTelegramLinkMessage,
    buildTelegramUnlinkMessage,
    (wallet: string, chainId: number, issuedAt: number, keyHash: string) =>
      buildAlertSettingsMessage(wallet, chainId, {}, issuedAt, keyHash),
    buildTelegramTestMessage,
    (wallet: string, chainId: number, issuedAt: number, keyHash: string) =>
      buildAlertPhraseMessage(wallet, chainId, `0x${'ab'.repeat(32)}`, issuedAt, keyHash),
    buildAlertPhraseClearMessage,
  ];

  it('are mutually distinct — no signature can cross actions', () => {
    // Same wallet, same chain, same timestamp: only the wording
    // separates them, which is exactly what the agent's per-action
    // verification relies on.
    const msgs = builders.map((b) => b(WALLET, 84532, 1, KEY_HASH));
    expect(new Set(msgs).size).toBe(builders.length);
  });

  it('lower-case the wallet so checksummed and lowercase spellings sign identically', () => {
    for (const build of builders) {
      expect(build(WALLET, 84532, 1, KEY_HASH)).toBe(build(LOWER, 84532, 1, KEY_HASH));
    }
  });

  it('bind the chain id — a signature for one chain is not one for another', () => {
    for (const build of builders) {
      expect(build(WALLET, 84532, 1, KEY_HASH)).not.toBe(build(WALLET, 421614, 1, KEY_HASH));
    }
  });

  it('bind the request key (#3836) — an approval for one key is not one for another', () => {
    const other = requestKeyHash(`0x${'22'.repeat(32)}`);
    for (const build of builders) {
      expect(build(WALLET, 84532, 1, KEY_HASH)).not.toBe(build(WALLET, 84532, 1, other));
    }
  });
});

describe('the request key (#3836)', () => {
  it('is 32 random bytes as lower-case hex, different each time', () => {
    const a = newRequestKey();
    const b = newRequestKey();
    expect(isRequestKey(a)).toBe(true);
    expect(isRequestKey(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('refuses anything else as a key', () => {
    for (const bad of [undefined, 1, '', '0x', `0x${'1'.repeat(63)}`, `0x${'A'.repeat(64)}`, `${'1'.repeat(64)}`]) {
      expect(isRequestKey(bad)).toBe(false);
    }
  });

  it('hashes to the keccak-256 the message names', () => {
    expect(KEY_HASH).toBe('0x' + KEY_HASH.slice(2).toLowerCase());
    expect(KEY_HASH).toHaveLength(66);
    expect(KEY_HASH).not.toBe(KEY);
  });
});

describe('alertRequestUnused (#3836)', () => {
  it('keeps a request the service refused before recording it', () => {
    expect(alertRequestUnused(429, 'rate-limited')).toBe(true);
    expect(alertRequestUnused(429, 'verification_failed')).toBe(true);
    expect(alertRequestUnused(503, 'verification-unavailable')).toBe(true);
    expect(alertRequestUnused(503, 'rate-limit-unavailable')).toBe(true);
    expect(alertRequestUnused(503, 'rate-limit-binding-missing')).toBe(true);
  });

  it('drops one that was used or can never apply', () => {
    expect(alertRequestUnused(200, undefined)).toBe(false);
    expect(alertRequestUnused(429, 'test-alert-cooldown')).toBe(false);
    expect(alertRequestUnused(409, 'request-already-used')).toBe(false);
    expect(alertRequestUnused(409, 'request-superseded')).toBe(false);
    expect(alertRequestUnused(401, 'verification_failed')).toBe(false);
    expect(alertRequestUnused(503, 'order-unavailable')).toBe(false);
  });
});

describe('the alert phrase (#3346)', () => {
  it('produces the frozen byte sequences, verbatim, naming only a fingerprint', () => {
    const fp = alertPhraseFingerprint(KEY, 'blue heron');
    expect(buildAlertPhraseMessage(WALLET, 84532, fp.toUpperCase().replace('0X', '0x'), 1747000000, KEY_HASH)).toBe(
      'Vaipakam — Set the alert phrase\n' +
        '\n' +
        "I request that this wallet's alert phrase be set. The phrase is\n" +
        'not in this message; the line below is its fingerprint. Signing\n' +
        'this message proves ownership of the wallet. It is not a\n' +
        'transaction and costs no gas.\n' +
        '\n' +
        `Phrase fingerprint: ${fp}\n` +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000\n' +
        KEY_LINE,
    );
    expect(buildAlertPhraseMessage(WALLET, 84532, fp, 1, KEY_HASH)).not.toContain('blue heron');
    expect(buildAlertPhraseClearMessage(WALLET, 84532, 1747000000, KEY_HASH)).toBe(
      'Vaipakam — Remove the alert phrase\n' +
        '\n' +
        "I request that this wallet's alert phrase be removed, so alerts no\n" +
        'longer lead with it. Signing this message proves ownership of the\n' +
        'wallet. It is not a transaction and costs no gas.\n' +
        '\n' +
        `Wallet: ${LOWER}\n` +
        'Chain id: 84532\n' +
        'Issued at (unix): 1747000000\n' +
        KEY_LINE,
    );
  });

  it('binds the fingerprint to the tag, the request key and the phrase', () => {
    const other = `0x${'22'.repeat(32)}` as const;
    expect(alertPhraseFingerprint(KEY, 'blue heron')).not.toBe(alertPhraseFingerprint(other, 'blue heron'));
    expect(alertPhraseFingerprint(KEY, 'blue heron')).not.toBe(alertPhraseFingerprint(KEY, 'blue herons'));
    expect(alertPhraseFingerprint(KEY, 'blue heron')).toMatch(/^0x[0-9a-f]{64}$/);
    // Pinned, so the app and the agent can never compute it differently.
    expect(alertPhraseFingerprint(KEY, 'blue heron')).toBe(
      keccak256(toHex(new TextEncoder().encode(`Vaipakam alert phrase v1${String.fromCharCode(0x11).repeat(32)}blue heron`))),
    );
  });

  it('trims and composes what was typed, and refuses the rest by name', () => {
    expect(normaliseAlertPhrase('  blue heron ')).toBe('blue heron');
    expect(alertPhraseProblem('blue heron')).toBeNull();
    expect(alertPhraseProblem('blue  heron')).toBeNull();
    expect(alertPhraseProblem(' blue heron')).toBe('not-normalised');
    expect(alertPhraseProblem('cafe\u0301')).toBe('not-normalised');
    expect(alertPhraseProblem('ab')).toBe('too-short');
    expect(alertPhraseProblem('x'.repeat(ALERT_PHRASE_MAX + 1))).toBe('too-long');
    expect(alertPhraseProblem('நீல நாரை')).toBeNull();
    expect(alertPhraseProblem('v2.5 heron')).toBeNull();
    for (const bad of ['blue\u202eheron', 'blue\u200bheron', 'blue\theron', 'evil.example', 'a/b heron', 'heron:1', '@heron']) {
      expect(alertPhraseProblem(bad)).toBe('bad-characters');
    }
  });
});
