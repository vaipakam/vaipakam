/**
 * The baseline record's rules, shared by its generator and its check (#3964,
 * RefactorRulesDesign §3.2 "What tagged means").
 *
 * A record describes one build of one source tree: for every deployable
 * contract its runtime code hash, size and interface hash; the storage layout's
 * recorded file; the gas suite's figures; the full regression's manifests; the
 * compiler, its settings, the build tool and every vendored library; and the
 * source tree itself. Every hash here is SHA-256, written as 64 lower-case hex
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

/** The deployable contracts: every cut facet, the Diamond proxy and every standalone contract the app ships. */
export function deployableNames(manifest) {
  const names = [...(manifest.facets ?? []), ...(manifest.proxy ?? []), ...(manifest.standalone ?? [])];
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) throw new Error(`baseline: ${n} is named twice in diamond-facets.json`);
    seen.add(n);
  }
  return names.sort();
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

/** Find `<Name>.json` in a forge `out/` directory (one level of `<File>.sol/` folders). */
export function findArtifact(outDir, name) {
  const direct = join(outDir, `${name}.sol`, `${name}.json`);
  if (existsSync(direct)) return direct;
  const hits = [];
  for (const d of readdirSync(outDir)) {
    const p = join(outDir, d, `${name}.json`);
    if (existsSync(p)) hits.push(p);
  }
  if (hits.length > 1) throw new Error(`baseline: ${name} has ${hits.length} artifacts (${hits.join(', ')}); a deployable name must be unique`);
  return hits[0];
}

/** What a record holds for one contract, from its forge artifact. */
export function contractEntry(artifact) {
  const hex = String(artifact.deployedBytecode?.object ?? '').replace(/^0x/, '');
  if (!hex || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) throw new Error('baseline: artifact carries no runtime code');
  const meta = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  return {
    runtimeHash: sha256(Buffer.from(hex, 'hex')),
    size: hex.length / 2,
    interfaceHash: interfaceHash(artifact.abi ?? []),
    compiler: meta?.compiler?.version,
  };
}

/** The compiler settings that change code, from an artifact's metadata (its own target left out). */
export function codeSettings(artifact) {
  const meta = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  if (!meta?.settings) throw new Error('baseline: artifact carries no metadata settings');
  const { compilationTarget, remappings, ...rest } = meta.settings;
  return { compiler: meta.compiler?.version, settings: rest };
}

/**
 * Read every deployable's entry from `outDir`. All must have been built by one
 * compiler with one set of settings; a mixed build is refused by name.
 */
export function collectContracts(outDir, names) {
  const contracts = {};
  let build;
  const missing = [];
  for (const n of names) {
    const p = findArtifact(outDir, n);
    if (!p) {
      missing.push(n);
      continue;
    }
    const art = JSON.parse(readFileSync(p, 'utf8'));
    const { compiler, ...entry } = contractEntry(art);
    contracts[n] = entry;
    const s = codeSettings(art);
    const text = canonicalJson(s);
    if (!build) build = { text, value: s, from: n };
    else if (build.text !== text) {
      throw new Error(`baseline: ${n} was built with ${canonicalJson(s).trim()} but ${build.from} with ${build.text.trim()}: one build, one compiler`);
    }
    if (compiler && compiler !== s.compiler) throw new Error(`baseline: ${n} reports two compilers`);
  }
  if (missing.length) throw new Error(`baseline: no artifact for ${missing.join(', ')} in ${outDir}`);
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
 * The full regression's manifests (`run-regression.sh --manifest`), kept as
 * written so `--verify-shards` can be run on them again, plus what they add up
 * to. A manifest line `tests <glob> <run> <passed>` carries a chunk's counts.
 */
export function collectRegression(dir) {
  if (!existsSync(dir)) throw new Error(`baseline: no regression manifests at ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsv')).sort();
  if (!files.length) throw new Error(`baseline: no *.tsv regression manifests in ${dir}`);
  const manifests = {};
  const digests = new Set();
  let chunks = 0;
  let passed = 0;
  let testsRun = 0;
  let testsPassed = 0;
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    manifests[f] = text;
    for (const line of text.split('\n')) {
      const [k, a, b, c] = line.split('\t');
      if (k === 'plan') digests.add(a);
      else if (k === 'pass' || k === 'fail') {
        chunks++;
        if (k === 'pass') passed++;
      } else if (k === 'tests') {
        testsRun += Number(b);
        testsPassed += Number(c);
      }
    }
  }
  if (digests.size !== 1) throw new Error(`baseline: the manifests name ${digests.size} plan digests; one regression has one plan`);
  return { planDigest: [...digests][0], chunks, chunksPassed: passed, testsRun, testsPassed, manifests };
}

/**
 * Compare a fresh build with the record. Returns every difference as a
 * sentence; an empty list is a match. The compiler and settings are compared
 * first and named, since a different compiler explains every code difference.
 */
export function compareBuild(record, built) {
  const diffs = [];
  const rb = record.versions?.build;
  if (rb && built.build) {
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
  }
  for (const n of Object.keys(bc).sort()) if (!rc[n]) diffs.push(`${n}: in this build, not in the record`);
  return diffs;
}

/** The record's own hash, as the tag message must carry it. */
export const recordHash = (text) => sha256(text);

/**
 * Check the tag's own facts, given what git reports. Returns every refusal as
 * a sentence. `t` is {annotated, signed, message, recordText, changedFiles,
 * parentTree, parentCommit} for the tag `tag`.
 */
export function checkTagFacts(tag, t) {
  const out = [];
  if (!t.annotated) out.push(`${tag} is a lightweight tag; the series is annotated and signed`);
  if (!t.signed) out.push(`${tag} carries no signature; the series is signed`);
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
  if (record.source?.tree !== t.parentTree) out.push(`the record was built from tree ${record.source?.tree}, but the tagged commit's parent has tree ${t.parentTree}`);
  if (record.source?.commit !== t.parentCommit) out.push(`the record was built from commit ${record.source?.commit}, but the tagged commit's parent is ${t.parentCommit}`);
  return out;
}
