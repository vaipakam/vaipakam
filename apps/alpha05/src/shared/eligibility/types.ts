/**
 * RB-ELIG — one eligibility rule per action. Every action a page offers is
 * decided by ONE verdict function that reads the protocol's own view where
 * the contracts publish one (sale exit verdict, cadence admission, forced
 * sale preview) and otherwise the same inputs the contract checks, and
 * states every refusal with the earliest time it can lift. A page renders
 * the verdict; it never re-derives it in a button handler.
 */

export type VerdictState =
  /** The action is open now. */
  | 'open'
  /** Closed by a stated reason; `reopensAt` says when it may lift (null
   *  when it needs a decision by someone, or never). */
  | 'closed'
  /** The inputs are not read yet or the last read failed; the page says so
   *  and withholds the action, never showing it as open or as closed. */
  | 'unknown';

export interface Refusal {
  /** A stable code, usually the contract's custom error name. */
  code: string;
  /** Tier-A sentence: the consequence and the current blocker. */
  reason: string;
  /** Unix seconds when the refusal may lift; null = needs a decision or never. */
  reopensAt: number | null;
  /** A remedy THIS session can offer (a route or action), or null. Never a
   *  remedy the app cannot drive (RB-FUNDS). */
  remedy: { label: string; to: string } | null;
}

export interface Verdict {
  state: VerdictState;
  refusals: readonly Refusal[];
  /** The switch class that closed the action, when one did (RB-SWITCH). */
  switchClass: SwitchClass | null;
  /** When the verdict's inputs were read (unix ms) and from which rail. */
  readAt: number | null;
  rail: 'own' | 'world' | 'pre-sign' | null;
}

/** RB-SWITCH classes. 1a blocks new positions only; 1b blocks that feature
 *  on existing loans too; 2 is the global pause (claims and withdrawals
 *  stop, repay and add-collateral stay open); 3 is asset-level; 4 is a
 *  keeper switch, which never blocks a user's own action. */
export type SwitchClass = '1a' | '1b' | '2' | '3' | '4';

export const OPEN: Verdict = Object.freeze({
  state: 'open',
  refusals: [],
  switchClass: null,
  readAt: null,
  rail: null,
});

export function unknownVerdict(reason: string): Verdict {
  return {
    state: 'unknown',
    refusals: [{ code: 'NotRead', reason, reopensAt: null, remedy: null }],
    switchClass: null,
    readAt: null,
    rail: null,
  };
}

export function closed(refusals: readonly Refusal[], switchClass: SwitchClass | null, readAt: number, rail: Verdict['rail']): Verdict {
  if (refusals.length === 0) throw new Error('closed() needs at least one refusal');
  return { state: 'closed', refusals, switchClass, readAt, rail };
}
