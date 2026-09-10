/**
 * Does the DEPLOYED forced-close card keep the two promises its spec
 * makes about what it may say?
 *
 * Extracted as a pure module, for the reason `jumpability.mjs` was: a
 * predicate that only ever runs inside a live drive is a predicate no
 * test has executed, and this card's history is four review rounds
 * spent on a branch that could not fire. Everything here is a function
 * of TEXT and two booleans, so `forcedCloseCard.test.mjs` can exercise
 * every arm without a chain, a browser or a deployment.
 *
 * The two promises, both from `docs/FunctionalSpecs/Alpha02ConnectedApp.md`
 * under "Forced close-out of an overdue loan":
 *
 *   1. "Nothing on this surface states an amount. The settlement path is
 *      chosen while the transaction executes, so no figure is knowable
 *      in advance, and a predicted one would be invented."
 *
 *   2. "Withholding an action for safety must not withhold the
 *      explanation with it… the surface stays visible in its unresolved
 *      state and says a check is running. Removing it entirely leaves
 *      the lender with neither the action nor a reason." — and, from the
 *      same section, "An unresolved check is never reported as 'not
 *      available'."
 *
 * Both are checkable against rendered text plus whether the card
 * mounted, which is exactly what a watch-only drive can observe.
 */

/**
 * Token tickers and currency marks that turn an adjacent number into a
 * MONETARY amount.
 *
 * Deliberately a list of shapes rather than a list of assets: the card
 * renders on whatever collateral a real loan carries, and enumerating
 * the testnet mocks would pass on mainnet by accident. See `isTicker`
 * below for the symbol shape; these are the currency signs a fiat
 * figure would use.
 */
const CURRENCY_MARK = /[$€£¥₹]/;

/**
 * Is this word a token symbol?
 *
 * ROUND 1 P2 — the first version required ALL-UPPERCASE, which misses
 * `stETH`, `cbETH`, `wstETH`, `rETH` and every other mixed-case symbol
 * in wide use. Those are exactly the assets a real loan carries, so the
 * scanner was blind on the collateral most likely to appear.
 *
 * Widening to "any word" would be the wrong repair: it would fire on
 * ordinary prose after a number (`1 lender`, `2 rows`), and a scanner
 * that cries wolf gets switched off, losing its true positives. The
 * distinguishing feature of a ticker is an INTERNAL UPPERCASE RUN —
 * `stETH` and `WETH` have one, `days` and `Position` do not. So: two or
 * more consecutive upper-case letters somewhere in a short alphanumeric
 * word.
 */
function isTicker(word) {
  if (typeof word !== 'string') return false;
  if (!/^[A-Za-z][A-Za-z0-9]{1,11}$/.test(word)) return false;
  return /[A-Z]{2}/.test(word);
}

/**
 * Words that make a following number a NAME for something rather than a
 * quantity of it — `loan 21`, `position 4`, `token 9`.
 */
const IDENTIFIER_LEAD = /\b(loan|position|offer|token|id|no|number|nft|item)\s*$/i;

/**
 * Units that make a number a DURATION or a PROPORTION rather than an
 * amount of money. The card is explicitly allowed to show the grace
 * window ("may show the grace window to explain a wait"), so a naive
 * digit scan would fail on correct copy — which is worse than no check,
 * because it would be silenced rather than fixed.
 */
const NON_MONETARY_UNIT =
  /^(%|bps|day|days|hour|hours|hr|hrs|h|minute|minutes|min|mins|m|second|seconds|sec|secs|s|week|weeks|month|months|year|years|block|blocks)$/i;

/**
 * A number with something money-shaped attached to it.
 *
 * Scans for a numeric run and then looks at what sits immediately
 * either side of it. `$120` and `120 USDC` and `USDC 120` all count;
 * `3 days`, `2%`, `500 bps` and a bare `#21` do not.
 *
 * ABSOLUTE SINCE ROUND 2. The spec forbids stating an amount, full
 * stop, so what remains after the named exclusions — durations,
 * proportions, identifiers — is reported. A bare `1.5` fails.
 *
 * STATED LIMIT: this is a heuristic over rendered TEXT, not a parse, so
 * it can only judge what a number sits next to. A figure spelled out in
 * words would pass, and so would one rendered outside the scraped
 * elements. Saying so is the point: a check that overstated its reach
 * would let the next reviewer skip the reading.
 *
 * @param {string} text rendered card text
 * @returns {string[]} the offending fragments, empty when clean
 */
export function monetaryAmountsIn(text) {
  if (typeof text !== 'string' || text === '') return [];
  const hits = [];
  // Numbers with optional grouping and decimals. The separators are
  // locale-dependent — the console formats for the reader's language —
  // so both `,` and `.` are accepted as either role.
  const NUMBER = /\d[\d.,  ']*\d|\d/g;
  let m;
  while ((m = NUMBER.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // 16 chars, not 8: the identifier words below are up to 8 long on
    // their own (`position `), so a shorter window could not see them.
    const before = text.slice(Math.max(0, start - 16), start);
    const after = text.slice(end, end + 10);

    // An IDENTIFIER, never an amount. The `#` form and the spelled-out
    // form both, because the comment here used to claim `loan 21` was
    // covered when only `#21` was — harmless while the scanner needed a
    // ticker to fire, and a false positive the moment round 2 made it
    // absolute. A comment that outlived its code, which is the failure
    // this file keeps finding elsewhere.
    if (/[#]\s*$/.test(before)) continue;
    if (IDENTIFIER_LEAD.test(before)) continue;

    // A currency mark hugging the number on either side.
    if (CURRENCY_MARK.test(before.slice(-2)) || CURRENCY_MARK.test(after.slice(0, 2))) {
      hits.push(fragment(text, start, end));
      continue;
    }

    // A unit word immediately after. `2%` and `3 days` are fine; a
    // ticker is not.
    const trailing = after.match(/^\s*([A-Za-z%][A-Za-z0-9]*)\s*([A-Za-z][A-Za-z0-9]*)?/);
    if (trailing) {
      const unit = trailing[1];
      const next = trailing[2];
      // ROUND 3 P2 — A MAGNITUDE ABBREVIATION IS NOT A DURATION WHEN A
      // TICKER FOLLOWS IT. `1m USDC` reads `m` as minutes, exempts the
      // figure and never looks at `USDC` — so the scanner missed
      // precisely the promise it exists to catch, on the shortest way
      // of writing a large one. The exemption now only applies when
      // nothing token-shaped follows.
      if (NON_MONETARY_UNIT.test(unit)) {
        if (next && isTicker(next)) {
          hits.push(fragment(text, start, end));
        }
        continue;
      }
      if (isTicker(unit)) {
        hits.push(fragment(text, start, end));
        continue;
      }
    }

    // A ticker immediately BEFORE the number — `USDC 120`.
    const leading = before.match(/([A-Za-z][A-Za-z0-9]*)\s*$/);
    if (leading && isTicker(leading[1])) {
      hits.push(fragment(text, start, end));
      continue;
    }

    // ROUND 2 P2 — ANYTHING LEFT IS A FIGURE, AND THE SPEC FORBIDS
    // FIGURES.
    //
    // The rule is "Nothing on this surface states an amount", not
    // "nothing states a unit-bearing amount". `You will receive 1.5`
    // carries no ticker and no currency mark, and the first version let
    // it through while advertising the absolute invariant — narrowing
    // the claim to what the scanner happened to implement.
    //
    // Safe to make absolute BECAUSE the exclusions above are real ones:
    // durations, proportions and identifiers are removed by name, and
    // the calibration case over every shipped `forcedClose` string is
    // what demonstrates there is no third legitimate category. That
    // test is the guard on this arm — if the card ever gains a
    // legitimate bare number, it fails there first, on named copy,
    // rather than surprising a live run.
    hits.push(fragment(text, start, end));
  }
  return hits;
}

function fragment(text, start, end) {
  return text.slice(Math.max(0, start - 12), Math.min(text.length, end + 12)).trim();
}

/**
 * Copy that reports the app's own ignorance. The spec forbids dressing
 * an unresolved check as a protocol answer, so a card that is BOTH
 * unresolved and saying "not available" is the defect.
 *
 * Matched against the shipped `copy.forcedClose.unknown` sentence
 * rather than a paraphrase — the caller passes the expected strings in,
 * so there is no second copy of the wording here to drift out of step
 * with `copy.ts`.
 */
export function saysCheckRunning(text, unknownCopy) {
  if (typeof text !== 'string' || typeof unknownCopy !== 'string') return false;
  // The first clause is enough and survives a later sentence being
  // appended; matching the whole paragraph would fail on an edit that
  // changed nothing about the claim.
  const head = unknownCopy.split(/[.。]/)[0]?.trim();
  return Boolean(head) && text.includes(head);
}

/**
 * @typedef {object} ForcedCloseObservation
 * @property {boolean} mounted   the card rendered AND was visible. Round
 *   3 P2 — `attached` alone passes a card left in the DOM by a CSS
 *   regression with `display: none`, whose text still reads fine from
 *   the DOM while the lender sees neither the action nor its
 *   explanation. Visibility does not require the viewport, so this
 *   costs nothing on an off-screen card.
 * @property {boolean} attached  in the DOM at all, visible or not — kept
 *   apart from `mounted` so the failure can say WHICH of the two
 *   happened rather than reporting a hidden card as an absent one.
 * @property {string|null} text  its rendered text, null when absent
 * @property {string|null} bodyText  the `forced-close-body` paragraph
 *   ALONE. Round 1 P2 — checking only whether the whole card is empty
 *   passes a rendered shell: a heading with no body is precisely the
 *   withheld-action-without-explanation state this module claims to
 *   detect, and it has text.
 * @property {string|null} confirmText  the confirmation panel's text
 *   when it was opened, null when it was not
 * @property {boolean} confirmExpected  a submit control was present and
 *   enabled, so a confirmation SHOULD have been readable
 * @property {boolean} submitDisabled  the submit control's state
 * @property {boolean} settled   the readiness reads finished
 * @property {boolean} lenderHoldsActive  chain says: this wallet holds
 *   the lender position AND the loan is Active
 * @property {boolean} saleLocked  the lender position token carries the
 *   early-withdrawal sale lock, which correctly unmounts the card
 */

/**
 * The verdict: `pass`, `fail` (a defect observed in the product), or
 * `blocked` (nothing was learned — never reported as a pass).
 *
 * A blocked result also carries `blockedKind`:
 *
 *   `inapplicable` — this position could never have exercised the
 *                    assertion (not held, not Active, correctly
 *                    unmounted by a sale lock). Nothing is missing.
 *   `incomplete`   — this position WAS applicable and the observation
 *                    failed anyway (never settled, confirmation
 *                    unreadable). Something IS missing, and round 3 P2
 *                    is that the two must not be pooled: a run where
 *                    one position passes and another is incomplete has
 *                    left a distinct copy path unscanned.
 *
 * ORDER MATTERS HERE, and round 3 P2 is the reason. Content defects are
 * judged FIRST, before eligibility. `observeForcedClose` scrapes the DOM
 * and THEN reads status and ownership, so a loan going terminal in
 * between would otherwise discard an empty body or an invented amount
 * that was actually observed — eligibility qualifying an absence is
 * correct, eligibility suppressing a positive finding is not.
 *
 * @param {ForcedCloseObservation} obs
 * @param {{unknownCopy: string}} copy
 */
export function forcedCloseVerdict(obs, copy) {
  if (!obs || typeof obs !== 'object') {
    return { verdict: 'blocked', blockedKind: 'incomplete', why: 'no observation recorded' };
  }

  // ---- 1. What was actually SEEN on a card that rendered. -----------
  // These need no eligibility: a card carrying an invented amount is a
  // defect whoever holds the position and whatever the chain did next.
  if (obs.mounted) {
    const text = obs.text ?? '';
    if (text.trim() === '') {
      return {
        verdict: 'fail',
        why: 'card mounted with no text — withheld the explanation with the action',
      };
    }
    if ((obs.bodyText ?? '').trim() === '') {
      return {
        verdict: 'fail',
        why: 'card mounted with no explanatory body — the withheld-action-without-explanation state',
      };
    }
    const scanned = obs.confirmText ? `${text}\n${obs.confirmText}` : text;
    const amounts = monetaryAmountsIn(scanned);
    if (amounts.length > 0) {
      return {
        verdict: 'fail',
        why: `states an amount it cannot know: ${amounts.join(' | ')}`,
        amounts,
      };
    }
  }

  // ---- 2. Was this position one the assertion could apply to? ------
  if (!obs.lenderHoldsActive) {
    return {
      verdict: 'blocked',
      blockedKind: 'inapplicable',
      why: 'position is not a held Active lender position',
    };
  }

  // ---- 3. The ABSENCE claim, which eligibility legitimately gates. --
  if (!obs.mounted) {
    if (obs.saleLocked) {
      return {
        verdict: 'blocked',
        blockedKind: 'inapplicable',
        why: 'card absent, but the position carries a sale lock — an accepted sale awaiting completion correctly unmounts it',
      };
    }
    if (obs.attached) {
      return {
        verdict: 'fail',
        why: 'card is in the DOM but not visible — the lender sees neither the action nor its explanation',
      };
    }
    return {
      verdict: 'fail',
      why: 'card absent on a held Active lender position with no sale lock — absence claims the capability does not apply',
    };
  }

  // ---- 4. Was the observation COMPLETE? ----------------------------
  const checkRunning = saysCheckRunning(obs.text ?? '', copy?.unknownCopy ?? '');
  if (!obs.settled) {
    return {
      verdict: 'blocked',
      blockedKind: 'incomplete',
      why: 'card still reported a check running at the deadline — visible and explained, but its settled copy was never scanned for an amount',
      checkRunning,
    };
  }
  if (obs.confirmExpected && obs.confirmText === null) {
    return {
      verdict: 'blocked',
      blockedKind: 'incomplete',
      why: 'submit was offered but its confirmation could not be opened or read — half this surface went unscanned',
    };
  }

  return {
    verdict: 'pass',
    why: obs.submitDisabled
      ? 'card present and non-submittable — the withheld-but-explained state'
      : 'card present and submittable',
    checkRunning,
    confirmScanned: Boolean(obs.confirmText),
  };
}

/**
 * Did the run OBSERVE the thing it advertises?
 *
 * Round 1 P2 established the all-blocked case. ROUND 3 P2 corrects the
 * aggregation: returning null as soon as ANY position passed let an
 * INCOMPLETE observation elsewhere — a card that never settled, a
 * confirmation that could not be read — ride out on its neighbour's
 * success, with that position's distinct copy path unscanned.
 *
 * So the two kinds of `blocked` are counted separately. An
 * `inapplicable` position is genuinely nothing to report. An
 * `incomplete` one is a gap, and it is a gap whether or not something
 * else went well.
 *
 * @param {Array<{path?: string, forcedCloseVerdict?: {verdict: string, blockedKind?: string}|null}>} visits
 * @returns {string|null} the reason to exit 2, or null
 */
export function forcedCloseCoverage(visits) {
  const judged = (Array.isArray(visits) ? visits : []).filter(
    (v) => v && v.forcedCloseVerdict,
  );
  if (judged.length === 0) return null; // not a lender run; nothing advertised

  const incomplete = judged.filter(
    (v) =>
      v.forcedCloseVerdict.verdict === 'blocked' &&
      v.forcedCloseVerdict.blockedKind === 'incomplete',
  );
  if (incomplete.length > 0) {
    return (
      `the forced-close observation was INCOMPLETE on ${incomplete.length} ` +
      `applicable position(s): ` +
      incomplete.map((v) => `${v.path ?? '?'} (${v.forcedCloseVerdict.why})`).join('; ')
    );
  }

  const applicable = judged.filter((v) =>
    ['pass', 'fail'].includes(v.forcedCloseVerdict.verdict),
  );
  if (applicable.length > 0) return null;
  return (
    `forced-close card was never observed on an applicable position ` +
    `(${judged.length} visit(s), all inapplicable) — the assertion did not run`
  );
}
