import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './Pager.css';

interface PagerProps {
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (next: number) => void;
  /** Singular label used in the "Showing N-M of X <unit>s" status (e.g. "loan").
   *  Caller is expected to pass an already-localised string here when the
   *  surrounding context calls for it. */
  unit?: string;
}

export function Pager({ total, pageSize, page, onPageChange, unit }: PagerProps) {
  const { t } = useTranslation();
  if (total <= pageSize) return null;
  const pageCount = Math.ceil(total / pageSize);
  const current = Math.min(page, pageCount - 1);
  const first = current * pageSize + 1;
  const last = Math.min(total, (current + 1) * pageSize);
  // Caller-provided unit gets appended verbatim. Pluralisation is naive
  // English ("s") — when callers start passing localised units this can
  // be lifted out of the Pager and into the caller (which already knows
  // its own plural rules).
  const unitLabel = unit ? ` ${unit}${total === 1 ? '' : 's'}` : '';
  return (
    <div className="pager">
      <span className="pager-status">
        {t('shared.showing', { first, last, total })}
        {unitLabel}
      </span>
      <div className="pager-controls">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={current === 0}
          onClick={() => onPageChange(current - 1)}
          aria-label={t('shared.previousPage')}
        >
          <ChevronLeft size={14} /> {t('shared.prev')}
        </button>
        <span className="pager-page">
          {t('shared.pageOf', { current: current + 1, total: pageCount })}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={current >= pageCount - 1}
          onClick={() => onPageChange(current + 1)}
          aria-label={t('shared.nextPage')}
        >
          {t('shared.next')} <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
