/**
 * The page-head sample WAITS for the readings already in flight —
 * asserted against the drive's own source.
 *
 * WHY A SOURCE TEST, and why a third one. `live-position-observe.mjs`
 * runs the entire drive on import, so none of its top-level wiring can
 * be executed from a unit test; `exitOrdering.test.mjs` and
 * `confirmTrial.test.mjs` exist for the same reason, on different
 * subjects.
 *
 * #2120 — THE TRACKER ITSELF IS NO LONGER HERE. The head state, the two
 * direct probes and the floor predicate were lifted into `pageHead.mjs`,
 * which runs under a fake page in `pageHead.test.mjs`; the cases below that
 * used to read those bodies out of the drive's source now read them out of
 * the module's, and are kept because they pin SHAPE a behavioural test does
 * not see — where a stamp is taken, which clock it takes, that there is one
 * admission. What this file still owns outright is the drive's WIRING: the
 * order of settle, sample and scrape at the two call sites, which clock the
 * drive hands the tracker, and that the report consumes what the
 * observation produces. None of that can run without the drive.
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

import { blockFrom, callContaining, stripLineComments } from './sourceBlock.mjs';

const DRIVE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'live-position-observe.mjs',
);
/** The tracker the drive wires in (#2120) — the bodies moved there. */
const TRACKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pageHead.mjs');

/**
 * A whole function from the drive's source, brace-matched from its
 * signature.
 *
 * ROUND 98 — `settleHeadReads` was read with a fixed character window
 * (`slice(0, 1600)`, then 2400, then 2600) and it broke three times as
 * explanatory comments grew above the loop. It broke LOUD each time, which
 * is the tolerable direction, but a pin that needs raising whenever a
 * comment lands is a pin that will eventually be raised without being read.
 *
 * ROUND 101 — GENERALISED, because `floorEstablishedFor` was read the same
 * way and broke for the same reason three rounds later. Retiring one
 * instance of a trap and leaving its sibling is the pattern this PR keeps
 * being caught by; there is no number to keep in either now.
 *
 * ROUND 109 SELF-AUDIT — MOVED to `sourceBlock.mjs`, because a second test
 * file needed the same matcher and a second COPY is the defect #2102
 * records rather than a fix for it. The name is kept here: it reads better
 * at the twenty-odd call sites below than the module's own.
 */
const functionBody = blockFrom;

/**
 * The literal text of a template expression, with every `${...}` removed.
 *
 * What is left is what the run actually PRINTS, minus the values — so a
 * rule about the shape of the output reads the output rather than the
 * code that produces it, and an `=` inside an expression cannot be
 * mistaken for a key.
 */
function stripInterpolations(source) {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '$' && source[i + 1] === '{') {
      let depth = 0;
      for (let j = i + 1; j < source.length; j += 1) {
        if (source[j] === '{') depth += 1;
        else if (source[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            i = j;
            break;
          }
        }
      }
      continue;
    }
    out += source[i];
  }
  return out;
}

const settleHeadReadsBody = (mod) =>
  functionBody(mod, 'async function settleHeadReads(page)');

describe('the head sample waits for the readings in flight', () => {
  const src = fs.readFileSync(DRIVE, 'utf8');
  const mod = fs.readFileSync(TRACKER, 'utf8');
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
  // ROUND 101 P2 — THE ORDERING EVIDENCE COMPARES AN ANSWER WITH AN ASK.
  //
  // Round 87 established that a batch is a set of independent calls rather
  // than a sequence, so the `eth_call` beside a head answer can be served a
  // block earlier. That argument was applied to one response and not to two:
  // two CONCURRENT requests can be served at M and M+1 and their responses
  // arrive in either order, so comparing two ARRIVAL times proved nothing and
  // could put the floor at M+1 for a card rendered from M.
  //
  // The read is stamped when it is SENT now, which makes the question sound:
  // had this endpoint already told us where it was, before we asked it to
  // read? Heads do not go backwards, so the answer bounds the read with no
  // assumption about response ordering. The head stays stamped on its ANSWER,
  // which is round 92's rule — an unanswered ask proves nothing.
  it('stamps the read when it is sent and the head when it answers', () => {
    expect(mod, 'the read stamp is on the request listener').toContain(
      "page.on('request', (req) => {",
    );
    const reqListener = functionBody(mod, "page.on('request', (req) => {");
    expect(reqListener).toContain("body.includes('eth_call')");
    // `now` is the clock the drive hands in — see the clock case below.
    expect(reqListener).toContain('firstReadAt.set(key, now())');
    // And NOT re-stamped on arrival, which would reintroduce the unsound
    // comparison for any endpoint the request listener missed.
    expect(mod, 'no arrival-time read stamp remains').not.toContain(
      "if (body.includes('eth_call')) stamp(firstReadAt);",
    );
    // The head keeps its answer-time stamp (round 92).
    expect(mod).toContain('stamp(firstHeadAt)');
  });

  // ROUND 102 P2 — AND THE PROOF IS MEASURED ON A MONOTONIC CLOCK.
  //
  // The floor accepts an endpoint when its head ANSWER was stamped before
  // its read was ASKED. Taken from the wall clock, an NTP step or a VM clock
  // correction between the two manufactures `head < read` for a head that
  // actually arrived afterwards — the floor accepted on evidence that never
  // happened, in the accusing direction.
  it('measures the ordering proof on a monotonic clock', () => {
    expect(src, 'the ordering clock is declared once').toContain(
      'const orderingNow = () => performance.now();',
    );
    // EVERY value that takes part in an ordering comparison, or the
    // comparison mixes two origins and means nothing.
    //
    // AMENDED IN ROUND 109 SELF-REVIEW. The first version enumerated the two
    // stamps that existed when it was written and asserted `toHaveLength(2)`.
    // Round 108 added a THIRD — `requestedAt`, compared against the ledger's
    // arrival time — and the guard did not notice, because it matched only
    // the two patterns it already knew. That is the same guarded-one-of-N
    // shape rounds 107 and 109 found in two other guards of mine; here it is
    // caught by sweeping my own rules rather than by a reviewer.
    //
    // Asserted as a NEGATIVE — nothing takes an ordering stamp from the wall
    // clock — so a fourth site is covered without being enumerated.
    // AMENDED AGAIN IN ROUND 112, which added `deliveredAt` — a FOURTH
    // stamp, and the enumeration would have missed it exactly as it missed
    // the third. The `const requestedAt = ` alternative is generalised to
    // any `<name>At` binding, so the rule is about the CLASS of ordering
    // stamps rather than the members of it that existed when it was last
    // edited. Twice is a pattern; a third time would be a choice.
    //
    // AMENDED FOR #2120 — the stamps now live in TWO files, and the rule
    // is the same one across a seam: the tracker stamps with the `now` it
    // was HANDED, it never reads a clock of its own, and the drive hands it
    // `orderingNow`. Any of those three failing puts the floor's proof and
    // the ledger's comparison on different origins, which is the mixed-
    // origin defect round 102 closed — so all three are pinned, and the
    // tracker's half is a negative over every clock it could reach for.
    const driveStamps = [...src.matchAll(/const [a-z][A-Za-z]*At = ([A-Za-z.]+\(\))/g)];
    expect(driveStamps.length, 'the drive ordering stamps were found').toBeGreaterThanOrEqual(2);
    for (const m of driveStamps) {
      expect(m[1], 'every drive ordering stamp uses orderingNow').toBe('orderingNow()');
    }
    const trackerStamps = [
      ...mod.matchAll(/(?:firstReadAt\.set\(key, |map\.set\(key, )([A-Za-z.]+\(\))/g),
    ];
    expect(trackerStamps.length, 'the tracker ordering stamps were found').toBeGreaterThanOrEqual(
      2,
    );
    for (const m of trackerStamps) {
      expect(m[1], 'every tracker ordering stamp uses the injected clock').toBe('now()');
    }
    expect(mod, 'the tracker reads no clock of its own').not.toMatch(
      /\b(?:Date|performance)\.now\(\)/,
    );
    expect(src, 'no ordering stamp takes the wall clock').not.toMatch(
      /const [a-z][A-Za-z]*At = Date\.now\(\)/,
    );
    // The seam: the drive hands the tracker the same clock it stamps with.
    const wiring = callContaining(src, 'now: orderingNow', 'createPageHeadTracker(');
    expect(wiring, 'the tracker is built with the ordering clock').toContain('now: orderingNow,');
    // And the wall clock is still what deadlines use — a monotonic origin
    // there would be a different, confusing change.
    expect(src).toContain('const until = Date.now() + 20_000;');
  });

  // ROUND 109 SELF-REVIEW — AND THE LEDGER'S CLOCK IS THE SAME ONE.
  //
  // `requestedAt` is stamped in the drive and compared against `at` in
  // `rpc-verdict.mjs`. The comparison is meaningless unless both come from
  // `performance.now()`, and that pairing spans two files, so neither file's
  // own tests can see it. This is the only place that can.
  //
  // AMENDED IN ROUND 112, which gave the ledger's `at` a second source: the
  // caller may now stamp it before the fulfill. Both sources have to be
  // monotonic, so the assertion is that every value `at` can take is —
  // `deliveredAt`, which the drive stamps with `orderingNow`, or the local
  // `performance.now()` fallback. Pinning the old literal would have failed
  // on the correct change, which is the pin that gets widened without being
  // read.
  it('the ledger stamps arrival on the same clock the drive stamps requests', () => {
    const verdictSrc = fs.readFileSync(
      path.join(path.dirname(DRIVE), 'rpc-verdict.mjs'),
      'utf8',
    );
    expect(src, 'the drive stamps requests monotonically').toContain(
      'const orderingNow = () => performance.now();',
    );
    const atBinding = verdictSrc.match(/const at = (.+);/);
    expect(atBinding, "the ledger's arrival stamp was not found").not.toBeNull();
    // Every clock reading in it, however it is written.
    const clocks = [...atBinding[1].matchAll(/([A-Za-z]+)\.now\(\)/g)].map((m) => m[1]);
    expect(clocks.length, 'no clock reading in the arrival stamp').toBeGreaterThan(0);
    for (const c of clocks) {
      expect(c, 'the ledger stamps arrival monotonically').toBe('performance');
    }
    // And the other source is the drive's own ordering clock, not a second
    // reading taken somewhere else.
    if (atBinding[1].includes('deliveredAt')) {
      expect(src, 'the caller stamps delivery on the ordering clock').toContain(
        'const deliveredAt = orderingNow();',
      );
    }
  });

  // ROUND 113 P2 — AND THE DELIVERY STAMP IS TAKEN AFTER THE FULFILL.
  //
  // Which side of the await it sits on IS the fix, and the two sides fail
  // in opposite directions: before it, a sibling begun during fulfillment
  // is stamped later than the failure's arrival and clears a call whose
  // caller consumed an error; several statements after it, a genuine retry
  // is stamped earlier and a correctly rendered page exits BLOCKED. The
  // ledger's own tests cannot see this — they receive the number, not where
  // it was taken — so it is pinned here.
  it('stamps delivery after the fulfill resolves, not before it begins', () => {
    const fulfill = at('await route.fulfill({ status: resp.status, headers, body: buf });');
    const stamp = at('const deliveredAt = orderingNow();');
    expect(fulfill, 'the fulfill was not found').toBeGreaterThan(-1);
    expect(stamp, 'the delivery stamp was not found').toBeGreaterThan(-1);
    expect(stamp, 'the stamp must follow the fulfill').toBeGreaterThan(fulfill);
    // And exactly one of each, so the ordering cannot be satisfied by a
    // second copy somewhere else in the file.
    expect([...src.matchAll(/const deliveredAt = orderingNow\(\);/g)]).toHaveLength(1);
    expect([...src.matchAll(/await route\.fulfill\(/g)]).toHaveLength(1);
  });

  it('only trusts the floor when every endpoint the page used is bounded', () => {
    const sig = 'function floorEstablishedFor(page, sampledBeforeNav)';
    expect(mod.indexOf(sig), 'the floor predicate was not found').toBeGreaterThan(-1);
    const fn = functionBody(mod, sig);
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
    expect(mod).toContain("body.includes('eth_call')");
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
    // Reformatted in round 105 when the extent callback was added, so this
    // pins the arguments rather than a one-line call shape.
    expect(both).toContain('pinnedDefaultable');
    expect(both).toContain('pinnedMatch');
    expect((both.match(/stableAcross\(/g) ?? []).length, 'both arms scan the span').toBe(2);
    expect(both).toContain('headBefore');
    expect(both).toContain('pinnedBlock');
    // ROUND 105 P2 — and both arms record how far they actually got, so the
    // report states the extent it established instead of projecting the
    // whole interval from a non-null verdict.
    expect((both.match(/noteProbed/g) ?? []).length, 'both arms record extent').toBe(2);
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
  //
  // #2120 — the definition is the TRACKER'S now, so the drive's count is
  // call sites alone; the one-definition half of the rule moved with it.
  it('has exactly the two sample sites, each settled first', () => {
    expect([...mod.matchAll(/function pageHeadOf\(page\)/g)], 'exactly one definition').toHaveLength(
      1,
    );
    expect(src, 'the drive defines no copy').not.toContain('function pageHeadOf(page)');
    const all = [...src.matchAll(/pageHeadOf\(page\)/g)];
    expect(all.length, 'exactly two call sites').toBe(2);

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
    expect(mod).toContain("page.on('response', (res) => {");
    expect(mod).not.toContain("page.on('response', async (res) => {");
    const reg = mod.slice(mod.indexOf("page.on('response', (res) => {"));
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
    const body = settleHeadReadsBody(mod);
    // Still a snapshot per pass — the listener adds to the live set while
    // this awaits, so iterating the set itself would be the unbounded
    // loop under another name.
    expect(body).toContain('[...pending]');
    // Bounded, and the bound is a literal rather than a condition on the
    // set: a condition is how "until empty" comes back.
    expect(body).toMatch(/for \(let pass = 0; pass < \d+; pass \+= 1\)/);
  });

  // ROUND 96 P2 — AND IT SAYS WHETHER THE BOUND WAS HIT.
  //
  // Round 92 bounded the wait and called the residual unchanged from round
  // 48. It was not: round 48's sample was a FLOOR, where a late reply is
  // genuinely not part of what the DOM was showing, and this same call now
  // also feeds a CEILING, where it is. Returning quietly after six busy
  // passes hands the caller a ceiling that is too low and looks exactly
  // like a drained one, so the catch-up test reads as satisfied against a
  // state the page had already moved past — an older protocol range then
  // substantiating a product failure.
  it('reports non-quiescence rather than returning as if drained', () => {
    const body = settleHeadReadsBody(mod);
    // The empty-at-entry and empty-during-drain exits are both a positive
    // answer; the fall-through past the budget must not be.
    expect(body).toContain('if (!pending || pending.size === 0) return true;');
    expect(body).toContain('if (inFlight.length === 0) return true;');
    expect(body, 'the post-budget return states what it found').toContain(
      'return pending.size === 0;',
    );
  });

  // ROUND 97 P2 — AND THE FLOOR NEEDS IT TOO. The round-96 version of this
  // case asserted the opposite and was WRONG, which is worth leaving on the
  // record rather than quietly rewriting.
  //
  // Round 48 is about a reply that ARRIVES after the sample: not part of
  // what the DOM was showing, rightly ignored. The budget expiring is a
  // different reply — one that arrived BEFORE the sample and had not
  // finished parsing. That one is already the page's, and dropping it makes
  // the floor too HIGH: a lagging endpoint discovered late leaves its head
  // unrecorded, the floor is built from an ahead OBSERVE_RPC height, the
  // pending parse then lands below it, and both the ordering check and the
  // post-scrape drain pass anyway. A card that rendered at the lower height
  // is then judged against a scan that never covers it.
  //
  // So BOTH sites keep the verdict, and the bracket is sound only when both
  // ends were completely sampled.
  it('both the FLOOR and the CEILING refuse an undrained sample', () => {
    expect(src, 'the pre-render site captures the drain verdict').toContain(
      'const floorDrained = await settleHeadReads(page);',
    );
    expect(src, 'the post-scrape site captures it').toContain(
      'const headSettled = await settleHeadReads(page);',
    );
    const caughtUp = src.slice(
      src.indexOf('const observerCaughtUp ='),
      src.indexOf('const observerCaughtUp =') + 320,
    );
    expect(caughtUp, 'the catch-up test is gated on the ceiling drain').toContain(
      'headSettled &&',
    );
    expect(src, 'and the bracket on the floor drain').toContain('floorDrained &&');
    // No bare call left: a third sample site added without capturing the
    // verdict is the shape this whole finding was.
    const bare = [...src.matchAll(/(?<![=]\s)\n\s*await settleHeadReads\(page\);/g)];
    expect(bare, 'every settle site keeps its verdict').toHaveLength(0);
  });

  // ROUND 101 P2 — AND THE OBSERVED HEAD IS NOT A CEILING BY ITSELF.
  //
  // `pageHead` is the highest head the drive SAW announced, and `headSettled`
  // only says the announcements it saw finished parsing. Neither bounds an
  // unpinned `eth_call` the page issues afterwards: the provider can advance
  // between its last head reply and that read and serve it higher, so a card
  // rendered from a block the interior scan never reaches passed the test
  // whose whole job is to establish that it did not.
  //
  // Asked after the scrape, highest across the endpoints the page actually
  // used, and refused outright when any of them will not answer — a ceiling
  // over some of them is not a ceiling.
  it('clears a ceiling ASKED after the scrape, not only the observed head', () => {
    expect(mod, 'the ceiling probe exists').toContain(
      'async function pageProviderCeiling(page)',
    );
    const probe = functionBody(mod, 'async function pageProviderCeiling(page)');
    // The HIGHEST, which is the mirror of the floor probe's lowest.
    expect(probe).toContain('if (seen > high) high = seen;');
    expect(probe, 'scoped to the endpoints THIS page used').toContain(
      'pageDiamondKeys.get(page)',
    );
    // Sampled after the scrape, not before it.
    const sampleAt = src.indexOf('const ceiling = await pageProviderCeiling(page);');
    expect(sampleAt, 'the ceiling sample was not found').toBeGreaterThan(-1);
    expect(src.indexOf('const card = await readForcedCloseCard(page);')).toBeLessThan(sampleAt);
    // And consumed, with an unbounded endpoint refusing rather than lowering.
    const caughtUp = src.slice(
      src.indexOf('const observerCaughtUp ='),
      src.indexOf('const observerCaughtUp =') + 320,
    );
    expect(caughtUp).toContain('ceilingSound');
    expect(caughtUp).toContain('pinnedBlock >= ceiling.head');
    const sound = src.slice(src.indexOf('const ceilingSound ='), src.indexOf('const ceilingSound =') + 400);
    expect(sound, 'every endpoint the page used must be sampled').toContain('.every(');
  });
});

// ROUND 100 P2 — THE SYNTHETIC CHAIN PROBE VALIDATES LIKE ITS SIBLING.
//
// `BigInt('84532')` parses a DECIMAL string happily, so an endpoint
// answering `"84532"` — not a valid JSON-RPC quantity — was read by the
// synthetic probe as the requested chain, while `chainIdFromRpcPair`
// correctly rejected the same value. Where the page's own traffic carries no
// chain reply, the probe is the sole source and the gate then certifies a
// deployment it never identified: the round-95 block is defeated by the
// malformed answer it exists to distrust.
//
// A source test because the probe lives inside `notePageRpcEndpoint`, which
// runs only under a live page. #2120 lifted the HEAD tracker out of the
// drive; this chain probe is the drive's still, so its two cases stay on the
// drive's source, and the page-provider reader they sit beside moved.
describe('the synthetic chain probe validates as a quantity (round 100)', () => {
  const src = fs.readFileSync(DRIVE, 'utf8');
  const mod = fs.readFileSync(TRACKER, 'utf8');

  it('reads the reply through the shared parser, not raw .result', () => {
    expect(src, 'the probe no longer reads a bare result').not.toContain(
      "const hex = (await r.json())?.result;",
    );
    expect(src).toContain('hexQuantity(believableResult(await r.json()))');
  });

  it('applies the same safe-integer check the captured reader applies', () => {
    const i = src.indexOf('hexQuantity(believableResult(await r.json()))');
    expect(i, 'the probe body moved').toBeGreaterThan(-1);
    const body = src.slice(i, i + 320);
    expect(body).toContain('Number.isSafeInteger(n)');
  });

  it('routes the page-provider head through the shared parser too', () => {
    // The fourth reader of a JSON-RPC result. Rounds 98, 99 and 100 each
    // found one that had been left behind, which is the whole argument for
    // there being one parser rather than a rule each reader remembers.
    expect(mod).toContain('const believed = believableResult(parsed);');
    expect(mod).toContain('const seen = hexQuantity(believed);');
    for (const [name, text] of [
      ['drive', src],
      ['tracker', mod],
    ]) {
      expect(text, `no ${name} reader left reaching for a raw member result`).not.toContain(
        'hexQuantity(parsed?.result)',
      );
    }
  });
});

// ROUND 106 P2 — THE REPORT'S KEYS ARE DISTINCT, asserted rather than
// remembered.
//
// Round 105 fixed a duplicate `span=` key — two meanings on one name in one
// record, ambiguous to a reader and silently lossy to any key-value parser —
// and in the SAME commit introduced `head>19 head>20` for the pinned block
// and the sighting, which is the identical defect. Twice in one change is
// enough to stop relying on noticing it.
// EVERY OBSERVATION FIELD REACHES THE REPORT, asserted rather than
// remembered.
//
// `observeForcedClose` returns the head facts, a hand-maintained projection
// copies them onto the visit record as `forcedClose*`, and the report reads
// them from there. Rounds 101-106 added seven fields along that path, and a
// field added to the observation but missed in the projection does not fail
// anything — it prints `unobserved`, which is a LIE about a figure rather
// than a missing one, on the surface whose whole job is stating what it
// knows.
//
// Checked when this was written and nothing had drifted. The point is that
// the next one cannot.
describe('the head facts survive the projection (round 106)', () => {
  const src = fs.readFileSync(DRIVE, 'utf8');

  it('every head* field the observation returns is projected', () => {
    // Scoped to `observeForcedClose` itself. The first version searched the
    // whole file for a four-space-indented `head*:` and matched Playwright's
    // `headless:` launch option — a guard that fails on something it was
    // never about is no better than one that passes on nothing.
    const fn = functionBody(
      src,
      'async function observeForcedClose(page, loan, headBeforeNav, pageHeadBeforeNav, pageSampledBeforeNav)',
    );
    const produced = [...fn.matchAll(/^ {4}(head[A-Za-z]+):/gm)].map((m) => m[1]);
    expect(produced.length, 'the observation head fields were not found').toBeGreaterThan(4);
    const projected = new Set(
      [...src.matchAll(/forcedClose[A-Za-z]*:\s*forcedClose\s*\?\s*\(forcedClose\.([A-Za-z]+)/g)].map(
        (m) => m[1],
      ),
    );
    const missing = [...new Set(produced)].filter((k) => !projected.has(k));
    expect(missing, `observation fields never projected: ${missing.join(', ')}`).toEqual([]);
  });

  // ROUND 107 P2 — AND THE SECOND LEG, which the first version did not
  // check while the note claimed it did.
  //
  // The path is observation → visit-record projection → report. Checking
  // only the first leg means a report interpolation can be deleted while its
  // projection remains, and nothing fails: the distinct-key case verifies
  // uniqueness, not presence. That is precisely the dropped-field regression
  // this guard was written to prevent, so it has to look at both ends.
  //
  // Writing this found `forcedClosePageHead` — projected since before round
  // 104 moved the report onto the separate thresholds, and read by nothing
  // since. It is removed rather than exempted.
  //
  // ROUND 109 P2 — AND `read` MEANS READ BY THE REPORT.
  //
  // The first version took `consumed` from the whole driver, so any other
  // reader answered the question: a later predicate consulting
  // `v.forcedCloseHeadPinned` keeps it looking consumed while its report
  // interpolation is gone, and the evidence disappears from the operator's
  // output with this test green. The leg being checked is projection →
  // REPORT, so the set has to come from the report.
  it('every projected field is read by the report', () => {
    const projectedNames = [...src.matchAll(/^ {4}(forcedClose[A-Za-z]*):/gm)].map((m) => m[1]);
    expect(projectedNames.length, 'the projection was not found').toBeGreaterThan(5);
    const report = callContaining(src, '`      card=${v.chooser}');
    const consumed = new Set([...report.matchAll(/v\.(forcedClose[A-Za-z]*)/g)].map((m) => m[1]));
    const dead = [...new Set(projectedNames)].filter((k) => !consumed.has(k));
    expect(dead, `projected but never read by the report: ${dead.join(', ')}`).toEqual([]);
  });
});

// ROUND 108 P2 — AN ENDPOINT PROVEN FOREIGN STAYS OUT OF BOTH SETS.
//
// `foreignPageRpcEndpoints` is module-wide and permanent (round 89) because
// the per-page `foreign` set starts empty on every visit, so a later page's
// raw-address heuristic would otherwise re-admit an endpoint already caught
// answering for another chain. The module-wide check guarded
// `knownPageRpcEndpoints` and not `diamond`, which is the set `pageHeadOf`,
// `pageHeadFloorOf` and `floorEstablishedFor` all read — so another chain's
// heights could become the floor a product accusation is measured against.
//
// A source assertion because `admit` is a closure inside `watchPageHead`.
// #2120 moved that closure into `pageHead.mjs`, where the BEHAVIOUR — a
// proven-foreign endpoint stays out on a later page — now runs under a fake
// page in `pageHead.test.mjs`; the source cases at the bottom of this file
// are kept for the SHAPE, scoped to the closure rather than grepping the
// file, and they pin the ORDER — the guard has to precede the add, or it
// guards nothing.
describe('the forced-close report emits distinct keys (round 106)', () => {
  const src = fs.readFileSync(DRIVE, 'utf8');

  it('no key appears twice in the emitted line', () => {
    const i = src.indexOf('` spanStable=');
    expect(i, 'the forced-close report line was not found').toBeGreaterThan(-1);
    // The whole concatenated line, from the stability verdict through the
    // confirming head — anchored at BOTH ends. It was a fixed 1200
    // characters from the block interval, which is the bound #2144 is
    // about: a window that moves with unrelated edits, silently short in
    // one direction and reaching into the neighbours in the other.
    const last = src.indexOf('confirmedAt=${v.forcedCloseConfirmedAt', i);
    expect(last, 'the last key of the report line was not found').toBeGreaterThan(i);
    const line = src.slice(i, src.indexOf('\n', last));
    // ROUND 107 P2 — EVERY token, not the first of each template literal.
    //
    // The first version anchored on a backtick, so it saw only the key that
    // opened each literal. Combining two fields into one literal — an
    // ordinary formatting change — hid the second from the guard, which
    // means it could not prevent the exact duplicate it was written for.
    // ROUND 109 P2 — AND EVERY FORM A KEY IS EMITTED IN.
    //
    // Anchoring on `${` reads only keys whose value is interpolated. A
    // constant token — `spanStable=unknown` written directly, or a ternary
    // moved outside its interpolation — is emitted exactly like the
    // others and was invisible here, so it could duplicate another key
    // while the case named "no key appears twice" stayed green.
    //
    // Taken from the EMITTED text rather than the source: the
    // interpolations are stripped first, so an `=` inside an expression
    // cannot be read as a key, and what remains is what the operator
    // sees.
    const keys = [
      ...stripInterpolations(stripLineComments(line)).matchAll(/[ `]([A-Za-z][A-Za-z0-9>=]*)=/g),
    ].map((m) => m[1]);
    expect(keys.length, 'keys were found at all').toBeGreaterThan(3);
    expect(new Set(keys).size, `duplicate key in: ${keys.join(' ')}`).toBe(keys.length);
  });

  it('each threshold keeps its NAME as well as its operator', () => {
    // The operator alone was round 105's attempt and is what produced the
    // duplicate: a comparison is not an identity.
    expect(src).toContain('head>pinned=');
    expect(src).toContain('head>sighting=');
    expect(src).toContain('head>=ceiling=');
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
  //
  // #2120 — read from the tracker, where `watchPageHead` lives now.
  const src = fs.readFileSync(TRACKER, 'utf8');

  // AMENDED IN ROUND 109. Both of these pinned the SHAPE of two separate
  // inline admissions, which is what let round 108 fix one of them and
  // leave the other: the assertions described the arrangement rather than
  // the property, so they stayed green while half the rule was missing.
  //
  // There is exactly ONE admission now, behind one named test that checks
  // both the per-page and the module-wide exclusion, and that is what these
  // assert. A second `diamond.add` appearing anywhere is the regression.
  it('admits through exactly one guarded place', () => {
    const admissions = [...src.matchAll(/diamond\.add\(key\)/g)];
    expect(admissions.length, 'one admission, one guard').toBe(1);
    const helper = src.indexOf('const admitIfNotForeign = () => {');
    expect(helper, 'the shared admission test was not found').toBeGreaterThan(-1);
    expect(helper, 'the sole admission is inside it').toBeLessThan(admissions[0].index);
  });

  it('that place checks BOTH the per-page and the module-wide exclusion', () => {
    const i = src.indexOf('const admitIfNotForeign = () => {');
    const body = src.slice(i, src.indexOf('};', i) + 2);
    const guard = body.indexOf('foreign.has(key) || foreignPageRpcEndpoints.has(key)');
    const add = body.indexOf('diamond.add(key)');
    expect(guard, 'both exclusions are tested').toBeGreaterThan(-1);
    expect(guard, 'the guard precedes the add, or it guards nothing').toBeLessThan(add);
  });

  it('both arms route through it rather than admitting directly', () => {
    // The expected-chain arm is the one round 108 missed.
    expect(src).toContain('admitIfNotForeign();');
    expect(src).toContain('const admit = admitIfNotForeign;');
  });

  it('still records the exclusion and revokes an earlier admission', () => {
    expect(src).toContain('foreign.add(key);');
    expect(src).toContain('diamond.delete(key);');
  });
});
