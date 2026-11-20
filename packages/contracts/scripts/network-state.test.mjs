// Pins the recorded network states (src/deployments.ts, NETWORK_STATES) to the
// closed set the daily launch check accepts (#3858,
// contracts/script/lib/NetworkWindDown.sol `recorded`), and refuses a bundle
// record carrying any other value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsPath = path.resolve(here, '../src/deployments.ts');

test('every recorded network state is open or closed (#3858)', () => {
  const src = fs.readFileSync(tsPath, 'utf8');
  const m = src.match(/export const NETWORK_STATES = \[([^\]]*)\] as const;/);
  assert.ok(m, 'NETWORK_STATES not found in src/deployments.ts');
  const states = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  assert.deepEqual(states, ['open', 'closed']);
  const deployments = JSON.parse(fs.readFileSync(path.resolve(here, '../src/deployments.json'), 'utf8'));
  for (const [chainId, dep] of Object.entries(deployments)) {
    if (dep.networkState === undefined) continue;
    assert.ok(states.includes(dep.networkState), `chain ${chainId}: networkState '${dep.networkState}' is neither open nor closed`);
  }
});
