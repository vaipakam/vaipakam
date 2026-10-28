/**
 * Scroll to the URL fragment once its element exists (#2076).
 *
 * A browser resolves a fragment once, at load, against a document that on a
 * client-rendered page does not yet hold the element — and React Router does
 * not replay fragment scrolling when it appears later. On a page whose cards
 * mount after their reads settle (the position page) there is no single
 * "ready" moment to wait for either, so this watches the DOM until the
 * element appears, scrolls to it once, and stops.
 *
 * It gives up, without scrolling, as soon as the visitor scrolls, types or
 * touches the page — a jump arriving after they started reading would take
 * them away from it — and after `FRAGMENT_WAIT_MS` in any case, since a card
 * that has not appeared by then (a loan that is not theirs, a mode that does
 * not show it) is not coming.
 *
 * `getElementById`, not `querySelector`: the fragment is user-controlled,
 * and an invalid selector would throw during mount.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export const FRAGMENT_WAIT_MS = 15_000;

const GIVE_UP_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;

/** The element id a fragment names, or `null` for none. */
export function fragmentId(hash: string): string | null {
  if (hash.length < 2 || !hash.startsWith('#')) return null;
  const raw = hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // a malformed escape: try the fragment as written
  }
}

export function useScrollToFragment(): void {
  const { hash, key } = useLocation();
  useEffect(() => {
    const id = fragmentId(hash);
    if (id === null) return;
    let done = false;
    const tryScroll = (): boolean => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView({ block: 'start' });
      return true;
    };
    const observer = new MutationObserver(() => {
      if (tryScroll()) stop();
    });
    const timer = window.setTimeout(stop, FRAGMENT_WAIT_MS);
    function stop() {
      if (done) return;
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
      for (const ev of GIVE_UP_EVENTS) window.removeEventListener(ev, stop, true);
    }
    if (tryScroll()) {
      stop();
      return stop;
    }
    observer.observe(document.body, { childList: true, subtree: true });
    for (const ev of GIVE_UP_EVENTS) window.addEventListener(ev, stop, { capture: true, passive: true });
    return stop;
    // `key` re-arms it for a new navigation to the same fragment.
  }, [hash, key]);
}
