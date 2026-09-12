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
