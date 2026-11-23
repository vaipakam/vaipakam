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
 *       The tree digest and the toolchain, printed as one JSON line. The
 *       check calls it before its first step.
 *   record --mode <default|full> --start <digest> --toolchain <text> [--dir <d>]
 *       After a passing run: writes the verdict, unless the tree changed while
 *       the check ran (the digest now differs from <digest>), in which case
 *       it says so and writes nothing.
 *   covers --mode <default|full> [--dir <d>]
 *       Exit 0 and print the verdict's path when a passing verdict covers the
 *       present tree, the present toolchain and a mode at least <mode> (`full`
 *       covers `default`). Exit 1 with the reason otherwise.
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

/** Why `verdict` does not cover `present` ({treeDigest, toolchain, mode}), or '' when it does. Pure. */
export function whyNot(verdict, present) {
  if (!verdict) return 'no pre-deploy verdict was recorded for this tree';
  if (verdict.kind !== KIND || verdict.result !== 'pass') return 'the recorded verdict is not a passing pre-deploy verdict';
  if (verdict.treeDigest !== present.treeDigest) return 'the recorded verdict is of another tree';
  if (verdict.toolchain !== present.toolchain) return `the verdict was reached with ${verdict.toolchain}, now ${present.toolchain}`;
  if (MODES.indexOf(verdict.mode) < MODES.indexOf(present.mode)) return `the verdict ran the ${verdict.mode} check; this step needs the ${present.mode} check`;
  return '';
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), { now = () => new Date(), tool = toolchain } = {}) {
  const [cmd, ...args] = argv;
  const dir = resolve(option(args, '--dir') ?? DEFAULT_DIR);
  const mode = option(args, '--mode');
  if (cmd === 'start') {
    const { commit, digest } = treeDigest();
    console.log(JSON.stringify({ commit, treeDigest: digest, toolchain: tool() }));
    return 0;
  }
  if ((cmd === 'record' || cmd === 'covers') && !MODES.includes(mode)) {
    console.error(`  ✗ predeploy-verdict: --mode must be one of ${MODES.join(', ')}`);
    return 2;
  }
  if (cmd === 'record') {
    const start = option(args, '--start');
    const chain = option(args, '--toolchain');
    if (!/^[0-9a-f]{64}$/.test(start ?? '') || !chain) {
      console.error('  ✗ predeploy-verdict: record needs --start <digest> and --toolchain <text>');
      return 2;
    }
    const { commit, digest } = treeDigest();
    if (digest !== start) {
      console.log('  · the tree changed while the pre-deploy check ran: no verdict recorded, the next step runs the check again');
      return 0;
    }
    mkdirSync(dir, { recursive: true });
    const verdict = { kind: KIND, version: 1, result: 'pass', mode, commit, treeDigest: digest, toolchain: chain, passedAt: now().toISOString() };
    const f = verdictPath(dir, digest);
    // A full verdict is never replaced by a weaker one for the same tree.
    if (existsSync(f)) {
      try {
        const old = JSON.parse(readFileSync(f, 'utf8'));
        if (whyNot(old, { treeDigest: digest, toolchain: chain, mode }) === '' && MODES.indexOf(old.mode) > MODES.indexOf(mode)) {
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
    const why = whyNot(verdict, { treeDigest: digest, toolchain: tool(), mode });
    if (why) {
      console.error(`  · ${why}`);
      return 1;
    }
    console.log(relative(REPO_ROOT, f));
    return 0;
  }
  console.error('usage: predeploy-verdict.mjs start | record --mode <m> --start <digest> --toolchain <t> | covers --mode <m> [--dir <d>]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main());
