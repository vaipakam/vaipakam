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

  // ROUND 58 P2 — AND THE RENDER-TIME SAMPLE COMES FIRST.
  //
  // Round 57 pinned the pre-render simulation to `pageHead`, which is
  // sampled AFTER the DOM observation — the head the page had reached by
  // the END of it, after the confirmation was opened and the interaction
  // timeouts waited out. A card exposing a ready action at block N could
  // be validated by an N+1 announced while the drive was still looking.
  //
  // Two samples now, answering two questions: `headAtRender` before
  // anything is read, for "what did the page know when it drew this",
  // and `pageHead` after, for the absence gate's "has the page caught
  // up". The ordering IS the fix, so it is pinned.
  it('samples the render-time head BEFORE reading the card', () => {
    const sample = at('const headAtRender = pageHeadOf(page);');
    const read = at('const card = await readForcedCloseCard(page);');
    expect(sample, 'the render-time sample was not found').toBeGreaterThan(-1);
    expect(read, 'the card read was not found').toBeGreaterThan(-1);
    expect(sample).toBeLessThan(read);
  });

  it('settles the in-flight parses before that sample too', () => {
    // Otherwise the earlier sample is the one that reads zero or stale,
    // which is round 48's defect moved to the new call site.
    const settle = at(SETTLE);
    expect(settle).toBeLessThan(at('const headAtRender = pageHeadOf(page);'));
  });

  // AMENDED IN ROUND 84. The case asserted that the pre-render probe was
  // pinned to `headAtRender`, which was the round-58 fix and turned out to
  // be the round-58 defect one cadence further in: `pageHeadOf` is the
  // HIGHEST head seen anywhere on the page, and the app announces heads
  // far more often than the card refetches, so the "render-time" sample
  // was routinely newer than the data being judged. Around a grace
  // transition that accuses the product of withholding a close-out the
  // protocol had only just started accepting.
  //
  // The pin is now the FLOOR — the first head the page was seen to reach,
  // which the card's data cannot predate — so the bracket spans every
  // block the card could have read. `headAtRender` remains the fallback
  // for a page that announced only one head, which is why both names still
  // appear.
  it('pins the pre-render simulation to a head the card cannot predate', () => {
    // Not to `pageHead` — that is the round-57 fix keeping the round-58
    // defect, and the two identifiers differ by one word.
    const decl = src.slice(at('const defaultableBefore ='), at('const defaultableBefore =') + 400);
    expect(decl).toContain('headBefore');
    expect(decl).not.toContain('pageHead ===');
  });

  it('derives that head from the floor, falling back to the render-time sample', () => {
    // The floor is the whole point: pinning to the render-time sample is
    // what round 84 found wrong. A refactor that quietly restored
    // `headAtRender` as the primary would pass the case above.
    //
    // AMENDED IN ROUND 85 — the floor now has TWO sources and takes the
    // lower. Round 84's floor was the first head the PAGE announced, and
    // its own note stated the gap: a contract read resolving before that
    // announcement could have used an earlier block. `headBeforeNav` is
    // this drive's own head sampled before the navigation, so it is a
    // height the page's reads can hardly precede. Neither source is
    // trusted over the other — the page's announcement is the better
    // evidence where it is lower, since a lagging page provider is the one
    // case `headBeforeNav` cannot cover.
    //
    // AMENDED AGAIN IN ROUND 87 — there are now THREE sources and the
    // floor is the lowest of them. The one that matters is the third: a
    // head sampled from the PAGE'S OWN provider before the page loaded,
    // which bounds what that provider's later `latest` reads can return
    // by construction. The other two remain because they still lower the
    // floor where they are further back, and because the page-provider
    // sample is absent on the first visit and on an endpoint that will
    // not answer.
    const decl = src.slice(at('const headFloor ='), at('const headFloor =') + 700);
    expect(decl).toContain('pageHeadFloorOf(page)');
    expect(decl).toContain('headBeforeNav');
    expect(decl).toContain('pageHeadBeforeNav');
    expect(decl).toMatch(/\[announced, preNav, pageNav\]/);
    // The lowest, never the first available: taking any other one would
    // put the floor above a block the card could have read.
    expect(decl).toMatch(/h < low \? h : low/);
  });

  // ROUND 85 P2 — and the pre-navigation sample has to be taken BEFORE the
  // navigation, which is the only property that makes it a lower bound.
  it('samples the pre-navigation head before the page is loaded', () => {
    const sample = at('headBeforeNav = await pub.getBlockNumber(');
    const goto = at('await page.goto(SITE + path');
    expect(sample, 'the pre-navigation sample was not found').toBeGreaterThan(-1);
    expect(goto, 'the navigation was not found').toBeGreaterThan(-1);
    expect(sample).toBeLessThan(goto);
    // Uncached, for round 13's reason: a height viem answered from a cache
    // filled by an earlier visit is a number this drive already had.
    const decl = src.slice(sample, sample + 200);
    expect(decl).toContain('cacheTime: 0');
  });

  // SELF-REVIEW OF ROUND 85 — and this sample must NOT go through
  // `discovery`.
  //
  // My first version did, with a `.catch(() => null)` after it that could
  // never fire: `discovery` exits the process rather than rejecting, so
  // the fallback was decoration implying a degradation path that did not
  // exist. The policy question underneath it is the real one — this
  // sample only WIDENS a lower bound, so losing it should cost a block or
  // two of bracket rather than an entire observation, and the pinned
  // snapshot makes the same call under `discovery` a few seconds later,
  // which keeps a genuinely dead endpoint loud.
  it('degrades rather than ending the run when that sample fails', () => {
    const sample = at('headBeforeNav = await pub.getBlockNumber(');
    const decl = src.slice(sample - 200, sample + 200);
    expect(decl).not.toContain('discovery(');
    expect(decl).toContain('catch');
  });

  // ROUND 86 P2 — and the interior scan is only worth taking when the
  // FLOOR bounds something. A lagging page provider can serve a contract
  // read from below every floor source this drive has, and scanning a span
  // the card's data sits under proves nothing about that data however
  // exhaustively it is read. The evidence is the ORDER of the endpoint's
  // first head announcement and its first `eth_call`, which this drive can
  // see because every page request goes through its interception.
  //
  // AMENDED IN ROUND 90 — the rule is PER ENDPOINT and has two ways to be
  // satisfied. The pre-navigation sample covers only the endpoints earlier
  // visits proved, so a page falling back to a new one left its reads
  // unbounded while `pageNav > 0n ||` marked the whole floor sound. A key
  // now counts as bounded when it was sampled OR when its own announcement
  // ordering holds — and this case failed on the signature change, which
  // is what its first assertion is for.
  it('only trusts the floor when every endpoint the page used is bounded', () => {
    const sig = 'function floorEstablishedFor(page, sampledBeforeNav)';
    expect(at(sig), 'the floor predicate was not found').toBeGreaterThan(-1);
    const fn = src.slice(at(sig), at(sig) + 2600);
    // Either way of bounding ONE endpoint, inside the per-key loop.
    expect(fn).toContain('sampledBeforeNav?.has(key)');
    // Both stamps, and the ordering test between them.
    expect(fn).toContain('pageFirstHeadAt');
    expect(fn).toContain('pageFirstReadAt');
    // STRICTLY earlier since round 87: equal timestamps mean one response
    // carried both, and a JSON-RPC batch is a set of independent calls
    // rather than a sequence — the `eth_call` can be served a block before
    // the head request beside it.
    expect(fn).toMatch(/head === undefined \|\| head >= read/);
    // `eth_call` and not any POST: counting `eth_chainId` or the head
    // announcements themselves would make this permanently false and
    // silently retire three protocol arms.
    expect(src).toContain("body.includes('eth_call')");
    // And the gate is actually consumed by both stability reads — with no
    // global shortcut past it, which is the round-90 finding.
    const both = src.slice(at('const floorSound ='), at('const floorSound =') + 1200);
    expect(both).toContain('floorEstablishedFor(page, pageSampledBeforeNav)');
    expect(both).not.toMatch(/pageNav > 0n \|\|/);
    expect(both).toMatch(/defaultableStable =\s*\n?\s*floorSound &&/);
    expect(both).toMatch(/internalMatchStable =\s*\n?\s*floorSound &&/);
  });

  // ROUND 85 P2 — the interior of the bracket is READ, not inferred from
  // its ends. Two matching endpoint samples say nothing about a value that
  // can round-trip inside the window.
  it('checks the protocol answer held at every block of the span', () => {
    expect(at('async function stableAcross(')).toBeGreaterThan(-1);
    const both = src.slice(at('const defaultableStable ='), at('const defaultableStable =') + 1400);
    expect(both).toContain('stableAcross(headBefore, pinnedBlock, pinnedDefaultable');
    expect(both).toContain('stableAcross(headBefore, pinnedBlock, pinnedMatch');
  });

  it('brackets the settlement-route read the same way', () => {
    // Both pre-render probes answer questions about the same render, so a
    // fix applied to one of them is this PR's most repeated finding.
    const decl = src.slice(at('const matchBefore ='), at('const matchBefore =') + 400);
    expect(decl).toContain('headBefore');
  });

  // AMENDED IN ROUND 58, and the guard earned its place by failing.
  //
  // It asserted ONE call site, on the reasoning that a second would be
  // unprotected and would read as covered by this file. Round 58 added a
  // second deliberately — `headAtRender` and `pageHead` answer different
  // questions — so the invariant is no longer "one sample" but "every
  // sample settles first", which is what the ordering fix actually
  // rests on.
  //
  // Counted as occurrences MINUS the declaration, because
  // `function pageHeadOf(page)` matches the same text — the first
  // version of this case asserted one occurrence, found two, and was
  // measuring the definition rather than a call site.
  it('has exactly the two sample sites, each settled first', () => {
    const all = [...src.matchAll(/pageHeadOf\(page\)/g)];
    const declarations = [...src.matchAll(/function pageHeadOf\(page\)/g)];
    expect(declarations, 'exactly one definition').toHaveLength(1);
    expect(all.length - declarations.length, 'exactly two call sites').toBe(2);

    // Each sample is preceded by its own settle, so neither reads a head
    // that an in-flight parse has not yet recorded (round 48).
    const settles = [...src.matchAll(/await settleHeadReads\(page\);/g)].map((m) => m.index);
    expect(settles, 'one settle per sample').toHaveLength(2);
    const samples = [...src.matchAll(/const (?:headAtRender|pageHead) = pageHeadOf\(page\);/g)].map(
      (m) => m.index,
    );
    expect(samples).toHaveLength(2);
    for (const [i, sample] of samples.entries()) {
      expect(settles[i], `sample ${i} is settled first`).toBeLessThan(sample);
    }
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

  // AMENDED IN ROUND 92 — the drain is BOUNDED, not a single snapshot.
  //
  // Round 48's reasoning held for the FLOOR and not for the ceiling this
  // same call now feeds: a reply landing while the await settles is one
  // the page has consumed, so its head belongs to what the page was
  // showing, and missing it leaves the ceiling too LOW — which is what
  // lets the catch-up test satisfy itself against a state the page had
  // already moved past. Draining to EMPTY is still refused for round 48's
  // reason: a polling page never reaches empty and the run would hang.
  it('drains the pending parses to a bounded quiet point', () => {
    const fn = src.slice(at('async function settleHeadReads(page)'));
    const body = fn.slice(0, 1600);
    // Still a snapshot per pass — the listener adds to the live set while
    // this awaits, so iterating the set itself would be the unbounded
    // loop under another name.
    expect(body).toContain('[...pending]');
    // Bounded, and the bound is a literal rather than a condition on the
    // set: a condition is how "until empty" comes back.
    expect(body).toMatch(/for \(let pass = 0; pass < \d+; pass \+= 1\)/);
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
