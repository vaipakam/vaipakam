#!/usr/bin/env node
/**
 * check-measured-delivery.mjs — every raw ERC-20 move in src/ is accounted
 * for (#2440).
 *
 * The protocol books only what a token move actually delivered, and
 * `src/libraries/LibDelivery.sol` is the one place that rule is written: each
 * of its moves measures the receiving end, refuses a move that cost its sender
 * more than it sent, and says what a short arrival means for the flow it
 * belongs to. Three review rounds on #2440 each found settlement sites that
 * still moved tokens by hand, around the library, and so booked a figure
 * nobody had measured. This check makes the rule hold for code written later:
 * a move of an ERC-20 written anywhere in src/ outside LibDelivery fails the
 * pre-deploy gate unless it is LISTED, with the reason it may move tokens
 * without the library, in contracts/script/measured-delivery-allowlist.json.
 *
 * It reads the COMPILER's AST, never the source text, the same way the
 * storage-layout guard does, and reuses that guard's freshness checks. A move
 * is a reference to one of these declarations, as the compiler resolved it:
 *   - SafeERC20's transfer functions (`safeTransfer`, `safeTransferFrom`,
 *     `trySafeTransfer`, `trySafeTransferFrom`), however they are reached
 *     (`SafeERC20.f(...)`, or `token.f(...)` through `using SafeERC20`);
 *   - any function whose selector is ERC-20 `transfer(address,uint256)`,
 *     which ERC-721 and ERC-1155 do not declare; and
 *   - `transferFrom(address,address,uint256)` declared by a contract that
 *     also declares `transfer(address,uint256)`. ERC-721's `transferFrom` has
 *     the same selector, and its interface declares no `transfer`, so NFT
 *     moves are not counted.
 * Any reference counts, a call or not, so `IERC20.transfer.selector` handed
 * to a low-level call is a move too.
 *
 * A reference names its declaration by AST node id, and solc numbers those
 * per compilation JOB: an incremental build leaves artifacts from several
 * jobs side by side, and an id read in one means nothing, or something else,
 * in another. So the check builds its own artifacts from scratch (`--force`,
 * in directories of its own) and refuses any set that was not compiled in a
 * single job, which it proves from the build-info forge writes beside them.
 * (The storage-layout guard resolves ids only inside one file, which is why
 * its incremental build is enough for it and not for this.)
 *
 * Three forms are outside what an AST reference can show, and are stated here
 * rather than implied: inline assembly that calls a token, a low-level call
 * whose calldata is built from a raw 4-byte constant, and one built from a
 * signature string (`abi.encodeWithSignature("transfer(address,uint256)",
 * ...)`). None appears in src/ today.
 *
 * Each listed site is keyed by file, contract and function, with the number of
 * moves it contains, so a second raw move added to a listed function fails as
 * well. A listed site that no longer exists also fails, so the list stays the
 * exact inventory.
 *
 * CLI: node contracts/script/check-measured-delivery.mjs [--out <dir>]
 *   --out   read artifacts already built with `forge build --force --ast`
 *           instead of building its own (tests and diagnosis). They are
 *           still refused when stale or when they span more than one job.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, loadBuild } from './storage-layout-guard.mjs';

export const ALLOWLIST_FILE = join(CONTRACTS_DIR, 'script', 'measured-delivery-allowlist.json');
export const BUILD_OUT_DIR = join(CONTRACTS_DIR, 'out-measured-delivery');
export const BUILD_CACHE_DIR = join(CONTRACTS_DIR, 'cache-measured-delivery');

/** The library every measured move goes through. Its own moves are the rule, not exceptions to it. */
export const HOME = 'src/libraries/LibDelivery.sol';

const SAFE_ERC20_MOVES = new Set(['safeTransfer', 'safeTransferFrom', 'trySafeTransfer', 'trySafeTransferFrom']);
const ERC20_TRANSFER = 'a9059cbb'; // transfer(address,uint256)
const TRANSFER_FROM = '23b872dd'; // transferFrom(address,address,uint256), ERC-20 and ERC-721 alike

/** Depth-first walk over a solc AST node, calling `visit(node, ancestors)`. */
function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, ancestors);
    return;
  }
  if (typeof node.nodeType === 'string') visit(node, ancestors);
  const next = typeof node.nodeType === 'string' ? [...ancestors, node] : ancestors;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'nodeType') continue;
    if (v && typeof v === 'object') walk(v, visit, next);
  }
}

/**
 * The declarations a reference to which is an ERC-20 move. Pure over the ASTs.
 *
 * @param {Iterable<object>} units  SourceUnit ASTs (every compiled source, libraries included)
 * @returns {Map<number, string>}   declaration id -> a label for messages
 */
export function moveDeclarations(units) {
  const decls = new Map();
  for (const unit of units) {
    walk(unit, (node) => {
      if (node.nodeType !== 'ContractDefinition') return;
      const fns = (node.nodes ?? []).filter((n) => n.nodeType === 'FunctionDefinition');
      const declaresTransfer = fns.some((f) => f.functionSelector === ERC20_TRANSFER);
      for (const f of fns) {
        const isSafe = node.name === 'SafeERC20' && node.contractKind === 'library' && SAFE_ERC20_MOVES.has(f.name);
        const isTransfer = f.functionSelector === ERC20_TRANSFER;
        const isTransferFrom = f.functionSelector === TRANSFER_FROM && declaresTransfer;
        if (isSafe || isTransfer || isTransferFrom) decls.set(f.id, `${node.name}.${f.name}`);
      }
    });
  }
  return decls;
}

/** `contract.function` for the innermost enclosing declaration, as the allowlist names it. */
function enclosingName(ancestors) {
  let contract = '<file>';
  let fn = '<top-level>';
  for (const a of ancestors) {
    if (a.nodeType === 'ContractDefinition') contract = a.name;
    if (a.nodeType === 'FunctionDefinition') {
      fn = a.kind === 'function' || a.kind === 'freeFunction' ? a.name : `<${a.kind}>`;
    }
    if (a.nodeType === 'ModifierDefinition') fn = `modifier ${a.name}`;
  }
  return `${contract}.${fn}`;
}

/**
 * 1-based line of a solc `src` offset ("start:length:file") in `bytes`, the
 * file's raw contents. The offset counts BYTES, so a string index would drift
 * past every non-ASCII character before it.
 */
function lineOf(src, bytes) {
  const start = Number(String(src).split(':')[0]);
  if (!bytes || !Number.isFinite(start)) return 0;
  let line = 1;
  for (let i = 0; i < start && i < bytes.length; i++) if (bytes[i] === 10) line++;
  return line;
}

/**
 * Problems unless every unit was compiled in the ONE job `buildInfos`
 * records. A unit's `src` names its index in the job that compiled it; the
 * job's build-info maps each index to a path. Pure.
 *
 * @param {Iterable<object>} units       SourceUnit ASTs
 * @param {object[]} buildInfos          the parsed `build-info/*.json` files
 */
export function oneJobProblems(units, buildInfos) {
  if (buildInfos.length !== 1) {
    return [`the artifacts come from ${buildInfos.length} compilation jobs, and AST ids are numbered per job — build them with \`forge build --force --ast\` (or omit --out)`];
  }
  const paths = buildInfos[0].source_id_to_path ?? {};
  const problems = [];
  for (const unit of units) {
    const index = String(unit.src ?? '').split(':')[2];
    if (paths[index] !== unit.absolutePath) {
      problems.push(`${unit.absolutePath} was not compiled in the one job its build-info records — rebuild with \`forge build --force --ast\``);
    }
  }
  return problems;
}

/** Build this check's own artifacts, from scratch. Returns an error message, or undefined on success. */
function buildArtifacts() {
  const args = ['build', '--force', '--ast', '--out', BUILD_OUT_DIR, '--cache-path', BUILD_CACHE_DIR];
  console.log(`check-measured-delivery: building src/ (FOUNDRY_PROFILE=quick forge ${args.map((a) => relative(CONTRACTS_DIR, a) || a).join(' ')})`);
  const r = spawnSync('forge', args, {
    cwd: CONTRACTS_DIR,
    env: { ...process.env, FOUNDRY_PROFILE: 'quick' },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) return `could not run forge: ${r.error.message}. forge is a required dependency of this check.`;
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n');
    return `forge build failed (exit ${r.status ?? r.signal}):\n${tail}`;
  }
  return undefined;
}

function readBuildInfos(outDir) {
  const dir = join(outDir, 'build-info');
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
}

/**
 * Every raw ERC-20 move written in src/ outside {HOME}, grouped by site. Pure
 * over the ASTs; `sourceText(path)` is used only to report line numbers.
 *
 * @returns {Map<string, {moves: number, refs: {label: string, line: number}[]}>}
 *          keyed `path:Contract.function`
 */
export function rawMoveSites(units, decls, { home = HOME, sourceText = () => undefined } = {}) {
  const sites = new Map();
  for (const unit of units) {
    const path = unit.absolutePath;
    if (typeof path !== 'string' || !path.startsWith('src/') || path === home) continue;
    const text = sourceText(path);
    walk(unit, (node, ancestors) => {
      if (!decls.has(node.referencedDeclaration)) return;
      const key = `${path}:${enclosingName(ancestors)}`;
      const site = sites.get(key) ?? { moves: 0, refs: [] };
      site.moves += 1;
      site.refs.push({ label: decls.get(node.referencedDeclaration), line: lineOf(node.src, text) });
      sites.set(key, site);
    });
  }
  return sites;
}

/** Parse and shape-check the allowlist. Throws on a malformed file. */
export function readAllowlist(text) {
  const doc = JSON.parse(text);
  if (!doc || !Array.isArray(doc.sites)) throw new Error('allowlist: expected an object with a "sites" array');
  const seen = new Set();
  for (const e of doc.sites) {
    if (typeof e?.site !== 'string' || !/^src\/[^:]+\.sol:[^.]+\..+$/.test(e.site)) {
      throw new Error(`allowlist: "${e?.site}" is not of the form src/<path>.sol:<Contract>.<function>`);
    }
    if (!Number.isInteger(e.moves) || e.moves < 1) throw new Error(`allowlist: ${e.site} needs "moves" (a positive integer)`);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) {
      throw new Error(`allowlist: ${e.site} needs a "reason" saying why it may move tokens without LibDelivery`);
    }
    if (seen.has(e.site)) throw new Error(`allowlist: ${e.site} is listed twice`);
    seen.add(e.site);
  }
  return doc.sites;
}

/** Problems with `sites` against `allowlist`. Pure. */
export function verdict(sites, allowlist) {
  const problems = [];
  const listed = new Map(allowlist.map((e) => [e.site, e]));
  for (const [key, site] of [...sites].sort(([a], [b]) => a.localeCompare(b))) {
    const where = site.refs.map((r) => `${r.label}${r.line ? ` @${r.line}` : ''}`).join(', ');
    const entry = listed.get(key);
    if (!entry) {
      problems.push(`${key}: ${site.moves} raw ERC-20 move(s) outside LibDelivery (${where}) — route it through LibDelivery, or list it with its reason`);
    } else if (entry.moves !== site.moves) {
      problems.push(`${key}: listed with ${entry.moves} move(s), found ${site.moves} (${where}) — a changed count is a new move to justify`);
    }
  }
  for (const e of allowlist) {
    if (!sites.has(e.site)) problems.push(`${e.site}: listed, but has no raw move any more — remove the entry`);
  }
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  let outDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else {
      console.error(`check-measured-delivery: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  if (!outDir) {
    const err = buildArtifacts();
    if (err) {
      console.error(`  ✗ ${err}`);
      return 1;
    }
    outDir = BUILD_OUT_DIR;
  }
  const build = loadBuild(outDir);
  if (build.problems.length) {
    for (const p of build.problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const units = [...build.units.values()];
  const jobProblems = oneJobProblems(units, readBuildInfos(outDir));
  if (jobProblems.length) {
    for (const p of jobProblems.slice(0, 10)) console.error(`  ✗ ${p}`);
    if (jobProblems.length > 10) console.error(`  ✗ ... and ${jobProblems.length - 10} more`);
    return 1;
  }
  const decls = moveDeclarations(units);
  if (![...decls.values()].some((l) => l === 'SafeERC20.safeTransfer')) {
    console.error('  ✗ SafeERC20.safeTransfer is not among the compiled declarations — the check would see nothing');
    return 1;
  }
  const sites = rawMoveSites(units, decls, {
    sourceText: (p) => {
      try {
        return readFileSync(join(CONTRACTS_DIR, p));
      } catch {
        return undefined;
      }
    },
  });
  let allowlist;
  try {
    allowlist = readAllowlist(readFileSync(ALLOWLIST_FILE, 'utf8'));
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    return 1;
  }
  const problems = verdict(sites, allowlist);
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const total = [...sites.values()].reduce((n, s) => n + s.moves, 0);
  console.log(`  ✓ every raw ERC-20 move in src/ is in LibDelivery or listed with its reason (${sites.size} listed sites, ${total} moves)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
