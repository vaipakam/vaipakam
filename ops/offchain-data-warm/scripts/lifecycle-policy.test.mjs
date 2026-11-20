/**
 * node:test suite for lifecycle-policy.mjs's recovery-window floor (#1476,
 * re-derived in #3158).
 *
 * The floor used to differ by tier: 8 days daily, 31 monthly, because the
 * weekly healthcheck fully verified only the newest period of each family.
 * The daily backup watcher (#1463 slice 2) replaced it and lists EVERY
 * version of every tier, so an overwrite of any retained period shows up as a
 * second version on the next run. One detector, one derivation, one floor.
 *
 * These tests exist so the floor cannot drift to a value nothing justifies,
 * and so the committed declaration is checked against it on every CI run
 * rather than only when an operator happens to hold B2 credentials (`--check`
 * needs live ones and is therefore unreachable in CI).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_RECOVERY_DAYS,
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

test('the floor is the one derived against the daily watcher', () => {
  // 3 days of detection (one skipped run plus the scheduler's delay) + 4 to
  // respond + 1 of slack. Both tiers share it, because the watcher checks
  // every retained version of both, not only the newest period.
  assert.equal(MIN_RECOVERY_DAYS, 8);
});

test('a recovery window under the floor is rejected, per tier', () => {
  for (const prefix of ['archives/', 'archives-monthly/']) {
    const bad = structuredClone(declared);
    const rule = bad.rules.find((r) => r.fileNamePrefix === prefix);
    assert.ok(rule, `${prefix} missing from the declaration`);
    // One day under the floor — the boundary, not an obviously silly value.
    const total = rule.daysFromUploadingToHiding + rule.daysFromHidingToDeleting;
    rule.daysFromHidingToDeleting = MIN_RECOVERY_DAYS - 1;
    rule.daysFromUploadingToHiding = total - (MIN_RECOVERY_DAYS - 1); // hold the ceiling constant
    assert.throws(
      () => assertPolicyCeilings(bad, fail),
      /floor/i,
      `${prefix} accepted a window one day under the floor`,
    );
  }
});

test('exactly the floor is accepted — the bound is inclusive', () => {
  // An off-by-one here would silently forbid the very value the comment
  // derives, and the next operator would raise the number to make it pass.
  const ok = structuredClone(declared);
  for (const prefix of ['archives/', 'archives-monthly/']) {
    const rule = ok.rules.find((r) => r.fileNamePrefix === prefix);
    const total = rule.daysFromUploadingToHiding + rule.daysFromHidingToDeleting;
    rule.daysFromHidingToDeleting = MIN_RECOVERY_DAYS;
    rule.daysFromUploadingToHiding = total - MIN_RECOVERY_DAYS;
  }
  // The manifest siblings keep their declared values, so this also confirms
  // the two prefixes in a tier are validated independently.
  assert.doesNotThrow(() => assertPolicyCeilings(ok, fail));
});

test('the watcher\'s monthly retention window agrees with the declared lifecycle', async () => {
  // `MONTHLY_RETAINED_MONTHS` lives in the shared tier table and the
  // retention days live in bucket-lifecycle.json. Nothing else ties them
  // together, so a lifecycle change could silently make the backup watcher
  // demand months that have legitimately aged out — a daily false page.
  const { MONTHLY_RETAINED_MONTHS } = await import('../src/tiers.ts');
  const rule = declared.rules.find((r) => r.fileNamePrefix === 'archives-monthly/');
  const liveMonths = rule.daysFromUploadingToHiding / 30.44; // mean month
  assert.ok(
    MONTHLY_RETAINED_MONTHS <= liveMonths,
    `the watcher requires ${MONTHLY_RETAINED_MONTHS} months but only ` +
      `~${liveMonths.toFixed(1)} are retained`,
  );
  // …and not so conservative that a deletion goes unnoticed for a year.
  assert.ok(MONTHLY_RETAINED_MONTHS >= liveMonths - 2);
});
