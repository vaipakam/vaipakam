/**
 * The page-head sample WAITS for the readings already in flight —
 * asserted against the drive's own source.
 *
 * WHY A SOURCE TEST, and why a third one. `live-position-observe.mjs`
 * runs the entire drive on import, so none of its top-level wiring can
 * be executed from a unit test; `exitOrdering.test.mjs` and
 * `confirmTrial.test.mjs` exist for the same reason, on different
 * subjects. Three files of this shape is a smell, and the fix is the
 * extraction tracked in #2120 — not folding unrelated subjects into one
 * file, which would make each of them harder to read than it is now.
 *
 * WHAT IT PROTECTS. `page.on('response', …)` accepts an async listener
 * and Playwright does not await it. A `latest`-block reply that arrives
 * just before the scrape can therefore still be inside `res.json()` when
 * `observeForcedClose` samples `pageHeadOf(page)` (round 48 P2). The DOM
 * already reflects block N while the map holds an older height, or none.
 *
 * Both outcomes are wrong and neither is loud. Zero disables the absence
 * assertion and reports an INCOMPLETE observation for a reading simply
 * taken too early. A stale non-zero bound is worse: the confirming
 * observer can settle below N and report a correctly absent card as a
 * regression — a false FAIL invented out of a race, on the surface this
 * drive exists to vouch for.
 *
 * The realistic regression is deleting the await as redundant — the
 * listener "obviously" ran already — which restores the race silently
 * and intermittently, the hardest kind to attribute afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DRIVE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'live-position-observe.mjs',
);

describe('the head sample waits for the readings in flight', () => {
  const src = fs.readFileSync(DRIVE, 'utf8');
  const at = (needle) => src.indexOf(needle);

  const SAMPLE = 'const pageHead = pageHeadOf(page);';
  const SETTLE = 'await settleHeadReads(page);';

  it('both halves of this still exist', () => {
    // Guards the guard: an ordering assertion over a -1 says nothing,
    // which is the vacuous shape this PR has been caught by three times.
    expect(at(SAMPLE), 'the head sample was not found').toBeGreaterThan(-1);
    expect(at(SETTLE), 'the settle call was not found').toBeGreaterThan(-1);
  });

  it('settles the pending parses BEFORE sampling', () => {
    expect(at(SETTLE)).toBeLessThan(at(SAMPLE));
  });

  it('samples the head exactly once, so one await covers it', () => {
    // The ordering above is only sufficient while there is a single
    // sample site. A second one added later would be unprotected and
    // would read as covered by this file.
    //
    // Counted as occurrences MINUS the declaration, because
    // `function pageHeadOf(page)` matches the same text — the first
    // version of this case asserted one occurrence, found two, and was
    // measuring the definition rather than a second call site.
    const all = [...src.matchAll(/pageHeadOf\(page\)/g)];
    const declarations = [...src.matchAll(/function pageHeadOf\(page\)/g)];
    expect(declarations, 'exactly one definition').toHaveLength(1);
    expect(all.length - declarations.length, 'exactly one call site').toBe(1);
  });

  it('registers the pending parse synchronously with the event', () => {
    // The registration has to happen before the listener's first await —
    // anything after it is already too late to be seen by a sample taken
    // in between, which is the race itself. So the listener is a plain
    // function that starts the async work and records the promise, not
    // an `async` listener that adds itself partway through.
    expect(src).toContain("page.on('response', (res) => {");
    expect(src).not.toContain("page.on('response', async (res) => {");
    const reg = src.slice(at("page.on('response', (res) => {"));
    expect(reg.slice(0, 400)).toContain('pending.add(done)');
  });

  it('awaits a snapshot rather than looping until the set empties', () => {
    // A parse completing can start another response's work, so draining
    // to empty is unbounded on a page that polls. Everything that
    // arrived before the sample is what the sample needs.
    const fn = src.slice(at('async function settleHeadReads(page)'));
    expect(fn.slice(0, 400)).toContain('[...pending]');
  });
});

describe('an endpoint that lied about its chain stays untrusted', () => {
  // SAME SUBJECT as the file above it: which heights the drive is
  // willing to treat as the page's view of the chain. Round 19
  // established that an endpoint identifying itself as a DIFFERENT chain
  // is excluded "for the rest of the run", and round 51 P2 found the one
  // door left open — the `foreign` check sat BELOW the admission, so an
  // inconsistent endpoint answering with the expected id afterwards was
  // added straight back.
  //
  // That matters because the exclusion exists for exactly the
  // inconsistent case: an endpoint that reports two chain ids has told
  // us it cannot say which chain a height belongs to, and a wrong-chain
  // bound reaching the absence gate lets a degraded page be blamed for
  // omitting a card it was right to omit.
  const src = fs.readFileSync(DRIVE, 'utf8');

  it('checks the exclusion before re-admitting', () => {
    expect(src).toContain('if (!foreign.has(key)) diamond.add(key);');
  });

  it('admits nothing UNGUARDED ahead of the exclusion check', () => {
    // The precise invariant, and the first version of this case got it
    // wrong by asserting there are no bare admissions at all. There are
    // two, and both are correct: they sit BELOW
    // `if (foreign.has(key)) return;`, which guards them already.
    //
    // What must hold is that nothing admits the key *before* that line
    // without testing `foreign` itself — which is exactly the defect
    // round 51 found, and exactly what a later tidy-up would restore by
    // deleting the inline guard as redundant.
    const gate = src.indexOf('if (foreign.has(key)) return;');
    expect(gate, 'the exclusion check was not found').toBeGreaterThan(-1);
    const before = src.slice(0, gate);
    const admissions = [...before.matchAll(/diamond\.add\(key\)/g)];
    expect(admissions.length, 'an admission ahead of the gate').toBe(1);
    for (const m of admissions) {
      const line = before.slice(before.lastIndexOf('\n', m.index) + 1, m.index);
      expect(line, 'that admission must test `foreign` itself').toContain('!foreign.has(key)');
    }
  });

  it('still records the exclusion and revokes an earlier admission', () => {
    expect(src).toContain('foreign.add(key);');
    expect(src).toContain('diamond.delete(key);');
  });
});
