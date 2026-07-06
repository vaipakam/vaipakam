/**
 * SelectMenu — the app's dropdown control, replacing native <select>
 * everywhere options deserve real presentation (user directive
 * 2026-07-06: OS-rendered <option> rows "look stock", can't carry a
 * second line or a badge, and clash with both themes).
 *
 * Accessibility contract (ARIA combobox/listbox pattern):
 *   - the trigger is a real <button role="combobox"> — labelable, so
 *     the surrounding `.field`'s <label htmlFor> keeps working;
 *   - DOM focus STAYS on the trigger; the active row is conveyed via
 *     aria-activedescendant (no focus trap, Tab always leaves);
 *   - ArrowUp/Down/Home/End move, Enter/Space select, Escape closes,
 *     printable characters typeahead on row labels;
 *   - rows are role="option" with aria-selected, and carry
 *     data-value so tests target by VALUE, never by position (the
 *     same anti-hydration-race rule the old option[value] selectors
 *     followed — see e2e/lib/flows.ts).
 *
 * Deliberately NOT a portal: the menu positions inside the field and
 * every usage sits in normal page flow (no overflow-hidden ancestors),
 * so avoiding the portal keeps stacking, theming, and testing simple.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectMenuOption {
  value: string;
  /** Primary row text — also the typeahead target and the closed-
   *  control text (unless `controlLabel` overrides it). */
  label: string;
  /** Muted second line (e.g. a shortened contract address). */
  sub?: string;
  /** Small pill after the label (e.g. "Faucet"). Tone maps to the
   *  existing .badge-* classes. */
  badge?: { text: string; tone?: 'neutral' | 'info' | 'ok' | 'warn' };
  /** Closed-control text when the row's label alone reads oddly out
   *  of context. */
  controlLabel?: string;
}

export function SelectMenu({
  id,
  value,
  onChange,
  options,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectMenuOption[];
  /** Closed-control text while nothing is picked (value not among
   *  the options). Also rendered as a non-selectable hint? No — a
   *  placeholder is control chrome only, never a row. */
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ buffer: '', at: 0 });
  const listboxId = useId();

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const openMenu = useCallback(() => {
    setOpen(true);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [selectedIndex]);

  const commit = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt) return;
      onChange(opt.value);
      close();
      buttonRef.current?.focus();
    },
    [options, onChange, close],
  );

  // Light-dismiss: pointer down anywhere outside closes (capture so a
  // click that also opens ANOTHER menu can't leave two open).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close();
        break;
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        const now = Date.now();
        const t = typeahead.current;
        t.buffer = (now - t.at > 600 ? '' : t.buffer) + e.key.toLowerCase();
        t.at = now;
        const hit = options.findIndex((o) =>
          o.label.toLowerCase().startsWith(t.buffer),
        );
        if (hit >= 0) setActiveIndex(hit);
      }
    }
  };

  return (
    <div className="select-menu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        id={id}
        className="input select-menu-trigger"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined
        }
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span
          className={
            selected ? 'select-menu-value' : 'select-menu-value select-menu-placeholder'
          }
        >
          {selected ? (selected.controlLabel ?? selected.label) : (placeholder ?? '')}
        </span>
        <ChevronDown aria-hidden className="select-menu-chevron" data-open={open} />
      </button>
      {open ? (
        <ul
          className="select-menu-list"
          role="listbox"
          id={listboxId}
          ref={listRef}
          aria-labelledby={id}
        >
          {options.map((opt, i) => (
            <li
              key={opt.value === '' ? `__empty-${i}` : opt.value}
              id={`${listboxId}-${i}`}
              data-index={i}
              data-value={opt.value}
              role="option"
              aria-selected={i === selectedIndex}
              className={`select-menu-option${i === activeIndex ? ' is-active' : ''}`}
              // pointerenter (not mousemove) so scroll-into-view can't
              // fight the pointer for the active row.
              onPointerEnter={() => setActiveIndex(i)}
              // pointerdown-commit keeps the click inside the menu even
              // if the row re-renders between down and up.
              onPointerDown={(e) => {
                e.preventDefault();
                commit(i);
              }}
            >
              <span className="select-menu-option-main">
                <span className="select-menu-option-label">{opt.label}</span>
                {opt.badge ? (
                  <span className={`badge badge-${opt.badge.tone ?? 'neutral'}`}>
                    {opt.badge.text}
                  </span>
                ) : null}
              </span>
              {opt.sub ? (
                <span className="select-menu-option-sub">{opt.sub}</span>
              ) : null}
              {i === selectedIndex ? (
                <Check aria-hidden className="select-menu-option-check" />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
