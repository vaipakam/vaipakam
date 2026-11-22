#!/usr/bin/env node
/**
 * The baseline record generator (#3964, RefactorRulesDesign §3.2).
 *
 * Writes `contracts/baseline/<tag>.json` from the build of the current commit,
 * which must be clean. It runs no build and no test itself; it reads what the
 * steps before it already produced, so nothing is run twice:
 *
 *   - `--out DIR`: the forge build of this commit (default `contracts/out`,
 *     from `FOUNDRY_PROFILE=default forge build --skip test --ast`; the AST
 *     names every immutable);
 *   - `--gas DIR`: the gas suite's figures (default `contracts/out-gas-suite`,
 *     written by the full regression, #3915);
 *   - `--manifests DIR`: the full regression's `--manifest` files, which this
 *     tool requires `run-regression.sh --verify-shards DIR` to accept;
 *   - the storage-layout guard's recorded file, hashed as committed.
 *
 * The record names the commit it was built from and the digest of its source
 * (§3.2's rule: every tracked file but contracts/baseline/; a file cannot name
 * the commit that contains it, nor hash a tree that contains it), the tag's message carries the record's hash,
 * and the tag names the commit that adds the record: each binds the other two.
 * `docs/procedures/BaselineTagging.md` is the procedure; `baseline-check.mjs`
 * is the check.
 *
 * CLI: node contracts/script/baseline-record.mjs --tag <tag> --manifests <dir>
 *        [--out <dir>] [--gas <dir>] [--allow-dirty-for-test]
 * Prints `record sha256 <hex>`, the line the tag message carries.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECORD_SCHEMA,
  canonicalJson,
  collectContracts,
  collectGas,
  collectRegression,
  GAS_BUDGETS_FILE,
  gasCompleteness,
  recordHash,
  recordPath,
  SOURCE_DIGEST_RULE,
  sha256,
  sourceDigest,
  planEnv,
  regressionAgreement,
} from './lib/baseline.mjs';
import { librariesAt, treeEntries } from './lib/baseline-git.mjs';

const CONTRACTS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REPO = resolve(CONTRACTS_DIR, '..');
const LAYOUT_FILE = join(CONTRACTS_DIR, 'storage-layout/layout.golden.json');

const git = (args, cwd = REPO) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The build tool's version line (`forge --version`, first line). */
export function forgeVersion() {
  return execFileSync('forge', ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
}

export function buildRecord({ tag, outDir, gasDir, manifestsDir, source, forge, libraries, layoutText }) {
  const { contracts, build } = collectContracts(outDir);
  return {
    schema: RECORD_SCHEMA,
    hash: 'sha256',
    tag,
    source,
    contracts,
    storageLayout: { file: 'contracts/storage-layout/layout.golden.json', sha256: sha256(layoutText) },
    gas: collectGas(gasDir),
    regression: collectRegression(manifestsDir),
    versions: { build, forge, libraries },
  };
}

export function main(argv = process.argv.slice(2)) {
  const opt = { out: join(CONTRACTS_DIR, 'out'), gas: join(CONTRACTS_DIR, 'out-gas-suite') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--tag', '--out', '--gas', '--manifests'].includes(a) && argv[i + 1]) opt[a.slice(2)] = argv[++i];
    else if (a === '--allow-dirty-for-test') opt.dirtyOk = true;
    else {
      console.error(`baseline-record: unknown argument ${a}`);
      return 2;
    }
  }
  if (!opt.tag || !opt.manifests) {
    console.error('baseline-record: --tag and --manifests are required');
    return 2;
  }
  const rel = recordPath(opt.tag);
  // The record describes a tree; uncommitted edits would make it describe none.
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty && !opt.dirtyOk) {
    console.error(`baseline-record: the working tree has uncommitted changes; a record is made from a clean commit:\n${dirty}`);
    return 1;
  }
  const gasGaps = gasCompleteness(existsSync(opt.gas) ? collectGas(opt.gas) : {}, JSON.parse(readFileSync(join(REPO, GAS_BUDGETS_FILE), 'utf8')));
  if (gasGaps.length) {
    for (const g of gasGaps) console.error(`baseline-record: ${g}`);
    console.error(`baseline-record: the record carries a figure for every action of the gas suite (${opt.gas}; the full regression writes them, #3915)`);
    return 1;
  }
  // Verify under the plan inputs the manifests recorded, not this shell's
  // (a regression run with `CHUNK_SIZE=7 bash ...` set them for that command).
  let planInputs;
  try {
    ({ planInputs } = collectRegression(resolve(opt.manifests)));
  } catch (e) {
    console.error(`baseline-record: ${e.message.replace(/^baseline: /, '')}`);
    return 1;
  }
  try {
    execFileSync('bash', [join(CONTRACTS_DIR, 'script/run-regression.sh'), '--verify-shards', resolve(opt.manifests)], { stdio: ['ignore', 'inherit', 'inherit'], env: planEnv(planInputs) });
  } catch {
    console.error('baseline-record: run-regression.sh --verify-shards refused the manifests; the record carries a verified regression only');
    return 1;
  }
  const record = buildRecord({
    tag: opt.tag,
    outDir: opt.out,
    gasDir: opt.gas,
    manifestsDir: opt.manifests,
    source: { commit: git(['rev-parse', 'HEAD']), digest: sourceDigest(treeEntries(REPO, 'HEAD')), digestRule: SOURCE_DIGEST_RULE },
    forge: forgeVersion(),
    libraries: librariesAt(REPO, 'HEAD'),
    layoutText: readFileSync(LAYOUT_FILE),
  });
  // The same rule the check applies: a record carries a green regression whose
  // totals are what its manifests add up to.
  const regressionGaps = regressionAgreement(record.regression);
  if (regressionGaps.length) {
    for (const g of regressionGaps) console.error(`baseline-record: ${g}`);
    return 1;
  }
  const text = canonicalJson(record);
  const dest = join(REPO, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  console.log(`wrote ${rel}: ${Object.keys(record.contracts).length} contracts, ${Object.keys(record.gas).length} gas actions, ${record.regression.chunks} regression chunks`);
  console.log(`record sha256 ${recordHash(text)}`);
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
