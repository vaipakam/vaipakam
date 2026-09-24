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
import { CHAIN_SLUG, DIAMOND, RPC_URL, pub } from './lib/chain.mjs';
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
console.log(`fork ${RPC_URL} | chain ${CHAIN_SLUG} | diamond ${DIAMOND} | block ${await pub.getBlockNumber()}\n`);

for (const file of files) {
  console.log(`--- ${file}`);
  const mod = await import(path.join(HERE, 'scenarios', file));
  try {
    await mod.run();
  } catch (e) {
    console.error(`  ${file} aborted: ${String(e.shortMessage ?? e.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
  console.log('');
}

const counts = summarise();
const out = path.join(HERE, 'last-run.json');
fs.writeFileSync(out, JSON.stringify({ chain: CHAIN_SLUG, diamond: DIAMOND, counts, rows: ledger() }, null, 1));
console.log(`ledger -> ${out}`);
if (counts.FAIL) process.exitCode = 1;
