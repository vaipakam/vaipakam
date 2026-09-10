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
 * the testnet mocks would pass on mainnet by accident. A ticker here is
 * "two to six characters that are all upper-case letters or digits,
 * containing at least one letter" — which is what a symbol read off an
 * ERC-20 looks like — plus the currency signs a fiat figure would use.
 */
const CURRENCY_MARK = /[$€£¥₹]/;
const TICKER = /\b[A-Z][A-Z0-9]{1,5}\b/;

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
 * STATED LIMIT: this is a heuristic over rendered text, not a parse. It
 * can miss an amount written without any unit at all ("you will receive
 * 1.5"), and it is not asked to catch that — the failure it exists for
 * is a figure that LOOKS authoritative, and a bare decimal with no unit
 * does not. Reporting the limit is the point: a check that overstated
 * its reach would let the next reviewer skip the reading.
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
    const before = text.slice(Math.max(0, start - 8), start);
    const after = text.slice(end, end + 10);

    // `#21`, `loan 21` — an identifier, never an amount.
    if (/[#]\s*$/.test(before)) continue;

    // A currency mark hugging the number on either side.
    if (CURRENCY_MARK.test(before.slice(-2)) || CURRENCY_MARK.test(after.slice(0, 2))) {
      hits.push(fragment(text, start, end));
      continue;
    }

    // A unit word immediately after. `2%` and `3 days` are fine; a
    // ticker is not.
    const trailing = after.match(/^\s*([A-Za-z%]+)/);
    if (trailing) {
      const unit = trailing[1];
      if (NON_MONETARY_UNIT.test(unit)) continue;
      if (TICKER.test(unit) && unit === unit.toUpperCase()) {
        hits.push(fragment(text, start, end));
        continue;
      }
    }

    // A ticker immediately BEFORE the number — `USDC 120`.
    const leading = before.match(/([A-Za-z]+)\s*$/);
    if (leading && TICKER.test(leading[1]) && leading[1] === leading[1].toUpperCase()) {
      hits.push(fragment(text, start, end));
    }
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
 * @property {boolean} mounted   the card rendered at all
 * @property {string|null} text  its rendered text, null when absent
 * @property {boolean} submitDisabled  the submit control's state
 * @property {boolean} lenderHoldsActive  chain says: this wallet holds
 *   the lender position AND the loan is Active — the exact pair that
 *   makes the card's absence a defect rather than correct behaviour
 */

/**
 * The verdict, in the same three-way shape the rest of this harness
 * uses: `pass`, `fail` (a defect observed in the product) and `blocked`
 * (nothing was learned — never reported as a pass).
 *
 * The distinction that matters, and the one round 65 got wrong in the
 * product itself: an ABSENT card on a position the wallet holds and the
 * chain calls Active is a FAIL, because absence is the strongest claim
 * the surface can make — it says the capability does not apply — and it
 * would be made on the one reading that has not happened. A card that
 * is present and merely non-submittable is a PASS: withholding the
 * action while a check runs is the designed behaviour.
 *
 * @param {ForcedCloseObservation} obs
 * @param {{unknownCopy: string}} copy
 */
export function forcedCloseVerdict(obs, copy) {
  if (!obs || typeof obs !== 'object') {
    return { verdict: 'blocked', why: 'no observation recorded' };
  }
  if (!obs.lenderHoldsActive) {
    // The card is correctly absent — or correctly present, since it
    // also mounts while a status read is still unresolved. Either way
    // this drive learned nothing about the invariant.
    return { verdict: 'blocked', why: 'position is not a held Active lender position' };
  }
  if (!obs.mounted) {
    return {
      verdict: 'fail',
      why: 'card absent on a held Active lender position — absence claims the capability does not apply',
    };
  }
  const text = obs.text ?? '';
  if (text.trim() === '') {
    return { verdict: 'fail', why: 'card mounted with no text — withheld the explanation with the action' };
  }
  const amounts = monetaryAmountsIn(text);
  if (amounts.length > 0) {
    return {
      verdict: 'fail',
      why: `card states an amount it cannot know: ${amounts.join(' | ')}`,
      amounts,
    };
  }
  return {
    verdict: 'pass',
    why: obs.submitDisabled
      ? 'card present and non-submittable — the withheld-but-explained state'
      : 'card present and submittable',
    checkRunning: saysCheckRunning(text, copy?.unknownCopy ?? ''),
  };
}
