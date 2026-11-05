import { useLocation, useParams } from 'react-router-dom';
import { PAGES, currentAppHref, type PageEntry } from './pageMap';
import { useCopy } from '../shared/copy/useCopy';

/**
 * The honest placeholder every route renders until its PR lands: it names
 * the page, the matrix rows it will carry and where the same job is done
 * today. It never shows a figure, a list or a button that would act.
 */
export function NotBuilt({ page }: { page: PageEntry }) {
  const location = useLocation();
  const params = useParams();
  const { text } = useCopy();
  const fallback = currentAppHref(page, params);
  return (
    <main className="page" aria-labelledby="nb-title">
      <p className="eyebrow">Under construction</p>
      <h1 id="nb-title">{page.name}</h1>
      <p className="tier-a">{text('notBuilt.a')}</p>
      <dl className="facts">
        <dt>Route</dt>
        <dd>
          <code>{location.pathname}</code>
        </dd>
        <dt>Carries</dt>
        <dd>{page.rows}</dd>
        <dt>Build order</dt>
        <dd>
          {page.order} of {PAGES.length}
        </dd>
      </dl>
      {fallback ? (
        <p className="tier-b">
          {text('notBuilt.b')} <a href={fallback}>{text('notBuilt.open')}</a>.
        </p>
      ) : (
        <p className="tier-b">{text('notBuilt.none')}</p>
      )}
    </main>
  );
}

export function NotFound() {
  const location = useLocation();
  return (
    <main className="page" aria-labelledby="nf-title">
      <h1 id="nf-title">No page here</h1>
      <p className="tier-a">
        <code>{location.pathname}</code> is not an address in this app. Nothing of yours is missing: a position,
        claim or vault is reached from its own page.
      </p>
    </main>
  );
}
