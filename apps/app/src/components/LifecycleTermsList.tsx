/**
 * #2725 — the lifecycle terms an accept signature binds, as one list every
 * accept review renders (direct accept, rental, signed-offer fill). Rows come
 * from `lifecycleRows`, so each review shows the same terms in the same words
 * and none can drop one: the signer compares every one of them against what
 * this list was built from.
 */
import { copy } from '../content/copy';
import { lifecycleRows, type LifecycleTerms } from '../contracts/acceptReview';

export function LifecycleTermsList({ terms }: { terms: LifecycleTerms }) {
  return (
    <div className="lifecycle-terms" style={{ margin: '8px 0' }}>
      <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: '0.9rem' }}>
        {copy.acceptTerms.heading}
      </p>
      <dl style={{ margin: 0, fontSize: '0.85rem' }}>
        {lifecycleRows(terms).map((row) => (
          <div key={row.label} style={{ margin: '2px 0' }}>
            <dt style={{ display: 'inline', fontWeight: 600 }}>{row.label}: </dt>
            <dd style={{ display: 'inline', margin: 0 }}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
