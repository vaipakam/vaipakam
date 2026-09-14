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
  bindingOf,
  isAnchored,
  isBoundedRegion,
  isStartOfText,
  markableStatementsOf,
  UNKNOWN_BOUNDS,
  markedStatement,
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

  // ROUND 15 — literal TEXT only. Skipping a whole template also skipped
  // its `${…}` holes, which are executable code, so a real header inside
  // one was reported missing; and a regex body is literal text too, so
  // `/if (target) {/` was being matched.
  it('skips a header in a regex but finds one in a template hole', () => {
    const inHole = "const t = `${flag ? (() => { if (target) { work(); } })() : ''}`;";
    expect(blockFrom(inHole, 'if (target) {')).toContain('work();');
    const inRegex = [
      'const re = /if (target) {/;',
      'const unrelated = {};',
      'if (target) {',
      '  work();',
      '}',
    ].join('\n');
    const body = blockFrom(inRegex, 'if (target) {');
    expect(body).toContain('work();');
    expect(body).not.toContain('unrelated');
  });

  // ROUND 14 — and a header quoted in a STRING is the same hazard by a
  // different door. `blockFrom` and `statementFrom` anchor on CODE, so a
  // string holding the header is not one. `callContaining` and `between`
  // deliberately still match inside strings: the first anchors on a
  // string INSIDE the call it wants, and one of the second's landmarks is
  // a message the drive prints.
  it('does not take its header from a string', () => {
    const src = [
      'const note = "if (target) {";',
      'const unrelated = {};',
      'if (target) {',
      '  work();',
      '}',
    ].join('\n');
    const body = blockFrom(src, 'if (target) {');
    expect(body).toContain('work();');
    expect(body).not.toContain('unrelated');
  });

  // ROUND 8 — these suites quote code in prose constantly, and a header
  // matched inside a COMMENT sent the search through to the first
  // unrelated braced node after it. The parser made that worse rather
  // than better: the old brace counter would usually run off the end and
  // throw, where this returns a plausible, complete, wrong block.
  // `between` had skipped comments since round 5; this had not.
  it('does not take its header from a comment', () => {
    const src = [
      '// the rule is about if (target) { below',
      'function other() { a(); }',
      'if (target) {',
      '  real();',
      '}',
    ].join('\n');
    const body = blockFrom(src, 'if (target) {');
    expect(body).toContain('real();');
    expect(body).not.toContain('a();');
    expect(statementFrom(src, 'function other()')).toContain('a();');
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
    expect(between('var a = 1; var a = 2;', 'var a', 'var a')).toBe('var a = 1; ');
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
const countsCharacters = (src, call) => {
  // Bounds this cannot read are not absent bounds (round 25). Zero
  // arguments on a bounded receiver is a legitimate slice-to-end;
  // an unreadable argument list is a window nobody can see.
  if (call.args === UNKNOWN_BOUNDS) return true;
  // A MISSING end is not an anchored end (round 7): the region runs to
  // the end of the text, so a rule over it can be satisfied by matching
  // anything later. True of `substr` too, whose one-argument form takes
  // the rest of the string (round 8) — the earlier exemption for it was
  // about its SECOND argument and had no business covering this.
  // …unless the receiver is ALREADY a bounded region, in which case the
  // end is that region's end, bounded by meaning when it was taken.
  if (call.args.length < 2 && !isBoundedRegion(src, call.receiverNode)) return true;
  return call.args.some((a, i) => {
    // `substr`'s second argument is a LENGTH by definition, however it
    // is produced — and a method name this cannot READ may be
    // `substr` (round 24): `const m = 'substr'; s[m](start, at('end'))`
    // was recorded as UNREADABLE and then had both arguments accepted
    // as positions. Unreadable means it might be, which is the same
    // reason the collector inspects such calls instead of skipping
    // them.
    if ((call.method === 'substr' || typeof call.method === 'symbol') && i === 1) return true;
    // A START may be the literal 0 — the stable beginning of the text,
    // a position and not a count (round 8). Marking it would claim a
    // character count that is not happening. Every END, and every other
    // bound, must be a landmark.
    if (i === 0 && isStartOfText(src, a)) return false;
    return !isAnchored(src, a);
  });
};

describe('#2144 — no source region is bounded by a character count', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // RECURSIVELY, because Vitest discovers `e2e/live/**/*.test.mjs`
  // (round 11). A non-recursive read checked only the top level, so a
  // suite in a nested directory would run with every fixed window in it
  // absent from this guard — and the file-count assertion below would
  // stay green while it happened.
  const files = fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
    .sort();

  const MARKER = 'not-a-source-region';

  // A bound is a CHARACTER COUNT unless it is recognisably an ANCHOR.
  // That way round is round 6's correction and the reason this stopped
  // needing a new fix every round: "every way to write a number" is an
  // open set and the classifier kept being caught not knowing one of
  // them, where "what an anchor looks like" is closed, small, and
  // matches what this suite actually writes.
  //
  // `substr`'s SECOND argument is a LENGTH by definition, however it is
  // produced — `s.substr(start, s.indexOf('end'))` truncates by however
  // many characters that landmark happens to sit at, which is a fixed
  // window wearing an anchor's clothes.


  // The marker excuses a STATEMENT the call sits inside, and only that.
  // Proximity alone excused a neighbour (round 4). Two further corrections
  // in round 5: it must BE a comment, since the raw line text let a string
  // holding the token excuse itself; and ANY enclosing statement counts,
  // since a block-bodied helper put the call inside a `return` while the
  // marker sat on the declaration.
  const excused = (src, call) =>
      markableStatementsOf(src, call.node).some((stmt) => markedStatement(src, stmt, MARKER));

  it('finds the suites to check', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('headSampling.test.mjs');
  });

  it.each(files)('%s bounds every source region by meaning', (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const counted = sliceCallsIn(src)
      .filter((c) => countsCharacters(src, c))
      .filter((c) => !excused(src, c))
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
  // EVERY DISGUISE REVIEW HAS DEMONSTRATED, in one place.
  //
  // Rounds 3 to 6 each produced a new way to write a fixed length that
  // the then-current classifier did not know about. They are listed
  // together because the list is the argument for the rule being the way
  // round it now is: none of these needed a rule of its own. A bound is
  // a count unless it is recognisably a landmark, so a form nobody has
  // thought of yet lands on the reported side by default.
  it('reports a fixed length however it is written', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    const cases = [
      ['plain arithmetic', 'const r = s.slice(start, start + 320);'],
      ['a comment in the way', "const r = s.slice(start, // don't truncate\n  start + 320);"],
      ['a coerced string', "const r = s.slice(start, '320');"],
      ['a no-substitution template', 'const r = s.slice(start, `320`);'],
      ['a named constant', 'const W = 320;\nconst r = s.slice(start, start + W);'],
      ['an alias of one', 'const B = 320;\nconst W = B;\nconst r = s.slice(start, start + W);'],
      ['arithmetic in the initializer', 'const W = 160 * 2;\nconst r = s.slice(start, start + W);'],
      ['a member of a literal', 'const W = { n: 320 }.n;\nconst r = s.slice(start, start + W);'],
      ['a unary minus', 'const r = s.slice(start, start - -320);'],
      ['an immediately-invoked function', 'const r = s.slice(start, (() => 320)());'],
      ['an assignment after declaration', 'let e;\ne = start + 320;\nconst r = s.slice(start, e);'],
      ['substring', 'const r = s.substring(start, start + 320);'],
      ['substr', 'const r = s.substr(start, 320);'],
    ];
    for (const [why, tail] of cases) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // ROUND 7 — the findings moved from "another way to write a number" to
  // "your landmark list admits things that are not landmarks", which is a
  // closed set and the reason the inversion was worth making. Each of
  // these WAS accepted as anchored by the first version of that list.
  it('refuses a bound that is not really a place in the text', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    const cases = [
      ['a reassigned name', "let e = s.indexOf('next');\ne = start + 320;\nconst r = s.slice(start, e);"],
      [
        'a helper that returns on only one path',
        "const e = () => { if (x) return s.indexOf('next'); };\nconst r = s.slice(start, e());",
      ],
      [
        'a finder that searches nothing',
        'const r = s.slice(start, ({ indexOf: () => start + 320 }).indexOf());',
      ],
      ['a length of something invented', 'const r = s.slice(start, ({ length: start + 320 }).length);'],
      [
        'a WIDTH between two places used as an end',
        "const r = s.slice(start, s.indexOf('end') - s.indexOf('begin'));",
      ],
      ['a bare measured length', "const r = s.slice(start, 'x'.length);"],
      ['two places added together', "const r = s.slice(start, start + s.indexOf('end'));"],
      [
        'a collection used as the bound itself',
        "const ends = [s.indexOf('a'), s.indexOf('b')];\nconst r = s.slice(start, ends);",
      ],
      ['a truncator named by a template', 'const r = s[`slice`](start, start + 320);'],
      ['no end at all', 'const r = s.slice(start);'],
    ];
    for (const [why, tail] of cases) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // ROUND 9 — three findings, all on the collection rule and on `var`.
  it('refuses the round-9 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      ['a key that is not an index', "const ends = [s.indexOf('e')];\nconst r = s.slice(start, ends[-1]);"],
      ['a fractional key', "const ends = [s.indexOf('e')];\nconst r = s.slice(start, ends[1.5]);"],
      ['a key that is not a number', "const ends = [s.indexOf('e')];\nconst r = s.slice(start, ends[true]);"],
      [
        'an element overwritten after the collection was built',
        "const ends = [s.indexOf('e')];\nends[0] = start + 320;\nconst r = s.slice(start, ends[0]);",
      ],
      [
        'a collection grown after it was built',
        "const ends = [s.indexOf('e')];\nends.push(start + 320);\nconst r = s.slice(start, ends[0]);",
      ],
      [
        'a var re-initialised in a branch',
        "function g(t, at, on) { var e = t.indexOf('e'); if (on) { var e = at + 320; } return t.slice(at, e); }",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // THE COLLECTION RULE IS GONE (round 11), and this case records the
  // retreat rather than the capability. Selecting a landmark out of a
  // list was added in round 6 to avoid over-flagging `anchors[0]` — a
  // shape that appears NOWHERE in this suite. Keeping it honest cost
  // rounds 9, 10 and 11, and the holes still open needed escape analysis
  // and a call graph, which this module has four times refused to build.
  // A capability with no user and an unbounded correctness bill is not
  // worth the surface. Unrecognised is refused, as everywhere else.
  it('reports a bound selected out of a collection, and says why', () => {
    const code = [
      'const s = f();',
      "const start = s.indexOf('a');",
      "const ends = [s.indexOf('e')];",
      'const r = s.slice(start, ends[0]);',
    ].join('\n');
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // ROUND 10 — six findings, two of them the guard objecting to correct
  // work. I nearly merged on a false convergence verdict here: my check
  // for findings read only the first page of a paginated list, so a
  // clean-looking round was not one.
  it('refuses the round-10 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'an index past the end of the collection',
        "const ends = [s.indexOf('e')];\nconst r = s.slice(start, ends[1]);",
      ],
      [
        'a non-canonical index spelling',
        "const ends = [s.indexOf('e')];\nconst r = s.slice(start, ends['01']);",
      ],
      [
        'an element stepped by ++',
        "const ends = [s.indexOf('e')];\nends[0]++;\nconst r = s.slice(start, ends[0]);",
      ],
      [
        'a mutation that happens BEFORE the use',
        "const ends = [s.indexOf('e')];\nends.push(start + 320);\nconst r = s.slice(start, ends[0]);",
      ],
      [
        'a finder on a receiver that is an object literal',
        'const fake = { indexOf: () => start + 320 };\nconst r = s.slice(start, fake.indexOf());',
      ],
      [
        'a var whose initializer is inside a branch',
        "function g(t, on) { const a = t.indexOf('a'); if (on) { var e = t.indexOf('e'); } return t.slice(a, e); }",
      ],
      [
        'a var initialised after the use',
        "function g(t) { const a = t.indexOf('a'); const r = t.slice(a, e); var e = t.indexOf('e'); return r; }",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // A name bound inside a PATTERN still shadows. Without that, a
  // destructured parameter inherited an outer landmark the caller may
  // never supply.
  it('lets a destructured binding shadow an outer landmark', () => {
    const code = "const s = f();\nconst end = s.indexOf('e');\nfunction region(t, start, { end }) { return t.slice(start, end); }";
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // ROUND 10's two FALSE POSITIVES.
  it('does not object to correct code, round 10', () => {
    for (const [why, code] of [
      [
        'a var declared directly in the body, before the use',
        "function g(t) { const a = t.indexOf('a'); var e = t.indexOf('e'); return t.slice(a, e); }",
      ],
    ]) {
      const call = sliceCallsIn(code).at(-1);
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // ROUND 11 — what survived the collection removal.
  it('refuses the round-11 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a receiver reassigned after its declaration',
        'let recv = s;\nrecv = { indexOf: () => start + 320 };\nconst r = s.slice(start, recv.indexOf());',
      ],
      [
        'a var PATTERN shadowing an outer landmark',
        "function g(t, obj) { var { end } = obj; return t.slice(t.indexOf('a'), end); }",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // ROUND 11's false positive: a search spelled through a subscript is
  // the same call, and refusing it asked for a marker claiming a count
  // that was not happening. `sliceCallsIn` already read truncator names
  // this way; finder names had been left on the dotted form only.
  it('reads a finder spelled as a subscript', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const tail of [
      "const r = s.slice(start, s['indexOf']('e'));",
      'const r = s.slice(start, s[`indexOf`]("e"));',
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), tail).toBe(false);
    }
  });

  // ROUND 12.
  it('refuses the round-12 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a finder on a DOTTED fake receiver',
        "const fake = { nested: { indexOf: () => start + 320 } };\nconst r = s.slice(start, fake.nested['indexOf']());",
      ],
      [
        'a class declaration shadowing an outer landmark',
        "const end = s.indexOf('e');\n{ class end {}; var r = s.slice(start, end); }",
      ],
      [
        'a destructuring var redeclaration',
        "function g(t, on, obj) { const a = t.indexOf('a'); var e = t.indexOf('e'); if (on) { var { e } = obj; } return t.slice(a, e); }",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // ROUND 13.
  it('refuses the round-13 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a receiver initialised as a function',
        'const fake = () => {};\nfake.indexOf = () => start + 320;\nconst r = s.slice(start, fake.indexOf());',
      ],
      [
        "a named function expression's own name",
        "const end = s.indexOf('e');\nconst f2 = function end() { return s.slice(start, end); };",
      ],
      [
        'a write BEFORE the use',
        "let e = s.indexOf('e');\ne = start + 320;\nconst r = s.slice(start, e);",
      ],
      [
        'a write inside a helper, wherever it sits',
        "let e = s.indexOf('e');\nconst r = s.slice(start, e);\nfunction later() { e = start + 320; }",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // ROUND 13's false positive, which my own round-11 simplification
  // introduced: dropping position-awareness entirely made a write below
  // the slice reject it. Straight-line code IS ordered; only a function
  // or a loop body cannot be, and those still count wherever they sit.
  it('accepts a bound written to only AFTER the region was taken', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\nlet e = s.indexOf('e');\nconst r = s.slice(start, e);\ne = start + 320;";
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(false);
  });

  // ROUND 14.
  it('refuses the round-14 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a DEFERRED use with a write below it',
        "let e = s.indexOf('e');\nfunction region() { return s.slice(start, e); }\ne = start + 320;\nregion();",
      ],
      [
        'a receiver DECLARED as a class',
        'class Fake {}\nFake.indexOf = () => start + 320;\nconst r = s.slice(start, Fake.indexOf());',
      ],
      [
        'a receiver DECLARED as a function',
        'function Fake2() {}\nFake2.indexOf = () => start + 320;\nconst r = s.slice(start, Fake2.indexOf());',
      ],
      [
        "a named class expression's own name",
        "const end = s.indexOf('e');\nconst C = class end { f() { return s.slice(start, end); } };",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // ROUND 15 — the round that replaced hand-written scope analysis with
  // the library that implements the specification. These are the shapes
  // that exposed the hand-written one.
  it('refuses the round-15 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a receiver from an EXPORTED class declaration',
        'export class Fake {}\nFake.indexOf = () => start + 320;\nconst r = s.slice(start, Fake.indexOf());',
      ],
      [
        'a class FIELD initializer, which runs at construction',
        "let e = s.indexOf('e');\nclass C { field = s.slice(start, e); }\ne = start + 320;",
      ],
      [
        'a truncator borrowed through bind',
        'const r = String.prototype.slice.bind(s)(start, start + 320);',
      ],
      [
        'a structural helper imported from somewhere else',
        "import { raw as blockFrom } from './fixture.mjs';\nconst b = blockFrom(s);\nconst r = b.slice(start);",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // ROUND 15's false positive: one binding declared twice, the second
  // time with the landmark. Taking the FIRST definition left a real
  // anchor looking unknown.
  it('takes the initializer that reaches the use, not the first one', () => {
    const code =
      "function g(s) { const a = s.indexOf('a'); var e; var e = s.indexOf('e'); return s.slice(a, e); }";
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(false);
  });

  // The other side of the same rules, so they cannot be satisfied by
  // refusing everything.
  it('still accepts the landmark shapes this suite writes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      ['just past a landmark', "const r = s.slice(start, s.indexOf('x') + 'x'.length);"],
      ['a helper with an expression body', "const at = (n) => s.indexOf(n);\nconst r = s.slice(start, at('x'));"],
      [
        'no end, on an already-bounded region',
        "import { blockFrom } from './sourceBlock.mjs';\nconst b = blockFrom(s, 'if (x) {');\nconst r = b.slice(b.indexOf('y'));",
      ],
      // The static twin of the round-15 field case: a STATIC initializer
      // runs where it is written, so ordinary position applies and the
      // later write cannot reach it. Refusing it would be the check
      // objecting to correct work.
      [
        'a STATIC class field, which runs in place',
        "let e = s.indexOf('e');\nclass C { static field = s.slice(start, e); }\ne = start + 320;",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // ROUND 16 — the round where the findings turned round. Four of five
  // were the check REFUSING CORRECT WORK, and three of those four were
  // one mistake: a rule stated over a NODE where only part of that node
  // is guarded. The slot tables are the fix; these are the shapes.
  it('does not refuse the round-16 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        "a do body, which is guaranteed a first pass however the loop's test reads",
        "do { var end = s.indexOf('e'); } while (false);\nconst r = s.slice(start, end);",
      ],
      [
        'a computed field KEY, evaluated where the class is defined',
        "let e = s.indexOf('e');\nclass C { [s.slice(start, e)] = 1; }\ne = start + 320;",
      ],
      [
        "apply's bounds, which live in the array it is handed",
        "const r = String.prototype.slice.apply(s, [start, s.indexOf('x')]);",
      ],
      [
        'a finder on imported source text, which a module can export',
        "import source from './fixture.mjs';\nconst r = source.slice(source.indexOf('a'), source.indexOf('b'));",
      ],
      [
        "a for INIT, which always runs even when the body does not",
        "for (var end = s.indexOf('e'); on; ) { work(); }\nconst r = s.slice(start, end);",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // And the refusing side of the same round, so loosening the four above
  // cannot have loosened anything else. A near-miss module NAME is the
  // cheapest way past a trust check, and `endsWith` fell for it.
  it('refuses the round-16 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a structural helper from a look-alike module',
        "import { blockFrom } from './fake-sourceBlock.mjs';\nconst b = blockFrom(s, 'if (x) {');\nconst r = b.slice(start);",
      ],
      [
        "apply's bounds spread from somewhere unreadable",
        'const r = String.prototype.slice.apply(s, [...bounds]);',
      ],
      [
        'a WHILE body, which may not run at all',
        "while (on) { var end = s.indexOf('e'); }\nconst r = s.slice(start, end);",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });
  // The field VALUE stays refused — that case is already pinned in the
  // round-15 block above, and the computed-KEY case accepted here is
  // precisely its other half: same node, different slot, opposite answer.

  // ROUND 17 — five more, four of them again the ACCEPTING direction.
  it('refuses the round-17 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a borrowed truncator whose borrower is spelled as a computed name',
        "const r = String.prototype.slice['call'](s, start, start + 320);",
      ],
      [
        'a borrowed truncator whose METHOD is spelled as a computed name',
        "const r = String.prototype['slice'].call(s, start, start + 320);",
      ],
      [
        'a later computed KEY, which runs before an earlier static value',
        "let e = s.indexOf('e');\nclass C { static a = s.slice(start, e); static [(e = start + 320, 'k')] = 1; }",
      ],
      [
        'an initializer in the branch the use is NOT in',
        "let r;\nif (on) { var end = s.indexOf('e'); } else { r = s.slice(start, end); }",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  it('does not refuse the round-17 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'an argument past the two a truncator consumes',
        "const r = s.slice(start, s.indexOf('x'), 320);",
      ],
      [
        'an initializer in the SAME branch as the use',
        "let r;\nif (on) { var end = s.indexOf('e'); r = s.slice(start, end); }",
      ],
      [
        'an initializer earlier in the same case body as the use',
        "let r;\nswitch (k) { case 1: var end = s.indexOf('e'); r = s.slice(start, end); }",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // Round 17's marker finding: one reason cannot excuse two bounds. A
  // marked helper with a legitimate count was handing that excuse to
  // every other call in it — the round-7 multi-declarator fault, a
  // scope wider.
  it('a function marker excuses one truncator, not every truncator in it', () => {
    const one =
      '// not-a-source-region: a label, capped for display.\n' +
      'function label(t) {\n  return t.slice(0, 40);\n}\n';
    const two =
      '// not-a-source-region: a label, capped for display.\n' +
      'function label(t, src, start) {\n' +
      '  const region = src.slice(start, start + 320);\n' +
      '  return t.slice(0, 40) + region;\n' +
      '}\n';
    const marks = (src, call) =>
      markableStatementsOf(src, call.node).some((stmt) =>
        markedStatement(src, stmt, 'not-a-source-region'),
      );
    expect(sliceCallsIn(one).every((c) => marks(one, c))).toBe(true);
    expect(sliceCallsIn(two).some((c) => marks(two, c))).toBe(false);
  });

  // ROUND 18. One accepted, one REFUTED, two deferred — see the PR
  // thread and the follow-up issue.
  //
  // The refuted one is worth a case anyway, because the behaviour it
  // asked for is already the behaviour and should stay so. An optional
  // finder call IS refused — `maybe?.indexOf('end')` parses as a
  // `ChainExpression`, which `kindOf` does not recognise, so round 6's
  // inversion refuses it before `callKind` is reached. No special check
  // for it exists, and one was written and removed as dead code. This
  // pins the inversion doing the work.
  it('refuses an optional finder call, whose receiver may be absent', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\nconst r = s.slice(start, maybe?.indexOf('end'));";
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // The arrow-function twin of round 17's marker rule. This is the form
  // THIS suite's one marked helper actually uses, so the sibling left
  // unfixed was the live one.
  it('a marker on a function-valued name excuses one truncator, not every one', () => {
    const one =
      '// not-a-source-region: a label, capped for display.\n' +
      'const label = (t) => t.slice(0, 40);\n';
    const two =
      '// not-a-source-region: a label, capped for display.\n' +
      'const label = (t, src, start) => {\n' +
      '  const region = src.slice(start, start + 320);\n' +
      '  return t.slice(0, 40) + region;\n' +
      '};\n';
    const marks = (src, call) =>
      markableStatementsOf(src, call.node).some((stmt) =>
        markedStatement(src, stmt, 'not-a-source-region'),
      );
    expect(sliceCallsIn(one).every((c) => marks(one, c))).toBe(true);
    expect(sliceCallsIn(two).some((c) => marks(two, c))).toBe(false);
  });

  // ROUND 19 — six, and THREE were holes in the two rounds before it.
  it('refuses the round-19 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a borrowed truncator whose method name cannot be read',
        "const r = String.prototype['sl' + 'ice'].call(s, start, start + 320);",
      ],
      [
        'a truncator borrowed through Reflect.apply',
        'const r = Reflect.apply(String.prototype.slice, s, [start, start + 320]);',
      ],
      [
        "Reflect.apply's bounds spread from somewhere unreadable",
        'const r = Reflect.apply(String.prototype.slice, s, [...bounds]);',
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  it('does not refuse the round-19 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'an uncertain initializer overwritten by a certain one before the use',
        "if (on) { var end = start + 320; }\nvar end = s.indexOf('e');\nconst r = s.slice(start, end);",
      ],
      [
        'a choice between two already-bounded regions',
        "import { blockFrom, between } from './sourceBlock.mjs';\n" +
          "const block = useA ? blockFrom(s, 'if (x) {') : between(s, 'a', 'b');\n" +
          "const r = block.slice(block.indexOf('y'));",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // The marker rule's THIRD shape: round 7 fixed the multi-declarator
  // statement, round 17 the function declaration, round 18 the
  // function-valued name — and a non-function initializer holding two
  // truncators was still excused by one reason.
  it('a marker excuses one truncator whatever the initializer is', () => {
    const two =
      '// not-a-source-region: a label, capped for display.\n' +
      'const label = choose(text.slice(0, 40), src.slice(start, start + 320));\n';
    const marks = (src, call) =>
      markableStatementsOf(src, call.node).some((stmt) =>
        markedStatement(src, stmt, 'not-a-source-region'),
      );
    expect(sliceCallsIn(two).some((c) => marks(two, c))).toBe(false);
  });

  // `blockFrom` must return the block the NAMED header opens, not the
  // next one in the file. A header whose construct has no block is an
  // error, not an invitation to take a neighbour's.
  it('refuses a header that opens no block of its own', () => {
    expect(() =>
      blockFrom('const anchor = 1;\nif (ready) { work(); }\n', 'const anchor = 1;'),
    ).toThrow(/opens no block/);
    expect(blockFrom('if (ready) { work(); }\n', 'if (ready) {')).toContain('work()');
  });

  // ROUND 20 — both findings were holes in round 19's own fixes.
  it('refuses the round-20 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a measurement whose text cannot be read',
        'const r = s.slice(start, start + `${\'x\'.repeat(320)}`.length);',
      ],
      [
        'a measurement of text the search did not find',
        "const r = s.slice(start, s.indexOf('x') + 'yyyy'.length);",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // An anchor naming only PART of a statement must not reach past that
  // statement for a block — round 19 keyed the owner on "first statement
  // at or after the anchor", which skipped the statement the anchor sits
  // INSIDE and took the next one's block.
  it('refuses a partial anchor that reaches into a later block', () => {
    const src = 'const anchor = 1;\nif (ready) { work(); }\n';
    expect(() => blockFrom(src, 'anchor = 1')).toThrow(/opens no block/);
    expect(blockFrom('function f() { a(); }\n', 'function f()')).toContain('a()');
  });

  // ROUND 21 — three, all holes in round 20's own fixes.
  it('refuses the round-21 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a second measurement bolted onto a stepped position',
        "const r = s.slice(start, s.indexOf('x') + 'x'.length + 'yyyy'.length);",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  it('does not refuse the round-21 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      // The one composite bound these suites actually write measures a
      // NAME, not a literal: `block.indexOf(haveControl) +
      // haveControl.length` in confirmTrial.
      [
        'a position stepped by its own landmark, named rather than written out',
        "const needle = 'x';\nconst r = s.slice(start, s.indexOf(needle) + needle.length);",
      ],
      [
        'the same alias down both arms of a choice',
        "const end = s.indexOf('e');\nconst alias = end;\nconst r = s.slice(start, on ? alias : alias);",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // An anchor may CONTAIN quoted text — `page.on('request', …` is a real
  // anchor in these suites — but must not straddle the edge of it.
  it('refuses an anchor that straddles the edge of quoted text', () => {
    const src = "const a = 1;\n 'if (target) {';\nif (ready) { work(); }\n";
    expect(() => blockFrom(src, " 'if (target) {")).toThrow(/renamed or removed/);
    expect(blockFrom("page.on('request', (req) => { go(); });\n", "page.on('request', (req) => {")).toContain(
      'go()',
    );
  });

  // ROUND 22 — two, both on round 21's fixes.
  it('refuses a shared needle that is not text', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\nconst needle = 320;\n" +
      'const r = s.slice(start, s.indexOf(needle) + needle.length);';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // The contains case, at the literal's very first character. An anchor
  // may BEGIN with a complete literal and carry on into code.
  it('accepts an anchor beginning at a literal it contains whole', () => {
    expect(blockFrom("'x' && (() => { work(); })();\n", "'x' && (() => {")).toContain('work()');
  });

  // ROUND 23 — three, all on round 21/22's fixes.
  it('refuses an anchor that is only a comment', () => {
    expect(() =>
      blockFrom('// if (target) {\nif (ready) { work(); }\n', '// if (target) {'),
    ).toThrow(/renamed or removed/);
  });

  it('refuses a non-text needle hidden behind an alias', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\nconst raw = 320;\nconst needle = raw;\n" +
      'const r = s.slice(start, s.indexOf(needle) + needle.length);';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // Deferring a function says nothing about the order of statements
  // WITHIN one call of it.
  it('keeps order for a write local to the same function as the use', () => {
    const code =
      'function region(s) {\n' +
      "  const start = s.indexOf('a');\n  let end = s.indexOf('e');\n" +
      '  const r = s.slice(start, end);\n  end = start + 320;\n  return r;\n}';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(false);
  });

  // …but a LOOP body gives no order even when it is shared.
  it('still refuses a write sharing a loop body with the use', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\nlet end = s.indexOf('e');\n" +
      'for (const x of xs) {\n  const r = s.slice(start, end);\n  end = start + 320;\n}';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // ROUND 24 — six, most of them on rounds 22-23's fixes.
  it('refuses the round-24 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a needle reassigned to a number before the use',
        "let needle = 'x';\nneedle = 320;\nconst r = s.slice(start, s.indexOf(needle) + needle.length);",
      ],
      [
        'a binding that outlives the function it is written in',
        "let end = s.indexOf('e');\nfunction region() { const r = s.slice(start, end); end = start + 320; return r; }\nregion();",
      ],
      [
        'an unreadable method that may be substr, whose second bound is a length',
        "const m = 'substr';\nconst r = s[m](start, s.indexOf('end'));",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  it('accepts a computed spelling of the needle length', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\nconst needle = 'x';\n" +
      "const r = s.slice(start, s.indexOf(needle) + needle['length']);";
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(false);
  });

  it('refuses an anchor that is whitespace plus a comment', () => {
    expect(() =>
      blockFrom(' // if (target) {\nif (ready) { work(); }\n', ' // if (target) {'),
    ).toThrow(/renamed or removed/);
  });

  // ROUND 25 — four distinct, three of them the collector's argument
  // and receiver resolution.
  it('refuses the round-25 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        "bind's PRESET bounds, which are the ones consumed",
        "const r = String.prototype.slice.bind(s, start, start + 320)(s.indexOf('x'), s.indexOf('y'));",
      ],
      [
        'apply bounds handed over through a name, on a bounded receiver',
        "import { blockFrom } from './sourceBlock.mjs';\nconst block = blockFrom(s, 'if (x) {');\n" +
          'const args = [start, start + 320];\nconst r = String.prototype.slice.apply(block, args);',
      ],
      [
        'a truncator held in an alias',
        'const cut = String.prototype.slice;\nconst r = cut.call(s, start, start + 320);',
      ],
      [
        'a structural helper from a same-named module in another directory',
        "import { raw as blockFrom } from './fixtures/sourceBlock.mjs';\n" +
          "const b = blockFrom(s, 'if (x) {');\nconst r = b.slice(start);",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // ROUND 26 — five, three of them the collector dropping a borrowing
  // it could not read. That is answered at the root: unresolved means
  // UNREADABLE, which refuses.
  it('refuses the round-26 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a truncator behind two aliases',
        'const cut1 = String.prototype.slice;\nconst cut2 = cut1;\nconst r = cut2.call(s, start, start + 320);',
      ],
      [
        'a truncator alias that is reassigned',
        "let cut = String.prototype.slice;\ncut = String.prototype.substring;\nconst r = cut.call(s, start, start + 320);",
      ],
      [
        'a truncator alias handed to Reflect.apply',
        'const cut = String.prototype.slice;\nconst r = Reflect.apply(cut, s, [start, start + 320]);',
      ],
      [
        'an optional member invoked directly',
        'const r = (s?.slice)(start, start + 320);',
      ],
      [
        'a later computed key reaching a slice in a static block',
        "let e = s.indexOf('e');\nclass C { static { s.slice(start, e); } static [(e = start + 320, 'k')] = 1; }",
      ],
      [
        'a var initializer that may not have run when the function is called',
        "region();\nvar end = s.indexOf('e');\nfunction region() { return s.slice(start, end); }",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // The `const` twin of the last one: reaching the use before the
  // declaration would throw, so any run that gets there has run it.
  it('keeps a const landmark usable from a deferred function', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\nconst end = s.indexOf('e');\n" +
      'function region() { return s.slice(start, end); }';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(false);
  });

  // ROUND 27 — four distinct; two refusing, two accepting.
  it('refuses the round-27 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a truncator bound by destructuring, whose initializer is not its value',
        'const { slice: cut } = String.prototype;\nconst r = cut.call(s, start, start + 320);',
      ],
      [
        'a later computed METHOD key reaching a slice in a static block',
        "let e = s.indexOf('e');\nclass C { static { s.slice(start, e); } static [(e = start + 320, 'k')]() {} }",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  it('does not refuse the round-27 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a lexical landmark declared after the function that uses it',
        "function region() { return s.slice(start, end); }\nconst end = s.indexOf('e');\nregion();",
      ],
      [
        "a write whose own right-hand side takes the region",
        "let end = s.indexOf('e');\nend = s.slice(start, end).length;",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // ROUND 28 — five; three refusing, two accepting.
  it('refuses the round-28 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a finder on a locally CONSTRUCTED object',
        'const fake = new (class { indexOf() { return start + 320; } })();\nconst r = s.slice(start, fake.indexOf());',
      ],
      [
        'a PRIVATE method that merely shares the finder name',
        'class C { #indexOf() { return start + 320; } region(src) { return src.slice(start, src.#indexOf()); } }\n' +
          'const r = new C().region(s);',
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  it('does not refuse the round-28 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a NAMED start of text',
        "const begin = 0;\nconst r = s.slice(begin, s.indexOf('end'));",
      ],
      [
        "a destructuring default whose own value takes the region",
        "let end = s.indexOf('e');\n[end = s.slice(start, end).length] = [];",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // A header whose construct has no braced body opens nothing — the
  // first brace after it may belong to an argument.
  it('refuses a header whose construct has an unbraced body', () => {
    expect(() => blockFrom('if (ready) consume({ marker: true });\n', 'if (ready)')).toThrow(
      /opens no block/,
    );
  });

  // ROUND 29 — five, and ALL FIVE were the guard refusing correct work.
  it('does not refuse the round-29 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'an unrelated destructuring default outside the value being computed',
        "let end = s.indexOf('e');\n[end = 0] = [s.slice(start, end).length];",
      ],
      [
        'a local Reflect that is not the intrinsic',
        'const Reflect = { apply(fn, recv, args) { return fn(recv, args); } };\n' +
          "const r = s.slice(start, s.indexOf('end'));\nReflect.apply(custom, s, [start, start + 320]);",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  it('finds the call containing a needle that also appears earlier', () => {
    const src = "const note = 'target';\nconsole.log('target', value);\n";
    expect(callContaining(src, "'target'")).toContain('console.log');
  });

  it('lets a marker attach to an exported declaration', () => {
    const src =
      '// not-a-source-region: a label, capped for display.\n' +
      'export const label = text.slice(0, 40);\n';
    const call = sliceCallsIn(src).at(-1);
    expect(
      markableStatementsOf(src, call.node).some((stmt) =>
        markedStatement(src, stmt, 'not-a-source-region'),
      ),
    ).toBe(true);
  });

  // ROUND 8 — the list kept shrinking in kind: these are the remaining
  // ways a bound can look like a landmark without being one, plus the two
  // spellings of a truncation the collector was not seeing.
  it('refuses the round-8 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a destructuring write to the name',
        "let e = s.indexOf('x');\n[e] = [start + 320];\nconst r = s.slice(start, e);",
      ],
      [
        "a collection's length rather than an element",
        "const ends = [s.indexOf('e')];\nconst r = s.slice(start, ends['length']);",
      ],
      [
        'a conditional hoisted var',
        "function g(t, at, on) { if (on) { var E = t.indexOf('e'); } return t.slice(at, E); }",
      ],
      [
        'an overrideable parameter default',
        "function g(t, e = t.indexOf('e')) { return t.slice(t.indexOf('a'), e); }",
      ],
      ['a truncator borrowed through call', 'const r = String.prototype.slice.call(s, start, start + 320);'],
      ['one-argument substr on raw text', 'const r = s.substr(start);'],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // ROUND 8's two FALSE POSITIVES, which matter as much as the gaps: a
  // guard that objects to correct code gets switched off rather than
  // obeyed.
  it('does not object to correct code', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      ['the start of the text', "const r = s.slice(0, s.indexOf('end'));"],
      [
        'an unrelated nested scope reusing the name',
        "const e = s.indexOf('x');\nfunction h() { let e; e = 0; return e; }\nconst r = s.slice(start, e);",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // ROUND 8 — a structural helper must BE the imported one. A parameter
  // spelled the same may return the whole file.
  it('does not trust a shadowed structural helper', () => {
    const code =
      "function f(blockFrom, s, start) { const b = blockFrom(s); return b.slice(start); }";
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // Parameter shapes, which need their own fixtures because the count is
  // in a signature rather than a body.
  it('reports a fixed length supplied through a parameter', () => {
    for (const [why, code] of [
      [
        'a default parameter',
        "function region(s, start, W = 320) { return s.slice(start, start + W); }",
      ],
      [
        'a default nested in a destructuring pattern',
        "function region(s, start, { W = 320 }) { return s.slice(start, start + W); }",
      ],
      [
        'a switch-case binding',
        "function f(s, start, k) { switch (k) { case 1: const W = 320; return s.slice(start, start + W); } }",
      ],
    ]) {
      const call = sliceCallsIn(code).at(-1);
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // `substr`'s SECOND argument is a length by definition, so an anchor
  // in that position is a fixed window wearing an anchor's clothes: the
  // region ends however many characters along the landmark happens to
  // sit. The first argument is still an offset and may be anchored.
  it("reports substr's length even when it is produced by a landmark", () => {
    const code = "const s = f();\nconst start = s.indexOf('a');\nconst r = s.substr(start, s.indexOf('end'));";
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // ROUND 5, and the direction that matters most: a CALL is opaque, and
  // its arguments are not the bound — the bound is what it returns. These
  // were being flagged because a number appeared somewhere inside them,
  // which would have forced false exemption markers onto correct code.
  it('does not read a number inside an anchor call as a count', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const tail of [
      "const r = s.slice(start, s.indexOf('320'));",
      "const r = s.slice(start, s.indexOf('end', start + 1));",
      "const r = s.slice(start, s.indexOf('x') + 'x'.length);",
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(countsCharacters(code, call), tail).toBe(false);
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
    expect(countsCharacters(code, call)).toBe(false);
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
    expect(countsCharacters(code, call)).toBe(false);
  });

  // ROUND 4's second finding, and my own fixture had codified the bug: a
  // marker three lines up excused whatever sat between. It now excuses
  // the STATEMENT it precedes and nothing else.
  it('excuses the statement the marker precedes, and not its neighbour', () => {
    const src = [
      `// ${MARKER}: drops the 0x prefix`,
      'const a = x.slice(2);',
      'const b = y.slice(start, start + 320);',
    ].join('\n');
    const [marked, neighbour] = sliceCallsIn(src);
    expect(excused(src, marked)).toBe(true);
    expect(excused(src, neighbour)).toBe(false);
  });

  it('reaches back over a run of comment lines, and stops at CODE', () => {
    const near = [
      '// why this counts, at length',
      `// ${MARKER}: drops the 0x prefix`,
      'const a = x.slice(2);',
    ].join('\n');
    expect(excused(near, sliceCallsIn(near)[0])).toBe(true);
    // A blank line does NOT break it — blank lines are formatting, and a
    // rule that treated one as a boundary would be an invention of this
    // guard rather than anything about the code. CODE between the note and
    // the declaration does break it, which is what makes the note a note
    // ON this declaration.
    const spaced = [`// ${MARKER}: reason`, '', 'const a = x.slice(2);'].join('\n');
    expect(excused(spaced, sliceCallsIn(spaced)[0])).toBe(true);
    const interrupted = [`// ${MARKER}: reason`, 'const other = 1;', 'const a = x.slice(2);'].join(
      '\n',
    );
    expect(excused(interrupted, sliceCallsIn(interrupted)[0])).toBe(false);
  });

  // ROUND 6 — a marker is a note on a DECLARATION. Above an `it(...)`
  // it would otherwise excuse every bound in the whole test, since that
  // registration is a statement containing them all.
  it('does not let a marker above a test registration excuse its body', () => {
    const src = [
      `// ${MARKER}: assertion label`,
      "it('x', () => {",
      '  const s = f();',
      "  const start = s.indexOf('a');",
      '  const r = s.slice(start, start + 320);',
      '});',
    ].join('\n');
    expect(excused(src, sliceCallsIn(src)[0])).toBe(false);
  });

  // ROUND 6 — a marker trailing unrelated code has only whitespace
  // between it and whatever follows, so it was attaching to the next
  // declaration and excusing a window it says nothing about.
  it('does not accept a marker trailing an unrelated statement', () => {
    const src = [
      `const other = 1; // ${MARKER}: about the line above`,
      'const r = s.slice(start, start + 320);',
    ].join('\n');
    expect(excused(src, sliceCallsIn(src)[0])).toBe(false);
  });

  // ROUND 7 — one statement, two names, one reason. The marker cannot
  // say which binding it is about, so it excuses neither.
  it('does not let a marker cover a sibling declarator', () => {
    const src = [
      `// ${MARKER}: assertion label`,
      'const label = text.slice(0, 40), region = src.slice(start, start + 320);',
    ].join('\n');
    for (const call of sliceCallsIn(src)) expect(excused(src, call)).toBe(false);
  });

  // ROUND 7 — a mention of the token is not an assertion, and an
  // assertion with no reason does not name what is counted.
  it('requires the marker to be a directive with a reason', () => {
    const bare = [`// ${MARKER}`, 'const a = x.slice(2);'].join('\n');
    expect(excused(bare, sliceCallsIn(bare)[0])).toBe(false);
    const denial = [`// never add ${MARKER} here`, 'const a = x.slice(2);'].join('\n');
    expect(excused(denial, sliceCallsIn(denial)[0])).toBe(false);
    const empty = [`// ${MARKER}:   `, 'const a = x.slice(2);'].join('\n');
    expect(excused(empty, sliceCallsIn(empty)[0])).toBe(false);
    const good = [`// ${MARKER}: drops the 0x prefix`, 'const a = x.slice(2);'].join('\n');
    expect(excused(good, sliceCallsIn(good)[0])).toBe(true);
  });

  // ROUND 5 — the marker has to BE a comment. Testing the raw line text
  // let a string holding the token excuse the very window beside it.
  it('does not accept the marker from a string or from other code', () => {
    const faked = `const reason = '${MARKER}', bad = src.slice(start, start + 320);`;
    expect(excused(faked, sliceCallsIn(faked)[0])).toBe(false);
  });

  // ROUND 5 — a block-bodied helper puts the call inside a `return`, so
  // the nearest statement is not the marked declaration. Any ENCLOSING
  // statement counts, which is what "one marker covers the helper" meant.
  it('covers a count nested inside the statement the marker precedes', () => {
    const src = [
      `// ${MARKER}: assertion label`,
      'const label = (text) => {',
      '  return text.slice(0, 40);',
      '};',
    ].join('\n');
    expect(excused(src, sliceCallsIn(src)[0])).toBe(true);
  });

  // One marker covers every count INSIDE its statement, which is the
  // point of collapsing six identical truncations into one helper.
  it('covers the calls inside the statement it marks', () => {
    const src = [`// ${MARKER}: assertion label`, 'const label = (t) => t.slice(0, 40);'].join('\n');
    expect(excused(src, sliceCallsIn(src)[0])).toBe(true);
  });

  // ROUND 4 found that `var` hoists to the function, so one declared in
  // an inner block is in scope after it. ROUND 8 then found the other
  // half: being in scope is not the same as holding anything. If the
  // branch did not run, the name is `undefined` and the region runs to
  // the end of the file — so the name RESOLVES and what it holds is
  // unknown, which means it is not a landmark.
  it('finds a hoisted var but does not trust what it holds', () => {
    const src = [
      'function f(s, start, enabled) {',
      "  if (enabled) { var END = s.indexOf('end'); }",
      '  return s.slice(start, END);',
      '}',
    ].join('\n');
    const use = sliceCallsIn(src)[0].args[1];
    expect(bindingOf(src, use).found).toBe(true);
    expect(isAnchored(src, use)).toBe(false);
  });

  // And the hoist stops at a function boundary, or every `var` anywhere
  // would answer for every name.
  it('does not hoist a var out of a nested function', () => {
    const src = [
      'function outer(s, start) {',
      "  function inner() { var END = s.indexOf('end'); return END; }",
      '  return s.slice(start, END);',
      '}',
    ].join('\n');
    expect(isAnchored(src, sliceCallsIn(src)[0].args[1])).toBe(false);
  });

  // Round 30. Two of these are the guard refusing correct work, one is
  // the guard trusting a finder somebody replaced, and one is a hang.
  it('does not refuse the round-30 shapes', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'an ordinary local function handed to Reflect.apply',
        'const custom = () => 42;\n' +
          "const r = s.slice(start, s.indexOf('end'));\nReflect.apply(custom, s, [start, start + 320]);",
      ],
      [
        'a choice between two already-bounded regions written with ||',
        "import { blockFrom, between } from './sourceBlock.mjs';\n" +
          "const block = blockFrom(s, 'if (x) {') || between(s, 'a', 'b');\n" +
          "const r = block.slice(block.indexOf('y'));",
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(false);
    }
  });

  // A String wrapper is an ordinary mutable object, and replacing its
  // finder replaces the answer. The write is to a PROPERTY, so the
  // reassignment check never sees it — the wrapper has to be trusted for
  // how it is USED, not merely for how it was built.
  it('refuses a built-in wrapper whose finder has been replaced', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      'const copy = new String(s);\n' +
      'copy.indexOf = () => start + 320;\n' +
      "const r = s.slice(start, copy.indexOf('end'));";
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // Round 32, and both of these are holes round 30 OPENED. A guard that
  // misses a real window is worse than one that objects to a good one,
  // so these are pinned in the refusing direction.
  it('refuses a truncator a constructor returns', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      'function Factory() { return String.prototype.slice; }\n' +
      'const cut = new Factory();\n' +
      'const r = cut.call(s, start, start + 320);';
    // `new` evaluates to whatever the constructor RETURNS when that is an
    // object, so this is a real fixed window. It must at least reach the
    // collector; calling it self-evidently harmless dropped it entirely.
    const calls = sliceCallsIn(code);
    expect(calls.length).toBeGreaterThan(0);
    expect(countsCharacters(code, calls.at(-1))).toBe(true);
  });

  // Round 33 WITHDREW the wrapper exemption rather than mending it a
  // fourth time. Three rounds found three routes to the same finder — a
  // property on the wrapper, the same property through its prototype,
  // and the intrinsic prototype replaced before the wrapper exists. The
  // last is not reachable from the wrapper's own uses at all, so no
  // examination of them closes it. All three are refused now, and so is
  // the untouched wrapper the exemption existed for: a shape no live
  // suite writes.
  it('refuses a built-in String wrapper, however it was reached', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a property written on the wrapper',
        'const copy = new String(s);\ncopy.indexOf = () => start + 320;\n' +
          "const r = s.slice(start, copy.indexOf('end'));",
      ],
      [
        'the same property written through its prototype',
        'const copy = new String(s);\ncopy.__proto__.indexOf = () => start + 320;\n' +
          "const r = s.slice(start, copy.indexOf('end'));",
      ],
      [
        'the intrinsic prototype replaced before the wrapper exists',
        'String.prototype.indexOf = () => start + 320;\nconst copy = new String(s);\n' +
          "const r = s.slice(start, copy.indexOf('end'));",
      ],
      [
        'an untouched wrapper — the shape the withdrawn exemption existed for',
        "const copy = new String(s);\nconst r = s.slice(start, copy.indexOf('end'));",
      ],
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), why).toBe(true);
    }
  });

  // Round 35 + the backlog sweep. Nineteen threads were found unresolved
  // on this PR, nine of them already fixed by later rounds and ten still
  // live; these are the five that let a window through.
  it('does not let the round-35 shapes through', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'an async arrow helper, whose call is a promise and not a position',
        "const at = async (n) => s.indexOf(n);\nconst r = s.slice(start, at('end'));",
      ],
      [
        'a needle whose value is arithmetic, so its length is undefined',
        'const needle = 320 * 1;\nconst r = s.slice(start, s.indexOf(needle) + needle.length);',
      ],
      [
        'a truncator BOUND and then invoked as a tag',
        'const r = s.slice.bind(s)`320`;',
      ],
      [
        'a truncator behind a property name that is not a truncator name',
        'const box = { cut: String.prototype.slice };\n' +
          'const r = Reflect.apply(box.cut, s, [start, start + 320]);',
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // Round 37, all three in code written the same hour. The member
  // reader had tried to work out what a property HOLDS by reading the
  // object literal; three rounds found three ways that reading is wrong
  // — the property reassigned afterwards, the property an accessor, a
  // spread bringing it in from elsewhere — so it stopped trying. An
  // intrinsic settles it and everything else is refused.
  it('refuses a borrowing through an object it cannot read', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a property written over after the literal',
        'const box = { cut: () => 42 };\nbox.cut = String.prototype.slice;\n' +
          'const r = Reflect.apply(box.cut, s, [start, start + 320]);',
      ],
      [
        'a property defined as an accessor, so the literal holds a getter',
        'const box = { get cut() { return String.prototype.slice; } };\n' +
          'const r = Reflect.apply(box.cut, s, [start, start + 320]);',
      ],
      [
        'a truncator bound to a name by assignment rather than declaration',
        'let cut;\ncut = s.slice.bind(s);\nconst r = cut(start, start + 320);',
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // Round 38. The else-if exemption was written as "a body that is an
  // if" rather than as "an else-if chain", so it excused any header
  // whose unbraced body happened to be one — and those headers then
  // handed back the nested block as if they had opened it, which is the
  // plausible partial region this check exists to refuse.
  it('refuses a header whose unbraced body merely happens to be an if', () => {
    for (const [why, src, header] of [
      ['a labelled if', 'label: if (ready) { one(); } else { two(); }\n', 'label:'],
      ['a loop with an unbraced if body', 'while (ready) if (x) { work(); }\n', 'while (ready)'],
    ]) {
      expect(() => blockFrom(src, header), why).toThrow(/opens no block of its own/);
    }
  });

  // Two supported forms combined is a third form, and it had to be said
  // once for callees and again for tags: a name given its value by
  // assignment, then used as a tag; and a second name aliasing the
  // first.
  it('finds a bound truncator however many names it passes through', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      ['assigned after declaration, then used as a tag', 'let cut;\ncut = s.slice.bind(s);\nconst r = cut`320`;'],
      [
        'held by a second name',
        'const cut = s.slice.bind(s);\nconst alias = cut;\nconst r = alias(start, start + 320);',
      ],
    ]) {
      const code = lead + tail;
      const call = sliceCallsIn(code).at(-1);
      expect(call, why).toBeDefined();
      expect(countsCharacters(code, call), why).toBe(true);
    }
  });

  // Round 36 REVERSES an earlier accepting case. "Just BEFORE a
  // landmark" was pinned as accepted for several rounds, and it is not
  // safe: when the landmark sits at the very start of the text the
  // subtraction is negative, and a negative end is measured from the END
  // of the source — so the bound returns very nearly the whole thing
  // while reading as an anchored position. Non-negativity cannot be
  // established without knowing where the landmark is, which is a
  // runtime fact. "Just past" is the shape these suites write; no live
  // suite writes "just before" at all, so refusing it costs nothing.
  it('refuses a position stepped BACK by a landmark width', () => {
    const code = "const s = f();\nconst r = s.slice(0, s.indexOf('x') - 'x'.length);";
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // A tagged template is a member like any other, so the reader that
  // decides what a member holds has to know an unshadowed intrinsic
  // from a local — otherwise every `String.raw` in a fixture reads as an
  // unreadable narrowing.
  it('does not read String.raw as a truncation', () => {
    const code = 'const t = String.raw`const p = 1;`;\n';
    expect(sliceCallsIn(code)).toEqual([]);
  });

  // The fifth is `blockFrom` itself handing back a wrong region, which is
  // the failure this whole family exists to refuse. An `if` has TWO
  // bodies and the round-28 opens-no-block check only ever looked at the
  // first, so an anchor on the `else` was answered about the consequent.
  it('refuses an else arm that opens no block of its own', () => {
    const src = 'if (ready) { work(); } else consume({ marker: true });\n';
    expect(() => blockFrom(src, 'else')).toThrow(/opens no block of its own/);
  });

  // …and an `else if` still works, because it opens no block of its own
  // legitimately: the nested `if` is its own owner.
  it('takes an else-if arm through its own header', () => {
    const src = 'if (a) { one(); } else if (b) { two(); }\nnext();\n';
    expect(blockFrom(src, 'if (b) {')).toContain('two()');
  });

  // Round 34, both permissive. A truncator invoked as a TAG is a call —
  // the template's parts arrive as an array the truncator coerces to a
  // number — so this is a one-argument slice from a fixed offset to the
  // end of the text, written in a form the node-type filter never saw.
  it('finds a truncator invoked as a template tag', () => {
    const code = 'const s = f();\nconst region = s.slice`320`;\n';
    const calls = sliceCallsIn(code);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].args).toBe(UNKNOWN_BOUNDS);
    expect(countsCharacters(code, calls[0])).toBe(true);
  });

  // A destructured name is not bound to the whole initialiser: `end`
  // holds a property of the number the search returned, which is
  // `undefined`, so the region runs to the end of the text. The alias
  // resolver has known this since round 27 and every other reader of
  // the binding did not — so it is fixed at the shared reader.
  it('refuses a bound introduced by destructuring a finder result', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      "const { end } = s.indexOf('end');\n" +
      'const r = s.slice(start, end);';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // A truncator bound in one statement and called in another. The bind
  // is skipped for being a bind, the call is skipped for having a plain
  // name as its callee, and the window left through the gap.
  it('finds a truncator bound to a name and called later', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      'const cut = s.slice.bind(s);\n' +
      'const r = cut(start, start + 320);';
    const calls = sliceCallsIn(code);
    expect(calls.length).toBeGreaterThan(0);
    expect(countsCharacters(code, calls.at(-1))).toBe(true);
  });

  // Round 29 made `callContaining` try every occurrence of its needle.
  // The empty string occurs at every index and then clamps to the end of
  // the text, so that loop never advances past it — the call hung the
  // test process rather than failing it.
  it('rejects an empty callContaining needle instead of looping forever', () => {
    expect(() => callContaining('console.log(1);', '')).toThrow(/non-empty needle/);
  });

  // A pair of names defined in terms of each other must not spin. It
  // resolves to nothing, so the bound is not recognised as a landmark
  // and is reported — the safe direction.
  it('terminates on a cyclic binding rather than recursing forever', () => {
    const src = "const a = b;\nconst b = a;\nconst s = f();\nconst start = s.indexOf('x');\nconst r = s.slice(start, a);";
    const call = sliceCallsIn(src).at(-1);
    expect(countsCharacters(src, call)).toBe(true);
  });
});

// #2175 — "what does this name hold, and can I trust it here" is asked
// ONCE. These pin the contract rather than any one rule: that the three
// states are distinguished, and that callers are allowed to disagree
// about what a state MEANS as long as they disagree in the open.
describe('#2175 — one resolver, three answers', () => {
  // UNBOUND is not a failure. The two rules below read it in OPPOSITE
  // directions on purpose, and that is the case that cannot be
  // expressed at all while "no binding" and "cannot be trusted" share
  // one falsy answer.
  it('reads a GLOBAL as text for a needle and as no region for a bound', () => {
    // A genuinely unbound name — no declaration anywhere in the file.
    const needle = "const s = f();\nconst r = s.slice(0, s.indexOf(LANDMARK) + LANDMARK.length);";
    expect(countsCharacters(needle, sliceCallsIn(needle).at(-1))).toBe(false);

    // The same unboundness in a RECEIVER position is not a bounded
    // region, so a one-argument slice off it is reported.
    const region = 'const r = block.slice(40);';
    expect(countsCharacters(region, sliceCallsIn(region).at(-1))).toBe(true);
  });

  // An IMPORT is NOT unbound, and an earlier revision of this block said
  // it was. The scope analyser binds it, so it comes back UNRESOLVED
  // with no value to follow — what it shares with a plain parameter is
  // the separate FACT that the value arrives from outside this file, not
  // a state. The two rules disagree here for that reason, not because
  // of the state.
  it('reads an IMPORT through the arrives-from-outside fact, not through a state', () => {
    const needle =
      "import { LANDMARK } from './fixture.mjs';\nconst s = f();\n" +
      'const r = s.slice(0, s.indexOf(LANDMARK) + LANDMARK.length);';
    expect(countsCharacters(needle, sliceCallsIn(needle).at(-1))).toBe(false);

    const region = "import { block } from './fixture.mjs';\nconst r = block.slice(40);";
    expect(countsCharacters(region, sliceCallsIn(region).at(-1))).toBe(true);
  });

  // UNRESOLVED refuses everywhere, because a name that may hold
  // anything by the time the line runs is not something to reason from.
  it('refuses a name whose value cannot be trusted at the use', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      ['reassigned before the use', "let end = s.indexOf('e');\nend = start + 320;\nconst r = s.slice(start, end);"],
      ['unpacked from a pattern', "const { end } = s.indexOf('e');\nconst r = s.slice(start, end);"],
      ['defined in terms of itself', 'const a = b;\nconst b = a;\nconst r = s.slice(start, a);'],
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), why).toBe(true);
    }
  });

  // The rule that used to live in ONE of seven copies. A name unpacked
  // from a pattern is not an alias for the whole initialiser, and every
  // reader inherits that now rather than the one that was taught it.
  it('applies the unpacking rule to every reader, not just the alias one', () => {
    // The borrowing reader — the copy that always had the rule.
    const borrowed =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      'const { slice: cut } = String.prototype;\n' +
      'const r = cut.call(s, start, start + 320);';
    expect(countsCharacters(borrowed, sliceCallsIn(borrowed).at(-1))).toBe(true);

    // The receiver reader — a copy that did not, until the binding
    // reader itself stopped handing back a pattern's initialiser.
    const receiver =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      'const { thing: fake } = { thing: { indexOf: () => start + 320 } };\n' +
      "const r = s.slice(start, fake.indexOf('end'));";
    expect(countsCharacters(receiver, sliceCallsIn(receiver).at(-1))).toBe(true);
  });

  // Round 1 of this PR found the hazard I had flagged in the trigger:
  // the resolver reported WHY a lookup failed, and two callers matched
  // on that string — so every situation sharing a reason with a plain
  // parameter inherited the parameter's exemption. The answer is to
  // report the FACT ("the value arrives from outside this file") rather
  // than the reason, asked of the binding.
  it('exempts only a name whose value really does arrive from outside', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a DEFAULTED parameter, which manufactures its own value',
        "const at = (recv = { indexOf: () => start + 320 }) => recv.indexOf('end');\n" +
          'const r = s.slice(start, at());',
      ],
      [
        'a REST parameter, which is an array and not source text',
        "const at = (...xs) => xs.indexOf('end');\nconst r = s.slice(start, at());",
      ],
      [
        'a DESTRUCTURED parameter, whose value is a projection',
        "const at = ({ recv }) => recv.indexOf('end');\nconst r = s.slice(start, at());",
      ],
      [
        'a definition inside a branch that may never have run',
        'if (on) { var recv = { indexOf: () => start + 320 }; }\n' +
          "const r = s.slice(start, recv.indexOf('end'));",
      ],
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), why).toBe(true);
    }
  });

  // Round 2. The parameter exemption is sound only while the caller is
  // OUT OF SIGHT. At a visible call it is not, and handing the helper a
  // stand-in in plain view was vouched for by the very exemption meant
  // to describe values this cannot see.
  it('refuses a helper handed a stand-in at a visible call', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'the stand-in written out at the call',
        "const at = recv => recv.indexOf('end');\n" +
          'const r = s.slice(start, at({ indexOf: () => start + 320 }));',
      ],
      [
        'the helper reached through an alias',
        "const at = recv => recv.indexOf('end');\nconst alias = at;\n" +
          'const r = s.slice(start, alias({ indexOf: () => start + 320 }));',
      ],
      [
        'the stand-in behind a name',
        'const fake = { indexOf: () => start + 320 };\n' +
          "const at = recv => recv.indexOf('end');\nconst r = s.slice(start, at(fake));",
      ],
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), why).toBe(true);
    }
  });

  // Round 3. Three ways the visibility rule and the intrinsic rule were
  // asking slightly the wrong question.
  it('sees a stand-in through a declaration and through a spread', () => {
    const lead = "const s = f();\nconst start = s.indexOf('a');\n";
    for (const [why, tail] of [
      [
        'a DECLARED function, which is known not to be text without being resolved',
        'function fake() {}\nfake.indexOf = () => start + 320;\n' +
          "const at = recv => recv.indexOf('end');\nconst r = s.slice(start, at(fake));",
      ],
      [
        'a stand-in handed through a SPREAD, which is a wrapper and not a value',
        "const at = recv => recv.indexOf('end');\n" +
          'const r = s.slice(start, at(...[{ indexOf: () => start + 320 }]));',
      ],
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), why).toBe(true);
    }
  });

  // Round 4. A CHOICE is not a value: any branch that is visibly not
  // text condemns the call, because any branch may be the one that runs.
  it('sees a stand-in through a choice of values', () => {
    const lead =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      "const at = recv => recv.indexOf('end');\n";
    for (const [why, tail] of [
      ['a conditional', 'const r = s.slice(start, at(flag ? { indexOf: () => start + 320 } : { indexOf: () => 1 }));'],
      ['a logical choice', 'const r = s.slice(start, at(x || { indexOf: () => start + 320 }));'],
      ['a sequence, whose LAST expression is the value', 'const r = s.slice(start, at((0, { indexOf: () => start + 320 })));'],
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), why).toBe(true);
    }
  });

  // Round 5. Every form the grammar offers for passing a value along is
  // somewhere this inspection can stop one step short — found three
  // rounds running, one form at a time, so they are pinned together.
  it('sees a stand-in through every value-forwarding form', () => {
    const lead =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      "const at = recv => recv.indexOf('end');\n";
    for (const [why, tail] of [
      ['an await', 'const r = s.slice(start, at(await { indexOf: () => start + 320 }));'],
      ['an assignment', 'let f2;\nconst r = s.slice(start, at((f2 = { indexOf: () => start + 320 })));'],
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), why).toBe(true);
    }
  });

  // Round 6. A property read is not an established value, and unwrapping
  // an optional chain is not enough on its own — both forms leave a
  // member expression, and what a property holds when a line runs is
  // not a question this answers (settled at #2170 round 37).
  it('refuses a stand-in reached through a property', () => {
    const lead =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      "const at = recv => recv.indexOf('end');\n" +
      'const holder = { fake: { indexOf: () => start + 320 } };\n';
    for (const [why, tail] of [
      ['through an optional chain', 'const r = s.slice(start, at(holder?.fake));'],
      ['through a plain property read', 'const r = s.slice(start, at(holder.fake));'],
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), why).toBe(true);
    }
  });

  // "Unbound" means declared elsewhere and beyond reach — which stops
  // being true the moment this file writes it. Assigning to an
  // undeclared name creates no binding, so every reference still reads
  // as global while the built-in has been replaced outright.
  it('refuses a built-in this file has written over', () => {
    const written =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      'String = { raw: String.prototype.slice };\n' +
      'const r = String.raw.call(s, start, start + 320);';
    expect(sliceCallsIn(written).length).toBeGreaterThan(0);
    // …and one nobody has touched is still not a narrowing.
    expect(sliceCallsIn('const t = String.raw`const p = 1;`;\n')).toEqual([]);
  });

  // Round 7. Two of these reverse tightenings this PR itself introduced
  // one and two rounds earlier — both were rules reaching one step past
  // their own question, which is the pattern this review keeps finding.
  it('does not let its own tightenings refuse correct work', () => {
    // A nested local sharing a built-in's spelling cannot touch the
    // built-in, and matching on the NAME alone said it had.
    const shadowed = 'function f() { let String; String = {}; }\nconst t = String.raw`x`;';
    expect(sliceCallsIn(shadowed)).toEqual([]);

    // An empty `var` redeclaration of a parameter supplies no value, so
    // the value still comes entirely from the caller.
    const redeclared =
      "const s = f();\nfunction region(text) { var text; return text.slice(0, text.indexOf('e')); }";
    expect(countsCharacters(redeclared, sliceCallsIn(redeclared).at(-1))).toBe(false);
  });

  // A LOGICAL assignment may not assign at all, and then evaluates to
  // the left operand it already held; a CALL WRITTEN AT THE ARGUMENT is
  // not established by knowing the call.
  it('sees a stand-in through a logical assignment and an inline call', () => {
    const lead =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      "const at = recv => recv.indexOf('end');\n";
    for (const [why, tail] of [
      [
        'a logical assignment that may keep its left operand',
        "let fake = { indexOf: () => start + 320 };\nconst r = s.slice(start, at(fake ||= 'text'));",
      ],
      [
        'a call written at the argument',
        'const make = () => ({ indexOf: () => start + 320 });\nconst r = s.slice(start, at(make()));',
      ],
    ]) {
      const code = lead + tail;
      expect(countsCharacters(code, sliceCallsIn(code).at(-1)), why).toBe(true);
    }
  });

  // Round 8. Both of the rules this PR added for writes were wrong in
  // BOTH directions — too strict where the write could not reach the
  // use, too loose where the write was shaped differently — and the
  // reaching-write reasoning every other rule here uses answers both.
  it('asks whether a write can reach the use, not merely whether one exists', () => {
    // Globals: a write AFTER the use cannot have affected it…
    expect(sliceCallsIn("const s = f();\nconst t = String.raw`x`;\nString = {};")).toEqual([]);
    // …a write through a PATTERN counts just as a plain one does…
    const destructured =
      'const s = f();\n[String] = [{ raw: String.prototype.slice }];\n' +
      'const r = String.raw.call(s, 0, 320);';
    expect(sliceCallsIn(destructured).length).toBeGreaterThan(0);
    // …and a local sharing the spelling is still not the global.
    expect(sliceCallsIn('function f() { let String; String = {}; }\nconst t = String.raw`x`;')).toEqual([]);
  });

  it('asks which definitions can supply the value AT the use', () => {
    // A loop target supplies without an initialiser, so the value no
    // longer comes only from the caller.
    const loop =
      'const s = f();\nfunction region(text, values) { for (var text of values) {} ' +
      "return text.slice(0, text.indexOf('e')); }";
    expect(countsCharacters(loop, sliceCallsIn(loop).at(-1))).toBe(true);

    // A redeclaration AFTER the use cannot have supplied it.
    const later =
      'const s = f();\nfunction region(text) { ' +
      "const r = text.slice(0, text.indexOf('e')); var text = { indexOf: () => 320 }; return r; }";
    expect(countsCharacters(later, sliceCallsIn(later).at(-1))).toBe(false);
  });

  // Only the arguments reaching a parameter the helper SEARCHES THROUGH
  // are inspected. Checking every argument refused ordinary ones — a
  // numeric search offset is not a stand-in for the source.
  it('does not judge arguments the helper never searches through', () => {
    const code =
      "const s = f();\nconst at = (text, from) => text.indexOf('e', from);\n" +
      'const r = s.slice(0, at(s, 1));';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(false);
  });

  // Round 9. Two more of this PR's own rules reaching past their
  // question, and two more routes to a value it had claimed to refuse.
  it('identifies a searched parameter by binding, not by spelling', () => {
    // A nested function reusing the name is a different binding, and
    // comparing names blamed the outer parameter for it.
    const shadowed =
      "const s = f();\nconst at = needle => s.indexOf((needle => needle.indexOf('x'))(s));\n" +
      'const r = s.slice(0, at(1));';
    expect(countsCharacters(shadowed, sliceCallsIn(shadowed).at(-1))).toBe(false);
  });

  it('lets a spread destroy the mapping only from where it appears', () => {
    const lead = "const s = f();\nconst at = (text, from) => text.indexOf('e', from);\n";
    // After every searched parameter: the first argument is still named.
    const after = lead + 'const r = s.slice(0, at(s, ...[1]));';
    expect(countsCharacters(after, sliceCallsIn(after).at(-1))).toBe(false);
    // At the searched parameter: nothing can be attributed to it.
    const before = lead + 'const r = s.slice(0, at(...[s], 1));';
    expect(countsCharacters(before, sliceCallsIn(before).at(-1))).toBe(true);
  });

  it('refuses a property read reached through a name, as well as inline', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      "const at = recv => recv.indexOf('end');\n" +
      'const holder = { fake: { indexOf: () => start + 320 } };\n' +
      'const fake = holder.fake;\nconst r = s.slice(start, at(fake));';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  it('sees a built-in replaced through the global object', () => {
    const code =
      'const s = f();\nglobalThis.String = { raw: String.prototype.slice };\n' +
      'const r = String.raw.call(s, 0, 320);';
    expect(sliceCallsIn(code).length).toBeGreaterThan(0);
  });

  // A LITERAL is text only when it is a STRING. A regular expression is
  // an object written out, and reading the node type alone called every
  // literal unknown — the `/x/` stand-in this guard has had an open
  // case about since #2174.
  it('refuses a regular expression written out as a stand-in', () => {
    const code =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      "const at = recv => recv.indexOf('end');\n" +
      'const fake = /x/;\nfake.indexOf = () => start + 320;\n' +
      'const r = s.slice(start, at(fake));';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // The exemption describes a value that CANNOT BE SEEN. A name whose
  // value could not be worked out and which does not come from outside
  // the file satisfies neither half — and forwarding one through a
  // second helper had reopened the defaulted-parameter case.
  it('refuses an unestablished local forwarded through a helper', () => {
    const code =
      'const s = f();\n' +
      'function outer(fake = { indexOf: () => 320 }) {\n' +
      "  const at = recv => recv.indexOf('end');\n" +
      '  return s.slice(0, at(fake));\n' +
      '}';
    expect(countsCharacters(code, sliceCallsIn(code).at(-1))).toBe(true);
  });

  // The resolver FOLLOWS CHAINS, so asking it only for a state answers a
  // different question than "is this name the built-in". A local that
  // aliases something unbound resolved through to an unbound name and
  // wore the built-in's exemption.
  it('recognises the built-in only where the name itself is unbound', () => {
    const aliased =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      'const String = External;\nconst r = String.raw.call(s, start, start + 320);';
    expect(sliceCallsIn(aliased).length).toBeGreaterThan(0);
    // …and the genuine one is still not a narrowing.
    expect(sliceCallsIn('const t = String.raw`const p = 1;`;\n')).toEqual([]);
  });

  // …and the two that genuinely do arrive from outside still work, or
  // the rule above would be satisfied by refusing everything.
  it('still accepts a plain parameter and an import', () => {
    // The receiver is the parameter — which is what the fact governs.
    // (A parameter used as a BOUND has never been a position: nothing
    // in the file says where it points. That is unchanged here.)
    const param = "function region(text) { return text.slice(0, text.indexOf('e')); }";
    expect(countsCharacters(param, sliceCallsIn(param).at(-1))).toBe(false);

    const imported =
      "import { LANDMARK } from './fixture.mjs';\nconst s = f();\n" +
      'const r = s.slice(0, s.indexOf(LANDMARK) + LANDMARK.length);';
    expect(countsCharacters(imported, sliceCallsIn(imported).at(-1))).toBe(false);
  });

  // An intrinsic is recognised BECAUSE it is unbound, not in spite of
  // it — the distinction round 36 reached with a fallback and this
  // states directly.
  it('recognises an intrinsic global and refuses a local of the same name', () => {
    expect(sliceCallsIn('const t = String.raw`const p = 1;`;\n')).toEqual([]);
    const shadowed =
      "const s = f();\nconst start = s.indexOf('a');\n" +
      'const String = { raw: s.slice };\n' +
      'const r = String.raw`320`;';
    expect(sliceCallsIn(shadowed).length).toBeGreaterThan(0);
  });
});
