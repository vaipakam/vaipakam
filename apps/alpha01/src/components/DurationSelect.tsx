import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  OFFER_DURATION_BUCKETS_DAYS,
  formatDurationBucketLabel,
} from '@vaipakam/defi-client';
import './DurationSelect.css';

interface Props {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string | null;
}

function durationSubtitle(days: number): string | null {
  switch (days) {
    case 7:
      return '1 week';
    case 14:
      return '2 weeks';
    case 30:
      return '1 month';
    case 60:
      return '2 months';
    case 90:
      return '3 months';
    case 180:
      return '6 months';
    case 365:
      return '12 months';
    default:
      return null;
  }
}

export function DurationSelect({
  label = 'Loan duration',
  value,
  onChange,
  hint = 'Bucketed durations improve offer matching.',
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedDays = Number(value);
  const selectedLabel = useMemo(() => {
    if (!Number.isFinite(selectedDays)) return 'Choose duration';
    return formatDurationBucketLabel(selectedDays);
  }, [selectedDays]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function pick(days: number) {
    onChange(String(days));
    setOpen(false);
  }

  return (
    <div className="field duration-select" ref={rootRef}>
      <label>{label}</label>

      <button
        type="button"
        className="duration-select-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="duration-select-value">{selectedLabel}</span>
        <ChevronDown size={18} className={`duration-select-chevron ${open ? 'open' : ''}`} />
      </button>

      {open ? (
        <div className="duration-select-panel" role="listbox">
          {OFFER_DURATION_BUCKETS_DAYS.map((days) => {
            const primary = formatDurationBucketLabel(days);
            const subtitle = durationSubtitle(days);
            const selected = String(days) === value;
            return (
              <button
                key={days}
                type="button"
                role="option"
                aria-selected={selected}
                className={`duration-select-option ${selected ? 'selected' : ''}`}
                onClick={() => pick(days)}
              >
                <span className="duration-select-option-copy">
                  <span className="duration-select-option-primary">{primary}</span>
                  {subtitle && primary !== subtitle ? (
                    <span className="duration-select-option-meta">{subtitle}</span>
                  ) : null}
                </span>
                {selected ? <Check size={16} className="duration-select-option-check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {hint ? <span className="form-hint duration-select-hint">{hint}</span> : null}
    </div>
  );
}