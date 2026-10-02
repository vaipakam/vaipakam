import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  expectedPostureFrom,
  postureCopyFrom,
  refinancePostureCoverage,
  refinancePostureVerdict,
} from './refinancePosture.mjs';
import { autoRefinancePostureFrom } from '../../src/data/autoRefinancePosture.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(
  fs.readFileSync(path.join(HERE, '../../src/i18n/locales/en.json'), 'utf8'),
);
const COPY = postureCopyFrom(EN);

const ON = { paused: false, autoRefinance: true, partialFill: true };
const OFF = { paused: false, autoRefinance: false, partialFill: true };
const PAUSED = { paused: true, autoRefinance: true, partialFill: true };

/** A clean `on` observation; each case overrides one fact. */
const obs = (over = {}) => ({
  applicable: true,
  before: ON,
  after: ON,
  formPresent: true,
  bannerCount: 1,
  attr: 'on',
  text: COPY.on,
  pageText: `Refinance this loan … ${COPY.on} … Review`,
  error: null,
  interval: { scanned: true, changes: 0 },
  ...over,
});

describe('expectedPostureFrom mirrors the app mapping for every KNOWN read', () => {
  // The drive's expectation must never disagree with what the app is
  // written to show — checked against the app's own function, not a copy
  // of its truth table.
  for (const paused of [false, true]) {
    for (const autoRefinance of [false, true]) {
      for (const partialFill of [false, true]) {
        const sw = { paused, autoRefinance, partialFill };
        it(JSON.stringify(sw), () => {
          expect(expectedPostureFrom(sw)).toBe(
            autoRefinancePostureFrom({ data: sw, isError: false, isPaused: false }),
          );
        });
      }
    }
  }

  it('establishes no expectation from a missing or malformed read', () => {
    expect(expectedPostureFrom(null)).toBeNull();
    expect(expectedPostureFrom(undefined)).toBeNull();
    expect(expectedPostureFrom({ paused: false, autoRefinance: true })).toBeNull();
    expect(expectedPostureFrom({ paused: 'false', autoRefinance: true, partialFill: true })).toBeNull();
  });
});

describe('postureCopyFrom', () => {
  it('reads all four sentences from the English catalogue', () => {
    for (const k of ['on', 'off', 'paused', 'unknown']) {
      expect(typeof COPY[k]).toBe('string');
      expect(COPY[k].length).toBeGreaterThan(20);
    }
    expect(new Set(Object.values(COPY)).size).toBe(4);
  });

  it('throws by name when a key is missing, so the drive can classify it', () => {
    expect(() => postureCopyFrom({ copy: { refinance: { ...EN.copy.refinance, autoMatchOff: '' } } })).toThrow(
      /copy\.refinance\.autoMatchOff/,
    );
  });
});

describe('refinancePostureVerdict', () => {
  it('does not judge a visit the form was never expected on', () => {
    expect(refinancePostureVerdict(obs({ applicable: false }), COPY)).toBeNull();
    expect(refinancePostureVerdict(null, COPY)).toBeNull();
  });

  it('passes the matching posture in the expected words', () => {
    expect(refinancePostureVerdict(obs(), COPY).verdict).toBe('pass');
    expect(
      refinancePostureVerdict(
        obs({ before: OFF, after: OFF, attr: 'off', text: COPY.off, pageText: COPY.off }),
        COPY,
      ).verdict,
    ).toBe('pass');
    expect(
      refinancePostureVerdict(
        obs({ before: PAUSED, after: PAUSED, attr: 'paused', text: COPY.paused, pageText: COPY.paused }),
        COPY,
      ).verdict,
    ).toBe('pass');
  });

  it('tolerates whitespace differences between the DOM text and the catalogue', () => {
    expect(refinancePostureVerdict(obs({ text: `  ${COPY.on.replace(/ /g, '\n ')} ` }), COPY).verdict).toBe(
      'pass',
    );
  });

  it('blocks when the chain could not be read on either side', () => {
    expect(refinancePostureVerdict(obs({ before: null }), COPY).verdict).toBe('blocked');
    expect(refinancePostureVerdict(obs({ after: null }), COPY).verdict).toBe('blocked');
  });

  it('blocks — never fails — when the posture moved during the observation', () => {
    // The page could rightly show either side of the flip.
    const v = refinancePostureVerdict(obs({ after: OFF, attr: 'off', text: COPY.off, pageText: COPY.off }), COPY);
    expect(v.verdict).toBe('blocked');
    expect(v.why).toMatch(/on → off/);
  });

  it('blocks when the form itself did not render', () => {
    expect(refinancePostureVerdict(obs({ formPresent: false, bannerCount: 0 }), COPY).verdict).toBe(
      'blocked',
    );
  });

  it('blocks when the banner is still honestly unknown at the deadline', () => {
    expect(
      refinancePostureVerdict(obs({ attr: 'unknown', text: COPY.unknown, pageText: COPY.unknown }), COPY)
        .verdict,
    ).toBe('blocked');
  });

  it('blocks when the scrape threw', () => {
    expect(refinancePostureVerdict(obs({ error: 'Target closed' }), COPY).verdict).toBe('blocked');
  });

  it('fails a rendered form with no banner — silence implies an availability not read', () => {
    const v = refinancePostureVerdict(obs({ bannerCount: 0, attr: null, text: null }), COPY);
    expect(v).toMatchObject({ verdict: 'fail', failKind: 'observed' });
  });

  it('fails two banners in one form', () => {
    expect(refinancePostureVerdict(obs({ bannerCount: 2 }), COPY)).toMatchObject({
      verdict: 'fail',
      failKind: 'observed',
    });
  });

  // ROOT DECISION (#2368 r5): a self-consistent banner that disagrees with
  // the drive's own chain reads cannot be attributed from outside the page
  // (lagging page provider, unsampled endpoint, flip-and-restore), so it is
  // BLOCKED — loud, never a pass, never an accusation.
  it('blocks — never fails, never passes — a stable chain disagreement, naming both postures', () => {
    for (const [attr, text] of [
      ['off', COPY.off],
      ['paused', COPY.paused],
    ]) {
      const v = refinancePostureVerdict(obs({ attr, text, pageText: text }), COPY);
      expect(v).toMatchObject({ verdict: 'blocked', expected: 'on', observed: attr });
      expect(v.why).toMatch(new RegExp(`stated "${attr}".*read "on"`));
    }
  });

  // #2368 r6 — an on → off → on excursion leaves both endpoint reads "on".
  it('blocks a MATCHING banner when a switch changed between the two reads', () => {
    const v = refinancePostureVerdict(obs({ interval: { scanned: true, changes: 2 } }), COPY);
    expect(v.verdict).toBe('blocked');
    expect(v.why).toMatch(/differed at 2 block/);
  });

  it('blocks a matching banner when interval stability could not be scanned', () => {
    for (const interval of [{ scanned: false }, null, undefined]) {
      expect(refinancePostureVerdict(obs({ interval }), COPY).verdict).toBe('blocked');
    }
  });

  it('still passes a matching banner', () => {
    expect(refinancePostureVerdict(obs(), COPY).verdict).toBe('pass');
  });

  it('fails an unrecognised posture attribute', () => {
    expect(refinancePostureVerdict(obs({ attr: 'maybe' }), COPY)).toMatchObject({
      verdict: 'fail',
      failKind: 'observed',
    });
  });

  it('fails the right attribute carrying the wrong sentence', () => {
    // e.g. a copy-table swap: data says on, words say off.
    expect(refinancePostureVerdict(obs({ text: COPY.off }), COPY)).toMatchObject({
      verdict: 'fail',
      failKind: 'observed',
    });
  });

  it('fails when another posture sentence is ALSO on the page', () => {
    const v = refinancePostureVerdict(obs({ pageText: `${COPY.on} … ${COPY.paused}` }), COPY);
    // A second posture sentence is a self-inconsistency of the page, judged
    // without the chain (#2368 r1), so it is an OBSERVED defect.
    expect(v).toMatchObject({ verdict: 'fail', failKind: 'observed' });
    expect(v.why).toMatch(/paused/);
  });

  // #2368 r3 — a mounted-but-invisible banner discloses nothing.
  it('fails a banner that is mounted but not visible, naming it as hidden', () => {
    const v = refinancePostureVerdict(obs({ bannerCount: 0, hiddenBannerCount: 1 }), COPY);
    expect(v).toMatchObject({ verdict: 'fail', failKind: 'observed' });
    expect(v.why).toMatch(/NOT VISIBLE/);
  });

  // #2368 r1 — chain-independent defects must not hide behind a chain blocker.
  it('fails a missing or doubled banner even when the chain could not be read', () => {
    for (const chain of [{ before: null }, { after: null }, { after: OFF }]) {
      expect(refinancePostureVerdict(obs({ ...chain, bannerCount: 0 }), COPY)).toMatchObject({
        verdict: 'fail',
        failKind: 'observed',
      });
      expect(refinancePostureVerdict(obs({ ...chain, bannerCount: 2 }), COPY)).toMatchObject({
        verdict: 'fail',
        failKind: 'observed',
      });
    }
  });

  it('fails a banner whose sentence does not match its own published posture, whatever the chain', () => {
    for (const chain of [{}, { before: null }, { after: OFF }]) {
      const v = refinancePostureVerdict(obs({ ...chain, attr: 'on', text: COPY.off, pageText: COPY.off }), COPY);
      expect(v).toMatchObject({ verdict: 'fail', failKind: 'observed' });
    }
  });

  it('fails an "unknown" banner that carries another posture\'s sentence instead of blocking', () => {
    for (const other of ['on', 'off', 'paused']) {
      const v = refinancePostureVerdict(
        obs({ attr: 'unknown', text: COPY[other], pageText: COPY[other] }),
        COPY,
      );
      expect(v).toMatchObject({ verdict: 'fail', failKind: 'observed' });
    }
  });
});

describe('refinancePostureCoverage', () => {
  const pass = { path: '/positions/1', refinancePostureVerdict: { verdict: 'pass', why: 'ok' } };
  const blocked = { path: '/positions/2', refinancePostureVerdict: { verdict: 'blocked', why: 'slow' } };
  const fail = { path: '/positions/3', refinancePostureVerdict: { verdict: 'fail', why: 'bad' } };
  const unjudged = { path: '/positions/4', refinancePostureVerdict: null };

  it('is silent when the assertion was not requested', () => {
    expect(refinancePostureCoverage([unjudged], false)).toBeNull();
  });

  it('names an assertion that never ran — an unrun check is not a clean run', () => {
    expect(refinancePostureCoverage([{ path: '/positions' }, unjudged], true)).toMatch(/never ran/);
  });

  it('names every blocked visit, even beside a pass', () => {
    const gap = refinancePostureCoverage([pass, blocked], true);
    expect(gap).toMatch(/1 of 2/);
    expect(gap).toMatch(/\/positions\/2 \(slow\)/);
  });

  it('leaves a fail to the visit verdict rather than calling it a gap', () => {
    expect(refinancePostureCoverage([pass, fail], true)).toBeNull();
    expect(refinancePostureCoverage([pass, unjudged], true)).toBeNull();
  });
});
