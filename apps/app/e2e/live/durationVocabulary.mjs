/**
 * The DURATION VOCABULARY of a locale, sourced from the runtime's own CLDR
 * data, and the matching policy for reading it against rendered text.
 *
 * Consumed by the forced-close amount scanner (`forcedCloseCard.mjs`,
 * `monetaryAmountsIn`), whose rule is that the card states no amount it
 * cannot substantiate and whose exemptions — a duration such as the grace
 * window, a proportion, an identifier — knew only English words. A
 * non-Latin unit word could not reach them, so a grace-window sentence in
 * ja / hi / ta / ko / zh — `猶予期間は 3 日です` — fell through to the
 * absolute bare-figure arm and was reported as an invented amount (#2125).
 * That is the false-FAIL direction, on the one thing the spec explicitly
 * permits the card to say, in five shipped locales. Latent only because no
 * shipped translation currently writes the window with a figure — luck,
 * not a guard.
 *
 * Split out of the scanner in review round 5: plural sampling, `Intl`
 * derivation, caching, script classification and phrase matching are one
 * concern — what a language's duration words are and how they sit in a
 * sentence — and the scanner is their consumer. The scanner keeps what is
 * evidence of an AMOUNT (tickers, currency signs, asset glyphs, magnitude
 * words) and passes that judgement in where this module needs it.
 *
 * The obvious generalisation, "any non-ASCII word after a figure is a
 * unit", is worse than the bug: it would also exempt a non-ASCII asset
 * glyph. So the vocabulary is SOURCED, not guessed:
 *
 *   - `Intl.NumberFormat` with `style: 'unit'` gives each duration unit in
 *     long, short and narrow form, for one sample per plural category the
 *     locale actually has (`durationSamplesFor`);
 *   - `Intl.RelativeTimeFormat` gives the same units in SENTENCE position
 *     — case-inflected (`in 3 Tagen`), with a trailing word (`3 days ago`,
 *     `3 日後`), or before the number where the language writes units
 *     first (`baada ya siku 3`) — and the literal on the number's other
 *     side is kept as the locale's TEMPORAL CONTEXT (`leads` / `trails`:
 *     `dentro de`, `il y a`, `za`, `خلال`), which is what lets a one-letter
 *     unit be read as a duration where the scanner's English context
 *     words cannot.
 *
 * Every word is stored in the SHAPE THE SCANNER READS — the leading
 * letter-run `[\p{L}\p{M}\p{N}]+` of each whitespace-separated word, NFC,
 * folded with the locale — as a WHOLE phrase of up to three tokens, so a
 * linker inside a phrase (`na araw`) is never a unit on its own. One
 * tokeniser for storing and for matching, so they cannot disagree.
 *
 * Empty for a locale the runtime does not know (stated; the all-locale
 * calibration asserts every shipped bundle IS known), and empty when no
 * locale is given — a caller that does not say which language the text is
 * in gets the scanner's English list alone and, for other scripts, a loud
 * false hit rather than a silent miss.
 */

const DURATION_UNITS = ['day', 'hour', 'minute', 'second', 'week', 'month', 'year'];
const UNIT_DISPLAYS = ['long', 'short', 'narrow'];
// One representative per plural category is drawn from these. Spanish and
// French put only the exact millions in `many`, hence the two large
// candidates; the fractions reach the fractional categories of Czech,
// Polish and Ukrainian. Zero is tried LAST (round 5): a locale with a
// single category — Japanese, Chinese, Korean — would otherwise be
// represented by `0` alone, and a relative-time phrase for zero has no
// past form, so `日前` was never learned.
const PLURAL_CANDIDATES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 19, 20, 21, 22, 25, 100, 101, 102, 1000, 1000000,
  2000000, 0.1, 0.5, 1.1, 1.5, 2.5, 10.5, 0,
];
// The parts of a formatted number, so the literal on either side of the
// WHOLE number is found (round 5): `za 0,1 dne` has an integer, a decimal
// mark and a fraction, and reading the part after the first integer alone
// found the decimal mark, took the other side, and stored `za` as a unit.
const NUMERIC_PARTS = new Set(['integer', 'group', 'decimal', 'fraction', 'minusSign', 'plusSign']);
const TOKEN_RUN = /[\p{L}\p{M}\p{N}]+/u;
// Abbreviation marks CLDR writes after a token (`Std.`, `घं॰`, `ימ׳`), which
// the token itself stops at and a phrase may carry between its words.
const ABBREVIATION_MARKS = '[.॰۔׳]';
const MAX_PHRASE_TOKENS = 3;

const tokenOf = (word) => word.normalize('NFC').match(TOKEN_RUN)?.[0] ?? '';
/**
 * Folded for comparison: CLDR writes `siku`, a sentence writes `Siku`, and
 * German capitalises its nouns; the scanner's English list is already
 * case-insensitive. Folded with the VALIDATED tags of the vocabulary
 * (round 5), never with the caller's raw locale — a malformed tag in a
 * fallback list (`['bad_tag', 'ja']`) is skipped at derivation and must
 * not reach `toLocaleLowerCase`, which throws on it.
 */
const foldUnit = (s, tags) =>
  s.normalize('NFC').toLocaleLowerCase(tags.length > 0 ? tags : undefined);

/**
 * One sample number per plural category the locale actually has, so the
 * unit formatters are asked for every grammatical form. Exported so the
 * calibration can assert that every category of every shipped locale is
 * reached — a fixed language-independent list had missed Tagalog's
 * `other` (which `4` selects while `1`, `2`, `3` and `5` all select `one`).
 */
export function durationSamplesFor(tag) {
  const pr = new Intl.PluralRules(tag);
  const byCategory = new Map();
  for (const n of PLURAL_CANDIDATES) {
    const c = pr.select(n);
    if (!byCategory.has(c)) byCategory.set(c, n);
  }
  return {
    categories: pr.resolvedOptions().pluralCategories,
    samples: [...byCategory.values()],
    reached: [...byCategory.keys()],
  };
}

const vocabularies = new Map();
export const EMPTY_VOCABULARY = Object.freeze({
  tags: Object.freeze([]),
  units: new Set(),
  leads: new Set(),
  trails: new Set(),
});

/** The unit words alone — see `durationVocabularyFor` for the whole. */
export function durationUnitsFor(locale) {
  return durationVocabularyFor(locale).units;
}

/**
 * `tags`: the locale tags the runtime knows, in the order given. `units`:
 * the duration words and phrases. `leads` / `trails`: the temporal
 * context around a duration, before the figure and after the unit.
 *
 * @param {string | string[] | undefined} locale a BCP 47 tag or a fallback list
 */
export function durationVocabularyFor(locale) {
  const requested = (Array.isArray(locale) ? locale : [locale]).filter(
    (t) => typeof t === 'string' && t !== '',
  );
  // Encoded without delimiter ambiguity (round 2): joining on `|` let the
  // malformed scalar `'en|ja'` share a cache slot with the valid array
  // `['en', 'ja']`, so whichever was asked first decided the other's
  // vocabulary.
  const key = JSON.stringify(requested);
  if (vocabularies.has(key)) return vocabularies.get(key);
  const tags = requested.filter((tag) => {
    try {
      return Intl.NumberFormat.supportedLocalesOf([tag]).length > 0;
    } catch {
      return false;
    }
  });
  const units = new Set();
  const leads = new Set();
  const trails = new Set();
  for (const tag of tags) {
    const { samples } = durationSamplesFor(tag);
    let unitFirst = false;
    for (const unit of DURATION_UNITS) {
      for (const unitDisplay of UNIT_DISPLAYS) {
        const nf = new Intl.NumberFormat(tag, { style: 'unit', unit, unitDisplay });
        for (const n of samples) {
          const parts = nf.formatToParts(n);
          const at = (type) => parts.findIndex((p) => p.type === type);
          if (at('unit') >= 0 && at('integer') >= 0 && at('unit') < at('integer')) unitFirst = true;
          for (const part of parts) {
            if (part.type !== 'unit') continue;
            const phrase = part.value.split(/\s+/).map(tokenOf).filter(Boolean).join(' ');
            if (phrase !== '') units.add(foldUnit(phrase, [tag]));
          }
        }
      }
    }
    // SENTENCE-POSITION forms (round 3): unit formatting gives the
    // standalone word, and a language that inflects by case writes `in 3
    // Tagen` where the standalone is `Tage`. The literal on the unit's
    // side of the number is the unit phrase; the literal on the other side
    // is context. The unit's side is read from EACH phrase (round 4): the
    // side the unit formatter suggests is used only when it carries a word
    // at all — Hebrew's singular is `בעוד יום (1)`, unit before a bracketed
    // number, although its unit formatter writes the number first.
    for (const unit of DURATION_UNITS) {
      for (const style of UNIT_DISPLAYS) {
        let rtf;
        try {
          rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'always', style });
        } catch {
          continue;
        }
        for (const n of samples.flatMap((s) => (s === 0 ? [0] : [s, -s]))) {
          const parts = rtf.formatToParts(n, unit);
          const first = parts.findIndex((p) => NUMERIC_PARTS.has(p.type));
          if (first < 0) continue;
          let last = first;
          while (last + 1 < parts.length && NUMERIC_PARTS.has(parts[last + 1].type)) last += 1;
          const tokensOf = (part) =>
            part && part.type === 'literal' ? part.value.split(/\s+/).map(tokenOf).filter(Boolean) : [];
          const left = tokensOf(parts[first - 1]);
          const right = tokensOf(parts[last + 1]);
          let unitOnLeft = unitFirst;
          if (unitOnLeft && left.length === 0 && right.length > 0) unitOnLeft = false;
          if (!unitOnLeft && right.length === 0 && left.length > 0) unitOnLeft = true;
          const unitToks = unitOnLeft ? left.slice(-MAX_PHRASE_TOKENS) : right.slice(0, MAX_PHRASE_TOKENS);
          if (unitToks.length > 0) units.add(foldUnit(unitToks.join(' '), [tag]));
          const contextToks = unitOnLeft ? right.slice(0, MAX_PHRASE_TOKENS) : left.slice(-MAX_PHRASE_TOKENS);
          if (contextToks.length > 0) {
            (unitOnLeft ? trails : leads).add(foldUnit(contextToks.join(' '), [tag]));
          }
        }
      }
    }
  }
  const vocabulary = Object.freeze({ tags: Object.freeze(tags), units, leads, trails });
  vocabularies.set(key, vocabulary);
  return vocabulary;
}

/**
 * Separators that may sit between a figure and what is read after it —
 * the same set the scanner's own lookaheads skip.
 */
export const CONTEXT_SEP = /^[\s(\[{:,;«»"'‘’“”)\]}–—-]*/u;
// The lead-in a unit phrase may have after the figure: whitespace and
// hyphens, as in a compound duration (`3-day`).
const PHRASE_LEAD = /^[\s‐-―-]*/u;

/**
 * Does a lead phrase of the locale's temporal wording END `before` —
 * `dentro de 3 h` — at a word boundary, folded with the locale?
 */
export function localeLeadEnds(before, vocabulary) {
  const b = foldUnit(before, vocabulary.tags).replace(/[\s(\[{«"'‘“]*$/u, '');
  for (const lead of vocabulary.leads) {
    if (!b.endsWith(lead)) continue;
    const at = b.length - lead.length;
    if (at === 0 || !/[\p{L}\p{M}\p{N}]/u.test(b[at - 1])) return true;
  }
  return false;
}

/**
 * Does a trail phrase of the locale's temporal wording START `afterUnit`,
 * at a word boundary, folded with the locale?
 */
export function localeTrailStarts(afterUnit, vocabulary) {
  const a = foldUnit(afterUnit, vocabulary.tags).replace(CONTEXT_SEP, '');
  for (const trail of vocabulary.trails) {
    if (!a.startsWith(trail)) continue;
    if (a.length === trail.length || !/[\p{L}\p{M}\p{N}]/u.test(a[trail.length])) return true;
  }
  return false;
}

/**
 * Script classification, for the one place a unit may be a PREFIX of the
 * letter run after the figure: Japanese and Chinese put no space between
 * a counter and what follows, so the run after `3` in `3 日です` is `日です`.
 * Where the run continues in the same script it is one word and no
 * exemption applies — `日本円` is yen, and `3 日本円` is an amount. A
 * character whose script is not listed is treated as the same script, so
 * an unknown pairing is reported rather than exempted.
 */
const SCRIPT_TESTS = [
  'Han',
  'Hiragana',
  'Katakana',
  'Hangul',
  'Latin',
  'Greek',
  'Cyrillic',
  'Arabic',
  'Hebrew',
  'Devanagari',
  'Bengali',
  'Tamil',
  'Telugu',
  'Thai',
].map((s) => new RegExp(`^\\p{Script=${s}}$`, 'u'));
const scriptOf = (ch) => SCRIPT_TESTS.findIndex((re) => re.test(ch));
export const sameScript = (a, b) => {
  const sa = scriptOf(a);
  const sb = scriptOf(b);
  return sa === -1 || sb === -1 || sa === sb;
};
/** The leading run of `s` in the script of its first character. */
export function leadingScriptRun(s) {
  let i = 1;
  while (i < s.length && sameScript(s[0], s[i])) i += 1;
  return s.slice(0, i);
}
// The only continuation read as a PARTICLE (round 3): Hiragana after a Han
// counter — `3日で`, `3か月です`. Hiragana is where Japanese writes its
// grammar; Katakana is where it writes loanwords, and an asset name is a
// loanword (`3日ビットコイン`), so "any other script" was a hole. Index pairs
// into `SCRIPT_TESTS`: Han is 0, Hiragana 1.
const PARTICLE_TRANSITIONS = new Set(['0>1']);
const particleFollows = (last, next) => PARTICLE_TRANSITIONS.has(`${scriptOf(last)}>${scriptOf(next)}`);

/**
 * The locale unit that starts `after` — the text following the figure —
 * and where it ends, or `null`.
 *
 * Whole phrases first, longest first, so `na araw` is matched as one unit
 * and never as `na`; a phrase's words may be separated by whitespace and
 * the abbreviation marks CLDR writes (`घं॰ में`, round 5), never by other
 * punctuation, which ends a phrase as it ends a clause. Then the prefix
 * rule on the first token alone, for a counter written without a space
 * before its particle; the continuation is judged by `isDenomination` —
 * the scanner's own evidence of an amount, on the text as written — so a
 * counter in front of a ticker or glyph (`3日USDC`, `3日ethです`) is not a
 * unit at all.
 *
 * @param {string} after text following the figure
 * @param {ReturnType<typeof durationVocabularyFor>} vocabulary
 * @param {{isDenomination: (suffix: string) => boolean}} judge
 * @returns {{unit: string, end: number} | null}
 */
export function unitAfter(after, vocabulary, { isDenomination }) {
  const { units, tags } = vocabulary;
  if (units.size === 0) return null;
  const lead = after.match(PHRASE_LEAD)[0].length;
  const rest = after.slice(lead);
  const tokens = [...rest.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].slice(0, MAX_PHRASE_TOKENS);
  if (tokens.length === 0 || tokens[0].index !== 0) return null;
  const phraseSpan = new RegExp(
    `^[\\p{L}\\p{M}\\p{N}]+(?:${ABBREVIATION_MARKS}*\\s+[\\p{L}\\p{M}\\p{N}]+)+$`,
    'u',
  );
  for (let k = tokens.length; k >= 1; k -= 1) {
    const last = tokens[k - 1];
    const span = rest.slice(0, last.index + last[0].length);
    if (k > 1 && !phraseSpan.test(span)) continue;
    const phrase = foldUnit(tokens.slice(0, k).map((t) => t[0]).join(' '), tags);
    if (units.has(phrase)) return { unit: phrase, end: lead + span.length };
  }
  const raw = tokens[0][0].normalize('NFC');
  const run = foldUnit(raw, tags);
  // The prefix rule needs the folded and the raw run to line up, so the
  // suffix judged for a denomination is the text as written (folding
  // would lower-case a ticker out of recognition). Where folding changes
  // the length the rule declines, which reports — the loud direction.
  if (run.length !== raw.length) return null;
  for (const u of units) {
    if (u.includes(' ')) continue;
    if (run.length > u.length && run.startsWith(u) && particleFollows(u[u.length - 1], run[u.length])) {
      if (isDenomination(raw.slice(u.length))) return null;
      return { unit: u, end: lead + u.length };
    }
  }
  return null;
}

/**
 * The locale unit that ENDS `before` — a language writing the unit in
 * front of the figure, Swahili's `siku 3` (round 1) — with where it starts,
 * or `null`. Whole phrases, longest first, folded with the locale (`Siku
 * 3` at the start of a sentence); whitespace, abbreviation marks or an
 * opening bracket may sit between the unit and the figure (Hebrew's
 * `בעוד יום (1)`). Exact match only: the prefix rule is about a counter
 * and the particle after it.
 *
 * @returns {{unit: string, start: number} | null}
 */
export function unitBefore(before, vocabulary) {
  const { units, tags } = vocabulary;
  if (units.size === 0) return null;
  for (let k = MAX_PHRASE_TOKENS; k >= 1; k -= 1) {
    const m = before.match(
      new RegExp(
        `((?:[\\p{L}\\p{M}\\p{N}]+${ABBREVIATION_MARKS}*\\s+){${k - 1}}[\\p{L}\\p{M}\\p{N}]+)` +
          `${ABBREVIATION_MARKS}*[\\s(\\[{«"'‘“]*$`,
        'u',
      ),
    );
    if (!m) continue;
    const phrase = foldUnit(m[1].split(/\s+/).map(tokenOf).filter(Boolean).join(' '), tags);
    // `start` is where the phrase begins in `before`, so the duration
    // context can be read from the text in front of it.
    if (units.has(phrase)) return { unit: phrase, start: m.index };
  }
  return null;
}

/**
 * Single-letter units are AMBIGUOUS and the rest are not.
 *
 * `m` is minutes or millions, `h` is hours or nothing, `s` is seconds or a
 * plural. `mins`, `hours` and `days` carry no such reading. The scanner's
 * round 3 closed `1m USDC` by consulting the trailing ticker, but the
 * absolute contract says a BARE figure fails too — and `You receive 1m`
 * has no ticker to cancel the exemption, so the scanner read a promise of
 * a million as a promise of a minute (round 21 P2 there). So an ambiguous
 * unit is exempt only when something around the number actually reads as
 * a duration: `unlocks in 30m` is a wait; `You receive 1m` is an amount.
 */
export const AMBIGUOUS_UNIT = /^[hms]$/i;

/**
 * `AMBIGUOUS_UNIT` generalised to every locale (#2125): a ONE-LETTER unit
 * in an alphabetic script is an abbreviation — `m`, `j`, `M`, `ي` — and
 * might as easily be a magnitude, so it needs duration context. A single
 * CJK ideograph or Hangul syllable is the whole word (`日`, `天`, `일`) and
 * is not ambiguous. The letter is counted without its combining marks
 * (round 4): Hindi's short hour `घं` is one visible letter written as a
 * base plus a mark, and is exactly as much an abbreviation as `h`. `%` is
 * one character and is not an abbreviation of anything. So a bare `3 M`
 * in German is reported — a loud false hit on copy that does not exist,
 * which the all-locale calibration proves — rather than a silent
 * exemption of a compact million.
 */
export function isAmbiguousUnit(unit) {
  if (AMBIGUOUS_UNIT.test(unit)) return true;
  const base = unit.replace(/\p{M}/gu, '');
  if ([...base].length !== 1 || !/^\p{L}$/u.test(base)) return false;
  return !/^[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(base);
}
