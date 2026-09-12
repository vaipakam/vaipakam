/**
 * `blockFrom` is a test helper, and a wrong answer from it does not
 * fail — it WEAKENS, silently, every rule asserted over the slice it
 * returns. A short slice makes a rule blind to the tail (the defect that
 * produced this module); a long one makes a rule match the block's
 * neighbours. Neither shows up as a red test, which is exactly why the
 * helper is pinned directly rather than only through its callers.
 */
import { describe, expect, it } from 'vitest';

import { blockFrom, callContaining, stripLineComments } from './sourceBlock.mjs';

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

describe('callContaining', () => {
  // The report this was written for is one of dozens of `console.log(`
  // calls, so the anchor is a string INSIDE it. That only works if the
  // search runs backwards from the anchor — forwards from the file start
  // finds the first call, which is a different one every time the file
  // is edited above.
  const src = [
    "console.log('unrelated', a(b), c);",
    'console.log(',
    "  `  card=${v.chooser}` +",
    "  ` head=${v.head ?? 'none'}`,",
    ');',
    "console.log('after');",
  ].join('\n');

  it('takes the call the anchor is inside, not the first one in the file', () => {
    const call = callContaining(src, '`  card=${v.chooser}`');
    expect(call).toContain('head=');
    expect(call).not.toContain('unrelated');
    expect(call).not.toContain('after');
  });

  it('closes on the call, not on a nested paren', () => {
    const nested = "console.log(\n  `x=${f(g(h))}` + `y=${1}`,\n);\nconsole.log('next');";
    const call = callContaining(nested, '`x=');
    expect(call).toContain('y=');
    expect(call).not.toContain('next');
  });

  it('throws when the anchor is gone', () => {
    expect(() => callContaining(src, '`  gone=')).toThrow(/renamed or removed/);
  });

  it('throws when no such call encloses the anchor', () => {
    expect(() => callContaining('const x = `  card=1`;\n', '`  card=')).toThrow(/not inside/);
  });

  it('refuses a call that closed before reaching the anchor', () => {
    // The failure an unbalanced paren in a string literal produces. Left
    // unchecked it returns an earlier, complete call and every rule over
    // it is about the wrong code — silently, since that slice parses
    // fine.
    const broken = "console.log('oops)');\nconst s = `  card=1`;\n";
    expect(() => callContaining(broken, '`  card=')).toThrow(/not inside the console\.log\( call/);
  });
});

describe('stripLineComments', () => {
  // A guard reads code; the drive's comments quote code. Over-stripping
  // is the silent direction — a rule over less text passes more easily —
  // so what must survive is pinned as carefully as what must go.
  it('drops whole-line comments, however indented', () => {
    const src = "a();\n// b();\n    // c();\nd();\n";
    expect(stripLineComments(src)).toBe('a();\nd();\n');
  });

  it('keeps a trailing comment and its line', () => {
    // Not a "//"-to-end-of-line stripper: a trailing comment's LINE is
    // code, and the code half must not be lost with it.
    expect(stripLineComments("x = 1; // set\n")).toBe('x = 1; // set\n');
  });

  it('keeps a // inside a string', () => {
    // A URL is the realistic case. Truncating its line would shorten the
    // very code being checked.
    const src = "const u = 'https://rpc.example';\n";
    expect(stripLineComments(src)).toBe(src);
  });

  it('keeps a comment-looking line that is not one', () => {
    expect(stripLineComments("' // not a comment'\n")).toBe("' // not a comment'\n");
  });

  it('leaves comment-free text untouched', () => {
    const src = 'a();\nb();\n';
    expect(stripLineComments(src)).toBe(src);
  });
});
