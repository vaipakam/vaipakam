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
  deployables,
  interfaceHash,
  readArtifacts,
  recordHash,
  recordPath,
  sourceDigest,
} from '../../../contracts/script/lib/baseline.mjs';
import { treeEntries } from '../../../contracts/script/lib/baseline-git.mjs';
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

/** A forge out/ folder; each artifact's compilation target is src/<name>.sol unless it names its own. */
function outDir(map) {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-out-'));
  for (const [name, art] of Object.entries(map)) {
    const a = structuredClone(art);
    a.metadata.settings = { ...a.metadata.settings, compilationTarget: a.target ?? { [`src/${name}.sol`]: name } };
    delete a.target;
    mkdirSync(join(dir, `${name}.sol`), { recursive: true });
    writeFileSync(join(dir, `${name}.sol`, `${name}.json`), JSON.stringify(a));
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

test('deployables are every contract compiled from src/ with runtime code, whatever ships an ABI', () => {
  const dir = outDir({
    A: artifact('60'),
    Lib: { ...artifact('60'), target: { 'lib/x/Lib.sol': 'Lib' } },
    Iface: artifact(''),
    Mirror: { ...artifact('61'), target: { 'src/crosschain/Mirror.sol': 'Mirror' } },
  });
  assert.deepEqual([...deployables(readArtifacts(dir)).keys()].sort(), ['src/A.sol:A', 'src/crosschain/Mirror.sol:Mirror']);
});

test('a build mixing compilers or settings is refused by name', () => {
  const dir = outDir({ A: artifact('60'), B: artifact('61', ABI, '0.8.30+commit.x') });
  assert.throws(() => collectContracts(dir), /src\/B\.sol:B was built with .*0\.8\.30.* but src\/A\.sol:A with/s);
});

test('an immutable is blanked before hashing and recorded by name; a build without names is refused', () => {
  const ast = { nodeType: 'SourceUnit', nodes: [{ nodeType: 'ContractDefinition', name: 'V', nodes: [{ nodeType: 'VariableDeclaration', id: 7, name: 'TREASURY', mutability: 'immutable' }] }] };
  const withValue = (v) => ({ ...artifact(`60${v}00`), deployedBytecode: { object: `0x60${v}00`, immutableReferences: { 7: [{ start: 1, length: 1 }] } } });
  const names = new Map([[7, 'V.TREASURY']]);
  const a = contractEntry(withValue('aa'), names);
  const b = contractEntry(withValue('bb'), names);
  assert.equal(a.runtimeHash, b.runtimeHash, 'a value fixed at construction does not change the hash');
  assert.deepEqual(a.immutables, [{ name: 'V.TREASURY', ranges: [{ start: 1, length: 1 }] }]);
  assert.throws(() => contractEntry(withValue('aa')), /immutable #7 has no name in this build; build with --ast/);
  const dir = outDir({ V: { ...withValue('aa'), ast } });
  assert.deepEqual(collectContracts(dir).contracts['src/V.sol:V'].immutables, a.immutables);
});

test('the source digest leaves the baseline records out and does not depend on order', () => {
  const e = [{ path: 'b.txt', oid: '2' }, { path: 'a.txt', oid: '1' }];
  const d = sourceDigest(e);
  assert.equal(sourceDigest([...e].reverse()), d);
  assert.equal(sourceDigest([...e, { path: 'contracts/baseline/v1.json', oid: '9' }]), d);
  assert.notEqual(sourceDigest([{ path: 'a.txt', oid: '1' }, { path: 'b.txt', oid: '3' }]), d);
});

test('the regression section keeps every manifest, at any depth, and adds up chunks and tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-man-'));
  mkdirSync(join(dir, 'machine2'));
  writeFileSync(join(dir, 'shard-1.tsv'), 'plan\tabc\nshard\t1/2\npass\ttest/{A}.t.sol\ntests\ttest/{A}.t.sol\t10\t10\ncomplete\t1\n');
  writeFileSync(join(dir, 'machine2/shard-2.tsv'), 'plan\tabc\nshard\t2/2\npass\ttest/{B}.t.sol\ntests\ttest/{B}.t.sol\t5\t5\ncomplete\t1\n');
  const r = collectRegression(dir);
  assert.deepEqual([r.planDigest, r.chunks, r.chunksPassed, r.testsRun, r.testsPassed], ['abc', 2, 2, 15, 15]);
  assert.deepEqual(Object.keys(r.manifests), ['machine2/shard-2.tsv', 'shard-1.tsv']);
  writeFileSync(join(dir, 'machine2/shard-2.tsv'), 'plan\tabc\nshard\t2/2\npass\ttest/{B}.t.sol\ncomplete\t1\n');
  assert.throws(() => collectRegression(dir), /the chunk test\/\{B\}\.t\.sol has no test counts/);
  writeFileSync(join(dir, 'machine2/shard-2.tsv'), 'plan\tabc\nshard\t2/2\npass\ttest/{B}.t.sol\ntests\ttest/{B}.t.sol\t5\tx\ncomplete\t1\n');
  assert.throws(() => collectRegression(dir), /not two whole numbers/);
  writeFileSync(join(dir, 'machine2/shard-2.tsv'), 'plan\tother\nshard\t2/2\n');
  assert.throws(() => collectRegression(dir), /2 plan digests/);
});

test('the comparison names the compiler first, then every contract difference', () => {
  const dir = outDir({ A: artifact('60'), B: artifact('61') });
  const built = collectContracts(dir);
  const record = { contracts: structuredClone(built.contracts), versions: { build: built.build } };
  assert.deepEqual(compareBuild(record, built), []);
  record.contracts['src/A.sol:A'].runtimeHash = '0'.repeat(64);
  record.contracts['src/B.sol:B'].size = 9;
  record.contracts['src/B.sol:B'].immutables = [{ name: 'B.X', ranges: [{ start: 0, length: 1 }] }];
  record.contracts.C = { runtimeHash: '1'.repeat(64), size: 1, interfaceHash: '2'.repeat(64) };
  const other = { ...built, build: { ...built.build, compiler: '0.8.30+commit.x' } };
  const d = compareBuild(record, other);
  assert.match(d[0], /compiler: the record was built with 0\.8\.29\+commit\.ab55807c, this build with 0\.8\.30/);
  assert.ok(d.some((x) => /^src\/A\.sol:A: runtime code hash/.test(x)));
  assert.ok(d.some((x) => /^src\/B\.sol:B: 1 bytes, the record has 9/.test(x)));
  assert.ok(d.some((x) => /^src\/B\.sol:B: immutables \[\], the record has/.test(x)));
  assert.ok(d.some((x) => /^C: in the record, not in this build/.test(x)));
});

test('the tag facts: annotated, signed, its message carrying the record hash, its commit adding only the record', () => {
  const tag = 'v0.9-pre-refactor';
  const recordText = canonicalJson({ tag, source: { commit: 'c1', digest: 'd1' } });
  const good = { annotated: true, signed: true, message: `Baseline\n\nrecord sha256 ${recordHash(recordText)}\n`, recordText, changedFiles: [recordPath(tag)], parentCommit: 'c1', sourceDigest: 'd1' };
  assert.deepEqual(checkTagFacts(tag, good), []);
  assert.match(checkTagFacts(tag, { ...good, annotated: false }).join(), /lightweight/);
  assert.match(checkTagFacts(tag, { ...good, signed: false }).join(), /signature does not verify \(git tag -v\)/);
  assert.match(checkTagFacts(tag, { ...good, message: 'no line' }).join(), /no "record sha256 <hash>" line/);
  assert.match(checkTagFacts(tag, { ...good, message: `record sha256 ${'0'.repeat(64)}` }).join(), /carries record hash 0+, but/);
  assert.match(checkTagFacts(tag, { ...good, changedFiles: [recordPath(tag), 'contracts/src/X.sol'] }).join(), /changes more than the record: contracts\/src\/X\.sol/);
  assert.match(checkTagFacts(tag, { ...good, sourceDigest: 'd2' }).join(), /names source digest d1, but the tagged commit, baseline records left out, digests to d2/);
  assert.throws(() => recordPath('main'), /not a tag name/);
});

// ─── Against a real repository ─────────────────────────────────────────────

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** A repository with one deployable and a tag of the series made the documented way (unsigned unless a key is given). */
function repoWithTag(tag, { extraFile = false, wrongHash = false, message } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'baseline-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'contracts/storage-layout'), { recursive: true });
  mkdirSync(join(repo, 'contracts/lib/dep'), { recursive: true });
  writeFileSync(join(repo, 'contracts/storage-layout/layout.golden.json'), '{"layout":1}\n');
  writeFileSync(join(repo, 'contracts/lib/dep/x.sol'), '// dep\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'source');
  const source = { commit: git(repo, 'rev-parse', 'HEAD'), digest: sourceDigest(treeEntries(repo, 'HEAD')) };
  const dir = outDir({ A: artifact('6001') });
  const built = collectContracts(dir);
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
  git(repo, 'tag', '-a', tag, '-m', message ?? `${tag}\n\nrecord sha256 ${h}`);
  return { repo, dir };
}

const verified = () => true;

test('the check against a real repository: a tag git cannot verify is refused, a verified good tag passes', () => {
  const tag = 'v0.9-pre-refactor';
  const { repo, dir } = repoWithTag(tag);
  try {
    assert.deepEqual(checkBaseline({ repo, tag, outDir: dir }).refusals, [`${tag}'s signature does not verify (git tag -v) with the keys this machine trusts; the series is signed`]);
    assert.deepEqual(checkBaseline({ repo, tag, outDir: dir, verifyTag: verified }).refusals, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a message that only looks signed is refused: git verifies the signature', () => {
  const tag = 'v0.9-pre-refactor';
  const { repo, dir } = repoWithTag(tag, { message: 'x\n\n-----BEGIN SSH SIGNATURE-----\nnot a signature\n-----END SSH SIGNATURE-----\n' });
  try {
    const { refusals } = checkBaseline({ repo, tag, outDir: dir });
    assert.ok(refusals.some((x) => /signature does not verify/.test(x)), refusals.join('\n'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the check refuses a build that differs, a commit that changes more than the record and a wrong tag hash', () => {
  const tag = 'v0.9-pre-refactor';
  const a = repoWithTag(tag);
  const other = outDir({ A: artifact('6002') });
  const r1 = checkBaseline({ repo: a.repo, tag, outDir: other, verifyTag: verified }).refusals;
  assert.ok(r1.some((x) => /^src\/A\.sol:A: runtime code hash/.test(x)), r1.join('\n'));
  const compilerChanged = outDir({ A: artifact('6001', ABI, '0.8.30+commit.x') });
  const r2 = checkBaseline({ repo: a.repo, tag, outDir: compilerChanged, verifyTag: verified }).refusals;
  assert.ok(r2.some((x) => /compiler: the record was built with 0\.8\.29\+commit\.ab55807c, this build with 0\.8\.30\+commit\.x/.test(x)), r2.join('\n'));
  rmSync(a.repo, { recursive: true, force: true });

  const b = repoWithTag(tag, { extraFile: true, wrongHash: true });
  const r3 = checkBaseline({ repo: b.repo, tag, outDir: b.dir, verifyTag: verified }).refusals;
  assert.ok(r3.some((x) => /changes more than the record: contracts\/storage-layout\/sneaky\.txt/.test(x)), r3.join('\n'));
  assert.ok(r3.some((x) => /carries record hash f+, but/.test(x)), r3.join('\n'));
  rmSync(b.repo, { recursive: true, force: true });
});

test('without --out the check refuses another build tool by name and builds nothing', () => {
  const tag = 'v0.9-pre-refactor';
  const { repo } = repoWithTag(tag);
  let built = false;
  try {
    const { refusals } = checkBaseline({ repo, tag, verifyTag: verified, forgeVersion: () => 'forge 1.9.0', build: () => { built = true; return {}; } });
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
    const { refusals } = checkBaseline({ repo, tag, outDir: dir, verifyTag: verified });
    assert.ok(refusals.some((x) => /names source digest [0-9a-f]+, but the tagged commit, baseline records left out, digests to/.test(x)), refusals.join('\n'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
