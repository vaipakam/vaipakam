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
 * Wording that asserts the protocol has REFUSED, as opposed to the app
 * not yet knowing. Checked only against a card that is simultaneously
 * reporting a check in flight, so this is a contradiction test rather
 * than a style rule (round 7 P2).
 */
const REFUSAL_CLAIM =
  /\b(not available|unavailable|cannot be closed|can't be closed|is not possible|not permitted|has refused|was refused|has been refused|protocol refused)\b/i;

/**
 * The shipped `unknown` sentence contains the word "refused" in its
 * NEGATED form — "this is what the app has not read yet, not what the
 * protocol has refused" — which is the surface being CORRECT about the
 * distinction, not claiming a refusal. Adding refusal vocabulary to the
 * matcher above without excluding it would fire on the very copy the
 * rule exists to protect (round 11 P2).
 *
 * So a hit is discarded when a negation governs it within a short
 * window. Deliberately narrow: it only rescues the negated form, and an
 * affirmative "the protocol has refused this" still fails.
 */
const NEGATED_REFUSAL = /\b(not|never|isn't|is not|nothing)\b[^.]{0,40}$/i;

/** The first refusal claim in `text` that no negation governs, or null. */
function firstUnnegatedRefusal(text) {
  const scan = new RegExp(REFUSAL_CLAIM.source, 'gi');
  let m;
  while ((m = scan.exec(text)) !== null) {
    if (!NEGATED_REFUSAL.test(text.slice(0, m.index))) return m[0];
  }
  return null;
}

/**
 * Units that make a number a DURATION or a PROPORTION rather than an
 * amount of money. The card is explicitly allowed to show the grace
 * window ("may show the grace window to explain a wait"), so a naive
 * digit scan would fail on correct copy — which is worse than no check,
 * because it would be silenced rather than fixed.
 */
/**
 * A token symbol somewhere in the short run that follows a figure,
 * across the delimiters real copy uses — spaces, brackets, colons,
 * dashes, commas. Used only to WITHHOLD an exemption, never to create a
 * hit on its own, so widening it cannot introduce a false positive on
 * text that carries no figure.
 */
function hasTickerNear(after) {
  for (const word of String(after).split(/[^A-Za-z0-9]+/)) {
    if (isTicker(word)) return true;
  }
  return false;
}

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
    // 16, not 10: a symbol can sit behind a unit word AND a delimiter
    // (`1m (USDC)`), and the window has to reach it (round 11 P2).
    const after = text.slice(end, end + 16);

    // A unit word immediately after. `2%` and `3 days` are fine; a
    // ticker is not. Parsed BEFORE the exemptions below, because every
    // exemption has to be able to consult it.
    const trailing = after.match(/^\s*([A-Za-z%][A-Za-z0-9]*)\s*([A-Za-z][A-Za-z0-9]*)?/);
    // ROUND 11 P2 — LOOK PAST PUNCTUATION, not only whitespace.
    //
    // `1m (USDC)` and `Loan 100: USDC principal` put a bracket or a
    // colon between the figure and its symbol, and a whitespace-only
    // parse never reached the ticker — so the duration and identifier
    // exemptions fired and the amount escaped. Third variant of the
    // look-before-exempting rule: rounds 3 and 5 widened WHICH
    // exemptions consult the trailing symbol, and this widens what
    // counts as reaching it.
    const trailingTicker = hasTickerNear(after);
    const hugsCurrency =
      CURRENCY_MARK.test(before.slice(-2)) || CURRENCY_MARK.test(after.slice(0, 2));

    // An IDENTIFIER, never an amount — UNLESS a symbol follows it.
    //
    // ROUND 5 P2, and the second instance of one mistake: an exemption
    // that `continue`s before inspecting what comes next. Round 3 had
    // it with `1m USDC`, where `m` was read as minutes; this is `Loan
    // 100 USDC principal`, where `Loan` made the figure an identifier
    // and the ticker behind it was never reached. Both exemptions now
    // look before they leave.
    if (!trailingTicker && !hugsCurrency) {
      if (/[#]\s*$/.test(before)) continue;
      if (IDENTIFIER_LEAD.test(before)) continue;
    }

    // A currency mark hugging the number on either side.
    if (hugsCurrency) {
      hits.push(fragment(text, start, end));
      continue;
    }
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
        // ROUND 11 P2 — consult the SAME widened lookahead the
        // identifier exemption uses. Round 3 checked only the word
        // immediately after the unit, so `1m (USDC)` exempted `m` as
        // minutes and never reached the bracketed symbol. Two
        // exemptions asking the same question needed the same answer.
        if (trailingTicker) {
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
 * @property {boolean|undefined} bodyPresent  did a `forced-close-body`
 *   element exist at all. Round 5 P2: with `bodyText`, this gives the
 *   three states that matter — no element (the heading-only shell, a
 *   defect), element but unreadable (incomplete), element read and
 *   blank (a defect). Round 4's single `bodyRead` flag collapsed the
 *   middle two by treating existence as a successful read.
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
  //
  // ORDERING IS THE RULE HERE, and round 6 is the third time it has had
  // to be applied: judge the DEFINITE observation before any uncertain
  // one. Round 3 put content ahead of eligibility; this puts the amount
  // scan ahead of the body reads, because a card whose own text was
  // captured and contains an invented figure is a defect already
  // observed — downgrading it to `blocked` because a LATER, narrower
  // read failed reports "we could not check" about something we did
  // check.
  if (obs.mounted) {
    // 1a. Nothing was read at all. `text: null` is not empty text: the
    //     card can unmount, or the locator read time out, after the
    //     visibility wait. Coercing that to '' reported an empty-card
    //     defect over an observation that never happened.
    if (obs.text === null || obs.text === undefined) {
      return {
        verdict: 'blocked',
        blockedKind: 'incomplete',
        why: 'the card was visible but its text could not be read — nothing was observed about its content',
      };
    }

    // 1b. THE DEFINITE FINDING, before anything that might be missing.
    //
    // ROUND 8 P2 — `bodyText` is scanned TOO. It is captured
    // independently, a moment after the whole-card read, so the card
    // can update in between and the body can positively carry a figure
    // the card text does not. Scanning only `text` and `confirmText`
    // ignored a value this drive had actually read.
    const scanned = [obs.text, obs.bodyText, obs.confirmText]
      .filter((part) => typeof part === 'string' && part !== '')
      .join('\n');
    const amounts = monetaryAmountsIn(scanned);
    if (amounts.length > 0) {
      return {
        verdict: 'fail',
        why: `states an amount it cannot know: ${amounts.join(' | ')}`,
        amounts,
      };
    }

    // 1c. Read, and genuinely empty.
    if (obs.text.trim() === '') {
      return {
        verdict: 'fail',
        why: 'card mounted with no text — withheld the explanation with the action',
      };
    }

    // 1d-f. THREE STATES for the body, not two (round 5 P2).
    //
    // Round 4 split "read and blank" from "could not read" and then
    // implemented the split as `bodyText !== null || count() > 0`,
    // which sets read=true because an element EXISTS even though the
    // read failed. Existence is not a successful read.
    //
    //   bodyPresent false        → no body element rendered at all.
    //                              That IS the heading-only shell.
    //   present, bodyText null   → the element is there and the read
    //                              did not land. Nothing observed.
    //   present, bodyText blank  → read, and genuinely empty.
    if (obs.bodyPresent === false) {
      return {
        verdict: 'fail',
        why: 'card mounted with no explanatory body element — the withheld-action-without-explanation state',
      };
    }
    // ROUND 8 P2 — a card that vanished mid-scrape is INCOMPLETE, not
    // a pass. Round 7 introduced `undefined` to stop the vanished case
    // being reported as the heading-only shell, and then let it fall
    // through to the final `pass` — so a run could exit clean having
    // never established that the required body existed. My own test
    // asserted that pass, which is the assertion being corrected here.
    if (obs.bodyPresent === undefined) {
      return {
        verdict: 'blocked',
        blockedKind: 'incomplete',
        why: 'the card was read and then vanished before its body could be checked — the explanation was never established',
      };
    }
    if (obs.bodyPresent === true && obs.bodyText === null) {
      return {
        verdict: 'blocked',
        blockedKind: 'incomplete',
        why: 'the body element is present but its text could not be read — nothing was observed about the explanation',
      };
    }
    // Only when the body was actually observed. `bodyPresent:
    // undefined` means the whole CARD vanished mid-scrape (round 7 P2),
    // and a blank read taken from a card that is no longer there is not
    // evidence of anything.
    if (obs.bodyPresent !== undefined && (obs.bodyText ?? '').trim() === '') {
      return {
        verdict: 'fail',
        why: 'card mounted with no explanatory body — the withheld-action-without-explanation state',
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
  // ROUND 9 P2 — applicability gates a MOUNTED card too, not only an
  // absent one.
  //
  // A sale accepted between the DOM scrape and the pinned snapshot
  // leaves a card that WAS mounted on a position now outside the
  // card's applicability. Consulting `saleLocked` only in the absence
  // branch let that stale-but-clean card bank a `pass` and satisfy
  // coverage — evidence drawn from a state the card is not supposed to
  // be in. Definite content failures are preserved above; what is
  // refused here is BANKING a clean reading, exactly as a later
  // ownership or status change is refused.
  if (obs.saleLocked) {
    return {
      verdict: 'blocked',
      blockedKind: 'inapplicable',
      why: 'the position carries an accepted sale awaiting completion — outside this card\'s applicability',
    };
  }

  // ---- 3. The ABSENCE claim, which eligibility legitimately gates. --
  if (!obs.mounted) {
    // The accepted-sale case already returned above, for mounted and
    // absent alike — one rule rather than two.
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
  // ROUND 8 P2, MOVED UP IN ROUND 9 — THE OTHER DIRECTION OF THE SAME
  // CONTRACT, AND IT HAS TO OUTRANK THE UNSETTLED RETURN.
  //
  // The ready-without-action arm below catches a route that should offer
  // the action and does not. This catches its inverse: a WITHHELD state
  // rendering an ENABLED control, offering a transaction the protocol
  // has not established is permitted — or has established will be
  // refused. That is the more expensive half, because there the user
  // pays the fee.
  //
  // Round 8 put it below the `!settled` return, which made it
  // UNREACHABLE for the state that matters most: a card showing
  // `unknown` is BY DEFINITION unsettled, so an `unknown` card with a
  // live button reported `blocked` — the check could not fire on its
  // own headline case. My test hid that by modelling `unknown` with
  // `settled: true`, a combination the driver cannot produce.
  //
  // Fourth application of one rule in this PR: a DEFINITE observation
  // outranks an uncertain one. An enabled control on a withheld state
  // was seen; the settlement question was not answered. The seen thing
  // wins.
  if (!obs.submitDisabled && Array.isArray(copy?.withheldCopy)) {
    const withheld = copy.withheldCopy.find(
      (sentence) => typeof sentence === 'string' && sentence && (obs.text ?? '').includes(sentence),
    );
    if (withheld) {
      return {
        verdict: 'fail',
        why: 'card renders a NON-ACTIONABLE state yet offers an enabled action — the user would pay a fee for a refusal',
      };
    }
  }

  const checkRunning = saysCheckRunning(obs.text ?? '', copy?.unknownCopy ?? '');

  // ROUND 7 P2 — AN UNRESOLVED CHECK MAY NOT CLAIM UNAVAILABILITY.
  //
  // The module names this invariant in its own header — "An unresolved
  // check is never reported as 'not available'" — and then used the
  // unresolved copy only as a readiness SIGNAL, never enforcing it. A
  // card saying both "still checking" and "not available" states the
  // app's ignorance and the protocol's refusal at once, and they are
  // opposite claims.
  //
  // Narrow by construction: this fires only while the card is ALSO
  // reporting a check in flight, so it is a self-contradiction rather
  // than a judgement about wording. Copy that merely says a route is
  // unavailable — which several legitimate states do — is untouched.
  if (checkRunning) {
    // EVERY match, not the first one. The shipped `unknown` copy itself
    // contains "not what the protocol has refused" — correctly negated —
    // and examining only the first hit let that legitimate occurrence
    // vouch for an affirmative claim later in the same card. Fourth
    // variant in this PR of stopping at the first thing found; caught
    // here by the round-7 case failing rather than by review.
    const refusal = firstUnnegatedRefusal(obs.text ?? '');
    if (refusal) {
      return {
        verdict: 'fail',
        why: `card reports a check still running AND claims unavailability ("${refusal}") — opposite claims about the app's knowledge and the protocol's answer`,
      };
    }
  }

  // ROUND 7 P2 — A READY ROUTE MUST OFFER THE ACTION.
  //
  // `pass` labelled every present non-submittable card the valid
  // "withheld-but-explained" state, which is correct for `unknown`,
  // `notYet`, `blockedPaused` and the rest — and wrong for a card
  // rendering ready copy, where the spec says the app offers the
  // action directly. The explanation is what distinguishes a safe
  // withheld state from an actionable one, so it has to be consulted
  // rather than assumed.
  if (obs.submitDisabled && Array.isArray(copy?.readyCopy)) {
    const ready = copy.readyCopy.find(
      (sentence) => typeof sentence === 'string' && sentence && (obs.text ?? '').includes(sentence),
    );
    if (ready) {
      return {
        verdict: 'fail',
        why: 'card renders a READY route yet offers no usable action — a ready route is offered directly, not withheld',
      };
    }
  }

  // ROUND 7 P2 — THE BACK BUTTON PROVES THE SHELL, NOT THE CONTENT.
  //
  // Round 4 waited for Back before accepting a confirmation scan. Back
  // belongs to `ConfirmReceipt`, so it does prove the panel mounted —
  // but the scrape is of the whole card, which still carries the
  // heading, body and notes. A receipt whose rows failed to render
  // therefore produced a non-null `confirmText` and `confirmScanned:
  // true` over content nobody had observed.
  //
  // The receipt's own `youReceive` line is the positive evidence, taken
  // from the shipped bundle so there is no second copy to drift.
  if (obs.confirmText !== null && obs.confirmText !== undefined && copy?.receiptLead) {
    if (!obs.confirmText.includes(copy.receiptLead)) {
      return {
        verdict: 'blocked',
        blockedKind: 'incomplete',
        why: 'the confirmation shell opened but its receipt content did not render — nothing was observed about what it claims',
      };
    }
  }
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

  // ROUND 11 P2 — "EXPLAINED" MEANS A RECOGNISED EXPLANATION.
  //
  // The pass called every non-empty non-submittable card the
  // "withheld-but-explained" state, which establishes only that SOME
  // text exists. A failed locale lookup, a raw key, or a generic
  // "Something went wrong" body all render non-empty, carry no
  // unresolved sentence (so `settled` is true), match no readiness
  // guard, and were reported as correct — while the lender had been
  // told nothing about what is known, unknown, or blocking the action.
  //
  // BLOCKED rather than FAIL, deliberately. Unrecognised copy may be a
  // genuine defect or may be a state this drive does not know about
  // yet, and those are not distinguishable from outside. Reporting the
  // gap in the drive's own vocabulary is honest; accusing the product
  // from it is the false-FAIL direction this PR has already produced
  // twice.
  if (Array.isArray(copy?.recognisedCopy) && copy.recognisedCopy.length > 0) {
    const known = copy.recognisedCopy.some(
      (sentence) => typeof sentence === 'string' && sentence && (obs.text ?? '').includes(sentence),
    );
    if (!known) {
      return {
        verdict: 'blocked',
        blockedKind: 'incomplete',
        why: 'the card rendered text this drive does not recognise as any known state — it establishes that something was said, not that the lender was told what is known or blocking',
      };
    }
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
