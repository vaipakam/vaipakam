/**
 * The baseline record's rules, shared by its generator and its check (#3964,
 * RefactorRulesDesign §3.2 "What tagged means").
 *
 * A record describes one build of one source tree: for every deployable
 * contract its runtime code hash, size and interface hash; the storage layout's
 * recorded file; the gas suite's figures; the full regression's manifests; the
 * compiler, its settings, the build tool and every vendored library; and the
 * digest of the source tree (§3.2's rule, baseline records left out). Every hash here is SHA-256, written as 64 lower-case hex
 * characters, and named so in the record (`hash: "sha256"`).
 *
 * Nothing here runs a build or reads git: the two command-line tools do that
 * and hand the results in, so every rule below is tested on plain data.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RECORD_SCHEMA = 1;
export const RECORD_DIR = 'contracts/baseline';
/** The tag message line that binds the tag to its record. */
export const TAG_LINE_RE = /^record sha256 ([0-9a-f]{64})$/m;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The record's path in the repository, from its tag. */
export function recordPath(tag) {
  if (!/^v[0-9][0-9A-Za-z.\-]*$/.test(tag)) throw new Error(`baseline: "${tag}" is not a tag name of the series (v<version>…)`);
  return `${RECORD_DIR}/${tag}.json`;
}

/** JSON with every object's keys sorted, two-space indented, newline-terminated: one text per value. */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** Byte-wise path order (LC_ALL=C), so every machine sorts alike. */
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * The source digest rule (§3.2): every tracked file of a commit except those
 * under `contracts/baseline/`, as the sorted lines "<path>\t<git object id>\n"
 * (a file's id is the hash of its content; a submodule's is its pinned
 * commit), hashed once with SHA-256. `entries` is [{path, oid}].
 */
export const SOURCE_DIGEST_RULE = 'sha256 over the byte-sorted lines "<path>\\t<git object id>\\n" of every tracked file, contracts/baseline/ left out';
export function sourceDigest(entries) {
  const lines = entries
    .filter((e) => !e.path.startsWith(`${RECORD_DIR}/`))
    .map((e) => e.path)
    .sort(byBytes);
  const oid = new Map(entries.map((e) => [e.path, e.oid]));
  return sha256(lines.map((p) => `${p}\t${oid.get(p)}\n`).join(''));
}

/**
 * One ABI entry as the interface hash sees it: its kind, name, parameter types
 * (with `indexed` for events), outputs and mutability. Parameter NAMES are left
 * out: renaming an argument changes no caller.
 */
function abiShape(e) {
  const params = (ps = []) => ps.map((p) => ({
    type: p.type,
    ...(p.components ? { components: params(p.components) } : {}),
    ...(e.type === 'event' ? { indexed: !!p.indexed } : {}),
  }));
  const shape = { type: e.type, name: e.name, inputs: params(e.inputs) };
  if (e.type === 'function') {
    shape.outputs = params(e.outputs);
    shape.stateMutability = e.stateMutability;
  }
  if (e.type === 'event') shape.anonymous = !!e.anonymous;
  return shape;
}

/** The hash of a contract's interface: its functions, events and errors, in a fixed order. */
export function interfaceHash(abi) {
  const entries = abi
    .filter((e) => e.type === 'function' || e.type === 'event' || e.type === 'error')
    .map((e) => canonicalJson(abiShape(e)))
    .sort();
  return sha256(entries.join(''));
}

const metadataOf = (artifact) => (typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata);

/**
 * Every artifact in a forge `out/` directory (one level of `<File>.sol/`
 * folders), with the source it was compiled from: [{key, artifact}], where the
 * key is "<source path>:<contract name>".
 */
export function readArtifacts(outDir) {
  const out = [];
  for (const d of readdirSync(outDir).sort(byBytes)) {
    const dir = join(outDir, d);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files.sort(byBytes)) {
      if (!f.endsWith('.json')) continue;
      const artifact = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const target = Object.entries(metadataOf(artifact)?.settings?.compilationTarget ?? {})[0];
      if (target) out.push({ key: `${target[0]}:${target[1]}`, artifact });
    }
  }
  return out;
}

/**
 * The deployables: every contract compiled from `src/` that has runtime code.
 * The rule reads the build itself, never a hand-kept list, so a contract a
 * deploy script creates is in the record whether or not an app ships its ABI.
 */
export function deployables(artifacts) {
  const out = new Map();
  for (const { key, artifact } of artifacts) {
    if (!key.startsWith('src/')) continue;
    if (!String(artifact.deployedBytecode?.object ?? '').replace(/^0x/, '')) continue;
    if (out.has(key)) throw new Error(`baseline: ${key} has two artifacts; one build has one of each contract`);
    out.set(key, artifact);
  }
  return out;
}

/**
 * The names of the build's immutables, by AST id: "<contract>.<variable>".
 * Read from the artifacts' ASTs, which a build made with `--ast` carries.
 */
export function immutableNames(artifacts) {
  const names = new Map();
  const walk = (node, contract) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, contract);
      return;
    }
    const here = node.nodeType === 'ContractDefinition' ? node.name : contract;
    if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable') {
      const name = `${here}.${node.name}`;
      // One compilation gives each declaration one id. Two names for one id
      // mean the folder mixes compilations (an incremental or stale build), and
      // a reference could take the wrong name, so it is refused, never guessed.
      if (names.has(node.id) && names.get(node.id) !== name) {
        throw new Error(`baseline: AST id ${node.id} names both ${names.get(node.id)} and ${name}; the build folder mixes compilations, build afresh`);
      }
      names.set(node.id, name);
    }
    for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') walk(node[k], here);
  };
  for (const { artifact } of artifacts) if (artifact.ast) walk(artifact.ast, null);
  return names;
}

/**
 * What a record holds for one contract, from its forge artifact: the runtime
 * code hash with every value fixed at construction blanked (§3.2), its size,
 * its interface hash and, when it has any, its immutables by name with the
 * byte ranges blanked, so a deployed copy can be compared on any chain.
 */
export function contractEntry(artifact, names = new Map()) {
  const hex = String(artifact.deployedBytecode?.object ?? '').replace(/^0x/, '');
  if (!hex || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) throw new Error('baseline: artifact carries no runtime code');
  const code = Buffer.from(hex, 'hex');
  const immutables = [];
  for (const [id, ranges] of Object.entries(artifact.deployedBytecode?.immutableReferences ?? {})) {
    const name = names.get(Number(id));
    if (!name) throw new Error(`baseline: immutable #${id} has no name in this build; build with --ast so every immutable is recorded by name`);
    const rs = ranges.map((r) => ({ start: r.start, length: r.length })).sort((a, b) => a.start - b.start);
    for (const r of rs) {
      if (r.start < 0 || r.start + r.length > code.length) throw new Error(`baseline: immutable ${name} lies outside the runtime code`);
      code.fill(0, r.start, r.start + r.length);
    }
    immutables.push({ name, ranges: rs });
  }
  immutables.sort((a, b) => byBytes(a.name, b.name));
  const meta = metadataOf(artifact);
  return {
    runtimeHash: sha256(code),
    size: code.length,
    interfaceHash: interfaceHash(artifact.abi ?? []),
    ...(immutables.length ? { immutables } : {}),
    compiler: meta?.compiler?.version,
  };
}

/** The compiler settings that change code, from an artifact's metadata (its own target left out). */
export function codeSettings(artifact) {
  const meta = metadataOf(artifact);
  if (!meta?.settings) throw new Error('baseline: artifact carries no metadata settings');
  const { compilationTarget, remappings, ...rest } = meta.settings;
  return { compiler: meta.compiler?.version, settings: rest };
}

/**
 * Read every deployable's entry from `outDir`. All must have been built by one
 * compiler with one set of settings; a mixed build is refused by name.
 */
export function collectContracts(outDir) {
  const artifacts = readArtifacts(outDir);
  const found = deployables(artifacts);
  if (!found.size) throw new Error(`baseline: no contract compiled from src/ in ${outDir}`);
  const needNames = [...found.values()].some((a) => Object.keys(a.deployedBytecode?.immutableReferences ?? {}).length);
  const names = needNames ? immutableNames(artifacts) : new Map();
  const contracts = {};
  let build;
  for (const [n, art] of [...found].sort((a, b) => byBytes(a[0], b[0]))) {
    const { compiler, ...entry } = contractEntry(art, names);
    contracts[n] = entry;
    const s = codeSettings(art);
    const text = canonicalJson(s);
    if (!build) build = { text, value: s, from: n };
    else if (build.text !== text) {
      throw new Error(`baseline: ${n} was built with ${text.trim()} but ${build.from} with ${build.text.trim()}: one build, one compiler`);
    }
    if (compiler && compiler !== s.compiler) throw new Error(`baseline: ${n} reports two compilers`);
  }
  return { contracts, build: build?.value };
}

/** The gas suite's figures, by action, probes (names starting `_`) left out. */
export function collectGas(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const { action, ...figures } = m;
    out[action ?? f.slice(0, -5)] = figures;
  }
  return out;
}

/**
 * The gas section against the suite's own list of actions (the budgets file,
 * `contracts/gas-suite/budgets.json`, which the budget check holds equal to
 * the suite): every action measured once, none missing and none extra. A
 * sharded regression writes each shard's figures on its own machine, so a
 * missing action is named here rather than recorded as absent.
 */
export const GAS_BUDGETS_FILE = 'contracts/gas-suite/budgets.json';
export function gasCompleteness(gas, budgets) {
  const want = Object.keys(budgets?.actions ?? {});
  const have = Object.keys(gas ?? {});
  const out = [];
  if (!want.length) out.push(`gas: ${GAS_BUDGETS_FILE} lists no actions`);
  const missing = want.filter((a) => !have.includes(a)).sort(byBytes);
  const extra = have.filter((a) => !want.includes(a)).sort(byBytes);
  if (missing.length) out.push(`gas: no figures for ${missing.join(', ')}; collect every shard's out-gas-suite/ into one folder`);
  if (extra.length) out.push(`gas: figures for ${extra.join(', ')}, which ${GAS_BUDGETS_FILE} does not list`);
  return out;
}

/**
 * The full regression's manifests (`run-regression.sh --manifest`), kept as
 * written so `--verify-shards` can be run on them again, plus what they add up
 * to. A manifest line `tests <glob> <run> <passed>` carries a chunk's counts.
 */
export function collectRegression(dir) {
  if (!existsSync(dir)) throw new Error(`baseline: no regression manifests at ${dir}`);
  // The same set `--verify-shards` reads: every *.tsv under the folder, at any
  // depth, keyed by its path relative to the folder.
  const files = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && e.name.endsWith('.tsv')) files.push(r);
    }
  };
  walk('');
  files.sort(byBytes);
  if (!files.length) throw new Error(`baseline: no *.tsv regression manifests in ${dir}`);
  const manifests = {};
  for (const f of files) manifests[f] = readFileSync(join(dir, f), 'utf8');
  return regressionFromManifests(manifests);
}

/**
 * The regression section from the manifests' text, keyed by relative path:
 * the one plan digest, the chunk and test totals, and the manifests
 * themselves. Throws, naming the manifest, on a count row missing or malformed.
 */
export function regressionFromManifests(manifests) {
  const files = Object.keys(manifests).sort(byBytes);
  if (!files.length) throw new Error('baseline: the regression section carries no manifests');
  const digests = new Set();
  let planInputs = null;
  let source = null;
  let chunks = 0;
  let passed = 0;
  let testsRun = 0;
  let testsPassed = 0;
  for (const f of files) {
    const text = manifests[f];
    // The inputs the plan was built from (run-regression.sh writes them), so
    // a verifier elsewhere rebuilds the same plan. Every manifest names the same.
    const inputs = {};
    for (const line of text.split('\n')) {
      const [k, name, value] = line.split('\t');
      if (k !== 'input') continue;
      const known =
        name === 'CHUNK_SIZE' || name === 'SUBDIR_CHUNK_SIZE'
          ? /^[1-9]\d*$/.test(value ?? '')
          : name === 'INVARIANTS'
            ? value === '0' || value === '1'
            : /^FORK_URL_[A-Z0-9_]+$/.test(name ?? '') && value === 'set';
      if (!known || name in inputs) throw new Error(`baseline: ${f}: the input row "${line}" is not a chunk size, the invariants switch or a FORK_URL_* name marked set, or repeats one`);
      inputs[name] = value;
    }
    if (!('CHUNK_SIZE' in inputs) || !('SUBDIR_CHUNK_SIZE' in inputs) || !('INVARIANTS' in inputs)) {
      throw new Error(`baseline: ${f}: no plan inputs (chunk sizes, invariants switch); run the regression again with this tree's run-regression.sh`);
    }
    // The tree the run tested: the plan digest covers file names, not
    // contents, so this binds the results to a source.
    const sources = text.split('\n').filter((l) => l.startsWith('source\t')).map((l) => l.split('\t'));
    if (sources.length !== 1 || !/^[0-9a-f]{40,64}$/.test(sources[0][1] ?? '') || !['clean', 'dirty'].includes(sources[0][2])) {
      throw new Error(`baseline: ${f}: no "source <commit> clean|dirty" row naming the tree it tested; run the regression again with this tree's run-regression.sh`);
    }
    const src = { commit: sources[0][1], clean: sources[0][2] === 'clean' };
    if (source && canonicalJson(source) !== canonicalJson(src)) throw new Error(`baseline: ${f}: it tested ${src.commit}, another manifest ${source.commit}; one regression tests one tree`);
    source = src;
    if (planInputs && canonicalJson(planInputs) !== canonicalJson(inputs)) throw new Error(`baseline: ${f}: its plan inputs differ from another manifest's; one regression has one plan`);
    planInputs = inputs;
    // Every chunk the manifest records carries exactly one count row, so the
    // record states measured figures, never a zero for a count it lacks.
    const ran = [];
    const counts = new Map();
    for (const line of text.split('\n')) {
      const [k, a, b, c] = line.split('\t');
      if (k === 'plan') digests.add(a);
      else if (k === 'pass' || k === 'fail') {
        chunks++;
        if (k === 'pass') passed++;
        ran.push(a);
      } else if (k === 'tests') {
        if (!/^\d+$/.test(b ?? '') || !/^\d+$/.test(c ?? '')) throw new Error(`baseline: ${f}: the count row for ${a} is not two whole numbers`);
        if (counts.has(a)) throw new Error(`baseline: ${f}: ${a} has two count rows`);
        counts.set(a, [Number(b), Number(c)]);
      }
    }
    for (const g of ran) {
      if (!counts.has(g)) throw new Error(`baseline: ${f}: the chunk ${g} has no test counts; run the regression again with this tree's run-regression.sh`);
      testsRun += counts.get(g)[0];
      testsPassed += counts.get(g)[1];
    }
    for (const g of counts.keys()) if (!ran.includes(g)) throw new Error(`baseline: ${f}: a count row for ${g}, which the manifest does not record as run`);
  }
  if (digests.size !== 1) throw new Error(`baseline: the manifests name ${digests.size} plan digests; one regression has one plan`);
  const sorted = {};
  for (const f of files) sorted[f] = manifests[f];
  return { planDigest: [...digests][0], planInputs, source, chunks, chunksPassed: passed, testsRun, testsPassed, manifests: sorted };
}

/**
 * Whether a record's regression section is the evidence §3.2 asks for: present,
 * its totals and plan digest the ones its own manifests add up to, and green
 * (every chunk and every test passed), run on a clean checkout of exactly
 * `sourceCommit`. Returns every refusal as a sentence.
 * Whether the manifests cover the tagged tree's plan is the tree's own
 * verifier's question (`run-regression.sh --verify-shards`), asked separately.
 */
export function regressionAgreement(regression, sourceCommit) {
  if (!regression || typeof regression !== 'object') return ['regression: the record carries no regression section; a baseline records its full regression'];
  let derived;
  try {
    derived = regressionFromManifests(regression.manifests ?? {});
  } catch (e) {
    return [`regression: ${e.message.replace(/^baseline: /, '')}`];
  }
  const out = [];
  for (const k of ['planDigest', 'planInputs', 'source', 'chunks', 'chunksPassed', 'testsRun', 'testsPassed']) {
    const [a, b] = [regression[k] ?? null, derived[k]].map((v) => JSON.stringify(JSON.parse(canonicalJson(v))));
    if (a !== b) out.push(`regression: the record states ${k} ${a}, its manifests add up to ${b}`);
  }
  if (derived.source.commit !== sourceCommit) out.push(`regression: the manifests tested ${derived.source.commit}, the record is of ${sourceCommit}; run the regression on the record's commit`);
  if (!derived.source.clean) out.push(`regression: the manifests were run with uncommitted changes to tracked files; run the regression on a clean checkout`);
  if (derived.chunksPassed !== derived.chunks) out.push(`regression: ${derived.chunks - derived.chunksPassed} of ${derived.chunks} chunks failed; a baseline records a green regression`);
  if (derived.testsPassed !== derived.testsRun) out.push(`regression: ${derived.testsRun - derived.testsPassed} of ${derived.testsRun} tests failed; a baseline records a green regression`);
  return out;
}

/**
 * Compare a fresh build with the record. Returns every difference as a
 * sentence; an empty list is a match. The compiler and settings are compared
 * first and named, since a different compiler explains every code difference.
 */
export function compareBuild(record, built) {
  const diffs = [];
  const rb = record.versions?.build;
  // The toolchain is evidence §3.2 requires, never optional: a record or a
  // build without it is refused rather than compared on contracts alone.
  if (!rb?.compiler || !rb?.settings) diffs.push('compiler: the record names no compiler and settings (versions.build); a baseline records its toolchain');
  if (!built.build?.compiler || !built.build?.settings) diffs.push('compiler: this build reports no compiler and settings (no build-info); build with this tree\'s forge');
  if (rb?.compiler && built.build?.compiler) {
    if (rb.compiler !== built.build.compiler) diffs.push(`compiler: the record was built with ${rb.compiler}, this build with ${built.build.compiler}`);
    if (canonicalJson(rb.settings) !== canonicalJson(built.build.settings)) {
      diffs.push(`compiler settings: the record has ${JSON.stringify(rb.settings)}, this build ${JSON.stringify(built.build.settings)}`);
    }
  }
  const rc = record.contracts ?? {};
  const bc = built.contracts ?? {};
  for (const n of Object.keys(rc).sort()) {
    const r = rc[n];
    const b = bc[n];
    if (!b) {
      diffs.push(`${n}: in the record, not in this build`);
      continue;
    }
    if (r.runtimeHash !== b.runtimeHash) diffs.push(`${n}: runtime code hash ${b.runtimeHash}, the record has ${r.runtimeHash}`);
    if (r.size !== b.size) diffs.push(`${n}: ${b.size} bytes, the record has ${r.size}`);
    if (r.interfaceHash !== b.interfaceHash) diffs.push(`${n}: interface hash ${b.interfaceHash}, the record has ${r.interfaceHash}`);
    if (canonicalJson(r.immutables ?? []) !== canonicalJson(b.immutables ?? [])) {
      diffs.push(`${n}: immutables ${JSON.stringify(b.immutables ?? [])}, the record has ${JSON.stringify(r.immutables ?? [])}`);
    }
  }
  for (const n of Object.keys(bc).sort()) if (!rc[n]) diffs.push(`${n}: in this build, not in the record`);
  return diffs;
}

/** The record's own hash, as the tag message must carry it. */
export const recordHash = (text) => sha256(text);

/**
 * Check the tag's own facts, given what git reports. Returns every refusal as
 * a sentence. `t` is {annotated, signed, message, recordText, changedFiles,
 * sourceDigest, parentCommit} for the tag `tag`: `signed` is whether git
 * verified the signature, never whether the message looks signed, and
 * `sourceDigest` is the tagged commit's digest by {@link sourceDigest}.
 */
export function checkTagFacts(tag, t) {
  const out = [];
  if (!t.annotated) out.push(`${tag} is a lightweight tag; the series is annotated and signed`);
  if (!t.signed) out.push(`${tag}'s signature does not verify (git tag -v) with the keys this machine trusts; the series is signed`);
  if (t.recordText == null) {
    out.push(`${tag} names a commit with no ${recordPath(tag)}`);
    return out;
  }
  const m = TAG_LINE_RE.exec(t.message ?? '');
  const h = recordHash(t.recordText);
  if (!m) out.push(`${tag}'s message has no "record sha256 <hash>" line; it must carry ${h}`);
  else if (m[1] !== h) out.push(`${tag}'s message carries record hash ${m[1]}, but ${recordPath(tag)} hashes to ${h}`);
  const others = (t.changedFiles ?? []).filter((f) => f !== recordPath(tag));
  if (!(t.changedFiles ?? []).includes(recordPath(tag))) out.push(`the commit ${tag} names does not add ${recordPath(tag)}`);
  if (others.length) out.push(`the commit ${tag} names changes more than the record: ${others.join(', ')}`);
  let record;
  try {
    record = JSON.parse(t.recordText);
  } catch {
    out.push(`${recordPath(tag)} is not JSON`);
    return out;
  }
  if (record.tag !== tag) out.push(`${recordPath(tag)} is the record of ${record.tag}, not ${tag}`);
  if (record.source?.digest !== t.sourceDigest) out.push(`the record names source digest ${record.source?.digest}, but the tagged commit, baseline records left out, digests to ${t.sourceDigest}`);
  if (record.source?.commit !== t.parentCommit) out.push(`the record was built from commit ${record.source?.commit}, but the tagged commit's parent is ${t.parentCommit}`);
  return out;
}

/**
 * How to run `run-regression.sh --verify-shards` so it rebuilds the plan a set
 * of manifests recorded: `base` without its own chunk sizes or FORK_URL_*
 * variables, plus the recorded ones (a FORK_URL_* name only marks a URL as
 * present; planning never reads the value), and `--invariants` when the
 * recorded plan held the invariant suites. Returns {env, args}.
 */
export function planInvocation(planInputs, base = process.env) {
  const { INVARIANTS, ...vars } = planInputs ?? {};
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'CHUNK_SIZE' && k !== 'SUBDIR_CHUNK_SIZE' && !k.startsWith('FORK_URL_')));
  return { env: Object.assign(env, vars), args: INVARIANTS === '1' ? ['--invariants'] : [] };
}
