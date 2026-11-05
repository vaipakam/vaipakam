import { useId, useState } from 'react';
import type { Copy } from '../copy/tiers';

/**
 * RB-HELP — a one-line summary (tier B) followed by a "Why?" link that opens
 * the full explanation (tier C) from the SAME copy entry, ending with a
 * deep link to the user guide. Rendered as a disclosure here; the side
 * panel / bottom sheet replaces the inline disclosure in the shell PR.
 * Tooltips are not used (touch screens, screen readers, length).
 */
export function WhyLink({ summary, detail, guideBase }: { summary: Copy; detail: Copy; guideBase: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (detail.tier !== 'C') throw new Error('WhyLink: the detail must be tier C');
  return (
    <div className="why">
      <p className="tier-b">
        {summary.text}{' '}
        <button type="button" className="link" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          Why?
        </button>
      </p>
      {open && (
        <div id={id} className="why-panel" role="region" aria-label="Explanation">
          <p>{detail.text}</p>
          {detail.guide && (
            <a href={`${guideBase}#${detail.guide}`} target="_blank" rel="noreferrer">
              Read more in the user guide
            </a>
          )}
        </div>
      )}
    </div>
  );
}
