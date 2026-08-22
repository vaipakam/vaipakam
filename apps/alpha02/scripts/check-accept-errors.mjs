#!/usr/bin/env node
/**
 * Drift guard for the `AcceptError` mirror (#1645).
 *
 * `OfferPreviewFacet.previewAccept` returns `errorCode` as a `uint8`.
 * Solidity enums do NOT appear in the ABI — only the width — so the
 * member NAMES that give those numbers meaning exist in exactly one
 * place, `OfferAcceptFacet.sol`, and any consumer needs its own copy.
 * A hand-maintained copy is precisely the shape that produced the
 * watcher offer-decode drift (ReleaseNotes-2026-05-05), so this script
 * pins ours to the contract on every typecheck.
 *
 * It compares the ORDERED member list, so it fails on an appended
 * member the mirror is missing, on a removal, and on a reorder. Order
 * is the whole point: the numbers are positional, and the enum's own
 * comments promise "APPENDED — prior values stay stable" at nearly
 * every member. This is the check that makes that promise enforceable
 * rather than aspirational.
 *
 * On lexical parsing: CLAUDE.md records a withdrawn pre-deploy gate
 * that read Solidity as text and reached verdicts it had not earned.
 * That gate was asking a semantic question — does this registration
 * execute, under this identity, on every chain — which needs scope and
 * control-flow analysis a text scan cannot do. Enumerating the
 * identifiers inside one `enum` block is a lexical question with a
 * bounded grammar, which is the case where reading the source is
 * appropriate. The parse below refuses to guess: it requires exactly
 * one `enum AcceptError` block, and it strips comments before reading
 * members so a commented-out member can never be counted.
 *
 * Run: node apps/alpha02/scripts/check-accept-errors.mjs
 * Wired into `pnpm --filter @vaipakam/alpha02 typecheck`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const SOL_PATH = resolve(REPO_ROOT, 'contracts/src/facets/OfferAcceptFacet.sol');
const TS_PATH = resolve(HERE, '../src/contracts/acceptErrors.ts');

/** Strip `//` and block comments. Enum bodies contain no string
 *  literals, so a comment stripper needs no string-awareness here. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function fail(message) {
  console.error(`\n[check-accept-errors] ${message}\n`);
  process.exit(1);
}

function solidityMembers() {
  const src = stripComments(readFileSync(SOL_PATH, 'utf8'));
  // Require exactly one declaration, so a second (or a rename) is a
  // loud failure rather than a silently-picked first match.
  const opens = [...src.matchAll(/\benum\s+AcceptError\s*\{/g)];
  if (opens.length !== 1) {
    fail(
      `expected exactly one \`enum AcceptError\` in ${SOL_PATH}, found ${opens.length}. ` +
        `If it moved or was renamed, update this script and the mirror together.`,
    );
  }
  const start = opens[0].index + opens[0][0].length;
  const end = src.indexOf('}', start);
  if (end === -1) fail('unterminated `enum AcceptError` block');
  return src
    .slice(start, end)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mirrorMembers() {
  const src = stripComments(readFileSync(TS_PATH, 'utf8'));
  const opens = [...src.matchAll(/export\s+const\s+ACCEPT_ERROR_NAMES\s*=\s*\[/g)];
  if (opens.length !== 1) {
    fail(`expected exactly one \`ACCEPT_ERROR_NAMES\` array in ${TS_PATH}`);
  }
  const start = opens[0].index + opens[0][0].length;
  const end = src.indexOf(']', start);
  if (end === -1) fail('unterminated `ACCEPT_ERROR_NAMES` array');
  return src
    .slice(start, end)
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

const sol = solidityMembers();
const ts = mirrorMembers();

if (sol.length === 0) fail('parsed zero members out of the Solidity enum — the parse is wrong, not the mirror');

const mismatch = sol.length !== ts.length || sol.some((name, i) => name !== ts[i]);
if (mismatch) {
  const rows = [];
  for (let i = 0; i < Math.max(sol.length, ts.length); i += 1) {
    if (sol[i] !== ts[i]) rows.push(`  [${i}] contract: ${sol[i] ?? '(none)'}   mirror: ${ts[i] ?? '(none)'}`);
  }
  fail(
    `AcceptError mirror is out of date with OfferAcceptFacet.sol:\n${rows.join('\n')}\n\n` +
      `Update apps/alpha02/src/contracts/acceptErrors.ts — the names AND, for a new\n` +
      `member, its entry in ACCEPT_ERROR_COPY. A member with no copy renders the\n` +
      `generic fallback, which is a worse answer than the contract already has.`,
  );
}

console.log(`[check-accept-errors] OK — ${sol.length} members match OfferAcceptFacet.AcceptError`);
