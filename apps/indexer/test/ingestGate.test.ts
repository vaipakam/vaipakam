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
import { isDoIngestEnabled, type WorkerEnv } from '../src/env';

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
