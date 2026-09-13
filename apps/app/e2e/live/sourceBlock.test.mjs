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
  markableStatementsOf,
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
  const countsCharacters = (src, call) => {
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
      // is produced.
      if (call.method === 'substr' && i === 1) return true;
      // A START may be the literal 0 — the stable beginning of the text,
      // a position and not a count (round 8). Marking it would claim a
      // character count that is not happening. Every END, and every other
      // bound, must be a landmark.
      if (i === 0 && isStartOfText(a)) return false;
      return !isAnchored(src, a);
    });
  };

  const isStartOfText = (node) =>
    node.type === 'Literal' && (node.value === 0 || node.value === '0');

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
      ['just before one', "const r = s.slice(start, s.indexOf('x') - 'x'.length);"],
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

  // A pair of names defined in terms of each other must not spin. It
  // resolves to nothing, so the bound is not recognised as a landmark
  // and is reported — the safe direction.
  it('terminates on a cyclic binding rather than recursing forever', () => {
    const src = "const a = b;\nconst b = a;\nconst s = f();\nconst start = s.indexOf('x');\nconst r = s.slice(start, a);";
    const call = sliceCallsIn(src).at(-1);
    expect(countsCharacters(src, call)).toBe(true);
  });
});
