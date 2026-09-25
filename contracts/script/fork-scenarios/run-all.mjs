#!/usr/bin/env node
/**
 * Drive every fork scenario in order and print the ledger.
 *
 * Scenarios share one fork and run in sequence on purpose: A3 warps the
 * chain weeks forward to reach the default path, and A5 arms and disarms a
 * sanctions oracle. Running them out of order, or in parallel, would have
 * them reading each other's chain state.
 *
 *   node contracts/script/fork-scenarios/run-all.mjs
 *   node contracts/script/fork-scenarios/run-all.mjs 02 04   # a subset
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN_SLUG, DIAMOND, RPC_URL, fundActors, pub, resolveLive, rpc } from './lib/chain.mjs';
import { ledger, mark, summarise, takeSince } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wanted = process.argv.slice(2);

const files = fs
  .readdirSync(path.join(HERE, 'scenarios'))
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)));

// A mistyped subset (`node run-all.mjs 12`) would otherwise select nothing
// and write a zero-row ledger with a clean exit — a green run that ran no
// scenario. Refuse it, naming what exists.
if (files.length === 0) {
  console.error(`No scenario file matches ${JSON.stringify(wanted)}. Available: ${
    fs.readdirSync(path.join(HERE, 'scenarios')).filter((f) => f.endsWith('.mjs')).sort().join(', ')}`);
  process.exit(1);
}
const unmatched = wanted.filter((w) => !files.some((f) => f.startsWith(w)));
if (unmatched.length) {
  console.error(`Subset selector(s) ${JSON.stringify(unmatched)} match no scenario file.`);
  process.exit(1);
}

const code = await pub.getBytecode({ address: DIAMOND }).catch(() => null);
if (!code) {
  console.error(
    `No Diamond code at ${DIAMOND} on ${RPC_URL}.\n` +
      `Start a fork of ${CHAIN_SLUG} first — see contracts/script/fork-scenarios/README.md.`,
  );
  process.exit(1);
}
// Mine one block before anything reads.
//
// On a FRESH fork, `latest` IS the fork block, and a hardhat node refuses to
// execute `eth_call` there — "No known hardfork for execution on historical
// block N (relative to fork block number N)". `eth_getCode` still answers, so
// the preflight above passes and the first scenario file then dies on its
// first read. That skipped a whole file on every fresh fork while the tally
// below still looked clean. One mined block puts `latest` past the fork point
// and the whole class goes away.
await rpc('evm_mine');
await resolveLive();
await fundActors();
console.log(`fork ${RPC_URL} | chain ${CHAIN_SLUG} | diamond ${DIAMOND} | block ${await pub.getBlockNumber()}\n`);

// Every file starts from the SAME fork state and leaves nothing behind.
//
// Scenario files move prices, warp time and arm switches. Each tries to put
// things back, but a file that aborts halfway cannot — and before this, one
// abort in the forced-close set left a debt asset repriced 2.5× and turned
// every later file into an unrelated-looking `IlliquidAssetNotAcknowledged`.
// Restoring by hand in every file is a list that is only ever as complete as
// the last person remembered; a node snapshot around each file is complete
// by construction. A snapshot id is consumed by its revert, so it is retaken
// per file.
const aborted = [];
for (const file of files) {
  console.log(`--- ${file}`);
  const snap = await rpc('evm_snapshot');
  if (snap.error || !snap.result) throw new Error(`fork node refused evm_snapshot: ${snap.error?.message ?? 'no id'}`);
  const firstRow = mark();
  try {
    // The import is INSIDE the guarded block: a module that fails to load (a
    // missing ABI, a top-level error, a syntax error) is an aborted file like
    // any other — named, reverted, and counted — not a crash that skips the
    // summary and the ledger.
    const mod = await import(path.join(HERE, 'scenarios', file));
    await mod.run();
  } catch (e) {
    const why = String(e.details ?? e.shortMessage ?? e.message).split('\n')[0];
    // Rows the file recorded before it aborted describe chain state that the
    // revert below erases; they leave the verdict and are kept for diagnosis.
    const partialRows = takeSince(firstRow);
    console.error(`  ${file} ABORTED: ${why}${partialRows.length ? ` (${partialRows.length} partial row(s) set aside)` : ''}`);
    aborted.push({ file, why, partialRows });
    process.exitCode = 1;
  } finally {
    const back = await rpc('evm_revert', [snap.result]);
    if (back.error || back.result !== true) throw new Error(`fork node failed to revert to the pre-${file} snapshot`);
  }
  console.log('');
}

const counts = summarise();
// An aborted file contributes no rows, so a clean-looking tally can sit on
// top of a scenario set that never ran. Say so where the verdict is read.
if (aborted.length) {
  console.log(`\n${aborted.length} scenario file(s) ABORTED and contributed no rows:`);
  for (const a of aborted) console.log(`  ${a.file} — ${a.why}`);
}
const out = path.join(HERE, 'last-run.json');
fs.writeFileSync(out, JSON.stringify({ chain: CHAIN_SLUG, diamond: DIAMOND, counts, aborted, rows: ledger() }, null, 1));
console.log(`ledger -> ${out}`);
if (counts.FAIL || aborted.length) process.exitCode = 1;
