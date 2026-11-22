#!/usr/bin/env node
/**
 * The baseline check (#3964, RefactorRulesDesign §3.2).
 *
 * Proves that a tag of the series is what its record says, from the
 * repository alone. It refuses, naming each difference, when:
 *
 *   - the tag is lightweight or unsigned, or its message lacks the line
 *     `record sha256 <hash>` matching `contracts/baseline/<tag>.json`;
 *   - the tagged commit changes anything but the record, or its parent is not
 *     the commit and tree the record was built from;
 *   - the vendored libraries or the storage layout's recorded file differ;
 *   - the build tool is not the recorded version (named);
 *   - a rebuild of the tagged commit gives another compiler or settings
 *     (named), or any deployable's runtime code hash, size or interface hash
 *     differs from the record, or a deployable is missing or extra.
 *
 * By default it rebuilds the tagged commit in a temporary worktree with
 * `FOUNDRY_PROFILE=default forge build --skip test`. With `--out DIR` it
 * checks a build someone already made (the differential run's reference
 * build, #3926): the comparison is by content, so where the build came from
 * does not matter, only whether it matches.
 *
 * CLI: node contracts/script/baseline-check.mjs --tag <tag> [--out <dir>]
 *        [--verify-signature] [--json <file>]
 * Exit 0 when the tag passes, 1 on any refusal, 2 on a usage error.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  checkTagFacts,
  collectContracts,
  compareBuild,
  deployableNames,
  recordPath,
  sha256,
} from './lib/baseline.mjs';

const CONTRACTS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_REPO = resolve(CONTRACTS_DIR, '..');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const tryGit = (repo, args) => {
  try {
    return run('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

/** What git says about the tag: the facts {@link checkTagFacts} judges. */
export function tagFacts(repo, tag) {
  const kind = tryGit(repo, ['cat-file', '-t', `refs/tags/${tag}`])?.trim();
  if (!kind) throw new Error(`baseline-check: no tag ${tag} in this repository`);
  const commit = run('git', ['rev-parse', `${tag}^{commit}`], { cwd: repo }).trim();
  const raw = kind === 'tag' ? run('git', ['cat-file', 'tag', `refs/tags/${tag}`], { cwd: repo }) : '';
  const parentCommit = tryGit(repo, ['rev-parse', `${commit}^`])?.trim() ?? null;
  return {
    commit,
    annotated: kind === 'tag',
    signed: /-----BEGIN (PGP|SSH) SIGNATURE-----/.test(raw),
    message: raw.split('\n\n').slice(1).join('\n\n'),
    recordText: tryGit(repo, ['show', `${commit}:${recordPath(tag)}`]),
    changedFiles: parentCommit ? run('git', ['diff', '--name-only', parentCommit, commit], { cwd: repo }).split('\n').filter(Boolean) : [],
    parentCommit,
    parentTree: parentCommit ? run('git', ['rev-parse', `${parentCommit}^{tree}`], { cwd: repo }).trim() : null,
  };
}

/** The vendored libraries as recorded at `commit` (same shape as the generator's). */
export function librariesAt(repo, commit) {
  const out = {};
  for (const line of run('git', ['ls-tree', commit, 'contracts/lib/'], { cwd: repo }).split('\n').filter(Boolean)) {
    const [meta, path] = line.split('\t');
    const [, type, hash] = meta.split(' ');
    out[path.replace(/^contracts\/lib\//, '')] = { type: type === 'commit' ? 'submodule' : 'vendored', hash };
  }
  return out;
}

/** Build `commit` in a temporary worktree; returns {outDir, cleanup}. */
export function buildAt(repo, commit) {
  const scratch = mkdtempSync(join(tmpdir(), 'baseline-check-'));
  const wt = join(scratch, 'tree');
  run('git', ['worktree', 'add', '--detach', '--quiet', wt, commit], { cwd: repo });
  const cleanup = () => {
    tryGit(repo, ['worktree', 'remove', '--force', wt]);
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    // A submodule the checkout has initialized is part of its build; the
    // worktree gets the same pinned commit.
    for (const line of run('git', ['submodule', 'status'], { cwd: repo }).split('\n').filter(Boolean)) {
      if (line.startsWith('-')) continue;
      const path = line.trim().split(/\s+/)[1];
      run('git', ['submodule', 'update', '--init', '--quiet', path], { cwd: wt });
    }
    const outDir = join(scratch, 'out');
    run('forge', ['build', '--skip', 'test'], {
      cwd: join(wt, 'contracts'),
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, FOUNDRY_PROFILE: 'default', FOUNDRY_OUT: outDir, FOUNDRY_CACHE_PATH: join(scratch, 'cache') },
    });
    return { outDir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * Judge `tag`. `build(commit)` returns {outDir, cleanup}; `forgeVersion()` the
 * build tool's version line. Returns {refusals, record}.
 */
export function checkBaseline({ repo, tag, outDir, build = (c) => buildAt(repo, c), forgeVersion }) {
  const facts = tagFacts(repo, tag);
  const refusals = checkTagFacts(tag, facts);
  if (facts.recordText == null) return { refusals };
  let record;
  try {
    record = JSON.parse(facts.recordText);
  } catch {
    return { refusals };
  }
  const libs = librariesAt(repo, facts.commit);
  if (canonicalJson(libs) !== canonicalJson(record.versions?.libraries ?? {})) {
    for (const name of new Set([...Object.keys(libs), ...Object.keys(record.versions?.libraries ?? {})])) {
      const a = record.versions?.libraries?.[name];
      const b = libs[name];
      if (canonicalJson(a ?? null) !== canonicalJson(b ?? null)) {
        refusals.push(`library ${name}: the record pins ${a ? `${a.type} ${a.hash}` : 'nothing'}, the tagged commit has ${b ? `${b.type} ${b.hash}` : 'nothing'}`);
      }
    }
  }
  const layout = tryGit(repo, ['show', `${facts.commit}:${record.storageLayout?.file ?? 'contracts/storage-layout/layout.golden.json'}`]);
  if (layout == null || sha256(layout) !== record.storageLayout?.sha256) {
    refusals.push(`storage layout: the tagged commit's recorded file does not hash to the record's ${record.storageLayout?.sha256}`);
  }
  if (!outDir) {
    const forge = forgeVersion();
    if (forge !== record.versions?.forge) {
      refusals.push(`build tool: the record was built with "${record.versions?.forge}", this machine has "${forge}"; rebuild with the recorded version`);
      return { refusals, record };
    }
  }
  const names = deployableNames(JSON.parse(run('git', ['show', `${facts.commit}:packages/contracts/scripts/diamond-facets.json`], { cwd: repo })));
  let built;
  let cleanup = () => {};
  try {
    let dir = outDir;
    if (!dir) ({ outDir: dir, cleanup } = build(facts.commit));
    built = collectContracts(dir, names);
  } catch (e) {
    refusals.push(e.message);
    return { refusals, record };
  } finally {
    cleanup();
  }
  refusals.push(...compareBuild(record, built));
  return { refusals, record };
}

export function main(argv = process.argv.slice(2)) {
  const opt = { repo: DEFAULT_REPO };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--tag', '--out', '--json', '--repo'].includes(a) && argv[i + 1]) opt[a.slice(2)] = argv[++i];
    else if (a === '--verify-signature') opt.verifySig = true;
    else {
      console.error(`baseline-check: unknown argument ${a}`);
      return 2;
    }
  }
  if (!opt.tag) {
    console.error('baseline-check: --tag is required');
    return 2;
  }
  const { refusals, record } = checkBaseline({
    repo: resolve(opt.repo),
    tag: opt.tag,
    outDir: opt.out && resolve(opt.out),
    forgeVersion: () => run('forge', ['--version']).split('\n')[0].trim(),
  });
  if (opt.verifySig) {
    try {
      run('git', ['tag', '-v', opt.tag], { cwd: opt.repo, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      refusals.push(`${opt.tag}: git tag -v could not verify the signature with the keys this machine trusts`);
    }
  }
  if (opt.json) writeFileSync(opt.json, canonicalJson({ tag: opt.tag, passed: !refusals.length, refusals }));
  for (const r of refusals) console.error(`  ✗ ${r}`);
  if (refusals.length) {
    console.error(`baseline-check: ${opt.tag} REFUSED (${refusals.length})`);
    return 1;
  }
  console.log(`  ✓ ${opt.tag}: the tag, its record and a build of its commit agree (${Object.keys(record.contracts).length} contracts)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
