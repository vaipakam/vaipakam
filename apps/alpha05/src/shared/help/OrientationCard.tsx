import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMode } from '../../app/ModeContext';
import type { PageEntry } from '../../routes/pageMap';
import { useCopy, type CopyKey } from '../copy/useCopy';

/** What each Advanced page is, and the guided pages that do the same job
 *  step by step (ACC-07). A page without an entry shows no card. */
const ORIENTATION: Readonly<Record<string, { what: CopyKey; guided: readonly { to: string; label: CopyKey }[] }>> = {
  '/desk': {
    what: 'orientation.desk',
    guided: [
      { to: '/borrow', label: 'orientation.borrow' },
      { to: '/lend', label: 'orientation.lend' },
    ],
  },
};

const DISMISSED_KEY = 'alpha05.orientation.dismissed';

function readDismissed(path: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISSED_KEY}:${path}`) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(path: string): void {
  try {
    window.localStorage.setItem(`${DISMISSED_KEY}:${path}`, '1');
  } catch {
    /* storage blocked: the card stays hidden for this visit only */
  }
}

/**
 * ACC-07 — the orientation card a Basic reader sees on top of an Advanced
 * page reached by its address (the main menu shows Advanced pages under
 * their own heading). It says what the page is, links the guided pages
 * that do the same job, and offers the mode switch; it is never shown in
 * Advanced mode. Hiding it is remembered per page in this browser; where
 * storage is blocked it stays hidden for the visit.
 */
export function OrientationCard({ page }: { page: PageEntry }) {
  const { text } = useCopy();
  const { mode, setMode } = useMode();
  const entry = ORIENTATION[page.path];
  // Hidden in this visit, by path: the card stays mounted across built
  // pages, so its state must name the page it hid, and storage is read for
  // the page shown now rather than the one the card first rendered on.
  const [hiddenNow, setHiddenNow] = useState<readonly string[]>([]);
  const dismissed = hiddenNow.includes(page.path) || readDismissed(page.path);
  if (entry === undefined || page.tier !== 'advanced' || mode !== 'basic' || dismissed) return null;
  return (
    <aside className="orientation card" aria-labelledby="orientation-title" data-testid="orientation-card">
      <h2 id="orientation-title">{text('orientation.title')}</h2>
      <p className="tier-b">{text(entry.what)}</p>
      <p className="tier-b">{text('orientation.lead')}</p>
      <p className="tier-b">
        {text('orientation.guided')}{' '}
        {entry.guided.map((g, i) => (
          <span key={g.to}>
            {i > 0 && ' · '}
            <Link to={g.to} data-testid={`orientation-guided-${g.to.slice(1)}`}>
              {text(g.label)}
            </Link>
          </span>
        ))}
      </p>
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => setMode('advanced')} data-testid="orientation-switch">
          {text('orientation.switch')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            writeDismissed(page.path);
            setHiddenNow((h) => [...h, page.path]);
          }}
          data-testid="orientation-dismiss"
        >
          {text('orientation.dismiss')}
        </button>
      </div>
    </aside>
  );
}
