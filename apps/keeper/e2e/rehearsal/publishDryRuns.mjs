#!/usr/bin/env node
/**
 * The deploy rehearsal's Worker publish steps, as dry runs (#3894,
 * DeployRehearsalDesign §7: "The Workers' publish steps run as dry runs.
 * Nothing is published"). Run by the rehearsal driver once per run with
 * `pnpm --filter @vaipakam/keeper run rehearsal:publish-dry`.
 *
 * Which Workers: every package under `apps/` and `ops/` that carries a
 * `deploy:dry` script, found here rather than listed, so a Worker that gains
 * one is rehearsed without an edit. Each runs its own `deploy:dry`
 * (`wrangler deploy --dry-run`), which builds the Worker and publishes
 * nothing.
 *
 * What a dry run proves, said plainly in the report: the Worker builds. It
 * builds from the repository's committed deployments bundle, not from the
 * run's scratch bundle, because the publish step reads the same imports a
 * real publish would; the Workers' behaviour against the run's records is
 * the off-chain stage's job (`offchain.rehearsal.ts`).
 *
 * Writes `<root>/reports/publish-dry.json` and exits non-zero when any dry run
 * failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rehearsalRoot } from '../../../indexer/scripts/deploy-shared-d1.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Every workspace package under `apps/` or `ops/` with a `deploy:dry` script. */
export function dryRunWorkers(repo = REPO) {
  const out = [];
  for (const group of ['apps', 'ops']) {
    const dir = join(repo, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const pkgPath = join(dir, name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.['deploy:dry']) out.push({ name: pkg.name, dir: `${group}/${name}`, script: pkg.scripts['deploy:dry'] });
    }
  }
  return out;
}

function main() {
  if (process.env.VAIPAKAM_REHEARSAL !== '1') {
    console.error('rehearsal: VAIPAKAM_REHEARSAL is not 1; the publish dry runs run only as a step of the rehearsal driver');
    process.exit(2);
  }
  const root = rehearsalRoot(process.env.VAIPAKAM_REHEARSAL_ROOT);
  if (!root.ok) {
    console.error(`rehearsal: ${root.message}`);
    process.exit(2);
  }
  const results = [];
  for (const w of dryRunWorkers()) {
    console.log(`[rehearsal] ${w.name}: ${w.script}`);
    const r = spawnSync('pnpm', ['run', 'deploy:dry'], {
      cwd: join(REPO, w.dir),
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-5);
    const ok = r.status === 0;
    console.log(`[rehearsal] ${w.name}: ${ok ? 'built, nothing published' : `FAILED (exit ${r.status})`}`);
    results.push({ worker: w.name, dir: w.dir, command: w.script, ok, exit: r.status, tail });
  }
  const report = {
    stage: 'publish-dry',
    note: 'each Worker built by its own dry run, which publishes nothing; built from the committed deployments bundle',
    results,
    passed: results.length > 0 && results.every((r) => r.ok),
  };
  mkdirSync(join(root.root, 'reports'), { recursive: true });
  writeFileSync(join(root.root, 'reports', 'publish-dry.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
