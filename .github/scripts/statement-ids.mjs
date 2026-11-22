#!/usr/bin/env node
// Which canonical statements a pull request says it implements.
//
// The canonical specification (docs/CanonicalSpec/) gives every statement a
// permanent id such as VLT-001. A pull request that changes behaviour names
// the statements it implements in its description, or says plainly that it
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
//   { ids, unknown, held, noBehaviourChange, notCovered, verdict }
// verdict is "ids", "no-behaviour-change", "not-covered" or "missing".
// Exit code is 0 in every case: the workflow decides what to warn about.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A statement id: a three-letter domain code, a dash, three digits.
const ID = /\b([A-Z]{3})-(\d{3})\b/g;
// Ids 900 to 999 of a domain are statements held outside the public folder
// (CanonicalSpec README, "Some statements are held outside this folder").
const HELD_FROM = 900;
// A statement heading in a domain file: "### VLT-001 · rule".
const HEADING = /^#{2,4}\s+([A-Z]{3}-\d{3})\b/gm;
const NO_CHANGE = /\bno behaviou?r change\b/i;
const NOT_COVERED = /\bno canonical section covers\b/i;

/** The ids the folder states, read from its statement headings. */
export function folderIds(folder) {
  const ids = new Set();
  if (!folder || !existsSync(folder)) return ids;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        // The record and the mistake lists cite ids; they do not state them.
        continue;
      }
      if (!name.endsWith('.md')) continue;
      for (const m of readFileSync(path, 'utf8').matchAll(HEADING)) ids.add(m[1]);
    }
  };
  walk(folder);
  return ids;
}

/** Strip HTML comments, so the template's own example ids never count. */
function visible(body) {
  return String(body ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

export function evaluate(body, known) {
  const text = visible(body);
  const ids = [...new Set([...text.matchAll(ID)].map((m) => `${m[1]}-${m[2]}`))].sort();
  const held = ids.filter((id) => Number(id.slice(4)) >= HELD_FROM);
  const unknown = ids.filter((id) => !held.includes(id) && !known.has(id));
  const noBehaviourChange = NO_CHANGE.test(text);
  const notCovered = NOT_COVERED.test(text);
  let verdict = 'missing';
  if (ids.length > 0) verdict = 'ids';
  else if (noBehaviourChange) verdict = 'no-behaviour-change';
  else if (notCovered) verdict = 'not-covered';
  return { ids, unknown, held, noBehaviourChange, notCovered, verdict };
}

function selftest() {
  const known = new Set(['VLT-001', 'VLT-043', 'PRC-010']);
  const cases = [
    ['names two known ids', 'Implements VLT-001 and VLT-043.', 'ids', []],
    ['an unknown id is reported', 'Implements VLT-002.', 'ids', ['VLT-002']],
    ['a held id is not unknown', 'Implements VLT-901.', 'ids', []],
    ['no behaviour change', 'Refactor only: no behaviour change.', 'no-behaviour-change', []],
    ['american spelling', 'No behavior change.', 'no-behaviour-change', []],
    ['not covered yet', 'No canonical section covers this yet.', 'not-covered', []],
    ['nothing stated', 'Fixes the thing.', 'missing', []],
    ['template comment ignored', '<!-- e.g. VLT-001 -->\nFixes the thing.', 'missing', []],
    ['empty body', '', 'missing', []],
    ['lowercase is not an id', 'vlt-001', 'missing', []],
  ];
  let failed = 0;
  for (const [name, body, verdict, unknown] of cases) {
    const r = evaluate(body, known);
    const ok = r.verdict === verdict && JSON.stringify(r.unknown) === JSON.stringify(unknown);
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
  const body = bodyPath && existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : '';
  const folder = arg('--folder') ?? 'docs/CanonicalSpec';
  console.log(JSON.stringify(evaluate(body, folderIds(folder))));
}

main(process.argv.slice(2));
