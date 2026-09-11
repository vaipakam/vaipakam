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

test('both copies of the drive visibility predicate agree, and reject clipped content', async ({
  page,
}) => {
  const src = fs.readFileSync(DRIVE, 'utf8');
  const clipHelpers = arrowBlocks(src, 'notClipped');
  const paintHelpers = arrowBlocks(src, 'paintsText');
  const predicates = arrowBlocks(src, 'visible');

  // Pinned counts, deliberately. If the drive grows a third copy, or
  // unifies down to one (#2102), this test is describing a shape that no
  // longer exists and must be revisited rather than quietly passing over
  // whichever copies it still happens to find.
  expect(clipHelpers).toHaveLength(2);
  expect(paintHelpers).toHaveLength(2);
  expect(predicates).toHaveLength(2);

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
  `);

  for (const [i, predicate] of predicates.entries()) {
    const result = await page.evaluate(
      ([clipSrc, paintSrc, visSrc]) => {
        // One shared scope for the pair: `visible` calls `notClipped`,
        // and `eval` of a `const` would not leak either into scope here.
        const visible = new Function(
          `${clipSrc}\n${paintSrc}\n${visSrc}\nreturn visible;`,
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
  const visSrc = arrowBlocks(src, 'visible')[0];

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
      const visible = new Function(`${clip}\n${paint}\n${vis}\nreturn visible;`)() as (
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
  const visSrc = arrowBlocks(src, 'visible')[0];
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
    </dl>
  `);

  const result = await page.evaluate(
    ([clip, paint, vis, text, row]) => {
      const scope = new Function(
        `${clip}\n${paint}\n${vis}\n${text}\n${row}\nreturn { rowShown, visible };`,
      )() as { rowShown: (r: Element) => boolean; visible: (n: Element | null) => boolean };
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
  const visSrc = arrowBlocks(src, 'visible')[0];
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

  await page.setContent(`
    <style>
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
      <div class="body" id="styleOnly"><style>.x { color: red; }</style></div>
      <div class="body" id="styleBeside"><style>.x { color: red; }</style><p>This loan can be closed out now.</p></div>
      <div class="body" id="withSrOnly">
        <span class="srOnly">Forced close-out</span>
        <p>This loan can be closed out now.</p>
      </div>
    </div>
  `);

  const result = await page.evaluate(
    ([clip, paint, vis, leaf]) => {
      const scope = new Function(
        `${clip}\n${paint}\n${vis}\n${leaf}\nreturn { visible, visibleTextOf };`,
      )() as {
        visible: (n: Element | null) => boolean;
        visibleTextOf: (r: Element | null) => string;
      };
      const byId = (id: string) => document.getElementById(id)!;
      // EXACTLY the expression the drive assigns to `bodyVisible`.
      const bodyVisible = (b: Element | null) =>
        scope.visible(b) &&
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
});
