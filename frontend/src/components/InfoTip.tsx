import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

/**
 * `<InfoTip>` — accessible (i) info icon paired with a portal-rendered
 * tooltip bubble.
 *
 * Why a new component instead of the existing CSS-only `[data-tooltip]`?
 *
 *   1. **No clipping.** The CSS tooltip lives inside the trigger's DOM
 *      subtree; any ancestor with `overflow: hidden`, `overflow: auto`,
 *      or `transform` clips the bubble. We hit this in cards, drawers,
 *      and inside the new Settings popover. Rendering through a portal
 *      to `document.body` and positioning with `fixed` coordinates lets
 *      the bubble float above every clipping ancestor.
 *
 *   2. **Mobile parity.** `:hover` is unreliable on touch devices —
 *      iOS fires it on the tap before navigation, Android fires it
 *      after, and neither dismisses cleanly. A plain (i) button with an
 *      `onClick` toggle gives mobile users a deterministic affordance
 *      while desktop hover keeps working through `onPointerEnter`/
 *      `onPointerLeave` (pointer events unify mouse + pen + touch).
 *
 *   3. **Edge-aware positioning.** The bubble's `left` is clamped to
 *      the viewport bounds so it never extends past either edge — a
 *      separate fix the CSS variant can't pull off without JS.
 *
 * Usage:
 *   <label>
 *     LTV cap
 *     <InfoTip>Maximum loan-to-value the borrower can request before…</InfoTip>
 *   </label>
 *
 * Pair it with a host element that has its own a11y label; the (i)
 * icon's `aria-label` defaults to "More information" but should be
 * passed explicitly when the surrounding label isn't self-describing.
 */
export interface InfoTipProps {
  /** Tooltip body — string or JSX. Multi-line strings render
   *  preserving `\n` (the bubble uses `white-space: pre-line`). */
  children: ReactNode;
  /** Icon size in px. Default 14 — matches the inline-text x-height
   *  of the surrounding 0.78–0.95rem labels we use across the app. */
  size?: number;
  /** Extra class on the trigger. Useful for nudging colour or margin
   *  in a parent context (e.g. white icon on a coloured pill). */
  className?: string;
  /** Override for the trigger's screen-reader label. Default:
   *  "More information". */
  ariaLabel?: string;
  /** Tooltip vertical placement relative to the trigger. Default
   *  "below". Falls back to "above" automatically when placing below
   *  would overflow the viewport. */
  placement?: "above" | "below";
}

const VIEWPORT_PAD = 12; // px — keeps the bubble at least this far from any viewport edge

export function InfoTip({
  children,
  size = 14,
  className,
  ariaLabel,
  placement = "below",
}: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    placement: "above" | "below";
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  // Compute viewport-aware coordinates whenever the bubble opens or
  // its size changes. Uses `useLayoutEffect` so the bubble is placed
  // before the next paint — a `useEffect` here causes a 1-frame jump
  // from (0,0) to the final spot when toggling rapidly.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const bubble = bubbleRef.current;
    // Bubble may not be in the DOM on the first pass (open just flipped
    // true). Best-effort sizing — the secondary effect below recomputes
    // once the bubble is rendered and its real width/height are known.
    const bubbleW = bubble?.offsetWidth ?? 280;
    const bubbleH = bubble?.offsetHeight ?? 60;

    // Decide above vs below: prefer the requested placement, but flip
    // if it would overflow the viewport.
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

    // Horizontal: centre on trigger, then clamp to viewport with
    // `VIEWPORT_PAD` margin on each side. The bubble's transform-origin
    // is its centre, so we also shift the arrow via CSS variable
    // (--info-tip-arrow-x) so it still points at the trigger after the
    // clamp.
    const halfBubble = bubbleW / 2;
    const minLeft = VIEWPORT_PAD + halfBubble;
    const maxLeft = window.innerWidth - VIEWPORT_PAD - halfBubble;
    const left = Math.min(Math.max(triggerCenterX, minLeft), maxLeft);

    setCoords({ top, left, placement: place });
  }, [open, placement, children]);

  // Close on outside click / Escape / scroll / resize.
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
      // Either close (cheap) or recompute coords. Closing is simpler
      // and a scroll/resize on an open tooltip is almost always the
      // user dismissing the surface anyway.
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
        aria-label={ariaLabel ?? "More information"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(e) => {
          // `stopPropagation` so an outside-click handler on a parent
          // popover (e.g. the topbar Settings panel) doesn't immediately
          // close the parent when the user taps the (i) icon inside it.
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        onPointerEnter={(e) => {
          // Mouse-only: hover-to-open. Touch input fires pointerenter
          // immediately followed by pointerleave / pointercancel before
          // the click; we let `onClick` own the toggle for touch and
          // use this only for mouse.
          if (e.pointerType !== "mouse") return;
          setOpen(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "mouse") return;
          setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
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
            // Clicking inside the bubble shouldn't close it via the
            // outside-click handler.
            onPointerDown={(e) => e.stopPropagation()}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

export default InfoTip;
