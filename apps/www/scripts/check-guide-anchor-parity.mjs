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
 */
const KNOWN_GAPS = {
  // The English guide gained a cross-chain tier-caching section that
  // was never translated. Real content, not stale — the `buy-vpfi.`
  // prefix is legacy naming from before the #687-A excision, but the
  // section itself documents the current CCIP tier push.
  'Advanced:buy-vpfi.cross-chain-tier': [
    'ar', 'de', 'es', 'fr', 'hi', 'ja', 'ko', 'ta', 'zh',
  ],
  // Korean Basic carries an anchor no other edition has, including the
  // English source it was translated from.
  'Basic:rewards.withdraw-staked': ['ko'],
};

const ANCHOR_RE = /<a id="([^"]+)"><\/a>/g;

const anchorsIn = (file) => {
  const raw = fs.readFileSync(path.join(GUIDE_DIR, file), 'utf8');
  return new Set([...raw.matchAll(ANCHOR_RE)].map((m) => m[1]));
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

for (const [doc, locales] of byDoc) {
  const englishFile = locales.get('en');
  if (!englishFile) {
    problems.push(`${doc}: no English edition to compare against`);
    continue;
  }
  const english = anchorsIn(englishFile);
  for (const [locale, file] of locales) {
    if (locale === 'en') continue;
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
  `[check-guide-anchor-parity] OK — anchor sets match across every edition of: ${docs}`,
);
