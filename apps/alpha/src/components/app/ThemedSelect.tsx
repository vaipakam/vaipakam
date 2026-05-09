import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import './ThemedSelect.css';

export type ThemedSelectOption<V extends string> = {
  value: V;
  label: ReactNode;
};

interface Props<V extends string> {
  value: V;
  options: readonly ThemedSelectOption<V>[];
  onChange: (next: V) => void;
  ariaLabel?: string;
  className?: string;
  menuAlign?: 'start' | 'end';
  disabled?: boolean;
}

/**
 * Shared filter/area dropdown used by OfferBook, Activity, etc. Built as a
 * button-plus-floating-menu (not a native <select>) so the opened option
 * panel follows the app's theme tokens — native <option> elements can only
 * tweak background/color, leaving the rest as browser chrome.
 *
 * Visual language mirrors .chain-switcher-btn / .chain-switcher-menu in the
 * topbar so every filter dropdown in the authenticated app reads as the
 * same pill-shaped control family.
 */
export function ThemedSelect<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  menuAlign = 'start',
  disabled = false,
}: Props<V>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (next: V) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <div
      ref={wrapRef}
      className={`themed-dropdown ${className}`.trim()}
    >
      <button
        type="button"
        className="themed-dropdown-btn"
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className="themed-dropdown-label">
          {selected?.label ?? ''}
        </span>
        <ChevronDown size={14} className="themed-dropdown-chevron" />
      </button>
      {open && (
        <div
          className={`themed-dropdown-menu align-${menuAlign}`}
          role="listbox"
        >
          {options.map((o) => {
            const isSelected = o.value === value;
            return (
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                key={o.value}
                className={`themed-dropdown-item ${isSelected ? 'selected' : ''}`}
                onClick={() => pick(o.value)}
              >
                <span>{o.label}</span>
                {isSelected && <Check size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
