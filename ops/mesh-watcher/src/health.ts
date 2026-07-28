/**
 * ROOT-CAUSE FIX #5 — health as a list of preconditions.
 *
 * `ok` began as `critical === 0` and grew a conjunct per review round
 * (#1443 r4, r5, r6, r7): a configured destination, then zero delivery
 * failures, then a probe that did not fail, then zero coverage gaps, then
 * no storage degradation. Each round found a state the Worker could be in
 * that the expression did not yet know about, and each fix was another
 * `&&` someone had to remember to add — plus a matching edit to the HTTP
 * status, which was keyed on `error` and diverged from `ok` for two
 * rounds.
 *
 * Enumerating the preconditions instead makes adding one a list entry
 * rather than an edit to an expression, and — more usefully — makes the
 * Worker able to SAY which precondition failed. "Unhealthy" without a
 * reason is barely better than no signal at all.
 */

export interface HealthInput {
  criticalFindings: number;
  deliveryConfigured: boolean;
  deliveryFailures: number;
  /** `null` when delivery was never exercised this tick. */
  deliveryVerified: boolean | null;
  coverageGaps: number;
  stateDegraded: boolean;
}

export interface Health {
  ok: boolean;
  /** Human-readable reasons, empty when healthy. */
  failing: string[];
}

/**
 * Every condition that must hold for a tick to count as healthy.
 *
 * Add new health inputs HERE, not to a boolean expression at the call
 * site — that is the mistake this replaces.
 */
const PRECONDITIONS: readonly {
  name: string;
  holds: (i: HealthInput) => boolean;
  why: (i: HealthInput) => string;
}[] = [
  {
    name: 'ledger-clean',
    holds: (i) => i.criticalFindings === 0,
    why: (i) => `${i.criticalFindings} critical ledger finding(s)`,
  },
  {
    name: 'pager-configured',
    holds: (i) => i.deliveryConfigured,
    why: () => 'no alert destination configured — findings reach no one',
  },
  {
    name: 'pager-delivering',
    holds: (i) => i.deliveryFailures === 0,
    why: (i) => `${i.deliveryFailures} alert(s) rejected by the delivery channel`,
  },
  {
    name: 'pager-verified',
    holds: (i) => i.deliveryVerified !== false,
    why: () => 'the delivery probe failed — the pager cannot deliver',
  },
  {
    name: 'mesh-covered',
    holds: (i) => i.coverageGaps === 0,
    why: (i) => `${i.coverageGaps} chain(s) not observed this tick`,
  },
  {
    name: 'state-intact',
    holds: (i) => !i.stateDegraded,
    why: () =>
      'alert-state storage degraded — windowed detectors cannot accumulate',
  },
];

export function assessHealth(input: HealthInput): Health {
  const failing = PRECONDITIONS.filter((p) => !p.holds(input)).map((p) =>
    `${p.name}: ${p.why(input)}`,
  );
  return { ok: failing.length === 0, failing };
}

/**
 * HTTP status for a tick summary.
 *
 * Derived from health rather than restated, because keying the status on
 * `error` alone let `curl --fail` certify a run whose pager probe had
 * just failed (#1443 r5).
 */
export function statusFor(health: Health, hadInternalError: boolean): number {
  if (hadInternalError) return 500;
  return health.ok ? 200 : 503;
}
