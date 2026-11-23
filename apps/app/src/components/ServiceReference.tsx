/**
 * The request reference beside a failure that came from one of the app's own
 * services (#3922). Shown ONLY with such a failure: a user can read it out to
 * support, and an operator finds the same reference in the service's log
 * line and its service error record. Renders nothing without a reference.
 */
import { copy } from '../content/copy';
import type { FailedRead } from '../lib/failedRead';

export function ServiceReference({ reference }: { reference: string | null | undefined }) {
  if (!reference) return null;
  return (
    <span className="service-reference" data-testid="service-reference">
      {' '}
      {copy.common.serviceReference(reference)}
    </span>
  );
}

/**
 * What a failed read can be quoted by (#3922, design option A): the
 * indexer's reference when it answered, and a plain statement when there is
 * no reference (the indexer did not answer, or the network read failed).
 * Renders nothing without a failure.
 */
export function FailedReadNote({ failed }: { failed: FailedRead | null | undefined }) {
  if (!failed) return null;
  const lines: string[] = [];
  if (failed.source === 'indexer' || failed.source === 'both') {
    const reference = failed.source === 'indexer' ? failed.reference : failed.indexerReference;
    lines.push(reference ? copy.common.serviceReference(reference) : copy.common.readNoAnswer);
  }
  if (failed.source === 'chain') lines.push(copy.common.chainReadFailed);
  if (failed.source === 'both') lines.push(copy.common.chainReadAlsoFailed);
  return (
    <p className="service-reference" data-testid="failed-read" data-source={failed.source}>
      {lines.join(' ')}
    </p>
  );
}
