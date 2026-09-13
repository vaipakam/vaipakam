#!/usr/bin/env node
/**
 * check-keep-vars — every Worker holding operator-managed vars declares that
 * a deploy will not delete them.
 *
 * WHY THIS EXISTS (#1995). Wrangler treats the config file as the source of
 * truth for environment configuration: on deploy it DELETES every var that is
 * not in the file before setting the ones that are. So any value managed only
 * in the Cloudflare dashboard is wiped by an ordinary deploy — for the keeper
 * that is `HF_SCALE`, the `LIQ_*` confidence thresholds,
 * `SPLIT_MIN_IMPROVEMENT_BPS` and `PARTIAL_LIQ_MIN_HF_BPS`; for the agent,
 * `RECIPIENT_VALIDATING_TOKENS` and `OPENSEA_OFFERS_MAX_PAGES`. Losing them
 * reverts liquidation behaviour to defaults silently, at the moment it starts
 * mattering.
 *
 * The original defence required `--keep-vars` on every invocation, and
 * `check-deploy-invocations.mjs` searched the tree for invocations lacking it.
 * That predicate is unbounded — a deploy can be spelled through a package
 * script, a manifest alias, a Makefile variable, a sourced helper, a shell
 * function or alias, a matrix expression, a reusable-workflow input, a Windows
 * shim, `eval`, or a marketplace action — and #1995 answered 242 review
 * findings enumerating them without reaching the end.
 *
 * `keep_vars` is the bounded question instead: wrangler reads it on BOTH the
 * deploy path (`props.keepVars || config.keep_vars`) and for `versions
 * upload`, so declaring it makes every spelling safe at once, including the
 * ones nobody has written yet. This file asserts the declaration.
 *
 * THE TREE-WIDE SCANNER IS RETIRED, and this file is now the whole defence.
 * #1995 kept `check-deploy-invocations.mjs` as defence in depth on top of the
 * declaration. Sixteen further months of review rounds showed what that cost:
 * fourteen open issues (#2110, #2112–#2119, #2121–#2124, #2126), every one an
 * edge of the same predicate — a folded YAML scalar's offsets, a settable
 * `.RECIPEPREFIX`, a PowerShell here-string, a case-varied variable name, an
 * upper-case file extension, a semicolon after an assignment — and four of
 * them FALSE REPORTS that redden a correct tree. Each was a constructed
 * example; none named a file in this repository. Reading arbitrary text and
 * deciding whether it will run a command requires the execution model of
 * every interpreter it might be, and 23,800 lines of scanner and fixtures did
 * not get there. Deleting the predicate is the fix the record asks for, the
 * same move as #2066 (a declaration heuristic deleted after six rounds) and
 * #2149 (a speculative branch deleted at round 13).
 *
 * WHAT THAT ACCEPTS, stated rather than implied, because a defence that has
 * shrunk should say what it no longer covers:
 *
 *   - A deploy that OVERRIDES the declaration on the command line. Whether
 *     wrangler honours a negating spelling such as `--no-keep-vars` against a
 *     config that sets the key has not been verified here, and the retired
 *     scanner did not look for it either — it searched for a MISSING flag, and
 *     went quiet entirely once a Worker declared `keep_vars`. So this is an
 *     exposure the retirement inherits, not one it creates.
 *   - A deploy pointed at a wrangler config this check never sees. It walks
 *     `apps/*` and `ops/*` one level down, which is where every Worker in this
 *     repo lives; a config elsewhere would be neither discovered nor asserted.
 *   - A dashboard var on a Worker whose config declares no `vars` at all
 *     (`apps/app`, `apps/www`). Dashboard values are by definition absent from
 *     the config, so an empty `vars` block is not evidence that none exist.
 *     Requiring the key there would state a rule those Workers do not have
 *     today; if either ever grows operator-managed values, add it to
 *     `VAR_CARRYING_WORKERS` in the same change.
 *
 * WHY IT RUNS UNCONDITIONALLY, and does not live only in the keeper's Vitest
 * suite. The Workers it checks span `apps/` and `ops/`, while the only CI job
 * running that suite is path-gated to `apps/(app|indexer|keeper)` — so an
 * agent-only or ops-only change could remove the key with the invariant
 * skipped, which is precisely the change it exists to catch (Codex #1995 r22).
 * Same reasoning as `check-d1-name-consistency`, and it takes the same shape:
 * node builtins only, so the job needs no install step.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Overridable so the invariant can be exercised against a COPIED tree. The
// suite proving this check fails when the key is removed must not remove the
// key from the real configs to do it: a crash or a kill between the write and
// the restore would leave the developer's worktree in exactly the unsafe state
// this check exists to prevent, and JavaScript cleanup does not run after
// process termination (Codex #1995 r23). Same override the deploy guard has
// carried since it was written, for the same reason.
const REPO_ROOT = (
  process.env.CHECK_KEEP_VARS_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
).replace(/\/$/, '');

/**
 * Workers whose config declares plain-text `vars`, so a deploy can wipe them.
 *
 * `apps/app` and `apps/www` are deliberately absent: they carry no `vars` at
 * all, so there is nothing to preserve and requiring the key would state a
 * rule they do not have.
 */
const VAR_CARRYING_WORKERS = [
  'apps/agent',
  'apps/keeper',
  'apps/indexer',
  'ops/mesh-watcher',
  'ops/offchain-data-warm',
];

import { parseJsonc } from './lib/jsonc.mjs';

function readJsonc(relPath) {
  return parseJsonc(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
}

const problems = [];

/**
 * Every Wrangler config in the tree, DISCOVERED rather than listed.
 *
 * The list above is a floor, not the inventory: a sixth Worker added with a
 * `vars` block and no `keep_vars` was never examined, and the paired test
 * compared the list against another copy of the same list — so the two agreed
 * with each other while both missed the new Worker (#1995 r23). The spec says
 * this check covers every Worker holding operator-managed values, and it now
 * does.
 *
 * Bounded to `apps/` and `ops/`, one level down, which is where every Worker
 * in this repo lives; node builtins only, so the unconditional CI job still
 * needs no install step.
 */
function discoverWorkerConfigs() {
  const found = [];
  for (const root of ['apps', 'ops']) {
    let entries;
    try {
      entries = readdirSync(join(REPO_ROOT, root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const name of ['wrangler.jsonc', 'wrangler.json']) {
        if (existsSync(join(REPO_ROOT, root, e.name, name))) {
          found.push(`${root}/${e.name}/${name}`);
          break;
        }
      }
    }
  }
  return found.sort();
}

for (const rel of discoverWorkerConfigs()) {
  const dir = rel.replace(/\/wrangler\.jsonc?$/, '');
  if (VAR_CARRYING_WORKERS.includes(dir)) continue; // asserted in full below
  let cfg;
  try {
    cfg = readJsonc(rel);
  } catch (err) {
    problems.push(`${rel} could not be read or parsed: ${err.message}`);
    continue;
  }
  const hasVars = typeof cfg.vars === 'object' && cfg.vars !== null;
  if (hasVars && cfg.keep_vars !== true) {
    problems.push(
      `${rel} declares \`vars\` but not \`"keep_vars": true\`, and is not in ` +
        `VAR_CARRYING_WORKERS.\n    A deploy of this Worker would DELETE every ` +
        `dashboard-managed var. Add the key, then add\n    "${dir}" to the ` +
        `list so the per-Worker mutation tests cover it too.`,
    );
  }
}

for (const dir of VAR_CARRYING_WORKERS) {
  const rel = `${dir}/wrangler.jsonc`;
  let cfg;
  try {
    cfg = readJsonc(rel);
  } catch (err) {
    problems.push(`${rel} could not be read or parsed: ${err.message}`);
    continue;
  }
  if (cfg.keep_vars !== true) {
    problems.push(
      `${rel} does not declare \`"keep_vars": true\`. A deploy of this Worker ` +
        `would DELETE every var\n    managed in the dashboard rather than in ` +
        `this file.`,
    );
  }
  // The LIST is pinned as well as the key. If a Worker's `vars` block goes
  // away, that is a decision to make — drop it from this list, or find out why
  // — not an assertion to leave passing for a Worker the rule no longer
  // describes.
  if (typeof cfg.vars !== 'object' || cfg.vars === null) {
    problems.push(
      `${rel} has no \`vars\` block, so this list is stale. Either the Worker ` +
        `stopped carrying\n    operator-managed values (remove it from ` +
        `VAR_CARRYING_WORKERS) or the block was lost.`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `\n[check-keep-vars] ${problems.length} problem(s):\n\n` +
      problems.map((p) => `  - ${p}`).join('\n\n') +
      `\n\nWrangler deletes vars absent from the config before setting the ` +
      `ones present, so a\nWorker with dashboard-managed values must declare ` +
      `\`"keep_vars": true\`. It is read for\nboth \`deploy\` and ` +
      `\`versions upload\`, which is what makes the declaration cover every\n` +
      `way a deploy can be spelled.\n`,
  );
  process.exit(1);
}

console.log(
  `[check-keep-vars] OK — ${VAR_CARRYING_WORKERS.length} Worker(s) preserve ` +
    `their dashboard-managed vars by configuration.`,
);
