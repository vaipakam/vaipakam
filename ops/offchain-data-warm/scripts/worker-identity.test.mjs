/**
 * The Worker names itself in its alerts, and that name is the real one.
 *
 * WHY (#1537 r8). The preflight alert fires before any configuration is
 * resolved — a missing bucket or encryption secret is precisely what it
 * reports — so it cannot name the bucket it would have written to. It names
 * the Worker instead, which means `src/index.ts` carries the deployed name
 * as a literal.
 *
 * A literal copy of a value that lives somewhere else drifts. It would drift
 * silently here, because nothing about a wrong name in an alert is visible
 * until an operator is reading that alert during an incident and deciding
 * which of two Workers to delete — which is the exact moment this identity
 * exists to serve. So the copy is pinned to the source.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** Minimal JSONC read — enough for a top-level string field. */
function wranglerName() {
  const src = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const withoutLineComments = src.replace(/^\s*\/\/.*$/gm, '');
  const m = withoutLineComments.match(/"name"\s*:\s*"([^"]+)"/);
  assert.ok(m, 'wrangler.jsonc has no top-level "name"');
  return m[1];
}

function declaredWorkerName() {
  const src = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
  const m = src.match(/const WORKER_NAME = '([^']+)'/);
  assert.ok(m, 'src/index.ts no longer declares WORKER_NAME');
  return m[1];
}

test('WORKER_NAME matches the deployed name in wrangler.jsonc', () => {
  assert.equal(declaredWorkerName(), wranglerName());
});

test('the preflight alert carries that identity', () => {
  // Not just "a constant exists" — the alert has to USE it. An earlier
  // version of this alert was unattributed, and the retirement step in the
  // release note treated alerts as proof of which Worker had run.
  const src = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
  // Comment lines mention the string too — and the first draft of this test
  // matched one of those and failed against correct code. Take the emitted
  // template literal, not any line containing the words.
  const line = src
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.includes('preflight FAILED') && !l.startsWith('//'));
  assert.ok(line, 'the preflight alert is gone');
  assert.match(
    line,
    /\$\{WORKER_NAME\}/,
    'the preflight alert must name the Worker — during the handoff two ' +
      'Workers share the schedule and the ops bot, so an unattributed ' +
      'failure cannot tell the operator which deployment is broken',
  );
});

test('the nightly alerts carry the bucket they wrote to', () => {
  // Same property, different identity: once config IS resolved, the bucket
  // is the more useful discriminator, and it is what the retirement step
  // now tells the operator to read.
  const src = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
  for (const marker of [
    'Nightly off-chain backup succeeded',
    'Nightly backup FAILED',
  ]) {
    const idx = src.indexOf(marker);
    assert.ok(idx !== -1, `alert missing: ${marker}`);
    // The bucket reference sits within the same alert construction.
    const window = src.slice(idx, idx + 900);
    assert.match(
      window,
      /cfg\.bucket/,
      `"${marker}" must name its bucket — during the archive→warm handoff ` +
        `two Workers share the schedule and the ops bot`,
    );
  }
});
