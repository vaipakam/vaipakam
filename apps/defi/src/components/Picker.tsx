import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import './ChainPicker.css';

export interface PickerItem<V extends string | number> {
  value: V;
  label: string;
  /** Optional small pill rendered next to the label (e.g. "default"). */
  pill?: string;
}

interface PickerProps<V extends string | number> {
  items: PickerItem<V>[];
  value: V;
  onSelect: (next: V) => void;
  /** Optional leading icon for the trigger. */
  icon?: ReactNode;
  /** Accessible name for the trigger button. */
  ariaLabel?: string;
  /** Optional prefix shown on the trigger only (e.g. "Role"). When set, the
   *  trigger reads `<prefix>: <selected label>`; menu rows still render just
   *  the bare item label so the prefix isn't duplicated on every row. */
  triggerPrefix?: string;
  /** Width of the trigger pill. Mirrors ChainPicker's 180px default; pass a
   *  smaller number for compact filters. */
  minWidth?: number;
  /** Which edge the popup menu aligns to; defaults to 'left'. */
  menuAlign?: 'left' | 'right';
}

/**
 * Generic picker pill — same trigger + dropdown chrome as `<ChainPicker>`,
 * but driven by a flat `items` array so filter UIs (role, status, page-size,
 * etc.) can share the chain picker's look without coupling to chain config.
 *
 * Reuses `ChainPicker.css` directly because the styling is already premium-
 * tier and class-name churn would just create noise.
 */
export function Picker<V extends string | number>({
  items,
  value,
  onSelect,
  icon,
  ariaLabel,
  triggerPrefix,
  minWidth = 140,
  menuAlign = 'left',
}: PickerProps<V>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => items.find((it) => it.value === value),
    [items, value],
  );
  const baseLabel = selected?.label ?? '';
  const label = triggerPrefix && baseLabel
    ? `${triggerPrefix}: ${baseLabel}`
    : baseLabel;

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
    onSelect(next);
  };

  return (
    <div className="chain-picker" ref={wrapRef}>
      <button
        type="button"
        className="chain-picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        style={{ minWidth }}
      >
        {icon}
        <span className="chain-picker-label">{label}</span>
        <ChevronDown size={14} className="chain-picker-chevron" />
      </button>
      {open && (
        <div
          className={`chain-picker-menu chain-picker-menu--${menuAlign}`}
          role="listbox"
        >
          {items.map((it) => (
            <button
              key={String(it.value)}
              type="button"
              role="option"
              aria-selected={it.value === value}
              className="chain-picker-item"
              onClick={() => pick(it.value)}
            >
              <span className="chain-picker-item-label">
                {it.label}
                {it.pill && <span className="chain-picker-pill">{it.pill}</span>}
              </span>
              {it.value === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
