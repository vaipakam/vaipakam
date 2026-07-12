/**
 * UX-026 — orientation for a Basic-mode user who lands on a power
 * surface (/offers, /desk) by URL. Both routes are deliberately
 * URL-reachable in Basic (deeper tools, not disabled features), but
 * nothing used to say "this is a power surface" or route back to the
 * guided flows. Dismissal is remembered per browser; the note never
 * renders in Advanced mode.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { copy } from '../content/copy';
import { useMode } from '../app/ModeContext';

const DISMISS_KEY = 'alpha02.powerSurfaceNoteDismissed';

function loadDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function PowerSurfaceNote() {
  const { isAdvanced, setMode } = useMode();
  const [dismissed, setDismissed] = useState(loadDismissed);

  if (isAdvanced || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div className="banner banner-info" role="note">
      <span className="banner-body">
        {copy.powerSurface.body}{' '}
        <span className="cluster" style={{ marginTop: 8 }}>
          <Link to="/borrow" className="btn btn-secondary btn-sm">
            {copy.powerSurface.guided}
          </Link>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setMode('advanced')}
          >
            {copy.powerSurface.enableAdvanced}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>
            {copy.powerSurface.dismiss}
          </button>
        </span>
      </span>
    </div>
  );
}
