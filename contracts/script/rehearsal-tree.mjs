#!/usr/bin/env node
/**
 * rehearsal-tree.mjs — a deploy rehearsal's two tree readings (#3891, deploy
 * rehearsal design §13 "The check" and §18 "Tree digest").
 *
 *   snapshot <out.json> [--scratch <rel>]
 *       Every file in the working tree by path and content hash: tracked,
 *       untracked and ignored alike, including the ignored deploy state beside
 *       the records (.markers, .history, .archive, the carry-forward file) and
 *       forge's broadcast/ and cache/ folders. Left out: `.git`, the run's own
 *       scratch folder, and the committed list {LEFT_OUT_FILE}, each entry with
 *       its reason.
 *
 *   compare <before.json> <after.json>
 *       Every path added, removed or changed between two snapshots. Any
 *       difference fails the run: the scratch folder is the only place a step
 *       may write.
 *
 *   digest
 *       The tree digest a verdict and the real deploy's gate compare: the
 *       commit plus a hash of every TRACKED file as it is on disk, excluding
 *       `contracts/deployments` (the one boundary the deploy scripts already
 *       use for their records). Printed as hex.
 *
 * The left-out list may never hide deploy state: an entry at or under
 * `contracts/deployments`, a `broadcast` folder or a forge `cache` folder is
 * refused ({validateLeftOut}), and its test pins that.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const LEFT_OUT_FILE = 'contracts/script/rehearsal-tree-leftout.json';

/** Paths no entry of the left-out list may be at or under, or contain. */
const PROTECTED = [
  /^contracts\/deployments(\/|$)/,
  /(^|\/)broadcast(\/|$)/,
  /(^|\/)cache(\/|$)/,
  // Compiled output is never left out: a step that recompiles means the tree
  // changed during the run, which is a failure (design §13).
  /^contracts\/out(\/|$)/,
];
/** Folder NAMES no `name` entry may use. */
const PROTECTED_NAMES = new Set(['deployments', 'broadcast', 'cache', 'out', 'contracts']);

/** The committed left-out list: `[{ path, reason }]` (a repo-relative POSIX
 *  path; a folder covers everything under it) or `[{ name, reason }]` (a
 *  folder name left out at any depth, such as `node_modules`). */
export function readLeftOut(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, LEFT_OUT_FILE), 'utf8')).leftOut;
}

/** Problems with a left-out list, as strings. Pure. */
export function validateLeftOut(list) {
  const problems = [];
  for (const e of list) {
    if (e && typeof e.name === 'string' && e.path === undefined) {
      if (!e.reason || e.reason.length < 20) problems.push(`${e.name}: no reason given`);
      if (!/^[A-Za-z0-9._-]+$/.test(e.name) || e.name === '.' || e.name === '..') problems.push(`${e.name}: not a folder name`);
      if (PROTECTED_NAMES.has(e.name)) problems.push(`${e.name}: may not leave out deploy state or compiled output`);
      continue;
    }
    if (!e || typeof e.path !== 'string' || !e.path) {
      problems.push('an entry has no path');
      continue;
    }
    const p = e.path.replace(/\/+$/, '');
    if (!e.reason || e.reason.length < 20) problems.push(`${p}: no reason given`);
    if (p.startsWith('/') || p.split('/').includes('..')) problems.push(`${p}: not a repo-relative path`);
    if (PROTECTED.some((re) => re.test(p))) problems.push(`${p}: may not leave out deploy state (records, broadcast journals, run caches)`);
    // A parent of a protected folder would hide it too.
    if (['contracts', 'contracts/deployments'].includes(p) || p === '') problems.push(`${p}: would hide the deployment records`);
  }
  return problems;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Walk `root`, hashing every file not under a left-out path. */
export function snapshot(root, leftOut, leftOutNames = []) {
  const skip = leftOut.map((p) => p.replace(/\/+$/, ''));
  const names = new Set(leftOutNames);
  const isSkipped = (rel) =>
    skip.some((p) => rel === p || rel.startsWith(`${p}/`)) || names.has(rel.slice(rel.lastIndexOf('/') + 1));
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join('/');
      if (isSkipped(rel)) continue;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) files[rel] = `link:${readlinkSync(abs)}`;
      else if (st.isDirectory()) walk(abs);
      else if (st.isFile()) files[rel] = sha256(readFileSync(abs));
    }
  };
  walk(root);
  return files;
}

/** Differences between two snapshots, sorted. Pure. */
export function compare(before, after) {
  const out = [];
  for (const p of Object.keys(before)) {
    if (!(p in after)) out.push({ path: p, change: 'removed' });
    else if (before[p] !== after[p]) out.push({ path: p, change: 'changed' });
  }
  for (const p of Object.keys(after)) if (!(p in before)) out.push({ path: p, change: 'added' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The tree digest (§18): commit + every tracked file outside
 *  contracts/deployments, by path and content as on disk. */
export function treeDigest(root = REPO_ROOT) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const commit = git('rev-parse', 'HEAD').trim();
  const tracked = git('ls-files', '-z', '--', '.', ':(exclude)contracts/deployments')
    .split('\0')
    .filter(Boolean)
    .sort();
  const h = createHash('sha256');
  h.update(`commit ${commit}\n`);
  for (const p of tracked) {
    let content;
    try {
      const st = lstatSync(join(root, p));
      content = st.isSymbolicLink() ? `link:${readlinkSync(join(root, p))}` : sha256(readFileSync(join(root, p)));
    } catch {
      content = 'missing';
    }
    h.update(`${p}\0${content}\n`);
  }
  return { commit, digest: h.digest('hex') };
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (cmd === 'snapshot') {
    const out = rest[0];
    const i = rest.indexOf('--scratch');
    const list = readLeftOut();
    const problems = validateLeftOut(list);
    if (problems.length) {
      for (const p of problems) console.error(`  ✗ ${LEFT_OUT_FILE}: ${p}`);
      return 1;
    }
    const leftOut = ['.git', ...list.filter((e) => e.path).map((e) => e.path)];
    if (i >= 0) leftOut.push(rest[i + 1]);
    const names = list.filter((e) => e.name).map((e) => e.name);
    writeFileSync(out, JSON.stringify(snapshot(REPO_ROOT, leftOut, names)));
    return 0;
  }
  if (cmd === 'compare') {
    const diff = compare(JSON.parse(readFileSync(rest[0], 'utf8')), JSON.parse(readFileSync(rest[1], 'utf8')));
    for (const d of diff) console.error(`  ✗ ${d.change} outside the scratch folder: ${d.path}`);
    if (!diff.length) console.log('  ✓ nothing outside the scratch folder changed');
    return diff.length ? 1 : 0;
  }
  if (cmd === 'digest') {
    const { commit, digest } = treeDigest();
    console.log(JSON.stringify({ commit, treeDigest: digest }));
    return 0;
  }
  console.error('usage: rehearsal-tree.mjs snapshot <out> [--scratch <rel>] | compare <before> <after> | digest');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
