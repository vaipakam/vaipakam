#!/usr/bin/env node
/**
 * check-d1-name-consistency — the shared D1 is named in ONE place, and
 * everything that talks to it agrees.
 *
 * WHY THIS EXISTS (#1537). Renaming the shared database looks like a
 * find-and-replace, and it is not. The name appears in four Workers'
 * bindings, in `wrangler d1` commands inside three deploy scripts, and in
 * copy-paste blocks across the runbooks. A sweep that reaches the bindings
 * but not the commands produces the worst possible outcome: migrations
 * apply to one database while the Workers read another, and BOTH halves
 * look correct in isolation. Nothing fails loudly — the deploy succeeds,
 * the Worker starts, and the schema it needs is simply somewhere else.
 *
 * That is what this catches — each check aimed at a different way the
 * halves come apart:
 *
 *   1. Every consumer of the shared database agrees with the indexer's
 *      declaration on BOTH name and id. Matching on one field only is the
 *      partial-cutover signature — a name change without an id change
 *      points at the old data under a new label; an id change without a
 *      name change points at new data under the old label.
 *
 *   2. Every `wrangler d1` command in a script or runbook targets a
 *      database this repo actually knows about. A command naming a
 *      database no binding uses is either a stale rename or a cutover
 *      half-applied.
 *
 *   3. `ops/mesh-watcher` does NOT bind the shared database. That is a
 *      trust boundary (CLAUDE.md, "Cloudflare D1 schema discipline"), not
 *      a preference — its internal ops alerts must not co-locate with
 *      user-facing data.
 *
 *   4. Scripts that GENERATE `wrangler d1` commands name the shared
 *      database too. The restore script builds its command by string
 *      interpolation, so check 2 cannot see the target — every binding and
 *      every literal command could move together while an incident restore
 *      still writes to the retired database, with nothing red.
 *
 * WHAT IT DOES NOT CATCH: prose. A sentence describing the database by
 * name in a design doc is invisible here. Checks 2 and 4 cover the
 * executable and copy-pasteable surface, which is the part that moves data.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

/** The single declaration. Every other consumer is checked against this. */
const DECLARING_FILE = 'apps/indexer/wrangler.jsonc';

/**
 * Workers that bind the SHARED database. The binding name differs by
 * Worker (the ops backup Worker reads it as `DB_ARCHIVE`), so the entry
 * is identified by binding, not by position.
 */
const SHARED_CONSUMERS = [
  { file: 'apps/indexer/wrangler.jsonc', binding: 'DB' },
  { file: 'apps/keeper/wrangler.jsonc', binding: 'DB' },
  { file: 'apps/agent/wrangler.jsonc', binding: 'DB' },
  { file: 'ops/offchain-data-warm/wrangler.jsonc', binding: 'DB_ARCHIVE' },
];

/** Workers that must NOT bind the shared database, and why. */
const MUST_NOT_SHARE = [
  {
    file: 'ops/mesh-watcher/wrangler.jsonc',
    reason:
      'internal ops alerts must not co-locate with user-facing data ' +
      '(CLAUDE.md, "Cloudflare D1 schema discipline")',
  },
];

/**
 * Databases a `wrangler d1` command may target besides the shared one.
 * Each needs a reason — an unexplained entry here would defeat check 2.
 */
const OTHER_DATABASES = new Map([
  ['vaipakam-mesh-alerts-db', 'ops/mesh-watcher — separate by trust boundary'],
  [
    'vaipakam-lz-alerts-db',
    'retired ops/lz-watcher (#1440) — still named in the restore runbook',
  ],
]);

/**
 * Scripts that build a `wrangler d1` command rather than spelling one out,
 * and the constant each holds the target in. Check 2's regex reads literal
 * commands only, so without this a generated one is unverified.
 */
const COMMAND_GENERATORS = [
  {
    file: 'ops/offchain-data-warm/scripts/restore-from-archive.mjs',
    constant: 'ARCHIVE_DATABASE',
    why: 'emits the restore `wrangler d1 execute` lines by interpolation',
  },
];

/** Paths whose D1 names record history and must not be rewritten. */
const HISTORICAL = [
  'docs/OlderDocs/',
  'docs/ReleaseNotes/ReleaseNotes-', // dated files; unreleased/ is current
];

/**
 * Strip JSONC comments without mangling string contents — a `//` inside a
 * URL is not a comment. Trailing commas go too, since wrangler allows them.
 */
function parseJsonc(src, file) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch (err) {
    throw new Error(`${file}: not parseable as JSONC — ${err.message}`);
  }
}

function d1Entries(file) {
  const cfg = parseJsonc(readFileSync(join(REPO, file), 'utf8'), file);
  return cfg.d1_databases ?? [];
}

const problems = [];

// ---------------------------------------------------------------- check 1
const declared = d1Entries(DECLARING_FILE).find((e) => e.binding === 'DB');
if (!declared?.database_name || !declared?.database_id) {
  console.error(
    `[check-d1-name-consistency] ${DECLARING_FILE} has no complete "DB" ` +
      `d1 binding — that file is the single declaration of the shared ` +
      `database, so there is nothing to check against.`,
  );
  process.exit(1);
}
const SHARED_NAME = declared.database_name;
const SHARED_ID = declared.database_id;

for (const { file, binding } of SHARED_CONSUMERS) {
  const entry = d1Entries(file).find((e) => e.binding === binding);
  if (!entry) {
    problems.push(`${file}: no d1 binding named "${binding}"`);
    continue;
  }
  const nameOk = entry.database_name === SHARED_NAME;
  const idOk = entry.database_id === SHARED_ID;
  if (nameOk && idOk) continue;
  problems.push(
    `${file} (binding ${binding}) disagrees with ${DECLARING_FILE}:\n` +
      `    name: ${entry.database_name} ${nameOk ? '(ok)' : `!= ${SHARED_NAME}`}\n` +
      `    id:   ${entry.database_id} ${idOk ? '(ok)' : `!= ${SHARED_ID}`}\n` +
      `    ${
        nameOk !== idOk
          ? 'One field matches and the other does not — this is a ' +
            'half-applied cutover, the shape that silently splits ' +
            'migrations from reads.'
          : 'This Worker binds a different database entirely.'
      }`,
  );
}

// ---------------------------------------------------------------- check 3
for (const { file, reason } of MUST_NOT_SHARE) {
  for (const entry of d1Entries(file)) {
    if (entry.database_name === SHARED_NAME || entry.database_id === SHARED_ID) {
      problems.push(
        `${file} binds the SHARED database (${SHARED_NAME}) as ` +
          `"${entry.binding}" — it must not: ${reason}.`,
      );
    }
  }
}

// ---------------------------------------------------------------- check 2
// Only `vaipakam-*` targets are treated as database names: that keeps prose
// like "⚠ wrangler d1 execute failed" out, while still catching every case
// where a real database is named — which is the class that moves data.
// The optional quote group is load-bearing, not defensive: the restore
// generator shell-quotes its arguments (`shQuote` wraps in single quotes),
// so `wrangler d1 execute 'vaipakam-…'` is a shape this repo actually
// produces. Requiring the name to start immediately after whitespace
// skipped every quoted target while the check reported success.
const D1_COMMAND =
  /wrangler\s+d1\s+(?:migrations\s+)?(?:apply|list|execute|create|info|delete)\s+(['"]?)(vaipakam-[a-z0-9-]+)\1/g;

const tracked = execFileSync(
  'git',
  // `*.json` belongs here as much as the rest: package scripts are
  // executable, and `ops/mesh-watcher/package.json` runs two
  // `wrangler d1 migrations apply` commands. Omitting the extension left
  // real data-moving commands unchecked while this script claimed to cover
  // every one — an overclaim, which is worse than a narrower promise.
  [
    'ls-files',
    '-z',
    '*.sh',
    '*.md',
    '*.mjs',
    '*.js',
    '*.ts',
    '*.json',
    '*.jsonc',
    '*.sql',
  ],
  { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
  .split('\0')
  .filter(Boolean)
  .filter((f) => !HISTORICAL.some((h) => f.startsWith(h)));

let commandCount = 0;
for (const file of tracked) {
  const src = readFileSync(join(REPO, file), 'utf8');
  if (!src.includes('wrangler')) continue;
  for (const m of src.matchAll(D1_COMMAND)) {
    commandCount += 1;
    const target = m[2];
    if (target === SHARED_NAME || OTHER_DATABASES.has(target)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(
      `${file}:${line}: \`wrangler d1\` targets "${target}", which is ` +
        `neither the shared database (${SHARED_NAME}) nor a known ` +
        `separate one.\n    ${
          target.startsWith('vaipakam-')
            ? 'If the shared database is being renamed, the bindings and ' +
              'every command must move together — a command pointing at ' +
              'the new name while the bindings still hold the old one ' +
              'applies migrations to a database nothing reads.'
            : ''
        }`,
    );
  }
}

// ---------------------------------------------------------------- check 4
for (const { file, constant, why } of COMMAND_GENERATORS) {
  const src = readFileSync(join(REPO, file), 'utf8');
  const decl = src.match(
    new RegExp(`const\\s+${constant}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`),
  );
  if (decl === null) {
    problems.push(
      `${file}: no \`const ${constant} = '…'\` declaration found. That ` +
        `file ${why}, so its target must be a single named constant this ` +
        `check can validate — not a literal repeated at each use.`,
    );
    continue;
  }
  if (decl[1] !== SHARED_NAME) {
    const line = src.slice(0, decl.index).split('\n').length;
    problems.push(
      `${file}:${line}: ${constant} is "${decl[1]}", but the shared ` +
        `database is "${SHARED_NAME}".\n    That file ${why} — a cutover ` +
        `that moved the bindings but not this constant would leave an ` +
        `incident restore writing to the retired database.`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `\n[check-d1-name-consistency] ${problems.length} problem(s):\n\n` +
      problems.map((p) => `  - ${p}`).join('\n\n') +
      `\n\nThe shared database is declared once, in ${DECLARING_FILE}. ` +
      `Every\nbinding and every \`wrangler d1\` command must agree with ` +
      `it. Changing\nwhich database the platform uses is a cutover, not a ` +
      `rename: the\nbindings, the deploy scripts and the runbooks move in ` +
      `one step, and the\ndata is copied after the last writer has ` +
      `stopped.\n`,
  );
  process.exit(1);
}

console.log(
  `[check-d1-name-consistency] OK — ${SHARED_NAME} agreed by ` +
    `${SHARED_CONSUMERS.length} bindings, ${commandCount} \`wrangler d1\` ` +
    `command(s) and ${COMMAND_GENERATORS.length} generator constant(s); ` +
    `${MUST_NOT_SHARE.length} Worker(s) verified separate.`,
);
