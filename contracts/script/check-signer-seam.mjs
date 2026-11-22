#!/usr/bin/env node
/**
 * check-signer-seam.mjs — every operator script signs through ONE library
 * (#3891, deploy rehearsal design §12).
 *
 * `contracts/script/lib/Signers.sol` is the only place an operator script may
 * read a signing key or start a broadcast. That seam is what lets a deploy
 * rehearsal run the REAL scripts on a local fork with no key at all: in
 * rehearsal mode the library broadcasts as the role's address, which the fork
 * has impersonated, and a real run proves its key gives that same address. A
 * script that read `ADMIN_PRIVATE_KEY` itself, or called `vm.startBroadcast`
 * itself, would sit outside the rehearsal (it would fail on the zeroed key, or
 * worse, sign with something the rehearsal never saw).
 *
 * The rule, over the compiler's AST of every `.sol` file under script/:
 *   1. no string literal that is a private-key variable name or a piece of
 *      one ({KEY_NAME}; prose mentioning one, like a revert message, is not
 *      a read), and
 *   2. no call to a broadcasting or key-holding cheatcode
 *      (`startBroadcast`, `broadcast`, `rememberKey`, `rememberKeys`,
 *      `signDelegation`, `attachDelegation`, `signAndAttachDelegation`),
 * outside `lib/Signers.sol` and outside the {EXEMPT} folders and files, each
 * listed with its reason. Comments are not in the AST, so prose naming a key
 * variable is never a finding.
 *
 * And the shell half (design §12, "the shell gets the same seam as one
 * function"): in the deploy scripts a rehearsal runs ({SHELL_SCRIPTS}), no
 * line outside a comment passes `--private-key`. A transaction the shell sends
 * goes through `vk_cast_send`, and a role's address comes from
 * `vk_role_address`, both in `script/lib/rehearsal.sh`.
 *
 * The AST is the parser's (`settings.stopAfter: "parsing"`), from the solc
 * forge already installed for this tree: both rules are about names written in
 * the source, so no type checking is needed, and a parse of the whole script
 * tree takes seconds rather than the minutes a code-generating build takes.
 *
 * CLI: node contracts/script/check-signer-seam.mjs [--solc <path>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const CONTRACTS_DIR = join(HERE, '..');
export const SCRIPT_DIR = join(CONTRACTS_DIR, 'script');

/** The library that owns signing. */
export const HOME = 'script/lib/Signers.sol';

/**
 * A string literal that IS a private-key variable name, or a piece of one
 * (`ADMIN_PRIVATE_KEY`, `_PRIVATE_KEY`): letters, digits and underscores only,
 * containing `PRIVATE_KEY`. Prose that mentions a variable (a revert message)
 * has spaces and is not a read, so it is not a finding.
 */
export const KEY_NAME = /^[A-Za-z0-9_]*PRIVATE_KEY[A-Za-z0-9_]*$/;

/** Cheatcodes that start a broadcast or hold a key. */
export const SIGNING_CHEATCODES = new Set([
  'startBroadcast',
  'broadcast',
  'rememberKey',
  'rememberKeys',
  'signDelegation',
  'attachDelegation',
  'signAndAttachDelegation',
]);

/**
 * Paths outside the rule, each with why. A folder entry ends in `/` and covers
 * everything under it. Keep this short: every entry is a script a rehearsal
 * cannot run.
 */
export const EXEMPT = [
  {
    path: 'script/e2e/',
    reason:
      'Scenario fixtures for the Anvil e2e suites: they deploy with development keys made for the run, on 31337 or a harness node, and are never part of a deploy plan.',
  },
  {
    path: 'script/positive-flows/',
    reason:
      'The positive-flow modules sign as test actors (lender, borrower, keeper) whose keys are made for the run; the rehearsal runs them in its smoke stage with such keys.',
  },
  {
    path: 'script/PositiveFlows.s.sol',
    reason: 'The positive-flow entry point; same reason as script/positive-flows/.',
  },
  {
    path: 'script/SeedAnvilOffers.s.sol',
    reason: 'Seeds a local Anvil playground with offers signed by Anvil\'s published development keys; never part of a deploy plan.',
  },
  {
    path: 'script/BaseSepoliaSellerClaim.s.sol',
    reason: 'A Base Sepolia live drive signed by test-actor wallets (lender, borrower, buyer); never part of a deploy plan.',
  },
  {
    path: 'script/BaseSepoliaInternalMatch.s.sol',
    reason: 'A Base Sepolia live drive signed by test-actor wallets; never part of a deploy plan.',
  },
  {
    path: 'script/utils/DeployGnosisSafe.s.sol',
    reason:
      'Deploys a Safe with the signer forge is given on its command line (a hardware wallet on mainnet); it reads no key variable and is run by hand, outside a deploy plan.',
  },
];

/** The deploy scripts a rehearsal runs, whose shell sends must use the seam. */
export const SHELL_SCRIPTS = ['script/deploy-testnet.sh', 'script/deploy-mainnet.sh'];

/** Findings in one shell script's text. Pure. A `#` comment line is prose. */
export function shellFindingsIn(path, text) {
  const findings = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (/--private-key\b/.test(line)) {
      findings.push({ path, line: i + 1, what: 'passes --private-key outside lib/rehearsal.sh (use vk_cast_send / vk_role_address)' });
    }
  });
  return findings;
}

function isExempt(rel) {
  return EXEMPT.some((e) => (e.path.endsWith('/') ? rel.startsWith(e.path) : rel === e.path));
}

/** Every `.sol` file under script/, as a contracts-relative POSIX path. */
export function scriptSources(dir = SCRIPT_DIR) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.sol')) out.push(relative(CONTRACTS_DIR, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** The solc forge installed for this tree's pinned version. */
export function findSolc() {
  const toml = readFileSync(join(CONTRACTS_DIR, 'foundry.toml'), 'utf8');
  const m = toml.match(/solc(?:_version)?\s*=\s*["']([0-9.]+)["']/);
  const version = m ? m[1] : '0.8.29';
  const candidates = [
    join(homedir(), '.local', 'share', 'svm', version, `solc-${version}`),
    join(homedir(), '.svm', version, `solc-${version}`),
    join(homedir(), '.foundry', 'svm', version, `solc-${version}`),
  ];
  return candidates.find((c) => existsSync(c));
}

/** Parse `files` with solc and return `{ asts: Map<path, ast>, errors }`. */
export function parse(files, solc) {
  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(files.map((f) => [f, { content: readFileSync(join(CONTRACTS_DIR, f), 'utf8') }])),
    settings: { stopAfter: 'parsing', outputSelection: { '*': { '': ['ast'] } } },
  };
  const r = spawnSync(solc, ['--standard-json'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.status !== 0 && !r.stdout) throw new Error(`solc failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const errors = (out.errors || []).filter((e) => e.severity === 'error').map((e) => e.formattedMessage || e.message);
  const asts = new Map();
  for (const [p, v] of Object.entries(out.sources || {})) asts.set(p, v.ast);
  return { asts, errors };
}

/** Byte offset → 1-based line in `text`. */
function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Findings in one AST. Pure. `text` is the file's source, for line numbers. */
export function findingsIn(path, ast, text = '') {
  const findings = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.nodeType === 'Literal' && node.kind === 'string' && typeof node.value === 'string' && KEY_NAME.test(node.value)) {
      const at = Number(String(node.src || '0').split(':')[0]);
      findings.push({ path, line: lineOf(text, at), what: `names a private-key variable ("${node.value}")` });
    }
    if (node.nodeType === 'FunctionCall' && node.expression && node.expression.nodeType === 'MemberAccess' && SIGNING_CHEATCODES.has(node.expression.memberName)) {
      const at = Number(String(node.src || '0').split(':')[0]);
      findings.push({ path, line: lineOf(text, at), what: `calls ${node.expression.memberName}(...)` });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
  };
  visit(ast);
  return findings;
}

/** Every finding over `asts`, honouring {HOME} and {EXEMPT}. Pure. */
export function verdict(asts, sourceText = () => '') {
  const findings = [];
  for (const [path, ast] of asts) {
    if (path === HOME || isExempt(path)) continue;
    findings.push(...findingsIn(path, ast, sourceText(path)));
  }
  return findings;
}

/** Exempt entries that name nothing, so a stale entry cannot linger. Pure. */
export function staleExemptions(files) {
  return EXEMPT.filter((e) => !files.some((f) => (e.path.endsWith('/') ? f.startsWith(e.path) : f === e.path)));
}

export function main(argv = process.argv.slice(2)) {
  let solc;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--solc' && argv[i + 1]) solc = argv[++i];
    else {
      console.error(`check-signer-seam: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  solc ||= findSolc();
  if (!solc) {
    console.error('  ✗ no solc found for this tree — run `forge build --skip test` once, or pass --solc');
    return 1;
  }
  const files = scriptSources();
  let parsed;
  try {
    parsed = parse(files, solc);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    return 1;
  }
  if (parsed.errors.length) {
    for (const e of parsed.errors) console.error(`  ✗ ${e}`);
    return 1;
  }
  const missing = files.filter((f) => !parsed.asts.has(f));
  if (missing.length) {
    for (const f of missing) console.error(`  ✗ no AST for ${f}`);
    return 1;
  }
  let fail = 0;
  for (const e of staleExemptions(files)) {
    console.error(`  ✗ exemption names no file: ${e.path} — remove it`);
    fail = 1;
  }
  const findings = verdict(parsed.asts, (p) => readFileSync(join(CONTRACTS_DIR, p), 'utf8'));
  for (const sh of SHELL_SCRIPTS) findings.push(...shellFindingsIn(sh, readFileSync(join(CONTRACTS_DIR, sh), 'utf8')));
  for (const f of findings) {
    console.error(`  ✗ ${f.path}:${f.line} ${f.what} — sign through ${HOME} (Signers.role / Signers.start), or exempt the file with its reason`);
    fail = 1;
  }
  if (!fail) console.log(`  ✓ ${files.length} script files: every key read and broadcast goes through ${HOME}; ${SHELL_SCRIPTS.length} deploy scripts send through lib/rehearsal.sh`);
  return fail;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
