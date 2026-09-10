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
