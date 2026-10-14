/**
 * WHICH WORKERS TOUCH D1, AND IN WHAT ROLE — one registry, because two
 * tools were keeping separate hand-written rosters of the same Workers and
 * nothing made them grow together (#2267 r24).
 *
 * That is the failure worth stating, since it is quiet in exactly the
 * place it matters: add a fourth writer, register it in one roster and not
 * the other, and the barrier check exits `OK` having never asked about it
 * — while it keeps writing straight through the window. Both tools read
 * this file now, so there is one list to forget instead of two to keep in
 * step.
 *
 * `assertClassified()` is what makes the list self-checking. Every
 * wrangler config in the tree that declares `d1_databases` must appear
 * here; an unclassified one is an error naming the file. It cannot catch
 * the reverse — a Worker whose bindings are stripped for the barrier
 * declares no D1 and is invisible to discovery — which is exactly why the
 * roster is explicit rather than derived, and why `WRITERS` being wrong is
 * a listed-membership question and not a scan.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Workers that bind the SHARED database. The binding name differs by
 * Worker — the ops backup Worker reads it as `DB_ARCHIVE` — so each entry
 * is identified by binding, not by position.
 *
 * `writer` marks the three the cutover barrier is about: the Workers whose
 * bindings are removed so nothing can obtain a handle while rows are
 * carried. The backup Worker is deliberately NOT one — it is hand-deployed
 * and stays on the database being left behind for the duration.
 */
export const SHARED_CONSUMERS = [
  { file: 'apps/indexer/wrangler.jsonc', binding: 'DB', writer: true },
  { file: 'apps/keeper/wrangler.jsonc', binding: 'DB', writer: true },
  { file: 'apps/agent/wrangler.jsonc', binding: 'DB', writer: true },
  { file: 'ops/offchain-data-warm/wrangler.jsonc', binding: 'DB_ARCHIVE', writer: false },
];

/** The three the barrier holds. Derived, so it cannot disagree above. */
export const WRITERS = new Set(
  SHARED_CONSUMERS.filter((c) => c.writer).map((c) => c.file),
);

/** Workers that must NOT bind the shared database, and why. */
export const MUST_NOT_SHARE = [
  {
    file: 'ops/mesh-watcher/wrangler.jsonc',
    reason:
      'internal ops alerts must not co-locate with user-facing data ' +
      '(CLAUDE.md, "Cloudflare D1 schema discipline")',
  },
];

/**
 * Every wrangler config in the tree that declares any `d1_databases`.
 *
 * Identified by wrangler's own filename convention rather than by content,
 * which is the same decision `check-keep-vars.mjs` records: a test on a
 * string, not an inference about what a file is for.
 */
export function discoverD1Configs(repo) {
  const tracked = execFileSync(
    'git',
    ['ls-files', '-z', '*wrangler*.json', '*wrangler*.jsonc'],
    { cwd: repo, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  return tracked.filter((f) =>
    readFileSync(`${repo}/${f}`, 'utf8').includes('"d1_databases"'),
  );
}

/**
 * Every discovered config is classified, or this returns the problems.
 *
 * Returned rather than thrown so each caller reports in its own format —
 * and so this module stays free of process exits, which is what lets a
 * test import it.
 */
export function assertClassified(repo) {
  const known = new Set([
    ...SHARED_CONSUMERS.map((c) => c.file),
    ...MUST_NOT_SHARE.map((c) => c.file),
  ]);
  return discoverD1Configs(repo)
    .filter((f) => !known.has(f))
    .map(
      (f) =>
        `${f} declares a d1_databases binding but is not classified in ` +
        `apps/indexer/scripts/lib/d1-workers.mjs.\n    Every Worker that ` +
        `touches D1 is either a consumer of the shared database — and if ` +
        `so, whether the cutover barrier holds it — or one that must not ` +
        `share it. Until it is one of those, the barrier check does not ` +
        `ask about it and exits OK while it writes straight through the ` +
        `window.`,
    );
}
