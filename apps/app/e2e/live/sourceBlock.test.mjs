/**
 * `blockFrom` is a test helper, and a wrong answer from it does not
 * fail — it WEAKENS, silently, every rule asserted over the slice it
 * returns. A short slice makes a rule blind to the tail (the defect that
 * produced this module); a long one makes a rule match the block's
 * neighbours. Neither shows up as a red test, which is exactly why the
 * helper is pinned directly rather than only through its callers.
 */
import { describe, expect, it } from 'vitest';

import { blockFrom } from './sourceBlock.mjs';

describe('blockFrom', () => {
  it('ends at the matching close, not the first one', () => {
    const src = 'before\nfunction f() {\n  if (x) { a(); }\n  b();\n}\nafter { c(); }\n';
    const body = blockFrom(src, 'function f()');
    expect(body).toContain('b();');
    expect(body.endsWith('}')).toBe(true);
    // The neighbour is not in it. A fixed window would have taken it.
    expect(body).not.toContain('after');
    expect(body).not.toContain('c();');
  });

  it('includes the header itself, so rules can assert on the signature', () => {
    const body = blockFrom('const g = () => {\n  y();\n};\n', 'const g = () => {');
    expect(body.startsWith('const g = () => {')).toBe(true);
    expect(body).toContain('y();');
  });

  it('takes a control-flow block, not only a function', () => {
    const src = 'if (a) {\n  one();\n} else {\n  two();\n}\n';
    const body = blockFrom(src, 'if (a) {');
    expect(body).toContain('one();');
    // The `else` arm is a SEPARATE block — the if's own brace closes
    // before it, and callers that want the arm take what follows.
    expect(body).not.toContain('two();');
  });

  it('throws when the header is gone rather than returning nothing', () => {
    // The whole point. A helper that returned '' here would turn every
    // rule built on it into a passing assertion over an empty string —
    // the vacuous shape this suite has been caught by four times.
    expect(() => blockFrom('function f() {}', 'function renamed()')).toThrow(/renamed or removed/);
  });

  it('throws when the header opens no block', () => {
    expect(() => blockFrom('const x = 1;\n', 'const x = 1;')).toThrow(/opens no block/);
  });

  it('throws on an unbalanced block rather than returning the rest of the file', () => {
    expect(() => blockFrom('function f() {\n  a();\n', 'function f()')).toThrow(
      /no matching close brace/,
    );
  });
});
