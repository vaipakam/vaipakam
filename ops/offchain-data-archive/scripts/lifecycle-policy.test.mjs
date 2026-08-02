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

test('the monthly floor is the daily floor, and both are the weekly cycle + slack', () => {
  assert.equal(MIN_RECOVERY_DAYS_DAILY, 8);
  assert.equal(MIN_RECOVERY_DAYS_MONTHLY, 8);
  // Equal because the same detector now covers both tiers. If a future change
  // removes monthly coverage from the healthcheck, this equality is the thing
  // that has to be revisited — not silently kept.
  assert.equal(MIN_RECOVERY_DAYS_MONTHLY, MIN_RECOVERY_DAYS_DAILY);
});

test('a recovery window under the floor is rejected, per tier', () => {
  for (const prefix of ['archives/', 'archives-monthly/']) {
    const bad = structuredClone(declared);
    const rule = bad.rules.find((r) => r.fileNamePrefix === prefix);
    assert.ok(rule, `${prefix} missing from the declaration`);
    // One day under the floor — the boundary, not an obviously silly value.
    const total = rule.daysFromUploadingToHiding + rule.daysFromHidingToDeleting;
    rule.daysFromHidingToDeleting = 7;
    rule.daysFromUploadingToHiding = total - 7; // hold the ceiling constant
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
  for (const prefix of ['archives/', 'archives-monthly/']) {
    const rule = ok.rules.find((r) => r.fileNamePrefix === prefix);
    const total = rule.daysFromUploadingToHiding + rule.daysFromHidingToDeleting;
    rule.daysFromHidingToDeleting = 8;
    rule.daysFromUploadingToHiding = total - 8;
  }
  // The manifest siblings keep their declared values, so this also confirms
  // the two prefixes in a tier are validated independently.
  assert.doesNotThrow(() => assertPolicyCeilings(ok, fail));
});
