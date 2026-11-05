import { useEffect, useId, useRef } from 'react';
import { useMode } from '../../app/ModeContext';
import { useCopy } from '../copy/useCopy';
import { guideUrl } from './guide';
import { useHelp } from './HelpContext';

/**
 * The help panel (RB-HELP): a side panel from 720px up, a bottom sheet
 * below it (CSS decides; the markup is one dialog). It renders the tier-C
 * explanation of the open request and ends with the deep link into the
 * guide page of the reader's mode. Modal to the keyboard (focus lands on
 * the close control, Tab cycles inside, Escape closes, focus returns to the
 * link that opened it) and labelled by its heading, so a screen reader
 * announces the summary it explains. Rendered once, by the shell.
 */
export function HelpPanel() {
  const { request, close } = useHelp();
  const { entry, text, format } = useCopy();
  const { mode } = useMode();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    const returnTo = request.returnTo;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnTo?.focus();
    };
  }, [request, close]);

  if (!request) return null;
  const detail = entry(request.detailKey);
  if (detail.tier !== 'C') throw new Error(`HelpPanel: "${request.detailKey}" is tier ${detail.tier}, the panel renders tier C only`);
  return (
    <div className="help-scrim" onClick={close} data-testid="help-scrim">
      <div
        ref={panelRef}
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h2 id={headingId}>{request.vars ? format(request.summaryKey, request.vars) : text(request.summaryKey)}</h2>
          <button ref={closeRef} type="button" className="btn help-close" onClick={close} aria-label={text('help.close')}>
            ×
          </button>
        </div>
        <p className="tier-c">{detail.text}</p>
        <a className="help-guide" href={guideUrl(mode, detail.guide)} target="_blank" rel="noreferrer">
          {text('help.guideLink')}
        </a>
      </div>
    </div>
  );
}
