#!/usr/bin/env node
/**
 * The deploy of every Worker that binds the shared `vaipakam-warm` D1 —
 * apps/indexer, apps/keeper and apps/agent (#2214 / #2409).
 *
 * Applies pending migrations (apps/indexer's `migrate` script — the schema's
 * owner, and the one place the apply is spelt), then runs `wrangler deploy`
 * in the CALLING Worker's directory with whatever arguments it was given. The
 * deploy runs only if the apply succeeded, so a failed migration never leaves
 * new code on an old schema.
 *
 * A script rather than a `migrate && wrangler deploy` one-liner because pnpm
 * appends `run` arguments to the END of a script string, so
 * `pnpm run deploy --dry-run` would apply REMOTE migrations and only then
 * hand `--dry-run` to wrangler (#2409 r2). Here the arguments are read first:
 * a run that does not deploy (`--dry-run`, which wrangler documents as "Don't
 * actually deploy", or a help request) changes nothing remote either, and
 * says that it skipped the apply.
 *
 * Usage, from the Worker's own directory (its package `deploy` script):
 *   node <path>/migrate-then-deploy.mjs [wrangler deploy args…]
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Arguments that make `wrangler deploy` publish nothing. A closed list: a
 *  flag not on it deploys, so it migrates first. */
const NO_DEPLOY_FLAGS = new Set(['--dry-run', '--help', '-h']);

/** The steps one invocation runs, in order. Pure, so a test can pin it. */
export function deployPlan(args) {
  const deploys = !args.some((a) => NO_DEPLOY_FLAGS.has(a));
  const steps = [];
  if (deploys) steps.push(['pnpm', ['--filter', '@vaipakam/indexer', 'run', 'migrate']]);
  steps.push(['wrangler', ['deploy', ...args]]);
  return { deploys, steps };
}

function main() {
  const { deploys, steps } = deployPlan(process.argv.slice(2));
  if (!deploys) {
    console.log('[deploy] not publishing (dry run / help): D1 migrations NOT applied — nothing remote is changed.');
  }
  for (const [cmd, args] of steps) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) {
      console.error(`[deploy] \`${cmd} ${args.join(' ')}\` failed — stopping before anything further runs.`);
      process.exit(r.status ?? 1);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
