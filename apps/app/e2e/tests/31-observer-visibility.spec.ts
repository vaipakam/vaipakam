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
          plain: visible(byId('plain')),
          scrolledOut: visible(byId('scrolledOut')),
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
    // The deliberate limit of the rule, pinned so it cannot be tightened
    // by accident: content merely scrolled out of a scroll container is
    // reachable, and condemning it would be a false failure — the
    // direction that gets a check switched off.
    expect(result.scrolledOut, `copy ${i}: scrolled out of a scroller`).toBe(true);
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
  const textSrc = arrowBlocks(src, 'hasText', 'el')[0];
  const rowSrc = arrowBlocks(src, 'rowShown', 'row')[0];

  // One `rowShown` and one `hasText`: unlike `visible`, these are not
  // duplicated. If that changes this test is describing a shape that no
  // longer exists.
  expect(arrowBlocks(src, 'rowShown', 'row')).toHaveLength(1);
  expect(arrowBlocks(src, 'hasText', 'el')).toHaveLength(1);

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
  // Recorded rather than assumed: if this ever becomes false the rows
  // are being rejected by geometry and the text rule is no longer the
  // thing under test.
  expect(
    result.emptyLabelLooksVisible,
    'the empty label still passes the visibility predicate — which is why the text rule is needed',
  ).toBe(true);
});
