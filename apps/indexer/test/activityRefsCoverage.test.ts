/**
 * Activity-refs coverage — the BEHAVIORAL half of the #1794 guardrail.
 *
 * `activity_events` denormalizes `loan_id` / `offer_id` so the audit feed can
 * be filtered by loan or offer. An event whose reference `pluckActivityRefs`
 * does not map is stored with NULL references: the row exists, nothing looks
 * broken, and `/activity?loanId=N` + `LoanTimeline` silently cannot find it.
 * Codex found `LoanStatusChanged` missing this way on #1792 — the 46th such
 * omission.
 *
 * HOW this is enforced (round-69 redesign): the reference-carrying surface is
 * derived from the compiled ABI bundle by the shared
 * `scripts/lib/activity-refs-surface.mjs` (the same derivation the
 * data-integrity checker uses), and then the REAL `pluckActivityRefs` is
 * EXECUTED for every event with a synthesized decoded-args bag. A pair is
 * "mapped" exactly when the executed mapper returns one of the values planted
 * on that field's ABI alias inputs.
 *
 * This replaced ~5,000 lines of TypeScript-AST inference that tried to prove
 * the same properties statically. That approach could not converge under
 * review: for any finite catalogue of recognized syntax shapes there is
 * another JavaScript construct that defeats it (getters with side effects,
 * aliased hosts, spread laundering, …), and 40+ rounds kept finding them one
 * shape at a time. Execution answers by observation — whatever exotic shape a
 * mapping takes, it either produces the planted id or it does not.
 *
 * The synthesized values are deliberately unique per input path, so this also
 * catches by construction:
 *   - a mapping that reads an argument the event no longer has (NaN ≠ planted)
 *   - a mapping wired to the wrong column (loanId planted ≠ offerId planted)
 *   - a mapping that returns a constant (constant ≠ planted)
 */
import { describe, expect, it } from 'vitest';
import { pluckActivityRefs } from '../src/chainIndexer';
import {
  DELIBERATELY_NOT_SCOPED,
  REF_FIELDS,
  deriveActivityRefsSurface,
} from '../scripts/lib/activity-refs-surface.mjs';

const surface = deriveActivityRefsSurface();
const { carries, aliasNames, argShapes, arrayOnlyRefs, abiConflicts } = surface;

/** Unique numeric id per (event, path) — starts high enough that no real
 *  constant in the mapper (0, 1, …) can collide with a planted value. */
const plantedId = (() => {
  let next = 100_000;
  const byKey = new Map<string, bigint>();
  return (event: string, path: string) => {
    const key = `${event} ${path}`;
    let v = byKey.get(key);
    if (v === undefined) {
      v = BigInt((next += 7));
      byKey.set(key, v);
    }
    return v;
  };
})();

/** A decoded-args bag for `event`, every ABI leaf populated by type. Numeric
 *  scalars get the planted unique id; everything else gets an inert value of
 *  the right JS shape (what viem would hand the mapper). */
function synthesizeArgs(event: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const { path, type } of argShapes.get(event) ?? []) {
    if (type === 'tuple') continue; // parents materialize via their leaves
    const segs = path.split('.');
    let host = args;
    for (const s of segs.slice(0, -1)) {
      host = (host[s] ??= {}) as Record<string, unknown>;
    }
    host[segs[segs.length - 1]] = valueFor(event, path, type);
  }
  return args;
}

function valueFor(event: string, path: string, type: string): unknown {
  if (/^u?int(\d+)?$/.test(type)) return plantedId(event, path);
  if (/\]$/.test(type)) return []; // any array — inert
  if (type === 'address') return '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
  if (type === 'bool') return false;
  if (type === 'string') return 'synthetic';
  if (/^bytes\d*$/.test(type)) return `0x${'00'.repeat(32)}`;
  return `0x${'00'.repeat(32)}`;
}

/** The planted values that count as "mapped" for this event+field. */
function expectedIds(event: string, field: string): number[] {
  const paths = aliasNames.get(event)?.get(field);
  if (!paths) return [];
  return [...paths].map((p) => Number(plantedId(event, p)));
}

describe('activity-refs coverage — executed against the real mapper', () => {
  it('derives a non-vacuous reference surface from the compiled ABI bundle', () => {
    expect(carries.size).toBeGreaterThan(0);
  });

  it('has no ABI problems the derivation cannot reason around', () => {
    // The one tolerated shape: an overload on an event that carries no
    // reference (the live ABI has `StuckERC20Recovered`, an ops recovery
    // event mapped nowhere). Everything else is a real problem.
    const relevant = abiConflicts.filter(
      (c) => c.kind !== 'overload' || carries.has(c.event),
    );
    expect(relevant.map((c) => c.message)).toEqual([]);
  });

  it('maps or deliberately allowlists every reference-bearing event/field pair', () => {
    const gaps: string[] = [];
    const staleNowMapped: string[] = [];
    for (const [event, fields] of [...carries].sort((a, b) => a[0].localeCompare(b[0]))) {
      const refs = pluckActivityRefs(event, synthesizeArgs(event));
      for (const field of fields) {
        const got = (refs as Record<string, unknown>)[field];
        const planted = expectedIds(event, field);
        const isMapped = typeof got === 'number' && planted.includes(got);
        const allowKey = `${event}.${field}`;
        // `Object.hasOwn`, not truthiness (Codex round-10 P2): an event named
        // like a prototype member must not read as allowlisted.
        const isAllowlisted = Object.hasOwn(DELIBERATELY_NOT_SCOPED, allowKey);
        if (isMapped && isAllowlisted) {
          staleNowMapped.push(`${allowKey} — now mapped in pluckActivityRefs; remove this entry`);
          continue;
        }
        if (isMapped || isAllowlisted) continue;
        if (typeof got === 'number' && !Number.isNaN(got)) {
          gaps.push(
            `${allowKey} — the mapper returned ${got}, which is NOT one of the values planted ` +
              `on this event's ${field} inputs (${planted.join(', ')}); it reads a constant or ` +
              'the wrong argument',
          );
        } else if (got !== null) {
          gaps.push(
            `${allowKey} — the mapper returned ${String(got)} (not a usable id); ` +
              'it likely reads an argument the event does not carry',
          );
        } else {
          const arrayPath = arrayOnlyRefs.get(allowKey);
          gaps.push(
            arrayPath
              ? `${allowKey} — its only ${field} is \`${arrayPath}\`, an ARRAY of ids; one activity ` +
                  'row carries one id, so which element it should be is a decision, not a lookup. ' +
                  `Allowlist '${allowKey}' with a reason saying which, or reshape the event.`
              : `${allowKey} — stores NULL, so /activity?${field}=N and the timeline cannot find the row. ` +
                  'Add a case to pluckActivityRefs(), or allowlist with a reason in ' +
                  'scripts/lib/activity-refs-surface.mjs.',
          );
        }
      }
    }
    expect(gaps).toEqual([]);
    expect(staleNowMapped).toEqual([]);
  });

  it('has no allowlist entries for pairs the ABI no longer carries', () => {
    const dead: string[] = [];
    for (const key of Object.keys(DELIBERATELY_NOT_SCOPED)) {
      const [event, field] = key.split('.');
      const has = carries.get(event);
      if (!has) {
        dead.push(`${key} — no compiled event carries a loanId/offerId under this name`);
      } else if (!has.has(field)) {
        dead.push(`${key} — the event no longer carries ${field}; remove this entry`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('returns a lowercase address or null for actor, for every event in the surface', () => {
    const bad: string[] = [];
    for (const event of carries.keys()) {
      const { actor } = pluckActivityRefs(event, synthesizeArgs(event));
      const ok =
        actor === null || (typeof actor === 'string' && actor === actor.toLowerCase());
      if (!ok) bad.push(`${event} — actor was ${String(actor)}`);
    }
    expect(bad).toEqual([]);
  });

  it('never invents references for an unmapped event (the default branch stays all-null)', () => {
    expect(pluckActivityRefs('SomeEventNobodyMapped', { loanId: 42n })).toEqual({
      actor: null,
      loanId: null,
      offerId: null,
    });
  });

  it.each(REF_FIELDS.map((f) => [f]))(
    'the surface knows at least one %s-carrying event (anti-vacuity per field)',
    (field) => {
      const count = [...carries.values()].filter((s) => s.has(field)).length;
      expect(count).toBeGreaterThan(0);
    },
  );
});
