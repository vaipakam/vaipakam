#!/usr/bin/env node
/**
 * @file Builds the ERC-7730 clear-signing descriptors for the Diamond's user
 *       calls and for every EIP-712 message Vaipakam asks a person to sign
 *       (#3348, #3718 step 1).
 *
 * Inputs, all in this repository:
 *   - the exported facet ABIs (src/abis/*.json) and the facet list
 *     (scripts/diamond-facets.json);
 *   - which functions a person signs (clear-signing/scope.json);
 *   - what the wallet shows for them (clear-signing/display.mjs);
 *   - the Solidity sources, for every enum, every constant-coded choice and
 *     every EIP-712 type string, so none of them is copied by hand;
 *   - the per-chain addresses (src/deployments.json);
 *   - the permissionless-steps ledger (contracts/permissionless-steps.json),
 *     whose `user` steps must be `user` here too.
 *
 * It refuses, by name: an unclassified non-view function, a scope entry for a
 * function that no longer exists, a user function with no intent, a field
 * with no rule, a rule for a path the function does not have, an enum shown
 * raw, and a descriptor the vendored ERC-7730 v2 schema rejects.
 *
 * Usage:
 *   node scripts/build-clear-signing.mjs           write clear-signing/descriptors/
 *   node scripts/build-clear-signing.mjs --check   fail if the committed files differ
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAddress, keccak256, toBytes, toFunctionSelector } from 'viem';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PKG, '../..');
const SCHEMA_URL = 'https://eips.ethereum.org/assets/eip-7730/erc7730-v2.schema.json';

/** Thrown for every refusal; the CLI prints all of them. */
export class ClearSigningError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

// ── Solidity source reading ─────────────────────────────────────────────

/** Strip comments, keeping string literals intact. */
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
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** An index of the Solidity sources under `root`. */
export function readSources(root) {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.sol')) files.push({ rel: path.relative(REPO, p), text: stripComments(fs.readFileSync(p, 'utf8')) });
    }
  };
  walk(root);
  return files;
}

const containerRe = (name) => new RegExp(`\\b(?:abstract\\s+contract|contract|library|interface)\\s+${name}\\b[^{]*\\{`);

/** The body of contract/library `name`, braces balanced. */
function containerBody(sources, name) {
  for (const f of sources) {
    const m = containerRe(name).exec(f.text);
    if (!m) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < f.text.length && depth > 0; i++) {
      if (f.text[i] === '{') depth++;
      else if (f.text[i] === '}') depth--;
    }
    return { file: f.rel, text: f.text.slice(start, i - 1) };
  }
  return null;
}

/** Members of `Lib.Enum` (inside a container) or of a file-level `Enum`. */
export function readEnum(sources, qualified) {
  const [owner, name] = qualified.includes('.') ? qualified.split('.') : [null, qualified];
  const bodies = owner ? [containerBody(sources, owner)].filter(Boolean) : sources.map((f) => ({ file: f.rel, text: f.text }));
  const found = new Set();
  for (const b of bodies) {
    const re = new RegExp(`\\benum\\s+${name}\\s*\\{([^}]*)\\}`, 'g');
    for (const m of b.text.matchAll(re)) found.add(m[1].split(',').map((s) => s.trim()).filter(Boolean).join(','));
  }
  if (found.size !== 1) throw new ClearSigningError([`enum ${qualified}: found ${found.size} distinct definitions in contracts/src`]);
  return [...found][0].split(',');
}

/** Integer constants of `owner` whose names start with `prefix`. */
export function readConstants(sources, owner, prefix) {
  const body = containerBody(sources, owner);
  if (!body) throw new ClearSigningError([`constants ${owner}.${prefix}*: no contract or library ${owner}`]);
  const out = {};
  const re = new RegExp(`\\buint\\d+\\s+(?:(?:internal|public|private)\\s+)*constant\\s+(${prefix}\\w*)\\s*=\\s*([^;]+);`, 'g');
  for (const m of body.text.matchAll(re)) {
    const expr = m[2].trim();
    let v;
    if (/^\d+$/.test(expr)) v = BigInt(expr);
    else if (/^0x[0-9a-fA-F]+$/.test(expr)) v = BigInt(expr);
    else if (/^1\s*<<\s*\d+$/.test(expr)) v = 1n << BigInt(expr.split('<<')[1].trim());
    else throw new ClearSigningError([`constant ${owner}.${m[1]}: cannot read the value ${expr}`]);
    out[m[1]] = v;
  }
  return out;
}

/** The string a `NAME = keccak256("..." "...")` or `NAME = "..." "...";` constant spells. */
export function readTypeString(sources, file, constant) {
  const f = sources.find((s) => s.rel === file);
  if (!f) throw new ClearSigningError([`type string ${constant}: no source ${file}`]);
  const m = new RegExp(`\\b${constant}\\s*=\\s*([^;]+);`).exec(f.text);
  if (!m) throw new ClearSigningError([`type string ${constant}: not found in ${file}`]);
  const lits = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  if (lits.length === 0) throw new ClearSigningError([`type string ${constant} in ${file} has no string literal`]);
  return lits.join('');
}

/** The address a `NAME = 0x...;` constant holds. */
function readAddressConstant(sources, file, constant) {
  const f = sources.find((s) => s.rel === file);
  const m = f && new RegExp(`\\b${constant}\\s*=\\s*(0x[0-9a-fA-F]{40})\\s*;`).exec(f.text);
  if (!m) throw new ClearSigningError([`address ${constant}: not found in ${file}`]);
  return getAddress(m[1]);
}

// ── EIP-712 type strings ────────────────────────────────────────────────

/** `{ primary, types: { Name: [{type, name}] } }` from an encodeType string. */
export function parseEncodeType(s) {
  const types = {};
  let primary = null;
  const re = /([A-Za-z_]\w*)\(([^()]*)\)/g;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    if (m.index !== consumed) throw new ClearSigningError([`malformed EIP-712 type string near: ${s.slice(consumed, consumed + 40)}`]);
    consumed = m.index + m[0].length;
    primary ??= m[1];
    types[m[1]] = m[2] === '' ? [] : m[2].split(',').map((p) => {
      const [type, name] = p.split(' ');
      return { type, name };
    });
  }
  if (consumed !== s.length) throw new ClearSigningError([`malformed EIP-712 type string: ${s}`]);
  return { primary, types };
}

// ── Leaves ──────────────────────────────────────────────────────────────

const baseOf = (t) => t.replace(/(\[\d*\])+$/, '');
const isArray = (t) => /\[\d*\]$/.test(t);
const structName = (internalType) => internalType?.replace(/^struct /, '').replace(/(\[\d*\])+$/, '');
const enumName = (internalType) => (internalType?.startsWith('enum ') ? internalType.slice(5).replace(/(\[\d*\])+$/, '') : null);

/** Every leaf of an ABI input list: `{path, name, parent, type, enumType}`. */
export function abiLeaves(inputs, prefix = '', parent = null) {
  const out = [];
  for (const i of inputs) {
    if (!i.name) throw new ClearSigningError([`an unnamed parameter under "${prefix || '(top)'}"; name it in Solidity so a wallet can label it`]);
    const p = `${prefix}${i.name}`;
    if (i.components) {
      out.push(...abiLeaves(i.components, `${p}${isArray(i.type) ? '.[].' : '.'}`, structName(i.internalType)));
    } else {
      out.push({ path: p, name: i.name, parent, type: i.type, enumType: enumName(i.internalType) });
    }
  }
  return out;
}

/** Every leaf of an EIP-712 type: the same shape, `parent` being the type name. */
export function typedLeaves(types, typeName, prefix = '') {
  const out = [];
  for (const m of types[typeName]) {
    const p = `${prefix}${m.name}`;
    const base = baseOf(m.type);
    if (types[base]) out.push(...typedLeaves(types, base, `${p}${isArray(m.type) ? '.[].' : '.'}`));
    else out.push({ path: p, name: m.name, parent: typeName, type: m.type, enumType: null });
  }
  return out;
}

/** The human-readable fragment ERC-7730 keys a function by. */
export function formatKey(fn) {
  const param = (i) => {
    const t = i.components ? `(${i.components.map(param).join(',')})${i.type.slice('tuple'.length)}` : i.type;
    return `${t} ${i.name}`;
  };
  return `${fn.name}(${fn.inputs.map(param).join(',')})`;
}

// ── Field rules → ERC-7730 fields ───────────────────────────────────────

class Enums {
  constructor(sources) {
    this.sources = sources;
    this.out = {};
  }
  /** Register the enum a rule names and return its `$ref`. */
  ref(spec, where) {
    let key;
    let map;
    if (spec.solidity) {
      const members = readEnum(this.sources, spec.solidity);
      const labels = spec.labels ?? {};
      for (const k of Object.keys(labels)) if (!members.includes(k)) throw new ClearSigningError([`${where}: label for ${spec.solidity}.${k}, which the enum does not have`]);
      for (const k of members) if (!(k in labels)) throw new ClearSigningError([`${where}: ${spec.solidity}.${k} has no label`]);
      key = spec.solidity.split('.').pop();
      map = Object.fromEntries(members.map((m, i) => [String(i), labels[m]]));
    } else if (spec.constants) {
      const { of, prefix, labels, except } = spec.constants;
      const consts = readConstants(this.sources, of, prefix);
      map = {};
      for (const [k, v] of Object.entries(consts)) {
        if (except.includes(k)) continue;
        if (!(k in labels)) throw new ClearSigningError([`${where}: constant ${of}.${k} has no label`]);
        map[String(v)] = labels[k];
      }
      for (const k of Object.keys(labels)) if (!(k in consts)) throw new ClearSigningError([`${where}: label for ${of}.${k}, which is not a constant there`]);
      key = `${of}.${prefix}`;
    } else if (spec.flags) {
      const { of, prefix, labels, except, none } = spec.flags;
      const consts = readConstants(this.sources, of, prefix);
      const bits = [];
      for (const [k, v] of Object.entries(consts)) {
        if (except.includes(k)) continue;
        if (!(k in labels)) throw new ClearSigningError([`${where}: flag ${of}.${k} has no label`]);
        if (v === 0n || (v & (v - 1n)) !== 0n) throw new ClearSigningError([`${where}: flag ${of}.${k} is not a single bit`]);
        bits.push([v, labels[k]]);
      }
      for (const k of Object.keys(labels)) if (!(k in consts)) throw new ClearSigningError([`${where}: label for ${of}.${k}, which is not a constant there`]);
      bits.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (bits.length > 10) throw new ClearSigningError([`${where}: ${bits.length} flags is too many to name every combination`]);
      map = { 0: none ?? 'None' };
      for (let mask = 1; mask < 1 << bits.length; mask++) {
        let v = 0n;
        const names = [];
        bits.forEach(([b, l], i) => {
          if (mask & (1 << i)) {
            v |= b;
            names.push(l);
          }
        });
        map[String(v)] = names.join(', ');
      }
      key = `${of}.${prefix}flags`;
    } else if (spec.literal) {
      key = spec.literal.name;
      map = Object.fromEntries(Object.entries(spec.literal.values).map(([k, v]) => [String(k), v]));
    } else {
      throw new ClearSigningError([`${where}: unknown enum rule`]);
    }
    key = key.replace(/[^A-Za-z0-9_]/g, '_');
    const prev = this.out[key];
    if (prev && JSON.stringify(prev) !== JSON.stringify(map)) throw new ClearSigningError([`${where}: two different enums would share the name ${key}`]);
    this.out[key] = map;
    return `$.metadata.enums.${key}`;
  }
}

/**
 * Turn the rule for `leaf` into an ERC-7730 field.
 * @returns {object|null} null when nothing matches.
 */
function fieldFor(leaf, rule, enums, where) {
  if (!rule) return null;
  if ('hide' in rule) {
    if (typeof rule.hide !== 'string' || rule.hide.length < 10) throw new ClearSigningError([`${where} ${leaf.path}: a hidden field needs its reason`]);
    return { path: leaf.path, visible: 'never' };
  }
  if (rule.mustMatchDiamond) {
    if (leaf.type !== 'address') throw new ClearSigningError([`${where} ${leaf.path}: only an address can be checked against the Diamond`]);
    return { path: leaf.path, mustMatchDiamond: true };
  }
  if (typeof rule.label !== 'string' || !rule.label || typeof rule.format !== 'string') {
    throw new ClearSigningError([`${where} ${leaf.path}: a shown field needs a label and a format`]);
  }
  const field = { path: leaf.path, label: rule.label, format: rule.format };
  if (rule.format === 'enum') {
    if (leaf.enumType && rule.enum.solidity && rule.enum.solidity.split('.').pop() !== leaf.enumType.split('.').pop()) {
      throw new ClearSigningError([`${where} ${leaf.path}: the ABI says enum ${leaf.enumType}, the rule says ${rule.enum.solidity}`]);
    }
    field.params = { $ref: enums.ref(rule.enum, `${where} ${leaf.path}`) };
  } else {
    if (leaf.enumType) throw new ClearSigningError([`${where} ${leaf.path}: enum ${leaf.enumType} must be shown by name (solEnum) or hidden`]);
    if (rule.params) {
      const parentPath = leaf.path.includes('.') ? leaf.path.slice(0, leaf.path.lastIndexOf('.') + 1) : '';
      field.params = Object.fromEntries(
        Object.entries(rule.params).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('~') ? `${parentPath}${v.slice(1)}` : v]),
      );
    }
  }
  if (rule.visible) field.visible = rule.visible;
  return field;
}

/** Resolve every leaf; collect the problems instead of stopping at the first. */
function buildFields(leaves, { overrides = {}, structs, leavesRules, structAlias = {} }, enums, where, problems) {
  const fields = [];
  const known = new Set(leaves.map((l) => l.path));
  for (const p of Object.keys(overrides)) if (!p.startsWith('@.') && !known.has(p) && !leaves.some((l) => l.name === p)) {
    problems.push(`${where}: a rule for "${p}", which this call does not have`);
  }
  for (const leaf of leaves) {
    const structKey = structAlias[leaf.parent] ?? leaf.parent;
    const rule = overrides[leaf.path] ?? (leaf.parent == null ? overrides[leaf.name] : undefined) ?? structs[structKey]?.[leaf.name] ?? leavesRules[leaf.name];
    try {
      const f = fieldFor(leaf, rule, enums, where);
      if (!f) problems.push(`${where}: no rule for "${leaf.path}" (${leaf.type}${leaf.parent ? `, in ${leaf.parent}` : ''})`);
      else fields.push(f);
    } catch (e) {
      if (e instanceof ClearSigningError) problems.push(...e.problems);
      else throw e;
    }
  }
  for (const [p, rule] of Object.entries(overrides)) {
    if (!p.startsWith('@.')) continue;
    fields.push({ path: p, label: rule.label, format: rule.format, ...(rule.params ? { params: rule.params } : {}) });
  }
  return fields;
}

// ── Inputs ──────────────────────────────────────────────────────────────

export function loadInputs(opts = {}) {
  const abiDir = opts.abiDir ?? path.join(PKG, 'src/abis');
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'scripts/diamond-facets.json'), 'utf8'));
  const abis = {};
  for (const f of manifest.facets) {
    const j = JSON.parse(fs.readFileSync(path.join(abiDir, `${f}.json`), 'utf8'));
    abis[f] = Array.isArray(j) ? j : j.abi;
  }
  return {
    abis,
    scope: JSON.parse(fs.readFileSync(path.join(PKG, 'clear-signing/scope.json'), 'utf8')),
    deployments: JSON.parse(fs.readFileSync(opts.deployments ?? path.join(PKG, 'src/deployments.json'), 'utf8')),
    ledger: JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/permissionless-steps.json'), 'utf8')).steps,
    sources: opts.sources ?? readSources(path.join(REPO, 'contracts/src')),
  };
}

// ── Build ───────────────────────────────────────────────────────────────

/** Classify every non-view function; return the user ones. */
export function classify({ abis, scope, ledger }, problems) {
  const user = [];
  const seen = new Set();
  for (const [facet, abi] of Object.entries(abis)) {
    const fns = abi.filter((x) => x.type === 'function' && x.stateMutability !== 'view' && x.stateMutability !== 'pure');
    const names = new Map();
    for (const fn of fns) names.set(fn.name, (names.get(fn.name) ?? 0) + 1);
    for (const fn of fns) {
      const key = `${facet}.${fn.name}`;
      const cls = scope.functions[key];
      if (names.get(fn.name) > 1 && cls === 'user') problems.push(`scope: ${key} is overloaded; a user function needs one display per signature`);
      seen.add(key);
      if (!cls) problems.push(`scope: ${key} is not classified (user, upkeep, admin or internal) in clear-signing/scope.json`);
      else if (!['user', 'upkeep', 'admin', 'internal'].includes(cls)) problems.push(`scope: ${key} has unknown class ${cls}`);
      else if (cls === 'user') user.push({ facet, fn, key });
    }
  }
  for (const k of Object.keys(scope.functions)) if (!seen.has(k)) problems.push(`scope: ${k} names no non-view function of a Diamond facet`);
  if (scope.facets) problems.push('scope: facet-wide defaults are not allowed; name every function');
  for (const [sig, row] of Object.entries(ledger)) {
    const [contract, rest] = sig.split('.');
    if (!abis[contract]) continue;
    const key = `${contract}.${rest.slice(0, rest.indexOf('('))}`;
    const cls = scope.functions[key];
    if (row.class === 'user' && cls !== 'user') problems.push(`scope: ${key} is a user step in contracts/permissionless-steps.json but ${cls ?? 'unclassified'} in clear-signing/scope.json`);
    if ((row.class === 'keeper' || row.class === 'alternative') && cls !== 'upkeep' && cls !== 'user') {
      problems.push(`scope: ${key} is a ${row.class} step in contracts/permissionless-steps.json, so anyone may run it; it cannot be ${cls ?? 'unclassified'}`);
    }
  }
  return user;
}

function diamondDeployments(deployments) {
  return Object.entries(deployments)
    .filter(([, d]) => d && typeof d === 'object' && d.diamond)
    .map(([chainId, d]) => ({ chainId: Number(chainId), address: getAddress(d.diamond) }))
    .sort((a, b) => a.chainId - b.chainId);
}

function deploymentsOf(deployments, key) {
  return Object.entries(deployments)
    .filter(([, d]) => d && typeof d === 'object' && d[key])
    .map(([chainId, d]) => ({ chainId: Number(chainId), address: getAddress(d[key]) }))
    .sort((a, b) => a.chainId - b.chainId);
}

/** Build every descriptor. Returns `{ files: {name: object}, problems }`. */
export async function build(inputs, display) {
  const problems = [];
  const { META, LEAVES, STRUCTS, CALLS, TYPED } = display;
  const diamonds = diamondDeployments(inputs.deployments);
  const metadata = (enums) => ({
    owner: META.owner,
    info: { url: META.url },
    ...(Object.keys(enums.out).length ? { enums: sortKeys(enums.out) } : {}),
  });

  // Calldata
  const user = classify(inputs, problems);
  const enums = new Enums(inputs.sources);
  const formats = {};
  for (const k of Object.keys(CALLS)) if (!user.some((u) => u.key === k)) problems.push(`display: CALLS has ${k}, which is not a user function in scope.json`);
  for (const { fn, key } of user.sort((a, b) => a.key.localeCompare(b.key))) {
    const call = CALLS[key];
    if (!call?.intent) {
      problems.push(`display: ${key} has no intent in CALLS`);
      continue;
    }
    let leaves;
    try {
      leaves = abiLeaves(fn.inputs);
    } catch (e) {
      problems.push(`${key}: ${e.message}`);
      continue;
    }
    if (call.fields?.['@.value'] && fn.stateMutability !== 'payable') problems.push(`${key}: shows @.value but is not payable`);
    const fields = buildFields(leaves, { overrides: call.fields, structs: STRUCTS, leavesRules: LEAVES }, enums, key, problems);
    const fk = formatKey(fn);
    if (formats[fk]) problems.push(`${key}: two functions share the signature ${fk}`);
    formats[fk] = { $id: key, intent: call.intent, fields };
  }
  const files = {
    'calldata-VaipakamDiamond.json': {
      $schema: SCHEMA_URL,
      context: { $id: 'Vaipakam Diamond', contract: { deployments: diamonds } },
      metadata: metadata(enums),
      display: { formats },
    },
  };

  // EIP-712
  for (const group of TYPED) {
    const genums = new Enums(inputs.sources);
    const gformats = {};
    for (const msg of group.messages) {
      let encodeType;
      try {
        encodeType = (msg.prefix ?? '') + readTypeString(inputs.sources, msg.source[0], msg.source[1]);
      } catch (e) {
        problems.push(...(e.problems ?? [e.message]));
        continue;
      }
      if (msg.typehash) {
        // The source's own TYPEHASH must hash the string we read.
        const f = inputs.sources.find((s) => s.rel === msg.source[0]);
        if (!new RegExp(`\\b${msg.typehash}\\s*=\\s*keccak256\\(`).test(f.text)) problems.push(`${group.file}: ${msg.typehash} is not a keccak256 of a type string in ${msg.source[0]}`);
      }
      const { primary, types } = parseEncodeType(encodeType);
      const leaves = typedLeaves(types, primary);
      const fields = buildFields(
        leaves,
        { overrides: msg.fields, structs: STRUCTS, leavesRules: LEAVES, structAlias: msg.structs ?? {} },
        genums,
        `${group.file} ${primary}`,
        problems,
      );
      if (gformats[encodeType]) problems.push(`${group.file}: ${primary} described twice`);
      gformats[encodeType] = { $id: primary, intent: msg.intent, fields };
    }
    const domain = { name: group.domain.name, ...(group.domain.version ? { version: group.domain.version } : {}) };
    let deployments;
    if (group.verifying === 'diamond') deployments = diamonds;
    else if (group.verifying?.deploymentKey) deployments = deploymentsOf(inputs.deployments, group.verifying.deploymentKey);
    else if (group.verifying?.constant) {
      const addr = readAddressConstant(inputs.sources, group.verifying.constant[0], group.verifying.constant[1]);
      deployments = diamonds.map((d) => ({ chainId: d.chainId, address: addr }));
    }
    files[`${group.file}.json`] = {
      $schema: SCHEMA_URL,
      context: { $id: group.id, eip712: { domain, ...(deployments ? { deployments } : {}) } },
      metadata: metadata(genums),
      display: { formats: gformats },
    };
  }

  // Permit2: the spender must be a Diamond.
  for (const f of Object.values(files)) {
    for (const fmt of Object.values(f.display.formats)) {
      for (const field of fmt.fields) if (field.mustMatchDiamond) {
        delete field.mustMatchDiamond;
        field.visible = { mustMatch: diamonds.map((d) => d.address) };
      }
    }
  }
  return { files, problems };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

// ── Schema validation ───────────────────────────────────────────────────

export async function validate(files) {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const schema = JSON.parse(fs.readFileSync(path.join(PKG, 'clear-signing/erc7730-v2.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('eip55', (s) => {
    try {
      return getAddress(s) === s;
    } catch {
      return false;
    }
  });
  ajv.addFormat('eip155', () => true);
  ajv.addFormat('uri', (s) => /^https?:\/\/\S+$/.test(s));
  ajv.addFormat('uri-reference', () => true);
  ajv.addFormat('date-time', (s) => !Number.isNaN(Date.parse(s)));
  const check = ajv.compile(schema);
  const problems = [];
  for (const [name, f] of Object.entries(files)) {
    if (!check(f)) for (const e of check.errors) problems.push(`schema: ${name} ${e.instancePath} ${e.message}`);
  }
  return problems;
}

/** Selector of a format key, for the tests and as a self-check. */
export function selectorOfKey(key) {
  const strip = (s) => {
    // Drop " name" after each type, recursing through tuples.
    let out = '';
    let depth = 0;
    let skipping = false;
    for (const c of s) {
      if (c === ' ') {
        skipping = true;
        continue;
      }
      if (c === ',' || c === ')') skipping = false;
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (!skipping) out += c;
    }
    return out;
  };
  return toFunctionSelector(strip(key));
}

export const typeHashOf = (encodeType) => keccak256(toBytes(encodeType));

// ── CLI ─────────────────────────────────────────────────────────────────

export function serialize(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

async function main(argv) {
  const check = argv.includes('--check');
  const display = await import(pathToFileURL(path.join(PKG, 'clear-signing/display.mjs')).href);
  let result;
  try {
    result = await build(loadInputs(), display);
  } catch (e) {
    if (e instanceof ClearSigningError) result = { files: {}, problems: e.problems };
    else throw e;
  }
  const problems = [...result.problems, ...(result.problems.length ? [] : await validate(result.files))];
  if (problems.length) {
    console.error(`Clear-signing descriptors not built (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('Classify new functions in packages/contracts/clear-signing/scope.json and give user ones a display in clear-signing/display.mjs.');
    return 1;
  }
  const outDir = path.join(PKG, 'clear-signing/descriptors');
  const want = Object.fromEntries(Object.entries(result.files).map(([n, f]) => [n, serialize(f)]));
  const have = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((n) => n.endsWith('.json')) : [];
  if (check) {
    const stale = [];
    for (const [n, text] of Object.entries(want)) {
      const p = path.join(outDir, n);
      if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) stale.push(n);
    }
    for (const n of have) if (!(n in want)) stale.push(`${n} (no longer generated)`);
    if (stale.length) {
      console.error(`Clear-signing descriptors are stale: ${stale.join(', ')}`);
      console.error('Run: node packages/contracts/scripts/build-clear-signing.mjs');
      return 1;
    }
    console.log(`Clear-signing descriptors up to date (${Object.keys(want).length} files).`);
    return 0;
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const n of have) if (!(n in want)) fs.rmSync(path.join(outDir, n));
  for (const [n, text] of Object.entries(want)) fs.writeFileSync(path.join(outDir, n), text);
  console.log(`Wrote ${Object.keys(want).length} clear-signing descriptors to ${path.relative(process.cwd(), outDir)}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(await main(process.argv.slice(2)));
}
