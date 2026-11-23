/**
 * The request reference beside a failure that came from one of the app's own
 * services (#3922). Shown ONLY with such a failure: a user can read it out to
 * support, and an operator finds the same reference in the service's log
 * line and its service error record. Renders nothing without a reference.
 */
import { copy } from '../content/copy';

export function ServiceReference({ reference }: { reference: string | null | undefined }) {
  if (!reference) return null;
  return (
    <span className="service-reference" data-testid="service-reference">
      {' '}
      {copy.common.serviceReference(reference)}
    </span>
  );
}
