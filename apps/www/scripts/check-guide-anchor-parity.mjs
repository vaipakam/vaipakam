#!/usr/bin/env node
/**
 * Guardrail (#1561): every localized edition of a long-form guide must
 * carry the SAME hand-authored `<a id="…">` anchors as its English
 * original.
 *
 *     node scripts/check-guide-anchor-parity.mjs
 *
 * Those anchors are the stable, locale-INDEPENDENT deep-link targets.
 * The other id scheme these pages carry — the slug derived from a
 * heading's own words — necessarily changes when the heading is
 * translated, which is why anything linking in from outside uses the
 * anchor instead. The connected app's stuck-token recovery declaration
 * is the load-bearing case: it asks the user to attest they have read a
 * named guide section and links them to it, unprefixed, so the reader
 * lands on their own language's edition.
 *
 * That only works if the anchor EXISTS in that edition. When it
 * doesn't, the link still resolves — the marketing site serves its SPA
 * shell for anything — and quietly drops the reader at the top of a
 * two-thousand-line document. Nothing about the failure is visible to
 * the person who wrote the link, and nothing about it is visible to a
 * reviewer reading either file on its own; it only shows up when you
 * compare the two, which is what this does.
 *
 * KNOWN_GAPS records the divergences that already exist, per
 * (document, anchor, locale). Shrink it; a new one is a failure. The
 * rule is deliberately symmetric — a translation carrying an anchor the
 * English lacks is also flagged, since it means one edition has a
 * section the source doesn't and the two have drifted apart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUIDE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'content',
  'userguide',
);

/**
 * Divergences that predate this check, tracked as #1561 follow-up.
 * Keyed `<doc>:<anchor>`, valued by the locales the divergence affects.
 *
 * EMPTY as of the #1561 follow-up — both original entries are closed,
 * not re-scoped: `Advanced:buy-vpfi.cross-chain-tier` was translated
 * into all nine editions, and `Basic:rewards.withdraw-staked` was
 * removed from Korean (it documented a withdraw control on the Rewards
 * page that does not exist there; the same information is already in
 * that edition's `buy-vpfi.unstake`, where the control actually lives).
 * Anchor parity therefore holds with nothing excused — a new entry here
 * is a regression, and the check below fails on any stale one.
 */
const KNOWN_GAPS = {};

const ANCHOR_RE = /<a id="([^"]+)"><\/a>/g;

const readGuide = (file) => fs.readFileSync(path.join(GUIDE_DIR, file), 'utf8');

const anchorsIn = (file) =>
  new Set([...readGuide(file).matchAll(ANCHOR_RE)].map((m) => m[1]));

/**
 * Chapter COUNT per edition.
 *
 * Anchors are not the whole structure: a `## ` chapter heading carries
 * no `<a id>` of its own, so an edition can be missing an ENTIRE
 * chapter while its anchor set still matches — every anchor that
 * chapter would have contributed is missing from both sides of the
 * comparison at once, and the symmetric check above sees nothing.
 *
 * That is not hypothetical: it is how "How VPFI Discounts Work" went
 * untranslated in all nine editions, and "How Liquidation Actually
 * Works" + "Allowances" in two, without this guard ever objecting
 * (#1561 follow-up).
 *
 * Counting is deliberately shallow — comparing heading TEXT would
 * flag every correctly-translated title. The count answers the only
 * question anchors cannot: does this edition have as many chapters as
 * its source?
 *
 * "Chapter" is a heading the FILE declares at column zero — matching
 * how the guide's own extractor, `extractToc` in
 * `src/pages/UserGuide.tsx`, recognises one: `/^##\s+(.+)$/` per line.
 * (Note the file: the guide pages use their OWN extractor, not the
 * `extractMarkdownToc` in `src/lib/markdownToc.tsx` that Overview and
 * Whitepaper use. The two behave differently, and checking the wrong
 * one is how this comment was previously wrong — Codex #1594 r3.)
 * A heading that is not at column zero is not a chapter here, because
 * it is not one there either.
 *
 * That distinction is load-bearing here. `Advanced.hi.md` and
 * `Advanced.ja.md` carry two two-space-indented `##` lines each, which
 * a CommonMark-shaped `^ {0,3}## ` pattern counts as chapters — but
 * those two spaces CONTINUE the preceding list item, so they parse as
 * `root > list > listItem > heading` rather than as top-level
 * chapters, and the site's own table of contents omits them. Counting
 * them would record those editions as chapter-equivalent while two of
 * their chapters are unreachable from the sidebar (Codex #1594 r2,
 * correcting r1).
 *
 * Fenced blocks are skipped: a `## Example` inside a code sample is
 * illustration, not structure. None exists in the corpus today, but
 * the failure mode — a phantom chapter masking a real missing one — is
 * silent, so the guard is worth its few lines. This is deliberately
 * STRICTER than `extractToc`, which does not track fences at all and
 * would list such a line in the sidebar; that is a renderer defect,
 * recorded in #1599 rather than mirrored here.
 *
 * Two places where the SIDEBAR shows fewer chapters than the FILE
 * declares, and why this counts the file anyway:
 *
 *  - `extractToc` ends with `sections.filter((s) => s.items.length > 0)`
 *    and only registers an `###` that carries a non-role `<a id>`
 *    above it. So a chapter whose subsections are unanchored is
 *    dropped from the sidebar entirely. That is live today, in
 *    English: `## How VPFI Discounts Work` renders in the body of
 *    `/help/advanced` but appears nowhere in its contents list —
 *    confirmed on production, and filed as #1599.
 *  - The same filter means a translation could gain an unanchored
 *    chapter and close its recorded gap here while remaining
 *    unreachable in its own sidebar.
 *
 * Counting the sidebar instead would make BOTH of those invisible:
 * `en` and `de` both yield 18 sidebar sections, so the chapter German
 * genuinely does not have would stop being a finding. The file is the
 * honest denominator; the sidebar shortfall is its own bug with its
 * own issue (Codex #1594 r3, which I first refuted in error).
 *
 * KNOWN LIMIT: this is a COUNT, so an edition that omits one anchorless
 * chapter and adds a different anchorless one nets to zero and passes
 * here, while the anchor comparison — seeing no anchors either side —
 * also stays silent. Chapters carrying anchors are covered, because the
 * anchor check catches those directly. Closing the residue needs a
 * locale-independent identifier on every chapter heading, i.e. giving
 * each `##` its own `<a id>`; that is a content change across the whole
 * corpus and is tracked in #1597 rather than half-done here.
 */
const chapterCount = (file) => {
  // CommonMark: a fence closes only on the SAME character, at least as
  // long as the opener. A plain toggle mis-reads a nested example — an
  // embedded ``` inside a ```` block is content, but toggling on it
  // would reopen the document and let a following `## Example` count as
  // a chapter, which is exactly the phantom that can offset a genuinely
  // missing one (Codex #1594 r4).
  let open = null; // { char, len }
  let n = 0;
  for (const line of readGuide(file).split('\n')) {
    // 0-3 leading spaces, never `\s*`: at four spaces (or a tab) the
    // renderer reads the line as INDENTED CODE, not a fence, so treating
    // it as an opener would swallow every real chapter after it until a
    // compatible delimiter or EOF (Codex #1594 r6).
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const char = fence[1][0];
      const len = fence[1].length;
      const info = fence[2];
      if (open === null) {
        open = { char, len };
      } else if (char === open.char && len >= open.len && info.trim() === '') {
        // CommonMark: a CLOSING fence carries no info string. Without
        // this, a ```js sample inside an outer ```md block reads as a
        // closer — the document reopens, a `##` in the sample counts,
        // and the real closer then hides the chapters after it. Two
        // errors in opposite directions, which can cancel and pass
        // (Codex #1594 r5).
        open = null;
      }
      continue;
    }
    // `\s+`, not a literal space: `extractToc` matches `/^##\s+(.+)$/`,
    // so `##\tTitle` IS a chapter on the site. A narrower pattern here
    // would let a translation drop that chapter without moving the
    // count — the guard silently passing the case it exists for
    // (Codex #1594 r5).
    if (open === null && /^##\s+.+$/.test(line)) n += 1;
  }
  return n;
};

/**
 * Editions known to be short of the English chapter list, per
 * `<doc>:<locale>` → the number of chapters they still lack.
 *
 * Translating these is tracked as #1593: one English chapter of
 * ~10.7k characters, which is ~96k of translated output across the
 * nine — and for `hi`/`ja` the extra two may need no translator at
 * all, since the prose is already there and only the indentation
 * hides it. Recorded here so the count cannot quietly grow in the
 * meantime. Shrink it; a new shortfall, or one larger than recorded,
 * is a failure.
 */
const KNOWN_CHAPTER_GAPS = {
  'Advanced:ar': 1,
  'Advanced:de': 1,
  'Advanced:es': 1,
  'Advanced:fr': 1,
  // hi/ja additionally lack `How Liquidation Actually Works` and
  // `Allowances` as CHAPTERS: the text is present but indented into
  // the preceding list item, so the sidebar never offers it.
  'Advanced:hi': 3,
  'Advanced:ja': 3,
  'Advanced:ko': 1,
  'Advanced:ta': 1,
  'Advanced:zh': 1,
};

/** `Advanced.en.md` → `{ doc: 'Advanced', locale: 'en' }` */
const parse = (file) => {
  const m = /^(.+)\.([a-z]{2})\.md$/.exec(file);
  return m ? { doc: m[1], locale: m[2] } : null;
};

const files = fs.readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md'));
const byDoc = new Map();
for (const file of files) {
  const parsed = parse(file);
  if (!parsed) continue;
  if (!byDoc.has(parsed.doc)) byDoc.set(parsed.doc, new Map());
  byDoc.get(parsed.doc).set(parsed.locale, file);
}

const isKnown = (doc, anchor, locale) =>
  (KNOWN_GAPS[`${doc}:${anchor}`] ?? []).includes(locale);

/**
 * Problems carry their CLASS, not just their text, so the closing
 * advice can name the right repair. A chapter shortfall told the reader
 * to "add the missing anchor … rather than widening KNOWN_GAPS" — an
 * anchor does not restore a missing `##`, and the relevant baseline is
 * KNOWN_CHAPTER_GAPS, so an otherwise actionable diagnostic ended by
 * sending them at the wrong file (Codex #1594 r6).
 */
const problems = [];
const report = (kind, text) => problems.push({ kind, text });
const seenGaps = new Set();
const seenChapterGaps = new Set();

for (const [doc, locales] of byDoc) {
  const englishFile = locales.get('en');
  if (!englishFile) {
    report('setup', `${doc}: no English edition to compare against`);
    continue;
  }
  const english = anchorsIn(englishFile);
  const englishChapters = chapterCount(englishFile);
  for (const [locale, file] of locales) {
    if (locale === 'en') continue;

    // Chapter-count parity, which the anchor comparison cannot see.
    const short = englishChapters - chapterCount(file);
    const allowed = KNOWN_CHAPTER_GAPS[`${doc}:${locale}`] ?? 0;
    if (short < 0) {
      // An EXTRA chapter is its own report, handled first: falling
      // through to the stale-baseline branch would print
      // `records 0 missing chapter(s) but only -1 are — remove it`,
      // which is both nonsense and a second thing to chase for one
      // change (Codex #1594 r2).
      report(
        'chapter',
        `${file}: has ${chapterCount(file)} chapters, ${englishFile} has ` +
          `${englishChapters} — the translation carries a section the ` +
          'source does not',
      );
      if (allowed > 0) seenChapterGaps.add(`${doc}:${locale}`);
    } else if (short > allowed) {
      report(
        'chapter',
        `${file}: has ${chapterCount(file)} chapters, ${englishFile} has ` +
          `${englishChapters}${allowed ? ` (${allowed} recorded as a known gap)` : ''}` +
          ' — a whole chapter can go missing without changing the anchor set',
      );
      // The baseline is not stale, it is EXCEEDED — already reported
      // above. Without this the sweep below would also say "no longer
      // diverges — remove it", which is both wrong and a second thing
      // to chase for one change (Codex #1594 r3).
      if (allowed > 0) seenChapterGaps.add(`${doc}:${locale}`);
    } else if (short < allowed) {
      report(
        'chapter',
        `KNOWN_CHAPTER_GAPS ${doc}:${locale} records ${allowed} missing ` +
          `chapter(s) but only ${short} are — ${short === 0 ? 'remove it' : 'lower it'}`,
      );
      // Mark it seen even though it is wrong: the stale-entry sweep
      // below reports an entry nothing matched, and an over-record has
      // already been reported here. Two messages for one problem sends
      // the reader looking for a second thing to fix.
      seenChapterGaps.add(`${doc}:${locale}`);
    } else if (allowed > 0) {
      seenChapterGaps.add(`${doc}:${locale}`);
    }
    const theirs = anchorsIn(file);
    for (const anchor of english) {
      if (theirs.has(anchor)) continue;
      if (isKnown(doc, anchor, locale)) {
        seenGaps.add(`${doc}:${anchor}:${locale}`);
        continue;
      }
      report('anchor', `${file}: missing anchor #${anchor} (present in ${englishFile})`);
    }
    for (const anchor of theirs) {
      if (english.has(anchor)) continue;
      if (isKnown(doc, anchor, locale)) {
        seenGaps.add(`${doc}:${anchor}:${locale}`);
        continue;
      }
      report('anchor', `${file}: has anchor #${anchor} the English edition doesn't`);
    }
  }
}

// A recorded gap that has since been closed must leave the list, or the
// exemption silently re-opens that anchor to regression.
for (const [key, localesForGap] of Object.entries(KNOWN_GAPS)) {
  for (const locale of localesForGap) {
    if (!seenGaps.has(`${key}:${locale}`)) {
      report('anchor', `KNOWN_GAPS entry ${key}:${locale} no longer diverges — remove it`);
    }
  }
}

// Same rule for the chapter list: a closed gap must leave, or the
// exemption silently re-opens that edition to a fresh shortfall.
for (const key of Object.keys(KNOWN_CHAPTER_GAPS)) {
  if (!seenChapterGaps.has(key)) {
    report(
      'chapter',
      `KNOWN_CHAPTER_GAPS entry ${key} no longer diverges — remove it`,
    );
  }
}

if (problems.length > 0) {
  console.error('[check-guide-anchor-parity] FAILED\n');
  for (const problem of problems) console.error(`  ${problem.text}`);
  const kinds = new Set(problems.map((p) => p.kind));
  if (kinds.has('anchor')) {
    console.error(
      '\nA deep link naming a section must reach that section in every language\n' +
        'the guide ships in. Add the missing anchor (and its section) to the\n' +
        'translated file rather than widening KNOWN_GAPS.',
    );
  }
  if (kinds.has('chapter')) {
    console.error(
      '\nA chapter can go missing without changing the anchor set, which is why\n' +
        'the counts are compared separately. Add the chapter itself to the\n' +
        'translated file — an anchor will not restore it — and correct\n' +
        'KNOWN_CHAPTER_GAPS (not KNOWN_GAPS) rather than widening it.',
    );
  }
  process.exit(1);
}

const docs = [...byDoc.keys()].join(', ');
const recordedGaps = Object.keys(KNOWN_CHAPTER_GAPS).length;
// "match too" alongside "9 edition(s) short" is a contradiction, and the
// half a CI reader remembers is the reassuring one. The counts do NOT
// match while an allowance stands; what holds is that the recorded
// divergences are UNCHANGED (Codex #1594 r6).
console.log(
  `[check-guide-anchor-parity] OK — anchor sets match across every edition` +
    ` of: ${docs}; ` +
    (recordedGaps
      ? `chapter counts are unchanged from their recorded gaps` +
        ` (${recordedGaps} edition(s) still short — see KNOWN_CHAPTER_GAPS)`
      : 'chapter counts match too, with nothing recorded as a known gap'),
);
