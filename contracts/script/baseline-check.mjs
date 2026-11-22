#!/usr/bin/env node
/**
 * The baseline check (#3964, RefactorRulesDesign §3.2).
 *
 * Proves that a tag of the series is what its record says, from the
 * repository alone. It refuses, naming each difference, when:
 *
 *   - the tag is lightweight or unsigned, or its message lacks the line
 *     `record sha256 <hash>` matching `contracts/baseline/<tag>.json`;
 *   - the tagged commit changes anything but the record, its parent is not the
 *     commit the record was built from, or its source digest (§3.2's rule,
 *     baseline records left out) differs from the record's;
 *   - the vendored libraries or the storage layout's recorded file differ, or
 *     the record lacks a gas figure for an action the suite lists;
 *   - the record carries no regression section, its stated totals are not
 *     what its own manifests add up to, a chunk or test failed, or the tagged
 *     tree's `run-regression.sh --verify-shards` refuses the manifests (its
 *     plan, every shard once, every chunk run once);
 *   - the build tool is not the recorded version (named);
 *   - a rebuild of the tagged commit gives another compiler or settings
 *     (named), or any deployable's runtime code hash, size or interface hash
 *     or immutables differ from the record, or a deployable (every contract
 *     compiled from src/ with runtime code) is missing or extra.
 *
 * By default it rebuilds the tagged commit in a temporary worktree with
 * `FOUNDRY_PROFILE=default forge build --skip test --ast`. With `--out DIR` it
 * checks a build someone already made (the differential run's reference
 * build, #3926): the comparison is by content, so where the build came from
 * does not matter, only whether it matches.
 *
 * The tag's signature is always verified (`git tag -v`): import the signer's
 * public key first. A message that only looks signed is refused.
 *
 * CLI: node contracts/script/baseline-check.mjs --tag <tag> [--out <dir>]
 *        [--json <file>]
 * Exit 0 when the tag passes, 1 on any refusal, 2 on a usage error.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  checkTagFacts,
  collectContracts,
  compareBuild,
  GAS_BUDGETS_FILE,
  gasCompleteness,
  recordPath,
  regressionAgreement,
  sha256,
  sourceDigest,
} from './lib/baseline.mjs';
import { librariesAt, treeEntries, verifyTagSignature } from './lib/baseline-git.mjs';

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

/**
 * What git says about the tag: the facts {@link checkTagFacts} judges.
 * `verifyTag(tag)` decides `signed`: git's own verification, never the
 * presence of a signature block in the message.
 */
export function tagFacts(repo, tag, verifyTag = (t) => verifyTagSignature(repo, t)) {
  const kind = tryGit(repo, ['cat-file', '-t', `refs/tags/${tag}`])?.trim();
  if (!kind) throw new Error(`baseline-check: no tag ${tag} in this repository`);
  const commit = run('git', ['rev-parse', `${tag}^{commit}`], { cwd: repo }).trim();
  const raw = kind === 'tag' ? run('git', ['cat-file', 'tag', `refs/tags/${tag}`], { cwd: repo }) : '';
  const parentCommit = tryGit(repo, ['rev-parse', `${commit}^`])?.trim() ?? null;
  return {
    commit,
    annotated: kind === 'tag',
    signed: kind === 'tag' && verifyTag(tag),
    message: raw.split('\n\n').slice(1).join('\n\n'),
    recordText: tryGit(repo, ['show', `${commit}:${recordPath(tag)}`]),
    changedFiles: parentCommit ? run('git', ['diff', '--name-only', parentCommit, commit], { cwd: repo }).split('\n').filter(Boolean) : [],
    parentCommit,
    sourceDigest: sourceDigest(treeEntries(repo, commit)),
  };
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
    // --ast names every immutable in the record (§3.2); it changes no code.
    run('forge', ['build', '--skip', 'test', '--ast'], {
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
 * Run the TAGGED tree's own `run-regression.sh --verify-shards` over the
 * record's manifests, so the plan they are checked against is the tag's, not
 * this checkout's, built from the inputs the run recorded, not this machine's. Returns its refusals (empty when it accepts). Needs no
 * forge: the plan is read from the tree's test files.
 */
export function verifyShardsAt(repo, commit, manifests, planInputs) {
  const scratch = mkdtempSync(join(tmpdir(), 'baseline-shards-'));
  const wt = join(scratch, 'tree');
  const dir = join(scratch, 'manifests');
  try {
    for (const [rel, text] of Object.entries(manifests ?? {})) {
      // A manifest key is a relative *.tsv path inside the folder, never one
      // that climbs out of it.
      if (!rel.endsWith('.tsv') || rel.startsWith('/') || rel.split('/').some((p) => p === '..' || p === '' || p === '.')) {
        return [`regression: the manifest key ${JSON.stringify(rel)} is not a relative *.tsv path`];
      }
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    run('git', ['worktree', 'add', '--detach', '--quiet', wt, commit], { cwd: repo });
    try {
      // The plan is rebuilt from the RECORDED inputs, never this machine's:
      // its chunk sizes and FORK_URL_* are dropped, the recorded ones set (a
      // name only marks a URL as present; planning never reads the value).
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CHUNK_SIZE' && k !== 'SUBDIR_CHUNK_SIZE' && !k.startsWith('FORK_URL_')));
      Object.assign(env, planInputs ?? {});
      run('bash', [join(wt, 'contracts/script/run-regression.sh'), '--verify-shards', dir], { stdio: ['ignore', 'pipe', 'pipe'], env });
      return [];
    } catch (e) {
      const said = `${e.stderr ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
      return said.length ? said.map((l) => `regression: ${l}`) : ['regression: the tagged tree\'s run-regression.sh --verify-shards refused the manifests'];
    }
  } finally {
    tryGit(repo, ['worktree', 'remove', '--force', wt]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Judge `tag`. `build(commit)` returns {outDir, cleanup}; `forgeVersion()` the
 * build tool's version line; `verifyShards(commit, regression)` the tagged
 * tree's verdict on the regression manifests, rebuilt from their recorded inputs (a list of refusals). Returns {refusals, record}.
 */
export function checkBaseline({
  repo,
  tag,
  outDir,
  build = (c) => buildAt(repo, c),
  forgeVersion,
  verifyTag,
  verifyShards = (commit, regression) => verifyShardsAt(repo, commit, regression.manifests, regression.planInputs),
}) {
  const facts = tagFacts(repo, tag, verifyTag);
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
  const budgets = tryGit(repo, ['show', `${facts.commit}:${GAS_BUDGETS_FILE}`]);
  refusals.push(...gasCompleteness(record.gas, budgets == null ? {} : JSON.parse(budgets)));
  const regressionRefusals = regressionAgreement(record.regression);
  refusals.push(...regressionRefusals);
  if (!regressionRefusals.length) refusals.push(...verifyShards(facts.commit, record.regression));
  if (!outDir) {
    const forge = forgeVersion();
    if (forge !== record.versions?.forge) {
      refusals.push(`build tool: the record was built with "${record.versions?.forge}", this machine has "${forge}"; rebuild with the recorded version`);
      return { refusals, record };
    }
  }
  let built;
  let cleanup = () => {};
  try {
    let dir = outDir;
    if (!dir) ({ outDir: dir, cleanup } = build(facts.commit));
    built = collectContracts(dir);
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
