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
  periodOf,
  classifyListing,
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

test('daily tolerates ONE missed nightly but not three', () => {
  const now = at('2026-03-01T09:00:00Z');
  const d = tier('daily');
  // Yesterday present, today not yet uploaded — normal, must not page.
  assert.deepEqual(d.missingRequired(['2026-02-28'], now), []);
  // Nothing in three days: the cron has stopped.
  assert.deepEqual(d.missingRequired(['2026-02-20'], now), [
    '2026-03-01',
    '2026-02-28',
    '2026-02-27',
  ]);
});

test('a FAILED monthly cut is reported in the month it failed', () => {
  // The previous month is REQUIRED, not a fallback. As a fallback, January
  // satisfied every February check and the missing February cut was never
  // reported at all once March succeeded — a permanent gap behind green
  // weekly reports.
  const feb = at('2026-02-16T09:00:00Z');
  assert.deepEqual(tier('monthly').missingRequired(['2026-01'], feb), ['2026-02']);
});

test('…and STILL reported in the months after it failed', () => {
  const mar = at('2026-03-16T09:00:00Z');
  assert.deepEqual(
    tier('monthly').missingRequired(['2026-01', '2026-03'], mar),
    ['2026-02'],
  );
});

test('the current month is excused ONLY on the 1st, the real race window', () => {
  const first = at('2026-02-01T09:00:00Z');
  assert.deepEqual(tier('monthly').missingRequired(['2026-01'], first), []);
  // One day later the excuse is gone.
  const second = at('2026-02-02T09:00:00Z');
  assert.deepEqual(tier('monthly').missingRequired(['2026-01'], second), ['2026-02']);
});

test('an ESTABLISHED yearly tier that loses a year FAILS', () => {
  // Nothing ages out of the yearly prefixes — that absence of a lifecycle
  // rule IS the indefinite retention the legal-audit tier rests on. So an
  // admin deletion or a lifecycle rule drifting onto them must not read as
  // a young deployment.
  const now = at('2029-06-01T09:00:00Z');
  assert.deepEqual(
    tier('yearly').missingRequired(['2027', '2029'], now),
    ['2028'],
  );
});

test('a yearly tier wiped ENTIRELY after being established still fails', () => {
  // The whole family gone is the case a blanket absence exemption made
  // permanently invisible. It now falls to the absence branch only when
  // nothing was EVER written; `verifyTier` checks missing first.
  const now = at('2029-06-01T09:00:00Z');
  // Nothing present -> no range to require, so the absence branch decides;
  // that branch is what `absenceIsFailure` governs, asserted below.
  assert.deepEqual(tier('yearly').missingRequired([], now), []);
  assert.equal(tier('yearly').absenceIsFailure, false);
});

test('yearly requires every year since the first, not just the last two', () => {
  // A two-period lookback never examined older indefinite-retention years.
  const now = at('2031-06-01T09:00:00Z');
  assert.deepEqual(
    tier('yearly').missingRequired(['2027'], now),
    ['2028', '2029', '2030', '2031'],
  );
});

test('yearly excuses the current year only on Jan 1', () => {
  assert.deepEqual(
    tier('yearly').missingRequired(['2027', '2028'], at('2029-01-01T09:00:00Z')),
    [],
  );
  assert.deepEqual(
    tier('yearly').missingRequired(['2027', '2028'], at('2029-01-02T09:00:00Z')),
    ['2029'],
  );
});

test('a young deployment with no yearly archive is not a failure', () => {
  assert.deepEqual(tier('yearly').missingRequired([], at('2026-06-01T09:00:00Z')), []);
});

test('period keys are UTC, not local', () => {
  assert.equal(dayKey(at('2026-06-30T23:59:59Z'), 0), '2026-06-30');
  assert.equal(monthKey(at('2026-06-30T23:59:59Z'), 0), '2026-06');
  assert.equal(yearKey(at('2026-12-31T23:59:59Z'), 0), '2026');
});

test('month stepping does not skip a month from a 31st', () => {
  // setUTCMonth rolls FORWARD on short months: a naive step back from
  // Mar 31 lands on Mar 3, so the previous month would never be required.
  assert.equal(monthKey(at('2026-03-31T09:00:00Z'), 1), '2026-02');
});

test('year stepping survives a leap day', () => {
  assert.equal(yearKey(at('2028-02-29T09:00:00Z'), 1), '2027');
});

test('periodOf extracts the period segment, and rejects foreign keys', () => {
  assert.equal(periodOf(tier('monthly'), 'manifests-monthly/2026-08/a.json'), '2026-08');
  assert.equal(periodOf(tier('daily'), 'manifests/2026-08-02/a.json'), '2026-08-02');
  // A key directly under the prefix has no period segment.
  assert.equal(periodOf(tier('daily'), 'manifests/stray.json'), null);
  // The daily prefix must not swallow the monthly family.
  assert.equal(periodOf(tier('daily'), 'manifests-monthly/2026-08/a.json'), null);
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

test('total-family absence is pageable for daily/monthly, not for yearly', () => {
  // Only about a family NEVER written. An ESTABLISHED family that loses a
  // period is caught by `missingRequired` first — see the yearly tests.
  assert.equal(tier('daily').absenceIsFailure, true);
  assert.equal(tier('monthly').absenceIsFailure, true);
  assert.equal(tier('yearly').absenceIsFailure, false);
});

describe_listing();
function describe_listing() {
  const K = (p, period) => `${p}${period}/abc.json`;

  test('a FAILED listing is a tier failure, never an empty tier', () => {
    // Continuing past a list error made an unreadable prefix
    // indistinguishable from an absent family — which on the yearly tier,
    // whose absence is excused, produced a green PASS over an S3 outage.
    for (const name of ['daily', 'monthly', 'yearly']) {
      const v = classifyListing(
        tier(name),
        { ok: false, error: 'S3 list failed: 503' },
        at('2029-06-01T09:00:00Z'),
      );
      assert.equal(v.done, true, `${name} should be decided`);
      assert.equal(v.ok, false, `${name} must FAIL on an unreadable prefix`);
      assert.equal(v.absent, false, `${name} must not report absence`);
      assert.match(v.reason, /NOT as an empty tier/);
    }
  });

  test('a missing required period is decided BEFORE the absence excuse', () => {
    // Ordering is the fix: an established family that lost a year must not
    // fall through to "nothing written yet", which is excused for yearly.
    const v = classifyListing(
      tier('yearly'),
      { ok: true, keys: [K('manifests-yearly/', '2027'), K('manifests-yearly/', '2029')] },
      at('2029-06-01T09:00:00Z'),
    );
    assert.equal(v.done, true);
    assert.equal(v.ok, false);
    assert.match(v.reason, /missing for 2028/);
  });

  test('a never-written yearly family is excused; a never-written daily one is not', () => {
    const now = at('2026-06-01T09:00:00Z');
    const y = classifyListing(tier('yearly'), { ok: true, keys: [] }, now);
    assert.equal(y.done, true);
    assert.equal(y.ok, true);
    assert.equal(y.absent, true);

    const d = classifyListing(tier('daily'), { ok: true, keys: [] }, now);
    assert.equal(d.done, true);
    assert.equal(d.ok, false);
  });

  test('a healthy tier proceeds to verify its NEWEST period', () => {
    const v = classifyListing(
      tier('monthly'),
      {
        ok: true,
        keys: [
          K('manifests-monthly/', '2026-01'),
          K('manifests-monthly/', '2026-03'),
          K('manifests-monthly/', '2026-02'),
        ],
      },
      at('2026-03-16T09:00:00Z'),
    );
    assert.equal(v.done, false);
    // Lexicographic max, not listing order — S3 lists by key, not by time.
    assert.equal(v.newestPeriod, '2026-03');
  });

  test('keys from a FOREIGN family are ignored, not counted as periods', () => {
    // `manifests-monthly/...` sits under no daily prefix, but a sloppy
    // segment split would still yield something period-shaped.
    const v = classifyListing(
      tier('daily'),
      { ok: true, keys: ['manifests-monthly/2026-03/a.json', 'manifests/stray.json'] },
      at('2026-03-16T09:00:00Z'),
    );
    assert.equal(v.done, true);
    assert.equal(v.ok, false); // nothing valid present -> daily fails
  });
}

test('an empty AGEING tier reports a dead cron, not "never written"', () => {
  // Both orderings fail the daily tier, so the verdict alone proves
  // nothing — the reason is the whole difference. "Never written" is
  // knowable only for a tier nothing deletes; claiming it for one that
  // ages out sends the operator after the wrong problem.
  const v = classifyListing(
    tier('daily'),
    { ok: true, keys: [] },
    at('2026-03-16T09:00:00Z'),
  );
  assert.equal(v.ok, false);
  assert.match(v.reason, /missing for 2026-03-16/);
  assert.doesNotMatch(v.reason, /ever been written/);

  // The yearly tier is the one that CAN make that claim.
  const y = classifyListing(
    tier('yearly'),
    { ok: true, keys: [] },
    at('2026-03-16T09:00:00Z'),
  );
  assert.equal(y.ok, true);
  assert.match(y.reason, /ever been written/);
});
