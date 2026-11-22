#!/usr/bin/env node
/**
 * The canonical specification's folder check (#3948, CanonicalSpecDesign §4).
 *
 *   node packages/canonical-spec/bin/check.mjs                 # folder mode, docs/CanonicalSpec
 *   node packages/canonical-spec/bin/check.mjs --draft <paths…> # draft mode, files or folders
 *   … --held <dir>          also read the held statements kept in the private records
 *   … --neighbours          print the neighbours report
 *   … --hashes              print each statement's approval hash, for the record's Approved column
 *   … --wording <file>      the wording list (default: wording.json in the folder)
 *
 * Exit 0 when nothing is refused, 1 on any finding, 2 on a usage error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from '../src/parse.mjs';
import { approvalHash, checkSpec, neighbours } from '../src/check.mjs';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const FOLDER = join(REPO, 'docs/CanonicalSpec');
/** Generated folders the check does not read as sources. */
const GENERATED = new Set(['catalogue']);

function mdFiles(path) {
  if (!existsSync(path)) throw new Error(`no such file or folder: ${path}`);
  if (statSync(path).isFile()) return [path];
  const out = [];
  for (const f of readdirSync(path).sort()) {
    const p = join(path, f);
    if (statSync(p).isDirectory()) {
      if (!GENERATED.has(f)) out.push(...mdFiles(p));
    } else if (f.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Domains the folder's README marks complete: a table "Code | Domain | Status". */
function completeDomains(readmePath) {
  const out = new Set();
  if (!existsSync(readmePath)) return out;
  const p = parseFile(readmePath, readFileSync(readmePath, 'utf8'));
  for (const t of p.tables) {
    const h = t.header.map((x) => x.toLowerCase());
    if (h[0] !== 'code' || !h.includes('status')) continue;
    const si = h.indexOf('status');
    for (const r of t.rows) if (/^complete\b/i.test(r.cells[si] ?? '')) out.add(r.cells[0]);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const opt = { mode: 'folder', paths: [], held: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--draft') opt.mode = 'draft';
    else if (a === '--neighbours') opt.neighbours = true;
    else if (a === '--hashes') opt.hashes = true;
    else if (a === '--held' && argv[i + 1]) opt.held.push(argv[++i]);
    else if (a === '--wording' && argv[i + 1]) opt.wording = argv[++i];
    else if (a.startsWith('--')) {
      console.error(`canonical-spec check: unknown argument ${a}`);
      return 2;
    } else opt.paths.push(a);
  }
  if (opt.mode === 'folder' && !opt.paths.length) opt.paths.push(FOLDER);
  if (!opt.paths.length) {
    console.error('canonical-spec check: --draft needs the files or folders of the draft');
    return 2;
  }
  const files = [...opt.paths, ...opt.held].flatMap((p) => mdFiles(resolve(p)));
  const parsed = files.map((f) => parseFile(relative(process.cwd(), f) || f, readFileSync(f, 'utf8')));
  const wordingPath = opt.wording ?? (opt.mode === 'folder' ? join(resolve(opt.paths[0]), 'wording.json') : null);
  const wording = wordingPath && existsSync(wordingPath) ? JSON.parse(readFileSync(wordingPath, 'utf8')) : null;
  const findings = checkSpec(parsed, { mode: opt.mode, wording, completeDomains: completeDomains(join(resolve(opt.paths[0]), 'README.md')) });

  const statements = parsed.flatMap((p) => p.statements);
  if (opt.hashes) for (const s of statements) console.log(`${s.id}\t${approvalHash(s)}`);
  if (opt.neighbours) {
    for (const g of neighbours(parsed)) console.log(`neighbours · ${g.model} · ${g.step}: ${g.ids.join(', ')}`);
  }
  for (const f of findings) console.error(`${f.file}:${f.line}: [${f.rule}] ${f.message}`);
  const held = statements.filter((s) => s.held).length;
  const summary = `${statements.length} statements (${held} held), ${parsed.flatMap((p) => p.models).length} models, ${parsed.flatMap((p) => p.mistakes).length} mistakes, ${opt.mode} mode`;
  if (findings.length) {
    console.error(`canonical-spec check: REFUSED, ${findings.length} finding(s) over ${summary}`);
    return 1;
  }
  console.log(`canonical-spec check: passed, ${summary}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`canonical-spec check: ${e.message}`);
    process.exitCode = 1;
  }
}
