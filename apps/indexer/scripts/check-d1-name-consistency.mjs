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
 *   1. Every consumer that binds the shared database binds the SAME one,
 *      on BOTH name and id. Matching on one field only is the
 *      partial-cutover signature — a name change without an id change
 *      points at the old data under a new label; an id change without a
 *      name change points at new data under the old label. The three
 *      writers may instead be collectively unbound: that is the cutover
 *      barrier, a deliberate state this check must permit because merging
 *      it is the only way to deploy it. All three, or none.
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
import {
  MUST_NOT_SHARE,
  SHARED_CONSUMERS,
  WRITERS,
  assertClassified,
} from './lib/d1-workers.mjs';
import { PREDECESSOR, SUCCESSOR } from './lib/cutover-databases.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');


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
 * `vaipakam-archive` is DELIBERATELY ABSENT from the map above, and the
 * reason is worth stating because an entry for it was added and then
 * removed (#2214, round 2).
 *
 * The retired databases that ARE listed — the mesh-alerts and lz-alerts
 * ones — were never the shared database. A command naming one of those
 * cannot split the shared data, because it was never where the shared data
 * lived. `vaipakam-archive` is the opposite case: it is the shared
 * database's immediate PREDECESSOR, holding a full copy of the same tables
 * under the same schema. A `wrangler d1 migrations apply` aimed at it today
 * succeeds, changes a database no Worker reads, and leaves both halves
 * looking correct — which is precisely the failure check 2 exists to
 * catch. Listing it would have switched that check off for the one name it
 * matters most for.
 *
 * So the exemption was not narrowed; it was removed, and the single
 * command that needed it was fixed instead
 * (`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`, §6 step 3, which
 * was still instructing operators to apply migrations to the retired
 * database). The runbooks that discuss the cutover hold the name in prose
 * and in shell variables (`"$SOURCE_DB"`), neither of which check 2 reads,
 * so nothing else required an allowance. Dated release notes are already
 * exempt via HISTORICAL below.
 *
 * If a future command genuinely must name the retired database, fix the
 * command or move the file under HISTORICAL — do not re-add the name here.
 */

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
  {
    file: 'apps/indexer/scripts/lib/cutover-databases.mjs',
    constant: 'SUCCESSOR',
    field: 'name',
    idField: 'id',
    why:
      'is the one pinned pair the cutover tools read, rather than each ' +
      'reading the shared one from a Worker binding — they have to run ' +
      'during the barrier, when no writer declares a binding at all',
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

const problems = [...assertClassified(REPO)];

// ---------------------------------------------------------------- check 1
//
// THERE ARE TWO LEGITIMATE SHAPES, and this check used to know only one.
//
// The normal shape is every consumer bound to one database. The other is
// the CUTOVER BARRIER: the three writers deploy with no `d1_databases` at
// all, so no invocation can obtain a handle while the data is copied
// (`docs/ops/D1CutoverArchiveToWarm.md`). That build reaches production by
// being merged — Workers Builds is the only deploy route these Workers
// have — so a check that refuses it refuses the barrier itself, and the
// documented procedure cannot be carried out. It did, and that is what
// this rewrite fixes.
//
// Anchoring on one privileged file is what made the second shape
// unrepresentable: strip the writers' bindings and the anchor is gone,
// and the check reports there is nothing to compare against. So the
// anchor is gone too. The invariant was never "the indexer declares it" —
// it is **every consumer that binds the shared database binds the same
// one**, which needs no privileged file and states the half-applied
// cutover directly: two distinct databases among the consumers.
//
// The writers are all-or-none. A mixed state is the barrier half-applied,
// which is worse than either shape, because the Workers still bound keep
// writing while the procedure believes everything has stopped.
const bound = [];
const unbound = [];
for (const { file, binding } of SHARED_CONSUMERS) {
  const entry = d1Entries(file).find((e) => e.binding === binding);
  if (entry?.database_name && entry?.database_id) bound.push({ file, binding, entry });
  else unbound.push({ file, binding, entry });
}

// THE BARRIER IS AN EMPTY `d1_databases`, NOT A MISSING `DB` ENTRY, and
// the two are not the same test (#2267 r22). Keying on the named entry
// let a writer keep a complete attachment under any other binding name —
// rename `DB` to `DB_OLD` on all three and the check reported the barrier
// held while every writer could still reach the database. What the
// barrier claims is that no invocation can obtain a handle, and a handle
// under a different name is still a handle.
const heldWriters = [...WRITERS].filter((f) => d1Entries(f).length === 0);
const heldForCutover = heldWriters.length === WRITERS.size;

// A writer with a d1 array that has no `DB` in it is neither bound nor
// held: it is attached to something under another name, which the
// barrier does not permit and the normal shape does not describe.
for (const file of WRITERS) {
  const entries = d1Entries(file);
  if (entries.length === 0) continue;
  if (entries.some((e) => e.binding === 'DB')) continue;
  problems.push(
    `${file}: has ${entries.length} d1 binding(s) — ` +
      `${entries.map((e) => `"${e.binding}"`).join(', ')} — but none named ` +
      `"DB".\n    That is neither shape: not the normal one, which binds ` +
      `the shared database as "DB", and not the cutover barrier, which is ` +
      `an EMPTY d1_databases. A handle under another name is still a ` +
      `handle, and this Worker can still reach a database.`,
  );
}

for (const { file, binding, entry } of unbound) {
  if (heldForCutover && WRITERS.has(file)) continue;
  problems.push(
    entry === undefined
      ? `${file}: no d1 binding named "${binding}"` +
        (WRITERS.has(file)
          ? `.\n    ${heldWriters.length} of ${WRITERS.size} writers declare ` +
            `no d1_databases at all, so this is not the cutover barrier — ` +
            `that shape needs ALL of them empty. A writer left attached ` +
            `while the others are held keeps writing through a window the ` +
            `procedure believes is closed.`
          : '')
      : `${file} (binding ${binding}) declares an incomplete d1 binding: ` +
        `name ${entry.database_name ?? '(missing)'}, id ` +
        `${entry.database_id ?? '(missing)'}. Half a binding names no database.`,
  );
}

if (bound.length === 0) {
  console.error(
    `[check-d1-name-consistency] no consumer binds the shared database — ` +
      `not even ${SHARED_CONSUMERS.map((c) => c.file).find((f) => !WRITERS.has(f))}, ` +
      `which is not part of the cutover barrier. There is nothing to check ` +
      `against.`,
  );
  process.exit(1);
}

// The shared database is whatever the bound consumers agree on. Two
// distinct pairs IS the half-applied cutover, reported below per consumer
// against the majority so the message names which file to move.
const pairs = new Map();
for (const c of bound) {
  const k = `${c.entry.database_name}\u0000${c.entry.database_id}`;
  pairs.set(k, [...(pairs.get(k) ?? []), c]);
}
const [agreed] = [...pairs.values()].sort((a, b) => b.length - a.length);
const SHARED_NAME = agreed[0].entry.database_name;
const SHARED_ID = agreed[0].entry.database_id;

if (heldForCutover) {
  console.log(
    `[check-d1-name-consistency] CUTOVER BARRIER — all ${WRITERS.size} ` +
      `writers declare no D1 binding. This tree deploys Workers that ` +
      `cannot reach ${SHARED_NAME} at all. That is a deliberate, ` +
      `temporary state (docs/ops/D1CutoverArchiveToWarm.md); if you did ` +
      `not mean to be in it, the bindings are missing.`,
  );
}

for (const { file, binding, entry } of bound) {
  const nameOk = entry.database_name === SHARED_NAME;
  const idOk = entry.database_id === SHARED_ID;
  if (nameOk && idOk) continue;
  problems.push(
    `${file} (binding ${binding}) disagrees with the other consumers:\n` +
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
//
// BOTH ENDS OF THE CUTOVER ARE FORBIDDEN, NOT JUST THE LIVE ONE
// (#2267 r39). The agreed pair is whatever the Workers bind today, which
// after the switch is the successor — so checking only that would let an
// internal ops Worker be pointed at the PREDECESSOR and pass. The
// predecessor is a full copy of the same user-facing tables, retained as
// the rollback source, so co-locating ops alert state there breaks the
// same separation for the same reason; and applying that Worker's
// migrations to it would mutate the copy the rollback depends on.
//
// Listed by id as well as name, since either identifies the database.
const FORBIDDEN_TO_OPS = [
  { name: SHARED_NAME, id: SHARED_ID, what: 'the SHARED database' },
  { name: SUCCESSOR.name, id: SUCCESSOR.id, what: 'the cutover SUCCESSOR' },
  { name: PREDECESSOR.name, id: PREDECESSOR.id, what: 'the RETAINED cutover predecessor' },
];
for (const { file, reason } of MUST_NOT_SHARE) {
  for (const entry of d1Entries(file)) {
    const hit = FORBIDDEN_TO_OPS.find(
      (f) => entry.database_name === f.name || entry.database_id === f.id,
    );
    if (hit) {
      problems.push(
        `${file} binds ${hit.what} (${hit.name}) as "${entry.binding}" — ` +
          `it must not: ${reason}.`,
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
for (const { file, constant, field, idField, why } of COMMAND_GENERATORS) {
  const src = readFileSync(join(REPO, file), 'utf8');
  const decl = src.match(
    field === undefined
      ? new RegExp(`const\\s+${constant}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`)
      : // An object constant: match the named field inside its literal.
        new RegExp(
          `const\\s+${constant}\\s*=\\s*\\{[^}]*?\\b${field}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`,
          's',
        ),
  );
  if (decl === null) {
    problems.push(
      `${file}: no \`const ${constant}${field ? ` = { ${field}: '…' }` : " = '…'"}\` ` +
        `declaration found. That ` +
        `file ${why}, so its target must be a single named constant this ` +
        `check can validate — not a literal repeated at each use.`,
    );
    continue;
  }
  if (decl[1] !== SHARED_NAME) {
    const line = src.slice(0, decl.index).split('\n').length;
    problems.push(
      `${file}:${line}: ${constant}${field ? `.${field}` : ''} is ` +
        `"${decl[1]}", but the shared ` +
        `database is "${SHARED_NAME}".\n    That file ${why} — a cutover ` +
        `that moved the bindings but not this constant would leave an ` +
        `incident restore writing to the retired database.`,
    );
  }

  // AND THE ID, where the constant carries one. Checking the name alone
  // is the half-check this guard exists to catch everywhere else: a
  // database recreated under the same name has a new id, so a constant
  // whose id was edited to any other valid uuid passed while naming the
  // right database (#2267 r24). The carry tool uses that id DIRECTLY as
  // its destination, so an unchecked one is a valid-but-wrong account
  // database being overwritten and then verified as correct.
  if (idField !== undefined) {
    const idDecl = src.match(
      new RegExp(
        `const\\s+${constant}\\s*=\\s*\\{[^}]*?\\b${idField}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`,
        's',
      ),
    );
    if (idDecl === null) {
      problems.push(
        `${file}: \`${constant}\` has no \`${idField}\` field to check. ` +
          `A name without an id is the half-check this guard exists to ` +
          `catch — a name can be reissued to a different database.`,
      );
    } else if (idDecl[1] !== SHARED_ID) {
      const line = src.slice(0, idDecl.index).split('\n').length;
      problems.push(
        `${file}:${line}: ${constant}.${idField} is "${idDecl[1]}", but ` +
          `the shared database is "${SHARED_ID}".\n    Same name, ` +
          `different database. That file ${why}.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(
    `\n[check-d1-name-consistency] ${problems.length} problem(s):\n\n` +
      problems.map((p) => `  - ${p}`).join('\n\n') +
      `\n\nEvery consumer that binds the shared database binds the SAME ` +
      `one, and\nevery \`wrangler d1\` command agrees with it. Changing ` +
      `which database the\nplatform uses is a cutover, not a ` +
      `rename: the\nbindings, the deploy scripts and the runbooks move in ` +
      `one step, and the\ndata is copied after the last writer has ` +
      `stopped.\n`,
  );
  process.exit(1);
}

console.log(
  `[check-d1-name-consistency] OK — ${SHARED_NAME} agreed by ` +
    `${bound.length} of ${SHARED_CONSUMERS.length} bindings` +
    `${heldForCutover ? ' (writers held for cutover)' : ''}, ` +
    `${commandCount} \`wrangler d1\` ` +
    `command(s) and ${COMMAND_GENERATORS.length} generator constant(s); ` +
    `${MUST_NOT_SHARE.length} Worker(s) verified separate.`,
);
