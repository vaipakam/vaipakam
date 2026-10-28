/**
 * The ONE rule for a review's consent tick (#1696, owner decision
 * 2026-10-28): consent covers exactly what was reviewed, so the tick clears
 * in the same render the reviewed data changes.
 *
 * Every signing review in the app shows terms that can move while it is
 * open: a background refresh of the loan, a fee or grace retune, a token
 * screen's verdict, a term the user edits. A tick given against the old
 * values must not survive the new ones. Before this hook the flows answered
 * that four ways (an effect that cleared after the new figures had already
 * painted, a ref stamped on tick and compared at the gate, a render-phase
 * clear keyed on DISPLAY strings, and clears scattered through every input
 * handler), and a reviewer could not tell which was the house rule.
 *
 * The rule, as built here:
 *
 *  - **Keyed on the underlying values.** The caller passes a fingerprint
 *    built with `consentFingerprint` from the values the review shows and
 *    the inputs that shape it: amounts as integers, ids, flags, verdict
 *    reasons. Never a formatted string: two different amounts can format
 *    alike, and a display-keyed rule misses that change.
 *  - **Cleared during render, never from an effect.** An effect runs after
 *    the commit that painted the new values, leaving a frame where fresh
 *    figures and an old tick coexist and a click would send consent for
 *    figures the user never saw. Adjusting state during render makes React
 *    re-render before committing, so no such frame is ever painted. This is
 *    React's documented "adjusting state when props change" pattern, which
 *    `react-hooks/set-state-in-render` inspects and accepts.
 *  - **The box shows the consent.** `given` is both the checkbox state and
 *    the gate, so a cleared consent is visibly unticked rather than a ticked
 *    box beside a button that silently refuses.
 *  - **The clear is explained.** `withdrawnByChange` latches when a tick
 *    the user gave was withdrawn by a change, until they tick again, so a
 *    flow can say why the box unticked itself.
 *
 * A value that returns to what was reviewed does not restore consent: once
 * cleared, only the user's own tick gives it again.
 */
import { useCallback, useState } from 'react';

export interface ReviewConsent {
  /** The tick — and the consent: true only when the user ticked it against
   *  the review as it is NOW. */
  given: boolean;
  /** The user's tick or untick. */
  set: (checked: boolean) => void;
  /** Withdraw consent without it reading as a change to the review (the
   *  review closed, or what it described was submitted). */
  clear: () => void;
  /** A tick the user gave was withdrawn because the review changed, and
   *  they have not ticked again since. */
  withdrawnByChange: boolean;
}

interface ConsentState {
  given: boolean;
  reviewed: string;
  withdrawnByChange: boolean;
}

export function useReviewConsent(reviewed: readonly unknown[]): ReviewConsent {
  const fingerprint = consentFingerprint(...reviewed);
  const [state, setState] = useState<ConsentState>({
    given: false,
    reviewed: fingerprint,
    withdrawnByChange: false,
  });
  let current = state;
  if (state.reviewed !== fingerprint) {
    current = {
      given: false,
      reviewed: fingerprint,
      withdrawnByChange: state.given || state.withdrawnByChange,
    };
    setState(current);
  }
  const set = useCallback(
    (checked: boolean) =>
      setState((s) => ({
        ...s,
        given: checked,
        withdrawnByChange: checked ? false : s.withdrawnByChange,
      })),
    [],
  );
  const clear = useCallback(
    () => setState((s) => ({ ...s, given: false, withdrawnByChange: false })),
    [],
  );
  return {
    given: current.given,
    withdrawnByChange: current.withdrawnByChange,
    set,
    clear,
  };
}

/**
 * A fingerprint of the reviewed VALUES, for `useReviewConsent`. Each part is
 * encoded with its type, so `1n` and `'1'` and `1` differ, `undefined`
 * (not yet read) differs from `null` (read, absent), and no part can run
 * into its neighbour.
 */
export function consentFingerprint(...parts: readonly unknown[]): string {
  return JSON.stringify(parts, (_key, value: unknown) =>
    typeof value === 'bigint'
      ? { bigint: value.toString() }
      : value === undefined
        ? { undefined: true }
        : value,
  );
}
