/**
 * The recovery confirmation word, enforced where CI can see it.
 *
 * The shared translate script (`packages/i18n/scripts/translate-i18n.ts`,
 * reached through `scripts/translate.mjs`) cross-checks the policy file
 * against `RECOVERY_CONFIRM_WORD` and rejects a response that loses the
 * token — but that script only runs when someone types the `translate`
 * command by hand. The required DeFi check is `tsc -b --noEmit`, which never
 * executes it. So `RECOVERY_CONFIRM_WORD` could change while the policy
 * and the committed prompts kept the old word, every required check
 * would stay green, and speakers of all nine translated languages would
 * be told to type a word that can no longer enable signing (Codex #1563
 * r21).
 *
 * A test is the right home: `defi-vitest.yml` is blocking, so this
 * fails a PR rather than waiting for the next translation run.
 */
import { describe, expect, it } from 'vitest';
import { containsToken } from '@vaipakam/i18n';

import { RECOVERY_CONFIRM_WORD } from '../lib/recoveryConfirm';
import { TRANSLATED_LOCALES } from './glossary';
import policy from './translation-policy.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import ja from './locales/ja.json';
import zh from './locales/zh.json';
import hi from './locales/hi.json';
import ta from './locales/ta.json';
import ko from './locales/ko.json';
import ar from './locales/ar.json';

const PROMPT_KEY = 'vaultRecover.modalConfirmPrompt';

/**
 * Bound to TRANSLATED_LOCALES, not hand-listed. A static map would stay
 * at today's ten while an eleventh locale was promoted and registered,
 * so the blocking test would keep passing without ever looking at the
 * new locale's recovery prompt — and a translated confirmation word
 * could ship with that language's sign button permanently disabled
 * (Codex #1563 r22). The identity assertion below is what makes the
 * binding real rather than decorative: adding a locale to the registry
 * without adding its bundle here fails immediately.
 */
const BUNDLES: Record<string, unknown> = { en, es, fr, de, ja, zh, hi, ta, ko, ar };

function prompt(bundle: unknown): unknown {
  return (bundle as { vaultRecover?: Record<string, unknown> })?.vaultRecover?.[
    'modalConfirmPrompt'
  ];
}

describe('recovery confirmation word', () => {
  it('checks every locale the app advertises as translated', () => {
    expect([...Object.keys(BUNDLES)].sort()).toEqual([...TRANSLATED_LOCALES].sort());
  });

  it('is named in the translation policy, exactly once', () => {
    // EXACTLY one entry, not merely "includes": every listed token is
    // REQUIRED, so a leftover second word would reject every correct
    // prompt carrying only the live one.
    expect(policy.requiredLiterals[PROMPT_KEY]).toEqual([RECOVERY_CONFIRM_WORD]);
  });

  it.each(TRANSLATED_LOCALES)(
    '%s keeps the word the gate compares against',
    (code) => {
      const value = prompt(BUNDLES[code]);
      expect(typeof value).toBe('string');
      // Standalone token: "Tapez CONFIRMÉ" and "Escribe CONFIRMAR" both
      // CONTAIN the word while asking for something the gate rejects.
      expect(containsToken(value as string, RECOVERY_CONFIRM_WORD)).toBe(true);
    },
  );
});
