/**
 * The #757 ingest rollout gate (#2202).
 *
 * The gate is TWO halves — the `CHAIN_INGEST_VIA_DO` flag and the
 * `CHAIN_INGEST_DO` binding — and the bug it exists to prevent is any
 * consumer deciding on one of them. That happened because the resolved env
 * carried only the flag, so three route modules could see nothing else:
 * `/loans/stats` and `/offers/stats` published the DO scan cadence, and the
 * recycling route sized its staleness floor from it, on a deployment whose
 * cron was running the legacy inline path.
 *
 * No existing test caught it, and that is structural rather than an
 * oversight: every fixture sets both halves together, or (in the stats
 * tests) casts an `Env` into being without either. The half-enabled
 * configuration is a shape the suite had no reason to construct — which is
 * exactly why it needs constructing on purpose.
 */
import { describe, expect, it } from 'vitest';
import { earlyRouteEnv, isDoIngestEnabled, type WorkerEnv } from '../src/env';

/** A namespace stands in for the binding; the gate only tests presence. */
const BINDING = {} as NonNullable<WorkerEnv['CHAIN_INGEST_DO']>;

const raw = (flag?: string, bound = false): WorkerEnv =>
  ({
    ...(flag === undefined ? {} : { CHAIN_INGEST_VIA_DO: flag }),
    ...(bound ? { CHAIN_INGEST_DO: BINDING } : {}),
  }) as unknown as WorkerEnv;

describe('isDoIngestEnabled — both halves, or it is off', () => {
  it('is ON only when the flag is set AND the binding is present', () => {
    expect(isDoIngestEnabled(raw('true', true))).toBe(true);
  });

  it('is OFF when the flag is set but the DO is not bound', () => {
    // THE CASE THIS FILE EXISTS FOR. A supported configuration — the binding
    // is optional — and the one every other fixture skips. Reading the flag
    // alone answers `true` here while the cron runs the legacy path, so a
    // consumer that believed it would publish the wrong cadence.
    expect(isDoIngestEnabled(raw('true', false))).toBe(false);
  });

  it('is OFF when the DO is bound but the flag has not been flipped', () => {
    // The other asymmetry, and the reason the gate has two halves at all:
    // deploying the DO must never re-route live ingest by itself.
    expect(isDoIngestEnabled(raw(undefined, true))).toBe(false);
    expect(isDoIngestEnabled(raw('false', true))).toBe(false);
  });

  it('is OFF for a flag that merely looks truthy', () => {
    // The flag is a string var, so anything can arrive in it. Only the exact
    // literal counts — an operator typing `1` or `yes` has not enabled the
    // path, and must not be told they have.
    for (const v of ['1', 'yes', 'TRUE', 'True', ' true', '']) {
      expect(isDoIngestEnabled(raw(v, true))).toBe(false);
    }
  });

  it('is OFF for an env carrying neither half', () => {
    expect(isDoIngestEnabled(raw(undefined, false))).toBe(false);
  });
});

describe('earlyRouteEnv — the one route that skips resolveEnv', () => {
  // `/metrics/recycling` bypasses `resolveEnv` for latency. It used to get a
  // bare `raw as unknown as Env`, which type-checks and yields
  // `doIngestEnabled: undefined` — falsy, so the route always read "legacy",
  // a WORSE answer than the half-gate it replaced. These cases exist because
  // that is precisely what happened the moment the gate became a resolved
  // field, and a double cast gives the typechecker no way to object.

  it('carries the resolved gate, not undefined', () => {
    expect(earlyRouteEnv(raw('true', true)).doIngestEnabled).toBe(true);
  });

  it('resolves it with BOTH halves, exactly as resolveEnv would', () => {
    // The half-enabled shape again — the bypass must not be a second place
    // where the flag alone decides.
    expect(earlyRouteEnv(raw('true', false)).doIngestEnabled).toBe(false);
    expect(earlyRouteEnv(raw(undefined, true)).doIngestEnabled).toBe(false);
  });

  it('is never undefined, whatever the raw env looks like', () => {
    // The specific regression: falsy-by-absence is indistinguishable from a
    // decided `false` at the call site, so assert the field is actually
    // present and boolean rather than merely not truthy.
    for (const e of [raw('true', true), raw('true', false), raw(undefined, false)]) {
      expect(typeof earlyRouteEnv(e).doIngestEnabled).toBe('boolean');
    }
  });

  it('passes the rest of the env through, so the route still has its D1', () => {
    const db = {} as unknown as WorkerEnv['DB'];
    expect(earlyRouteEnv({ ...raw('true', true), DB: db } as WorkerEnv).DB).toBe(db);
  });
});
