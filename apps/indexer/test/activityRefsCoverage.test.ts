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
} from '../scripts/lib/activity-refs-surface.mjs';
import { expectedIds, surface, synthesizeArgs } from './helpers/activityRefsSynth';

const { carries, arrayOnlyRefs, abiConflicts, eventInputs } = surface;

describe('activity-refs coverage — executed against the real mapper', () => {
  it('derives a non-vacuous reference surface from the compiled ABI bundle', () => {
    expect(carries.size).toBeGreaterThan(0);
  });

  it('has no ABI problems the derivation cannot reason around', () => {
    // The one tolerated shape: an overload on an event that carries no
    // reference (the live ABI has `StuckERC20Recovered`, an ops recovery
    // event mapped nowhere). Tolerated only while it stays UNMAPPED — the
    // test below executes exactly that. Everything else is a real problem.
    const relevant = abiConflicts.filter(
      (c) => c.kind !== 'overload' || carries.has(c.event),
    );
    expect(relevant.map((c) => c.message)).toEqual([]);
  });

  it('keeps every tolerated overloaded event completely unmapped', () => {
    // A name-keyed mapper cannot be correct for two argument layouts at once
    // (Codex round-70 P2): an overload outside the reference surface is
    // tolerated by the filter above only because nothing maps it — a case
    // reading a field present in one layout would silently misread logs
    // emitted under the other. EXECUTE the mapper for each such event and
    // require the default branch: all three references null.
    const overloadedOutsideSurface = [
      ...new Set(
        abiConflicts
          .filter((c) => c.kind === 'overload' && !carries.has(c.event))
          .map((c) => c.event),
      ),
    ];
    // The live ABI has exactly one; if that changes this list grows and each
    // entry is still executed. Guard against the check going vacuous the day
    // the overload is cleaned up: skip silently only when there are none.
    for (const event of overloadedOutsideSurface) {
      expect(
        pluckActivityRefs(event, synthesizeArgs(event)),
        `${event} is overloaded — mapping it under one layout misreads the other`,
      ).toEqual({ actor: null, loanId: null, offerId: null });
    }
    // eventInputs holds the LAST-parsed signature per name; nothing further
    // to assert here — the conflict record itself is what flags the shape.
    expect(eventInputs.size).toBeGreaterThan(0);
  });

  it('maps or deliberately allowlists every reference-bearing event/field pair', () => {
    const gaps: string[] = [];
    const staleNowMapped: string[] = [];
    for (const [event, fields] of [...carries].sort((a, b) => a[0].localeCompare(b[0]))) {
      const args = synthesizeArgs(event);
      // The mapper must not MUTATE the decoded arguments (Codex round-70 P2):
      // `recordActivityEvents` serializes `args_json` only after calling it,
      // so a side effect here corrupts the persisted bag while every returned
      // reference still checks out. structuredClone carries bigints.
      const before = structuredClone(args);
      const refs = pluckActivityRefs(event, args);
      expect(args, `${event} — the mapper mutated the decoded arguments`).toEqual(before);
      for (const field of fields) {
        const got = (refs as Record<string, unknown>)[field];
        const planted = expectedIds(event, field);
        const isMapped = typeof got === 'number' && planted.includes(got);
        const allowKey = `${event}.${field}`;
        // `Object.hasOwn`, not truthiness (Codex round-10 P2): an event named
        // like a prototype member must not read as allowlisted.
        const isAllowlisted = Object.hasOwn(DELIBERATELY_NOT_SCOPED, allowKey);
        // A MALFORMED non-null result fails REGARDLESS of the allowlist
        // (Codex round-70 P2): an allowlist entry exempts the intentionally
        // unscoped null, never a wrong value — otherwise an implementation
        // slice that lands a broken mapping before removing the TODO entry
        // persists corrupt references behind a green run.
        if (got !== null && !isMapped) {
          gaps.push(
            typeof got === 'number' && !Number.isNaN(got)
              ? `${allowKey} — the mapper returned ${got}, which is NOT one of the values planted ` +
                  `on this event's ${field} inputs (${planted.join(', ')}); it reads a constant or ` +
                  'the wrong argument'
              : `${allowKey} — the mapper returned ${String(got)} (not a usable id); ` +
                  'it likely reads an argument the event does not carry',
          );
          continue;
        }
        if (isMapped && isAllowlisted) {
          staleNowMapped.push(`${allowKey} — now mapped in pluckActivityRefs; remove this entry`);
          continue;
        }
        if (isMapped || isAllowlisted) continue;
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
