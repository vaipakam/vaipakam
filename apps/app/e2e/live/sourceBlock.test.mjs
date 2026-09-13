/**
 * `blockFrom` is a test helper, and a wrong answer from it does not
 * fail — it WEAKENS, silently, every rule asserted over the slice it
 * returns. A short slice makes a rule blind to the tail (the defect that
 * produced this module); a long one makes a rule match the block's
 * neighbours. Neither shows up as a red test, which is exactly why the
 * helper is pinned directly rather than only through its callers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  balancedArgs,
  between,
  blockFrom,
  callContaining,
  statementFrom,
  stripLineComments,
} from './sourceBlock.mjs';

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

describe('#2144 — between(): a region bounded by a following anchor', () => {
  const src = [
    'const alpha = 1;',
    '// a comment about beta',
    'const beta = 2;',
    'const gamma = 3;',
  ].join('\n');

  it('returns the region from one anchor up to the next', () => {
    const region = between(src, 'const alpha', 'const beta');
    expect(region).toContain('const alpha = 1;');
    expect(region).toContain('a comment about beta');
    expect(region).not.toContain('const beta = 2;');
  });

  it('throws when the opening anchor is gone', () => {
    expect(() => between(src, 'const delta', 'const beta')).toThrow(/const delta was renamed/);
  });

  it('throws when the closing anchor is gone', () => {
    expect(() => between(src, 'const alpha', 'const omega')).toThrow(/const omega does not follow/);
  });

  // The vacuous shape this helper exists to refuse: a `to` that appears
  // only BEFORE `from` would otherwise yield '' and pass every assertion
  // by measuring nothing.
  it('throws rather than returning an empty region when the anchors are out of order', () => {
    expect(() => between(src, 'const gamma', 'const alpha')).toThrow(/does not follow/);
    expect(between(src, 'const alpha', 'const gamma')).not.toBe('');
  });

  // The closing anchor is searched for AFTER the opening one ends, so an
  // anchor that is a prefix of its own region does not match itself.
  it('does not match the closing anchor inside the opening one', () => {
    expect(between('const a = 1; const a = 2;', 'const a', 'const a')).toBe('const a = 1; ');
  });

  // An EMPTY anchor matches at 0, so the helper would otherwise produce
  // the very vacuous region it exists to refuse.
  it('rejects an empty anchor rather than returning an empty region', () => {
    expect(() => between(src, '', 'const beta')).toThrow(/non-empty `from`/);
    expect(() => between(src, 'const alpha', '')).toThrow(/non-empty `to`/);
    expect(() => between(src, undefined, 'const beta')).toThrow(/non-empty `from`/);
  });
});

describe('statementFrom', () => {
  it('ends at the declaration s own semicolon, not the next one', () => {
    const src = 'const a =\n  one &&\n  two;\nconst b = three;\n';
    expect(statementFrom(src, 'const a =')).toBe('const a =\n  one &&\n  two;');
  });

  // The reason a fixed window was reached for in the first place: these
  // initializers span lines and carry calls, so any bound short of the
  // statement's own end either truncates it or runs into the next one.
  it('keeps a multi-line initializer whole, including nested calls', () => {
    const src = 'const s =\n  h > 0n &&\n  [...k].every((x) => f(x));\nconst next = 1;\n';
    const got = statementFrom(src, 'const s =');
    expect(got).toContain('.every(');
    expect(got.endsWith('f(x));')).toBe(true);
    expect(got).not.toContain('next');
  });

  // A semicolon inside an arrow body belongs to the body, not to the
  // declaration that contains it. Stopping there would cut the statement
  // in half and leave the rule blind to everything after the callback.
  it('does not end on a semicolon nested inside a callback', () => {
    const src = 'const g = run(() => { step(); }) && tail;\nconst after = 2;\n';
    expect(statementFrom(src, 'const g =')).toBe('const g = run(() => { step(); }) && tail;');
  });

  // Strings and comments are TEXT. A `;` in either is not the statement's
  // end, and reading it as one produces a short slice that passes a
  // `toContain` only by luck.
  it('ignores semicolons inside strings and comments', () => {
    const src = "const m = note('a; b') /* c; */ + `d; ${e('f; g')}`;\nconst z = 3;\n";
    const got = statementFrom(src, 'const m =');
    expect(got.endsWith('`;')).toBe(true);
    expect(got).not.toContain('const z');
  });

  // Same refusal as every other helper here: a missing anchor, or a
  // statement with no end, throws rather than handing back a region that
  // would pass by measuring nothing.
  it('throws rather than guessing when the anchor or the end is missing', () => {
    expect(() => statementFrom('const a = 1;', 'const gone =')).toThrow(/renamed or removed/);
    expect(() => statementFrom('const a = 1', 'const a =')).toThrow(/no terminating semicolon/);
  });
});

describe('balancedArgs', () => {
  it('takes the whole argument list, across lines and nested calls', () => {
    const src = 'f(\n  a.indexOf(g(1)),\n  b,\n);\nafter();';
    expect(balancedArgs(src, src.indexOf('('))).toBe('\n  a.indexOf(g(1)),\n  b,\n');
  });

  it('closes on the call, not on a nested bracket', () => {
    const src = 'h([x, y], {k: 1});next();';
    expect(balancedArgs(src, src.indexOf('('))).toBe('[x, y], {k: 1}');
  });

  // A SCANNER meets text that is not a call, and should move on rather
  // than abort the sweep — the opposite of the anchored helpers, which
  // are told what to find and throw when it is gone.
  it('returns null instead of throwing when there is no call to read', () => {
    expect(balancedArgs('const x = 1;', 0)).toBeNull();
    expect(balancedArgs('f(a, b', 1)).toBeNull();
    // An unterminated quote means this was not a call — an apostrophe in
    // a comment is the usual way — so the sweep moves on rather than
    // aborting on text it was never meant to read.
    expect(balancedArgs("f('unclosed", 1)).toBeNull();
  });

  // The realistic anchor: a quoted fragment of the code being searched
  // for, whose own brackets are TEXT. Counting them walks the depth off
  // and the call "closes" somewhere in the next test.
  it('does not count brackets inside a string anchor', () => {
    const src = "f(s.indexOf('for (const l of xs) {'));\nnext();";
    expect(balancedArgs(src, src.indexOf('('))).toBe("s.indexOf('for (const l of xs) {')");
  });
});

// THE GUARD THIS WHOLE MODULE EXISTS FOR (#2144).
//
// Twice now the completeness of that conversion was claimed from a
// hand-written grep, and twice the grep was narrower than the shape it
// was looking for: the first missed `slice(i, i + 320)` because it
// required an `indexOf` in the bound, the second missed the same window
// written across four lines because `[^)]*` stops at the nested
// `indexOf(...)`'s own close paren. Both times the claim read as
// verified and was not.
//
// A prose rule policed by a regex a person writes fresh each time is not
// a rule. This asserts it instead, and the two properties that beat the
// greps are why it is written the long way round:
//
//   - the bound is read as BALANCED TEXT, so it does not matter whether
//     the window is on one line or four, nor how many nested calls its
//     arguments carry;
//   - string literals are removed from the bound BEFORE looking for a
//     number, so `indexOf('ROUND 93 P2 — …')` is an anchor and not a
//     count. What remains is arithmetic, and arithmetic on a source
//     region is the defect.
//
// It deliberately does NOT forbid a hand-written `src.slice(a, b)` whose
// bounds are both anchors. Several read perfectly well, `between` is
// exactly that shape, and a rule that banned them would be about tidiness
// rather than about the failure #2144 names.
describe('#2144 — no source region is bounded by a character count', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.test.mjs'))
    .sort();

  // Producers of SOURCE TEXT. `readFileSync` however it is qualified
  // (`fs.readFileSync`, a destructured import), and every helper in this
  // module — a region taken from a region is still a region.
  const PRODUCER = String.raw`(?:[\w$.]*\breadFileSync|blockFrom|between|statementFrom|callContaining|stripLineComments)`;

  // Counted rather than sliced: this file is itself under the rule, and a
  // helper that broke it to report on it would be its own first failure.
  const lineOf = (text, index) => {
    let n = 1;
    for (let i = 0; i < index; i += 1) if (text[i] === '\n') n += 1;
    return n;
  };

  const withoutStrings = (text) => text.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");

  it('finds the suites to check', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('headSampling.test.mjs');
  });

  it.each(files)('%s bounds every source region by meaning', (file) => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const held = new Set();
    const decl = new RegExp(
      String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?${PRODUCER}\s*\(`,
      'g',
    );
    for (const m of text.matchAll(decl)) held.add(m[1]);

    const counted = [];
    for (const name of held) {
      const use = new RegExp(String.raw`\b${name}\s*\.\s*slice\s*\(`, 'g');
      for (const m of text.matchAll(use)) {
        const open = text.indexOf('(', m.index + name.length);
        const args = balancedArgs(text, open);
        if (args === null) continue;
        const bare = withoutStrings(args);
        if (/\d/.test(bare)) {
          counted.push(`${file}:${lineOf(text, m.index)} — ${name}.slice(${bare.trim()})`);
        }
      }
    }
    expect(
      counted,
      'a source region bounded by a number: use blockFrom / between / statementFrom / callContaining',
    ).toEqual([]);
  });
});
