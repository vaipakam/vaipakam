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
  validateBaseline,
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

const B = (monthly, yearly) => ({ monthly, yearly });
const NO_BASELINE = {};

test('daily tolerates ONE missed nightly but not three', () => {
  const now = at('2026-03-01T09:00:00Z');
  const d = tier('daily');
  assert.deepEqual(d.missingRequired(['2026-02-28'], now, NO_BASELINE), []);
  assert.deepEqual(d.missingRequired(['2026-02-20'], now, NO_BASELINE), [
    '2026-03-01',
    '2026-02-28',
    '2026-02-27',
  ]);
});

test('a FAILED monthly cut is reported in the month it failed', () => {
  const feb = at('2026-02-16T09:00:00Z');
  assert.deepEqual(
    tier('monthly').missingRequired(['2026-01'], feb, B('2026-01')),
    ['2026-02'],
  );
});

test('…and STILL reported in the months after it failed', () => {
  const mar = at('2026-03-16T09:00:00Z');
  assert.deepEqual(
    tier('monthly').missingRequired(['2026-01', '2026-03'], mar, B('2026-01')),
    ['2026-02'],
  );
});

test('an OLD monthly snapshot deleted mid-retention is caught', () => {
  // Requiring only the current and previous month meant deleting April in
  // June went unnoticed forever: May and June were present, nothing else
  // was asked about, and April had ~10 months of expected life left.
  const jun = at('2026-06-16T09:00:00Z');
  const present = ['2026-01', '2026-02', '2026-03', '2026-05', '2026-06'];
  assert.deepEqual(
    tier('monthly').missingRequired(present, jun, B('2026-01')),
    ['2026-04'],
  );
});

test('monthly never requires a month predating the declared first cut', () => {
  // The retention window reaches back further than the deployment does.
  const jun = at('2026-06-16T09:00:00Z');
  assert.deepEqual(
    tier('monthly').missingRequired(['2026-05', '2026-06'], jun, B('2026-05')),
    [],
  );
});

test('the current month is excused ONLY on the 1st, the real race window', () => {
  assert.deepEqual(
    tier('monthly').missingRequired(['2026-01'], at('2026-02-01T09:00:00Z'), B('2026-01')),
    [],
  );
  assert.deepEqual(
    tier('monthly').missingRequired(['2026-01'], at('2026-02-02T09:00:00Z'), B('2026-01')),
    ['2026-02'],
  );
});

test('a DECLARED yearly baseline catches deletion of the OLDEST year', () => {
  // The circularity this fixes: inferring the baseline from surviving
  // keys means deleting the oldest year advances the baseline past it, so
  // the deleted year stops being required and the tier passes.
  const now = at('2029-06-01T09:00:00Z');
  assert.deepEqual(
    tier('yearly').missingRequired(['2028', '2029'], now, B(undefined, '2027')),
    ['2027'],
  );
  // Without the declared baseline the same deletion is invisible.
  assert.deepEqual(
    tier('yearly').missingRequired(['2028', '2029'], now, NO_BASELINE),
    [],
  );
});

test('a yearly family wiped ENTIRELY fails when a baseline is declared', () => {
  // With nothing left to infer from, the inferring version had nothing to
  // report and passed — the worst case reading as the healthiest.
  const now = at('2029-06-01T09:00:00Z');
  assert.deepEqual(
    tier('yearly').missingRequired([], now, B(undefined, '2027')),
    ['2027', '2028', '2029'],
  );
});

test('an ESTABLISHED yearly tier that loses a middle year FAILS', () => {
  const now = at('2029-06-01T09:00:00Z');
  assert.deepEqual(
    tier('yearly').missingRequired(['2027', '2029'], now, B(undefined, '2027')),
    ['2028'],
  );
});

test('yearly excuses the current year only on Jan 1', () => {
  assert.deepEqual(
    tier('yearly').missingRequired(['2027', '2028'], at('2029-01-01T09:00:00Z'), B(undefined, '2027')),
    [],
  );
  assert.deepEqual(
    tier('yearly').missingRequired(['2027', '2028'], at('2029-01-02T09:00:00Z'), B(undefined, '2027')),
    ['2029'],
  );
});

test('a young deployment with no yearly archive and no baseline is not a failure', () => {
  assert.deepEqual(
    tier('yearly').missingRequired([], at('2026-06-01T09:00:00Z'), NO_BASELINE),
    [],
  );
});

test('period keys are UTC, not local', () => {
  assert.equal(dayKey(at('2026-06-30T23:59:59Z'), 0), '2026-06-30');
  assert.equal(monthKey(at('2026-06-30T23:59:59Z'), 0), '2026-06');
  assert.equal(yearKey(at('2026-12-31T23:59:59Z'), 0), '2026');
});

test('month stepping does not skip a month from a 31st', () => {
  assert.equal(monthKey(at('2026-03-31T09:00:00Z'), 1), '2026-02');
});

test('year stepping survives a leap day', () => {
  assert.equal(yearKey(at('2028-02-29T09:00:00Z'), 1), '2027');
});

test('a HOSTILE period segment never enters the period set', () => {
  // The write-only B2 key can create objects, so a holder can upload
  // `manifests-yearly/-999999999/attack.json`. Unvalidated, that segment
  // became the start of a required-period RANGE — a synchronous loop of
  // ~a billion iterations, enough to exhaust the scheduled invocation
  // before the per-tier catch or the alert ran, taking the Monday backup
  // sharing that invocation with it.
  assert.equal(periodOf(tier('yearly'), 'manifests-yearly/-999999999/a.json'), null);
  assert.equal(periodOf(tier('yearly'), 'manifests-yearly/99999/a.json'), null);
  assert.equal(periodOf(tier('monthly'), 'manifests-monthly/2026-8/a.json'), null);
  assert.equal(periodOf(tier('daily'), 'manifests/2026-08/a.json'), null);
  // …and the canonical shapes still pass.
  assert.equal(periodOf(tier('yearly'), 'manifests-yearly/2026/a.json'), '2026');
  assert.equal(periodOf(tier('monthly'), 'manifests-monthly/2026-08/a.json'), '2026-08');
  assert.equal(periodOf(tier('daily'), 'manifests/2026-08-02/a.json'), '2026-08-02');
});

test('a hostile listing cannot hang the run even if validation regresses', () => {
  // Second, independent guard: the range expander refuses an implausible
  // span outright. One regression in `periodOf` must not be able to
  // reintroduce a denial of service that takes the backup down with it.
  assert.throws(
    () => tier('yearly').missingRequired([], at('2029-06-01T09:00:00Z'), B(undefined, '0001')),
    /implausible yearly range/,
  );
});

test('periodOf extracts the period segment, and rejects foreign keys', () => {
  assert.equal(periodOf(tier('monthly'), 'manifests-monthly/2026-08/a.json'), '2026-08');
  assert.equal(periodOf(tier('daily'), 'manifests/stray.json'), null);
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
  /** The real sibling of `K` — `.bin`, not `.json`. The pairing check
   *  compares actual keys now, so a fixture that pairs `.json` with
   *  `.json` is not modelling a restorable backup. */
  const KA = (p, period) => `${p}${period}/abc.bin`;

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
      { monthly: '2026-01' },
    );
    assert.equal(v.done, false);
    // Lexicographic max, not listing order — S3 lists by key, not by time.
    assert.equal(v.newestPeriod, '2026-03');
  });

  test('a manifest with NO archive beside it fails the tier', () => {
    // A period counts as present from its MANIFEST — a few hundred bytes
    // describing an archive that may no longer be there. Only the newest
    // period's archive was ever fetched, so an individual deletion or
    // asymmetric lifecycle drift on an older one passed unseen.
    const v = classifyListing(
      tier('monthly'),
      { ok: true, keys: [K('manifests-monthly/', '2026-02'), K('manifests-monthly/', '2026-03')] },
      at('2026-03-16T09:00:00Z'),
      { monthly: '2026-02' },
      { ok: true, keys: [KA('archives-monthly/', '2026-03')] },
    );
    assert.equal(v.done, true);
    assert.equal(v.ok, false);
    assert.match(v.reason, /NO archive beside it for 2026-02/);
  });

  test('an unreadable ARCHIVE prefix fails too, like an unreadable manifest one', () => {
    const v = classifyListing(
      tier('monthly'),
      { ok: true, keys: [K('manifests-monthly/', '2026-03')] },
      at('2026-03-16T09:00:00Z'),
      { monthly: '2026-03' },
      { ok: false, error: 'S3 list failed: 503' },
    );
    assert.equal(v.done, true);
    assert.equal(v.ok, false);
    assert.match(v.reason, /could not list archives-monthly\//);
  });

  test('a passing tier DISCLOSES that deletion detection is degraded', () => {
    // Without a declared baseline the tier cannot report that its oldest
    // periods were deleted. Passing silently would imply a coverage it
    // does not have — the exact failure this whole PR started from.
    const v = classifyListing(
      tier('yearly'),
      { ok: true, keys: [K('manifests-yearly/', '2028')] },
      at('2028-06-01T09:00:00Z'),
      {},
      { ok: true, keys: [KA('archives-yearly/', '2028')] },
    );
    assert.equal(v.done, false);
    assert.match(v.degraded, /no declared first-yearly baseline/);
  });

  test('…and does NOT claim degradation once a baseline is declared', () => {
    const v = classifyListing(
      tier('yearly'),
      { ok: true, keys: [K('manifests-yearly/', '2028')] },
      at('2028-06-01T09:00:00Z'),
      { yearly: '2028' },
      { ok: true, keys: [KA('archives-yearly/', '2028')] },
    );
    assert.equal(v.done, false);
    assert.equal(v.degraded, undefined);
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

test('a period must be a real calendar period, not merely the right width', () => {
  // `9999-99` passes a width regex AND sorts above every genuine month, so
  // it becomes `newestPeriod` — the tier would then fetch and parse an
  // attacker-chosen manifest instead of the real newest backup. The shape
  // check stopped the range explosion; it did not stop selection.
  assert.equal(periodOf(tier('monthly'), 'manifests-monthly/9999-99/a.json'), null);
  assert.equal(periodOf(tier('monthly'), 'manifests-monthly/2026-00/a.json'), null);
  assert.equal(periodOf(tier('daily'), 'manifests/2026-02-30/a.json'), null);
  assert.equal(periodOf(tier('daily'), 'manifests/2026-13-01/a.json'), null);
  assert.equal(periodOf(tier('yearly'), 'manifests-yearly/1999/a.json'), null);
  // …and real ones still pass.
  assert.equal(periodOf(tier('daily'), 'manifests/2026-02-28/a.json'), '2026-02-28');
  assert.equal(periodOf(tier('monthly'), 'manifests-monthly/2026-12/a.json'), '2026-12');
});

test('a FUTURE period cannot capture the newest slot', () => {
  // A real-but-future period passes the calendar check, so the guard has
  // to be against the clock, not the shape.
  const v = classifyListing(
    tier('monthly'),
    {
      ok: true,
      keys: [
        'manifests-monthly/2026-03/honest.json',
        'manifests-monthly/2030-01/planted.json',
      ],
    },
    at('2026-03-16T09:00:00Z'),
    { monthly: '2026-03' },
    {
      ok: true,
      keys: [
        'archives-monthly/2026-03/honest.bin',
        'archives-monthly/2030-01/planted.bin',
      ],
    },
  );
  assert.equal(v.done, false);
  assert.equal(v.newestPeriod, '2026-03');
});

test('a manifest paired with a DIFFERENT nonce is not a restorable backup', () => {
  // Reducing both sides to period labels says "this month has a manifest
  // and this month has an archive" — satisfied by manifest/A beside
  // archive/B, where neither restores with the other.
  const v = classifyListing(
    tier('monthly'),
    { ok: true, keys: ['manifests-monthly/2026-03/A.json'] },
    at('2026-03-16T09:00:00Z'),
    { monthly: '2026-03' },
    { ok: true, keys: ['archives-monthly/2026-03/B.bin'] },
  );
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /NO archive beside it/);
});

test('one superseded upload losing its pair is not a lost backup', () => {
  // The period is still restorable through the other pair, so this must
  // not page — the check is about losing a BACKUP, not a stray key.
  const v = classifyListing(
    tier('monthly'),
    {
      ok: true,
      keys: ['manifests-monthly/2026-03/A.json', 'manifests-monthly/2026-03/B.json'],
    },
    at('2026-03-16T09:00:00Z'),
    { monthly: '2026-03' },
    { ok: true, keys: ['archives-monthly/2026-03/B.bin'] },
  );
  assert.equal(v.done, false);
});

test('an empty family with no baseline PASSES but discloses the degradation', () => {
  // This is the state where deletion detection is most conspicuously
  // unavailable, and it was the one path that returned a bare pass.
  const v = classifyListing(
    tier('yearly'),
    { ok: true, keys: [] },
    at('2026-06-01T09:00:00Z'),
    {},
    { ok: true, keys: [] },
  );
  assert.equal(v.done, true);
  assert.equal(v.ok, true);
  assert.match(v.degraded, /no declared first-yearly baseline/);
});

test('a mistyped baseline is REJECTED, not silently obeyed', () => {
  // `2026-13` compares above every real month, so every retained month
  // reads as predating the deployment and nothing is required — and being
  // truthy, it also suppresses the degraded warning that would have said
  // so. One digit turns the tier off and removes the notice.
  const now = at('2026-06-01T09:00:00Z');
  const bad = validateBaseline({ monthly: '2026-13' }, now);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /not a valid monthly period/);

  const future = validateBaseline({ yearly: '2999' }, now);
  assert.equal(future.ok, false);
  assert.match(future.errors[0], /in the future/);

  const good = validateBaseline({ monthly: '2026-01', yearly: '2026' }, now);
  assert.equal(good.ok, true);
  assert.deepEqual(good.baseline, { monthly: '2026-01', yearly: '2026' });

  // Unset stays legal — a fresh deployment has none to declare.
  assert.deepEqual(validateBaseline({}, now), { ok: true, baseline: {} });
});

