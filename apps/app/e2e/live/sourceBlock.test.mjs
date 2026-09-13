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
  between,
  blockFrom,
  callContaining,
  numericBindingAt,
  numericValueOf,
  sliceCallsIn,
  statementFrom,
  stripLineComments,
} from './sourceBlock.mjs';

describe('blockFrom', () => {
  it('ends at the matching close, not the first one', () => {
    const src = 'before;\nfunction f() {\n  if (x) { a(); }\n  b();\n}\nafter();\n{ c(); }\n';
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

  // An unbalanced block is now a PARSE failure, and the message says so.
  // Reaching the end of the file with braces open is not a region the
  // grammar has, and the old scanner could only discover that by running
  // out of characters.
  it('throws on an unbalanced block rather than returning the rest of the file', () => {
    expect(() => blockFrom('function f() {\n  a();\n', 'function f()')).toThrow(
      /does not parse as a module/,
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

  // The hazard this case was written for is STRUCTURALLY GONE. A paren
  // inside a string literal used to walk the scanner's depth off, so the
  // helper returned an earlier, complete call and every rule over it was
  // about the wrong code — silently, since that slice parses fine. To the
  // parser `'oops)'` is a string, the call ends where the grammar says,
  // and the anchor is simply not inside any such call. Kept, retargeted
  // at what now happens, because the fixture is the one that used to lie.
  it('does not mistake a paren inside a string for the call it is looking for', () => {
    const broken = "console.log('oops)');\nconst s = `  card=1`;\n";
    expect(() => callContaining(broken, '`  card=')).toThrow(/not inside a console\.log\( call/);
    // And the call that IS there still comes back whole, parens and all.
    expect(callContaining(broken, "'oops)'")).toBe("console.log('oops)')");
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

  // ROUND 3 P2, and the reason this module now parses. A regex literal
  // is not punctuation: `/;/` ended the statement early and handed back a
  // truncated region that a `toContain` could still satisfy, and a regex
  // holding an unmatched bracket made the scanner report no end at all.
  // Division has to keep working alongside it, which is the part a
  // character walk cannot get right — the same `/` means both.
  it('is not fooled by a regex literal, and still reads division', () => {
    expect(statementFrom('const pattern = /;/; const next = 1;', 'const pattern =')).toBe(
      'const pattern = /;/;',
    );
    expect(statementFrom(String.raw`const p = /\)/; const n = 1;`, 'const p =')).toBe(
      String.raw`const p = /\)/;`,
    );
    expect(statementFrom('const p = /[}{]/; const n = 1;', 'const p =')).toBe('const p = /[}{]/;');
    expect(statementFrom('const q = a / b / c; const n = 1;', 'const q =')).toBe(
      'const q = a / b / c;',
    );
  });

  // A statement ends where the grammar ends it, which is not always at a
  // semicolon. The hand-written version looked for one and threw when
  // there was none.
  it('ends an ASI-terminated statement without a semicolon', () => {
    expect(statementFrom('const z = 1\nconst n = 2', 'const z =')).toBe('const z = 1');
  });

  // Same refusal as every other helper here: a missing anchor, or a
  // statement with no end, throws rather than handing back a region that
  // would pass by measuring nothing.
  it('throws rather than guessing when the anchor or the end is missing', () => {
    expect(() => statementFrom('const a = 1;', 'const gone =')).toThrow(/renamed or removed/);
    expect(() => statementFrom('const a = f(1);', 'f(')).toThrow(/does not begin a statement/);
  });
});

// THE GUARD THIS WHOLE MODULE EXISTS FOR (#2144).
//
// Three rounds, three versions, one shape of finding each time: the
// completeness of the fixed-window conversion was claimed from something
// that read the file as TEXT, and each reader was narrower than the
// thing it hunted. A regex requiring an `indexOf` in the bound missed
// eight windows. A regex using `[^)]*` missed three more, because it
// stops at a nested call's own close paren. A hand-rolled scanner then
// missed bounds hidden behind a comment, behind `'320'`, and behind a
// named constant — and skipped, silently, any call whose arguments it
// could not balance.
//
// So nothing here reads text. `sliceCallsIn` returns the calls from the
// PARSE TREE and the bounds as expression NODES, and the classifier
// below judges the expression rather than its spelling. Comments, line
// breaks, regex literals and template holes stop being evasions because
// they are not part of an argument's value.
//
// It FAILS CLOSED, which is the other half of round 3's finding. There
// is no attempt to work out which variables hold source text: tracking
// that through wrappers (`branch()`), aliases and `f.toString()` is
// unbounded, and every gap in it is a place a window can hide. EVERY
// slice in these suites is inspected, and the few that are legitimately
// counting characters — truncating a message, dropping `0x`, dropping
// array rows — say so at their declaration with a `not-a-source-region`
// marker naming what they count. Nine such sites became three markers,
// because saying it once per reason is also how you notice a fourth.
describe('#2144 — no source region is bounded by a character count', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.test.mjs'))
    .sort();

  const MARKER = 'not-a-source-region';

  // A bound is a CHARACTER COUNT if a number can be reached anywhere
  // inside it — written as one, coerced from a string, or bound to a
  // name in scope. Anything else is an anchor: an `indexOf`, a variable
  // holding one, a call.
  const countsCharacters = (src, arg) => {
    let found = false;
    const visit = (n) => {
      if (found || n === null || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        n.forEach(visit);
        return;
      }
      if (typeof n.type !== 'string') return;
      if (numericValueOf(n) !== null) found = true;
      if (n.type === 'Identifier' && numericBindingAt(src, n.name, n.start) !== null) found = true;
      for (const k of Object.keys(n)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'range') continue;
        visit(n[k]);
      }
    };
    visit(arg);
    return found;
  };

  // The marker sits on the call's line or the lines just above it, so it
  // reads as a note on the declaration rather than as configuration
  // somewhere else. Out-of-band allowlists drift away from the code they
  // excuse; this one cannot.
  const excused = (src, line) => {
    const lines = src.split('\n');
    // The guard's own rule, applied to the guard — and the reason the
    // marker names WHAT it counts rather than merely asserting innocence.
    // not-a-source-region: counts LINES of an already-split array
    return lines.slice(Math.max(0, line - 4), line).some((l) => l.includes(MARKER));
  };

  it('finds the suites to check', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('headSampling.test.mjs');
  });

  it.each(files)('%s bounds every source region by meaning', (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const counted = sliceCallsIn(src)
      .filter((c) => c.args.some((a) => countsCharacters(src, a)))
      .filter((c) => !excused(src, c.line))
      .map((c) => `${file}:${c.line} — ${c.text.replace(/\s+/g, ' ')}`);
    expect(
      counted,
      'a source region bounded by a number: use blockFrom / between / statementFrom / callContaining, ' +
        `or mark a genuine character count with a ${MARKER} comment naming what it counts`,
    ).toEqual([]);
  });

  // The guard's own premises. Each was an evasion Codex demonstrated on
  // the version before this one, and a guard that cannot fail on them is
  // the thing it replaced.
  it('sees a count a text search would miss', () => {
    const cases = [
      ["const s = f();\nconst r = s.slice(start, start + 320);", 'plain arithmetic'],
      ["const s = f();\nconst r = s.slice(start, // don't truncate\n  start + 320);", 'a comment'],
      ["const s = f();\nconst r = s.slice(start, '320');", 'a coerced string'],
      ['const W = 320;\nconst s = f();\nconst r = s.slice(start, start + W);', 'a named constant'],
      ["const s = f();\nconst r = s.slice(start, start - -320);", 'a unary minus'],
    ];
    for (const [code, why] of cases) {
      const calls = sliceCallsIn(code);
      expect(calls, why).toHaveLength(1);
      expect(calls[0].args.some((a) => countsCharacters(code, a)), why).toBe(true);
    }
  });

  it('leaves an anchored bound alone, including one named by a variable', () => {
    const code = [
      'const s = f();',
      "const at = s.indexOf('const x =');",
      "const to = s.indexOf('const y =');",
      'const r = s.slice(at, to);',
    ].join('\n');
    const [call] = sliceCallsIn(code);
    expect(call.args.some((a) => countsCharacters(code, a))).toBe(false);
  });

  // The false positive that scope-awareness exists to prevent: the same
  // name bound to a count in one place and to an anchor in another.
  it('resolves a name to the binding in scope, not to any binding in the file', () => {
    const code = [
      'function counter() {',
      '  let i = 0;',
      '  return i;',
      '}',
      'function region(s) {',
      "  const i = s.indexOf('const x =');",
      "  return s.slice(i, s.indexOf('\\n', i));",
      '}',
    ].join('\n');
    const [call] = sliceCallsIn(code);
    expect(call.args.some((a) => countsCharacters(code, a))).toBe(false);
  });

  it('excuses only what is marked, and only near the marker', () => {
    const marked = `// ${MARKER}: drops the 0x prefix\nconst a = x.slice(2);\nconst b = y.slice(2);`;
    const calls = sliceCallsIn(marked);
    expect(excused(marked, calls[0].line)).toBe(true);
    expect(excused(marked, calls[1].line)).toBe(true);
    const far = `// ${MARKER}: reason\n\n\n\n\nconst c = z.slice(2);`;
    expect(excused(far, sliceCallsIn(far)[0].line)).toBe(false);
  });
});
