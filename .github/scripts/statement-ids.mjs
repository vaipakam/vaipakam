#!/usr/bin/env node
// Which canonical statements a pull request says it implements.
//
// The canonical specification (docs/CanonicalSpec/) gives every statement a
// permanent id such as VLT-001. A pull request that changes behaviour names
// the statements it implements in its description's "## Statements"
// section (only that section counts), or says there plainly that it
// changes no behaviour, or that no canonical section covers what it changes
// yet (CanonicalSpecDesign section 15). The docs-drift workflow calls this
// script with the merged pull request's description and warns when none of
// the three is there, or when an id names no statement in the folder.
//
// Usage:
//   node .github/scripts/statement-ids.mjs --body <file> [--folder <dir>]
//   node .github/scripts/statement-ids.mjs --selftest
//
// Prints one JSON object:
//   { ids, unknown, reserved, noBehaviourChange, notCovered, notCoveredDomains,
//     verdict }
// verdict is "ids", "no-behaviour-change", "not-covered", "not-covered-unnamed"
// (the not-covered answer names no domain the author looked in) or "missing".
// Exit code is 0 in every case: the workflow decides what to warn about.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A statement id: a three-letter domain code, a dash, three digits.
const ID = /\b([A-Z]{3})-(\d{3})\b/g;
// Ids 900 to 999 of a domain are reserved. Public text never carries one, so
// a description that does is reported (by count only: the merge check never
// repeats the id) and the id does not count as naming a statement.
const RESERVED_FROM = 900;
// A statement heading in a domain file: "### VLT-001 · rule".
const HEADING = /^#{2,4}\s+([A-Z]{3}-\d{3})\b/gm;
const NO_CHANGE = /\bno behaviou?r change\b/i;
const NOT_COVERED = /\bno canonical section covers\b[^\n]*/i;
// The domain codes of CanonicalSpecDesign section 3.5; keep this list equal
// to that table.
// The not-covered answer names the domain the author looked in, so a reviewer
// can check that no section of it covers the change.
const DOMAINS = [
  'PLT', 'VLT', 'AUT', 'SCR', 'PRC', 'OFR', 'OPN', 'LON', 'FCL', 'CLM',
  'EXT', 'POS', 'RNT', 'MKT', 'FEE', 'VPF', 'RWD', 'XCH', 'KPR', 'DPL',
  'IDX', 'KOP', 'APP', 'WEB', 'NTF',
];
const DOMAIN = new RegExp(`\\b(${DOMAINS.join('|')})\\b`, 'g');

/** The ids the folder states, read from its statement headings. */
export function folderIds(folder) {
  const ids = new Set();
  if (!folder) return ids;
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return ids; // no folder: no ids
  }
  // Top-level files only: the record and the mistake lists, in
  // subdirectories, cite ids; they do not state them.
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    for (const m of readFileSync(join(folder, entry.name), 'utf8').matchAll(HEADING)) {
      ids.add(m[1]);
    }
  }
  return ids;
}

/**
 * Strip HTML comments, so the template's own example ids never count. An
 * unclosed comment hides the rest of the text, as it does when rendered, and
 * the strip repeats until nothing changes, so a comment rebuilt by removing
 * another (`<!<!-- x -->-- y -->`) goes too.
 */
export function visible(body) {
  let text = String(body ?? '');
  for (;;) {
    const next = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    if (next === text) return text;
    text = next;
  }
}

/**
 * The description's "## Statements" section, up to the next heading of the
 * same or a higher level. Only this section declares what a change
 * implements; an id mentioned elsewhere (a link to an earlier pull request,
 * say) declares nothing. No section reads as empty.
 */
export function statementsSection(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,2}\s+Statements\s*$/i.test(l.trim()));
  if (start < 0) return '';
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line.trim())) break;
    out.push(line);
  }
  return out.join('\n');
}

const idsIn = (text) =>
  [...new Set([...String(text).matchAll(ID)].map((m) => `${m[1]}-${m[2]}`))].sort();
const isReserved = (id) => Number(id.slice(4)) >= RESERVED_FROM;

export function evaluate(body, known) {
  // A reserved id anywhere in the raw description counts, comments included:
  // the source of a description is public even where it does not render.
  const reserved = idsIn(body).filter(isReserved);
  const text = statementsSection(visible(body));
  const named = idsIn(text).filter((id) => !isReserved(id));
  const unknown = named.filter((id) => !known.has(id));
  const noBehaviourChange = NO_CHANGE.test(text);
  const notCoveredLine = text.match(NOT_COVERED)?.[0];
  const notCovered = notCoveredLine !== undefined;
  // The domain is named on the same line as the answer.
  const notCoveredDomains = notCovered
    ? [...new Set([...notCoveredLine.matchAll(DOMAIN)].map((m) => m[1]))].sort()
    : [];
  let verdict = 'missing';
  if (named.length > 0) verdict = 'ids';
  else if (noBehaviourChange) verdict = 'no-behaviour-change';
  else if (notCovered) verdict = notCoveredDomains.length ? 'not-covered' : 'not-covered-unnamed';
  return { ids: named, unknown, reserved: reserved.length, noBehaviourChange, notCovered, notCoveredDomains, verdict };
}

function selftest() {
  const known = new Set(['VLT-001', 'VLT-043', 'PRC-010']);
  // A reserved id made at run time, in a domain with no statements, so this
  // file carries no reserved id as text.
  const res = `XCH-${RESERVED_FROM + 99}`;
  const cases = [
    ['names two known ids', 'Implements VLT-001 and VLT-043.', 'ids', []],
    ['an unknown id is reported', 'Implements VLT-002.', 'ids', ['VLT-002']],
    ['a reserved id names nothing', `Implements ${res}.`, 'missing', [], 1],
    ['a reserved id beside a known one', `Implements VLT-001 and ${res}.`, 'ids', [], 1],
    ['no behaviour change', 'Refactor only: no behaviour change.', 'no-behaviour-change', []],
    ['american spelling', 'No behavior change.', 'no-behaviour-change', []],
    ['not covered, domain named', 'No canonical section covers this change (looked in OFR).', 'not-covered', []],
    ['not covered, no domain', 'No canonical section covers this yet.', 'not-covered-unnamed', []],
    ['domain on another line does not count', 'No canonical section covers this.\nTouches OFR code.', 'not-covered-unnamed', []],
    ['unknown code is not a domain', 'No canonical section covers this (ABC).', 'not-covered-unnamed', []],
    ['nothing stated', 'Fixes the thing.', 'missing', []],
    ['template comment ignored', '<!-- e.g. VLT-001 -->\nFixes the thing.', 'missing', []],
    ['empty body', '', 'missing', []],
    ['lowercase is not an id', 'vlt-001', 'missing', []],
    ['an unclosed comment hides the rest', 'Changes matching. <!-- VLT-001', 'missing', []],
    ['a nested comment is stripped whole', '<!<!-- a -->-- VLT-001 -->', 'missing', []],
    ['an id outside the section declares nothing', '## What\n\nUnlike VLT-001, this changes matching.\n\n## Statements\n\n## Verification\n', 'missing', []],
    ['no Statements section reads as empty', '## What\n\nImplements VLT-001.\n', 'missing', []],
    ['the section ends at the next heading', '## Statements\n\nNo behaviour change.\n\n## Why\n\nVLT-001 matters.\n', 'no-behaviour-change', []],
    ['a reserved id outside the section still counts', `## What\n\nSee ${res}.\n\n## Statements\n\nVLT-001\n`, 'ids', [], 1],
    ['a reserved id in a comment still counts', `<!-- ${res} -->\n## Statements\n\nVLT-001\n`, 'ids', [], 1],
  ];
  let failed = 0;
  // Each case body is the Statements section unless it brings its own headings.
  const wrap = (b) => (/^## /m.test(b) ? b : `## What\n\nSomething.\n\n## Statements\n\n${b}\n`);
  for (const [name, body, verdict, unknown, reserved = 0] of cases) {
    const r = evaluate(wrap(body), known);
    const ok =
      r.verdict === verdict &&
      JSON.stringify(r.unknown) === JSON.stringify(unknown) &&
      r.reserved === reserved;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${JSON.stringify(r)}`}`);
  }
  console.log(`${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bodyPath = arg('--body');
  let body = '';
  if (bodyPath) {
    try {
      body = readFileSync(bodyPath, 'utf8');
    } catch {
      body = ''; // an unreadable description reads as empty
    }
  }
  const folder = arg('--folder') ?? 'docs/CanonicalSpec';
  console.log(JSON.stringify(evaluate(body, folderIds(folder))));
}

main(process.argv.slice(2));
