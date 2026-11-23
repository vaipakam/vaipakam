import { useCopy } from '../copy/useCopy';

/**
 * The request reference beside a failure from one of the app's own services
 * (#3922): the alert service or the offer book, whether it refused or could
 * not be reached. A person can
 * read it out to support, and an operator finds the same reference in the
 * service's log line and its service error record. Shown ONLY beside such a
 * failure, never on a success, a chain read or a wallet refusal, which have none.
 * Renders nothing without a reference.
 */
export function ServiceReference({ reference }: { reference: string | null | undefined }) {
  const { format } = useCopy();
  if (!reference) return null;
  return (
    <span className="service-reference" data-testid="service-reference">
      {' '}
      {format('shell.serviceReference', { reference })}
    </span>
  );
}
