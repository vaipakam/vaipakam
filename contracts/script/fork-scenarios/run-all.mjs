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
import { CHAIN_SLUG, DIAMOND, RPC_URL, pub, rpc } from './lib/chain.mjs';
import { ledger, summarise } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wanted = process.argv.slice(2);

const files = fs
  .readdirSync(path.join(HERE, 'scenarios'))
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)));

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
console.log(`fork ${RPC_URL} | chain ${CHAIN_SLUG} | diamond ${DIAMOND} | block ${await pub.getBlockNumber()}\n`);

const aborted = [];
for (const file of files) {
  console.log(`--- ${file}`);
  const mod = await import(path.join(HERE, 'scenarios', file));
  try {
    await mod.run();
  } catch (e) {
    const why = String(e.details ?? e.shortMessage ?? e.message).split('\n')[0];
    console.error(`  ${file} ABORTED: ${why}`);
    aborted.push({ file, why });
    process.exitCode = 1;
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
