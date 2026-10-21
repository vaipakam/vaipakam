// Pins src/ccipSelectors.json to Deployments.ccipSelectorForChainId, the
// table the deploy scripts configure every CCIP lane from. A reader checking
// a lane's selector bindings against the JSON would otherwise drift from what
// the deploys actually set, and report a correctly wired lane as broken, or a
// broken one as wired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const solPath = path.resolve(here, '../../../contracts/script/lib/Deployments.sol');
const json = JSON.parse(fs.readFileSync(path.resolve(here, '../src/ccipSelectors.json'), 'utf8'));

/** `if (cid == N) return S;` lines of the function body, as chain id → selector. */
function solidityTable() {
  const src = fs.readFileSync(solPath, 'utf8');
  const start = src.indexOf('function ccipSelectorForChainId');
  assert.ok(start >= 0, 'Deployments.ccipSelectorForChainId not found');
  const end = src.indexOf('revert(', start);
  assert.ok(end > start, 'the function has no terminating revert');
  const body = src.slice(start, end);
  const out = new Map();
  for (const m of body.matchAll(/if \(cid == (\d+)\)\s+return (\d+);/g)) out.set(m[1], m[2]);
  // Every `return` in the body must be one of the matched entries, so an
  // entry written another way cannot be skipped silently.
  assert.equal((body.match(/\breturn\b/g) ?? []).length, out.size, 'an entry in ccipSelectorForChainId is not of the form `if (cid == N) return S;`');
  return out;
}

test('ccipSelectors.json carries exactly the deploy scripts\' CCIP selectors', () => {
  const sol = solidityTable();
  assert.ok(sol.size > 0);
  const mine = new Map(Object.entries(json.selectors).map(([c, e]) => [c, e.selector]));
  assert.deepEqual(new Map([...mine].sort()), new Map([...sol].sort()));
});
