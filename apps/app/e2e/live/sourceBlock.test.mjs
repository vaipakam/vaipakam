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

import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import { describe, expect, it } from 'vitest';

import {
  after,
  between,
  blockFrom,
  callContaining,
  markableStatementsOf,
  markedStatement,
  propertyName,
  statementFrom,
  stripLineComments,
  truncationsIn,
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

describe('after(): the tail of an already bounded region', () => {
  const block = 'if (a) {\n  one();\n} else {\n  two();\n}';

  it('returns what follows the anchor', () => {
    expect(after(block, '  one();\n}')).toBe(' else {\n  two();\n}');
  });

  // #2172. The hand-written form searched to -1 and returned the region
  // from a few characters before its end, which asserts nothing and
  // fails nothing.
  it('throws when the anchor is gone, where the hand-written form returned a tail', () => {
    expect(() => after(block, 'three();')).toThrow(/renamed or removed/);
    // not-a-source-region: the hazard after() exists to refuse, written out once.
    const handCut = block.slice(block.indexOf('three();') + 'three();'.length);
    expect(handCut, 'the hand-written form returns most of the block instead').toContain('two();');
  });

  it('does not take its anchor from a comment', () => {
    const src = '// two();\nif (a) { two(); rest(); }';
    expect(after(src, 'two();')).toBe(' rest(); }');
  });
});

describe('no suite cuts a source region by hand (#2144, #2172)', () => {
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

  // EVERY live file, not only the suites: the assumption below is about
  // the code the guard reads, and it reads drives as well as tests.
  // Block comments as well as line comments: this module's own header
  // discusses the very forms below, and a scan that reads prose reports
  // the documentation as the violation.
  const stripComments = (text) => stripLineComments(text).replace(/\/\*[\s\S]*?\*\//g, '');

  const allLiveFiles = () =>
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
      .filter((rel) => rel !== 'sourceBlock.test.mjs')
      .sort();

  // THE ASSUMPTION THE MODULE STATES, ASSERTED OVER THE REAL FILES.
  //
  // `sourceBlock.mjs` reads each file's own text to decide what a value
  // is, which holds only while the language behaves as written. It used
  // to CHECK that — first for a replaced global, then for a written
  // prototype — and both checks were deleted at round 15 of #2175,
  // because "has this file replaced something the language provides" has
  // no syntactic answer and six review rounds each produced another
  // spelling of it.
  //
  // So it is asserted HERE instead, and the change of place is the whole
  // point. Best-effort is appropriate in this assertion and was not
  // appropriate inside the analyser: a form this misses means nobody
  // noticed something bizarre in our OWN drive files, while a form the
  // analyser missed meant a region certified as anchored that is not.
  // These are the forms a person might actually reach for, not a claim
  // to have enumerated the language.
  it('no live file rewrites the machinery the guard assumes', () => {
    // BY PARSING, not by matching text — round 17, and the third time on
    // this change that a question about bindings was asked of characters
    // and answered wrongly. The regexes this replaces reported
    // `function f() { let String; String = x; }` as a replaced intrinsic
    // (it is a local shadow) and `globalThis['__wsProbe'] = entries` as
    // one too (it is an ordinary probe write).
    //
    // Those are FALSE ALARMS, and they matter more here than misses do.
    // The argument for moving this check out of the analyser was that a
    // miss is cheap in the suite — nobody noticed something bizarre in
    // our own files. A false alarm is not cheap: it fails the suite on
    // correct work, which is the failure this whole family exists to
    // avoid. So the asymmetry runs the other way in this assertion than
    // it does inside the analyser, and it is built accordingly:
    // everything below is established from the tree, and anything that
    // cannot be established is passed over rather than reported.
    //
    // Scoped to the machinery the guard's REASONING depends on, not to
    // prototypes in general: `live-position-observe.mjs` legitimately
    // patches `Element.prototype.scrollIntoView` for the page it drives.
    const INTRINSICS = new Set([
      'String', 'Array', 'Object', 'Number', 'Boolean', 'Function',
      'Symbol', 'Reflect', 'JSON', 'Math',
    ]);
    const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);
    // The MODULE's own static-member decoder, not a copy of it — a
    // narrower copy here missed a no-substitution template key
    // (`globalThis[`String`]`), which is one question answered two ways
    // and the shape this whole change is about (round 18).
    const staticProperty = (m) => {
      const name = propertyName(m);
      return typeof name === 'string' ? name : null;
    };

    const found = [];
    for (const rel of allLiveFiles()) {
      const text = fs.readFileSync(path.join(dir, rel), 'utf8');
      // `ranges` because eslint-scope needs them, the same options the
      // module itself parses with.
      const tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module', ranges: true });
      const scopes = analyze(tree, { ecmaVersion: 2024, sourceType: 'module' });
      const globals = new Set();
      for (const ref of scopes.globalScope.through) globals.add(ref.identifier);
      const report = (why) => {
        const entry = `${rel} — ${why}`;
        if (!found.includes(entry)) found.push(entry);
      };
      // Write targets, THROUGH DESTRUCTURING: `[String.prototype.indexOf]
      // = […]` installs the finder exactly as a plain assignment does,
      // and pushing the outer pattern meant the loop skipped it (round
      // 18). The analyser had a walk for this; it was deleted with the
      // rule that used it, and the question outlived the rule.
      const targets = [];
      const pushTarget = (t) => {
        if (!t) return;
        if (t.type === 'MemberExpression' || t.type === 'Identifier') targets.push(t);
        else if (t.type === 'ArrayPattern') t.elements.forEach(pushTarget);
        else if (t.type === 'ObjectPattern') t.properties.forEach((q) => pushTarget(q.value ?? q.argument));
        else if (t.type === 'AssignmentPattern') pushTarget(t.left);
        else if (t.type === 'RestElement') pushTarget(t.argument);
      };
      const collect = (n) => {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'AssignmentExpression') pushTarget(n.left);
        if (n.type === 'ForOfStatement' || n.type === 'ForInStatement') pushTarget(n.left);
        for (const k of Object.keys(n)) {
          const v = n[k];
          if (Array.isArray(v)) v.forEach(collect);
          else if (v && typeof v.type === 'string') collect(v);
        }
      };
      collect(tree);

      const unshadowedGlobal = (n, names) =>
        n?.type === 'Identifier' && names.has(n.name) && globals.has(n);
      // An intrinsic named DIRECTLY, or selected from an unshadowed
      // global object — `String` and `globalThis.String` are the same
      // object, and an identifier-only test saw only the first.
      const intrinsic = (n) => {
        if (unshadowedGlobal(n, INTRINSICS)) return true;
        return (
          n?.type === 'MemberExpression' &&
          unshadowedGlobal(n.object, GLOBAL_OBJECTS) &&
          INTRINSICS.has(staticProperty(n))
        );
      };

      for (const t of targets) {
        // Replacing an intrinsic OUTRIGHT. The binding must be global —
        // a local of the same name replaces nothing.
        if (t.type === 'Identifier') {
          if (unshadowedGlobal(t, INTRINSICS)) report('replaces an intrinsic outright');
          continue;
        }
        const prop = staticProperty(t);
        if (prop === null) continue;
        const obj = t.object;
        // …through the global object, by a name nothing here declares.
        if (unshadowedGlobal(obj, GLOBAL_OBJECTS) && INTRINSICS.has(prop)) {
          report('replaces an intrinsic through the global object');
        }
        // …or writing a built-in PROTOTYPE, however the built-in is named.
        if (
          obj?.type === 'MemberExpression' &&
          staticProperty(obj) === 'prototype' &&
          intrinsic(obj.object)
        ) {
          report('writes a built-in prototype');
        }
      }
    }
    expect(
      found,
      'a live file rewrites the language the source guard assumes is intact; ' +
        'see the assumption stated in sourceBlock.mjs. Either write it another ' +
        'way, or the guard cannot reason about that file at all',
    ).toEqual([]);
  });

  const MARKER = 'not-a-source-region';

  // The marker excuses a STATEMENT the truncation sits inside, and only
  // that. Proximity alone excused a neighbour (#2144 round 4). It must BE
  // a comment, since the raw line text let a string holding the token
  // excuse itself; and ANY enclosing statement counts, since a
  // block-bodied helper puts the call inside a `return` while the marker
  // sits on the declaration (round 5).
  const excused = (src, t) =>
    markableStatementsOf(src, t.node).some((stmt) => markedStatement(src, stmt, MARKER));

  it('finds the suites to check', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('headSampling.test.mjs');
  });

  // THE RULE (#2172, #2174, #2176; the reasoning is in sourceBlock.mjs).
  // A suite never cuts source text itself: every region comes from a
  // helper that throws when its anchor is gone, and every other
  // truncation says what it cuts.
  it.each(files)('%s cuts no source region by hand', (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const found = truncationsIn(src)
      .filter((t) => !excused(src, t))
      .map((t) => `${file}:${t.line} — ${t.why}: ${t.text.replace(/\s+/g, ' ')}`);
    expect(
      found,
      'a truncation in a suite: take a source region with blockFrom / statementFrom / between / ' +
        `callContaining / after, or mark a truncation that is not one with a ${MARKER} comment ` +
        'saying what it cuts',
    ).toEqual([]);
  });

  // Every way a review round (#2144, #2170, #2175, #2177) found to reach
  // a truncator, in one table. Under the old rule each needed its own
  // reader; under this one each is a name the text spells.
  it('reports every way to reach a truncator', () => {
    const cases = [
      ['a plain call', 's.slice(start, start + 320);'],
      ['substring', 's.substring(start, start + 320);'],
      ['substr', 's.substr(start, 320);'],
      ['a comment in the way', "s.slice(start, // don't truncate\n  start + 320);"],
      ['a string key', "s['slice'](start, start + 320);"],
      ['a template key', 's[`substring`](start, start + 320);'],
      ['a key nobody can read', "const k = 'sl' + 'ice';\ns[k](start, start + 320);"],
      ['an optional call', 's?.slice(start, start + 320);'],
      ['an optional member, parenthesised', '(s?.slice)(start, start + 320);'],
      ['a template tag', 's.slice`320`;'],
      ['an unreadable template tag', "const k = 'slice';\ns[k]`320`;"],
      ['bind, inline', 's.slice.bind(s)(start, start + 320);'],
      ['bind, stored', 'const cut = s.slice.bind(s);\ncut(start, start + 320);'],
      ['call', 'String.prototype.slice.call(s, start, start + 320);'],
      ['apply', 'String.prototype.slice.apply(s, [start, start + 320]);'],
      ['Reflect.apply', 'Reflect.apply(String.prototype.slice, s, [start, start + 320]);'],
      ['a stored truncator', 'const cut = String.prototype.slice;\ncut.call(s, start, start + 320);'],
      ['destructured', 'const { slice } = String.prototype;\nslice.call(s, start, start + 320);'],
      ['destructured and renamed', 'const { substr: cut } = String.prototype;\ncut.call(s, 0, 320);'],
      ['destructured by a computed key', "const { ['sl' + 'ice']: cut } = String.prototype;"],
      ['through an object', 'const box = { cut: String.prototype.slice };\nbox.cut.call(s, 0, 320);'],
      ['a computed borrowing', "String.prototype['sl' + 'ice'].call(s, 0, 320);"],
      ['a String wrapper', 'new String(s).slice(0, 320);'],
    ];
    for (const [why, code] of cases) {
      expect(truncationsIn(code).length, why).toBeGreaterThan(0);
    }
  });

  // #2172. An anchored-LOOKING bound is reported like any other, because
  // a search can fail: `indexOf` of a renamed landmark is -1, a valid
  // slice bound, and the region silently becomes the rest of the text.
  // `between` throws instead, so it is the only spelling.
  it('reports a hand-cut region however well anchored it looks', () => {
    const code = "const r = src.slice(src.indexOf('a'), src.indexOf('b'));";
    expect(truncationsIn(code)).toHaveLength(1);
    const text = 'const head = 1; two(); tail();';
    // not-a-source-region: the #2172 hazard, written out once.
    const handCut = text.slice(text.indexOf('two'), text.indexOf('renamed'));
    expect(handCut, 'a missing landmark widens the hand-cut region').toBe('two(); tail()');
    expect(() => between(text, 'two', 'renamed')).toThrow(/does not follow/);
  });

  // #2174 and #2176 were findings about the ANCHORED-BOUND model: shapes
  // it trusted wrongly (#2174) and correct code it refused (#2176). With
  // no such model they are all one case, a truncation in a suite, and the
  // honest spelling of each is a helper call. Recorded so the shapes are
  // not argued again.
  it('the #2174 and #2176 shapes are plain truncations now', () => {
    const shapes = [
      ['#2174 1: a receiver with its own finder', 'const fake = /x/;\nfake.indexOf = () => start + 320;\nsrc.slice(start, fake.indexOf());'],
      ['#2174 2: a jump past the initialiser', "label: {\n  if (on) break label;\n  var end = src.indexOf('e');\n}\nsrc.slice(start, end);"],
      ['#2176 1: class computed-key order', 'class C {\n  static x = (end = start + 320);\n  static [src.slice(0, end)] = 1;\n}'],
      ['#2176 2: equal literals spelled differently', `src.slice(start, src.indexOf('x') + "x".length);`],
      ['#2176 3: a loop-local binding', "for (const x of xs) {\n  let end = s.indexOf('e');\n  const r = s.slice(0, end);\n  end = 320;\n}"],
    ];
    for (const [why, code] of shapes) expect(truncationsIn(code), why).toHaveLength(1);
  });

  // A borrowing is ONE truncation. Reporting `.slice` and `.call` apart
  // would leave a marked borrowing with two reports in one statement,
  // which the one-truncation-per-marker rule then refuses to excuse.
  it('reports a borrowing once, so a marker can excuse it', () => {
    const src = `// ${MARKER}: drops the 0x prefix\nconst hex = String.prototype.slice.call(x, 2);`;
    const found = truncationsIn(src);
    expect(found).toHaveLength(1);
    expect(excused(src, found[0])).toBe(true);
  });

  it('does not report what truncates nothing', () => {
    const code = [
      'const t = String.raw`const p = 1;`;',
      "const r = s.replace('a', 'b') + s.indexOf('x');",
      'const o = { slice: 1, call: 2 };',
      'box.cut(1, 2);',
      'handlers[0](x);',
      'const n = spy.mock.calls.length;',
      'class A { #slice() { return 1; } m() { return this.#slice(); } }',
    ].join('\n');
    expect(truncationsIn(code)).toEqual([]);
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
    expect(truncationsIn(one).every((c) => marks(one, c))).toBe(true);
    expect(truncationsIn(two).some((c) => marks(two, c))).toBe(false);
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
    expect(truncationsIn(one).every((c) => marks(one, c))).toBe(true);
    expect(truncationsIn(two).some((c) => marks(two, c))).toBe(false);
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
    expect(truncationsIn(two).some((c) => marks(two, c))).toBe(false);
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

  // An anchor naming only PART of a statement must not reach past that
  // statement for a block — round 19 keyed the owner on "first statement
  // at or after the anchor", which skipped the statement the anchor sits
  // INSIDE and took the next one's block.
  it('refuses a partial anchor that reaches into a later block', () => {
    const src = 'const anchor = 1;\nif (ready) { work(); }\n';
    expect(() => blockFrom(src, 'anchor = 1')).toThrow(/opens no block/);
    expect(blockFrom('function f() { a(); }\n', 'function f()')).toContain('a()');
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

  it('refuses an anchor that is whitespace plus a comment', () => {
    expect(() =>
      blockFrom(' // if (target) {\nif (ready) { work(); }\n', ' // if (target) {'),
    ).toThrow(/renamed or removed/);
  });

  // A header whose construct has no braced body opens nothing — the
  // first brace after it may belong to an argument.
  it('refuses a header whose construct has an unbraced body', () => {
    expect(() => blockFrom('if (ready) consume({ marker: true });\n', 'if (ready)')).toThrow(
      /opens no block/,
    );
  });

  it('finds the call containing a needle that also appears earlier', () => {
    const src = "const note = 'target';\nconsole.log('target', value);\n";
    expect(callContaining(src, "'target'")).toContain('console.log');
  });

  it('lets a marker attach to an exported declaration', () => {
    const src =
      '// not-a-source-region: a label, capped for display.\n' +
      'export const label = text.slice(0, 40);\n';
    const call = truncationsIn(src).at(-1);
    expect(
      markableStatementsOf(src, call.node).some((stmt) =>
        markedStatement(src, stmt, 'not-a-source-region'),
      ),
    ).toBe(true);
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
    const [marked, neighbour] = truncationsIn(src);
    expect(excused(src, marked)).toBe(true);
    expect(excused(src, neighbour)).toBe(false);
  });

  it('reaches back over a run of comment lines, and stops at CODE', () => {
    const near = [
      '// why this counts, at length',
      `// ${MARKER}: drops the 0x prefix`,
      'const a = x.slice(2);',
    ].join('\n');
    expect(excused(near, truncationsIn(near)[0])).toBe(true);
    // A blank line does NOT break it — blank lines are formatting, and a
    // rule that treated one as a boundary would be an invention of this
    // guard rather than anything about the code. CODE between the note and
    // the declaration does break it, which is what makes the note a note
    // ON this declaration.
    const spaced = [`// ${MARKER}: reason`, '', 'const a = x.slice(2);'].join('\n');
    expect(excused(spaced, truncationsIn(spaced)[0])).toBe(true);
    const interrupted = [`// ${MARKER}: reason`, 'const other = 1;', 'const a = x.slice(2);'].join(
      '\n',
    );
    expect(excused(interrupted, truncationsIn(interrupted)[0])).toBe(false);
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
    expect(excused(src, truncationsIn(src)[0])).toBe(false);
  });

  // ROUND 6 — a marker trailing unrelated code has only whitespace
  // between it and whatever follows, so it was attaching to the next
  // declaration and excusing a window it says nothing about.
  it('does not accept a marker trailing an unrelated statement', () => {
    const src = [
      `const other = 1; // ${MARKER}: about the line above`,
      'const r = s.slice(start, start + 320);',
    ].join('\n');
    expect(excused(src, truncationsIn(src)[0])).toBe(false);
  });

  // ROUND 7 — one statement, two names, one reason. The marker cannot
  // say which binding it is about, so it excuses neither.
  it('does not let a marker cover a sibling declarator', () => {
    const src = [
      `// ${MARKER}: assertion label`,
      'const label = text.slice(0, 40), region = src.slice(start, start + 320);',
    ].join('\n');
    for (const call of truncationsIn(src)) expect(excused(src, call)).toBe(false);
  });

  // ROUND 7 — a mention of the token is not an assertion, and an
  // assertion with no reason does not name what is counted.
  it('requires the marker to be a directive with a reason', () => {
    const bare = [`// ${MARKER}`, 'const a = x.slice(2);'].join('\n');
    expect(excused(bare, truncationsIn(bare)[0])).toBe(false);
    const denial = [`// never add ${MARKER} here`, 'const a = x.slice(2);'].join('\n');
    expect(excused(denial, truncationsIn(denial)[0])).toBe(false);
    const empty = [`// ${MARKER}:   `, 'const a = x.slice(2);'].join('\n');
    expect(excused(empty, truncationsIn(empty)[0])).toBe(false);
    const good = [`// ${MARKER}: drops the 0x prefix`, 'const a = x.slice(2);'].join('\n');
    expect(excused(good, truncationsIn(good)[0])).toBe(true);
  });

  // ROUND 5 — the marker has to BE a comment. Testing the raw line text
  // let a string holding the token excuse the very window beside it.
  it('does not accept the marker from a string or from other code', () => {
    const faked = `const reason = '${MARKER}', bad = src.slice(start, start + 320);`;
    expect(excused(faked, truncationsIn(faked)[0])).toBe(false);
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
    expect(excused(src, truncationsIn(src)[0])).toBe(true);
  });

  // One marker covers every count INSIDE its statement, which is the
  // point of collapsing six identical truncations into one helper.
  it('covers the calls inside the statement it marks', () => {
    const src = [`// ${MARKER}: assertion label`, 'const label = (t) => t.slice(0, 40);'].join('\n');
    expect(excused(src, truncationsIn(src)[0])).toBe(true);
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

  // A tagged template is reported only when its tag names a truncator,
  // so every `String.raw` in a fixture stays out of the report.
  it('does not read String.raw as a truncation', () => {
    const code = 'const t = String.raw`const p = 1;`;\n';
    expect(truncationsIn(code)).toEqual([]);
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

  // Round 29 made `callContaining` try every occurrence of its needle.
  // The empty string occurs at every index and then clamps to the end of
  // the text, so that loop never advances past it — the call hung the
  // test process rather than failing it.
  it('rejects an empty callContaining needle instead of looping forever', () => {
    expect(() => callContaining('console.log(1);', '')).toThrow(/non-empty needle/);
  });
});
