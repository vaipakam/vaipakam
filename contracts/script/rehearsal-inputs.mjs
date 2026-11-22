#!/usr/bin/env node
/**
 * rehearsal-inputs.mjs — the deploy's input digest (#3891, deploy rehearsal
 * design §18) and the check that keeps its input set complete.
 *
 *   digest <env-file>
 *       A hash over the canonical input set, worked out the same way in a
 *       rehearsal and in the real deploy: the name and value of every variable
 *       in THIS process's environment that is named in the operator's `.env`
 *       file or listed under `inputs` in {INPUTS_FILE}, less every `leftOut`
 *       pattern (keys, RPC values, the rehearsal's declared differences and
 *       forge's moved folders, each with its reason). An unset input is hashed
 *       as unset, so setting one later is a different deploy. Run it inside
 *       the deploy's environment, after `.env` is loaded. Names a script builds
 *       at run time are in the set too: every variable matching a
 *       `hashedPatterns` entry (role addresses, per-symbol feeds) and every
 *       chain-prefixed form (`chainPrefixes`) of a listed input.
 *
 *   check [--solc <path>]
 *       Fails when an operator script reads a variable by a literal name that
 *       is in neither `inputs` nor `leftOut`, or builds a variable name at run
 *       time in a file `dynamicSites` does not list. Scope and parse are the
 *       signer guard's (`check-signer-seam.mjs`): every script outside its
 *       test-actor exemptions, by the parser's AST. In a file that builds names,
 *       every UPPER_SNAKE string literal is taken as a key a name may be built
 *       from, and must be an input, left out, matched by `hashedPatterns`, or
 *       listed under `notInputs` with its reason. `chainPrefixes` must be the
 *       prefixes `Deployments.envPrefix()` returns.
 *
 * The digest never prints a value: only the hash and, with --names, the names.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, EXEMPT, findSolc, parse, scriptSources } from './check-signer-seam.mjs';

export const INPUTS_FILE = 'deploy-inputs.json';

export function readInputs() {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, INPUTS_FILE), 'utf8'));
}

/** Shell-style glob (`*` only) to a RegExp. */
export function globToRe(pattern) {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

/** Names an env file declares, in order, values never read. */
export function envFileNames(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The canonical input set and its digest. Pure over its arguments. */
export function inputDigest(env, envFileNameList, spec) {
  const left = spec.leftOut.map((e) => globToRe(e.pattern));
  const isLeft = (n) => left.some((re) => re.test(n));
  const hashed = (spec.hashedPatterns ?? []).map((e) => globToRe(e.pattern));
  const prefixed = (spec.chainPrefixes ?? []).flatMap((p) => spec.inputs.map((n) => p + n));
  const built = Object.keys(env).filter((n) => hashed.some((re) => re.test(n)));
  const names = [...new Set([...envFileNameList, ...spec.inputs, ...prefixed, ...built])].filter((n) => !isLeft(n)).sort();
  const h = createHash('sha256');
  for (const n of names) {
    const v = env[n];
    h.update(v === undefined ? `${n}\0unset\n` : `${n}=${v}\n`);
  }
  return { names, digest: h.digest('hex') };
}

const isExempt = (p) => EXEMPT.some((e) => (e.path.endsWith('/') ? p.startsWith(e.path) : p === e.path));

/** Env reads in one AST: literal names and the count of built names. Pure. */
export function envReadsIn(ast) {
  const literals = new Set();
  let dynamic = 0;
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (
      n.nodeType === 'FunctionCall' &&
      n.expression?.nodeType === 'MemberAccess' &&
      /^env[A-Z]?/.test(n.expression.memberName) &&
      n.expression.memberName !== 'envExists' &&
      Array.isArray(n.arguments) &&
      n.arguments.length
    ) {
      const a = n.arguments[0];
      if (a.nodeType === 'Literal' && typeof a.value === 'string') literals.add(a.value);
      else dynamic++;
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v);
  };
  visit(ast);
  return { literals, dynamic };
}

const KEY_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Every UPPER_SNAKE string literal in one AST: the keys a built name may come from. Pure. */
export function keyLiteralsIn(ast) {
  const out = new Set();
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (n.nodeType === 'Literal' && typeof n.value === 'string' && KEY_RE.test(n.value)) out.add(n.value);
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v);
  };
  visit(ast);
  return out;
}

/** The string literals `function envPrefix` returns in one AST. Pure. */
export function envPrefixLiteralsIn(ast) {
  const out = new Set();
  let inside = 0;
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const enter = n.nodeType === 'FunctionDefinition' && n.name === 'envPrefix';
    if (enter) inside++;
    if (inside && n.nodeType === 'Literal' && typeof n.value === 'string' && /^[A-Z0-9_]+_$/.test(n.value)) out.add(n.value);
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v);
    if (enter) inside--;
  };
  visit(ast);
  return out;
}

/** Problems over a map of ASTs. Pure. */
export function checkReads(asts, spec) {
  const known = new Set(spec.inputs);
  const left = spec.leftOut.map((e) => globToRe(e.pattern));
  const hashed = (spec.hashedPatterns ?? []).map((e) => globToRe(e.pattern));
  const notInputs = (spec.notInputs ?? []).map((e) => globToRe(e.pattern));
  const dynamicFiles = new Set(spec.dynamicSites.map((d) => d.path));
  const covered = (n) => known.has(n) || notInputs.some((re) => re.test(n)) || left.some((re) => re.test(n)) || hashed.some((re) => re.test(n));
  const problems = [];
  for (const [p, ast] of asts) {
    if (isExempt(p)) continue;
    const { literals, dynamic } = envReadsIn(ast);
    for (const n of literals) {
      if (!known.has(n) && !left.some((re) => re.test(n))) problems.push(`${p} reads ${n}, which is in neither inputs nor leftOut of ${INPUTS_FILE}`);
    }
    if (dynamic && !dynamicFiles.has(p)) problems.push(`${p} builds a variable name at run time (${dynamic} read(s)); list it under dynamicSites with the names it can read`);
    if (dynamicFiles.has(p)) {
      for (const n of keyLiteralsIn(ast)) {
        if (!covered(n)) problems.push(`${p} builds names and carries the key ${n}, which is not an input, left out, hashed by pattern or listed under notInputs`);
      }
    }
  }
  const dep = asts.get('script/lib/Deployments.sol');
  if (dep) {
    const want = [...envPrefixLiteralsIn(dep)].sort().join(',');
    const have = [...(spec.chainPrefixes ?? [])].sort().join(',');
    if (want !== have) problems.push(`chainPrefixes (${have}) is not the prefixes Deployments.envPrefix() returns (${want})`);
  }
  for (const e of spec.hashedPatterns ?? []) if (!e.reason || e.reason.length < 20) problems.push(`hashedPatterns ${e.pattern}: needs a reason`);
  for (const e of spec.notInputs ?? []) if (!e.reason || e.reason.length < 20) problems.push(`notInputs ${e.pattern}: needs a reason`);
  for (const d of spec.dynamicSites) {
    if (!asts.has(d.path)) problems.push(`dynamicSites names ${d.path}, which is not a script file`);
    if (!d.reason || !Array.isArray(d.patterns) || !d.patterns.length) problems.push(`dynamicSites ${d.path}: needs patterns and a reason`);
  }
  for (const e of spec.leftOut) if (!e.reason || e.reason.length < 20) problems.push(`leftOut ${e.pattern}: needs a reason`);
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const spec = readInputs();
  if (cmd === 'digest') {
    const envFile = rest[0];
    if (!envFile) {
      console.error('usage: rehearsal-inputs.mjs digest <env-file> [--names]');
      return 2;
    }
    let fileNames = [];
    try {
      fileNames = envFileNames(readFileSync(envFile, 'utf8'));
    } catch {
      console.error(`  ✗ cannot read ${envFile}`);
      return 1;
    }
    const { names, digest } = inputDigest(process.env, fileNames, spec);
    if (rest.includes('--names')) for (const n of names) console.error(n);
    console.log(JSON.stringify({ inputDigest: digest, inputCount: names.length }));
    return 0;
  }
  if (cmd === 'check') {
    const i = rest.indexOf('--solc');
    const solc = i >= 0 ? rest[i + 1] : findSolc();
    if (!solc) {
      console.error('  ✗ no solc found for this tree — run `forge build --skip test` once, or pass --solc');
      return 1;
    }
    const { asts, errors } = parse(scriptSources(), solc);
    if (errors.length) {
      for (const e of errors) console.error(`  ✗ ${e}`);
      return 1;
    }
    const problems = checkReads(asts, spec);
    for (const p of problems) console.error(`  ✗ ${p}`);
    if (!problems.length) console.log(`  ✓ every variable an operator script reads is in ${INPUTS_FILE}`);
    return problems.length ? 1 : 0;
  }
  console.error('usage: rehearsal-inputs.mjs digest <env-file> [--names] | check [--solc <path>]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
