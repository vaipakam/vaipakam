/**
 * The line that explains a consent the user did not withdraw themselves
 * (#1696). Every signing review keys its risk-and-terms consent on what it
 * shows (`hooks/useReviewConsent`) and unticks the box the moment any of it
 * changes; an untick the user did not make, with nothing saying why, reads
 * as a glitch. So a review that shows a consent box shows this note beneath
 * it: present while a tick the user gave stands withdrawn by a change, gone
 * once they tick again or clear the review themselves.
 *
 * `message` lets a review name what moved in its own words (the desk ticket's
 * "Terms changed"); the default fits any review.
 */
import { copy } from '../content/copy';
import type { ReviewConsent } from '../hooks/useReviewConsent';

export function ConsentWithdrawnNote({
  consent,
  message,
}: {
  consent: Pick<ReviewConsent, 'withdrawnByChange'>;
  message?: string;
}) {
  if (!consent.withdrawnByChange) return null;
  return (
    <p
      className="field-hint"
      role="status"
      data-testid="consent-withdrawn"
      style={{ color: 'var(--warn)', marginTop: -4 }}
    >
      {message ?? copy.consentParts.withdrawn}
    </p>
  );
}
