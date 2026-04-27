import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * `<InfoTip>` — accessible (i) info icon paired with a portal-rendered
 * tooltip bubble. Click-only on every device.
 *
 * Why click-only (no hover-to-open)?
 *
 *   - On iOS / Android, a `:hover` rule on the trigger would defer
 *     the synthetic `click` event to the SECOND tap (the first tap
 *     becomes a "show hover state" interaction). Scoping `:hover`
 *     to `@media (hover: hover)` works for visual styling, but JS
 *     hover handlers (`onPointerEnter`/`onPointerLeave`) still left
 *     a confusing UX: desktop opens on hover, mobile only on click,
 *     and the close-on-mouseleave race made anchor links inside the
 *     bubble flaky to tap. A single click-to-toggle path makes the
 *     interaction identical on every device.
 *
 *   - The bubble is portal-rendered to `document.body` (not a
 *     descendant of the trigger), so it sits above every clipping
 *     ancestor — a card, modal, drawer, or sticky topbar can't
 *     truncate it. Coordinates are JS-clamped to the viewport so
 *     long content wraps in-bounds rather than running off-screen.
 *
 * Usage:
 *   <label>
 *     LTV cap
 *     <InfoTip>Maximum loan-to-value the borrower can request before…</InfoTip>
 *   </label>
 */
export interface InfoTipProps {
  /** Tooltip body — string or JSX. Multi-line strings render
   *  preserving `\n` (the bubble uses `white-space: pre-line`). */
  children: ReactNode;
  /** Icon size in px. Default 14. */
  size?: number;
  /** Extra class on the trigger. */
  className?: string;
  /** Override for the trigger's screen-reader label. Default
   *  "More information". */
  ariaLabel?: string;
  /** Tooltip vertical placement relative to the trigger. Default
   *  "below". Falls back to "above" automatically when placing
   *  below would overflow the viewport. */
  placement?: "above" | "below";
}

const VIEWPORT_PAD = 12; // px — minimum distance from viewport edges

export function InfoTip({
  children,
  size = 14,
  className,
  ariaLabel,
  placement = "below",
}: InfoTipProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    placement: "above" | "below";
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  // Compute viewport-aware coordinates whenever the bubble opens
  // (or its size changes via children). useLayoutEffect so the
  // bubble is placed before the next paint — useEffect causes a
  // 1-frame jump from (0,0) to the final spot.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const bubble = bubbleRef.current;
    const bubbleW = bubble?.offsetWidth ?? 280;
    const bubbleH = bubble?.offsetHeight ?? 60;

    const triggerCenterX = triggerRect.left + triggerRect.width / 2;
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    let place: "above" | "below" = placement;
    if (place === "below" && spaceBelow < bubbleH + VIEWPORT_PAD && spaceAbove > spaceBelow) {
      place = "above";
    } else if (place === "above" && spaceAbove < bubbleH + VIEWPORT_PAD && spaceBelow > spaceAbove) {
      place = "below";
    }
    const top =
      place === "below"
        ? triggerRect.bottom + 8
        : triggerRect.top - bubbleH - 8;

    const halfBubble = bubbleW / 2;
    const minLeft = VIEWPORT_PAD + halfBubble;
    const maxLeft = window.innerWidth - VIEWPORT_PAD - halfBubble;
    const left = Math.min(Math.max(triggerCenterX, minLeft), maxLeft);

    setCoords({ top, left, placement: place });
  }, [open, placement, children]);

  // Close on outside click / Escape / scroll / resize. The handler
  // checks `e.target` against the trigger and bubble refs, so a
  // tap inside the bubble (e.g. on a "Learn more" link) is correctly
  // ignored — no stopPropagation needed at the bubble level (and
  // critically, NOT calling stopPropagation on pointerdown avoids
  // an iOS Safari bug where it suppresses the synthetic click and
  // anchor taps don't navigate).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        bubbleRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onWindowChange() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onWindowChange, true);
    window.addEventListener("resize", onWindowChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onWindowChange, true);
      window.removeEventListener("resize", onWindowChange);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`info-tip-trigger${className ? " " + className : ""}`}
        aria-label={ariaLabel ?? t('infoTip.defaultAria')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Info size={size} aria-hidden="true" />
      </button>

      {open && coords &&
        createPortal(
          <div
            ref={bubbleRef}
            className={`info-tip-bubble info-tip-bubble--${coords.placement}`}
            role="tooltip"
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              transform: "translateX(-50%)",
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

export default InfoTip;
