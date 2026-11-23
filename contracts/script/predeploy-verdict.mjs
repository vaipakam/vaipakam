#!/usr/bin/env node
/**
 * predeploy-verdict.mjs — the pre-deploy check's own verdict, recorded once
 * per tree (#3896; deploy rehearsal design §18 "Tree digest", hardening
 * lesson 10).
 *
 * `predeploy-check.sh` reads a property of the tree, not of a chain, so a
 * deploy across several chains (and the rehearsal before it) need not run it
 * once per chain. A passing run records a verdict keyed by the tree digest
 * (`rehearsal-tree.mjs`), and the next step that needs the check reuses it
 * when it covers the present tree in a mode at least as strong.
 *
 *   start
 *       The tree digest, printed as one JSON line. The check calls it before
 *       its first step.
 *   record --mode <default|full> --start <digest> [--dir <d>]
 *       After a passing run: writes the verdict with the check's context,
 *       unless the tree changed while the check ran (the digest now differs
 *       from <digest>), in which case it says so and writes nothing.
 *   covers --mode <default|full> [--dir <d>]
 *       Exit 0 and print the verdict's path when a passing verdict covers the
 *       present tree, a mode at least <mode> (`full` covers `default`) and
 *       the present context. Exit 1 with the reason otherwise.
 *
 * The context is everything outside the tree that changes what the check
 * decides, worked out in one place ({@link checkContext}): the forge version,
 * every FOUNDRY_* setting in the environment (a profile can leave tests out),
 * and for the full check two more: the resolved commit its gas-budget raise
 * rule compares against (GAS_BUDGETS_BASE_REF, else where HEAD left
 * origin/main), and the regression plan itself, as `run-regression.sh
 * --list-chunks` prints it. The plan is the regression's own statement of
 * which suites it runs, so anything that changes the coverage (a FORK_URL_*
 * that adds the fork suites, --invariants, a new suite) changes it, without
 * this file keeping a list of such inputs.
 * A storage-layout baseline (STORAGE_LAYOUT_BASE) names a file outside the
 * tree, so a run with one is never recorded or reused (predeploy-check.sh,
 * lib/predeploy-once.sh).
 *
 * The verdict is a local file under the ignored
 * `contracts/deployments/.forge-test/predeploy/`, outside the tree digest.
 * Like the rehearsal verdict it guards against mistakes, not against someone
 * who means to skip the check.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, treeDigest } from './rehearsal-tree.mjs';

export const DEFAULT_DIR = join(REPO_ROOT, 'contracts', 'deployments', '.forge-test', 'predeploy');
export const KIND = 'vaipakam-predeploy-verdict';
const MODES = ['default', 'full'];

/** The toolchain a verdict was reached with: forge's version line. */
export function toolchain() {
  try {
    return execFileSync('forge', ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
  } catch {
    return 'forge unavailable';
  }
}

export const verdictPath = (dir, digest) => join(dir, `${digest}.json`);

/** The commit the full check's gas-budget raise rule compares against, as predeploy-check.sh resolves it. */
export function gasBudgetsBase(env = process.env, root = REPO_ROOT) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const ref = env.GAS_BUDGETS_BASE_REF;
  try {
    return ref ? git('rev-parse', '--verify', `${ref}^{commit}`) : git('merge-base', 'HEAD', 'origin/main');
  } catch {
    return `unresolved ${ref || 'origin/main'}`;
  }
}

/** The digest of the full check's regression plan, from run-regression.sh itself. */
export function regressionPlan(env = process.env) {
  try {
    const out = execFileSync('bash', [join(REPO_ROOT, 'contracts', 'script', 'run-regression.sh'), '--list-chunks'], {
      cwd: join(REPO_ROOT, 'contracts'),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return createHash('sha256').update(out).digest('hex');
  } catch {
    return 'unavailable';
  }
}

/** Everything outside the tree that changes what the check decides. */
export function checkContext(mode, { env = process.env, tool = toolchain, gasBase = gasBudgetsBase, plan = regressionPlan } = {}) {
  const foundry = Object.keys(env)
    .filter((k) => k.startsWith('FOUNDRY_') && !(k === 'FOUNDRY_PROFILE' && env[k] === 'default'))
    .sort()
    .map((k) => `${k}=${env[k]}`);
  const ctx = { toolchain: tool(), foundry: foundry.join(' ') || 'none' };
  if (mode === 'full') {
    ctx.gasBudgetsBase = gasBase(env);
    ctx.regressionPlan = plan(env);
  }
  return ctx;
}

/**
 * Why `verdict` does not cover `present` ({treeDigest, mode, context}), or ''
 * when it does. Every key of the present context must equal the verdict's
 * (a full verdict carries one more, which a default step does not ask). Pure.
 */
export function whyNot(verdict, present) {
  if (!verdict) return 'no pre-deploy verdict was recorded for this tree';
  if (verdict.kind !== KIND || verdict.result !== 'pass') return 'the recorded verdict is not a passing pre-deploy verdict';
  if (verdict.treeDigest !== present.treeDigest) return 'the recorded verdict is of another tree';
  if (MODES.indexOf(verdict.mode) < MODES.indexOf(present.mode)) return `the verdict ran the ${verdict.mode} check; this step needs the ${present.mode} check`;
  for (const [k, v] of Object.entries(present.context ?? {})) {
    const was = verdict.context?.[k];
    if (was !== v) return `the verdict's ${k} was ${was ?? 'not recorded'}, now ${v}`;
  }
  return '';
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), { now = () => new Date(), context = checkContext } = {}) {
  const [cmd, ...args] = argv;
  const dir = resolve(option(args, '--dir') ?? DEFAULT_DIR);
  const mode = option(args, '--mode');
  if (cmd === 'start') {
    const { commit, digest } = treeDigest();
    console.log(JSON.stringify({ commit, treeDigest: digest }));
    return 0;
  }
  if ((cmd === 'record' || cmd === 'covers') && !MODES.includes(mode)) {
    console.error(`  ✗ predeploy-verdict: --mode must be one of ${MODES.join(', ')}`);
    return 2;
  }
  if (cmd === 'record') {
    const start = option(args, '--start');
    if (!/^[0-9a-f]{64}$/.test(start ?? '')) {
      console.error('  ✗ predeploy-verdict: record needs --start <digest>');
      return 2;
    }
    const { commit, digest } = treeDigest();
    if (digest !== start) {
      console.log('  · the tree changed while the pre-deploy check ran: no verdict recorded, the next step runs the check again');
      return 0;
    }
    mkdirSync(dir, { recursive: true });
    const ctx = context(mode);
    const verdict = { kind: KIND, version: 1, result: 'pass', mode, commit, treeDigest: digest, context: ctx, passedAt: now().toISOString() };
    const f = verdictPath(dir, digest);
    // A full verdict is never replaced by a weaker one for the same tree.
    if (existsSync(f)) {
      try {
        const old = JSON.parse(readFileSync(f, 'utf8'));
        if (whyNot(old, { treeDigest: digest, mode, context: ctx }) === '' && MODES.indexOf(old.mode) > MODES.indexOf(mode)) {
          console.log(`  · ${relative(REPO_ROOT, f)} already records the ${old.mode} check for this tree`);
          return 0;
        }
      } catch {
        // An unreadable file is replaced.
      }
    }
    writeFileSync(`${f}.tmp`, `${JSON.stringify(verdict)}\n`);
    renameSync(`${f}.tmp`, f);
    console.log(`  ✓ pre-deploy verdict recorded for this tree: ${relative(REPO_ROOT, f)}`);
    return 0;
  }
  if (cmd === 'covers') {
    const { digest } = treeDigest();
    const f = verdictPath(dir, digest);
    let verdict = null;
    try {
      verdict = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      verdict = null;
    }
    const why = whyNot(verdict, { treeDigest: digest, mode, context: context(mode) });
    if (why) {
      console.error(`  · ${why}`);
      return 1;
    }
    console.log(relative(REPO_ROOT, f));
    return 0;
  }
  console.error('usage: predeploy-verdict.mjs start | record --mode <m> --start <digest> | covers --mode <m> [--dir <d>]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main());
