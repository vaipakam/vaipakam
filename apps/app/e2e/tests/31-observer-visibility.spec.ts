/** The live drive's element-visibility predicate, exercised against a
 *  real layout engine.
 *
 *  WHY THIS EXISTS, and why it is not a unit test.
 *
 *  `live-position-observe.mjs` decides every content assertion it makes
 *  — card mounted, body explained, control actionable, receipt rows and
 *  their labels and values — through one `visible(node)` predicate. That
 *  predicate cannot be unit tested: it reads `checkVisibility`, computed
 *  styles and layout boxes, none of which jsdom implements meaningfully.
 *  So it had no coverage at all, and two defects walked straight through
 *  the gap:
 *
 *    - #2093 round 28 added an overflow-clipping rule to the FALLBACK
 *      branch only. Every engine that provides `checkVisibility` — which
 *      is to say the browser the drive actually runs — returned before
 *      reaching it, so the fix did nothing for the card, the body or the
 *      control. A full green live run reported otherwise, because the
 *      one copy that DID get the rule was the receipt's, and the
 *      receipt is what that run's canary exercised.
 *
 *    - the predicate exists in TWO copies (one per `page.evaluate` body,
 *      which cannot share a Node-side closure) and they had already
 *      drifted before anyone noticed. That divergence is #2102; until it
 *      is unified, "both copies agree" is the property worth pinning.
 *
 *  The predicate is read out of the drive's own SOURCE rather than
 *  re-implemented here. A paraphrase would test the paraphrase, which is
 *  the mistake this file is guarding against in the first place.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVE = path.join(HERE, '..', 'live', 'live-position-observe.mjs');

/** Every `const <name> = (<arg>) => { … };` in the drive, by brace match. */
function arrowBlocks(src: string, name: string, arg = 'node'): string[] {
  const out: string[] = [];
  const re = new RegExp(`const ${name} = \\(${arg}\\) => \\{`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) {
        out.push(`${src.slice(m.index, j + 1)};`);
        break;
      }
    }
  }
  return out;
}

/**
 * A helper's SOURCE, stripped to the code: comments removed, whitespace
 * collapsed. Two copies of one helper may explain themselves differently
 * and must not compute differently.
 *
 * ROUND 96 P1 — module-level, and used by every drift assertion here.
 * There were two identical local copies of this: a guard against
 * duplicated code, itself duplicated, so a later fix to how comments are
 * stripped could have strengthened one assertion and silently left the
 * other weaker. Exactly the parallel-site drift the guard exists to catch.
 */
const codeOf = (t: string) =>
  t
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join(' ')
    .split(/\s+/)
    .join(' ');

/**
 * Every `const <name> = (<arg>) => <expression>;` in the drive — the
 * EXPRESSION-bodied form, which {@link arrowBlocks} cannot see because it
 * matches on `=> {`.
 *
 * ROUND 96 P2 — `visible` is written that way at both scrape sites, so it
 * was the one duplicated pair with no drift assertion at all. The
 * behavioural harness cannot stand in for one either: it RECONSTRUCTS the
 * predicate in-page from `shownBox` and `paintsText` rather than running
 * either production copy, so an edit to one of them passes every fixture
 * here and every source comparison above it.
 */
function arrowExpressions(src: string, name: string, arg = 'node'): string[] {
  const re = new RegExp(`const ${name} = \\(${arg}\\) => [^\n;]*;`, 'g');
  return src.match(re) ?? [];
}

test('both copies of the drive visibility predicate agree, and reject clipped content', async ({
  page,
}) => {
  const src = fs.readFileSync(DRIVE, 'utf8');
  const clipHelpers = arrowBlocks(src, 'notClipped');
  const paintHelpers = arrowBlocks(src, 'paintsText');
  // ROUND 66 P2 — the predicate is now `shownBox` (the box) composed with
  // `paintsText` (the element's own text), and `visible` is a one-liner
  // over them. `arrowBlocks` only finds `=> {` forms, so the pair under
  // test is `shownBox`; `visible` is reconstructed in-page below.
  const predicates = arrowBlocks(src, 'shownBox');

  // Pinned counts, deliberately. If the drive grows a third copy, or
  // unifies down to one (#2102), this test is describing a shape that no
  // longer exists and must be revisited rather than quietly passing over
  // whichever copies it still happens to find.
  expect(clipHelpers).toHaveLength(2);
  expect(paintHelpers).toHaveLength(2);
  expect(predicates).toHaveLength(2);

  // ROUND 95 SELF-REVIEW — THE DRIFT ASSERTION, FOR ALL FOUR HELPERS.
  //
  // `visibleTextOf` has had one since round 63; the other three never did,
  // and the whole point of this file is that the duplication is the risk.
  // The behavioural cases below run each copy against the same fixtures and
  // compare, which catches a divergence that CHANGES A VERDICT — but only
  // for the shapes a fixture happens to cover, and a copy differing on a
  // branch no fixture reaches passes clean. That is exactly what was found
  // when this assertion was first added: `shownBox`'s two copies had
  // diverged on the arm taken only when `checkVisibility` is absent, which
  // Chromium never takes, so every behavioural case agreed while the source
  // did not. Rounds 29 and 51 were both that shape, and both times the arm
  // that differed was the one that later became live.
  //
  // Compared as CODE — comments stripped, whitespace collapsed — so the two
  // may explain themselves differently, and must not compute differently.
  for (const [name, copies] of [
    ['notClipped', clipHelpers],
    ['paintsText', paintHelpers],
    ['shownBox', predicates],
    ['visibleTextOf', arrowBlocks(src, 'visibleTextOf', 'root')],
  ] as const) {
    expect(copies, `${name}: expected exactly two copies`).toHaveLength(2);
    expect(codeOf(copies[0]), `${name}: the two copies have drifted`).toBe(codeOf(copies[1]));
  }

  // ROUND 96 P2 — AND `visible` IS THE FIFTH PAIR, with a THIRD occurrence.
  //
  // It is written as an EXPRESSION body at both scrape sites, so
  // `arrowBlocks` — which matches on `=> {` — has never seen it. The
  // round-66 note above says exactly that and does not draw the conclusion.
  // Nothing else covered it either: the behavioural harness RECONSTRUCTS the
  // predicate in-page as `shownBox(n) && paintsText(n)` rather than running
  // either production copy, so an edit to one of them passed every fixture
  // in this file and every comparison in the loop above.
  //
  // THREE, not two, and the third is the load-bearing one. The drive builds
  // `VISIBILITY_HELPER_SOURCES` for the mount wait by looking itself up with
  // `self.indexOf('const visible = (node) => shownBox(node) && ...')` — a
  // STRING LITERAL of the predicate, which sits earlier in the file than
  // either definition and is therefore what `indexOf` finds FIRST. It works
  // today only because the literal and the definitions are the same text. If
  // a definition changed and the literal did not, the lookup would not throw
  // — it would keep finding the literal and hand the mount wait a predicate
  // the scrape no longer uses, silently.
  //
  // So all three are compared, not just the two definitions.
  const visibleCopies = arrowExpressions(src, 'visible');
  expect(
    visibleCopies,
    'visible: two definitions plus the self-lookup literal in VISIBILITY_HELPER_SOURCES',
  ).toHaveLength(3);
  for (const copy of visibleCopies.slice(1)) {
    expect(codeOf(copy), 'visible: the copies have drifted').toBe(codeOf(visibleCopies[0]));
  }

  await page.setContent(`
    <div id="collapsed" style="height:0; overflow:hidden">
      <p id="clipped">a fee row the lender cannot see</p>
    </div>
    <div id="slit" style="height:1px; overflow:hidden">
      <p id="slivered" style="height:20px; margin:0">You can lose: the collateral</p>
    </div>
    <p id="plain">an ordinary visible row</p>
    <div id="scroller" style="height:40px; overflow:auto">
      <p style="height:200px">tall filler</p>
      <p id="scrolledOut">below the fold, but the lender can scroll to it</p>
    </div>
    <div id="trimmer" style="height:19px; overflow:hidden">
      <p id="trimmed" style="height:20px; margin:0">clipped by one pixel, still readable</p>
    </div>
    <div id="halfLines" style="height:20px; overflow:hidden; width:200px; font:16px/20px monospace">
      <p id="twoLines" style="margin:0">first line visible<br>second line clipped away</p>
    </div>
    <dl class="receipt">
      <div class="receipt-row" id="selfClipRow">
        <dt style="width:118px">Fees</dt>
        <dd id="selfClipped" style="height:1px; overflow:hidden; font:16px/20px monospace">2% of the interest, taken at settlement</dd>
        <dd id="selfClippedAbs" style="position:absolute; height:1px; overflow:hidden; width:200px; font:16px/20px monospace">2% of the interest, taken at settlement</dd>
      </div>
    </dl>
    <div id="cardClip" style="height:30px; overflow:hidden; width:200px; font:16px/20px monospace">
      <section id="cardish"><p style="margin:0">row one</p><p style="margin:0">row two</p><p style="margin:0">row three clipped</p></section>
    </div>
    <dl class="receipt">
      <div class="receipt-row" id="ghostRow">
        <dt style="color: transparent">Fees</dt>
        <dd style="color: transparent">the treasury share</dd>
      </div>
    </dl>
    <p id="inherited" style="color: transparent"><span id="repainted" style="color: #111">visible again</span></p>
    <dl class="receipt">
      <div class="receipt-row" id="clipPathRow">
        <dt id="clipPathLeaf" style="clip-path: inset(50%)">Fees</dt>
        <dd id="clipPathPct" style="clip-path: inset(60% 0 60% 0)">the treasury share</dd>
        <dd id="clipPathPx" style="width:200px; height:20px; clip-path: inset(10px 0 10px 0)">exactly collapsed in px</dd>
      </div>
    </dl>
    <div id="clipPathAncestor" style="clip-path: inset(50%)">
      <p id="underClippedAncestor">a loss disclosure under an emptied clip region</p>
    </div>
    <p id="clipPathPartial" style="clip-path: inset(10%)">trimmed at the edges, still readable</p>
    <p id="clipPathRounded" style="clip-path: inset(10% round 4px)">rounded corners are not an extent</p>
    <p id="clipPathCircle" style="clip-path: circle(0)">a shape this predicate does not judge</p>
    <dl class="receipt">
      <div class="receipt-row">
        <dt id="filterLeaf" style="filter: opacity(0)">Fees</dt>
        <dd id="filterPct" style="filter: opacity(0%)">the treasury share</dd>
        <dd id="filterChain" style="filter: blur(1px) opacity(0)">chained onto another filter</dd>
      </div>
    </dl>
    <div id="filterAncestor" style="filter: opacity(0)">
      <p id="underFilter">a loss disclosure under an erased filter</p>
    </div>
    <p id="filterPartial" style="filter: opacity(0.4)">faint on purpose, still readable</p>
    <p id="filterOther" style="filter: brightness(0)">black, but painted</p>
    <!-- ROUND 65 P2 — which ancestors clip an OUT-OF-FLOW box. -->
    <div id="posClipper" style="position:relative; height:20px; overflow:hidden; width:200px; font:16px/20px monospace">
      <p id="absClipped" style="position:absolute; top:60px; margin:0">a fee row pushed outside its containing block</p>
      <!-- Short enough to fit ONE line in a 200px monospace box. The
           first version of this fixture used a long sentence, which wrapped
           to two lines and was then correctly rejected by the per-line
           rule — a fixture failing for a reason that had nothing to do
           with the rule under test. -->
      <p id="absInside" style="position:absolute; top:0; margin:0">Fees 2%</p>
    </div>
    <div id="staticClipper" style="height:20px; overflow:hidden; width:200px; font:16px/20px monospace">
      <p id="absUnderStatic" style="position:absolute; top:60px; margin:0">not clipped by a STATIC ancestor — it is not the containing block</p>
    </div>
    <div id="fixedHost" style="position:relative; height:20px; overflow:hidden; width:200px; font:16px/20px monospace">
      <p id="fixedUnderPositioned" style="position:fixed; top:300px; left:10px; margin:0">a fixed box is not captured by a merely positioned ancestor</p>
    </div>
  `);

  for (const [i, predicate] of predicates.entries()) {
    const result = await page.evaluate(
      ([clipSrc, paintSrc, visSrc]) => {
        // One shared scope for the pair: `visible` calls `notClipped`,
        // and `eval` of a `const` would not leak either into scope here.
        const visible = new Function(
          `${clipSrc}\n${paintSrc}\n${visSrc}\nreturn (n) => shownBox(n) && paintsText(n);`,
        )() as (n: Element | null) => boolean;
        const byId = (id: string) => document.getElementById(id);
        return {
          clipped: visible(byId('clipped')),
          transparentLeaf: visible(byId('ghostRow')!.querySelector('dd')),
          // A wrapper whose own colour is transparent but whose text
          // lives in a repainted child must NOT be condemned: `color`
          // inherits, so judging wrappers would fail a whole card.
          transparentWrapper: visible(byId('inherited')),
          repaintedChild: visible(byId('repainted')),
          slivered: visible(byId('slivered')),
          trimmed: visible(byId('trimmed')),
          twoLines: visible(byId('twoLines')),
          // A CONTAINER with a clipped descendant. The per-line rule is
          // scoped to nodes carrying their OWN text, so this keeps the
          // element-rect behaviour it already had.
          cardish: visible(byId('cardish')),
          // A leaf that clips its OWN text. The walk used to start at
          // `parentElement`, so the one box that could catch this was
          // the one box it skipped.
          selfClipped: visible(byId('selfClipped')),
          // The out-of-flow exemption is about ANCESTORS — whether one
          // clips a positioned descendant is a containing-block
          // question. An element clipping its OWN text is not uncertain
          // at all, whatever its `position` is.
          selfClippedAbs: visible(byId('selfClippedAbs')),
          // ROUND 65 P2.
          absClipped: visible(byId('absClipped')),
          absInside: visible(byId('absInside')),
          absUnderStatic: visible(byId('absUnderStatic')),
          fixedUnderPositioned: visible(byId('fixedUnderPositioned')),
          plain: visible(byId('plain')),
          scrolledOut: visible(byId('scrolledOut')),
          // ROUND 48 — `clip-path` hides the CONTENT and leaves every
          // other signal intact: full-size box, `checkVisibility`
          // positive, no overflow to walk, an opaque colour.
          clipPathLeaf: visible(byId('clipPathLeaf')),
          clipPathPct: visible(byId('clipPathPct')),
          clipPathPx: visible(byId('clipPathPx')),
          underClippedAncestor: visible(byId('underClippedAncestor')),
          // The other direction, pinned so the rule cannot be widened
          // into a false failure on ordinary decorative clipping.
          clipPathPartial: visible(byId('clipPathPartial')),
          clipPathRounded: visible(byId('clipPathRounded')),
          clipPathCircle: visible(byId('clipPathCircle')),
          // ROUND 51 — a FILTER erases content the same way opacity
          // does, leaving geometry, computed `opacity`, text colour and
          // `checkVisibility` all untouched.
          filterLeaf: visible(byId('filterLeaf')),
          filterPct: visible(byId('filterPct')),
          filterChain: visible(byId('filterChain')),
          underFilter: visible(byId('underFilter')),
          filterPartial: visible(byId('filterPartial')),
          filterOther: visible(byId('filterOther')),
          // Recorded so a future failure says WHICH branch ran. The
          // round-28 defect was invisible precisely because the branch
          // under test was not the branch in use.
          usesCheckVisibility:
            typeof byId('plain')!.checkVisibility === 'function',
        };
      },
      [clipHelpers[i], paintHelpers[i], predicate] as const,
    );

    expect(result.usesCheckVisibility, 'the engine exposes checkVisibility').toBe(
      true,
    );
    // A collapsed clipping ancestor paints nothing, while every
    // descendant keeps a full-size layout box and `innerText` keeps
    // yielding its text. Neither `checkVisibility` nor a rect test sees
    // this on its own.
    expect(result.clipped, `copy ${i}: content inside height:0/overflow:hidden`).toBe(
      false,
    );
    // A clipper does not have to be exactly zero to hide everything.
    // `height: 1px` leaves the ancestor non-zero, so the collapsed rule
    // passed it while the lender saw one pixel of a loss disclosure.
    expect(result.slivered, `copy ${i}: content inside height:1px/overflow:hidden`).toBe(
      false,
    );
    // `checkVisibility` says nothing about colour, and neither did any
    // geometry test — so `color: transparent` left every receipt value
    // laid out, measurable and readable through `innerText` while the
    // lender saw nothing.
    expect(result.transparentLeaf, `copy ${i}: a dd painted in transparent`).toBe(false);
    expect(result.transparentWrapper, `copy ${i}: a wrapper with no own text`).toBe(true);
    expect(result.repaintedChild, `copy ${i}: a child that repaints itself`).toBe(true);
    expect(result.plain, `copy ${i}: ordinary content`).toBe(true);
    // The other end of the same rule, pinned so the threshold cannot be
    // tightened into a false failure: a row clipped by a single pixel is
    // still a row the lender can read.
    expect(result.trimmed, `copy ${i}: clipped by one pixel`).toBe(true);
    // Half of a TWO-LINE leaf surviving is not the leaf being readable:
    // it is one whole line on screen and one whole line gone, and
    // `innerText` yields both. The element-level ratio accepted this at
    // exactly 50%; the per-line rule does not.
    expect(result.twoLines, `copy ${i}: a two-line value with line two clipped`).toBe(
      false,
    );
    // THE LIMIT OF THE PER-LINE RULE, and a correction to my own first
    // version of it. `selectNodeContents` on a CONTAINER yields a rect
    // per line of its whole subtree, so an unscoped rule condemns the
    // entire card whenever any one descendant line is mostly clipped —
    // and the verdict that follows says "card is in the DOM but not
    // visible", which is the wrong sentence about a card largely on
    // screen. Leaves are checked individually anyway.
    expect(result.cardish, `copy ${i}: a container whose last row is clipped`).toBe(true);
    expect(result.selfClipped, `copy ${i}: a dd clipping its own text`).toBe(false);
    // ROUND 65 P2 — WHICH ancestors clip an OUT-OF-FLOW box.
    //
    // `inFlow` was computed once from the observed node, so every
    // ancestor intersection test was skipped for any absolute or fixed
    // node — an absolutely positioned receipt leaf inside a positioned
    // `overflow: hidden` box carried fully clipped funds copy into a
    // passing verdict. The exemption existed to avoid a containing-block
    // question; the answer is narrow enough to give.
    //
    // These four are the whole rule, and the last two are what keep it
    // from over-reaching into a false FAIL.
    expect(
      result.absClipped,
      `copy ${i}: absolute, pushed outside its own containing block`,
    ).toBe(false);
    expect(result.absInside, `copy ${i}: absolute, inside its containing block`).toBe(true);
    expect(
      result.absUnderStatic,
      `copy ${i}: a STATIC overflow ancestor is not an absolute box's containing block`,
    ).toBe(true);
    expect(
      result.fixedUnderPositioned,
      `copy ${i}: a merely positioned ancestor does not capture a FIXED box`,
    ).toBe(true);
    expect(
      result.selfClippedAbs,
      `copy ${i}: a POSITIONED dd clipping its own text`,
    ).toBe(false);
    // The deliberate limit of the rule, pinned so it cannot be tightened
    // by accident: content merely scrolled out of a scroll container is
    // reachable, and condemning it would be a false failure — the
    // direction that gets a check switched off.
    expect(result.scrolledOut, `copy ${i}: scrolled out of a scroller`).toBe(true);
    // ROUND 48 P2 — `clip-path: inset(50%)` is the modern
    // visually-hidden idiom, and every other test in this predicate
    // vouches for it: the box is full size, `checkVisibility` is
    // positive, there is no overflow to walk and the colour is opaque,
    // while nothing is painted and `innerText` yields every word.
    expect(result.clipPathLeaf, `copy ${i}: a dt under clip-path: inset(50%)`).toBe(false);
    expect(result.clipPathPct, `copy ${i}: a dd clipped past collapse in %`).toBe(false);
    expect(result.clipPathPx, `copy ${i}: a dd clipped to nothing in px`).toBe(false);
    expect(
      result.underClippedAncestor,
      `copy ${i}: content under an emptied clip region`,
    ).toBe(false);
    // The deliberate limits, pinned in the direction that matters more.
    // A partial inset is ordinary decorative clipping; `round` describes
    // corners, not extent; and a `circle()` — even an empty one — is a
    // geometry question this predicate does not attempt, so it counts as
    // painted. The residual is a missed defect, never an invented one.
    expect(result.clipPathPartial, `copy ${i}: a partial inset`).toBe(true);
    expect(result.clipPathRounded, `copy ${i}: an inset with a corner radius`).toBe(true);
    expect(result.clipPathCircle, `copy ${i}: a shape function, not judged`).toBe(true);
    // ROUND 51 P2 — `filter: opacity(0)` paints nothing while every
    // other signal stays green, and it is checked on the same ancestor
    // walk as `opacity` because a filter applies to the subtree the same
    // way.
    expect(result.filterLeaf, `copy ${i}: a dt under filter: opacity(0)`).toBe(false);
    expect(result.filterPct, `copy ${i}: the same stated as a percentage`).toBe(false);
    expect(result.filterChain, `copy ${i}: zero opacity inside a filter chain`).toBe(false);
    expect(result.underFilter, `copy ${i}: content under an erased ancestor`).toBe(false);
    // The limits, pinned in the direction that matters more: a partial
    // opacity is a deliberate design choice, and a filter this cannot
    // reason about counts as painted.
    expect(result.filterPartial, `copy ${i}: filter: opacity(0.4)`).toBe(true);
    expect(result.filterOther, `copy ${i}: a filter that is not opacity`).toBe(true);
  }
});

/** #2093 round 33 P2 — the interaction target and the judged card.
 *
 *  The drive scrapes whichever card its own `visible()` predicate picks
 *  and then CLICKS through a Playwright locator. Those are two different
 *  definitions of visible: `:visible` is a non-empty box plus a computed
 *  `visibility`, and it does not consider opacity at all, while the
 *  predicate above rejects ancestor opacity because round 22 established
 *  that a transparent card is one the lender cannot see.
 *
 *  So a transparent card ahead of the real one splits the two halves: the
 *  copy, the submit state and the duplicate count describe the genuine
 *  card while the click, the Back wait and the receipt scan land on the
 *  transparent one — a healthy card reported incomplete.
 *
 *  This runs in a real engine for the same reason the case above does: a
 *  unit test cannot tell you what Playwright's `:visible` resolves to, and
 *  that resolution IS the finding. The disagreement is asserted directly
 *  rather than assumed, so if Playwright ever changes what `:visible`
 *  means, this says so instead of silently vouching for a fix aimed at a
 *  problem that no longer exists.
 */
test('the drive addresses the card its own predicate judged, not Playwright’s', async ({
  page,
}) => {
  const src = fs.readFileSync(DRIVE, 'utf8');
  const clipSrc = arrowBlocks(src, 'notClipped')[0];
  const paintSrc = arrowBlocks(src, 'paintsText')[0];
  // ROUND 66 P2 — `shownBox` is the block-bodied half; `visible` is
  // composed from it and `paintsText` in-page, exactly as the drive does.
  const visSrc = arrowBlocks(src, 'shownBox')[0];

  await page.setContent(`
    <div style="opacity:0">
      <div data-testid="forced-close-card" id="ghost">the transparent one</div>
    </div>
    <div data-testid="forced-close-card" id="real">the card the lender sees</div>
  `);

  const cards = page.getByTestId('forced-close-card');
  await expect(cards).toHaveCount(2);

  // The mismatch itself. If this ever stops being true the fix below is
  // no longer needed, and a reader should be told that rather than left
  // with a workaround whose reason has evaporated.
  const playwrightPick = await page
    .locator('[data-testid="forced-close-card"]:visible')
    .first()
    .getAttribute('id');
  expect(playwrightPick, 'Playwright `:visible` ignores ancestor opacity').toBe('ghost');

  // What the DOM pass actually chooses, and the index it now reports so
  // the interaction can address the same element.
  const chosenIndex = await page.evaluate(
    ([clip, paint, vis]) => {
      // All THREE helpers, in dependency order. `visible` calls both
      // `notClipped` and `paintsText`, and injecting a subset throws a
      // `ReferenceError` inside the page — which is how this was caught:
      // adding `paintsText` to the drive broke this second injection
      // while the first, already updated, went on passing.
      const visible = new Function(
        `${clip}\n${paint}\n${vis}\nreturn (n) => shownBox(n) && paintsText(n);`,
      )() as (
        n: Element | null,
      ) => boolean;
      const all = [...document.querySelectorAll('[data-testid="forced-close-card"]')];
      const shown = all.filter(visible);
      return all.indexOf(shown[0]);
    },
    [clipSrc, paintSrc, visSrc] as const,
  );

  expect(chosenIndex, 'the predicate skips the transparent card').toBe(1);
  await expect(cards.nth(chosenIndex)).toHaveAttribute('id', 'real');
});

/** #2093 round 40 P2 — a receipt LEAF must carry text, not just space.
 *
 *  `paintsText` deliberately passes a node with no own text: `color`
 *  inherits, so judging wrappers would condemn a whole card whose rows
 *  repaint themselves. That exemption reaches the receipt's leaves, and
 *  a leaf without text is itself the defect there.
 *
 *  The shipped CSS is what makes it reachable rather than theoretical:
 *  `.receipt-row dt` is `width: 118px; flex-shrink: 0` inside a flex
 *  row, so an EMPTY label keeps its full width and stretches to the
 *  value's height. Non-zero rect, `checkVisibility` positive, clipping
 *  walk clean, paint check exempt — six rows of unlabelled figures would
 *  have recorded a successful confirmation scan, with nothing telling a
 *  lender which figure is the fee and which is the loss.
 *
 *  Exercised in a real engine because every one of those four tests is a
 *  layout or style question, and because the deployed page cannot show
 *  this: its labels are populated, so a live run is green either way.
 */
test('a receipt row with a blank label is not a readable row', async ({ page }) => {
  const src = fs.readFileSync(DRIVE, 'utf8');
  const clipSrc = arrowBlocks(src, 'notClipped')[0];
  const paintSrc = arrowBlocks(src, 'paintsText')[0];
  // ROUND 66 P2 — `shownBox` is the block-bodied half; `visible` is
  // composed from it and `paintsText` in-page, exactly as the drive does.
  const visSrc = arrowBlocks(src, 'shownBox')[0];
  // ROUND 62 P2 — `hasText` is GONE. It asked `innerText` of the
  // `dt`/`dd` WRAPPER, and `visible` on a wrapper is deliberately
  // lenient, so a label in a transparent child passed both. Replaced by
  // `visibleTextOf`, which collects only the text whose element chain is
  // visible.
  //
  // Index [1] is the RECEIPT scope's copy — the same ordering as
  // `visible` above, and the reason the copies are counted.
  const textSrc = arrowBlocks(src, 'visibleTextOf', 'root')[1];
  const rowSrc = arrowBlocks(src, 'rowShown', 'row')[0];

  // One `rowShown`, and `visibleTextOf` in the same two copies `visible`
  // has (#2102). If either changes this test is describing a shape that
  // no longer exists.
  expect(arrowBlocks(src, 'rowShown', 'row')).toHaveLength(1);
  expect(arrowBlocks(src, 'visibleTextOf', 'root')).toHaveLength(2);
  expect(arrowBlocks(src, 'hasText', 'el'), 'hasText was replaced').toHaveLength(0);

  await page.setContent(`
    <style>
      .receipt-row { display: flex; gap: 12px; padding: 12px 16px; font-size: .9rem; }
      .receipt-row dt { flex-shrink: 0; width: 118px; margin: 0; font-weight: 600; }
      .receipt-row dd { margin: 0; }
    </style>
    <dl class="receipt">
      <div class="receipt-row" id="good"><dt>Fees</dt><dd>2% of interest</dd></div>
      <div class="receipt-row" id="blankLabel"><dt></dt><dd>2% of interest</dd></div>
      <div class="receipt-row" id="spaceLabel"><dt>   </dt><dd>2% of interest</dd></div>
      <div class="receipt-row" id="blankValue"><dt>Fees</dt><dd></dd></div>
      <div class="receipt-row" id="ghostLabel"><dt><span style="color: transparent">Fees</span></dt><dd>2% of interest</dd></div>
      <div class="receipt-row" id="ghostValue"><dt>Fees</dt><dd><span style="filter: opacity(0)">2% of interest</span></dd></div>
      <div class="receipt-row" id="clippedValue"><dt>Fees</dt><dd><span style="clip-path: inset(50%)">2% of interest</span></dd></div>
      <div class="receipt-row" id="wrappedOk"><dt><span>Fees</span></dt><dd><span>2% of interest</span></dd></div>
      <div class="receipt-row" id="fillerRow"><dt><span style="color: transparent">Fees</span><span>—</span></dt><dd><span>2% of interest</span></dd></div>
    </dl>
  `);

  const result = await page.evaluate(
    ([clip, paint, vis, text, row]) => {
      const scope = new Function(
        `${clip}\n${paint}\n${vis}\nconst visible = (n) => shownBox(n) && paintsText(n);\n${text}\n${row}\nreturn { rowShown, visible, visibleTextOf };`,
      )() as {
        rowShown: (r: Element) => boolean;
        visible: (n: Element | null) => boolean;
        visibleTextOf: (r: Element | null) => string;
      };
      const byId = (id: string) => document.getElementById(id)!;
      return {
        good: scope.rowShown(byId('good')),
        blankLabel: scope.rowShown(byId('blankLabel')),
        spaceLabel: scope.rowShown(byId('spaceLabel')),
        blankValue: scope.rowShown(byId('blankValue')),
        // ROUND 62 P2 — the label or value erased ONE LEVEL DOWN.
        ghostLabel: scope.rowShown(byId('ghostLabel')),
        ghostValue: scope.rowShown(byId('ghostValue')),
        clippedValue: scope.rowShown(byId('clippedValue')),
        wrappedOk: scope.rowShown(byId('wrappedOk')),
        // The hole itself: each wrapper still passes the predicate on its
        // own, and `innerText` still yields the text. Recorded so that if
        // this ever stops being true the rows are being rejected by
        // something else and the leaf rule is no longer under test.
        ghostLabelWrapperVisible: scope.visible(byId('ghostLabel').querySelector('dt')),
        ghostLabelInnerText:
          (byId('ghostLabel').querySelector('dt') as HTMLElement).innerText.trim(),
        // ROUND 63 P2 — AND THE TEXT CARRIED INTO THE VERDICT.
        //
        // A row with painted filler beside an erased label passes the
        // readability test legitimately — something in it IS painted —
        // and the projection then recorded its raw `innerText`, so the
        // erased label still satisfied the expected label/value pairing.
        // All six pairs matched while the lender read filler.
        wrappedOkPaintedText: scope.visibleTextOf(byId('wrappedOk')),
        fillerRowReadable: scope.rowShown(byId('fillerRow')),
        fillerRowPaintedText: scope.visibleTextOf(byId('fillerRow')),
        fillerRowInnerText: (byId('fillerRow') as HTMLElement).innerText
          .replace(/\s+/g, ' ')
          .trim(),
        // The reason this was reachable: geometry alone accepts the
        // empty label, because the fixed width and the flex stretch give
        // it a full-size box.
        emptyLabelLooksVisible: scope.visible(byId('blankLabel').querySelector('dt')),
      };
    },
    [clipSrc, paintSrc, visSrc, textSrc, rowSrc] as const,
  );

  expect(result.good, 'a populated row').toBe(true);
  expect(result.blankLabel, 'an empty label').toBe(false);
  expect(result.spaceLabel, 'a whitespace-only label').toBe(false);
  expect(result.blankValue, 'an empty value').toBe(false);
  expect(result.ghostLabel, 'a label painted in nothing, one level down').toBe(false);
  expect(result.ghostValue, 'a value under a zero-opacity filter').toBe(false);
  expect(result.clippedValue, 'a value clipped away').toBe(false);
  expect(result.wrappedOk, 'a readable row whose text is merely wrapped').toBe(true);
  expect(
    result.ghostLabelWrapperVisible,
    'the dt wrapper still passes the predicate — which is why the text rule must descend',
  ).toBe(true);
  expect(result.ghostLabelInnerText, 'and innerText still yields the label').toBe('Fees');

  // ROUND 63 P2 — the row reads, and what it CARRIES must not include
  // the erased label. Reporting it readable is correct here; reporting
  // its raw text as the disclosure is what let filler stand in for the
  // funds figures.
  expect(result.fillerRowReadable, 'painted filler makes the row readable').toBe(true);
  // No space between two painted runs INSIDE one line: the join is
  // deliberately empty so that a label split across elements
  // (`<b>Loan</b>s`) does not become `Loan s` when compared against
  // shipped copy with `includes`.
  //
  // ROUND 74 P2 — a rendered LINE BREAK survives the join, because round
  // 24 made that newline a clause boundary the amount scanner relies on:
  // without it a duration on one line and a ticker on the next read as
  // one clause and produced a false funds FAIL.
  //
  // ROUND 79 P2 — AND THIS ROW IS NOT A LINE BREAK. Round 74 decided
  // breaks from the child's `display`, which reads `block` for a flex or
  // grid ITEM even though the items sit side by side; that inserted a
  // boundary between a label and its value and stopped the ticker
  // qualifying the number beside it — a false PASS on funds copy, from
  // the fix for a false FAIL on it. Breaks now come from GEOMETRY, and
  // these two boxes overlap vertically, so the row is one clause again.
  //
  // The value below therefore went `—2% of interest` → `—\n2% of
  // interest` → `—2% of interest` across two rounds. Recorded rather than
  // quietly restored: the second change was mine and wrong.
  expect(result.fillerRowPaintedText, 'the painted runs, joined').toBe('—2% of interest');
  expect(result.fillerRowPaintedText, 'and NOT the erased label').not.toContain('Fees');
  expect(result.fillerRowInnerText, 'while innerText still carries it').toContain('Fees');

  // AND THE SHAPE THE VERDICT NEEDS, which nothing else pins.
  //
  // The verdict pairs each row with its label by substring
  // (`rowsSeen[i].includes(label) && rowsSeen[i].includes(value)`), and
  // the unit fixtures build those strings by hand with a newline between
  // label and value — so they cannot notice if the DRIVE stops producing
  // a string of that shape. Switching `rowsText` from `innerText` to
  // painted text changed exactly that: `innerText` puts a newline
  // between the `dt` and the `dd`, this joins with nothing and collapses
  // whitespace.
  //
  // Substring pairing survives that, and the live run confirmed it on
  // the real card — but only a run that is not in CI did. This is the
  // assertion that says the two halves still agree without one.
  expect(result.wrappedOkPaintedText, 'the label is findable').toContain('Fees');
  expect(result.wrappedOkPaintedText, 'and so is the value').toContain('2% of interest');
  // Recorded rather than assumed: if this ever becomes false the rows
  // are being rejected by geometry and the text rule is no longer the
  // thing under test.
  expect(
    result.emptyLabelLooksVisible,
    'the empty label still passes the visibility predicate — which is why the text rule is needed',
  ).toBe(true);
});

// ROUND 61 P2 — THE BODY'S EXPLANATION, ONE LEVEL DOWN.
//
// `visible(body)` cannot answer "can the lender read this", and
// `paintsText` says why in its own comment: only elements carrying their
// OWN text are judged, because `color` inherits and condemning a wrapper
// whose children set their own colour would be a false FAIL on the very
// card the run exists to vouch for.
//
// So an explanation wrapped in a child — ordinary markup — is exempt
// from the colour test; the opacity and filter walk only climbs to
// ANCESTORS; and `notClipped` looks at the body and above. Erase the
// CHILD and every one of those still passes while `innerText` keeps
// yielding the sentence. That is round 21's heading-only surface
// reached one level down, and it would pass a card whose explanation
// the lender never sees.
//
// Three erasures, because they are three independent mechanisms and the
// predicate has been caught carrying a fix in only one of them twice
// (rounds 29 and 51).
test('an explanation erased inside the body is not a visible body', async ({ page }) => {
  const src = fs.readFileSync(DRIVE, 'utf8');
  const clipSrc = arrowBlocks(src, 'notClipped')[0];
  const paintSrc = arrowBlocks(src, 'paintsText')[0];
  // ROUND 66 P2 — `shownBox` is the block-bodied half; `visible` is
  // composed from it and `paintsText` in-page, exactly as the drive does.
  const visSrc = arrowBlocks(src, 'shownBox')[0];
  // ROUND 62 P2 — `textLeavesOf` became `visibleTextOf`. "At least one
  // visible leaf" accepted an unrelated leaf while the sentence the
  // verdict MATCHES was erased; reporting the painted TEXT and
  // recognising state from that binds the check to the copy that
  // governs the action.
  //
  // Index [0] is the CARD-SCRAPE scope's copy, the same ordering as
  // `visible`.
  const leafSrc = arrowBlocks(src, 'visibleTextOf', 'root')[0];
  expect(arrowBlocks(src, 'visibleTextOf', 'root')).toHaveLength(2);
  expect(arrowBlocks(src, 'textLeavesOf', 'root'), 'replaced').toHaveLength(0);


  // AND THE TWO COPIES MUST AGREE, which nothing asserted when they were
  // written. `visible` has a whole test for this property because its two
  // copies had already drifted (#2102); a second duplicated helper with
  // no such assertion is that story queued up again. Compared as source
  // with whitespace normalised — the copies sit at different indentation
  // — because textual identity is the strongest form of "they agree" and
  // the cheapest to check.
  // COMMENT LINES DROPPED, code compared. The two copies carry different
  // prose on purpose — one cross-references the other — and this
  // assertion failed on exactly that when it compared the raw source,
  // which would have made it a nuisance rather than a guard. Only whole
  // comment lines are removed, never a trailing `//`, so the regex
  // literals in the body are untouched.
  const bothCopies = arrowBlocks(src, 'visibleTextOf', 'root');
  expect(codeOf(bothCopies[0]), 'the two copies have drifted').toBe(codeOf(bothCopies[1]));

  await page.setContent(`
    <style>
      /* An opaque page background, as a real stylesheet has. The
         occlusion rule must never read it as a cover — see the
         onOpaquePage fixture below. */
      body { background: #ffffff; }
      .card { padding: 16px; }
      .body { font-size: .9rem; }
      .transparent { color: transparent; }
      .erased { filter: opacity(0); }
      /* IN FLOW, deliberately. An absolutely-positioned child leaves the
         wrapper zero-height, so the wrapper fails on geometry and the
         leaf rule is never reached — the first version of this fixture
         did that and proved nothing about the hole it names. */
      .clipped { clip-path: inset(50%); }
      .srOnly { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
    </style>
    <div class="card">
      <div class="body" id="plain"><p>This loan can be closed out now.</p></div>
      <div class="body" id="ownText">This loan can be closed out now.</div>
      <div class="body" id="transparent"><p class="transparent">This loan can be closed out now.</p></div>
      <div class="body" id="erased"><p class="erased">This loan can be closed out now.</p></div>
      <div class="body" id="clipped"><p class="clipped">This loan can be closed out now.</p></div>
      <div class="body" id="empty"></div>
      <div class="body" id="twoLeaves">
        <p class="transparent">This loan can be closed out now.</p>
        <p>You can change your mind until you confirm.</p>
      </div>
      <div class="body transparent" id="rootErased">This loan can be closed out now.</div>
      <!-- ROUND 66 P2 — a container whose OWN text is transparent, with a
           descendant that repaints itself. The readable sentence must
           survive; discarding it was a product FAIL on a card whose
           explanation is painted. -->
      <div class="body transparent" id="repaintedChild">hidden filler<p style="color:#111">This loan can be closed out now.</p></div>
      <div class="body" id="styleOnly"><style>.x { color: red; }</style></div>
      <div class="body" id="styleBeside"><style>.x { color: red; }</style><p>This loan can be closed out now.</p></div>
      <div class="body" id="withSrOnly">
        <span class="srOnly">Forced close-out</span>
        <p>This loan can be closed out now.</p>
      </div>
      <!-- ROUND 74 P2 — rendered line boundaries. Two rows must not read
           as one clause: round 24 made the newline a clause boundary, and
           joining every run with nothing deleted it, so a ticker on the
           second line looked adjacent to a duration on the first and the
           amount scanner emitted a false funds FAIL. -->
      <div class="body" id="twoLines">
        <p>Wait 3 days</p>
        <p>USDC is returned later</p>
      </div>
      <!-- And the rule round 66 exists for must survive it: an INLINE
           split is still joined with nothing, or a bolded word becomes
           two words and stops matching shipped copy. -->
      <div class="body" id="inlineSplit"><b>Loan</b>s are closed out</div>
      <div class="body" id="withBreak">Wait 3 days<br>USDC is returned later</div>
      <!-- ROUND 81 P2 — the older screen-reader pattern defeats every
           other test: visible, real rect, opaque, unclipped. Admitting it
           let an off-screen sentence substantiate a card showing a
           sighted lender nothing. -->
      <div class="body" id="offLeft">
        <p style="position:absolute; left:-9999px">This loan can be closed out now.</p>
      </div>
      <!-- SELF-REVIEW AFTER ROUND 81 — the same trick written as an
           indent. The BOX is exactly where it belongs, so geometry,
           clipping and the document-origin test all say yes while the
           line sits far outside it. -->
      <div class="body" id="indentedOut">
        <p style="text-indent:-9999px">This loan can be closed out now.</p>
      </div>
      <!-- ROUND 82 P2 — the hole the round-81 heuristic left open. It
           condemned an indent "at least as wide as the element", so a
           SHORT label parked off-screen inside a WIDE container walked
           through: 300 is not >= 600, and the word sits at x=-300. The
           glyph rectangles do not care how wide the box is. -->
      <div class="body" id="indentedShortLabel" style="width:600px">
        <p style="text-indent:-300px; margin:0">Ready</p>
      </div>
      <!-- A hanging indent is legitimate and stays painted, which is what
           keeps the rule from condemning ordinary typography. -->
      <div class="body" id="hangingIndent">
        <p style="text-indent:-12px; padding-left:12px">This loan can be closed out now.</p>
      </div>
      <!-- ROUND 89 P2 — an opaque sibling laid over the text defeats every
           other test: real rect, real document coordinates, full opacity,
           nothing clipped, glyphs measurable. The lender sees the overlay.
           The wrapper is positioned so the absolute overlay is placed
           against it rather than against the page. -->
      <div class="body" id="occluded" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:#123456"></div>
      </div>
      <!-- THE FALSE-POSITIVE GUARD, and the reason the rule asks whether the
           cover PAINTS rather than merely whether something is on top: a
           full-size transparent click-catcher is ordinary modal markup and
           hides nothing. -->
      <div class="body" id="catcher" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0"></div>
      </div>
      <!-- Partial cover stays painted: a sticky header crossing a row as the
           page scrolls is ordinary, and half a sentence is not this defect. -->
      <div class="body" id="halfCovered" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; left:0; top:0; right:0; height:4px; background:#123456"></div>
      </div>
      <!-- The STATED RESIDUAL, pinned so it is a known limit rather than a
           surprise: an opaque cover that does not take pointer events is
           invisible to hit-testing, so this text is still reported painted. -->
      <div class="body" id="occludedNoPointer" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:#123456; pointer-events:none"></div>
      </div>
      <!-- ROUND 90 P2 — a DESCENDANT can cover its parent's own text. The
           first version exempted every descendant, so an absolutely
           positioned opaque child was declared not-a-cover by the very
           fact that it belongs to the element it hides. -->
      <div class="body" id="coveredByChild" style="position:relative; width:320px">
        <p style="margin:0; position:relative">This loan can be closed out now.<span style="position:absolute; inset:0; background:#123456"></span></p>
      </div>
      <!-- ROUND 90 P2 — a modern colour form. Chromium preserves these
           notations, so an rgba-only parser reads the cover as transparent
           and keeps the hidden text. -->
      <div class="body" id="coveredByModernColor" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:oklab(0.5 0.1 0.1)"></div>
      </div>
      <!-- ROUND 91 P2 — an opaque BACKGROUND on an element that is itself
           transparent is not a cover. A transition layer left at zero
           opacity is ordinary, hit-testing still returns it, and reading
           its background alone condemned plainly visible copy. -->
      <div class="body" id="coveredByGhost" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:#123456; opacity:0"></div>
      </div>
      <!-- The same by another property. -->
      <div class="body" id="coveredByErased" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:#123456; filter:opacity(0)"></div>
      </div>
      <!-- ROUND 92 P2 — an opaque CHILD inside a transparent wrapper.
           Opacity does not inherit, so the child reports 1 while the
           wrapper erases the whole overlay: stopping at the first opaque
           element accepted a paint that is not on screen. -->
      <div class="body" id="coveredByOpaqueChildOfGhost" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; opacity:0">
          <div style="position:absolute; inset:0; background:#123456"></div>
        </div>
      </div>
      <!-- And the same shape where the wrapper paints nothing but does not
           erase: the child genuinely covers, so this one is condemned. -->
      <div class="body" id="coveredByOpaqueChild" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0">
          <div style="position:absolute; inset:0; background:#123456"></div>
        </div>
      </div>
      <!-- ROUND 95 P2 — an opaque backdrop UNDER a transparent catcher.
           This is the ordinary modal: a backdrop that paints, and a
           full-size click-catcher above it. Hit-testing returns only the
           topmost element, so reading the catcher alone found no paint and
           declared the text visible while the backdrop hid it. The catcher
           guard and this one pull in opposite directions on purpose, which
           is why both fixtures sit here. -->
      <div class="body" id="coveredUnderCatcher" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:#123456"></div>
        <div style="position:absolute; inset:0"></div>
      </div>
      <!-- And the control that keeps the deeper search from over-reaching:
           the same two layers with the backdrop erased. Looking past the
           catcher must not turn a ghost into a cover. -->
      <div class="body" id="catcherOverGhost" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:#123456; opacity:0"></div>
        <div style="position:absolute; inset:0"></div>
      </div>
      <!-- ROUND 96 P2 — three COLLINEAR probes (the centre and the two
           opposite corners) were all that decided total occlusion, so three
           small covers sitting on that line discarded a sentence the lender
           can plainly read. The covers are placed BY SCRIPT below, at the
           exact points the old sampling used — a hand-drawn diagonal band
           was tried first and passed under the old rule, which made it a
           fixture that proved nothing rather than a guard. -->
      <div class="body" id="oldProbePoints" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
      </div>
      <!-- SELF-REVIEW OF THE OCCLUSION RULE — the page body carries an
           opaque background, as a real stylesheet almost always does. The
           walk from a hit stops at the first element containing the text,
           so body is never reached and never read as a cover. Invert that
           ordering and every foreign hit reads as covered: this fixture is
           what fails if anyone does. -->
      <div class="body" id="onOpaquePage" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
      </div>
      <!-- The control that keeps the rule narrow: below the fold is
           painted, and must stay admitted. -->
      <div class="body" id="belowFold">
        <p style="position:relative; top:4000px">This loan can be closed out now.</p>
      </div>
      <!-- ROUND 79 P2 — flex and grid ITEMS are blockified, so their
           computed display reads as block while they sit side by side on
           one rendered row. Inserting a break here stopped the ticker
           qualifying the number beside it and let a visible
           unsubstantiated amount pass. -->
      <div class="body" id="flexRow" style="display:flex; gap:4px">
        <span style="display:block">Loan 100</span>
        <span style="display:block">USDC principal</span>
      </div>
      <div class="body" id="gridRow" style="display:grid; grid-template-columns:auto auto; gap:4px">
        <span style="display:block">Loan 100</span>
        <span style="display:block">USDC principal</span>
      </div>
      <!-- A COLUMN flex really is two lines, which a parent-display test
           would have got wrong and geometry gets right. -->
      <div class="body" id="flexColumn" style="display:flex; flex-direction:column">
        <span style="display:block">Wait 3 days</span>
        <span style="display:block">USDC is returned later</span>
      </div>
      <!-- ROUND 75 P2 — a transparent FILL is not the only way glyphs get
           painted: a text-shadow draws them, and so does a paint-order
           stroke. Condemning either accuses copy the lender can read. -->
      <div class="body" id="shadowPainted">
        <p style="color: transparent; text-shadow: 0 0 0 #111">This loan can be closed out now.</p>
      </div>
      <div class="body" id="strokePainted">
        <p style="color: transparent; -webkit-text-stroke: 1px #111">This loan can be closed out now.</p>
      </div>
      <div class="body" id="noShadow">
        <p style="color: transparent; text-shadow: none">This loan can be closed out now.</p>
      </div>
    </div>
  `);

  const result = await page.evaluate(
    ([clip, paint, vis, leaf]) => {
      const scope = new Function(
        `${clip}\n${paint}\n${vis}\nconst visible = (n) => shownBox(n) && paintsText(n);\n${leaf}\nreturn { visible, shownBox, visibleTextOf };`,
      )() as {
        visible: (n: Element | null) => boolean;
        shownBox: (n: Element | null) => boolean;
        visibleTextOf: (r: Element | null) => string;
      };
      const byId = (id: string) => document.getElementById(id)!;
      // Read a fixture's painted text with it SCROLLED INTO VIEW.
      //
      // Occlusion is a viewport question: hit-testing cannot reach a point
      // outside the viewport, and the rule deliberately skips those rather
      // than counting them as covered. On a fixture page this long the
      // element's POSITION would otherwise decide the verdict — a case
      // added above another could silently flip it to passing for the
      // wrong reason, and a new one landing below the fold failed for that
      // rather than for the rule under test.
      const seenScrolled = (el: Element) => {
        el.scrollIntoView({ block: 'center' });
        const text = scope.visibleTextOf(el);
        window.scrollTo(0, 0);
        return text;
      };
      // EXACTLY the expression the drive assigns to `bodyVisible` — and
      // it is `shownBox`, not `visible`, since round 66: a container
      // whose own text is transparent still SHOWS a repainted child, and
      // the text rule below is what decides whether anything is readable.
      const bodyVisible = (b: Element | null) =>
        scope.shownBox(b) &&
        (((b as HTMLElement | null)?.innerText ?? '').trim() === '' ||
          scope.visibleTextOf(b) !== '');
      return {
        plain: bodyVisible(byId('plain')),
        ownText: bodyVisible(byId('ownText')),
        transparent: bodyVisible(byId('transparent')),
        erased: bodyVisible(byId('erased')),
        clipped: bodyVisible(byId('clipped')),
        empty: bodyVisible(byId('empty')),
        styleOnly: bodyVisible(byId('styleOnly')),
        styleBeside: bodyVisible(byId('styleBeside')),
        styleLeafText: scope.visibleTextOf(byId('styleOnly')),
        // ROUND 62 P2 — THE RESIDUAL ROUND 61 LEFT, closed.
        //
        // Two leaves, the RECOGNISED sentence erased and a secondary
        // note painted. Round 61's "at least one visible leaf" passed
        // this while the lender read nothing justifying the button.
        // THE ROOT'S OWN TEXT, erased at the root's own level. The walk
        // judges only the elements it DESCENDS INTO, so without a root
        // check the sentence would be collected as painted.
        rootErasedPaintedText: scope.visibleTextOf(byId('rootErased')),
        repaintedChildVisible: bodyVisible(byId('repaintedChild')),
        repaintedChildPaintedText: scope.visibleTextOf(byId('repaintedChild')),
        rootErasedInnerText: (byId('rootErased') as HTMLElement).innerText.trim(),
        twoLeavesVisible: bodyVisible(byId('twoLeaves')),
        twoLeavesPaintedText: scope.visibleTextOf(byId('twoLeaves')),
        twoLeavesInnerText: (byId('twoLeaves') as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
        // The TEXT RULE's own answer for the empty body, separated from
        // the predicate's. See the assertion for why the split matters.
        emptyTextRule: (() => {
          const b = byId('empty') as HTMLElement;
          return (b.innerText ?? '').trim() === '' || scope.visibleTextOf(b) !== '';
        })(),
        withSrOnly: bodyVisible(byId('withSrOnly')),
        // ROUND 74 P2 — rendered line boundaries survive, inline runs do
        // not gain one.
        twoLinesPaintedText: scope.visibleTextOf(byId('twoLines')),
        offLeftPaintedText: scope.visibleTextOf(byId('offLeft')),
        indentedOutPaintedText: scope.visibleTextOf(byId('indentedOut')),
        indentedShortLabelPaintedText: scope.visibleTextOf(byId('indentedShortLabel')),
        // OCCLUSION IS A VIEWPORT QUESTION, so these readings scroll their
        // fixture into view first. Hit-testing cannot reach a point outside
        // the viewport — the rule deliberately skips those rather than
        // counting them as covered — so on a page this long the fixture's
        // POSITION would otherwise decide the verdict, and a case added
        // above one of these would silently flip it to passing for the
        // wrong reason. Found by a new fixture landing below the fold and
        // failing for that reason rather than for the rule under test.
        //
        // Written out one key at a time rather than built from a list: a
        // computed spread types as `{}` and every assertion below then
        // fails to compile, which is how this reached CI once already.
        occludedSeen: seenScrolled(byId('occluded')),
        catcherSeen: seenScrolled(byId('catcher')),
        halfCoveredSeen: seenScrolled(byId('halfCovered')),
        occludedNoPointerSeen: seenScrolled(byId('occludedNoPointer')),
        onOpaquePageSeen: seenScrolled(byId('onOpaquePage')),
        coveredByChildSeen: seenScrolled(byId('coveredByChild')),
        coveredByModernColorSeen: seenScrolled(byId('coveredByModernColor')),
        coveredByGhostSeen: seenScrolled(byId('coveredByGhost')),
        coveredByErasedSeen: seenScrolled(byId('coveredByErased')),
        coveredByOpaqueChildOfGhostSeen: seenScrolled(byId('coveredByOpaqueChildOfGhost')),
        coveredByOpaqueChildSeen: seenScrolled(byId('coveredByOpaqueChild')),
        coveredUnderCatcherSeen: seenScrolled(byId('coveredUnderCatcher')),
        catcherOverGhostSeen: seenScrolled(byId('catcherOverGhost')),
        oldProbePointsSeen: (() => {
          // Cover EXACTLY the three points the pre-round-96 sampling used:
          // the centre of the glyph rectangle and its two opposite corners.
          // Measured from the text node's own `Range`, the same rectangle
          // the predicate measures, rather than from the element box — a
          // left-aligned line is narrower than its container, so element
          // corners are not the points that were probed.
          const host = byId('oldProbePoints');
          const text = host.querySelector('p')!.firstChild!;
          const range = document.createRange();
          range.selectNodeContents(text);
          const q = range.getClientRects()[0];
          const at: Array<[number, number]> = [
            [q.left + q.width / 2, q.top + q.height / 2],
            [q.left + 1, q.top + 1],
            [q.right - 1, q.bottom - 1],
          ];
          const dots = at.map(([x, y]) => {
            const d = document.createElement('div');
            d.style.cssText =
              `position:absolute; width:7px; height:7px; background:#123456;` +
              `left:${x + window.scrollX - 3}px; top:${y + window.scrollY - 3}px;`;
            document.body.appendChild(d);
            return d;
          });
          const seen = seenScrolled(host);
          dots.forEach((d) => d.remove());
          return seen;
        })(),

        hangingIndentPaintedText: scope.visibleTextOf(byId('hangingIndent')),
        belowFoldPaintedText: scope.visibleTextOf(byId('belowFold')),
        flexRowPaintedText: scope.visibleTextOf(byId('flexRow')),
        gridRowPaintedText: scope.visibleTextOf(byId('gridRow')),
        flexColumnPaintedText: scope.visibleTextOf(byId('flexColumn')),
        shadowPaintedText: scope.visibleTextOf(byId('shadowPainted')),
        strokePaintedText: scope.visibleTextOf(byId('strokePainted')),
        noShadowPaintedText: scope.visibleTextOf(byId('noShadow')),
        inlineSplitPaintedText: scope.visibleTextOf(byId('inlineSplit')),
        withBreakPaintedText: scope.visibleTextOf(byId('withBreak')),
        // The hole itself, recorded rather than assumed: each wrapper
        // still passes the predicate on its own. If one of these ever
        // reads false the leaf rule is no longer what is being tested.
        wrapperLooksVisible: {
          transparent: scope.visible(byId('transparent')),
          erased: scope.visible(byId('erased')),
          clipped: scope.visible(byId('clipped')),
        },
        // The body's DOM text survives every erasure, which is what made
        // the wrong answer look right.
        textStillReadable: (byId('transparent') as HTMLElement).innerText.trim().length > 0,
      };
    },
    [clipSrc, paintSrc, visSrc, leafSrc] as const,
  );

  expect(result.plain, 'a readable explanation in a child').toBe(true);
  expect(result.ownText, 'a readable explanation as the body’s own text').toBe(true);
  expect(result.transparent, 'an explanation painted in nothing').toBe(false);
  expect(result.erased, 'an explanation under a zero-opacity filter').toBe(false);
  expect(result.clipped, 'an explanation clipped away').toBe(false);
  // AN EMPTY BODY, and this assertion was written the other way round
  // and failed — which is the useful outcome, because the reasoning
  // behind it was wrong in a way worth keeping.
  //
  // The worry was that the leaf rule would newly condemn an empty body
  // as "not visible" when the verdict has its own, more accurate arm for
  // one that rendered nothing. It cannot: an empty body has a zero-height
  // rect, so `visible` has ALWAYS returned false for it and the verdict
  // has always reached that arm the same way. The guard is still right
  // to be there — it is what keeps the leaf rule from becoming a SECOND
  // route to the same mis-naming if the body ever has height without
  // text — and this pair of assertions is what says so: the predicate
  // rejects it, the leaf rule does not.
  expect(result.empty, 'an empty body is rejected — by geometry').toBe(false);
  expect(result.emptyTextRule, 'not by the text rule, which abstains').toBe(true);
  // `some`, not `every`: a screen-reader-only span is correct,
  // accessible markup and is clipped by design. `every` would fail a
  // card for having one, which is the false-FAIL direction.
  expect(result.withSrOnly, 'a readable explanation beside an sr-only span').toBe(true);

  // A `<style>` HOLDS TEXT AND PAINTS NONE, and `innerText` — which is
  // what `bodyText` reads — already skips it, so counting it as a leaf
  // would make the two disagree about what the body says.
  //
  // AND THIS ASSERTION WAS WRITTEN TOO STRONGLY, then failed, which is
  // the second time in this one test that a dramatic justification did
  // not survive contact with the layout engine. The claim was that a
  // `<style>`-only body would FAIL for markup nobody can see. It does
  // read false — but on GEOMETRY, exactly like the empty body above: a
  // `<style>` is `display: none`, so the wrapper has no height and
  // `visible` rejects it before the leaf rule is consulted. The leaf
  // count is what actually demonstrates the exclusion, and the
  // exclusion is defence in depth rather than a live defect: it stops
  // the rule CONTRIBUTING a false FAIL if such a body ever gains height
  // from something else.
  expect(result.styleLeafText, 'a <style> contributes no painted text').toBe('');

  // ROUND 62 P2 — and the point of reporting TEXT rather than a verdict.
  //
  // The body still counts as visible, correctly: something in it IS
  // painted, so "the lender sees a heading and no reason" would be the
  // wrong accusation. What changes is the string the verdict recognises
  // the card's state from — the erased sentence is simply not in it, so
  // it can no longer substantiate the action it was supposed to justify.
  // `innerText` still yields it, which is exactly the disagreement the
  // finding is about.
  expect(result.rootErasedPaintedText, 'text erased at the root’s own level').toBe('');

  // ROUND 66 P2 — AND A DESCENDANT THAT REPAINTS ITSELF SURVIVES.
  //
  // This is the defect the round-65 self-review introduced: gating the
  // whole traversal on `visible(root)` meant a container with
  // transparent OWN text discarded a painted child with it, and the
  // verdict then reported a product failure on a card whose explanation
  // is on screen. `paintsText` deliberately judges only an element's own
  // text, because `color` inherits — so the box and the text are two
  // questions and had been collapsed into one.
  expect(result.repaintedChildVisible, 'the body is readable').toBe(true);
  expect(result.repaintedChildPaintedText, 'the repainted sentence is carried').toBe(
    'This loan can be closed out now.',
  );
  expect(
    result.repaintedChildPaintedText,
    'and the transparent filler beside it is not',
  ).not.toContain('hidden filler');
  expect(result.rootErasedInnerText, 'which innerText still yields').toBe(
    'This loan can be closed out now.',
  );

  expect(result.twoLeavesVisible, 'something in the body is painted').toBe(true);
  expect(result.twoLeavesPaintedText, 'but not the sentence').toBe(
    'You can change your mind until you confirm.',
  );
  expect(result.twoLeavesInnerText, 'which innerText still reports').toBe(
    'This loan can be closed out now. You can change your mind until you confirm.',
  );
  expect(result.styleOnly, 'rejected by geometry, not by the leaf rule').toBe(false);
  expect(result.styleBeside, 'a readable explanation beside a <style>').toBe(true);

  expect(result.wrapperLooksVisible.transparent).toBe(true);
  expect(result.wrapperLooksVisible.erased).toBe(true);
  expect(result.wrapperLooksVisible.clipped).toBe(true);
  expect(result.textStillReadable).toBe(true);

  // ROUND 74 P2 — THE BOUNDARY RULE, both directions.
  //
  // `innerText` puts a newline between rendered blocks and round 24 made
  // that newline a clause boundary the amount scanner relies on. Joining
  // every painted run with nothing deleted it, so `Wait 3 days` above
  // `USDC is returned later` read as one clause and produced an observed
  // funds FAIL on correct copy. The opposite rule still holds inside a
  // line: an inline split must not gain a separator, or `<b>Loan</b>s`
  // becomes `Loan s` and stops matching shipped copy with `includes`.
  expect(result.twoLinesPaintedText, 'two rows stay two clauses').toBe(
    'Wait 3 days\nUSDC is returned later',
  );
  expect(result.inlineSplitPaintedText, 'an inline split gains nothing').toBe(
    'Loans are closed out',
  );
  expect(result.withBreakPaintedText, 'a <br> breaks the line').toBe(
    'Wait 3 days\nUSDC is returned later',
  );

  // ROUND 79 P2 — adjacency comes from GEOMETRY, not the child's display.
  //
  // Flex and grid items are blockified, so a display-based rule inserted
  // a clause boundary between two halves of one rendered row — which is
  // how a visible unsubstantiated amount could pass, the ticker no longer
  // sitting in the same clause as the number. The column case is the
  // control: it IS two lines, and a parent-display test would have called
  // it one.
  // The separating SPACE is the markup's own indentation, collapsed the
  // way the browser collapses it — not a break. Before round 79 that
  // whitespace carried the source's newlines straight through, so how the
  // HTML happened to be typed decided where a clause ended.
  expect(result.flexRowPaintedText, 'a flex row is one clause').toBe(
    'Loan 100 USDC principal',
  );
  expect(result.gridRowPaintedText, 'and so is a grid row').toBe(
    'Loan 100 USDC principal',
  );
  expect(result.flexColumnPaintedText, 'but a column really is two lines').toBe(
    'Wait 3 days\nUSDC is returned later',
  );

  // ROUND 75 P2 — glyphs painted by something other than the fill.
  //
  // `color: transparent` with a shadow or a stroke puts the words on
  // screen, and calling them erased accuses copy the lender can read —
  // the direction the unparseable-colour branch already refuses. The
  // check declines rather than adjudicating: no attempt is made to
  // decide whether the shadow is offset clear of the glyphs or matches
  // the background, because that is the contrast judgement this file
  // does not make.
  expect(result.shadowPaintedText, 'a text-shadow paints the glyphs').toContain(
    'closed out now',
  );
  expect(result.strokePaintedText, 'a paint-order stroke does too').toContain(
    'closed out now',
  );
  expect(result.noShadowPaintedText, 'and a transparent fill alone is still erased').toBe('');

  // ROUND 81 P2 — parked outside the document is not painted; below the
  // fold is. The second assertion is what keeps the rule from condemning
  // copy the lender can scroll to.
  expect(result.offLeftPaintedText, 'an off-screen sentence is not painted').toBe('');
  expect(result.belowFoldPaintedText, 'but below the fold still is').toContain(
    'closed out now',
  );

  // SELF-REVIEW AFTER ROUND 81 — found by probing the predicate with the
  // hiding patterns it did NOT already cover, rather than waiting to be
  // told. The indent moves the line without moving the box, so every
  // geometric test still says yes.
  expect(result.indentedOutPaintedText, 'a line indented out of its box is not painted').toBe(
    '',
  );
  expect(result.hangingIndentPaintedText, 'but ordinary hanging indent is').toContain(
    'closed out now',
  );

  // ROUND 82 P2 — and the hole that self-review's own patch left. Sizing
  // the rule on the ELEMENT ("a negative indent at least as wide as the
  // box") passes any short label in a wide container, which is the
  // ordinary shape of a status word inside a card. Measuring where the
  // GLYPHS landed asks the question directly and does not consult the
  // width at all.
  expect(
    result.indentedShortLabelPaintedText,
    'a short label indented out of a wide box is not painted either',
  ).toBe('');

  // ROUND 89 P2 — the last door in the present-but-invisible class, and the
  // three controls that keep it from swinging the other way.
  expect(result.occludedSeen, 'text under an opaque cover is not painted').toBe('');
  expect(
    result.catcherSeen,
    'but a transparent click-catcher hides nothing and must not condemn it',
  ).toContain('closed out now');
  expect(
    result.halfCoveredSeen,
    'and a partial cover leaves the text readable',
  ).toContain('closed out now');
  // The stated residual, pinned as a KNOWN limit rather than left to be
  // discovered: hit-testing cannot see a cover that takes no pointer events,
  // so this one is missed. Asserted so that closing it later is a deliberate
  // change to a recorded behaviour.
  expect(
    result.occludedNoPointerSeen,
    'an opaque cover that takes no pointer events is a KNOWN miss',
  ).toContain('closed out now');
  expect(
    result.onOpaquePageSeen,
    'ordinary copy on a page with an opaque background is still painted',
  ).toContain('closed out now');

  // ROUND 90 P2 — two ways the first version of the cover test could be
  // walked past: a cover that BELONGS to the text it hides, and one
  // painted in a colour notation an rgba-only parser cannot read.
  expect(
    result.coveredByChildSeen,
    'a descendant laid over its parent text is still a cover',
  ).toBe('');
  expect(
    result.coveredByModernColorSeen,
    'and an opaque cover in a modern colour form is one too',
  ).toBe('');

  // ROUND 91 P2 — the other direction, and the one that matters more: a
  // cover that is itself invisible hides nothing, and condemning the text
  // under it would be a false FAIL on copy the lender can plainly read.
  expect(
    result.coveredByGhostSeen,
    'an opaque background at zero opacity covers nothing',
  ).toContain('closed out now');
  expect(
    result.coveredByErasedSeen,
    'nor does one erased by a filter',
  ).toContain('closed out now');

  // ROUND 92 P2 — opacity does not INHERIT, so the first opaque element
  // found is not the end of the question: an opaque child inside a wrapper
  // at zero opacity paints nothing at all.
  expect(
    result.coveredByOpaqueChildOfGhostSeen,
    'an opaque child inside an erased wrapper covers nothing',
  ).toContain('closed out now');
  expect(
    result.coveredByOpaqueChildSeen,
    'but the same child under an ordinary wrapper does cover',
  ).toBe('');

  // ROUND 95 P2 — the topmost element is not the only one in front of the
  // text. A transparent catcher over an opaque backdrop is the ordinary
  // modal, and reading only the catcher kept hidden copy in the reading.
  expect(
    result.coveredUnderCatcherSeen,
    'an opaque backdrop below a transparent catcher still covers',
  ).toBe('');
  expect(
    result.catcherOverGhostSeen,
    'but looking past the catcher must not turn a ghost into a cover',
  ).toContain('closed out now');

  // ROUND 96 P2 — occlusion must be TOTAL, and three collinear probes
  // cannot establish that. Three small covers on the centre and the two
  // opposite corners satisfied every probe the old sampling took, and the
  // whole sentence was discarded while most of it was plainly readable: a
  // false FAIL on legible funds copy, the one direction this predicate must
  // never take.
  expect(
    result.oldProbePointsSeen,
    'three dots on the old probe points do not hide the sentence',
  ).toContain('closed out now');
});
