/**
 * #2071 — the Protocol Console cannot silently fall behind the canonical
 * knob reference. Every `###` setting in
 * `docs/ops/AdminConfigurableKnobsAndSwitches.md` is either shown or
 * listed with the reason it is not, every rendered value is claimed by a
 * setting in that document, and every setting the shared reader publishes
 * is rendered.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_KNOB_GETTERS } from '@vaipakam/lib/protocolKnobs';
import { DOC_COVERAGE } from './protocolConsoleDocCoverage';
import { RENDERED_KEYS } from './protocolConsoleRows';

const DOC = readFileSync(
  new URL('../../../../docs/ops/AdminConfigurableKnobsAndSwitches.md', import.meta.url),
  'utf8',
);
const HEADINGS = DOC.split('\n')
  .filter((l) => l.startsWith('### '))
  .map((l) => l.slice(4).trim());

describe('Protocol Console coverage of the knob reference', () => {
  it('reads the reference document', () => {
    expect(HEADINGS.length).toBeGreaterThan(40);
    expect(new Set(HEADINGS).size).toBe(HEADINGS.length);
  });

  it('accounts for every setting the document lists', () => {
    const missing = HEADINGS.filter((h) => !(h in DOC_COVERAGE));
    expect(missing, 'add each to DOC_COVERAGE: shown, or not shown with a reason').toEqual([]);
  });

  it('names no setting the document no longer has', () => {
    const gone = Object.keys(DOC_COVERAGE).filter((h) => !HEADINGS.includes(h));
    expect(gone).toEqual([]);
  });

  it('claims each rendered value under exactly one setting, and renders every claimed value', () => {
    const claimed = Object.values(DOC_COVERAGE).flatMap((c) => ('shown' in c ? c.shown : []));
    expect(new Set(claimed).size, 'a value claimed twice').toBe(claimed.length);
    expect([...RENDERED_KEYS].filter((k) => !claimed.includes(k))).toEqual([]);
    expect(claimed.filter((k) => !RENDERED_KEYS.has(k))).toEqual([]);
  });

  it('never lists a rendered value among a heading\'s unshown settings', () => {
    const unshown = Object.values(DOC_COVERAGE).flatMap((c) =>
      'shown' in c && c.alsoNotShown ? Object.keys(c.alsoNotShown) : [],
    );
    expect(unshown.filter((k) => RENDERED_KEYS.has(k as never))).toEqual([]);
  });

  it('renders every setting the shared reader publishes', () => {
    for (const k of PROTOCOL_KNOB_GETTERS) {
      expect(RENDERED_KEYS.has(k.key as never), k.key).toBe(true);
    }
  });
});
