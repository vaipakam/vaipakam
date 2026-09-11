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

/** Every `const <name> = (node) => { … };` in the drive, by brace match. */
function arrowBlocks(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`const ${name} = \\(node\\) => \\{`, 'g');
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
  const predicates = arrowBlocks(src, 'visible');

  // Pinned counts, deliberately. If the drive grows a third copy, or
  // unifies down to one (#2102), this test is describing a shape that no
  // longer exists and must be revisited rather than quietly passing over
  // whichever copies it still happens to find.
  expect(clipHelpers).toHaveLength(2);
  expect(predicates).toHaveLength(2);

  await page.setContent(`
    <div id="collapsed" style="height:0; overflow:hidden">
      <p id="clipped">a fee row the lender cannot see</p>
    </div>
    <p id="plain">an ordinary visible row</p>
    <div id="scroller" style="height:40px; overflow:auto">
      <p style="height:200px">tall filler</p>
      <p id="scrolledOut">below the fold, but the lender can scroll to it</p>
    </div>
  `);

  for (const [i, predicate] of predicates.entries()) {
    const result = await page.evaluate(
      ([clipSrc, visSrc]) => {
        // One shared scope for the pair: `visible` calls `notClipped`,
        // and `eval` of a `const` would not leak either into scope here.
        const visible = new Function(
          `${clipSrc}\n${visSrc}\nreturn visible;`,
        )() as (n: Element | null) => boolean;
        const byId = (id: string) => document.getElementById(id);
        return {
          clipped: visible(byId('clipped')),
          plain: visible(byId('plain')),
          scrolledOut: visible(byId('scrolledOut')),
          // Recorded so a future failure says WHICH branch ran. The
          // round-28 defect was invisible precisely because the branch
          // under test was not the branch in use.
          usesCheckVisibility:
            typeof byId('plain')!.checkVisibility === 'function',
        };
      },
      [clipHelpers[i], predicate] as const,
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
    expect(result.plain, `copy ${i}: ordinary content`).toBe(true);
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
    ([clip, vis]) => {
      const visible = new Function(`${clip}\n${vis}\nreturn visible;`)() as (
        n: Element | null,
      ) => boolean;
      const all = [...document.querySelectorAll('[data-testid="forced-close-card"]')];
      const shown = all.filter(visible);
      return all.indexOf(shown[0]);
    },
    [clipSrc, visSrc] as const,
  );

  expect(chosenIndex, 'the predicate skips the transparent card').toBe(1);
  await expect(cards.nth(chosenIndex)).toHaveAttribute('id', 'real');
});
