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
 *   covers --mode default [--dir <d>]
 *       Exit 0 and print the verdict's path when a passing verdict (of the
 *       default or the full check) covers the present tree and the present
 *       context. Exit 1 with the reason otherwise.
 *
 * Only the default check is ever answered from a verdict. The full check
 * (mainnet) runs every time: its regression includes the live-fork suites,
 * which read live chains and the deployment records under
 * `contracts/deployments`, both outside the tree digest and outside anything
 * a verdict could pin. A full pass is still recorded, and covers a later
 * default step.
 *
 * The context is what outside the tree changes the default check's decision,
 * worked out in one place ({@link checkContext}): the forge version and every
 * FOUNDRY_* setting in the environment (a profile can leave tests out). A
 * storage-layout baseline (STORAGE_LAYOUT_BASE) names a file outside the
 * tree, so a run with one is never recorded or reused (predeploy-check.sh,
 * lib/predeploy-once.sh). The deployment records are outside the tree digest
 * by design (§18), so that a launch's later chains reuse the verdict after the
 * first chain writes its records; the one default step that reads them is the
 * LayerZero-residue lint over committed addresses.json files, which the
 * deploy writes from the tree's own code.
 *
 * The verdict is a local file under the ignored
 * `contracts/deployments/.forge-test/predeploy/`, outside the tree digest.
 * Like the rehearsal verdict it guards against mistakes, not against someone
 * who means to skip the check.
 */
import { execFileSync } from 'node:child_process';
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

/** Everything outside the tree that changes what the check decides. */
export function checkContext({ env = process.env, tool = toolchain } = {}) {
  const foundry = Object.keys(env)
    .filter((k) => k.startsWith('FOUNDRY_') && !(k === 'FOUNDRY_PROFILE' && env[k] === 'default'))
    .sort()
    .map((k) => `${k}=${env[k]}`);
  return { toolchain: tool(), foundry: foundry.join(' ') || 'none' };
}

/**
 * Why `verdict` does not cover `present` ({treeDigest, mode, context}), or ''
 * when it does. Every key of the present context must equal the verdict's.
 * A full step is never covered. Pure.
 */
export function whyNot(verdict, present) {
  if (present.mode === 'full') return 'the full check is never reused: its live-fork suites read chains and deployment records outside the tree';
  if (!verdict) return 'no pre-deploy verdict was recorded for this tree';
  if (verdict.kind !== KIND || verdict.result !== 'pass') return 'the recorded verdict is not a passing pre-deploy verdict';
  if (verdict.treeDigest !== present.treeDigest) return 'the recorded verdict is of another tree';
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
  if ((cmd === 'record' && !MODES.includes(mode)) || (cmd === 'covers' && mode !== 'default' && mode !== 'full')) {
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
    const ctx = context();
    const verdict = { kind: KIND, version: 1, result: 'pass', mode, commit, treeDigest: digest, context: ctx, passedAt: now().toISOString() };
    const f = verdictPath(dir, digest);
    // A full verdict is never replaced by a default one for the same tree.
    if (existsSync(f)) {
      try {
        const old = JSON.parse(readFileSync(f, 'utf8'));
        if (whyNot(old, { treeDigest: digest, mode: 'default', context: ctx }) === '' && MODES.indexOf(old.mode) > MODES.indexOf(mode)) {
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
    const why = whyNot(verdict, { treeDigest: digest, mode, context: context() });
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
