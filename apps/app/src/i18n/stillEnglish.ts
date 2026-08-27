/**
 * "Is this locale value still the English one, as far as a reader is
 * concerned?" — the single definition, shared.
 *
 * SHARED because it is asked in two places that must agree, and did not
 * have to. `check-locale-coverage.ts` asks it of every leaf;
 * `check-baselines-shrink-only.mjs` asks it of a pair being REMOVED
 * from the record, to refuse a deletion of debt that is still owed. The
 * removal check first compared exactly, and the committed baseline
 * already contains values these rules deliberately normalize away —
 * `ko:contractError.SaleListingActive` differs from the English only in
 * case — so lowercasing a value was enough to make its evidence
 * deletable (Codex #1607 r23).
 *
 * Restating the rule in the second guard would have been the eleventh
 * instance in this pull request of one fact living in two places, and
 * the first where the two copies were an actual security property
 * rather than prose. One definition, imported twice.
 *
 * Every rule here was found by a review round rather than designed up
 * front; the comments name the round so the reasoning survives the
 * next edit.
 */

/**
 * Default-ignorable code points removed. They render as nothing, so
 * they can never be the difference between two visible strings — and
 * every comparison below is about what a reader sees, so every one of
 * them drops these first.
 */
export const stripIgnorable = (value: string): string =>
  value.replace(/\p{Default_Ignorable_Code_Point}/gu, '');

/**
 * The visible MARKS, with all spacing removed.
 *
 * Spacing is not a language, and the worded branch has never treated it
 * as one — `wordsOf` tokenizes, so separators disappear before anything
 * is compared. The wordless branch trimmed only the ends, which left
 * one arrangement uncovered: `.` written as `. .` is two English full
 * stops to the reader and an undecomposable stream to the guard, so it
 * passed (Codex #1607 r19). Same treatment, same branch.
 *
 * Measured: no wordless verdict on the committed bundles changes.
 */
export const marksOf = (value: string): string =>
  stripIgnorable(value.normalize('NFKC')).replace(/\s+/gu, '');

/** What a reader actually sees, ends trimmed. */
export const visibleForm = (value: string): string =>
  // NFKC, matching `wordsOf`: compatibility-equivalent punctuation is
  // the same mark on screen. `．` (U+FF0E) is the English full stop
  // wearing a wide glyph, and comparing NFC let it through (Codex
  // #1607 r10). NFKC folds it to `.` while leaving `。` alone, which
  // is the distinction rounds 1 and 4 turned on.
  stripIgnorable(value.normalize('NFKC')).trim();

/**
 * Does this value contain any LETTER at all, once interpolation tokens
 * are removed?
 *
 * `wordsOf` counts a digit run as a word, which is right for comparing
 * vocabulary — `Step 1 of 2` and `Step 1/2` differ by the word `of`,
 * and dropping the digits would lose that. It is wrong for asking
 * "is there prose here": a label replaced by `123` has a word by that
 * measure and no readable text by any other, and it passed every check
 * in the file (Codex #1607 r14). The two questions need two tests.
 */
export const hasLetters = (value: string): boolean =>
  // Invisible letters do not count. U+115F HANGUL CHOSEONG FILLER is
  // simultaneously `\p{L}`, default-ignorable, and a Hangul character
  // the Korean bundle is allowed to contain — so appending it to `…`
  // satisfied this test, the script rule and the still-English rule at
  // once, while rendering as punctuation (Codex #1607 r15). Every other
  // comparison in this file drops ignorables first; this one did not.
  /\p{L}/u.test(stripIgnorable(value.replace(/\{\{[^}]*\}\}/g, ' ')));

export const wordsOf = (value: string): string[] =>
  (stripIgnorable(
    value
      // Interpolation tokens are removed first. They are not prose, and
      // their identifiers are not words: `({{c}} of {{t}})` reordered to
      // `({{t}} of {{c}})` produced a different "word" sequence and was
      // called a translation, while every visible word stayed English —
      // and `placeholderDrift` deliberately PERMITS that reordering,
      // because grammar requires it. Whether the tokens are right is its
      // job; whether the prose is English is this one's (Codex #1607 r8).
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .normalize('NFKC'),
  )
    // Invisible characters are dropped BEFORE tokenizing, not after.
    // A zero-width space inside a word splits it into two: `Set​tings`
    // tokenized as `set` + `tings`, which matches no English word list
    // and passed as a translation while rendering as "Settings" (Codex
    // #1607 r11). The wordless path already stripped them; the worded
    // path did not, so the same character defeated one check and not
    // the other.
    .toLowerCase()
    // LETTERS only — digits are not vocabulary. Keeping them let a
    // digit dropped INSIDE a word break the decomposition: `Set1tings`
    // produced a stream no arrangement of `settings` could cover, so
    // mangled English read as translated (Codex #1607 r14 asked the
    // same question of prose and got `123`; r18 found the inverse).
    // Nothing is lost: a value differing from the English only in its
    // numbers is not a translation either.
    .match(/\p{L}+/gu) ?? []);

export const stillEnglish = (source: string, candidate: unknown): boolean => {
  if (typeof candidate !== 'string') return false;
  const sourceWords = wordsOf(source);
  const candidateWords = wordsOf(candidate);
  // Wordless on either side — the punctuation IS the content. This is
  // the case that makes a blanket punctuation-strip wrong:
  // `copy.consentParts.suffix` is `.` in English and `。` in Chinese,
  // and both reduce to zero words. Stripping punctuation would call a
  // correct localization "still English" (Codex #1607 r4).
  //
  // The SAME question as the worded branch, asked of characters instead
  // of words: can what the reader sees be built entirely out of the
  // source's own marks? Exact comparison was the earlier answer and it
  // excused a repetition — `.` doubled to `..` is not a translation
  // into anything, and it passed (r18). `。` is not among the English
  // marks, so a real localization still reads as translated.
  //
  // Default-ignorable code points are removed first. They render as
  // nothing, so `.` followed by a zero-width space IS the English full
  // stop on screen while differing in bytes — a regression that looked
  // like a translation (r6).
  if (sourceWords.length === 0 || candidateWords.length === 0) {
    const sourceMarks = marksOf(source);
    const candidateMarks = marksOf(candidate);
    if (candidateMarks === sourceMarks) return true;
    return coveredBySourceWords(candidateMarks, [...new Set(sourceMarks)]);
  }
  // Otherwise compare the WORDS, on ONE rule: is everything the reader
  // sees made only of THIS SOURCE's words?
  //
  //   Skip to content -> content to Skip          reordered
  //   Skip to content -> Skip content             a word deleted
  //   Settings        -> Settings Settings        repeated
  //   Settings        -> Einstellungen Settings   has a German word
  //
  // The first three are English on screen; only the fourth has a word
  // from somewhere else. Counts, order and separators are bookkeeping a
  // reader cannot see: `Refinance carry-over collateral shortfall` in
  // Hindi against `Refinance carry over collateral shortfall` in
  // English is English with a hyphen added, and `Mock USD Coin（{{s}}）`
  // is English with localized brackets — 11 such leaves were passing.
  //
  // Five revisions each caught one arrangement and left the next:
  // sequence order (Codex #1607 r11), then equal-length multisets,
  // which excused deletions (r13 — eight committed leaves, Hindi
  // `loan asset` for `the loan asset`, Korean `permission signing…`
  // for `Signing the permission…`), then sub-multisets, which still
  // excused repetition because `Settings Settings` is LONGER than its
  // source and fell out of the length shortcut (r14), then the word
  // set, which could not see punctuation dropped inside a word (r16),
  // then concatenated letters, which could not see that repeated (r17).
  // Each fix was correct about the case in front of it and blind to
  // the next arrangement of the same thing.
  //
  // SAY THE RULE PRECISELY. The loose form — "is every word an English
  // word?" — promises what this cannot deliver: `Open Settings` for
  // `Settings` is entirely English and passes, because `open` is not in
  // the source (r15). The loose form was measured before being
  // rejected: all 1,801 words of en.json as a dictionary adds 17 pairs,
  // and reading them, essentially all are correct translations sharing
  // vocabulary with English — French `Plus`, `Principal`,
  // `Type de NFT`, `1 an`, and `{{noun}} n°{{id}} — {{what}}`, the
  // value defended one round earlier AS localization. Telling those
  // from a real English rewrite needs a language identifier, not a set
  // operation; #1611 carries it.
  //
  // The asymmetry is deliberate: a candidate with a word THIS SOURCE
  // does not have is treated as a translation someone started, because
  // flagging it would invent debt — the failure `\p{L}` over `\w` was
  // fixed to avoid in round 5.
  //
  // Applied to the LETTERS, not the tokens, because the word boundaries
  // are themselves editable. `Set-tings` splits into `set` + `tings`,
  // neither a source word — so a token-level test reads two foreign
  // words where a reader sees one mangled English one (r16). Comparing
  // the concatenated letters fixed that and then failed on
  // `Set-tings Set-tings`, whose letters are `settings` twice (r17).
  //
  // So: can the candidate's letter stream be cut ENTIRELY into source
  // words? That is one question covering all of it — reordering,
  // deletion, repetition, and any punctuation moved, added or removed,
  // in any combination. Measured against the committed bundles it flags
  // exactly what the two rules it replaces flagged and nothing more.
  return coveredBySourceWords(candidateWords.join(''), sourceWords);
};

/**
 * Can `stream` be cut, end to end, into words drawn from `vocabulary`?
 *
 * A word may be used any number of times or not at all, so this covers
 * every rearrangement of the source's own words. `settingssettings`
 * decomposes into `settings` twice; `kontoeinstellungen` cannot be
 * decomposed by `{settings}` at all, so real German is untouched.
 *
 * Linear in the stream, scanning the vocabulary at each reachable
 * position — bundles are hundreds of characters and a handful of words
 * per leaf, so the cost is invisible next to reading ten JSON files.
 */
export function coveredBySourceWords(stream: string, vocabulary: string[]): boolean {
  if (stream === '' || vocabulary.length === 0) return false;
  const reachable = new Array<boolean>(stream.length + 1).fill(false);
  reachable[0] = true;
  for (let i = 0; i < stream.length; i++) {
    if (!reachable[i]) continue;
    for (const word of vocabulary) {
      if (word !== '' && stream.startsWith(word, i)) reachable[i + word.length] = true;
    }
  }
  return reachable[stream.length];
}
