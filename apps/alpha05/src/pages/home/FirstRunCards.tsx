import { useState } from 'react';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';

/** The browser-local record of which cards were dismissed. A per-viewer
 *  convenience: when storage is blocked the cards simply show again. */
const STORAGE_KEY = 'alpha05.firstRun.dismissed';

const CARDS: readonly { id: string; title: CopyKey; line: CopyKey }[] = [
  { id: 'vault', title: 'home.firstRunVaultTitle', line: 'home.firstRunVault' },
  { id: 'rate', title: 'home.firstRunRateTitle', line: 'home.firstRunRate' },
  { id: 'receipt', title: 'home.firstRunReceiptTitle', line: 'home.firstRunReceipt' },
  { id: 'help', title: 'home.firstRunHelpTitle', line: 'home.firstRunHelp' },
];

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage blocked: the dismissal lasts for this visit only */
  }
}

/**
 * RB-CONFIDENCE's first-run introduction: four dismissable cards on first
 * connect, never a tour over the live page. Each states something the app
 * does or holds for every loan, so none of them promises an outcome.
 */
export function FirstRunCards() {
  const { text } = useCopy();
  const [dismissed, setDismissed] = useState(readDismissed);
  const showing = CARDS.filter((c) => !dismissed.has(c.id));
  if (showing.length === 0) return null;
  const dismiss = (ids: string[]) => {
    const next = new Set([...dismissed, ...ids]);
    writeDismissed(next);
    setDismissed(next);
  };
  return (
    <section className="home-section first-run" aria-labelledby="home-first-run">
      <div className="section-head">
        <h2 id="home-first-run">{text('home.firstRunLabel')}</h2>
        <button type="button" className="link" onClick={() => dismiss(CARDS.map((c) => c.id))}>
          {text('home.firstRunDismissAll')}
        </button>
      </div>
      <ul className="first-run-cards">
        {showing.map((c) => (
          <li key={c.id} className="card" data-card={c.id}>
            <h3>{text(c.title)}</h3>
            <p className="tier-b">{text(c.line)}</p>
            <button type="button" className="btn" onClick={() => dismiss([c.id])}>
              {text('home.firstRunDismiss')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
