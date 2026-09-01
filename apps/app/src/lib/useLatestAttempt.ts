/**
 * "Only the latest attempt may report" — the rule four call sites reached
 * independently, made into one thing (#2044, follow-up to #2043).
 *
 * THE DEFECT THIS EXISTS TO PREVENT. A click starts async work; the work
 * settles and writes component state. Nothing in that shape establishes that
 * the settlement is still the *current* one, so whichever promise resolves
 * last wins regardless of which started last. A stale result then overwrites
 * newer truth, and on a control that reports its own outcome the user is told
 * something false: "Copied." over a clipboard that refused, or a failure
 * message over one that succeeded.
 *
 * #2043 found this FOUR TIMES across two files in six review rounds — silent
 * failure, contradictory flags, a cross-mint race, then same-token ordering —
 * and each fix was correct for the case in front of it. That is what says the
 * rule wants to be a thing rather than a habit: four near-identical
 * `attempt`/`isCurrent()` blocks are four chances to get it subtly different,
 * and the fifth call site would have had to rediscover it.
 *
 * WHY A COUNTER AND NOT A CANCELLATION. Neither the Clipboard API nor
 * `wallet_watchAsset` can be aborted, so the pending work cannot be stopped —
 * only its RESULT can be ignored. Disabling the control while work is pending
 * was considered and rejected in #2043: a wedged clipboard promise may never
 * settle, and a permanently disabled button is a worse outcome than a stale
 * label.
 *
 * Usage:
 *
 *     const attempt = useLatestAttempt();
 *     const onClick = () => {
 *       const mine = attempt.begin();
 *       doSomethingAsync()
 *         .then(() => { if (mine.isCurrent()) setState('ok'); })
 *         .catch(() => { if (mine.isCurrent()) setState('failed'); });
 *     };
 *
 * THE RULE LIVES IN A PLAIN FACTORY, and the hook is the two lines that give
 * it a component's lifetime. That split is not tidiness: `apps/app`'s vitest
 * project is `environment: 'node'` with no rendering harness, so a hook can
 * only be tested by re-implementing it in the test — which proves nothing
 * about the hook and is the vacuous-assertion trap #2043 spent a round on.
 * `createLatestAttempt` is directly drivable, so the tests bind to the real
 * implementation.
 */
import { useState } from 'react';

export interface AttemptToken {
  /** This attempt's number. Useful when the rendered state carries it. */
  readonly id: number;
  /** True only while no later attempt has begun. */
  readonly isCurrent: () => boolean;
}

export interface LatestAttempt {
  /** Start an attempt, superseding any in flight. */
  readonly begin: () => AttemptToken;
  /**
   * Abandon any in-flight attempt without starting one — for a reset that
   * must not be undone by work already running. `Faucet`'s mint handlers use
   * it: a settlement belonging to the previous token must not label the new
   * one.
   */
  readonly supersede: () => void;
}

/** The rule itself, free of React so it can be driven in a test. */
export function createLatestAttempt(): LatestAttempt {
  let latest = 0;
  return {
    begin: () => {
      const id = (latest += 1);
      return { id, isCurrent: () => id === latest };
    },
    supersede: () => {
      latest += 1;
    },
  };
}

/**
 * One `LatestAttempt` per component instance, with a STABLE identity across
 * renders — handlers close over it and effects list it as a dependency, so a
 * new object each render would defeat both.
 */
export function useLatestAttempt(): LatestAttempt {
  // LAZY `useState`, not a ref. The obvious `useRef` + init-if-empty reads
  // `ref.current` during render, which this repo lints as an error
  // (`react-hooks/refs`, promoted in #1520) — and the rule is right: a ref
  // read during render is not guaranteed to be the value the render commits
  // with. `useState`'s initializer runs exactly once and its value is stable
  // for the component's life, which is precisely the guarantee needed here.
  // The setter is never called, so this never causes a render.
  const [attempt] = useState(createLatestAttempt);
  return attempt;
}
