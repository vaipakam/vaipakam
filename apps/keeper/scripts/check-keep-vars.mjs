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
 * `check-deploy-invocations.mjs` still searches the tree for invocations
 * lacking it. That predicate is unbounded — a deploy can be spelled through a
 * package script, a manifest alias, a Makefile variable, a sourced helper, a
 * shell function or alias, a matrix expression, a reusable-workflow input, a
 * Windows shim, `eval`, or a marketplace action — and #1995 answered 242
 * review findings enumerating them without reaching the end.
 *
 * `keep_vars` is the bounded question instead: wrangler reads it on BOTH the
 * deploy path (`props.keepVars || config.keep_vars`) and for `versions
 * upload`, so declaring it makes every spelling safe at once, including the
 * ones nobody has written yet. This file asserts the declaration.
 *
 * WHY IT RUNS UNCONDITIONALLY, and does not live only in the keeper's Vitest
 * suite. The Workers it checks span `apps/` and `ops/`, while the only CI job
 * running that suite is path-gated to `apps/(app|indexer|keeper)` — so an
 * agent-only or ops-only change could remove the key with the invariant
 * skipped, which is precisely the change it exists to catch (Codex #1995 r22).
 * Same reasoning as `check-d1-name-consistency`, and it takes the same shape:
 * node builtins only, so the job needs no install step.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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
