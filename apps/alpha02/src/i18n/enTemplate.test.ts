/**
 * Drift guard: the committed translators' template
 * (`locales/en.json`) must match what `copy.ts` currently contains.
 * Fails when a copy.ts string lands without re-running
 * `pnpm --filter @vaipakam/alpha02 i18n:template` — otherwise
 * translators would work from stale keys and the new string would
 * silently never be translatable.
 */

import { describe, expect, it } from 'vitest';
import { copySource } from '../content/copy';
import { buildTemplate } from './template';
import committed from './locales/en.json';

describe('i18n en.json template', () => {
  it('matches copy.ts (run `pnpm i18n:template` after editing copy.ts)', () => {
    expect(committed).toEqual({ copy: buildTemplate(copySource) });
  });
});
