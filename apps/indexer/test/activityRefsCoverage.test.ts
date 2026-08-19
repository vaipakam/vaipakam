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
  INTENDED_REFERENCE_ALIAS,
  REF_FIELDS,
} from '../scripts/lib/activity-refs-surface.mjs';
import { expectedIds, layoutsOf, plantedId, surface, synthesizeArgs } from './helpers/activityRefsSynth';

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
      // EVERY layout, not just the last-parsed one (Codex round-71 P2): a
      // mapping that reads a field unique to one overload only misbehaves
      // when THAT layout's bag is handed in, so each distinct signature is
      // synthesized and executed.
      const layouts = layoutsOf(event);
      expect(layouts.length).toBeGreaterThan(1);
      for (const layout of layouts) {
        expect(
          pluckActivityRefs(event, synthesizeArgs(event, layout)),
          `${event} is overloaded — mapping it under one layout misreads the other`,
        ).toEqual({ actor: null, loanId: null, offerId: null });
      }
    }
    expect(eventInputs.size).toBeGreaterThan(0);
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
        if (isMapped) {
          // A mapped pair with MORE THAN ONE candidate alias must read the
          // alias the recorded policy names (Codex round-72 P2): any-alias
          // acceptance let OfferMatched silently switch from the lender to
          // the borrower offer id while staying green.
          const aliasPaths = [...(surface.aliasNames.get(event)?.get(field) ?? [])];
          if (aliasPaths.length > 1) {
            if (!Object.hasOwn(INTENDED_REFERENCE_ALIAS, allowKey)) {
              gaps.push(
                `${allowKey} — mapped from one of ${aliasPaths.join(', ')}, but no intended ` +
                  'alias is recorded; add an INTENDED_REFERENCE_ALIAS entry with the policy',
              );
            } else {
              const intended = INTENDED_REFERENCE_ALIAS[allowKey];
              const intendedId = Number(plantedId(event, intended));
              if (got !== intendedId) {
                gaps.push(
                  `${allowKey} — the policy is to index \`${intended}\` (${intendedId}), but the ` +
                    `mapper returned ${got}, another of the event's aliases`,
                );
              }
            }
          }
          continue;
        }
        if (isAllowlisted) continue;
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

  it('has no stale intended-alias entries', () => {
    // Each entry must still describe a live, mapped, multi-alias pair whose
    // named alias exists — anything less re-opens the ambiguity it documents.
    const stale: string[] = [];
    for (const [key, intended] of Object.entries(INTENDED_REFERENCE_ALIAS)) {
      const [event, field] = key.split('.');
      const aliasPaths = surface.aliasNames.get(event)?.get(field);
      if (!aliasPaths || aliasPaths.size < 2) {
        stale.push(`${key} — the pair is no longer multi-alias; remove this entry`);
        continue;
      }
      if (!aliasPaths.has(intended)) {
        stale.push(`${key} — \`${intended}\` is not among the event's ${field} aliases`);
        continue;
      }
      const got = (pluckActivityRefs(event, synthesizeArgs(event)) as Record<string, unknown>)[
        field
      ];
      if (got === null) {
        stale.push(`${key} — the pair is no longer mapped; remove this entry`);
      }
    }
    expect(stale).toEqual([]);
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

  it('never mutates the decoded arguments, for ANY compiled event', () => {
    // The mapper must not MUTATE the decoded arguments (Codex round-70 P2):
    // `recordActivityEvents` serializes `args_json` only after calling it,
    // so a side effect here corrupts the persisted bag while every returned
    // reference still checks out. Over EVERY compiled event and layout, not
    // only the reference-carrying ones (Codex round-71 P2) — the actor-only
    // mappings (Transfer, vault deposits, reward events) run the same code
    // path and their bags persist the same way. structuredClone carries
    // bigints.
    const bad: string[] = [];
    for (const event of surface.argShapes.keys()) {
      for (const layout of layoutsOf(event)) {
        const args = synthesizeArgs(event, layout);
        const before = structuredClone(args);
        pluckActivityRefs(event, args);
        try {
          expect(args).toEqual(before);
        } catch {
          bad.push(`${event} — the mapper mutated the decoded arguments`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('returns a lowercase 0x-address or null for actor, for ANY compiled event', () => {
    // The full address SHAPE, not just lowercase-ness (Codex round-71 P2): a
    // mapping that lowercases a non-address argument — or returns a constant
    // like 'not-an-address' — persists an actor no wallet filter can ever
    // match, so the row disappears from actor-scoped activity.
    const bad: string[] = [];
    for (const event of surface.argShapes.keys()) {
      for (const layout of layoutsOf(event)) {
        const { actor } = pluckActivityRefs(event, synthesizeArgs(event, layout));
        const ok = actor === null || /^0x[0-9a-f]{40}$/.test(actor as string);
        if (!ok) bad.push(`${event} — actor was ${String(actor)}`);
      }
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
