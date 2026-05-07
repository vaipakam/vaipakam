import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * `<HoverTip>` — portal-rendered hover tooltip for any inline trigger.
 *
 * Why this exists alongside the simpler CSS `[data-tooltip="…"]`
 * pattern: when a tooltip-bearing element sits inside an
 * `overflow:auto`/`overflow:hidden` ancestor (e.g. the dashboard's
 * `.loans-table-wrap` which sets `overflow-x: auto` for horizontal
 * table scrolling on small viewports) the CSS-only tooltip clips
 * against that ancestor's scroll container — a one-line label gets
 * cropped or hidden entirely. CSS Level 2 has no escape: setting
 * `overflow-x: auto` with `overflow-y: visible` resolves both axes
 * to `auto`, so the pseudo-element can't escape the rectangle.
 *
 * The fix mirrors `<InfoTip>`'s portal trick: render the bubble
 * into `document.body`, position it relative to the viewport via
 * `position: fixed` with JS-computed coordinates from the trigger's
 * bounding rect. Free of every clipping ancestor.
 *
 * Usage:
 *   <HoverTip text="One short sentence">
 *     <button className="icon-btn">…</button>
 *   </HoverTip>
 *
 * The single child is cloned with hover / focus handlers (and a
 * `ref`) so the wrapper introduces no extra DOM. Multi-line strings
 * render with `\n` preserved (`white-space: pre-line`). Pairs with
 * the existing CSS-only `[data-tooltip]` styling — same look, same
 * 320 px max-width, same delay — so the visual feel is unchanged.
 */
interface HoverTipProps {
  /** Tooltip body. Strings or JSX both work; strings honour `\n`. */
  text: ReactNode;
  /** Single trigger element. */
  children: ReactElement;
  /** Optional placement. Defaults to "above"; falls back to "below"
   *  automatically when placing above would overflow the viewport. */
  placement?: 'above' | 'below';
}

const VIEWPORT_PAD = 12;
const SHOW_DELAY_MS = 350;

export function HoverTip({ text, children, placement = 'above' }: HoverTipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    placement: 'above' | 'below';
  } | null>(null);

  const cancelShow = () => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  };
  const scheduleShow = () => {
    cancelShow();
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null;
      setOpen(true);
    }, SHOW_DELAY_MS);
  };
  const hide = () => {
    cancelShow();
    setOpen(false);
  };

  useEffect(() => () => cancelShow(), []);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const bubbleRect = bubble?.getBoundingClientRect();
    const bubbleH = bubbleRect?.height ?? 32;
    const bubbleW = bubbleRect?.width ?? 160;

    let actualPlacement: 'above' | 'below' = placement;
    let top =
      placement === 'above'
        ? triggerRect.top - bubbleH - 8
        : triggerRect.bottom + 8;
    if (placement === 'above' && top < VIEWPORT_PAD) {
      actualPlacement = 'below';
      top = triggerRect.bottom + 8;
    } else if (
      placement === 'below' &&
      top + bubbleH > window.innerHeight - VIEWPORT_PAD
    ) {
      actualPlacement = 'above';
      top = triggerRect.top - bubbleH - 8;
    }
    let left = triggerRect.left + triggerRect.width / 2 - bubbleW / 2;
    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    if (left + bubbleW > window.innerWidth - VIEWPORT_PAD) {
      left = window.innerWidth - bubbleW - VIEWPORT_PAD;
    }
    setCoords({ top, left, placement: actualPlacement });
  }, [open, placement, text]);

  if (!isValidElement(children)) {
    // Defensive — caller passed a string / fragment. Fall back to no
    // tooltip rather than crash.
    return <>{children}</>;
  }

  const enhanced = cloneElement(
    children as ReactElement<{
      ref?: (el: HTMLElement | null) => void;
      onPointerEnter?: (e: React.PointerEvent) => void;
      onPointerLeave?: (e: React.PointerEvent) => void;
      onFocus?: (e: React.FocusEvent) => void;
      onBlur?: (e: React.FocusEvent) => void;
    }>,
    {
      ref: (el: HTMLElement | null) => {
        triggerRef.current = el;
      },
      onPointerEnter: (e: React.PointerEvent) => {
        const original = (
          children.props as { onPointerEnter?: (ev: React.PointerEvent) => void }
        ).onPointerEnter;
        if (original) original(e);
        scheduleShow();
      },
      onPointerLeave: (e: React.PointerEvent) => {
        const original = (
          children.props as { onPointerLeave?: (ev: React.PointerEvent) => void }
        ).onPointerLeave;
        if (original) original(e);
        hide();
      },
      onFocus: (e: React.FocusEvent) => {
        const original = (
          children.props as { onFocus?: (ev: React.FocusEvent) => void }
        ).onFocus;
        if (original) original(e);
        scheduleShow();
      },
      onBlur: (e: React.FocusEvent) => {
        const original = (
          children.props as { onBlur?: (ev: React.FocusEvent) => void }
        ).onBlur;
        if (original) original(e);
        hide();
      },
    },
  );

  return (
    <>
      {enhanced}
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            style={{
              position: 'fixed',
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              maxWidth: 320,
              width: 'max-content',
              padding: '8px 12px',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow-md)',
              fontSize: '0.78rem',
              fontWeight: 500,
              lineHeight: 1.45,
              textAlign: 'left',
              whiteSpace: 'pre-line',
              pointerEvents: 'none',
              opacity: coords ? 1 : 0,
              transition: 'opacity 0.15s ease',
              // Same z-index tier as `<InfoTip>`'s bubble (see
              // global.css comment "Above modals (z-index 1100),
              // drawers (1200), sticky topbar"). The Diagnostics
              // drawer sits at 1001, so the bubble must outrank it
              // or the tooltip renders behind the drawer surface.
              zIndex: 5000,
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
