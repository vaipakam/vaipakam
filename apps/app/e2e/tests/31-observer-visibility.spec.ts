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
 *    - the predicate existed in TWO copies (one per `page.evaluate` body,
 *      which cannot share a Node-side closure) and they had already
 *      drifted before anyone noticed. #2102 unified them: the family now
 *      lives in `e2e/live/visibility.mjs` and every consumer in the drive
 *      composes it through `withVisibility`, so "both copies agree" is no
 *      longer a property to pin — there is one copy. What this file pins
 *      instead is that the drive defines NONE of it inline.
 *
 *  The predicate is the PRODUCTION definition, imported from that module
 *  and run in the page, rather than re-implemented here. A paraphrase
 *  would test the paraphrase, which is the mistake this file is guarding
 *  against in the first place. The one helper still sliced out of the
 *  drive's source is `rowShown`, the receipt-row rule, which is defined
 *  once at its only site.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISIBILITY_SOURCE } from '../live/visibility.mjs';

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

test('the drive visibility predicate rejects clipped, erased and unreachable content', async ({
  page,
}) => {
  // #2102 — ONE definition, imported. The census of copies and the drift
  // assertions that lived here guarded a duplication that no longer
  // exists; what is guarded now is that it cannot come back: the drive
  // defines no helper of the family inline, and composes the module in.
  const src = fs.readFileSync(DRIVE, 'utf8');
  expect(src, 'the drive defines no visibility helper inline').not.toMatch(
    /const (notClipped|paintsText|shownBox|visibleTextOf) = \((node|root)\) => \{/,
  );
  expect(src, 'the drive composes the module in').toContain(
    "import { withVisibility } from './visibility.mjs';",
  );
  const predicates = [VISIBILITY_SOURCE];

  await page.setContent(`
    <!-- #2138 — FIRST in the document on purpose. An inner scroll
         container at the top of the page, scrolled down by 300, carries
         its first row to a NEGATIVE viewport rect while window.scrollY is
         still 0. A bare document-origin test condemned that row; the
         lender can scroll the container straight back to it. Placed
         first so the container really does sit near the origin —
         further down the page the row's document coordinates would stay
         positive and the case would test nothing. -->
    <div id="innerScroller" style="height:40px; overflow:auto; margin:0">
      <p id="scrolledAbove" style="height:20px; margin:0">scrolled above an inner slit, reachable</p>
      <!-- Parked far above inside the SAME scrolled container: the
           container's 300 of scroll cannot carry -9999 back, so the
           exemption must not become a blanket one. -->
      <p id="parkedInScroller" style="position:absolute; top:-9999px; margin:0">This loan can be closed out now.</p>
      <p style="height:400px; margin:0">filler</p>
    </div>
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

  for (const predicate of predicates) {
    const result = await page.evaluate(
      (helpersSrc) => {
        // The production family, instantiated in the page exactly as the
        // drive's composition does it.
        const visible = new Function(`return (${helpersSrc})();`)().visible as (
          n: Element | null,
        ) => boolean;
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
          // #2138 — the container is scrolled HERE, inside the page, so
          // the row's rect is negative while window.scrollY is 0; the
          // measurement the issue records, reproduced rather than assumed.
          ...(() => {
            const scroller = byId('innerScroller')!;
            scroller.scrollTop = 300;
            const row = byId('scrolledAbove')!.getBoundingClientRect();
            return {
              scrolledAboveRectTop: row.top,
              scrolledAbovePageScrollY: window.scrollY,
              scrolledAbove: visible(byId('scrolledAbove')),
              parkedInScroller: visible(byId('parkedInScroller')),
            };
          })(),
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
      predicate,
    );

    expect(result.usesCheckVisibility, 'the engine exposes checkVisibility').toBe(
      true,
    );
    // A collapsed clipping ancestor paints nothing, while every
    // descendant keeps a full-size layout box and `innerText` keeps
    // yielding its text. Neither `checkVisibility` nor a rect test sees
    // this on its own.
    expect(result.clipped, `content inside height:0/overflow:hidden`).toBe(
      false,
    );
    // A clipper does not have to be exactly zero to hide everything.
    // `height: 1px` leaves the ancestor non-zero, so the collapsed rule
    // passed it while the lender saw one pixel of a loss disclosure.
    expect(result.slivered, `content inside height:1px/overflow:hidden`).toBe(
      false,
    );
    // `checkVisibility` says nothing about colour, and neither did any
    // geometry test — so `color: transparent` left every receipt value
    // laid out, measurable and readable through `innerText` while the
    // lender saw nothing.
    expect(result.transparentLeaf, `a dd painted in transparent`).toBe(false);
    expect(result.transparentWrapper, `a wrapper with no own text`).toBe(true);
    expect(result.repaintedChild, `a child that repaints itself`).toBe(true);
    expect(result.plain, `ordinary content`).toBe(true);
    // The other end of the same rule, pinned so the threshold cannot be
    // tightened into a false failure: a row clipped by a single pixel is
    // still a row the lender can read.
    expect(result.trimmed, `clipped by one pixel`).toBe(true);
    // Half of a TWO-LINE leaf surviving is not the leaf being readable:
    // it is one whole line on screen and one whole line gone, and
    // `innerText` yields both. The element-level ratio accepted this at
    // exactly 50%; the per-line rule does not.
    expect(result.twoLines, `a two-line value with line two clipped`).toBe(
      false,
    );
    // THE LIMIT OF THE PER-LINE RULE, and a correction to my own first
    // version of it. `selectNodeContents` on a CONTAINER yields a rect
    // per line of its whole subtree, so an unscoped rule condemns the
    // entire card whenever any one descendant line is mostly clipped —
    // and the verdict that follows says "card is in the DOM but not
    // visible", which is the wrong sentence about a card largely on
    // screen. Leaves are checked individually anyway.
    expect(result.cardish, `a container whose last row is clipped`).toBe(true);
    expect(result.selfClipped, `a dd clipping its own text`).toBe(false);
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
      `absolute, pushed outside its own containing block`,
    ).toBe(false);
    expect(result.absInside, `absolute, inside its containing block`).toBe(true);
    expect(
      result.absUnderStatic,
      `a STATIC overflow ancestor is not an absolute box's containing block`,
    ).toBe(true);
    expect(
      result.fixedUnderPositioned,
      `a merely positioned ancestor does not capture a FIXED box`,
    ).toBe(true);
    expect(
      result.selfClippedAbs,
      `a POSITIONED dd clipping its own text`,
    ).toBe(false);
    // The deliberate limit of the rule, pinned so it cannot be tightened
    // by accident: content merely scrolled out of a scroll container is
    // reachable, and condemning it would be a false failure — the
    // direction that gets a check switched off.
    expect(result.scrolledOut, `scrolled out of a scroller`).toBe(true);
    // #2138 — and scrolled ABOVE an inner scroller's slit is the same
    // reachability, arriving through a negative rect the page's own
    // scroll offset does not explain. The two geometry reads guard the
    // guard: if the row's rect were not negative, or the page had
    // scrolled, the case would be passing without testing the rule.
    expect(result.scrolledAboveRectTop, 'the row sits above the viewport').toBeLessThan(0);
    expect(result.scrolledAbovePageScrollY, 'and the page itself has not scrolled').toBe(0);
    expect(result.scrolledAbove, `scrolled above an inner scroller's slit`).toBe(true);
    // The exemption is quantified by the container's own scroll offset,
    // not granted to everything under a scrolled container.
    expect(result.parkedInScroller, `parked at -9999px inside that scroller`).toBe(false);
    // ROUND 48 P2 — `clip-path: inset(50%)` is the modern
    // visually-hidden idiom, and every other test in this predicate
    // vouches for it: the box is full size, `checkVisibility` is
    // positive, there is no overflow to walk and the colour is opaque,
    // while nothing is painted and `innerText` yields every word.
    expect(result.clipPathLeaf, `a dt under clip-path: inset(50%)`).toBe(false);
    expect(result.clipPathPct, `a dd clipped past collapse in %`).toBe(false);
    expect(result.clipPathPx, `a dd clipped to nothing in px`).toBe(false);
    expect(
      result.underClippedAncestor,
      `content under an emptied clip region`,
    ).toBe(false);
    // The deliberate limits, pinned in the direction that matters more.
    // A partial inset is ordinary decorative clipping; `round` describes
    // corners, not extent; and a `circle()` — even an empty one — is a
    // geometry question this predicate does not attempt, so it counts as
    // painted. The residual is a missed defect, never an invented one.
    expect(result.clipPathPartial, `a partial inset`).toBe(true);
    expect(result.clipPathRounded, `an inset with a corner radius`).toBe(true);
    expect(result.clipPathCircle, `a shape function, not judged`).toBe(true);
    // ROUND 51 P2 — `filter: opacity(0)` paints nothing while every
    // other signal stays green, and it is checked on the same ancestor
    // walk as `opacity` because a filter applies to the subtree the same
    // way.
    expect(result.filterLeaf, `a dt under filter: opacity(0)`).toBe(false);
    expect(result.filterPct, `the same stated as a percentage`).toBe(false);
    expect(result.filterChain, `zero opacity inside a filter chain`).toBe(false);
    expect(result.underFilter, `content under an erased ancestor`).toBe(false);
    // The limits, pinned in the direction that matters more: a partial
    // opacity is a deliberate design choice, and a filter this cannot
    // reason about counts as painted.
    expect(result.filterPartial, `filter: opacity(0.4)`).toBe(true);
    expect(result.filterOther, `a filter that is not opacity`).toBe(true);
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
    (helpersSrc) => {
      // The whole family at once — there is no subset to inject and no
      // dependency order to get wrong (#2102).
      const visible = new Function(`return (${helpersSrc})();`)().visible as (
        n: Element | null,
      ) => boolean;
      const all = [...document.querySelectorAll('[data-testid="forced-close-card"]')];
      const shown = all.filter(visible);
      return all.indexOf(shown[0]);
    },
    VISIBILITY_SOURCE,
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
  // ROUND 62 P2 — `hasText` is GONE. It asked `innerText` of the
  // `dt`/`dd` WRAPPER, and `visible` on a wrapper is deliberately
  // lenient, so a label in a transparent child passed both. Replaced by
  // `visibleTextOf`, which collects only the text whose element chain is
  // visible — imported from the module since #2102.
  const rowSrc = arrowBlocks(src, 'rowShown', 'row')[0];

  // One `rowShown` — its only site — and NO inline `visibleTextOf` (#2102).
  // If either changes this test is describing a shape that no longer
  // exists.
  expect(arrowBlocks(src, 'rowShown', 'row')).toHaveLength(1);
  expect(arrowBlocks(src, 'visibleTextOf', 'root')).toHaveLength(0);
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
    ([helpersSrc, row]) => {
      const scope = new Function(
        `const { visible, visibleTextOf } = (${helpersSrc})();\n${row}\nreturn { rowShown, visible, visibleTextOf };`,
      )() as {
        rowShown: (r: Element) => boolean;
        visible: (n: Element | null) => boolean;
        // The unresolved-generated-content signal rides on the function
        // rather than the return value, so the signature stays a string
        // for its twenty call sites (round 116).
        visibleTextOf: ((r: Element | null) => string) & {
          sawUnresolvedGenerated?: boolean;
        };
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
    [VISIBILITY_SOURCE, rowSrc] as const,
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
  // ROUND 62 P2 — `textLeavesOf` became `visibleTextOf`. "At least one
  // visible leaf" accepted an unrelated leaf while the sentence the
  // verdict MATCHES was erased; reporting the painted TEXT and
  // recognising state from that binds the check to the copy that
  // governs the action.
  //
  // Imported from the module since #2102; the drive carries no copy.
  expect(arrowBlocks(src, 'visibleTextOf', 'root')).toHaveLength(0);
  expect(arrowBlocks(src, 'textLeavesOf', 'root'), 'replaced').toHaveLength(0);

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
      <!-- ROUND 100 P2 — a HALF-transparent filter is not a cover either.
           filter:opacity(.5) leaves the computed opacity at 1, so the
           zero-only regex did not match and an opaque background behind it
           counted as solid — while the lender reads the sentence straight
           through. The element-opacity test already rejected anything
           below 1; this one only rejected exactly zero.
           (No backticks in here: this block is inside a template literal,
           and putting one in has broken spec discovery four times now.) -->
      <div class="body" id="coveredByHalfFilter" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:#123456; filter:opacity(.5)"></div>
      </div>
      <!-- ROUND 115 P2 — A CLIPPING ANCESTOR ABOVE THE CONTAINING BLOCK.
           The leaf is absolutely positioned, so the walk skips ancestors
           until it reaches its containing block. That containing block is
           positioned but its own overflow is VISIBLE, and the fast path
           for visible overflow used to run before the containing-block
           state was recorded — so the block was skipped without being
           marked, and the static ancestor above it with overflow:hidden
           was then mistaken for one below it and skipped too. That
           ancestor really does clip the leaf, and the sentence is not on
           screen at all.
           (No backticks in here: this block is inside a template literal,
           and putting one in has broken spec discovery four times now.) -->
      <div id="clippedAboveCB" style="width:320px; height:20px; overflow:hidden">
        <div style="position:relative; overflow:visible; width:320px">
          <p class="body" id="clippedAboveCBLeaf"
             style="position:absolute; top:400px; margin:0">This loan can be closed out now.</p>
        </div>
      </div>
      <!-- ROUND 111 P2 — CSS-GENERATED TEXT IS TEXT THE LENDER READS.
           A stylesheet regression adding content to ::after paints an
           amount on screen that appears in no childNodes, so the walk
           could not see it and the funds scan certified the card clean.
           The styled-away sibling is the control: a pseudo can be hidden
           independently of its owner, and inventing text from one that
           paints nothing would be the opposite error.
           (No backticks in here: this block is inside a template literal,
           and putting one in has broken spec discovery four times now.) -->
      <style>
        #generatedAmount::after { content: "100 USDC"; }
        #generatedHidden::after { content: "250 WETH"; visibility: hidden; }
        #generatedCounter::after { content: counter(page); }
        #generatedAttr::after { content: attr(data-amount) " USDC"; }
        #generatedMixed::after { content: counter(page) " USDC"; }
      </style>
      <div class="body" id="generatedAmount" style="width:320px"><span>Close-out</span></div>
      <div class="body" id="generatedHidden" style="width:320px"><span>Close-out</span></div>
      <div class="body" id="generatedCounter" style="width:320px"><span>Close-out</span></div>
      <div class="body" id="generatedAttr" data-amount="100" style="width:320px"><span>Close-out</span></div>
      <div class="body" id="generatedMixed" style="width:320px"><span>Close-out</span></div>
      <!-- The percentage spelling of the same thing. -->
      <div class="body" id="coveredByPercentFilter" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:#123456; filter:opacity(50%)"></div>
      </div>
      <!-- And the control: a FULLY opaque filter still covers, so widening
           the test from zero to below-one must not disarm it. -->
      <div class="body" id="coveredByFullFilter" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <div style="position:absolute; inset:0; background:#123456; filter:opacity(1)"></div>
      </div>
      <!-- ROUND 97 P2 — a REPLACED element is not automatically a cover.
           A fully transparent 1x1 PNG stretched over the row reports
           opacity 1 and is what hit-testing returns, and the old tag test
           counted any img/video/canvas/svg as painting — so decorative
           artwork discarded readable copy. Nothing cheap can tell whether
           its pixels are opaque (naturalWidth says it loaded; reading the
           pixels back taints on a cross-origin image), so undecidable
           counts as NOT covering, as everywhere else here. -->
      <div class="body" id="coveredByGhostImage" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <img alt="" style="position:absolute; inset:0; width:100%; height:100%" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
      </div>
      <!-- And the same element carrying an opaque BACKGROUND is still a
           cover: the background test never depended on the tag, so removing
           the tag shortcut must not take this with it. -->
      <div class="body" id="coveredByPaintedImage" style="position:relative; width:320px">
        <p style="margin:0">This loan can be closed out now.</p>
        <img alt="" style="position:absolute; inset:0; width:100%; height:100%; background:#123456" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
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
    (helpersSrc) => {
      const scope = new Function(
        `const { visible, shownBox, visibleTextOf } = (${helpersSrc})();\nreturn { visible, shownBox, visibleTextOf };`,
      )() as {
        visible: (n: Element | null) => boolean;
        shownBox: (n: Element | null) => boolean;
        // The unresolved-generated-content signal rides on the function
        // rather than the return value, so the signature stays a string
        // for its twenty call sites (round 116).
        visibleTextOf: ((r: Element | null) => string) & {
          sawUnresolvedGenerated?: boolean;
        };
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
        clippedAboveCB: bodyVisible(byId('clippedAboveCBLeaf')),
        generatedAmountText: scope.visibleTextOf(byId('generatedAmount')),
        generatedHiddenText: scope.visibleTextOf(byId('generatedHidden')),
        generatedCounterText: scope.visibleTextOf(byId('generatedCounter')),
        generatedAttrText: scope.visibleTextOf(byId('generatedAttr')),
        generatedAttrUnresolved: scope.visibleTextOf.sawUnresolvedGenerated === true,
        generatedMixedText: (() => {
          const t = scope.visibleTextOf(byId('generatedMixed'));
          return { text: t, unresolved: scope.visibleTextOf.sawUnresolvedGenerated === true };
        })(),
        coveredByHalfFilterSeen: seenScrolled(byId('coveredByHalfFilter')),
        coveredByPercentFilterSeen: seenScrolled(byId('coveredByPercentFilter')),
        coveredByFullFilterSeen: seenScrolled(byId('coveredByFullFilter')),
        coveredByGhostImageSeen: seenScrolled(byId('coveredByGhostImage')),
        coveredByPaintedImageSeen: seenScrolled(byId('coveredByPaintedImage')),
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
    VISIBILITY_SOURCE,
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

  // ROUND 97 P2 — a replaced element is not evidence of paint. A fully
  // transparent image over the row reports opacity 1 and is what
  // hit-testing returns; the tag test counted it as a cover and threw the
  // sentence away. Nothing cheap can read its pixels, so it is undecidable
  // — and undecidable counts as not covering.
  expect(
    result.coveredByGhostImageSeen,
    'a transparent image covers nothing',
  ).toContain('closed out now');
  expect(
    result.coveredByPaintedImageSeen,
    'but the same image with an opaque background still covers',
  ).toBe('');

  // ROUND 100 P2 — a filter below full opacity is not a cover. The element
  // `opacity` test has always rejected anything under 1; the filter test
  // matched only exactly zero, so `opacity(.5)` over an opaque background
  // read as solid and discarded copy the lender can read through it.
  expect(
    result.coveredByHalfFilterSeen,
    'a half-transparent filter leaves the sentence readable',
  ).toContain('closed out now');
  expect(
    result.coveredByPercentFilterSeen,
    'and the percentage spelling of it',
  ).toContain('closed out now');
  expect(
    result.coveredByFullFilterSeen,
    'but a fully opaque filter still covers',
  ).toBe('');

  // ROUND 115 P2 — a clipping ancestor ABOVE the containing block. The
  // walk skips ancestors until it reaches the out-of-flow leaf's
  // containing block; that block is positioned but its own overflow is
  // visible, and the visible-overflow fast path used to run before the
  // containing-block state was recorded. The block was skipped unmarked,
  // so the overflow:hidden ancestor above it looked like one below it and
  // was skipped too — and copy scrolled 400px out of a 20px window read
  // as shown.
  // Read WITHOUT `scrollIntoView`: an overflow:hidden box is still
  // programmatically scrollable, so scrolling the leaf into view is
  // exactly the thing that would hide the defect.
  expect(
    result.clippedAboveCB,
    'a hidden ancestor above the containing block still clips',
  ).toBe(false);

  // ROUND 111 P2 — generated text is collected, because the lender reads
  // it and the funds scan was certifying cards that displayed an amount
  // through ::after. Only a QUOTED string, and only when the pseudo
  // actually paints: a hidden one contributes nothing, and counter()
  // cannot be read without inventing text.
  expect(
    result.generatedAmountText,
    'text painted through ::after reaches the scan',
  ).toContain('100 USDC');
  expect(
    result.generatedHiddenText,
    'but a styled-away pseudo contributes nothing',
  ).not.toContain('250 WETH');
  expect(
    result.generatedCounterText,
    'and a non-string content invents no text',
  ).toBe('Close-out');

  // ROUND 116 P2 — a dynamic component mixed with a literal unit. Reading
  // only the quoted half yielded "USDC" with the NUMBER dropped, so the
  // scan saw no digits and certified a card that visibly states an amount.
  // attr() is resolved from the element; a counter cannot be, so the run
  // says the claim was not established rather than reading half of it.
  expect(
    result.generatedAttrText,
    'attr() is resolved, so the amount reaches the scan',
  ).toContain('100 USDC');
  expect(
    result.generatedAttrUnresolved,
    'and nothing was left unresolved in it',
  ).toBe(false);
  expect(
    result.generatedMixedText.unresolved,
    'a counter mixed with a unit leaves the claim unestablished',
  ).toBe(true);
});

// #2138 review — THE SCROLL CREDIT IS WHAT A SCROLLER CAN ACTUALLY DO TO
// THIS BOX. Five ways the first version of the credit was wrong, each a
// Codex finding on #2157, each pinned against a real engine:
//
//   - a scroller between an absolutely positioned box and its containing
//     block does not move it, and nothing moves a viewport-fixed one;
//   - `<body>` as an independent scroller (standards mode, `html`
//     overflow hidden) is real credit while `window.scrollY` stays 0;
//   - an element's own scroll carries its glyphs and not its box;
//   - the credit goes through ancestor transforms — under `scale(2)`
//     restoring 300 moves the row 600;
//   - a `column-reverse` scroller rests at 0 and scrolls into negative
//     values, so its restorable distance is to its minimum, not to 0.
//
// Every scrolled fixture also asserts the geometry it relies on — a
// negative rect with the page unscrolled — so a case cannot pass by never
// reaching the state it claims to test. Layout is stacked from the top of
// an unscrolled document so the arithmetic in each comment holds.
test('the scroll credit counts only what moves the box, mapped through transforms', async ({
  page,
}) => {
  // STANDARDS MODE, stated. Without a doctype `setContent` yields a quirks
  // document, where `body.clientHeight` is the viewport's and a body
  // scroller's own numbers are wrong; the app under test has a doctype.
  await page.setContent(`<!DOCTYPE html>
    <style>html { overflow: hidden } body { margin: 0 } p { margin: 0 }</style>
    <!-- y 0..40 -->
    <div id="staticScroller" style="height:40px; overflow:auto">
      <p id="absUnderStatic" style="position:absolute; top:-100px">absolute, scroller is not its containing block</p>
      <p id="fixedUnderScroller" style="position:fixed; top:-100px">fixed, nothing carries it</p>
      <p style="height:400px">filler</p>
    </div>
    <!-- y 40..80 -->
    <div id="positionedScroller" style="position:relative; height:40px; overflow:auto">
      <p id="absUnderPositioned" style="position:absolute; top:0; height:20px">absolute under its own scrolling containing block</p>
      <p style="height:400px">filler</p>
    </div>
    <!-- y 80..120: a 40px box whose own text is followed by 600px of
         block filler, so it scrolls its text out of its own slit -->
    <p id="selfScroller" style="height:40px; overflow:auto">an element scrolling its own text<span style="display:block; height:600px"></span></p>
    <!-- y 120..200: a 40px scroller drawn at twice its size -->
    <div style="transform:scale(2); transform-origin:0 0; height:80px">
      <div id="scaledScroller" style="height:40px; overflow:auto">
        <p id="scaledRow" style="height:20px">under a scaled ancestor</p>
        <p style="height:400px">filler</p>
      </div>
    </div>
    <!-- y 200..240 -->
    <div id="reverseScroller" style="height:40px; overflow:auto; display:flex; flex-direction:column-reverse">
      <p style="height:400px; flex:none">filler shown first</p>
      <p id="reverseRow" style="height:20px; flex:none">earlier content, above the slit at rest</p>
    </div>
    <!-- y 240..280: a clipper whose inner scroller's slit (340..380) lies
         wholly outside it — an inner scroll range must not exempt this -->
    <div id="outsideClipper" style="height:40px; overflow:hidden">
      <div id="outsideScroller" style="margin-top:100px; height:40px; overflow:auto">
        <p id="outsideRow" style="height:20px">in a scroller the clipper never shows</p>
        <p style="height:400px">filler</p>
      </div>
    </div>
    <!-- y 280..320: content the scroller can only carry FURTHER away -->
    <div id="awayScroller" style="height:40px; overflow:auto">
      <p id="awayRow" style="margin-top:-100px; height:20px">above the slit, and scrolling only moves it up</p>
      <p style="height:400px">filler</p>
    </div>
    <!-- y 320..360: a scroller turned upside down, resting at its minimum,
         whose FAR end is the one that rescues -->
    <div style="transform:rotate(180deg); transform-origin:50% 50%; height:40px">
      <div id="rotatedScroller" style="height:40px; overflow:auto">
        <p style="height:400px">filler shown first</p>
        <p id="rotatedRow" style="height:20px">local bottom, viewport top</p>
      </div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    const top = (id: string) => byId(id).getBoundingClientRect().top;
    // Scroll the three ordinary scrollers by 300 and the self-scroller as
    // far as it goes; the reverse scroller already rests with its earlier
    // content above. Then judge.
    for (const id of ['staticScroller', 'positionedScroller', 'scaledScroller']) {
      byId(id).scrollTop = 300;
    }
    byId('selfScroller').scrollTop = 600;
    byId('outsideScroller').scrollTop = 300;
    const selfText = document.createRange();
    selfText.selectNodeContents(byId('selfScroller').firstChild!);
    return {
      pageScrollY: window.scrollY,
      absUnderStaticTop: top('absUnderStatic'),
      absUnderStatic: visible(byId('absUnderStatic')),
      fixedUnderScrollerTop: top('fixedUnderScroller'),
      fixedUnderScroller: visible(byId('fixedUnderScroller')),
      absUnderPositionedTop: top('absUnderPositioned'),
      absUnderPositioned: visible(byId('absUnderPositioned')),
      selfScrollTop: byId('selfScroller').scrollTop,
      selfScrollerBoxTop: top('selfScroller'),
      selfTextBottom: selfText.getBoundingClientRect().bottom,
      selfScroller: visible(byId('selfScroller')),
      scaledRowTop: top('scaledRow'),
      scaledRow: visible(byId('scaledRow')),
      reverseScrollTop: byId('reverseScroller').scrollTop,
      reverseRowTop: top('reverseRow'),
      reverseRow: visible(byId('reverseRow')),
      outsideRowTop: top('outsideRow'),
      outsideRow: visible(byId('outsideRow')),
      awayRowTop: top('awayRow'),
      awayRow: visible(byId('awayRow')),
      rotatedScrollTop: byId('rotatedScroller').scrollTop,
      rotatedRowTop: top('rotatedRow'),
      rotatedRow: visible(byId('rotatedRow')),
    };
  }, VISIBILITY_SOURCE);

  expect(result.pageScrollY, 'the page itself never scrolled').toBe(0);
  // NOT carried by the scroller. The static scroller is not the absolute
  // box's containing block, so it sits at -100 whatever the scroll offset
  // is, and a credit of 0 leaves it before the origin; the fixed box is
  // carried by nothing.
  expect(result.absUnderStaticTop).toBe(-100);
  expect(result.absUnderStatic, 'absolute under a static scroller').toBe(false);
  expect(result.fixedUnderScrollerTop).toBe(-100);
  expect(result.fixedUnderScroller, 'fixed under a scroller').toBe(false);
  // Carried. The positioned scroller IS the containing block: at rest the
  // row is at 40, the 300 of scroll puts it at -260, and 300 of credit
  // brings its bottom back to +60.
  expect(result.absUnderPositionedTop).toBe(-260);
  expect(result.absUnderPositioned, 'absolute under its scrolling containing block').toBe(true);
  // Own scroll. The box stays at 80 while its text is carried far above
  // (the block filler is the scroll range); the credit applies to the
  // glyphs.
  expect(result.selfScrollTop).toBeGreaterThan(500);
  expect(result.selfScrollerBoxTop).toBe(80);
  expect(result.selfTextBottom).toBeLessThan(0);
  expect(result.selfScroller, 'an element scrolling its own text').toBe(true);
  // Scaled. The row rests at 120; scrolling 300 under scale(2) puts it at
  // 120 - 600 = -480. A raw credit of 300 would leave it at -180 and
  // condemn it; the mapped credit of 600 reaches it.
  expect(result.scaledRowTop).toBe(-480);
  expect(result.scaledRow, 'a row under a scale(2) ancestor').toBe(true);
  // Reverse. At rest (scrollTop 0) the row is 380 above the slit's top of
  // 200, and the restorable distance is the 380 of negative range, not 0.
  expect(result.reverseScrollTop).toBe(0);
  expect(result.reverseRowTop).toBe(-180);
  expect(result.reverseRow, 'earlier content in a column-reverse scroller').toBe(true);
  // #2157 round 2 — the clipper exemption is not blanket. The inner
  // scroller's slit (340..380) never shows through a clipper at 240..280,
  // whatever it scrolls: the row (at 340 - 300 = 40, so not before the
  // origin) is condemned by the clip walk, not the origin test.
  expect(result.outsideRowTop).toBe(40);
  expect(result.outsideRow, 'a scroller whose slit lies outside its clipper').toBe(false);
  // And a scroller at rest can only carry a negative-margin row further
  // up: at 180 it is not before the origin, and no scroll position brings
  // it into the 280..320 slit.
  expect(result.awayRowTop).toBe(180);
  expect(result.awayRow, 'content the scroller can only move away').toBe(false);
  // Upside down, at rest (scrollTop 0 = its minimum): the row sits at the
  // scroller's local bottom, which rotation puts 360 above the slit's top
  // of 320, i.e. at -60. Moving toward the MAXIMUM offset — the end a
  // toward-minimum credit never considers — carries it back.
  expect(result.rotatedScrollTop).toBe(0);
  expect(result.rotatedRowTop).toBe(-60);
  expect(result.rotatedRow, 'a rotated scroller rescued by its far end').toBe(true);
});

test('body as an independent scroller is credited when it is not the page scroller', async ({
  page,
}) => {
  // Standards mode, as above: in a quirks document body is the page
  // scroller or reports the viewport's numbers, and the premise fails.
  await page.setContent(`<!DOCTYPE html>
    <style>html { overflow: hidden } body { margin: 0; height: 40px; overflow: auto }</style>
    <p id="bodyRow" style="height:20px; margin:0">scrolled above body's own slit</p>
    <p style="height:400px; margin:0">filler</p>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    document.body.scrollTop = 300;
    return {
      bodyIsPageScroller: document.scrollingElement === document.body,
      bodyScrollTop: document.body.scrollTop,
      pageScrollY: window.scrollY,
      rowTop: document.getElementById('bodyRow')!.getBoundingClientRect().top,
      row: visible(document.getElementById('bodyRow')),
    };
  }, VISIBILITY_SOURCE);
  // The premise, asserted: body scrolled as its own container while the
  // viewport did not — otherwise this is the ordinary page-scroll case.
  expect(result.bodyIsPageScroller).toBe(false);
  expect(result.bodyScrollTop).toBe(300);
  expect(result.pageScrollY).toBe(0);
  expect(result.rowTop).toBe(-300);
  expect(result.row, 'a row scrolled above an independent body scroller').toBe(true);
});

// #2157 round 3 — two more things "scroller" has to mean:
//
//   - NESTED. An inner scrollport currently below an outer scroller's slit
//     is carried into view TOGETHER with its row when the outer one
//     scrolls. Intersecting the inner slit with the outer box where it
//     currently sits condemned that row.
//   - ZERO EXTENT. `overflow: auto` whose content fits is a clipper by
//     behaviour whatever its style says; a relatively positioned row
//     shifted out of it cannot be scrolled back and gets the half rule.
test('nested scrollers carry the inner slit, and a zero-extent scroller is a clipper', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>html { overflow: hidden } body { margin: 0 } p { margin: 0 }</style>
    <!-- y 0..40: the outer scroller, at rest; its inner scroller sits 200
         down, outside the outer slit until the outer one scrolls -->
    <div id="outer" style="height:40px; overflow:auto">
      <p style="height:200px">outer filler</p>
      <div id="inner" style="height:40px; overflow:auto">
        <p id="nestedRow" style="height:20px">above the inner slit, below the outer one</p>
        <p style="height:400px">inner filler</p>
      </div>
    </div>
    <!-- y 40..80: scroller styling, no scroll extent -->
    <div id="zeroExtent" style="height:40px; overflow:auto">
      <p id="shiftedRow" style="position:relative; top:-39px; height:20px">one pixel of this is inside the box</p>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('inner').scrollTop = 300;
    const zero = byId('zeroExtent');
    return {
      pageScrollY: window.scrollY,
      outerScrollTop: byId('outer').scrollTop,
      innerScrollTop: byId('inner').scrollTop,
      innerTop: byId('inner').getBoundingClientRect().top,
      nestedRowTop: byId('nestedRow').getBoundingClientRect().top,
      nestedRow: visible(byId('nestedRow')),
      zeroSpan: zero.scrollHeight - zero.clientHeight,
      shiftedRowTop: byId('shiftedRow').getBoundingClientRect().top,
      shiftedRow: visible(byId('shiftedRow')),
    };
  }, VISIBILITY_SOURCE);

  expect(result.pageScrollY).toBe(0);
  // The premise: outer at rest with the inner scroller 200 below its slit,
  // inner scrolled 300 so the row sits at 200 - 300 = -100. Scrolling the
  // outer by 200 brings the inner slit to 0..40; scrolling the inner back
  // brings the row into it.
  expect(result.outerScrollTop).toBe(0);
  expect(result.innerScrollTop).toBe(300);
  expect(result.innerTop).toBe(200);
  expect(result.nestedRowTop).toBe(-100);
  expect(result.nestedRow, 'a row in a nested scroller the outer one can reveal').toBe(true);
  // No movement to credit: the row shifted to 1 leaves one pixel of twenty
  // inside the box and nothing scrolls it back, so the half rule condemns.
  expect(result.zeroSpan).toBe(0);
  expect(result.shiftedRowTop).toBe(1);
  expect(result.shiftedRow, 'a row shifted out of a zero-extent scroller').toBe(false);
});

// #2157 round 4 — four more, each pinned against a real engine:
//
//   - ONE scroll position has to serve every box: a slit placed inside an
//     outer scroller cannot then be re-placed elsewhere to satisfy a
//     clipper above it;
//   - scroller-vs-clipper is decided in VIEWPORT axes: a rotated vertical
//     scroller moves its content horizontally;
//   - an ancestor that clips one axis leaves the slit alone on the other;
//   - `rtl` and `row-reverse` together cancel (measured: [0, span]).
test('one scroll position serves every box above the slit', async ({ page }) => {
  await page.setContent(`<!DOCTYPE html>
    <style>html { overflow: hidden } body { margin: 0 } p { margin: 0 }</style>
    <!-- 0..40: a clipper. The outer scroller's fixed box (100..140) lies
         wholly outside it, so nothing the inner scroller shows can ever
         be seen — but an offset chosen freely for the clipper alone would
         place the inner slit at 0..40 and pass it. -->
    <div id="clip" style="height:40px; overflow:hidden">
      <div id="outer" style="margin-top:100px; height:40px; overflow:auto">
        <p style="height:300px">outer filler</p>
        <div id="inner" style="height:40px; overflow:auto">
          <p id="row" style="height:20px">seen through two boxes that never both show it</p>
          <p style="height:400px">inner filler</p>
        </div>
      </div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('inner').scrollTop = 300;
    return {
      outerTop: byId('outer').getBoundingClientRect().top,
      innerTop: byId('inner').getBoundingClientRect().top,
      rowTop: byId('row').getBoundingClientRect().top,
      row: visible(byId('row')),
    };
  }, VISIBILITY_SOURCE);
  expect(result.outerTop).toBe(100);
  expect(result.innerTop).toBe(400);
  // At +100 the row is not before the origin: only the clip walk decides.
  expect(result.rowTop).toBe(100);
  expect(result.row, 'a slit that cannot serve the outer box and the clipper at once').toBe(false);
});

test('a rotated vertical scroller is a horizontal scroller in viewport axes', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>html { overflow: hidden } body { margin: 0 } p { margin: 0 }</style>
    <!-- local (x, y) → viewport (40 - y, x): the 200×40 scroller stands
         on its side at x 0..40, y 0..200, and its vertical scroll moves
         content along viewport X. -->
    <div style="transform:translate(40px, 0) rotate(90deg); transform-origin:0 0; width:200px; height:40px">
      <div id="scroller" style="width:200px; height:40px; overflow:auto">
        <p id="row" style="height:20px">carried sideways</p>
        <p style="height:400px">filler</p>
      </div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('scroller').scrollTop = 300;
    const box = byId('scroller').getBoundingClientRect();
    const row = byId('row').getBoundingClientRect();
    return {
      boxRight: box.right,
      boxBottom: box.bottom,
      rowLeft: row.left,
      rowTop: row.top,
      rootBoxBottom: document.documentElement.getBoundingClientRect().bottom,
      row: visible(byId('row')),
    };
  }, VISIBILITY_SOURCE);
  // The row sits 280 to the RIGHT of the box after 300 of local scroll —
  // no vertical overlap question at all, and a local-axis classification
  // would apply the half rule on X and condemn it.
  expect(result.boxRight).toBe(40);
  expect(result.boxBottom).toBe(200);
  expect(result.rowLeft).toBe(320);
  expect(result.rowTop).toBe(0);
  // And the root's own layout box (40px, the wrapper's unrotated height)
  // is shorter than the standing scroller: `html { overflow: hidden }`
  // clips at the VIEWPORT, not at that box, and reading the box condemned
  // this row before the rule was corrected.
  expect(result.rootBoxBottom).toBeLessThan(200);
  expect(result.row, 'reachable by the scroll that moves it, whichever axis that is').toBe(true);
});

test('an ancestor that clips one axis leaves the slit alone on the other', async ({ page }) => {
  await page.setContent(`<!DOCTYPE html>
    <style>html { overflow: hidden } body { margin: 0 } p { margin: 0 }</style>
    <!-- 0..12: a vertical clipper showing 12px of a 40px scrollport. In
         between, a wrapper that clips X only and is shorter than the
         scroller; trimming the slit to it would make the clipper's share
         look like 12 of 20 instead of 12 of 40. -->
    <div style="height:12px; overflow-y:hidden">
      <div style="height:20px; overflow-x:clip; overflow-y:visible">
        <div id="scroller" style="height:40px; overflow:auto">
          <p id="row" style="height:20px">mostly hidden scrollport</p>
          <p style="height:400px">filler</p>
        </div>
      </div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('scroller').scrollTop = 300;
    return {
      scrollerBottom: byId('scroller').getBoundingClientRect().bottom,
      rowTop: byId('row').getBoundingClientRect().top,
      row: visible(byId('row')),
    };
  }, VISIBILITY_SOURCE);
  expect(result.scrollerBottom).toBe(40);
  expect(result.rowTop).toBe(-300);
  expect(result.row, 'a 40px scrollport of which the clipper shows 12').toBe(false);
});

test('rtl and row-reverse together cancel, and either alone reverses', async ({ page }) => {
  await page.setContent(`<!DOCTYPE html>
    <style>html { overflow: hidden } body { margin: 0 } p { margin: 0; flex: none; height: 20px }</style>
    <div id="both" dir="rtl" style="display:flex; flex-direction:row-reverse; overflow:auto; width:200px; height:40px">
      <p style="width:400px">filler</p><p id="bothRow" style="width:100px">off to the right, reachable</p>
    </div>
    <div id="rtlOnly" dir="rtl" style="display:flex; overflow:auto; width:200px; height:40px">
      <p style="width:400px">filler</p><p id="rtlRow" style="width:100px">off to the left, reachable</p>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    return {
      bothScrollLeft: byId('both').scrollLeft,
      bothRowLeft: byId('bothRow').getBoundingClientRect().left,
      bothRow: visible(byId('bothRow')),
      rtlScrollLeft: byId('rtlOnly').scrollLeft,
      rtlRowLeft: byId('rtlRow').getBoundingClientRect().left,
      rtlRow: visible(byId('rtlRow')),
    };
  }, VISIBILITY_SOURCE);
  // Measured shape: both reversals cancel, the overflow is on the right
  // and the range is [0, span]; a single reversal puts it on the left
  // with [-span, 0]. Treating the pair as a single reversal would point
  // the credit the wrong way and condemn the first row.
  expect(result.bothScrollLeft).toBe(0);
  expect(result.bothRowLeft).toBe(400);
  expect(result.bothRow, 'rtl + row-reverse').toBe(true);
  expect(result.rtlScrollLeft).toBe(0);
  expect(result.rtlRowLeft).toBe(-300);
  expect(result.rtlRow, 'rtl alone').toBe(true);
});

// #2157 round 5 — the range helper reads the styles that actually move
// content: a flex reversal reverses only a flex container, and the
// individual `rotate` / `scale` properties are transforms too.
test('flex reversal applies only to flex containers, and individual transform properties count', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0 } p { margin: 0 }</style>
    <!-- 0..40: a BLOCK scroller carrying flex-direction: column-reverse,
         which does nothing to it; its range is the ordinary [0, span], so
         a negative-margin row above the slit can only be carried away. -->
    <div id="blockReverse" style="height:40px; overflow:auto; flex-direction:column-reverse; margin-top:120px">
      <p id="blockRow" style="margin-top:-100px; height:20px">above, and the reversal is a no-op</p>
      <p style="height:400px">filler</p>
    </div>
    <!-- a 40px scroller drawn at twice its size via the individual
         property, not transform: scale(2) -->
    <div style="scale:2; transform-origin:0 0; height:80px">
      <div id="scaledScroller" style="height:40px; overflow:auto">
        <p id="scaledRow" style="height:20px">under an individual scale</p>
        <p style="height:400px">filler</p>
      </div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('scaledScroller').scrollTop = 300;
    return {
      blockDisplay: getComputedStyle(byId('blockReverse')).display,
      blockFlexDirection: getComputedStyle(byId('blockReverse')).flexDirection,
      blockScrollTop: byId('blockReverse').scrollTop,
      blockRowTop: byId('blockRow').getBoundingClientRect().top,
      blockRow: visible(byId('blockRow')),
      wrapperTransform: getComputedStyle(byId('scaledScroller').parentElement!).transform,
      wrapperScale: getComputedStyle(byId('scaledScroller').parentElement!).scale,
      scaledRowTop: byId('scaledRow').getBoundingClientRect().top,
      scaledRow: visible(byId('scaledRow')),
    };
  }, VISIBILITY_SOURCE);
  // The computed flex-direction IS reported on the block scroller, and
  // must be ignored: at rest the row sits at 120 - 100 = 20, outside the
  // 120..160 slit, and no scroll position brings it in.
  expect(result.blockDisplay).toBe('block');
  expect(result.blockFlexDirection).toBe('column-reverse');
  expect(result.blockScrollTop).toBe(0);
  expect(result.blockRowTop).toBe(20);
  expect(result.blockRow, 'a block scroller is not reversed by flex-direction').toBe(false);
  // `scale: 2` leaves computed `transform` at none; the row still sits at
  // 160 - 600 = -440 and a raw credit of 300 would condemn it.
  expect(result.wrapperTransform).toBe('none');
  expect(result.wrapperScale).toBe('2');
  expect(result.scaledRowTop).toBe(-440);
  expect(result.scaledRow, 'a row under an individual scale property').toBe(true);
});

// #2157 round 6 — what the credit declines to model, and where occlusion
// is judged when the row is off-screen:
//
//   - a projective chain (ancestor `perspective`, any 3-D transform) and a
//     vertical writing mode are UNQUANTIFIABLE — admitted, stated, never
//     mis-scaled; nothing the drive reads uses either;
//   - a row admitted only by scroll credit is judged for occlusion at the
//     slit it would come back to, so an overlay parked over the whole
//     scrollport condemns it.
test('unmodelled chains admit, and an overlay over the slit condemns an off-screen row', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0 } p { margin: 0 }</style>
    <!-- 0..40: a scroller in a 3-D scene -->
    <div style="perspective:100px">
      <div id="persp" style="transform:translateZ(-50px); height:40px; overflow:auto">
        <p id="perspRow" style="height:20px">scrolled out under perspective</p>
        <p style="height:400px">filler</p>
      </div>
    </div>
    <!-- 40..240: a vertical-rl scroller, whose horizontal range is negative -->
    <div id="vert" style="writing-mode:vertical-rl; width:40px; height:200px; overflow:auto">
      <p id="vertRow" style="width:20px; height:200px">vertical</p>
      <p style="width:400px; height:200px">filler</p>
    </div>
    <!-- 240..280: a scroller whose slit an opaque overlay covers entirely;
         the row is scrolled far above the viewport -->
    <div style="position:relative">
      <div id="covered" style="height:40px; overflow:auto">
        <p id="coveredRow" style="height:20px">hidden at every scroll offset</p>
        <p style="height:1000px">filler</p>
      </div>
      <div style="position:absolute; inset:0; background:#000"></div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('persp').scrollTop = 300;
    byId('vert').scrollLeft = -300;
    byId('covered').scrollTop = 600;
    return {
      perspRowTop: byId('perspRow').getBoundingClientRect().top,
      perspRow: visible(byId('perspRow')),
      vertScrollLeft: byId('vert').scrollLeft,
      vertRow: visible(byId('vertRow')),
      coveredRowBottom: byId('coveredRow').getBoundingClientRect().bottom,
      coveredRow: visible(byId('coveredRow')),
    };
  }, VISIBILITY_SOURCE);
  // Perspective-scaled displacement: the row is above the origin and the
  // credit is not quantifiable, so it is admitted rather than mis-scaled.
  expect(result.perspRowTop).toBeLessThan(0);
  expect(result.perspRow, 'a projective chain admits').toBe(true);
  // The negative horizontal range is the premise; the credit declines it.
  expect(result.vertScrollLeft).toBeLessThan(0);
  expect(result.vertRow, 'a vertical writing mode admits').toBe(true);
  // Off-screen (bottom < 0), reachable by the scroll — and the slit it
  // would come back to is covered, so it is not visible at any offset.
  expect(result.coveredRowBottom).toBeLessThan(0);
  expect(result.coveredRow, 'an overlay over the whole scrollport').toBe(false);
});

// #2157 round 7 — seven more corrections to the same model, each pinned:
//
//   - the off-screen slit probe runs only where the PAGE scroll cannot
//     help (glyphs before the document origin);
//   - that probe samples the scroller's CLIENT area, not its border;
//   - a viewport-fixed row gets no page-scroll credit, whatever scrollY is;
//   - `will-change: backdrop-filter` establishes a containing block;
//   - CSS `zoom` is unquantifiable (admits);
//   - the outer offset is chosen for the ROW's reachable band, not the
//     slit's centre;
//   - stacked clippers are measured against the ORIGINAL slit extent.
test('the slit probe respects page scroll and borders; fixed rows get no page credit', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0; height: 3000px } p { margin: 0 }</style>
    <!-- a fixed overlay over the bottom 120px of the viewport -->
    <div style="position:fixed; left:0; right:0; bottom:0; height:120px; background:#000"></div>
    <!-- a scroller whose top 20px show beneath that overlay; its row sits
         BELOW the viewport and comes back by page scroll, not inner scroll -->
    <div id="belowScroller" style="position:absolute; top:700px; height:100px; overflow:auto">
      <p style="height:50px">head</p>
      <p id="belowRow" style="height:20px">below the fold, page-scrollable</p>
      <p style="height:400px">filler</p>
    </div>
    <!-- a BORDERED scroller whose client area an overlay covers -->
    <div style="position:absolute; top:200px; left:0; width:120px">
      <div id="bordered" style="height:60px; width:100px; overflow:auto; border:10px solid #888">
        <p id="borderedRow" style="height:20px">hidden behind the client-area overlay</p>
        <p style="height:1000px">filler</p>
      </div>
      <div style="position:absolute; top:10px; left:10px; width:100px; height:60px; background:#000"></div>
    </div>
    <!-- a viewport-fixed row above the viewport -->
    <p id="fixedRow" style="position:fixed; top:-100px; height:20px">never on screen</p>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('bordered').scrollTop = 600;
    const before = {
      belowRowTop: byId('belowRow').getBoundingClientRect().top,
      belowRow: visible(byId('belowRow')),
      borderedRowBottom: byId('borderedRow').getBoundingClientRect().bottom,
      borderedRow: visible(byId('borderedRow')),
    };
    window.scrollTo(0, 1000);
    return {
      ...before,
      viewportHeight: window.innerHeight,
      scrollY: window.scrollY,
      fixedRowTop: byId('fixedRow').getBoundingClientRect().top,
      fixedRow: visible(byId('fixedRow')),
    };
  }, VISIBILITY_SOURCE);
  // Below the viewport (750 > 720) behind a fixed overlay: page scroll
  // brings both scroller and row away from the overlay, so admitted.
  expect(result.viewportHeight).toBe(720);
  expect(result.belowRowTop).toBe(750);
  expect(result.belowRow, 'a page-scrollable row under a fixed overlay').toBe(true);
  // Scrolled above the origin, and the only place it can come back to is
  // covered — probing the border would have found the scroller itself.
  expect(result.borderedRowBottom).toBeLessThan(0);
  expect(result.borderedRow, 'a bordered scroller whose client area is covered').toBe(false);
  // Fixed 100 above the viewport with the page scrolled by 1000: the page
  // offset must not be added, so it is before the origin with no credit.
  expect(result.scrollY).toBe(1000);
  expect(result.fixedRowTop).toBe(-100);
  expect(result.fixedRow, 'a viewport-fixed row gets no page-scroll credit').toBe(false);
});

test('containing-block hints, zoom, joint outer offset and stacked clippers', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0 } p { margin: 0 }</style>
    <!-- 0..40: a scroller made the containing block only by a will-change hint -->
    <div id="hinted" style="will-change:backdrop-filter; height:40px; overflow:auto">
      <p id="hintedRow" style="position:absolute; top:0; height:20px">absolute under a hinted containing block</p>
      <p style="height:400px">filler</p>
    </div>
    <!-- 40..120: zoom is not modelled -->
    <div style="zoom:2">
      <div id="zoomed" style="height:40px; overflow:auto">
        <p id="zoomedRow" style="height:20px">under zoom</p>
        <p style="height:400px">filler</p>
      </div>
    </div>
    <!-- 120..160: a 40px outer scroller at rest holding a 200px inner
         scroller whose first row is scrolled above the origin; the row can
         come back only to the inner slit's TOP, which the outer box shows -->
    <div id="outerShort" style="height:40px; overflow:auto">
      <div id="innerTall" style="height:200px; overflow:auto">
        <p id="jointRow" style="height:20px">reachable at the inner slit's top</p>
        <p style="height:600px">inner filler</p>
      </div>
      <p style="height:400px">outer filler</p>
    </div>
    <!-- 160..170: two clippers each keeping half of what the previous left:
         10 of a 40px slit is a quarter, not "half of half" -->
    <div style="height:10px; overflow:hidden">
      <div style="height:20px; overflow:hidden">
        <div id="stacked" style="height:40px; overflow:auto">
          <p id="stackedRow" style="height:20px">seen through a quarter of its slit</p>
          <p style="height:400px">filler</p>
        </div>
      </div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('hinted').scrollTop = 300;
    byId('zoomed').scrollTop = 300;
    byId('innerTall').scrollTop = 300;
    return {
      hintedRowTop: byId('hintedRow').getBoundingClientRect().top,
      hintedRow: visible(byId('hintedRow')),
      zoomValue: getComputedStyle(byId('zoomed').parentElement!).zoom,
      zoomedRowTop: byId('zoomedRow').getBoundingClientRect().top,
      zoomedRow: visible(byId('zoomedRow')),
      outerScrollTop: byId('outerShort').scrollTop,
      jointRowTop: byId('jointRow').getBoundingClientRect().top,
      jointRow: visible(byId('jointRow')),
      stackedRowTop: byId('stackedRow').getBoundingClientRect().top,
      stackedRow: visible(byId('stackedRow')),
    };
  }, VISIBILITY_SOURCE);
  // Carried by its hinted containing block: -300 with 300 of credit.
  expect(result.hintedRowTop).toBe(-300);
  expect(result.hintedRow, 'an absolute row under a will-change: backdrop-filter scroller').toBe(true);
  // Zoom: declared unquantifiable, admitted.
  expect(result.zoomValue).toBe('2');
  expect(result.zoomedRowTop).toBeLessThan(0);
  expect(result.zoomedRow, 'zoom admits').toBe(true);
  // Outer at rest; the row restores to the inner slit's top (120..140),
  // which is inside the outer box (120..160). Centring the 200px inner
  // slit in the 40px box demanded the row at 200..240 and condemned it.
  expect(result.outerScrollTop).toBe(0);
  expect(result.jointRowTop).toBe(-180);
  expect(result.jointRow, 'the outer offset is chosen for the row').toBe(true);
  // 10 of the original 40 shows: a quarter, condemned; halving twice
  // would have passed it.
  expect(result.stackedRowTop).toBe(160);
  expect(result.stackedRow, 'stacked clippers keep a quarter of the slit').toBe(false);
});

// #2157 round 8 — four more, each pinned against a real engine:
//
//   - `content-visibility: auto` establishes a containing block (measured);
//   - a nested scroller becomes the new limiting viewport for the half rule;
//   - the off-screen slit probe uses the TRANSFORMED client area;
//   - and intersects it with the scroller's clipping ancestors.
test('content-visibility containing block, and the nested slit resets the half-rule denominator', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0 } p { margin: 0 }</style>
    <!-- 0..40: a scroller made a containing block by content-visibility -->
    <div id="cv" style="content-visibility:auto; height:40px; overflow:auto">
      <p id="cvRow" style="position:absolute; top:0; height:20px">absolute under a content-visibility container</p>
      <p style="height:400px">filler</p>
    </div>
    <!-- 40..80: a wrapper that fully exposes a 40px outer scroller which in
         turn shows 40 of a 200px inner scrollport -->
    <div style="height:40px; overflow:hidden">
      <div id="outerFull" style="height:40px; overflow:auto">
        <div id="innerTall2" style="height:200px; overflow:auto">
          <p id="nestedRow2" style="height:20px">readable through the outer slit</p>
          <p style="height:600px">inner filler</p>
        </div>
        <p style="height:400px">outer filler</p>
      </div>
    </div>
  `);
  // `content-visibility: auto` decides whether a subtree is relevant at a
  // rendering update; one local run in twelve read the row as not visible
  // straight after `setContent`, with its layout already in place, so the
  // fixture waits for a rendering update before it reads anything.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('cv').scrollTop = 300;
    byId('innerTall2').scrollTop = 300;
    return {
      cvComputed: getComputedStyle(byId('cv')).contentVisibility,
      cvRowTop: byId('cvRow').getBoundingClientRect().top,
      cvRow: visible(byId('cvRow')),
      nestedRow2Top: byId('nestedRow2').getBoundingClientRect().top,
      nestedRow2: visible(byId('nestedRow2')),
    };
  }, VISIBILITY_SOURCE);
  // Carried by the container: at -300 with 300 of credit.
  expect(result.cvComputed).toBe('auto');
  expect(result.cvRowTop).toBe(-300);
  expect(result.cvRow, 'an absolute row under a content-visibility container').toBe(true);
  // The wrapper exposes all 40 of the outer slit; measured against the
  // 200px inner extent it looked like 20% and was condemned.
  expect(result.nestedRow2Top).toBe(-260);
  expect(result.nestedRow2, 'a fully exposed outer slit over a tall inner one').toBe(true);
});

test('the off-screen slit probe uses the transformed client area, clipped by ancestors', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0 } p { margin: 0 }</style>
    <!-- a scaled, bordered scroller whose client area an overlay covers
         exactly; the unscaled client metrics would probe twice as far -->
    <div style="position:absolute; top:0; left:0; transform:scale(0.5); transform-origin:0 0; width:220px">
      <div id="scaledBordered" style="width:200px; height:80px; overflow:auto; border:10px solid #888">
        <p id="scaledBorderedRow" style="height:20px">behind a scaled overlay</p>
        <p style="height:1000px">filler</p>
      </div>
      <div style="position:absolute; top:10px; left:10px; width:200px; height:80px; background:#000"></div>
    </div>
    <!-- a wrapper exposing the top half of a 40px scrollport, with an
         overlay over exactly that exposed half -->
    <div style="position:absolute; top:200px; left:0; width:300px">
      <div style="height:20px; overflow:hidden">
        <div id="halfExposed" style="height:40px; overflow:auto">
          <p id="halfExposedRow" style="height:20px">the visible half is covered</p>
          <p style="height:1000px">filler</p>
        </div>
      </div>
      <div style="position:absolute; top:0; left:0; width:300px; height:20px; background:#000"></div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('scaledBordered').scrollTop = 600;
    byId('halfExposed').scrollTop = 600;
    const sb = byId('scaledBordered').getBoundingClientRect();
    return {
      scaledBoxBottom: sb.bottom,
      scaledClientHeight: byId('scaledBordered').clientHeight,
      scaledRowBottom: byId('scaledBorderedRow').getBoundingClientRect().bottom,
      scaledRow: visible(byId('scaledBorderedRow')),
      halfRowBottom: byId('halfExposedRow').getBoundingClientRect().bottom,
      halfRow: visible(byId('halfExposedRow')),
    };
  }, VISIBILITY_SOURCE);
  // The premise: a 100px layout box drawn 50px tall, client height still
  // reported as 80. Unscaled client metrics would probe down to y=90 and
  // find uncovered background below the 50px box.
  expect(result.scaledBoxBottom).toBe(50);
  expect(result.scaledClientHeight).toBe(80);
  expect(result.scaledRowBottom).toBeLessThan(0);
  expect(result.scaledRow, 'a scaled scroller whose client area is covered').toBe(false);
  // Only the top 20 of the 40px slit is ever shown, and that half is
  // covered; probing the clipped-away half would have found background.
  expect(result.halfRowBottom).toBeLessThan(0);
  expect(result.halfRow, 'a half-exposed scrollport whose exposed half is covered').toBe(false);
});

// #2157 round 9 — the model's stated scope, and four corrections inside it:
//
//   - the individual transform properties establish a containing block
//     even at identity (`scale: 1`), with computed `transform` at `none`;
//   - an in-flow row inside a viewport-fixed card does not ride the page;
//   - the slit probe clips to ancestors' PADDING boxes, not border boxes;
//   - a zero-span scroller stays an ordinary clipper under every bail-out;
//   - and two declared boundaries: a rotated scroller's probe does not
//     run, and `flex-wrap: wrap-reverse` is unquantifiable (both admit).
test('identity individual transforms, fixed ancestors, ancestor padding boxes, zero spans', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0; height: 3000px } p { margin: 0 }</style>
    <!-- 0..40: a containing block by scale: 1 alone -->
    <div id="identity" style="scale:1; height:40px; overflow:auto">
      <p id="identityRow" style="position:absolute; top:0; height:20px">carried by an identity-scaled container</p>
      <p style="height:400px">filler</p>
    </div>
    <!-- a viewport-fixed card parked above the viewport, holding a static row -->
    <div style="position:fixed; top:-200px; height:100px; left:0; right:0">
      <p id="fixedChildRow" style="height:20px">static inside a fixed card</p>
    </div>
    <!-- 40..80: a bordered clipper exposing 20 of a 40px scrollport through
         its padding box (10..30 within it), with an overlay over exactly
         that padding box -->
    <div style="position:relative; width:300px">
      <div style="height:20px; overflow:hidden; border:10px solid #888; box-sizing:content-box">
        <div id="throughBorder" style="height:40px; overflow:auto">
          <p id="throughBorderRow" style="height:20px">the padding box is covered</p>
          <p style="height:1000px">filler</p>
        </div>
      </div>
      <div style="position:absolute; top:10px; left:10px; width:280px; height:20px; background:#000"></div>
    </div>
    <!-- a zero-span scroller under zoom: still a clipper -->
    <div style="zoom:2">
      <div id="zeroUnderZoom" style="height:40px; overflow:auto">
        <p id="zeroUnderZoomRow" style="position:relative; top:-39px; height:20px">one pixel inside, nothing to scroll</p>
      </div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('identity').scrollTop = 300;
    byId('throughBorder').scrollTop = 600;
    const before = {
      identityTransform: getComputedStyle(byId('identity')).transform,
      identityRowTop: byId('identityRow').getBoundingClientRect().top,
      identityRow: visible(byId('identityRow')),
      throughBorderRowBottom: byId('throughBorderRow').getBoundingClientRect().bottom,
      throughBorderRow: visible(byId('throughBorderRow')),
      zeroSpan: byId('zeroUnderZoom').scrollHeight - byId('zeroUnderZoom').clientHeight,
      zeroUnderZoomRow: visible(byId('zeroUnderZoomRow')),
    };
    window.scrollTo(0, 1000);
    return {
      ...before,
      scrollY: window.scrollY,
      fixedChildRowTop: byId('fixedChildRow').getBoundingClientRect().top,
      fixedChildRow: visible(byId('fixedChildRow')),
    };
  }, VISIBILITY_SOURCE);
  // scale: 1 leaves computed transform at none and still anchors the row.
  expect(result.identityTransform).toBe('none');
  expect(result.identityRowTop).toBe(-300);
  expect(result.identityRow, 'an absolute row under scale: 1').toBe(true);
  // The clipper's border is not part of the opening; the padding box is
  // covered, so nothing the row can come back to is readable.
  expect(result.throughBorderRowBottom).toBeLessThan(0);
  expect(result.throughBorderRow, 'a covered padding box behind a bordered clipper').toBe(false);
  // Zero span under zoom: the half rule applies, one pixel of twenty.
  expect(result.zeroSpan).toBe(0);
  expect(result.zeroUnderZoomRow, 'a zero-span scroller under zoom is a clipper').toBe(false);
  // The static row inside a fixed card parked at -200: page scroll of
  // 1000 moves neither, so no page offset is added.
  expect(result.scrollY).toBe(1000);
  expect(result.fixedChildRowTop).toBe(-200);
  expect(result.fixedChildRow, 'a static row inside a viewport-fixed card').toBe(false);
});

test('declared boundaries: a rotated scroller is not probed, wrap-reverse is unquantifiable', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0 } p { margin: 0 }</style>
    <div style="position:absolute; top:0; left:0; transform:translate(40px, 0) rotate(90deg); transform-origin:0 0; width:200px; height:40px">
      <div id="rot" style="width:200px; height:40px; overflow:auto">
        <p id="rotRow" style="height:20px">rotated, off-screen</p>
        <p style="height:1000px">filler</p>
      </div>
    </div>
    <div id="wrapRev" style="position:absolute; top:300px; display:flex; flex-wrap:wrap-reverse; width:100px; height:40px; overflow:auto">
      <p id="wrapRevRow" style="flex:none; width:100px; height:20px">first line</p>
      <p style="flex:none; width:100px; height:20px">second</p>
      <p style="flex:none; width:100px; height:400px">tall filler</p>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('rot').scrollTop = 600;
    const wr = byId('wrapRev');
    wr.scrollTop = -10000;
    return {
      rotRowLeft: byId('rotRow').getBoundingClientRect().left,
      rotRow: visible(byId('rotRow')),
      wrapRevMinScroll: wr.scrollTop,
      wrapRevRow: visible(byId('wrapRevRow')),
    };
  }, VISIBILITY_SOURCE);
  // Off-screen to the right of the standing scroller; the credit reaches
  // it and, under rotation, the occlusion probe declines rather than
  // mis-measuring the client area.
  expect(result.rotRowLeft).toBeGreaterThan(200);
  expect(result.rotRow, 'a rotated scroller: reachable, probe declined').toBe(true);
  // The premise for wrap-reverse: a negative scroll range. Declared
  // unquantifiable, admitted.
  expect(result.wrapRevMinScroll).toBeLessThan(0);
  expect(result.wrapRevRow, 'wrap-reverse admits').toBe(true);
});

// #2157 round 10 — four corrections inside the stated scope, one boundary:
//
//   - a cover INSIDE the credited scroller is carried by the scroll being
//     credited, so an in-flow opaque sibling filling the slit is not one;
//   - two lines whose reachable bands sit apart in a tall inner scrollport
//     are each aimed at on their own by the outer scroller;
//   - the "page cannot help" gate on the slit probe asks whether the page
//     scroll moves the row at all, so a row inside a fixed card is probed;
//   - the clip walk's slit is seeded from the scroller's CLIENT area, so a
//     bordered scroller's opening is what a wrapper has to show;
//   - and a REFLECTED scroller's probe declines (admits), a declared
//     boundary alongside rotation.
test('carried covers, per-line aiming, fixed chains and client-area slits', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0; height: 3000px } p { margin: 0 }</style>
    <!-- 0..40: an in-flow opaque block fills the slit at scrollTop 600 -->
    <div id="carried" style="width:300px; height:40px; overflow:auto">
      <p id="carriedRow" style="height:20px">behind a sibling the scroll carries away</p>
      <p style="height:580px">filler</p>
      <div id="carriedCover" style="height:40px; background:#000"></div>
      <p style="height:1000px">filler</p>
    </div>
    <!-- 40..80: a 40px outer scroller over a 300px inner one whose 20px span
         leaves two lines' reachable bands 230px apart -->
    <div id="twoLineOuter" style="width:300px; height:40px; overflow:auto">
      <div id="twoLineInner" style="height:300px; overflow:auto">
        <div id="twoLine" style="line-height:20px">first line<div style="height:250px"></div>second line<div style="height:30px"></div></div>
      </div>
    </div>
    <!-- 80..120: a 40px wrapper exposing exactly the 40px client area of a
         scroller with 100px top and bottom borders -->
    <div id="borderWrap" style="width:300px; height:40px; overflow:hidden">
      <div id="bordered" style="position:relative; top:-100px; height:40px; overflow:auto; border:100px solid #888; border-left:0; border-right:0; box-sizing:content-box">
        <p id="borderedRow" style="height:20px">seen through the opening, not the border</p>
        <p style="height:1000px">filler</p>
      </div>
    </div>
    <!-- a mirrored scroller, wholly covered: the probe declines -->
    <div style="position:absolute; top:200px; left:0; width:200px; transform:scaleX(-1); transform-origin:100px 0">
      <div id="mirror" style="width:200px; height:40px; overflow:auto; border-left:50px solid #888">
        <p id="mirrorRow" style="height:20px">mirrored, off-screen</p>
        <p style="height:1000px">filler</p>
      </div>
      <div style="position:absolute; top:0; left:0; width:200px; height:40px; background:#000"></div>
    </div>
    <!-- a viewport-fixed card with an inner scroller under an overlay -->
    <div style="position:fixed; top:0; left:400px; width:300px; height:100px">
      <div id="fixedInner" style="height:40px; overflow:auto">
        <p id="fixedInnerRow" style="height:20px">covered inside a fixed card</p>
        <p style="height:1000px">filler</p>
      </div>
      <div style="position:absolute; top:0; left:0; width:300px; height:40px; background:#000"></div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('carried').scrollTop = 600;
    byId('bordered').scrollTop = 600;
    byId('mirror').scrollTop = 600;
    byId('fixedInner').scrollTop = 600;
    const lineRects = (() => {
      const r = document.createRange();
      r.selectNodeContents(byId('twoLine'));
      return Array.from(r.getClientRects())
        .filter((q) => q.height > 0 && q.height <= 20)
        .map((q) => q.top);
    })();
    const bordered = byId('bordered');
    const before = {
      carriedCoverTop: byId('carriedCover').getBoundingClientRect().top,
      carriedRowBottom: byId('carriedRow').getBoundingClientRect().bottom,
      carriedRow: visible(byId('carriedRow')),
      innerSpan: byId('twoLineInner').scrollHeight - byId('twoLineInner').clientHeight,
      lineTops: lineRects,
      twoLine: visible(byId('twoLine')),
      borderedBoxHeight: bordered.getBoundingClientRect().height,
      borderedClientHeight: bordered.clientHeight,
      borderedOpeningTop: bordered.getBoundingClientRect().top + bordered.clientTop,
      borderWrapTop: byId('borderWrap').getBoundingClientRect().top,
      borderedRowBottom: byId('borderedRow').getBoundingClientRect().bottom,
      borderedRow: visible(byId('borderedRow')),
      mirrorMatrix: getComputedStyle(byId('mirror').parentElement!).transform,
      mirrorRowBottom: byId('mirrorRow').getBoundingClientRect().bottom,
      mirrorRow: visible(byId('mirrorRow')),
    };
    window.scrollTo(0, 1000);
    return {
      ...before,
      scrollY: window.scrollY,
      fixedInnerRowBottom: byId('fixedInnerRow').getBoundingClientRect().bottom,
      fixedInnerRow: visible(byId('fixedInnerRow')),
    };
  }, VISIBILITY_SOURCE);
  // The opaque sibling sits exactly in the slit and is carried by the same
  // scroll that brings the row back: not a cover.
  expect(result.carriedCoverTop).toBe(0);
  expect(result.carriedRowBottom).toBe(-580);
  expect(result.carriedRow, 'a cover the credited scroller carries away').toBe(true);
  // Two lines 270px apart (the glyph rects sit a pixel inside their 20px
  // line boxes at 40 and 310) in a 300px inner scrollport with a 20px
  // span: line 1 reaches slit rows 0..20 of it, line 2 rows 250..290, and
  // the envelope's middle lies in the 230px gap between them.
  expect(result.innerSpan).toBe(20);
  expect(result.lineTops).toHaveLength(2);
  expect(result.lineTops[0]).toBeGreaterThanOrEqual(40);
  expect(result.lineTops[0]).toBeLessThan(50);
  expect(result.lineTops[1] - result.lineTops[0]).toBe(270);
  expect(result.twoLine, 'two lines aimed at separately by the outer scroller').toBe(true);
  // A 240px border box whose 40px opening the 40px wrapper shows entirely.
  expect(result.borderedBoxHeight).toBe(240);
  expect(result.borderedClientHeight).toBe(40);
  expect(result.borderedOpeningTop).toBe(result.borderWrapTop);
  expect(result.borderedRowBottom).toBeLessThan(0);
  expect(result.borderedRow, 'a wrapper showing a bordered scroller’s whole opening').toBe(true);
  // The premise for the boundary: a reflection, computed as a negative
  // x-scale. The probe declines rather than mirroring the insets; the row
  // is admitted on scroll credit although the scroller is covered.
  expect(result.mirrorMatrix).toBe('matrix(-1, 0, 0, 1, 0, 0)');
  expect(result.mirrorRowBottom).toBeLessThan(0);
  expect(result.mirrorRow, 'a mirrored scroller: reachable, probe declined').toBe(true);
  // Inside a fixed card the page scroll of 1000 moves nothing, so the row
  // at -580 is before the origin whatever `scrollY` says, and the probe
  // finds the overlay.
  expect(result.scrollY).toBe(1000);
  expect(result.fixedInnerRowBottom).toBe(-580);
  expect(result.fixedInnerRow, 'a covered scroller inside a fixed card on a scrolled page').toBe(false);
});

// #2157 round 11 — four corrections inside the stated scope:
//
//   - a fixed box captured by a transformed ancestor that is ITSELF fixed
//     still does not ride the page (the fixed chain is followed upward);
//   - an out-of-flow WRAPPER between the row and a scroller is honoured:
//     the scroller neither carries nor clips a subtree whose containing
//     block lies above it, so its range is no credit;
//   - `overflow-clip-margin` widens an `overflow: clip` box's clip edge,
//     as Chromium applies it: both axes `clip`, bare length, padding box;
//   - the half rule on an inherited slit is asked at each line's own outer
//     offset, not only at the envelope's.
test('nested fixed chains, out-of-flow wrappers, clip margins, per-line slit visibility', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0; height: 3000px } p { margin: 0 }</style>
    <!-- 0..40: a static row inside an absolute wrapper whose containing
         block is the relative box ABOVE the scroller -->
    <div style="position:relative; width:300px; height:40px">
      <div id="midScroller" style="height:40px; overflow:auto">
        <div style="position:absolute; top:-600px; left:0">
          <p id="absWrappedRow" style="height:20px">static inside an absolute wrapper</p>
        </div>
        <p style="height:1000px">filler</p>
      </div>
    </div>
    <!-- 40..80: a 40px hidden wrapper over a 200px scroller over an 80px
         scroller holding two 10px lines at the slit's two ends -->
    <div id="endsWrap" style="width:300px; height:40px; overflow:hidden">
      <div id="endsMid" style="height:200px; overflow:auto">
        <div id="endsInner" style="height:80px; overflow:auto">
          <div id="twoEnds" style="line-height:10px; font-size:8px">top line<div style="height:60px"></div>bottom line<div style="height:20px"></div></div>
        </div>
        <p style="height:1000px">filler</p>
      </div>
    </div>
    <!-- clip margins, measured: both axes clip → the margin shows the row;
         one axis clip → cut at the padding edge -->
    <div id="clipBoth" style="position:absolute; top:0; left:400px; width:300px; height:40px; overflow:clip; overflow-clip-margin:20px">
      <p id="clipBothRow" style="position:relative; top:45px; height:20px">painted in the clip margin</p>
    </div>
    <div id="clipY" style="position:absolute; top:200px; left:400px; width:300px; height:40px; overflow-y:clip; overflow-x:visible; overflow-clip-margin:20px">
      <p id="clipYRow" style="position:relative; top:45px; height:20px">cut at the padding edge</p>
    </div>
    <!-- a fixed card inside a transformed fixed card, holding a row parked
         above the viewport with nothing to scroll -->
    <div id="fixedOuter" style="position:fixed; top:0; left:800px; width:300px; height:100px; transform:translate(0)">
      <div style="position:fixed; top:0; left:0; width:300px; height:100px">
        <p id="nestedFixedRow" style="position:relative; top:-600px; height:20px">nested fixed, before the origin</p>
      </div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('midScroller').scrollTop = 600;
    const hitId = (x: number, y: number) => document.elementFromPoint(x, y)?.id ?? '';
    const lineTops = (() => {
      const r = document.createRange();
      r.selectNodeContents(byId('twoEnds'));
      return Array.from(r.getClientRects())
        .filter((q) => q.height > 0 && q.height <= 10)
        .map((q) => q.top);
    })();
    const before = {
      absWrappedRowBottom: byId('absWrappedRow').getBoundingClientRect().bottom,
      midSpan: byId('midScroller').scrollHeight - byId('midScroller').clientHeight,
      absWrappedRow: visible(byId('absWrappedRow')),
      endsInnerSpan: byId('endsInner').scrollHeight - byId('endsInner').clientHeight,
      endsMidSpan: byId('endsMid').scrollHeight - byId('endsMid').clientHeight,
      endsWrapTop: byId('endsWrap').getBoundingClientRect().top,
      lineTops,
      twoEnds: visible(byId('twoEnds')),
      clipBothComputed: getComputedStyle(byId('clipBoth')).overflowClipMargin,
      clipBothHitInMargin: hitId(405, 50),
      clipBothHitPastMargin: hitId(405, 62),
      clipBothRow: visible(byId('clipBothRow')),
      clipYOverflow: getComputedStyle(byId('clipY')).overflow,
      clipYHitInMargin: hitId(405, 250),
      clipYRow: visible(byId('clipYRow')),
    };
    window.scrollTo(0, 1000);
    return {
      ...before,
      scrollY: window.scrollY,
      fixedOuterTransform: getComputedStyle(byId('fixedOuter')).transform,
      nestedFixedRowBottom: byId('nestedFixedRow').getBoundingClientRect().bottom,
      nestedFixedRow: visible(byId('nestedFixedRow')),
    };
  }, VISIBILITY_SOURCE);
  // The wrapper is positioned against the relative box above the scroller,
  // so the scroller's 600px of credit never moves it: parked, condemned.
  expect(result.absWrappedRowBottom).toBe(-580);
  expect(result.midSpan).toBe(960);
  expect(result.absWrappedRow, 'a static row inside an absolute wrapper the scroller does not carry').toBe(false);
  // Two lines at the slit's ends (glyph rects inside 10px line boxes 70px
  // apart). The envelope's offset shows half the 80px slit through the
  // 40px wrapper; bringing the bottom line in shows 35px of it, under half.
  expect(result.endsInnerSpan).toBe(20);
  expect(result.endsMidSpan).toBe(880);
  expect(result.lineTops).toHaveLength(2);
  expect(result.lineTops[0]).toBeGreaterThanOrEqual(result.endsWrapTop);
  expect(result.lineTops[0]).toBeLessThan(result.endsWrapTop + 5);
  expect(result.lineTops[1] - result.lineTops[0]).toBe(70);
  expect(result.twoEnds, 'a line reachable only through a mostly hidden slit').toBe(false);
  // Measured: with `clip` on both axes the 20px margin paints the row
  // between the padding edge (40) and 60; past it nothing.
  expect(result.clipBothComputed).toBe('20px');
  expect(result.clipBothHitInMargin).toBe('clipBothRow');
  expect(result.clipBothHitPastMargin).not.toBe('clipBothRow');
  expect(result.clipBothRow, 'a row painted in an overflow-clip-margin').toBe(true);
  // Measured: with `clip` on one axis only the margin does not apply and
  // the row is cut at the padding edge.
  expect(result.clipYOverflow).toBe('visible clip');
  expect(result.clipYHitInMargin).not.toBe('clipYRow');
  expect(result.clipYRow, 'a row past the padding edge of a one-axis clip').toBe(false);
  // The inner fixed card is captured by the transformed outer card, which
  // is itself fixed: the page scroll of 1000 moves neither, so the row is
  // before the origin with nothing to credit.
  expect(result.scrollY).toBe(1000);
  expect(result.fixedOuterTransform).toBe('matrix(1, 0, 0, 1, 0, 0)');
  expect(result.nestedFixedRowBottom).toBe(-580);
  expect(result.nestedFixedRow, 'a row inside a fixed card captured by a fixed transformed card').toBe(false);
});

// #2157 round 12 — three corrections inside the stated scope:
//
//   - at a scroller the best reachable overlap must be READABLE — half of
//     the line or of the opening, whichever is smaller — not merely
//     positive, so a row with a sliver inside a scrollport that can only
//     carry it further out is condemned;
//   - an element that generates no box (`display: contents`) is neither a
//     containing block nor a carrier, whatever its `position`;
//   - `will-change: contain` (with `translate` / `rotate` / `scale` and
//     `offset-path`) establishes a containing block in advance, measured.
test('readable overlap at scrollers, boxless positioned ancestors, will-change: contain', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0 } p { margin: 0 }</style>
    <!-- 0..40: an absolute row under a display: contents "relative" ancestor
         inside a scroller; its real containing block is the box above -->
    <div style="position:relative; width:300px; height:40px">
      <div id="contentsScroller" style="height:40px; overflow:auto">
        <div id="contentsCB" style="display:contents; position:relative">
          <p id="contentsRow" style="position:absolute; top:-600px; height:20px">positioned past a boxless ancestor</p>
        </div>
        <p style="height:1000px">filler</p>
      </div>
    </div>
    <!-- 40..80: a static scroller made a containing block by will-change -->
    <div id="wcContain" style="will-change:contain; width:300px; height:40px; overflow:auto">
      <p id="wcRow" style="position:absolute; top:0; height:20px">anchored by will-change: contain</p>
      <p style="height:400px">filler</p>
    </div>
    <!-- a scrollport with a relatively shifted row showing a few pixels of
         its glyphs at the minimum offset; scrolling only carries it out -->
    <div id="sliverBox" style="position:absolute; top:200px; left:0; width:300px; height:40px; overflow:auto">
      <p id="sliverRow" style="position:relative; top:-15px; height:20px">a sliver at the top</p>
      <p style="height:500px">filler</p>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('contentsScroller').scrollTop = 600;
    byId('wcContain').scrollTop = 300;
    const glyph = (() => {
      const r = document.createRange();
      r.selectNodeContents(byId('sliverRow'));
      const rects = Array.from(r.getClientRects()).filter((q) => q.height > 0);
      return { top: Math.min(...rects.map((q) => q.top)), bottom: Math.max(...rects.map((q) => q.bottom)) };
    })();
    return {
      contentsDisplay: getComputedStyle(byId('contentsCB')).display,
      contentsPosition: getComputedStyle(byId('contentsCB')).position,
      contentsRowBottom: byId('contentsRow').getBoundingClientRect().bottom,
      contentsSpan: byId('contentsScroller').scrollHeight - byId('contentsScroller').clientHeight,
      contentsRow: visible(byId('contentsRow')),
      wcComputed: getComputedStyle(byId('wcContain')).willChange,
      wcRowTop: byId('wcRow').getBoundingClientRect().top,
      wcRow: visible(byId('wcRow')),
      sliverBoxTop: byId('sliverBox').getBoundingClientRect().top,
      sliverGlyphTop: glyph.top,
      sliverGlyphBottom: glyph.bottom,
      sliverSpan: byId('sliverBox').scrollHeight - byId('sliverBox').clientHeight,
      sliverScrollTop: byId('sliverBox').scrollTop,
      sliverRow: visible(byId('sliverRow')),
    };
  }, VISIBILITY_SOURCE);
  // The boxless ancestor is not the containing block: the row sits against
  // the relative box above the scroller, whose 960px of credit never moves
  // it. Parked, condemned — it was admitted while the walk read `relative`.
  expect(result.contentsDisplay).toBe('contents');
  expect(result.contentsPosition).toBe('relative');
  expect(result.contentsRowBottom).toBe(-580);
  expect(result.contentsSpan).toBe(960);
  expect(result.contentsRow, 'an absolute row under a display: contents ancestor').toBe(false);
  // Measured: the absolute row is anchored to the will-change scroller (at
  // -260 after a scroll of 300 from a box at 40), so the scroller carries
  // it and its credit admits.
  expect(result.wcComputed).toBe('contain');
  expect(result.wcRowTop).toBe(-260);
  expect(result.wcRow, 'an absolute row anchored by will-change: contain').toBe(true);
  // At the minimum offset the glyphs protrude a few pixels into the
  // scrollport; every other offset carries them further out. Less than
  // half of the line is ever shown.
  expect(result.sliverScrollTop).toBe(0);
  expect(result.sliverSpan).toBeGreaterThan(0);
  expect(result.sliverGlyphTop).toBeLessThan(result.sliverBoxTop);
  expect(result.sliverGlyphBottom - result.sliverBoxTop).toBeGreaterThan(0);
  expect(result.sliverGlyphBottom - result.sliverBoxTop).toBeLessThan(
    (result.sliverGlyphBottom - result.sliverGlyphTop) / 2,
  );
  expect(result.sliverRow, 'a row whose best reachable overlap is a sliver').toBe(false);
});

// #2157 round 13 — three corrections inside the stated scope, plus the
// readable-overlap bound corrected to its stated intent:
//
//   - `will-change` is matched as whole property names, so
//     `transform-origin` is not read as `transform`;
//   - the slit probe intersects only the ancestors that CARRY the credited
//     scroller, so an `overflow` box an absolutely positioned scroller is
//     not clipped by does not narrow the probe to itself;
//   - `<body>` is skipped by the probe only where it is the viewport (see
//     the next test).
test('will-change tokens match whole names; the probe clips only through carriers', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0 } p { margin: 0 }</style>
    <!-- 0..40: a scroller with will-change: transform-origin — not a
         containing block — under the real one -->
    <div style="position:relative; width:300px; height:40px">
      <div id="wcOrigin" style="height:40px; overflow:auto; will-change:transform-origin">
        <p id="wcOriginRow" style="position:absolute; top:-600px; height:20px">not anchored by transform-origin</p>
        <p style="height:1000px">filler</p>
      </div>
    </div>
    <!-- 40..80: an absolutely positioned scroller whose containing block
         is above a 100px hidden wrapper; an overlay covers only the
         wrapper's box, the rest of the scrollport is readable -->
    <div style="position:relative; width:300px; height:40px">
      <div style="width:100px; height:40px; overflow:hidden">
        <div id="absScroller" style="position:absolute; top:0; left:0; width:300px; height:40px; overflow:auto">
          <p id="absScrollerRow" style="height:20px">readable beside the wrapper</p>
          <p style="height:1000px">filler</p>
        </div>
      </div>
      <div id="absOverlay" style="position:absolute; top:0; left:0; width:100px; height:40px; background:#000"></div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    const hitId = (x: number, y: number) => document.elementFromPoint(x, y)?.id ?? '';
    byId('absScroller').scrollTop = 600;
    return {
      wcComputed: getComputedStyle(byId('wcOrigin')).willChange,
      wcOriginRowBottom: byId('wcOriginRow').getBoundingClientRect().bottom,
      wcOriginRow: visible(byId('wcOriginRow')),
      absScrollerRowBottom: byId('absScrollerRow').getBoundingClientRect().bottom,
      hitBesideWrapper: byId('absScroller').contains(document.elementFromPoint(200, 60)),
      hitOnOverlay: hitId(50, 60),
      absScrollerRow: visible(byId('absScrollerRow')),
    };
  }, VISIBILITY_SOURCE);
  // Measured: the row is anchored to the relative box (at -580), not to the
  // will-change scroller, whose 960px of credit therefore never moves it.
  expect(result.wcComputed).toBe('transform-origin');
  expect(result.wcOriginRowBottom).toBe(-580);
  expect(result.wcOriginRow, 'an absolute row under will-change: transform-origin').toBe(false);
  // The scrollport is hit beside the wrapper and covered only over it: the
  // wrapper does not carry the scroller, so it does not narrow the probe.
  expect(result.absScrollerRowBottom).toBeLessThan(0);
  expect(result.hitBesideWrapper).toBe(true);
  expect(result.hitOnOverlay).toBe('absOverlay');
  expect(result.absScrollerRow, 'a scrollport readable beside a non-carrying wrapper').toBe(true);
});

test('a body that clips at its own box narrows the slit probe', async ({ page }) => {
  await page.setContent(`<!DOCTYPE html>
    <style>html { overflow: hidden } body { margin: 0; overflow: hidden; height: 40px } p { margin: 0 }</style>
    <!-- the root's overflow is non-visible, so the body's does not
         propagate: the body clips at its own 40px box. An 80px scrollport
         shows only through that opening, and an overlay covers it. -->
    <div style="position:relative">
      <div id="bodyClipped" style="width:300px; height:80px; overflow:auto">
        <p id="bodyClippedRow" style="height:20px">seen only through the body's opening</p>
        <p style="height:1000px">filler</p>
      </div>
      <div id="bodyOverlay" style="position:absolute; top:0; left:0; width:300px; height:40px; background:#000"></div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    const hitId = (x: number, y: number) => document.elementFromPoint(x, y)?.id ?? '';
    byId('bodyClipped').scrollTop = 600;
    return {
      rootOverflow: getComputedStyle(document.documentElement).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflowY,
      bodyClientHeight: document.body.clientHeight,
      hitInOpening: hitId(150, 20),
      hitPastOpening: hitId(150, 60),
      rowBottom: byId('bodyClippedRow').getBoundingClientRect().bottom,
      row: visible(byId('bodyClippedRow')),
    };
  }, VISIBILITY_SOURCE);
  // Measured: past the body's 40px opening the scrollport is not hit at
  // all; inside it, only the overlay is.
  expect(result.rootOverflow).toBe('hidden');
  expect(result.bodyOverflow).toBe('hidden');
  expect(result.bodyClientHeight).toBe(40);
  expect(result.hitInOpening).toBe('bodyOverlay');
  expect(result.hitPastOpening).not.toBe('bodyClipped');
  expect(result.rowBottom).toBeLessThan(0);
  expect(result.row, 'a scrollport covered over the whole opening a clipping body leaves').toBe(false);
});

// #2157 round 14 — a non-replaced inline box is not transformable and takes
// no containment, so on a `display: inline` span only `filter` /
// `backdrop-filter` (and `position`) establish a containing block. Measured
// in Chromium 141 for every property the hint predicate reads.
test('an inline wrapper with a transform is not a containing block; one with a filter is', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html>
    <style>body { margin: 0 } p { margin: 0 }</style>
    <!-- 0..40: an absolute row inside a transformed INLINE span inside a
         scroller; its real containing block is the relative box above -->
    <div style="position:relative; width:300px; height:40px">
      <div id="inlineTScroller" style="height:40px; overflow:auto">
        <span id="inlineT" style="transform:scale(1)">inline<p id="inlineTRow" style="position:absolute; top:-600px; height:20px">not held by an inline transform</p></span>
        <p style="height:1000px">filler</p>
      </div>
    </div>
    <!-- 40..80: the same shape with a filter on the span, which does hold
         the row, so the scroller carries it -->
    <div style="position:relative; width:300px; height:40px">
      <div id="inlineFScroller" style="height:40px; overflow:auto">
        <span id="inlineF" style="filter:blur(0px)">inline<p id="inlineFRow" style="position:absolute; top:0; height:20px">held by an inline filter</p></span>
        <p style="height:1000px">filler</p>
      </div>
    </div>
  `);
  const result = await page.evaluate((helpersSrc) => {
    const family = new Function(`return (${helpersSrc})();`)();
    const visible = family.visible as (n: Element | null) => boolean;
    const byId = (id: string) => document.getElementById(id)!;
    byId('inlineTScroller').scrollTop = 600;
    byId('inlineFScroller').scrollTop = 300;
    return {
      inlineTDisplay: getComputedStyle(byId('inlineT')).display,
      inlineTTransform: getComputedStyle(byId('inlineT')).transform,
      inlineTRowBottom: byId('inlineTRow').getBoundingClientRect().bottom,
      inlineTRow: visible(byId('inlineTRow')),
      inlineFDisplay: getComputedStyle(byId('inlineF')).display,
      inlineFFilter: getComputedStyle(byId('inlineF')).filter,
      inlineFSpanTop: byId('inlineF').getBoundingClientRect().top,
      inlineFRowTop: byId('inlineFRow').getBoundingClientRect().top,
      inlineFRow: visible(byId('inlineFRow')),
    };
  }, VISIBILITY_SOURCE);
  // Measured: the transformed span keeps `display: inline`, its computed
  // transform is the identity matrix, and the row is anchored to the
  // relative box (bottom -580), not to the span — so the scroller's credit
  // never moves it, and it is condemned.
  expect(result.inlineTDisplay).toBe('inline');
  expect(result.inlineTTransform).toBe('matrix(1, 0, 0, 1, 0, 0)');
  expect(result.inlineTRowBottom).toBe(-580);
  expect(result.inlineTRow, 'an absolute row under a transformed inline span').toBe(false);
  // Measured: the filtered span IS the containing block — the row's top
  // equals the span's, both carried 300 up by the scroller — so the
  // scroller's credit admits.
  expect(result.inlineFDisplay).toBe('inline');
  expect(result.inlineFFilter).toBe('blur(0px)');
  expect(result.inlineFRowTop).toBe(result.inlineFSpanTop);
  expect(result.inlineFRowTop).toBeLessThan(0);
  expect(result.inlineFRow, 'an absolute row under a filtered inline span').toBe(true);
});
