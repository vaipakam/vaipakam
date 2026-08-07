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
 * The pattern allows up to three leading spaces because CommonMark
 * does, and the renderer follows CommonMark: `Advanced.hi.md` and
 * `Advanced.ja.md` both carry two-space-indented `##` headings that
 * render as real chapters. Anchoring at column zero counted those
 * editions two chapters short and would have recorded a gap that does
 * not exist — then failed the moment someone tidied the indentation
 * (Codex #1594 r1).
 */
const CHAPTER_RE = /^ {0,3}## .+$/gm;
const chapterCount = (file) => (readGuide(file).match(CHAPTER_RE) ?? []).length;

/**
 * Editions known to be short of the English chapter list, per
 * `<doc>:<locale>` → the number of chapters they still lack.
 *
 * Translating these is tracked as #1593 (whole chapters, ~19k
 * characters of technical prose); recorded here so the count cannot
 * quietly grow in the meantime. Shrink it; a new shortfall, or one
 * larger than recorded, is a failure.
 */
const KNOWN_CHAPTER_GAPS = {
  'Advanced:ar': 1,
  'Advanced:de': 1,
  'Advanced:es': 1,
  'Advanced:fr': 1,
  'Advanced:hi': 1,
  'Advanced:ja': 1,
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

const problems = [];
const seenGaps = new Set();
const seenChapterGaps = new Set();

for (const [doc, locales] of byDoc) {
  const englishFile = locales.get('en');
  if (!englishFile) {
    problems.push(`${doc}: no English edition to compare against`);
    continue;
  }
  const english = anchorsIn(englishFile);
  const englishChapters = chapterCount(englishFile);
  for (const [locale, file] of locales) {
    if (locale === 'en') continue;

    // Chapter-count parity, which the anchor comparison cannot see.
    const short = englishChapters - chapterCount(file);
    const allowed = KNOWN_CHAPTER_GAPS[`${doc}:${locale}`] ?? 0;
    if (short > allowed) {
      problems.push(
        `${file}: has ${chapterCount(file)} chapters, ${englishFile} has ` +
          `${englishChapters}${allowed ? ` (${allowed} recorded as a known gap)` : ''}` +
          ' — a whole chapter can go missing without changing the anchor set',
      );
    } else if (short < allowed) {
      problems.push(
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
    if (short < 0) {
      problems.push(
        `${file}: has MORE chapters than ${englishFile} — the translation ` +
          'carries a section the source does not',
      );
    }

    const theirs = anchorsIn(file);
    for (const anchor of english) {
      if (theirs.has(anchor)) continue;
      if (isKnown(doc, anchor, locale)) {
        seenGaps.add(`${doc}:${anchor}:${locale}`);
        continue;
      }
      problems.push(`${file}: missing anchor #${anchor} (present in ${englishFile})`);
    }
    for (const anchor of theirs) {
      if (english.has(anchor)) continue;
      if (isKnown(doc, anchor, locale)) {
        seenGaps.add(`${doc}:${anchor}:${locale}`);
        continue;
      }
      problems.push(`${file}: has anchor #${anchor} the English edition doesn't`);
    }
  }
}

// A recorded gap that has since been closed must leave the list, or the
// exemption silently re-opens that anchor to regression.
for (const [key, localesForGap] of Object.entries(KNOWN_GAPS)) {
  for (const locale of localesForGap) {
    if (!seenGaps.has(`${key}:${locale}`)) {
      problems.push(`KNOWN_GAPS entry ${key}:${locale} no longer diverges — remove it`);
    }
  }
}

// Same rule for the chapter list: a closed gap must leave, or the
// exemption silently re-opens that edition to a fresh shortfall.
for (const key of Object.keys(KNOWN_CHAPTER_GAPS)) {
  if (!seenChapterGaps.has(key)) {
    problems.push(
      `KNOWN_CHAPTER_GAPS entry ${key} no longer diverges — remove it`,
    );
  }
}

if (problems.length > 0) {
  console.error('[check-guide-anchor-parity] FAILED\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nA deep link naming a section must reach that section in every language\n' +
      'the guide ships in. Add the missing anchor (and its section) to the\n' +
      'translated file rather than widening KNOWN_GAPS.',
  );
  process.exit(1);
}

const docs = [...byDoc.keys()].join(', ');
console.log(
  `[check-guide-anchor-parity] OK — anchor sets match across every edition` +
    ` of: ${docs}; chapter counts match too` +
    (Object.keys(KNOWN_CHAPTER_GAPS).length
      ? ` (${Object.keys(KNOWN_CHAPTER_GAPS).length} edition(s) short by a` +
        ' recorded, unchanged amount)'
      : ''),
);
