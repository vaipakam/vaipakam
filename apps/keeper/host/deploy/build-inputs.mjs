#!/usr/bin/env node
// What a keeper release was built from, and whether a later commit can change
// it (#2651).
//
// The keeper machine follows `main`, and most merges to `main` change nothing
// the keeper bundle is built from: an app screen, an indexer migration, a
// contract test. Building each of them anyway cost the machine about three
// minutes of a 1 GB host per merge, and those builds were what pushed the
// keeper past its own run deadlines. So each build now records the files the
// bundle was actually made from, and the updater builds a new commit only when
// it changes one of them, or something that decides how they are read.
//
//   build-inputs.mjs record <metafile> <esbuild working dir>
//     Run by build.sh, inside the build sandbox, from the source tree's root.
//     Prints the release's INPUTS file: every file esbuild read that is not
//     under a node_modules directory (those are pinned by the lockfile).
//
//   build-inputs.mjs decide <repo> <from commit> <to commit> <INPUTS file>
//     Run by update.sh, as root. Prints `skip` when every change from <from>
//     to <to> provably leaves the bundle and the kit as they are, and
//     `build: <reason>` otherwise. Anything it cannot read (a malformed
//     INPUTS file, a commit the checkout no longer has) is `build`: an
//     unneeded build costs minutes, a wrongly skipped one leaves the keeper
//     on old code.
//
// Root never runs anything the build wrote. It reads INPUTS as data, through
// `parseInputs`, which refuses anything that is not a plain list of
// repository paths.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INPUTS_HEADER = '# vaipakam keeper build inputs v1';

/** The deploy kit: its units, its updater and build.sh. A change to any of
 *  them deploys, whatever it does to the bundle. */
export const KIT_DIR = 'apps/keeper/host/deploy/';

/** Extensions esbuild may resolve an import to. An ADDED file with one of
 *  these, next to an input, could be picked by an import that resolved to
 *  something else before, so it counts as a change. */
const MODULE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css|node)$/;

/** Files that decide how the inputs are read rather than being read as
 *  code: package manifests (dependencies, `exports`), TypeScript configs
 *  (esbuild reads the nearest one and whatever it extends), npm settings, and
 *  `.gitattributes` (which `git archive` applies to the source export). A
 *  change to one anywhere in the tree deploys. */
const CONFIG_FILE = /(^|\/)(package\.json|[tj]sconfig[^/]*\.json|\.npmrc|\.gitattributes)$/;

const SAFE_PATH = /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/;

/** Every file esbuild read, as repository paths, sorted. Refuses an input it
 *  cannot place inside the repository, so a release never records a list
 *  that leaves something out. */
export function recordInputs(metafile, esbuildDir, repoRoot = process.cwd()) {
  const root = realpathSync(repoRoot);
  const base = resolve(root, esbuildDir);
  const files = new Set();
  for (const key of Object.keys(metafile.inputs ?? {})) {
    if (key.split('/').includes('node_modules')) continue;
    const file = resolve(base, key);
    const rel = relative(root, file).split(sep).join('/');
    if (isAbsolute(key) || rel.startsWith('..') || !SAFE_PATH.test(rel) || rel.split('/').includes('..')) {
      throw new Error(`build input outside the repository: ${key}`);
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new Error(`build input is not a file in the source tree: ${key}`);
    }
    files.add(rel);
  }
  if (files.size === 0) throw new Error('the metafile names no build inputs');
  return [...files].sort();
}

export function formatInputs(files) {
  return `${INPUTS_HEADER}\n${files.join('\n')}\n`;
}

/** The recorded inputs, or `undefined` for anything that is not exactly what
 *  `formatInputs` writes: then nothing is known, and the commit is built. */
export function parseInputs(text) {
  if (typeof text !== 'string' || !text.endsWith('\n')) return undefined;
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== INPUTS_HEADER || lines.length < 2) return undefined;
  const files = lines.slice(1);
  if (!files.every((f) => SAFE_PATH.test(f) && !f.split('/').includes('..'))) return undefined;
  return new Set(files);
}

/**
 * Whether the changes from the release's commit to a newer one can change
 * what the keeper runs. `changes` is `git diff --no-renames --name-status`:
 * a status letter and a path each (a rename is a delete and an add).
 *
 * A change matters when it is:
 *   - a file at the repository root, except Markdown (the lockfile, the
 *     workspace, the root manifest and its `packageManager`);
 *   - one of the recorded inputs, changed or deleted;
 *   - in the deploy kit;
 *   - a config file (`CONFIG_FILE`), anywhere;
 *   - a new module file in a directory that holds an input, or one level
 *     below it (where `./x` resolves to `x/index.ts`).
 * Anything else was never read by the build and cannot be, so the bundle a
 * build of the newer commit makes is the release's own, byte for byte.
 */
export function mustBuild(changes, inputs) {
  const inputDirs = new Set([...inputs].map(parentOf));
  for (const { status, path } of changes) {
    if (!path.includes('/')) {
      if (!path.endsWith('.md')) return { build: true, why: `${path} at the repository root changed` };
      continue;
    }
    if (inputs.has(path)) return { build: true, why: `${path}, a build input, changed` };
    if (path.startsWith(KIT_DIR)) return { build: true, why: `${path}, in the deploy kit, changed` };
    if (CONFIG_FILE.test(path)) return { build: true, why: `${path}, a config file, changed` };
    if (status === 'A' && MODULE_EXTENSION.test(path)) {
      const dir = parentOf(path);
      if (inputDirs.has(dir) || inputDirs.has(parentOf(dir))) {
        return { build: true, why: `${path} was added next to the build inputs` };
      }
    }
  }
  return { build: false };
}

function parentOf(path) {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/** `git diff -z --no-renames --name-status` output, as status and path. */
export function parseNameStatus(raw) {
  const fields = raw.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  if (fields.length % 2 !== 0) throw new Error('unexpected git diff output');
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) changes.push({ status: fields[i][0], path: fields[i + 1] });
  return changes;
}

export function decide(repo, from, to, inputsFile) {
  const commit = /^[0-9a-f]{40}$/;
  if (!commit.test(from) || !commit.test(to)) return 'build: the commits are not both full hashes';
  let text;
  try {
    text = readFileSync(inputsFile, 'utf8');
  } catch {
    return 'build: the running release records no build inputs';
  }
  const inputs = parseInputs(text);
  if (inputs === undefined) return "build: the running release's build inputs are unreadable";
  let raw;
  try {
    raw = execFileSync('git', ['-C', repo, 'diff', '-z', '--no-renames', '--name-status', from, to, '--'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return `build: could not compare ${from} with ${to}`;
  }
  const verdict = mustBuild(parseNameStatus(raw), inputs);
  return verdict.build ? `build: ${verdict.why}` : 'skip';
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'record' && args.length === 2) {
    const metafile = JSON.parse(readFileSync(args[0], 'utf8'));
    process.stdout.write(formatInputs(recordInputs(metafile, args[1])));
    return;
  }
  if (command === 'decide' && args.length === 4) {
    process.stdout.write(`${decide(...args)}\n`);
    return;
  }
  process.stderr.write('usage: build-inputs.mjs record <metafile> <esbuild dir> | decide <repo> <from> <to> <INPUTS>\n');
  process.exit(2);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

