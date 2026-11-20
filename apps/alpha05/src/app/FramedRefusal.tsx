/**
 * #3770 — shown in place of the whole app when it is framed by a site that
 * is not on the Safe origin list (`chain/safeOrigins`). The app acts on
 * nothing there: no wallet connects and no step is offered, because a page
 * that frames the app could overlay or misreport what the user confirms.
 * `_headers` already tells the browser to refuse such framing; this covers
 * a browser that does not enforce it.
 */
import { useCopy } from '../shared/copy/useCopy';

export function FramedRefusal() {
  const { text } = useCopy();
  return (
    <main className="page" data-testid="framed-refusal">
      <h1>{text('framing.title')}</h1>
      <p className="tier-a">{text('framing.body')}</p>
      <p className="tier-a">
        <a href={window.location.href} target="_top" rel="noopener">
          {text('framing.open')}
        </a>
      </p>
    </main>
  );
}
