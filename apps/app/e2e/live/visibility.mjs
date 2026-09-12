/**
 * The live drive's element-visibility predicate family — ONE definition,
 * run inside the browser (#2102).
 *
 * `live-position-observe.mjs` used to carry this family twice, once in
 * the card `page.evaluate` and once in the receipt `locator.evaluate`,
 * because Playwright serialises the evaluate callback's SOURCE and two
 * callbacks share no closure. The copies had already drifted once before
 * they were found, and every later rule had to be written into both — a
 * hand-maintained duplicate of the single most load-bearing helper in
 * the drive, where a divergence means two definitions of "the lender can
 * see this" inside one verdict.
 *
 * ## How one definition reaches every evaluate
 *
 * `visibilityHelpers` is an ordinary function whose body defines the
 * helpers and returns them. It is never called in Node. `withVisibility`
 * composes its SOURCE TEXT with an evaluate body's source text into a
 * new function — on the Node side, with `new Function` — and hands THAT
 * to Playwright, which serialises it like any other callback. So the
 * page runs plain code: no `eval` in the page, no CSP exposure (the
 * option #2102 weighed and rejected), and no global installed on the app
 * under test (the `addInitScript` option, which the watch-only posture
 * argued against). The earlier mount wait and back-button read DID run
 * `new Function` inside the page; they now go through the same
 * composition, so the drive's in-page eval count went from two to zero.
 *
 * Adding a rule here reaches every consumer by construction — the card
 * pass, the receipt pass, the mount wait, the back-button read, and the
 * fixture suite (`31-observer-visibility.spec.ts` imports this module
 * rather than slicing the drive's source by brace-matching).
 *
 * ## Contract
 *
 * Pure DOM. Nothing in here may reference a Node module or a variable of
 * the evaluate that calls it — it runs in the browser, in a scope of its
 * own. Comments are the history of each rule; they were written in the
 * card copy and are kept here verbatim, round numbers included, because
 * the rounds are the record of why each branch exists.
 */

/**
 * Define the helpers. Runs IN THE BROWSER — see the module header. The
 * return value is what an evaluate body receives as `V`.
 *
 * `visibleTextOf.sawUnresolvedGenerated` rides on the function object,
 * so the signature stays a string for its many call sites (round 116);
 * every call to `visibilityHelpers()` yields a fresh family and a fresh
 * flag, so one evaluate's reading cannot leak into another's.
 */
export function visibilityHelpers() {
  // Does this computed style establish a containing block for absolutely
  // and fixed-positioned descendants? Read from the properties that define
  // it (round 65 P2, see `notClipped`): `transform`, `perspective`,
  // `filter`, paint/layout `contain`, or a `will-change` hint for any of
  // them — plus `backdrop-filter` (#2157 round 2). Shared by the clip walk
  // and the scroll-credit walk (#2138), so the two cannot answer the
  // containing-block question differently.
  //
  // MEASURED, not assumed, in the drive's own Chromium (141): an absolute
  // child of each listed property is positioned against it. `container-type`
  // was measured the same way and is NOT one — `inline-size` and `size`
  // containers both leave an absolute child positioned against the initial
  // containing block — so it is deliberately absent although this
  // repository uses it. Listing it would skip real scrollers in the credit
  // walk and revoke real clipping in the clip walk.
  const establishesCB = (cs) =>
    cs.transform !== 'none' ||
    cs.perspective !== 'none' ||
    cs.filter !== 'none' ||
    (typeof cs.backdropFilter === 'string' && cs.backdropFilter !== 'none') ||
    /\b(paint|layout|strict|content)\b/.test(cs.contain || '') ||
    /\b(transform|perspective|filter)\b/.test(cs.willChange || '');

  /**
   * How far, in VIEWPORT pixels, can scrolling `n` move the content it
   * carries — as a per-axis interval that contains 0, the current position?
   *
   * #2138 (rounds 1–2 of #2157). Both walks below ask this: the clip walk
   * for "can this box be brought into the clipper", the origin walk for
   * "can this box be brought past the document's origin". One helper, so
   * they cannot disagree about what a scroller can do.
   *
   *   - BOTH DIRECTIONS, NEITHER FORCED. The offset can go anywhere in
   *     [min, max], so the content can move by [s - max, s - min] on that
   *     axis — an interval containing 0. A reversed axis (`column-reverse`,
   *     `rtl`, `row-reverse`) rests at 0 and scrolls negative, so its
   *     minimum is -span rather than 0. Callers take whichever end helps.
   *   - THROUGH THE TRANSFORM CHAIN, AS VECTORS. Rects are viewport
   *     coordinates and `scrollTop` is the scroller's own, so the local
   *     rectangle of reachable displacements goes through the accumulated
   *     transforms from the scroller outward (linear part only — a
   *     displacement has no position) and its four mapped corners bound
   *     the result. Under `scale(2)` restoring 300 moves the box 600; under
   *     `rotate(180deg)` the rescuing end is the far one, and taking both
   *     ends is what finds it.
   *   - PER-AXIS BOUNDS ARE AN OVER-APPROXIMATION of the mapped
   *     parallelogram, and summing them across nested scrollers is another.
   *     Both err toward ADMITTING — a missed defect, never an invented one.
   *   - `unquantifiable` when the engine cannot supply the matrix. Callers
   *     admit rather than guess.
   *
   * @returns {null | {unquantifiable: true} | {lo: {x: number, y: number}, hi: {x: number, y: number}, spanX: number, spanY: number}}
   *   `null` when `n` is not styled as a scroll container at all; a zero
   *   `spanY` / `spanX` means that axis has scroller styling and no
   *   movement.
   */
  const scrollShiftRange = (n, cs) => {
    const scrollsY = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    const scrollsX = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    if (!scrollsY && !scrollsX) return null;
    // `spanY` / `spanX` are returned beside the range (#2157 round 3): an
    // `overflow: auto` box whose content fits has the STYLE of a scroller
    // and none of the movement, and the clip walk must treat that axis as
    // an ordinary clipper — its content cannot be scrolled into view.
    const spanY = scrollsY ? Math.max(0, n.scrollHeight - n.clientHeight) : 0;
    const spanX = scrollsX ? Math.max(0, n.scrollWidth - n.clientWidth) : 0;
    const minTop = cs.flexDirection === 'column-reverse' ? -spanY : 0;
    const minLeft = cs.direction === 'rtl' || cs.flexDirection === 'row-reverse' ? -spanX : 0;
    const sY = scrollsY ? n.scrollTop : 0;
    const sX = scrollsX ? n.scrollLeft : 0;
    const local = {
      xLo: sX - (minLeft + spanX),
      xHi: sX - minLeft,
      yLo: sY - (minTop + spanY),
      yHi: sY - minTop,
    };
    let m = null;
    try {
      for (let a = n; a; a = a.parentElement) {
        const t = getComputedStyle(a).transform;
        if (t && t !== 'none') m = new DOMMatrixReadOnly(t).multiply(m ?? new DOMMatrixReadOnly());
      }
      if (m === null) {
        return { lo: { x: local.xLo, y: local.yLo }, hi: { x: local.xHi, y: local.yHi }, spanX, spanY };
      }
      const lo = { x: Infinity, y: Infinity };
      const hi = { x: -Infinity, y: -Infinity };
      for (const [dx, dy] of [
        [local.xLo, local.yLo],
        [local.xLo, local.yHi],
        [local.xHi, local.yLo],
        [local.xHi, local.yHi],
      ]) {
        const p = m.transformPoint(new DOMPoint(dx, dy, 0, 0));
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { unquantifiable: true };
        lo.x = Math.min(lo.x, p.x);
        hi.x = Math.max(hi.x, p.x);
        lo.y = Math.min(lo.y, p.y);
        hi.y = Math.max(hi.y, p.y);
      }
      return { lo, hi, spanX, spanY };
    } catch {
      return { unquantifiable: true };
    }
  };

  /**
   * Is `box` parked entirely BEFORE the document's origin — left of it or
   * above it — with no scroll position, the page's or an ancestor
   * container's, from which it becomes readable?
   *
   * The document-origin test (round 81) lives here so that its two
   * consumers — `shownBox` for the element's box, `paintsText` for the
   * glyph rectangles — decide reachability in one place. Below the fold
   * is reachable: `window.scrollX` / `scrollY` convert the viewport rect
   * into document coordinates, so a box at y=4000 has positive
   * coordinates and is unaffected.
   *
   * #2138 — AND SO IS CONTENT SCROLLED ABOVE AN INNER CONTAINER'S SLIT.
   * A row inside an `overflow: auto` box near the top of the document,
   * scrolled above that box's own visible slit, has a negative viewport
   * rect while `window.scrollY` is still 0 — measured in a browser rather
   * than argued — so the document-origin test alone condemned copy the
   * lender can scroll straight back to. That is the false-FAIL direction
   * this predicate is otherwise built to avoid.
   *
   * QUANTIFIED by `scrollShiftRange`, and only over scrollers that carry
   * the node: an absolutely positioned box is moved by a scroller only
   * from its containing block upward, a viewport-fixed box by nothing
   * unless an ancestor establishes its containing block — the same walk
   * `notClipped` uses, the same `establishesCB`. The page's own scrolling
   * element is skipped because `window.scrollX` / `scrollY` already cover
   * it; only that element, since an independently scrolling `<body>` is
   * real credit. `ownScroll` is how `paintsText` says it is asking about
   * the glyphs, which the node's own scroll carries, rather than the box,
   * which it does not.
   *
   * Deliberately narrow still. A box parked far to the RIGHT beyond every
   * scroll extent, or an RTL document's mirrored origin, is a reachability
   * question this cannot answer from one rect, and guessing would condemn
   * copy the lender can read. The residual is a missed defect, which is
   * the direction this file takes every time.
   */
  const unreachableBeforeOrigin = (node, box, { ownScroll = false } = {}) => {
    const beforeX = box.right + window.scrollX <= 0;
    const beforeY = box.bottom + window.scrollY <= 0;
    if (!beforeX && !beforeY) return false;
    const flow = getComputedStyle(node).position;
    // `sticky` is in flow for THIS question: it rides its scroller.
    let reachedCB = flow === 'static' || flow === 'relative' || flow === 'sticky';
    const pageScroller = document.scrollingElement || document.documentElement;
    // The favourable end of every carrying scroller's range, summed: how
    // far the content can be moved toward +x / +y.
    let hiX = 0;
    let hiY = 0;
    for (let n = ownScroll ? node : node.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (n !== node && !reachedCB) {
        if (flow === 'fixed' ? establishesCB(cs) : cs.position !== 'static' || establishesCB(cs)) {
          reachedCB = true;
        } else {
          continue;
        }
      }
      if (n === pageScroller || n === document.documentElement) continue;
      const range = scrollShiftRange(n, cs);
      if (range === null) continue;
      if (range.unquantifiable) return false;
      hiX += range.hi.x;
      hiY += range.hi.y;
    }
    const stuckX = beforeX && box.right + window.scrollX + hiX <= 0;
    const stuckY = beforeY && box.bottom + window.scrollY + hiY <= 0;
    return stuckX || stuckY;
  };
  // ROUND 22 P2 — OPACITY IS NOT INHERITED, so asking the node
  // alone is not asking whether the lender can see it.
  //
  // An ancestor with `opacity: 0` makes everything under it
  // invisible while each descendant still computes `opacity: 1`
  // and keeps a non-zero rect — so a card, a body or a submit
  // control inside one read as visible. `display: none` and
  // `visibility: hidden` do not have this problem: the first
  // zeroes the rect and the second inherits.
  //
  // `checkVisibility` asks the browser the whole question, walking
  // the chain for exactly these properties. The manual walk is the
  // fallback for an engine without it, and it is a walk rather
  // than a single read for the reason above.
  // ROUND 28 P2 — A COLLAPSED CLIPPING ANCESTOR HIDES ITS
  // DESCENDANTS while each of them keeps its own layout box.
  //
  // `checkVisibility` answers about display, visibility, opacity
  // and content-visibility. It says nothing about OVERFLOW, so a
  // `height: 0; overflow: hidden` wrapper paints none of its
  // subtree while every element inside is laid out normally and
  // reports a full-size rect. Both halves of the test above
  // therefore pass for content clipped entirely out of view, and
  // `innerText` still yields all of its text.
  //
  // Only a COLLAPSED clipper counts, deliberately. Requiring an
  // element to lie inside every clipping ancestor's box would also
  // condemn content scrolled out of a scroll container, which the
  // lender can simply scroll back to — and a false FAIL is the
  // direction that gets a check switched off. A zero-area box on
  // something that clips is not scrolled-away content; it is
  // content that cannot be reached at all.
  //
  // Measured on the RECT rather than `clientHeight`, which is 0
  // for inline elements: `overflow` has no effect on a non-replaced
  // inline box, so keying on `clientHeight` would condemn anything
  // inside an ordinary `<span>`.
  const notClipped = (node) => {
    // ROUND 36 P2 — A CLIPPER DOES NOT HAVE TO BE EXACTLY ZERO to hide
    // everything inside it. `height: 0` was the only case rounds 28/29
    // rejected, so `height: 1px; overflow: hidden` walked straight
    // through: the ancestor is non-zero, every descendant keeps a
    // full-size rect and passes `checkVisibility`, and `innerText` yields
    // all of it — so the fee and loss rows of the receipt were recorded
    // as read while the lender could see a single pixel of them.
    //
    // A non-scrollable clipper now has to actually SHOW the element: at
    // least half of the element's extent must fall inside the clipper's
    // box on the clipped axis. Half rather than any overlap, because a
    // 1px clipper DOES overlap — that is exactly how it escaped — and
    // rather than full containment, which would condemn a row whose
    // descender is clipped by a pixel. Half a line is the point below
    // which a figure cannot be read at all.
    //
    // SCROLLABLE clippers stay exempt, which is rounds 28/29's deliberate
    // limit restated: content the lender can scroll to is reachable, and
    // condemning it is the false-FAIL direction that gets a check
    // switched off. `auto`/`scroll` WITH something to scroll is the test;
    // `hidden` and `clip` are not user-scrollable however much they hold.
    //
    // OUT-OF-FLOW ELEMENTS GET THE BENEFIT OF THE DOUBT, and only for the
    // intersection rule. Which clipper applies to an absolutely or fixed
    // positioned box is a containing-block question — a `position:
    // absolute` child of a `position: static` `overflow: hidden` ancestor
    // is NOT clipped by it — and answering it wrongly condemns content
    // the lender can see. The collapsed-clipper rule still applies to
    // them. Nothing on this card is out of flow; this is here so the
    // predicate stays honest if something ever is.
    const flow = getComputedStyle(node).position;
    const inFlow = flow === 'static' || flow === 'relative';
    // ROUND 65 P2 — WHICH ancestors clip an out-of-flow box, rather than
    // none of them.
    //
    // The exemption below was written to avoid a containing-block
    // question, and avoiding it cost the whole rule: `inFlow` is computed
    // once, so for any absolute or fixed node the walk skipped EVERY
    // ancestor intersection test. An absolutely positioned body, receipt
    // leaf or action inside a positioned `overflow: hidden` box — which IS
    // its containing block and definitively clips it — carried fully
    // clipped readiness copy or funds disclosures into a passing verdict.
    //
    // The question is answerable, and narrowly. An absolutely positioned
    // box is clipped by an `overflow` ancestor only from its CONTAINING
    // BLOCK upwards; ancestors between it and that block do not clip it.
    // So the walk skips until it reaches the containing block and applies
    // the rule from there — including to the containing block itself,
    // which clips its own padding box.
    //
    // Read from the properties that define it rather than guessed: for
    // `absolute`, the nearest ancestor that is positioned or that
    // establishes a containing block by `transform`, `filter`,
    // `perspective` or paint/layout `contain`; for `fixed`, only the
    // latter group, since a merely positioned ancestor does not capture a
    // fixed box. Anything this cannot decide leaves the ancestor skipped,
    // so the residual stays a missed defect rather than an invented one.
    // `establishesCB` is hoisted to the top of the family (#2138): the
    // scroll-credit walk asks the same containing-block question.
    let reachedCB = inFlow;
    const r = node.getBoundingClientRect();
    // TRUNCATED TEXT IS CONDEMNED, DELIBERATELY, and this note exists so
    // it is not "fixed" later as a false positive. `text-overflow:
    // ellipsis` with `white-space: nowrap` gives a line box wider than its
    // clipping box, so a heavily truncated line fails the ratio below.
    // That is the right answer HERE even though it would be wrong on a
    // chrome label: a fee value cut off mid-number, or an explanation cut
    // off mid-sentence, is exactly what this drive exists to catch, and a
    // reader seeing an ellipsis does not make the missing half readable.
    //
    // Checked rather than assumed — the only ellipsis rules in
    // `global.css` are `.connect-addr`/`.connect-label` and the two
    // `.select-menu-*` classes, which are the header wallet button and the
    // select menus. Nothing observed by this drive is truncated today.
    //
    // One Range per NODE, not per clipping ancestor: this predicate runs
    // for the card, the body, the control and every receipt leaf on every
    // poll tick, and rebuilding the range inside the walk was pure waste.
    const ownText = [...node.childNodes].some(
      (c) => c.nodeType === 3 && c.textContent.trim() !== '',
    );
    const boxes = (() => {
      if (!ownText) return [r];
      try {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter(
          (q) => q.width > 0 && q.height > 0,
        );
        // "No rects" must not read as "nothing is visible".
        return rects.length > 0 ? rects : [r];
      } catch {
        return [r];
      }
    })();
    // ROUND 44 P2 — STARTS AT THE NODE, not at its parent.
    //
    // A leaf that clips its OWN text was never examined: `height: 1px;
    // overflow: hidden` on the `dd` itself leaves a positive rect (so the
    // geometry test passes), `checkVisibility` positive, `paintsText`
    // satisfied — and the only box that would have caught it was the one
    // box this walk skipped. `innerText` then supplied the hidden
    // disclosure and the confirmation scan recorded it as read.
    //
    // Including the node costs nothing on a normal leaf: `overflow:
    // visible` skips the body of the loop, and a leaf sized to its own
    // content contains its own line boxes by definition.
    // ROUND 48 P2 — A CLIP PATH HIDES TEXT THAT EVERY OTHER TEST VOUCHES FOR.
    //
    // `clip-path: inset(50%)` — the modern visually-hidden idiom — leaves the
    // box laid out at full size, `checkVisibility` positive, the overflow walk
    // satisfied (there is no overflow) and `paintsText` satisfied (the colour
    // is opaque), while nothing is painted. `innerText` keeps yielding every
    // word, so the receipt's fee and loss rows could be recorded as read with
    // the lender seeing none of them. Same class as rounds 37, 43, 44 and 45:
    // a property that hides the CONTENT rather than the box.
    //
    // ONLY `inset()`, and only where the region is PROVABLY EMPTY. A circle,
    // an ellipse, a polygon, a `path()` or a `url()` reference can each be
    // empty too, and deciding that in general is a geometry problem this
    // predicate has no business attempting — getting it wrong condemns content
    // the lender can see, which is the error that gets a whole check switched
    // off. Anything it cannot read counts as painted, so the residual is a
    // missed defect and never an invented one.
    //
    // The legacy `clip: rect(...)` idiom needs nothing here: this codebase's
    // `.visually-hidden` pairs it with `width: 1px; height: 1px;
    // overflow: hidden`, which the half-extent rule below already rejects.
    const emptyClipRegion = (cs, box) => {
      const raw = (cs.clipPath || 'none').trim();
      const m = /^inset\(([^)]*)\)$/i.exec(raw);
      if (!m) return false;
      // `round <radii>` describes the corners, not the extent.
      const parts = m[1].split(/\s+round\s+/i)[0].trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0 || parts.length > 4) return false;
      const px = (t, extent) => {
        const v = String(t);
        if (v.endsWith('%')) {
          const n = Number(v.slice(0, -1));
          return Number.isFinite(n) ? (n / 100) * extent : null;
        }
        const n = Number(v.endsWith('px') ? v.slice(0, -2) : v);
        return Number.isFinite(n) ? n : null;
      };
      // CSS shorthand order, top/right/bottom/left with the usual fill-ins.
      const top = px(parts[0], box.height);
      const right = px(parts[1] ?? parts[0], box.width);
      const bottom = px(parts[2] ?? parts[0], box.height);
      const left = px(parts[3] ?? parts[1] ?? parts[0], box.width);
      if ([top, right, bottom, left].some((v) => v === null)) return false;
      // Judged only on an axis with extent to lose. A degenerate box is
      // someone else's finding, and calling it an empty clip would be
      // asserting something this has not established.
      return (
        (box.height > 0 && top + bottom >= box.height) ||
        (box.width > 0 && left + right >= box.width)
      );
    };
    // #2138 — what the scrollers passed so far can do, see the note at the
    // test below: the summed displacement range they offer the content,
    // the intersection of their slits (the slit anything scrolled into
    // view is seen through), and whether one of them was unquantifiable.
    const zero = () => ({ xLo: 0, xHi: 0, yLo: 0, yHi: 0 });
    const add = (r, range) => {
      r.xLo += range.lo.x;
      r.xHi += range.hi.x;
      r.yLo += range.lo.y;
      r.yHi += range.hi.y;
    };
    // What moves the ROW: every scroller passed so far.
    const shift = zero();
    // The innermost slit the row is seen through, in CURRENT coordinates;
    // `innerShift` is how far the row can move relative to that slit (the
    // scrollers at or below it), `slitShift` how far the slit itself can be
    // carried by the scrollers passed since it was set (#2157 round 3).
    let slit = null;
    let innerShift = zero();
    const slitShift = zero();
    let unbounded = false;
    for (let n = node; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      // An empty clip region on the node or on any ancestor hides
      // everything inside it, whatever the overflow rules say.
      //
      // The string test comes FIRST so the rect is not measured on
      // every ancestor of every node on every poll tick. `clip-path`
      // is `none` almost everywhere, and forcing a layout read to
      // discover that was a cost my own first version added silently.
      const clipPath = cs.clipPath;
      if (
        clipPath &&
        clipPath !== 'none' &&
        emptyClipRegion(cs, n.getBoundingClientRect())
      ) {
        return false;
      }
      // ROUND 115 P2 — BEFORE THE VISIBLE-OVERFLOW FAST PATH, NOT AFTER.
      //
      // `if (!clipsY && !clipsX) continue` used to run first, so a POSITIONED
      // containing block whose own overflow is visible was skipped without ever
      // setting `reachedCB`. A higher STATIC ancestor with `overflow: hidden` —
      // which genuinely does clip the leaf, being above the containing block —
      // then failed the `!reachedCB` test, was treated as lying below it, and
      // was skipped too. Fully hidden funds copy satisfied `shownBox`.
      //
      // Where an element sits relative to the containing block has nothing to
      // do with whether it clips, so that question is answered first for every
      // ancestor. The box tests below therefore run only at or above the
      // containing block, which is the same correction in the other direction:
      // an ancestor BELOW it does not clip an out-of-flow descendant, so a
      // zero-height one there was never evidence of hidden text.
      // ROUND 45 P2 — the out-of-flow exemption is about ANCESTORS, never
      // about the node's own clipping box.
      //
      // I wrote it to avoid a containing-block question: whether a given
      // ancestor clips an absolutely positioned descendant depends on which
      // element is that descendant's containing block, and answering it
      // wrongly condemns content the lender can see. None of that
      // uncertainty applies to an element clipping ITS OWN text — every
      // element clips its own content, whatever its `position` is.
      //
      // Round 44 put `node` into this walk and this `continue` skipped it
      // right back out again for a positioned leaf, so `position: absolute;
      // height: 1px; overflow: hidden` still passed. The fix for the skipped
      // box, skipping the same box.
      // ROUND 65 P2 — skip only UP TO the containing block, then apply the
      // rule. `n !== node` keeps round 45's correction: an element always
      // clips its OWN text, whatever its `position`.
      if (!reachedCB && n !== node) {{
        if (flow === 'fixed' ? establishesCB(cs) : cs.position !== 'static' || establishesCB(cs)) {{
          reachedCB = true;
        }} else {{
          continue;
        }}
      }}
      const clipsY = cs.overflowY !== 'visible';
      const clipsX = cs.overflowX !== 'visible';
      if (!clipsY && !clipsX) continue;
      const box = n.getBoundingClientRect();
      if (clipsY && box.height === 0) return false;
      if (clipsX && box.width === 0) return false;
      const range = scrollShiftRange(n, cs);
      // ROUND 43 P2 — PER LINE, not per element.
      //
      // The half-of-the-element rule reads a MULTI-LINE leaf as visible
      // whenever half of it survives — so a two-line value with its second
      // line entirely clipped passes at exactly 50%, `innerText` yields
      // both lines, and the run records a lender as having read a
      // disclosure whose second half is not on screen. On this surface the
      // clipped half is as likely as not to be the one carrying the
      // consequence.
      //
      // A Range over the node's own text yields one client rect per LINE
      // BOX, which is the unit a reader actually consumes. Every line must
      // clear the same half-visible bar the element used to clear as a
      // whole — so a descender trimmed by a pixel still passes (that line
      // is ~95% shown) while a line that is wholly outside does not.
      //
      // SCOPED TO NODES CARRYING THEIR OWN TEXT, and computed ONCE above
      // the ancestor walk rather than per ancestor.
      //
      // Both corrected after writing this. `selectNodeContents` on a
      // CONTAINER yields a rect per line of its whole subtree, so applying
      // the per-line rule to the card or the body would condemn the entire
      // surface whenever any single descendant line was mostly clipped —
      // and the resulting verdict says "card is in the DOM but not
      // visible", which is the wrong sentence about a card that is largely
      // on screen. The finding was about a multi-line `dt`/`dd`, and a
      // leaf's own text is exactly where "can this be read" is the
      // question being asked. Same scope `paintsText` uses, for the same
      // reason.
      //
      // Containers keep the element-rect rule they already had, and their
      // leaves are checked individually anyway — the receipt probe
      // requires every row AND both of its leaves to pass.
      //
      // #2138 — REACHABLE, NOT MERELY PRESENT, and rounds 28/29's scroller
      // exemption is now the quantified form of itself.
      //
      // Rounds 28/29 exempted a SCROLLER entirely: content scrolled out of
      // it is reachable, and condemning it is the false-FAIL direction. Two
      // things that exemption could not see (#2157 rounds 1–2):
      //
      //   - a NON-scrollable clipper ABOVE a scroller — a rounded-corner
      //     card around a scrolling list, `html { overflow: hidden }` above
      //     an independently scrolling body — saw the same scrolled-out
      //     rect and condemned it one level up;
      //   - the reverse: a blanket "an inner scroller exists" exemption
      //     admits a scroller whose slit lies wholly outside the clipper,
      //     or content the scroller can only move FURTHER away.
      //
      // So the walk carries what the passed scrollers can actually do.
      // `shift` is their summed displacement range (both directions, via
      // `scrollShiftRange`); `slit` is the intersection of their slits,
      // which is where anything scrolled into view is seen.
      //
      //   AT A SCROLLER: the box must be able to REACH the slit — some
      //   displacement in the range puts any part of it inside. Not the
      //   half rule: a container taller than twice the slit is read by
      //   scrolling through it, and "can most of it be seen at once" is the
      //   wrong question of a scroll container, which is what rounds 28/29
      //   established. Content the scroller can only carry away fails.
      //
      //   AT A NON-SCROLLABLE CLIPPER WITH A SCROLLER BELOW IT: the SLIT is
      //   what has to be shown, and it gets the half rule the content
      //   would have got — a scrollport mostly hidden by the clipper shows
      //   at most a sliver of anything scrolled into it. Wholly outside
      //   fails outright. The content's own reachability was settled at
      //   the scroller.
      //
      //   WITH NO SCROLLER BELOW IT: the half rule on the box, unchanged.
      //
      // A ZERO-extent clipper is still condemned above whatever scrolls
      // inside it, and an UNQUANTIFIABLE scroller (no transform matrix from
      // the engine) admits everything above it rather than guessing.
      //
      // ROUND 3 OF #2157 — TWO MORE, both about what "scroller" meant:
      //
      //   NESTED SCROLLERS. The slit was intersected with an outer
      //   scroller's box where it currently sits, so an inner scrollport
      //   below the outer one's slit gave an empty window and its row was
      //   condemned — although the outer scroll carries slit and row into
      //   view TOGETHER. The slit now has its own carrying range
      //   (`slitShift`, the scrollers passed since it was set) and is placed
      //   where that range best brings it against each box; the row is then
      //   judged relative to the slit by the scrollers at or below it
      //   (`innerShift`).
      //
      //   ZERO EXTENT. `overflow: auto` with content that fits is a scroller
      //   by style and a clipper by behaviour, and it was granted the
      //   any-overlap test on the strength of the style. Scroller-vs-clipper
      //   is decided PER AXIS by the range's actual span, so a relatively
      //   positioned row shifted out of such a box gets the half rule.
      const reach = (lo, hi, from, to, want) => {
        // Best-case overlap of an extent `[from, to]` moved by any amount in
        // `[lo, hi]` with `want`: centre it as far as the range allows.
        const desired = (want.lo + want.hi - from - to) / 2;
        const d = Math.min(Math.max(desired, lo), hi);
        return Math.min(to + d, want.hi) - Math.max(from + d, want.lo);
      };
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
      if (range !== null && range.unquantifiable) unbounded = true;
      // PER AXIS (#2157 round 3): an `overflow: auto` box whose content fits
      // on an axis has no movement there and is an ordinary clipper for it.
      const scrollsY = range !== null && !range.unquantifiable && range.spanY > 0;
      const scrollsX = range !== null && !range.unquantifiable && range.spanX > 0;
      if (range !== null && !range.unquantifiable) {
        add(shift, range);
        if (slit !== null) add(slitShift, range);
      }
      if (!unbounded) {
        if (slit === null) {
          for (const q of boxes) {
            if (clipsY && q.height > 0) {
              const seen = scrollsY
                ? reach(shift.yLo, shift.yHi, q.top, q.bottom, { lo: box.top, hi: box.bottom })
                : Math.min(q.bottom, box.bottom) - Math.max(q.top, box.top);
              if (scrollsY ? seen <= 0 : seen / q.height < 0.5) return false;
            }
            if (clipsX && q.width > 0) {
              const seen = scrollsX
                ? reach(shift.xLo, shift.xHi, q.left, q.right, { lo: box.left, hi: box.right })
                : Math.min(q.right, box.right) - Math.max(q.left, box.left);
              if (scrollsX ? seen <= 0 : seen / q.width < 0.5) return false;
            }
          }
          if (scrollsY || scrollsX) {
            slit = { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
            innerShift = { ...shift };
          }
        } else {
          // NESTED (#2157 round 3): the slit is carried by the scrollers
          // passed since it was set, so it is placed where those can best
          // bring it against this box before anything is judged — an inner
          // scrollport currently below an outer scroller's slit comes into
          // view together with its row when the outer one scrolls.
          const dy = clamp(
            (box.top + box.bottom - slit.top - slit.bottom) / 2,
            slitShift.yLo,
            slitShift.yHi,
          );
          const dx = clamp(
            (box.left + box.right - slit.left - slit.right) / 2,
            slitShift.xLo,
            slitShift.xHi,
          );
          const S = {
            top: Math.max(slit.top + dy, box.top),
            bottom: Math.min(slit.bottom + dy, box.bottom),
            left: Math.max(slit.left + dx, box.left),
            right: Math.min(slit.right + dx, box.right),
          };
          // The SLIT has to be shown through this box: any positive extent
          // on an axis this box scrolls, the half rule on one it merely
          // clips — a scrollport mostly hidden shows at most a sliver of
          // anything scrolled into it, and one wholly outside shows nothing.
          if (clipsY) {
            const seen = S.bottom - S.top;
            if (seen <= 0 || (!scrollsY && seen / (slit.bottom - slit.top) < 0.5)) return false;
          }
          if (clipsX) {
            const seen = S.right - S.left;
            if (seen <= 0 || (!scrollsX && seen / (slit.right - slit.left) < 0.5)) return false;
          }
          // And the ROW has to reach the part of the slit that is shown,
          // moving relative to the slit by the scrollers at or below it.
          const want = { top: S.top - dy, bottom: S.bottom - dy, left: S.left - dx, right: S.right - dx };
          for (const q of boxes) {
            if (
              clipsY &&
              q.height > 0 &&
              reach(innerShift.yLo, innerShift.yHi, q.top, q.bottom, { lo: want.top, hi: want.bottom }) <= 0
            ) {
              return false;
            }
            if (
              clipsX &&
              q.width > 0 &&
              reach(innerShift.xLo, innerShift.xHi, q.left, q.right, { lo: want.left, hi: want.right }) <= 0
            ) {
              return false;
            }
          }
          // Everything seen from here up is seen through this box too. The
          // slit keeps its full carrying range for the clippers above: the
          // placement chosen here was for THIS box, and pinning it would
          // condemn a row a higher clipper could still be shown by a
          // different scroll position — the admitting error, deliberately.
          slit = want;
        }
      }
    }
    return true;
  };

  const paintsText = (node) => {
    // ROUND 37 P2 — TEXT CAN BE HIDDEN BY ITS OWN COLOUR, and nothing else
    // in this predicate looks at colour. `color: transparent` leaves the
    // element laid out, `checkVisibility` positive, the rect non-zero and
    // the clipping walk satisfied, while `innerText` keeps yielding every
    // word — so the receipt's fee and loss values could be recorded as
    // read with nothing painted on screen. Same class as the opacity and
    // clipping holes before it: a property that hides the CONTENT rather
    // than the box.
    //
    // Only elements carrying their OWN text are judged. `color` inherits,
    // so testing a wrapper would condemn a whole card whose children set
    // their own colour — a false FAIL, on the very element the run exists
    // to vouch for. The leaves are where this matters anyway: the
    // receipt's `dt`/`dd` are exactly the nodes whose values get blanked.
    //
    // `-webkit-text-fill-color` is read first because it OVERRIDES `color`
    // for painting wherever it is set, which is how this is usually done
    // in a real stylesheet.
    //
    // Alpha ZERO only, never a contrast judgement. Deciding text is too
    // faint against its background needs the background, the stacking and
    // whatever image sits behind it, and getting that wrong condemns
    // legible copy — the direction this file keeps saying gets a check
    // switched off.
    const own = [...node.childNodes].some(
      (c) => c.nodeType === 3 && c.textContent.trim() !== '',
    );
    if (!own) return true;
    const cs = getComputedStyle(node);
    // ROUND 82 P2 — ASKED OF THE GLYPHS, not of the element's box.
    //
    // Round 81 closed `position: absolute; left: -9999px` with a
    // document-origin test on the element RECT, and the self-review
    // after it found `text-indent: -9999px` walking straight through:
    // the indent moves the LINE and leaves the box exactly where it
    // was, so every box-shaped test — geometry, clipping, the origin
    // test — says yes while the text sits far outside. That was
    // patched with a heuristic (a negative indent at least as wide as
    // the element), and the heuristic was wrong in BOTH directions:
    // too narrow for a short label in a wide container, too broad for
    // wrapped text whose later lines stay on screen, which the patch
    // recorded as a stated limit rather than fixing.
    //
    // The text nodes' own `Range` rectangles are where the glyphs
    // actually are, and `notClipped` has been reading them for its
    // clipping ratio since round 44. Asking the document-origin
    // question of THOSE answers `text-indent`, a negative
    // `margin-left` on an inline run, and anything else that parks
    // the line without moving the box — one rule where the previous
    // two rounds each added an arm per trick.
    //
    // ANY reachable rectangle counts as painted, so wrapped text
    // whose first line is indented out keeps the lines the lender can
    // still read. Text this cannot measure — no rects, or a `Range`
    // that throws — counts as painted too. Both are the direction
    // this file takes everywhere: the residual is a missed defect,
    // never an invented one.
    //
    // STATED LIMIT, and it is the price of that choice: the verdict
    // is per ELEMENT, not per line, so the words on an indented-out
    // FIRST line are still collected when a later line of the same
    // run is readable. Slicing a text node by line rectangle would
    // close it and would also start discarding copy on any line this
    // drive mismeasures, which is the false-FAIL direction. The
    // single-line label is what the pattern is actually used for and
    // is fully covered.
    //
    // OWN TEXT NODES ONLY, matching what the rest of this predicate
    // judges: `selectNodeContents(node)` would pull in a descendant's
    // glyphs and let a visible child vouch for an indented-out
    // parent.
    //
    // THIS ADDS NO NEW SCROLL EXPOSURE, which is why no scroll
    // exemption sits beside it: scrolling moves the box and its
    // glyphs together, and both drive call sites (`visible` and
    // `visibleTextOf`) run `shownBox` first, so a box carried before
    // the origin is condemned there first. What reaches here is text
    // that left its own box behind.
    //
    // That is NOT the same as saying a scrolled ancestor cannot
    // produce a false condemnation, and the stronger sentence stood
    // here until it was measured. It could: a row inside an INNER
    // scroll container near the top of the document, scrolled above
    // that container's own slit, has a negative rect while
    // `window.scrollY` is 0, so a bare document-origin test condemned
    // content the lender can scroll back to — in `shownBox` since
    // round 81 added the box test, and here, which inherited the
    // question rather than introducing it. #2138 closed it in the one
    // place both consult: `unreachableBeforeOrigin` credits an
    // ancestor's scroll offset before condemning, so the glyph rule
    // and the box rule cannot answer the reachability question
    // differently.
    const glyphs = [];
    for (const c of node.childNodes) {
      if (c.nodeType !== 3 || c.textContent.trim() === '') continue;
      try {
        const range = document.createRange();
        range.selectNodeContents(c);
        for (const q of range.getClientRects()) {
          if (q.width > 0 && q.height > 0) glyphs.push(q);
        }
      } catch {
        // Unmeasurable: leaves `glyphs` short, which reads as painted.
      }
    }
    // `ownScroll`: the element's own scroll carries its glyphs (and not its
    // box), so it is credited here and not in `shownBox`.
    if (
      glyphs.length > 0 &&
      glyphs.every((q) => unreachableBeforeOrigin(node, q, { ownScroll: true }))
    ) {
      return false;
    }
    // HOISTED ABOVE THE OCCLUSION RULE (round 90): that rule now reads a
    // cover's background through this same parser, and a `const` arrow
    // used before its declaration is a temporal-dead-zone throw — the
    // shape that made a round-75 fix inert inside its own catch. One
    // definition, declared before either reader.
    const alphaOf = (value) => {
      const v = String(value).trim();
      if (v === 'transparent') return 0;
      const fn = /^[a-zA-Z-]+\(([^]*)\)$/.exec(v);
      if (!fn) return 1;
      const body = fn[1];
      const cut = body.lastIndexOf('/');
      let raw = null;
      if (cut >= 0) {
        raw = body.slice(cut + 1);
      } else {
        const parts = body.split(',');
        if (parts.length === 4) raw = parts[3];
      }
      if (raw === null) return 1;
      const t = raw.trim();
      const n = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
      return Number.isFinite(n) ? n : 1;
    };
    // ROUND 89 P2 — AND TEXT COVERED BY SOMETHING OPAQUE IS NOT
    // PAINTED EITHER.
    //
    // An opaque positioned sibling laid over the explanation or a receipt
    // row defeats every test above it: the covered node still reports
    // `checkVisibility`, a real rect at real document coordinates, full
    // opacity, no clipping and measurable glyphs. So the whole class this
    // predicate exists for — copy present in the markup and absent from
    // the lender's screen — had one door left open, and it is the door a
    // CSS regression is most likely to walk through: an overlay that grew,
    // a z-index that flipped.
    //
    // HIT-TESTED, which is the only way to ask "is something in front of
    // this". Each glyph rectangle is probed at its centre first, and at
    // two corners only when the centre comes back covered — so the common
    // case costs one `elementsFromPoint` per rectangle and reachable text
    // returns on the first probe.
    //
    // THREE GUARDS AGAINST CONDEMNING LEGIBLE COPY, because this is the
    // one rule in this file that can invent a finding out of ordinary
    // layout:
    //
    //   - The covering element must actually PAINT. An invisible
    //     click-catcher — a full-page div with no background, which is
    //     ordinary in a modal implementation — is hit first by
    //     `elementsFromPoint` and covers nothing a lender can see. So the
    //     walk up from each hit looks for a fully opaque background
    //     colour — and ONLY that, since round 98. Anything it cannot
    //     decide counts as NOT covering, which is what "unknown means
    //     painted" amounts to for this rule: the text stays in the
    //     reading. (The layers BELOW that catcher are examined too —
    //     round 95.) It used to accept a replaced element as paint on
    //     the strength of its tag, which condemned readable copy under
    //     a transparent image; that is gone, and this sentence named it
    //     for one round after it went, which is how a description sends
    //     a later change back to the behaviour just removed.
    //   - Points outside the VIEWPORT cannot be hit-tested at all, and
    //     `elementsFromPoint` answers an empty stack for them. They are
    //     skipped, not counted as covered — otherwise every below-the-fold
    //     row, which the lender reaches by scrolling, would be condemned.
    //   - Occlusion must be TOTAL. One reachable probe anywhere in the
    //     text is enough to keep it painted, because partial overlap is
    //     ordinary (a sticky header crossing a row as the page scrolls)
    //     and reading half a sentence is not the defect this catches.
    //
    // STATED RESIDUAL, and it is the mirror of the first guard rather
    // than a second win: `elementsFromPoint` looks straight through an
    // element with `pointer-events: none`, so an OPAQUE overlay carrying
    // that property hides the text visually and is invisible to this
    // test. That is a missed defect, which is the direction this file
    // takes every time — the alternative is a geometric overlap test
    // that would condemn the transparent click-catcher above it.
    // THE CONTAINMENT TEST COMES FIRST INSIDE THE WALK, and swapping it
    // below the paint tests would condemn the whole page (self-review).
    // The walk climbs from whatever was hit until it reaches something
    // that contains this node — the common ancestor — and stops there. Any
    // element from the common ancestor upward is an ANCESTOR of the text,
    // not a cover, and `body` almost always carries an opaque background:
    // reach it and every foreign hit reads as covered, so the transparent
    // click-catcher guard above would silently invert.
    // Is this element's `filter` less than fully opaque?
    //
    // The same parse `filterErases` performs, asking the weaker question:
    // that one wants erased-entirely, this one wants anything short of
    // solid, because a cover you can read through is not a cover. A
    // chain multiplies, so one component below 1 settles it.
    const filterBelowOpaque = (f) => {
      if (!f || f === 'none') return false;
      for (const m of String(f).matchAll(/opacity\(([^)]*)\)/gi)) {
        const t = m[1].trim();
        const v = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
        if (Number.isFinite(v) && v < 1) return true;
      }
      return false;
    };
    // Does THIS ONE LAYER of the hit-test stack paint over the text?
    // Split out of `coveredAt` in round 95 so the answer can be asked of
    // each layer in turn; the walk itself is unchanged.
    const layerPaints = (hit) => {
      // Whether anything in the cover's chain actually paints, carried so
      // the walk can keep going and still answer (round 92).
      let paints = false;
      for (let n = hit; n && n !== document.documentElement; n = n.parentElement) {
        // The common ancestor: everything below it has been examined, so
        // whatever was found is the answer.
        if (n.contains(node)) return paints;
        // ROUND 91 P2 — AND THE COVER HAS TO BE VISIBLE ITSELF.
        //
        // An opaque BACKGROUND on an element that is itself transparent —
        // `background:#123456; opacity:0`, an ordinary transition layer —
        // is still what hit-testing returns, and the first version read its
        // background alpha and declared the text covered. That is a false
        // FAIL on plainly visible copy, which is the one direction this
        // predicate must never take.
        //
        // Anything less than fully opaque disqualifies the whole chain
        // rather than being weighed: a half-transparent cover leaves the
        // text partly legible, and judging how much is the contrast
        // question this file refuses. A filter carrying an `opacity()` below
        // 1 says the same thing by another property (round 100 — it used to
        // read only an exact zero); other filters still cover, so they are
        // left alone.
        //
        // NO `visibility` TEST HERE, and its removal is the correction
        // rather than an omission (self-review). Hit-testing already skips
        // a hidden element, so the check could never fire for the hit
        // itself — and for an ANCESTOR of the hit it is actively wrong,
        // since `visibility` is inherited and a child may set `visible`
        // again, leaving a cover that genuinely paints. Opacity and the
        // filter do not have that shape: both composite over the whole
        // subtree, so an ancestor carrying either really does erase the
        // cover.
        const coverStyle = getComputedStyle(n);
        const op = Number(coverStyle.opacity);
        if (Number.isFinite(op) && op < 1) return false;
        // ROUND 100 P2 — ANY filter opacity BELOW 1, not only exactly zero.
        //
        // The regex here matched `opacity(0)` and nothing else, so a cover
        // at `filter: opacity(0.5)` — computed `opacity` still 1 — counted
        // as fully opaque and the text under it was discarded, while the
        // lender can read it straight through. The rule two paragraphs up
        // says anything less than fully opaque disqualifies the chain; the
        // element `opacity` test honours that and this one did not.
        //
        // Parsed rather than matched, the same way `filterErases` parses
        // it, percentage form included. A value this cannot read is left
        // alone — unreadable is not evidence of transparency, and the
        // surrounding rule already treats undecidable as not-covering.
        if (filterBelowOpaque(coverStyle.filter)) return false;
        // ROUND 92 P2 — FOUND IS NOT FINISHED. The walk continues to the
        // common ancestor even after something opaque is seen, because
        // opacity does not INHERIT: an overlay written as an opaque child
        // inside a wrapper at `opacity: 0` reports 1 on the child, and
        // returning there accepted a paint the wrapper erases. Readable
        // copy was then discarded — the false-FAIL direction again, from
        // the fix that was supposed to close it.
        //
        // ROUND 97 P2 — AND THE TAG TEST THAT USED TO LIVE HERE IS GONE.
        //
        // It read `/^(img|video|canvas|svg)$/.test(n.tagName)` and counted
        // any replaced element as painting. A fully transparent PNG, an
        // untouched canvas or a mostly-empty SVG all report `opacity: 1`
        // and are all what hit-testing returns, so any of them spanning the
        // glyph discarded plainly readable copy — the false-FAIL direction,
        // on a funds surface, from a rule that never looked at a pixel.
        //
        // DELETED RATHER THAN NARROWED, because there is no cheap honest
        // version. `naturalWidth` says an image loaded, not that it is
        // opaque; reading pixels back means a canvas draw, and a
        // cross-origin image taints the canvas and throws. Undecidable
        // counts as NOT covering here, as everywhere else in this
        // predicate.
        //
        // STATED RESIDUAL: an opaque image laid over the text with no
        // background colour of its own is no longer detected. That is a
        // missed defect, which is the trade this file makes every time —
        // the alternative invents failures out of decorative artwork.
        // ROUND 90 P2 — READ BY SHAPE, via the same `alphaOf` the fill test
        // uses. The first version matched `rgba?(…)` only, so an overlay
        // painted in `oklab(…)` or `color(display-p3 …)` — forms Chromium
        // preserves, as the note above `alphaOf` records — read as
        // transparent and the hidden text stayed in the reading. Round 38
        // learned this exact lesson for the text colour and I wrote the new
        // site against the old standard anyway.
        const bg = coverStyle.backgroundColor || '';
        if (!paints && bg && bg !== 'transparent' && alphaOf(bg) === 1) paints = true;
      }
      return paints;
    };
    // ROUND 95 P2 — THE WHOLE STACK AT THE POINT, NOT THE TOP OF IT.
    //
    // `elementFromPoint` returns ONE element: the topmost. The modal
    // implementation the first guard was written for — a full-size
    // transparent click-catcher — is exactly what lands there, and its
    // own chain paints nothing, so the walk correctly answered "this
    // layer is not a cover" and `coveredAt` then stopped. The OPAQUE
    // backdrop immediately beneath it, which is the thing the lender
    // cannot see through, was never examined. Hidden receipt copy could
    // therefore enter `visibleTextOf` and a fee-facing surface be
    // certified on text nobody could read.
    //
    // `elementsFromPoint` returns the stack topmost-first. Everything
    // before the entry that contains this node paints ABOVE the glyph at
    // this point, so each is asked in turn and the first that paints
    // settles it. Reaching the node's own layer ends the search: nothing
    // below it can hide it.
    //
    // The containment test stays FIRST, for the reason recorded above —
    // `body` carries an opaque background and sits at the bottom of every
    // stack, so examining it would read as covered everywhere.
    //
    // A layer disqualified by its opacity, or by a filter that is not fully
    // opaque, does not end the search either: it is see-through, and the
    // layers below it are still in front of the text.
    const coveredAt = (x, y) => {
      const stack = document.elementsFromPoint(x, y);
      if (!stack || !stack.length) return false;
      for (const hit of stack) {
        // ROUND 90 P2 — ONLY THIS NODE AND ITS ANCESTORS ARE EXEMPT. A
        // DESCENDANT CAN COVER ITS PARENT'S OWN TEXT.
        //
        // The first version exempted `node.contains(hit)` as well, which
        // trusted every descendant — so an absolutely positioned opaque
        // child laid over its parent's glyphs was declared "not a cover"
        // by the very fact that it belongs to the element it is hiding.
        //
        // `contains` is true of a node itself, so `hit.contains(node)`
        // covers both the element's own hit and any ancestor's, and
        // nothing else is waved through. Note the rects probed are the
        // element's OWN text nodes, so an ordinary inline child is not at
        // these points at all — a descendant hit here is one that
        // genuinely overlaps the text.
        if (hit.contains(node)) return false;
        if (layerPaints(hit)) return true;
      }
      return false;
    };
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const inView = (x, y) => x >= 0 && y >= 0 && x < vw && y < vh;
    let probed = 0;
    let allCovered = true;
    // ROUND 96 P2 — A DIAGONAL IS NOT A RECTANGLE.
    //
    // The three probes were the centre and the two opposite corners:
    // three COLLINEAR points. An opaque diagonal stripe, or three small
    // badges that happen to sit on that line, cover all of them while
    // leaving most of the sentence readable — and the text node was then
    // discarded whole. The rule directly above says occlusion must be
    // TOTAL, and the sampling did not implement the rule it states.
    //
    // The direction is what makes this urgent rather than merely
    // imprecise: it is a FALSE FAIL on legible funds copy, the one error
    // this file says gets a whole check switched off.
    //
    // Sampled on a GRID now — five positions across the width at three
    // heights — so a cover has to defeat fifteen points spread over the
    // whole rectangle rather than three on one line. Still sampling, and
    // still not a proof of total coverage; what changes is that every
    // added point can only make a cover HARDER to claim, so the residual
    // moves further into the missed-defect direction and never into the
    // invented one.
    //
    // The common path costs no more than before: the loop stops at the
    // first uncovered point, and readable text is uncovered at the first
    // one tried. Only text that really is covered everywhere pays for
    // the whole grid.
    const COL_FRACTIONS = [0.02, 0.25, 0.5, 0.75, 0.98];
    const ROW_FRACTIONS = [0.25, 0.5, 0.75];
    // KEPT AT LEAST A PIXEL INSIDE (self-review of the grid above).
    // The rules it replaced were absolute 1px insets from the corners,
    // and a fraction is not: on a narrow rectangle 0.02 lands on the
    // boundary, where hit-testing can resolve to the NEIGHBOUR rather
    // than to the glyph. An opaque badge beside a short figure would
    // then answer for a point that is not on the text. It cannot
    // condemn on its own — total occlusion needs every point, and the
    // interior ones sit over the glyph — but a sample that is not on
    // the thing being measured should not be taken at all. Rectangles
    // too narrow to have an inside are probed at their centre.
    const inset = (extent, f) =>
      extent <= 2 ? extent / 2 : Math.min(Math.max(extent * f, 1), extent - 1);
    for (const q of glyphs) {
      const points = [];
      for (const fy of ROW_FRACTIONS) {
        for (const fx of COL_FRACTIONS) {
          points.push([q.left + inset(q.width, fx), q.top + inset(q.height, fy)]);
        }
      }
      for (const [x, y] of points) {
        if (!inView(x, y)) continue;
        probed += 1;
        if (!coveredAt(x, y)) {
          allCovered = false;
          break;
        }
      }
      if (!allCovered) break;
    }
    if (probed > 0 && allCovered) return false;
    const fill = cs.webkitTextFillColor || cs.color || '';
    // ROUND 38 P2 — EVERY COMPUTED COLOUR FORM, not just `rgb()`/`rgba()`.
    //
    // Chromium PRESERVES the functional notation for the modern colour
    // syntaxes, so `color(display-p3 0 0 0 / 0)` and `oklab(0 0 0 / 0)`
    // never matched the old `rgba?` probe — and the no-match branch
    // returns "painted", which fails OPEN on the one check that exists
    // to catch invisible funds copy. All six receipt leaves could pass
    // while `innerText` supplied their values.
    //
    // Parsed by SHAPE rather than by enumerating colour functions:
    // every CSS colour syntax carrying alpha spells it either after a
    // `/` (the modern forms, and space-separated `rgb()`) or as a fourth
    // comma-separated component (legacy `rgba()` / `hsla()`). Reading
    // the shape means a colour function added to CSS later needs no
    // change here — the enumeration mistake this file has now made
    // twice, with the transport allowlist and the currency signs.
    //
    // ANYTHING UNPARSEABLE COUNTS AS PAINTED. A form this cannot read
    // must not be condemned: a false FAIL on legible copy is the error
    // that gets the whole check switched off, so the residual is a
    // missed defect and never an invented one.
    // ROUND 75 P2 — A ZERO-ALPHA FILL IS NOT THE ONLY WAY GLYPHS GET
    // PAINTED.
    //
    // `color: transparent` with a `text-shadow` is a real technique, and
    // the glyphs are plainly on screen: the shadow draws them.
    // Condemning that text erased the body, a receipt value or a control
    // label and accused a surface the lender can read — the false-FAIL
    // direction this helper already argues for two paragraphs up, where
    // an unparseable colour is deliberately counted as painted. The same
    // goes for a paint-order stroke, which outlines glyphs a transparent
    // fill would otherwise hide.
    //
    // DECLINED rather than adjudicated: no attempt is made to decide
    // whether the shadow is itself visible, offset clear of the glyphs,
    // or the colour of the background. Each of those is the contrast
    // judgement this file has already refused to make, and getting it
    // wrong puts the accusation back. The residual is a missed defect,
    // never an invented one.
    if (alphaOf(fill) !== 0) return true;
    const shadow = String(cs.textShadow ?? 'none').trim();
    if (shadow !== '' && shadow !== 'none') return true;
    const strokeWidth = String(cs.webkitTextStrokeWidth ?? '0px').trim();
    const strokeColor = String(cs.webkitTextStrokeColor ?? 'transparent').trim();
    if (parseFloat(strokeWidth) > 0 && alphaOf(strokeColor) !== 0) return true;
    return false;
  };

  const shownBox = (node) => {
    // `!node`, not `node === null`: the twin has always written it this
    // way, and it is the safer of the two — a caller handing this
    // `undefined` would throw on the property read below.
    if (!node) return false;
    // ROUND 23 P2 — SUPPLEMENTS the geometry test, never replaces
    // it. `checkVisibility` answers about display, visibility,
    // opacity and content-visibility; it does not establish that
    // the element occupies space, so `transform: scale(0)` or a
    // collapsed box still reads as visible through it alone.
    if (typeof node.checkVisibility === 'function') {
      if (
        !node.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true,
        })
      ) {
        return false;
      }
      // ROUND 29 P2 — AND THE CLIPPING TEST, on THIS path too.
      //
      // Round 28 added `notClipped` to the fallback's return and
      // not to this one, so on every engine that HAS
      // `checkVisibility` — which is to say the browser this drive
      // actually runs — the clipping fix did nothing at all for
      // the card, the body and the submit control. The receipt
      // helper was rewritten wholesale and did get it, which is
      // why the live run looked like it confirmed the change: the
      // canary I checked exercised the copy that worked.
      //
      // ROUND 51 P2 — AND THE SAME SPLIT BIT AGAIN, so the branch
      // no longer RETURNS. Round 29 fixed the symptom by copying
      // `notClipped` into this arm and left the shape that caused
      // it: an early return here meant everything below — the
      // ancestor walk included — ran only on an engine without
      // `checkVisibility`, which is to say never.
      //
      // That was free while the walk only tested `opacity`, since
      // `checkVisibility({opacityProperty: true})` already covers
      // it, and that is precisely why nobody noticed. It stops
      // being free the moment the walk carries something
      // `checkVisibility` does not know about — `filter` is that
      // thing, and the fix for it would have landed in dead code
      // in one of the two copies.
      //
      // Restructured to match the twin rather than patched inside
      // the branch, so the copies converge instead of diverging
      // further (#2102).
    } else {
      const cs = getComputedStyle(node);
      if (
        cs.display === 'none' ||
        cs.visibility === 'hidden' ||
        cs.visibility === 'collapse'
      ) {
        return false;
      }
    }
    // ROUND 51 P2 — A FILTER ERASES CONTENT THE SAME WAY OPACITY DOES,
    // and nothing above looks at it.
    //
    // `filter: opacity(0)` leaves the geometry, the computed `opacity`,
    // the text colour and `checkVisibility` all untouched while Chromium
    // paints nothing — so the explanation, or a fee and loss row, could be
    // vouched for from `innerText` with none of it on screen. Same class
    // as rounds 37, 43, 44, 45 and 48: a property that hides the CONTENT
    // rather than the box.
    //
    // Checked on the same ANCESTOR WALK as `opacity`, because a filter
    // applies to the element and everything inside it exactly as opacity
    // does — one walk, one rule, rather than a second traversal to drift.
    //
    // ONLY a zero `opacity()` component, and only where it is stated as a
    // number. `brightness(0)` paints black rather than nothing, a `url()`
    // reference is an arbitrary SVG filter, and deciding in general what a
    // filter chain renders is not something this predicate can do — so
    // anything else counts as painted. The residual is a missed defect,
    // never an invented one.
    const filterErases = (cs) => {
      const f = cs.filter;
      if (!f || f === 'none') return false;
      for (const m of String(f).matchAll(/opacity\(([^)]*)\)/gi)) {
        const t = m[1].trim();
        const v = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
        if (Number.isFinite(v) && v === 0) return true;
      }
      return false;
    };
    for (let n = node; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (Number(cs.opacity) === 0) return false;
      if (filterErases(cs)) return false;
    }
    // ROUND 81 P2 — AND TEXT PARKED OUTSIDE THE DOCUMENT IS NOT
    // PAINTED EITHER.
    //
    // `position: absolute; left: -9999px` is the older screen-reader
    // pattern, and it defeats every test above it: `checkVisibility`
    // is true, the rect has real width and height, opacity is 1 and
    // nothing clips it. So an off-screen readiness sentence or a fee
    // value could substantiate a card showing a sighted lender
    // nothing but filler — the exact substitution the painted-text
    // rule exists to stop, arriving by geometry instead of colour.
    //
    // BELOW THE FOLD IS NOT THIS. Content the lender can scroll to is
    // painted and must stay admitted, so the test is in DOCUMENT
    // coordinates and asks whether the box lies wholly before the
    // document's origin — left of it or above it — and (#2138) whether
    // an ancestor scroll container could carry it back. The rule and
    // its limits are stated once, on `unreachableBeforeOrigin`, which
    // `paintsText` consults for the glyph rectangles the same way.
    const r = node.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    if (unreachableBeforeOrigin(node, r)) return false;
    return notClipped(node);
  };

  // ROUND 66 P2 — TWO QUESTIONS, SEPARATED. `shownBox` above answers
  // whether the BOX is on screen: display, visibility, opacity, an
  // erasing filter, geometry and clipping, each of which hides
  // everything inside it. `paintsText` answers whether an element's
  // OWN text is painted, which affects only that element's own text
  // nodes — `color` inherits, and a descendant may repaint itself.
  //
  // `visible` is unchanged: it is both, and every existing caller
  // asking "can the lender read THIS element" still gets the same
  // answer. The split exists so `visibleTextOf` can stop discarding a
  // painted descendant because its container's own text is not.
  const visible = (node) => shownBox(node) && paintsText(node);

  // Collected by walking TEXT NODES and keeping those whose element
  // chain is visible, rather than by collecting "leaf elements": a
  // parent with its own text beside a child with more would be
  // counted twice by the latter, and the text is what the verdict
  // needs anyway.
  //
  // Joined with NOTHING and then whitespace-collapsed. A space
  // between every text node would split `<b>Loan</b>s` into
  // "Loan s", and this string is compared against shipped copy with
  // `includes`.
  //
  // Elements whose text is NEVER PAINTED (`script`, `style`,
  // `template`, `title`, `noscript`) are skipped, so this agrees
  // with the `innerText` that `bodyText` reports. Defence in depth
  // rather than a live defect — a body holding only a `<style>` has
  // no height and `visible` already rejects it on geometry, which
  // the fixture asserts.
  const visibleTextOf = (root) => {
    if (root === null) return '';
    // THE ROOT'S OWN VISIBILITY FIRST — see the twin in the receipt
    // pass. The walk only judges elements it DESCENDS INTO, so a
    // text node directly under a hidden root would be collected as
    // painted. The two copies are asserted identical by
    // `31-observer-visibility.spec.ts`.
    if (!shownBox(root)) return '';
    const unpainted = /^(script|style|template|title|noscript)$/i;
    const parts = [];
    // One shape for every early exit, so a pseudo that paints nothing and
    // a pseudo whose content could not be resolved stay distinguishable.
    const NOTHING_PAINTED = { text: '', unresolved: false };
    let sawUnresolved = false;
    // ROUND 111 P2 — CSS-GENERATED TEXT IS TEXT THE LENDER READS.
    //
    // `::before` / `::after` content is painted on screen and appears in no
    // `childNodes`, so this walk could not see it and the amount scan
    // returned a clean verdict on a card displaying `100 USDC`. That is the
    // false-PASS direction on the one absolute claim this drive makes — the
    // card states no amount it cannot substantiate — so the text is
    // collected rather than the assertion declined: declining on any
    // generated content would switch the check off for every decorative
    // bullet or icon, which is the same check lost by a different door.
    //
    // Only a QUOTED string counts. `counter()`, `attr()`, `url()` and the
    // `none` / `normal` defaults are not copy this can read, and guessing at
    // them would invent text. And only when the pseudo actually paints: its
    // own display, visibility, opacity and colour alpha are checked the way
    // `paintsText` checks an element's, since a pseudo can be styled away
    // independently of its owner.
    const pseudoText = (el, which) => {
      let cs;
      try {
        cs = getComputedStyle(el, which);
      } catch {
        return NOTHING_PAINTED;
      }
      if (!cs) return NOTHING_PAINTED;
      const content = cs.content;
      if (!content || content === 'none' || content === 'normal') return NOTHING_PAINTED;
      if (cs.display === 'none' || cs.visibility !== 'visible') return NOTHING_PAINTED;
      if (Number.parseFloat(cs.opacity) === 0) return NOTHING_PAINTED;
      // THE SAME ALPHA RULE AS `alphaOf`, and written out because that one
      // lives in the occlusion scope and is not reachable from here. My
      // first version was a one-line regex taking the LAST number before
      // the paren, which reads `rgb(0, 0, 0)` as alpha 0 and dropped every
      // pseudo painted in plain black — a fix that silently did nothing,
      // caught only because the fixture failed. A colour parser written a
      // third time is the #2102 duplication one level down, and is recorded
      // there rather than left implicit.
      const colour = String(cs.color).trim();
      if (colour === 'transparent') return NOTHING_PAINTED;
      const fn = /^[a-zA-Z-]+\(([^]*)\)$/.exec(colour);
      if (fn) {
        const body = fn[1];
        const cut = body.lastIndexOf('/');
        const parts = body.split(',');
        const raw = cut >= 0 ? body.slice(cut + 1) : parts.length === 4 ? parts[3] : null;
        if (raw !== null && Number.parseFloat(raw) === 0) return NOTHING_PAINTED;
      }
      // ROUND 116 P2 — RESOLVE `attr()`, AND SAY SO WHEN NOTHING CAN.
      //
      // Reading only the quoted parts drops the dynamic half: `attr(data-amount)
      // " USDC"` yielded `USDC` with the number gone, so the scan saw no digits
      // and certified a card that visibly states an amount — the very false PASS
      // this collection was added to close.
      //
      // `attr()` is read off the element. A counter is not: its value comes from
      // the document's counter state at paint time. What cannot be resolved is
      // REPORTED rather than guessed at, and the verdict declines to certify the
      // no-amount claim on that card.
      let rest = content;
      let out = '';
      let unresolved = false;
      while (rest.length > 0) {
        const lit = /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/.exec(rest);
        if (lit) {
          out += (lit[1] ?? lit[2] ?? '').replace(/\\(.)/g, '$1');
          rest = rest.slice(lit[0].length);
          continue;
        }
        const attr = /^\s*attr\(\s*([A-Za-z_][-\w]*)[^)]*\)/.exec(rest);
        if (attr) {
          out += el.getAttribute(attr[1]) ?? '';
          rest = rest.slice(attr[0].length);
          continue;
        }
        const other = /^\s*[^\s]+/.exec(rest);
        if (!other) break;
        // `normal` and `none` are handled above; anything else left here is a
        // component whose painted text this cannot know.
        unresolved = true;
        rest = rest.slice(other[0].length);
      }
      return { text: out, unresolved };
    };
    // ROUND 66 P2 — AN ELEMENT'S OWN TEXT AND ITS SUBTREE ARE JUDGED
    // SEPARATELY.
    //
    // `paintsText` gates only the element's OWN text nodes, because
    // `color` inherits and a descendant may repaint itself. Descent
    // is gated on `shownBox` alone: a container whose own text is
    // transparent still SHOWS a child that sets its own colour, and
    // gating descent on the full `visible` discarded that child — a
    // product FAIL on a card whose explanation is painted, which is
    // the direction this file refuses everywhere else.
    // ROUND 74 P2 — RENDERED LINE BOUNDARIES SURVIVE THE WALK.
    //
    // `innerText` inserts a newline between rendered blocks, and round 24
    // made that newline a CLAUSE BOUNDARY: `Wait 3 days` above `USDC is
    // returned later` is two rows, so the ticker is not near the duration.
    // Round 66 moved the scans onto this painted walk and joined every
    // text node with nothing, which silently deleted that boundary — so
    // correct copy on two lines read as one clause and the amount scanner
    // emitted an observed funds FAIL on an allowed grace duration. A false
    // FAIL on funds copy, introduced by the fix that made the reading
    // honest.
    //
    // A newline is emitted around a child that BREAKS THE LINE and never
    // around an inline one, which is what keeps round 66's other rule
    // intact: `<b>Loan</b>s` must not become `Loan s`. `inline-block` and
    // `contents` do not break, matching what `innerText` does; `<br>` does,
    // unless it is display:none.
    // ROUND 79 P2 — GEOMETRY DECIDES, not the child's `display` alone.
    //
    // A flex or grid ITEM is blockified, so `display` reads `block`
    // while the items sit side by side on one rendered row. Breaking
    // on that inserted a newline between, say, `Loan 100` and
    // `USDC principal` — and `monetaryAmountsIn` reads a newline as a
    // CLAUSE BOUNDARY, so the ticker stopped cancelling the identifier
    // exemption and a visible unsubstantiated amount got a clean
    // verdict. A false PASS on funds copy, from the fix that stopped a
    // false FAIL on it one round earlier.
    //
    // Rects answer the question the rule is actually asking — did the
    // lender see these on the same line? Two boxes whose vertical
    // ranges OVERLAP are on one line whatever their display says, and
    // a box below the previous one starts a new line whatever the
    // parent's formatting context is. That also covers a column flex,
    // a wrapped row and a multi-row grid, which a parent-display test
    // would each get wrong.
    //
    // `display` is still consulted FIRST, as the cheap negative: an
    // inline element never breaks, which is what keeps a bolded word
    // from becoming two. Zero-area boxes fall back to the display
    // rule, since a rect of nothing cannot place anything.
    const breaksLine = (el, prev) => {
      const d = getComputedStyle(el).display;
      if (d === 'contents' || d.startsWith('inline') || d.startsWith('ruby')) return false;
      if (!prev) return true;
      const a = el.getBoundingClientRect();
      const b = prev.getBoundingClientRect();
      if (a.height === 0 || b.height === 0) return true;
      return !(a.top < b.bottom && b.top < a.bottom);
    };
    // `prevBox` is the last element that actually laid a box down, so
    // adjacency is judged against what was rendered before this
    // child rather than against its parent.
    let prevBox = null;
    const walk = (node) => {
      const ownPainted = paintsText(node);
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          // ROUND 79 P2 — SOURCE WHITESPACE IS NOT A RENDERED BREAK.
          //
          // A text node between two elements carries the markup's own
          // indentation, newlines included, and the normalisation
          // below deliberately preserves newlines — so the way the
          // HTML happened to be formatted leaked in as a clause
          // boundary. Collapsed here instead: a break comes from
          // layout, which is `breaksLine` and `<br>`, and never from
          // how the source was typed.
          if (ownPainted) parts.push(child.textContent.replace(/\s+/g, ' '));
        } else if (child.nodeType === 1) {
          if (unpainted.test(child.tagName)) continue;
          if (child.tagName === 'BR') {
            if (getComputedStyle(child).display !== 'none') parts.push('\n');
            continue;
          }
          if (!shownBox(child)) continue;
          const boundary = breaksLine(child, prevBox);
          if (boundary) parts.push('\n');
          prevBox = child;
          // Generated text sits around the element's own children, so
          // it is collected in the order it is painted.
          const before = pseudoText(child, '::before');
          if (before.unresolved) sawUnresolved = true;
          if (before.text) parts.push(before.text);
          walk(child);
          const after = pseudoText(child, '::after');
          if (after.unresolved) sawUnresolved = true;
          if (after.text) parts.push(after.text);
        }
      }
    };
    // The ROOT's own generated text too — the walk only sees children,
    // and a card whose amount is painted through its own ::after is
    // exactly the shape this was written for.
    const rootBefore = pseudoText(root, '::before');
    if (rootBefore.unresolved) sawUnresolved = true;
    if (rootBefore.text) parts.push(rootBefore.text);
    walk(root);
    const rootAfter = pseudoText(root, '::after');
    if (rootAfter.unresolved) sawUnresolved = true;
    if (rootAfter.text) parts.push(rootAfter.text);
    // Horizontal whitespace collapses; the deliberate breaks do not.
    // Published on the function rather than returned, so the signature
    // stays a string for its twenty call sites and there is still only ONE
    // parser of `content`. Read immediately after the call; the walk is
    // synchronous, so there is no interleaving to get wrong.
    visibleTextOf.sawUnresolvedGenerated = sawUnresolved;
    return parts
      .join('')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/[^\S\n]*\n[\s]*/g, '\n')
      .trim();
  };

  return { notClipped, paintsText, shownBox, visible, visibleTextOf };
}

/**
 * Compose an evaluate body with the helpers, for `page.evaluate`,
 * `locator.evaluate` and `page.waitForFunction`.
 *
 * `body` is `(V, a, b) => …`: `V` is the helper family and `a`, `b` are
 * whatever Playwright passes — `(arg)` for a page evaluate, `(element,
 * arg)` for a locator evaluate. The result is a plain function whose
 * source Playwright serialises; the `new Function` here runs in NODE,
 * once, at composition time.
 *
 * Playwright serialises the callback with `toString()`, so `body` must be
 * self-contained in the same way it would be as a direct evaluate
 * callback: no closure over Node-side variables. That was already the
 * rule for every evaluate in the drive; this changes nothing about it.
 */
export function withVisibility(body) {
  if (typeof body !== 'function') {
    throw new TypeError('withVisibility expects the evaluate body as a function');
  }
  return new Function(
    'a',
    'b',
    `const V = (${visibilityHelpers.toString()})();\nreturn (${body.toString()})(V, a, b);`,
  );
}

/**
 * The helpers' source, for a test that wants to build its own in-page
 * scope beside helpers it extracts from elsewhere. `(${VISIBILITY_SOURCE})()`
 * evaluates to the family.
 */
export const VISIBILITY_SOURCE = visibilityHelpers.toString();
