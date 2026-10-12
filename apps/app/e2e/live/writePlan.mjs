/**
 * ONE ORDERED WRITE PLAN FOR A SIGNING DRIVE (#2422 r3).
 *
 * The write gate in `live-refinance.mjs` used to hold, per phase, a SET of
 * armed requests and allow any request matching one of them. A set has no
 * memory: a stale or regressed page repeating an identical request inside
 * an open phase — a second createOffer, a second accept — matched again and
 * was signed again. Three review rounds landed on that gate; this module is
 * the structural answer rather than a counter on the set.
 *
 * The drive declares, before its first write, the WHOLE sequence of
 * signing steps it will allow, in order, each with its complete expected
 * object (rule A, `expectedPayload.mjs`). The cursor then enforces:
 *
 *   - A request is allowed only if it matches the NEXT unconsumed step.
 *     Steps declared `optional` (an approval the app skips when the
 *     allowance already suffices, a guardrail write it skips when the caps
 *     already cover the terms) may be passed over — but only when a LATER
 *     step matches, and only optional ones: a required step can never be
 *     skipped.
 *   - A match CONSUMES the step at once (and marks any passed-over optional
 *     steps `skipped`), before the caller hands the request to the
 *     provider. A consumed step never matches again, so a duplicate is
 *     refused by construction.
 *   - Anything else — a duplicate, an out-of-order request, a role or kind
 *     the next step does not expect, a request after the plan is complete —
 *     is refused, and the plan LATCHES: every later request is refused too.
 *     A drive that saw something it did not plan for stops writing.
 *
 * A step may declare `requires: <stepId>` (#2422 r7): once it is consumed,
 * the named step stops being optional — it must be consumed before any
 * later step. That is how an approval RESET pairs with its SET: the reset
 * may be skipped, and so may the pair, but a reset followed by anything
 * other than its set (a createOffer standing on a zeroed allowance) is
 * refused.
 *
 * THE PLAN IS CLOSED UNTIL A ROLE IS ARMED (#2422 r7, moved here in r8).
 * `arm(role)` opens the plan to ONE role's requests; `close()` shuts it.
 * A request from any role while the plan is closed — or from a role other
 * than the armed one — is refused and LATCHES, like any other refusal. It
 * lives in the plan rather than beside it so that no caller can consult the
 * cursor without the arming state: a drive arms a role immediately before
 * the UI action that is meant to lead to a write (the confirmed submit), so
 * a page that asks to sign anything while it is still loading — an
 * `approve(Diamond, 0)` fired from the position page's mount, say — is
 * refused and halts the drive instead of consuming the plan's optional
 * reset step.
 *
 * A step's `expected` may be a function, evaluated at match time, for a
 * step whose payload depends on an earlier one (an accept CALL carrying
 * exactly the terms and signature just signed). Returning `null` means the
 * step cannot be judged yet, which refuses the request.
 *
 * Pure: the comparator and the clock are the only dependencies, so
 * `writePlan.test.mjs` pins the cursor without a chain or a browser.
 */
import { structMismatches } from './expectedPayload.mjs';

/**
 * @typedef {object} PlanStep
 * @property {string} id
 * @property {'borrower'|'lender'|string} role
 * @property {'tx'|'typed'} kind
 * @property {string} purpose
 * @property {boolean} [optional]
 * @property {string} [requires]   a step that becomes REQUIRED once this one is consumed
 * @property {object|(() => object|null)} expected
 */

/** @param {PlanStep[]} steps */
export function createWritePlan(steps) {
  const state = steps.map((s) => ({ ...s, status: 'pending', record: {} }));
  let cursor = 0;
  let latched = null;
  /** The one role whose requests may be judged; null = CLOSED. */
  let armed = null;
  /** Step ids made required by a consumed step's `requires`. */
  const forced = new Set();
  const isOptional = (s) => Boolean(s.optional) && !forced.has(s.id);

  const expectedOf = (s) => (typeof s.expected === 'function' ? s.expected() : s.expected);

  /**
   * Offer one signing request. Synchronous on purpose: the decision and
   * the consumption happen in one turn, before any provider call.
   *
   * @returns {{ ok: true, index: number, step: object }
   *          | { ok: false, why: string }}
   */
  function offer(role, kind, actual) {
    if (latched) return { ok: false, why: `plan already refused a request (${latched}) — no further writes` };
    if (armed === null) {
      return refuse(`the write plan is CLOSED — no role is armed, so nothing may be signed (${role} ${kind})`);
    }
    if (armed !== role) return refuse(`the ${armed} phase is armed, not the ${role} phase (${role} ${kind})`);
    if (cursor >= state.length) {
      return refuse(`the plan is complete — nothing further may be signed (${role} ${kind})`);
    }
    const reasons = [];
    for (let i = cursor; i < state.length; i++) {
      const s = state[i];
      let why = null;
      if (s.role !== role || s.kind !== kind) {
        why = `${s.id} expects ${s.role} ${s.kind}, got ${role} ${kind}`;
      } else {
        const expected = expectedOf(s);
        if (expected == null) {
          why = `${s.id} cannot be judged yet (an earlier step has not completed)`;
        } else {
          const diff = structMismatches(expected, actual);
          if (diff.length === 0) {
            for (let j = cursor; j < i; j++) state[j].status = 'skipped';
            s.status = 'consumed';
            if (s.requires) forced.add(s.requires);
            cursor = i + 1;
            return { ok: true, index: i, step: s };
          }
          why = `${s.id}: ${diff.join('; ')}`;
        }
      }
      reasons.push(why);
      if (!isOptional(s)) break; // a required (or now-required) step cannot be passed over
    }
    return refuse(`matches no next step of the plan — ${reasons.join(' | ')}`);
  }

  function refuse(why) {
    latched = why;
    return { ok: false, why };
  }

  return {
    offer,
    /** Open the plan to `role`'s requests only (closes any other role). A
     *  latched plan stays latched: arming never undoes a refusal. */
    arm(role) {
      if (typeof role !== 'string' || role === '') throw new Error(`arm(): not a role: ${JSON.stringify(role)}`);
      armed = role;
    },
    /** Close the plan: every request is refused until a role is armed. */
    close() {
      armed = null;
    },
    /** The armed role, or null while CLOSED. */
    armed: () => armed,
    /** Attach outcome data (hash, signature, provider result) to a step. */
    record(index, data) {
      Object.assign(state[index].record, data);
    },
    /** Every required step consumed. */
    complete() {
      return state.filter((s) => !isOptional(s)).every((s) => s.status === 'consumed');
    },
    /** The refusal that latched the plan, or null. */
    refusal: () => latched,
    /** A read-only view of the steps, for reports and reconciliation. */
    steps: () => state.map((s) => ({ ...s, record: { ...s.record } })),
  };
}
