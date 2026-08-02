/**
 * node:test suite for src/tiers.ts (#1476).
 *
 * The healthcheck only ever examined the daily prefixes, so the monthly
 * and yearly families were unverified by anything — and the retention
 * policy then justified the monthly floor with "the detector will catch
 * it". These tests cover the two parts of the fix most likely to be
 * quietly wrong: calendar stepping (which misbehaves on month ends) and
 * sibling-key derivation (whose obvious implementation silently fails on
 * every prefix except the daily one).
 *
 * Loaded directly as TypeScript — `src/tiers.ts` deliberately has no
 * imports so `node --test` can read it without the Worker bundler.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIERS,
  dayKey,
  monthKey,
  yearKey,
  siblingArchiveKey,
} from '../src/tiers.ts';

const at = (iso) => Date.parse(iso);
const tier = (name) => TIERS.find((t) => t.tier === name);

test('every prefix family the backup writes is covered', () => {
  // The defect was a family nobody checked. Pin the whole set, so
  // adding a writer without a checker fails here.
  assert.deepEqual(
    TIERS.map((t) => t.tier),
    ['daily', 'monthly', 'yearly'],
  );
  assert.deepEqual(
    TIERS.map((t) => t.manifestPrefix).sort(),
    ['manifests-monthly/', 'manifests-yearly/', 'manifests/'],
  );
  assert.deepEqual(
    TIERS.map((t) => t.archivePrefix).sort(),
    ['archives-monthly/', 'archives-yearly/', 'archives/'],
  );
});

test('daily lookback spans three days and tolerates one missed nightly', () => {
  const keys = tier('daily').periodKeys(at('2026-03-01T09:00:00Z'));
  assert.deepEqual(keys, ['2026-03-01', '2026-02-28', '2026-02-27']);
});

test('monthly lookback does not skip a month when run on a 31st', () => {
  // `setUTCMonth` rolls FORWARD when the target month is shorter, so a
  // naive step back from Mar 31 lands on Mar 3 — the lookback would
  // then check March twice and never look at February at all.
  const keys = tier('monthly').periodKeys(at('2026-03-31T09:00:00Z'));
  assert.deepEqual(keys, ['2026-03', '2026-02']);
});

test('monthly lookback crosses a year boundary', () => {
  const keys = tier('monthly').periodKeys(at('2026-01-01T00:30:00Z'));
  assert.deepEqual(keys, ['2026-01', '2025-12']);
});

test('yearly lookback survives a leap day', () => {
  // Feb 29 stepped back one year is not a date.
  const keys = tier('yearly').periodKeys(at('2028-02-29T09:00:00Z'));
  assert.deepEqual(keys, ['2028', '2027']);
});

test('period keys are UTC, not local', () => {
  // A run just before midnight UTC must not be attributed to tomorrow.
  assert.equal(dayKey(at('2026-06-30T23:59:59Z'), 0), '2026-06-30');
  assert.equal(monthKey(at('2026-06-30T23:59:59Z'), 0), '2026-06');
  assert.equal(yearKey(at('2026-12-31T23:59:59Z'), 0), '2026');
});

test('sibling archive key is derived per tier, not by rewriting "manifests/"', () => {
  // The obvious implementation — replace(/^manifests\//, 'archives/') —
  // does not match `manifests-monthly/`, so it returns a .bin under the
  // MANIFEST prefix. That reads as a missing archive on a healthy tier.
  assert.equal(
    siblingArchiveKey(tier('daily'), 'manifests/2026-08-02/abc.json'),
    'archives/2026-08-02/abc.bin',
  );
  assert.equal(
    siblingArchiveKey(tier('monthly'), 'manifests-monthly/2026-08/abc.json'),
    'archives-monthly/2026-08/abc.bin',
  );
  assert.equal(
    siblingArchiveKey(tier('yearly'), 'manifests-yearly/2026/abc.json'),
    'archives-yearly/2026/abc.bin',
  );
});

test('a manifest key under the wrong prefix is fatal, never guessed at', () => {
  // Silently returning a wrong key would send the check looking for an
  // object that does not exist and report the tier as broken.
  assert.throws(
    () => siblingArchiveKey(tier('monthly'), 'manifests/2026-08-02/abc.json'),
    /not under manifests-monthly\//,
  );
});

test('the daily prefix does not swallow the monthly one', () => {
  // `manifests-monthly/...` does NOT start with `manifests/`, which is
  // what makes per-tier derivation necessary rather than cosmetic.
  assert.ok(!'manifests-monthly/2026-08/a.json'.startsWith('manifests/'));
  assert.throws(
    () => siblingArchiveKey(tier('daily'), 'manifests-monthly/2026-08/a.json'),
    /not under manifests\//,
  );
});

test('absence is pageable for monthly but not for yearly', () => {
  // A yearly archive legitimately does not exist until the deployment
  // lives through a Jan 1 — a normal state lasting up to a year, which
  // cannot be paged weekly without training the operator to ignore it.
  // A missing monthly means the monthly write has stopped.
  assert.equal(tier('daily').absenceIsFailure, true);
  assert.equal(tier('monthly').absenceIsFailure, true);
  assert.equal(tier('yearly').absenceIsFailure, false);
});
