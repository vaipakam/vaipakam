/**
 * #1794 — which loan and offer an activity row concerns, read from the
 * event's own ABI by ONE rule rather than written out per event.
 *
 * `activity_events.loan_id` / `offer_id` make the ledger filterable by loan
 * and by offer. They used to be filled by a hand-written `case` per event in
 * `pluckActivityRefs`, and an event with no case was stored with both NULL:
 * the insert succeeded, the row existed, and `/activity?loanId=N` could not
 * find it. Forty-odd events sat in that state, each a separate omission, and
 * every new event with a `loanId` was one more chance to forget. The
 * guardrail (#1797) made the gaps visible; this module removes the reason
 * they existed. The reference is already in the ABI, so it is read from the
 * ABI, by the same shape rule the guardrail uses to decide that an event
 * carries one.
 *
 * WHAT THE COLUMNS MEAN. `loan_id` says which loan an event concerns. It is
 * not a display decision: whether a loan screen shows a given kind is the
 * consumer's call, made on `kind`. So every event that names a loan is filed
 * under it, bookkeeping ones included (a fee billed against a loan concerns
 * that loan). The only exemptions are companion payloads, whose primary event
 * in the same transaction already carries the reference.
 *
 * THE RULE, per event and per column:
 *   1. A pair listed under `notScoped` in the policy stays NULL.
 *   2. The candidates are the event's inputs whose name has the column's
 *      shape (`loanId`, `oldLoanId`, `loanIdA`, `fields.newLoanId`, …; the
 *      `refShape` patterns) and whose type is a scalar integer. An array of
 *      ids (`loanIds`) is never a candidate: one row carries one id.
 *   3. One candidate: it. Several: the input the policy's `intendedAlias`
 *      names, with its reason, or NULL when none is recorded (the guardrail
 *      fails such a pair, so NULL here is never silent for long).
 *   4. The value 0 reads as NULL: ids start at 1, and events use 0 to mean
 *      "none" (see `readId`).
 *
 * WHERE THE POLICY LIVES. `activityRefsPolicy.json`, a plain data file, so
 * this module and the guardrail script
 * (`apps/indexer/scripts/lib/activity-refs-surface.mjs`) read the same
 * patterns, choices and exemptions instead of two copies that could drift.
 * The guardrail validates the policy against the compiled ABI (dead entries,
 * stale aliases, malformed shapes), and
 * `apps/indexer/test/activityRefsCoverage.test.ts` executes this module for
 * every compiled event.
 *
 * WHY IT LIVES IN THE SHARED LIBRARY (#2658). The indexer files every row by
 * this rule, and the app's Activity page receives a wallet's rows through it,
 * so the app's label catalog must name every kind it files. The app's test
 * reads `refScopedKinds()` here rather than re-deriving the rule from the
 * policy file, which is how a second copy would drift (it did: a test-side
 * copy ignored `extraAliases`).
 *
 * Shapes this module will not read, and so leaves NULL, each reported by the
 * guardrail as an ABI problem rather than tolerated: an event name with two
 * different definitions (a name-keyed rule cannot be right for both), an
 * indexed tuple (only its hash is in the log), a tuple array, and a tuple or
 * argument list mixing named and unnamed members (viem then decodes it as an
 * array, so no named path resolves).
 */
import { type Abi, type AbiEvent, type AbiParameter, toEventSignature } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import policy from './activityRefsPolicy.json';

export type RefField = 'loanId' | 'offerId';
export const REF_FIELDS: readonly RefField[] = ['loanId', 'offerId'];

const EXTRA_ALIASES = policy.extraAliases as Record<RefField, readonly string[]>;

const REF_SHAPE: Record<RefField, RegExp> = {
  loanId: new RegExp(policy.refShape.loanId),
  offerId: new RegExp(policy.refShape.offerId),
};

const SCALAR_INT = /^u?int(\d+)?$/;

/** Does an ABI input name populate `field`? Applied to the LAST path segment. */
function isAliasOf(field: RefField, name: string): boolean {
  return REF_SHAPE[field].test(name) || EXTRA_ALIASES[field].includes(name);
}

type ParamWithComponents = AbiParameter & {
  components?: readonly ParamWithComponents[];
  indexed?: boolean;
};

/** Every named scalar-integer leaf reachable by a dotted path. Returns null
 *  when the input list has a shape no named path can read (see header). */
function scalarIntPaths(
  inputs: readonly ParamWithComponents[],
  prefix: string,
): string[] | null {
  if (inputs.some((i) => !i.name)) return null;
  const out: string[] = [];
  for (const i of inputs) {
    const path = prefix ? `${prefix}.${i.name}` : i.name!;
    if (Array.isArray(i.components)) {
      if (/\]$/.test(i.type) || i.indexed) continue; // tuple array / hashed tuple
      const nested = scalarIntPaths(i.components, path);
      if (nested === null) continue; // mixed tuple — unreadable by path
      out.push(...nested);
    } else if (SCALAR_INT.test(i.type)) {
      out.push(path);
    }
  }
  return out;
}

/** eventName → the input path that fills each column (absent = NULL). */
const RESOLVED: ReadonlyMap<string, Partial<Record<RefField, string>>> = (() => {
  const signatureOf = new Map<string, string>();
  const ambiguous = new Set<string>();
  const pathsOf = new Map<string, string[] | null>();
  for (const item of DIAMOND_ABI_VIEM as Abi) {
    if (item.type !== 'event') continue;
    const ev = item as AbiEvent;
    let sig: string;
    try {
      // The indexed layout and the anonymous flag are part of what must agree:
      // two definitions differing only there decode logs differently.
      sig =
        `${ev.anonymous ? 'anon|' : ''}${toEventSignature(ev)}|` +
        ev.inputs.map((i) => `${i.name ?? ''}:${(i as ParamWithComponents).indexed ? 'i' : ''}`).join(',');
    } catch {
      continue;
    }
    const prior = signatureOf.get(ev.name);
    if (prior !== undefined) {
      if (prior !== sig) ambiguous.add(ev.name);
      continue;
    }
    signatureOf.set(ev.name, sig);
    pathsOf.set(ev.name, scalarIntPaths(ev.inputs as readonly ParamWithComponents[], ''));
  }

  const notScoped = policy.notScoped as Record<string, unknown>;
  const intended = policy.intendedAlias as Record<string, { path: string }>;
  const out = new Map<string, Partial<Record<RefField, string>>>();
  for (const [name, paths] of pathsOf) {
    if (ambiguous.has(name) || paths === null) continue;
    const resolved: Partial<Record<RefField, string>> = {};
    for (const field of REF_FIELDS) {
      const key = `${name}.${field}`;
      if (Object.hasOwn(notScoped, key)) continue;
      const candidates = paths.filter((p) => isAliasOf(field, p.split('.').pop()!));
      if (candidates.length === 1) {
        resolved[field] = candidates[0];
      } else if (candidates.length > 1 && Object.hasOwn(intended, key)) {
        const chosen = intended[key].path;
        if (candidates.includes(chosen)) resolved[field] = chosen;
      }
    }
    if (resolved.loanId !== undefined || resolved.offerId !== undefined) out.set(name, resolved);
  }
  return out;
})();

function readId(args: Record<string, unknown>, path: string): number | null {
  let v: unknown = args;
  for (const seg of path.split('.')) {
    if (v === null || typeof v !== 'object') return null;
    v = (v as Record<string, unknown>)[seg];
  }
  const id = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN;
  // Zero is "no loan / no offer", never an id: both counters pre-increment,
  // so the first loan and the first offer are 1. Events use it as that
  // sentinel — a treasury conversion's swap attempts carry loanId 0 — and
  // filing those under a loan 0 would invent a loan.
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The loan and offer a decoded event concerns, by the rule in the header.
 *  Never throws; an unknown event name or an unreadable shape yields NULLs. */
export function activityRefs(
  eventName: string,
  args: Record<string, unknown>,
): { loanId: number | null; offerId: number | null } {
  const resolved = RESOLVED.get(eventName);
  return {
    loanId: resolved?.loanId !== undefined ? readId(args, resolved.loanId) : null,
    offerId: resolved?.offerId !== undefined ? readId(args, resolved.offerId) : null,
  };
}

/** Every event kind filed under a loan or an offer: each kind the rule
 *  resolves at least one reference column for. Read by the app's test that
 *  its Activity label catalog names every kind the indexer files (#2658). */
export function refScopedKinds(): ReadonlySet<string> {
  return new Set(RESOLVED.keys());
}
