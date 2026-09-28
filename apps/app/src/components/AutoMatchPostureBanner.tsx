import { copy } from '../content/copy';
import type { AutoRefinancePosture } from '../data/autoRefinancePosture';

/**
 * #2349 / #2355 — the ONE place the refinance surfaces state whether
 * automation can fill a posted refinance request. It renders a sentence
 * for every posture, including `on` and `unknown`: the switches never
 * block a lender's direct accept, so this is a disclosure, never a gate,
 * and a missing line would imply an availability the app has not read.
 */
export function AutoMatchPostureBanner({
  posture,
}: {
  posture: AutoRefinancePosture;
}) {
  const text = {
    on: copy.refinance.autoMatchOn,
    matcherOff: copy.refinance.autoMatchMatcherOff,
    off: copy.refinance.autoMatchOff,
    unknown: copy.refinance.autoMatchUnknown,
  }[posture];
  return (
    <div
      className="banner banner-info"
      role="status"
      data-auto-match-posture={posture}
      style={{ marginTop: 12 }}
    >
      <span className="banner-body">{text}</span>
    </div>
  );
}
