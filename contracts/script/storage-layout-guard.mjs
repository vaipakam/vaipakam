#!/usr/bin/env node
/**
 * storage-layout-guard.mjs — the append-only storage-layout guard (#1274, #2092).
 *
 * A Diamond refreshed in place, or a UUPS proxy upgraded, keeps its storage and
 * swaps its code. If the new code lays a field out anywhere other than where
 * the old code wrote it, every read of that field returns another field's
 * value, and nothing reverts to say so. #2092 found it had already happened on
 * the testnets: `LibVaipakam.Storage` had fields removed on 2026-06-23 and
 * 2026-08-16, and Diamonds refreshed across those removals read every later
 * field one or more slots away from where it had been written. The repository
 * stated the rule ("append-only post-launch") only in comments.
 *
 * This module turns the rule into a check, from the COMPILER's own layout —
 * never from a reading of the source, which is how a moved field and a renamed
 * one get confused:
 *
 *   1. Every surviving layout is a ROOT (contracts/storage-layout/roots.json):
 *      each namespaced storage struct of the Diamond, read through a probe
 *      contract (src/storage-layout/StorageLayoutProbes.sol), and each UUPS
 *      implementation contract.
 *   2. Each root's `storageLayout` (forge `extra_output`) is flattened into a
 *      LEDGER of lines. A line states one fact a live contract depends on:
 *      this slot/offset in this region holds this type; this mapping is keyed
 *      by this type; this array's elements are this wide; this enum's Nth
 *      member is this name; this namespace sits at this position.
 *   3. The rule is set inclusion: every line of the old ledger must still be in
 *      the new one. Appending a field adds lines and removes none. Inserting,
 *      removing, reordering, retyping or resizing an element type removes at
 *      least one. No case analysis about "is this struct the last member" is
 *      needed: a struct that grows in place shifts the slots of whatever follows
 *      it, and those lines then go missing.
 *
 * Every value line carries the field's PATH as well as its position, because
 * position and type alone cannot tell two different changes apart: inserting a
 * `uint256` into a run of `uint256`s leaves exactly the set of (slot, type)
 * pairs that appending one would, while every field after the insertion now
 * reads its neighbour's value. Only the name says which field a slot belongs
 * to. So a rename removes a line too, and must be DECLARED in
 * contracts/storage-layout/renames.json — a durable statement that a field kept
 * its slot and its meaning under a new name. Declared renames are honoured
 * everywhere, the deploy-time check (#2092 item 1) included, so a genuine
 * rename never blocks an upgrade. A field repurposed under a new name (old data
 * read with a new meaning) is a break, and is not a rename to declare.
 *
 * Nested regions are identified by the SLOT of the field that owns them —
 * `vaipakam@57[uint256]` is the value region of the mapping at slot 57 — so a
 * rename of that mapping changes only the paths, never the region.
 *
 * A real break, accepted on purpose, is acknowledged in breaks.ack.json against
 * the exact base file it was measured on, and only CI honours it: an
 * acknowledgement says "nothing may be upgraded in place across this change",
 * which is why the deploy-time check never reads one.
 *
 * `__gap` arrays (OpenZeppelin's reserved-space convention, used by several
 * UUPS contracts here) are free space: they contribute no lines, so a new field
 * may take a slot a gap used to cover. A field AFTER a gap keeps its own line,
 * so shrinking the gap by the wrong amount is still caught.
 *
 * CLI (run from anywhere; paths are resolved against the repository):
 *
 *   node contracts/script/storage-layout-guard.mjs write             regenerate the golden file
 *   node contracts/script/storage-layout-guard.mjs check             golden is fresh + tree complete
 *   node contracts/script/storage-layout-guard.mjs check --base <f>  ... and append-only vs <f>
 *
 * `--out <dir>` overrides the forge artifact directory (default contracts/out).
 * Anything non-zero must stop the caller.
 *
 * NO DEPENDENCIES, on purpose: it runs inside `predeploy-check.sh`, in CI's
 * contracts-fast job and on a deploy machine, none of which installs the pnpm
 * workspace. That is why it carries its own Keccak-256 below instead of
 * importing one; packages/contracts/scripts/storage-layout-guard.test.mjs
 * checks it against viem's.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const CONTRACTS_DIR = join(REPO_ROOT, 'contracts');
export const LAYOUT_DIR = join(CONTRACTS_DIR, 'storage-layout');
export const ROOTS_FILE = join(LAYOUT_DIR, 'roots.json');
export const GOLDEN_FILE = join(LAYOUT_DIR, 'layout.golden.json');
export const ACKS_FILE = join(LAYOUT_DIR, 'breaks.ack.json');
export const RENAMES_FILE = join(LAYOUT_DIR, 'renames.json');
export const FACETS_FILE = join(REPO_ROOT, 'packages', 'contracts', 'scripts', 'diamond-facets.json');
export const GOLDEN_FORMAT = 2;

/** The file's text, or `undefined` if it does not exist. One read, no separate existence check. */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
}

// ─── Ledger ──────────────────────────────────────────────────────────────

const GAP = /^__gap$/;

function isValueType(ty) {
  return ty.encoding === 'inplace' && !ty.members && !ty.base;
}

/**
 * Flatten one root's compiler layout into ledger lines. Pure.
 *
 * @param {string} rootId   region prefix for this root
 * @param {{storage: object[], types: Record<string, object>}} layout
 * @returns {{layout: Set<string>, enums: Set<string>}}
 *          `enums` are the enum type labels the layout uses; their members are
 *          added by the caller, which has the sources.
 */
export function ledgerFromLayout(rootId, layout, { probe = false } = {}) {
  const types = layout.types ?? {};
  const out = { layout: new Set(), enums: new Set() };
  const typeOf = (id) => {
    const ty = types[id];
    if (!ty) throw new Error(`${rootId}: storage layout names type ${id} but does not define it`);
    return ty;
  };

  const member = (region, slot, offset, typeId, path, label) => {
    const ty = typeOf(typeId);
    if (GAP.test(label) && ty.encoding === 'inplace' && ty.base && isValueType(typeOf(ty.base))) return;
    if (ty.encoding === 'mapping') {
      const key = typeOf(ty.key).label;
      out.layout.add(`M|${region}|${slot}|${offset}|${key}|${path}`);
      if (key.startsWith('enum ')) out.enums.add(key);
      const valueRegion = `${region}@${slot}[${key}]`;
      member(valueRegion, 0n, 0, ty.value, `${path}[]`, '');
    } else if (ty.encoding === 'dynamic_array') {
      const base = typeOf(ty.base);
      const elemRegion = `${region}@${slot}[]`;
      out.layout.add(`D|${region}|${slot}|${offset}|${path}`);
      out.layout.add(`W|${elemRegion}|${base.numberOfBytes}`);
      member(elemRegion, 0n, 0, ty.base, `${path}[]`, '');
    } else if (ty.encoding === 'bytes') {
      out.layout.add(`L|${region}|${slot}|${offset}|${ty.label}|${path}`);
    } else if (ty.encoding === 'inplace' && ty.members) {
      for (const m of ty.members) {
        member(region, slot + BigInt(m.slot), m.offset, m.type, path ? `${path}.${m.label}` : m.label, m.label);
      }
    } else if (ty.encoding === 'inplace' && ty.base) {
      const base = typeOf(ty.base);
      if (isValueType(base)) {
        out.layout.add(`L|${region}|${slot}|${offset}|${ty.label}|${path}`);
        if (base.label.startsWith('enum ')) out.enums.add(base.label);
      } else {
        const elemRegion = `${region}@${slot}[${ty.label.match(/\[(\d+)\]$/)?.[1] ?? '?'}]`;
        out.layout.add(`W|${elemRegion}|${base.numberOfBytes}`);
        member(elemRegion, 0n, 0, ty.base, `${path}[]`, '');
      }
    } else if (isValueType(ty)) {
      out.layout.add(`L|${region}|${slot}|${offset}|${ty.label}|${path}`);
      if (ty.label.startsWith('enum ')) out.enums.add(ty.label);
    } else {
      throw new Error(`${rootId}: unknown storage encoding ${ty.encoding} for ${path}`);
    }
  };

  const entries = layout.storage ?? [];
  if (probe) {
    // A namespace probe declares exactly one variable: the struct, at slot 0.
    // Its members ARE the namespace; the variable's own name is not part of it.
    const [only] = entries;
    const ty = only && types[only.type];
    if (entries.length !== 1 || only.slot !== '0' || only.offset !== 0 || !ty?.members) {
      throw new Error(`${rootId}: a namespace probe must declare exactly one struct variable at slot 0`);
    }
    for (const m of ty.members) member(rootId, BigInt(m.slot), m.offset, m.type, m.label, m.label);
  } else {
    for (const e of entries) member(rootId, BigInt(e.slot), e.offset, e.type, e.label, e.label);
  }
  return out;
}

// ─── Sources: enum members, namespace positions, completeness ────────────

/** Strip // and /* *\/ comments, keeping string literals intact. Pure. */
export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Members of the enum a layout label names, from the sources. Pure over the
 * given `{path: commentFreeSource}` map. `enum LibVaipakam.LoanStatus` is looked
 * up as `enum LoanStatus { … }` in the file that declares `LibVaipakam`; a
 * top-level `enum Foo` in any file. Exactly one declaration must match.
 */
export function enumMembers(label, sources) {
  const qualified = label.replace(/^enum /, '');
  const parts = qualified.split('.');
  const name = parts.pop();
  const scope = parts.pop();
  const decl = new RegExp(`\\benum\\s+${name}\\s*\\{([^}]*)\\}`, 'g');
  const scopeDecl = scope ? new RegExp(`\\b(library|contract|interface)\\s+${scope}\\b`) : null;
  const hits = [];
  for (const [path, src] of Object.entries(sources)) {
    if (scopeDecl && !scopeDecl.test(src)) continue;
    for (const m of src.matchAll(decl)) hits.push({ path, body: m[1] });
  }
  if (hits.length !== 1) {
    throw new Error(`${label}: expected exactly one enum declaration, found ${hits.length}${hits.length ? ` (${hits.map((h) => h.path).join(', ')})` : ''}`);
  }
  return hits[0].body.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The bytes32 a position constant evaluates to. Accepts the three forms this
 * tree uses: a literal, `keccak256("…")`, and the ERC-7201 formula
 * `keccak256(abi.encode(uint256(keccak256("…")) - 1)) & ~bytes32(uint256(0xff))`.
 * A literal is checked against the formula in its own `///` comment when there
 * is one, so a hand-typed hash that disagrees with its stated namespace fails.
 * Pure over the raw (comment-bearing) source.
 */
export function positionOf(constantName, rawSource) {
  const src = stripComments(rawSource);
  const m = src.match(new RegExp(`\\bconstant\\s+${constantName}\\s*=\\s*([^;]+);`));
  if (!m) throw new Error(`position constant ${constantName} not found`);
  const expr = m[1].replace(/\s+/g, '');
  const lit = expr.match(/^(0x[0-9a-fA-F]{64})$/);
  if (lit) {
    const value = lit[1].toLowerCase();
    const before = rawSource.slice(0, rawSource.search(new RegExp(`\\bconstant\\s+${constantName}\\b`)));
    const doc = before.split('\n').slice(-4).join('\n');
    const ns = doc.match(/keccak256\(abi\.encode\(uint256\(keccak256\("([^"]+)"\)\)\s*-\s*1\)\)\s*&\s*~bytes32\(uint256\(0xff\)\)/);
    if (ns && erc7201(ns[1]) !== value) {
      throw new Error(`${constantName} = ${value}, but its comment derives ERC-7201 "${ns[1]}" = ${erc7201(ns[1])}`);
    }
    return value;
  }
  const plain = expr.match(/^keccak256\("([^"]+)"\)$/);
  if (plain) return keccak256(utf8(plain[1]));
  const formula = expr.match(/^keccak256\(abi\.encode\(uint256\(keccak256\("([^"]+)"\)\)-1\)\)&~bytes32\(uint256\(0xff\)\)$/);
  if (formula) return erc7201(formula[1]);
  throw new Error(`${constantName}: unsupported position expression ${m[1].trim()}`);
}

// ─── Keccak-256 (the Ethereum hash, NOT NIST SHA3-256: different padding) ──

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets r[x][y].
const KECCAK_ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
const MASK64 = (1n << 64n) - 1n;
const rotl64 = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64);

function keccakF(a) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(a[x + 5 * y], KECCAK_ROT[x][y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK64 & b[((x + 2) % 5) + 5 * y]);
    }
    a[0] ^= KECCAK_RC[round];
  }
}

/** Keccak-256 of a byte array, as a 0x-prefixed 32-byte hex string. Pure. */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const a = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + 8 * i + k]);
      a[i] ^= lane;
    }
    keccakF(a);
  }
  let hex = '0x';
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 8; k++) hex += Number((a[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, '0');
  }
  return hex;
}

const utf8 = (text) => new TextEncoder().encode(text);
const word = (n) => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));

/** ERC-7201 slot for a namespace id. Pure. */
export function erc7201(id) {
  const inner = BigInt(keccak256(utf8(id))) - 1n;
  const outer = BigInt(keccak256(word(inner)));
  return `0x${(outer & ~0xffn).toString(16).padStart(64, '0')}`;
}

/**
 * Every `.sol` file under `dir`, as `{repoRelativePath: source}`. Entry types
 * come from the directory listing itself (no separate stat before the read),
 * and symlinks are not followed: the guard reads the tree as committed.
 */
function readSources(dir, base = CONTRACTS_DIR) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.sol')) out[relative(base, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/**
 * Every storage-pointer assignment (`<ptr>.slot := …`) in one file, resolved
 * to the struct it points as and the position constant it points at. Two
 * forms are read: `<ptr>.slot := CONST` and `bytes32 v = CONST; … <ptr>.slot
 * := v` within the same function. The struct is the one the enclosing
 * function returns as `(<Struct> storage <ptr>)`. An assignment this cannot
 * resolve comes back with `error` set: a pointer whose target the guard cannot
 * name is a namespace it cannot check. Pure over the raw source.
 */
export function storagePointers(rawSource) {
  const src = stripComments(rawSource);
  const out = [];
  for (const m of src.matchAll(/(\$\w*|\w+)\.slot\s*:=\s*(\w+)/g)) {
    const before = src.slice(0, m.index);
    const fnAt = before.lastIndexOf('function ');
    const header = fnAt >= 0 ? before.slice(fnAt) : '';
    const ret = header.match(/returns\s*\(\s*([\w.]+)\s+storage\s+(\$\w*|\w+)\s*\)/);
    const [ptr, rhs] = [m[1], m[2]];
    if (!ret || ret[2] !== ptr) {
      out.push({ error: `\`${ptr}.slot := ${rhs}\` is not the returned storage pointer of its enclosing function` });
      continue;
    }
    const struct = ret[1].split('.').pop();
    const alias = header.match(new RegExp(`\\bbytes32\\s+${rhs}\\s*=\\s*(\\w+)\\s*;`));
    const constant = alias ? alias[1] : rhs;
    if (!/^[A-Z][A-Z0-9_]*$/.test(constant)) {
      out.push({ struct, error: `\`${ptr}.slot := ${rhs}\` does not resolve to a named position constant` });
      continue;
    }
    out.push({ struct, constant });
  }
  return out;
}

/**
 * Concrete contracts that inherit UUPSUpgradeable, directly or through any
 * chain of bases declared in `sources`. Abstract bases are not returned: their
 * state is part of every concrete descendant's layout, which is what a proxy
 * actually runs. Pure.
 */
export function uupsContracts(sources) {
  const decls = {};
  for (const src of Object.values(sources)) {
    for (const m of stripComments(src).matchAll(/\b(abstract\s+)?contract\s+(\w+)\s+is\s+([^{]*)\{/g)) {
      const bases = m[3].split(',').map((b) => b.trim().match(/^\w+/)?.[0]).filter(Boolean);
      decls[m[2]] = { abstract: Boolean(m[1]), bases };
    }
  }
  const reaches = (name, seen = new Set()) => {
    if (name === 'UUPSUpgradeable') return true;
    if (seen.has(name) || !decls[name]) return false;
    seen.add(name);
    return decls[name].bases.some((b) => reaches(b, seen));
  };
  return Object.keys(decls).filter((c) => !decls[c].abstract && reaches(c)).sort();
}

// ─── Artifacts ───────────────────────────────────────────────────────────

/** Every `<Contract>.json` at any depth under `dir`. */
function findArtifacts(dir, file, found = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findArtifacts(p, file, found);
    else if (e.isFile() && e.name === file) found.push(p);
  }
  return found;
}

/** The source path the artifact was compiled from, per its solc metadata. */
function compilationTarget(art) {
  const meta = typeof art.metadata === 'string' ? JSON.parse(art.metadata) : art.metadata;
  return Object.keys(meta?.settings?.compilationTarget ?? {})[0];
}

/**
 * The storageLayout of the contract of this name compiled from `src/`. Forge
 * nests artifacts by path when two contracts share a name (a test double, a
 * vendored copy), so this searches at any depth and, when several match,
 * keeps the one compiled from `src/`. Anything but exactly one is an error.
 */
export function readStorageLayout(outDir, contract) {
  let hits = findArtifacts(outDir, `${contract}.json`).map((p) => ({ p, art: JSON.parse(readFileSync(p, 'utf8')) }));
  if (hits.length > 1) hits = hits.filter((h) => compilationTarget(h.art)?.startsWith('src/'));
  if (hits.length !== 1) {
    throw new Error(`${contract}: expected exactly one artifact compiled from src/ under ${outDir}, found ${hits.length}${hits.length ? ` (${hits.map((h) => relative(outDir, h.p)).join(', ')}: a stale artifact from a moved source — run \`forge clean\` and rebuild)` : ' (run forge build first)'}`);
  }
  const { art } = hits[0];
  if (!art.storageLayout) {
    throw new Error(`${contract}: artifact has no storageLayout — foundry.toml must carry extra_output = ["storageLayout"] in the active profile`);
  }
  return art.storageLayout;
}

// ─── Build + compare ─────────────────────────────────────────────────────

/**
 * The whole ledger for the tree, plus the completeness findings. Reads the
 * roots manifest, the forge artifacts and the sources.
 */
export function buildLedger({ outDir = join(CONTRACTS_DIR, 'out'), roots = JSON.parse(readFileSync(ROOTS_FILE, 'utf8')) } = {}) {
  const srcSources = readSources(join(CONTRACTS_DIR, 'src'));
  const enumSources = Object.fromEntries(Object.entries(srcSources).map(([p, s]) => [p, stripComments(s)]));
  const layout = new Set();
  const enums = new Set();
  const problems = [];
  const rootIds = new Set();
  const add = (id, l, opts) => {
    if (rootIds.has(id)) throw new Error(`root id ${id} is listed twice`);
    rootIds.add(id);
    const led = ledgerFromLayout(id, l, opts);
    led.layout.forEach((x) => layout.add(x));
    led.enums.forEach((x) => enums.add(x));
  };

  // Each namespace root binds three things that must agree: the probe's
  // struct, a storage pointer in the position file that returns that struct,
  // and the constant that pointer is set from.
  for (const ns of roots.namespaces) {
    const probeLayout = readStorageLayout(outDir, ns.probe);
    add(ns.id, probeLayout, { probe: true });
    const raw = readFileSync(join(CONTRACTS_DIR, ns.positionFile), 'utf8');
    layout.add(`P|${ns.id}|${positionOf(ns.positionConstant, raw)}`);
    const struct = probeLayout.types[probeLayout.storage[0].type].label.split('.').pop();
    if (!storagePointers(raw).some((p) => p.struct === struct && p.constant === ns.positionConstant)) {
      problems.push(`root ${ns.id}: ${ns.positionFile} has no storage pointer returning ${struct} from ${ns.positionConstant}, so the probe ${ns.probe} may not describe the storage that position holds`);
    }
  }
  for (const c of roots.uups) add(`uups:${c}`, readStorageLayout(outDir, c));
  for (const label of [...enums].sort()) {
    enumMembers(label, enumSources).forEach((m, i) => layout.add(`E|${label}|${i}|${m}`));
  }

  // Completeness: a surviving layout nobody listed is a layout nobody checks.
  for (const [f, src] of Object.entries(srcSources)) {
    for (const p of storagePointers(src)) {
      if (p.error) problems.push(`${f}: ${p.error}`);
      else if (!roots.namespaces.some((ns) => ns.positionFile === f && ns.positionConstant === p.constant)) {
        problems.push(`${f} points ${p.struct} storage at ${p.constant}, but no namespace root in roots.json names that position`);
      }
    }
  }
  const listedUups = new Set(roots.uups);
  const foundUups = uupsContracts(srcSources);
  for (const c of foundUups) {
    if (!listedUups.has(c)) problems.push(`${c} is a UUPS implementation but roots.json does not list it`);
  }
  for (const c of roots.uups) {
    if (!foundUups.includes(c)) problems.push(`roots.json lists ${c} as UUPS, but no contract of that name inherits UUPSUpgradeable`);
  }
  // A facet with an ordinary state variable writes at slot 0.. of the Diamond.
  const facets = JSON.parse(readFileSync(FACETS_FILE, 'utf8'));
  for (const c of [...facets.facets, ...facets.proxy, 'DiamondCutFacet']) {
    const l = readStorageLayout(outDir, c);
    if ((l.storage ?? []).length) problems.push(`${c} declares state variables (${l.storage.map((s) => s.label).join(', ')}); Diamond code must keep all state in a namespaced struct`);
  }

  return {
    golden: {
      format: GOLDEN_FORMAT,
      roots: [...rootIds].sort(),
      layout: [...layout].sort(),
    },
    problems,
  };
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function serializeGolden(golden) {
  return `${JSON.stringify({
    _readme: 'GENERATED by contracts/script/storage-layout-guard.mjs write — do not edit by hand. Each `layout` line is a fact a live Diamond or UUPS proxy depends on; a change to contracts/src that removes any line is a layout break (#1274, #2092). See docs/DesignsAndPlans/StorageLayoutGuardDesign.md.',
    ...golden,
  }, null, 2)}\n`;
}

/** Lines of `before` missing from `after`. Pure. */
export function missingLines(before, after) {
  const have = new Set(after);
  return before.filter((l) => !have.has(l));
}

/**
 * Rewrite `lines` through the declared renames, oldest first, so a base laid
 * down before a rename reads with today's names. A rename is anchored on the
 * exact line its field had (region, slot, offset and old path): it applies only
 * to a ledger that HAS that field there, which is what keeps a later, unrelated
 * field reusing the old name from being rewritten. Within a root every path is
 * unique (Solidity forbids two members of one name), so the anchor's path
 * prefix identifies the field's nested lines exactly. Pure.
 */
export function applyRenames(lines, renames = []) {
  let out = [...lines];
  for (const r of renames) {
    if (r.enum) {
      out = out.map((l) => (l === `E|${r.enum}|${r.index}|${r.from}` ? `E|${r.enum}|${r.index}|${r.to}` : l));
      continue;
    }
    const anchored = out.some((l) => {
      const f = l.split('|');
      return 'LMD'.includes(f[0]) && f[1] === r.region && f[2] === String(r.slot) && f[3] === String(r.offset) && f[f.length - 1] === r.from;
    });
    if (!anchored) continue;
    const root = r.region.split('@')[0];
    out = out.map((l) => {
      const f = l.split('|');
      if (!'LMD'.includes(f[0]) || f[1].split('@')[0] !== root) return l;
      const path = f[f.length - 1];
      if (path !== r.from && !path.startsWith(`${r.from}.`) && !path.startsWith(`${r.from}[`)) return l;
      f[f.length - 1] = r.to + path.slice(r.from.length);
      return f.join('|');
    });
  }
  return out;
}

/**
 * Append-only verdict of `current` against `base`: the declared renames are
 * applied to the base first; then every base line must be in `current`.
 * Acknowledgements are honoured only when their `baseSha256` names this base
 * file exactly, so one can never outlive the comparison it was written for. The
 * deploy-time check passes no acks at all. Pure.
 */
export function appendOnlyVerdict(base, current, { baseSha256, acks = [], renames = [] } = {}) {
  const live = acks.filter((a) => a.baseSha256 === baseSha256);
  const acked = new Set(live.flatMap((a) => a.lines ?? []));
  const missing = missingLines(applyRenames(base.layout, renames), current.layout);
  return {
    breaks: missing.filter((l) => !acked.has(l)),
    acknowledged: missing.filter((l) => acked.has(l)),
    staleAcks: acks.filter((a) => a.baseSha256 !== baseSha256).length,
  };
}

/**
 * Parse renames.json. A rename is permanent (a chain refreshed long after it
 * still needs it), so each entry must anchor on an exact old position and say
 * why it is a rename and not a repurpose. Pure.
 */
export function readRenames(text) {
  const doc = JSON.parse(text);
  const renames = doc.renames ?? [];
  if (!Array.isArray(renames)) throw new Error('renames.json: `renames` must be an array');
  renames.forEach((r, i) => {
    const where = `renames.json: renames[${i}]`;
    if (typeof r?.from !== 'string' || typeof r.to !== 'string' || !r.from || !r.to || r.from === r.to) throw new Error(`${where} needs distinct non-empty \`from\` and \`to\``);
    if (typeof r.reason !== 'string' || !r.reason.trim()) throw new Error(`${where}.reason must say why the field kept its meaning`);
    if (r.enum !== undefined) {
      if (typeof r.enum !== 'string' || !Number.isInteger(r.index) || r.index < 0) throw new Error(`${where}: an enum rename names \`enum\` and a member \`index\``);
    } else if (typeof r.region !== 'string' || !/^\d+$/.test(String(r.slot)) || !Number.isInteger(r.offset)) {
      throw new Error(`${where}: a field rename anchors on \`region\`, \`slot\` and \`offset\` of the field's old line`);
    }
  });
  return renames;
}

/**
 * Parse breaks.ack.json. Every acknowledgement must name the exact base it was
 * written against, the exact lines it accepts and why; a malformed one is an
 * error rather than an ack that quietly accepts nothing or everything. Pure.
 */
export function readAcks(text) {
  const doc = JSON.parse(text);
  const acks = doc.acks ?? [];
  if (!Array.isArray(acks)) throw new Error('breaks.ack.json: `acks` must be an array');
  acks.forEach((a, i) => {
    if (!/^[0-9a-f]{64}$/.test(a?.baseSha256 ?? '')) throw new Error(`breaks.ack.json: acks[${i}].baseSha256 must be the sha256 of the base golden file`);
    if (!Array.isArray(a.lines) || !a.lines.length || a.lines.some((l) => typeof l !== 'string')) throw new Error(`breaks.ack.json: acks[${i}].lines must list the exact ledger lines it accepts`);
    if (typeof a.reason !== 'string' || !a.reason.trim()) throw new Error(`breaks.ack.json: acks[${i}].reason must say why the break is acceptable`);
  });
  return acks;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  const outDir = arg(argv, '--out') ?? join(CONTRACTS_DIR, 'out');
  const fail = (msg) => {
    console.error(`storage-layout-guard: ${msg}`);
    return 1;
  };
  if (mode !== 'write' && mode !== 'check') return fail('usage: storage-layout-guard.mjs write|check [--base <golden>] [--out <dir>]');
  const { golden, problems } = buildLedger({ outDir });
  if (problems.length) {
    problems.forEach((p) => console.error(`storage-layout-guard: ${p}`));
    return fail(`${problems.length} completeness problem(s)`);
  }

  if (mode === 'write') {
    writeFileSync(GOLDEN_FILE, serializeGolden(golden));
    console.log(`storage-layout-guard: wrote ${relative(REPO_ROOT, GOLDEN_FILE)} (${golden.layout.length} lines, ${golden.roots.length} roots)`);
    return 0;
  }

  const committedText = readIfPresent(GOLDEN_FILE);
  if (committedText === undefined) return fail(`${relative(REPO_ROOT, GOLDEN_FILE)} is missing — run \`node contracts/script/storage-layout-guard.mjs write\``);
  const committed = JSON.parse(committedText);
  let rc = 0;

  // 1. The committed golden describes the code being built. Without this, the
  //    append-only comparison below would be checking a file, not the code.
  const stale = [...missingLines(committed.layout ?? [], golden.layout), ...missingLines(golden.layout, committed.layout ?? [])];
  if (committed.format !== GOLDEN_FORMAT || stale.length || JSON.stringify(committed.roots) !== JSON.stringify(golden.roots)) {
    console.error(`storage-layout-guard: the committed golden file does not match the compiled layout (${stale.length} line(s) differ). Regenerate it in this change:\n  node contracts/script/storage-layout-guard.mjs write`);
    stale.slice(0, 10).forEach((l) => console.error(`  ${l}`));
    rc = 1;
  } else {
    console.log(`storage-layout-guard: golden file is current (${golden.layout.length} lines, ${golden.roots.length} roots)`);
  }

  // 2. Append-only against a base golden (CI passes the PR base's file).
  const basePath = arg(argv, '--base');
  if (basePath) {
    const baseText = readFileSync(basePath, 'utf8');
    const base = JSON.parse(baseText);
    if (base.format !== GOLDEN_FORMAT) {
      return fail(`the base golden is format ${base.format}, this guard reads format ${GOLDEN_FORMAT}. A format change must ship a translation of the old format, or no base can be compared.`);
    }
    const acksText = readIfPresent(ACKS_FILE);
    const renamesText = readIfPresent(RENAMES_FILE);
    const acks = acksText === undefined ? [] : readAcks(acksText);
    const renames = renamesText === undefined ? [] : readRenames(renamesText);
    const v = appendOnlyVerdict(base, golden, { baseSha256: sha256(baseText), acks, renames });
    if (v.breaks.length) {
      console.error(`storage-layout-guard: LAYOUT BREAK — ${v.breaks.length} line(s) of the base layout are gone. A proxy upgraded in place across this change would read existing state at the wrong place, or under the wrong field:`);
      v.breaks.slice(0, 40).forEach((l) => console.error(`  - ${l}`));
      if (v.breaks.length > 40) console.error(`  … and ${v.breaks.length - 40} more`);
      console.error(`  If a field only changed its NAME and kept its meaning, declare it in ${relative(REPO_ROOT, RENAMES_FILE)}.`);
      console.error(`  If the break is intended (no chain will be upgraded in place across it), acknowledge it in ${relative(REPO_ROOT, ACKS_FILE)} with baseSha256 ${sha256(baseText)}.`);
      rc = 1;
    } else {
      console.log('storage-layout-guard: append-only against the base layout');
    }
    if (v.acknowledged.length) console.log(`storage-layout-guard: ${v.acknowledged.length} line(s) acknowledged as an intended break in ${relative(REPO_ROOT, ACKS_FILE)}`);
    if (v.staleAcks) console.log(`storage-layout-guard: note — ${v.staleAcks} acknowledgement(s) name a different base and are inert; delete them`);
  }
  return rc;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
