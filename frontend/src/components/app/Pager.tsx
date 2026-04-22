import { ChevronLeft, ChevronRight } from 'lucide-react';
import './Pager.css';

interface PagerProps {
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (next: number) => void;
  /** Singular label used in the "Showing N-M of X <unit>s" status (e.g. "loan"). */
  unit?: string;
}

export function Pager({ total, pageSize, page, onPageChange, unit }: PagerProps) {
  if (total <= pageSize) return null;
  const pageCount = Math.ceil(total / pageSize);
  const current = Math.min(page, pageCount - 1);
  const first = current * pageSize + 1;
  const last = Math.min(total, (current + 1) * pageSize);
  const unitLabel = unit ? ` ${unit}${total === 1 ? '' : 's'}` : '';
  return (
    <div className="pager">
      <span className="pager-status">
        Showing {first}–{last} of {total}{unitLabel}
      </span>
      <div className="pager-controls">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={current === 0}
          onClick={() => onPageChange(current - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={14} /> Prev
        </button>
        <span className="pager-page">
          Page {current + 1} of {pageCount}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={current >= pageCount - 1}
          onClick={() => onPageChange(current + 1)}
          aria-label="Next page"
        >
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
