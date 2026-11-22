// The baseline record and its check (#3964, RefactorRulesDesign §3.2):
// the record's rules on plain data, and the check against real git repositories
// built in a temporary folder (the build itself is a fake: the check is told
// where a build is, and judges it by content).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  checkTagFacts,
  collectContracts,
  collectRegression,
  compareBuild,
  contractEntry,
  deployableNames,
  interfaceHash,
  recordHash,
  recordPath,
} from '../../../contracts/script/lib/baseline.mjs';
import { checkBaseline } from '../../../contracts/script/baseline-check.mjs';

const ABI = [
  { type: 'function', name: 'f', inputs: [{ name: 'a', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'event', name: 'E', inputs: [{ name: 'x', type: 'address', indexed: true }], anonymous: false },
  { type: 'error', name: 'Err', inputs: [] },
];
const SETTINGS = { compiler: { version: '0.8.29+commit.ab55807c' }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'prague', compilationTarget: { 'src/A.sol': 'A' }, remappings: ['x=y'] } };

function artifact(code, abi = ABI, compiler = SETTINGS.compiler.version, settings = SETTINGS.settings) {
  return { abi, deployedBytecode: { object: `0x${code}` }, metadata: { compiler: { version: compiler }, settings } };
}

function outDir(map) {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-out-'));
  for (const [name, art] of Object.entries(map)) {
    mkdirSync(join(dir, `${name}.sol`), { recursive: true });
    writeFileSync(join(dir, `${name}.sol`, `${name}.json`), JSON.stringify(art));
  }
  return dir;
}

test('the interface hash ignores parameter names and order of entries, and sees a type change', () => {
  const renamed = structuredClone(ABI);
  renamed[0].inputs[0].name = 'renamed';
  assert.equal(interfaceHash(renamed), interfaceHash(ABI));
  assert.equal(interfaceHash([...ABI].reverse()), interfaceHash(ABI));
  const retyped = structuredClone(ABI);
  retyped[0].inputs[0].type = 'uint128';
  assert.notEqual(interfaceHash(retyped), interfaceHash(ABI));
  const unindexed = structuredClone(ABI);
  unindexed[1].inputs[0].indexed = false;
  assert.notEqual(interfaceHash(unindexed), interfaceHash(ABI));
  const constructorOnly = [...ABI, { type: 'constructor', inputs: [] }];
  assert.equal(interfaceHash(constructorOnly), interfaceHash(ABI), 'only functions, events and errors count');
});

test('a contract entry is the runtime code hash, its size in bytes and the interface hash', () => {
  const e = contractEntry(artifact('6001600055'));
  assert.equal(e.size, 5);
  assert.match(e.runtimeHash, /^[0-9a-f]{64}$/);
  assert.equal(e.interfaceHash, interfaceHash(ABI));
  assert.throws(() => contractEntry({ abi: [], deployedBytecode: { object: '0x' } }), /no runtime code/);
});

test('deployables are the facets, the proxy and the standalone contracts, each once', () => {
  assert.deepEqual(deployableNames({ facets: ['B', 'A'], proxy: ['P'], standalone: ['S'] }), ['A', 'B', 'P', 'S']);
  assert.throws(() => deployableNames({ facets: ['A'], standalone: ['A'] }), /named twice/);
});

test('a build mixing compilers or settings is refused by name', () => {
  const dir = outDir({ A: artifact('60'), B: artifact('61', ABI, '0.8.30+commit.x') });
  assert.throws(() => collectContracts(dir, ['A', 'B']), /B was built with .*0\.8\.30.* but A with/s);
  const dir2 = outDir({ A: artifact('60') });
  assert.throws(() => collectContracts(dir2, ['A', 'Missing']), /no artifact for Missing/);
});

test('the regression section keeps every manifest and adds up chunks and tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-man-'));
  writeFileSync(join(dir, 'shard-1.tsv'), 'plan\tabc\nshard\t1/2\npass\ttest/{A}.t.sol\ntests\ttest/{A}.t.sol\t10\t10\ncomplete\t1\n');
  writeFileSync(join(dir, 'shard-2.tsv'), 'plan\tabc\nshard\t2/2\npass\ttest/{B}.t.sol\ntests\ttest/{B}.t.sol\t5\t5\ncomplete\t1\n');
  const r = collectRegression(dir);
  assert.deepEqual([r.planDigest, r.chunks, r.chunksPassed, r.testsRun, r.testsPassed], ['abc', 2, 2, 15, 15]);
  assert.equal(Object.keys(r.manifests).length, 2);
  writeFileSync(join(dir, 'shard-2.tsv'), 'plan\tother\nshard\t2/2\n');
  assert.throws(() => collectRegression(dir), /2 plan digests/);
});

test('the comparison names the compiler first, then every contract difference', () => {
  const dir = outDir({ A: artifact('60'), B: artifact('61') });
  const built = collectContracts(dir, ['A', 'B']);
  const record = { contracts: structuredClone(built.contracts), versions: { build: built.build } };
  assert.deepEqual(compareBuild(record, built), []);
  record.contracts.A.runtimeHash = '0'.repeat(64);
  record.contracts.B.size = 9;
  record.contracts.C = { runtimeHash: '1'.repeat(64), size: 1, interfaceHash: '2'.repeat(64) };
  const other = { ...built, build: { ...built.build, compiler: '0.8.30+commit.x' } };
  const d = compareBuild(record, other);
  assert.match(d[0], /compiler: the record was built with 0\.8\.29\+commit\.ab55807c, this build with 0\.8\.30/);
  assert.ok(d.some((x) => /^A: runtime code hash/.test(x)));
  assert.ok(d.some((x) => /^B: 1 bytes, the record has 9/.test(x)));
  assert.ok(d.some((x) => /^C: in the record, not in this build/.test(x)));
});

test('the tag facts: annotated, signed, its message carrying the record hash, its commit adding only the record', () => {
  const tag = 'v0.9-pre-refactor';
  const recordText = canonicalJson({ tag, source: { commit: 'c1', tree: 't1' } });
  const good = { annotated: true, signed: true, message: `Baseline\n\nrecord sha256 ${recordHash(recordText)}\n`, recordText, changedFiles: [recordPath(tag)], parentCommit: 'c1', parentTree: 't1' };
  assert.deepEqual(checkTagFacts(tag, good), []);
  assert.match(checkTagFacts(tag, { ...good, annotated: false }).join(), /lightweight/);
  assert.match(checkTagFacts(tag, { ...good, signed: false }).join(), /no signature/);
  assert.match(checkTagFacts(tag, { ...good, message: 'no line' }).join(), /no "record sha256 <hash>" line/);
  assert.match(checkTagFacts(tag, { ...good, message: `record sha256 ${'0'.repeat(64)}` }).join(), /carries record hash 0+, but/);
  assert.match(checkTagFacts(tag, { ...good, changedFiles: [recordPath(tag), 'contracts/src/X.sol'] }).join(), /changes more than the record: contracts\/src\/X\.sol/);
  assert.match(checkTagFacts(tag, { ...good, parentTree: 't2' }).join(), /built from tree t1, but the tagged commit's parent has tree t2/);
  assert.throws(() => recordPath('main'), /not a tag name/);
});

// ─── Against a real repository ─────────────────────────────────────────────

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** A repository with one deployable and a tag of the series made the documented way (unsigned unless a key is given). */
function repoWithTag(tag, { extraFile = false, wrongHash = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'baseline-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'packages/contracts/scripts'), { recursive: true });
  mkdirSync(join(repo, 'contracts/storage-layout'), { recursive: true });
  mkdirSync(join(repo, 'contracts/lib/dep'), { recursive: true });
  writeFileSync(join(repo, 'packages/contracts/scripts/diamond-facets.json'), JSON.stringify({ facets: ['A'], proxy: [], standalone: [] }));
  writeFileSync(join(repo, 'contracts/storage-layout/layout.golden.json'), '{"layout":1}\n');
  writeFileSync(join(repo, 'contracts/lib/dep/x.sol'), '// dep\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'source');
  const source = { commit: git(repo, 'rev-parse', 'HEAD'), tree: git(repo, 'rev-parse', 'HEAD^{tree}') };
  const dir = outDir({ A: artifact('6001') });
  const built = collectContracts(dir, ['A']);
  const libLine = git(repo, 'ls-tree', 'HEAD', 'contracts/lib/').split('\n')[0];
  const [meta] = libLine.split('\t');
  const record = {
    tag,
    source,
    contracts: built.contracts,
    storageLayout: { file: 'contracts/storage-layout/layout.golden.json', sha256: execFileSync('sha256sum', [join(repo, 'contracts/storage-layout/layout.golden.json')], { encoding: 'utf8' }).split(' ')[0] },
    versions: { build: built.build, forge: 'forge 1.8.6', libraries: { dep: { type: 'vendored', hash: meta.split(' ')[2] } } },
  };
  const text = canonicalJson(record);
  mkdirSync(join(repo, 'contracts/baseline'), { recursive: true });
  writeFileSync(join(repo, recordPath(tag)), text);
  if (extraFile) writeFileSync(join(repo, 'contracts/storage-layout/sneaky.txt'), 'x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `Baseline record for ${tag}`);
  const h = wrongHash ? 'f'.repeat(64) : recordHash(text);
  git(repo, 'tag', '-a', tag, '-m', `${tag}\n\nrecord sha256 ${h}`);
  return { repo, dir };
}

test('the check against a real repository: an unsigned tag is refused, the rest of a good tag passes', () => {
  const tag = 'v0.9-pre-refactor';
  const { repo, dir } = repoWithTag(tag);
  try {
    const { refusals } = checkBaseline({ repo, tag, outDir: dir });
    assert.deepEqual(refusals, [`${tag} carries no signature; the series is signed`]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the check refuses a build that differs, a commit that changes more than the record and a wrong tag hash', () => {
  const tag = 'v0.9-pre-refactor';
  const a = repoWithTag(tag);
  const other = outDir({ A: artifact('6002') });
  const r1 = checkBaseline({ repo: a.repo, tag, outDir: other }).refusals;
  assert.ok(r1.some((x) => /^A: runtime code hash/.test(x)), r1.join('\n'));
  const compilerChanged = outDir({ A: artifact('6001', ABI, '0.8.30+commit.x') });
  const r2 = checkBaseline({ repo: a.repo, tag, outDir: compilerChanged }).refusals;
  assert.ok(r2.some((x) => /compiler: the record was built with 0\.8\.29\+commit\.ab55807c, this build with 0\.8\.30\+commit\.x/.test(x)), r2.join('\n'));
  rmSync(a.repo, { recursive: true, force: true });

  const b = repoWithTag(tag, { extraFile: true, wrongHash: true });
  const r3 = checkBaseline({ repo: b.repo, tag, outDir: b.dir }).refusals;
  assert.ok(r3.some((x) => /changes more than the record: contracts\/storage-layout\/sneaky\.txt/.test(x)), r3.join('\n'));
  assert.ok(r3.some((x) => /carries record hash f+, but/.test(x)), r3.join('\n'));
  rmSync(b.repo, { recursive: true, force: true });
});

test('without --out the check refuses another build tool by name and builds nothing', () => {
  const tag = 'v0.9-pre-refactor';
  const { repo } = repoWithTag(tag);
  let built = false;
  try {
    const { refusals } = checkBaseline({ repo, tag, forgeVersion: () => 'forge 1.9.0', build: () => { built = true; return {}; } });
    assert.ok(refusals.some((x) => /build tool: the record was built with "forge 1\.8\.6", this machine has "forge 1\.9\.0"/.test(x)), refusals.join('\n'));
    assert.equal(built, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a record from another source tree is refused', () => {
  const tag = 'v0.9-pre-refactor';
  const { repo, dir } = repoWithTag(tag);
  try {
    // Re-tag on a later commit whose parent is not the record's source.
    writeFileSync(join(repo, 'later.txt'), 'x');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'later');
    git(repo, 'tag', '-d', tag);
    git(repo, 'tag', '-a', tag, '-m', 'x');
    const { refusals } = checkBaseline({ repo, tag, outDir: dir });
    assert.ok(refusals.some((x) => /but the tagged commit's parent has tree/.test(x)), refusals.join('\n'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
