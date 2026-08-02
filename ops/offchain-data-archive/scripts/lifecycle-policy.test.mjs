/**
 * node:test suite for lifecycle-policy.mjs's recovery-window floors (#1476).
 *
 * The monthly floor was 31 rather than 8 for one reason: nothing inspected the
 * monthly prefixes, so the window could not be justified by detection and had
 * to outlast the monthly write cadence instead. #1476 gave that tier the same
 * weekly healthcheck the daily tier has, which is what permits the same
 * derivation and therefore the same number.
 *
 * These tests exist so the floor cannot drift back to a value nothing
 * justifies, and so the committed declaration is checked against the floors
 * on every CI run rather than only when an operator happens to hold B2
 * credentials (`--check` needs live ones and is therefore unreachable in CI).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_RECOVERY_DAYS_DAILY,
  MIN_RECOVERY_DAYS_MONTHLY,
  assertPolicyCeilings,
} from './lifecycle-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const declared = JSON.parse(
  readFileSync(path.join(here, '..', 'bucket-lifecycle.json'), 'utf8'),
);

/** `fail` must not return — mirror how the real callers use it. */
const fail = (msg) => {
  throw new Error(msg);
};

test('the committed declaration satisfies both floors and ceilings', () => {
  // CI never runs `--check` (it needs live B2 credentials), so without this
  // the committed numbers were only ever validated by hand.
  assert.doesNotThrow(() => assertPolicyCeilings(declared, fail));
});

test('the monthly floor is NOT lowered to the daily one', () => {
  assert.equal(MIN_RECOVERY_DAYS_DAILY, 8);
  // 31, deliberately. The healthcheck now READS the monthly prefixes, but
  // fully verifies only the NEWEST period of each family; older retained
  // months get presence-and-pairing only, and an overwrite leaves both keys
  // in place. An 8-day window there would rest on a detector that does not
  // watch those objects.
  assert.equal(MIN_RECOVERY_DAYS_MONTHLY, 31);
  assert.ok(
    MIN_RECOVERY_DAYS_MONTHLY > MIN_RECOVERY_DAYS_DAILY,
    'the monthly floor may not be lowered to the daily one while only the ' +
      'newest monthly period is fully verified',
  );
});

test('a recovery window under the floor is rejected, per tier', () => {
  for (const prefix of ['archives/', 'archives-monthly/']) {
    const bad = structuredClone(declared);
    const rule = bad.rules.find((r) => r.fileNamePrefix === prefix);
    assert.ok(rule, `${prefix} missing from the declaration`);
    // One day under the floor — the boundary, not an obviously silly value.
    const total = rule.daysFromUploadingToHiding + rule.daysFromHidingToDeleting;
    const floor =
      prefix === 'archives/' ? MIN_RECOVERY_DAYS_DAILY : MIN_RECOVERY_DAYS_MONTHLY;
    rule.daysFromHidingToDeleting = floor - 1;
    rule.daysFromUploadingToHiding = total - (floor - 1); // hold the ceiling constant
    assert.throws(
      () => assertPolicyCeilings(bad, fail),
      /floor/i,
      `${prefix} accepted a 7-day recovery window`,
    );
  }
});

test('exactly the floor is accepted — the bound is inclusive', () => {
  // An off-by-one here would silently forbid the very value the comment
  // derives, and the next operator would raise the number to make it pass.
  const ok = structuredClone(declared);
  // Each tier at ITS OWN floor — they differ, and using one number for both
  // is what the previous version of this test did.
  const floors = {
    'archives/': MIN_RECOVERY_DAYS_DAILY,
    'archives-monthly/': MIN_RECOVERY_DAYS_MONTHLY,
  };
  for (const [prefix, floor] of Object.entries(floors)) {
    const rule = ok.rules.find((r) => r.fileNamePrefix === prefix);
    const total = rule.daysFromUploadingToHiding + rule.daysFromHidingToDeleting;
    rule.daysFromHidingToDeleting = floor;
    rule.daysFromUploadingToHiding = total - floor;
  }
  // The manifest siblings keep their declared values, so this also confirms
  // the two prefixes in a tier are validated independently.
  assert.doesNotThrow(() => assertPolicyCeilings(ok, fail));
});

test('the healthcheck retention window agrees with the declared lifecycle', async () => {
  // `MONTHLY_RETAINED_MONTHS` lives in the Worker's tier table and the
  // retention days live in bucket-lifecycle.json. Nothing else ties them
  // together, so a lifecycle change could silently make the healthcheck
  // demand months that have legitimately aged out — a weekly false page.
  const { MONTHLY_RETAINED_MONTHS } = await import('../src/tiers.ts');
  const rule = declared.rules.find((r) => r.fileNamePrefix === 'archives-monthly/');
  const liveMonths = rule.daysFromUploadingToHiding / 30.44; // mean month
  assert.ok(
    MONTHLY_RETAINED_MONTHS <= liveMonths,
    `healthcheck requires ${MONTHLY_RETAINED_MONTHS} months but only ` +
      `~${liveMonths.toFixed(1)} are retained`,
  );
  // …and not so conservative that a deletion goes unnoticed for a year.
  assert.ok(MONTHLY_RETAINED_MONTHS >= liveMonths - 2);
});
