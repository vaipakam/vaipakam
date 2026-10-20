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
 * This module turns the rule into a check, from the COMPILER's own output and
 * never from a reading of the source text. Two outputs are read, both from the
 * forge artifacts in out/: each contract's `storageLayout` (foundry.toml
 * `extra_output`) for the layouts, and each source's AST (foundry.toml
 * `ast = true`) for everything about the source itself: storage pointers,
 * position constants, enum members, value types. The AST is what the compiler
 * resolved, so formatting, aliases and qualified names cannot hide anything
 * from it the way they hide things from a text match.
 *
 *   1. Every surviving layout is a ROOT (contracts/storage-layout/roots.json):
 *      each namespaced storage struct, read through a probe contract
 *      (src/storage-layout/StorageLayoutProbes.sol), and each UUPS
 *      implementation contract.
 *   2. Each root's `storageLayout` is flattened into a LEDGER of lines. A line
 *      states one fact a live contract depends on: this slot/offset in this
 *      region holds this type, or starts this struct; this mapping is keyed by
 *      this type; this array's elements are this wide; this enum's Nth member
 *      is this name; this value type wraps this type; this namespace sits at
 *      this position.
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
 * the exact base file it was measured on, and is honoured only when the caller
 * passes `--honour-acks`, which only CI does: an acknowledgement says "nothing
 * may be upgraded in place across this change", so a comparison against a
 * deployed chain's layout must never read one.
 *
 * `__gap` arrays (OpenZeppelin's reserved-space convention, used by several
 * UUPS contracts here) are free space: they contribute no lines, so a new field
 * may take a slot a gap used to cover. A field AFTER a gap keeps its own line,
 * so shrinking the gap by the wrong amount is still caught.
 *
 * CLI (run from anywhere; paths are resolved against the repository):
 *
 *   node contracts/script/storage-layout-guard.mjs write                 regenerate the golden file
 *   node contracts/script/storage-layout-guard.mjs check                 golden is fresh + tree complete
 *   node contracts/script/storage-layout-guard.mjs check --base <file>   ... and append-only vs <file>
 *   ... check --base <file> --honour-acks                                ... with breaks.ack.json (CI only)
 *
 * `--out <dir>` overrides the forge artifact directory (default contracts/out).
 * Any other argument is refused. Anything non-zero must stop the caller.
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

/** The file's contents, or `undefined` if it does not exist. One read, no separate existence check. */
function readIfPresent(path, encoding) {
  try {
    return readFileSync(path, encoding);
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
 * Line shapes (`region` is the root id, or a nested region named by the slot
 * of the field that owns it):
 *   L|region|slot|offset|type|path      a value of this type, as this field
 *   C|region|slot|offset|path           an inline struct, or a fixed array of
 *                                       non-value elements, starts here
 *   M|region|slot|offset|keyType|path   a mapping keyed by this type
 *   D|region|slot|offset|path           a dynamic array
 *   R|region|slot|offset|struct|path    a struct that contains itself (through
 *                                       a mapping or dynamic array) recurs
 *                                       here; its members are the lines
 *                                       already written for the enclosing one
 *   W|elementRegion|bytes               the stride of an array's elements
 *
 * `C` lines carry no type. A container's members already state everything its
 * type does; the line exists so a rename of the container can be anchored on
 * it like any other field.
 *
 * @param {string} rootId   region prefix for this root
 * @param {{storage: object[], types: Record<string, object>}} layout
 * @returns {{layout: Set<string>, enums: Set<string>, valueTypes: Set<string>}}
 *          `enums` and `valueTypes` are the enum and user-defined value type
 *          labels the layout uses; their `E` and `U` lines are added by the
 *          caller, which has the ASTs.
 */
export function ledgerFromLayout(rootId, layout, { probe = false } = {}) {
  const types = layout.types ?? {};
  const out = { layout: new Set(), enums: new Set(), valueTypes: new Set() };
  const typeOf = (id) => {
    const ty = types[id];
    if (!ty) throw new Error(`${rootId}: storage layout names type ${id} but does not define it`);
    return ty;
  };
  const noteValue = (id, ty) => {
    if (ty.label.startsWith('enum ')) out.enums.add(ty.label);
    if (id.startsWith('t_userDefinedValueType')) out.valueTypes.add(ty.label);
  };

  // `active` is the structs being expanded on the way to this member. A struct
  // can reach itself only through a mapping or dynamic array (inline recursion
  // does not compile), and expanding it again would never end.
  const member = (region, slot, offset, typeId, path, label, active) => {
    const ty = typeOf(typeId);
    if (GAP.test(label) && ty.encoding === 'inplace' && ty.base && isValueType(typeOf(ty.base))) return;
    if (ty.encoding === 'mapping') {
      const keyType = typeOf(ty.key);
      out.layout.add(`M|${region}|${slot}|${offset}|${keyType.label}|${path}`);
      noteValue(ty.key, keyType);
      const valueRegion = `${region}@${slot}[${keyType.label}]`;
      member(valueRegion, 0n, 0, ty.value, `${path}[]`, '', active);
    } else if (ty.encoding === 'dynamic_array') {
      const base = typeOf(ty.base);
      const elemRegion = `${region}@${slot}[]`;
      out.layout.add(`D|${region}|${slot}|${offset}|${path}`);
      out.layout.add(`W|${elemRegion}|${base.numberOfBytes}`);
      member(elemRegion, 0n, 0, ty.base, `${path}[]`, '', active);
    } else if (ty.encoding === 'bytes') {
      out.layout.add(`L|${region}|${slot}|${offset}|${ty.label}|${path}`);
    } else if (ty.encoding === 'inplace' && ty.members) {
      if (active.has(typeId)) {
        out.layout.add(`R|${region}|${slot}|${offset}|${ty.label}|${path}`);
        return;
      }
      out.layout.add(`C|${region}|${slot}|${offset}|${path}`);
      const inner = new Set(active).add(typeId);
      for (const m of ty.members) {
        member(region, slot + BigInt(m.slot), m.offset, m.type, path ? `${path}.${m.label}` : m.label, m.label, inner);
      }
    } else if (ty.encoding === 'inplace' && ty.base) {
      const base = typeOf(ty.base);
      if (isValueType(base)) {
        out.layout.add(`L|${region}|${slot}|${offset}|${ty.label}|${path}`);
        noteValue(ty.base, base);
      } else {
        out.layout.add(`C|${region}|${slot}|${offset}|${path}`);
        const elemRegion = `${region}@${slot}[${ty.label.match(/\[(\d+)\]$/)?.[1] ?? '?'}]`;
        out.layout.add(`W|${elemRegion}|${base.numberOfBytes}`);
        member(elemRegion, 0n, 0, ty.base, `${path}[]`, '', active);
      }
    } else if (isValueType(ty)) {
      out.layout.add(`L|${region}|${slot}|${offset}|${ty.label}|${path}`);
      noteValue(typeId, ty);
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
    const inner = new Set([only.type]);
    for (const m of ty.members) member(rootId, BigInt(m.slot), m.offset, m.type, m.label, m.label, inner);
  } else {
    for (const e of entries) member(rootId, BigInt(e.slot), e.offset, e.type, e.label, e.label, new Set());
  }
  return out;
}

// ─── Keccak-256 (the Ethereum hash, NOT NIST SHA3-256: different padding) ──
//
// 64-bit lanes as (lo, hi) pairs of 32-bit words, so the permutation runs on
// plain integer arithmetic. The guard hashes every source it reads (8 MB here)
// to prove each artifact was compiled from the file on disk.

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const RC_LO = KECCAK_RC.map((r) => Number(r & 0xffffffffn));
const RC_HI = KECCAK_RC.map((r) => Number(r >> 32n));
// Rotation offsets r[x][y].
const KECCAK_ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];

function keccakF(s) {
  const c = new Uint32Array(10);
  const b = new Uint32Array(50);
  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) {
      c[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      c[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const nl = c[2 * ((x + 1) % 5)];
      const nh = c[2 * ((x + 1) % 5) + 1];
      const dl = c[2 * ((x + 4) % 5)] ^ ((nl << 1) | (nh >>> 31));
      const dh = c[2 * ((x + 4) % 5) + 1] ^ ((nh << 1) | (nl >>> 31));
      for (let y = 0; y < 5; y++) {
        s[2 * (x + 5 * y)] ^= dl;
        s[2 * (x + 5 * y) + 1] ^= dh;
      }
    }
    // ρ and π
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const src = 2 * (x + 5 * y);
        const dst = 2 * (y + 5 * ((2 * x + 3 * y) % 5));
        const n = KECCAK_ROT[x][y];
        const lo = s[src];
        const hi = s[src + 1];
        if (n === 0) {
          b[dst] = lo;
          b[dst + 1] = hi;
        } else if (n < 32) {
          b[dst] = (lo << n) | (hi >>> (32 - n));
          b[dst + 1] = (hi << n) | (lo >>> (32 - n));
        } else if (n === 32) {
          b[dst] = hi;
          b[dst + 1] = lo;
        } else {
          b[dst] = (hi << (n - 32)) | (lo >>> (64 - n));
          b[dst + 1] = (lo << (n - 32)) | (hi >>> (64 - n));
        }
      }
    }
    // χ
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = 2 * (x + 5 * y);
        const i1 = 2 * (((x + 1) % 5) + 5 * y);
        const i2 = 2 * (((x + 2) % 5) + 5 * y);
        s[i] = b[i] ^ (~b[i1] & b[i2]);
        s[i + 1] = b[i + 1] ^ (~b[i1 + 1] & b[i2 + 1]);
      }
    }
    // ι
    s[0] ^= RC_LO[round];
    s[1] ^= RC_HI[round];
  }
}

/** Keccak-256 of a byte array, as a 0x-prefixed 32-byte hex string. Pure. */
export function keccak256(bytes) {
  const rate = 136;
  const blocks = Math.floor(bytes.length / rate) + 1;
  const padded = new Uint8Array(blocks * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Uint32Array(50);
  const view = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 4; i++) s[i] ^= view.getUint32(off + 4 * i, true);
    keccakF(s);
  }
  const out = new DataView(new ArrayBuffer(32));
  for (let i = 0; i < 8; i++) out.setUint32(4 * i, s[i], true);
  return `0x${Buffer.from(out.buffer).toString('hex')}`;
}

const utf8 = (text) => new TextEncoder().encode(text);
const MAX256 = (1n << 256n) - 1n;
const word = (n) => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
const hex32 = (n) => `0x${n.toString(16).padStart(64, '0')}`;

/** ERC-7201 slot for a namespace id. Pure. */
export function erc7201(id) {
  const inner = BigInt(keccak256(utf8(id))) - 1n;
  const outer = BigInt(keccak256(word(inner)));
  return hex32(outer & ~0xffn);
}

// ─── Compiler output: artifacts and ASTs ─────────────────────────────────

/** Every node of an AST (Solidity or Yul), depth first. */
function* nodes(n) {
  if (Array.isArray(n)) {
    for (const v of n) yield* nodes(v);
  } else if (n && typeof n === 'object') {
    if (typeof n.nodeType === 'string') yield n;
    for (const v of Object.values(n)) if (v && typeof v === 'object') yield* nodes(v);
  }
}

/** `file:line` of an AST `src` ("start:length:index") in `source` (a Buffer). */
function where(file, source, src) {
  const start = Number(String(src).split(':')[0]);
  if (!source || !Number.isInteger(start)) return file;
  return `${file}:${source.subarray(0, start).toString('utf8').split('\n').length}`;
}

/**
 * One source unit's AST, indexed. Declaration ids are unique only within one
 * compiler run, and forge's incremental builds put different files in
 * different runs, so the guard never resolves an id outside the unit it came
 * from: a reference it cannot resolve inside its own file is reported, not
 * guessed at.
 */
function indexUnit(unit) {
  const byId = new Map();
  const statementOf = new Map();
  // Every reference to a declaration, Solidity or Yul, read or write. A
  // position local is accepted only when the pointer's own read is its sole
  // use, so no form of write (assignment, `delete`, a tuple, `++`, a Yul
  // `:=`) has to be recognised for one to be refused.
  const uses = new Map();
  const use = (id) => uses.set(id, (uses.get(id) ?? 0) + 1);
  for (const n of nodes(unit)) {
    if (Number.isInteger(n.id)) byId.set(n.id, n);
    if (n.nodeType === 'VariableDeclarationStatement') {
      for (const d of n.declarations ?? []) if (d) statementOf.set(d.id, n);
    }
    if (n.nodeType === 'Identifier' && Number.isInteger(n.referencedDeclaration)) use(n.referencedDeclaration);
    if (n.nodeType === 'InlineAssembly') for (const r of n.externalReferences ?? []) use(r.declaration);
  }
  return { unit, byId, statementOf, uses };
}

/**
 * Read the forge artifacts under `outDir`, keeping only those compiled from the
 * files on disk as they are now.
 *
 * An artifact is used only if its compilation target exists under `root` and
 * every source its metadata lists still hashes to the keccak256 it was compiled
 * from. A leftover artifact from a deleted or moved source (forge never prunes
 * one, and CI restores out/ from a cache) is ignored; a stale artifact of a
 * file that still exists is an error, because the build did not run. Test and
 * script artifacts are never read: what survives on a chain is src/ and the
 * libraries it compiles.
 *
 * @returns {{contracts: {name: string, target: string, art: object}[],
 *            units: Map<string, object>, sources: Map<string, Buffer>,
 *            scope: Set<string>, problems: string[]}}
 *          `scope` is every source compiled into any src/ contract.
 */
export function loadBuild(outDir, { root = CONTRACTS_DIR } = {}) {
  const sources = new Map();
  const hashes = new Map();
  const problems = [];
  const sourceOf = (p) => {
    if (!sources.has(p)) sources.set(p, readIfPresent(join(root, p)));
    return sources.get(p);
  };
  const hashOf = (p) => {
    if (!hashes.has(p)) hashes.set(p, sourceOf(p) === undefined ? undefined : keccak256(sourceOf(p)));
    return hashes.get(p);
  };
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'build-info') walk(p);
      } else if (e.isFile() && e.name.endsWith('.json')) files.push(p);
    }
  };
  walk(outDir);

  const contracts = [];
  const units = new Map();
  const sourceOnly = [];
  let missingAst = false;
  for (const file of files.sort()) {
    const art = JSON.parse(readFileSync(file, 'utf8'));
    if (!art.abi) continue; // not an artifact
    const meta = typeof art.metadata === 'string' ? JSON.parse(art.metadata) : art.metadata;
    const [target, name] = Object.entries(meta?.settings?.compilationTarget ?? {})[0] ?? [];
    if (!target && art.ast && Array.isArray(art.abi) && !art.abi.length && !meta) {
      // A source with no contract in it (only structs, enums, free functions
      // or imports) gets an artifact carrying just its AST. It has no hashes
      // of its own; it is used below only for a file that a current src/
      // artifact's metadata proves was compiled as it is on disk now.
      sourceOnly.push(art.ast);
      continue;
    }
    if (!target) {
      problems.push(`${relative(outDir, file)} has no metadata naming the source it was compiled from; the guard cannot tell whether it is current (forge must keep its default \`metadata\` output)`);
      continue;
    }
    if (!target.startsWith('src/') && !target.startsWith('lib/')) continue;
    if (sourceOf(target) === undefined) continue; // leftover from a deleted or moved source
    const stale = Object.entries(meta.sources ?? {}).filter(([p, s]) => hashOf(p) !== s.keccak256).map(([p]) => p);
    if (stale.length) {
      problems.push(`${relative(outDir, file)} was not compiled from the current ${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ` and ${stale.length - 3} more` : ''} — run forge build (forge clean first if it persists)`);
      continue;
    }
    if (!art.ast) {
      missingAst = true;
      continue;
    }
    contracts.push({ name, target, art, meta });
    units.set(art.ast.absolutePath, art.ast);
  }
  if (missingAst) problems.push('artifacts carry no AST — foundry.toml must set `ast = true` in the active profile');

  const scope = new Set();
  for (const c of contracts) if (c.target.startsWith('src/')) Object.keys(c.meta.sources).forEach((p) => scope.add(p));
  for (const ast of sourceOnly) if (scope.has(ast.absolutePath) && !units.has(ast.absolutePath)) units.set(ast.absolutePath, ast);
  for (const p of [...scope].sort()) if (!units.has(p)) problems.push(`${p} is compiled into src/ but no current artifact carries its AST`);
  return { contracts, units, sources, scope, problems };
}

/**
 * The one current artifact of `name` compiled from `src/`. A contract of the
 * same name in a test, a script or a dependency is never it, and neither is a
 * leftover from a source that no longer exists.
 */
export function contractArtifact(build, name) {
  const hits = build.contracts.filter((c) => c.name === name && c.target.startsWith('src/'));
  if (hits.length !== 1) {
    throw new Error(`${name}: expected exactly one current artifact compiled from src/, found ${hits.length}${hits.length ? ` (${hits.map((h) => h.target).join(', ')})` : ' (run forge build first)'}`);
  }
  if (!hits[0].art.storageLayout) {
    throw new Error(`${name}: artifact has no storageLayout — foundry.toml must carry extra_output = ["storageLayout"] in the active profile`);
  }
  return hits[0].art;
}

// ─── Sources, from the AST ───────────────────────────────────────────────

/**
 * Every write of a storage pointer's slot (`<ptr>.slot := …` in inline
 * assembly) in one source unit, resolved to the struct the pointer is typed as
 * and the position constant its slot is set from. Pure over the AST.
 *
 * The slot value may be the constant itself, or a local that is initialised
 * once from the constant (or from a parameterless function in the same file
 * that returns it) and is used nowhere but in this one read. Anything else
 * comes back with `error` set: a pointer whose position the guard cannot name
 * is a namespace it cannot check. `via` names the function, when one is used,
 * so the caller can refuse one that is overridden. `parameter` marks a pointer
 * whose slot is a parameter of its function (a generic accessor); it carries
 * an error too, and only a roots.json exemption passes it.
 *
 * @returns {{struct?: string, constant?: string, via?: string, parameter?: true, src: string, error?: string}[]}
 */
export function storagePointers(unit) {
  const ix = indexUnit(unit);
  const out = [];
  const constantOf = (id, what) => {
    const d = ix.byId.get(id);
    if (!d) return { error: `${what} is declared in another file, which the guard does not resolve` };
    if (d.nodeType === 'VariableDeclaration' && d.constant) return { constant: d.name };
    return { error: `${what} is not a constant` };
  };
  const isParameter = (decl) => {
    const fn = ix.byId.get(decl.scope);
    return fn?.nodeType === 'FunctionDefinition' && (fn.parameters?.parameters ?? []).some((p) => p.id === decl.id);
  };
  const resolveLocal = (decl) => {
    if (decl.constant) return { constant: decl.name };
    const stmt = ix.statementOf.get(decl.id);
    if (!stmt) return { error: `\`${decl.name}\` is not a local initialised from a position constant` };
    if (ix.uses.get(decl.id) !== 1) return { error: `\`${decl.name}\` is used again besides this read, so the guard cannot tell which slot it holds` };
    const init = stmt.initialValue;
    if (init?.nodeType === 'Identifier') return constantOf(init.referencedDeclaration, `\`${init.name}\``);
    if (init?.nodeType === 'FunctionCall' && init.expression?.nodeType === 'Identifier' && !(init.arguments ?? []).length) {
      const fn = ix.byId.get(init.expression.referencedDeclaration);
      const body = fn?.nodeType === 'FunctionDefinition' ? fn.body?.statements ?? [] : [];
      const ret = body.length === 1 && body[0].nodeType === 'Return' ? body[0].expression : undefined;
      if (ret?.nodeType === 'Identifier') {
        const c = constantOf(ret.referencedDeclaration, `\`${ret.name}\``);
        return c.error ? c : { ...c, via: fn.virtual ? fn.name : undefined };
      }
      return { error: `\`${decl.name}\` is set from \`${init.expression.name}()\`, which does not just return a constant from this file` };
    }
    return { error: `\`${decl.name}\` is not initialised from a named position constant` };
  };

  for (const asm of nodes(unit)) {
    if (asm.nodeType !== 'InlineAssembly') continue;
    const refs = new Map((asm.externalReferences ?? []).map((r) => [r.src, r]));
    for (const y of nodes(asm.AST)) {
      if (y.nodeType !== 'YulAssignment') continue;
      for (const v of y.variableNames ?? []) {
        const ref = refs.get(v.src);
        if (!ref || ref.suffix !== 'slot') continue;
        const ptr = ix.byId.get(ref.declaration);
        const struct = ptr?.storageLocation === 'storage' ? ptr.typeDescriptions?.typeString?.match(/^struct (\S+)( storage( pointer| ref)?)?$/)?.[1] : undefined;
        if (!struct) {
          out.push({ src: v.src, error: `\`${v.name} :=\` sets the slot of something other than a struct storage pointer (${ptr?.typeDescriptions?.typeString ?? 'unresolved'})` });
          continue;
        }
        const valueRef = y.value?.nodeType === 'YulIdentifier' ? refs.get(y.value.src) : undefined;
        const decl = valueRef && ix.byId.get(valueRef.declaration);
        if (decl && isParameter(decl)) {
          // A generic accessor: each caller chooses the slot, so this pointer
          // names no namespace of its own. Reported, so only an exemption can
          // pass it, and the exemption covers exactly this form.
          out.push({ struct, src: v.src, parameter: true, error: `\`${v.name} :=\` takes its slot from the parameter \`${decl.name}\`` });
          continue;
        }
        if (!valueRef || valueRef.suffix) {
          out.push({ struct, src: v.src, error: `\`${v.name} :=\` is not set from a named position constant` });
          continue;
        }
        const r = decl?.nodeType === 'VariableDeclaration' ? resolveLocal(decl) : { error: `\`${y.value.name}\` is not resolvable in this file` };
        out.push({ struct, src: v.src, ...r });
      }
    }
  }
  return out;
}

/**
 * Evaluate a 256-bit constant expression from the AST: literals, string
 * literals, `keccak256`, `abi.encode` of words, `uint256(…)` / `bytes32(…)`,
 * parentheses, `+ - & | ^ ~`, and other constants of the same file. That
 * covers the literal, `keccak256("…")` and ERC-7201 forms, written any way the
 * compiler accepts. Anything else is refused, never approximated. Pure.
 */
function evaluate(expr, ix, depth = 0) {
  const fail = (why) => {
    throw new Error(`unsupported position expression (${why})`);
  };
  if (depth > 32) fail('nested too deep');
  const int = (v) => (typeof v === 'bigint' ? v : fail('a byte string where a word is needed'));
  switch (expr?.nodeType) {
    case 'Literal':
      if (expr.subdenomination) fail(`a ${expr.subdenomination} literal`);
      if (expr.kind === 'number') {
        const text = String(expr.value).replace(/_/g, '');
        if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) fail(`literal ${expr.value}`);
        return BigInt(text);
      }
      if (expr.kind === 'string' || expr.kind === 'hexString') return Uint8Array.from(Buffer.from(expr.hexValue, 'hex'));
      return fail(`a ${expr.kind} literal`);
    case 'TupleExpression':
      if (expr.components?.length !== 1 || expr.isInlineArray) fail('a tuple');
      return evaluate(expr.components[0], ix, depth + 1);
    case 'Identifier': {
      const d = ix.byId.get(expr.referencedDeclaration);
      if (d?.nodeType !== 'VariableDeclaration' || !d.constant || !d.value) fail(`\`${expr.name}\` is not a constant of this file`);
      return evaluate(d.value, ix, depth + 1);
    }
    case 'UnaryOperation':
      if (expr.operator !== '~') fail(`operator ${expr.operator}`);
      return ~int(evaluate(expr.subExpression, ix, depth + 1)) & MAX256;
    case 'BinaryOperation': {
      const a = int(evaluate(expr.leftExpression, ix, depth + 1));
      const b = int(evaluate(expr.rightExpression, ix, depth + 1));
      const ops = { '+': a + b, '-': a - b, '&': a & b, '|': a | b, '^': a ^ b };
      if (!(expr.operator in ops)) fail(`operator ${expr.operator}`);
      const r = ops[expr.operator];
      if (r < 0n || r > MAX256) fail('a value outside 256 bits');
      return r;
    }
    case 'FunctionCall': {
      const callee = expr.expression;
      const args = expr.arguments ?? [];
      if (expr.kind === 'typeConversion') {
        const to = callee?.typeName?.name;
        if (to !== 'uint256' && to !== 'bytes32') fail(`a conversion to ${to}`);
        if (args.length !== 1) fail('a conversion of several values');
        return int(evaluate(args[0], ix, depth + 1));
      }
      if (callee?.nodeType === 'Identifier' && callee.name === 'keccak256' && callee.referencedDeclaration < 0 && args.length === 1) {
        const v = evaluate(args[0], ix, depth + 1);
        return BigInt(keccak256(typeof v === 'bigint' ? fail('keccak256 of a word') : v));
      }
      if (callee?.nodeType === 'MemberAccess' && callee.memberName === 'encode' && callee.expression?.name === 'abi' && callee.expression.referencedDeclaration < 0) {
        const words = args.map((a) => word(int(evaluate(a, ix, depth + 1))));
        return Uint8Array.from(words.flatMap((w) => [...w]));
      }
      return fail('a call');
    }
    default:
      return fail(expr?.nodeType ?? 'nothing');
  }
}

/**
 * The bytes32 a position constant evaluates to, from its AST. A literal is
 * also checked against the ERC-7201 formula in the comment just above it,
 * when there is one, so a hand-typed hash that disagrees with its stated
 * namespace fails. Pure over the AST and the source bytes.
 */
export function positionOf(constantName, unit, source) {
  const ix = indexUnit(unit);
  const decls = [...ix.byId.values()].filter((n) => n.nodeType === 'VariableDeclaration' && n.constant && n.name === constantName);
  if (decls.length !== 1) throw new Error(`${unit.absolutePath}: expected exactly one constant ${constantName}, found ${decls.length}`);
  const [decl] = decls;
  let value;
  try {
    value = hex32(evaluate(decl.value, ix));
  } catch (e) {
    throw new Error(`${constantName}: ${e.message}`);
  }
  if (decl.value?.nodeType === 'Literal' && source) {
    const start = Number(decl.src.split(':')[0]);
    const doc = source.subarray(0, start).toString('utf8').split('\n').slice(-4).join('\n');
    const ns = doc.match(/keccak256\(abi\.encode\(uint256\(keccak256\("([^"]+)"\)\)\s*-\s*1\)\)\s*&\s*~bytes32\(uint256\(0xff\)\)/);
    if (ns && erc7201(ns[1]) !== value) {
      throw new Error(`${constantName} = ${value}, but its comment derives ERC-7201 "${ns[1]}" = ${erc7201(ns[1])}`);
    }
  }
  return value;
}

/**
 * Enum members and user-defined value types, by canonical name, across the
 * given units. A name declared twice is recorded as ambiguous. Pure.
 */
export function typeIndex(units) {
  const enums = new Map();
  const valueTypes = new Map();
  const add = (map, key, value) => map.set(key, map.has(key) ? null : value);
  for (const unit of units) {
    for (const n of nodes(unit)) {
      if (n.nodeType === 'EnumDefinition') add(enums, n.canonicalName, n.members.map((m) => m.name));
      if (n.nodeType === 'UserDefinedValueTypeDefinition') {
        add(valueTypes, n.canonicalName, n.underlyingType?.typeDescriptions?.typeString);
        if (n.canonicalName !== n.name) add(valueTypes, `#${n.name}`, n.underlyingType?.typeDescriptions?.typeString);
      }
    }
  }
  return { enums, valueTypes };
}

/**
 * The UUPS implementations among `contracts`: deployable (non-empty runtime
 * code) and upgradeable through ERC-1822, that is exposing `proxiableUUID()`.
 * Read from the compiler's own method list, so it does not matter how the
 * contract reaches UUPSUpgradeable, or whether it does at all. Pure.
 */
export function uupsContracts(contracts) {
  return contracts
    .filter((c) => c.target.startsWith('src/'))
    .filter((c) => (c.art.deployedBytecode?.object ?? '0x').length > 2 && c.art.methodIdentifiers?.['proxiableUUID()'])
    .map((c) => c.name)
    .sort();
}

// ─── Build + compare ─────────────────────────────────────────────────────

/**
 * What an exemption in roots.json may pass: only the pointers that take their
 * slot from a parameter (a generic accessor such as StorageSlot's, whose
 * callers choose the slot). Every other pointer in an exempted file, including
 * one a dependency bump adds there, is checked like any other. Pure.
 */
export function applyExemption(found) {
  return { exempted: found.filter((p) => p.parameter), kept: found.filter((p) => !p.parameter) };
}

/**
 * Completeness of the storage pointers against the namespace roots. Pure.
 *
 * Every pointer must resolve, must be set from a constant some root names,
 * and must view that namespace as the very struct the root probes: a second
 * struct read at a rooted position is a layout nobody records. Every root must
 * have at least one such pointer, or its probe may describe storage that
 * position does not hold. A position that comes from a virtual function is
 * refused when a function of that name is declared anywhere else in scope,
 * since an override moves the namespace.
 *
 * @param {{namespaces: object[], probeStructs: Record<string, string>,
 *          pointers: {file: string, at: string, struct?: string, constant?: string, via?: string, error?: string}[],
 *          functionFiles: Map<string, string[]>}} args
 */
export function pointerProblems({ namespaces, probeStructs, pointers, functionFiles }) {
  const problems = [];
  const resolved = [];
  for (const p of pointers) {
    const declared = p.via ? functionFiles.get(p.via) ?? [] : [];
    if (p.error) problems.push(`${p.at}: ${p.error}`);
    else if (declared.length > 1) {
      problems.push(`${p.at}: the position comes from \`${p.via}()\`, which is virtual and declared ${declared.length} times (${[...new Set(declared)].join(', ')}), so which position a contract uses cannot be read statically`);
    } else resolved.push(p);
  }
  for (const ns of namespaces) {
    const bound = resolved.filter((p) => p.file === ns.positionFile && p.constant === ns.positionConstant);
    if (!bound.length) problems.push(`root ${ns.id}: ${ns.positionFile} sets no storage pointer from ${ns.positionConstant}, so the probe ${ns.probe} may not describe the storage that position holds`);
    for (const p of bound) {
      if (p.struct !== probeStructs[ns.id]) problems.push(`${p.at} reads the ${ns.id} namespace (${ns.positionConstant}) as ${p.struct}, but its root probes ${probeStructs[ns.id]}; every view of one namespace must be the probed struct`);
    }
  }
  for (const p of resolved) {
    if (!namespaces.some((ns) => ns.positionFile === p.file && ns.positionConstant === p.constant)) {
      problems.push(`${p.at} points ${p.struct} storage at ${p.constant}, but no namespace root in roots.json names that position`);
    }
  }
  return problems;
}

/** Parse roots.json. A malformed manifest is an error, never an empty check. Pure. */
export function readRoots(text) {
  const roots = JSON.parse(text);
  if (!Array.isArray(roots.namespaces) || !Array.isArray(roots.uups)) throw new Error('roots.json needs `namespaces` and `uups` arrays');
  roots.namespaces.forEach((ns, i) => {
    for (const k of ['id', 'probe', 'positionFile', 'positionConstant']) {
      if (typeof ns?.[k] !== 'string' || !ns[k]) throw new Error(`roots.json: namespaces[${i}].${k} must be a non-empty string`);
    }
  });
  const exemptions = roots.pointerExemptions ?? [];
  if (!Array.isArray(exemptions)) throw new Error('roots.json: `pointerExemptions` must be an array');
  exemptions.forEach((e, i) => {
    if (typeof e?.file !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) throw new Error(`roots.json: pointerExemptions[${i}] needs a \`file\` and a \`reason\``);
  });
  return { ...roots, pointerExemptions: exemptions };
}

/**
 * The whole ledger for the tree, plus the completeness findings. Reads the
 * roots manifest and the forge artifacts (layouts and ASTs) under `outDir`.
 */
export function buildLedger({ outDir = join(CONTRACTS_DIR, 'out'), roots = readRoots(readFileSync(ROOTS_FILE, 'utf8')), root = CONTRACTS_DIR, facetsFile = FACETS_FILE } = {}) {
  const build = loadBuild(outDir, { root });
  const problems = [...build.problems];
  const layout = new Set();
  const enums = new Set();
  const valueTypes = new Set();
  const rootIds = new Set();
  const add = (id, l, opts) => {
    if (rootIds.has(id)) throw new Error(`root id ${id} is listed twice`);
    rootIds.add(id);
    const led = ledgerFromLayout(id, l, opts);
    led.layout.forEach((x) => layout.add(x));
    led.enums.forEach((x) => enums.add(x));
    led.valueTypes.forEach((x) => valueTypes.add(x));
  };

  // Every storage pointer in everything src/ compiles, resolved from the AST.
  const exempt = new Map(roots.pointerExemptions.map((e) => [e.file, e]));
  const pointers = [];
  for (const file of [...build.scope].sort()) {
    const unit = build.units.get(file);
    if (!unit) continue;
    const found = storagePointers(unit).map((p) => ({ ...p, file, at: where(file, build.sources.get(file), p.src) }));
    if (exempt.has(file)) {
      const { kept, exempted } = applyExemption(found);
      if (!exempted.length) problems.push(`roots.json exempts ${file}, which no longer has a pointer taking its slot from a parameter; delete the exemption`);
      pointers.push(...kept);
      continue;
    }
    pointers.push(...found);
  }
  for (const e of exempt.keys()) if (!build.scope.has(e)) problems.push(`roots.json exempts ${e}, which nothing in src/ compiles; delete the exemption`);
  const functionFiles = new Map();
  for (const file of build.scope) {
    for (const n of nodes(build.units.get(file) ?? {})) {
      if (n.nodeType === 'FunctionDefinition' && n.name) functionFiles.set(n.name, [...(functionFiles.get(n.name) ?? []), file]);
    }
  }

  // Each namespace root: its probe's layout, and its position from the AST.
  const probeStructs = {};
  const positions = new Map();
  for (const ns of roots.namespaces) {
    const probeLayout = contractArtifact(build, ns.probe).storageLayout;
    add(ns.id, probeLayout, { probe: true });
    probeStructs[ns.id] = probeLayout.types[probeLayout.storage[0].type].label.replace(/^struct /, '');
    const unit = build.units.get(ns.positionFile);
    if (!unit) {
      problems.push(`root ${ns.id}: ${ns.positionFile} is not compiled into src/, so its position cannot be read`);
      continue;
    }
    const position = positionOf(ns.positionConstant, unit, build.sources.get(ns.positionFile));
    if (positions.has(position)) problems.push(`roots ${positions.get(position)} and ${ns.id} sit at the same position ${position}`);
    positions.set(position, ns.id);
    layout.add(`P|${ns.id}|${position}`);
  }
  problems.push(...pointerProblems({ namespaces: roots.namespaces, probeStructs, pointers, functionFiles }));

  // UUPS implementations: their own state variables are the layout.
  for (const c of roots.uups) add(`uups:${c}`, contractArtifact(build, c).storageLayout);
  const found = uupsContracts(build.contracts);
  for (const c of found) if (!roots.uups.includes(c)) problems.push(`${c} is a UUPS implementation (it exposes proxiableUUID()) but roots.json does not list it`);
  for (const c of roots.uups) if (!found.includes(c)) problems.push(`roots.json lists ${c} as UUPS, but it does not expose proxiableUUID()`);

  // Enum members and value types, from the declarations the compiler resolved.
  const types = typeIndex([...build.scope].map((f) => build.units.get(f)).filter(Boolean));
  for (const label of [...enums].sort()) {
    const members = types.enums.get(label.replace(/^enum /, ''));
    if (!members) problems.push(`${label}: expected exactly one declaration among the sources src/ compiles`);
    else members.forEach((m, i) => layout.add(`E|${label}|${i}|${m}`));
  }
  for (const label of [...valueTypes].sort()) {
    const underlying = types.valueTypes.get(label) ?? types.valueTypes.get(`#${label}`);
    if (!underlying) problems.push(`value type ${label}: expected exactly one declaration among the sources src/ compiles`);
    else layout.add(`U|${label}|${underlying}`);
  }

  // A facet with an ordinary state variable writes at slot 0.. of the Diamond.
  const facets = JSON.parse(readFileSync(facetsFile, 'utf8'));
  for (const c of [...facets.facets, ...facets.proxy, 'DiamondCutFacet']) {
    const l = contractArtifact(build, c).storageLayout;
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

const FIELD_LINES = 'LCMDR';

/**
 * Rewrite `lines` through the declared renames, oldest first, so a base laid
 * down before a rename reads with today's names. A rename is anchored on the
 * exact line its field had (region, slot, offset and old path), which may be a
 * value, a container, a mapping or an array: it applies only to a ledger that
 * HAS that field there, which is what keeps a later, unrelated field reusing
 * the old name from being rewritten. Within a root every path is unique
 * (Solidity forbids two members of one name), so the anchor's path prefix
 * identifies the field's nested lines exactly. Pure.
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
      return FIELD_LINES.includes(f[0]) && f[1] === r.region && f[2] === String(r.slot) && f[3] === String(r.offset) && f[f.length - 1] === r.from;
    });
    if (!anchored) continue;
    const root = r.region.split('@')[0];
    out = out.map((l) => {
      const f = l.split('|');
      if (!FIELD_LINES.includes(f[0]) || f[1].split('@')[0] !== root) return l;
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
 * file exactly, so one can never outlive the comparison it was written for,
 * and a live one may list only lines this change removes (`overreach`). A
 * comparison against a deployed chain passes no acks at all. Pure.
 */
export function appendOnlyVerdict(base, current, { baseSha256, acks = [], renames = [] } = {}) {
  const live = acks.filter((a) => a.baseSha256 === baseSha256);
  const acked = new Set(live.flatMap((a) => a.lines ?? []));
  const missing = missingLines(applyRenames(base.layout, renames), current.layout);
  const gone = new Set(missing);
  return {
    breaks: missing.filter((l) => !acked.has(l)),
    acknowledged: missing.filter((l) => acked.has(l)),
    // A live acknowledgement accepts exactly the measured break. A line it
    // lists that this change does not remove would pre-authorise a later
    // removal against the same base, so it is refused, not ignored.
    overreach: [...acked].filter((l) => !gone.has(l)).sort(),
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

const USAGE = 'usage: storage-layout-guard.mjs write [--out <dir>] | check [--out <dir>] [--base <golden> [--honour-acks]]';

/**
 * Parse the command line strictly: one mode, known flags only, each at most
 * once, and every value present. A typo must stop the run, not quietly skip
 * the comparison it asked for. Pure; throws on anything else.
 */
export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'write' && mode !== 'check') throw new Error(USAGE);
  const opts = { mode };
  const valued = { '--out': 'out', '--base': 'base' };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const key = valued[flag] ?? (flag === '--honour-acks' ? 'honourAcks' : undefined);
    if (!key) throw new Error(`unknown argument ${flag}\n${USAGE}`);
    if (key in opts) throw new Error(`${flag} given twice`);
    if (key === 'honourAcks') {
      opts.honourAcks = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    opts[key] = value;
  }
  if (mode === 'write' && (opts.base || opts.honourAcks)) throw new Error(`write takes no --base or --honour-acks\n${USAGE}`);
  if (opts.honourAcks && !opts.base) throw new Error('--honour-acks applies only to a --base comparison');
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const fail = (msg) => {
    console.error(`storage-layout-guard: ${msg}`);
    return 1;
  };
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    return fail(e.message);
  }
  let golden;
  let problems;
  try {
    ({ golden, problems } = buildLedger({ outDir: opts.out ?? join(CONTRACTS_DIR, 'out') }));
  } catch (e) {
    return fail(e.message);
  }
  if (problems.length) {
    problems.forEach((p) => console.error(`storage-layout-guard: ${p}`));
    return fail(`${problems.length} completeness problem(s)`);
  }

  if (opts.mode === 'write') {
    writeFileSync(GOLDEN_FILE, serializeGolden(golden));
    console.log(`storage-layout-guard: wrote ${relative(REPO_ROOT, GOLDEN_FILE)} (${golden.layout.length} lines, ${golden.roots.length} roots)`);
    return 0;
  }

  const committedText = readIfPresent(GOLDEN_FILE, 'utf8');
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
  if (opts.base) {
    const baseText = readFileSync(opts.base, 'utf8');
    const base = JSON.parse(baseText);
    if (base.format !== GOLDEN_FORMAT) {
      return fail(`the base golden is format ${base.format}, this guard reads format ${GOLDEN_FORMAT}. A format change must ship a translation of the old format, or no base can be compared.`);
    }
    const renamesText = readIfPresent(RENAMES_FILE, 'utf8');
    const renames = renamesText === undefined ? [] : readRenames(renamesText);
    const acksText = opts.honourAcks ? readIfPresent(ACKS_FILE, 'utf8') : undefined;
    const acks = acksText === undefined ? [] : readAcks(acksText);
    const v = appendOnlyVerdict(base, golden, { baseSha256: sha256(baseText), acks, renames });
    if (v.breaks.length) {
      console.error(`storage-layout-guard: LAYOUT BREAK — ${v.breaks.length} line(s) of the base layout are gone. A proxy upgraded in place across this change would read existing state at the wrong place, or under the wrong field:`);
      v.breaks.slice(0, 40).forEach((l) => console.error(`  - ${l}`));
      if (v.breaks.length > 40) console.error(`  … and ${v.breaks.length - 40} more`);
      console.error(`  If a field only changed its NAME and kept its meaning, declare it in ${relative(REPO_ROOT, RENAMES_FILE)}.`);
      if (opts.honourAcks) {
        console.error(`  If the break is intended (no chain will be upgraded in place across it), acknowledge it in ${relative(REPO_ROOT, ACKS_FILE)} with baseSha256 ${sha256(baseText)}.`);
      } else {
        console.error('  Acknowledgements are not read by this comparison: an acknowledged break still means no chain may be upgraded in place across it.');
      }
      rc = 1;
    } else {
      console.log('storage-layout-guard: append-only against the base layout');
    }
    if (v.overreach.length) {
      console.error(`storage-layout-guard: ${relative(REPO_ROOT, ACKS_FILE)} acknowledges ${v.overreach.length} line(s) this change does not remove. An acknowledgement must list exactly the break it accepts:`);
      v.overreach.slice(0, 40).forEach((l) => console.error(`  - ${l}`));
      rc = 1;
    }
    if (v.acknowledged.length) console.log(`storage-layout-guard: ${v.acknowledged.length} line(s) acknowledged as an intended break in ${relative(REPO_ROOT, ACKS_FILE)}`);
    if (v.staleAcks) console.log(`storage-layout-guard: note — ${v.staleAcks} acknowledgement(s) name a different base and are inert; delete them`);
  }
  return rc;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
