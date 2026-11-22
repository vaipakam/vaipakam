/**
 * What the baseline tools ask git (#3964): kept apart from `baseline.mjs`,
 * whose rules run on plain data, so both command-line tools ask git the same
 * questions the same way.
 */
import { execFileSync } from 'node:child_process';

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Every tracked entry of `commit`: [{path, oid}] (a submodule's oid is its pinned commit). */
export function treeEntries(repo, commit) {
  const out = [];
  for (const rec of git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [, , oid] = rec.slice(0, tab).split(' ');
    out.push({ path: rec.slice(tab + 1), oid });
  }
  return out;
}

/** Every vendored library under contracts/lib at `commit`: a submodule's pinned commit, or a vendored folder's tree. */
export function librariesAt(repo, commit) {
  const out = {};
  for (const line of git(repo, ['ls-tree', commit, 'contracts/lib/']).split('\n').filter(Boolean)) {
    const [meta, path] = line.split('\t');
    const [, type, hash] = meta.split(' ');
    out[path.replace(/^contracts\/lib\//, '')] = { type: type === 'commit' ? 'submodule' : 'vendored', hash };
  }
  return out;
}

/** Whether git verifies the tag's signature with the keys this machine trusts. */
export function verifyTagSignature(repo, tag) {
  try {
    execFileSync('git', ['tag', '-v', tag], { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}
