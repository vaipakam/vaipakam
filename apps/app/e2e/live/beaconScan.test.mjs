import { describe, expect, it } from 'vitest';

import { BEACON_ORIGIN, isBeaconRefusalMessage, isBeaconUrl, scanBeacon } from './beaconScan.mjs';

/**
 * The sweep's privacy verdict, which is only as good as this traversal.
 *
 * The first revision read `report.passes[].console` — one level too
 * shallow — and would have returned "nothing found" on every run
 * forever, which is indistinguishable from a clean deployment. The
 * shape cases below are therefore the point of this file, not padding:
 * they pin the traversal to the report the sweep actually writes
 * (Codex #1859 r3 P2).
 */

const BEACON_JS = `${BEACON_ORIGIN}/beacon.min.js/v4513226cdae34746b4dedf0b4dfa099e1781791509496`;

/** The verbatim message the deployed site logs, captured 2026-08-21. */
const REAL_REFUSAL =
  `Refused to load the script '${BEACON_JS}' because it violates the following ` +
  `Content Security Policy directive: "script-src 'self' 'unsafe-inline' 'unsafe-eval'". ` +
  `Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback.`;

const refusalEntry = {
  level: 'error',
  text: REAL_REFUSAL,
  noise: 'csp-beacon',
};
const appError = {
  level: 'error',
  text: 'TypeError: x is not a function',
  noise: null,
};

/** A report shaped exactly like the one `live-ux-sweep.mjs` writes. */
const reportOf = (...routes) => ({
  passes: [{ name: 'basic-desktop', routes }],
});

describe('isBeaconUrl — parsed origin, never a substring', () => {
  it('accepts the beacon script', () => {
    expect(isBeaconUrl(BEACON_JS)).toBe(true);
  });

  // The reason this compares parsed origins: a lookalike host that
  // merely CONTAINS the real one must not be able to self-tag as known
  // noise, which would be a way to hide a third-party script.
  it.each([
    ['suffixed lookalike', 'https://static.cloudflareinsights.com.evil.tld/x.js'],
    ['prefixed lookalike', 'https://evil-static.cloudflareinsights.com/x.js'],
    ['same host over http', 'http://static.cloudflareinsights.com/beacon.min.js'],
    ['unparseable', 'not a url at all'],
  ])('rejects a %s', (_name, url) => {
    expect(isBeaconUrl(url)).toBe(false);
  });
});

describe('isBeaconRefusalMessage — the URL sits mid-message', () => {
  it('tags the message the deployed site actually logs', () => {
    expect(isBeaconRefusalMessage(REAL_REFUSAL)).toBe(true);
  });

  it('leaves an ordinary app error alone', () => {
    expect(isBeaconRefusalMessage('TypeError: x is not a function')).toBe(false);
  });

  it('does not tag a refusal for some other host', () => {
    expect(
      isBeaconRefusalMessage(`Refused to load the script 'https://evil.tld/x.js' because …`),
    ).toBe(false);
  });
});

describe('scanBeacon — REFUSED: console entries, no responses', () => {
  it('collects the distinct routes that logged a refusal', () => {
    const v = scanBeacon(
      reportOf(
        { route: '/', console: [refusalEntry], beacon: [] },
        { route: '/lend', console: [refusalEntry], beacon: [] },
      ),
    );
    expect(v.refusedRoutes).toEqual(['/', '/lend']);
    expect(v.permittedRequests).toEqual([]);
    expect(v.failed).toBe(true);
  });

  // Counted per ROUTE, not per occurrence: the defect belongs to the
  // deployment, so repeats within one route say nothing extra.
  it('counts a route once however many times it fired', () => {
    const v = scanBeacon(
      reportOf(
        { route: '/', console: [refusalEntry, refusalEntry], beacon: [] },
        { route: '/', console: [refusalEntry], beacon: [] },
      ),
    );
    expect(v.refusedRoutes).toEqual(['/']);
  });

  it('ignores console errors that are not the beacon', () => {
    const v = scanBeacon(reportOf({ route: '/', console: [appError], beacon: [] }));
    expect(v.failed).toBe(false);
  });
});

describe('scanBeacon — PERMITTED: the state with no console error at all', () => {
  // The r2 P1 case. If this ever returns failed:false the sweep goes
  // green while an ungated collector runs, which is the worst outcome
  // this file exists to prevent.
  it('fails on a beacon response even though nothing was logged', () => {
    const v = scanBeacon(reportOf({ route: '/', console: [], beacon: [`200 ${BEACON_JS}`] }));
    expect(v.refusedRoutes).toEqual([]);
    expect(v.permittedRequests).toEqual([`/: 200 ${BEACON_JS}`]);
    expect(v.failed).toBe(true);
  });

  it('keeps a response that arrived between routes, owned by no route', () => {
    const v = scanBeacon(reportOf({ route: '/', console: [], beacon: [] }), [
      `[main] 200 ${BEACON_JS}`,
    ]);
    expect(v.permittedRequests).toEqual([`[main] 200 ${BEACON_JS}`]);
    expect(v.failed).toBe(true);
  });

  it('reports both states when both occur', () => {
    const v = scanBeacon(
      reportOf(
        { route: '/', console: [refusalEntry], beacon: [] },
        { route: '/lend', console: [], beacon: [`200 ${BEACON_JS}`] },
      ),
    );
    expect(v.refusedRoutes).toEqual(['/']);
    expect(v.permittedRequests).toEqual([`/lend: 200 ${BEACON_JS}`]);
    expect(v.failed).toBe(true);
  });
});

describe('scanBeacon — report shapes', () => {
  // The regression that motivated the extraction: reading one level too
  // shallow. Entries parked where the broken version looked must NOT be
  // found, so a future traversal that drifts back up a level fails here
  // instead of silently passing every run.
  it('does not read pass-level console (the level that does not exist)', () => {
    const wrongShape = {
      passes: [{ console: [refusalEntry], beacon: [`200 ${BEACON_JS}`] }],
    };
    expect(scanBeacon(wrongShape).failed).toBe(false);
  });

  it('finds entries at the real nesting', () => {
    expect(scanBeacon(reportOf({ route: '/', console: [refusalEntry] })).failed).toBe(true);
  });

  // A probe-only run and a route that threw before its sink filled both
  // legitimately omit these keys. Absent must mean "nothing seen", not
  // a crash that takes the whole verdict with it.
  it.each([
    ['a route with no console or beacon key', reportOf({ route: '/x' })],
    ['a pass with null routes', { passes: [{ routes: null }] }],
    ['a report with no passes', {}],
    ['an undefined report', undefined],
  ])('treats %s as nothing seen', (_name, report) => {
    expect(scanBeacon(report).failed).toBe(false);
  });

  it('scans every pass, not only the first', () => {
    const v = scanBeacon({
      passes: [
        {
          name: 'basic-desktop',
          routes: [{ route: '/', console: [], beacon: [] }],
        },
        {
          name: 'advanced-desktop',
          routes: [{ route: '/desk', console: [refusalEntry] }],
        },
      ],
    });
    expect(v.refusedRoutes).toEqual(['/desk']);
  });
});
