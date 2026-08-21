/**
 * Which observations from one visited page become a FAILURE, which
 * become BLOCKED, and which are merely printed.
 *
 * Extracted from `live-position-observe.mjs` (#1861) for the reason
 * `jumpability.mjs` was: this logic decides the drive's exit code and
 * had no seam anything could call. Every defect found in it so far —
 * an anchor failure suppressed in aggregate (#1853 r18), one message
 * serving two different findings (r16), a suppression keyed on the
 * driver's own prose so a reword would silently disable it (r14) — was
 * found by READING the code, because the only way to run it was to
 * drive a live chain into the exact state it describes, and the live
 * chain does not carry those states.
 *
 * Each rule here is a pure function of one visit record. That is the
 * whole argument for the move: they were always testable, and were not
 * being tested.
 *
 * NOTHING HERE DECIDES PRECEDENCE. `problems` and `blocked` are both
 * returned for every visit; the driver still ranks FAIL above BLOCKED
 * at the exit, which is where that ordering has always lived and where
 * several rounds of review put it deliberately.
 */

/**
 * @typedef {object} AnchorCheck
 * @property {string} title    the row's own title, truncated
 * @property {string|null} target  the anchor id this row promises, or
 *   null when this drive cannot map the row
 * @property {string|undefined} reached  where the click actually landed;
 *   undefined means the button could not be clicked at all
 * @property {boolean|null} present  did the button do what its row
 *   promises; null for an unmapped or unexercised row
 */

/**
 * Was this page's route blocked by a transition that happened BEFORE
 * the scrape — meaning the card was correctly never mounted, and the
 * shape observations are of an absence rather than a regression?
 *
 * THREE CONDITIONS, NOT TWO (Codex #1853 r16). The route was blocked,
 * the chain explains it, AND the scrape itself saw no card. The third
 * is what makes this sound: without it, a card that DID render with a
 * row missing loses its finding whenever the chain happens to move
 * afterwards.
 *
 * The distinction this rests on is WHEN the transition happened
 * relative to the scrape, and it is easy to get backwards — round 10
 * did, and suppressed too much:
 *
 *   advancedPreRaced — before the scrape. The observations are of a
 *                      correctly absent card; suppress them.
 *   advancedRaced    — during the probe, after the scrape. The
 *                      observations stand; the race only excuses the
 *                      zero-jump result, which is where it was found.
 *
 * `text`, `lenderCardText` and the shape reads are all evaluated
 * EARLIER in the visit record's object literal than the Advanced probe,
 * so a transition detected during that probe cannot have affected a
 * scrape that had already happened.
 *
 * @param {object} v visit record
 * @returns {boolean}
 */
export function preRaced(v) {
  return (
    v.advancedBlocked === true &&
    v.advancedPreRaced === true &&
    v.cardAbsentAtScrape === true
  );
}

/** Is this a position DETAIL page, as opposed to the list route? */
export function isDetailPath(path) {
  return /^\/positions\/\d+$/.test(String(path ?? ''));
}

/**
 * The problems that make a visit a FAIL (exit 1).
 *
 * @param {object} v visit record
 * @param {'lender'|'borrower'} role
 * @returns {string[]}
 */
export function visitProblems(v, role) {
  const problems = [];
  if (v.nav) problems.push(`nav: ${v.nav}`);
  // A 404/500 does not throw and does not fire `pageerror`: page.goto
  // resolves and the status is merely recorded. Unchecked, a route that
  // never loaded counted toward "routes clean" (#1529 review).
  if (
    !v.nav &&
    (v.http === null || v.http === undefined || v.http < 200 || v.http >= 300)
  ) {
    problems.push(`navigation returned ${v.http ?? 'no response'}`);
  }
  if (v.hooks) problems.push('HOOKS-ORDER CRASH');
  if (v.pageErrors?.length) problems.push(`${v.pageErrors.length} uncaught error(s)`);

  // A position DETAIL page for an eligible loan must show the chooser
  // AND both newly-exposed paths. Printing handover/offset without
  // failing on them let the drive pass while missing one of the two
  // #1505 surfaces it claims to validate (#1529 review).
  if (!isDetailPath(v.path) || v.nav || preRaced(v)) return problems;

  if (!v.chooser) {
    problems.push(`${role} chooser MISSING on an eligible loan`);
    return problems;
  }

  if (role !== 'lender') {
    if (!v.handover) problems.push('handover path MISSING from the chooser');
    if (!v.offset) problems.push('offset path MISSING from the chooser');
    return problems;
  }

  // The card is an AWARENESS surface, so what makes it correct is that
  // every option is NAMED — an unavailable row explains itself rather
  // than vanishing, precisely because a missing row reads as "no such
  // option". A row absent altogether is therefore a regression even on
  // a loan where that exit is shut.
  if (!v.lenderBlurb) problems.push('lender card title without its own blurb');
  if (!v.waitRow) problems.push('wait row MISSING from the lender card');
  if (!v.sellNowRow) problems.push('sell-now row MISSING from the lender card');
  if (!v.listRow) problems.push('listing row MISSING from the lender card');
  // `null` = not enough rows rendered to have an order; the missing row
  // is already reported above and must not be double-counted.
  if (v.waitFirst === false) problems.push('wait row is NOT first on the lender card');

  // A PRODUCER THAT SAW A DEFECT SAYS SO (Codex #1853 r27). Every arm
  // below infers failure from a PATTERN of fields — a dead entry in
  // `advancedAnchors`, or `advancedJumps === 0` — which works only for
  // the outcomes those patterns were written against. Round 25's
  // Basic-mode-leak guard produced a record matching neither (positive
  // jumps, no anchors) and the reporter let the run exit clean on a
  // directly observed product defect.
  //
  // A FLAG, for the same reason `advancedRaced` is one: a rule the next
  // return has to remember to match is a rule that keeps being
  // forgotten. Anything that observes a defect sets this, and this
  // function honours it without needing to recognise the shape.
  if (v.advancedFailed) {
    problems.push(v.advancedWhy ?? 'the lender Advanced audit reported a failure');
  }

  // PER CHECK, NOT PER RUN (Codex #1853 r18). Round 13 suppressed the
  // whole anchor finding whenever ANY unmapped title existed, which is
  // right about the unmapped row and wrong about its neighbours: one
  // new or reworded jump row would hide a positively observed dead
  // button sitting beside it, and the run would exit 2 for the
  // harness's mapping gap while a real product defect went unprinted.
  // `anchorAudit` keeps each row's own mapping and presence verdict
  // precisely so this does not have to be decided in aggregate.
  //
  // The two verdicts are independent and both are emitted: the dead
  // anchor is a FAIL on evidence we have, the unmapped rows still block
  // on evidence we could not get.
  const deadAnchors = (v.advancedAnchors ?? []).filter(
    (a) => a.target && a.present === false,
  );
  if (deadAnchors.length) {
    // NAME WHERE IT WENT, not only where it should have (Codex #1853
    // r26). The audit now MEASURES navigation, so `present: false`
    // covers two different defects: an anchor that is not there, and a
    // button bound to the wrong one. The old sentence described only
    // the first and printed only the expected id, which on a swapped
    // binding — both anchors present — sends a reader looking for a
    // missing element that exists.
    problems.push(
      'a lender jump button did not reach its own anchor: ' +
        deadAnchors.map((a) => `${a.target} → ${a.reached ?? 'nowhere'}`).join(', '),
    );
  } else if (
    // NOT WHEN THE PRODUCER ALREADY SPOKE (Codex #1853 r29). The
    // readiness FAIL sets `advancedFailed` AND matches this inferred
    // shape, so one defect printed twice — and a reader counting
    // problems would have counted two. The explicit verdict wins; this
    // arm is the inference for records that carry no verdict of their
    // own.
    !v.advancedFailed &&
    v.advancedJumps === 0 &&
    v.advancedAnchorsOk === false
  ) {
    // The no-op switch has NO jump button at all, so the anchor
    // sentence above is not true of it — reporting it that way sent a
    // reader looking for a button that was never rendered. It states
    // its own finding instead (Codex #1853 r16).
    problems.push(v.advancedWhy ?? 'the lender card offered the switch and rendered no jump');
  }

  return problems;
}

/**
 * The reason this visit is BLOCKED (exit 2), or null.
 *
 * Not a product FAIL — nothing was learned about the app either way —
 * but not a clean run either, because the assertion this drive
 * advertises did not execute (Codex #1853 r6).
 *
 * @param {object} v visit record
 * @returns {string|null}
 */
export function visitBlockedReason(v) {
  const unmapped = v.advancedUnmapped ?? [];
  const unexercised = v.advancedUnexercised ?? [];
  if (!v.advancedBlocked && unmapped.length === 0 && unexercised.length === 0) {
    return null;
  }
  // `advancedWhy` wins when the probe named its own reason. The
  // assembled sentence is the fallback for a record that carries a
  // mapping or click gap and no prose.
  const assembled = [
    unmapped.length
      ? `jumping row(s) this drive cannot map to an anchor: ${unmapped.join(', ')}`
      : null,
    unexercised.length
      ? `jump button(s) that could not be clicked: ${unexercised.join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('; ');
  // NEVER THE EMPTY STRING, and this is a defect the extraction itself
  // introduced rather than one it inherited. The driver filtered on the
  // FIELDS and printed the message separately, so a blocked page with
  // no prose printed a blank reason and still exited 2. Returning the
  // message AS the verdict makes `''` falsy, so a caller writing the
  // obvious `if (blocked)` would silently drop the block.
  //
  // Every current producer of `advancedBlocked` sets `advancedWhy`
  // alongside it, so this is unreachable today. It is not defensive
  // padding: the point is that the seam must not be the thing that
  // makes a reachable-tomorrow record disappear, and "the callers all
  // happen to set the other field" is the kind of invariant that stops
  // being true without anyone noticing.
  //
  // `||` rather than the driver's `??`, and deliberately: `??` passes
  // an EMPTY `advancedWhy` straight through, which is the same falsy
  // verdict by a second door. An empty reason is not a reason.
  return (
    v.advancedWhy ||
    assembled ||
    'the Advanced probe did not complete and named no reason'
  );
}

/**
 * Both verdicts for one visit.
 *
 * BOTH ARE ALWAYS COMPUTED, and that is the point rather than an
 * oversight: a page can carry a positively observed dead anchor (FAIL)
 * AND an unmapped row beside it (BLOCKED), and #1853 r18 was exactly
 * the bug of letting the second erase the first. The caller ranks them.
 *
 * @param {object} v visit record
 * @param {'lender'|'borrower'} role
 * @returns {{problems: string[], blocked: string|null}}
 */
export function visitVerdict(v, role) {
  return { problems: visitProblems(v, role), blocked: visitBlockedReason(v) };
}
