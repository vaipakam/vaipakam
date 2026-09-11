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
 *
 * ROUND 35 P2 — `\p{Sc}`, BECAUSE A HAND-LISTED FIVE WAS A DENYLIST
 * WEARING AN ALLOWLIST'S CLOTHES.
 *
 * The class was `[$€£¥₹]`, and a sign outside it made `hugsCurrency`
 * false — which does not merely fail to flag the figure, it hands it to
 * the identifier exemption. `Loan 100 ₽` and `Position 2 ₩` therefore
 * read as names for things rather than amounts and the scanner returned
 * clean, on a surface whose one absolute promise is that no figure
 * appears. Won is the currency of a SHIPPED locale.
 *
 * This is the same failure the transport allowlist had in round 33,
 * arriving from the opposite direction: there a set that was too WIDE
 * waved defects through, here a set too NARROW did. Both were
 * hand-maintained lists standing in for a closed one that already
 * exists. Unicode's `Sc` general category IS the complete set of
 * currency symbols — it carries ₽, ₩, ₺, ₫, ฿, ₴, ₦, ₪, ¢, ₱, ₸, ₿ and
 * the fullwidth forms (`￥`), and no provider or translator can add to
 * it — so there is nothing left to keep in sync.
 *
 * Widening cannot make the scanner cry wolf on shipped copy: a currency
 * sign adjacent to a figure IS the thing being forbidden, and the
 * all-locale calibration over every shipped `forcedClose` string is what
 * demonstrates none of them carries one.
 */
const CURRENCY_MARK = /\p{Sc}/u;

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
 * Glyphs that stand in for an ASSET the way a ticker does — `Ξ` for
 * ether, `Ƀ` for bitcoin, `Ð` for doge, `◎` for sol.
 *
 * A hand-list, stated as one (round 38 P2). `isTicker` cannot reach them
 * (ASCII-only, and they carry no internal uppercase run) and `\p{Sc}`
 * does not contain them (`Ξ` is a Greek capital LETTER, U+039E). No
 * Unicode category groups them, so there is no closed set to defer to
 * the way the currency widening could — which means this list can only
 * be wrong by omission, and the all-locale calibration is what would
 * surface a shipped string carrying an unlisted one.
 *
 * `₿` is deliberately absent: it is `\p{Sc}` and already covered.
 */
const ASSET_GLYPH = /[\u039E\u03BE\u0243\u00D0\u25CE]/u;

/**
 * Lower-case DENOMINATIONS, which `isTicker` cannot reach.
 *
 * ROUND 43 P2. `isTicker` requires an internal uppercase RUN, and that
 * requirement is doing real work: it is what separates `stETH` from the
 * ordinary words that follow numbers in prose (`1 lender`, `2 rows`).
 * Lower-case denominations have no such shape, so `Loan 100 eth` and
 * `Position 2 wei` fell through the identifier exemption as reference
 * numbers — the commonest way an ether figure is actually written.
 *
 * A HAND-LIST, and unlike the ticker test it cannot be anything else.
 * The module's rule is "a list of shapes rather than a list of assets",
 * and that rule is about the UPPERCASE test, which has a shape to key
 * on. Here there is none: `eth` and `is` are the same shape, so only
 * membership distinguishes them. Kept to DENOMINATIONS and the majors
 * rather than every ticker, because the further this reaches the closer
 * it comes to matching ordinary words — `sol` is a Spanish noun, and
 * Spanish ships.
 *
 * The residual is stated rather than hidden: a lower-case unit not
 * listed is missed. The all-locale calibration is the guard — a shipped
 * string carrying one fails there, on named copy, rather than
 * surprising a live run.
 */
const LOWERCASE_ASSET_UNIT = /^(eth|weth|wei|gwei|btc|wbtc|sats|usdc|usdt|dai)$/;

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
 * So a hit is discarded when a negation GOVERNS it. Deliberately
 * narrow: it only rescues the negated form, and an affirmative "the
 * protocol has refused this" still fails.
 *
 * ROUND 13 P2 — PROXIMITY IS NOT GOVERNMENT.
 *
 * The first version accepted any negation within 40 non-period
 * characters, which is a distance test wearing a grammar test's
 * clothes. `The check is not complete, but the protocol has refused
 * this` puts a `not` inside that window belonging to a DIFFERENT
 * clause, so an affirmative refusal claim — the contradiction this
 * check exists to catch — was discarded and the card reported as merely
 * unsettled.
 *
 * A negation governs a refusal when nothing separates them but the
 * words in between: no clause boundary, no coordinating conjunction.
 * The shipped copy satisfies that (`not what the protocol has refused`
 * → ` what the protocol `), and the counterexample does not
 * (`complete, but the protocol ` → a comma AND a `but`).
 */
const NEGATION = /\b(not|never|isn't|isn’t|no|nothing)\b/gi;
/** A comma, a dash, a semicolon or a conjunction — a new clause starts. */
const CLAUSE_BREAK = /[,;:—–]|\b(but|however|yet|although|though|whereas|and)\b/i;

/** Does a negation in `prefix` govern a refusal beginning right after it? */
function refusalIsNegated(prefix) {
  const scan = new RegExp(NEGATION.source, 'gi');
  let m;
  let lastEnd = -1;
  while ((m = scan.exec(prefix)) !== null) lastEnd = m.index + m[0].length;
  if (lastEnd < 0) return false;
  const between = prefix.slice(lastEnd);
  // Still bounded — a negation forty characters back is not governing
  // anything either, clause break or no clause break.
  return between.length <= 40 && !CLAUSE_BREAK.test(between);
}

/** The first refusal claim in `text` that no negation governs, or null. */
function firstUnnegatedRefusal(text) {
  const scan = new RegExp(REFUSAL_CLAIM.source, 'gi');
  let m;
  while ((m = scan.exec(text)) !== null) {
    // Sentence-scoped: a negation in an EARLIER sentence never governs
    // this one, which the old `[^.]{0,40}` encoded as a side effect of
    // its character class and is stated directly here.
    const prefix = text.slice(0, m.index);
    // ROUND 24 P2 — `?` and `!` end sentences too, as do the CJK stops
    // the shipped bundles use, and a rendered line break separates rows.
    // Slicing on `.` alone let `Is the check not ready? The protocol has
    // refused this` keep both sentences together, so the earlier `not`
    // suppressed a definite refusal claim.
    const lastStop = Math.max(
      ...['.', '!', '?', '。', '！', '？', '\n'].map((ch) => prefix.lastIndexOf(ch)),
    );
    const sentence = prefix.slice(lastStop + 1);
    if (!refusalIsNegated(sentence)) return m[0];
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
  // ROUND 23 P2 — STOP AT THE CLAUSE BOUNDARY.
  //
  // The window is a fixed number of characters, so it runs straight
  // through a sentence end into whatever follows: `Wait 3 days. USDC
  // returns later` and `Loan 21. USDC is lent` both put an unrelated
  // ticker inside it, cancelling the duration and identifier exemptions
  // and reporting correct copy as an invented amount.
  //
  // That is the FALSE-POSITIVE direction, which this file argues at
  // length is the one that gets a check switched off — and it would
  // have fired on the two exemptions most likely to appear in real
  // sentences. A ticker belongs to the figure only if nothing separates
  // them, so the search stops at the first boundary.
  // ROUND 24 P2 — `\n` IS A BOUNDARY, and the likeliest one.
  //
  // `innerText` inserts a newline between rendered elements, so the
  // separator between a card's sections is a line break rather than
  // punctuation — `Wait 3 days\nUSDC later` is two rows, not one
  // sentence. Splitting on punctuation alone left exactly the boundary
  // that real card markup produces.
  const clause = String(after).split(/[\n.;!?—–]|,\s/)[0] ?? '';
  for (const word of clause.split(/[^A-Za-z0-9]+/)) {
    if (isTicker(word)) return true;
  }
  return false;
}

const NON_MONETARY_UNIT =
  /^(%|bps|day|days|hour|hours|hr|hrs|h|minute|minutes|min|mins|m|second|seconds|sec|secs|s|week|weeks|month|months|year|years|block|blocks)$/i;

/**
 * Single-letter units are AMBIGUOUS and the rest are not.
 *
 * `m` is minutes or millions, `h` is hours or nothing, `s` is seconds or
 * a plural. `mins`, `hours` and `days` carry no such reading. Round 3
 * closed `1m USDC` by consulting the trailing ticker, but the absolute
 * contract says a BARE figure fails too — and `You receive 1m` has no
 * ticker to cancel the exemption, so the scanner read a promise of a
 * million as a promise of a minute (round 21 P2).
 *
 * So an ambiguous unit is exempt only when something in front of the
 * number actually reads as a duration. `unlocks in 30m` is a wait;
 * `You receive 1m` is an amount.
 */
const AMBIGUOUS_UNIT = /^[hms]$/i;
/**
 * Context that ESTABLISHES TIME, not merely context that precedes a
 * number (round 22 P2).
 *
 * My first list swept in generic modifiers — `for`, `about`, `around`,
 * `under`, `over`, `another` — which read perfectly naturally in front
 * of an amount: `Sell for 1m`, `You receive about 1m`, `Worth over 1m`.
 * Every one of those was exempted as a duration, so the round-21 fix
 * still let a compact amount through, in the phrasings a regression is
 * most likely to use.
 *
 * Only prepositions and verbs that cannot introduce a quantity survive:
 * `in 30m` is a wait, `for 1m` is a price. Kept deliberately small,
 * because a word that is wrong here silently disarms the check, while a
 * missing word merely produces a loud false hit somebody fixes.
 *
 * ROUND 24 P2 — `next` and `every` went the same way, for the same
 * reason, on the same list: `The next 1m is claimable` and `Withdraw
 * every 1m` are quantities. That is now the THIRD time this list has
 * been trimmed for admitting a word that can precede an amount, which
 * is the argument recorded on the PR for narrowing what this scanner is
 * asked to judge rather than continuing to curate vocabulary.
 */
const DURATION_LEAD = /\b(in|within|after|wait|waits|waiting|takes|lasts|expires)\s+$/i;
/**
 * The other half: a temporal word AFTER the unit.
 *
 * ROUND 23 P2 — and `remaining`, `remain`, `remains` and `left` are NOT
 * such words. They describe a residual QUANTITY at least as naturally
 * as a residual duration: `Balance: 1m remaining`, `Only 1m left to
 * claim`. Including them recreated the bare-amount hole on the trailing
 * side, one round after closing it on the leading side, and for the
 * identical reason — I listed words that appear near durations instead
 * of words that cannot appear near amounts.
 *
 * What survives is unambiguous: nothing measures money in `ago` or
 * `from now`. The cost is that `2h remaining` now reports, which is a
 * false hit on plausible-sounding copy — but the shipped strings spell
 * their units out (`72 hours`, `3 days`, `30 minutes`), so no real copy
 * uses this shape, and the all-locale calibration is what proves that
 * rather than my judgement. A loud false hit on copy that does not
 * exist is the affordable error; a silent miss on an invented figure is
 * not.
 */
const DURATION_TRAIL = /^\s*(ago|to go|from now|of grace|earlier|later)\b/i;

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
  // ROUND 13 P2 — UNICODE DECIMAL DIGITS, NOT ASCII.
  //
  // `\d` without the `u` flag is `[0-9]`, so `١٫٥ USDC`, `१.५ USDC` and
  // full-width `１２ USDC` produced NO numeric run at all and the scanner
  // returned clean. Arabic and Hindi are SHIPPED locales, so the
  // all-locale calibration was passing for those bundles because it
  // could not tokenize them — the worst way for a guard on funds copy to
  // be green, since it looks exactly like coverage.
  //
  // `\p{Nd}` covers every decimal-digit script. The separator class gains
  // the Arabic decimal and thousands marks for the same reason: a figure
  // written with them would otherwise split into two runs, and each half
  // would then be judged on its own neighbours rather than as one number.
  const NUMBER = /\p{Nd}[\p{Nd}.,٫٬  ']*\p{Nd}|\p{Nd}/gu;
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
    // ROUND 35, SELF-REVIEW — LOOK PAST PUNCTUATION HERE TOO.
    //
    // Found while verifying the `\p{Sc}` widening above, by probing its
    // edges rather than by reading: the sign set was only half of why
    // `Loan 100 ₽` escaped. The other half is that this test read a
    // TWO-CHARACTER window, so the sign had to be immediately adjacent.
    // `Loan 100  ₽` (two spaces), `Loan 100 ($)` and `Loan 100: ₽` all
    // still returned clean after the widening — and, as above, not
    // merely unflagged: `hugsCurrency` guards the identifier exemption,
    // so each was read as a loan NUMBER.
    //
    // This is round 11's finding one branch over. That round taught the
    // TICKER lookahead to see past a bracket or a colon — its comment
    // names `Loan 100: USDC principal` specifically — and left the
    // currency test on its original window. Two exemptions asking the
    // same question again needed the same answer.
    //
    // Deliberately NOT `hasTickerNear`'s clause scan. A ticker anywhere
    // in the clause is evidence, but a currency sign later in the same
    // sentence is not: `hugsCurrency` short-circuits to a HIT above the
    // duration check, so scanning a whole clause would make
    // `3 days and fees in $` report the `3` — a false FAIL on the grace
    // window this card is explicitly allowed to show. Only SEPARATORS
    // may intervene; no word may.
    // ROUND 37 P2 — THE TYPOGRAPHIC SEPARATORS TOO. The class reached
    // ASCII `-` and `:` and stopped there, so `Loan 100 — ₽` and
    // `Loan 100, ₽` still left through the identifier exemption.
    //
    // These are the characters `hasTickerNear` treats as CLAUSE
    // BOUNDARIES, and admitting them here is a deliberate asymmetry
    // rather than an inconsistency. A ticker is a WORD and can appear in
    // unrelated prose after a dash — round 23 found exactly that — so it
    // must not be attached across a boundary. A currency SIGN is not a
    // word: `₽` does not occur as a standalone token in a sentence, so
    // one sitting immediately after the figure with nothing but
    // punctuation between belongs to it.
    //
    // The rule stays "no WORD may intervene", which is what bounds this.
    // `Loan 100, fees are paid in ₽` does not match — the first
    // non-separator after the figure is `f` — so admitting the comma
    // cannot reach across a clause into unrelated prose. `.` and `!?`
    // are deliberately still absent: a sentence really has ended there.
    const SEP = '[\\s(\\[{:,;«»"\'‘’“”)\\]}\\u2013\\u2014-]*';
    const currencyAfter = new RegExp(`^${SEP}\\p{Sc}`, 'u');
    const currencyBefore = new RegExp(`\\p{Sc}${SEP}$`, 'u');
    const hugsCurrency = currencyBefore.test(before) || currencyAfter.test(after);

    // An IDENTIFIER, never an amount — UNLESS a symbol follows it.
    //
    // ROUND 5 P2, and the second instance of one mistake: an exemption
    // that `continue`s before inspecting what comes next. Round 3 had
    // it with `1m USDC`, where `m` was read as minutes; this is `Loan
    // 100 USDC principal`, where `Loan` made the figure an identifier
    // and the ticker behind it was never reached. Both exemptions now
    // look before they leave.
    // ROUND 38 P2 — AN ASSET GLYPH IS NOT A TICKER AND NOT A CURRENCY
    // SIGN, and `Loan 100 Ξ` fell through the gap between them.
    //
    // `isTicker` is ASCII-only and wants an internal uppercase RUN, so a
    // single `Ξ` fails it. `\p{Sc}` does not contain `Ξ` either — U+039E
    // is a Greek capital LETTER, not a currency symbol. With both false
    // the identifier exemption fired and an ether-denominated figure
    // left as a loan number, which is the commonest way an amount would
    // actually be written on this surface.
    //
    // THIS IS A HAND-LIST, and unlike the currency widening I am not
    // going to pretend otherwise. There is no Unicode category for
    // "asset glyph" to defer to, so the closed-set argument that
    // justified `\p{Sc}` is simply unavailable here. The honest
    // consequence: a glyph not listed will be missed, and the guard is
    // the all-locale calibration — if shipped copy ever carries one, it
    // fails there, on named copy, rather than surprising a live run.
    //
    // Deliberately NOT widened to "any non-ASCII character after a
    // figure". Japanese, Hindi and Tamil ship, and `3日` is a duration:
    // that rule would report the grace window as an invented amount in
    // three locales at once — the false-FAIL direction, on the exemption
    // the spec explicitly protects.
    const trailingGlyph = ASSET_GLYPH.test(after.replace(/^[\s(\[{:,;«»"'‘’“”)\]}\u2013\u2014-]*/, '').slice(0, 2));
    // ROUND 43 P2 — a lower-case denomination counts too, and it is read
    // from a CLAUSE-BOUNDED lookahead rather than from `trailing`.
    //
    // My first version used `trailing[1]` and lower-cased it, which
    // broke round 24's case on the spot: `trailing`'s `\s*` crosses a
    // newline, and `innerText` puts a newline between rendered elements
    // — so `Loan 21\nUSDC is lent` matched `usdc` after case-folding and
    // cancelled the identifier exemption on an unrelated next line. The
    // fix for reaching across a boundary, reaching across a boundary.
    //
    // Two corrections, and the second is the principled one:
    //
    //   - no case folding. The finding is about LOWER-CASE units;
    //     `USDC` is already `isTicker`'s job, and that path respects the
    //     clause boundary through `hasTickerNear`.
    //   - the same clause split `hasTickerNear` uses, because a WORD may
    //     be ordinary prose on the next line and must not be attached
    //     across the break.
    //
    // That is the line between this and the currency/glyph tests, which
    // DO cross a newline deliberately: a symbol is never prose, so one
    // sitting after a figure belongs to it wherever it is rendered. A
    // word is not, so it does not.
    const firstWordAfter = (() => {
      const clause = String(after).split(/[\n.;!?—–]|,\s/)[0] ?? '';
      const w = clause.match(/^[\s(\[{:,;«»"'‘’“”)\]}\u2013\u2014-]*([A-Za-z][A-Za-z0-9]*)/);
      return w ? w[1] : '';
    })();
    const trailingLower = LOWERCASE_ASSET_UNIT.test(firstWordAfter);
    // ROUND 46 P2 — AN IDENTIFIER IS INTEGRAL.
    //
    // `Loan 1.5 will be returned` and `Position 2.75 becomes claimable`
    // were exempted as reference numbers. Loan, position, offer and
    // token ids are whole numbers — a fractional value after one of
    // those words is not naming a thing, it is stating a quantity of
    // one, which is exactly the invented figure the rule forbids.
    //
    // Whole DIGITS, not merely "no decimal point": a grouped `1,000`
    // after an identifier word is not an id either, and ids are not
    // rendered with separators. Both roles of `.` and `,` are ambiguous
    // across locales here, so requiring digits only avoids deciding
    // which is the decimal mark.
    const integral = /^\p{Nd}+$/u.test(m[0]);
    // ROUND 48 P2 — AND IT ENDS WHERE THE DIGITS END.
    //
    // `Loan 1k will be returned` and `Position 2m becomes claimable`
    // walked straight through. `NUMBER` captures only the digit, so
    // `integral` is true; `k` and `m` are neither a ticker nor one of the
    // listed lower-case units, so nothing else objected and the
    // identifier exemption swallowed a compact magnitude — the exact
    // invented figure this scan exists to catch, wearing the one costume
    // the scan is instructed to ignore.
    //
    // An id cannot carry a magnitude suffix, so a LETTER immediately
    // after the digits means the run is not an id and the exemption must
    // not apply. Testing the boundary rather than enumerating `k`/`m`/
    // `bn`/`mm`: enumeration is the mistake this file has now made three
    // times (the transport allowlist, the currency signs, the ASCII-only
    // duration words), and the suffixes are open-ended across locales.
    //
    // A DIGIT after the match cannot occur — `NUMBER` is greedy — and
    // punctuation, whitespace and end-of-text all read as a boundary, so
    // `Loan 21.` and `Loan 21` keep their exemption.
    const endsCleanly = !/^\p{L}/u.test(String(after));
    if (
      !trailingTicker &&
      !hugsCurrency &&
      !trailingGlyph &&
      !trailingLower &&
      integral &&
      endsCleanly
    ) {
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
        // ROUND 21 P2 — a one-letter unit needs duration CONTEXT, not
        // just the absence of a ticker. See `AMBIGUOUS_UNIT`.
        // Strip the UNIT only — `trailing[0]` also swallows the word
        // after it, which is precisely the word being looked for.
        const afterUnit = after.replace(/^\s*[A-Za-z%][A-Za-z0-9]*/, '');
        const temporal = DURATION_LEAD.test(before) || DURATION_TRAIL.test(afterUnit);
        if (AMBIGUOUS_UNIT.test(unit) && !temporal) {
          hits.push(fragment(text, start, end));
          continue;
        }
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
 * @property {boolean|'unknown'} saleLocked  does an ACCEPTED sale
 *   awaiting completion explain this card's absence? TRI-STATE since
 *   round 12: `false` no, `true` yes, `'unknown'` the probe could not
 *   classify. `'unknown'` is not a weak `true` — it is the absence of
 *   an answer, and the verdict reports the two differently
 */

/**
 * Has this observer caught up far enough to JUDGE an absent card?
 *
 * The absence FAIL is the one verdict whose cost is a wrongly accused
 * product, so it is gated on a re-read that can actually see what the
 * page saw. Two conditions, and round 13 shipped only the first:
 *
 *   1. `observerHead > pinnedBlock` — this client moved at all. Round
 *      13's fix, and necessary: viem served the head from a 4-second
 *      cache, so the "later" read was routinely the same block.
 *   2. `observerHead >= pageHead` — this client reached what the page
 *      had ALREADY SEEN. Round 14's finding, and the one that makes the
 *      gate sound: condition 1 proves only that we advanced. A page
 *      whose provider is two blocks ahead can correctly drop the card
 *      for a transition at N+2 while we confirm at N+1, re-read a
 *      still-eligible position, and emit the same false FAIL one block
 *      further along.
 *
 * STRICTLY AHEAD of the page's announced head, not merely level (round
 * 16 P2). `pageHead` is a LOWER BOUND on what the page knows: it is the
 * last height the page was seen to ANNOUNCE, and the read that actually
 * unmounted the card is an `eth_call` the page issues at `latest`, which
 * carries no block number on the wire in either direction. So the page
 * can have evaluated at a height above anything we recorded. Requiring
 * the observer to pass that bound rather than match it closes the
 * one-block case and re-reads every fact at a height where a transition
 * at or below it would be visible to us as well.
 *
 * IT DOES NOT CLOSE THE GENERAL CASE, and this comment is the place that
 * says so rather than implying an airtight gate. If the page's real head
 * runs several blocks beyond its last announced one AND a transition
 * lands in that window, an absence can still be reported as a defect.
 * One thing shrinks it — the gate requires this observer to PASS the
 * announced bound rather than draw level with it — but shrinking is not
 * eliminating.
 *
 * ROUND 41 P2 — THE `newHeads` CREDIT IS STRUCK, here as it was in the
 * coverage notes. This comment still said socket pushes are "recorded
 * alongside HTTP `eth_blockNumber`, so the bound tracks the real head
 * far more closely". They are recorded, and the bound does not track
 * anything better for it: `live-position-observe.mjs` exits 2 at the
 * `wsRpcMethods.size` gate on ANY WebSocket JSON-RPC traffic, before a
 * verdict or coverage is computed — so on precisely the runs where
 * socket heads would matter, nothing downstream ever reads them. Round
 * 37 corrected the operational account and left this one, which is the
 * duplicate-site pattern again, across a file boundary. The complete fix is for
 * the card to publish the block its readiness resolved at, the way the
 * chooser publishes its readiness (#1855); this drive would then compare
 * two stated facts instead of racing an unobservable one. Tracked in
 * #2098.
 *
 * `pageHead === 0n` means the page's head was never observed, and that
 * is NOT treated as satisfied. Nothing is known about the relationship
 * between the two views, and an absence judged on an unknown
 * relationship is exactly the accusation this gate exists to withhold.
 * A drive that cannot see the page's head therefore reports every
 * absence as incomplete — conservative, loudly, rather than confidently
 * wrong.
 *
 * @param {bigint} observerHead  head this drive has reached
 * @param {bigint} pinnedBlock   block the snapshot was taken at
 * @param {bigint} pageHead      highest block the PAGE was seen to know
 * @returns {boolean}
 */
export function confirmationReady(observerHead, pinnedBlock, pageHead) {
  if (typeof observerHead !== 'bigint' || typeof pinnedBlock !== 'bigint') return false;
  if (typeof pageHead !== 'bigint' || pageHead === 0n) return false;
  return observerHead > pinnedBlock && observerHead > pageHead;
}

/**
 * Fold the CONFIRMING re-read into the pinned snapshot's eligibility.
 *
 * The driver pins status / ownership / sale to one block beside the DOM
 * scrape, and then — only when the card was ABSENT on a position that
 * snapshot calls eligible — re-reads all three at a later head, because
 * the deployed bundle can be a block ahead of this observer and the
 * card may be correctly absent. This decides what that second read did
 * to the first one's verdict.
 *
 * IT IS HERE, AND NOT IN THE DRIVER, FOR THE REASON `visitVerdict.mjs`
 * IS: as an inline predicate it could only be exercised by driving a
 * live chain into each state, and the live chain does not carry them —
 * so every defect in it has had to be found by reading. It was written
 * inline, and the first thing that happened was a defect:
 * `later.sale` was consulted with a TRUTHINESS test after round 12 made
 * the probe tri-state, so `'unknown'` marked the position ineligible.
 * That reports `inapplicable` — nothing is wrong — for a missing card
 * on the strength of an accepted sale that was never established. It is
 * precisely the finding round 12 raised, surviving in the one branch
 * whose job is deciding whether an absent card is a FAIL.
 *
 * ORDER IS THE WHOLE CONTENT of this function, and it runs
 * established-facts-first:
 *
 *   1. Terminal, or transferred away — ESTABLISHED. The position has
 *      left the eligible set, which explains the absent card exactly,
 *      so this outranks an unresolved sale probe: a known reason beats
 *      an unknown one.
 *   2. An accepted sale — ESTABLISHED. Also explains it, and naming the
 *      sale is a better reason than the generic ineligibility the old
 *      code reported for this case.
 *   3. The probe could not classify — NOT ESTABLISHED. Nothing is
 *      concluded; the caller's verdict reports an incomplete
 *      observation, which trips coverage rather than passing quietly.
 *
 * @param {object} pinned      `{lenderHoldsActive, saleLocked}` from the
 *   snapshot taken beside the DOM scrape
 * @param {object|null} later  `{active, stillHeld, sale}` from the
 *   confirming head read, or null when no confirmation was needed
 * @returns {{lenderHoldsActive: boolean, saleLocked: boolean|'unknown'}}
 */
export function reconcileEligibility(pinned, later) {
  const lenderHoldsActive = Boolean(pinned?.lenderHoldsActive);
  const saleLocked = pinned?.saleLocked ?? false;
  if (!later) return { lenderHoldsActive, saleLocked };

  // ROUND 13 P2 — THE CONFIRMATION CAN FAIL TO HAPPEN.
  //
  // The confirming read only means something if it observed a STRICTLY
  // NEWER block than the snapshot: its whole job is to catch a page
  // whose provider is ahead of this observer. viem served the head from
  // a 4-second cache, so the "later" read was routinely the SAME block —
  // a re-read that could only agree with itself, waving through the
  // false missing-card FAIL it was added to prevent.
  //
  // When no newer head arrives, nothing was confirmed, and the absence
  // must not be reported as a product defect on evidence never
  // obtained. Eligibility is left as the snapshot found it and the
  // absence is flagged unconfirmed, which the verdict reports as an
  // incomplete observation.
  if (later.unconfirmed) {
    return {
      lenderHoldsActive,
      saleLocked,
      absenceUnconfirmed: true,
      // The SPECIFIC condition that failed, so the report does not send
      // an operator to a stale RPC when the real gap is that the page's
      // head was never observed (round 23 P2).
      absenceUnconfirmedWhy: later.why,
    };
  }

  if (!later.active || !later.stillHeld) {
    return { lenderHoldsActive: false, saleLocked };
  }
  if (later.sale === true) {
    return { lenderHoldsActive, saleLocked: true };
  }
  if (later.sale === 'unknown') {
    return { lenderHoldsActive, saleLocked: 'unknown' };
  }
  // The head agrees the position is still eligible and carries no sale.
  // The pinned reading stands — INCLUDING a pinned `'unknown'`, which a
  // later `false` does not retroactively resolve: the two probes ran at
  // different blocks and the earlier one still did not answer.
  return { lenderHoldsActive, saleLocked };
}

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
  // 1-pre. THE AMOUNT EVIDENCE IS GATHERED HERE; WHERE IT IS REPORTED
  //        depends on whether a card rendered (round 33 P2).
  //
  // This arm used to live inside the `obs.mounted` block below, which
  // made the drive's one ABSOLUTE claim conditional on the card still
  // being there when the poll stopped. A card that stated a figure while
  // its readiness reads were outstanding and then VANISHED — the loan
  // went terminal, the token transferred, a sale was accepted — was
  // positively observed stating it, and every one of those exits skipped
  // the scan. Worse, the accepted-sale case then returns `inapplicable`
  // at section 2, so the run reported "nothing to see here" about a
  // figure a lender had actually been shown.
  //
  // It is also what makes it safe for a vanished card to report
  // `mounted: false` — without this, classifying the vanish honestly
  // would have silently disarmed the scan for exactly the records that
  // carry the evidence.
  //
  // THE EVIDENCE IS GATHERED HERE AND REPORTED IN TWO PLACES, and the
  // first draft of this fix got that wrong in a way the existing suite
  // caught immediately. Returning the FAIL from here outranks the
  // duplicate-card and duplicate-control arms, and those deliberately
  // outrank the content scan: the scan only ever read the FIRST card, so
  // a finding drawn from it must not be handed to a reader as the verdict
  // on a surface this drive has only partly interrogated. That ordering
  // is round 19's and round 26's, and it stands.
  //
  // So the scan runs twice from one computation: inside the mounted
  // block, in its original position BELOW the duplicate arms, and again
  // for records where no card rendered — the branch that had no scan at
  // all and is the whole point of this round's finding.
  //
  // ROUND 8 P2 — `bodyText` is scanned TOO. It is captured independently,
  // a moment after the whole-card read, so the card can update in between
  // and the body can positively carry a figure the card text does not.
  // Scanning only `text` and `confirmText` ignored a value this drive had
  // actually read.
  //
  // ROUND 31 P2 — INCLUDING the renders the readiness poll superseded.
  // `obs.text` / `obs.bodyText` are the SETTLED render; `seenTexts`
  // carries every render the drive actually read.
  //
  // Absent on records that predate the field, and on every path that
  // never polls, so it is spread defensively rather than assumed — the
  // same `typeof` discipline the duplicate-control arm uses, and for the
  // same reason: a record without the field must not change the verdict.
  //
  // ROUND 35 P2 — SCANNED SEPARATELY, NEVER JOINED. The `\n` join I
  // added last round let one render supply CONTEXT for another's digits,
  // and the scanner's exemptions are all context. A render ending in
  // `Loan` followed by one beginning `1.5` became `Loan\n1.5`, whose
  // `IDENTIFIER_LEAD` crosses the synthetic newline through `\s*` — so
  // the figure was exempted as a loan NUMBER and the verdict passed,
  // while scanning that render on its own reports it.
  //
  // Joining could only ever have hurt: each part is a complete rendered
  // string, so no real amount spans two of them, and the only thing an
  // adjacency creates is a neighbour that was never on screen together.
  // The hits are concatenated instead, which is what was wanted all
  // along — every render judged on its own text.
  const parts = [
    obs.text,
    obs.bodyText,
    obs.confirmText,
    ...(Array.isArray(obs.seenTexts) ? obs.seenTexts : []),
  ].filter((part) => typeof part === 'string' && part !== '');
  //
  // De-duplicated for the MESSAGE only. The whole card's text contains
  // its body's, so a figure in the body is reported by both parts, and
  // two identical fragments say nothing a reader can act on differently.
  // The verdict turns on whether there were any, which dedup cannot
  // change.
  const amounts = [...new Set(parts.flatMap((part) => monetaryAmountsIn(part)))];
  const amountFinding = () => ({
    verdict: 'fail',
    failKind: 'observed',
    why: `states an amount it cannot know: ${amounts.join(' | ')}`,
    amounts,
  });

  // A FAILED SCRAPE IS NOT A MOUNTED CARD WITH UNREADABLE TEXT. Its
  // record carries `mounted: true` so the absence rules below cannot
  // turn it into a missing-card FAIL, but arm 1a would describe it as
  // "the card was visible but its text could not be read" — a statement
  // about the page, when the truth is that the pass never ran.
  if (obs.mounted && !obs.scrapeFailed) {
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

    // 1a-bis. MORE THAN ONE CARD IS ITSELF A FINDING (round 19 P2).
    //
    // Every read and every click this drive makes is scoped to the FIRST
    // match, so a second visible card was silently discarded — and the
    // contracts asserted here are about the whole surface, not about
    // whichever element matched first. A clean first card would let a
    // second state an amount it cannot know, withhold its explanation,
    // or offer a control the first correctly withholds, and the run
    // would still pass.
    //
    // Reported BEFORE the content scan below rather than after: the scan
    // only ever saw the first card, so a pass from it says nothing about
    // the others, and a reader must not be handed a clean-looking
    // content verdict for a surface that was never fully read.
    if (typeof obs.visibleCards === 'number' && obs.visibleCards > 1) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `${obs.visibleCards} forced-close cards are visible at once — this drive reads only the first, so the others are unchecked and the surface states its case more than once`,
      };
    }

    // 1a-bis-2. AND A DUPLICATE THAT HAS SINCE GONE (round 35 P2).
    //
    // The arm above reads the SETTLED render. A second card present on
    // an intermediate readiness tick and gone by the time the card
    // settled was counted and then discarded by the poll's `snap =
    // again`, so the final record said `visibleCards: 1` and passed.
    // The drive only ever scraped the first card's text, so that second
    // surface was never read at all — it could have stated an amount or
    // offered an action while the run reported the page clean.
    //
    // A separate sentence rather than the one above, because the two
    // describe different situations and an operator reading "2 cards are
    // visible" about a page now showing one would go looking for
    // something that is not there.
    if (typeof obs.visibleCardsPeak === 'number' && obs.visibleCardsPeak > 1) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `${obs.visibleCardsPeak} forced-close cards were visible at once during the readiness wait, though only one remains — the drive read the first and never the other, so a surface it could not vouch for was shown to the lender`,
      };
    }

    // 1a-ter-2. THE SAME, ONE LEVEL DOWN (round 39 P2). Round 35 gave
    // the CARD count a peak and left the CONTROL count reading the
    // settled snapshot, so two visible submit controls on an
    // intermediate tick were counted and then overwritten. That is the
    // more dangerous duplicate of the two: the copy explains one
    // decision while the lender is offered it twice, and the drive
    // inspected only the first.
    if (typeof obs.visibleSubmitsPeak === 'number' && obs.visibleSubmitsPeak > 1) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `${obs.visibleSubmitsPeak} forced-close submit controls were visible at once during the readiness wait, though only one remains — the lender was briefly offered the same fee-paying action twice and this drive clicked only the first`,
      };
    }

    // 1a-ter. MORE THAN ONE SUBMIT CONTROL, same rule one level down
    // (round 26 P2).
    //
    // The card-level duplicate check above does not see two controls
    // inside ONE card, and that arrangement is the more dangerous of the
    // two: the readiness copy explains a single decision while the
    // surface offers the lender two buttons for it. Whichever is
    // pressed, at most one can be the action the copy describes.
    //
    // Reported as a FAIL rather than folded into the actionability
    // flags, because the flags now answer "is an action offered" from
    // the visible set and would answer YES here — correctly, and while
    // hiding that the surface offers the action twice. Ranked beside the
    // duplicate-card arm and before the content scan for the same
    // reason: a clean content verdict must not be handed to a reader
    // over a surface this drive has only partly interrogated.
    if (typeof obs.visibleSubmits === 'number' && obs.visibleSubmits > 1) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `${obs.visibleSubmits} forced-close submit controls are visible in one card — the copy explains a single decision while the lender is offered it more than once, and this drive clicks only the first`,
      };
    }

    // 1b. THE DEFINITE FINDING, before anything that might be missing.
    //     Gathered at `1-pre`, reported here — below the duplicate arms
    //     above, which outrank it, and above the body reads below, which
    //     it outranks. Do not move either boundary without reading the
    //     note at `1-pre`: both directions have been wrong once.
    if (amounts.length > 0) return amountFinding();

    // 1c. Read, and genuinely empty.
    if (obs.text.trim() === '') {
      return {
        verdict: 'fail',
        failKind: 'observed',
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
        failKind: 'observed',
        why: 'card mounted with no explanatory body element — the withheld-action-without-explanation state',
      };
    }
    // ROUND 21 P2 — A FOURTH STATE: present, read, and NOT VISIBLE.
    //
    // A CSS regression that hides only the body leaves the element in
    // place, and `innerText` can still yield its DOM text — so a
    // heading-only surface, which is exactly the
    // withheld-action-without-explanation shape, was passing on text
    // the lender cannot see. Presence, text and visibility are three
    // different facts and the first two do not imply the third.
    //
    // `=== false` rather than a falsy test, so an observation predating
    // the field says nothing rather than manufacturing a finding.
    if (obs.bodyVisible === false && obs.bodyPresent === true) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: 'card mounted with an explanatory body that is not visible — the lender sees the heading and no reason',
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
        failKind: 'observed',
        why: 'card mounted with no explanatory body — the withheld-action-without-explanation state',
      };
    }
  }

  // 1-post. THE SAME FINDING, for a record where no card rendered.
  //
  // This is the branch the round-33 P2 was about. A card that stated a
  // figure while its readiness reads were outstanding and then VANISHED —
  // the loan went terminal, the token transferred, a sale was accepted —
  // was positively observed stating it, and every unmounted path skipped
  // the scan entirely. Worse, an accepted sale then returns `inapplicable`
  // just below, so the run reported nothing to see about an amount a
  // lender had actually been shown.
  //
  // Above section 2 for the reason that section already states about
  // mounted cards: eligibility qualifying an ABSENCE is correct,
  // eligibility suppressing a POSITIVE finding is not. The duplicate-card
  // arms are not a concern here — no card rendered, so there is no
  // partly-read surface to misrepresent.
  if ((!obs.mounted || obs.scrapeFailed) && amounts.length > 0) return amountFinding();

  // 1-post-2. The duplicate the poll saw, on a record where no card
  //           survived to be counted (round 35 P2). Same reasoning as
  //           the arm inside the mounted block; the card vanishing
  //           afterwards does not unsee it.
  if ((!obs.mounted || obs.scrapeFailed) && typeof obs.visibleCardsPeak === 'number' && obs.visibleCardsPeak > 1) {
    return {
      verdict: 'fail',
      failKind: 'observed',
      why: `${obs.visibleCardsPeak} forced-close cards were visible at once during the readiness wait, and the card is now gone — the drive read the first and never the other`,
    };
  }

  // 1-post-3. THE CONTROL PEAK, on the same path (round 40 P2).
  //
  // Round 39 added the submit peak inside the mounted block and I did not
  // add its unmounted twin, though the card peak has had one since round
  // 35 — the fourth time in this PR a fix has landed on one of two
  // parallel sites. The consequence is the one this ordering exists to
  // prevent: both poll exits carry the peak and set `mounted: false`, so
  // the check was skipped, and if the pinned snapshot then found an
  // accepted sale the verdict returned `inapplicable` — reporting nothing
  // to see about a lender who had been offered the same fee-paying action
  // twice.
  if ((!obs.mounted || obs.scrapeFailed) && typeof obs.visibleSubmitsPeak === 'number' && obs.visibleSubmitsPeak > 1) {
    return {
      verdict: 'fail',
      failKind: 'observed',
      why: `${obs.visibleSubmitsPeak} forced-close submit controls were visible at once during the readiness wait, and the card is now gone — the lender was offered the same fee-paying action twice and this drive clicked only the first`,
    };
  }

  // 1-post-4. THE PER-RENDER CONTENT SCANS, AHEAD OF APPLICABILITY
  //           (round 41 P2).
  //
  // Both of these judge what a render SAID, and both sat after section
  // 2 — so an accepted sale found by the pinned snapshot returned
  // `inapplicable` and discarded a contradiction the lender had been
  // shown. The amounts and the duplicate counts were moved ahead of that
  // exit in rounds 33 and 40 for exactly this reason; these two were
  // left behind. Fifth instance in this PR of a rule applied to some of
  // its sites and not the rest.
  //
  // The rule they are being brought under is the one this module states
  // in its own header: eligibility qualifying an ABSENCE is correct,
  // eligibility suppressing a POSITIVE finding is not.
  //
  // Below the mounted block, so the duplicate-card and duplicate-control
  // arms still outrank them — a finding drawn from the first card must
  // not be presented as the verdict on a surface only partly read.
  // ROUND 7 P2 — AN UNRESOLVED CHECK MAY NOT CLAIM UNAVAILABILITY.
  //
  // The module names this invariant in its own header — "An unresolved
  // check is never reported as 'not available'" — and then used the
  // unresolved copy only as a readiness SIGNAL, never enforcing it. A
  // card saying both "still checking" and "not available" states the
  // app's ignorance and the protocol's refusal at once, and they are
  // opposite claims.
  //
  // Narrow by construction: this fires only where a render ALSO
  // reported a check in flight, so it is a self-contradiction rather
  // than a judgement about wording. Copy that merely says a route is
  // unavailable — which several legitimate states do — is untouched.
  //
  // NOT GATED ON `checkRunning`, deliberately (round 37 P2). That
  // variable reads the SETTLED render, and gating on it would have
  // reintroduced the very defect being fixed one line up: a card that
  // contradicted itself mid-poll and then settled clean has
  // `checkRunning === false`, so the scan below would never run. Each
  // part now carries its own check-running test instead, which is both
  // the gate and the pairing.
  {
    // EVERY match, not the first one. The shipped `unknown` copy itself
    // contains "not what the protocol has refused" — correctly negated —
    // and examining only the first hit let that legitimate occurrence
    // vouch for an affirmative claim later in the same card. Fourth
    // variant in this PR of stopping at the first thing found; caught
    // here by the round-7 case failing rather than by review.
    // ROUND 37 P2 — EVERY CAPTURED RENDER, not only the settled one.
    //
    // This invariant is ABOUT the unresolved state — "an unresolved
    // check is never reported as 'not available'" — and it was reading
    // only `obs.text`, which is the render the poll finally settled on.
    // A card that said both things WHILE its checks ran and then reached
    // clean ready copy had the contradiction overwritten by the ordinary
    // readiness update, so the arm could not fire on the exact moment it
    // exists to catch.
    //
    // Scanned PER PART, never over the joined text, for round 35's
    // reason: the pairing must be two claims in ONE render. A render
    // saying "still checking" and a different one later saying
    // "unavailable" is a card that resolved, which is correct
    // behaviour — pairing those across renders would manufacture a FAIL
    // out of a normal transition.
    const refusal = parts
      .map((part) =>
        saysCheckRunning(part, copy?.unknownCopy ?? '') ? firstUnnegatedRefusal(part) : null,
      )
      .find((hit) => hit);
    if (refusal) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `card reports a check still running AND claims unavailability ("${refusal}") — opposite claims about the app's knowledge and the protocol's answer`,
      };
    }
  }


  // Two recognised readiness states inside ONE captured render. The
  // settled-render form of this check lives further down, where the
  // recognised-copy vocabulary is consulted; this is the form that
  // survives the poll overwriting `bodyText`, and it has to clear
  // applicability for the same reason the refusal scan does.
  if (Array.isArray(copy?.recognisedCopy) && copy.recognisedCopy.length > 0) {
    const twoStateSeen = parts
      .map((part) =>
        copy.recognisedCopy.filter(
          (sentence) => typeof sentence === 'string' && sentence && part.includes(sentence),
        ),
      )
      .find((hits) => hits.length > 1);
    if (twoStateSeen) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `a render this drive read stated ${twoStateSeen.length} recognised readiness states at once, though the card settled on one — the lender was shown two different things about the same decision`,
      };
    }
  }

  // 1-post-5. A BODY PRESENT AND HIDDEN, on any render (round 41 P2).
  //
  // The heading-without-a-reason state is what the absence rule exists
  // to catch, and `remember` kept the texts and the counts while
  // dropping this. Observed on a render, then discarded when the card
  // vanished — and explained away as `inapplicable` if a sale had been
  // accepted meanwhile.
  //
  // SCOPED TO UNMOUNTED RECORDS, and that is a correction to my own
  // first version of this fix, found by re-reading it rather than by
  // review.
  //
  // Unscoped, this latch fires on ANY tick of a ~30-second poll — so a
  // body that reads as present-but-invisible for a single frame and then
  // paints correctly becomes a FAIL on a card that ends up entirely
  // right. Round 10 established the opposite convention for precisely
  // this situation: a transient ready-but-disabled control is a
  // legitimate intermediate state and the FAIL requires the condition to
  // PERSIST to the deadline. Applying a stricter rule to the body than
  // to the control would be an inconsistency with no argument behind it,
  // and false FAILs on funds checks are what get them switched off.
  //
  // The hole the finding actually describes is narrower: evidence
  // discarded when the card VANISHES, where the settled render can no
  // longer speak for itself. For a mounted record the settled
  // `bodyVisible === false` arm above already applies and is the right
  // test. So this covers exactly the case the settled arm cannot reach.
  //
  // `=== true`, so a record predating the field says nothing rather than
  // manufacturing a finding.
  if ((!obs.mounted || obs.scrapeFailed) && obs.bodyHiddenSeen === true) {
    return {
      verdict: 'fail',
      failKind: 'observed',
      why: 'a render this drive read had its explanatory body present but not visible — the lender was shown the heading and no reason, whether or not the card settled that way',
    };
  }

  // 1-post-6. THE SCRAPE ITSELF DID NOT RUN (round 41 P2, REPOSITIONED
  //           by round 42 P2).
  //
  // I put this arm FIRST when I added it, reasoning that every arm below
  // reasons from an observation and this record is the absence of one.
  // That is true of an INITIAL scrape failure and false of a mid-poll
  // one: the loop's exit deliberately carries `seenTexts`, both peaks
  // and `bodyHiddenSeen`, so a card already observed stating a forbidden
  // amount, showing duplicate controls, or hiding its body had that
  // evidence discarded and the run downgraded to exit 2. My own fix
  // turned a confirmed funds defect into "nothing was learned" — the
  // exact failure the exit-ranking work of rounds 38–39 was about.
  //
  // One position serves both cases. An initial failure carries no
  // accumulated evidence, so the arms above find nothing and fall
  // through to here; a later failure is judged on what was seen first.
  //
  // Still ABOVE applicability and absence: a scrape that did not run
  // must never become a missing-card FAIL, and must not be explained
  // away by an accepted sale either.
  if (obs.scrapeFailed) {
    return {
      verdict: 'blocked',
      blockedKind: 'incomplete',
      why: 'the DOM pass over the card could not be completed — nothing further was observed, so neither its content nor its absence says anything about the page',
    };
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
  // ROUND 12 P2 — the sale probe is TRI-STATE.
  //
  // `true` is an established accepted sale, which puts the position
  // outside this card's applicability: nothing is wrong, nothing to
  // report. `'unknown'` is a probe that could not classify — on a
  // deployment carrying another guard, say — and reporting THAT as
  // inapplicable would suppress a genuinely missing card while printing
  // a confident reason for its absence. Different facts, different
  // kinds of blocked.
  if (obs.saleLocked === 'unknown') {
    return {
      verdict: 'blocked',
      blockedKind: 'incomplete',
      why: 'the sale-listing probe returned an unrecognised revert, so whether an accepted sale explains this card could not be established',
    };
  }
  if (obs.saleLocked === true) {
    return {
      verdict: 'blocked',
      blockedKind: 'inapplicable',
      why: 'the position carries an accepted sale awaiting completion — outside this card\'s applicability',
    };
  }

  // ---- 3. The ABSENCE claim, which eligibility legitimately gates. --
  if (!obs.mounted) {
    // ROUND 13 P2 — AN ABSENCE THE CONFIRMATION NEVER REACHED.
    //
    // The missing-card FAIL is the one verdict here whose cost is a
    // wrongly accused product, which is why it is gated on a re-read at
    // a LATER block: a page whose provider is a block ahead can be
    // correctly showing nothing. When that later block never arrived,
    // the gate did not run, and reporting the FAIL anyway would rest it
    // on evidence the drive did not obtain.
    //
    // Above the hidden-card arm deliberately: `attached` is read from
    // the same DOM pass, so it is equally unconfirmed.
    if (obs.absenceUnconfirmed) {
      return {
        verdict: 'blocked',
        blockedKind: 'incomplete',
        why:
          obs.absenceUnconfirmedWhy ??
          "the card was absent, but this observer could not be shown to have caught up with the page, so a page reading ahead of it could not be ruled out",
      };
    }
    // The accepted-sale case already returned above, for mounted and
    // absent alike — one rule rather than two.
    if (obs.attached) {
      return {
        verdict: 'fail',
        // ROUND 39 P2 — INFERRED, not observed, and the distinction now
        // decides whether this finding may overtake an infrastructure
        // blocker at the run's exit.
        //
        // Round 38 ranked forced-close FAILs ahead of the route,
        // WebSocket and wrong-chain gates so a funds defect the drive had
        // READ could not be downgraded to "nothing was learned". I wrote
        // in that commit that absence findings must stay behind those
        // gates, because a transport failure legitimately explains a
        // missing surface — and then filtered on `verdict === 'fail'`,
        // which includes exactly the two arms it must not. The principle
        // was stated correctly and implemented backwards.
        //
        // This arm is inferred rather than read for the same reason: the
        // nodes are present and none is painted, which a stylesheet that
        // failed to fetch produces just as readily as a CSS regression
        // does. Conservative on purpose — the cost is a real finding
        // reported one gate later, against a false accusation of the
        // product.
        failKind: 'inferred',
        why: 'card is in the DOM but not visible — the lender sees neither the action nor its explanation',
      };
    }
    return {
      verdict: 'fail',
      // INFERRED — see the note on the arm above. This is the clearest
      // case of the two: nothing was rendered, so nothing was read, and
      // the conclusion rests entirely on the chain reads agreeing that
      // the position is still eligible. A page that could not fetch its
      // RPC, or one served by an endpoint on another chain, produces
      // precisely this observation while the product is blameless.
      failKind: 'inferred',
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
  // ROUND 18 P2 — AN OFFER IS A CONTROL THE LENDER CAN ACTUALLY USE.
  //
  // `disabled === false` on an element that EXISTS is not the same
  // claim. A CSS regression that hides an enabled button is wrong in
  // both directions: on withheld copy it manufactures a FAIL saying the
  // lender was offered a fee-paying transaction, and on ready copy it
  // hides the missing usable action behind a merely incomplete
  // confirmation. Same defect as round 3's on the card itself, one
  // level down — existence mistaken for actionability.
  //
  // `!== false` rather than a truthy test, deliberately: an observation
  // that predates this field says nothing about visibility, and treating
  // silence as "hidden" would invent findings on every older record.
  const actionOffered = obs.submitVisible !== false && !obs.submitDisabled;

  if (actionOffered && Array.isArray(copy?.withheldCopy)) {
    const withheld = copy.withheldCopy.find(
      (sentence) => typeof sentence === 'string' && sentence && (obs.text ?? '').includes(sentence),
    );
    if (withheld) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: 'card renders a NON-ACTIONABLE state yet offers an enabled action — the user would pay a fee for a refusal',
      };
    }
  }

  const checkRunning = saysCheckRunning(obs.text ?? '', copy?.unknownCopy ?? '');

  // ROUND 7 P2 — A READY ROUTE MUST OFFER THE ACTION.
  //
  // `pass` labelled every present non-submittable card the valid
  // "withheld-but-explained" state, which is correct for `unknown`,
  // `notYet`, `blockedPaused` and the rest — and wrong for a card
  // rendering ready copy, where the spec says the app offers the
  // action directly. The explanation is what distinguishes a safe
  // withheld state from an actionable one, so it has to be consulted
  // rather than assumed.
  if (!actionOffered && Array.isArray(copy?.readyCopy)) {
    const ready = copy.readyCopy.find(
      (sentence) => typeof sentence === 'string' && sentence && (obs.text ?? '').includes(sentence),
    );
    if (ready) {
      return {
        verdict: 'fail',
        failKind: 'observed',
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
  // ROUND 43 P2 — EITHER LEGITIMATE RECEIPT LEAD, because there are two.
  //
  // `ForcedCloseCard` renders `rentalReceipt` rather than `receipt` on
  // `ready-rental`, and the two `youReceive` strings are entirely
  // different — one describes collateral or the lent asset, the other
  // the prepaid rent and an NFT that stays put. Supplying only the
  // ordinary lead meant a rental confirmation could render all six rows
  // correctly and still be reported `blocked/incomplete`: a FALSE gap in
  // coverage on the one route this drive already records as uncovered,
  // which is the worst place for it — nobody would have questioned an
  // `incomplete` there.
  //
  // Accepting EITHER rather than selecting by readiness, deliberately.
  // The observation carries no readiness field, and adding one to pick
  // the lead would make this arm depend on a value the DOM pass infers
  // from prose. Both strings are legitimate receipt leads; what this arm
  // establishes is that the panel rendered its receipt at all, and
  // either one proves that.
  //
  // `receiptLeads` plural. The singular `receiptLead` is still accepted
  // so an older constructed record keeps working.
  const leads = Array.isArray(copy?.receiptLeads)
    ? copy.receiptLeads.filter((lead) => typeof lead === 'string' && lead !== '')
    : [copy?.receiptLead].filter((lead) => typeof lead === 'string' && lead !== '');
  if (obs.confirmText !== null && obs.confirmText !== undefined && leads.length > 0) {
    if (!leads.some((lead) => obs.confirmText.includes(lead))) {
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
  // ROUND 45 P2 — THE CONFIRMATION MUST OFFER ITS OWN ACTION.
  //
  // The drive clicked the outer submit, waited for Back and scanned the
  // six rows — and never looked at the button that would actually send
  // the transaction. A confirm control missing, hidden, blank or
  // permanently disabled strands the lender one click short while the
  // run reports the ACTIONABLE route as covered, which is the strongest
  // claim this drive makes.
  //
  // Judged only where the panel was established to have rendered, so a
  // shell that never opened is still reported by the arms around it
  // rather than as a missing button.
  //
  // On the path this drive takes the control cannot legitimately be
  // unusable: `ConfirmReceipt`'s confirm is `disabled={busy || disabled}`,
  // `ForcedCloseCard` passes `disabled={holdingAfterSubmit}`, and
  // `submittable` is `canSubmitFromApp(readiness) && !holdingAfterSubmit`
  // — so a card whose outer submit was clickable has both false, and
  // `busy` cannot be true because this drive never submits.
  //
  // Absent `confirmAction` says nothing: an older record predates the
  // field, and inventing a finding from silence is the failure mode this
  // file guards against everywhere else.
  // ROUND 46 P2 — GATED ON THE PANEL, not on the receipt reading.
  //
  // `confirmText` is null whenever any receipt row fails its scan, so a
  // BROKEN CONFIRM BUTTON plus one bad row suppressed the action finding
  // entirely and the visit was downgraded to BLOCKED. An incomplete
  // receipt is a gap in what was read; an unusable transaction button is
  // a defect that WAS read, and the second must not be hidden by the
  // first — the same ordering rule this module applies to amounts and
  // duplicate controls.
  //
  // The presence of `confirmAction` IS the panel evidence: the receipt
  // pass runs only after the Back control was seen, so a record carrying
  // this field is a record whose confirmation opened.
  if (obs.confirmAction) {
    const a = obs.confirmAction;
    // ROUND 46 P2 — TWO ACTIONS BESIDE BACK is a finding in itself, and
    // ranked ahead of the usability tests below for the same reason the
    // duplicate-card arm outranks the content scan: the fields describe
    // the FIRST control, so a clean reading of it says nothing about the
    // second. One level in from the duplicate-submit rule and the more
    // dangerous level — these buttons send the transaction rather than
    // opening a panel.
    if (typeof a.count === 'number' && a.count > 1) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `the confirmation offers ${a.count} actions beside Back — the receipt explains one decision while the lender is given more than one way to pay for it, and this drive inspected only the first`,
      };
    }
    if (!a.present || !a.visible || !a.enabled || !a.labelled) {
      const why = !a.present
        ? 'no confirmation action was rendered beside Back'
        : !a.visible
          ? 'its confirmation action is not visible'
          : !a.labelled
            ? 'its confirmation action has no label'
            : 'its confirmation action is disabled';
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `the confirmation opened but ${why} — the lender is left one click short of the action the card offered`,
      };
    }
    // SELF-REVIEW AFTER ROUND 46 — AND THE LABEL MUST BE PAINTED.
    //
    // `labelled` reads `innerText`, which yields every word whatever its
    // colour, and the button's own visibility check cannot cover this:
    // `paintsText` exempts a node with no own text, and a button that
    // wraps its label in a span — the usual way to write one — is that
    // node. So `color: transparent` on the label left every field above
    // true on a control the lender reads as blank. Round 37 fixed this
    // for the receipt's leaves and not for the button beside them.
    //
    // Its own arm rather than folding into `labelled`, because the two
    // are different defects and the lender's experience of them differs:
    // an unlabelled button is a blank control, an unpainted one is a
    // control that is not there at all until it is hovered.
    //
    // `=== false`, so a record predating the field says nothing.
    if (a.labelPainted === false) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: 'the confirmation action carries a label in the markup but none of it is painted — the lender is asked to confirm a forced close-out on a control that reads as blank',
      };
    }
    // ROUND 46 P2 — AND IT MUST BE ABLE TO RECEIVE THE CLICK.
    //
    // Visible, enabled and labelled are all true of a button covered by
    // another element, or one under `pointer-events: none`. The lender
    // cannot activate either, and every field above says the route is
    // fine. The drive asks Playwright the actionability question
    // directly with a TRIAL click, which runs the checks and dispatches
    // nothing — the only form of this test a watch-only drive may make,
    // since the real click sends a fee-paying transaction.
    //
    // `=== false`, so a record that never ran the trial says nothing.
    if (a.clickable === false) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: 'the confirmation action is visible and enabled but cannot receive a click — covered by another element, or not accepting pointer events',
      };
    }
    // ROUND 47 P2 — AND AN UNTESTED ACTION IS NOT A PASS.
    //
    // The previous round's own fix created this. Leaving `clickable`
    // unset when the re-read label did not match the snapshot's control
    // was the honest thing to do about the reading, but the verdict then
    // fell through to `pass` — so a lender run could exit 0 having never
    // established that the fee-paying action is usable, which is the
    // single claim the trial exists to make.
    //
    // BLOCKED, not FAIL: nothing was observed to be wrong. It is an
    // incomplete observation, and `forcedCloseCoverage` already treats
    // an incomplete observation as a gap that exits 2 — "re-run, this
    // did not establish what it advertises" — rather than as a defect.
    //
    // `=== null` and not falsy: `undefined` still means a record from
    // before the field existed, and accusing one of a gap it could not
    // have filled would be inventing a finding from silence.
    if (a.clickable === null) {
      return {
        verdict: 'blocked',
        blockedKind: 'incomplete',
        why: 'the confirmation opened but its action could not be identified for the click trial — the control the snapshot described was not the one found, so whether the lender can submit went untested',
      };
    }
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
    // The BODY, not the whole card. The card also carries the
    // `lastOutcome` note about a PREVIOUS attempt, and the component's
    // own comment says that note does not describe the current state —
    // so matching against the card text let a broken readiness body be
    // vouched for by a history line (round 12 P2).
    const stateText = obs.bodyText ?? obs.text ?? '';
    const known = copy.recognisedCopy.filter(
      (sentence) => typeof sentence === 'string' && sentence && stateText.includes(sentence),
    );
    if (known.length === 0) {
      return {
        verdict: 'blocked',
        blockedKind: 'incomplete',
        why: 'the card rendered text this drive does not recognise as any known state — it establishes that something was said, not that the lender was told what is known or blocking',
      };
    }
    // ROUND 33 P2 — EXACTLY ONE, because these nine are ALTERNATIVES.
    //
    // `.some()` stopped at the first match, so a body carrying TWO of
    // them satisfied recognition on the strength of either. The states
    // are mutually exclusive by construction — `ForcedCloseCard`'s
    // `PRESENTATION` table maps one readiness to one `body` string, and
    // exactly one is rendered — so two at once is a composition or
    // merge regression, and it is the worst-shaped one this card can
    // have: the surface would tell the lender both that they recover the
    // collateral and that they recover the asset they lent. With an
    // enabled control, both action-consistency arms below agree and the
    // generic receipt supplies the expected lead, so nothing else here
    // would have caught it.
    //
    // FAIL rather than the BLOCKED used for unrecognised copy, and the
    // distinction is the usual one: unrecognised text may be a state
    // this drive has not learned, which is a gap in its vocabulary;
    // two recognised states TOGETHER is the product contradicting
    // itself about what a lender is owed, which is a defect.
    //
    // This cannot fire on correct copy by accident: it would take one
    // shipped state's sentence to be a substring of another's, and
    // `forcedCloseCard.test.mjs` pins that non-containment across every
    // translated bundle rather than leaving it to English and to luck.
    if (known.length > 1) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `the card's body states ${known.length} recognised readiness states at once — they are alternatives, so the lender is being told two different things about the same decision`,
      };
    }
    // ROUND 38 P2 — AND IN EVERY CAPTURED RENDER, not only the settled
    // one. The check above reads `bodyText`, which the poll overwrites,
    // so a render showing two mutually exclusive states that then
    // settled on one clean state was seen, recorded in `seenTexts`, and
    // passed. The lender was shown two different recovery outcomes at
    // once; the drive had the evidence and did not look at it.
    //
    // PER PART, never over a join — round 35's rule, and here it is not
    // merely about context but about the claim itself: two states in ONE
    // render is a contradiction, two states across two renders is a card
    // resolving. Joining would report every ordinary transition as a
    // defect.
    //
    // Only parts that match at all are judged. A part matching NOTHING
    // is not a finding here: an early render can legitimately be empty
    // or carry copy this drive has no vocabulary for, and the
    // unrecognised-copy arm above deliberately applies to the SETTLED
    // render alone for that reason.
    const twoStateRender = parts
      .map((part) =>
        copy.recognisedCopy.filter(
          (sentence) => typeof sentence === 'string' && sentence && part.includes(sentence),
        ),
      )
      .find((hits) => hits.length > 1);
    if (twoStateRender) {
      return {
        verdict: 'fail',
        failKind: 'observed',
        why: `a render this drive read stated ${twoStateRender.length} recognised readiness states at once, though the card settled on one — the lender was shown two different things about the same decision`,
      };
    }
  }

  return {
    verdict: 'pass',
    why: !actionOffered
      ? obs.submitVisible === false && !obs.submitDisabled
        ? 'card present and non-submittable — the control is enabled but not visible'
        : 'card present and non-submittable — the withheld-but-explained state'
      : 'card present and submittable',
    checkRunning,
    confirmScanned: Boolean(obs.confirmText),
    // ROUND 27 P2 — reported on the PASS, where it is least expected
    // and most needed. A duplicate control FAILS above, so on this path
    // the count is always 0 or 1 and looks redundant; what it actually
    // documents is that the count REACHED the verdict at all. The two
    // times this field went missing it arrived here as `undefined`, and
    // the duplicate arm then could not fire on any input — a check
    // switched off with nothing to show for it. Now the run prints
    // `submits=undefined` in that state instead of a confident pass.
    visibleSubmits: obs.visibleSubmits,
    // ROUND 36, SELF-REVIEW — the SAME treatment, for the same reason.
    //
    // `visibleCardsPeak` is added to the record OUTSIDE the snapshot
    // spread, by hand, at three separate exits. That is exactly the
    // shape that dropped a field twice before round 27 deleted the
    // projection's field list — and the spread cannot protect a value
    // the spread does not carry. Its arm FAILS above, so on this path
    // the number is always 0 or 1 and looks redundant; what it documents
    // is that the field ARRIVED. A silent regression to `undefined` at
    // one of those three exits now prints `peak=undefined` instead of a
    // confident pass.
    visibleCardsPeak: obs.visibleCardsPeak,
    visibleSubmitsPeak: obs.visibleSubmitsPeak,
    // SELF-REVIEW AFTER ROUND 46 — round 27's remedy, applied to the
    // trial click, and needed here for a reason the other three do not
    // have: this field can legitimately be absent.
    //
    // `clickable === false` FAILS above, so on this path the value is
    // `true` or `undefined`, and `undefined` means the trial was never
    // run — which now happens on purpose, when the re-read label does
    // not match the control the snapshot described. That is the honest
    // outcome, but it is also indistinguishable from the check having
    // silently stopped running, and a usability test that quietly
    // switched itself off is the failure mode this file keeps finding.
    //
    // So the run SAYS which. Round 47 narrowed what can appear here:
    // `null` — this run did not test it — is now BLOCKED above, so the
    // only values reaching a pass are `true` (trialled, actionable) and
    // `undefined` (a record predating the field). The print distinguishes
    // them, because a pass carrying `unrecorded` on a current run would
    // mean the assignment had gone missing.
    confirmClickable: obs.confirmAction?.clickable,
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
export function forcedCloseCoverage(visits, role) {
  const judged = (Array.isArray(visits) ? visits : []).filter(
    (v) => v && v.forcedCloseVerdict,
  );
  // ROUND 41 P2 — "NO VERDICTS" MEANS TWO DIFFERENT THINGS and this
  // returned the same answer for both.
  //
  // On a BORROWER run the forced-close card is not observed at all, so
  // an empty set is correct and there is nothing to report. On a LENDER
  // run it means the assertion this drive ADVERTISES never reached a
  // single position — the observation unwired, the field renamed, the
  // scrape never called — and the run exited 0 announcing routes clean.
  // That is the exact failure round 1 introduced this function to catch,
  // reachable through the one input it treated as uninteresting.
  //
  // The role has to be PASSED rather than sniffed from the records,
  // because the records are what went missing: inferring "this was a
  // lender run" from the presence of lender fields makes the check
  // vanish precisely when it is needed. The caller knows `ROLE`.
  //
  // Unknown role is treated as the permissive case deliberately — an
  // older caller that passes nothing must not start failing — and the
  // parity test pins that the live caller does pass it.
  if (judged.length === 0) {
    if (role !== 'lender') return null; // borrower run; nothing advertised
    return (
      'no forced-close verdict was recorded on any visit of a LENDER run — ' +
      'the assertion this drive advertises did not run at all'
    );
  }

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
