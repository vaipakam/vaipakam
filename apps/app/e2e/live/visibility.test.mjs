/**
 * The visibility module's COMPOSITION, and the guard that the drive uses
 * it everywhere (#2102).
 *
 * The helpers themselves are layout questions and are exercised against a
 * real engine in `e2e/tests/31-observer-visibility.spec.ts`. What can be
 * tested here without a DOM is the seam that replaced the duplication:
 * that `withVisibility` produces a plain function Playwright can
 * serialise, that the body receives the whole family and whatever
 * Playwright passes, and that the drive has no inline copy left and no
 * consumer outside the composition.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VISIBILITY_SOURCE, visibilityHelpers, withVisibility } from './visibility.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVE = fs.readFileSync(path.join(HERE, 'live-position-observe.mjs'), 'utf8');

const FAMILY = ['notClipped', 'paintsText', 'shownBox', 'visible', 'visibleTextOf'];

describe('withVisibility', () => {
  it('hands the body the whole family and both Playwright arguments', () => {
    // Defining the helpers touches no DOM, so the composed function runs
    // here; only CALLING a helper needs a browser.
    const f = withVisibility((V, a, b) => [Object.keys(V).sort(), a, b]);
    expect(f('element', 'arg')).toEqual([[...FAMILY].sort(), 'element', 'arg']);
  });

  it('is a plain function whose source Playwright can serialise', () => {
    const f = withVisibility((V) => V.visible(null));
    expect(typeof f).toBe('function');
    const src = f.toString();
    // The composed source carries the family's definition and the body,
    // and nothing that would need a Node-side closure to resolve.
    expect(src).toContain('function visibilityHelpers()');
    expect(src).toContain('V.visible(null)');
    expect(src).not.toContain('require(');
    expect(src).not.toContain('import ');
  });

  it('gives every composition a fresh family, so one read cannot leak into another', () => {
    const a = withVisibility((V) => V.visibleTextOf)();
    const b = withVisibility((V) => V.visibleTextOf)();
    expect(a).not.toBe(b);
  });

  it('refuses a body that is not a function, by name', () => {
    expect(() => withVisibility('return 1')).toThrow(/expects the evaluate body as a function/);
  });

  it('exposes the family source the fixture suite injects, and it evaluates to the family', () => {
    expect(VISIBILITY_SOURCE).toBe(visibilityHelpers.toString());
    const family = new Function(`return (${VISIBILITY_SOURCE})();`)();
    expect(Object.keys(family).sort()).toEqual([...FAMILY].sort());
  });
});

describe('the drive carries no copy of the predicate family', () => {
  // The acceptance test #2102 set: adding a rule to the predicate cannot
  // again reach one call site and not the other. With one definition that
  // holds by construction — provided nothing reintroduces an inline copy
  // or a consumer that bypasses the composition. Both are pinned here.
  it('defines none of the helpers inline', () => {
    for (const name of FAMILY) {
      expect(DRIVE, name).not.toMatch(new RegExp(`const ${name} = \\((node|root)\\) =>`));
    }
  });

  it('composes the module at every consumer, and evaluates no source in the page', () => {
    expect(DRIVE).toContain("import { withVisibility } from './visibility.mjs';");
    const sites = [...DRIVE.matchAll(/withVisibility\(\(V(?:, el)?\) =>/g)];
    // Card pass, receipt pass, mount wait, back-button read.
    expect(sites).toHaveLength(4);
    expect(DRIVE).not.toContain('new Function(');
    expect(DRIVE).not.toContain('VISIBILITY_HELPER_SOURCES');
  });

  it('destructures the family at both scrape passes, so a helper is named where it is used', () => {
    const line = 'const { notClipped, paintsText, shownBox, visible, visibleTextOf } = V;';
    expect(DRIVE.split(line).length - 1).toBe(2);
  });
});
